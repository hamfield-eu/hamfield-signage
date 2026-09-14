import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DeviceDto, ScheduleDto } from '@signage/shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  PageHeader,
  Select,
  Spinner,
  TableCard,
  Td,
  Th,
} from '../components/ui';
import { api } from '../lib/api';
import { useOrgId } from '../lib/auth';
import { useApi } from '../lib/hooks';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function describeWindow(schedule: ScheduleDto): string {
  const parts: string[] = [];
  if (schedule.startDate || schedule.endDate) {
    parts.push(`${schedule.startDate ?? '…'} → ${schedule.endDate ?? '…'}`);
  }
  if (schedule.daysOfWeek.length > 0 && schedule.daysOfWeek.length < 7) {
    parts.push(schedule.daysOfWeek.map((d) => DAY_LABELS[d - 1]).join(', '));
  }
  if (schedule.startTime && schedule.endTime) {
    parts.push(`${schedule.startTime}–${schedule.endTime}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Always';
}

export function SchedulesPage() {
  const orgId = useOrgId();
  const navigate = useNavigate();
  const schedules = useApi(() => api.get<ScheduleDto[]>(`/orgs/${orgId}/schedules`), [orgId]);

  return (
    <div>
      <PageHeader
        title="Schedules"
        subtitle="When playlists run on which screens — highest priority wins"
        actions={<Button onClick={() => navigate('/schedules/new')}>New schedule</Button>}
      />

      <ErrorNote message={schedules.error} />
      {schedules.loading ? <Spinner /> : null}

      {schedules.data && schedules.data.length === 0 ? (
        <EmptyState
          title="No schedules yet"
          hint="Screens without a schedule play their default playlist."
        />
      ) : null}

      {schedules.data && schedules.data.length > 0 ? (
        <TableCard>
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <Th>Name</Th>
                <Th>Playlist</Th>
                <Th>Window</Th>
                <Th>Priority</Th>
                <Th>Targets</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {schedules.data
                .slice()
                .sort((a, b) => b.priority - a.priority)
                .map((schedule) => (
                  <tr
                    key={schedule.id}
                    className="cursor-pointer hover:bg-slate-50"
                    onClick={() => navigate(`/schedules/${schedule.id}`)}
                  >
                    <Td>
                      <span className="font-medium text-slate-900">{schedule.name}</span>
                    </Td>
                    <Td>{schedule.playlistName ?? schedule.playlistId}</Td>
                    <Td>
                      <span className="text-xs">{describeWindow(schedule)}</span>
                      {schedule.timezone ? (
                        <span className="block text-xs text-slate-400">{schedule.timezone}</span>
                      ) : null}
                    </Td>
                    <Td>{schedule.priority}</Td>
                    <Td>
                      {schedule.deviceIds.length + schedule.groupIds.length === 0 ? (
                        <span className="text-slate-400">none</span>
                      ) : (
                        <>
                          {schedule.deviceIds.length > 0
                            ? `${schedule.deviceIds.length} screens`
                            : ''}
                          {schedule.deviceIds.length > 0 && schedule.groupIds.length > 0
                            ? ', '
                            : ''}
                          {schedule.groupIds.length > 0 ? `${schedule.groupIds.length} groups` : ''}
                        </>
                      )}
                    </Td>
                    <Td>
                      {schedule.enabled ? (
                        <Badge tone="green">enabled</Badge>
                      ) : (
                        <Badge>disabled</Badge>
                      )}
                    </Td>
                  </tr>
                ))}
            </tbody>
          </table>
        </TableCard>
      ) : null}

      <div className="mt-6">
        <SchedulePreview orgId={orgId} />
      </div>
    </div>
  );
}

function SchedulePreview({ orgId }: { orgId: string }) {
  const devices = useApi(() => api.get<DeviceDto[]>(`/orgs/${orgId}/devices`), [orgId]);
  const [deviceId, setDeviceId] = useState('');
  const [at, setAt] = useState('');

  const preview = useApi(async () => {
    if (!deviceId) return null;
    const query = new URLSearchParams({ deviceId });
    if (at) query.set('at', new Date(at).toISOString());
    return api.get<{
      source: string;
      playlistName: string | null;
      mediaAssetName: string | null;
      scheduleName: string | null;
      evaluatedAt: string;
      timezone: string;
    }>(`/orgs/${orgId}/schedules/preview?${query.toString()}`);
  }, [orgId, deviceId, at]);

  return (
    <Card title="Preview: what plays when?">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-64">
          <label className="mb-1 block text-sm font-medium text-slate-700">Screen</label>
          <Select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            <option value="">Select a screen…</option>
            {(devices.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-full sm:w-64">
          <label className="mb-1 block text-sm font-medium text-slate-700">At (optional)</label>
          <input
            type="datetime-local"
            value={at}
            onChange={(e) => setAt(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm"
          />
        </div>
      </div>
      {preview.error ? (
        <div className="mt-3">
          <ErrorNote message={preview.error} />
        </div>
      ) : null}
      {preview.data ? (
        <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm text-slate-700">
          <p>
            Source:{' '}
            <Badge
              tone={
                preview.data.source === 'emergency'
                  ? 'red'
                  : preview.data.source === 'none'
                    ? 'gray'
                    : 'blue'
              }
            >
              {preview.data.source}
            </Badge>
          </p>
          <p className="mt-1.5">
            Content:{' '}
            <strong>{preview.data.playlistName ?? preview.data.mediaAssetName ?? 'nothing'}</strong>
            {preview.data.scheduleName ? ` via "${preview.data.scheduleName}"` : ''}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Evaluated {new Date(preview.data.evaluatedAt).toLocaleString()} in{' '}
            {preview.data.timezone}
          </p>
        </div>
      ) : null}
    </Card>
  );
}
