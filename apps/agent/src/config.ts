import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_MAX_CACHE_SIZE_GB, DEFAULT_MIN_FREE_DISK_MB } from '@signage/shared';

const configSchema = z.object({
  /** Base URL of the backend, e.g. https://signage.example.com */
  SIGNAGE_SERVER_URL: z.string().url().default('http://localhost:4000'),
  /** Where credentials, the SQLite state db and the media cache live. */
  SIGNAGE_DATA_DIR: z.string().optional(),
  /** Port of the local player HTTP/WS server the kiosk browser connects to. */
  SIGNAGE_PLAYER_PORT: z.coerce.number().int().default(8080),
  /** One-time pairing code; used only while the device is not yet paired. */
  SIGNAGE_PAIRING_CODE: z.string().optional(),
  /** Directory containing the built player UI (apps/player/dist). */
  SIGNAGE_PLAYER_UI_DIR: z.string().optional(),
  /** Shell command that writes a screenshot to the path given as $1. */
  SIGNAGE_SCREENSHOT_CMD: z.string().optional(),
  /** Shell command executed for the software_update remote command. */
  SIGNAGE_UPDATE_CMD: z.string().optional(),
  /** Allow reboot_device to actually reboot the host. */
  SIGNAGE_ALLOW_REBOOT: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  /** systemd unit restarted by the restart_player command, if any. */
  SIGNAGE_PLAYER_SERVICE: z.string().optional(),
  /** Media cache budget in GB; also capped at a fraction of the disk. */
  SIGNAGE_MAX_CACHE_GB: z.coerce.number().positive().default(DEFAULT_MAX_CACHE_SIZE_GB),
  /** Free space a sync will not eat into. */
  SIGNAGE_MIN_FREE_DISK_MB: z.coerce.number().nonnegative().default(DEFAULT_MIN_FREE_DISK_MB),
  /**
   * LRU eviction of unreferenced cached files. **Default off**: it deletes
   * files on a customer's device, and the orphan sweep already removes the
   * files that eviction would mostly be finding. Turn it on per device once
   * the integrity and precheck work has run cleanly.
   */
  SIGNAGE_CACHE_EVICTION: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true' || v.toLowerCase() === 'on'),
  /** Files re-hashed per verification pass; bounded to spare slow eMMC. */
  SIGNAGE_CACHE_HASH_PER_PASS: z.coerce.number().int().nonnegative().default(2),
  /**
   * Playback liveness monitoring. `off` disables it entirely, for debugging a
   * device without the agent commenting on what you are doing to it.
   * Today the monitor only observes and reports — it never restarts or reboots
   * anything (see T015: the recovery ladder is deliberately not shipped).
   */
  SIGNAGE_WATCHDOG: z
    .string()
    .default('on')
    .transform((v) => v.toLowerCase() !== 'off' && v.toLowerCase() !== 'false'),
  SIGNAGE_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  SIGNAGE_APP_VERSION: z.string().default('0.1.0'),
});

export interface AgentConfig {
  serverUrl: string;
  apiBase: string;
  wsUrl: string;
  dataDir: string;
  mediaDir: string;
  tmpDir: string;
  playerPort: number;
  pairingCode: string | null;
  playerUiDir: string | null;
  screenshotCmd: string | null;
  updateCmd: string | null;
  allowReboot: boolean;
  playerService: string | null;
  watchdog: boolean;
  maxCacheGb: number;
  minFreeDiskBytes: number;
  cacheEviction: boolean;
  cacheHashPerPass: number;
  logLevel: string;
  appVersion: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = configSchema.parse(env);
  const serverUrl = parsed.SIGNAGE_SERVER_URL.replace(/\/+$/, '');
  const dataDir =
    parsed.SIGNAGE_DATA_DIR ??
    (process.platform === 'linux' ? '/var/lib/signage' : join(homedir(), '.signage'));

  const wsBase = serverUrl.replace(/^http/, 'ws');
  return {
    serverUrl,
    apiBase: `${serverUrl}/api/v1`,
    wsUrl: `${wsBase}/api/v1/device/ws`,
    dataDir,
    mediaDir: join(dataDir, 'media'),
    tmpDir: join(dataDir, 'tmp'),
    playerPort: parsed.SIGNAGE_PLAYER_PORT,
    pairingCode: parsed.SIGNAGE_PAIRING_CODE || null,
    playerUiDir: parsed.SIGNAGE_PLAYER_UI_DIR || null,
    screenshotCmd: parsed.SIGNAGE_SCREENSHOT_CMD || null,
    updateCmd: parsed.SIGNAGE_UPDATE_CMD || null,
    allowReboot: parsed.SIGNAGE_ALLOW_REBOOT,
    playerService: parsed.SIGNAGE_PLAYER_SERVICE || null,
    watchdog: parsed.SIGNAGE_WATCHDOG,
    maxCacheGb: parsed.SIGNAGE_MAX_CACHE_GB,
    minFreeDiskBytes: Math.round(parsed.SIGNAGE_MIN_FREE_DISK_MB * 1024 * 1024),
    cacheEviction: parsed.SIGNAGE_CACHE_EVICTION,
    cacheHashPerPass: parsed.SIGNAGE_CACHE_HASH_PER_PASS,
    logLevel: parsed.SIGNAGE_LOG_LEVEL,
    appVersion: parsed.SIGNAGE_APP_VERSION,
  };
}
