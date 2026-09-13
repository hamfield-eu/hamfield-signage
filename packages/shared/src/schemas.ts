import { z } from 'zod';
import {
  COMMAND_TYPES,
  DEVICE_ORIENTATIONS,
  DEVICE_ROTATIONS,
  FIT_MODES,
  LOG_LEVELS,
  ORG_ROLES,
  ORG_STATUSES,
  PLAYBACK_EVENT_TYPES,
  PLAYBACK_ORDER_MODES,
  PLAYBACK_PROFILES,
  PLAYED_AS_VALUES,
  POSITION_MODES,
  PRIORITY_SELECTION_MODES,
} from './enums';
import { normalizeHexColor } from './display';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `#RGB` / `#RRGGBB` hex color, normalized to lowercase `#rrggbb`. */
export const hexColorSchema = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => normalizeHexColor(v) !== null, {
    message: 'Must be a hex color like #000000 or #fff',
  })
  .transform((v) => normalizeHexColor(v)!);

export const timezoneSchema = z.string().min(1).max(64).refine(isValidTimezone, {
  message: 'Invalid IANA timezone',
});

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------- Auth ----------
// Public registration was removed in v2: accounts are created by a
// superadmin (or organization admins for their own organization).

export const passwordSchema = z.string().min(8).max(128);

/** Stronger requirement for superadmin accounts. */
export const superadminPasswordSchema = z.string().min(12).max(128);

export const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(128),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

// ---------- Organizations ----------
export const createOrgSchema = z.object({
  name: z.string().min(1).max(100),
});

export const updateOrgSchema = z.object({
  name: z.string().min(1).max(100).optional(),
});

export const addMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(ORG_ROLES),
});

export const updateMemberSchema = z.object({
  role: z.enum(ORG_ROLES),
});

// ---------- Devices ----------
/** Accepts the discrete rotation steps (0/90/180/270) as a precise literal union. */
export const rotationSchema = z.union(
  DEVICE_ROTATIONS.map((r) => z.literal(r)) as [
    z.ZodLiteral<0>,
    z.ZodLiteral<90>,
    z.ZodLiteral<180>,
    z.ZodLiteral<270>,
  ],
);

export const createDeviceSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  orientation: z.enum(DEVICE_ORIENTATIONS).default('landscape'),
  rotation: rotationSchema.default(0),
  timezone: timezoneSchema.default('UTC'),
  playbackProfile: z.enum(PLAYBACK_PROFILES).default('standard'),
  groupIds: z.array(z.string()).optional(),
});

export const updateDeviceSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  orientation: z.enum(DEVICE_ORIENTATIONS).optional(),
  rotation: rotationSchema.optional(),
  timezone: timezoneSchema.optional(),
  playbackProfile: z.enum(PLAYBACK_PROFILES).optional(),
  defaultPlaylistId: z.string().nullable().optional(),
  groupIds: z.array(z.string()).optional(),
});

export const createDeviceGroupSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  deviceIds: z.array(z.string()).optional(),
});

export const updateDeviceGroupSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  deviceIds: z.array(z.string()).optional(),
});

export const issueCommandSchema = z.object({
  type: z.enum(COMMAND_TYPES),
  payload: z.record(z.unknown()).default({}),
});

// ---------- Media folders ----------
export const createFolderSchema = z.object({
  name: z.string().min(1).max(120),
  parentFolderId: z.string().nullable().optional(),
});

export const updateFolderSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  /** null moves the folder to the root. */
  parentFolderId: z.string().nullable().optional(),
});

export const deleteFolderSchema = z.object({
  /** What to do with media inside the folder (and its subfolders). */
  strategy: z.enum(['move_to_root', 'move_to_folder', 'delete_media']),
  targetFolderId: z.string().optional(),
});

// ---------- Media ----------
export const updateMediaSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  /** null moves the media to the root folder. */
  folderId: z.string().nullable().optional(),
});

export const mediaListQuerySchema = z.object({
  type: z.enum(['image', 'video']).optional(),
  orientation: z.enum(['landscape', 'portrait', 'square']).optional(),
  status: z.enum(['pending', 'processing', 'ready', 'failed']).optional(),
  search: z.string().max(255).optional(),
  /** 'root' = unfiled media only; folder id = that folder; omitted = all media. */
  folderId: z.string().max(64).optional(),
  usedInPlaylist: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  sort: z
    .enum(['name', 'createdAt', 'updatedAt', 'type', 'orientation', 'duration', 'playCount'])
    .default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export const bulkMoveMediaSchema = z.object({
  mediaIds: z.array(z.string().min(1)).min(1).max(500),
  /** null moves to the root folder. */
  folderId: z.string().nullable(),
});

export const bulkDeleteMediaSchema = z.object({
  mediaIds: z.array(z.string().min(1)).min(1).max(500),
});

// ---------- Playlists ----------
export const playlistItemInputSchema = z
  .object({
    type: z.enum(['media', 'folder']).default('media'),
    mediaAssetId: z.string().min(1).nullable().optional(),
    folderId: z.string().min(1).nullable().optional(),
    durationSeconds: z.number().min(1).max(86400).nullable().optional(),
    fitMode: z.enum(FIT_MODES).nullable().optional(),
    backgroundColor: hexColorSchema.nullable().optional(),
    positionMode: z.enum(POSITION_MODES).nullable().optional(),
    enabled: z.boolean().default(true),
    includeSubfolders: z.boolean().default(false),
    filterMediaType: z.enum(['image', 'video']).nullable().optional(),
    filterOrientation: z.enum(['landscape', 'portrait', 'square']).nullable().optional(),
  })
  .refine((item) => (item.type === 'media' ? Boolean(item.mediaAssetId) : true), {
    message: 'media items require mediaAssetId',
  })
  .refine((item) => (item.type === 'folder' ? Boolean(item.folderId) : true), {
    message: 'folder items require folderId',
  });

export const createPlaylistSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  loop: z.boolean().default(true),
  defaultImageDurationSeconds: z.number().int().min(1).max(86400).default(10),
  playbackOrderMode: z.enum(PLAYBACK_ORDER_MODES).default('manual_order'),
  defaultFitMode: z.enum(FIT_MODES).nullable().optional(),
  defaultBackgroundColor: hexColorSchema.nullable().optional(),
  defaultPositionMode: z.enum(POSITION_MODES).nullable().optional(),
  items: z.array(playlistItemInputSchema).optional(),
});

export const updatePlaylistSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  loop: z.boolean().optional(),
  defaultImageDurationSeconds: z.number().int().min(1).max(86400).optional(),
  playbackOrderMode: z.enum(PLAYBACK_ORDER_MODES).optional(),
  defaultFitMode: z.enum(FIT_MODES).nullable().optional(),
  defaultBackgroundColor: hexColorSchema.nullable().optional(),
  defaultPositionMode: z.enum(POSITION_MODES).nullable().optional(),
});

export const replacePlaylistItemsSchema = z.object({
  items: z.array(playlistItemInputSchema),
});

export const clonePlaylistSchema = z.object({
  name: z.string().min(1).max(100).optional(),
});

// ---------- Playlist priority rules ----------
export const priorityRuleAssignmentInputSchema = z
  .object({
    mediaAssetId: z.string().min(1).nullable().optional(),
    folderId: z.string().min(1).nullable().optional(),
    includeSubfolders: z.boolean().default(false),
  })
  .refine((a) => Boolean(a.mediaAssetId) !== Boolean(a.folderId), {
    message: 'Provide exactly one of mediaAssetId or folderId',
  });

export const createPriorityRuleSchema = z.object({
  name: z.string().min(1).max(100),
  intervalCount: z.number().int().min(1).max(1000),
  selectionMode: z.enum(PRIORITY_SELECTION_MODES).default('rotate'),
  enabled: z.boolean().default(true),
  position: z.number().int().min(0).optional(),
  assignments: z.array(priorityRuleAssignmentInputSchema).max(200).optional(),
});

export const updatePriorityRuleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  intervalCount: z.number().int().min(1).max(1000).optional(),
  selectionMode: z.enum(PRIORITY_SELECTION_MODES).optional(),
  enabled: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
});

export const replacePriorityRuleAssignmentsSchema = z.object({
  assignments: z.array(priorityRuleAssignmentInputSchema).max(200),
});

// ---------- Superadmin ----------
export const superadminCreateOrgSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
  status: z.enum(ORG_STATUSES).default('active'),
  planName: z.string().max(100).nullable().optional(),
  maxDevices: z.number().int().min(0).nullable().optional(),
  maxStorageGb: z.number().int().min(0).nullable().optional(),
});

export const superadminUpdateOrgSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  status: z.enum(ORG_STATUSES).optional(),
  planName: z.string().max(100).nullable().optional(),
  maxDevices: z.number().int().min(0).nullable().optional(),
  maxStorageGb: z.number().int().min(0).nullable().optional(),
});

export const superadminCreateUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().max(255),
  password: passwordSchema,
  mustChangePassword: z.boolean().default(true),
  memberships: z
    .array(
      z.object({
        organizationId: z.string().min(1),
        role: z.enum(ORG_ROLES),
      }),
    )
    .max(50)
    .default([]),
});

export const superadminUpdateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  disabled: z.boolean().optional(),
});

export const superadminResetPasswordSchema = z.object({
  password: passwordSchema,
  mustChangePassword: z.boolean().default(true),
});

export const superadminAddMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(ORG_ROLES),
});

export const superadminUpdateMemberSchema = z.object({
  role: z.enum(ORG_ROLES),
});

// ---------- Schedules ----------
export const scheduleBaseSchema = z.object({
  name: z.string().min(1).max(100),
  playlistId: z.string().min(1),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(1000).default(0),
  startDate: z.string().regex(DATE_RE).nullable().optional(),
  endDate: z.string().regex(DATE_RE).nullable().optional(),
  daysOfWeek: z.array(z.number().int().min(1).max(7)).max(7).default([]),
  startTime: z.string().regex(TIME_RE).nullable().optional(),
  endTime: z.string().regex(TIME_RE).nullable().optional(),
  timezone: timezoneSchema.nullable().optional(),
  deviceIds: z.array(z.string()).default([]),
  groupIds: z.array(z.string()).default([]),
});

export const createScheduleSchema = scheduleBaseSchema.refine(
  (s) => (s.startTime == null) === (s.endTime == null),
  { message: 'startTime and endTime must both be set or both be empty' },
);

export const updateScheduleSchema = scheduleBaseSchema.partial();

export const schedulePreviewQuerySchema = z.object({
  deviceId: z.string().min(1),
  at: z.string().datetime({ offset: true }).optional(),
});

// ---------- Emergency override ----------
export const startEmergencySchema = z
  .object({
    name: z.string().max(200).optional(),
    playlistId: z.string().optional(),
    mediaAssetId: z.string().optional(),
    appliesToAll: z.boolean().default(false),
    deviceIds: z.array(z.string()).default([]),
    groupIds: z.array(z.string()).default([]),
    // Display settings apply only to single-media overrides; playlist overrides
    // use the playlist's own item/default display settings.
    fitMode: z.enum(FIT_MODES).nullable().optional(),
    backgroundColor: hexColorSchema.nullable().optional(),
    positionMode: z.enum(POSITION_MODES).nullable().optional(),
  })
  .refine((v) => Boolean(v.playlistId) !== Boolean(v.mediaAssetId), {
    message: 'Provide exactly one of playlistId or mediaAssetId',
  })
  .refine((v) => v.appliesToAll || v.deviceIds.length > 0 || v.groupIds.length > 0, {
    message: 'Select at least one device or group, or set appliesToAll',
  });

// ---------- Device APIs ----------
export const pairRequestSchema = z.object({
  pairingCode: z.string().min(4).max(16),
  hardware: z
    .object({
      model: z.string().max(200).optional(),
      os: z.string().max(200).optional(),
      arch: z.string().max(50).optional(),
      appVersion: z.string().max(50).optional(),
    })
    .optional(),
});

export const heartbeatSchema = z.object({
  appVersion: z.string().max(50).optional(),
  osInfo: z.string().max(200).optional(),
  archInfo: z.string().max(50).optional(),
  /** Board model (e.g. from /proc/device-tree/model) for tier auto-suggestion. */
  deviceModel: z.string().max(200).nullable().optional(),
  uptimeSeconds: z.number().optional(),
  cpuPercent: z.number().optional(),
  memUsedBytes: z.number().optional(),
  memTotalBytes: z.number().optional(),
  diskFreeBytes: z.number().optional(),
  diskTotalBytes: z.number().optional(),
  cacheUsedBytes: z.number().optional(),
  screenWidth: z.number().int().optional(),
  screenHeight: z.number().int().optional(),
  networkType: z.string().max(50).optional(),
  currentPlaylistId: z.string().nullable().optional(),
  currentMediaId: z.string().nullable().optional(),
  manifestVersion: z.string().nullable().optional(),
  lastError: z.string().max(2000).nullable().optional(),
  /** Cache guard state (T017); absent from older agents. */
  cacheBudgetBytes: z.number().nonnegative().optional(),
  cachedFileCount: z.number().int().nonnegative().optional(),
  lastIntegrityCheckAt: z.string().datetime({ offset: true }).nullable().optional(),
  integrityFailureCount: z.number().int().nonnegative().optional(),
  orphanFilesRemoved: z.number().int().nonnegative().optional(),
});

export const syncStatusSchema = z.object({
  manifestVersion: z.string(),
  status: z.enum(['applied', 'failed', 'downloading', 'insufficient_storage']),
  error: z.string().max(2000).optional(),
  cachedMediaIds: z.array(z.string()).optional(),
  cacheUsedBytes: z.number().optional(),
  /**
   * Storage accounting, sent with `insufficient_storage` so the dashboard can
   * state the shortfall in plain language instead of showing a bare status.
   * All optional: an older agent sends none of them.
   */
  requiredBytes: z.number().nonnegative().optional(),
  availableBytes: z.number().nonnegative().optional(),
  reclaimableBytes: z.number().nonnegative().optional(),
  cacheBudgetBytes: z.number().nonnegative().optional(),
  shortfallBytes: z.number().nonnegative().optional(),
});

export const deviceLogsSchema = z.object({
  logs: z
    .array(
      z.object({
        level: z.enum(LOG_LEVELS),
        message: z.string().max(4000),
        context: z.record(z.unknown()).optional(),
        loggedAt: z.string().datetime({ offset: true }),
      }),
    )
    .max(500),
});

export const playbackEventsSchema = z.object({
  events: z
    .array(
      z.object({
        eventType: z.enum(PLAYBACK_EVENT_TYPES),
        mediaAssetId: z.string().nullable().optional(),
        playlistId: z.string().nullable().optional(),
        /** Client-generated id; resubmitted batches are deduplicated on it. */
        clientEventId: z.string().max(64).nullable().optional(),
        priorityRuleId: z.string().nullable().optional(),
        playedAs: z.enum(PLAYED_AS_VALUES).nullable().optional(),
        durationSeconds: z.number().min(0).nullable().optional(),
        detail: z.record(z.unknown()).optional(),
        occurredAt: z.string().datetime({ offset: true }),
      }),
    )
    .max(500),
});

export const commandResultSchema = z.object({
  status: z.enum(['completed', 'failed']),
  result: z.record(z.unknown()).optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateDeviceInput = z.infer<typeof createDeviceSchema>;
export type UpdateDeviceInput = z.infer<typeof updateDeviceSchema>;
export type CreatePlaylistInput = z.infer<typeof createPlaylistSchema>;
export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;
export type StartEmergencyInput = z.infer<typeof startEmergencySchema>;
export type PairRequestInput = z.infer<typeof pairRequestSchema>;
export type HeartbeatInput = z.infer<typeof heartbeatSchema>;
export type IssueCommandInput = z.infer<typeof issueCommandSchema>;
