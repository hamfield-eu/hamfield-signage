import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SuperadminOrganizationDto } from '@signage/shared';
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Td,
  Th,
} from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { OrganizationLogo } from '../components/OrganizationLogo';
import { PlatformHealth } from '../components/PlatformHealth';
import { formatBytes } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';

export function SuperadminOrgsPage() {
  const { refreshOrgs, switchOrg } = useAuth();
  const navigate = useNavigate();

  const openOrg = (org: SuperadminOrganizationDto) => {
    switchOrg(org.id);
    navigate('/devices');
  };
  const orgs = useApi(() => api.get<SuperadminOrganizationDto[]>('/superadmin/organizations'), []);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<SuperadminOrganizationDto | null>(null);

  const toggleStatus = useAction(async (org: SuperadminOrganizationDto) => {
    const next = org.status === 'active' ? 'disabled' : 'active';
    if (
      next === 'disabled' &&
      !window.confirm(
        `Disable "${org.name}"? Its users can no longer sign in to this organization.`,
      )
    ) {
      return;
    }
    await api.patch(`/superadmin/organizations/${org.id}`, { status: next });
    orgs.reload();
  });

  return (
    <div>
      <PageHeader
        title="Companies"
        subtitle="Platform-level organization management"
        actions={<Button onClick={() => setShowCreate(true)}>New company</Button>}
      />
      {/* Operational state of the platform, above the company list: dependency
          health, fleet counts, backup and retention status, and any emergency
          override that has been left running. */}
      <div className="mb-6">
        <PlatformHealth />
      </div>

      <ErrorNote message={orgs.error ?? toggleStatus.error} />
      {orgs.loading && !orgs.data ? <Spinner /> : null}

      {orgs.data && orgs.data.length === 0 ? (
        <EmptyState title="No companies yet" hint="Create the first company to get started." />
      ) : null}

      {orgs.data && orgs.data.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>Plan</Th>
                <Th>Devices</Th>
                <Th>Users</Th>
                <Th>Media</Th>
                <Th>Storage</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {orgs.data.map((org) => (
                <tr key={org.id}>
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <OrganizationLogo org={org} size={32} className="border border-slate-200" />
                      <div>
                        <div className="font-medium text-slate-900">{org.name}</div>
                        <div className="text-xs text-slate-400">{org.slug}</div>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    {org.status === 'active' ? (
                      <Badge tone="green">active</Badge>
                    ) : (
                      <Badge tone="red">disabled</Badge>
                    )}
                  </Td>
                  <Td>{org.planName ?? '—'}</Td>
                  <Td>
                    {org.deviceCount}
                    {org.maxDevices != null ? ` / ${org.maxDevices}` : ''}
                  </Td>
                  <Td>{org.userCount}</Td>
                  <Td>{org.mediaCount}</Td>
                  <Td>{formatBytes(org.storageUsedBytes)}</Td>
                  <Td>
                    <div className="flex gap-1">
                      <Button variant="ghost" small onClick={() => openOrg(org)}>
                        Open
                      </Button>
                      <Button variant="ghost" small onClick={() => setEditing(org)}>
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        small
                        disabled={toggleStatus.busy}
                        onClick={() => toggleStatus.run(org)}
                      >
                        {org.status === 'active' ? 'Disable' : 'Enable'}
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {showCreate ? (
        <OrgModal
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            orgs.reload();
            void refreshOrgs();
          }}
        />
      ) : null}
      {editing ? (
        <OrgModal
          org={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            orgs.reload();
            void refreshOrgs();
          }}
        />
      ) : null}
    </div>
  );
}

function OrgModal({
  org,
  onClose,
  onSaved,
}: {
  org?: SuperadminOrganizationDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(org?.name ?? '');
  const [status, setStatus] = useState(org?.status ?? 'active');
  const [planName, setPlanName] = useState(org?.planName ?? '');
  const [maxDevices, setMaxDevices] = useState(org?.maxDevices?.toString() ?? '');
  const [maxStorageGb, setMaxStorageGb] = useState(org?.maxStorageGb?.toString() ?? '');

  const submit = useAction(async () => {
    const body = {
      name,
      status,
      planName: planName || null,
      maxDevices: maxDevices ? Number(maxDevices) : null,
      maxStorageGb: maxStorageGb ? Number(maxStorageGb) : null,
    };
    if (org) await api.patch(`/superadmin/organizations/${org.id}`, body);
    else await api.post('/superadmin/organizations', body);
    onSaved();
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.run();
  };

  return (
    <Modal title={org ? `Edit ${org.name}` : 'New company'} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </Select>
        </Field>
        <Field label="Plan name (optional)">
          <Input value={planName} onChange={(e) => setPlanName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Max devices (optional)">
            <Input
              type="number"
              min={0}
              value={maxDevices}
              onChange={(e) => setMaxDevices(e.target.value)}
            />
          </Field>
          <Field label="Max storage GB (optional)">
            <Input
              type="number"
              min={0}
              value={maxStorageGb}
              onChange={(e) => setMaxStorageGb(e.target.value)}
            />
          </Field>
        </div>
        <ErrorNote message={submit.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submit.busy}>
            {submit.busy ? 'Saving…' : org ? 'Save' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
