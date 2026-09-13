import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  commandResultSchema,
  deviceLogsSchema,
  heartbeatSchema,
  pairRequestSchema,
  playbackEventsSchema,
  syncStatusSchema,
  type PairResponse,
  type PlaybackProfile,
} from '@signage/shared';
import type { Prisma } from '@signage/database';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { generateDeviceToken, normalizePairingCode } from '../lib/tokens';
import { applyHeartbeat } from '../lib/heartbeat';
import { allowedMediaIdsForDevice, buildSyncManifest } from '../lib/manifest';
import { selectVideoVariant } from '../lib/media-variant';
import { presignDownload, uploadBufferToS3 } from '../lib/s3';
import { serializeCommand } from '../lib/serializers';

const screenshotSchema = z.object({
  imageBase64: z
    .string()
    .min(1)
    .max(8 * 1024 * 1024),
  mimeType: z.enum(['image/jpeg', 'image/png']).default('image/jpeg'),
});

const mediaFileQuerySchema = z.object({
  variant: z.enum(['processed', 'thumbnail', 'original']).default('processed'),
  token: z.string().optional(), // consumed by device auth
});

const SCREENSHOTS_KEPT = 5;
const ALLOWED_MEDIA_CACHE_TTL_MS = 30_000;

type CommandParams = { Params: { commandId: string } };
type MediaFileParams = { Params: { mediaId: string } };

export async function deviceApiRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;
  const auth = { preHandler: app.deviceAuth };

  // Per-instance cache of which media each device may download, so media
  // file requests do not rebuild the full manifest on every download.
  const allowedMediaCache = new Map<string, { ids: Set<string>; expires: number }>();

  function device(req: FastifyRequest) {
    return req.device!;
  }

  async function fetchPendingCommands(deviceId: string) {
    const now = new Date();
    const commands = await prisma.deviceCommand.findMany({
      where: {
        deviceId,
        status: { in: ['pending', 'sent'] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    const pendingIds = commands.filter((c) => c.status === 'pending').map((c) => c.id);
    if (pendingIds.length > 0) {
      await prisma.deviceCommand.updateMany({
        where: { id: { in: pendingIds }, status: 'pending' },
        data: { status: 'sent', sentAt: now },
      });
    }
    return commands.map((c) =>
      pendingIds.includes(c.id) ? { ...c, status: 'sent' as const, sentAt: now } : c,
    );
  }

  // ---------- Pairing (unauthenticated, rate limited) ----------

  app.post(
    '/device/pair',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = pairRequestSchema.parse(req.body);
      const code = normalizePairingCode(body.pairingCode);
      if (code.length < 4) throw badRequest('Invalid pairing code');

      const found = await prisma.device.findUnique({ where: { pairingCode: code } });
      if (!found || found.deletedAt) {
        req.log.warn({ ip: req.ip }, 'pairing attempt with unknown code');
        throw notFound('Invalid pairing code');
      }
      if (!found.pairingCodeExpiresAt || found.pairingCodeExpiresAt.getTime() < Date.now()) {
        throw badRequest('Pairing code has expired — generate a new one in the dashboard');
      }

      // Conditional update enforces single use even under concurrent attempts.
      const claimed = await prisma.device.updateMany({
        where: { id: found.id, pairingCode: code },
        data: {
          pairingCode: null,
          pairingCodeExpiresAt: null,
          pairedAt: new Date(),
          lastSeenAt: new Date(),
          lastIp: req.ip,
          appVersion: body.hardware?.appVersion,
          osInfo: body.hardware?.os ?? body.hardware?.model,
          archInfo: body.hardware?.arch,
          deviceModel: body.hardware?.model,
        },
      });
      if (claimed.count === 0) throw conflict('Pairing code was already used');

      const { token, hash } = generateDeviceToken();
      await prisma.deviceToken.create({
        data: { deviceId: found.id, tokenHash: hash, name: 'paired' },
      });

      req.log.info({ deviceId: found.id, orgId: found.organizationId }, 'device paired');
      const response: PairResponse = {
        deviceId: found.id,
        deviceToken: token,
        deviceName: found.name,
        organizationId: found.organizationId,
        settings: {
          orientation: found.orientation as PairResponse['settings']['orientation'],
          rotation: found.rotation as PairResponse['settings']['rotation'],
          timezone: found.timezone,
        },
      };
      return reply.status(201).send(response);
    },
  );

  // ---------- Status & telemetry ----------

  app.post('/device/heartbeat', auth, async (req) => {
    const body = heartbeatSchema.parse(req.body);
    await applyHeartbeat(prisma, device(req).id, body, req.ip);
    return { serverTime: new Date().toISOString() };
  });

  app.get('/device/sync', auth, async (req) => {
    const dev = device(req);
    const query = z
      .object({ include_commands: z.coerce.boolean().default(false), token: z.string().optional() })
      .parse(req.query);

    const manifest = await buildSyncManifest(prisma, dev.id);
    await prisma.device.update({
      where: { id: dev.id },
      data: { lastSeenAt: new Date(), lastIp: req.ip },
    });

    // Polling fallback: devices without a working WebSocket pick up pending
    // commands together with the manifest.
    const commands = query.include_commands ? await fetchPendingCommands(dev.id) : [];
    return { manifest, commands: commands.map(serializeCommand) };
  });

  const bigintOrNull = (value: number | undefined): bigint | null =>
    value == null ? null : BigInt(Math.max(0, Math.round(value)));

  const REPORTED_SYNC_STATUS = {
    downloading: 'syncing',
    applied: 'in_sync',
    failed: 'error',
    // Kept distinct from `error` deliberately (T017): the operator's next
    // action is different, and the screen is still playing.
    insufficient_storage: 'insufficient_storage',
  } as const;

  app.post('/device/sync-status', auth, async (req) => {
    const dev = device(req);
    const body = syncStatusSchema.parse(req.body);

    await prisma.device.update({
      where: { id: dev.id },
      data: {
        lastSeenAt: new Date(),
        syncStatus: REPORTED_SYNC_STATUS[body.status],
        ...(body.status === 'applied'
          ? { manifestVersion: body.manifestVersion, lastSyncAt: new Date(), lastError: null }
          : {}),
        ...(body.status === 'failed' ? { lastError: body.error ?? 'sync failed' } : {}),
        ...(body.status === 'insufficient_storage'
          ? {
              lastError: body.error ?? 'insufficient storage',
              storageShortfallBytes: bigintOrNull(body.shortfallBytes),
              ...(body.cacheBudgetBytes != null
                ? { cacheBudgetBytes: bigintOrNull(body.cacheBudgetBytes) }
                : {}),
            }
          : {}),
        // A successful sync clears the shortfall; otherwise the dashboard would
        // keep showing a stale "needs 2.4 GB more" after the operator fixed it.
        ...(body.status === 'applied' ? { storageShortfallBytes: null } : {}),
        ...(body.cacheUsedBytes != null
          ? { cacheUsedBytes: BigInt(Math.max(0, Math.round(body.cacheUsedBytes))) }
          : {}),
      },
    });
    if (body.status === 'failed') {
      req.log.warn({ deviceId: dev.id, error: body.error }, 'device sync failed');
    }
    if (body.status === 'insufficient_storage') {
      req.log.warn(
        {
          deviceId: dev.id,
          requiredBytes: body.requiredBytes,
          availableBytes: body.availableBytes,
          shortfallBytes: body.shortfallBytes,
        },
        'device has insufficient storage for its playlist',
      );
    }
    return { ok: true };
  });

  app.post('/device/logs', auth, async (req) => {
    const dev = device(req);
    const body = deviceLogsSchema.parse(req.body);
    if (body.logs.length > 0) {
      await prisma.deviceLog.createMany({
        data: body.logs.map((log) => ({
          deviceId: dev.id,
          level: log.level,
          message: log.message,
          context: (log.context ?? undefined) as Prisma.InputJsonValue | undefined,
          loggedAt: new Date(log.loggedAt),
        })),
      });
    }
    return { saved: body.logs.length };
  });

  app.post('/device/playback-events', auth, async (req) => {
    const dev = device(req);
    const body = playbackEventsSchema.parse(req.body);
    if (body.events.length === 0) return { saved: 0 };

    // skipDuplicates + the (deviceId, clientEventId) unique constraint make
    // offline batch resubmission idempotent: replayed events do not double
    // count. Events without a clientEventId (old agents) are kept as-is.
    await prisma.playbackEvent.createMany({
      data: body.events.map((event) => ({
        organizationId: dev.organizationId,
        deviceId: dev.id,
        eventType: event.eventType,
        mediaAssetId: event.mediaAssetId ?? null,
        playlistId: event.playlistId ?? null,
        clientEventId: event.clientEventId ?? null,
        priorityRuleId: event.priorityRuleId ?? null,
        playedAs: event.playedAs ?? null,
        durationSeconds: event.durationSeconds ?? null,
        detail: (event.detail ?? undefined) as Prisma.InputJsonValue | undefined,
        occurredAt: new Date(event.occurredAt),
      })),
      skipDuplicates: true,
    });

    const latestStart = [...body.events]
      .filter((e) => e.eventType === 'start')
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
    if (latestStart) {
      await prisma.device.update({
        where: { id: dev.id },
        data: {
          currentMediaId: latestStart.mediaAssetId ?? null,
          currentPlaylistId: latestStart.playlistId ?? null,
        },
      });
    }
    return { saved: body.events.length };
  });

  app.post('/device/screenshot', auth, async (req) => {
    const dev = device(req);
    const body = screenshotSchema.parse(req.body);

    const buffer = Buffer.from(body.imageBase64, 'base64');
    if (buffer.length === 0) throw badRequest('Empty screenshot payload');

    const ext = body.mimeType === 'image/png' ? 'png' : 'jpg';
    const storageKey = `org/${dev.organizationId}/screenshots/${dev.id}/${Date.now()}.${ext}`;
    await uploadBufferToS3(storageKey, buffer, body.mimeType);
    await prisma.deviceScreenshot.create({ data: { deviceId: dev.id, storageKey } });

    // Keep only the newest few; older rows go, object cleanup is best-effort
    // via the retention job (same policy as soft-deleted media).
    const stale = await prisma.deviceScreenshot.findMany({
      where: { deviceId: dev.id },
      orderBy: { createdAt: 'desc' },
      skip: SCREENSHOTS_KEPT,
      select: { id: true },
    });
    if (stale.length > 0) {
      await prisma.deviceScreenshot.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    }
    return { ok: true, storageKey };
  });

  // ---------- Commands (polling fallback + acknowledgements) ----------

  app.get('/device/commands', auth, async (req) => {
    const commands = await fetchPendingCommands(device(req).id);
    return { commands: commands.map(serializeCommand) };
  });

  app.post<CommandParams>('/device/commands/:commandId/ack', auth, async (req) => {
    const updated = await prisma.deviceCommand.updateMany({
      where: {
        id: req.params.commandId,
        deviceId: device(req).id,
        status: { in: ['pending', 'sent'] },
      },
      data: { status: 'acked', ackedAt: new Date() },
    });
    if (updated.count === 0) throw notFound('Command not found or already acknowledged');
    return { ok: true };
  });

  app.post<CommandParams>('/device/commands/:commandId/result', auth, async (req) => {
    const body = commandResultSchema.parse(req.body);
    const updated = await prisma.deviceCommand.updateMany({
      where: {
        id: req.params.commandId,
        deviceId: device(req).id,
        status: { in: ['pending', 'sent', 'acked'] },
      },
      data: {
        status: body.status,
        result: (body.result ?? undefined) as Prisma.InputJsonValue | undefined,
        completedAt: new Date(),
      },
    });
    if (updated.count === 0) throw notFound('Command not found or already finished');
    return { ok: true };
  });

  // ---------- Media downloads ----------

  app.get<MediaFileParams>('/device/media/:mediaId/file', auth, async (req, reply) => {
    const dev = device(req);
    const query = mediaFileQuerySchema.parse(req.query);

    let cached = allowedMediaCache.get(dev.id);
    if (!cached || cached.expires < Date.now()) {
      cached = {
        ids: await allowedMediaIdsForDevice(prisma, dev.id),
        expires: Date.now() + ALLOWED_MEDIA_CACHE_TTL_MS,
      };
      allowedMediaCache.set(dev.id, cached);
    }
    if (!cached.ids.has(req.params.mediaId)) {
      throw forbidden('Media is not assigned to this device');
    }

    const media = await prisma.mediaAsset.findFirst({
      where: { id: req.params.mediaId, organizationId: dev.organizationId, deletedAt: null },
      include: { variants: true },
    });
    if (!media) throw notFound('Media not found');

    // The default `processed` variant resolves to the device's playback tier so
    // the served file matches the checksum advertised in the manifest.
    const storageKey =
      query.variant === 'thumbnail'
        ? media.thumbnailStorageKey
        : query.variant === 'original'
          ? media.originalStorageKey
          : selectVideoVariant(media, media.variants, dev.playbackProfile as PlaybackProfile)
              .storageKey;
    if (!storageKey) throw notFound(`No ${query.variant} variant available`);

    const url = await presignDownload(storageKey, 900);
    return reply.redirect(url, 302);
  });
}
