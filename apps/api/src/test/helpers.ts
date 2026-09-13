import { inject } from 'vitest';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { PrismaClient } from '@signage/database';
import { buildServer } from '../server';
import { hashPassword, signUserToken } from '../lib/auth';
import { generateDeviceToken } from '../lib/tokens';

/**
 * Shared integration-test harness.
 *
 * `buildServer({ prisma, logger })` already takes an injected Prisma client —
 * the app has always been testable through that seam; nobody had used it.
 * Everything here goes through `app.inject()`, which exercises the full Fastify
 * pipeline (preHandler hooks, the error handler, the rate limiter) without a
 * socket.
 */

/**
 * The connection string is threaded through the client, never through
 * `process.env.DATABASE_URL`: `getEnv()` caches its parse on the first call, so
 * a later env mutation would be silently ignored.
 */
export function testPrisma(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: inject('databaseUrl') } } });
}

/**
 * A fresh app per test file. Not shared: `routes/device-api.ts` caches the
 * media ids a device may fetch for 30 seconds per instance, so one app across
 * files would leak authorization decisions between tests.
 */
export async function buildTestApp(prisma: PrismaClient): Promise<FastifyInstance> {
  // Must happen before the first getEnv(), which buildServer triggers.
  process.env.REDIS_URL = inject('redisUrl');
  const app = await buildServer({ prisma, logger: false });
  await app.ready();
  return app;
}

/** Every table except Prisma's own bookkeeping, so a test starts from nothing. */
export async function resetDb(prisma: PrismaClient): Promise<void> {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * Rate limiting is global (300/min, keyed by `req.ip` off the socket address).
 * The authorization matrix alone is ~1,000 injections, and a 429 looks exactly
 * like an authorization failure. Giving every request its own source address
 * keeps each bucket at one request — without changing application code, which
 * this task is not allowed to do.
 */
let ipCounter = 0;
export function nextIp(): string {
  const n = ipCounter++;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

/** The HTTP verbs `app.inject()` accepts — narrower than Fastify's HTTPMethods. */
export type InjectMethod = NonNullable<InjectOptions['method']>;

export interface CallOptions extends Omit<InjectOptions, 'headers'> {
  /** User JWT or raw device token. */
  token?: string | null;
  headers?: Record<string, string>;
}

export async function call(
  app: FastifyInstance,
  options: CallOptions,
): Promise<LightMyRequestResponse> {
  const { token, headers, ...rest } = options;
  return app.inject({
    ...rest,
    remoteAddress: rest.remoteAddress ?? nextIp(),
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
}

// ------------------------------------------------------------------ fixtures

export const ORG_ROLES = ['viewer', 'editor', 'admin', 'owner'] as const;
export type SeedRole = (typeof ORG_ROLES)[number];

export interface SeededOrg {
  id: string;
  slug: string;
  users: Record<SeedRole, { id: string; email: string; token: string }>;
  deviceId: string;
  deviceToken: string;
  groupId: string;
  folderId: string;
  mediaId: string;
  /** Media that is not `ready` — must never reach a manifest. */
  pendingMediaId: string;
  playlistId: string;
  playlistItemId: string;
  priorityRuleId: string;
  scheduleId: string;
  overrideId: string;
  commandId: string;
  membershipId: string;
}

export interface Fixture {
  /** The organization under test. */
  a: SeededOrg;
  /** A second, complete organization. Every id here is a cross-tenant probe. */
  b: SeededOrg;
  superadmin: { id: string; email: string; token: string };
  /** Disabled account, an admin of org A — a valid token for a dead account. */
  disabledUser: { id: string; email: string; token: string };
  /** Org with `status: disabled`: members are out, superadmins are not. */
  disabledOrg: { id: string; ownerToken: string };
  /** Org with `deletedAt` set: nobody gets in, superadmins included. */
  deletedOrg: { id: string; ownerToken: string };
  /** A syntactically valid token for a user id that does not exist. */
  strangerToken: string;
}

export const FIXTURE_PASSWORD = 'correct-horse-battery-staple';

/**
 * bcrypt once, not once per user. The matrix re-seeds before every route, and
 * ten hashes per seed dominated the runtime of the whole suite.
 */
let passwordHash: Promise<string> | undefined;
function fixturePasswordHash(): Promise<string> {
  if (!passwordHash) passwordHash = hashPassword(FIXTURE_PASSWORD);
  return passwordHash;
}

async function makeUser(
  prisma: PrismaClient,
  email: string,
  globalRole: 'user' | 'superadmin' = 'user',
  disabled = false,
) {
  const user = await prisma.user.create({
    data: {
      email,
      name: email,
      passwordHash: await fixturePasswordHash(),
      globalRole,
      disabledAt: disabled ? new Date() : null,
    },
  });
  return {
    id: user.id,
    email: user.email,
    token: signUserToken({ sub: user.id, email: user.email }),
  };
}

/** Issues a real device token row and returns the raw value (never stored). */
export async function deviceTokenFor(prisma: PrismaClient, deviceId: string): Promise<string> {
  const { token, hash } = generateDeviceToken();
  await prisma.deviceToken.create({ data: { deviceId, tokenHash: hash } });
  return token;
}

async function seedOrg(prisma: PrismaClient, key: string): Promise<SeededOrg> {
  const org = await prisma.organization.create({
    data: { name: `Org ${key}`, slug: `org-${key}` },
  });

  const users = {} as SeededOrg['users'];
  for (const role of ORG_ROLES) {
    const user = await makeUser(prisma, `${role}@${key}.test`);
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: user.id, role },
    });
    users[role] = user;
  }

  const folder = await prisma.mediaFolder.create({
    data: { organizationId: org.id, name: `Folder ${key}` },
  });

  // Deliberately the same name in both organizations: a list endpoint that
  // leaks is much easier to spot when the rows are indistinguishable by name.
  const media = await prisma.mediaAsset.create({
    data: {
      organizationId: org.id,
      folderId: folder.id,
      name: 'Shared name',
      originalFilename: 'clip.mp4',
      mediaType: 'video',
      originalMimeType: 'video/mp4',
      originalStorageKey: `${key}/clip.mp4`,
      processedStorageKey: `${key}/clip.processed.mp4`,
      processedMimeType: 'video/mp4',
      processingStatus: 'ready',
      durationSeconds: 30,
      width: 1920,
      height: 1080,
      orientation: 'landscape',
      sizeBytes: BigInt(1024),
      processedSizeBytes: BigInt(900),
      checksumSha256: `${'0'.repeat(63)}${key === 'a' ? '1' : '2'}`,
    },
  });

  const pendingMedia = await prisma.mediaAsset.create({
    data: {
      organizationId: org.id,
      name: 'Still processing',
      originalFilename: 'raw.mp4',
      mediaType: 'video',
      originalMimeType: 'video/mp4',
      originalStorageKey: `${key}/raw.mp4`,
      processingStatus: 'processing',
    },
  });

  const playlist = await prisma.playlist.create({
    data: { organizationId: org.id, name: `Playlist ${key}` },
  });
  const item = await prisma.playlistItem.create({
    data: { playlistId: playlist.id, mediaAssetId: media.id, position: 0 },
  });
  const rule = await prisma.playlistPriorityRule.create({
    data: {
      organizationId: org.id,
      playlistId: playlist.id,
      name: 'Sponsor',
      intervalCount: 3,
    },
  });

  const device = await prisma.device.create({
    data: {
      organizationId: org.id,
      name: `Screen ${key}`,
      defaultPlaylistId: playlist.id,
      pairedAt: new Date(),
    },
  });
  const deviceToken = await deviceTokenFor(prisma, device.id);

  const group = await prisma.deviceGroup.create({
    data: { organizationId: org.id, name: `Group ${key}` },
  });
  await prisma.deviceGroupMembership.create({
    data: { deviceId: device.id, groupId: group.id },
  });

  const schedule = await prisma.schedule.create({
    data: {
      organizationId: org.id,
      name: `Schedule ${key}`,
      playlistId: playlist.id,
      daysOfWeek: [1, 2, 3, 4, 5],
      startTime: '08:00',
      endTime: '18:00',
    },
  });
  await prisma.scheduleDeviceAssignment.create({
    data: { scheduleId: schedule.id, deviceId: device.id },
  });

  // Stopped, so it does not mask the scheduled playlist in manifest tests.
  const override = await prisma.emergencyOverride.create({
    data: {
      organizationId: org.id,
      name: `Emergency ${key}`,
      mediaAssetId: media.id,
      appliesToAll: true,
      active: false,
      stoppedAt: new Date(),
    },
  });

  const command = await prisma.deviceCommand.create({
    data: { deviceId: device.id, type: 'identify', payload: {} },
  });

  const membership = await prisma.organizationMember.findFirstOrThrow({
    where: { organizationId: org.id, userId: users.viewer.id },
  });

  return {
    id: org.id,
    slug: org.slug,
    users,
    deviceId: device.id,
    deviceToken,
    groupId: group.id,
    folderId: folder.id,
    mediaId: media.id,
    pendingMediaId: pendingMedia.id,
    playlistId: playlist.id,
    playlistItemId: item.id,
    priorityRuleId: rule.id,
    scheduleId: schedule.id,
    overrideId: override.id,
    commandId: command.id,
    membershipId: membership.id,
  };
}

/**
 * Two complete organizations, A and B, deliberately identical in shape. Every
 * id in B is a probe for a missing organization scope in a route that takes an
 * id from the URL.
 */
export async function seedFixture(prisma: PrismaClient): Promise<Fixture> {
  const a = await seedOrg(prisma, 'a');
  const b = await seedOrg(prisma, 'b');

  const superadmin = await makeUser(prisma, 'root@platform.test', 'superadmin');

  const disabledUser = await makeUser(prisma, 'disabled@a.test', 'user', true);
  await prisma.organizationMember.create({
    data: { organizationId: a.id, userId: disabledUser.id, role: 'admin' },
  });

  const disabledOrgRow = await prisma.organization.create({
    data: { name: 'Disabled Org', slug: 'disabled-org', status: 'disabled' },
  });
  const disabledOrgOwner = await makeUser(prisma, 'owner@disabled.test');
  await prisma.organizationMember.create({
    data: { organizationId: disabledOrgRow.id, userId: disabledOrgOwner.id, role: 'owner' },
  });

  const deletedOrgRow = await prisma.organization.create({
    data: { name: 'Deleted Org', slug: 'deleted-org', deletedAt: new Date() },
  });
  const deletedOrgOwner = await makeUser(prisma, 'owner@deleted.test');
  await prisma.organizationMember.create({
    data: { organizationId: deletedOrgRow.id, userId: deletedOrgOwner.id, role: 'owner' },
  });

  return {
    a,
    b,
    superadmin,
    disabledUser,
    disabledOrg: { id: disabledOrgRow.id, ownerToken: disabledOrgOwner.token },
    deletedOrg: { id: deletedOrgRow.id, ownerToken: deletedOrgOwner.token },
    strangerToken: signUserToken({ sub: 'clh0000000000000000000000', email: 'ghost@nowhere.test' }),
  };
}
