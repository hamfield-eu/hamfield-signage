import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepOrphans, verifyCache, type VerifiableEntry } from './cache-maintenance';

let dir: string;
let mediaDir: string;
let tmpDirPath: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'signage-cache-'));
  mediaDir = join(dir, 'media');
  tmpDirPath = join(dir, 'tmp');
  await mkdir(mediaDir, { recursive: true });
  await mkdir(tmpDirPath, { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sha256 = (body: string) => createHash('sha256').update(body).digest('hex');

async function writeMedia(id: string, body: string): Promise<VerifiableEntry> {
  const filePath = join(mediaDir, id);
  await writeFile(filePath, body);
  return {
    mediaId: id,
    checksum: sha256(body),
    sizeBytes: Buffer.byteLength(body),
    filePath,
    lastVerifiedAt: null,
  };
}

const opts = { hashLimit: 0, rehashIntervalMs: 7 * 24 * 60 * 60 * 1000 };

describe('verifyCache (F5)', () => {
  it('detects a file the index claims is present but which is gone', async () => {
    // Today the index alone decides, so diffManifest calls this "unchanged"
    // and it is never re-downloaded. The player then 404s on it forever.
    const entry = await writeMedia('gone', 'hello');
    rmSync(entry.filePath);

    const result = await verifyCache([entry], opts);

    expect(result.invalid).toEqual([{ mediaId: 'gone', reason: 'missing' }]);
  });

  it('detects a truncated file by size, without hashing', async () => {
    const entry = await writeMedia('short', 'hello world');
    await writeFile(entry.filePath, 'hel');

    const result = await verifyCache([entry], opts);

    expect(result.invalid).toEqual([{ mediaId: 'short', reason: 'wrong_size' }]);
  });

  it('detects same-size corruption only on the hashing tier', async () => {
    const entry = await writeMedia('flipped', 'aaaaa');
    await writeFile(entry.filePath, 'bbbbb'); // same length, different bytes

    const cheap = await verifyCache([entry], opts);
    expect(cheap.invalid).toEqual([]); // stat cannot see this, by design

    const deep = await verifyCache([entry], { ...opts, hashLimit: 5 });
    expect(deep.invalid).toEqual([{ mediaId: 'flipped', reason: 'checksum_mismatch' }]);
  });

  it('re-hashes a file the player just errored on, out of rotation', async () => {
    // A playback error is the cheapest corruption signal available, so it must
    // not wait for the file's weekly turn.
    const good = await writeMedia('a', 'aaaaa');
    const bad = await writeMedia('b', 'bbbbb');
    await writeFile(bad.filePath, 'ccccc');

    const result = await verifyCache([good, bad], {
      ...opts,
      hashLimit: 0,
      forceRehash: ['b'],
    });

    expect(result.invalid).toEqual([{ mediaId: 'b', reason: 'checksum_mismatch' }]);
  });

  it('reports good files as verified so they go to the back of the queue', async () => {
    const entry = await writeMedia('fine', 'content');
    const result = await verifyCache([entry], { ...opts, hashLimit: 5 });
    expect(result.rehashed).toEqual(['fine']);
    expect(result.invalid).toEqual([]);
  });

  it('checks every file even when one is damaged', async () => {
    // One corrupt file must not stop the others being checked, the same way it
    // must not abort the whole sync.
    const a = await writeMedia('a', 'aaa');
    const b = await writeMedia('b', 'bbb');
    rmSync(a.filePath);

    const result = await verifyCache([a, b], opts);

    expect(result.checked).toBe(2);
    expect(result.invalid).toHaveLength(1);
  });
});

describe('sweepOrphans', () => {
  const old = async (path: string) => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await utimes(path, past, past);
  };

  it('removes an unindexed file that is past the grace period', async () => {
    const orphan = join(mediaDir, 'orphan');
    await writeFile(orphan, 'left by a crash between download and commit');
    await old(orphan);

    const result = await sweepOrphans({
      mediaDir,
      tmpDir: tmpDirPath,
      indexedFileNames: new Set(),
    });

    expect(result.mediaRemoved).toBe(1);
    expect(result.bytesFreed).toBeGreaterThan(0);
  });

  it('respects the grace period, so it cannot race an in-flight download', async () => {
    // downloadMedia renames into mediaDir before applyManifest commits the
    // index rows, so a file with no row is normal for the length of a sync.
    await writeFile(join(mediaDir, 'downloading-now'), 'fresh');

    const result = await sweepOrphans({
      mediaDir,
      tmpDir: tmpDirPath,
      indexedFileNames: new Set(),
    });

    expect(result.mediaRemoved).toBe(0);
  });

  it('never removes an indexed file', async () => {
    const kept = join(mediaDir, 'indexed');
    await writeFile(kept, 'real content');
    await old(kept);

    const result = await sweepOrphans({
      mediaDir,
      tmpDir: tmpDirPath,
      indexedFileNames: new Set(['indexed']),
    });

    expect(result.mediaRemoved).toBe(0);
  });

  it('cleans stale .part files left by an interrupted download', async () => {
    const part = join(tmpDirPath, 'media-1.part');
    await writeFile(part, 'half a video');
    await old(part);
    const other = join(tmpDirPath, 'notes.txt');
    await writeFile(other, 'not ours');
    await old(other);

    const result = await sweepOrphans({
      mediaDir,
      tmpDir: tmpDirPath,
      indexedFileNames: new Set(),
    });

    expect(result.partsRemoved).toBe(1);
  });

  it('tolerates missing directories', async () => {
    const result = await sweepOrphans({
      mediaDir: join(dir, 'nope'),
      tmpDir: join(dir, 'also-nope'),
      indexedFileNames: new Set(),
    });
    expect(result).toEqual({ mediaRemoved: 0, partsRemoved: 0, bytesFreed: 0 });
  });
});
