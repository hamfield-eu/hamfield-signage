import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DeviceDto, DeviceGroupDto } from '@signage/shared';
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Modal,
  OnlineDot,
  PageHeader,
  Select,
  Spinner,
  TableCard,
  Td,
  Th,
} from '../components/ui';
import { api } from '../lib/api';
import { useOrgId } from '../lib/auth';
import { timeAgo } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';

const ORIENTATIONS = [
  ['landscape', 'Landscape'],
  ['portrait', 'Portrait'],
] as const;

const SYNC_TONE: Record<string, 'green' | 'yellow' | 'red' | 'gray'> = {
  in_sync: 'green',
  syncing: 'yellow',
  never_synced: 'gray',
  error: 'red',
  insufficient_storage: 'red',
};

/** Raw enum values are not operator-facing text. */
export const SYNC_STATUS_LABEL: Record<string, string> = {
  in_sync: 'in sync',
  syncing: 'syncing',
  never_synced: 'never synced',
  error: 'error',
  insufficient_storage: 'storage full',
};

export function PairingCodeNote({ device }: { device: DeviceDto }) {
  if (!device.pairingCode) return null;
  return (
    <div className="rounded-md border border-blue-200 bg-blue-50 p-4">
      <p className="text-sm text-blue-900">
        Pairing code for <strong>{device.name}</strong> (enter it as{' '}
        <code className="rounded bg-blue-100 px-1">SIGNAGE_PAIRING_CODE</code> on the device):
      </p>
      <p className="mt-2 font-mono text-3xl font-bold tracking-widest text-blue-700">
        {device.pairingCode}
      </p>
      {device.pairingCodeExpiresAt ? (
        <p className="mt-1 text-xs text-blue-700">
          Expires {new Date(device.pairingCodeExpiresAt).toLocaleString()}
        </p>
      ) : null}
    </div>
  );
}

export function DevicesPage() {
  const orgId = useOrgId();
  const navigate = useNavigate();
  const devices = useApi(() => api.get<DeviceDto[]>(`/orgs/${orgId}/devices`), [orgId], {
    refreshMs: 15_000,
  });
  const groups = useApi(() => api.get<DeviceGroupDto[]>(`/orgs/${orgId}/device-groups`), [orgId]);

  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState<DeviceDto | null>(null);

  return (
    <div>
      <PageHeader
        title="Screens"
        subtitle="All signage devices in this organization"
        actions={<Button onClick={() => setShowCreate(true)}>Add screen</Button>}
      />

      {devices.error ? <ErrorNote message={devices.error} /> : null}
      {devices.loading ? <Spinner /> : null}

      {devices.data && devices.data.length === 0 ? (
        <EmptyState
          title="No screens yet"
          hint="Add a screen to get a pairing code, then configure the device agent with it."
        />
      ) : null}

      {devices.data && devices.data.length > 0 ? (
        <TableCard>
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>Orientation</Th>
                <Th>Now playing</Th>
                <Th>Sync</Th>
                <Th>Last seen</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {devices.data.map((device) => (
                <tr
                  key={device.id}
                  onClick={() => navigate(`/devices/${device.id}`)}
                  className="cursor-pointer hover:bg-slate-50"
                >
                  <Td>
                    <div className="font-medium text-slate-900">{device.name}</div>
                    {!device.paired ? (
                      <span className="text-xs text-amber-600">Awaiting pairing</span>
                    ) : null}
                  </Td>
                  <Td>
                    <OnlineDot online={device.online} />
                  </Td>
                  <Td>
                    {ORIENTATIONS.find(([v]) => v === device.orientation)?.[1]}
                    {device.rotation ? (
                      <span className="text-slate-400"> · {device.rotation}°</span>
                    ) : null}
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
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      ) : null}

      {showCreate ? (
        <CreateDeviceModal
          orgId={orgId}
          groups={groups.data ?? []}
          onClose={() => setShowCreate(false)}
          onCreated={(device) => {
            setShowCreate(false);
            setCreated(device);
            devices.reload();
          }}
        />
      ) : null}

      {created ? (
        <Modal title="Screen created" onClose={() => setCreated(null)}>
          <div className="space-y-4">
            <PairingCodeNote device={created} />
            <Button className="w-full" onClick={() => navigate(`/devices/${created.id}`)}>
              Open device page
            </Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function CreateDeviceModal({
  orgId,
  groups,
  onClose,
  onCreated,
}: {
  orgId: string;
  groups: DeviceGroupDto[];
  onClose: () => void;
  onCreated: (device: DeviceDto) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [orientation, setOrientation] = useState('landscape');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [groupIds, setGroupIds] = useState<string[]>([]);

  const submit = useAction(async () => {
    const device = await api.post<DeviceDto>(`/orgs/${orgId}/devices`, {
      name,
      description: description || undefined,
      orientation,
      timezone,
      groupIds,
    });
    onCreated(device);
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.run();
  };

  return (
    <Modal title="Add screen" onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Orientation">
          <Select value={orientation} onChange={(e) => setOrientation(e.target.value)}>
            {ORIENTATIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Timezone" hint="IANA zone, e.g. Europe/Amsterdam">
          <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} required />
        </Field>
        {groups.length > 0 ? (
          <Field label="Groups">
            <div className="space-y-1">
              {groups.map((group) => (
                <label key={group.id} className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={groupIds.includes(group.id)}
                    onChange={(e) =>
                      setGroupIds((ids) =>
                        e.target.checked ? [...ids, group.id] : ids.filter((id) => id !== group.id),
                      )
                    }
                  />
                  {group.name}
                </label>
              ))}
            </div>
          </Field>
        ) : null}
        <ErrorNote message={submit.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submit.busy}>
            {submit.busy ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
