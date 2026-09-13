import type { Prisma, PrismaClient } from '@signage/database';
import type { HeartbeatInput } from '@signage/shared';

const big = (v: number | undefined): bigint | undefined =>
  v == null ? undefined : BigInt(Math.max(0, Math.round(v)));

/**
 * Applies a heartbeat (REST or WebSocket) to the device row and records the
 * raw payload for the monitoring history.
 */
export async function applyHeartbeat(
  prisma: PrismaClient,
  deviceId: string,
  body: HeartbeatInput,
  ip: string | undefined,
): Promise<void> {
  await prisma.$transaction([
    prisma.device.update({
      where: { id: deviceId },
      data: {
        lastSeenAt: new Date(),
        lastIp: ip,
        appVersion: body.appVersion,
        osInfo: body.osInfo,
        archInfo: body.archInfo,
        deviceModel: body.deviceModel ?? undefined,
        uptimeSeconds: body.uptimeSeconds,
        cpuPercent: body.cpuPercent,
        memUsedBytes: big(body.memUsedBytes),
        memTotalBytes: big(body.memTotalBytes),
        diskFreeBytes: big(body.diskFreeBytes),
        diskTotalBytes: big(body.diskTotalBytes),
        cacheUsedBytes: big(body.cacheUsedBytes),
        screenWidth: body.screenWidth,
        screenHeight: body.screenHeight,
        networkType: body.networkType,
        currentPlaylistId: body.currentPlaylistId,
        currentMediaId: body.currentMediaId,
        manifestVersion: body.manifestVersion,
        lastError: body.lastError,
        cacheBudgetBytes: big(body.cacheBudgetBytes),
        cachedFileCount: body.cachedFileCount,
        lastIntegrityCheckAt: body.lastIntegrityCheckAt
          ? new Date(body.lastIntegrityCheckAt)
          : undefined,
      },
    }),
    prisma.deviceHeartbeat.create({
      data: { deviceId, payload: body as Prisma.InputJsonValue },
    }),
  ]);
}
