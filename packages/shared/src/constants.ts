export const DEFAULT_IMAGE_DURATION_SECONDS = 10;
export const DEFAULT_FIT_MODE = 'contain' as const;
export const DEFAULT_DEVICE_ORIENTATION = 'landscape' as const;
/** Safe default video tier: 1080p30 plays on every current player. */
export const DEFAULT_PLAYBACK_PROFILE = 'standard' as const;
export const DEFAULT_TIMEZONE = 'UTC';
/** Default media cache budget on a device; `SIGNAGE_MAX_CACHE_GB` overrides it. */
export const DEFAULT_MAX_CACHE_SIZE_GB = 8;
/**
 * The budget is also capped at this fraction of the whole filesystem, so a
 * small eMMC does not hand 8 GB to the cache and leave the OS with nothing.
 */
export const MAX_CACHE_DISK_FRACTION = 0.7;
/** Free space a sync refuses to eat into, so the device never wedges itself. */
export const DEFAULT_MIN_FREE_DISK_MB = 500;
/** Age at which an unindexed file in the media directory is treated as an orphan. */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

export const PAIRING_CODE_LENGTH = 8;
/** Characters used in pairing codes; ambiguous chars (0/O, 1/I/L) removed. */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const DEVICE_TOKEN_PREFIX = 'sgd_';

export const HEARTBEAT_INTERVAL_SECONDS = 30;
export const OFFLINE_THRESHOLD_SECONDS = 90;
export const POLL_FALLBACK_INTERVAL_SECONDS = 30;

/**
 * v2 adds: playback order modes, server-resolved dynamic folder entries and
 * priority rules. The manifest stays backwards compatible for manual
 * playback: v1 agents ignore the new fields and keep playing resolved items
 * in manifest order.
 */
export const SYNC_PROTOCOL_VERSION = 2;

export const API_PREFIX = '/api/v1';

// ---------- Organization logos ----------
/** Maximum organization logo upload size (2 MB). */
export const ORG_LOGO_MAX_BYTES = 2 * 1024 * 1024;
/** MIME types accepted for organization logos. */
export const ORG_LOGO_MIME_TYPES = ['image/svg+xml', 'image/png', 'image/jpeg'] as const;
/** `accept` attribute value for the logo file picker. */
export const ORG_LOGO_ACCEPT = '.svg,.png,.jpg,.jpeg,image/svg+xml,image/png,image/jpeg';
