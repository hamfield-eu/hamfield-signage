import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@signage/database';
import {
  TOTP_STEP_SECONDS,
  base32Decode,
  currentTotpStep,
  disableMfaForUser,
  hotp,
} from '../lib/mfa';
import { MAX_CHALLENGE_ATTEMPTS } from '../lib/mfa-challenge';
import {
  FIXTURE_PASSWORD,
  buildTestApp,
  call,
  resetDb,
  seedFixture,
  testPrisma,
  type Fixture,
} from './helpers';

/**
 * The end-to-end second-factor flow, against real Postgres and real Redis.
 *
 * The thing this suite exists to prove is the property `mfa.test.ts` cannot:
 * that a half-authenticated login is not a session. The challenge id must open
 * nothing, and the only way past it is a code.
 */
describe('multi-factor authentication', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let fx: Fixture;

  beforeAll(async () => {
    prisma = testPrisma();
    app = await buildTestApp(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    fx = await seedFixture(prisma);
  });

  const user = () => fx.a.users.admin;

  const login = (email: string, password = FIXTURE_PASSWORD) =>
    call(app, { method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });

  const submitCode = (challengeId: string, code: string) =>
    call(app, { method: 'POST', url: '/api/v1/auth/login/mfa', payload: { challengeId, code } });

  /**
   * Waits out the tail of the current 30-second step when there is not enough
   * of it left to run a test in. Without this, a step boundary crossing
   * mid-test would shift every relative code by one and fail the suite for a
   * reason that has nothing to do with the code under test.
   */
  async function settleStep(): Promise<number> {
    const intoStep = (Date.now() / 1000) % TOTP_STEP_SECONDS;
    const remaining = TOTP_STEP_SECONDS - intoStep;
    if (remaining < 5) await new Promise((resolve) => setTimeout(resolve, remaining * 1000 + 100));
    return currentTotpStep();
  }

  /** The code for an absolute step, so a test's codes cannot drift apart. */
  const codeAt = (secret: string, step: number) => hotp(base32Decode(secret)!, step, 6);

  /**
   * Runs the real enrollment flow, confirming with the *previous* step's code.
   *
   * Confirming consumes a step (`mfaLastStep`) exactly as a login does, so
   * enrolling with the current code would leave the caller unable to sign in
   * until the next one — true in production, and merely noise in a test that is
   * about something else. Spending step-1 leaves `base` and `base + 1` free.
   */
  async function enroll(token: string) {
    const base = await settleStep();
    const setup = await call(app, { method: 'POST', url: '/api/v1/auth/mfa/setup', token });
    expect(setup.statusCode).toBe(200);
    const { secret, otpauthUri } = setup.json();

    const enable = await call(app, {
      method: 'POST',
      url: '/api/v1/auth/mfa/enable',
      token,
      payload: { code: codeAt(secret, base - 1) },
    });
    expect(enable.statusCode).toBe(200);
    return {
      secret,
      otpauthUri,
      base,
      recoveryCodes: enable.json().recoveryCodes as string[],
    };
  }

  // ------------------------------------------------------------- enrollment

  it('does not challenge until enrollment is confirmed', async () => {
    const setup = await call(app, {
      method: 'POST',
      url: '/api/v1/auth/mfa/setup',
      token: user().token,
    });
    expect(setup.statusCode).toBe(200);
    expect(setup.json().otpauthUri).toContain(encodeURIComponent(user().email));

    // The secret exists in the database but was never confirmed. Login must be
    // untouched — an abandoned enrollment cannot lock anyone out.
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user().id } });
    expect(stored.mfaSecret).toBe(setup.json().secret);
    expect(stored.mfaConfirmedAt).toBeNull();

    const res = await login(user().email);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
    expect(res.json().token).toBeTruthy();
  });

  it('turns MFA on only against a correct code, and issues recovery codes', async () => {
    const base = await settleStep();
    const setup = await call(app, {
      method: 'POST',
      url: '/api/v1/auth/mfa/setup',
      token: user().token,
    });
    const { secret } = setup.json();

    const wrong = await call(app, {
      method: 'POST',
      url: '/api/v1/auth/mfa/enable',
      token: user().token,
      payload: { code: '000000' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user().id } })).mfaConfirmedAt,
    ).toBeNull();

    const ok = await call(app, {
      method: 'POST',
      url: '/api/v1/auth/mfa/enable',
      token: user().token,
      payload: { code: codeAt(secret, base) },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().recoveryCodes).toHaveLength(10);

    // Stored hashed, never in the clear.
    const stored = await prisma.mfaRecoveryCode.findMany({ where: { userId: user().id } });
    expect(stored).toHaveLength(10);
    for (const row of stored) {
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(ok.json().recoveryCodes).not.toContain(row.codeHash);
    }

    expect(
      (await call(app, { method: 'GET', url: '/api/v1/auth/me', token: user().token })).json().user
        .mfaEnabled,
    ).toBe(true);
  });

  // ------------------------------------------------------------------ login

  it('withholds the session token until the second factor is given', async () => {
    const { secret, base } = await enroll(user().token);

    const first = await login(user().email);
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.status).toBe('mfa_required');
    expect(body.challengeId).toMatch(/^[0-9a-f]{64}$/);
    // The password step must hand back nothing that acts as a credential.
    expect(body.token).toBeUndefined();
    expect(body.user).toBeUndefined();
    expect(body.organizations).toBeUndefined();

    // The challenge id is not a token: it opens no authenticated route.
    const misuse = await call(app, {
      method: 'GET',
      url: '/api/v1/auth/me',
      token: body.challengeId,
    });
    expect(misuse.statusCode).toBe(401);

    const second = await submitCode(body.challengeId, codeAt(secret, base));
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe('ok');

    // ...and that token is a real session.
    const me = await call(app, {
      method: 'GET',
      url: '/api/v1/auth/me',
      token: second.json().token,
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(user().id);
  });

  it('rejects a wrong password before ever creating a challenge', async () => {
    await enroll(user().token);
    const res = await login(user().email, 'not-the-password');
    expect(res.statusCode).toBe(401);
    expect(res.json().challengeId).toBeUndefined();
  });

  it('spends a challenge on success, so it cannot be replayed', async () => {
    const { secret, base } = await enroll(user().token);
    const { challengeId } = (await login(user().email)).json();

    expect((await submitCode(challengeId, codeAt(secret, base))).statusCode).toBe(200);
    const replay = await submitCode(challengeId, codeAt(secret, base));
    expect(replay.statusCode).toBe(401);
  });

  it('refuses a TOTP code a second time within its own window', async () => {
    const { secret, base } = await enroll(user().token);
    const code = codeAt(secret, base);

    const first = (await login(user().email)).json();
    expect((await submitCode(first.challengeId, code)).statusCode).toBe(200);

    // Same code, a brand-new challenge: still inside the 30s window, so this is
    // exactly what a shoulder-surfer or a replayed request would send.
    const second = (await login(user().email)).json();
    expect((await submitCode(second.challengeId, code)).statusCode).toBe(401);

    // The next step is still accepted — the user is not locked out for 30s.
    expect((await submitCode(second.challengeId, codeAt(secret, base + 1))).statusCode).toBe(200);
  });

  it('destroys the challenge after five wrong codes', async () => {
    const { secret, base } = await enroll(user().token);
    const { challengeId } = (await login(user().email)).json();

    for (let i = 0; i < MAX_CHALLENGE_ATTEMPTS; i++) {
      expect((await submitCode(challengeId, '000000')).statusCode).toBe(401);
    }
    // Even the right code cannot rescue it: 10^6 is small, so the cap is the
    // control that matters here, not the per-IP rate limit.
    expect((await submitCode(challengeId, codeAt(secret, base))).statusCode).toBe(401);
  });

  it('rejects an unknown or malformed challenge id', async () => {
    await enroll(user().token);
    expect((await submitCode('a'.repeat(64), '000000')).statusCode).toBe(401);
    expect((await submitCode('not-a-challenge', '000000')).statusCode).toBe(400);
  });

  it('re-checks the account at the second step, not just the first', async () => {
    const { secret, base } = await enroll(user().token);
    const { challengeId } = (await login(user().email)).json();

    // Disabled between the two steps: the challenge is a handle, never a
    // decision that stays true.
    await prisma.user.update({ where: { id: user().id }, data: { disabledAt: new Date() } });
    expect((await submitCode(challengeId, codeAt(secret, base))).statusCode).toBe(403);
  });

  // --------------------------------------------------------------- recovery

  it('accepts a recovery code once and only once', async () => {
    const { recoveryCodes } = await enroll(user().token);
    const [code] = recoveryCodes;

    const first = (await login(user().email)).json();
    // Typed the way a person reads it off paper.
    const ok = await submitCode(first.challengeId, code.toLowerCase().replace('-', ' '));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().token).toBeTruthy();

    const second = (await login(user().email)).json();
    expect((await submitCode(second.challengeId, code)).statusCode).toBe(401);

    const remaining = await call(app, {
      method: 'GET',
      url: '/api/v1/auth/mfa/recovery-codes',
      token: ok.json().token,
    });
    expect(remaining.json()).toEqual({ enabled: true, remaining: 9 });
  });

  it('will not accept another account’s recovery code', async () => {
    const mine = await enroll(user().token);
    const theirs = await enroll(fx.b.users.admin.token);

    const { challengeId } = (await login(user().email)).json();
    expect((await submitCode(challengeId, theirs.recoveryCodes[0])).statusCode).toBe(401);
    // Their code must also still be unspent.
    expect(
      await prisma.mfaRecoveryCode.count({
        where: { userId: fx.b.users.admin.id, usedAt: null },
      }),
    ).toBe(10);
    expect(mine.recoveryCodes).not.toContain(theirs.recoveryCodes[0]);
  });

  // ---------------------------------------------------------------- disable

  it('requires the password to turn MFA off from the dashboard', async () => {
    await enroll(user().token);

    const wrong = await call(app, {
      method: 'POST',
      url: '/api/v1/auth/mfa/disable',
      token: user().token,
      payload: { password: 'not-the-password' },
    });
    expect(wrong.statusCode).toBe(401);
    expect((await login(user().email)).json().status).toBe('mfa_required');

    const ok = await call(app, {
      method: 'POST',
      url: '/api/v1/auth/mfa/disable',
      token: user().token,
      payload: { password: FIXTURE_PASSWORD },
    });
    expect(ok.statusCode).toBe(200);

    const after = await login(user().email);
    expect(after.json().status).toBe('ok');
    expect(await prisma.mfaRecoveryCode.count({ where: { userId: user().id } })).toBe(0);
  });

  /**
   * The operator's recovery path, and the reason this feature can ship without
   * an email channel: it must work from the server alone.
   */
  it('lets the CLI helper unlock an account with no authenticator left', async () => {
    await enroll(user().token);
    expect((await login(user().email)).json().status).toBe('mfa_required');

    const result = await disableMfaForUser(prisma, user().email.toUpperCase());
    expect(result.status).toBe('disabled');

    const after = await login(user().email);
    expect(after.statusCode).toBe(200);
    expect(after.json().status).toBe('ok');
    expect(after.json().token).toBeTruthy();

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user().id } });
    expect(stored.mfaSecret).toBeNull();
    expect(stored.mfaConfirmedAt).toBeNull();
    expect(stored.mfaLastStep).toBeNull();
    // The password is deliberately untouched by the recovery path.
    expect(stored.passwordHash).toBe(
      (await prisma.user.findUniqueOrThrow({ where: { id: user().id } })).passwordHash,
    );
    expect(await prisma.mfaRecoveryCode.count({ where: { userId: user().id } })).toBe(0);
  });

  it('reports a missing account instead of silently succeeding', async () => {
    expect(await disableMfaForUser(prisma, 'nobody@example.test')).toEqual({
      status: 'no-such-user',
      email: 'nobody@example.test',
    });
    expect((await disableMfaForUser(prisma, user().email)).status).toBe('already-off');
  });
});
