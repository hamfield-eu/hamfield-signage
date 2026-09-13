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

// ---------- Playback liveness (T015) ----------

/**
 * A video item is given a hard ceiling timer so playback always advances even
 * when the element never fires `ended` — the F1 hang. The ceiling is the
 * probed duration plus slack, never the probed duration itself: a video that
 * decodes slightly slowly is healthy and must not be cut off.
 */
export const VIDEO_CEILING_SLACK_RATIO = 1.25;
/** Absolute slack added on top of the ratio, so very short clips get room too. */
export const VIDEO_CEILING_SLACK_SECONDS = 10;
/**
 * Ceiling used when the natural duration is unknown (ffprobe could not
 * determine it). Generous on purpose — the rule is that no video item may ever
 * have no timer, not that the timer must be tight.
 */
export const VIDEO_CEILING_FALLBACK_SECONDS = 1_800;

/** How often the player reports playback progress to the agent. */
export const PLAYER_PROGRESS_INTERVAL_MS = 5_000;
/**
 * Consecutive progress reports with a stationary `currentTime` that mean the
 * video is wedged rather than merely buffering. `waiting`/`stalled` fire
 * legitimately during buffering, so stagnation is the authority.
 */
export const PLAYER_STALL_REPORTS = 3;
