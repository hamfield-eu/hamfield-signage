import { describe, expect, it } from 'vitest';
import { diffAlertState, evaluateAlerts, type Alert, type FleetSnapshot } from './alerts';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const T = { emergencyHours: 4, offlineMinutes: 15, queueWaiting: 20, backupWithinHours: 36 };

const base = (over: Partial<FleetSnapshot> = {}): FleetSnapshot => ({
  now: NOW,
  activeOverrides: [],
  offlineDevices: [],
  devicesInSyncError: [],
  failedMediaLastHour: 0,
  queueWaiting: 0,
  backupMarker: ago(60 * 60_000).toISOString(),
  ...over,
});

describe('evaluateAlerts', () => {
  it('is silent on a healthy fleet', () => {
    expect(evaluateAlerts(base(), T)).toEqual([]);
  });

  it('fires urgent on a long-running emergency override', () => {
    // The highest-value alert: emergency.ts has no auto-expiry, so a forgotten
    // override blanks a customer's screens indefinitely and nothing else mentions it.
    const a = evaluateAlerts(
      base({
        activeOverrides: [
          { id: 'o1', name: 'Fire drill', organizationName: 'Acme', startedAt: ago(5 * 3_600_000) },
        ],
      }),
      T,
    );
    expect(a).toHaveLength(1);
    expect(a[0].id).toBe('emergency:o1');
    expect(a[0].priority).toBe('urgent');
    expect(a[0].message).toContain('5.0h');
  });

  it('does not fire on an override that is still within the window', () => {
    const a = evaluateAlerts(
      base({
        activeOverrides: [
          { id: 'o1', name: 'Fire drill', organizationName: 'Acme', startedAt: ago(3 * 3_600_000) },
        ],
      }),
      T,
    );
    expect(a).toEqual([]);
  });

  it('distinguishes a never-seen device from a lapsed one', () => {
    const a = evaluateAlerts(
      base({
        offlineDevices: [
          { id: 'd1', name: 'Lobby', lastSeenAt: ago(30 * 60_000) },
          { id: 'd2', name: 'New screen', lastSeenAt: null },
        ],
      }),
      T,
    );
    expect(a.map((x) => x.id)).toEqual(['offline:d1', 'offline:d2']);
    expect(a[0].message).toContain('30 minutes');
    expect(a[1].message).toContain('never checked in');
  });

  it('fires urgent when backups have stopped', () => {
    const a = evaluateAlerts(base({ backupMarker: null }), T);
    expect(a).toHaveLength(1);
    expect(a[0].id).toBe('backup-stale');
    expect(a[0].priority).toBe('urgent');
  });

  it('only fires the queue alert above the threshold', () => {
    expect(evaluateAlerts(base({ queueWaiting: 20 }), T)).toEqual([]);
    expect(evaluateAlerts(base({ queueWaiting: 21 }), T)[0].id).toBe('queue-backlog');
  });
});

describe('diffAlertState', () => {
  const a: Alert = { id: 'x', title: 't', message: 'm', priority: 'high', tags: [] };

  it('sends an alert it has never sent', () => {
    expect(diffAlertState([a], new Set(), new Map(), NOW, 6).toSend).toHaveLength(1);
  });

  it('suppresses a repeat inside the repeat window', () => {
    // Re-notifying every evaluation trains people to ignore the channel.
    const last = new Map([['x', NOW.getTime() - 2 * 3_600_000]]);
    expect(diffAlertState([a], new Set(['x']), last, NOW, 6).toSend).toEqual([]);
  });

  it('re-sends once the repeat window has passed', () => {
    const last = new Map([['x', NOW.getTime() - 7 * 3_600_000]]);
    expect(diffAlertState([a], new Set(['x']), last, NOW, 6).toSend).toHaveLength(1);
  });

  it('reports a condition that has cleared', () => {
    // A recovery notice is what makes a silent channel mean "fine" rather than
    // "possibly broken".
    const r = diffAlertState([], new Set(['x', 'y']), new Map(), NOW, 6);
    expect(r.resolved.sort()).toEqual(['x', 'y']);
  });

  it('does not report a still-firing condition as resolved', () => {
    expect(diffAlertState([a], new Set(['x']), new Map(), NOW, 6).resolved).toEqual([]);
  });
});
