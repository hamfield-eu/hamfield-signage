import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import pino from 'pino';
import { HEARTBEAT_INTERVAL_SECONDS, POLL_FALLBACK_INTERVAL_SECONDS } from '@signage/shared';
import { ApiClient, loadCredentials, saveCredentials, type Credentials } from './api-client';
import { BackendConnection } from './backend-ws';
import { CommandExecutor } from './commands';
import { loadConfig, type AgentConfig } from './config';
import { AgentDb } from './db';
import { collectMetrics, readDeviceModel, type PlaybackPosition } from './metrics';
import { PlayerServer } from './player-server';
import { computePlayerState } from './state';
import { SyncEngine } from './sync';

const STATE_INTERVAL_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = HEARTBEAT_INTERVAL_SECONDS * 1_000;
const FLUSH_INTERVAL_MS = 60_000;
const POLL_INTERVAL_MS = POLL_FALLBACK_INTERVAL_SECONDS * 1_000;
const PAIR_RETRY_MS = 15_000;
/** How long after the last successful HTTP call we still count as online. */
const HTTP_ONLINE_WINDOW_MS = 90_000;

export interface RunningAgent {
  config: AgentConfig;
  stop: () => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startAgent(env: NodeJS.ProcessEnv = process.env): Promise<RunningAgent> {
  const config = loadConfig(env);
  await mkdir(config.dataDir, { recursive: true });
  await mkdir(config.mediaDir, { recursive: true });
  await mkdir(config.tmpDir, { recursive: true });

  const log = pino({
    level: config.logLevel,
    ...(env.NODE_ENV !== 'production'
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  });

  const db = new AgentDb(config.dataDir);
  const api = new ApiClient(config);

  let stopped = false;
  let paired = false;
  let backend: BackendConnection | null = null;
  let lastHttpOkAt = 0;
  let lastError: string | null = null;
  const position: PlaybackPosition = { currentPlaylistId: null, currentMediaId: null };
  const timers: NodeJS.Timeout[] = [];

  const isOnline = (): boolean =>
    (backend?.isConnected() ?? false) || Date.now() - lastHttpOkAt < HTTP_ONLINE_WINDOW_MS;

  const playerServer = new PlayerServer(config, db, log, (event) => {
    db.bufferEvent({
      eventType: event.eventType,
      mediaAssetId: event.mediaId,
      playlistId: event.playlistId,
      // Generated here (not in the player) so every buffered event has one,
      // making offline resubmission idempotent on the backend.
      clientEventId: randomUUID(),
      playedAs: event.playedAs ?? null,
      priorityRuleId: event.priorityRuleId ?? null,
      durationSeconds: event.durationSeconds ?? null,
      detail: event.detail,
      occurredAt: event.occurredAt,
    });
    if (event.eventType === 'start') {
      position.currentMediaId = event.mediaId;
      position.currentPlaylistId = event.playlistId;
      backend?.sendStatus({ ...position, manifestVersion: db.getManifestVersion() });
    } else if (event.eventType === 'error') {
      lastError = `playback error on media ${event.mediaId}`;
      // The cheapest corruption signal there is: the player could not play this
      // exact file. Queue it for a full re-hash on the next integrity pass
      // rather than waiting for its turn in the weekly rotation.
      if (event.mediaId) sync.noteSuspectMedia(event.mediaId);
    }
  });

  const recomputeState = (): void => {
    const state = computePlayerState(db.getManifest(), {
      paired,
      online: isOnline(),
      cachedMediaIds: new Set(db.listCachedMedia().map((m) => m.mediaId)),
    });
    const changed = playerServer.setState(state);
    if (changed) {
      log.debug({ source: state.source, items: state.items.length }, 'player state updated');
      backend?.sendStatus({ ...position, manifestVersion: db.getManifestVersion() });
    }
  };

  const sync = new SyncEngine(config, db, api, log, () => recomputeState());

  const flushBuffers = async (): Promise<{ logs: number; events: number }> => {
    let sentLogs = 0;
    let sentEvents = 0;
    const logs = db.takeLogs(500);
    if (logs.length > 0) {
      await api.sendLogs(
        logs.map((l) => ({
          level: l.level,
          message: l.message,
          context: l.context ? (JSON.parse(l.context) as Record<string, unknown>) : undefined,
          loggedAt: l.loggedAt,
        })),
      );
      db.deleteLogs(logs.map((l) => l.id));
      sentLogs = logs.length;
    }
    const events = db.takeEvents(500);
    if (events.length > 0) {
      await api.sendPlaybackEvents(
        events.map((e) => ({
          eventType: e.eventType,
          mediaAssetId: e.mediaAssetId,
          playlistId: e.playlistId,
          clientEventId: e.clientEventId,
          playedAs: e.playedAs,
          priorityRuleId: e.priorityRuleId,
          durationSeconds: e.durationSeconds,
          detail: e.detail ? (JSON.parse(e.detail) as Record<string, unknown>) : undefined,
          occurredAt: e.occurredAt,
        })),
      );
      db.deleteEvents(events.map((e) => e.id));
      sentEvents = events.length;
    }
    if (sentLogs || sentEvents) lastHttpOkAt = Date.now();
    return { logs: sentLogs, events: sentEvents };
  };

  const executor = new CommandExecutor({
    config,
    api,
    sync,
    playerServer,
    ws: () => backend,
    getManifestVersion: () => db.getManifestVersion(),
    getMetrics: () => collectMetrics(config, db, position, lastError, sync.cacheReport()),
    flushBuffers,
    log,
  });

  const sendHeartbeat = async (): Promise<void> => {
    const metrics = await collectMetrics(config, db, position, lastError, sync.cacheReport());
    if (backend?.sendHeartbeat(metrics)) return;
    try {
      await api.heartbeat(metrics);
      lastHttpOkAt = Date.now();
    } catch (err) {
      log.debug({ err }, 'heartbeat failed (offline?)');
    }
  };

  const pollFallback = async (): Promise<void> => {
    if (backend?.isConnected()) return;
    try {
      const { commands } = await api.getCommands();
      lastHttpOkAt = Date.now();
      for (const command of commands) {
        await executor.execute({ id: command.id, type: command.type, payload: command.payload });
      }
      await sync.syncNow('poll fallback');
    } catch (err) {
      log.debug({ err }, 'poll fallback failed (offline?)');
    }
  };

  const ensureCredentials = async (): Promise<Credentials | null> => {
    let creds = await loadCredentials(config);
    let warnedNoCode = false;
    while (!creds && !stopped) {
      if (!config.pairingCode) {
        if (!warnedNoCode) {
          log.warn('device is not paired and no SIGNAGE_PAIRING_CODE is configured; waiting');
          warnedNoCode = true;
        }
        await sleep(30_000);
        creds = await loadCredentials(config);
        continue;
      }
      try {
        const res = await api.pair(config.pairingCode, {
          model: (await readDeviceModel()) ?? `${os.type()} ${os.arch()}`,
          os: `${os.type()} ${os.release()}`,
          arch: os.arch(),
          hostname: os.hostname(),
          appVersion: config.appVersion,
        });
        creds = {
          deviceId: res.deviceId,
          deviceToken: res.deviceToken,
          organizationId: res.organizationId,
          deviceName: res.deviceName,
        };
        await saveCredentials(config, creds);
        log.info({ deviceId: creds.deviceId, name: creds.deviceName }, 'paired with backend');
      } catch (err) {
        log.warn({ err }, `pairing failed; retrying in ${PAIR_RETRY_MS / 1000}s`);
        await sleep(PAIR_RETRY_MS);
      }
    }
    return creds;
  };

  await playerServer.start();
  recomputeState();

  // Pairing + the connected lifecycle run in the background so the player
  // server (and its "not paired" screen) is up immediately.
  void (async () => {
    const creds = await ensureCredentials();
    if (!creds || stopped) return;
    paired = true;
    api.setToken(creds.deviceToken);
    recomputeState();

    backend = new BackendConnection(
      config.wsUrl,
      creds.deviceToken,
      config.appVersion,
      () => db.getManifestVersion(),
      {
        onCommand: (command) => void executor.execute(command),
        onSyncRequired: (reason) => void sync.syncNow(`server: ${reason}`),
        onConnected: () => recomputeState(),
        onDisconnected: () => recomputeState(),
      },
      log,
    );
    backend.start();

    // Before the first sync: a file damaged while the agent was down must be
    // repaired even when the server manifest has not changed since.
    await sync.maintainCache('startup');
    await sync.syncNow('startup');
    await sendHeartbeat().catch(() => undefined);

    timers.push(setInterval(recomputeState, STATE_INTERVAL_MS));
    timers.push(setInterval(() => void sendHeartbeat(), HEARTBEAT_INTERVAL_MS));
    timers.push(
      setInterval(
        () => void flushBuffers().catch((err) => log.debug({ err }, 'buffer flush failed')),
        FLUSH_INTERVAL_MS,
      ),
    );
    timers.push(setInterval(() => void pollFallback(), POLL_INTERVAL_MS));
  })().catch((err) => log.error({ err }, 'agent startup failed'));

  log.info(
    { server: config.serverUrl, dataDir: config.dataDir, playerPort: config.playerPort },
    'signage agent started',
  );

  return {
    config,
    stop: async () => {
      stopped = true;
      for (const timer of timers) clearInterval(timer);
      backend?.close();
      await playerServer.close();
      db.close();
      log.info('signage agent stopped');
    },
  };
}

if (require.main === module) {
  startAgent()
    .then((agent) => {
      const shutdown = () => {
        void agent.stop().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error('agent failed to start', err);
      process.exit(1);
    });
}
