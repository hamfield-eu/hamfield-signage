import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  DeviceCommandDto,
  DeviceDto,
  DeviceGroupDto,
  DeviceLogDto,
  PlaylistDto,
} from '@signage/shared';
import {
  SHOW_MESSAGE_DEFAULT_SECONDS,
  SHOW_MESSAGE_MAX_LENGTH,
  rotationSwapsAxes,
  suggestPlaybackProfile,
} from '@signage/shared';
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  OnlineDot,
  PageHeader,
  Select,
  Spinner,
  Td,
  Th,
} from '../components/ui';
import { PairingCodeNote, SYNC_STATUS_LABEL } from './Devices';
import { api } from '../lib/api';
import { useOrgId } from '../lib/auth';
import { formatBytes, formatDateTime, formatUptime, timeAgo } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';

const TABS = ['Overview', 'Settings', 'Commands', 'Logs'] as const;
type Tab = (typeof TABS)[number];

const COMMAND_BUTTONS: Array<{ type: string; label: string; danger?: boolean; confirm?: string }> =
  [
    { type: 'refresh_content', label: 'Refresh content' },
    { type: 'take_screenshot', label: 'Take screenshot' },
    { type: 'identify', label: 'Identify screen' },
    { type: 'restart_player', label: 'Restart player' },
    { type: 'health_check', label: 'Health check' },
    { type: 'send_logs', label: 'Send logs' },
    {
      type: 'clear_cache',
      label: 'Clear cache',
      confirm: 'Clear the media cache and re-download everything?',
    },
    {
      type: 'software_update',
      label: 'Software update',
      confirm: 'Run the software update command on the device?',
    },
    { type: 'reboot_device', label: 'Reboot device', danger: true, confirm: 'Reboot this device?' },
  ];

const PROFILE_LABELS: Record<DeviceDto['playbackProfile'], string> = {
  high: 'High — 1080p60 (strong players)',
  standard: 'Standard — 1080p30 (Raspberry Pi 4)',
  light: 'Light — 720p30 (ODROID C4 / weak)',
};

const STATUS_TONE: Record<string, 'green' | 'yellow' | 'red' | 'blue' | 'gray'> = {
  pending: 'gray',
  sent: 'blue',
  acked: 'yellow',
  completed: 'green',
  failed: 'red',
  expired: 'red',
};

export function DeviceDetailPage() {
  const orgId = useOrgId();
  const { deviceId = '' } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('Overview');

  const device = useApi(
    () => api.get<DeviceDto>(`/orgs/${orgId}/devices/${deviceId}`),
    [orgId, deviceId],
    { refreshMs: 10_000 },
  );

  if (device.loading && !device.data) return <Spinner />;
  if (device.error) return <ErrorNote message={device.error} />;
  if (!device.data) return null;
  const d = device.data;

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {d.name} <OnlineDot online={d.online} />
          </span>
        }
        subtitle={d.description ?? undefined}
        actions={
          <Button variant="secondary" onClick={() => navigate('/devices')}>
            Back to screens
          </Button>
        }
      />

      <div className="mb-4 flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
              tab === t
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Overview' ? (
        <OverviewTab orgId={orgId} device={d} onChanged={device.reload} />
      ) : null}
      {tab === 'Settings' ? (
        <SettingsTab orgId={orgId} device={d} onChanged={device.reload} />
      ) : null}
      {tab === 'Commands' ? <CommandsTab orgId={orgId} device={d} /> : null}
      {tab === 'Logs' ? <LogsTab orgId={orgId} deviceId={d.id} /> : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md bg-slate-50 px-3 py-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-0.5 truncate text-sm font-medium text-slate-800">{value}</div>
    </div>
  );
}

function OverviewTab({
  orgId,
  device,
  onChanged,
}: {
  orgId: string;
  device: DeviceDto;
  onChanged: () => void;
}) {
  const m = device.metrics;
  const screenshot = useApi(
    () =>
      api.get<{ url: string | null; createdAt: string | null }>(
        `/orgs/${orgId}/devices/${device.id}/screenshot`,
      ),
    [orgId, device.id],
    { refreshMs: 15_000 },
  );
  const preview = useApi(
    () =>
      api.get<{
        source: string;
        playlistName: string | null;
        mediaAssetName: string | null;
        scheduleName: string | null;
        timezone: string;
      }>(`/orgs/${orgId}/schedules/preview?deviceId=${device.id}`),
    [orgId, device.id],
    { refreshMs: 30_000 },
  );

  const regenerate = useAction(async () => {
    await api.post(`/orgs/${orgId}/devices/${device.id}/regenerate-pairing-code`);
    onChanged();
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        {!device.paired ? (
          <Card title="Pairing">
            <div className="space-y-3">
              <PairingCodeNote device={device} />
              {!device.pairingCode ? (
                <p className="text-sm text-slate-500">No active pairing code.</p>
              ) : null}
              <Button
                variant="secondary"
                onClick={() => regenerate.run()}
                disabled={regenerate.busy}
              >
                Generate new pairing code
              </Button>
              <ErrorNote message={regenerate.error} />
            </div>
          </Card>
        ) : null}

        <Card title="Status">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label="Last seen" value={timeAgo(device.lastSeenAt)} />
            <Stat
              label="Sync status"
              value={
                <Badge
                  tone={
                    device.syncStatus === 'in_sync'
                      ? 'green'
                      : device.syncStatus === 'error' ||
                          device.syncStatus === 'insufficient_storage'
                        ? 'red'
                        : device.syncStatus === 'syncing'
                          ? 'yellow'
                          : 'gray'
                  }
                >
                  {SYNC_STATUS_LABEL[device.syncStatus] ?? device.syncStatus}
                </Badge>
              }
            />
            <Stat label="Last sync" value={timeAgo(device.lastSyncAt)} />
            <Stat label="App version" value={device.appVersion ?? '—'} />
            <Stat label="OS" value={device.osInfo ?? '—'} />
            <Stat label="Arch" value={device.archInfo ?? '—'} />
            <Stat label="Uptime" value={formatUptime(m.uptimeSeconds)} />
            <Stat label="CPU" value={m.cpuPercent != null ? `${m.cpuPercent}%` : '—'} />
            <Stat
              label="Memory"
              value={
                m.memUsedBytes != null && m.memTotalBytes != null
                  ? `${formatBytes(m.memUsedBytes)} / ${formatBytes(m.memTotalBytes)}`
                  : '—'
              }
            />
            <Stat
              label="Disk free"
              value={m.diskFreeBytes != null ? formatBytes(m.diskFreeBytes) : '—'}
            />
            <Stat
              label="Cache"
              value={
                m.cacheBudgetBytes != null
                  ? `${formatBytes(m.cacheUsedBytes)} / ${formatBytes(m.cacheBudgetBytes)}`
                  : formatBytes(m.cacheUsedBytes)
              }
            />
            <Stat
              label="Cached files"
              value={m.cachedFileCount != null ? String(m.cachedFileCount) : '—'}
            />
            <Stat label="Integrity check" value={timeAgo(m.lastIntegrityCheckAt)} />
            <Stat label="IP" value={device.lastIp ?? '—'} />
          </div>
          {device.syncStatus === 'insufficient_storage' ? (
            <div className="mt-3">
              <ErrorNote
                message={
                  m.storageShortfallBytes != null
                    ? `Not enough storage: this screen needs ${formatBytes(
                        m.storageShortfallBytes,
                      )} more space for its current playlist. It is still playing the content it already cached — free space on the device, raise its cache budget, or remove items from the playlist.`
                    : 'Not enough storage for the current playlist. The screen is still playing the content it already cached.'
                }
              />
            </div>
          ) : null}
          {device.lastError ? (
            <div className="mt-3">
              <ErrorNote message={`Device error: ${device.lastError}`} />
            </div>
          ) : null}
        </Card>

        <Card title="Now playing">
          <div className="space-y-1 text-sm text-slate-700">
            <p>
              <span className="text-slate-500">Reported: </span>
              {device.currentPlaylistName ?? device.currentMediaName ?? 'nothing'}
            </p>
            {preview.data ? (
              <p>
                <span className="text-slate-500">Per schedule ({preview.data.timezone}): </span>
                {preview.data.source === 'none'
                  ? 'nothing scheduled'
                  : `${preview.data.playlistName ?? preview.data.mediaAssetName ?? 'unknown'} (${preview.data.source}${preview.data.scheduleName ? `: ${preview.data.scheduleName}` : ''})`}
              </p>
            ) : null}
            <p>
              <span className="text-slate-500">Manifest: </span>
              <code className="text-xs">{device.manifestVersion ?? '—'}</code>
            </p>
          </div>
        </Card>
      </div>

      <Card
        title="Latest screenshot"
        actions={
          screenshot.data?.createdAt ? (
            <span className="text-xs text-slate-400">
              {formatDateTime(screenshot.data.createdAt)}
            </span>
          ) : null
        }
      >
        {screenshot.data?.url ? (
          <img
            src={screenshot.data.url}
            alt="Device screenshot"
            className="w-full rounded-md border border-slate-200"
          />
        ) : (
          <p className="text-sm text-slate-500">
            No screenshot yet. Use “Take screenshot” on the Commands tab.
          </p>
        )}
      </Card>
    </div>
  );
}

/**
 * Schematic of how content maps onto the physical panel: the outer rectangle is
 * the panel in its native scan-out shape; the inner rectangle is the content
 * canvas, rotated by `rotation` to show how it lands on the mounted screen.
 */
function OrientationPreview({
  orientation,
  rotation,
}: {
  orientation: DeviceDto['orientation'];
  rotation: DeviceDto['rotation'];
}) {
  const contentPortrait = orientation === 'portrait';
  // A 90/270° mount swaps the panel's native shape relative to the content.
  const panelPortrait = contentPortrait !== rotationSwapsAxes(rotation);

  const long = 132;
  const short = Math.round((long * 9) / 16);
  const panelW = panelPortrait ? short : long;
  const panelH = panelPortrait ? long : short;
  // The content rect matches the panel footprint once rotated, so before the
  // rotate transform it has the panel's dimensions with axes swapped on 90/270.
  const contentW = rotationSwapsAxes(rotation) ? panelH : panelW;
  const contentH = rotationSwapsAxes(rotation) ? panelW : panelH;

  return (
    <div className="flex items-center gap-4 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div
        className="relative flex flex-shrink-0 items-center justify-center rounded-sm border-2 border-slate-400 bg-white"
        style={{ width: panelW, height: panelH }}
        aria-hidden
      >
        <div
          className="flex items-center justify-center rounded-sm bg-blue-500/85 text-[10px] font-semibold text-white"
          style={{ width: contentW, height: contentH, transform: `rotate(${rotation}deg)` }}
        >
          ▲
        </div>
      </div>
      <div className="text-xs text-slate-600">
        <p className="font-medium text-slate-700">
          {contentPortrait ? 'Portrait' : 'Landscape'} content
          {rotation !== 0 ? `, rotated ${rotation}°` : ''}
        </p>
        <p className="mt-0.5 text-slate-500">
          Physical panel: {panelPortrait ? 'portrait (9:16)' : 'landscape (16:9)'}.{' '}
          {rotation === 0
            ? 'Mounted in its native orientation.'
            : '▲ marks the top of the content as the viewer sees it.'}
        </p>
      </div>
    </div>
  );
}

function SettingsTab({
  orgId,
  device,
  onChanged,
}: {
  orgId: string;
  device: DeviceDto;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const playlists = useApi(() => api.get<PlaylistDto[]>(`/orgs/${orgId}/playlists`), [orgId]);
  const groups = useApi(() => api.get<DeviceGroupDto[]>(`/orgs/${orgId}/device-groups`), [orgId]);

  const [name, setName] = useState(device.name);
  const [description, setDescription] = useState(device.description ?? '');
  const [orientation, setOrientation] = useState(device.orientation);
  const [rotation, setRotation] = useState<DeviceDto['rotation']>(device.rotation);
  const [timezone, setTimezone] = useState(device.timezone);
  const [playbackProfile, setPlaybackProfile] = useState(device.playbackProfile);
  const [defaultPlaylistId, setDefaultPlaylistId] = useState(device.defaultPlaylistId ?? '');
  const [groupIds, setGroupIds] = useState<string[]>(device.groupIds);

  useEffect(() => {
    setName(device.name);
    setDescription(device.description ?? '');
    setOrientation(device.orientation);
    setRotation(device.rotation);
    setTimezone(device.timezone);
    setPlaybackProfile(device.playbackProfile);
    setDefaultPlaylistId(device.defaultPlaylistId ?? '');
    setGroupIds(device.groupIds);
  }, [device]);

  // UI hint derived from reported hardware; the dropdown value still wins.
  const suggestedProfile = suggestPlaybackProfile(
    device.deviceModel ?? device.archInfo ?? device.osInfo,
  );

  const save = useAction(async () => {
    await api.patch(`/orgs/${orgId}/devices/${device.id}`, {
      name,
      description: description || null,
      orientation,
      rotation,
      timezone,
      playbackProfile,
      defaultPlaylistId: defaultPlaylistId || null,
      groupIds,
    });
    onChanged();
  });

  const revoke = useAction(async () => {
    await api.post(`/orgs/${orgId}/devices/${device.id}/revoke-token`);
    onChanged();
  });

  const remove = useAction(async () => {
    await api.delete(`/orgs/${orgId}/devices/${device.id}`);
    navigate('/devices');
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Screen settings">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.run();
          }}
        >
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Content orientation" hint="Shape of the content the audience sees">
              <Select
                value={orientation}
                onChange={(e) => setOrientation(e.target.value as DeviceDto['orientation'])}
              >
                <option value="landscape">Landscape (16:9)</option>
                <option value="portrait">Portrait (9:16)</option>
              </Select>
            </Field>
            <Field label="Rotation" hint="Compensates for physical mounting">
              <Select
                value={String(rotation)}
                onChange={(e) => setRotation(Number(e.target.value) as DeviceDto['rotation'])}
              >
                <option value="0">0°</option>
                <option value="90">90° clockwise</option>
                <option value="180">180°</option>
                <option value="270">270° clockwise</option>
              </Select>
            </Field>
          </div>
          <OrientationPreview orientation={orientation} rotation={rotation} />
          {rotation !== 0 ? (
            <p className="text-xs text-slate-500">
              The player rotates its output by {rotation}° in software — use this when the panel is
              physically mounted turned (e.g. a 16:9 screen rotated to portrait). Native 9:16 panels
              need 0°.
            </p>
          ) : null}
          <Field
            label="Video quality tier"
            hint={`Matches the file served to this screen to its hardware. Suggested: ${PROFILE_LABELS[suggestedProfile]}`}
          >
            <Select
              value={playbackProfile}
              onChange={(e) => setPlaybackProfile(e.target.value as DeviceDto['playbackProfile'])}
            >
              {(Object.keys(PROFILE_LABELS) as DeviceDto['playbackProfile'][]).map((p) => (
                <option key={p} value={p}>
                  {PROFILE_LABELS[p]}
                  {p === suggestedProfile ? ' (suggested)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          {playbackProfile !== device.playbackProfile ? (
            <p className="text-xs text-slate-500">
              The new tier is encoded on the next upload. To apply it to existing media, re-run the
              reprocess-media CLI.
            </p>
          ) : null}
          <Field label="Timezone">
            <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} required />
          </Field>
          <Field label="Default playlist" hint="Played when no schedule is active">
            <Select
              value={defaultPlaylistId}
              onChange={(e) => setDefaultPlaylistId(e.target.value)}
            >
              <option value="">None</option>
              {(playlists.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          {(groups.data ?? []).length > 0 ? (
            <Field label="Groups">
              <div className="space-y-1">
                {(groups.data ?? []).map((group) => (
                  <label key={group.id} className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={groupIds.includes(group.id)}
                      onChange={(e) =>
                        setGroupIds((ids) =>
                          e.target.checked
                            ? [...ids, group.id]
                            : ids.filter((id) => id !== group.id),
                        )
                      }
                    />
                    {group.name}
                  </label>
                ))}
              </div>
            </Field>
          ) : null}
          <ErrorNote message={save.error} />
          <Button type="submit" disabled={save.busy}>
            {save.busy ? 'Saving…' : 'Save settings'}
          </Button>
        </form>
      </Card>

      <Card title="Danger zone">
        <div className="space-y-4 text-sm">
          <div>
            <p className="mb-2 text-slate-600">
              Revoke the device token. The device must be re-paired before it can connect again.
            </p>
            <Button
              variant="secondary"
              disabled={revoke.busy}
              onClick={() => {
                if (window.confirm('Revoke all tokens for this device?')) revoke.run();
              }}
            >
              Revoke device token
            </Button>
            <ErrorNote message={revoke.error} />
          </div>
          <div className="border-t border-slate-100 pt-4">
            <p className="mb-2 text-slate-600">
              Delete this screen. Tokens are revoked and the device is removed from all playlists
              and schedules.
            </p>
            <Button
              variant="danger"
              disabled={remove.busy}
              onClick={() => {
                if (window.confirm(`Delete "${device.name}"? This cannot be undone.`)) remove.run();
              }}
            >
              Delete screen
            </Button>
            <ErrorNote message={remove.error} />
          </div>
        </div>
      </Card>
    </div>
  );
}

/**
 * Puts operator text on the screen, the same full-screen overlay `identify`
 * uses. It is a form rather than another entry in COMMAND_BUTTONS because
 * every button in that grid is a one-click action, and this one needs to be
 * composed first — sending the wrong text to a screen in a public space is
 * not an undoable action.
 */
function ShowMessageCard({
  busy,
  onSend,
}: {
  busy: boolean;
  onSend: (payload: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState('');
  const [durationSeconds, setDurationSeconds] = useState(SHOW_MESSAGE_DEFAULT_SECONDS);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend({ text: trimmed, durationSeconds });
    setText('');
  };

  const remaining = SHOW_MESSAGE_MAX_LENGTH - text.length;

  return (
    <Card title="Show a message on screen">
      <form onSubmit={onSubmit} className="space-y-3">
        <Field label="Message">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, SHOW_MESSAGE_MAX_LENGTH))}
            rows={2}
            maxLength={SHOW_MESSAGE_MAX_LENGTH}
            placeholder="Closing at 4pm today"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </Field>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-40">
            <Field label="Show for">
              <Select
                value={durationSeconds}
                onChange={(e) => setDurationSeconds(Number(e.target.value))}
              >
                {[10, 30, 60, 120, 300].map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {seconds < 60 ? `${seconds} seconds` : `${seconds / 60} minutes`}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button type="submit" small disabled={busy || text.trim().length === 0}>
            Show on screen
          </Button>
          <span className="text-xs text-slate-400">
            {remaining} characters left · covers the playlist while shown
          </span>
        </div>
      </form>
    </Card>
  );
}

function CommandsTab({ orgId, device }: { orgId: string; device: DeviceDto }) {
  const commands = useApi(
    () => api.get<DeviceCommandDto[]>(`/orgs/${orgId}/devices/${device.id}/commands`),
    [orgId, device.id],
    { refreshMs: 5_000 },
  );

  const issue = useAction(async (type: string, payload: Record<string, unknown> = {}) => {
    await api.post(`/orgs/${orgId}/devices/${device.id}/commands`, { type, payload });
    commands.reload();
  });

  return (
    <div className="space-y-4">
      <Card title="Send a command">
        <div className="flex flex-wrap gap-2">
          {COMMAND_BUTTONS.map((cmd) => (
            <Button
              key={cmd.type}
              variant={cmd.danger ? 'danger' : 'secondary'}
              small
              disabled={issue.busy}
              onClick={() => {
                if (cmd.confirm && !window.confirm(cmd.confirm)) return;
                issue.run(cmd.type);
              }}
            >
              {cmd.label}
            </Button>
          ))}
        </div>
        <div className="mt-2">
          <ErrorNote message={issue.error} />
        </div>
      </Card>

      <ShowMessageCard busy={issue.busy} onSend={(payload) => issue.run('show_message', payload)} />

      <Card
        title="Recent commands"
        actions={
          <Button variant="ghost" small onClick={commands.reload}>
            Refresh
          </Button>
        }
      >
        {commands.loading && !commands.data ? <Spinner /> : null}
        {commands.data && commands.data.length === 0 ? (
          <p className="text-sm text-slate-500">No commands sent yet.</p>
        ) : null}
        {commands.data && commands.data.length > 0 ? (
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <Th>Command</Th>
                <Th>Status</Th>
                <Th>Created</Th>
                <Th>Completed</Th>
                <Th>Result</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {commands.data.map((cmd) => (
                <tr key={cmd.id}>
                  <Td>
                    <code className="text-xs">{cmd.type}</code>
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[cmd.status] ?? 'gray'}>{cmd.status}</Badge>
                  </Td>
                  <Td>{timeAgo(cmd.createdAt)}</Td>
                  <Td>{cmd.completedAt ? timeAgo(cmd.completedAt) : '—'}</Td>
                  <Td className="max-w-xs">
                    {cmd.result ? (
                      <code className="block truncate text-xs text-slate-500">
                        {JSON.stringify(cmd.result)}
                      </code>
                    ) : (
                      '—'
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>
    </div>
  );
}

function LogsTab({ orgId, deviceId }: { orgId: string; deviceId: string }) {
  const logs = useApi(
    () => api.get<DeviceLogDto[]>(`/orgs/${orgId}/devices/${deviceId}/logs?limit=200`),
    [orgId, deviceId],
    { refreshMs: 10_000 },
  );

  const LEVEL_TONE: Record<string, 'red' | 'yellow' | 'blue' | 'gray'> = {
    error: 'red',
    warn: 'yellow',
    info: 'blue',
    debug: 'gray',
  };

  return (
    <Card
      title="Device logs"
      actions={
        <Button variant="ghost" small onClick={logs.reload}>
          Refresh
        </Button>
      }
    >
      {logs.loading && !logs.data ? <Spinner /> : null}
      {logs.error ? <ErrorNote message={logs.error} /> : null}
      {logs.data && logs.data.length === 0 ? (
        <p className="text-sm text-slate-500">No logs received from this device yet.</p>
      ) : null}
      {logs.data && logs.data.length > 0 ? (
        <div className="max-h-[32rem] overflow-y-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Level</Th>
                <Th>Message</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {logs.data.map((log) => (
                <tr key={log.id}>
                  <Td className="whitespace-nowrap">{formatDateTime(log.loggedAt)}</Td>
                  <Td>
                    <Badge tone={LEVEL_TONE[log.level] ?? 'gray'}>{log.level}</Badge>
                  </Td>
                  <Td>
                    <span className="break-all font-mono text-xs">{log.message}</span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}
