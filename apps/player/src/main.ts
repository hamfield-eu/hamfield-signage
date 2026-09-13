import {
  DEFAULT_IMAGE_DURATION_SECONDS,
  PLAYER_PROGRESS_INTERVAL_MS,
  PLAYER_STALL_REPORTS,
  PlaybackQueueEngine,
  VIDEO_CEILING_FALLBACK_SECONDS,
  cssObjectPosition,
  flexAlignment,
  type AgentToPlayerMessage,
  type PlayerState,
  type PlayerStateItem,
  type PlayerToAgentMessage,
  type QueueResult,
} from '@signage/shared';
import './style.css';

// The agent serving this page is also the websocket/media host. During
// `vite dev` you can point at a remote agent with ?agent=host:port.
const params = new URLSearchParams(location.search);
const agentHost = params.get('agent') ?? location.host;
const isSecure = location.protocol === 'https:';
const mediaBase =
  agentHost === location.host ? '' : `${isSecure ? 'https' : 'http'}://${agentHost}`;
const wsUrl = `${isSecure ? 'wss' : 'ws'}://${agentHost}/ws`;

const stage = document.getElementById('stage') as HTMLDivElement;
const layerEls = [
  document.getElementById('layer-a') as HTMLDivElement,
  document.getElementById('layer-b') as HTMLDivElement,
];
const fallbackEl = document.getElementById('fallback') as HTMLDivElement;
const fbName = document.getElementById('fb-name') as HTMLDivElement;
const fbMessage = document.getElementById('fb-message') as HTMLDivElement;
const fbPaired = document.getElementById('fb-paired') as HTMLSpanElement;
const fbOnline = document.getElementById('fb-online') as HTMLSpanElement;
const fbClock = document.getElementById('fb-clock') as HTMLDivElement;
const identifyEl = document.getElementById('identify') as HTMLDivElement;
const offlineDot = document.getElementById('offline-dot') as HTMLDivElement;

let socket: WebSocket | null = null;

function send(message: PlayerToAgentMessage): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function sendEvent(
  eventType: 'start' | 'end' | 'error' | 'skip',
  item: PlayerStateItem,
  playlistId: string | null,
  detail?: Record<string, unknown>,
  play?: { playedAs: 'normal' | 'priority'; priorityRuleId?: string } | null,
): void {
  send({
    type: 'playback_event',
    eventType,
    itemId: item.id,
    mediaId: item.mediaId,
    playlistId,
    playedAs: play?.playedAs ?? 'normal',
    priorityRuleId: play?.priorityRuleId ?? null,
    detail,
    occurredAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------- playback

const DEFAULT_IMAGE_DURATION = DEFAULT_IMAGE_DURATION_SECONDS;
const ERROR_RETRY_DELAY_MS = 3_000;
/** Ceiling for the exponential backoff on an item that keeps failing. */
const MAX_ERROR_RETRY_DELAY_MS = 60_000;
const PRELOAD_TIMEOUT_MS = 15_000;

let state: PlayerState | null = null;
let playFingerprint = '';
let currentItemId: string | null = null;
let index = 0;
let activeLayer = 0;
let advanceTimer: number | null = null;
let playToken = 0;

// ---------------------------------------------------------- liveness (T015)
//
// A video that decodes its first frame and then wedges fires neither `ended`
// nor `error`, so before this the screen froze forever with no telemetry.
// Two independent nets catch it, and every video item gets both:
//
//   * the ceiling timer — an absolute cap from the agent (`maxDurationSeconds`,
//     the probed duration plus slack), re-armed on each loop of a looping video
//   * stall detection — `timeupdate` stagnation across PLAYER_STALL_REPORTS
//     progress reports, which fires much sooner on a long video
//
// `waiting`/`stalled` are deliberately not used as triggers: they fire during
// ordinary buffering. Stagnation of `currentTime` is the authority.

/** Absolute cap on the current video. Separate from `advanceTimer`, which owns
 *  the normal "this item is done" transition — one timer, one owner. */
let ceilingTimer: number | null = null;
let activeVideo: HTMLVideoElement | null = null;
/** Item currently on screen, for progress reports. */
let activeReportItem: PlayerStateItem | null = null;
/** currentTime at the previous progress report. */
let lastReportedTime: number | null = null;
/** Set by `timeupdate`; the primary evidence that decoding is alive. */
let sawTimeUpdate = false;
/** Previous `timeupdate` position, used to spot a loop wrap. */
let lastTimeUpdateValue: number | null = null;
let stationaryReports = 0;
/** Consecutive progress reports showing real movement. */
let advancingReports = 0;
/** Consecutive error-driven advances; drives the retry backoff. */
let errorStreak = 0;
let lastFailedMediaId: string | null = null;

// Random order modes: the agent ships the resolved pool + priority rules and
// the player shuffles locally so reshuffles never need a state update.
const LAST_MEDIA_KEY = 'signage.lastPlayedMediaId';
let engine: PlaybackQueueEngine | null = null;
let engineItems = new Map<string, PlayerStateItem>();
let currentPlay: QueueResult | null = null;

function isRandomMode(s: PlayerState): boolean {
  return s.playbackOrderMode === 'random' || s.playbackOrderMode === 'random_with_priority_rules';
}

function rebuildEngine(s: PlayerState): void {
  engineItems = new Map(s.items.map((item) => [item.id, item]));
  const rules = (s.playbackOrderMode === 'random_with_priority_rules' ? s.priorityRules : []).map(
    (rule) => {
      for (const item of rule.items) engineItems.set(item.id, item);
      return {
        id: rule.id,
        name: rule.name,
        intervalCount: rule.intervalCount,
        selectionMode: rule.selectionMode,
        position: rule.position,
        createdAt: rule.createdAt,
        entries: rule.items.map((item) => ({ id: item.id, mediaId: item.mediaId })),
      };
    },
  );
  // Remembering the last played media survives player reloads and reboots,
  // avoiding an obvious immediate repeat when a new cycle starts.
  let lastPlayed: string | null = null;
  try {
    lastPlayed = localStorage.getItem(LAST_MEDIA_KEY);
  } catch {
    // storage unavailable (e.g. incognito kiosk) — fine, start fresh
  }
  engine = new PlaybackQueueEngine({
    entries: s.items.map((item) => ({ id: item.id, mediaId: item.mediaId })),
    priorityRules: rules,
    lastPlayedMediaId: lastPlayed,
  });
  currentPlay = null;
}

function rememberLastPlayed(mediaId: string): void {
  try {
    localStorage.setItem(LAST_MEDIA_KEY, mediaId);
  } catch {
    // ignored
  }
}

function clearAdvanceTimer(): void {
  if (advanceTimer !== null) {
    window.clearTimeout(advanceTimer);
    advanceTimer = null;
  }
}

function clearCeilingTimer(): void {
  if (ceilingTimer !== null) {
    window.clearTimeout(ceilingTimer);
    ceilingTimer = null;
  }
}

/** Detaches the current video from liveness tracking (fallback, teardown). */
function detachVideo(): void {
  clearCeilingTimer();
  activeVideo = null;
  activeReportItem = null;
  lastReportedTime = null;
  lastTimeUpdateValue = null;
  sawTimeUpdate = false;
  stationaryReports = 0;
  advancingReports = 0;
}

/** Exponential backoff so an item that always fails cannot spin at 3 s and
 *  flood the agent's bounded event buffer. */
function retryDelayMs(): number {
  const factor = 2 ** Math.max(0, errorStreak - 1);
  return Math.min(ERROR_RETRY_DELAY_MS * factor, MAX_ERROR_RETRY_DELAY_MS);
}

/**
 * Playback is demonstrably alive again: forget the failure history.
 *
 * Called only on evidence that the item actually *worked* — an image that
 * rendered, a clean end, or sustained movement across progress reports. A
 * single `timeupdate` is NOT such evidence: a corrupt stream that decodes one
 * second and then wedges emits one, and resetting on it would pin the backoff
 * at its 3 s floor forever, retrying roughly every 18 s and filling the agent's
 * 5,000-row event buffer within a day. That is the exact flooding the backoff
 * exists to prevent.
 */
function noteProgress(): void {
  errorStreak = 0;
  lastFailedMediaId = null;
}

function fitClass(item: PlayerStateItem): string {
  return `fit-${item.fitMode}`;
}

/** Applies fit class + alignment to the media element (used for all fit modes). */
function styleMediaElement(el: HTMLElement, item: PlayerStateItem): void {
  el.className = fitClass(item);
  // object-position positions media within contain/cover; harmless otherwise.
  el.style.objectPosition = cssObjectPosition(item.positionMode);
}

function buildMediaElement(item: PlayerStateItem): Promise<HTMLImageElement | HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const url = `${mediaBase}${item.url}`;
    const timeout = window.setTimeout(
      () => reject(new Error('media load timeout')),
      PRELOAD_TIMEOUT_MS,
    );

    if (item.mediaType === 'image') {
      const img = document.createElement('img');
      styleMediaElement(img, item);
      img.onload = () => {
        window.clearTimeout(timeout);
        resolve(img);
      };
      img.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error('image failed to load'));
      };
      img.src = url;
    } else {
      const video = document.createElement('video');
      styleMediaElement(video, item);
      // Muted autoplay is required for kiosk Chromium; audio is out of scope
      // for v1 but nothing here prevents unmuting later.
      video.muted = true;
      video.autoplay = false;
      video.playsInline = true;
      video.preload = 'auto';
      video.oncanplay = () => {
        window.clearTimeout(timeout);
        resolve(video);
      };
      video.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error('video failed to load'));
      };
      video.src = url;
    }
  });
}

function swapToLayer(layer: number, element: HTMLElement, item: PlayerStateItem): void {
  const next = layerEls[layer];
  const prev = layerEls[1 - layer];
  // Background color sits behind the media (no white flash); the stage matches
  // so rotated/letterboxed areas use the same color.
  next.style.backgroundColor = item.backgroundColor;
  stage.style.backgroundColor = item.backgroundColor;
  // Alignment for natural-size modes (original/scale_down) via the flex layer.
  const { justify, align } = flexAlignment(item.positionMode);
  next.style.justifyContent = justify;
  next.style.alignItems = align;
  next.replaceChildren(element);
  next.classList.add('visible');
  prev.classList.remove('visible');
  window.setTimeout(() => {
    if (!next.classList.contains('visible')) return;
    prev.replaceChildren();
  }, 600);
}

function scheduleAdvance(seconds: number): void {
  clearAdvanceTimer();
  advanceTimer = window.setTimeout(() => advance('end'), Math.max(0.5, seconds) * 1000);
}

/** The item that should be on screen right now, for any order mode. */
function activeItem(): PlayerStateItem | null {
  if (!state) return null;
  if (isRandomMode(state)) {
    return currentPlay ? (engineItems.get(currentPlay.entry.id) ?? null) : null;
  }
  return state.items[index] ?? null;
}

/**
 * Records a playback failure and moves on immediately — the screen must never
 * keep showing a frame that is not playing. The retry backoff is applied in
 * `showCurrent`, so it throttles only the case where the very same media comes
 * straight back (a one-item playlist or an emergency single video).
 */
function failCurrent(
  item: PlayerStateItem,
  playlistId: string | null,
  play: { playedAs: 'normal' | 'priority'; priorityRuleId?: string } | null,
  detail: Record<string, unknown>,
): void {
  errorStreak++;
  lastFailedMediaId = item.mediaId;
  sendEvent('error', item, playlistId, detail, play);
  advance('error');
}

function advance(reason: 'end' | 'error'): void {
  if (!state) return;

  if (isRandomMode(state)) {
    const item = activeItem();
    if (item && reason === 'end') {
      noteProgress();
      sendEvent('end', item, state.playlistId, undefined, currentPlay);
    }
    currentPlay = engine?.next() ?? null;
    if (!currentPlay) return;
    void showCurrent();
    return;
  }

  if (state.items.length === 0) return;
  const item = state.items[index];
  if (item && reason === 'end') {
    noteProgress();
    sendEvent('end', item, state.playlistId);
  }

  const last = index >= state.items.length - 1;
  if (last && !state.loop) {
    // Non-looping playlist finished: hold the final still frame; videos have
    // ended so for a video item we fall back to the info screen instead.
    clearAdvanceTimer();
    if (item?.mediaType === 'video') {
      playToken++;
      detachVideo();
      layerEls[activeLayer].classList.remove('visible');
      showFallback(true);
    }
    return;
  }
  index = last ? 0 : index + 1;
  void showCurrent();
}

async function showCurrent(): Promise<void> {
  if (!state) return;
  const item = activeItem();
  if (!item) return;
  const token = ++playToken;
  clearAdvanceTimer();
  detachVideo();
  currentItemId = item.id;
  const playlistId = state.playlistId;
  const play = isRandomMode(state) ? currentPlay : null;
  const single = !isRandomMode(state) && state.items.length === 1 && state.loop;

  // The same media coming straight back after a failure means the playlist has
  // nothing else to offer. Wait out the backoff before trying again rather than
  // hammering it — the frame is already wrong either way, and a 3 s loop would
  // fill the agent's bounded event buffer within the hour.
  if (errorStreak > 0 && item.mediaId === lastFailedMediaId) {
    const delay = retryDelayMs();
    await new Promise<void>((r) => window.setTimeout(r, delay));
    if (token !== playToken) return;
  }

  let element: HTMLImageElement | HTMLVideoElement;
  try {
    element = await buildMediaElement(item);
  } catch (err) {
    if (token !== playToken) return;
    failCurrent(item, playlistId, play, {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (token !== playToken) return;

  activeLayer = 1 - activeLayer;
  swapToLayer(activeLayer, element, item);
  showFallback(false);
  sendEvent('start', item, playlistId, undefined, play);
  if (state && isRandomMode(state)) rememberLastPlayed(item.mediaId);

  if (element instanceof HTMLVideoElement) {
    const video = element;
    activeVideo = video;
    activeReportItem = item;
    lastReportedTime = null;
    sawTimeUpdate = false;
    stationaryReports = 0;

    if (single) {
      // One looping video: let the element loop natively, no re-decode churn.
      video.loop = true;
    } else {
      video.onended = () => {
        if (token === playToken) advance('end');
      };
    }
    video.onerror = () => {
      if (token !== playToken) return;
      failCurrent(item, playlistId, play, { error: 'video playback error' });
    };
    video.ontimeupdate = () => {
      if (token !== playToken) return;
      const now = video.currentTime;
      // A jump backwards is the element looping; give the ceiling a fresh
      // window so a healthy looping video is never cut off mid-iteration.
      if (lastTimeUpdateValue !== null && now + 0.5 < lastTimeUpdateValue) {
        armCeiling(item, playlistId, play, token);
      }
      lastTimeUpdateValue = now;
      sawTimeUpdate = true;
    };
    video.play().catch(() => {
      // Autoplay should not be blocked with muted=true. If it ever is,
      // currentTime never moves and stall detection picks it up.
    });

    // F1: this is the fix. Every video gets a ceiling, including the single
    // looping case, which previously had no timer of any kind.
    lastTimeUpdateValue = null;
    armCeiling(item, playlistId, play, token);

    if (item.durationSeconds && item.durationSeconds > 0 && !single) {
      // An operator-set per-item duration still owns the normal transition.
      scheduleAdvance(item.durationSeconds);
    }
  } else {
    noteProgress();
    if (!single) scheduleAdvance(item.durationSeconds ?? DEFAULT_IMAGE_DURATION);
  }
}

/** (Re)arms the absolute cap for the video currently on screen. */
function armCeiling(
  item: PlayerStateItem,
  playlistId: string | null,
  play: { playedAs: 'normal' | 'priority'; priorityRuleId?: string } | null,
  token: number,
): void {
  clearCeilingTimer();
  const seconds =
    item.maxDurationSeconds && item.maxDurationSeconds > 0
      ? item.maxDurationSeconds
      : VIDEO_CEILING_FALLBACK_SECONDS;
  ceilingTimer = window.setTimeout(() => {
    ceilingTimer = null;
    if (token !== playToken) return;
    failCurrent(item, playlistId, play, {
      reason: 'stall_timeout',
      ceilingSeconds: seconds,
    });
  }, seconds * 1000);
}

// ------------------------------------------------------------ state intake

/**
 * What counts as "the content changed" and therefore restarts playback.
 *
 * `maxDurationSeconds` is deliberately NOT part of this. It is a safety bound,
 * not content: when the worker re-probes a video and the ceiling shifts by a
 * second, the screen must not jump back to the first item. The agent's
 * `stateFingerprint` does include it (it hashes the whole state), so a new
 * revision still reaches the player — it just does not interrupt playback.
 */
function contentFingerprint(s: PlayerState): string {
  return JSON.stringify([
    s.items.map((i) => [
      i.id,
      i.url,
      i.durationSeconds,
      i.fitMode,
      i.backgroundColor,
      i.positionMode,
    ]),
    s.loop,
    s.source,
    s.playbackOrderMode,
    (s.priorityRules ?? []).map((r) => [
      r.id,
      r.intervalCount,
      r.selectionMode,
      r.position,
      r.items.map((i) => i.id),
    ]),
  ]);
}

function hasPlayableContent(s: PlayerState): boolean {
  if (s.items.length > 0) return true;
  return isRandomMode(s) && (s.priorityRules ?? []).some((r) => r.items.length > 0);
}

function applyState(next: PlayerState): void {
  state = next;

  // The stage is rotated purely to compensate for physical mounting; the
  // content orientation (next.orientation) only affects content-matching and
  // the dashboard preview, not how we render here.
  stage.classList.remove('rot-90', 'rot-180', 'rot-270');
  if (next.rotation) stage.classList.add(`rot-${next.rotation}`);

  updateFallbackContent(next);
  offlineDot.classList.toggle('hidden', next.online || !hasPlayableContent(next));

  const fingerprint = contentFingerprint(next);
  if (fingerprint === playFingerprint) return;
  playFingerprint = fingerprint;

  if (!hasPlayableContent(next)) {
    playToken++;
    currentItemId = null;
    currentPlay = null;
    engine = null;
    clearAdvanceTimer();
    detachVideo();
    layerEls[0].classList.remove('visible');
    layerEls[1].classList.remove('visible');
    layerEls[0].replaceChildren();
    layerEls[1].replaceChildren();
    showFallback(true);
    return;
  }

  if (isRandomMode(next)) {
    // Content changed: build a fresh shuffle over the new pool and start it.
    rebuildEngine(next);
    currentPlay = engine?.next() ?? null;
    void showCurrent();
    return;
  }
  engine = null;
  currentPlay = null;

  // Keep playing the same item if it survived the update; otherwise restart.
  const keepIndex = currentItemId ? next.items.findIndex((i) => i.id === currentItemId) : -1;
  index = keepIndex >= 0 ? keepIndex : 0;
  if (keepIndex < 0) {
    void showCurrent();
  }
}

function showFallback(visible: boolean): void {
  fallbackEl.classList.toggle('hidden', !visible);
}

function updateFallbackContent(s: PlayerState): void {
  fbName.textContent = s.deviceName;
  fbMessage.textContent = s.statusMessage ?? '';
  fbPaired.textContent = s.paired ? 'Paired' : 'Not paired';
  fbPaired.className = `badge ${s.paired ? 'ok' : 'bad'}`;
  fbOnline.textContent = s.online ? 'Online' : 'Offline';
  fbOnline.className = `badge ${s.online ? 'ok' : 'bad'}`;
}

window.setInterval(() => {
  fbClock.textContent = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}, 1000);

// ------------------------------------------------- progress + stall report

/**
 * Reports liveness to the agent on a steady interval, and decides whether the
 * video on screen is wedged.
 *
 * `timeupdate` having fired since the last report is the primary signal —
 * during buffering it stops, during playback it fires several times a second,
 * and it also survives a looping video whose `currentTime` happens to land on
 * the same value twice.
 */
function reportProgress(): void {
  const video = activeVideo;
  const item = activeReportItem;
  const currentTime = video ? video.currentTime : null;
  const advancing = video ? sawTimeUpdate || currentTime !== lastReportedTime : true;

  send({
    type: 'player_progress',
    itemId: item?.id ?? null,
    mediaId: item?.mediaId ?? null,
    currentTime,
    advancing,
    revision: state?.revision ?? 0,
  });

  lastReportedTime = currentTime;
  sawTimeUpdate = false;

  if (!video || !item || !state) return;
  if (video.ended) return;

  if (advancing) {
    stationaryReports = 0;
    // Two consecutive moving reports (~10 s) is sustained playback, not the
    // single frame a corrupt stream manages before it wedges.
    if (++advancingReports >= 2) noteProgress();
    return;
  }
  advancingReports = 0;
  stationaryReports++;
  if (stationaryReports < PLAYER_STALL_REPORTS) return;

  // Wedged. Do not wait for the ceiling — on a long video that could be
  // minutes of a frozen frame.
  stationaryReports = 0;
  const playlistId = state.playlistId;
  const play = isRandomMode(state) ? currentPlay : null;
  failCurrent(item, playlistId, play, {
    reason: 'stall_timeout',
    detectedBy: 'timeupdate_stagnation',
    currentTime,
  });
}

window.setInterval(reportProgress, PLAYER_PROGRESS_INTERVAL_MS);

// --------------------------------------------------------------- identify

let identifyTimer: number | null = null;

function showIdentify(deviceName: string, durationSeconds: number): void {
  identifyEl.textContent = deviceName;
  identifyEl.classList.remove('hidden');
  if (identifyTimer !== null) window.clearTimeout(identifyTimer);
  identifyTimer = window.setTimeout(() => {
    identifyEl.classList.add('hidden');
    identifyTimer = null;
  }, durationSeconds * 1000);
}

// ------------------------------------------------------------- agent link

function connect(): void {
  socket = new WebSocket(wsUrl);
  socket.onopen = () => send({ type: 'player_ready' });
  socket.onmessage = (event) => {
    let message: AgentToPlayerMessage;
    try {
      message = JSON.parse(String(event.data)) as AgentToPlayerMessage;
    } catch {
      return;
    }
    if (message.type === 'state') {
      applyState(message.state);
    } else if (message.type === 'identify') {
      showIdentify(message.deviceName, message.durationSeconds);
    }
  };
  socket.onclose = () => {
    socket = null;
    window.setTimeout(connect, 2000);
  };
  socket.onerror = () => {
    socket?.close();
  };
}

showFallback(true);
fbMessage.textContent = 'Connecting to signage agent…';
connect();
