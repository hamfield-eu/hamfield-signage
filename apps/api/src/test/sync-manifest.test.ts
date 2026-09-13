import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@signage/database';
import type { SyncManifest } from '@signage/sync-protocol';
import { buildTestApp, call, resetDb, seedFixture, testPrisma, type Fixture } from './helpers';

/**
 * The manifest end to end, against a real database.
 *
 * `packages/sync-protocol` unit-tests the hashing and diffing; what was never
 * tested is that `buildSyncManifest` produces a *stable* version for unchanged
 * content and a *different* one for every change that matters. The whole
 * poll-skip optimisation — and therefore every device's bandwidth bill — rests
 * on that, and a manifest that changed spuriously would have devices
 * re-downloading their entire library on every poll.
 */
describe('sync manifest', () => {
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

  async function manifest(token = fx.a.deviceToken): Promise<SyncManifest> {
    const res = await call(app, { method: 'GET', url: '/api/v1/device/sync', token });
    expect(res.statusCode).toBe(200);
    return res.json().manifest as SyncManifest;
  }

  const version = async () => (await manifest()).version;

  describe('determinism', () => {
    it('two consecutive builds of unchanged content produce the same version', async () => {
      const first = await manifest();
      const second = await manifest();
      expect(second.version).toBe(first.version);
      // `generatedAt` is a timestamp and must NOT feed the hash.
      expect(second.generatedAt).not.toBe(first.generatedAt);
    });

    it('a no-op write does not change the version', async () => {
      const before = await version();
      await prisma.device.update({
        where: { id: fx.a.deviceId },
        data: { lastSeenAt: new Date() },
      });
      expect(await version()).toBe(before);
    });
  });

  describe('the version changes when content changes', () => {
    it('a playlist item is added', async () => {
      const before = await version();
      const extra = await prisma.mediaAsset.create({
        data: {
          organizationId: fx.a.id,
          name: 'Second clip',
          originalFilename: 'two.jpg',
          mediaType: 'image',
          originalMimeType: 'image/jpeg',
          originalStorageKey: 'a/two.jpg',
          processedStorageKey: 'a/two.processed.jpg',
          processedMimeType: 'image/jpeg',
          processingStatus: 'ready',
          checksumSha256: 'a'.repeat(64),
          sizeBytes: BigInt(10),
        },
      });
      await prisma.playlistItem.create({
        data: { playlistId: fx.a.playlistId, mediaAssetId: extra.id, position: 1 },
      });
      expect(await version()).not.toBe(before);
    });

    it('a schedule is edited', async () => {
      const before = await version();
      await prisma.schedule.update({
        where: { id: fx.a.scheduleId },
        data: { startTime: '09:30' },
      });
      expect(await version()).not.toBe(before);
    });

    it('an emergency override starts, and stops again', async () => {
      const quiet = await version();

      await prisma.emergencyOverride.update({
        where: { id: fx.a.overrideId },
        data: { active: true, stoppedAt: null },
      });
      const during = await manifest();
      expect(during.version).not.toBe(quiet);
      expect(during.emergency.active).toBe(true);
      expect(during.emergency.mediaAssetId).toBe(fx.a.mediaId);

      await prisma.emergencyOverride.update({
        where: { id: fx.a.overrideId },
        data: { active: false, stoppedAt: new Date() },
      });
      const after = await manifest();
      expect(after.emergency.active).toBe(false);
      // Back to exactly the previous content, so back to the same version.
      expect(after.version).toBe(quiet);
    });

    it('the media file is replaced', async () => {
      const before = await version();
      await prisma.mediaAsset.update({
        where: { id: fx.a.mediaId },
        data: { checksumSha256: 'b'.repeat(64) },
      });
      expect(await version()).not.toBe(before);
    });

    it('device settings change', async () => {
      const before = await version();
      await prisma.device.update({
        where: { id: fx.a.deviceId },
        data: { orientation: 'portrait', rotation: 90 },
      });
      const after = await manifest();
      expect(after.version).not.toBe(before);
      expect(after.settings.orientation).toBe('portrait');
    });
  });

  describe('what may appear', () => {
    it('only ready media with a checksum', async () => {
      // The fixture's second asset is still processing and is on no playlist;
      // put it on one to prove the filter, not the absence of a reference.
      await prisma.playlistItem.create({
        data: { playlistId: fx.a.playlistId, mediaAssetId: fx.a.pendingMediaId, position: 5 },
      });
      const ids = (await manifest()).media.map((m) => m.id);
      expect(ids).toContain(fx.a.mediaId);
      expect(ids).not.toContain(fx.a.pendingMediaId);
    });

    it('ready media with no checksum is excluded', async () => {
      await prisma.mediaAsset.update({
        where: { id: fx.a.mediaId },
        data: { checksumSha256: null },
      });
      expect((await manifest()).media.map((m) => m.id)).not.toContain(fx.a.mediaId);
    });

    it('soft-deleted media disappears', async () => {
      expect((await manifest()).media.map((m) => m.id)).toContain(fx.a.mediaId);
      await prisma.mediaAsset.update({
        where: { id: fx.a.mediaId },
        data: { deletedAt: new Date() },
      });
      expect((await manifest()).media.map((m) => m.id)).not.toContain(fx.a.mediaId);
    });

    it('a schedule assigned via a device group is included', async () => {
      const groupOnly = await prisma.schedule.create({
        data: {
          organizationId: fx.a.id,
          name: 'Group schedule',
          playlistId: fx.a.playlistId,
          daysOfWeek: [6],
          startTime: '10:00',
          endTime: '12:00',
        },
      });
      await prisma.scheduleGroupAssignment.create({
        data: { scheduleId: groupOnly.id, groupId: fx.a.groupId },
      });

      const ids = (await manifest()).schedules.map((s) => s.id);
      expect(ids).toContain(groupOnly.id);
      expect(ids).toContain(fx.a.scheduleId);
    });

    it('a disabled schedule is not', async () => {
      await prisma.schedule.update({ where: { id: fx.a.scheduleId }, data: { enabled: false } });
      expect((await manifest()).schedules.map((s) => s.id)).not.toContain(fx.a.scheduleId);
    });

    it('a folder playlist entry is resolved into concrete media', async () => {
      // Devices never see folder data; the expansion happens here at sync time
      // so folder playlists play fully offline.
      const inFolder = await prisma.mediaAsset.create({
        data: {
          organizationId: fx.a.id,
          folderId: fx.a.folderId,
          name: 'Inside the folder',
          originalFilename: 'inside.jpg',
          mediaType: 'image',
          originalMimeType: 'image/jpeg',
          originalStorageKey: 'a/inside.jpg',
          processedStorageKey: 'a/inside.processed.jpg',
          processedMimeType: 'image/jpeg',
          processingStatus: 'ready',
          checksumSha256: 'c'.repeat(64),
          sizeBytes: BigInt(20),
        },
      });
      const folderPlaylist = await prisma.playlist.create({
        data: { organizationId: fx.a.id, name: 'Folder playlist' },
      });
      await prisma.playlistItem.create({
        data: {
          playlistId: folderPlaylist.id,
          type: 'folder',
          folderId: fx.a.folderId,
          position: 0,
        },
      });
      await prisma.device.update({
        where: { id: fx.a.deviceId },
        data: { defaultPlaylistId: folderPlaylist.id },
      });

      const built = await manifest();
      const resolved = built.playlists.find((p) => p.id === folderPlaylist.id);
      expect(resolved).toBeDefined();
      expect(resolved!.items.map((i) => i.mediaId)).toContain(inFolder.id);
      expect(built.media.map((m) => m.id)).toContain(inFolder.id);
    });
  });

  describe('per-device playback tiers', () => {
    it('a light-profile device gets the light variant’s checksum and size', async () => {
      await prisma.mediaVariant.create({
        data: {
          mediaAssetId: fx.a.mediaId,
          kind: 'video_light',
          storageKey: 'a/clip.light.mp4',
          mimeType: 'video/mp4',
          sizeBytes: BigInt(500),
          checksumSha256: 'd'.repeat(64),
          width: 1280,
          height: 720,
        },
      });

      const standard = (await manifest()).media.find((m) => m.id === fx.a.mediaId)!;
      expect(standard.checksum).not.toBe('d'.repeat(64));

      await prisma.device.update({
        where: { id: fx.a.deviceId },
        data: { playbackProfile: 'light' },
      });
      const light = (await manifest()).media.find((m) => m.id === fx.a.mediaId)!;
      expect(light.checksum).toBe('d'.repeat(64));
      expect(light.sizeBytes).toBe(500);
      expect(light.width).toBe(1280);
    });

    it('falls back to the standard file when the tier has no variant', async () => {
      await prisma.device.update({
        where: { id: fx.a.deviceId },
        data: { playbackProfile: 'light' },
      });
      const media = (await manifest()).media.find((m) => m.id === fx.a.mediaId)!;
      // The fixture's checksum, i.e. the processed standard file.
      expect(media.checksum).toBe(`${'0'.repeat(63)}1`);
    });

    it('changing the tier changes the version', async () => {
      await prisma.mediaVariant.create({
        data: {
          mediaAssetId: fx.a.mediaId,
          kind: 'video_light',
          storageKey: 'a/clip.light.mp4',
          mimeType: 'video/mp4',
          sizeBytes: BigInt(500),
          checksumSha256: 'd'.repeat(64),
        },
      });
      const before = await version();
      await prisma.device.update({
        where: { id: fx.a.deviceId },
        data: { playbackProfile: 'light' },
      });
      expect(await version()).not.toBe(before);
    });
  });

  it('two devices in different organizations never share a manifest version', async () => {
    const a = await manifest(fx.a.deviceToken);
    const b = await manifest(fx.b.deviceToken);
    expect(a.deviceId).toBe(fx.a.deviceId);
    expect(b.deviceId).toBe(fx.b.deviceId);
    expect(a.version).not.toBe(b.version);
  });
});
