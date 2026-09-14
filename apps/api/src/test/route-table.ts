import type { FastifyInstance } from 'fastify';
import { FIXTURE_PASSWORD, type InjectMethod, type SeedRole, type SeededOrg } from './helpers';

/**
 * The route table — one row per registered route, shared by the authorization
 * matrix and the cross-tenant suite.
 *
 * Keeping it in one place is what lets `registeredRoutes()` prove the table is
 * complete: a route added without a row here fails the completeness test rather
 * than silently going untested.
 */

export type Access = SeedRole | 'superadmin' | 'authenticated';

export interface RouteSpec {
  method: InjectMethod;
  /** `org` supplies the resource ids; `orgId` is the id in the URL. */
  url: (org: SeededOrg, orgId: string) => string;
  access: Access;
  body?: (org: SeededOrg) => Record<string, unknown>;
  /**
   * Route pattern for the test name and the completeness check, when the
   * placeholder fixture cannot produce it — the org and superadmin member
   * routes name the same id `:memberId` and `:membershipId` respectively.
   */
  pattern?: string;
  /** Why an allowed caller may legitimately not reach a 2xx here. */
  note?: string;
}

export const ROLE_RANK: Record<SeedRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export const ORG_ROUTES: RouteSpec[] = [
  // ---------------------------------------------------------- device groups
  { method: 'GET', url: (_o, id) => `/orgs/${id}/device-groups`, access: 'viewer' },
  {
    method: 'POST',
    url: (_o, id) => `/orgs/${id}/device-groups`,
    access: 'editor',
    body: () => ({ name: 'New group' }),
  },
  { method: 'GET', url: (o, id) => `/orgs/${id}/device-groups/${o.groupId}`, access: 'viewer' },
  {
    method: 'PATCH',
    url: (o, id) => `/orgs/${id}/device-groups/${o.groupId}`,
    access: 'editor',
    body: () => ({ name: 'Renamed' }),
  },
  { method: 'DELETE', url: (o, id) => `/orgs/${id}/device-groups/${o.groupId}`, access: 'editor' },

  // --------------------------------------------------------------- devices
  { method: 'GET', url: (_o, id) => `/orgs/${id}/devices`, access: 'viewer' },
  {
    method: 'POST',
    url: (_o, id) => `/orgs/${id}/devices`,
    access: 'editor',
    body: () => ({ name: 'New screen' }),
  },
  { method: 'GET', url: (o, id) => `/orgs/${id}/devices/${o.deviceId}`, access: 'viewer' },
  {
    method: 'PATCH',
    url: (o, id) => `/orgs/${id}/devices/${o.deviceId}`,
    access: 'editor',
    body: () => ({ name: 'Renamed screen' }),
  },
  { method: 'DELETE', url: (o, id) => `/orgs/${id}/devices/${o.deviceId}`, access: 'admin' },
  {
    method: 'POST',
    url: (o, id) => `/orgs/${id}/devices/${o.deviceId}/regenerate-pairing-code`,
    access: 'editor',
  },
  {
    method: 'POST',
    url: (o, id) => `/orgs/${id}/devices/${o.deviceId}/revoke-token`,
    access: 'admin',
  },
  {
    method: 'POST',
    url: (o, id) => `/orgs/${id}/devices/${o.deviceId}/commands`,
    access: 'editor',
    body: () => ({ type: 'identify' }),
  },
  { method: 'GET', url: (o, id) => `/orgs/${id}/devices/${o.deviceId}/commands`, access: 'viewer' },
  { method: 'GET', url: (o, id) => `/orgs/${id}/devices/${o.deviceId}/logs`, access: 'viewer' },
  {
    method: 'GET',
    url: (o, id) => `/orgs/${id}/devices/${o.deviceId}/heartbeats`,
    access: 'viewer',
  },
  {
    method: 'GET',
    url: (o, id) => `/orgs/${id}/devices/${o.deviceId}/playback-events`,
    access: 'viewer',
  },
  {
    method: 'GET',
    url: (o, id) => `/orgs/${id}/devices/${o.deviceId}/screenshot`,
    access: 'viewer',
    note: '404 when the device has never uploaded one',
  },

  // ------------------------------------------------------------- emergency
  { method: 'GET', url: (_o, id) => `/orgs/${id}/emergency`, access: 'viewer' },
  {
    method: 'POST',
    url: (o, id) => `/orgs/${id}/emergency`,
    access: 'admin',
    body: (o) => ({ playlistId: o.playlistId, appliesToAll: true }),
  },
  {
    method: 'POST',
    url: (o, id) => `/orgs/${id}/emergency/${o.overrideId}/stop`,
    access: 'admin',
    note: 'the seeded override is already stopped',
  },

  // ---------------------------------------------------------- media folders
  { method: 'GET', url: (_o, id) => `/orgs/${id}/media/folders`, access: 'viewer' },
  {
    method: 'POST',
    url: (_o, id) => `/orgs/${id}/media/folders`,
    access: 'editor',
    body: () => ({ name: 'New folder' }),
  },
  {
    method: 'PATCH',
    url: (o, id) => `/orgs/${id}/media/folders/${o.folderId}`,
    access: 'editor',
    body: () => ({ name: 'Renamed folder' }),
  },
  {
    method: 'GET',
    url: (o, id) => `/orgs/${id}/media/folders/${o.folderId}/usage`,
    access: 'viewer',
  },
  { method: 'DELETE', url: (o, id) => `/orgs/${id}/media/folders/${o.folderId}`, access: 'editor' },

  // ----------------------------------------------------------------- media
  {
    method: 'POST',
    url: (_o, id) => `/orgs/${id}/media`,
    access: 'editor',
    note: 'multipart upload; without a file body it fails validation after the role check',
  },
  { method: 'GET', url: (_o, id) => `/orgs/${id}/media`, access: 'viewer' },
  { method: 'GET', url: (o, id) => `/orgs/${id}/media/${o.mediaId}`, access: 'viewer' },
  {
    method: 'PATCH',
    url: (o, id) => `/orgs/${id}/media/${o.mediaId}`,
    access: 'editor',
    body: () => ({ name: 'Renamed media' }),
  },
  {
    method: 'POST',
    url: (o, id) => `/orgs/${id}/media/bulk-move`,
    access: 'editor',
    body: (o) => ({ mediaIds: [o.mediaId], folderId: null }),
  },
  { method: 'GET', url: (o, id) => `/orgs/${id}/media/${o.mediaId}/usage`, access: 'viewer' },
  {
    method: 'GET',
    url: (o, id) => `/orgs/${id}/media/${o.mediaId}/playback-stats`,
    access: 'viewer',
  },
  { method: 'DELETE', url: (o, id) => `/orgs/${id}/media/${o.mediaId}`, access: 'editor' },
  {
    method: 'POST',
    url: (o, id) => `/orgs/${id}/media/bulk-delete`,
    access: 'editor',
    body: (o) => ({ mediaIds: [o.mediaId] }),
  },
  {
    method: 'POST',
    url: (o, id) => `/orgs/${id}/media/${o.mediaId}/reprocess`,
    access: 'editor',
  },

  // ------------------------------------------------------------------ orgs
  { method: 'GET', url: (_o, id) => `/orgs/${id}`, access: 'viewer' },
  {
    method: 'PATCH',
    url: (_o, id) => `/orgs/${id}`,
    access: 'admin',
    body: () => ({ name: 'Renamed org' }),
  },
  {
    method: 'POST',
    url: (_o, id) => `/orgs/${id}/logo`,
    access: 'admin',
    note: 'multipart upload',
  },
  { method: 'DELETE', url: (_o, id) => `/orgs/${id}/logo`, access: 'admin' },
  { method: 'GET', url: (_o, id) => `/orgs/${id}/members`, access: 'viewer' },
  {
    method: 'POST',
    url: (_o, id) => `/orgs/${id}/members`,
    access: 'admin',
    body: () => ({ email: 'newcomer@a.test', role: 'viewer' }),
  },
  {
    method: 'PATCH',
    url: (o, id) => `/orgs/${id}/members/${o.membershipId}`,
    pattern: '/orgs/:orgId/members/:memberId',
    access: 'admin',
    body: () => ({ role: 'editor' }),
  },
  {
    method: 'DELETE',
    url: (o, id) => `/orgs/${id}/members/${o.membershipId}`,
    pattern: '/orgs/:orgId/members/:memberId',
    access: 'admin',
  },

  // ------------------------------------------------------------- playlists
  { method: 'GET', url: (_o, id) => `/orgs/${id}/playlists`, access: 'viewer' },
  {
    method: 'POST',
    url: (_o, id) => `/orgs/${id}/playlists`,
    access: 'editor',
    body: () => ({ name: 'New playlist' }),
  },
  { method: 'GET', url: (o, id) => `/orgs/${id}/playlists/${o.playlistId}`, access: 'viewer' },
  {
    method: 'PATCH',
    url: (o, id) => `/orgs/${id}/playlists/${o.playlistId}`,
    access: 'editor',
    body: () => ({ name: 'Renamed playlist' }),
  },
  {
    method: 'PUT',
    url: (o, id) => `/orgs/${id}/playlists/${o.playlistId}/items`,
    access: 'editor',
    body: () => ({ items: [] }),
  },
  { method: 'DELETE', url: (o, id) => `/orgs/${id}/playlists/${o.playlistId}`, access: 'editor' },
  {
    method: 'POST',
    url: (o, id) => `/orgs/${id}/playlists/${o.playlistId}/clone`,
    access: 'editor',
    body: () => ({ name: 'Cloned playlist' }),
  },
  {
    method: 'GET',
    url: (o, id) => `/orgs/${id}/playlists/${o.playlistId}/resolved-preview`,
    access: 'viewer',
  },

  // -------------------------------------------------------- priority rules
  {
    method: 'GET',
    url: (o, id) => `/orgs/${id}/playlists/${o.playlistId}/priority-rules`,
    access: 'viewer',
  },
  {
    method: 'POST',
    url: (o, id) => `/orgs/${id}/playlists/${o.playlistId}/priority-rules`,
    access: 'editor',
    body: () => ({ name: 'Rule', intervalCount: 3 }),
  },
  {
    method: 'PATCH',
    url: (o, id) => `/orgs/${id}/playlists/${o.playlistId}/priority-rules/${o.priorityRuleId}`,
    access: 'editor',
    body: () => ({ name: 'Renamed rule' }),
  },
  {
    method: 'DELETE',
    url: (o, id) => `/orgs/${id}/playlists/${o.playlistId}/priority-rules/${o.priorityRuleId}`,
    access: 'editor',
  },
  {
    method: 'PUT',
    url: (o, id) =>
      `/orgs/${id}/playlists/${o.playlistId}/priority-rules/${o.priorityRuleId}/assignments`,
    access: 'editor',
    body: () => ({ assignments: [] }),
  },

  // ------------------------------------------------------------- schedules
  { method: 'GET', url: (_o, id) => `/orgs/${id}/schedules`, access: 'viewer' },
  {
    method: 'POST',
    url: (o, id) => `/orgs/${id}/schedules`,
    access: 'editor',
    body: (o) => ({ name: 'New schedule', playlistId: o.playlistId, daysOfWeek: [1] }),
  },
  { method: 'GET', url: (_o, id) => `/orgs/${id}/schedules/preview`, access: 'viewer' },
  { method: 'GET', url: (o, id) => `/orgs/${id}/schedules/${o.scheduleId}`, access: 'viewer' },
  {
    method: 'PATCH',
    url: (o, id) => `/orgs/${id}/schedules/${o.scheduleId}`,
    access: 'editor',
    body: () => ({ name: 'Renamed schedule' }),
  },
  { method: 'DELETE', url: (o, id) => `/orgs/${id}/schedules/${o.scheduleId}`, access: 'editor' },
];

export const SUPERADMIN_ROUTES: RouteSpec[] = [
  { method: 'GET', url: () => '/orgs', access: 'authenticated' },
  {
    method: 'POST',
    url: () => '/orgs',
    access: 'superadmin',
    body: () => ({ name: 'Brand new org', slug: 'brand-new-org' }),
  },
  { method: 'GET', url: () => '/superadmin/organizations', access: 'superadmin' },
  {
    method: 'POST',
    url: () => '/superadmin/organizations',
    access: 'superadmin',
    body: () => ({ name: 'Another org', slug: 'another-org' }),
  },
  {
    method: 'PATCH',
    url: (o) => `/superadmin/organizations/${o.id}`,
    access: 'superadmin',
    body: () => ({ name: 'Renamed by root' }),
  },
  { method: 'GET', url: () => '/superadmin/users', access: 'superadmin' },
  {
    method: 'POST',
    url: () => '/superadmin/users',
    access: 'superadmin',
    body: () => ({ email: 'fresh@platform.test', name: 'Fresh', password: 'hunter2-hunter2' }),
  },
  {
    method: 'PATCH',
    url: (o) => `/superadmin/users/${o.users.viewer.id}`,
    access: 'superadmin',
    body: () => ({ name: 'Renamed by root' }),
  },
  {
    method: 'POST',
    url: (o) => `/superadmin/users/${o.users.viewer.id}/reset-password`,
    access: 'superadmin',
    body: () => ({ password: 'brand-new-password' }),
  },
  {
    method: 'POST',
    url: (o) => `/superadmin/organizations/${o.id}/members`,
    access: 'superadmin',
    body: (o) => ({ userId: o.users.viewer.id, role: 'editor' }),
  },
  {
    method: 'PATCH',
    url: (o) => `/superadmin/organizations/${o.id}/members/${o.membershipId}`,
    access: 'superadmin',
    body: () => ({ role: 'admin' }),
  },
  {
    method: 'DELETE',
    url: (o) => `/superadmin/organizations/${o.id}/members/${o.membershipId}`,
    access: 'superadmin',
  },
  {
    method: 'GET',
    url: () => '/superadmin/platform-health',
    access: 'superadmin',
    note: 'probes S3, which this suite does not stand up; the probe is bounded at 2s',
  },
  { method: 'GET', url: () => '/superadmin/audit-logs', access: 'superadmin' },
];

export const AUTH_ROUTES: RouteSpec[] = [
  { method: 'GET', url: () => '/auth/me', access: 'authenticated' },
  { method: 'GET', url: () => '/auth/mfa/recovery-codes', access: 'authenticated' },
  { method: 'POST', url: () => '/auth/mfa/setup', access: 'authenticated' },
  {
    // Answers 400 for a caller who has not run /setup, which every fixture user
    // is - correct behaviour, but indistinguishable from an authorization pass
    // at this matrix's resolution.
    method: 'POST',
    url: () => '/auth/mfa/enable',
    access: 'authenticated',
    body: () => ({ code: '000000' }),
    note: 'no enrollment in progress for fixture users, so an allowed caller still gets 400',
  },
  {
    method: 'POST',
    url: () => '/auth/mfa/disable',
    access: 'authenticated',
    body: () => ({ password: FIXTURE_PASSWORD }),
  },
  {
    // The current password must be the real one: this route answers a wrong
    // one with 401, which is correct behaviour but indistinguishable from
    // "not authenticated" at the matrix's resolution.
    method: 'POST',
    url: () => '/auth/change-password',
    access: 'authenticated',
    body: () => ({ currentPassword: FIXTURE_PASSWORD, newPassword: 'another-password-12' }),
  },
];

export const pattern = (r: RouteSpec) => r.pattern ?? r.url(SPEC_PLACEHOLDER, ':orgId');
export const label = (r: RouteSpec) => `${r.method} ${pattern(r)}`;

/** Renders the table's URL templates for test names, without a live fixture. */
export const SPEC_PLACEHOLDER = {
  id: ':orgId',
  groupId: ':groupId',
  deviceId: ':deviceId',
  folderId: ':folderId',
  mediaId: ':mediaId',
  playlistId: ':playlistId',
  priorityRuleId: ':ruleId',
  scheduleId: ':scheduleId',
  overrideId: ':overrideId',
  membershipId: ':membershipId',
  users: { viewer: { id: ':userId' } },
} as unknown as SeededOrg;

export const DENIED = [401, 403];
export const isDenied = (status: number) => DENIED.includes(status);

/**
 * Every route the server actually has, as "METHOD /full/path".
 *
 * Fastify exposes its route table only as a printed tree, in which each line
 * carries one path *fragment* indented four columns per level — so a full path
 * is the fragments along its branch, concatenated (`/device/sync` + `-status`).
 * Reconstructing it here is what lets the matrix prove it is complete instead of
 * merely claiming it.
 */
export function registeredRoutes(app: FastifyInstance): string[] {
  const stack: string[] = [];
  const routes: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const connector = line.search(/[├└]── /);
    if (connector < 0) continue;
    const depth = connector / 4;
    const rest = line.slice(connector + 4);
    const withMethods = /^(.*) \(([A-Z, ]+)\)$/.exec(rest);
    stack[depth] = withMethods ? withMethods[1] : rest;
    stack.length = depth + 1;
    if (!withMethods) continue;
    const path = stack.join('');
    for (const method of withMethods[2].split(', ')) routes.push(`${method} ${path}`);
  }
  return routes;
}
