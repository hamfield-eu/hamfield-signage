import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@signage/database';
import {
  FIXTURE_PASSWORD,
  ORG_ROLES,
  buildTestApp,
  call,
  resetDb,
  seedFixture,
  testPrisma,
  type Fixture,
  type SeedRole,
} from './helpers';
import {
  AUTH_ROUTES,
  ORG_ROUTES,
  ROLE_RANK,
  SPEC_PLACEHOLDER,
  SUPERADMIN_ROUTES,
  isDenied,
  label,
  pattern,
  registeredRoutes,
  type RouteSpec,
} from './route-table';

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
      // The second login step: its credential is a Redis challenge, not a token,
      // so the authenticated/unauthenticated matrix cannot express it. Covered
      // end-to-end by mfa.test.ts.
      'POST /api/v1/auth/login/mfa',
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
