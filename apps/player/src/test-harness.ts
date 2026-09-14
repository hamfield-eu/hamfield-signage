/**
 * jsdom scaffolding for the player tests.
 *
 * `main.ts` is a script, not a module with an API: it grabs DOM nodes at import
 * time, opens a websocket and starts timers. The tests therefore drive the real
 * thing through the same two surfaces the agent uses — the socket and the media
 * elements — rather than a reimplementation of it, which is the only way a
 * regression test for F1 is worth anything.
 */
import { vi } from 'vitest';
import type {
  AgentToPlayerMessage,
  PlayerState,
  PlayerStateItem,
  PlayerToAgentMessage,
} from '@signage/shared';

const STAGE_HTML = `
  <div id="stage">
    <div id="layer-a" class="layer"></div>
    <div id="layer-b" class="layer"></div>
    <div id="fallback" class="hidden">
      <div class="fallback-inner">
        <div id="fb-name">Signage</div>
        <div id="fb-message"></div>
        <div id="fb-badges">
          <span id="fb-paired" class="badge"></span>
          <span id="fb-online" class="badge"></span>
        </div>
        <div id="fb-clock"></div>
      </div>
    </div>
    <div id="overlay" class="hidden"></div>
    <div id="offline-dot" class="hidden"></div>
  </div>
`;

export interface Harness {
  /** Everything the player has sent to the agent, in order. */
  sent: PlayerToAgentMessage[];
  /** Pushes a PlayerState to the player, as the agent would. */
  pushState: (state: PlayerState) => void;
  /** Pushes any agent message — identify, show_message — down the socket. */
  push: (message: AgentToPlayerMessage) => void;
  /** The <video> currently on screen, if any. */
  video: () => HTMLVideoElement | null;
  /** Moves a video's position and fires `timeupdate`, as a real element would. */
  tick: (seconds: number) => void;
  /** Advances fake time, letting pending promises settle. */
  advance: (ms: number) => Promise<void>;
  /** Runs `ms` of time while keeping a healthy video's position moving. */
  playFor: (ms: number, opts?: { loopEvery?: number }) => Promise<void>;
  /** Makes every subsequent media load fail. */
  failLoads: (fail: boolean) => void;
  events: (eventType: string) => Extract<PlayerToAgentMessage, { type: 'playback_event' }>[];
}

let loadsFail = false;

class FakeSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = FakeSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    public url: string,
    private sink: PlayerToAgentMessage[],
    private register: (socket: FakeSocket) => void,
  ) {
    this.register(this);
    setTimeout(() => this.onopen?.(), 0);
  }
  send(data: string): void {
    this.sink.push(JSON.parse(data) as PlayerToAgentMessage);
  }
  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }
}

/**
 * jsdom implements no media loading at all, so `src` never resolves and
 * `currentTime` is read-only. These shims give the elements just enough
 * behaviour for the player's own logic to run unmodified.
 */
function installMediaShims(): void {
  const positions = new WeakMap<object, number>();

  const defineSrc = (proto: object, ready: string) => {
    Object.defineProperty(proto, 'src', {
      configurable: true,
      get(this: Element) {
        return this.getAttribute('src') ?? '';
      },
      set(this: Element & Record<string, unknown>, value: string) {
        this.setAttribute('src', value);
        // A macrotask, so fake timers drive loading deterministically.
        setTimeout(() => {
          if (loadsFail) (this.onerror as (() => void) | null)?.();
          else (this[ready] as (() => void) | null)?.();
        }, 0);
      },
    });
  };

  defineSrc(window.HTMLImageElement.prototype, 'onload');
  defineSrc(window.HTMLMediaElement.prototype, 'oncanplay');

  Object.defineProperty(window.HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get(this: object) {
      return positions.get(this) ?? 0;
    },
    set(this: object, value: number) {
      positions.set(this, value);
    },
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, 'ended', {
    configurable: true,
    get: () => false,
  });
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  window.HTMLMediaElement.prototype.load = vi.fn();
}

export function baseState(items: PlayerStateItem[], overrides: Partial<PlayerState> = {}) {
  return {
    revision: 1,
    deviceName: 'Lobby',
    orientation: 'landscape',
    rotation: 0,
    source: 'default',
    playlistId: 'pl-1',
    playlistName: 'Default',
    loop: true,
    playbackOrderMode: 'manual_order',
    items,
    priorityRules: [],
    statusMessage: null,
    paired: true,
    online: true,
    ...overrides,
  } as PlayerState;
}

export function videoItem(overrides: Partial<PlayerStateItem> = {}): PlayerStateItem {
  return {
    id: 'item-video',
    mediaId: 'vid-1',
    mediaType: 'video',
    url: '/media/vid-1',
    durationSeconds: null,
    maxDurationSeconds: 40,
    fitMode: 'contain',
    backgroundColor: '#000000',
    positionMode: 'center',
    width: 1920,
    height: 1080,
    ...overrides,
  };
}

export function imageItem(overrides: Partial<PlayerStateItem> = {}): PlayerStateItem {
  return {
    id: 'item-image',
    mediaId: 'img-1',
    mediaType: 'image',
    url: '/media/img-1',
    durationSeconds: 5,
    maxDurationSeconds: null,
    fitMode: 'contain',
    backgroundColor: '#000000',
    positionMode: 'center',
    width: 1920,
    height: 1080,
    ...overrides,
  };
}

export async function startPlayer(): Promise<Harness> {
  loadsFail = false;
  document.body.innerHTML = STAGE_HTML;
  const sent: PlayerToAgentMessage[] = [];
  let socket: FakeSocket | null = null;

  vi.stubGlobal(
    'WebSocket',
    class extends FakeSocket {
      constructor(url: string) {
        super(url, sent, (s) => {
          socket = s;
        });
      }
    },
  );

  installMediaShims();
  vi.useFakeTimers();
  vi.resetModules();
  await import('./main');
  await vi.advanceTimersByTimeAsync(1);

  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  const video = () => document.querySelector('video');

  const tick = (seconds: number) => {
    const el = video();
    if (!el) return;
    el.currentTime = seconds;
    (el.ontimeupdate as ((e: Event) => void) | null)?.(new Event('timeupdate'));
  };

  const playFor: Harness['playFor'] = async (ms, opts = {}) => {
    const step = 500;
    const loopEvery = opts.loopEvery ?? Infinity;
    let position = video()?.currentTime ?? 0;
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      position += step / 1000;
      if (position >= loopEvery) position = 0;
      tick(position);
      await advance(step);
    }
  };

  return {
    sent,
    pushState: (state) => {
      socket?.onmessage?.({ data: JSON.stringify({ type: 'state', state }) });
    },
    push: (message) => {
      socket?.onmessage?.({ data: JSON.stringify(message) });
    },
    video,
    tick,
    advance,
    playFor,
    failLoads: (fail: boolean) => {
      loadsFail = fail;
    },
    events: (eventType) =>
      sent.filter(
        (m): m is Extract<PlayerToAgentMessage, { type: 'playback_event' }> =>
          m.type === 'playback_event' && m.eventType === eventType,
      ),
  };
}
