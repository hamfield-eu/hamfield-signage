import { useState, type FormEvent } from 'react';
import { Button, ErrorNote, Field, Input } from '../components/ui';
import { api, setToken } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction } from '../lib/hooks';

/**
 * Shown as a full-screen gate when the account has a temporary password
 * (mustChangePassword), and reachable from Settings otherwise.
 */
export function ChangePasswordPage({ forced = false }: { forced?: boolean }) {
  const { user, refreshUser, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const submit = useAction(async () => {
    if (newPassword !== confirm) throw new Error('Passwords do not match');
    // The API invalidates every token issued before this change, including the
    // one we are holding, and returns a replacement. Adopt it before the next
    // request or refreshUser() below 401s and drops us at the login screen.
    const res = await api.post<{ ok: boolean; token?: string }>('/auth/change-password', {
      currentPassword,
      newPassword,
    });
    if (res.token) setToken(res.token);
    await refreshUser();
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.run();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-7 shadow-md">
        <h1 className="text-xl font-bold text-slate-900">Set a new password</h1>
        <p className="mb-5 mt-1 text-sm text-slate-500">
          {forced
            ? `Welcome ${user?.name ?? ''}. Your account uses a temporary password — choose your own before continuing.`
            : 'Choose a new password for your account.'}
        </p>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Current password">
            <Input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          <Field label="New password" hint="At least 8 characters">
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </Field>
          <Field label="Repeat new password">
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </Field>
          <ErrorNote message={submit.error} />
          <Button type="submit" disabled={submit.busy} className="w-full">
            {submit.busy ? 'Saving…' : 'Change password'}
          </Button>
          {forced ? (
            <button
              type="button"
              onClick={logout}
              className="w-full text-center text-xs font-medium text-slate-400 hover:text-slate-600"
            >
              Sign out instead
            </button>
          ) : null}
        </form>
      </div>
    </div>
  );
}
