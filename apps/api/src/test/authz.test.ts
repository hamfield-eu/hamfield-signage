import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@signage/database';
import {
  FIXTURE_PASSWORD,
  ORG_ROLES,
  buildTestApp,
  type InjectMethod,
  call,
  resetDb,
  seedFixture,
  testPrisma,
  type Fixture,
  type SeedRole,
  type SeededOrg,
} from './helpers';

/**
 * The route × role matrix.
 *
 * Every org-scoped route is called as every kind of caller and the *category*
 * of the answer is asserted: denied means exactly 401 or 403, allowed means
 * anything else. That distinction is the security boundary. Whether an allowed
 * caller then gets 200, 400 or 404 is the handler's business and is asserted by
 * the suites that care about it — pinning exact success codes here would make
 * the matrix brittle without making it stricter.
 *
 * Written as a data table so that adding a route without adding a row is
 * visible in review. The completeness check at the bottom makes it more than a
 * convention: it fails if a registered route is missing from this file.
 */

type Access = SeedRole | 'superadmin' | 'authenticated';

interface RouteSpec {
  method: InjectMethod;
  /** `org` supplies the resource ids; `orgId` is the id in the URL. */
  url: (org: SeededOrg, orgId: string) => string;
  access: Access;
  body?: (org: SeededOrg) => Record<string, unknown>;
  /**
   * Route pattern for the test name and the completeness check, when the
   * placeholder fixture cannot produce it — the org and superadmin member
   * routes name the same id `:memberId` and `:membershipId` respectively.
   */
  pattern?: string;
  /** Why an allowed caller may legitimately not reach a 2xx here. */
  note?: string;
}

const ROLE_RANK: Record<SeedRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

const ORG_ROUTES: RouteSpec[] = [
  // ---------------------------------------------------------- device groups
  { method: 'GET', url: (_o, id) => `/orgs/${id}/device-groups`, access: 'viewer' },
  {
    method: 'POST',
    url: (_o, id) => `/orgs/${id}/device-groups`,
    access: 'editor',
    body: () => ({ name: 'New group' }),
  },
  { method: 'GET', url: (o, id) => `/orgs/${id}/device-groups/${o.groupId}`, access: 'viewer' },
  {
    method: 'PATCH',
    url: (o, id) => `/orgs/${id}/device-groups/${o.groupId}`,
    access: 'editor',
    body: () => ({ name: 'Renamed' }),
  },
  { method: 'DELETE', url: (o, id) => `/orgs/${id}/device-groups/${o.groupId}`, access: 'editor' },

  // --------------------------------------------------------------- devices
  { method: 'GET', url: (_o, id) => `/orgs/${id}/devices`, access: 'viewer' },
  {
    method: 'POST',
    url: (_o, id) => `/orgs/${id}/devices`,
    access: 'editor',
    body: () => ({ name: 'New screen' }),
  },
  { method: 'GET', url: (o, id) => `/orgs/${id}/devices/${o.deviceId}`, access: 'viewer' },
  {
    method: 'PATCH',
    url: (o, id) => `/orgs/${id}/devices/${o.deviceId}`,
    access: 'editor',
    body: () => ({ name: 'Renamed screen' }),
  },
  { method: 'DELETE', url: (o, id) => `/orgs/${id}/devices/${o.deviceId}`, access: 'admin' },
  {
    method: 'POST',
    url: (o, id) => `/orgs/${id}/devices/${o.deviceId}/regenerate-pairing-code`,
    access: 'editor',
  },
  {
    method: 'POST',
    url: (o, id) => `/orgs/${id}/devices/${o.deviceId}/revoke-token`,
    access: 'admin',
  },
  {
    method: 'POST',
    url: (o, id) => `/orgs/${id}/devices/${o.deviceId}/commands`,
    access: 'editor',
    body: () => ({ type: 'identify' }),
  },
  { method: 'GET', url: (o, id) => `/orgs/${id}/devices/${o.deviceId}/commands`, access: 'viewer' },
  { method: 'GET', url: (o, id) => `/orgs/${id}/devices/${o.deviceId}/logs`, access: 'viewer' },
  {
    method: 'GET',
    url: (o, id) => `/orgs/${id}/devices/${o.deviceId}/heartbeats`,
    access: 'viewer',
  },
  {
    method: 'GET',
    url: (o, id) => `/orgs/${id}/devices/${o.deviceId}/playback-events`,
    access: 'viewer',
  },
  {
    method: 'GET',
    url: (o, id) => `/orgs/${id}/devices/${o.deviceId}/screenshot`,
    access: 'viewer',
    note: '404 when the device has never uploaded one',
  },

  // ------------------------------------------------------------- emergency
  { method: 'GET', url: (_o, id) => `/orgs/${id}/emergency`, access: 'viewer' },
  {
    method: 'POST',
    url: (o, id) => `/orgs/${id}/emergency`,
    access: 'admin',
    body: (o) => ({ playlistId: o.playlistId, appliesToAll: true }),
  },
  {
    method: 'POST',
    url: (o, id) => `/orgs/${id}/emergency/${o.overrideId}/stop`,
    access: 'admin',
    note: 'the seeded override is already stopped',
  },

  // ---------------------------------------------------------- media folders
  { method: 'GET', url: (_o, id) => `/orgs/${id}/media/folders`, access: 'viewer' },
  {
    method: 'POST',
    url: (_o, id) => `/orgs/${id}/media/folders`,
    access: 'editor',
    body: () => ({ name: 'New folder' }),
  },
  {
    method: 'PATCH',
    url: (o, id) => `/orgs/${id}/media/folders/${o.folderId}`,
    access: 'editor',
    body: () => ({ name: 'Renamed folder' }),
  },
  {
    method: 'GET',
    url: (o, id) => `/orgs/${id}/media/folders/${o.folderId}/usage`,
    access: 'viewer',
  },
  { method: 'DELETE', url: (o, id) => `/orgs/${id}/media/folders/${o.folderId}`, access: 'editor' },

  // ----------------------------------------------------------------- media
  {
    method: 'POST',
    url: (_o, id) => `/orgs/${id}/media`,
    access: 'editor',
    note: 'multipart upload; without a file body it fails validation after the role check',
  },
  { method: 'GET', url: (_o, id) => `/orgs/${id}/media`, access: 'viewer' },
  { method: 'GET', url: (o, id) => `/orgs/${id}/media/${o.mediaId}`, access: 'viewer' },
  {
    method: 'PATCH',
    url: (o, id) => `/orgs/${id}/media/${o.mediaId}`,
    access: 'editor',
    body: () => ({ name: 'Renamed media' }),
  },
  {
    method: 'POST',
    url: (o, id) => `/orgs/${id}/media/bulk-move`,
    access: 'editor',
    body: (o) => ({ mediaIds: [o.mediaId], folderId: null }),
  },
  { method: 'GET', url: (o, id) => `/orgs/${id}/media/${o.mediaId}/usage`, access: 'viewer' },
  {
    method: 'GET',
    url: (o, id) => `/orgs/${id}/media/${o.mediaId}/playback-stats`,
    access: 'viewer',
  },
  { method: 'DELETE', url: (o, id) => `/orgs/${id}/media/${o.mediaId}`, access: 'editor' },
  {
    method: 'POST',
    url: (o, id) => `/orgs/${id}/media/bulk-delete`,
    access: 'editor',
    body: (o) => ({ mediaIds: [o.mediaId] }),
  },
  {
    method: 'POST',
    url: (o, id) => `/orgs/${id}/media/${o.mediaId}/reprocess`,
    access: 'editor',
  },

  // ------------------------------------------------------------------ orgs
  { method: 'GET', url: (_o, id) => `/orgs/${id}`, access: 'viewer' },
  {
    method: 'PATCH',
    url: (_o, id) => `/orgs/${id}`,
    access: 'admin',
    body: () => ({ name: 'Renamed org' }),
  },
  {
    method: 'POST',
    url: (_o, id) => `/orgs/${id}/logo`,
    access: 'admin',
    note: 'multipart upload',
  },
  { method: 'DELETE', url: (_o, id) => `/orgs/${id}/logo`, access: 'admin' },
  { method: 'GET', url: (_o, id) => `/orgs/${id}/members`, access: 'viewer' },
  {
    method: 'POST',
    url: (_o, id) => `/orgs/${id}/members`,
    access: 'admin',
    body: () => ({ email: 'newcomer@a.test', role: 'viewer' }),
  },
  {
    method: 'PATCH',
    url: (o, id) => `/orgs/${id}/members/${o.membershipId}`,
    pattern: '/orgs/:orgId/members/:memberId',
    access: 'admin',
    body: () => ({ role: 'editor' }),
  },
  {
    method: 'DELETE',
    url: (o, id) => `/orgs/${id}/members/${o.membershipId}`,
    pattern: '/orgs/:orgId/members/:memberId',
    access: 'admin',
  },

  // ------------------------------------------------------------- playlists
  { method: 'GET', url: (_o, id) => `/orgs/${id}/playlists`, access: 'viewer' },
  {
    method: 'POST',
    url: (_o, id) => `/orgs/${id}/playlists`,
    access: 'editor',
    body: () => ({ name: 'New playlist' }),
  },
  { method: 'GET', url: (o, id) => `/orgs/${id}/playlists/${o.playlistId}`, access: 'viewer' },
  {
    method: 'PATCH',
    url: (o, id) => `/orgs/${id}/playlists/${o.playlistId}`,
    access: 'editor',
    body: () => ({ name: 'Renamed playlist' }),
  },
  {
    method: 'PUT',
    url: (o, id) => `/orgs/${id}/playlists/${o.playlistId}/items`,
    access: 'editor',
    body: () => ({ items: [] }),
  },
  { method: 'DELETE', url: (o, id) => `/orgs/${id}/playlists/${o.playlistId}`, access: 'editor' },
  {
    method: 'POST',
    url: (o, id) => `/orgs/${id}/playlists/${o.playlistId}/clone`,
    access: 'editor',
    body: () => ({ name: 'Cloned playlist' }),
  },
  {
    method: 'GET',
    url: (o, id) => `/orgs/${id}/playlists/${o.playlistId}/resolved-preview`,
    access: 'viewer',
  },

  // -------------------------------------------------------- priority rules
  {
    method: 'GET',
    url: (o, id) => `/orgs/${id}/playlists/${o.playlistId}/priority-rules`,
    access: 'viewer',
  },
  {
    method: 'POST',
    url: (o, id) => `/orgs/${id}/playlists/${o.playlistId}/priority-rules`,
    access: 'editor',
    body: () => ({ name: 'Rule', intervalCount: 3 }),
  },
  {
    method: 'PATCH',
    url: (o, id) => `/orgs/${id}/playlists/${o.playlistId}/priority-rules/${o.priorityRuleId}`,
    access: 'editor',
    body: () => ({ name: 'Renamed rule' }),
  },
  {
    method: 'DELETE',
    url: (o, id) => `/orgs/${id}/playlists/${o.playlistId}/priority-rules/${o.priorityRuleId}`,
    access: 'editor',
  },
  {
    method: 'PUT',
    url: (o, id) =>
      `/orgs/${id}/playlists/${o.playlistId}/priority-rules/${o.priorityRuleId}/assignments`,
    access: 'editor',
    body: () => ({ assignments: [] }),
  },

  // ------------------------------------------------------------- schedules
  { method: 'GET', url: (_o, id) => `/orgs/${id}/schedules`, access: 'viewer' },
  {
    method: 'POST',
    url: (o, id) => `/orgs/${id}/schedules`,
    access: 'editor',
    body: (o) => ({ name: 'New schedule', playlistId: o.playlistId, daysOfWeek: [1] }),
  },
  { method: 'GET', url: (_o, id) => `/orgs/${id}/schedules/preview`, access: 'viewer' },
  { method: 'GET', url: (o, id) => `/orgs/${id}/schedules/${o.scheduleId}`, access: 'viewer' },
  {
    method: 'PATCH',
    url: (o, id) => `/orgs/${id}/schedules/${o.scheduleId}`,
    access: 'editor',
    body: () => ({ name: 'Renamed schedule' }),
  },
  { method: 'DELETE', url: (o, id) => `/orgs/${id}/schedules/${o.scheduleId}`, access: 'editor' },
];

const SUPERADMIN_ROUTES: RouteSpec[] = [
  { method: 'GET', url: () => '/orgs', access: 'authenticated' },
  {
    method: 'POST',
    url: () => '/orgs',
    access: 'superadmin',
    body: () => ({ name: 'Brand new org', slug: 'brand-new-org' }),
  },
  { method: 'GET', url: () => '/superadmin/organizations', access: 'superadmin' },
  {
    method: 'POST',
    url: () => '/superadmin/organizations',
    access: 'superadmin',
    body: () => ({ name: 'Another org', slug: 'another-org' }),
  },
  {
    method: 'PATCH',
    url: (o) => `/superadmin/organizations/${o.id}`,
    access: 'superadmin',
    body: () => ({ name: 'Renamed by root' }),
  },
  { method: 'GET', url: () => '/superadmin/users', access: 'superadmin' },
  {
    method: 'POST',
    url: () => '/superadmin/users',
    access: 'superadmin',
    body: () => ({ email: 'fresh@platform.test', name: 'Fresh', password: 'hunter2-hunter2' }),
  },
  {
    method: 'PATCH',
    url: (o) => `/superadmin/users/${o.users.viewer.id}`,
    access: 'superadmin',
    body: () => ({ name: 'Renamed by root' }),
  },
  {
    method: 'POST',
    url: (o) => `/superadmin/users/${o.users.viewer.id}/reset-password`,
    access: 'superadmin',
    body: () => ({ password: 'brand-new-password' }),
  },
  {
    method: 'POST',
    url: (o) => `/superadmin/organizations/${o.id}/members`,
    access: 'superadmin',
    body: (o) => ({ userId: o.users.viewer.id, role: 'editor' }),
  },
  {
    method: 'PATCH',
    url: (o) => `/superadmin/organizations/${o.id}/members/${o.membershipId}`,
    access: 'superadmin',
    body: () => ({ role: 'admin' }),
  },
  {
    method: 'DELETE',
    url: (o) => `/superadmin/organizations/${o.id}/members/${o.membershipId}`,
    access: 'superadmin',
  },
  {
    method: 'GET',
    url: () => '/superadmin/platform-health',
    access: 'superadmin',
    note: 'probes S3, which this suite does not stand up; the probe is bounded at 2s',
  },
  { method: 'GET', url: () => '/superadmin/audit-logs', access: 'superadmin' },
];

const AUTH_ROUTES: RouteSpec[] = [
  { method: 'GET', url: () => '/auth/me', access: 'authenticated' },
  {
    // The current password must be the real one: this route answers a wrong
    // one with 401, which is correct behaviour but indistinguishable from
    // "not authenticated" at the matrix's resolution.
    method: 'POST',
    url: () => '/auth/change-password',
    access: 'authenticated',
    body: () => ({ currentPassword: FIXTURE_PASSWORD, newPassword: 'another-password-12' }),
  },
];

const pattern = (r: RouteSpec) => r.pattern ?? r.url(SPEC_PLACEHOLDER, ':orgId');
const label = (r: RouteSpec) => `${r.method} ${pattern(r)}`;

/** Renders the table's URL templates for test names, without a live fixture. */
const SPEC_PLACEHOLDER = {
  id: ':orgId',
  groupId: ':groupId',
  deviceId: ':deviceId',
  folderId: ':folderId',
  mediaId: ':mediaId',
  playlistId: ':playlistId',
  priorityRuleId: ':ruleId',
  scheduleId: ':scheduleId',
  overrideId: ':overrideId',
  membershipId: ':membershipId',
  users: { viewer: { id: ':userId' } },
} as unknown as SeededOrg;

const DENIED = [401, 403];
const isDenied = (status: number) => DENIED.includes(status);

/**
 * Every route the server actually has, as "METHOD /full/path".
 *
 * Fastify exposes its route table only as a printed tree, in which each line
 * carries one path *fragment* indented four columns per level — so a full path
 * is the fragments along its branch, concatenated (`/device/sync` + `-status`).
 * Reconstructing it here is what lets the matrix prove it is complete instead of
 * merely claiming it.
 */
function registeredRoutes(app: FastifyInstance): string[] {
  const stack: string[] = [];
  const routes: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const connector = line.search(/[├└]── /);
    if (connector < 0) continue;
    const depth = connector / 4;
    const rest = line.slice(connector + 4);
    const withMethods = /^(.*) \(([A-Z, ]+)\)$/.exec(rest);
    stack[depth] = withMethods ? withMethods[1] : rest;
    stack.length = depth + 1;
    if (!withMethods) continue;
    const path = stack.join('');
    for (const method of withMethods[2].split(', ')) routes.push(`${method} ${path}`);
  }
  return routes;
}

describe('authorization matrix', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let fx: Fixture;

  beforeAll(async () => {
    prisma = testPrisma();
    app = await buildTestApp(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  // Every route gets a clean fixture: the matrix calls DELETE routes as an
  // allowed caller, and a deleted membership would make the next route's
  // viewer look unauthorized for the wrong reason.
  beforeEach(async () => {
    await resetDb(prisma);
    fx = await seedFixture(prisma);
  });

  const send = (route: RouteSpec, url: string, token: string | null) =>
    call(app, {
      method: route.method,
      url: `/api/v1${url}`,
      token,
      ...(route.body ? { payload: route.body(fx.a) } : {}),
    });

  describe('org-scoped routes', () => {
    for (const route of ORG_ROUTES) {
      it(label(route), async () => {
        const url = (orgId: string) => route.url(fx.a, orgId);
        const mine = url(fx.a.id);
        const required = route.access as SeedRole;

        // No credentials at all.
        expect((await send(route, mine, null)).statusCode).toBe(401);
        // A token that is not a token.
        expect((await send(route, mine, 'not-a-jwt')).statusCode).toBe(401);
        // Well-formed and correctly signed, for a user that does not exist.
        expect((await send(route, mine, fx.strangerToken)).statusCode).toBe(401);

        // The role ladder.
        for (const role of ORG_ROLES) {
          const res = await send(route, mine, fx.a.users[role].token);
          const shouldPass = ROLE_RANK[role] >= ROLE_RANK[required];
          expect(
            { role, status: res.statusCode, allowed: !isDenied(res.statusCode) },
            `${role} ${shouldPass ? 'should reach' : 'must not reach'} the handler`,
          ).toMatchObject({ allowed: shouldPass });
          if (shouldPass) {
            expect(res.statusCode, `${role} triggered a server error`).toBeLessThan(500);
          }
        }

        // A full owner of the *other* organization is still an outsider here.
        expect((await send(route, mine, fx.b.users.owner.token)).statusCode).toBe(403);

        // Superadmins enter any organization as owner, with no membership.
        const asRoot = await send(route, mine, fx.superadmin.token);
        expect(isDenied(asRoot.statusCode), 'superadmin was denied').toBe(false);

        // A disabled account keeps a valid, unexpired token. It must not work.
        expect((await send(route, mine, fx.disabledUser.token)).statusCode).toBe(403);

        // Disabled organization: members out, superadmins in.
        const disabledUrl = url(fx.disabledOrg.id);
        expect((await send(route, disabledUrl, fx.disabledOrg.ownerToken)).statusCode).toBe(403);
        const rootInDisabled = await send(route, disabledUrl, fx.superadmin.token);
        expect(isDenied(rootInDisabled.statusCode), 'superadmin locked out of a disabled org').toBe(
          false,
        );

        // Soft-deleted organization: nobody, superadmins included.
        const deletedUrl = url(fx.deletedOrg.id);
        expect((await send(route, deletedUrl, fx.deletedOrg.ownerToken)).statusCode).toBe(403);
        expect((await send(route, deletedUrl, fx.superadmin.token)).statusCode).toBe(403);
      });
    }
  });

  describe('platform routes', () => {
    for (const route of [...SUPERADMIN_ROUTES, ...AUTH_ROUTES]) {
      it(label(route), async () => {
        const url = route.url(fx.a, fx.a.id);

        expect((await send(route, url, null)).statusCode).toBe(401);
        expect((await send(route, url, 'not-a-jwt')).statusCode).toBe(401);
        expect((await send(route, url, fx.strangerToken)).statusCode).toBe(401);
        expect((await send(route, url, fx.disabledUser.token)).statusCode).toBe(403);

        if (route.access === 'superadmin') {
          // An organization owner is the most privileged non-platform caller
          // there is, and must still be out.
          expect((await send(route, url, fx.a.users.owner.token)).statusCode).toBe(403);
          const res = await send(route, url, fx.superadmin.token);
          expect(isDenied(res.statusCode), 'superadmin was denied').toBe(false);
          expect(res.statusCode, 'superadmin triggered a server error').toBeLessThan(500);
        } else {
          const res = await send(route, url, fx.a.users.viewer.token);
          expect(isDenied(res.statusCode), 'an authenticated user was denied').toBe(false);
        }
      });
    }
  });

  describe('unauthenticated routes', () => {
    it('POST /auth/register is gone, deliberately', async () => {
      const res = await call(app, { method: 'POST', url: '/api/v1/auth/register', payload: {} });
      expect(res.statusCode).toBe(410);
    });

    it('POST /auth/login rejects a wrong password without leaking which part was wrong', async () => {
      const wrongPassword = await call(app, {
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: fx.a.users.owner.email, password: 'not-the-password' },
      });
      const unknownEmail = await call(app, {
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'nobody@nowhere.test', password: 'not-the-password' },
      });
      expect(wrongPassword.statusCode).toBe(401);
      expect(unknownEmail.statusCode).toBe(401);
      expect(wrongPassword.json().message).toBe(unknownEmail.json().message);
    });

    it('POST /auth/login issues a working token for correct credentials', async () => {
      const res = await call(app, {
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: fx.a.users.owner.email, password: FIXTURE_PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      const me = await call(app, {
        method: 'GET',
        url: '/api/v1/auth/me',
        token: res.json().token,
      });
      expect(me.statusCode).toBe(200);
    });
  });

  /**
   * The table is only a guarantee if it is complete. This walks Fastify's own
   * route tree and fails when a registered route has no row — which is what
   * makes "add a route, forget the matrix" visible in review rather than in
   * production.
   */
  it('covers every route registered on the server', () => {
    const covered = new Set<string>();
    for (const route of [...ORG_ROUTES, ...SUPERADMIN_ROUTES, ...AUTH_ROUTES]) {
      covered.add(`${route.method} /api/v1${pattern(route)}`);
    }
    // Handled by dedicated suites rather than the matrix.
    const elsewhere = [
      'POST /api/v1/auth/register',
      'POST /api/v1/auth/login',
      'GET /api/v1/device/ws',
      'GET /health',
      'GET /health/ready',
      // Registered by @fastify/cors for preflight; carries no authorization.
      'OPTIONS *',
    ];

    const registered = registeredRoutes(app)
      .filter((entry) => !entry.startsWith('HEAD '))
      // Device-token routes have their own suite; they use a different
      // credential system entirely.
      .filter((entry) => !entry.includes('/api/v1/device/'))
      .filter((entry) => !elsewhere.includes(entry));

    const missing = registered.filter((entry) => !covered.has(entry));
    expect(missing, 'routes registered but absent from the authorization matrix').toEqual([]);
  });
});
