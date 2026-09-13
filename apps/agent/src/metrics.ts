import os from 'node:os';
import { readFile, statfs } from 'node:fs/promises';
import type { HeartbeatInput } from '@signage/shared';
import type { AgentConfig } from './config';
import type { AgentDb } from './db';

export interface PlaybackPosition {
  currentPlaylistId: string | null;
  currentMediaId: string | null;
}

/** Reads a sysfs/procfs node, trimming device-tree NUL padding. Null if absent. */
async function readTrimmed(path: string): Promise<string | null> {
  try {
    const value = (await readFile(path, 'utf8')).replace(/\0/g, '').trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * DMI strings are frequently placeholders rather than absent — a board with
 * unset fields reports "To Be Filled By O.E.M." or "Default string", which is
 * worse than nothing because it looks like a real answer in the dashboard.
 */
const DMI_PLACEHOLDERS = new Set([
  'tobefilledbyoem',
  'defaultstring',
  'systemproductname',
  'systemmanufacturer',
  'systemversion',
  'oem',
  'none',
  'na',
  'notapplicable',
  'unknown',
  'noenclosure',
  'chassismanufacture',
]);

export function isPlaceholderDmi(value: string): boolean {
  // Exact match on a normalised form, never a prefix: "None" is a placeholder
  // but "Nonesuch Systems X1" is a real vendor, and a prefix rule cannot tell
  // them apart. Punctuation varies between boards ("O.E.M." vs "OEM"), so it
  // is stripped rather than enumerated.
  return DMI_PLACEHOLDERS.has(value.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

/**
 * Joins the DMI vendor and product into one model string, dropping placeholders.
 * Separated from the file reads so the part with rules in it is testable.
 */
export function composeDmiModel(vendor: string | null, product: string | null): string | null {
  // Either field can be a placeholder independently; keep whichever is real
  // rather than discarding both.
  const parts = [vendor, product].filter((p): p is string => !!p && !isPlaceholderDmi(p));
  if (parts.length === 0) return null;
  // "Acer Acer Chromebox CXI3" reads badly, and vendors do repeat themselves
  // in product_name.
  if (parts.length === 2 && parts[1].toLowerCase().startsWith(parts[0].toLowerCase())) {
    return parts[1];
  }
  return parts.join(' ');
}

/**
 * Reads the hardware model.
 *
 * ARM SBCs expose it on the device tree ("Raspberry Pi 4 Model B Rev 1.4",
 * "Hardkernel ODROID-C4"). **x86 has no device tree at all**, so every thin
 * client used to fall through to `${os.type()} ${os.arch()}` — every Chromebox
 * in the fleet showed as "Linux x64", which identifies nothing and gives
 * `suggestPlaybackProfile` nothing to work with. DMI is the x86 equivalent.
 *
 * Device tree first: on the boards that have both, it is the more specific.
 */
export async function readDeviceModel(): Promise<string | null> {
  for (const path of ['/proc/device-tree/model', '/sys/firmware/devicetree/base/model']) {
    const model = await readTrimmed(path);
    if (model) return model;
  }

  const [vendor, product] = await Promise.all([
    readTrimmed('/sys/class/dmi/id/sys_vendor'),
    readTrimmed('/sys/class/dmi/id/product_name'),
  ]);
  return composeDmiModel(vendor, product);
}

export interface CacheReport {
  cacheBudgetBytes: number;
  cachedFileCount: number;
  lastIntegrityCheckAt: string | null;
  integrityFailureCount: number;
  orphanFilesRemoved: number;
}

export async function collectMetrics(
  config: AgentConfig,
  db: AgentDb,
  position: PlaybackPosition,
  lastError: string | null,
  cache?: CacheReport,
): Promise<HeartbeatInput> {
  let diskFreeBytes: number | undefined;
  let diskTotalBytes: number | undefined;
  try {
    const fs = await statfs(config.dataDir);
    diskFreeBytes = fs.bavail * fs.bsize;
    diskTotalBytes = fs.blocks * fs.bsize;
  } catch {
    // statfs can fail on exotic filesystems; report without disk numbers.
  }

  const cores = os.cpus().length || 1;
  const cpuPercent = Math.min(100, Math.round((os.loadavg()[0] / cores) * 100));

  return {
    appVersion: config.appVersion,
    osInfo: `${os.type()} ${os.release()}`,
    archInfo: os.arch(),
    deviceModel: await readDeviceModel(),
    uptimeSeconds: Math.round(os.uptime()),
    cpuPercent,
    memUsedBytes: os.totalmem() - os.freemem(),
    memTotalBytes: os.totalmem(),
    diskFreeBytes,
    diskTotalBytes,
    cacheUsedBytes: db.cacheUsedBytes(),
    currentPlaylistId: position.currentPlaylistId,
    currentMediaId: position.currentMediaId,
    manifestVersion: db.getManifestVersion(),
    lastError,
    ...(cache ?? {}),
  };
}
