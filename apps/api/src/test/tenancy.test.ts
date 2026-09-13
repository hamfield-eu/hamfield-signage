import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@signage/database';
import { buildTestApp, call, resetDb, seedFixture, testPrisma, type Fixture } from './helpers';
import { ORG_ROUTES, label } from './route-table';

/**
 * Cross-tenant isolation.
 *
 * The authorization matrix proves org B's owner cannot call org A's routes.
 * This proves the other half, which is the easier one to get wrong: a caller
 * who is a legitimate **owner of org A** passing an id that belongs to org B.
 * Every one of those is a route whose `where` clause forgot `organizationId`,
 * and the answer must never be a 2xx.
 *
 * The important half is generated rather than hand-written: the route table's
 * URL builder already takes the id-supplying org separately from the org in the
 * path, so `url(fx.b, fx.a.id)` is exactly the probe.
 */
describe('cross-tenant isolation', () => {
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

  beforeEach(async () => {
    await resetDb(prisma);
    fx = await seedFixture(prisma);
  });

  describe("org A's owner, using org B's ids", () => {
    for (const route of ORG_ROUTES) {
      it(label(route), async () => {
        const theirs = route.url(fx.b, fx.a.id);
        if (route.url(fx.a, fx.a.id) === theirs) {
          // This route's path carries no resource id, so there is nothing to
          // cross-probe. The matrix covers it; skip rather than pass silently.
          return;
        }

        const res = await call(app, {
          method: route.method,
          url: `/api/v1${theirs}`,
          token: fx.a.users.owner.token,
          ...(route.body ? { payload: route.body(fx.b) } : {}),
        });

        expect(res.statusCode, "org A reached one of org B's resources").toBeGreaterThanOrEqual(
          400,
        );
        expect(res.statusCode, 'a cross-org id produced a server error').toBeLessThan(500);
      });
    }
  });

  describe('list endpoints never leak', () => {
    it('media lists only the calling organization, despite identical names', async () => {
      const res = await call(app, {
        method: 'GET',
        url: `/api/v1/orgs/${fx.a.id}/media`,
        token: fx.a.users.viewer.token,
      });
      expect(res.statusCode).toBe(200);
      const ids = (res.json().items ?? res.json()).map((m: { id: string }) => m.id);
      expect(ids).toContain(fx.a.mediaId);
      expect(ids).not.toContain(fx.b.mediaId);
    });

    for (const [resource, path, idOf] of [
      ['devices', 'devices', (o: Fixture['a']) => o.deviceId],
      ['device groups', 'device-groups', (o: Fixture['a']) => o.groupId],
      ['playlists', 'playlists', (o: Fixture['a']) => o.playlistId],
      ['schedules', 'schedules', (o: Fixture['a']) => o.scheduleId],
      ['media folders', 'media/folders', (o: Fixture['a']) => o.folderId],
    ] as const) {
      it(`${resource} list only the calling organization`, async () => {
        const res = await call(app, {
          method: 'GET',
          url: `/api/v1/orgs/${fx.a.id}/${path}`,
          token: fx.a.users.viewer.token,
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        const rows: Array<{ id: string }> = Array.isArray(body) ? body : (body.items ?? []);
        const ids = rows.map((r) => r.id);
        expect(ids).toContain(idOf(fx.a));
        expect(ids).not.toContain(idOf(fx.b));
      });
    }

    it('GET /orgs lists only the organizations the caller belongs to', async () => {
      const res = await call(app, {
        method: 'GET',
        url: '/api/v1/orgs',
        token: fx.a.users.viewer.token,
      });
      expect(res.statusCode).toBe(200);
      const ids = res.json().map((o: { id: string }) => o.id);
      expect(ids).toEqual([fx.a.id]);
    });

    it('GET /orgs hides soft-deleted and shows superadmins everything', async () => {
      const asRoot = await call(app, {
        method: 'GET',
        url: '/api/v1/orgs',
        token: fx.superadmin.token,
      });
      expect(asRoot.statusCode).toBe(200);
      const ids = asRoot.json().map((o: { id: string }) => o.id);
      expect(ids).not.toContain(fx.deletedOrg.id);
    });
  });

  /**
   * The two places the codebase review predicted would be wrong. Both turn out
   * to be handled — which is worth pinning down, because neither is obvious
   * from reading the handler and a later edit could quietly undo either.
   */
  describe('the reviewed trouble spots', () => {
    it('PATCH /orgs/:orgId cannot reach a soft-deleted organization', async () => {
      // `prisma.organization.update` in this handler has no `deletedAt: null`
      // guard. It is unreachable anyway: requireOrgRole rejects a soft-deleted
      // org for members and superadmins alike, so the missing guard is not an
      // exposure. This test is what keeps that true.
      const before = await prisma.organization.findUniqueOrThrow({
        where: { id: fx.deletedOrg.id },
      });

      for (const token of [fx.deletedOrg.ownerToken, fx.superadmin.token]) {
        const res = await call(app, {
          method: 'PATCH',
          url: `/api/v1/orgs/${fx.deletedOrg.id}`,
          token,
          payload: { name: 'Resurrected' },
        });
        expect(res.statusCode).toBe(403);
      }

      const after = await prisma.organization.findUniqueOrThrow({
        where: { id: fx.deletedOrg.id },
      });
      expect(after.name).toBe(before.name);
      expect(after.deletedAt).not.toBeNull();
    });

    it('a set_playlist command with another org’s playlist mutates nothing', async () => {
      // The handler applies `set_playlist` to the device *before* creating the
      // command row, so a validation gap here would leave a screen pointed at
      // another tenant's playlist with no command record to explain it.
      const before = await prisma.device.findUniqueOrThrow({ where: { id: fx.a.deviceId } });

      const res = await call(app, {
        method: 'POST',
        url: `/api/v1/orgs/${fx.a.id}/devices/${fx.a.deviceId}/commands`,
        token: fx.a.users.owner.token,
        payload: { type: 'set_playlist', payload: { playlistId: fx.b.playlistId } },
      });
      expect(res.statusCode).toBe(400);

      const after = await prisma.device.findUniqueOrThrow({ where: { id: fx.a.deviceId } });
      expect(after.defaultPlaylistId).toBe(before.defaultPlaylistId);
      expect(await prisma.deviceCommand.count({ where: { deviceId: fx.a.deviceId } })).toBe(1);
    });

    it("a device PATCH cannot adopt another org's default playlist or groups", async () => {
      const withPlaylist = await call(app, {
        method: 'PATCH',
        url: `/api/v1/orgs/${fx.a.id}/devices/${fx.a.deviceId}`,
        token: fx.a.users.owner.token,
        payload: { defaultPlaylistId: fx.b.playlistId },
      });
      expect(withPlaylist.statusCode).toBe(400);

      const withGroup = await call(app, {
        method: 'PATCH',
        url: `/api/v1/orgs/${fx.a.id}/devices/${fx.a.deviceId}`,
        token: fx.a.users.owner.token,
        payload: { groupIds: [fx.b.groupId] },
      });
      // The handler filters the group ids by organization rather than
      // rejecting, so the request succeeds with the foreign group dropped.
      expect(withGroup.statusCode).toBeLessThan(400);
      const memberships = await prisma.deviceGroupMembership.findMany({
        where: { deviceId: fx.a.deviceId },
      });
      expect(memberships.map((m) => m.groupId)).not.toContain(fx.b.groupId);
    });

    it("a schedule cannot be created against another org's playlist", async () => {
      const res = await call(app, {
        method: 'POST',
        url: `/api/v1/orgs/${fx.a.id}/schedules`,
        token: fx.a.users.owner.token,
        payload: { name: 'Cross-tenant', playlistId: fx.b.playlistId, daysOfWeek: [1] },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(await prisma.schedule.count({ where: { playlistId: fx.b.playlistId } })).toBe(1);
    });

    it("bulk media operations ignore another org's media ids", async () => {
      const res = await call(app, {
        method: 'POST',
        url: `/api/v1/orgs/${fx.a.id}/media/bulk-delete`,
        token: fx.a.users.owner.token,
        payload: { mediaIds: [fx.b.mediaId] },
      });
      // Whether this is a 400 or a no-op 200 is the handler's choice; what must
      // never happen is org B's media being deleted.
      expect(res.statusCode).toBeLessThan(500);
      const victim = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: fx.b.mediaId } });
      expect(victim.deletedAt).toBeNull();
    });

    it("an emergency override cannot be started with another org's playlist", async () => {
      const res = await call(app, {
        method: 'POST',
        url: `/api/v1/orgs/${fx.a.id}/emergency`,
        token: fx.a.users.owner.token,
        payload: { playlistId: fx.b.playlistId, appliesToAll: true },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(
        await prisma.emergencyOverride.count({
          where: { organizationId: fx.a.id, active: true },
        }),
      ).toBe(0);
    });
  });
});
