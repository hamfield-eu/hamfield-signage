import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Logger } from 'pino';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  AgentToPlayerMessage,
  PlayerProgressMessage,
  PlayerState,
  PlayerToAgentMessage,
} from '@signage/shared';
import type { AgentConfig } from './config';
import type { AgentDb } from './db';
import { stateFingerprint } from './state';

/** Minimum gap between LRU bookkeeping writes for one media id. */
const CACHE_USE_WRITE_INTERVAL_MS = 5 * 60_000;

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const FALLBACK_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Signage</title>
<style>html,body{margin:0;height:100%;background:#0b1220;color:#e2e8f0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center}#m{font-size:3vw;text-align:center;padding:0 8vw}</style>
</head><body><div id="m">Connecting to signage agent…</div>
<script>
const el=document.getElementById('m');
function connect(){
  const ws=new WebSocket('ws://'+location.host+'/ws');
  ws.onopen=()=>ws.send(JSON.stringify({type:'player_ready'}));
  ws.onmessage=(e)=>{const msg=JSON.parse(e.data);
    if(msg.type==='state'){el.textContent=msg.state.statusMessage||('Playlist: '+(msg.state.playlistName||'none')+' ('+msg.state.items.length+' items) - install the full player UI for playback');}
    if(msg.type==='identify'){el.textContent='I am '+msg.deviceName;}};
  ws.onclose=()=>setTimeout(connect,2000);
}
connect();
</script></body></html>`;

/**
 * Local HTTP/WS server the kiosk browser talks to. Serves the player UI,
 * streams cached media (with Range support so the video element can seek),
 * and pushes PlayerState updates over the websocket.
 */
export class PlayerServer {
  private server: http.Server;
  private wss: WebSocketServer;
  private sockets = new Set<WebSocket>();
  private state: PlayerState;
  private fingerprint = '';
  /** Epoch ms of the last player_progress message, or null if none yet. */
  private lastProgressAt: number | null = null;
  /** The last progress report, for diagnostics. */
  private lastProgress: PlayerProgressMessage | null = null;
  /** Epoch ms a player socket was last seen open. */
  private lastSocketAt: number | null = null;
  /** Last LRU write per media id; see `noteCacheUse`. */
  private lastUseWrite = new Map<string, number>();

  constructor(
    private config: AgentConfig,
    private db: AgentDb,
    private log: Logger,
    private onPlaybackEvent: (
      event: Extract<PlayerToAgentMessage, { type: 'playback_event' }>,
    ) => void,
  ) {
    this.state = {
      revision: 0,
      deviceName: 'Signage device',
      orientation: 'landscape',
      rotation: 0,
      source: 'none',
      playlistId: null,
      playlistName: null,
      loop: false,
      playbackOrderMode: 'manual_order',
      items: [],
      priorityRules: [],
      statusMessage: 'Starting…',
      paired: false,
      online: false,
    };
    this.fingerprint = stateFingerprint({ ...this.state });

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        this.log.warn({ err }, 'player server request failed');
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
    this.wss.on('connection', (socket) => this.handleSocket(socket));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.playerPort, () => {
        this.server.removeListener('error', reject);
        resolvePromise();
      });
    });
    this.log.info({ port: this.config.playerPort }, 'player server listening');
  }

  getState(): PlayerState {
    return this.state;
  }

  /**
   * What the agent knows about the player being alive (T015).
   *
   * `progress` is the signal that matters: a wedged video keeps its socket open
   * and emits no playback events, so socket presence alone proves nothing.
   */
  getLiveness(): {
    connected: boolean;
    socketCount: number;
    lastSocketAt: number | null;
    lastProgressAt: number | null;
    advancing: boolean | null;
  } {
    return {
      connected: this.sockets.size > 0,
      socketCount: this.sockets.size,
      lastSocketAt: this.sockets.size > 0 ? Date.now() : this.lastSocketAt,
      lastProgressAt: this.lastProgressAt,
      advancing: this.lastProgress?.advancing ?? null,
    };
  }

  /**
   * Replaces the content-relevant part of the state; bumps the revision and
   * broadcasts only when the fingerprint actually changed.
   */
  setState(next: Omit<PlayerState, 'revision'>): boolean {
    const fingerprint = stateFingerprint(next);
    if (fingerprint === this.fingerprint) return false;
    this.fingerprint = fingerprint;
    this.state = { ...next, revision: this.state.revision + 1 };
    this.broadcast({ type: 'state', state: this.state });
    return true;
  }

  sendIdentify(deviceName: string, durationSeconds: number): void {
    this.broadcast({ type: 'identify', deviceName, durationSeconds });
  }

  /** Closes player sockets; the player UI reconnects and reloads its state. */
  kickPlayers(): number {
    const count = this.sockets.size;
    for (const socket of this.sockets) socket.close(4000, 'restart');
    return count;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    this.wss.close();
    await new Promise<void>((resolvePromise) => this.server.close(() => resolvePromise()));
  }

  private broadcast(message: AgentToPlayerMessage): void {
    const data = JSON.stringify(message);
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    }
  }

  private handleSocket(socket: WebSocket): void {
    this.sockets.add(socket);
    this.lastSocketAt = Date.now();
    const forget = () => {
      this.sockets.delete(socket);
      this.lastSocketAt = Date.now();
    };
    socket.on('close', forget);
    socket.on('error', forget);
    socket.on('message', (raw) => {
      let message: PlayerToAgentMessage;
      try {
        message = JSON.parse(String(raw)) as PlayerToAgentMessage;
      } catch {
        return;
      }
      if (message.type === 'player_ready') {
        socket.send(
          JSON.stringify({ type: 'state', state: this.state } satisfies AgentToPlayerMessage),
        );
      } else if (message.type === 'playback_event') {
        this.onPlaybackEvent(message);
      } else if (message.type === 'player_progress') {
        // Liveness, never telemetry: these arrive every few seconds and must
        // not reach db.bufferEvent, whose 5,000-row cap would evict real
        // playback events within the hour.
        this.lastProgressAt = Date.now();
        this.lastProgress = message;
      }
    });
    // Push the current state immediately so a reconnecting player recovers fast.
    socket.send(
      JSON.stringify({ type: 'state', state: this.state } satisfies AgentToPlayerMessage),
    );
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://localhost:${this.config.playerPort}`);
    const pathname = decodeURIComponent(url.pathname);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }

    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ ok: true, revision: this.state.revision, paired: this.state.paired }),
      );
      return;
    }

    const mediaMatch = pathname.match(/^\/media\/([A-Za-z0-9_-]+)$/);
    if (mediaMatch) {
      await this.serveMedia(mediaMatch[1], req, res);
      return;
    }

    await this.serveStatic(pathname, res);
  }

  /**
   * Records real last-use, so eviction is an LRU rather than "oldest download".
   *
   * Throttled hard, and that matters: this route serves Range requests — that
   * is what `accept-ranges` is for — and Chromium issues a stream of them while
   * buffering a single video. An unthrottled synchronous SQLite write per range
   * would put flash writes in the middle of the one code path that must never
   * disturb playback. Eviction orders by day-scale recency, so a five-minute
   * resolution loses nothing.
   */
  private noteCacheUse(mediaId: string): void {
    const now = Date.now();
    const last = this.lastUseWrite.get(mediaId) ?? 0;
    if (now - last < CACHE_USE_WRITE_INTERVAL_MS) return;
    this.lastUseWrite.set(mediaId, now);
    this.db.touchCacheUse(mediaId);
  }

  private async serveMedia(
    mediaId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const entry = this.db.getCachedMedia(mediaId);
    if (!entry) {
      res.writeHead(404).end();
      return;
    }
    this.noteCacheUse(mediaId);
    let size: number;
    try {
      size = (await stat(entry.filePath)).size;
    } catch {
      res.writeHead(404).end();
      return;
    }

    const headers: Record<string, string> = {
      'content-type': entry.mimeType,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    };

    const range = req.headers.range;
    const rangeMatch = range?.match(/^bytes=(\d*)-(\d*)$/);
    if (rangeMatch && (rangeMatch[1] || rangeMatch[2])) {
      let start = rangeMatch[1] ? Number(rangeMatch[1]) : NaN;
      let end = rangeMatch[2] ? Number(rangeMatch[2]) : size - 1;
      if (Number.isNaN(start)) {
        // suffix range: last N bytes
        start = Math.max(0, size - Number(rangeMatch[2]));
        end = size - 1;
      }
      end = Math.min(end, size - 1);
      if (start > end || start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, {
        ...headers,
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': String(end - start + 1),
      });
      if (req.method === 'HEAD') return void res.end();
      createReadStream(entry.filePath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, { ...headers, 'content-length': String(size) });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(entry.filePath).pipe(res);
  }

  private async serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
    if (!this.config.playerUiDir) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FALLBACK_HTML);
      return;
    }

    const root = resolve(this.config.playerUiDir);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = normalize(join(root, relative));
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }

    const candidates = [filePath, join(root, 'index.html')];
    for (const candidate of candidates) {
      try {
        const info = await stat(candidate);
        if (!info.isFile()) continue;
        res.writeHead(200, {
          'content-type':
            STATIC_MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
          'content-length': String(info.size),
        });
        createReadStream(candidate).pipe(res);
        return;
      } catch {
        // try next candidate (SPA fallback to index.html)
      }
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(FALLBACK_HTML);
  }
}
