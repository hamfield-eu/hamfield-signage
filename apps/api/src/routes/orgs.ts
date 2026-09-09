import type { FastifyInstance } from 'fastify';
import {
  addMemberSchema,
  createOrgSchema,
  updateMemberSchema,
  updateOrgSchema,
} from '@signage/shared';
import { sanitizeFilename, validateLogoBuffer } from '@signage/media';
import { ORG_LOGO_MAX_BYTES } from '@signage/shared';
import { authenticateUser, requireOrgRole, requireSuperadmin } from '../plugins/auth';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { deleteFromS3, uploadBufferToS3 } from '../lib/s3';
import { orgLogoUrl, serializeMember, serializeOrg } from '../lib/serializers';

export async function orgRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;
  app.addHook('preHandler', authenticateUser);

  app.get('/orgs', async (req) => {
    const memberships = await prisma.organizationMember.findMany({
      where: { userId: req.user!.id, organization: { deletedAt: null } },
      include: { organization: true },
    });
    return Promise.all(
      memberships.map(async (m) =>
        serializeOrg(m.organization, m.role, { logoUrl: await orgLogoUrl(m.organization) }),
      ),
    );
  });

  // Self-service organization signup was removed in v2: only superadmins
  // create organizations (see also the /superadmin routes).
  app.post('/orgs', async (req, reply) => {
    await requireSuperadmin(prisma, req);
    const body = createOrgSchema.parse(req.body);
    const slug = `${body.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)}-${Math.random().toString(36).slice(2, 8)}`;
    const org = await prisma.organization.create({
      data: {
        name: body.name,
        slug,
        members: { create: { userId: req.user!.id, role: 'owner' } },
      },
    });
    await writeAudit(prisma, req, {
      action: 'organization.create',
      targetType: 'organization',
      targetId: org.id,
      organizationId: org.id,
      actorGlobalRole: 'superadmin',
      metadata: { name: org.name },
    });
    return reply.status(201).send(serializeOrg(org, 'owner'));
  });

  app.get<{ Params: { orgId: string } }>('/orgs/:orgId', async (req) => {
    const role = await requireOrgRole(prisma, req, req.params.orgId, 'viewer');
    const org = await prisma.organization.findFirst({
      where: { id: req.params.orgId, deletedAt: null },
    });
    if (!org) throw notFound('Organization not found');
    return serializeOrg(org, role, { logoUrl: await orgLogoUrl(org) });
  });

  app.patch<{ Params: { orgId: string } }>('/orgs/:orgId', async (req) => {
    const role = await requireOrgRole(prisma, req, req.params.orgId, 'admin');
    const body = updateOrgSchema.parse(req.body);
    const org = await prisma.organization.update({
      where: { id: req.params.orgId },
      data: { name: body.name },
    });
    return serializeOrg(org, role, { logoUrl: await orgLogoUrl(org) });
  });

  // ---------- Organization logo ----------
  // Branding changes require admin (or owner / superadmin via requireOrgRole).
  // The same route serves superadmins acting in any organization context.

  app.post<{ Params: { orgId: string } }>('/orgs/:orgId/logo', async (req, reply) => {
    const role = await requireOrgRole(prisma, req, req.params.orgId, 'admin');
    // Per-request limit, NOT the global MAX_UPLOAD_SIZE_BYTES (1 GiB by default).
    // toBuffer() below materialises the whole upload in API memory, and
    // validateLogoBuffer only enforces the 2 MB cap afterwards - so without this
    // any org admin could spike the API process by ~1 GiB. The stream is cut off
    // at the limit instead, and `truncated` turns that into a clean 400.
    //
    // The other multipart route, POST /orgs/:orgId/media, streams to a temp file
    // via pipeline() and is already correct; it is deliberately left alone.
    const file = await req.file({ limits: { fileSize: ORG_LOGO_MAX_BYTES } });
    if (!file) throw badRequest('No file uploaded (expected multipart field "file")');

    const buffer = await file.toBuffer();
    if (file.file.truncated) throw badRequest('Logo exceeds the maximum allowed upload size');

    // Validate by content — never trust the client MIME type or extension.
    const result = validateLogoBuffer(buffer);
    if (!result.ok) throw badRequest(result.error);

    const org = await prisma.organization.findFirst({
      where: { id: req.params.orgId, deletedAt: null },
    });
    if (!org) throw notFound('Organization not found');

    const previousKey = org.logoStorageKey;
    const storageKey = `orgs/${org.id}/branding/logo-${Date.now()}.${result.ext}`;
    await uploadBufferToS3(storageKey, buffer, result.mime);

    const updated = await prisma.organization.update({
      where: { id: org.id },
      data: {
        logoStorageKey: storageKey,
        logoMimeType: result.mime,
        logoOriginalFilename: file.filename ? sanitizeFilename(file.filename) : null,
        logoSizeBytes: buffer.length,
        logoUpdatedAt: new Date(),
      },
    });

    // Best-effort cleanup of the replaced object; never fail the request on it.
    if (previousKey && previousKey !== storageKey) {
      deleteFromS3(previousKey).catch((err) =>
        req.log.warn({ err, key: previousKey }, 'failed to delete previous org logo'),
      );
    }

    await writeAudit(prisma, req, {
      action: 'organization.logo.update',
      targetType: 'organization',
      targetId: org.id,
      organizationId: org.id,
      metadata: { mimeType: result.mime, sizeBytes: buffer.length },
    });
    req.log.info({ orgId: org.id, mime: result.mime }, 'org logo updated');
    return reply
      .status(200)
      .send(serializeOrg(updated, role, { logoUrl: await orgLogoUrl(updated) }));
  });

  app.delete<{ Params: { orgId: string } }>('/orgs/:orgId/logo', async (req) => {
    const role = await requireOrgRole(prisma, req, req.params.orgId, 'admin');
    const org = await prisma.organization.findFirst({
      where: { id: req.params.orgId, deletedAt: null },
    });
    if (!org) throw notFound('Organization not found');
    const previousKey = org.logoStorageKey;

    const updated = await prisma.organization.update({
      where: { id: org.id },
      data: {
        logoStorageKey: null,
        logoMimeType: null,
        logoOriginalFilename: null,
        logoSizeBytes: null,
        logoUpdatedAt: null,
      },
    });
    if (previousKey) {
      deleteFromS3(previousKey).catch((err) =>
        req.log.warn({ err, key: previousKey }, 'failed to delete org logo'),
      );
    }
    await writeAudit(prisma, req, {
      action: 'organization.logo.delete',
      targetType: 'organization',
      targetId: org.id,
      organizationId: org.id,
    });
    return serializeOrg(updated, role, { logoUrl: null });
  });

  app.get<{ Params: { orgId: string } }>('/orgs/:orgId/members', async (req) => {
    await requireOrgRole(prisma, req, req.params.orgId, 'viewer');
    const members = await prisma.organizationMember.findMany({
      where: { organizationId: req.params.orgId },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });
    return members.map(serializeMember);
  });

  app.post<{ Params: { orgId: string } }>('/orgs/:orgId/members', async (req, reply) => {
    await requireOrgRole(prisma, req, req.params.orgId, 'admin');
    const body = addMemberSchema.parse(req.body);
    if (body.role === 'owner')
      throw badRequest('Cannot grant the owner role; transfer ownership instead');

    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user)
      throw notFound('No user exists with this email — ask a superadmin to create the account');

    const existing = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: req.params.orgId, userId: user.id } },
    });
    if (existing) throw conflict('User is already a member');

    const member = await prisma.organizationMember.create({
      data: { organizationId: req.params.orgId, userId: user.id, role: body.role },
      include: { user: true },
    });
    req.log.info(
      { orgId: req.params.orgId, userId: user.id, role: body.role },
      'org: member added',
    );
    return reply.status(201).send(serializeMember(member));
  });

  app.patch<{ Params: { orgId: string; memberId: string } }>(
    '/orgs/:orgId/members/:memberId',
    async (req) => {
      const actorRole = await requireOrgRole(prisma, req, req.params.orgId, 'admin');
      const body = updateMemberSchema.parse(req.body);

      const member = await prisma.organizationMember.findFirst({
        where: { id: req.params.memberId, organizationId: req.params.orgId },
        include: { user: true },
      });
      if (!member) throw notFound('Member not found');
      if (member.role === 'owner') throw forbidden('Cannot change the owner role');
      if (body.role === 'owner' && actorRole !== 'owner') {
        throw forbidden('Only the owner can transfer ownership');
      }

      const updated = await prisma.organizationMember.update({
        where: { id: member.id },
        data: { role: body.role },
        include: { user: true },
      });
      return serializeMember(updated);
    },
  );

  app.delete<{ Params: { orgId: string; memberId: string } }>(
    '/orgs/:orgId/members/:memberId',
    async (req, reply) => {
      await requireOrgRole(prisma, req, req.params.orgId, 'admin');
      const member = await prisma.organizationMember.findFirst({
        where: { id: req.params.memberId, organizationId: req.params.orgId },
      });
      if (!member) throw notFound('Member not found');
      if (member.role === 'owner') throw forbidden('Cannot remove the owner');
      await prisma.organizationMember.delete({ where: { id: member.id } });
      return reply.status(204).send();
    },
  );
}
