/**
 * The shape of the content canvas the audience sees. This is the *logical*
 * orientation and is independent of how the physical panel is mounted — see
 * DEVICE_ROTATIONS for the software compensation applied at render time.
 */
export const DEVICE_ORIENTATIONS = ['landscape', 'portrait'] as const;
export type DeviceOrientation = (typeof DEVICE_ORIENTATIONS)[number];

/**
 * Software rotation (clockwise degrees) the player applies to the stage to
 * compensate for how the panel is physically mounted relative to its native
 * scan-out. Orthogonal to orientation:
 *   - Native 16:9 landscape panel:            orientation landscape, rotation 0
 *   - Native 9:16 portrait panel:             orientation portrait,  rotation 0
 *   - 16:9 panel physically rotated to tall:  orientation portrait,  rotation 90
 *   - Landscape panel mounted upside-down:    orientation landscape, rotation 180
 */
export const DEVICE_ROTATIONS = [0, 90, 180, 270] as const;
export type DeviceRotation = (typeof DEVICE_ROTATIONS)[number];

export const MEDIA_ORIENTATIONS = ['landscape', 'portrait', 'square'] as const;
export type MediaOrientation = (typeof MEDIA_ORIENTATIONS)[number];

export const FIT_MODES = ['contain', 'cover', 'stretch', 'original', 'scale_down'] as const;
export type FitMode = (typeof FIT_MODES)[number];

export const POSITION_MODES = [
  'center',
  'top',
  'bottom',
  'left',
  'right',
  'top_left',
  'top_right',
  'bottom_left',
  'bottom_right',
] as const;
export type PositionMode = (typeof POSITION_MODES)[number];

export const MEDIA_TYPES = ['image', 'video'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const PROCESSING_STATUSES = ['pending', 'processing', 'ready', 'failed'] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

export const ORG_ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const GLOBAL_ROLES = ['user', 'superadmin'] as const;
export type GlobalRole = (typeof GLOBAL_ROLES)[number];

export const ORG_STATUSES = ['active', 'disabled'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

export const PLAYBACK_ORDER_MODES = [
  'manual_order',
  'alphabetical',
  'random',
  'random_with_priority_rules',
] as const;
export type PlaybackOrderMode = (typeof PLAYBACK_ORDER_MODES)[number];

export const PLAYLIST_ITEM_TYPES = ['media', 'folder'] as const;
export type PlaylistItemType = (typeof PLAYLIST_ITEM_TYPES)[number];

export const PRIORITY_SELECTION_MODES = ['rotate', 'random'] as const;
export type PrioritySelectionMode = (typeof PRIORITY_SELECTION_MODES)[number];

export const PLAYED_AS_VALUES = ['normal', 'priority'] as const;
export type PlayedAs = (typeof PLAYED_AS_VALUES)[number];

export const COMMAND_TYPES = [
  'restart_player',
  'reboot_device',
  'refresh_content',
  'clear_cache',
  'take_screenshot',
  'identify',
  'set_orientation',
  'set_playlist',
  'update_settings',
  'show_emergency',
  'stop_emergency',
  'send_logs',
  'health_check',
  'software_update',
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export const COMMAND_STATUSES = [
  'pending',
  'sent',
  'acked',
  'completed',
  'failed',
  'expired',
] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

/**
 * `insufficient_storage` is deliberately distinct from `error`: it is the one
 * sync failure an operator can actually fix, and it needs a different action
 * (smaller playlist, or a bigger disk) from "something went wrong".
 */
export const SYNC_STATUSES = [
  'never_synced',
  'in_sync',
  'syncing',
  'error',
  'insufficient_storage',
] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export const PLAYBACK_EVENT_TYPES = ['start', 'end', 'error', 'skip'] as const;
export type PlaybackEventType = (typeof PLAYBACK_EVENT_TYPES)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const MEDIA_VARIANT_KINDS = [
  'original',
  'processed',
  'fallback',
  'thumbnail',
  'video_high',
  'video_standard',
  'video_light',
] as const;
export type MediaVariantKind = (typeof MEDIA_VARIANT_KINDS)[number];

/**
 * Per-device video quality tiers. Each video is encoded into one of these and a
 * device is served the tier its hardware can decode smoothly:
 *   - `high`     — beefy players (1080p60, H.264 high)
 *   - `standard` — Raspberry Pi 4 (1080p30, H.264 high) — the safe default
 *   - `light`    — ODROID C4 / weak ARM SBCs (720p30, H.264 main)
 * The `standard` tier doubles as the processed file (MediaAsset.processedStorageKey)
 * for back-compat; other tiers live in MediaVariant rows keyed `video_<tier>`.
 */
export const PLAYBACK_PROFILES = ['high', 'standard', 'light'] as const;
export type PlaybackProfile = (typeof PLAYBACK_PROFILES)[number];

/** Maps a playback profile to its MediaVariant kind. */
export function videoVariantKindForProfile(profile: PlaybackProfile): MediaVariantKind {
  return `video_${profile}` as MediaVariantKind;
}

export function isPlaybackProfile(value: unknown): value is PlaybackProfile {
  return typeof value === 'string' && (PLAYBACK_PROFILES as readonly string[]).includes(value);
}

/**
 * Suggests a tier from a device's reported hardware string (board model, or
 * arch/OS as a fallback). A UI hint only — the per-device dropdown value wins.
 */
export function suggestPlaybackProfile(info: string | null | undefined): PlaybackProfile {
  if (!info) return 'standard';
  const s = info.toLowerCase();
  // Weakest first: ODROID C4 / Amlogic boards need the light tier.
  if (s.includes('odroid') || s.includes('c4') || s.includes('amlogic')) return 'light';

  // Known thin clients, by their DMI product name. `sion` is the board name an
  // Acer Chromebox CXI3 reports — a 2-core Celeron 3867U with 4 GB and an HD
  // 610. It plays 1080p30 comfortably with hardware decode and has no business
  // anywhere near the 60 fps tier.
  if (s.includes('sion')) return 'standard';

  if (s.includes('raspberry pi 5')) return 'high';
  if (s.includes('raspberry pi 4')) return 'standard';

  // Bare `x86_64`/`x64` deliberately does NOT suggest `high` any more.
  //
  // It used to, on the reasoning that x86 means a desktop. The x86 devices this
  // platform actually runs on are thin clients — and until the DMI fallback in
  // the agent landed, every one of them reported exactly `Linux x64`, so the
  // weakest hardware in the fleet was being recommended the heaviest tier
  // (1080p60 at 9000 kbps). An architecture string says nothing about whether
  // the machine is a Xeon or a 1.8 GHz Celeron; `standard` is the safe answer
  // and an operator can raise it deliberately once a model is validated.
  return 'standard';
}

/** Does the configured content orientation present a portrait-shaped viewport? */
export function isPortraitDeviceOrientation(o: DeviceOrientation): boolean {
  return o === 'portrait';
}

/** Returns the media orientation that best matches a device orientation. */
export function expectedMediaOrientation(o: DeviceOrientation): MediaOrientation {
  return isPortraitDeviceOrientation(o) ? 'portrait' : 'landscape';
}

/** A 90°/270° rotation swaps the stage's width and height. */
export function rotationSwapsAxes(rotation: DeviceRotation): boolean {
  return rotation === 90 || rotation === 270;
}

/** True when a media item's shape mismatches the screen's shape (square never mismatches). */
export function orientationMismatch(
  media: MediaOrientation | null | undefined,
  device: DeviceOrientation,
): boolean {
  if (!media || media === 'square') return false;
  return media !== expectedMediaOrientation(device);
}
