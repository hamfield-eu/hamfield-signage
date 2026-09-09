import type { FastifyInstance } from 'fastify';
import {
  DEVICE_ORIENTATIONS,
  DEVICE_ROTATIONS,
  createDeviceSchema,
  issueCommandSchema,
  updateDeviceSchema,
  type DeviceOrientation,
  type DeviceRotation,
} from '@signage/shared';
import { authenticateUser, requireOrgRole } from '../plugins/auth';
import { badRequest, notFound } from '../lib/errors';
import { generatePairingCode } from '../lib/tokens';
import { presignDownload } from '../lib/s3';
import { serializeCommand, serializeDevice, serializeDeviceLog } from '../lib/serializers';
import { writeAudit } from '../lib/audit';
import { getEnv } from '../env';

type OrgParams = { Params: { orgId: string } };
type DeviceParams = { Params: { orgId: string; deviceId: string } };

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, wsHub } = app;
  app.addHook('preHandler', authenticateUser);

  async function getDeviceOr404(orgId: string, deviceId: string) {
    const device = await prisma.device.findFirst({
      where: { id: deviceId, organizationId: orgId, deletedAt: null },
      include: { groupMemberships: true },
    });
    if (!device) throw notFound('Device not found');
    return device;
  }

  app.get<OrgParams>('/orgs/:orgId/devices', async (req) => {
    await requireOrgRole(prisma, req, req.params.orgId, 'viewer');
    const devices = await prisma.device.findMany({
      where: { organizationId: req.params.orgId, deletedAt: null },
      include: { groupMemberships: true },
      orderBy: { name: 'asc' },
    });

    const playlistIds = [
      ...new Set(devices.map((d) => d.currentPlaylistId).filter((v): v is string => !!v)),
    ];
    const mediaIds = [
      ...new Set(devices.map((d) => d.currentMediaId).filter((v): v is string => !!v)),
    ];
    const [playlists, media] = await Promise.all([
      prisma.playlist.findMany({
        where: { id: { in: playlistIds } },
        select: { id: true, name: true },
      }),
      prisma.mediaAsset.findMany({
        where: { id: { in: mediaIds } },
        select: { id: true, name: true },
      }),
    ]);
    const playlistNames = new Map(playlists.map((p) => [p.id, p.name]));
    const mediaNames = new Map(media.map((m) => [m.id, m.name]));

    return devices.map((d) =>
      serializeDevice(d, {
        currentPlaylistName: d.currentPlaylistId
          ? (playlistNames.get(d.currentPlaylistId) ?? null)
          : null,
        currentMediaName: d.currentMediaId ? (mediaNames.get(d.currentMediaId) ?? null) : null,
      }),
    );
  });

  app.post<OrgParams>('/orgs/:orgId/devices', async (req, reply) => {
    await requireOrgRole(prisma, req, req.params.orgId, 'editor');
    const body = createDeviceSchema.parse(req.body);
    const env = getEnv();

    const device = await prisma.device.create({
      data: {
        organizationId: req.params.orgId,
        name: body.name,
        description: body.description,
        orientation: body.orientation,
        rotation: body.rotation,
        timezone: body.timezone,
        playbackProfile: body.playbackProfile,
        pairingCode: generatePairingCode(),
        pairingCodeExpiresAt: new Date(Date.now() + env.PAIRING_CODE_TTL_MINUTES * 60_000),
        groupMemberships: body.groupIds?.length
          ? { create: body.groupIds.map((groupId) => ({ groupId })) }
          : undefined,
      },
      include: { groupMemberships: true },
    });
    req.log.info({ deviceId: device.id, orgId: req.params.orgId }, 'device created');
    await writeAudit(prisma, req, {
      action: 'device.create',
      targetType: 'device',
      targetId: device.id,
      organizationId: req.params.orgId,
      metadata: { name: device.name },
    });
    return reply.status(201).send(serializeDevice(device));
  });

  app.get<DeviceParams>('/orgs/:orgId/devices/:deviceId', async (req) => {
    await requireOrgRole(prisma, req, req.params.orgId, 'viewer');
    const device = await getDeviceOr404(req.params.orgId, req.params.deviceId);
    const [playlist, media] = await Promise.all([
      device.currentPlaylistId
        ? prisma.playlist.findUnique({
            where: { id: device.currentPlaylistId },
            select: { name: true },
          })
        : null,
      device.currentMediaId
        ? prisma.mediaAsset.findUnique({
            where: { id: device.currentMediaId },
            select: { name: true },
          })
        : null,
    ]);
    return serializeDevice(device, {
      currentPlaylistName: playlist?.name ?? null,
      currentMediaName: media?.name ?? null,
    });
  });

  app.patch<DeviceParams>('/orgs/:orgId/devices/:deviceId', async (req) => {
    await requireOrgRole(prisma, req, req.params.orgId, 'editor');
    const device = await getDeviceOr404(req.params.orgId, req.params.deviceId);
    const body = updateDeviceSchema.parse(req.body);

    if (body.defaultPlaylistId) {
      const playlist = await prisma.playlist.findFirst({
        where: { id: body.defaultPlaylistId, organizationId: req.params.orgId, deletedAt: null },
      });
      if (!playlist)
        throw badRequest('defaultPlaylistId does not reference a playlist in this organization');
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (body.groupIds) {
        const validGroups = await tx.deviceGroup.findMany({
          where: { id: { in: body.groupIds }, organizationId: req.params.orgId, deletedAt: null },
          select: { id: true },
        });
        await tx.deviceGroupMembership.deleteMany({ where: { deviceId: device.id } });
        await tx.deviceGroupMembership.createMany({
          data: validGroups.map((g) => ({ deviceId: device.id, groupId: g.id })),
        });
      }
      return tx.device.update({
        where: { id: device.id },
        data: {
          name: body.name,
          description: body.description,
          orientation: body.orientation,
          rotation: body.rotation,
          timezone: body.timezone,
          playbackProfile: body.playbackProfile,
          defaultPlaylistId: body.defaultPlaylistId,
        },
        include: { groupMemberships: true },
      });
    });

    // A new playback tier may not be encoded yet — the device falls back to the
    // standard tier until the media is reprocessed (reprocess-media CLI).
    if (body.playbackProfile && body.playbackProfile !== device.playbackProfile) {
      req.log.info(
        { deviceId: device.id, playbackProfile: body.playbackProfile },
        'device playback tier changed — reprocess media to backfill the tier',
      );
    }
    await wsHub.notifySyncRequired([device.id], 'device settings updated');
    return serializeDevice(updated);
  });

  app.delete<DeviceParams>('/orgs/:orgId/devices/:deviceId', async (req, reply) => {
    await requireOrgRole(prisma, req, req.params.orgId, 'admin');
    const device = await getDeviceOr404(req.params.orgId, req.params.deviceId);
    await prisma.$transaction([
      prisma.device.update({
        where: { id: device.id },
        data: { deletedAt: new Date(), pairingCode: null },
      }),
      prisma.deviceToken.updateMany({
        where: { deviceId: device.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    req.log.info({ deviceId: device.id }, 'device soft-deleted, tokens revoked');
    await writeAudit(prisma, req, {
      action: 'device.delete',
      targetType: 'device',
      targetId: device.id,
      organizationId: req.params.orgId,
      metadata: { name: device.name },
    });
    return reply.status(204).send();
  });

  app.post<DeviceParams>('/orgs/:orgId/devices/:deviceId/regenerate-pairing-code', async (req) => {
    await requireOrgRole(prisma, req, req.params.orgId, 'editor');
    const device = await getDeviceOr404(req.params.orgId, req.params.deviceId);
    const env = getEnv();
    const updated = await prisma.device.update({
      where: { id: device.id },
      data: {
        pairingCode: generatePairingCode(),
        pairingCodeExpiresAt: new Date(Date.now() + env.PAIRING_CODE_TTL_MINUTES * 60_000),
      },
      include: { groupMemberships: true },
    });
    req.log.info({ deviceId: device.id }, 'pairing code regenerated');
    // Deliberately no code in the metadata: a pairing code is a credential, and
    // the audit log is readable by every superadmin.
    await writeAudit(prisma, req, {
      action: 'device.regenerate_pairing_code',
      targetType: 'device',
      targetId: device.id,
      organizationId: req.params.orgId,
      metadata: { name: device.name },
    });
    return serializeDevice(updated);
  });

  app.post<DeviceParams>('/orgs/:orgId/devices/:deviceId/revoke-token', async (req) => {
    await requireOrgRole(prisma, req, req.params.orgId, 'admin');
    const device = await getDeviceOr404(req.params.orgId, req.params.deviceId);
    const { count } = await prisma.deviceToken.updateMany({
      where: { deviceId: device.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    req.log.warn({ deviceId: device.id, revoked: count }, 'device tokens revoked');
    await writeAudit(prisma, req, {
      action: 'device.revoke_token',
      targetType: 'device',
      targetId: device.id,
      organizationId: req.params.orgId,
      metadata: { name: device.name, revoked: count },
    });
    return { revoked: count };
  });

  app.post<DeviceParams>('/orgs/:orgId/devices/:deviceId/commands', async (req, reply) => {
    await requireOrgRole(prisma, req, req.params.orgId, 'editor');
    const device = await getDeviceOr404(req.params.orgId, req.params.deviceId);
    const body = issueCommandSchema.parse(req.body);

    // Commands that change server-side state apply it immediately, then the
    // device is told to sync.
    if (body.type === 'set_orientation') {
      // Both axes are optional so a caller can change just the content
      // orientation, just the physical rotation, or both in one command.
      const { orientation, rotation } = body.payload as {
        orientation?: unknown;
        rotation?: unknown;
      };
      const data: { orientation?: DeviceOrientation; rotation?: DeviceRotation } = {};
      if (orientation !== undefined) {
        if (!(DEVICE_ORIENTATIONS as readonly unknown[]).includes(orientation)) {
          throw badRequest(`payload.orientation must be one of ${DEVICE_ORIENTATIONS.join(', ')}`);
        }
        data.orientation = orientation as DeviceOrientation;
      }
      if (rotation !== undefined) {
        if (!(DEVICE_ROTATIONS as readonly unknown[]).includes(rotation)) {
          throw badRequest(`payload.rotation must be one of ${DEVICE_ROTATIONS.join(', ')}`);
        }
        data.rotation = rotation as DeviceRotation;
      }
      if (data.orientation === undefined && data.rotation === undefined) {
        throw badRequest('set_orientation requires payload.orientation and/or payload.rotation');
      }
      await prisma.device.update({ where: { id: device.id }, data });
    } else if (body.type === 'set_playlist') {
      const playlistId = body.payload.playlistId;
      if (typeof playlistId !== 'string' && playlistId !== null) {
        throw badRequest('payload.playlistId must be a playlist id or null');
      }
      if (playlistId) {
        const playlist = await prisma.playlist.findFirst({
          where: { id: playlistId, organizationId: req.params.orgId, deletedAt: null },
        });
        if (!playlist) throw badRequest('Unknown playlist');
      }
      await prisma.device.update({
        where: { id: device.id },
        data: { defaultPlaylistId: playlistId },
      });
    } else if (body.type === 'update_settings') {
      const { name, timezone } = body.payload as { name?: unknown; timezone?: unknown };
      await prisma.device.update({
        where: { id: device.id },
        data: {
          name: typeof name === 'string' && name.length > 0 ? name : undefined,
          timezone: typeof timezone === 'string' && timezone.length > 0 ? timezone : undefined,
        },
      });
    }

    const command = await prisma.deviceCommand.create({
      data: {
        deviceId: device.id,
        type: body.type,
        payload: body.payload as object,
        createdByUserId: req.user!.id,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });

    await wsHub.sendToDevice(device.id, {
      type: 'command',
      command: { id: command.id, type: body.type, payload: body.payload },
    });
    const sent = await prisma.deviceCommand.update({
      where: { id: command.id },
      data: { status: 'sent', sentAt: new Date() },
    });

    req.log.info({ deviceId: device.id, commandId: command.id, type: body.type }, 'command issued');
    // reboot_device and software_update are disruptive and remote-triggered, so
    // who issued them has to be recoverable. The payload is recorded only for
    // command types known not to carry anything sensitive - software_update
    // payloads contain a URL, which may be signed.
    const payloadIsSafeToLog = body.type !== 'software_update';
    await writeAudit(prisma, req, {
      action: 'device.command',
      targetType: 'device_command',
      targetId: command.id,
      organizationId: req.params.orgId,
      metadata: {
        deviceId: device.id,
        deviceName: device.name,
        type: body.type,
        ...(payloadIsSafeToLog ? { payload: body.payload } : {}),
      },
    });
    return reply.status(201).send(serializeCommand(sent));
  });

  app.get<DeviceParams>('/orgs/:orgId/devices/:deviceId/commands', async (req) => {
    await requireOrgRole(prisma, req, req.params.orgId, 'viewer');
    await getDeviceOr404(req.params.orgId, req.params.deviceId);
    const commands = await prisma.deviceCommand.findMany({
      where: { deviceId: req.params.deviceId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return commands.map(serializeCommand);
  });

  app.get<DeviceParams & { Querystring: { limit?: string } }>(
    '/orgs/:orgId/devices/:deviceId/logs',
    async (req) => {
      await requireOrgRole(prisma, req, req.params.orgId, 'viewer');
      await getDeviceOr404(req.params.orgId, req.params.deviceId);
      const limit = Math.min(Number(req.query.limit) || 200, 1000);
      const logs = await prisma.deviceLog.findMany({
        where: { deviceId: req.params.deviceId },
        orderBy: { loggedAt: 'desc' },
        take: limit,
      });
      return logs.map(serializeDeviceLog);
    },
  );

  app.get<DeviceParams>('/orgs/:orgId/devices/:deviceId/heartbeats', async (req) => {
    await requireOrgRole(prisma, req, req.params.orgId, 'viewer');
    await getDeviceOr404(req.params.orgId, req.params.deviceId);
    const heartbeats = await prisma.deviceHeartbeat.findMany({
      where: { deviceId: req.params.deviceId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return heartbeats.map((h) => ({
      id: h.id,
      payload: h.payload,
      createdAt: h.createdAt.toISOString(),
    }));
  });

  app.get<DeviceParams>('/orgs/:orgId/devices/:deviceId/playback-events', async (req) => {
    await requireOrgRole(prisma, req, req.params.orgId, 'viewer');
    await getDeviceOr404(req.params.orgId, req.params.deviceId);
    const events = await prisma.playbackEvent.findMany({
      where: { deviceId: req.params.deviceId },
      orderBy: { occurredAt: 'desc' },
      take: 100,
    });
    return events.map((e) => ({
      id: e.id,
      deviceId: e.deviceId,
      mediaAssetId: e.mediaAssetId,
      playlistId: e.playlistId,
      eventType: e.eventType,
      detail: e.detail,
      occurredAt: e.occurredAt.toISOString(),
    }));
  });

  app.get<DeviceParams>('/orgs/:orgId/devices/:deviceId/screenshot', async (req) => {
    await requireOrgRole(prisma, req, req.params.orgId, 'viewer');
    await getDeviceOr404(req.params.orgId, req.params.deviceId);
    const screenshot = await prisma.deviceScreenshot.findFirst({
      where: { deviceId: req.params.deviceId },
      orderBy: { createdAt: 'desc' },
    });
    if (!screenshot) return { url: null, createdAt: null };
    return {
      url: await presignDownload(screenshot.storageKey, 300),
      createdAt: screenshot.createdAt.toISOString(),
    };
  });
}
