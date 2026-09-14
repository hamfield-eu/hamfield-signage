import { useState, type FormEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { MfaEnableResponse, MfaSetupResponse } from '@signage/shared';
import { Badge, Button, Card, ErrorNote, Field, Input } from './ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApi, useAction } from '../lib/hooks';

interface RecoveryStatus {
  enabled: boolean;
  remaining: number;
}

/**
 * Two-factor authentication, on the account settings page.
 *
 * This deployment has no outbound email, so the recovery story is deliberately
 * visible in the UI: recovery codes are shown once and the screen says plainly
 * that losing both factors means asking an administrator. Hiding that would
 * only move the surprise to the worst possible moment.
 */
export function MfaCard() {
  const { user, refreshUser } = useAuth();
  const status = useApi(() => api.get<RecoveryStatus>('/auth/mfa/recovery-codes'), []);
  const [enrolling, setEnrolling] = useState<MfaSetupResponse | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);

  const enabled = user?.mfaEnabled ?? false;

  const begin = useAction(async () => {
    setRecoveryCodes(null);
    setEnrolling(await api.post<MfaSetupResponse>('/auth/mfa/setup'));
  });

  const finished = async () => {
    setEnrolling(null);
    await refreshUser();
    status.reload();
  };

  return (
    <Card title="Two-factor authentication">
      {recoveryCodes ? (
        <RecoveryCodes codes={recoveryCodes} onDone={() => setRecoveryCodes(null)} />
      ) : enrolling ? (
        <Enrollment
          setup={enrolling}
          onCancel={() => setEnrolling(null)}
          onEnabled={async (codes) => {
            setRecoveryCodes(codes);
            await finished();
          }}
        />
      ) : disabling ? (
        <DisableForm
          onCancel={() => setDisabling(false)}
          onDisabled={async () => {
            setDisabling(false);
            await finished();
          }}
        />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-500">Status</span>
            <Badge tone={enabled ? 'green' : 'gray'}>{enabled ? 'On' : 'Off'}</Badge>
          </div>
          {enabled ? (
            <>
              <p className="text-sm text-slate-600">
                You are asked for a code from your authenticator app each time you sign in.
              </p>
              {status.data ? (
                <p className="text-sm text-slate-500">
                  {status.data.remaining} recovery {status.data.remaining === 1 ? 'code' : 'codes'}{' '}
                  left.
                  {status.data.remaining <= 2
                    ? ' Turn two-factor off and on again to get a fresh set.'
                    : ''}
                </p>
              ) : null}
              <Button variant="danger" onClick={() => setDisabling(true)}>
                Turn off
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-600">
                Add a second step to sign-in using an authenticator app such as Google
                Authenticator, 1Password, or Aegis.
              </p>
              <ErrorNote message={begin.error} />
              <Button onClick={() => begin.run()} disabled={begin.busy}>
                {begin.busy ? 'Preparing…' : 'Set up'}
              </Button>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function Enrollment({
  setup,
  onCancel,
  onEnabled,
}: {
  setup: MfaSetupResponse;
  onCancel: () => void;
  onEnabled: (codes: string[]) => Promise<void>;
}) {
  const [code, setCode] = useState('');

  const confirm = useAction(async () => {
    const result = await api.post<MfaEnableResponse>('/auth/mfa/enable', { code });
    await onEnabled(result.recoveryCodes);
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    confirm.run();
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Scan this with your authenticator app, then enter the code it shows.
      </p>
      <div className="flex justify-center rounded-md border border-slate-200 bg-white p-4">
        <QRCodeSVG value={setup.otpauthUri} size={168} />
      </div>
      <div>
        <p className="text-sm text-slate-500">Or enter this key by hand:</p>
        {/* Shown always, not behind a "can't scan?" link: a phone camera that
            will not focus is the single most common way this flow stalls. */}
        <code className="mt-1 block break-all rounded bg-slate-100 px-2 py-1.5 font-mono text-sm tracking-wider text-slate-800">
          {setup.secret}
        </code>
      </div>
      <form onSubmit={onSubmit} className="space-y-3">
        <Field label="Code from your app">
          <Input
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            required
          />
        </Field>
        <ErrorNote message={confirm.error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={confirm.busy}>
            {confirm.busy ? 'Verifying…' : 'Turn on'}
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="space-y-4">
      <p className="text-sm font-medium text-slate-800">
        Two-factor authentication is on. Save these recovery codes now.
      </p>
      <p className="text-sm text-slate-600">
        Each code works once, if you lose your authenticator. This is the only time they are shown —
        they are stored hashed and cannot be displayed again.
      </p>
      <ul className="grid grid-cols-2 gap-2 rounded-md bg-slate-100 p-3 font-mono text-sm text-slate-800">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            // Clipboard access can be refused (insecure origin, permissions);
            // the codes are on screen regardless, so a failure is not an error.
            navigator.clipboard?.writeText(codes.join('\n')).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button onClick={onDone}>I have saved them</Button>
      </div>
    </div>
  );
}

function DisableForm({
  onCancel,
  onDisabled,
}: {
  onCancel: () => void;
  onDisabled: () => Promise<void>;
}) {
  const [password, setPassword] = useState('');

  const disable = useAction(async () => {
    await api.post('/auth/mfa/disable', { password });
    await onDisabled();
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    disable.run();
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <p className="text-sm text-slate-600">
        Confirm your password to turn two-factor authentication off. Your recovery codes are
        deleted.
      </p>
      <Field label="Password">
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </Field>
      <ErrorNote message={disable.error} />
      <div className="flex gap-2">
        <Button type="submit" variant="danger" disabled={disable.busy}>
          {disable.busy ? 'Turning off…' : 'Turn off'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
