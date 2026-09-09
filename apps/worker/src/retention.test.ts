import { describe, expect, it } from 'vitest';
import { assessBackupFreshness, computeCutoffs } from './retention';

const NOW = new Date('2026-09-09T12:00:00.000Z');

/**
 * This job deletes production rows, so the two pure decisions it rests on —
 * where the cutoff falls, and whether a backup is recent enough to justify
 * deleting at all — are pinned here.
 */
describe('computeCutoffs', () => {
  it('places each cutoff exactly N days back', () => {
    const c = computeCutoffs(NOW, {
      heartbeatDays: 14,
      deviceLogDays: 30,
      playbackEventDays: 90,
    });
    expect(c.heartbeats.toISOString()).toBe('2026-08-26T12:00:00.000Z');
    expect(c.deviceLogs.toISOString()).toBe('2026-08-10T12:00:00.000Z');
    expect(c.playbackEvents.toISOString()).toBe('2026-06-11T12:00:00.000Z');
  });

  it('always produces a cutoff in the past', () => {
    const c = computeCutoffs(NOW, { heartbeatDays: 1, deviceLogDays: 1, playbackEventDays: 1 });
    for (const cutoff of Object.values(c)) expect(cutoff.getTime()).toBeLessThan(NOW.getTime());
  });

  it('refuses a zero or negative window', () => {
    // `0` would mean "delete everything up to now" — a plausible typo, and an
    // unrecoverable one. Reject rather than compute it.
    expect(() => computeCutoffs(NOW, { heartbeatDays: 0, deviceLogDays: 30, playbackEventDays: 90 })).toThrow(
      /must be >= 1 day/,
    );
    expect(() => computeCutoffs(NOW, { heartbeatDays: -5, deviceLogDays: 30, playbackEventDays: 90 })).toThrow();
  });

  it('refuses a non-numeric window', () => {
    expect(() =>
      computeCutoffs(NOW, { heartbeatDays: NaN, deviceLogDays: 30, playbackEventDays: 90 }),
    ).toThrow();
  });
});

describe('assessBackupFreshness', () => {
  const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();

  it('accepts a recent backup', () => {
    expect(assessBackupFreshness(at(2), NOW, 36).ok).toBe(true);
  });

  it('rejects a stale backup', () => {
    const r = assessBackupFreshness(at(48), NOW, 36);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/48.0h old/);
  });

  it('fails CLOSED when no backup is recorded', () => {
    // The gate exists for the case where backups silently stopped — which is
    // exactly when the marker is missing. Absence must not read as success.
    expect(assessBackupFreshness(null, NOW, 36).ok).toBe(false);
  });

  it('fails closed on an unparseable marker', () => {
    expect(assessBackupFreshness('not-a-date', NOW, 36).ok).toBe(false);
  });

  it('tolerates a marker slightly in the future', () => {
    // The host writes the marker; the worker reads it in a container. Small clock
    // skew must not block retention forever.
    const r = assessBackupFreshness(at(-1), NOW, 36);
    expect(r.ok).toBe(true);
  });

  it('treats the boundary as fresh', () => {
    expect(assessBackupFreshness(at(36), NOW, 36).ok).toBe(true);
  });
});
