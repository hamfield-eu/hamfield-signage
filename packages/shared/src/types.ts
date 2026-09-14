import type {
  CommandStatus,
  CommandType,
  DeviceOrientation,
  DeviceRotation,
  FitMode,
  GlobalRole,
  MediaOrientation,
  MediaType,
  OrgRole,
  OrgStatus,
  PlaybackEventType,
  PlaybackOrderMode,
  PlaybackProfile,
  PlayedAs,
  PlaylistItemType,
  PositionMode,
  PrioritySelectionMode,
  ProcessingStatus,
  SyncStatus,
} from './enums';

export interface UserDto {
  id: string;
  email: string;
  name: string;
  globalRole: GlobalRole;
  mustChangePassword: boolean;
  /** True once the user has confirmed an authenticator app (MFA is active). */
  mfaEnabled: boolean;
  disabledAt?: string | null;
  createdAt: string;
}

export interface OrganizationDto {
  id: string;
  name: string;
  slug: string;
  status: OrgStatus;
  planName?: string | null;
  maxDevices?: number | null;
  maxStorageGb?: number | null;
  role?: OrgRole;
  /** Short-lived URL for the organization logo, or null when none is set. */
  logoUrl?: string | null;
  logoMimeType?: string | null;
  logoUpdatedAt?: string | null;
  createdAt: string;
}

export interface OrganizationMemberDto {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: OrgRole;
  createdAt: string;
}

export interface DeviceMetrics {
  uptimeSeconds?: number | null;
  cpuPercent?: number | null;
  memUsedBytes?: number | null;
  memTotalBytes?: number | null;
  diskFreeBytes?: number | null;
  diskTotalBytes?: number | null;
  cacheUsedBytes?: number | null;
  /** Cache guard state (T017); absent on devices running an older agent. */
  cacheBudgetBytes?: number | null;
  cachedFileCount?: number | null;
  lastIntegrityCheckAt?: string | null;
  /** How much more room the device needs; null once it syncs successfully. */
  storageShortfallBytes?: number | null;
  screenWidth?: number | null;
  screenHeight?: number | null;
  networkType?: string | null;
}

export interface DeviceDto {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  orientation: DeviceOrientation;
  /** Software rotation (clockwise degrees) to compensate for physical mounting. */
  rotation: DeviceRotation;
  timezone: string;
  /** Video quality tier served to this device. */
  playbackProfile: PlaybackProfile;
  online: boolean;
  paired: boolean;
  pairingCode: string | null;
  pairingCodeExpiresAt: string | null;
  lastSeenAt: string | null;
  lastIp: string | null;
  appVersion: string | null;
  osInfo: string | null;
  archInfo: string | null;
  /** Reported board model, used to auto-suggest a playback tier. */
  deviceModel: string | null;
  syncStatus: SyncStatus;
  lastSyncAt: string | null;
  manifestVersion: string | null;
  currentPlaylistId: string | null;
  currentPlaylistName?: string | null;
  currentMediaId: string | null;
  currentMediaName?: string | null;
  defaultPlaylistId: string | null;
  metrics: DeviceMetrics;
  lastError: string | null;
  groupIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DeviceGroupDto {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  deviceCount: number;
  createdAt: string;
}

export interface MediaFolderDto {
  id: string;
  organizationId: string;
  parentFolderId: string | null;
  name: string;
  /** Human-readable path computed from parent relationships, e.g. "Campaigns / Summer". */
  path: string;
  mediaCount?: number;
  subfolderCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface MediaAssetDto {
  id: string;
  organizationId: string;
  folderId: string | null;
  folderPath?: string | null;
  name: string;
  originalFilename: string;
  mediaType: MediaType;
  originalMimeType: string;
  processedMimeType: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  orientation: MediaOrientation | null;
  processingStatus: ProcessingStatus;
  processingError: string | null;
  sizeBytes: number | null;
  processedSizeBytes: number | null;
  checksumSha256: string | null;
  thumbnailUrl: string | null;
  previewUrl: string | null;
  playCount?: number;
  lastPlayedAt?: string | null;
  usedInPlaylistCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlaylistItemDto {
  id: string;
  playlistId: string;
  type: PlaylistItemType;
  mediaAssetId: string | null;
  folderId: string | null;
  position: number;
  durationSeconds: number | null;
  fitMode: FitMode | null;
  backgroundColor: string | null;
  positionMode: PositionMode | null;
  enabled: boolean;
  includeSubfolders: boolean;
  filterMediaType: MediaType | null;
  filterOrientation: MediaOrientation | null;
  media?: MediaAssetDto;
  folder?: { id: string; name: string; path: string } | null;
}

export interface PriorityRuleAssignmentDto {
  id: string;
  mediaAssetId: string | null;
  folderId: string | null;
  includeSubfolders: boolean;
  media?: MediaAssetDto | null;
  folder?: { id: string; name: string; path: string } | null;
}

export interface PriorityRuleDto {
  id: string;
  organizationId: string;
  playlistId: string;
  name: string;
  intervalCount: number;
  selectionMode: PrioritySelectionMode;
  enabled: boolean;
  position: number;
  assignments: PriorityRuleAssignmentDto[];
  createdAt: string;
  updatedAt: string;
}

export interface PlaylistDto {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  loop: boolean;
  defaultImageDurationSeconds: number;
  playbackOrderMode: PlaybackOrderMode;
  defaultFitMode: FitMode | null;
  defaultBackgroundColor: string | null;
  defaultPositionMode: PositionMode | null;
  clonedFromPlaylistId: string | null;
  clonedAt: string | null;
  itemCount: number;
  totalDurationSeconds: number | null;
  items?: PlaylistItemDto[];
  priorityRules?: PriorityRuleDto[];
  createdAt: string;
  updatedAt: string;
}

// ---------- Resolved playlist preview ----------

export type ResolvedItemSource = 'item' | 'folder' | 'priority_rule';

export interface ResolvedPreviewItem {
  /** Playlist item / synthetic entry id this media resolved from. */
  entryId: string;
  mediaId: string;
  name: string;
  mediaType: MediaType;
  orientation: MediaOrientation | null;
  processingStatus: ProcessingStatus;
  durationSeconds: number | null;
  source: ResolvedItemSource;
  sourceId: string;
  /** Folder path or priority rule name for display. */
  sourceName: string | null;
  thumbnailUrl?: string | null;
  /** Resolved display settings devices will use (item override → playlist default → platform). */
  effectiveFitMode: FitMode;
  effectiveBackgroundColor: string;
  effectivePositionMode: PositionMode;
  /** Where the effective fit mode came from. */
  displaySource: 'item' | 'playlist_default' | 'platform_default';
}

export interface PreviewWarning {
  kind:
    | 'empty_folder'
    | 'processing_media'
    | 'failed_media'
    | 'missing_media'
    | 'orientation_mismatch'
    | 'empty_priority_rule'
    | 'disabled_priority_rules_inactive';
  message: string;
}

export interface ResolvedSampleEntry {
  mediaId: string;
  name: string;
  playedAs: PlayedAs;
  priorityRuleId?: string;
  priorityRuleName?: string;
}

export interface ResolvedPreviewDto {
  playlistId: string;
  playbackOrderMode: PlaybackOrderMode;
  resolvedCount: number;
  totalDurationSeconds: number | null;
  /** Exact order for manual/alphabetical; resolution order for random modes. */
  items: ResolvedPreviewItem[];
  /** Sample playback sequence for the random modes (real order will differ). */
  sample: ResolvedSampleEntry[] | null;
  warnings: PreviewWarning[];
}

// ---------- Usage / safe delete ----------

export interface UsageRef {
  id: string;
  name: string;
}

export interface MediaUsageDto {
  directPlaylists: UsageRef[];
  folderPlaylists: UsageRef[];
  priorityRules: Array<UsageRef & { playlistId: string; playlistName: string }>;
  activeSchedules: UsageRef[];
  affectedDeviceCount: number;
  playCount: number;
}

export interface FolderUsageDto {
  mediaCount: number;
  subfolderCount: number;
  /** Playlists referencing this folder (or a subfolder) as a dynamic entry. */
  directPlaylistRefs: UsageRef[];
  /** Playlists using media inside this folder as direct items. */
  mediaPlaylistRefs: UsageRef[];
  priorityRuleRefs: Array<UsageRef & { playlistId: string; playlistName: string }>;
  activeSchedules: UsageRef[];
  affectedDeviceCount: number;
}

export interface MediaPlaybackStatsDto {
  totalPlayCount: number;
  firstPlayedAt: string | null;
  lastPlayedAt: string | null;
  perDevice: Array<{
    deviceId: string;
    deviceName: string;
    playCount: number;
    lastPlayedAt: string;
  }>;
  perPlaylist: Array<{
    playlistId: string;
    playlistName: string;
    playCount: number;
    lastPlayedAt: string;
  }>;
}

// ---------- Superadmin ----------

export interface SuperadminOrganizationDto extends OrganizationDto {
  deviceCount: number;
  userCount: number;
  mediaCount: number;
  storageUsedBytes: number;
}

export interface SuperadminUserDto {
  id: string;
  email: string;
  name: string;
  globalRole: GlobalRole;
  mustChangePassword: boolean;
  disabledAt: string | null;
  createdAt: string;
  memberships: Array<{
    membershipId: string;
    organizationId: string;
    organizationName: string;
    role: OrgRole;
  }>;
}

export interface AuditLogDto {
  id: string;
  actorUserId: string | null;
  actorName?: string | null;
  actorGlobalRole: string | null;
  organizationId: string | null;
  targetType: string;
  targetId: string | null;
  action: string;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: string;
}

export interface ScheduleDto {
  id: string;
  organizationId: string;
  name: string;
  playlistId: string;
  playlistName?: string;
  enabled: boolean;
  priority: number;
  /** ISO date (yyyy-MM-dd) or null for open-ended */
  startDate: string | null;
  endDate: string | null;
  /** ISO weekday numbers 1 (Mon) - 7 (Sun); empty = every day */
  daysOfWeek: number[];
  /** "HH:mm" in the schedule/device timezone, or null for all day */
  startTime: string | null;
  endTime: string | null;
  /** IANA zone; null = interpret in each device's own timezone */
  timezone: string | null;
  deviceIds: string[];
  groupIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface EmergencyOverrideDto {
  id: string;
  organizationId: string;
  name: string | null;
  playlistId: string | null;
  mediaAssetId: string | null;
  active: boolean;
  appliesToAll: boolean;
  deviceIds: string[];
  groupIds: string[];
  /** Display settings for single-media overrides (null for playlist overrides). */
  fitMode: FitMode | null;
  backgroundColor: string | null;
  positionMode: PositionMode | null;
  startedAt: string;
  stoppedAt: string | null;
  createdAt: string;
}

export interface DeviceCommandDto {
  id: string;
  deviceId: string;
  type: CommandType;
  payload: Record<string, unknown>;
  status: CommandStatus;
  result: Record<string, unknown> | null;
  createdAt: string;
  sentAt: string | null;
  ackedAt: string | null;
  completedAt: string | null;
}

export interface DeviceLogDto {
  id: string;
  deviceId: string;
  level: string;
  message: string;
  context: Record<string, unknown> | null;
  loggedAt: string;
}

export interface PlaybackEventDto {
  id: string;
  deviceId: string;
  mediaAssetId: string | null;
  playlistId: string | null;
  eventType: PlaybackEventType;
  detail: Record<string, unknown> | null;
  occurredAt: string;
}

export interface PairResponse {
  deviceId: string;
  deviceToken: string;
  deviceName: string;
  organizationId: string;
  settings: {
    orientation: DeviceOrientation;
    rotation: DeviceRotation;
    timezone: string;
  };
}

/** A completed login: the caller holds a session token. */
export interface AuthSuccessResponse {
  status: 'ok';
  token: string;
  user: UserDto;
  organizations: OrganizationDto[];
}

/**
 * The password was correct but the account has MFA on. `challengeId` is an
 * opaque, single-use, server-side handle — it is not a token and grants nothing
 * on its own. Exchange it at `POST /auth/login/mfa`.
 */
export interface MfaChallengeResponse {
  status: 'mfa_required';
  challengeId: string;
  expiresInSeconds: number;
}

export type AuthResponse = AuthSuccessResponse | MfaChallengeResponse;

/** Returned by `POST /auth/mfa/setup` — nothing is active until confirmed. */
export interface MfaSetupResponse {
  secret: string;
  otpauthUri: string;
}

/** Recovery codes are returned in the clear exactly once, at enrollment. */
export interface MfaEnableResponse {
  ok: true;
  recoveryCodes: string[];
}

export interface ApiError {
  statusCode: number;
  error: string;
  message: string;
}
