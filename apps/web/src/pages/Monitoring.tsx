import { useNavigate } from 'react-router-dom';
import type { DeviceDto } from '@signage/shared';
import {
  Badge,
  Card,
  EmptyState,
  ErrorNote,
  OnlineDot,
  PageHeader,
  Spinner,
  TableCard,
  Td,
  Th,
} from '../components/ui';
import { api } from '../lib/api';
import { useOrgId } from '../lib/auth';
import { formatBytes, timeAgo } from '../lib/format';
import { useApi } from '../lib/hooks';
import { SYNC_STATUS_LABEL } from './Devices';

const SYNC_TONE: Record<string, 'green' | 'yellow' | 'red' | 'gray'> = {
  in_sync: 'green',
  syncing: 'yellow',
  never_synced: 'gray',
  error: 'red',
  insufficient_storage: 'red',
};

function StatCard({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <Card>
      <p className="text-sm text-slate-500">{label}</p>
      <p className={`mt-1 text-3xl font-semibold ${tone ?? 'text-slate-900'}`}>{value}</p>
    </Card>
  );
}

export function MonitoringPage() {
  const orgId = useOrgId();
  const navigate = useNavigate();
  const devices = useApi(() => api.get<DeviceDto[]>(`/orgs/${orgId}/devices`), [orgId], {
    refreshMs: 10_000,
  });

  const list = devices.data ?? [];
  const online = list.filter((d) => d.online);
  const offline = list.filter((d) => !d.online && d.paired);
  const unpaired = list.filter((d) => !d.paired);
  const withIssues = list.filter(
    (d) => d.lastError || d.syncStatus === 'error' || d.syncStatus === 'insufficient_storage',
  );

  return (
    <div>
      <PageHeader title="Monitoring" subtitle="Live fleet health — refreshes every 10 seconds" />

      <ErrorNote message={devices.error} />
      {devices.loading && !devices.data ? <Spinner /> : null}

      {devices.data ? (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <StatCard label="Screens" value={list.length} />
            <StatCard label="Online" value={online.length} tone="text-green-600" />
            <StatCard
              label="Offline"
              value={offline.length}
              tone={offline.length > 0 ? 'text-red-600' : 'text-slate-900'}
            />
            <StatCard
              label="Not paired"
              value={unpaired.length}
              tone={unpaired.length > 0 ? 'text-amber-600' : 'text-slate-900'}
            />
            <StatCard
              label="With issues"
              value={withIssues.length}
              tone={withIssues.length > 0 ? 'text-red-600' : 'text-slate-900'}
            />
          </div>

          {list.length === 0 ? (
            <EmptyState
              title="No screens yet"
              hint="Add a screen on the Screens page to start monitoring."
            />
          ) : (
            <TableCard>
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <Th>Screen</Th>
                    <Th>Now playing</Th>
                    <Th>Sync</Th>
                    <Th>Last seen</Th>
                    <Th>Version</Th>
                    <Th>CPU</Th>
                    <Th>Memory</Th>
                    <Th>Disk free</Th>
                    <Th>Issue</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {list.map((device) => {
                    const m = device.metrics;
                    return (
                      <tr
                        key={device.id}
                        className="cursor-pointer hover:bg-slate-50"
                        onClick={() => navigate(`/devices/${device.id}`)}
                      >
                        <Td>
                          <div className="flex items-center gap-2">
                            <OnlineDot online={device.online} />
                            <span className="font-medium text-slate-900">{device.name}</span>
                            {!device.paired ? <Badge tone="yellow">not paired</Badge> : null}
                          </div>
                        </Td>
                        <Td>
                          {device.currentPlaylistName ?? device.currentMediaName ?? (
                            <span className="text-slate-400">—</span>
                          )}
                        </Td>
                        <Td>
                          <Badge tone={SYNC_TONE[device.syncStatus] ?? 'gray'}>
                            {SYNC_STATUS_LABEL[device.syncStatus] ?? device.syncStatus}
                          </Badge>
                        </Td>
                        <Td>{timeAgo(device.lastSeenAt)}</Td>
                        <Td>{device.appVersion ?? '—'}</Td>
                        <Td>{m.cpuPercent != null ? `${m.cpuPercent}%` : '—'}</Td>
                        <Td>
                          {m.memUsedBytes != null && m.memTotalBytes != null
                            ? `${formatBytes(m.memUsedBytes)} / ${formatBytes(m.memTotalBytes)}`
                            : '—'}
                        </Td>
                        <Td>{m.diskFreeBytes != null ? formatBytes(m.diskFreeBytes) : '—'}</Td>
                        <Td>
                          {device.lastError ? (
                            <span
                              className="block max-w-[16rem] truncate text-xs text-red-600"
                              title={device.lastError}
                            >
                              {device.lastError}
                            </span>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableCard>
          )}
        </>
      ) : null}
    </div>
  );
}
