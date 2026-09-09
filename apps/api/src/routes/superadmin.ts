import type { FastifyInstance } from 'fastify';
import {
  superadminAddMemberSchema,
  superadminCreateOrgSchema,
  superadminCreateUserSchema,
  superadminResetPasswordSchema,
  superadminUpdateMemberSchema,
  superadminUpdateOrgSchema,
  superadminUpdateUserSchema,
  type SuperadminOrganizationDto,
  type SuperadminUserDto,
  OFFLINE_THRESHOLD_SECONDS,
} from '@signage/shared';
import { hashPassword } from '../lib/auth';
import { authenticateUser, requireSuperadmin } from '../plugins/auth';
import { badRequest, conflict, notFound } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { orgLogoUrl, serializeOrg } from '../lib/serializers';
import { readyReport } from '../lib/health';
import { getRedisPub } from '../lib/redis';
import { getMediaQueue } from '../lib/queues';

type OrgParams = { Params: { orgId: string } };
type UserParams = { Params: { userId: string } };
type MemberParams = { Params: { orgId: string; membershipId: string } };

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 8);
  return base ? `${base}-${suffix}` : suffix;
}

/** Shape returned by GET /superadmin/platform-health. */
export interface PlatformHealthDto {
  dependencies: Awaited<ReturnType<typeof readyReport>>;
  fleet: { total: number; online: number; offline: number; syncError: number };
  media: { pending: number; processing: number; failed: number };
  activeOverrides: Array<{ id: string; name: string; organizationName: string; hoursActive: number }>;
  queue: { waiting: number; active: number } | null;
  lastRetentionRun: { at: string; dryRun: boolean; totalDeleted: number } | null;
  lastBackupAt: string | null;
}

export async function superadminRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;
  app.addHook('preHandler', authenticateUser);
  // Every route below requires an active superadmin.
  app.addHook('preHandler', async (req) => {
    await requireSuperadmin(prisma, req);
  });

  // ---------- Organizations ----------

  app.get('/superadmin/organizations', async (): Promise<SuperadminOrganizationDto[]> => {
    const orgs = await prisma.organization.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: {
            devices: { where: { deletedAt: null } },
            members: true,
            mediaAssets: { where: { deletedAt: null } },
          },
        },
      },
    });
    const storage = await prisma.mediaAsset.groupBy({
      by: ['organizationId'],
      where: { deletedAt: null },
      _sum: { sizeBytes: true, processedSizeBytes: true },
    });
    const storageByOrg = new Map(
      storage.map((s) => [
        s.organizationId,
        Number(s._sum.sizeBytes ?? 0n) + Number(s._sum.processedSizeBytes ?? 0n),
      ]),
    );
    return Promise.all(
      orgs.map(async (org) => ({
        ...serializeOrg(org, undefined, { logoUrl: await orgLogoUrl(org) }),
        deviceCount: org._count.devices,
        userCount: org._count.members,
        mediaCount: org._count.mediaAssets,
        storageUsedBytes: storageByOrg.get(org.id) ?? 0,
      })),
    );
  });

  app.post('/superadmin/organizations', async (req, reply) => {
    const body = superadminCreateOrgSchema.parse(req.body);
    const slug = body.slug ?? slugify(body.name);
    const existing = await prisma.organization.findUnique({ where: { slug } });
    if (existing) throw conflict(`An organization with slug "${slug}" already exists`);

    const org = await prisma.organization.create({
      data: {
        name: body.name,
        slug,
        status: body.status,
        planName: body.planName ?? null,
        maxDevices: body.maxDevices ?? null,
        maxStorageGb: body.maxStorageGb ?? null,
      },
    });
    await writeAudit(prisma, req, {
      action: 'superadmin.organization.create',
      targetType: 'organization',
      targetId: org.id,
      organizationId: org.id,
      actorGlobalRole: 'superadmin',
      metadata: { name: org.name, slug: org.slug },
    });
    return reply.status(201).send(serializeOrg(org));
  });

  app.patch<OrgParams>('/superadmin/organizations/:orgId', async (req) => {
    const body = superadminUpdateOrgSchema.parse(req.body);
    const org = await prisma.organization.findFirst({
      where: { id: req.params.orgId, deletedAt: null },
    });
    if (!org) throw notFound('Organization not found');

    const updated = await prisma.organization.update({
      where: { id: org.id },
      data: {
        name: body.name,
        status: body.status,
        planName: body.planName,
        maxDevices: body.maxDevices,
        maxStorageGb: body.maxStorageGb,
      },
    });
    await writeAudit(prisma, req, {
      action:
        body.status && body.status !== org.status
          ? body.status === 'disabled'
            ? 'superadmin.organization.disable'
            : 'superadmin.organization.enable'
          : 'superadmin.organization.update',
      targetType: 'organization',
      targetId: org.id,
      organizationId: org.id,
      actorGlobalRole: 'superadmin',
      metadata: { changes: body as Record<string, unknown> },
    });
    return serializeOrg(updated);
  });

  // ---------- Users ----------

  const userInclude = {
    memberships: { include: { organization: true } },
  } as const;

  type UserWithMemberships = Awaited<
    ReturnType<typeof prisma.user.findFirstOrThrow<{ include: typeof userInclude }>>
  >;

  function serializeSuperadminUser(user: UserWithMemberships): SuperadminUserDto {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      globalRole: user.globalRole as SuperadminUserDto['globalRole'],
      mustChangePassword: user.mustChangePassword,
      disabledAt: user.disabledAt ? user.disabledAt.toISOString() : null,
      createdAt: user.createdAt.toISOString(),
      memberships: user.memberships
        .filter((m) => !m.organization.deletedAt)
        .map((m) => ({
          membershipId: m.id,
          organizationId: m.organizationId,
          organizationName: m.organization.name,
          role: m.role as SuperadminUserDto['memberships'][number]['role'],
        })),
    };
  }

  app.get('/superadmin/users', async () => {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      include: userInclude,
    });
    return users.map(serializeSuperadminUser);
  });

  app.post('/superadmin/users', async (req, reply) => {
    const body = superadminCreateUserSchema.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) throw conflict('A user with this email already exists');

    if (body.memberships.length > 0) {
      const orgCount = await prisma.organization.count({
        where: { id: { in: body.memberships.map((m) => m.organizationId) }, deletedAt: null },
      });
      if (orgCount !== new Set(body.memberships.map((m) => m.organizationId)).size) {
        throw badRequest('One or more organizations do not exist');
      }
    }

    const user = await prisma.user.create({
      data: {
        email: body.email,
        name: body.name,
        passwordHash: await hashPassword(body.password),
        mustChangePassword: body.mustChangePassword,
        memberships: {
          create: body.memberships.map((m) => ({
            organizationId: m.organizationId,
            role: m.role,
          })),
        },
      },
      include: userInclude,
    });
    await writeAudit(prisma, req, {
      action: 'superadmin.user.create',
      targetType: 'user',
      targetId: user.id,
      actorGlobalRole: 'superadmin',
      metadata: {
        email: user.email,
        memberships: body.memberships as unknown as Record<string, unknown>[],
      },
    });
    return reply.status(201).send(serializeSuperadminUser(user));
  });

  app.patch<UserParams>('/superadmin/users/:userId', async (req) => {
    const body = superadminUpdateUserSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!user) throw notFound('User not found');
    if (user.globalRole === 'superadmin' && body.disabled) {
      throw badRequest('Superadmin accounts cannot be disabled from the dashboard');
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        name: body.name,
        ...(body.disabled === undefined
          ? {}
          : { disabledAt: body.disabled ? (user.disabledAt ?? new Date()) : null }),
      },
      include: userInclude,
    });
    if (body.disabled !== undefined && Boolean(user.disabledAt) !== body.disabled) {
      await writeAudit(prisma, req, {
        action: body.disabled ? 'superadmin.user.disable' : 'superadmin.user.enable',
        targetType: 'user',
        targetId: user.id,
        actorGlobalRole: 'superadmin',
      });
    }
    return serializeSuperadminUser(updated);
  });

  app.post<UserParams>('/superadmin/users/:userId/reset-password', async (req) => {
    const body = superadminResetPasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!user) throw notFound('User not found');

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(body.password),
        mustChangePassword: body.mustChangePassword,
        // Kills every outstanding session for the account being reset. A
        // superadmin resetting someone's password should lock out whoever may
        // be holding a stolen token, not just change the credential.
        passwordChangedAt: new Date(),
      },
    });
    await writeAudit(prisma, req, {
      action: 'superadmin.user.reset_password',
      targetType: 'user',
      targetId: user.id,
      actorGlobalRole: 'superadmin',
    });
    return { ok: true };
  });

  // ---------- Organization memberships ----------

  app.post<OrgParams>('/superadmin/organizations/:orgId/members', async (req, reply) => {
    const body = superadminAddMemberSchema.parse(req.body);
    const org = await prisma.organization.findFirst({
      where: { id: req.params.orgId, deletedAt: null },
    });
    if (!org) throw notFound('Organization not found');
    const user = await prisma.user.findUnique({ where: { id: body.userId } });
    if (!user) throw notFound('User not found');

    const existing = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
    });
    if (existing) throw conflict('User is already a member of this organization');

    const member = await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: user.id, role: body.role },
    });
    await writeAudit(prisma, req, {
      action: 'superadmin.member.add',
      targetType: 'organization_member',
      targetId: member.id,
      organizationId: org.id,
      actorGlobalRole: 'superadmin',
      metadata: { userId: user.id, role: body.role },
    });
    return reply.status(201).send({ id: member.id, role: member.role });
  });

  app.patch<MemberParams>('/superadmin/organizations/:orgId/members/:membershipId', async (req) => {
    const body = superadminUpdateMemberSchema.parse(req.body);
    const member = await prisma.organizationMember.findFirst({
      where: { id: req.params.membershipId, organizationId: req.params.orgId },
    });
    if (!member) throw notFound('Membership not found');

    const updated = await prisma.organizationMember.update({
      where: { id: member.id },
      data: { role: body.role },
    });
    await writeAudit(prisma, req, {
      action: 'superadmin.member.change_role',
      targetType: 'organization_member',
      targetId: member.id,
      organizationId: req.params.orgId,
      actorGlobalRole: 'superadmin',
      metadata: { userId: member.userId, from: member.role, to: body.role },
    });
    return { id: updated.id, role: updated.role };
  });

  app.delete<MemberParams>(
    '/superadmin/organizations/:orgId/members/:membershipId',
    async (req, reply) => {
      const member = await prisma.organizationMember.findFirst({
        where: { id: req.params.membershipId, organizationId: req.params.orgId },
      });
      if (!member) throw notFound('Membership not found');
      await prisma.organizationMember.delete({ where: { id: member.id } });
      await writeAudit(prisma, req, {
        action: 'superadmin.member.remove',
        targetType: 'organization_member',
        targetId: member.id,
        organizationId: req.params.orgId,
        actorGlobalRole: 'superadmin',
        metadata: { userId: member.userId },
      });
      return reply.status(204).send();
    },
  );

  // ---------- Audit log ----------

  // ---------- Platform health ----------

  // The operational picture in one request, for the superadmin dashboard.
  //
  // This exists because /health/ready is registered outside /api/v1 and is
  // therefore NOT proxied - per-dependency latencies are a diagnostic surface, not
  // a public one. Rather than exposing it, this route reuses the same report
  // behind superadmin auth, and adds the fleet-level numbers the alert conditions
  // in the worker are evaluating, so the dashboard and the alerts cannot disagree.
  app.get('/superadmin/platform-health', async (): Promise<PlatformHealthDto> => {
    const now = new Date();
    const offlineBefore = new Date(now.getTime() - OFFLINE_THRESHOLD_SECONDS * 1000);

    const [dependencies, total, online, syncError, mediaCounts, overrides, lastRun, lastBackupAt] =
      await Promise.all([
        readyReport(prisma),
        prisma.device.count({ where: { deletedAt: null } }),
        prisma.device.count({ where: { deletedAt: null, lastSeenAt: { gte: offlineBefore } } }),
        prisma.device.count({ where: { deletedAt: null, syncStatus: 'error' } }),
        prisma.mediaAsset.groupBy({
          by: ['processingStatus'],
          where: { deletedAt: null },
          _count: { _all: true },
        }),
        prisma.emergencyOverride.findMany({
          where: { active: true },
          select: { id: true, name: true, startedAt: true, organization: { select: { name: true } } },
          orderBy: { startedAt: 'asc' },
        }),
        prisma.auditLog.findFirst({
          where: { action: 'retention.run' },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true, metadata: true },
        }),
        getRedisPub()
          .get('signage:backup:last-success')
          .catch(() => null),
      ]);

    const countFor = (status: string) =>
      mediaCounts.find((m) => m.processingStatus === status)?._count._all ?? 0;

    let queue: PlatformHealthDto['queue'] = null;
    try {
      const q = getMediaQueue();
      queue = { waiting: await q.getWaitingCount(), active: await q.getActiveCount() };
    } catch {
      // Redis already appears in `dependencies`; do not fail the whole page for it.
    }

    const meta = (lastRun?.metadata ?? null) as { dryRun?: boolean; totalDeleted?: number } | null;

    return {
      dependencies,
      fleet: { total, online, offline: total - online, syncError },
      media: {
        pending: countFor('pending'),
        processing: countFor('processing'),
        failed: countFor('failed'),
      },
      activeOverrides: overrides.map((o) => ({
        id: o.id,
        name: o.name ?? 'unnamed override',
        organizationName: o.organization?.name ?? 'unknown org',
        hoursActive: (now.getTime() - o.startedAt.getTime()) / 3_600_000,
      })),
      queue,
      lastRetentionRun: lastRun
        ? {
            at: lastRun.createdAt.toISOString(),
            dryRun: meta?.dryRun ?? true,
            totalDeleted: meta?.totalDeleted ?? 0,
          }
        : null,
      lastBackupAt,
    };
  });

  app.get('/superadmin/audit-logs', async (req) => {
    const query = (req.query ?? {}) as { page?: string; pageSize?: string };
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 50));
    const [total, logs] = await Promise.all([
      prisma.auditLog.count(),
      prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { actor: { select: { name: true } } },
      }),
    ]);
    return {
      total,
      page,
      pageSize,
      items: logs.map((log) => ({
        id: log.id,
        actorUserId: log.actorUserId,
        actorName: log.actor?.name ?? null,
        actorGlobalRole: log.actorGlobalRole,
        organizationId: log.organizationId,
        targetType: log.targetType,
        targetId: log.targetId,
        action: log.action,
        metadata: (log.metadata ?? {}) as Record<string, unknown>,
        ipAddress: log.ipAddress,
        createdAt: log.createdAt.toISOString(),
      })),
    };
  });
}
