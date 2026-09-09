import type { FastifyInstance } from 'fastify';
import { startEmergencySchema } from '@signage/shared';
import type { PrismaClient } from '@signage/database';
import { authenticateUser, requireOrgRole } from '../plugins/auth';
import { badRequest, notFound } from '../lib/errors';
import { serializeEmergency } from '../lib/serializers';
import { writeAudit } from '../lib/audit';

type OrgParams = { Params: { orgId: string } };
type OverrideParams = { Params: { orgId: string; overrideId: string } };

const overrideInclude = {
  devices: { select: { deviceId: true } },
  groups: { select: { groupId: true } },
} as const;

async function affectedDeviceIds(
  prisma: PrismaClient,
  orgId: string,
  appliesToAll: boolean,
  deviceIds: string[],
  groupIds: string[],
): Promise<string[]> {
  if (appliesToAll) return []; // org-wide broadcast is used instead
  const ids = new Set(deviceIds);
  if (groupIds.length > 0) {
    const memberships = await prisma.deviceGroupMembership.findMany({
      where: { groupId: { in: groupIds }, device: { deletedAt: null } },
      select: { deviceId: true },
    });
    for (const m of memberships) ids.add(m.deviceId);
  }
  return [...ids];
}

export async function emergencyRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, wsHub } = app;
  app.addHook('preHandler', authenticateUser);

  app.get<OrgParams>('/orgs/:orgId/emergency', async (req) => {
    await requireOrgRole(prisma, req, req.params.orgId, 'viewer');
    const overrides = await prisma.emergencyOverride.findMany({
      where: { organizationId: req.params.orgId },
      include: overrideInclude,
      orderBy: [{ active: 'desc' }, { startedAt: 'desc' }],
      take: 50,
    });
    return overrides.map(serializeEmergency);
  });

  app.post<OrgParams>('/orgs/:orgId/emergency', async (req, reply) => {
    // Starting an override interrupts screens immediately — require admin.
    await requireOrgRole(prisma, req, req.params.orgId, 'admin');
    const body = startEmergencySchema.parse(req.body);

    if (body.playlistId) {
      const playlist = await prisma.playlist.findFirst({
        where: { id: body.playlistId, organizationId: req.params.orgId, deletedAt: null },
        select: { id: true },
      });
      if (!playlist) throw badRequest('Playlist does not exist in this organization');
    }
    if (body.mediaAssetId) {
      const media = await prisma.mediaAsset.findFirst({
        where: { id: body.mediaAssetId, organizationId: req.params.orgId, deletedAt: null },
        select: { processingStatus: true },
      });
      if (!media) throw badRequest('Media does not exist in this organization');
      if (media.processingStatus !== 'ready') {
        throw badRequest('Media is still processing and cannot be shown yet');
      }
    }
    if (!body.appliesToAll) {
      if (body.deviceIds.length > 0) {
        const count = await prisma.device.count({
          where: { id: { in: body.deviceIds }, organizationId: req.params.orgId, deletedAt: null },
        });
        if (count !== new Set(body.deviceIds).size) {
          throw badRequest('One or more devices do not exist in this organization');
        }
      }
      if (body.groupIds.length > 0) {
        const count = await prisma.deviceGroup.count({
          where: { id: { in: body.groupIds }, organizationId: req.params.orgId, deletedAt: null },
        });
        if (count !== new Set(body.groupIds).size) {
          throw badRequest('One or more groups do not exist in this organization');
        }
      }
    }

    const override = await prisma.emergencyOverride.create({
      data: {
        organizationId: req.params.orgId,
        name: body.name,
        playlistId: body.playlistId ?? null,
        mediaAssetId: body.mediaAssetId ?? null,
        active: true,
        appliesToAll: body.appliesToAll,
        // Display settings apply to single-media overrides only.
        fitMode: body.mediaAssetId ? (body.fitMode ?? null) : null,
        backgroundColor: body.mediaAssetId ? (body.backgroundColor ?? null) : null,
        positionMode: body.mediaAssetId ? (body.positionMode ?? null) : null,
        createdByUserId: req.user!.id,
        devices: body.appliesToAll
          ? undefined
          : { create: body.deviceIds.map((deviceId) => ({ deviceId })) },
        groups: body.appliesToAll
          ? undefined
          : { create: body.groupIds.map((groupId) => ({ groupId })) },
      },
      include: overrideInclude,
    });

    req.log.warn(
      { overrideId: override.id, orgId: req.params.orgId, appliesToAll: body.appliesToAll },
      'emergency override started',
    );
    // Starting an override blanks a customer's screens org-wide. It is the most
    // disruptive action in the product and was not audited at all.
    await writeAudit(prisma, req, {
      action: 'emergency.start',
      targetType: 'emergency_override',
      targetId: override.id,
      organizationId: req.params.orgId,
      metadata: {
        name: override.name,
        appliesToAll: body.appliesToAll,
        deviceCount: body.appliesToAll ? null : body.deviceIds.length,
        groupCount: body.appliesToAll ? null : body.groupIds.length,
        playlistId: override.playlistId,
        mediaAssetId: override.mediaAssetId,
      },
    });
    if (body.appliesToAll) {
      await wsHub.notifyOrgSyncRequired(req.params.orgId, 'emergency override started');
    } else {
      const targets = await affectedDeviceIds(
        prisma,
        req.params.orgId,
        false,
        body.deviceIds,
        body.groupIds,
      );
      await wsHub.notifySyncRequired(targets, 'emergency override started');
    }
    return reply.status(201).send(serializeEmergency(override));
  });

  app.post<OverrideParams>('/orgs/:orgId/emergency/:overrideId/stop', async (req) => {
    await requireOrgRole(prisma, req, req.params.orgId, 'admin');
    const override = await prisma.emergencyOverride.findFirst({
      where: { id: req.params.overrideId, organizationId: req.params.orgId },
      include: overrideInclude,
    });
    if (!override) throw notFound('Emergency override not found');
    if (!override.active) throw badRequest('Override is already stopped');

    const updated = await prisma.emergencyOverride.update({
      where: { id: override.id },
      data: { active: false, stoppedAt: new Date() },
      include: overrideInclude,
    });

    req.log.warn({ overrideId: override.id }, 'emergency override stopped');
    await writeAudit(prisma, req, {
      action: 'emergency.stop',
      targetType: 'emergency_override',
      targetId: override.id,
      organizationId: req.params.orgId,
      metadata: {
        name: override.name,
        appliesToAll: override.appliesToAll,
        // How long screens were actually overridden - the number an incident
        // review asks for first.
        durationSeconds: Math.round(
          ((updated.stoppedAt ?? new Date()).getTime() - override.startedAt.getTime()) / 1000,
        ),
      },
    });
    if (override.appliesToAll) {
      await wsHub.notifyOrgSyncRequired(req.params.orgId, 'emergency override stopped');
    } else {
      const targets = await affectedDeviceIds(
        prisma,
        req.params.orgId,
        false,
        override.devices.map((d) => d.deviceId),
        override.groups.map((g) => g.groupId),
      );
      await wsHub.notifySyncRequired(targets, 'emergency override stopped');
    }
    return serializeEmergency(updated);
  });
}
