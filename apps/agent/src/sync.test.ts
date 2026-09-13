import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ManifestMedia, SyncManifest } from '@signage/sync-protocol';
import { ApiClient } from './api-client';
import { loadConfig, type AgentConfig } from './config';
import { AgentDb } from './db';
import { SyncEngine } from './sync';

interface StubBackend {
  server: http.Server;
  url: string;
  manifest: SyncManifest;
  files: Map<string, Buffer>;
  downloads: string[];
  syncStatuses: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function mediaEntry(id: string, content: Buffer, type: 'image' | 'video' = 'image'): ManifestMedia {
  return {
    id,
    name: id,
    type,
    mimeType: type === 'image' ? 'image/jpeg' : 'video/mp4',
    checksum: sha256(content),
    sizeBytes: content.length,
    width: 1920,
    height: 1080,
    orientation: 'landscape',
    durationSeconds: type === 'video' ? 30 : null,
    downloadPath: `/api/v1/device/media/${id}/download`,
  };
}

function buildManifest(version: string, media: ManifestMedia[]): SyncManifest {
  return {
    protocolVersion: 1,
    version,
    generatedAt: new Date().toISOString(),
    deviceId: 'dev-1',
    settings: {
      name: 'Test screen',
      orientation: 'landscape',
      timezone: 'UTC',
      defaultPlaylistId: 'pl-1',
    },
    emergency: { active: false, playlistId: null, mediaAssetId: null, startedAt: null },
    schedules: [],
    playlists: [
      {
        id: 'pl-1',
        name: 'Playlist',
        loop: true,
        defaultImageDurationSeconds: 10,
        items: media.map((m, i) => ({
          id: `item-${m.id}`,
          mediaId: m.id,
          position: i,
          durationSeconds: null,
          fitMode: null,
          enabled: true,
        })),
      },
    ],
    media,
  };
}

async function startStubBackend(
  initial: SyncManifest,
  files: Map<string, Buffer>,
): Promise<StubBackend> {
  const downloads: string[] = [];
  const syncStatuses: Array<Record<string, unknown>> = [];

  const backend: Partial<StubBackend> = { manifest: initial, files, downloads, syncStatuses };

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url.startsWith('/api/v1/device/sync')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ manifest: backend.manifest, commands: [] }));
      return;
    }
    const download = url.match(/^\/api\/v1\/device\/media\/([^/]+)\/download$/);
    if (req.method === 'GET' && download) {
      const content = files.get(download[1]);
      if (!content) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      downloads.push(download[1]);
      res.setHeader('content-type', 'application/octet-stream');
      res.end(content);
      return;
    }
    if (req.method === 'POST' && url === '/api/v1/device/sync-status') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        syncStatuses.push(JSON.parse(body) as Record<string, unknown>);
        res.statusCode = 204;
        res.end();
      });
      return;
    }
    res.statusCode = 404;
    res.end('unhandled');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  backend.server = server;
  backend.url = `http://127.0.0.1:${port}`;
  backend.close = () => new Promise((resolve) => server.close(() => resolve()));
  return backend as StubBackend;
}

describe('SyncEngine', () => {
  let dataDir: string;
  let backend: StubBackend;
  let db: AgentDb;
  let config: AgentConfig;
  let engine: SyncEngine;
  let applied: SyncManifest[];

  const imgContent = Buffer.from('fake jpeg bytes for the sync test');
  const vidContent = Buffer.from('fake mp4 bytes — somewhat longer so sizes differ');

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'signage-sync-test-'));
    const img = mediaEntry('img-1', imgContent);
    const vid = mediaEntry('vid-1', vidContent, 'video');
    backend = await startStubBackend(
      buildManifest('v1', [img, vid]),
      new Map([
        ['img-1', imgContent],
        ['vid-1', vidContent],
      ]),
    );

    config = loadConfig({
      SIGNAGE_SERVER_URL: backend.url,
      SIGNAGE_DATA_DIR: dataDir,
    } as NodeJS.ProcessEnv);
    db = new AgentDb(dataDir);
    const api = new ApiClient(config, 'test-token');
    applied = [];
    engine = new SyncEngine(config, db, api, pino({ level: 'silent' }), (m) => applied.push(m));
  });

  afterEach(async () => {
    db.close();
    await backend.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('downloads media, verifies checksums and applies the manifest atomically', async () => {
    await engine.syncNow('test');

    expect(db.getManifestVersion()).toBe('v1');
    expect(applied).toHaveLength(1);
    expect(backend.downloads.sort()).toEqual(['img-1', 'vid-1']);

    const cached = db.listCachedMedia();
    expect(cached.map((c) => c.mediaId).sort()).toEqual(['img-1', 'vid-1']);
    for (const entry of cached) {
      expect(existsSync(entry.filePath)).toBe(true);
    }
    expect(readFileSync(join(config.mediaDir, 'img-1'))).toEqual(imgContent);

    const final = backend.syncStatuses.at(-1);
    expect(final?.status).toBe('applied');
    expect(final?.manifestVersion).toBe('v1');
  });

  it('does nothing when the manifest version is unchanged', async () => {
    await engine.syncNow('first');
    const downloadsAfterFirst = backend.downloads.length;

    await engine.syncNow('second');
    expect(backend.downloads.length).toBe(downloadsAfterFirst);
    expect(applied).toHaveLength(1);
  });

  it('removes stale media only after the new manifest is committed', async () => {
    await engine.syncNow('initial');
    const stalePath = db.getCachedMedia('vid-1')?.filePath;
    expect(stalePath && existsSync(stalePath)).toBe(true);

    backend.manifest = buildManifest('v2', [mediaEntry('img-1', imgContent)]);
    await engine.syncNow('content changed');

    expect(db.getManifestVersion()).toBe('v2');
    expect(db.listCachedMedia().map((c) => c.mediaId)).toEqual(['img-1']);
    expect(stalePath && existsSync(stalePath)).toBe(false);
    // The kept file was not re-downloaded.
    expect(backend.downloads.filter((d) => d === 'img-1')).toHaveLength(1);
  });

  it('rejects a corrupted download and keeps the previous state', async () => {
    await engine.syncNow('initial');
    expect(db.getManifestVersion()).toBe('v1');

    const tampered = mediaEntry('img-2', Buffer.from('expected content'));
    backend.files.set('img-2', Buffer.from('actual different content'));
    backend.manifest = buildManifest('v3', [mediaEntry('img-1', imgContent), tampered]);

    await engine.syncNow('tampered update');

    // The corrupt manifest must not be applied; the old content keeps playing.
    expect(db.getManifestVersion()).toBe('v1');
    expect(db.getCachedMedia('img-2')).toBeNull();
    expect(existsSync(join(config.mediaDir, 'img-2'))).toBe(false);
    expect(backend.syncStatuses.some((s) => s.status === 'failed')).toBe(true);
    expect(db.takeLogs(10).some((l) => l.message.includes('sync failed'))).toBe(true);
  });

  // ------------------------------------------------------------- T017 (F5)

  describe('cache integrity', () => {
    it('re-downloads a cached file that has vanished from disk', async () => {
      // The F5 acceptance test. The index still says "present with the right
      // checksum", so diffManifest calls it unchanged and it is never fetched
      // again — the player 404s on it every cycle, forever. Note the manifest
      // version has NOT changed, which is why repair needs the forced sync.
      await engine.syncNow('initial');
      const path = db.getCachedMedia('img-1')!.filePath;
      rmSync(path);

      await engine.maintainCache('test');

      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path)).toEqual(imgContent);
      expect(backend.downloads.filter((d) => d === 'img-1')).toHaveLength(2);
      expect(db.getManifestVersion()).toBe('v1');
    });

    it('re-downloads a truncated file, detected by size alone', async () => {
      await engine.syncNow('initial');
      const path = db.getCachedMedia('vid-1')!.filePath;
      writeFileSync(path, 'tru');

      await engine.maintainCache('test');

      expect(readFileSync(path)).toEqual(vidContent);
      expect(backend.downloads.filter((d) => d === 'vid-1')).toHaveLength(2);
    });

    it('re-downloads same-size corruption once the file is re-hashed', async () => {
      // stat cannot see this; only the hashing tier can. Nothing had ever
      // re-hashed a cached file before T017.
      await engine.syncNow('initial');
      const path = db.getCachedMedia('img-1')!.filePath;
      writeFileSync(path, Buffer.alloc(imgContent.length, 0x41));

      // Age the verification stamp past the rehash interval. Without this the
      // file is not due: the sync that just ran ended in a maintenance pass
      // that hashed and stamped it, and re-hashing is deliberately bounded to
      // roughly weekly per file so it does not saturate eMMC read bandwidth.
      // Skipping a file verified seconds ago is correct behaviour, so the test
      // has to simulate the passage of time rather than assert it away.
      db.markVerified(['img-1'], new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString());

      await engine.maintainCache('test');

      expect(readFileSync(path)).toEqual(imgContent);
    });

    it('re-hashes a file immediately when the player reports an error on it', async () => {
      // The out-of-rotation path: a playback error is the cheapest corruption
      // signal there is, so that file jumps the weekly queue instead of
      // waiting up to a week behind a stamp that was set moments ago.
      await engine.syncNow('initial');
      const path = db.getCachedMedia('img-1')!.filePath;
      writeFileSync(path, Buffer.alloc(imgContent.length, 0x41));

      engine.noteSuspectMedia('img-1');
      await engine.maintainCache('test');

      expect(readFileSync(path)).toEqual(imgContent);
    });

    it('repairs one damaged file without disturbing the others', async () => {
      await engine.syncNow('initial');
      const imgPath = db.getCachedMedia('img-1')!.filePath;
      const vidPath = db.getCachedMedia('vid-1')!.filePath;
      rmSync(imgPath);

      await engine.maintainCache('test');

      expect(existsSync(imgPath)).toBe(true);
      expect(existsSync(vidPath)).toBe(true);
      expect(backend.downloads.filter((d) => d === 'vid-1')).toHaveLength(1);
      expect(
        db
          .listCachedMedia()
          .map((c) => c.mediaId)
          .sort(),
      ).toEqual(['img-1', 'vid-1']);
    });

    it('reports the repair through the buffered device log', async () => {
      await engine.syncNow('initial');
      rmSync(db.getCachedMedia('img-1')!.filePath);

      await engine.maintainCache('test');

      expect(db.takeLogs(20).some((l) => l.message.includes('cache integrity'))).toBe(true);
    });
  });

  // ------------------------------------------------------------- T017 (F6)

  describe('storage precheck', () => {
    /** An engine whose headroom demand no real filesystem can satisfy. */
    function engineWithConfig(env: Record<string, string>): SyncEngine {
      const cfg = loadConfig({
        SIGNAGE_SERVER_URL: backend.url,
        SIGNAGE_DATA_DIR: dataDir,
        ...env,
      } as NodeJS.ProcessEnv);
      return new SyncEngine(
        cfg,
        db,
        new ApiClient(cfg, 'test-token'),
        pino({ level: 'silent' }),
        (m) => applied.push(m),
      );
    }

    it('refuses to start, reports insufficient_storage, and touches nothing', async () => {
      // The F6 acceptance test. Today the sync starts, hits ENOSPC part-way,
      // aborts, and the next poll repeats the identical failure forever.
      const cramped = engineWithConfig({ SIGNAGE_MIN_FREE_DISK_MB: '100000000' });

      await cramped.syncNow('no room');

      expect(backend.downloads).toEqual([]);
      expect(db.getManifestVersion()).toBeNull();
      expect(db.listCachedMedia()).toEqual([]);
      expect(applied).toHaveLength(0);

      const report = backend.syncStatuses.at(-1);
      expect(report?.status).toBe('insufficient_storage');
      expect(report?.shortfallBytes).toBeGreaterThan(0);
      expect(report?.requiredBytes).toBeGreaterThan(0);
      expect(typeof report?.availableBytes).toBe('number');
    });

    it('keeps the previously cached content playable when it later runs out', async () => {
      // The screen must never go blank because of a storage problem.
      await engine.syncNow('initial');
      const cramped = engineWithConfig({ SIGNAGE_MIN_FREE_DISK_MB: '100000000' });
      backend.manifest = buildManifest('v2', [
        mediaEntry('img-1', imgContent),
        mediaEntry('img-9', Buffer.from('a new large asset')),
      ]);
      backend.files.set('img-9', Buffer.from('a new large asset'));

      await cramped.syncNow('no room for the update');

      expect(db.getManifestVersion()).toBe('v1');
      expect(
        db
          .listCachedMedia()
          .map((c) => c.mediaId)
          .sort(),
      ).toEqual(['img-1', 'vid-1']);
      expect(existsSync(db.getCachedMedia('img-1')!.filePath)).toBe(true);
    });

    it('recovers by itself on the next sync once there is room', async () => {
      const cramped = engineWithConfig({ SIGNAGE_MIN_FREE_DISK_MB: '100000000' });
      await cramped.syncNow('no room');
      expect(db.getManifestVersion()).toBeNull();

      // No operator action beyond freeing space — the ordinary engine retries.
      await engine.syncNow('space freed');

      expect(db.getManifestVersion()).toBe('v1');
      expect(backend.syncStatuses.at(-1)?.status).toBe('applied');
    });

    it('records the refusal in the device log', async () => {
      const cramped = engineWithConfig({ SIGNAGE_MIN_FREE_DISK_MB: '100000000' });
      await cramped.syncNow('no room');
      expect(db.takeLogs(20).some((l) => l.message.includes('sync refused'))).toBe(true);
    });
  });

  // ------------------------------------------------------ T017 housekeeping

  describe('orphan sweep and eviction', () => {
    const ageOut = (path: string) => {
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
      utimesSync(path, past, past);
    };

    it('removes an aged unindexed file and a stale .part', async () => {
      await engine.syncNow('initial');
      const orphan = join(config.mediaDir, 'left-by-a-crash');
      writeFileSync(orphan, 'orphan');
      ageOut(orphan);
      const part = join(config.tmpDir, 'interrupted.part');
      writeFileSync(part, 'half');
      ageOut(part);

      await engine.maintainCache('test');

      expect(existsSync(orphan)).toBe(false);
      expect(existsSync(part)).toBe(false);
      // Real cached files are untouched.
      expect(existsSync(db.getCachedMedia('img-1')!.filePath)).toBe(true);
    });

    it('leaves a freshly downloaded unindexed file alone', async () => {
      await engine.syncNow('initial');
      const inFlight = join(config.mediaDir, 'mid-download');
      writeFileSync(inFlight, 'still going');

      await engine.maintainCache('test');

      expect(existsSync(inFlight)).toBe(true);
    });

    it('does not evict by default, even when over budget', async () => {
      // Eviction deletes files on a customer's device, so it stays opt-in.
      await engine.syncNow('initial');
      addUnreferencedEntry();

      await engine.maintainCache('test');

      expect(db.getCachedMedia('orphan-1')).not.toBeNull();
    });

    it('evicts only unreferenced files when enabled', async () => {
      await engine.syncNow('initial');
      addUnreferencedEntry();
      const evicting = engineWithTinyBudget();

      await evicting.maintainCache('test');

      expect(db.getCachedMedia('orphan-1')).toBeNull();
      // Everything the current manifest references survives: offline playback
      // is the product's core promise and eviction may never break it.
      expect(db.getCachedMedia('img-1')).not.toBeNull();
      expect(db.getCachedMedia('vid-1')).not.toBeNull();
    });

    /** Adds a cache row the current manifest does not reference. */
    function addUnreferencedEntry(): void {
      const filePath = join(config.mediaDir, 'orphan-1');
      const body = Buffer.from('an unreferenced leftover');
      writeFileSync(filePath, body);
      db.applyManifest(
        db.getManifest()!,
        [
          {
            mediaId: 'orphan-1',
            checksum: sha256(body),
            sizeBytes: body.length,
            mimeType: 'image/jpeg',
            filePath,
          },
        ],
        [],
      );
    }

    /**
     * A budget smaller than the few dozen test bytes, so the over-budget branch
     * is reachable without writing gigabytes. Only `maintainCache` is called on
     * this engine — a sync would be refused as `over_budget`, correctly.
     */
    function engineWithTinyBudget(): SyncEngine {
      const cfg = loadConfig({
        SIGNAGE_SERVER_URL: backend.url,
        SIGNAGE_DATA_DIR: dataDir,
        SIGNAGE_CACHE_EVICTION: 'true',
        SIGNAGE_MAX_CACHE_GB: '0.00000005',
      } as NodeJS.ProcessEnv);
      return new SyncEngine(
        cfg,
        db,
        new ApiClient(cfg, 'test-token'),
        pino({ level: 'silent' }),
        () => {},
      );
    }
  });
});
