import { DEFAULT_MIN_FREE_DISK_MB, MAX_CACHE_DISK_FRACTION } from '@signage/shared';

/**
 * Storage decisions, as pure functions.
 *
 * Extracted from the sync engine deliberately: this is the arithmetic that
 * decides whether a device downloads or refuses, and whether it deletes a
 * customer's cached file. It must be testable without a filesystem, a database
 * or a network, so that the reasoning is verified even where the agent's
 * native SQLite binding cannot be built.
 */

export interface CacheEntrySummary {
  mediaId: string;
  sizeBytes: number;
  /** ISO timestamp of the last time the player actually read this file. */
  lastUsedAt: string | null;
  /** ISO timestamp of when it was downloaded; the fallback ordering key. */
  downloadedAt: string | null;
}

/**
 * The effective cache budget: the configured cap, but never more than a
 * fraction of the whole filesystem.
 *
 * A 32 GB thin client given the 8 GB default would otherwise hand a quarter of
 * its disk to media and still be one large playlist away from an OS with no
 * room to write logs — which is the failure this task exists to stop.
 */
export function effectiveCacheBudgetBytes(input: {
  configuredGb: number;
  diskTotalBytes: number | null;
  fraction?: number;
}): number {
  const configured = Math.max(0, input.configuredGb) * 1024 ** 3;
  if (!input.diskTotalBytes || input.diskTotalBytes <= 0) return configured;
  const fraction = input.fraction ?? MAX_CACHE_DISK_FRACTION;
  return Math.min(configured, Math.floor(input.diskTotalBytes * fraction));
}

export interface StoragePlan {
  ok: boolean;
  requiredBytes: number;
  availableBytes: number;
  reclaimableBytes: number;
  /** How much more room the device needs; 0 when `ok`. */
  shortfallBytes: number;
  reason: 'ok' | 'disk_full' | 'over_budget';
}

/**
 * Decides whether a sync may start.
 *
 * Two independent limits, and the tighter one wins:
 *
 *  - **Free disk.** Downloads land before deletions do (the commit order is
 *    transactional and must not change), so the device transiently needs
 *    `old + new` bytes. `reclaimableBytes` — what the stale files would give
 *    back — is reported but NOT counted as available, because freeing it early
 *    would delete files the still-active manifest is playing from.
 *  - **Cache budget.** What the new manifest wants to keep, against the cap.
 *
 * Returning `ok: false` is the whole point of the task: the device stops,
 * reports a distinct status, and keeps playing what it already has, rather
 * than starting a download it cannot finish and retrying that failure forever.
 */
export function planStorage(input: {
  requiredBytes: number;
  availableBytes: number;
  reclaimableBytes: number;
  manifestBytes: number;
  budgetBytes: number;
  headroomBytes?: number;
}): StoragePlan {
  const headroom = input.headroomBytes ?? DEFAULT_MIN_FREE_DISK_MB * 1024 * 1024;
  const needOnDisk = input.requiredBytes + headroom;
  const base = {
    requiredBytes: input.requiredBytes,
    availableBytes: input.availableBytes,
    reclaimableBytes: input.reclaimableBytes,
  };

  if (input.manifestBytes > input.budgetBytes) {
    // The content itself does not fit the cap. Eviction cannot help: every
    // byte is referenced by the manifest the device is being asked to play.
    return {
      ...base,
      ok: false,
      shortfallBytes: input.manifestBytes - input.budgetBytes,
      reason: 'over_budget',
    };
  }
  if (input.availableBytes < needOnDisk) {
    return {
      ...base,
      ok: false,
      shortfallBytes: needOnDisk - input.availableBytes,
      reason: 'disk_full',
    };
  }
  return { ...base, ok: true, shortfallBytes: 0, reason: 'ok' };
}

/**
 * Chooses cache entries to evict, least-recently-used first.
 *
 * **Files referenced by the current manifest are never candidates.** Evicting
 * one would break offline playback, which is the product's core promise — a
 * device with no network could not get it back. If the manifest alone exceeds
 * the budget, that is an `insufficient_storage` condition (see `planStorage`),
 * not something eviction is allowed to paper over.
 */
export function selectEvictionCandidates(input: {
  entries: CacheEntrySummary[];
  referencedIds: Set<string>;
  budgetBytes: number;
}): { mediaIds: string[]; freedBytes: number } {
  const used = input.entries.reduce((sum, e) => sum + e.sizeBytes, 0);
  let over = used - input.budgetBytes;
  if (over <= 0) return { mediaIds: [], freedBytes: 0 };

  const candidates = input.entries
    .filter((e) => !input.referencedIds.has(e.mediaId))
    .sort((a, b) => orderKey(a).localeCompare(orderKey(b)));

  const mediaIds: string[] = [];
  let freedBytes = 0;
  for (const entry of candidates) {
    if (over <= 0) break;
    mediaIds.push(entry.mediaId);
    freedBytes += entry.sizeBytes;
    over -= entry.sizeBytes;
  }
  return { mediaIds, freedBytes };
}

/** Oldest-first ordering key: real last use, falling back to download time. */
function orderKey(entry: CacheEntrySummary): string {
  return entry.lastUsedAt ?? entry.downloadedAt ?? '';
}

/**
 * Files due an expensive re-hash this pass, oldest verification first.
 *
 * Bounded on purpose. A full re-hash of a multi-gigabyte cache saturates eMMC
 * read bandwidth, and doing that while a video plays would cause exactly the
 * decode stalls T015 exists to eliminate.
 */
export function selectForRehash(input: {
  entries: Array<{ mediaId: string; lastVerifiedAt: string | null }>;
  limit: number;
  now: Date;
  intervalMs: number;
}): string[] {
  const cutoff = input.now.getTime() - input.intervalMs;
  return input.entries
    .filter((e) => !e.lastVerifiedAt || Date.parse(e.lastVerifiedAt) < cutoff)
    .sort((a, b) => (a.lastVerifiedAt ?? '').localeCompare(b.lastVerifiedAt ?? ''))
    .slice(0, Math.max(0, input.limit))
    .map((e) => e.mediaId);
}
