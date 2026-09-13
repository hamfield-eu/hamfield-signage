# Sync protocol

How a device's content gets from the cloud to the screen, and why an interrupted
or corrupted sync can never break playback. Types live in
`packages/sync-protocol` and are shared by the API (producer) and the agent
(consumer).

## The manifest

`GET /api/v1/device/sync` returns `{ manifest, commands }`. The manifest is the
**complete desired state** for one device — not a delta:

```jsonc
{
  "protocolVersion": 2, // breaking-change gate (bumped in v2)
  "version": "8f3a…", // content hash of everything below
  "generatedAt": "2026-06-11T09:00:00.000Z",
  "deviceId": "dev_…",

  "settings": {
    "name": "Lobby screen",
    "orientation": "landscape", // content canvas shape: landscape | portrait
    "rotation": 0, // software mounting rotation: 0 | 90 | 180 | 270 (absent = 0)
    "timezone": "Europe/Amsterdam",
    "defaultPlaylistId": "pl_…", // or null
  },

  "emergency": {
    "active": false,
    "playlistId": null, // exactly one of playlistId/mediaAssetId when active
    "mediaAssetId": null,
    "startedAt": null,
  },

  "schedules": [
    /* windows + priority + playlistId; resolved on-device */
  ],

  "playlists": [
    {
      "id": "pl_…",
      "name": "Default",
      "loop": true,
      "defaultImageDurationSeconds": 10,
      "playbackOrderMode": "manual_order", // manual_order | alphabetical | random | random_with_priority_rules
      "defaultFitMode": null, // playlist display defaults (used for priority-rule items)
      "defaultBackgroundColor": null,
      "defaultPositionMode": null,
      "items": [
        {
          "id": "item_…",
          "mediaId": "med_…",
          "position": 0,
          "durationSeconds": null, // null → image inherits playlist default, video plays natural length
          "fitMode": "contain", // resolved/effective: contain | cover | stretch | original | scale_down
          "backgroundColor": "#000000", // resolved hex color behind the media
          "positionMode": "center", // resolved alignment
          "enabled": true,
          "source": "folder", // "item" (direct) or "folder" (expanded from a dynamic folder entry)
          "sourceFolderId": "fld_…", // display/debug only when source = "folder"
          "sourceFolderPath": "Campaigns / Summer",
        },
      ],
      // Present and active only when playbackOrderMode = random_with_priority_rules.
      "priorityRules": [
        {
          "id": "rule_…",
          "name": "Sponsor Ads",
          "intervalCount": 5, // play one rule item after every 5 normal items
          "selectionMode": "rotate", // rotate | random
          "position": 0, // deterministic tie-break order
          "createdAt": "2026-06-11T09:00:00.000Z",
          "mediaIds": ["med_…", "med_…"], // assignments resolved to ready media at sync time
        },
      ],
    },
  ],

  "media": [
    {
      "id": "med_…",
      "name": "poster.jpg",
      "type": "image", // image | video
      "mimeType": "image/jpeg",
      "checksum": "sha256-hex…",
      "sizeBytes": 482133,
      "width": 1920,
      "height": 1080,
      "orientation": "landscape",
      "durationSeconds": null, // natural duration for videos
      "downloadPath": "/api/v1/device/media/med_…/file",
    },
  ],
}
```

Only media actually referenced by the device's playlists/schedules/emergency is
included, so the media list doubles as the cache's desired contents.

### Server-side resolution (v2)

Dynamic folder entries and priority-rule assignments are **resolved on the server
at sync time** into concrete, ready-media ids before the manifest is sent. The
device therefore never needs folder data or backend access to know what to play —
it works entirely from the manifest, online or offline:

- A folder playlist entry expands into one manifest item per matching ready media
  (after include-subfolders and media-type/orientation filters), tagged with
  `source: "folder"` plus the folder id/path for display. Direct items are
  `source: "item"` (or the field is absent, for v1 compatibility).
- `priorityRules[].mediaIds` are the rule's assignments expanded to ready media.
- The `playbackOrderMode` is passed through; the device applies it locally (see
  below). Media that is deleted, disabled, or not yet `ready` is excluded at
  resolution time, so the device pool only ever contains playable media.

## Versioning

- **`protocolVersion`** — incremented only for incompatible shape changes;
  currently **2** (`SYNC_PROTOCOL_VERSION`). v2 adds `playbackOrderMode`, folder
  `source` metadata on items, and `priorityRules`; all are additive, so a v2
  agent reads a v1 manifest unchanged (missing `playbackOrderMode` means
  `manual_order`). An agent that sees a higher protocol version than it
  understands reports a sync error instead of guessing; older agents keep playing
  their cached content until they are updated.
- **`version`** — a deterministic hash of the manifest content. The server bumps
  it whenever anything affecting this device changes (settings, playlist edits,
  schedule changes, emergency start/stop, media replacement). The agent compares
  it with the last applied version and **skips the entire sync when unchanged**,
  making the poll loop nearly free.

When relevant state changes, the server also pushes `sync_required` over the
WebSocket so connected devices react within seconds; polling devices pick the
change up on the next interval.

## Sync algorithm (agent)

The agent keeps a SQLite database (`better-sqlite3`) with the applied manifest,
a `media_cache` index (`mediaId`, `checksum`, `sizeBytes`, file path, last
verified, last used), and bounded log/event buffers. One sync pass:

1. **Fetch** the manifest. If `version` equals the applied version → done.
   A **repair** sync skips this shortcut: after a damaged file is dropped from
   the index the server manifest is unchanged, so the version check would
   otherwise return before the diff ever ran.
2. **Diff** (`diffManifest`) the manifest's media list against the cache index by
   id + checksum → `toDownload`, `toDelete`, `unchanged`. A changed checksum for
   the same id is treated as a new download (media replacement).
3. **Check storage** before writing a single byte. Required bytes
   (`bytesToDownload`) plus a free-space headroom against `statfs`, and the
   manifest's total size against the cache budget.
   - Not enough room → **do not start**. Report
     `sync-status: insufficient_storage` with required / available /
     reclaimable / shortfall, buffer a log line, and leave the previous
     manifest, index and files untouched. The screen keeps playing.
   - Note that reclaimable bytes — what step 6 would give back — are reported
     but **not** counted as available. Freeing them early would delete files the
     still-active manifest is playing from, so a large swap genuinely needs
     `old + new` space.
4. **Report** `sync-status: downloading` when there is anything to fetch.
5. **Download** each new file from its `downloadPath` to a **temp file**, compute
   SHA-256 while streaming, and compare with the manifest checksum.
   - Mismatch or failed download → delete the temp file and **abort the whole
     sync**: report `sync-status: failed` with the reason, buffer a log line, and
     leave the previous manifest, cache index, and files fully intact. The screen
     keeps playing the old content. The sync is retried later (next poll,
     `sync_required` push, or `refresh_content` command).
   - Match → atomically rename the temp file into the media directory.
6. **Commit** — in a single SQLite transaction: store the new manifest +
   `version` and replace the cache index rows. This is the atomic switch; the
   player state recomputes from the new manifest immediately after.
7. **Clean up** — only after the commit, delete files for `toDelete` entries.
   A crash between commit and cleanup leaves harmless orphan files that the next
   sync removes; the reverse order could delete files the current manifest needs.
8. **Report** `sync-status: applied` with the new version. The dashboard renders
   this as the screen's sync state
   (`never_synced | syncing | in_sync | error | insufficient_storage`).
9. **Maintain the cache** — after the commit, never before it. Verify the index
   against the disk, repair what is damaged, sweep orphans, and evict
   unreferenced files over budget when eviction is enabled.

Concurrent triggers (poll timer, WS push, command) are coalesced: a sync request
arriving mid-run queues exactly one re-run instead of racing.

### Cache integrity (agent)

The index alone is not evidence that a file is on disk. Verification runs at
agent startup and after every applied sync, in two tiers:

- **Cheap, every pass:** `stat` each cached file. Missing, or a size that does
  not match the index, is damage.
- **Expensive, bounded:** re-hash a few files per pass, oldest verification
  first, so each file is checked roughly weekly. This is the only way to catch
  corruption that preserves the file size, and it is rate-limited because
  hashing gigabytes saturates eMMC read bandwidth and would itself cause
  playback stalls. A file the player has just reported a playback error on is
  re-hashed immediately, out of rotation.

Damaged files are deleted along with their index rows, which is what puts them
back into `toDownload`; a forced sync then re-fetches them through the ordinary
download-verify-commit path. **Repair never aborts the sync** — a single bad
file re-downloads that file, and only a genuine download failure aborts.

Files present in the media directory with no index row are orphans (step 7's
documented crash window). They are swept once past a grace period, and never
while a sync is running.

**Eviction never selects a file the current manifest references.** Doing so
would break offline playback, which the whole design exists to guarantee. A
manifest that does not fit the budget is an `insufficient_storage` condition,
not something eviction may paper over.

## Playback resolution

What actually plays is computed locally and offline from the applied manifest by
`computePlayerState` (agent) using `@signage/scheduler`:

1. Active emergency → its playlist, or a single media asset looping.
2. Highest-priority schedule whose window matches the local (timezone-aware) time.
3. `settings.defaultPlaylistId`.
4. Otherwise a status screen ("No content scheduled") — never a blank screen.

Disabled items are skipped. Items whose media is not yet cached are skipped with
a "downloading" status rather than blocking the rest of the playlist; they join
playback as soon as their download lands. Images default to the playlist's
`defaultImageDurationSeconds` (10s), videos to their natural duration.

### Display settings (fit mode, background, position)

Each item carries **resolved** display settings, applied by the backend at sync
time with precedence **item override → playlist default → platform default**
(`contain` / `#000000` / `center`). The single resolver
(`resolveDisplaySettings` in `@signage/shared`) is used by the manifest builder,
the dashboard resolved-preview and the device agent, so the rules never diverge.
Devices need no backend access to display correctly offline. Older manifests
without these fields fall back to the platform defaults. Priority-rule items have
no per-item settings and use the playlist `default*` fields.

| User label         | Internal value | Aspect ratio |             Crops | Upscales | Distorts |
| ------------------ | -------------- | -----------: | ----------------: | -------: | -------: |
| Fit to screen      | contain        |          yes |                no |      yes |       no |
| Fill screen / crop | cover          |          yes |               yes |      yes |       no |
| Stretch to screen  | stretch        |           no |                no |      yes |      yes |
| Original size      | original       |          yes | possible clipping |       no |       no |
| Scale down only    | scale_down     |          yes |                no |       no |       no |

Fit mode applies to the active (post-rotation) viewport, so it behaves correctly
in every screen orientation; media files are never rotated or modified.

### Playback order (offline)

The order within a playlist is computed on-device from `playbackOrderMode` by the
shared `PlaybackQueueEngine` (`@signage/shared`), so every mode works with zero
connectivity:

- **`manual_order`** — manifest item order (folder entries already expanded in
  place, alphabetically).
- **`alphabetical`** — case-insensitive natural sort of the resolved pool
  (`file2` before `file10`); deterministic.
- **`random`** — shuffled with no immediate repeats; reshuffles each time the
  pool is exhausted.
- **`random_with_priority_rules`** — random normal playback with a priority item
  inserted after every `intervalCount` normal items. `rotate` cycles a rule's
  media in order; `random` picks from it. Multiple rules triggering at once are
  ordered deterministically (lowest interval, then position, then creation time),
  and priority insertions never starve normal content.

The same engine drives the dashboard's resolved-preview samples (with a seeded
RNG), so previews match device behaviour. Playback events are queued locally with
client-generated ids while offline and flushed on reconnect; the ids make event
ingestion idempotent so plays are never double-counted.

## Failure-mode summary

| Failure                               | Outcome                                                                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network down                          | Cached manifest keeps playing; schedules keep switching on-device.                                                                                  |
| Download interrupted                  | Temp file discarded; sync retried; old content unaffected.                                                                                          |
| Checksum mismatch (corruption/tamper) | Whole sync rejected; `failed` status reported; old content unaffected.                                                                              |
| Crash mid-download                    | Temp files ignored/overwritten on the next pass.                                                                                                    |
| Crash after commit, before cleanup    | Orphan files only; swept once past the grace period.                                                                                                |
| Cached file deleted or truncated      | Detected by the integrity pass; row and file dropped, then re-downloaded.                                                                           |
| Cached file corrupt at the same size  | Detected on the periodic re-hash (or immediately after a playback error).                                                                           |
| Not enough disk or cache budget       | Sync refuses to start; `insufficient_storage` reported with the shortfall; old content keeps playing and recovers automatically once there is room. |
| Unknown `protocolVersion`             | Sync error reported; cached content keeps playing until the agent is updated.                                                                       |

These guarantees are covered by tests in `apps/agent/src/sync.test.ts` and
`packages/sync-protocol`.
