import type { ReactNode } from 'react';
import { Badge, Card, ErrorNote, Spinner } from './ui';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useApi } from '../lib/hooks';

interface Check {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  count?: number;
}

interface PlatformHealthDto {
  dependencies: { status: 'ok' | 'degraded' | 'down'; checks: Record<string, Check>; time: string };
  fleet: { total: number; online: number; offline: number; syncError: number };
  media: { pending: number; processing: number; failed: number };
  activeOverrides: Array<{
    id: string;
    name: string;
    organizationName: string;
    hoursActive: number;
  }>;
  queue: { waiting: number; active: number } | null;
  lastRetentionRun: { at: string; dryRun: boolean; totalDeleted: number } | null;
  lastBackupAt: string | null;
}

const STATUS_TONE = { ok: 'green', degraded: 'yellow', down: 'red' } as const;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-sm text-slate-500">{label}</span>
      <span className="text-sm font-medium text-slate-900">{children}</span>
    </div>
  );
}

/**
 * Superadmin operational summary.
 *
 * Reads /superadmin/platform-health, which is the same dependency report as
 * /health/ready plus the fleet numbers the worker's alert conditions evaluate — so
 * this panel and the ntfy alerts cannot disagree about the state of the platform.
 *
 * Refreshed every 30s rather than the 10s used elsewhere: each call runs a real
 * HeadBucket against object storage, and there is no reason to bill for that four
 * times a minute per open tab.
 */
export function PlatformHealth() {
  const health = useApi(() => api.get<PlatformHealthDto>('/superadmin/platform-health'), [], {
    refreshMs: 30_000,
  });

  if (health.error) return <ErrorNote message={health.error} />;
  if (!health.data) return <Spinner label="Loading platform health" />;

  const h = health.data;
  const backupStale =
    !h.lastBackupAt || Date.now() - new Date(h.lastBackupAt).getTime() > 36 * 3_600_000;

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card title="Dependencies">
        <div className="mb-2">
          <Badge tone={STATUS_TONE[h.dependencies.status]}>{h.dependencies.status}</Badge>
        </div>
        {Object.entries(h.dependencies.checks).map(([name, c]) => (
          <Row key={name} label={name}>
            {c.ok ? (
              <span className="text-green-700">
                ok{c.latencyMs !== undefined ? ` · ${c.latencyMs}ms` : ''}
                {c.count !== undefined ? ` · ${c.count}` : ''}
              </span>
            ) : (
              <span className="text-red-700">{c.error ?? 'failed'}</span>
            )}
          </Row>
        ))}
      </Card>

      <Card title="Fleet">
        <Row label="Screens">{h.fleet.total}</Row>
        <Row label="Online">
          <span className={h.fleet.online === h.fleet.total ? 'text-green-700' : ''}>
            {h.fleet.online}
          </span>
        </Row>
        <Row label="Offline">
          <span className={h.fleet.offline > 0 ? 'text-red-700' : ''}>{h.fleet.offline}</span>
        </Row>
        <Row label="Sync errors">
          <span className={h.fleet.syncError > 0 ? 'text-red-700' : ''}>{h.fleet.syncError}</span>
        </Row>
        <Row label="Media failed">
          <span className={h.media.failed > 0 ? 'text-red-700' : ''}>{h.media.failed}</span>
        </Row>
        <Row label="Media processing">{h.media.pending + h.media.processing}</Row>
        <Row label="Queue">{h.queue ? `${h.queue.waiting} waiting / ${h.queue.active} active` : 'unavailable'}</Row>
      </Card>

      <Card title="Operations">
        <Row label="Last backup">
          <span className={backupStale ? 'text-red-700' : 'text-green-700'}>
            {h.lastBackupAt ? timeAgo(h.lastBackupAt) : 'never recorded'}
          </span>
        </Row>
        <Row label="Last retention run">
          {h.lastRetentionRun ? (
            <>
              {timeAgo(h.lastRetentionRun.at)}{' '}
              {h.lastRetentionRun.dryRun ? (
                <Badge tone="gray">dry run</Badge>
              ) : (
                <Badge tone="blue">{h.lastRetentionRun.totalDeleted} deleted</Badge>
              )}
            </>
          ) : (
            'never'
          )}
        </Row>
        {h.activeOverrides.length === 0 ? (
          <Row label="Emergency overrides">
            <span className="text-green-700">none active</span>
          </Row>
        ) : (
          <div className="mt-2 space-y-1">
            <p className="text-sm text-slate-500">Emergency overrides active</p>
            {h.activeOverrides.map((o) => (
              <div key={o.id} className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm text-slate-900">
                  {o.organizationName} — {o.name}
                </span>
                {/* An override has no auto-expiry, so elapsed time is the number
                    that matters: a forgotten one blanks screens indefinitely. */}
                <Badge tone={o.hoursActive >= 4 ? 'red' : 'yellow'}>
                  {o.hoursActive.toFixed(1)}h
                </Badge>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
