import { describe, expect, it } from 'vitest';
import { deriveStatus } from './health';

const ok = { ok: true, latencyMs: 1 };
const bad = { ok: false, error: 'unreachable' };
const all = (over: Record<string, typeof ok | typeof bad> = {}) => ({
  database: ok,
  redis: ok,
  storage: ok,
  workers: ok,
  ...over,
});

/**
 * The severity split is a deliberate policy, not an AND over every dependency:
 * `down` returns 503 and is what a script or an alert acts on, so it is reserved
 * for dependencies without which the API cannot serve requests at all.
 */
describe('deriveStatus', () => {
  it('is ok when everything answers', () => {
    expect(deriveStatus(all())).toBe('ok');
  });

  it('is down without the database or redis', () => {
    // Core request handling and the device WebSocket both stop.
    expect(deriveStatus(all({ database: bad }))).toBe('down');
    expect(deriveStatus(all({ redis: bad }))).toBe('down');
  });

  it('is only degraded without storage or a worker', () => {
    // Uploads and transcoding suffer, but the API still serves manifests and
    // devices keep playing and syncing what already exists. Returning 503 here
    // would tell an operator the platform is offline when it is not.
    expect(deriveStatus(all({ storage: bad }))).toBe('degraded');
    expect(deriveStatus(all({ workers: bad }))).toBe('degraded');
  });

  it('reports the worst status, not the first failure', () => {
    expect(deriveStatus(all({ storage: bad, database: bad }))).toBe('down');
  });

  it('treats a missing check as healthy rather than failing closed', () => {
    // A future check that has not been wired up yet must not make production
    // look down.
    expect(deriveStatus({ database: ok, redis: ok })).toBe('ok');
    expect(deriveStatus({})).toBe('ok');
  });
});
