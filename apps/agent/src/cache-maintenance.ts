import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256File } from '@signage/media';
import { ORPHAN_GRACE_MS } from '@signage/shared';
import { selectForRehash } from './cache-policy';

/**
 * Filesystem-facing half of the cache guard: does what is on disk still match
 * what the index claims?
 *
 * Before this, nothing ever looked. `diffManifest` trusts the SQLite index
 * alone, so a file truncated by an eMMC write failure, or deleted by hand, was
 * never re-downloaded — the player asked for it, got a 404 from the agent's own
 * media route, errored, advanced, and did the same thing on the next cycle
 * forever. The only escape was `clear_cache`, which re-downloads everything.
 */

export type IntegrityFailureReason = 'missing' | 'wrong_size' | 'checksum_mismatch';

export interface IntegrityResult {
  /** Entries whose file is gone or wrong; their rows and files must be dropped. */
  invalid: Array<{ mediaId: string; reason: IntegrityFailureReason }>;
  /** Entries confirmed good by a full re-hash this pass. */
  rehashed: string[];
  checked: number;
}

export interface VerifiableEntry {
  mediaId: string;
  checksum: string;
  sizeBytes: number;
  filePath: string;
  lastVerifiedAt: string | null;
}

/**
 * Two tiers, because they cost very different amounts.
 *
 * The cheap tier `stat`s every file and catches the common damage — a missing
 * or truncated file — for the price of one syscall each. The expensive tier
 * re-hashes, which is the only way to catch same-size corruption, and is
 * therefore bounded per pass and spread over `rehashIntervalMs`.
 *
 * `forceRehash` exists for the cheapest corruption signal there is: the player
 * has just reported a playback error on that specific file.
 */
export async function verifyCache(
  entries: VerifiableEntry[],
  opts: {
    hashLimit: number;
    rehashIntervalMs: number;
    now?: Date;
    forceRehash?: Iterable<string>;
  },
): Promise<IntegrityResult> {
  const now = opts.now ?? new Date();
  const invalid: IntegrityResult['invalid'] = [];
  const sizeOk: VerifiableEntry[] = [];

  for (const entry of entries) {
    let size: number;
    try {
      size = (await stat(entry.filePath)).size;
    } catch {
      invalid.push({ mediaId: entry.mediaId, reason: 'missing' });
      continue;
    }
    if (size !== entry.sizeBytes) {
      invalid.push({ mediaId: entry.mediaId, reason: 'wrong_size' });
      continue;
    }
    sizeOk.push(entry);
  }

  const forced = new Set(opts.forceRehash ?? []);
  const due = new Set(
    selectForRehash({
      entries: sizeOk.map((e) => ({ mediaId: e.mediaId, lastVerifiedAt: e.lastVerifiedAt })),
      limit: opts.hashLimit,
      now,
      intervalMs: opts.rehashIntervalMs,
    }),
  );
  for (const id of forced) due.add(id);

  const rehashed: string[] = [];
  for (const entry of sizeOk) {
    if (!due.has(entry.mediaId)) continue;
    try {
      const digest = await sha256File(entry.filePath);
      if (digest === entry.checksum) rehashed.push(entry.mediaId);
      else invalid.push({ mediaId: entry.mediaId, reason: 'checksum_mismatch' });
    } catch {
      invalid.push({ mediaId: entry.mediaId, reason: 'missing' });
    }
  }

  return { invalid, rehashed, checked: entries.length };
}

/**
 * Removes files the index does not know about.
 *
 * `docs/sync-protocol.md` documents these as expected: downloads land in the
 * media directory before the index commit, so a crash in that window leaves a
 * file with no row.
 *
 * **The grace period is the only thing standing between this and deleting a
 * download in flight**, because an unindexed file is entirely normal for the
 * duration of a sync. Do not shorten it to make a test faster — pass an
 * explicit `graceMs` in the test instead.
 */
export async function sweepOrphans(opts: {
  mediaDir: string;
  tmpDir: string;
  indexedFileNames: Set<string>;
  now?: Date;
  graceMs?: number;
}): Promise<{ mediaRemoved: number; partsRemoved: number; bytesFreed: number }> {
  const grace = opts.graceMs ?? ORPHAN_GRACE_MS;
  const cutoff = (opts.now ?? new Date()).getTime() - grace;
  let mediaRemoved = 0;
  let partsRemoved = 0;
  let bytesFreed = 0;

  for (const name of await listDir(opts.mediaDir)) {
    if (opts.indexedFileNames.has(name)) continue;
    const path = join(opts.mediaDir, name);
    const info = await stat(path).catch(() => null);
    if (!info || !info.isFile() || info.mtimeMs > cutoff) continue;
    await rm(path, { force: true }).catch(() => undefined);
    mediaRemoved++;
    bytesFreed += info.size;
  }

  // Interrupted downloads. `downloadMedia` cleans up its own temp file on a
  // handled failure, but a power cut mid-write leaves one behind.
  for (const name of await listDir(opts.tmpDir)) {
    if (!name.endsWith('.part')) continue;
    const path = join(opts.tmpDir, name);
    const info = await stat(path).catch(() => null);
    if (!info || !info.isFile() || info.mtimeMs > cutoff) continue;
    await rm(path, { force: true }).catch(() => undefined);
    partsRemoved++;
    bytesFreed += info.size;
  }

  return { mediaRemoved, partsRemoved, bytesFreed };
}

async function listDir(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => [] as string[]);
}
