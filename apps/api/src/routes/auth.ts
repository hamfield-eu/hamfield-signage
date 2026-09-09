import type { FastifyInstance } from 'fastify';
import { changePasswordSchema, loginSchema } from '@signage/shared';
import { hashPassword, signUserToken, verifyPassword } from '../lib/auth';
import { authenticateUser, requireActiveUser } from '../plugins/auth';
import { badRequest, forbidden, gone, unauthorized } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { orgLogoUrl, serializeOrg, serializeUser } from '../lib/serializers';
import type { Organization, OrgRole } from '@signage/database';

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

      const memberships = await prisma.organizationMember.findMany({
        where: { userId: user.id, organization: { deletedAt: null } },
        include: { organization: true },
      });

      req.log.info({ userId: user.id }, 'auth: login success');
      if (user.globalRole === 'superadmin') {
        await writeAudit(prisma, req, {
          action: 'superadmin.login',
          targetType: 'user',
          targetId: user.id,
          actorUserId: user.id,
          actorGlobalRole: 'superadmin',
        });
      }
      return {
        token: signUserToken({
          sub: user.id,
          email: user.email,
          pwdAt: user.passwordChangedAt?.getTime(),
        }),
        user: serializeUser(user),
        organizations: await serializeMemberOrgs(memberships, user.globalRole === 'superadmin'),
      };
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
