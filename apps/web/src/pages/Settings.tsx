import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { DeviceDto, DeviceGroupDto } from '@signage/shared';
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Modal,
  PageHeader,
  Spinner,
} from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { NoOrganizationState } from '../components/RequireOrganization';
import { MfaCard } from '../components/MfaCard';
import { useAction, useApi } from '../lib/hooks';

export function SettingsPage() {
  const { user, org, orgId } = useAuth();

  return (
    <div>
      <PageHeader title="Settings" subtitle="Your account, organization, and screen groups" />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Account">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">Name</dt>
              <dd className="font-medium text-slate-800">{user?.name}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Email</dt>
              <dd className="font-medium text-slate-800">{user?.email}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Organization</dt>
              <dd className="font-medium text-slate-800">{org?.name ?? '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Your role</dt>
              <dd>
                <Badge tone="blue">{org?.role ?? '—'}</Badge>
              </dd>
            </div>
          </dl>
          {orgId ? (
            <div className="mt-4">
              <Link
                to="/settings/organization"
                className="text-sm font-medium text-blue-600 hover:underline"
              >
                Organization settings, logo &amp; members →
              </Link>
            </div>
          ) : null}
        </Card>

        {/* Account security, not organization-scoped: a superadmin in system
            context must be able to reach it too. */}
        <MfaCard />

        {/* Screen groups are organization-scoped; without an active org we show
            the no-organization state instead of crashing (the old blank-screen bug). */}
        {orgId ? <ScreenGroupsCard orgId={orgId} /> : <NoOrganizationState what="screen groups" />}
      </div>
    </div>
  );
}

function ScreenGroupsCard({ orgId }: { orgId: string }) {
  const groups = useApi(() => api.get<DeviceGroupDto[]>(`/orgs/${orgId}/device-groups`), [orgId]);
  const [editing, setEditing] = useState<DeviceGroupDto | 'new' | null>(null);

  const remove = useAction(async (group: DeviceGroupDto) => {
    if (!window.confirm(`Delete group "${group.name}"? Schedules targeting it lose this target.`)) {
      return;
    }
    await api.delete(`/orgs/${orgId}/device-groups/${group.id}`);
    groups.reload();
  });

  return (
    <>
      <Card
        title="Screen groups"
        actions={
          <Button small onClick={() => setEditing('new')}>
            New group
          </Button>
        }
      >
        <ErrorNote message={groups.error ?? remove.error} />
        {groups.loading && !groups.data ? <Spinner /> : null}
        {groups.data && groups.data.length === 0 ? (
          <p className="text-sm text-slate-500">
            No groups yet. Groups let schedules and emergency overrides target many screens at once.
          </p>
        ) : null}
        <ul className="divide-y divide-slate-100">
          {(groups.data ?? []).map((group) => (
            <li key={group.id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-800">{group.name}</p>
                <p className="text-xs text-slate-500">
                  {group.deviceCount} screens
                  {group.description ? ` · ${group.description}` : ''}
                </p>
              </div>
              <Button variant="secondary" small onClick={() => setEditing(group)}>
                Edit
              </Button>
              <Button
                variant="ghost"
                small
                onClick={() => remove.run(group)}
                disabled={remove.busy}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      </Card>

      {editing ? (
        <GroupModal
          orgId={orgId}
          group={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            groups.reload();
          }}
        />
      ) : null}
    </>
  );
}

function GroupModal({
  orgId,
  group,
  onClose,
  onSaved,
}: {
  orgId: string;
  group: DeviceGroupDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const devices = useApi(() => api.get<DeviceDto[]>(`/orgs/${orgId}/devices`), [orgId]);
  const detail = useApi(
    () =>
      group
        ? api.get<DeviceGroupDto & { deviceIds: string[] }>(
            `/orgs/${orgId}/device-groups/${group.id}`,
          )
        : Promise.resolve(null),
    [orgId, group?.id],
  );

  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [deviceIds, setDeviceIds] = useState<string[] | null>(group ? null : []);

  const selected = deviceIds ?? detail.data?.deviceIds ?? [];

  const submit = useAction(async () => {
    const body = {
      name,
      description: description || null,
      deviceIds: selected,
    };
    if (group) {
      await api.patch(`/orgs/${orgId}/device-groups/${group.id}`, body);
    } else {
      await api.post(`/orgs/${orgId}/device-groups`, body);
    }
    onSaved();
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.run();
  };

  return (
    <Modal title={group ? `Edit group: ${group.name}` : 'New screen group'} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div>
          <p className="mb-1.5 text-sm font-medium text-slate-700">Screens in this group</p>
          {devices.loading && !devices.data ? <Spinner /> : null}
          {group && detail.loading && !detail.data ? <Spinner /> : null}
          {(devices.data ?? []).length === 0 ? (
            <p className="text-sm text-slate-500">No screens registered yet.</p>
          ) : (
            <ul className="max-h-56 space-y-1.5 overflow-y-auto">
              {(devices.data ?? []).map((d) => (
                <li key={d.id}>
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={selected.includes(d.id)}
                      onChange={() =>
                        setDeviceIds(
                          selected.includes(d.id)
                            ? selected.filter((x) => x !== d.id)
                            : [...selected, d.id],
                        )
                      }
                    />
                    {d.name}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        <ErrorNote message={detail.error ?? submit.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submit.busy}>
            {submit.busy ? 'Saving…' : group ? 'Save group' : 'Create group'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
