import { exec } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from 'pino';
import type { HeartbeatInput } from '@signage/shared';
import type { ApiClient } from './api-client';
import type { BackendConnection } from './backend-ws';
import type { AgentConfig } from './config';
import type { PlayerServer } from './player-server';
import { solidColorPng } from './png';
import type { SyncEngine } from './sync';

const execAsync = promisify(exec);

export interface IncomingCommand {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface CommandDeps {
  config: AgentConfig;
  api: ApiClient;
  sync: SyncEngine;
  playerServer: PlayerServer;
  /** Returns the live backend socket, if any; used to ack/report instantly. */
  ws: () => BackendConnection | null;
  getManifestVersion: () => string | null;
  getMetrics: () => Promise<HeartbeatInput>;
  flushBuffers: () => Promise<{ logs: number; events: number }>;
  log: Logger;
}

/**
 * Executes remote commands: ack immediately, run the handler, then report
 * completed/failed. Ack and result go over the websocket when connected,
 * falling back to the REST endpoints otherwise.
 */
export class CommandExecutor {
  constructor(private deps: CommandDeps) {}

  async execute(command: IncomingCommand): Promise<void> {
    const { log } = this.deps;
    log.info({ commandId: command.id, type: command.type }, 'executing command');
    await this.ack(command.id);
    try {
      const result = await this.run(command);
      await this.report(command.id, 'completed', result);
      log.info({ commandId: command.id, type: command.type }, 'command completed');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ commandId: command.id, type: command.type, err }, 'command failed');
      await this.report(command.id, 'failed', { error: message.slice(0, 2000) });
    }
  }

  private async ack(commandId: string): Promise<void> {
    if (this.deps.ws()?.sendCommandAck(commandId)) return;
    await this.deps.api.ackCommand(commandId);
  }

  private async report(
    commandId: string,
    status: 'completed' | 'failed',
    result?: Record<string, unknown>,
  ): Promise<void> {
    if (this.deps.ws()?.sendCommandResult(commandId, status, result)) return;
    await this.deps.api.sendCommandResult(commandId, status, result).catch((err) => {
      this.deps.log.warn({ err, commandId }, 'failed to report command result');
    });
  }

  private async run(command: IncomingCommand): Promise<Record<string, unknown>> {
    const { config, sync, playerServer } = this.deps;
    switch (command.type) {
      case 'restart_player': {
        if (config.playerService) {
          await execAsync(`systemctl restart ${config.playerService}`, { timeout: 30_000 });
          return { restarted: config.playerService };
        }
        return { kickedPlayers: playerServer.kickPlayers() };
      }

      case 'reboot_device': {
        if (!config.allowReboot) {
          throw new Error('reboot not allowed on this device (SIGNAGE_ALLOW_REBOOT is not true)');
        }
        // Delay so the completed result reaches the backend before we go down.
        setTimeout(() => {
          exec('systemctl reboot', (err) => {
            if (err) this.deps.log.error({ err }, 'reboot failed');
          });
        }, 2_000).unref();
        return { rebooting: true };
      }

      case 'refresh_content':
        await sync.syncNow('refresh_content command');
        return { manifestVersion: this.manifestVersion() };

      case 'clear_cache':
        await sync.clearCacheAndResync();
        return { manifestVersion: this.manifestVersion() };

      case 'take_screenshot':
        return this.takeScreenshot();

      case 'identify': {
        const duration =
          typeof command.payload.durationSeconds === 'number'
            ? command.payload.durationSeconds
            : 10;
        playerServer.sendIdentify(playerServer.getState().deviceName, duration);
        return { durationSeconds: duration };
      }

      case 'show_message': {
        // The API validates this payload, but the agent must not depend on that:
        // commands also arrive over the polling fallback, and a device running
        // against an older or a hand-driven backend still has to behave.
        const text = typeof command.payload.text === 'string' ? command.payload.text.trim() : '';
        if (!text) throw new Error('show_message requires payload.text');
        const duration =
          typeof command.payload.durationSeconds === 'number' && command.payload.durationSeconds > 0
            ? command.payload.durationSeconds
            : 10;
        playerServer.sendShowMessage(text, duration);
        return { text, durationSeconds: duration };
      }

      // The backend already mutated org/device state for these; the device
      // just needs to pull the new manifest and re-render.
      case 'set_orientation':
      case 'set_playlist':
      case 'update_settings':
      case 'show_emergency':
      case 'stop_emergency':
        await sync.syncNow(`${command.type} command`);
        return { manifestVersion: this.manifestVersion() };

      case 'send_logs': {
        const flushed = await this.deps.flushBuffers();
        return { sentLogs: flushed.logs, sentEvents: flushed.events };
      }

      case 'health_check': {
        const metrics = await this.deps.getMetrics();
        return metrics as unknown as Record<string, unknown>;
      }

      case 'software_update': {
        if (!config.updateCmd) throw new Error('no update command configured (SIGNAGE_UPDATE_CMD)');
        const { stdout, stderr } = await execAsync(config.updateCmd, {
          timeout: 10 * 60_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        return { output: `${stdout}\n${stderr}`.trim().slice(-2000) };
      }

      default:
        throw new Error(`unknown command type: ${command.type}`);
    }
  }

  private manifestVersion(): string | null {
    return this.deps.getManifestVersion();
  }

  private async takeScreenshot(): Promise<Record<string, unknown>> {
    const { config, api } = this.deps;
    let buffer: Buffer;
    let placeholder = false;
    if (config.screenshotCmd) {
      await mkdir(config.tmpDir, { recursive: true });
      const outPath = join(config.tmpDir, `screenshot-${Date.now()}.png`);
      try {
        await execAsync(`${config.screenshotCmd} "${outPath}"`, { timeout: 60_000 });
        buffer = await readFile(outPath);
      } finally {
        await rm(outPath, { force: true }).catch(() => undefined);
      }
    } else {
      // No capture tool (mock device / headless): send a valid generated PNG
      // so the whole screenshot pipeline still works end to end.
      buffer = solidColorPng(1280, 720, [15, 23, 42]);
      placeholder = true;
    }
    await api.sendScreenshot(buffer.toString('base64'), 'image/png');
    return { sizeBytes: buffer.length, placeholder };
  }
}
