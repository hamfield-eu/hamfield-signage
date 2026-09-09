import type { FastifyInstance } from 'fastify';
import {
  createScheduleSchema,
  schedulePreviewQuerySchema,
  updateScheduleSchema,
} from '@signage/shared';
import { resolveActiveContent, type SchedulerSchedule } from '@signage/scheduler';
import type { Schedule } from '@signage/database';
import { authenticateUser, requireOrgRole } from '../plugins/auth';
import { badRequest, notFound } from '../lib/errors';
import { serializeSchedule } from '../lib/serializers';
import { writeAudit } from '../lib/audit';

type OrgParams = { Params: { orgId: string } };
type ScheduleParams = { Params: { orgId: string; scheduleId: string } };

const scheduleInclude = {
  playlist: true,
  deviceAssignments: { select: { deviceId: true } },
  groupAssignments: { select: { groupId: true } },
} as const;

function toSchedulerSchedule(s: Schedule): SchedulerSchedule {
  return {
    id: s.id,
    playlistId: s.playlistId,
    enabled: s.enabled,
    priority: s.priority,
    startDate: s.startDate,
    endDate: s.endDate,
    daysOfWeek: s.daysOfWeek,
    startTime: s.startTime,
    endTime: s.endTime,
    timezone: s.timezone,
    createdAt: s.createdAt.toISOString(),
  };
}

export async function scheduleRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, wsHub } = app;
  app.addHook('preHandler', authenticateUser);

  async function assertPlaylistInOrg(orgId: string, playlistId: string): Promise<void> {
    const playlist = await prisma.playlist.findFirst({
      where: { id: playlistId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!playlist) throw badRequest('Playlist does not exist in this organization');
  }

  async function assertTargetsInOrg(
    orgId: string,
    deviceIds: string[],
    groupIds: string[],
  ): Promise<void> {
    if (deviceIds.length > 0) {
      const count = await prisma.device.count({
        where: { id: { in: deviceIds }, organizationId: orgId, deletedAt: null },
      });
      if (count !== new Set(deviceIds).size) {
        throw badRequest('One or more devices do not exist in this organization');
      }
    }
    if (groupIds.length > 0) {
      const count = await prisma.deviceGroup.count({
        where: { id: { in: groupIds }, organizationId: orgId, deletedAt: null },
      });
      if (count !== new Set(groupIds).size) {
        throw badRequest('One or more groups do not exist in this organization');
      }
    }
  }

  app.get<OrgParams>('/orgs/:orgId/schedules', async (req) => {
    await requireOrgRole(prisma, req, req.params.orgId, 'viewer');
    const schedules = await prisma.schedule.findMany({
      where: { organizationId: req.params.orgId, deletedAt: null },
      include: scheduleInclude,
      orderBy: [{ priority: 'desc' }, { name: 'asc' }],
    });
    return schedules.map(serializeSchedule);
  });

  app.post<OrgParams>('/orgs/:orgId/schedules', async (req, reply) => {
    await requireOrgRole(prisma, req, req.params.orgId, 'editor');
    const body = createScheduleSchema.parse(req.body);
    await assertPlaylistInOrg(req.params.orgId, body.playlistId);
    await assertTargetsInOrg(req.params.orgId, body.deviceIds, body.groupIds);

    const schedule = await prisma.schedule.create({
      data: {
        organizationId: req.params.orgId,
        name: body.name,
        playlistId: body.playlistId,
        enabled: body.enabled,
        priority: body.priority,
        startDate: body.startDate ?? null,
        endDate: body.endDate ?? null,
        daysOfWeek: body.daysOfWeek,
        startTime: body.startTime ?? null,
        endTime: body.endTime ?? null,
        timezone: body.timezone ?? null,
        deviceAssignments: { create: body.deviceIds.map((deviceId) => ({ deviceId })) },
        groupAssignments: { create: body.groupIds.map((groupId) => ({ groupId })) },
      },
      include: scheduleInclude,
    });
    await wsHub.notifyOrgSyncRequired(req.params.orgId, 'schedule created');
    await writeAudit(prisma, req, {
      action: 'schedule.create',
      targetType: 'schedule',
      targetId: schedule.id,
      organizationId: req.params.orgId,
      metadata: { name: schedule.name, playlistId: schedule.playlistId, priority: schedule.priority },
    });
    return reply.status(201).send(serializeSchedule(schedule));
  });

  // Static segment route; Fastify prefers it over /schedules/:scheduleId.
  app.get<OrgParams>('/orgs/:orgId/schedules/preview', async (req) => {
    await requireOrgRole(prisma, req, req.params.orgId, 'viewer');
    const query = schedulePreviewQuerySchema.parse(req.query);
    const at = query.at ? new Date(query.at) : new Date();

    const device = await prisma.device.findFirst({
      where: { id: query.deviceId, organizationId: req.params.orgId, deletedAt: null },
      include: { groupMemberships: { select: { groupId: true } } },
    });
    if (!device) throw notFound('Device not found');
    const groupIds = device.groupMemberships.map((m) => m.groupId);

    const schedules = await prisma.schedule.findMany({
      where: {
        organizationId: req.params.orgId,
        deletedAt: null,
        enabled: true,
        OR: [
          { deviceAssignments: { some: { deviceId: device.id } } },
          ...(groupIds.length > 0
            ? [{ groupAssignments: { some: { groupId: { in: groupIds } } } }]
            : []),
        ],
      },
    });

    const activeOverride = await prisma.emergencyOverride.findFirst({
      where: {
        organizationId: req.params.orgId,
        active: true,
        OR: [
          { appliesToAll: true },
          { devices: { some: { deviceId: device.id } } },
          ...(groupIds.length > 0 ? [{ groups: { some: { groupId: { in: groupIds } } } }] : []),
        ],
      },
      orderBy: { startedAt: 'desc' },
    });

    const resolution = resolveActiveContent({
      schedules: schedules.map(toSchedulerSchedule),
      emergency: activeOverride
        ? {
            active: true,
            playlistId: activeOverride.playlistId,
            mediaAssetId: activeOverride.mediaAssetId,
          }
        : null,
      defaultPlaylistId: device.defaultPlaylistId,
      deviceTimezone: device.timezone,
      now: at,
    });

    const [playlist, media, schedule] = await Promise.all([
      resolution.playlistId
        ? prisma.playlist.findUnique({
            where: { id: resolution.playlistId },
            select: { name: true },
          })
        : null,
      resolution.mediaAssetId
        ? prisma.mediaAsset.findUnique({
            where: { id: resolution.mediaAssetId },
            select: { name: true },
          })
        : null,
      resolution.scheduleId
        ? prisma.schedule.findUnique({
            where: { id: resolution.scheduleId },
            select: { name: true },
          })
        : null,
    ]);

    return {
      ...resolution,
      playlistName: playlist?.name ?? null,
      mediaAssetName: media?.name ?? null,
      scheduleName: schedule?.name ?? null,
      evaluatedAt: at.toISOString(),
      timezone: device.timezone,
    };
  });

  app.get<ScheduleParams>('/orgs/:orgId/schedules/:scheduleId', async (req) => {
    await requireOrgRole(prisma, req, req.params.orgId, 'viewer');
    const schedule = await prisma.schedule.findFirst({
      where: { id: req.params.scheduleId, organizationId: req.params.orgId, deletedAt: null },
      include: scheduleInclude,
    });
    if (!schedule) throw notFound('Schedule not found');
    return serializeSchedule(schedule);
  });

  app.patch<ScheduleParams>('/orgs/:orgId/schedules/:scheduleId', async (req) => {
    await requireOrgRole(prisma, req, req.params.orgId, 'editor');
    const body = updateScheduleSchema.parse(req.body);
    const schedule = await prisma.schedule.findFirst({
      where: { id: req.params.scheduleId, organizationId: req.params.orgId, deletedAt: null },
    });
    if (!schedule) throw notFound('Schedule not found');

    // The partial schema loses the both-or-neither refinement; re-check the
    // effective time window after merging with the existing record.
    const effectiveStart = body.startTime !== undefined ? body.startTime : schedule.startTime;
    const effectiveEnd = body.endTime !== undefined ? body.endTime : schedule.endTime;
    if ((effectiveStart == null) !== (effectiveEnd == null)) {
      throw badRequest('startTime and endTime must both be set or both be empty');
    }

    if (body.playlistId) await assertPlaylistInOrg(req.params.orgId, body.playlistId);
    await assertTargetsInOrg(req.params.orgId, body.deviceIds ?? [], body.groupIds ?? []);

    const updated = await prisma.$transaction(async (tx) => {
      if (body.deviceIds) {
        await tx.scheduleDeviceAssignment.deleteMany({ where: { scheduleId: schedule.id } });
        await tx.scheduleDeviceAssignment.createMany({
          data: body.deviceIds.map((deviceId) => ({ scheduleId: schedule.id, deviceId })),
        });
      }
      if (body.groupIds) {
        await tx.scheduleGroupAssignment.deleteMany({ where: { scheduleId: schedule.id } });
        await tx.scheduleGroupAssignment.createMany({
          data: body.groupIds.map((groupId) => ({ scheduleId: schedule.id, groupId })),
        });
      }
      return tx.schedule.update({
        where: { id: schedule.id },
        data: {
          name: body.name,
          playlistId: body.playlistId,
          enabled: body.enabled,
          priority: body.priority,
          startDate: body.startDate,
          endDate: body.endDate,
          daysOfWeek: body.daysOfWeek,
          startTime: body.startTime,
          endTime: body.endTime,
          timezone: body.timezone,
        },
        include: scheduleInclude,
      });
    });

    await wsHub.notifyOrgSyncRequired(req.params.orgId, 'schedule updated');
    await writeAudit(prisma, req, {
      action: 'schedule.update',
      targetType: 'schedule',
      targetId: updated.id,
      organizationId: req.params.orgId,
      metadata: { name: updated.name, playlistId: updated.playlistId, priority: updated.priority },
    });
    return serializeSchedule(updated);
  });

  app.delete<ScheduleParams>('/orgs/:orgId/schedules/:scheduleId', async (req, reply) => {
    await requireOrgRole(prisma, req, req.params.orgId, 'editor');
    const schedule = await prisma.schedule.findFirst({
      where: { id: req.params.scheduleId, organizationId: req.params.orgId, deletedAt: null },
    });
    if (!schedule) throw notFound('Schedule not found');

    await prisma.schedule.update({
      where: { id: schedule.id },
      data: { deletedAt: new Date(), enabled: false },
    });
    await wsHub.notifyOrgSyncRequired(req.params.orgId, 'schedule deleted');
    await writeAudit(prisma, req, {
      action: 'schedule.delete',
      targetType: 'schedule',
      targetId: schedule.id,
      organizationId: req.params.orgId,
      metadata: { name: schedule.name, playlistId: schedule.playlistId, priority: schedule.priority },
    });
    return reply.status(204).send();
  });
}
