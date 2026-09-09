import type { PrismaClient } from '@signage/database';
import type { Logger } from 'pino';
import type Redis from 'ioredis';
import { BACKUP_LAST_SUCCESS_KEY, assessBackupFreshness } from './retention';

/**
 * Alerting (T013 step 6).
 *
 * The dashboard already *shows* an offline device; nothing ever *told* anyone. A
 * screen could be dark for a week until a customer called. This closes that.
 *
 * Evaluation is a pure function over a plain snapshot so the thresholds can be
 * tested without a database. Only `gatherSnapshot` and `dispatch` touch the world.
 */

export type Priority = 'default' | 'high' | 'urgent';

export interface Alert {
  /** Stable across firings of the same condition — used for dedupe state. */
  id: string;
  title: string;
  message: string;
  priority: Priority;
  tags: string[];
}

export interface FleetSnapshot {
  now: Date;
  /** Active emergency overrides: org name plus when it started. */
  activeOverrides: Array<{ id: string; name: string; organizationName: string; startedAt: Date }>;
  /** Devices considered offline, with how long since we last heard from them. */
  offlineDevices: Array<{ id: string; name: string; lastSeenAt: Date | null }>;
  devicesInSyncError: Array<{ id: string; name: string; lastError: string | null }>;
  failedMediaLastHour: number;
  queueWaiting: number;
  backupMarker: string | null;
}

export interface AlertThresholds {
  emergencyHours: number;
  offlineMinutes: number;
  queueWaiting: number;
  backupWithinHours: number;
}

export function evaluateAlerts(s: FleetSnapshot, t: AlertThresholds): Alert[] {
  const alerts: Alert[] = [];

  // Highest-value alert in the product. routes/emergency.ts has no auto-expiry,
  // so an override someone forgot to stop blanks a customer's screens
  // indefinitely and nothing else will ever mention it.
  for (const o of s.activeOverrides) {
    const hours = (s.now.getTime() - o.startedAt.getTime()) / 3_600_000;
    if (hours >= t.emergencyHours) {
      alerts.push({
        id: `emergency:${o.id}`,
        title: 'Emergency override still active',
        message: `"${o.name}" has been overriding screens at ${o.organizationName} for ${hours.toFixed(1)}h. If that was not intended, stop it — screens are showing override content, not their playlists.`,
        priority: 'urgent',
        tags: ['rotating_light'],
      });
    }
  }

  for (const d of s.offlineDevices) {
    const mins = d.lastSeenAt ? (s.now.getTime() - d.lastSeenAt.getTime()) / 60_000 : Infinity;
    if (mins >= t.offlineMinutes) {
      alerts.push({
        id: `offline:${d.id}`,
        title: 'Screen offline',
        message: d.lastSeenAt
          ? `"${d.name}" has not checked in for ${Math.round(mins)} minutes.`
          : `"${d.name}" has never checked in since it was paired.`,
        priority: 'high',
        tags: ['tv_off'],
      });
    }
  }

  for (const d of s.devicesInSyncError) {
    alerts.push({
      id: `sync:${d.id}`,
      title: 'Screen cannot sync',
      message: `"${d.name}" is failing to sync, so its content is stale. ${d.lastError ?? 'No error recorded.'} A full disk is a common cause.`,
      priority: 'high',
      tags: ['warning'],
    });
  }

  if (s.failedMediaLastHour > 0) {
    alerts.push({
      id: 'media-failed',
      title: 'Media processing failed',
      message: `${s.failedMediaLastHour} upload(s) failed to process in the last hour. They will never appear on screens until reprocessed.`,
      priority: 'default',
      tags: ['film_projector'],
    });
  }

  if (s.queueWaiting > t.queueWaiting) {
    alerts.push({
      id: 'queue-backlog',
      title: 'Processing queue backed up',
      message: `${s.queueWaiting} jobs waiting (threshold ${t.queueWaiting}). The worker may be wedged or under-provisioned.`,
      priority: 'default',
      tags: ['hourglass'],
    });
  }

  // Ties to T011. A silent backup failure is the worst failure mode there is,
  // because you only discover it when you need the backup.
  const backup = assessBackupFreshness(s.backupMarker, s.now, t.backupWithinHours);
  if (!backup.ok) {
    alerts.push({
      id: 'backup-stale',
      title: 'Backups are not running',
      message: `${backup.reason}. Retention will also refuse to delete anything until this is fixed.`,
      priority: 'urgent',
      tags: ['floppy_disk'],
    });
  }

  return alerts;
}

/**
 * Decides which alerts to actually send, and which resolutions to announce.
 *
 * Re-notifying every five minutes trains people to ignore the channel, so a
 * firing alert repeats at most every `repeatHours`. Recoveries are announced once
 * so a silent channel means "fine" rather than "possibly broken".
 */
export function diffAlertState(
  current: Alert[],
  previouslyFiring: Set<string>,
  lastSentAt: Map<string, number>,
  now: Date,
  repeatHours: number,
): { toSend: Alert[]; resolved: string[] } {
  const currentIds = new Set(current.map((a) => a.id));
  const toSend = current.filter((a) => {
    const last = lastSentAt.get(a.id);
    if (last === undefined) return true;
    return now.getTime() - last >= repeatHours * 3_600_000;
  });
  const resolved = [...previouslyFiring].filter((id) => !currentIds.has(id));
  return { toSend, resolved };
}

export async function gatherSnapshot(
  prisma: PrismaClient,
  redis: Redis,
  queueWaiting: number,
  offlineMinutes: number,
  now = new Date(),
): Promise<FleetSnapshot> {
  const offlineBefore = new Date(now.getTime() - offlineMinutes * 60_000);
  const [overrides, offline, syncError, failedMedia, backupMarker] = await Promise.all([
    prisma.emergencyOverride.findMany({
      where: { active: true },
      select: { id: true, name: true, startedAt: true, organization: { select: { name: true } } },
    }),
    prisma.device.findMany({
      where: {
        deletedAt: null,
        // Never-paired devices have no token and are not a fault to report.
        tokens: { some: { revokedAt: null } },
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: offlineBefore } }],
      },
      select: { id: true, name: true, lastSeenAt: true },
    }),
    prisma.device.findMany({
      where: { deletedAt: null, syncStatus: 'error' },
      select: { id: true, name: true, lastError: true },
    }),
    prisma.mediaAsset.count({
      where: {
        processingStatus: 'failed',
        deletedAt: null,
        updatedAt: { gte: new Date(now.getTime() - 3_600_000) },
      },
    }),
    redis.get(BACKUP_LAST_SUCCESS_KEY).catch(() => null),
  ]);

  return {
    now,
    activeOverrides: overrides.map((o) => ({
      id: o.id,
      // EmergencyOverride.name is nullable in the schema.
      name: o.name ?? 'unnamed override',
      organizationName: o.organization?.name ?? 'unknown org',
      startedAt: o.startedAt,
    })),
    offlineDevices: offline,
    devicesInSyncError: syncError,
    failedMediaLastHour: failedMedia,
    queueWaiting,
    backupMarker,
  };
}

/** Posts to an ntfy topic. Any failure is logged, never thrown. */
export async function sendNtfy(
  url: string,
  token: string | undefined,
  a: { title: string; message: string; priority: Priority; tags: string[] },
  log: Logger,
): Promise<boolean> {
  const priorityHeader = a.priority === 'urgent' ? '5' : a.priority === 'high' ? '4' : '3';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Title: a.title,
        Priority: priorityHeader,
        Tags: a.tags.join(','),
      },
      body: a.message,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.warn({ status: res.status }, 'alerts: ntfy rejected the notification');
      return false;
    }
    return true;
  } catch (err) {
    log.warn({ err }, 'alerts: could not reach ntfy');
    return false;
  }
}
