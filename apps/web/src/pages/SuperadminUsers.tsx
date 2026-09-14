import { useState, type FormEvent } from 'react';
import type { OrgRole, SuperadminOrganizationDto, SuperadminUserDto } from '@signage/shared';
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
  TableCard,
  Td,
  Th,
} from '../components/ui';
import { api } from '../lib/api';
import { useAction, useApi } from '../lib/hooks';

export function SuperadminUsersPage() {
  const users = useApi(() => api.get<SuperadminUserDto[]>('/superadmin/users'), []);
  const orgs = useApi(() => api.get<SuperadminOrganizationDto[]>('/superadmin/organizations'), []);
  const [showCreate, setShowCreate] = useState(false);
  const [resetting, setResetting] = useState<SuperadminUserDto | null>(null);
  const [assigning, setAssigning] = useState<SuperadminUserDto | null>(null);

  const toggleDisabled = useAction(async (user: SuperadminUserDto) => {
    const disable = !user.disabledAt;
    if (disable && !window.confirm(`Disable "${user.email}"? They can no longer sign in.`)) return;
    await api.patch(`/superadmin/users/${user.id}`, { disabled: disable });
    users.reload();
  });

  const removeMembership = useAction(
    async (user: SuperadminUserDto, membershipId: string, orgId: string) => {
      if (!window.confirm(`Remove ${user.email} from this company?`)) return;
      await api.delete(`/superadmin/organizations/${orgId}/members/${membershipId}`);
      users.reload();
    },
  );

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle="Platform-level account management"
        actions={<Button onClick={() => setShowCreate(true)}>New user</Button>}
      />
      <ErrorNote message={users.error ?? toggleDisabled.error ?? removeMembership.error} />
      {users.loading && !users.data ? <Spinner /> : null}

      {users.data && users.data.length === 0 ? <EmptyState title="No users" /> : null}

      {users.data && users.data.length > 0 ? (
        <TableCard>
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <Th>User</Th>
                <Th>Role</Th>
                <Th>Status</Th>
                <Th>Companies</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.data.map((user) => (
                <tr key={user.id}>
                  <Td>
                    <div className="font-medium text-slate-900">{user.name}</div>
                    <div className="text-xs text-slate-400">{user.email}</div>
                  </Td>
                  <Td>
                    {user.globalRole === 'superadmin' ? (
                      <Badge tone="blue">superadmin</Badge>
                    ) : (
                      <Badge>user</Badge>
                    )}
                  </Td>
                  <Td>
                    {user.disabledAt ? (
                      <Badge tone="red">disabled</Badge>
                    ) : user.mustChangePassword ? (
                      <Badge tone="yellow">temp password</Badge>
                    ) : (
                      <Badge tone="green">active</Badge>
                    )}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {user.memberships.map((m) => (
                        <span
                          key={m.membershipId}
                          className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
                        >
                          {m.organizationName} · {m.role}
                          <button
                            className="text-slate-400 hover:text-red-600"
                            title="Remove from company"
                            onClick={() =>
                              removeMembership.run(user, m.membershipId, m.organizationId)
                            }
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                      {user.memberships.length === 0 ? (
                        <span className="text-xs text-slate-400">none</span>
                      ) : null}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex gap-1">
                      <Button variant="ghost" small onClick={() => setAssigning(user)}>
                        Assign
                      </Button>
                      <Button variant="ghost" small onClick={() => setResetting(user)}>
                        Reset password
                      </Button>
                      {user.globalRole !== 'superadmin' ? (
                        <Button
                          variant="ghost"
                          small
                          disabled={toggleDisabled.busy}
                          onClick={() => toggleDisabled.run(user)}
                        >
                          {user.disabledAt ? 'Enable' : 'Disable'}
                        </Button>
                      ) : null}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      ) : null}

      {showCreate ? (
        <CreateUserModal
          orgs={orgs.data ?? []}
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            users.reload();
          }}
        />
      ) : null}
      {resetting ? (
        <ResetPasswordModal
          user={resetting}
          onClose={() => setResetting(null)}
          onSaved={() => {
            setResetting(null);
            users.reload();
          }}
        />
      ) : null}
      {assigning ? (
        <AssignModal
          user={assigning}
          orgs={orgs.data ?? []}
          onClose={() => setAssigning(null)}
          onSaved={() => {
            setAssigning(null);
            users.reload();
          }}
        />
      ) : null}
    </div>
  );
}

const ROLE_OPTIONS: OrgRole[] = ['owner', 'admin', 'editor', 'viewer'];

function CreateUserModal({
  orgs,
  onClose,
  onSaved,
}: {
  orgs: SuperadminOrganizationDto[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [role, setRole] = useState<OrgRole>('editor');

  const submit = useAction(async () => {
    await api.post('/superadmin/users', {
      name,
      email,
      password,
      mustChangePassword: true,
      memberships: organizationId ? [{ organizationId, role }] : [],
    });
    onSaved();
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.run();
  };

  return (
    <Modal title="New user" onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field
          label="Temporary password"
          hint="The user must change it on first login. Share it through a secure channel."
        >
          <Input
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Company (optional)">
            <Select value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}>
              <option value="">No company</option>
              {orgs.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Role">
            <Select
              value={role}
              onChange={(e) => setRole(e.target.value as OrgRole)}
              disabled={!organizationId}
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <ErrorNote message={submit.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submit.busy}>
            {submit.busy ? 'Creating…' : 'Create user'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({
  user,
  onClose,
  onSaved,
}: {
  user: SuperadminUserDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [password, setPassword] = useState('');

  const submit = useAction(async () => {
    await api.post(`/superadmin/users/${user.id}/reset-password`, {
      password,
      mustChangePassword: true,
    });
    onSaved();
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.run();
  };

  return (
    <Modal title={`Reset password for ${user.email}`} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field
          label="New temporary password"
          hint="The user must change it on first login. Share it through a secure channel."
        >
          <Input
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
            autoFocus
          />
        </Field>
        <ErrorNote message={submit.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submit.busy}>
            {submit.busy ? 'Saving…' : 'Reset password'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function AssignModal({
  user,
  orgs,
  onClose,
  onSaved,
}: {
  user: SuperadminUserDto;
  orgs: SuperadminOrganizationDto[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const memberOf = new Set(user.memberships.map((m) => m.organizationId));
  const available = orgs.filter((org) => !memberOf.has(org.id));
  const [organizationId, setOrganizationId] = useState(available[0]?.id ?? '');
  const [role, setRole] = useState<OrgRole>('editor');

  const submit = useAction(async () => {
    await api.post(`/superadmin/organizations/${organizationId}/members`, {
      userId: user.id,
      role,
    });
    onSaved();
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.run();
  };

  return (
    <Modal title={`Assign ${user.email} to a company`} onClose={onClose}>
      {available.length === 0 ? (
        <p className="text-sm text-slate-500">This user is already a member of every company.</p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Company">
            <Select value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}>
              {available.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value as OrgRole)}>
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
          <ErrorNote message={submit.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={submit.busy || !organizationId}>
              {submit.busy ? 'Assigning…' : 'Assign'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
