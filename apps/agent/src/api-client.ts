import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sha256File } from '@signage/media';
import type { DeviceCommandDto, HeartbeatInput, PairResponse } from '@signage/shared';
import type { ManifestMedia, SyncManifest } from '@signage/sync-protocol';
import type { AgentConfig } from './config';

export interface Credentials {
  deviceId: string;
  deviceToken: string;
  organizationId: string;
  deviceName: string;
}

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function credentialsPath(config: AgentConfig): string {
  return join(config.dataDir, 'credentials.json');
}

export async function loadCredentials(config: AgentConfig): Promise<Credentials | null> {
  try {
    const raw = await readFile(credentialsPath(config), 'utf8');
    const parsed = JSON.parse(raw) as Credentials;
    return parsed.deviceToken ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveCredentials(config: AgentConfig, creds: Credentials): Promise<void> {
  const path = credentialsPath(config);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/** Thin authenticated HTTP client for the backend device API. */
export class ApiClient {
  constructor(
    private config: AgentConfig,
    private token: string | null = null,
  ) {}

  setToken(token: string): void {
    this.token = token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 30_000,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const response = await fetch(`${this.config.apiBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ApiError(
        response.status,
        `${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async pair(
    pairingCode: string,
    hardware: Record<string, string | undefined>,
  ): Promise<PairResponse> {
    return this.request<PairResponse>('POST', '/device/pair', { pairingCode, hardware });
  }

  async heartbeat(body: HeartbeatInput): Promise<{ serverTime: string }> {
    return this.request('POST', '/device/heartbeat', body);
  }

  async getSync(
    includeCommands: boolean,
  ): Promise<{ manifest: SyncManifest; commands: DeviceCommandDto[] }> {
    const suffix = includeCommands ? '?include_commands=true' : '';
    return this.request('GET', `/device/sync${suffix}`, undefined, 60_000);
  }

  async reportSyncStatus(body: {
    manifestVersion: string;
    status: 'applied' | 'failed' | 'downloading' | 'insufficient_storage';
    error?: string;
    cachedMediaIds?: string[];
    cacheUsedBytes?: number;
    requiredBytes?: number;
    availableBytes?: number;
    reclaimableBytes?: number;
    cacheBudgetBytes?: number;
    shortfallBytes?: number;
  }): Promise<void> {
    try {
      await this.request('POST', '/device/sync-status', body);
    } catch (err) {
      // A server older than T017 rejects `insufficient_storage` with a 400 from
      // its zod schema. Downgrade rather than lose the report entirely: the
      // operator still learns the device is stuck and why, just without the
      // distinct status. Any other failure propagates as before.
      if (
        body.status !== 'insufficient_storage' ||
        !(err instanceof ApiError) ||
        err.statusCode !== 400
      )
        throw err;
      await this.request('POST', '/device/sync-status', {
        ...body,
        status: 'failed',
        error: body.error ?? 'insufficient storage for the current playlist',
        requiredBytes: undefined,
        availableBytes: undefined,
        reclaimableBytes: undefined,
        cacheBudgetBytes: undefined,
        shortfallBytes: undefined,
      });
    }
  }

  async sendLogs(
    logs: Array<{
      level: string;
      message: string;
      context?: Record<string, unknown>;
      loggedAt: string;
    }>,
  ): Promise<void> {
    await this.request('POST', '/device/logs', { logs });
  }

  async sendPlaybackEvents(
    events: Array<{
      eventType: string;
      mediaAssetId: string | null;
      playlistId: string | null;
      clientEventId?: string | null;
      playedAs?: string | null;
      priorityRuleId?: string | null;
      durationSeconds?: number | null;
      detail?: Record<string, unknown>;
      occurredAt: string;
    }>,
  ): Promise<void> {
    await this.request('POST', '/device/playback-events', { events });
  }

  async sendScreenshot(imageBase64: string, mimeType: 'image/jpeg' | 'image/png'): Promise<void> {
    await this.request('POST', '/device/screenshot', { imageBase64, mimeType }, 60_000);
  }

  async getCommands(): Promise<{ commands: DeviceCommandDto[] }> {
    return this.request('GET', '/device/commands');
  }

  async ackCommand(commandId: string): Promise<void> {
    await this.request('POST', `/device/commands/${commandId}/ack`).catch(() => undefined);
  }

  async sendCommandResult(
    commandId: string,
    status: 'completed' | 'failed',
    result?: Record<string, unknown>,
  ): Promise<void> {
    await this.request('POST', `/device/commands/${commandId}/result`, { status, result });
  }

  /**
   * Downloads one media file to its final cache location, via a temp file so
   * a partial download never shows up in the cache, and verifies the sha256
   * checksum against the manifest before moving it into place.
   */
  async downloadMedia(media: ManifestMedia, destinationPath: string): Promise<void> {
    const tmpPath = join(this.config.tmpDir, `${media.id}.part`);
    await mkdir(this.config.tmpDir, { recursive: true });
    await mkdir(dirname(destinationPath), { recursive: true });

    // downloadPath already contains the API prefix; auth via header. The
    // backend replies with a redirect to a presigned URL, which fetch follows
    // (undici drops the auth header on cross-origin redirects).
    const response = await fetch(`${this.config.serverUrl}${media.downloadPath}`, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
      signal: AbortSignal.timeout(30 * 60_000),
    });
    if (!response.ok || !response.body) {
      throw new ApiError(response.status, `download ${media.id} -> ${response.status}`);
    }
    try {
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tmpPath));
      const checksum = await sha256File(tmpPath);
      if (checksum !== media.checksum) {
        throw new Error(
          `checksum mismatch for ${media.id}: expected ${media.checksum}, got ${checksum}`,
        );
      }
      await rename(tmpPath, destinationPath);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }
}
