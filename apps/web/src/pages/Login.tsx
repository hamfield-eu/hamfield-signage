import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, ErrorNote, Field, Input } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useAction } from '../lib/hooks';

/**
 * Sign-in, in one or two steps.
 *
 * The second step appears only for accounts with MFA on. It is a separate
 * screen rather than an always-visible field because most accounts do not have
 * MFA, and the server must not reveal which do until the password is correct.
 */
export function LoginPage() {
  const [challengeId, setChallengeId] = useState<string | null>(null);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-7 shadow-md">
        <h1 className="text-xl font-bold text-slate-900">Signage</h1>
        {challengeId ? (
          <SecondFactorStep challengeId={challengeId} onCancel={() => setChallengeId(null)} />
        ) : (
          <PasswordStep onChallenge={setChallengeId} />
        )}
      </div>
    </div>
  );
}

function PasswordStep({ onChallenge }: { onChallenge: (challengeId: string) => void }) {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const submit = useAction(async () => {
    const outcome = await login(email, password);
    if (outcome.status === 'mfa_required') onChallenge(outcome.challengeId);
    else navigate('/devices');
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.run();
  };

  return (
    <>
      <p className="mb-5 mt-1 text-sm text-slate-500">Sign in to your dashboard</p>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Email">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        <ErrorNote message={submit.error} />
        <Button type="submit" disabled={submit.busy} className="w-full">
          {submit.busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <p className="mt-4 text-center text-xs text-slate-400">
        Accounts are managed by your administrator.
      </p>
    </>
  );
}

function SecondFactorStep({
  challengeId,
  onCancel,
}: {
  challengeId: string;
  onCancel: () => void;
}) {
  const { completeMfaLogin } = useAuth();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);

  const submit = useAction(async () => {
    await completeMfaLogin(challengeId, code);
    navigate('/devices');
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.run();
  };

  return (
    <>
      <p className="mb-5 mt-1 text-sm text-slate-500">
        {useRecovery
          ? 'Enter one of your recovery codes'
          : 'Enter the 6-digit code from your authenticator app'}
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label={useRecovery ? 'Recovery code' : 'Authentication code'}>
          <Input
            // autoFocus is right here and nowhere else in the app: the user has
            // already committed to signing in and has a code in front of them.
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            // one-time-code lets phones offer the SMS/app code; for a recovery
            // code it would be wrong, and off keeps managers from saving it.
            autoComplete={useRecovery ? 'off' : 'one-time-code'}
            inputMode={useRecovery ? 'text' : 'numeric'}
            placeholder={useRecovery ? 'XXXXX-XXXXX' : '123456'}
            required
          />
        </Field>
        <ErrorNote message={submit.error} />
        <Button type="submit" disabled={submit.busy} className="w-full">
          {submit.busy ? 'Verifying…' : 'Verify'}
        </Button>
      </form>
      <div className="mt-4 flex justify-between text-xs">
        <button
          type="button"
          onClick={() => {
            setUseRecovery((v) => !v);
            setCode('');
            submit.clearError();
          }}
          className="font-medium text-blue-600 hover:underline"
        >
          {useRecovery ? 'Use your authenticator app' : 'Use a recovery code'}
        </button>
        <button type="button" onClick={onCancel} className="text-slate-400 hover:underline">
          Cancel
        </button>
      </div>
      {useRecovery ? (
        <p className="mt-4 text-center text-xs text-slate-400">
          Lost your codes too? An administrator can turn off two-factor authentication for your
          account from the server.
        </p>
      ) : null}
    </>
  );
}
