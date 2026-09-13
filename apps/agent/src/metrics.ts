import os from 'node:os';
import { readFile, statfs } from 'node:fs/promises';
import type { HeartbeatInput } from '@signage/shared';
import type { AgentConfig } from './config';
import type { AgentDb } from './db';

export interface PlaybackPosition {
  currentPlaylistId: string | null;
  currentMediaId: string | null;
}

/**
 * Reads the board model on Linux SBCs (e.g. "Raspberry Pi 4 Model B Rev 1.4",
 * "Hardkernel ODROID-C4"). The device-tree exposes it NUL-terminated; we trim
 * that. Returns null on non-Linux hosts or when the node is absent.
 */
export async function readDeviceModel(): Promise<string | null> {
  for (const path of ['/proc/device-tree/model', '/sys/firmware/devicetree/base/model']) {
    try {
      const raw = await readFile(path, 'utf8');
      const model = raw.replace(/\0/g, '').trim();
      if (model) return model;
    } catch {
      // Not present on this host; try the next path.
    }
  }
  return null;
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
