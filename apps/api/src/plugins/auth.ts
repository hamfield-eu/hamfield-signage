import type { FastifyReply, FastifyRequest } from 'fastify';
import type { GlobalRole, OrgRole } from '@signage/shared';
import type { Device, PrismaClient, User } from '@signage/database';
import { roleSatisfies, tokenPredatesPasswordChange, verifyUserToken } from '../lib/auth';
import { hashDeviceToken } from '../lib/tokens';
import { forbidden, unauthorized } from '../lib/errors';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; email: string };
    /** The account row loaded by authenticateUser, so guards need not re-query. */
    authUser?: User;
    device?: Device;
  }
}

/**
 * preHandler: requires a valid user JWT (Authorization: Bearer ...).
 *
 * This deliberately loads the account row rather than trusting the token alone.
 * The check has to be HERE and not in requireActiveUser, because not every
 * handler calls a guard - `GET /orgs` (routes/orgs.ts) reads `req.user.id`
 * directly and relies only on this hook. Putting the revocation check downstream
 * would leave those routes bypassable, and would let a disabled account keep
 * listing its organizations.
 *
 * The row is cached on the request so requireActiveUser/requireOrgRole reuse it
 * instead of issuing a second query.
 */
export async function authenticateUser(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized('Missing bearer token');
  const payload = verifyUserToken(header.slice(7));
  if (!payload) throw unauthorized('Invalid or expired token');

  const user = await req.server.prisma.user.findUnique({ where: { id: payload.sub } });
  // Deleted account, or a token for an id that no longer exists.
  if (!user) throw unauthorized('Invalid or expired token');
  if (tokenPredatesPasswordChange(payload.pwdAt, user.passwordChangedAt)) {
    throw unauthorized('Session ended because the account password was changed');
  }
  if (user.disabledAt) throw forbidden('This account has been disabled');

  req.user = { id: user.id, email: user.email };
  req.authUser = user;
}

/**
 * Loads the authenticated user and rejects disabled accounts. Prefers the row
 * authenticateUser already fetched; the query is a fallback for call paths that
 * set req.user without running that hook.
 */
export async function requireActiveUser(prisma: PrismaClient, req: FastifyRequest): Promise<User> {
  if (!req.user) throw unauthorized();
  const user = req.authUser ?? (await prisma.user.findUnique({ where: { id: req.user.id } }));
  if (!user) throw unauthorized();
  if (user.disabledAt) throw forbidden('This account has been disabled');
  return user;
}

/** Asserts the authenticated user is a (non-disabled) platform superadmin. */
export async function requireSuperadmin(prisma: PrismaClient, req: FastifyRequest): Promise<User> {
  const user = await requireActiveUser(prisma, req);
  if ((user.globalRole as GlobalRole) !== 'superadmin') {
    throw forbidden('Requires superadmin privileges');
  }
  return user;
}

/**
 * Asserts the authenticated user is a member of the organization with at
 * least the given role. Superadmins may enter any organization context and
 * act with owner privileges. Disabled organizations are only accessible to
 * superadmins. Returns the effective role.
 */
export async function requireOrgRole(
  prisma: PrismaClient,
  req: FastifyRequest,
  organizationId: string,
  minRole: OrgRole,
): Promise<OrgRole> {
  if (!req.user) throw unauthorized();
  const membership = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: req.user.id } },
    include: {
      organization: { select: { status: true, deletedAt: true } },
      user: { select: { globalRole: true, disabledAt: true } },
    },
  });

  if (membership) {
    if (membership.user.disabledAt) throw forbidden('This account has been disabled');
    const isSuperadmin = (membership.user.globalRole as GlobalRole) === 'superadmin';
    if (membership.organization.deletedAt) throw forbidden('Not a member of this organization');
    if (membership.organization.status === 'disabled' && !isSuperadmin) {
      throw forbidden('This organization has been disabled');
    }
    if (isSuperadmin) return 'owner';
    if (!roleSatisfies(membership.role as OrgRole, minRole)) {
      throw forbidden(`Requires ${minRole} role`);
    }
    return membership.role as OrgRole;
  }

  // No membership: superadmins may still manage any existing organization.
  const user = await requireActiveUser(prisma, req);
  if ((user.globalRole as GlobalRole) === 'superadmin') {
    const org = await prisma.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
      select: { id: true },
    });
    if (org) return 'owner';
  }
  throw forbidden('Not a member of this organization');
}

/** preHandler factory: requires a valid, non-revoked device token. */
export function makeDeviceAuth(prisma: PrismaClient) {
  return async function authenticateDevice(req: FastifyRequest): Promise<void> {
    const header = req.headers.authorization;
    const queryToken = (req.query as Record<string, unknown> | undefined)?.token;
    const raw = header?.startsWith('Bearer ')
      ? header.slice(7)
      : typeof queryToken === 'string'
        ? queryToken
        : null;
    if (!raw) throw unauthorized('Missing device token');

    const tokenRecord = await prisma.deviceToken.findUnique({
      where: { tokenHash: hashDeviceToken(raw) },
      include: { device: true },
    });
    if (!tokenRecord || tokenRecord.revokedAt || tokenRecord.device.deletedAt) {
      throw unauthorized('Invalid or revoked device token');
    }

    // Touch lastUsedAt at most once a minute to avoid write amplification.
    if (!tokenRecord.lastUsedAt || Date.now() - tokenRecord.lastUsedAt.getTime() > 60_000) {
      await prisma.deviceToken.update({
        where: { id: tokenRecord.id },
        data: { lastUsedAt: new Date() },
      });
    }

    req.device = tokenRecord.device;
  };
}
