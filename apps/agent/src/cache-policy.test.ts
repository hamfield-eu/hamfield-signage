import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_CACHE_SIZE_GB } from '@signage/shared';
import {
  effectiveCacheBudgetBytes,
  planStorage,
  selectEvictionCandidates,
  selectForRehash,
  type CacheEntrySummary,
} from './cache-policy';

const GB = 1024 ** 3;
const MB = 1024 * 1024;

describe('effectiveCacheBudgetBytes', () => {
  it('uses the configured cap on a roomy disk', () => {
    expect(
      effectiveCacheBudgetBytes({
        configuredGb: DEFAULT_MAX_CACHE_SIZE_GB,
        diskTotalBytes: 500 * GB,
      }),
    ).toBe(8 * GB);
  });

  it('caps at a fraction of the disk on a small thin client', () => {
    // The failure this prevents: an 8 GB eMMC handing the whole disk to media
    // and leaving the OS no room to write logs. Note the cap only bites below
    // ~11.4 GB of total disk, which is exactly the thin-client range.
    const budget = effectiveCacheBudgetBytes({ configuredGb: 8, diskTotalBytes: 8 * GB });
    expect(budget).toBeLessThan(8 * GB);
    expect(budget).toBe(Math.floor(8 * GB * 0.7));
  });

  it('falls back to the configured cap when the disk size is unknown', () => {
    expect(effectiveCacheBudgetBytes({ configuredGb: 4, diskTotalBytes: null })).toBe(4 * GB);
  });
});

describe('planStorage', () => {
  const base = {
    requiredBytes: 1 * GB,
    availableBytes: 10 * GB,
    reclaimableBytes: 0,
    manifestBytes: 2 * GB,
    budgetBytes: 8 * GB,
    headroomBytes: 500 * MB,
  };

  it('allows a sync that comfortably fits', () => {
    expect(planStorage(base)).toMatchObject({ ok: true, shortfallBytes: 0, reason: 'ok' });
  });

  it('refuses when the download plus headroom exceeds free space', () => {
    const plan = planStorage({ ...base, availableBytes: 1 * GB });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe('disk_full');
    expect(plan.shortfallBytes).toBe(500 * MB);
  });

  it('keeps headroom rather than filling the disk to the last byte', () => {
    // Exactly enough for the file, nothing left over: still refused, because a
    // device with a full root filesystem cannot even write its own logs.
    const plan = planStorage({ ...base, availableBytes: 1 * GB, requiredBytes: 1 * GB });
    expect(plan.ok).toBe(false);
  });

  it('does NOT count reclaimable bytes as available', () => {
    // Deleting the stale files early would free the room, and would also delete
    // content the still-active manifest is playing from. The commit order is
    // transactional on purpose, so the swap genuinely needs old + new.
    const plan = planStorage({
      ...base,
      requiredBytes: 6 * GB,
      availableBytes: 2 * GB,
      reclaimableBytes: 6 * GB,
    });
    expect(plan.ok).toBe(false);
    expect(plan.reclaimableBytes).toBe(6 * GB);
  });

  it('refuses when the manifest itself exceeds the cache budget', () => {
    const plan = planStorage({ ...base, manifestBytes: 10 * GB, budgetBytes: 8 * GB });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe('over_budget');
    expect(plan.shortfallBytes).toBe(2 * GB);
  });

  it('reports over_budget ahead of disk_full, because eviction cannot fix it', () => {
    const plan = planStorage({
      ...base,
      manifestBytes: 10 * GB,
      budgetBytes: 8 * GB,
      availableBytes: 0,
    });
    expect(plan.reason).toBe('over_budget');
  });
});

describe('selectEvictionCandidates', () => {
  const entry = (over: Partial<CacheEntrySummary> = {}): CacheEntrySummary => ({
    mediaId: 'm',
    sizeBytes: 1 * GB,
    lastUsedAt: null,
    downloadedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('evicts nothing when under budget', () => {
    const result = selectEvictionCandidates({
      entries: [entry({ mediaId: 'a' })],
      referencedIds: new Set(),
      budgetBytes: 8 * GB,
    });
    expect(result.mediaIds).toEqual([]);
  });

  it('never evicts a file the current manifest references', () => {
    // Doing so would break offline playback — the product's core promise — and
    // a device with no network could not get the file back.
    const result = selectEvictionCandidates({
      entries: [entry({ mediaId: 'referenced' }), entry({ mediaId: 'orphan' })],
      referencedIds: new Set(['referenced']),
      budgetBytes: 1 * GB,
    });
    expect(result.mediaIds).toEqual(['orphan']);
  });

  it('evicts least-recently-*played* first, not oldest download', () => {
    const result = selectEvictionCandidates({
      entries: [
        entry({
          mediaId: 'new-download-old-play',
          downloadedAt: '2026-05-01T00:00:00.000Z',
          lastUsedAt: '2026-01-01T00:00:00.000Z',
        }),
        entry({
          mediaId: 'old-download-recent-play',
          downloadedAt: '2026-01-01T00:00:00.000Z',
          lastUsedAt: '2026-06-01T00:00:00.000Z',
        }),
      ],
      referencedIds: new Set(),
      budgetBytes: 1 * GB,
    });
    expect(result.mediaIds).toEqual(['new-download-old-play']);
  });

  it('stops as soon as it is back under budget', () => {
    const result = selectEvictionCandidates({
      entries: [
        entry({ mediaId: 'a', lastUsedAt: '2026-01-01T00:00:00.000Z' }),
        entry({ mediaId: 'b', lastUsedAt: '2026-02-01T00:00:00.000Z' }),
        entry({ mediaId: 'c', lastUsedAt: '2026-03-01T00:00:00.000Z' }),
      ],
      referencedIds: new Set(),
      budgetBytes: 2 * GB,
    });
    expect(result.mediaIds).toEqual(['a']);
    expect(result.freedBytes).toBe(1 * GB);
  });

  it('returns nothing when every over-budget file is referenced', () => {
    // This is an insufficient_storage condition, not an eviction problem.
    const result = selectEvictionCandidates({
      entries: [entry({ mediaId: 'a' }), entry({ mediaId: 'b' })],
      referencedIds: new Set(['a', 'b']),
      budgetBytes: 1 * GB,
    });
    expect(result.mediaIds).toEqual([]);
  });
});

describe('selectForRehash', () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const week = 7 * 24 * 60 * 60 * 1000;

  it('prefers never-verified files', () => {
    const picked = selectForRehash({
      entries: [
        { mediaId: 'verified-recently', lastVerifiedAt: '2026-09-10T11:00:00.000Z' },
        { mediaId: 'never', lastVerifiedAt: null },
      ],
      limit: 5,
      now,
      intervalMs: week,
    });
    expect(picked).toEqual(['never']);
  });

  it('bounds the pass so hashing cannot saturate a slow eMMC', () => {
    const picked = selectForRehash({
      entries: Array.from({ length: 50 }, (_, i) => ({
        mediaId: `m${i}`,
        lastVerifiedAt: null,
      })),
      limit: 2,
      now,
      intervalMs: week,
    });
    expect(picked).toHaveLength(2);
  });

  it('takes the oldest verification first', () => {
    const picked = selectForRehash({
      entries: [
        { mediaId: 'newer', lastVerifiedAt: '2026-08-01T00:00:00.000Z' },
        { mediaId: 'older', lastVerifiedAt: '2026-07-01T00:00:00.000Z' },
      ],
      limit: 1,
      now,
      intervalMs: week,
    });
    expect(picked).toEqual(['older']);
  });
});
