import { mkdir, rm, statfs } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Logger } from 'pino';
import { diffManifest, bytesToDownload, type SyncManifest } from '@signage/sync-protocol';
import type { ApiClient } from './api-client';
import { effectiveCacheBudgetBytes, planStorage, selectEvictionCandidates } from './cache-policy';
import { sweepOrphans, verifyCache } from './cache-maintenance';
import type { AgentConfig } from './config';
import type { AgentDb } from './db';

/** How long a cached file may go without a full re-hash. */
const REHASH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** Minimum gap between automatic repair re-downloads; see `maintainCache`. */
const REPAIR_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Transactional content sync:
 *  1. fetch the manifest and skip if the version is unchanged
 *  2. download new/changed media to temp files, verify checksums
 *  3. commit manifest + cache index atomically in SQLite
 *  4. delete stale files only after the commit
 *
 * The currently playing content keeps running from the old cache until the
 * commit, so the screen never goes blank during a sync.
 */
export class SyncEngine {
  private syncing = false;
  private queued = false;
  private queuedForce = false;
  /** Media ids the player has just errored on; re-hashed on the next pass. */
  private suspect = new Set<string>();
  private lastIntegrityCheckAt: string | null = null;
  private lastRepairAt = 0;
  private integrityFailures: string[] = [];
  private orphansRemoved = 0;

  constructor(
    private config: AgentConfig,
    private db: AgentDb,
    private api: ApiClient,
    private log: Logger,
    private onApplied: (manifest: SyncManifest) => void,
  ) {}

  /** True while media is being downloaded or the manifest swapped. */
  isSyncing(): boolean {
    return this.syncing;
  }

  /**
   * `force` skips the "manifest version unchanged" shortcut.
   *
   * Repair needs it. After a corrupt file is dropped from the index the server
   * manifest is byte-identical to the one already applied, so the ordinary sync
   * returns before `diffManifest` ever runs and the file is never re-fetched.
   * Everything downstream of the version check is unchanged, so a repair still
   * goes through the same download, checksum and commit path as any other sync.
   */
  async syncNow(reason: string, opts: { force?: boolean } = {}): Promise<void> {
    if (this.syncing) {
      this.queued = true;
      this.queuedForce ||= opts.force ?? false;
      return;
    }
    this.syncing = true;
    try {
      await this.runSync(reason, opts.force ?? false);
    } catch (err) {
      this.log.warn({ err, reason }, 'sync failed');
      this.db.bufferLog('warn', `sync failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.syncing = false;
      if (this.queued) {
        this.queued = false;
        const force = this.queuedForce;
        this.queuedForce = false;
        void this.syncNow('queued during previous sync', { force });
      }
    }
  }

  /** Media the player just failed to play: the cheapest corruption signal. */
  noteSuspectMedia(mediaId: string): void {
    this.suspect.add(mediaId);
  }

  cacheReport(): {
    cacheBudgetBytes: number;
    cachedFileCount: number;
    lastIntegrityCheckAt: string | null;
    integrityFailureCount: number;
    orphanFilesRemoved: number;
  } {
    return {
      cacheBudgetBytes: this.budgetBytes(this.lastDiskTotalBytes),
      cachedFileCount: this.db.cachedFileCount(),
      lastIntegrityCheckAt: this.lastIntegrityCheckAt,
      integrityFailureCount: this.integrityFailures.length,
      orphanFilesRemoved: this.orphansRemoved,
    };
  }

  private lastDiskTotalBytes: number | null = null;

  private budgetBytes(diskTotalBytes: number | null): number {
    return effectiveCacheBudgetBytes({
      configuredGb: this.config.maxCacheGb,
      diskTotalBytes,
    });
  }

  private async diskSpace(): Promise<{ available: number; total: number } | null> {
    // Walk up to the nearest directory that exists.
    //
    // On a device's FIRST sync the media directory has not been created yet —
    // `mkdir` happens further down, inside the download step — so statfs threw
    // ENOENT, this returned null, and the precheck was skipped entirely. That
    // is exactly the sync that most needs checking: an empty cache downloading
    // a whole playlist onto a small eMMC.
    //
    // The parent is on the filesystem the media directory will be created on,
    // so it measures the right thing. (If the media directory were itself a
    // mount point, it would exist and the first attempt would succeed.)
    let dir = this.config.mediaDir;
    for (;;) {
      try {
        const fs = await statfs(dir);
        const space = { available: fs.bavail * fs.bsize, total: fs.blocks * fs.bsize };
        this.lastDiskTotalBytes = space.total;
        return space;
      } catch {
        const parent = dirname(dir);
        // statfs can also fail on exotic filesystems. Without numbers there is
        // nothing to decide on, so the sync proceeds as it did before T017.
        if (parent === dir) return null;
        dir = parent;
      }
    }
  }

  private async runSync(reason: string, force: boolean): Promise<void> {
    const { manifest } = await this.api.getSync(false);
    const currentVersion = this.db.getManifestVersion();
    if (!force && manifest.version === currentVersion) {
      this.log.debug({ reason, version: manifest.version }, 'sync: manifest unchanged');
      return;
    }
    this.log.info(
      { reason, from: currentVersion, to: manifest.version, media: manifest.media.length },
      'sync: applying new manifest',
    );

    const cached = this.db.listCachedMedia();
    const diff = diffManifest(cached, manifest.media);

    if (diff.toDownload.length > 0 && !(await this.checkStorage(manifest, diff, cached))) {
      // Refused before a single byte was written. The previous manifest and
      // cache index are untouched, so the screen carries on playing what it
      // has — which is the whole difference from today's behaviour, where the
      // sync starts, hits ENOSPC, aborts, and retries the same failure forever.
      return;
    }

    if (diff.toDownload.length > 0) {
      this.log.info(
        { files: diff.toDownload.length, bytes: bytesToDownload(diff) },
        'sync: downloading media',
      );
      await this.api
        .reportSyncStatus({
          manifestVersion: manifest.version,
          status: 'downloading',
          cacheUsedBytes: this.db.cacheUsedBytes(),
        })
        .catch(() => undefined);
    }

    await mkdir(this.config.mediaDir, { recursive: true });
    const upserts: Array<{
      mediaId: string;
      checksum: string;
      sizeBytes: number;
      mimeType: string;
      filePath: string;
    }> = [];
    try {
      for (const media of diff.toDownload) {
        const filePath = join(this.config.mediaDir, media.id);
        await this.api.downloadMedia(media, filePath);
        upserts.push({
          mediaId: media.id,
          checksum: media.checksum,
          sizeBytes: media.sizeBytes,
          mimeType: media.mimeType,
          filePath,
        });
        this.log.debug({ mediaId: media.id, name: media.name }, 'sync: downloaded');
      }
    } catch (err) {
      // ENOSPC can still surface here despite the precheck — another process
      // took the space, or the manifest under-reports a file's size. Report it
      // as the storage condition it is, not as a generic failure.
      const outOfSpace = isOutOfSpace(err);
      const space = outOfSpace ? await this.diskSpace() : null;
      await this.api
        .reportSyncStatus({
          manifestVersion: manifest.version,
          status: outOfSpace ? 'insufficient_storage' : 'failed',
          error: err instanceof Error ? err.message.slice(0, 2000) : String(err),
          cacheUsedBytes: this.db.cacheUsedBytes(),
          ...(outOfSpace
            ? {
                requiredBytes: bytesToDownload(diff),
                availableBytes: space?.available,
                cacheBudgetBytes: this.budgetBytes(space?.total ?? null),
              }
            : {}),
        })
        .catch(() => undefined);
      throw err;
    }

    // Collect stale file paths before the index rows disappear.
    const staleFiles = diff.toDelete
      .map((id) => this.db.getCachedMedia(id)?.filePath)
      .filter((p): p is string => Boolean(p));

    this.db.applyManifest(manifest, upserts, diff.toDelete);

    for (const filePath of staleFiles) {
      await rm(filePath, { force: true }).catch(() => undefined);
    }

    await this.api
      .reportSyncStatus({
        manifestVersion: manifest.version,
        status: 'applied',
        cachedMediaIds: manifest.media.map((m) => m.id),
        cacheUsedBytes: this.db.cacheUsedBytes(),
      })
      .catch(() => undefined);

    this.log.info({ version: manifest.version }, 'sync: applied');
    this.onApplied(manifest);

    // Housekeeping runs after the commit, never before it: nothing here may
    // delay the moment the new content becomes playable.
    await this.maintainCache('after sync');
  }

  /**
   * Verifies the cache against the disk, sweeps orphans, and (only when
   * explicitly enabled) evicts unreferenced files over budget.
   *
   * Runs at startup and after every applied sync. Never throws — a failure to
   * tidy up must not become a failure to play.
   */
  async maintainCache(reason: string): Promise<void> {
    try {
      // Also refreshes `lastDiskTotalBytes`, which the heartbeat's budget
      // figure reads. Without it a device with eviction off (the default)
      // would report the uncapped configured budget rather than the real one.
      await this.diskSpace();
      const entries = this.db.listCacheDetail();
      const suspect = [...this.suspect];
      this.suspect.clear();

      const result = await verifyCache(entries, {
        hashLimit: this.config.cacheHashPerPass,
        rehashIntervalMs: REHASH_INTERVAL_MS,
        forceRehash: suspect,
      });
      this.lastIntegrityCheckAt = new Date().toISOString();
      if (result.rehashed.length > 0) this.db.markVerified(result.rehashed);

      if (result.invalid.length > 0) {
        this.integrityFailures = result.invalid.map((i) => i.mediaId);
        const context = { reason, invalid: result.invalid.slice(0, 20) };
        this.log.warn(context, 'cache integrity: damaged files found, repairing');
        this.db.bufferLog('warn', `cache integrity: ${result.invalid.length} file(s) damaged`, {
          ...context,
          count: result.invalid.length,
        });
        for (const bad of result.invalid) {
          const entry = entries.find((e) => e.mediaId === bad.mediaId);
          if (entry) await rm(entry.filePath, { force: true }).catch(() => undefined);
        }
        // Dropping the rows is what puts the media back in `toDownload`.
        this.db.removeCacheEntries(result.invalid.map((i) => i.mediaId));
      } else {
        this.integrityFailures = [];
      }

      await this.evictIfOverBudget();

      const indexed = new Set(this.db.listCacheDetail().map((e) => basename(e.filePath)));
      const swept = await sweepOrphans({
        mediaDir: this.config.mediaDir,
        tmpDir: this.config.tmpDir,
        indexedFileNames: indexed,
      });
      if (swept.mediaRemoved || swept.partsRemoved) {
        this.orphansRemoved += swept.mediaRemoved + swept.partsRemoved;
        this.log.info(swept, 'cache: swept orphaned files');
      }

      if (result.invalid.length > 0) {
        // Re-fetch through the ordinary path. Forced, because the server
        // manifest has not changed — only our copy of it has.
        //
        // Rate-limited, because maintenance runs at the end of every sync: a
        // device whose storage is physically failing would otherwise corrupt a
        // file, repair it, corrupt it again and loop, re-downloading the whole
        // playlist continuously. The damage is still reported every pass; only
        // the automatic re-fetch waits, and the next ordinary sync retries it.
        const now = Date.now();
        if (now - this.lastRepairAt < REPAIR_COOLDOWN_MS) {
          this.log.warn(
            { sinceLastRepairMs: now - this.lastRepairAt },
            'cache integrity: damage found again within the repair cooldown; not re-fetching yet',
          );
        } else {
          this.lastRepairAt = now;
          await this.syncNow('cache repair', { force: true });
        }
      }
    } catch (err) {
      this.log.warn({ err, reason }, 'cache maintenance failed');
    }
  }

  private async evictIfOverBudget(): Promise<void> {
    if (!this.config.cacheEviction) return;
    const space = await this.diskSpace();
    const entries = this.db.listCacheDetail();
    const referenced = new Set((this.db.getManifest()?.media ?? []).map((m) => m.id));
    const { mediaIds } = selectEvictionCandidates({
      entries: entries.map((e) => ({
        mediaId: e.mediaId,
        sizeBytes: e.sizeBytes,
        lastUsedAt: e.lastUsedAt,
        downloadedAt: e.downloadedAt,
      })),
      referencedIds: referenced,
      budgetBytes: this.budgetBytes(space?.total ?? null),
    });
    if (mediaIds.length === 0) return;
    for (const id of mediaIds) {
      const entry = entries.find((e) => e.mediaId === id);
      if (entry) await rm(entry.filePath, { force: true }).catch(() => undefined);
    }
    this.db.removeCacheEntries(mediaIds);
    // Every eviction is logged: this is the one part of T017 that deletes a
    // customer's files, so it must never be silent.
    this.log.info({ mediaIds }, 'cache: evicted unreferenced files over budget');
    this.db.bufferLog('info', `cache: evicted ${mediaIds.length} unreferenced file(s)`, {
      mediaIds,
    });
  }

  /** Decides whether there is room to start. Returns false when there is not. */
  private async checkStorage(
    manifest: SyncManifest,
    diff: ReturnType<typeof diffManifest>,
    cached: Array<{ mediaId: string; sizeBytes: number }>,
  ): Promise<boolean> {
    const space = await this.diskSpace();
    if (!space) return true;

    const toDelete = new Set(diff.toDelete);
    const reclaimable = cached
      .filter((c) => toDelete.has(c.mediaId))
      .reduce((sum, c) => sum + c.sizeBytes, 0);

    const plan = planStorage({
      requiredBytes: bytesToDownload(diff),
      availableBytes: space.available,
      reclaimableBytes: reclaimable,
      manifestBytes: manifest.media.reduce((sum, m) => sum + m.sizeBytes, 0),
      budgetBytes: this.budgetBytes(space.total),
      headroomBytes: this.config.minFreeDiskBytes,
    });
    if (plan.ok) return true;

    const error =
      plan.reason === 'over_budget'
        ? `the playlist needs ${mb(plan.shortfallBytes)} MB more than this screen's cache budget`
        : `this screen needs ${mb(plan.shortfallBytes)} MB more free disk space to sync`;

    this.log.warn({ ...plan, version: manifest.version }, 'sync: insufficient storage');
    this.db.bufferLog('warn', `sync refused: ${error}`, { ...plan });
    await this.api
      .reportSyncStatus({
        manifestVersion: manifest.version,
        status: 'insufficient_storage',
        error,
        cacheUsedBytes: this.db.cacheUsedBytes(),
        requiredBytes: plan.requiredBytes,
        availableBytes: plan.availableBytes,
        reclaimableBytes: plan.reclaimableBytes,
        cacheBudgetBytes: this.budgetBytes(space.total),
        shortfallBytes: plan.shortfallBytes,
      })
      .catch(() => undefined);
    return false;
  }

  async clearCacheAndResync(): Promise<void> {
    const cached = this.db.listCachedMedia();
    this.db.clearCache();
    for (const entry of cached) {
      await rm(entry.filePath, { force: true }).catch(() => undefined);
    }
    this.log.info('cache cleared');
    await this.syncNow('cache cleared');
  }
}

function mb(bytes: number): number {
  return Math.ceil(bytes / (1024 * 1024));
}

/** ENOSPC surfaces as a code on the error or, through streams, on its cause. */
function isOutOfSpace(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code === 'ENOSPC') return true;
  const cause = (err as { cause?: { code?: string } })?.cause;
  return cause?.code === 'ENOSPC';
}
