import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  changePasswordSchema,
  loginSchema,
  mfaDisableSchema,
  mfaEnableSchema,
  mfaLoginSchema,
} from '@signage/shared';
import type { AuthSuccessResponse } from '@signage/shared';
import { hashPassword, signUserToken, verifyPassword } from '../lib/auth';
import { authenticateUser, requireActiveUser } from '../plugins/auth';
import { badRequest, forbidden, gone, unauthorized } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import {
  disableMfaForUser,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUri,
  verifyTotp,
} from '../lib/mfa';
import {
  CHALLENGE_TTL_SECONDS,
  consumeMfaChallenge,
  createMfaChallenge,
  readMfaChallenge,
  recordFailedAttempt,
} from '../lib/mfa-challenge';
import { orgLogoUrl, serializeOrg, serializeUser } from '../lib/serializers';
import { getEnv } from '../env';
import type { Organization, OrgRole, PrismaClient, User } from '@signage/database';

/** Serializes the caller's organizations, including a presigned logo URL each. */
async function serializeMemberOrgs(
  memberships: Array<{ organization: Organization; role: OrgRole }>,
  isSuperadmin: boolean,
) {
  const visible = memberships.filter((m) => m.organization.status === 'active' || isSuperadmin);
  return Promise.all(
    visible.map(async (m) =>
      serializeOrg(m.organization, m.role, { logoUrl: await orgLogoUrl(m.organization) }),
    ),
  );
}

/**
 * The payload that ends a successful login, from either step. Shared so the
 * direct path and the post-MFA path cannot drift apart — a difference between
 * them is a difference in what the dashboard believes about the account.
 */
async function loginSuccess(prisma: PrismaClient, user: User): Promise<AuthSuccessResponse> {
  const memberships = await prisma.organizationMember.findMany({
    where: { userId: user.id, organization: { deletedAt: null } },
    include: { organization: true },
  });
  return {
    status: 'ok',
    token: signUserToken({
      sub: user.id,
      email: user.email,
      pwdAt: user.passwordChangedAt?.getTime(),
    }),
    user: serializeUser(user),
    organizations: await serializeMemberOrgs(memberships, user.globalRole === 'superadmin'),
  };
}

/**
 * Checks a second factor and, on success, records what was spent.
 *
 * Accepts either an authenticator code or a recovery code; both are single-use.
 * TOTP consumes its step (`mfaLastStep`) so a code cannot be replayed inside its
 * 30-second window; a recovery code is marked used rather than deleted, so the
 * remaining count stays honest.
 */
async function consumeSecondFactor(
  prisma: PrismaClient,
  user: User,
  code: string,
): Promise<boolean> {
  if (user.mfaSecret) {
    const totp = verifyTotp(user.mfaSecret, code, { lastStep: user.mfaLastStep });
    if (totp.valid) {
      await prisma.user.update({ where: { id: user.id }, data: { mfaLastStep: totp.step } });
      return true;
    }
  }

  const record = await prisma.mfaRecoveryCode.findUnique({
    where: { codeHash: hashRecoveryCode(code) },
  });
  if (!record || record.userId !== user.id || record.usedAt) return false;
  // updateMany with a usedAt=null guard: two requests racing the same code must
  // not both win, and this is one statement rather than a read-then-write.
  const claimed = await prisma.mfaRecoveryCode.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  return claimed.count === 1;
}

/**
 * Shared by both login paths. Only a *completed* login is audited: with MFA on,
 * passing the password step is not yet a sign-in.
 */
async function auditSuperadminLogin(
  prisma: PrismaClient,
  req: FastifyRequest,
  user: User,
): Promise<void> {
  if (user.globalRole !== 'superadmin') return;
  await writeAudit(prisma, req, {
    action: 'superadmin.login',
    targetType: 'user',
    targetId: user.id,
    actorUserId: user.id,
    actorGlobalRole: 'superadmin',
  });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  // Public registration was removed in v2: accounts are created by a
  // superadmin (or organization admins). The route stays registered so old
  // clients get an explicit error instead of a confusing 404.
  app.post('/auth/register', async () => {
    throw gone('Public registration is disabled. Ask your administrator for an account.');
  });

  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const body = loginSchema.parse(req.body);

      const user = await prisma.user.findUnique({ where: { email: body.email } });
      if (!user) {
        req.log.warn({ email: body.email }, 'auth: login failed (unknown user)');
        throw unauthorized('Invalid email or password');
      }
      const valid = await verifyPassword(body.password, user.passwordHash);
      if (!valid) {
        req.log.warn({ userId: user.id }, 'auth: login failed (bad password)');
        throw unauthorized('Invalid email or password');
      }
      if (user.disabledAt) {
        req.log.warn({ userId: user.id }, 'auth: login rejected (account disabled)');
        throw forbidden('This account has been disabled');
      }

      // MFA is only in force once the user proved they could generate a code.
      // A secret written but never confirmed is an abandoned enrollment, and
      // must not stand between anyone and their account.
      if (user.mfaConfirmedAt) {
        const challenge = await createMfaChallenge(user.id);
        req.log.info({ userId: user.id }, 'auth: password ok, awaiting second factor');
        return {
          status: 'mfa_required' as const,
          challengeId: challenge.id,
          expiresInSeconds: CHALLENGE_TTL_SECONDS,
        };
      }

      req.log.info({ userId: user.id }, 'auth: login success');
      await auditSuperadminLogin(prisma, req, user);
      return loginSuccess(prisma, user);
    },
  );

  /**
   * Second step of login. The challenge id is the only credential — it is
   * server-side, single-use, five-minute, and capped at five attempts, because
   * a six-digit code is otherwise inside brute-force range of the 10/min
   * route limit.
   */
  app.post(
    '/auth/login/mfa',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const body = mfaLoginSchema.parse(req.body);

      const challenge = await readMfaChallenge(body.challengeId);
      if (!challenge) throw unauthorized('This sign-in attempt expired. Please sign in again.');

      const user = await prisma.user.findUnique({ where: { id: challenge.userId } });
      // Everything that could have changed since the password step is re-checked
      // here: the challenge is a handle, never a decision that stays true.
      if (!user || !user.mfaConfirmedAt) {
        await consumeMfaChallenge(challenge.id);
        throw unauthorized('This sign-in attempt expired. Please sign in again.');
      }
      if (user.disabledAt) {
        await consumeMfaChallenge(challenge.id);
        throw forbidden('This account has been disabled');
      }

      if (!(await consumeSecondFactor(prisma, user, body.code))) {
        const attempts = await recordFailedAttempt(challenge);
        req.log.warn({ userId: user.id, attempts }, 'auth: second factor rejected');
        throw unauthorized('That code is not valid');
      }

      await consumeMfaChallenge(challenge.id);
      req.log.info({ userId: user.id }, 'auth: login success (second factor)');
      await auditSuperadminLogin(prisma, req, user);
      return loginSuccess(prisma, user);
    },
  );

  app.get('/auth/me', { preHandler: authenticateUser }, async (req) => {
    const user = await requireActiveUser(prisma, req);
    const memberships = await prisma.organizationMember.findMany({
      where: { userId: user.id, organization: { deletedAt: null } },
      include: { organization: true },
    });
    return {
      user: serializeUser(user),
      organizations: await serializeMemberOrgs(memberships, user.globalRole === 'superadmin'),
    };
  });

  // ------------------------------------------------------------------ MFA
  // Enrollment is two calls on purpose: /setup hands out a secret, /enable only
  // turns it on once the user has proved the app produces matching codes. An
  // account can therefore never end up locked behind a secret nobody holds.

  app.post(
    '/auth/mfa/setup',
    { preHandler: authenticateUser, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const user = await requireActiveUser(prisma, req);
      if (user.mfaConfirmedAt) {
        throw badRequest(
          'Two-factor authentication is already on. Turn it off first to re-enroll.',
        );
      }

      // A fresh secret every time: restarting the flow must invalidate whatever the
      // previous attempt showed, in case that screen was left open elsewhere.
      const secret = generateTotpSecret();
      await prisma.user.update({
        where: { id: user.id },
        data: { mfaSecret: secret, mfaLastStep: null },
      });
      req.log.info({ userId: user.id }, 'auth: mfa enrollment started');

      return {
        secret,
        otpauthUri: otpauthUri({ secret, account: user.email, issuer: getEnv().MFA_ISSUER }),
      };
    },
  );

  app.post(
    '/auth/mfa/enable',
    { preHandler: authenticateUser, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const body = mfaEnableSchema.parse(req.body);
      const user = await requireActiveUser(prisma, req);
      if (user.mfaConfirmedAt) throw badRequest('Two-factor authentication is already on');
      if (!user.mfaSecret) throw badRequest('Start with /auth/mfa/setup');

      const totp = verifyTotp(user.mfaSecret, body.code, { lastStep: user.mfaLastStep });
      if (!totp.valid) throw unauthorized('That code is not valid. Check your device clock.');

      // Recovery codes are the only way back in without server access, so they
      // are issued in the same transaction that turns MFA on - there is no
      // window in which the account is locked and has no fallback.
      const codes = generateRecoveryCodes();
      await prisma.$transaction([
        prisma.mfaRecoveryCode.deleteMany({ where: { userId: user.id } }),
        prisma.mfaRecoveryCode.createMany({
          data: codes.map((code) => ({ userId: user.id, codeHash: hashRecoveryCode(code) })),
        }),
        prisma.user.update({
          where: { id: user.id },
          data: { mfaConfirmedAt: new Date(), mfaLastStep: totp.step },
        }),
      ]);

      req.log.info({ userId: user.id }, 'auth: mfa enabled');
      await writeAudit(prisma, req, {
        action: 'user.mfa.enable',
        targetType: 'user',
        targetId: user.id,
        actorUserId: user.id,
        actorGlobalRole: user.globalRole,
      });

      // The only time these are ever readable. They are stored hashed.
      return { ok: true as const, recoveryCodes: codes };
    },
  );

  app.post(
    '/auth/mfa/disable',
    { preHandler: authenticateUser, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req) => {
      const body = mfaDisableSchema.parse(req.body);
      const user = await requireActiveUser(prisma, req);

      // Re-check the password: a borrowed unlocked tab must not be able to
      // strip the second factor off the account.
      if (!(await verifyPassword(body.password, user.passwordHash))) {
        throw unauthorized('Password is incorrect');
      }

      await disableMfaForUser(prisma, user.email);
      req.log.info({ userId: user.id }, 'auth: mfa disabled by user');
      await writeAudit(prisma, req, {
        action: 'user.mfa.disable',
        targetType: 'user',
        targetId: user.id,
        actorUserId: user.id,
        actorGlobalRole: user.globalRole,
        metadata: { via: 'dashboard' },
      });
      return { ok: true };
    },
  );

  /** How many single-use codes are left, so the dashboard can warn in time. */
  app.get('/auth/mfa/recovery-codes', { preHandler: authenticateUser }, async (req) => {
    const user = await requireActiveUser(prisma, req);
    const remaining = await prisma.mfaRecoveryCode.count({
      where: { userId: user.id, usedAt: null },
    });
    return { enabled: user.mfaConfirmedAt !== null, remaining };
  });

  app.post(
    '/auth/change-password',
    { preHandler: authenticateUser, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req) => {
      const body = changePasswordSchema.parse(req.body);
      const user = await requireActiveUser(prisma, req);

      const valid = await verifyPassword(body.currentPassword, user.passwordHash);
      if (!valid) throw unauthorized('Current password is incorrect');
      if (body.currentPassword === body.newPassword) {
        throw badRequest('New password must differ from the current password');
      }

      // passwordChangedAt invalidates every token issued before this moment -
      // including the caller's own. Hand back a fresh one so changing your
      // password does not log you out of the tab you are sitting in; every OTHER
      // session for this account dies, which is the point.
      const passwordChangedAt = new Date();
      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash: await hashPassword(body.newPassword),
          mustChangePassword: false,
          passwordChangedAt,
        },
      });
      req.log.info({ userId: user.id }, 'auth: password changed, other sessions invalidated');
      return {
        ok: true,
        token: signUserToken({
          sub: user.id,
          email: user.email,
          pwdAt: passwordChangedAt.getTime(),
        }),
      };
    },
  );
}
