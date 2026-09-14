import type {
  CommandType,
  FitMode,
  PlaybackOrderMode,
  PlayedAs,
  PositionMode,
  PrioritySelectionMode,
} from './enums';

// ============================================================
// Device <-> Backend WebSocket protocol (outbound from device)
// ============================================================

/** Sent by the device immediately after connecting. */
export interface DeviceHelloMessage {
  type: 'hello';
  appVersion: string;
  manifestVersion: string | null;
}

/** Periodic heartbeat over the socket (same shape as the REST heartbeat body). */
export interface DeviceWsHeartbeatMessage {
  type: 'heartbeat';
  payload: Record<string, unknown>;
}

export interface DeviceCommandAckMessage {
  type: 'command_ack';
  commandId: string;
}

export interface DeviceCommandResultMessage {
  type: 'command_result';
  commandId: string;
  status: 'completed' | 'failed';
  result?: Record<string, unknown>;
}

export interface DeviceStatusMessage {
  type: 'status';
  currentPlaylistId: string | null;
  currentMediaId: string | null;
  manifestVersion: string | null;
}

export type DeviceToServerMessage =
  | DeviceHelloMessage
  | DeviceWsHeartbeatMessage
  | DeviceCommandAckMessage
  | DeviceCommandResultMessage
  | DeviceStatusMessage;

/** Backend pushes a command to the device through the open socket. */
export interface ServerCommandMessage {
  type: 'command';
  command: {
    id: string;
    type: CommandType;
    payload: Record<string, unknown>;
  };
}

/** Backend tells the device its content changed; device should sync now. */
export interface ServerSyncRequiredMessage {
  type: 'sync_required';
  reason: string;
}

export interface ServerHelloAckMessage {
  type: 'hello_ack';
  serverTime: string;
  manifestVersion: string;
}

export interface ServerPongMessage {
  type: 'pong';
}

export type ServerToDeviceMessage =
  | ServerCommandMessage
  | ServerSyncRequiredMessage
  | ServerHelloAckMessage
  | ServerPongMessage;

// ============================================================
// Player UI <-> Device agent local protocol
// ============================================================

export interface PlayerStateItem {
  /** Playlist item id (or synthetic id for emergency single media). */
  id: string;
  mediaId: string;
  mediaType: 'image' | 'video';
  /** Local URL served by the agent, e.g. /media/<mediaId> */
  url: string;
  durationSeconds: number | null;
  /**
   * Hard ceiling, in seconds, after which the player abandons a video item
   * even if it never fired `ended`. Videos only; null for images and for
   * pre-T015 agents, where the player falls back to its own ceiling.
   *
   * Deliberately separate from `durationSeconds`: that field means "advance at
   * exactly this time" and would truncate a video that runs slightly long.
   */
  maxDurationSeconds?: number | null;
  /** Resolved (effective) display settings — never null in player state. */
  fitMode: FitMode;
  backgroundColor: string;
  positionMode: PositionMode;
  width: number | null;
  height: number | null;
  name?: string;
}

export interface PlayerPriorityRule {
  id: string;
  name: string;
  /** One rule item plays after every `intervalCount` normal items. */
  intervalCount: number;
  selectionMode: PrioritySelectionMode;
  position: number;
  createdAt?: string;
  /** Playable rule content, resolved and cached like normal items. */
  items: PlayerStateItem[];
}

export interface PlayerState {
  /** Increments whenever the playable content changes. */
  revision: number;
  deviceName: string;
  /** Content canvas shape; drives content-matching and the dashboard preview. */
  orientation: 'landscape' | 'portrait';
  /** Software rotation (clockwise degrees) the player applies to the stage. */
  rotation: 0 | 90 | 180 | 270;
  source: 'emergency' | 'schedule' | 'default' | 'none';
  playlistId: string | null;
  playlistName: string | null;
  loop: boolean;
  /**
   * How the player should order `items`. For manual/alphabetical the items
   * are already in final order; for the random modes the player shuffles.
   */
  playbackOrderMode: PlaybackOrderMode;
  items: PlayerStateItem[];
  /** Active only when playbackOrderMode is random_with_priority_rules. */
  priorityRules: PlayerPriorityRule[];
  /** Shown on the fallback screen when there is nothing to play. */
  statusMessage: string | null;
  paired: boolean;
  online: boolean;
  identify?: boolean;
}

export interface AgentToPlayerStateMessage {
  type: 'state';
  state: PlayerState;
}

export interface AgentToPlayerIdentifyMessage {
  type: 'identify';
  deviceName: string;
  durationSeconds: number;
}

/**
 * Operator text to put on the screen, e.g. "Closing at 4pm today".
 *
 * A separate message type rather than a `text` field on identify: the player is
 * a browser, and a kiosk that has not reloaded is running yesterday's bundle
 * against today's agent. An unknown message type is ignored by an old player;
 * a changed one would render `undefined` across the screen.
 */
export interface AgentToPlayerShowMessageMessage {
  type: 'show_message';
  text: string;
  durationSeconds: number;
}

export type AgentToPlayerMessage =
  | AgentToPlayerStateMessage
  | AgentToPlayerIdentifyMessage
  | AgentToPlayerShowMessageMessage;

export interface PlayerPlaybackEventMessage {
  type: 'playback_event';
  eventType: 'start' | 'end' | 'error' | 'skip';
  itemId: string;
  mediaId: string;
  playlistId: string | null;
  /** Whether the item played as normal content or via a priority rule. */
  playedAs?: PlayedAs;
  priorityRuleId?: string | null;
  durationSeconds?: number | null;
  detail?: Record<string, unknown>;
  occurredAt: string;
}

export interface PlayerReadyMessage {
  type: 'player_ready';
}

/**
 * Liveness, not telemetry. Sent on a steady interval while the player has
 * something on screen, so the agent can tell "playing" from "wedged" — a
 * stalled video emits no playback_event at all.
 *
 * The agent must NOT buffer these into `event_buffer`; they would flood its
 * 5,000-row cap and push out real playback events.
 */
export interface PlayerProgressMessage {
  type: 'player_progress';
  itemId: string | null;
  mediaId: string | null;
  /** Video position in seconds; null for images and the fallback screen. */
  currentTime: number | null;
  /** False when `currentTime` has not moved since the previous report. */
  advancing: boolean;
  /** PlayerState.revision the player is currently rendering. */
  revision: number;
}

export type PlayerToAgentMessage =
  | PlayerPlaybackEventMessage
  | PlayerReadyMessage
  | PlayerProgressMessage;
