# T015 — Player watchdog and recovery ladder

| | |
|---|---|
| **Estimate** | M |
| **Risk** | Medium-High — the recovery ladder can reboot devices. A false positive means a screen that reboots in a loop in front of customers |
| **Depends on** | None technically. Deploy after T010 so fixes are releasable. |
| **Blocks** | Trusting any device — ARM or x86 — for unattended 24/7 operation |
| **Status** | Not started |

> Self-contained by design: a fresh Claude Code session has no memory of the
> review that produced this file.

---

## Objective

Fix the highest-risk playback reliability problem in the product: **a video that
stalls freezes the screen forever, and nothing anywhere detects it.**

Three layers, in order of value:

1. A **video safety timer** so playback always advances (the cheap, high-value fix).
2. A **player→agent progress heartbeat** so the agent knows playback is alive.
3. An **agent-side watchdog** with a graduated recovery ladder, plus dashboard
   visibility so recoveries are not silent.

---

## Context from the review report

These were graded **A1 and A2 — Critical before real customer use**. Both are
CONFIRMED by reading the code, not inferred.

### F1 — A stalled video never advances *(CONFIRMED)*

The chain:

1. `apps/agent/src/state.ts:182` (`buildPlaylistItems`) sets:
   ```ts
   durationSeconds:
     item.durationSeconds ??
     (media.type === 'image' ? playlist.defaultImageDurationSeconds : null),
   ```
   So unless an operator set an explicit per-item duration, **every video item
   reaches the player with `durationSeconds: null`.** Line 220
   (`buildPriorityRules`) does the same for priority-rule items.

2. `apps/player/src/main.ts:308-309`:
   ```ts
   if (item.durationSeconds && item.durationSeconds > 0 && !single) {
     scheduleAdvance(item.durationSeconds);
   }
   ```
   The advance timer is only armed when a duration exists. For a normal video it
   does not.

3. Therefore the **only** exit from a video item is `element.onended`
   (`main.ts:296`) or `element.onerror` (`main.ts:302`). A video that decodes the
   first frame and then stalls fires neither.

4. The `single` case is worse: one looping video sets `element.loop = true`
   (`main.ts:294`) with no timer at all. A stall there freezes the screen with
   zero telemetry, and single-video loops are a very common signage setup.

Verified exhaustively — every `setTimeout`/`setInterval` in
`apps/player/src/main.ts` is accounted for: line 150 (preload timeout), 203
(layer cleanup), 211 (`scheduleAdvance`), 280/303 (error retry), 407 (clock),
423 (identify), 449 (WS reconnect). **There is no stall, `waiting`, `stalled` or
`timeupdate` handler anywhere.**

### F2 — Nothing detects a dead player *(CONFIRMED)*

- The agent recomputes state every 15 s (`apps/agent/src/main.ts:11`
  `STATE_INTERVAL_MS`) but `PlayerServer.setState`
  (`apps/agent/src/player-server.ts`) only broadcasts when the **fingerprint
  changes**. A stalled video does not change the fingerprint, so nothing happens.
- `PlayerServer` tracks connected sockets in `this.sockets` but **never inspects
  the set**. If Chromium crashes, the tab dies, or the WebSocket drops, the agent
  does not notice.
- There is no player→agent liveness signal at all. `playback_event` messages
  (`start`/`end`/`error`/`skip`) are the only traffic, and a stalled video emits
  none of them.
- `apps/agent/src/main.ts` sets `lastError` on a playback error but **never
  clears it** (report D10), so once set the device reports a stale error forever.

### Useful facts for the fix

- **The natural duration is already available.** `ManifestMedia.durationSeconds`
  is populated by `addMedia` in `apps/api/src/lib/manifest.ts` from
  `MediaAsset.durationSeconds` (set by the worker from ffprobe of the *processed*
  file, `apps/worker/src/processor.ts`). Critically, `applyProfileVariants`
  overrides `checksum`, `sizeBytes`, `mimeType`, `width` and `height` for
  `high`/`light` tiers but **does not touch `durationSeconds`** — so it survives
  intact for every playback profile. The fix is therefore cheap: the data is
  already on the device.
- The player already has `playToken` (`main.ts:76`) to invalidate stale async
  work, and `activeItem()` to resolve the current item across order modes. Both
  should be reused rather than reinvented.
- The kiosk wrapper already relaunches Chromium if it exits
  (`infra/device/start-player.sh`, `while true; do chromium …; sleep 2; done`),
  and systemd restarts the whole unit if X dies. So the ladder's job is to catch
  the cases where Chromium is *running but not rendering*.
- `restart_player` and `reboot_device` commands already exist
  (`apps/agent/src/commands.ts`), gated by `SIGNAGE_PLAYER_SERVICE` and
  `SIGNAGE_ALLOW_REBOOT` respectively, with polkit rules in
  `infra/device/50-signage.rules`. The ladder can reuse these code paths.

---

## Files likely involved

- `apps/agent/src/state.ts` — pass the natural duration through to the player
- `apps/player/src/main.ts` — safety timer, stall detection, progress heartbeat
- `packages/shared/src/ws-messages.ts` — new `player_progress` message type
- `packages/shared/src/types.ts` — `PlayerStateItem` if a new field is added
- `apps/agent/src/player-server.ts` — receive progress, expose liveness
- `apps/agent/src/main.ts` — the watchdog timer and recovery ladder; clear `lastError`
- `apps/agent/src/commands.ts` — reuse restart/reboot execution paths
- `apps/agent/src/metrics.ts` — report watchdog state in the heartbeat
- `packages/shared/src/schemas.ts` — heartbeat schema additions
- `packages/database/prisma/schema.prisma` + migration — device columns for
  recovery visibility (additive)
- `apps/web/src/pages/DeviceDetail.tsx` — surface recovery events
- **Tests:** `apps/agent/src/state.test.ts`, new `apps/player/src/player.test.ts`

---

## Non-goals

- Preloading the next item to remove the inter-item gap (report B-tier
  optimisation). Separate task.
- Replacing Chromium with an mpv/GStreamer "lite player" (report E1).
- Fixing the display-settings-mid-item bug (report D14/F17) — related file,
  different problem, low severity.
- x86 GPU/VA-API work — **T016**.
- Cache integrity and disk guards — **T017**.
- Server-side alerting on recovery events — **T013** owns alert dispatch; this
  task only produces the signal.

---

## Implementation plan

### 1. Video safety timer (do this first — it is small and it alone fixes F1)

Two possible layers. **Prefer the agent**, so the logic is unit-testable in
`state.test.ts` and a stale player build still benefits:

- In `apps/agent/src/state.ts` `buildPlaylistItems` (and `buildPriorityRules`),
  when the item has no explicit `durationSeconds` and the media is a video with a
  known `media.durationSeconds`, emit a **separate** field — do not overload
  `durationSeconds`, because the player treats a set duration as "advance at
  exactly this time" and would truncate a video that runs slightly long.

  Suggested: `maxDurationSeconds` on `PlayerStateItem`, computed as
  `media.durationSeconds * 1.25 + 10` (25% slack for slow decode plus a floor for
  very short clips). Tune the constants; make them named exports so tests can
  reference them.

- In `apps/player/src/main.ts` `showCurrent`, arm a timer from
  `maxDurationSeconds` for **every** video, including the `single` looping case.
  When it fires: emit a playback `error` event with a distinguishing detail
  (e.g. `{ reason: 'stall_timeout' }`) and `advance('error')`.

- For the `single` looping video, the timer must be re-armed on each loop
  iteration rather than firing once — use the progress signal from step 2 to
  reset it, so a healthy looping video never trips it.

- Fallback when `media.durationSeconds` is unknown (`null` — possible if ffprobe
  could not determine it): use a generous absolute ceiling (e.g. 30 min) rather
  than no timer at all. **No video item may ever have no timer.**

### 2. Player progress heartbeat

- Attach a `timeupdate` listener to video elements and record the last
  `currentTime`. For images, the existing advance timer is sufficient — but the
  player should still report that it is alive.
- Add a `player_progress` message to `PlayerToAgentMessage`
  (`packages/shared/src/ws-messages.ts`), sent every ~5 s:
  ```jsonc
  { "type": "player_progress",
    "itemId": "...", "mediaId": "...",
    "currentTime": 12.4,        // null for images
    "advancing": true,          // false if currentTime has not moved since the last report
    "revision": 7 }             // PlayerState.revision the player is rendering
  ```
- Also detect the stall *inside* the player: if `currentTime` has not advanced
  across N consecutive reports while the element is not paused and not ended,
  that is a stall — do not wait for the safety timer. Handle `waiting` and
  `stalled` events as corroborating signals, but treat `timeupdate` stagnation as
  the authority (`waiting` fires legitimately during buffering).
- Keep the message small and the interval modest. It travels over loopback, but
  it lands in the agent's event path, so do **not** buffer these into
  `event_buffer` — they are liveness, not telemetry, and would flood the
  5,000-row cap in `apps/agent/src/db.ts`.

### 3. Agent-side liveness watchdog

In `apps/agent/src/main.ts`, add a watchdog timer (~10 s) tracking:

- `lastPlayerSocketAt` — a player WebSocket is connected
  (`PlayerServer.sockets.size > 0`)
- `lastProgressAt` — last `player_progress` received
- `lastAdvanceAt` — last `playback_event` of type `start`
- The current state's expectation: is there playable content at all? A device
  showing the "No content scheduled" fallback is **healthy**, not stalled.

Escalation must be **state-aware**. Do not fire when:
- the state has no playable items (`statusMessage` set, `items` empty)
- content is still downloading
- the device is not paired
- a sync is in progress (media files are being replaced under the player)

### 4. The recovery ladder

Each rung escalates only if the previous did not restore progress. Reset to rung
0 on recovery.

| Rung | Trigger | Action | Cooldown |
|---|---|---|---|
| 0 | Progress observed | none | — |
| 1 | No progress for ~90 s while content should be playing | Send a `force_advance` message to the player; player skips to the next item | 60 s |
| 2 | Rung 1 did not restore progress within 60 s | Send `reload` to the player (`location.reload()`), or use the existing `PlayerServer.kickPlayers()` which closes sockets and makes the page reconnect | 2 min |
| 3 | Still no progress, **or** no player socket for ~3 min | `systemctl restart $SIGNAGE_PLAYER_SERVICE` (reuse the `restart_player` path in `apps/agent/src/commands.ts`) | 5 min |
| 4 | Rung 3 tried twice within 15 min and still no progress | `systemctl reboot` — **only if `SIGNAGE_ALLOW_REBOOT=true`** | 30 min, hard cap 2/hour |

**Safety rules — these matter more than the ladder itself:**

- **Hard rate limits per rung.** A device must never reboot more than twice an
  hour regardless of what the watchdog thinks. A reboot loop in front of a
  customer is worse than a frozen frame.
- **Persist the ladder state in SQLite** (`apps/agent/src/db.ts` `kv` table), so a
  reboot does not reset the counter and produce an infinite reboot cycle. This is
  the single most important safety property here.
- **Never escalate to rung 4 without evidence rung 3 was tried and failed.**
- **Buffer a log line at every rung** (`db.bufferLog`) so the reason reaches the
  server on the next flush — including when the device reboots, since the buffer
  is in SQLite and survives.
- Make the whole watchdog disableable: `SIGNAGE_WATCHDOG=off` in
  `/etc/signage/agent.env`, for debugging a device without it rebooting underneath
  you.
- Also add a rung-0 housekeeping fix: **clear `lastError`** once progress resumes
  (report D10), so the dashboard stops showing a stale error.

### 5. Dashboard visibility

Recoveries must not be silent — a device that quietly reboots twice a day is a
broken device, and today you would never know.

- Extend the heartbeat schema (`packages/shared/src/schemas.ts`,
  `apps/agent/src/metrics.ts` `collectMetrics`) with: `playerConnected: boolean`,
  `lastProgressAgeSeconds: number | null`, `watchdogRung: number`,
  `recoveryCount24h: number`, `lastRecoveryAt`, `lastRecoveryReason`.
- Persist onto `Device` (additive Prisma migration; follow T011's migration
  procedure) and surface in `apps/web/src/pages/DeviceDetail.tsx` and the fleet
  view.
- Buffer a structured `DeviceLog` entry per recovery so the timeline is
  reconstructible from `GET /orgs/:orgId/devices/:deviceId/logs`.
- Feed "device recovered N times in 24h" into T013's alerting.

### 6. Testing infrastructure (this is the deliverable that keeps it fixed)

`apps/player` currently has `"test": "echo \"no tests\""`. Stand up vitest +
jsdom and write the regression tests below. Without them, the next refactor
reintroduces F1.

---

## Acceptance criteria

- [ ] **A video element that never fires `ended` still advances.** This is the
      primary criterion; the test for it must exist and pass.
- [ ] A single looping video that stalls is detected and recovered.
- [ ] Every video item on the device has a timer armed — verified by asserting
      that no code path reaches `showCurrent` for a video without one.
- [ ] The player sends progress at a steady interval; the agent tracks it.
- [ ] The agent detects a closed player socket within ~30 s.
- [ ] The ladder escalates in order, with cooldowns, and de-escalates on recovery.
- [ ] Ladder state survives a reboot (persisted in SQLite) — a device cannot
      enter a reboot loop.
- [ ] Reboots are hard-capped at 2/hour and never happen when
      `SIGNAGE_ALLOW_REBOOT` is false.
- [ ] The watchdog **never fires** on a healthy device: 24 h of normal playback
      (mixed images and videos, including a schedule change and a content sync)
      produces zero recovery events.
- [ ] The watchdog **never fires** on a legitimately idle device showing "No
      content scheduled".
- [ ] Every recovery is visible in the dashboard with a timestamp and reason.
- [ ] `lastError` clears when playback resumes.
- [ ] `SIGNAGE_WATCHDOG=off` fully disables escalation.

---

## Testing checklist

**Player state machine (new, jsdom):**
- [ ] Video whose `ended` never fires → advances via the safety timer. **The F1
      regression test.**
- [ ] Video whose `currentTime` stops moving → stall detected before the safety
      timer, error event emitted with `reason: 'stall_timeout'`.
- [ ] Healthy video that runs slightly longer than its probed duration is **not**
      cut off (verifies the 1.25× slack).
- [ ] Single looping video: timer re-arms per loop; a healthy loop never trips it.
- [ ] Image item still advances on its normal duration.
- [ ] Item with an explicit operator-set duration still uses that duration.
- [ ] Video with `media.durationSeconds === null` still gets the ceiling timer.
- [ ] Repeated load errors back off instead of spinning at the 3 s
      `ERROR_RETRY_DELAY_MS` (avoid flooding `event_buffer`).
- [ ] `playToken` invalidation still works — a state change mid-load does not
      produce two concurrent playbacks.

**Agent watchdog (vitest, fake timers):**
- [ ] Ladder escalates 1→2→3→4 with the configured cooldowns.
- [ ] Recovery at any rung resets to 0.
- [ ] No escalation when there is no playable content / not paired / sync running.
- [ ] Reboot cap enforced; ladder state reloaded from SQLite after a simulated restart.
- [ ] `SIGNAGE_WATCHDOG=off` disables everything.

**Integration / on-device:**
- [ ] Craft a deliberately broken video (valid container, corrupt stream) → the
      playlist recovers instead of hanging. **This test fails today.**
- [ ] `kill -9` the Chromium renderer → the wrapper relaunches; confirm the agent
      also notices the socket loss and does not double-escalate.
- [ ] `pkill chromium` repeatedly → ladder reaches rung 3, not rung 4 immediately.
- [ ] Disconnect the network mid-video → **no recovery should fire**; offline
      playback from cache is healthy behaviour.
- [ ] 24 h soak with zero false positives (feeds T016's 72 h soak).

---

## Rollback / safety notes

- **The ladder can reboot devices. Ship it in stages:**
  1. Release rungs 0–2 only (advance + reload). These are safe and fix most cases.
  2. Add rung 3 (service restart) after a week of clean telemetry.
  3. Add rung 4 (reboot) last, only once the false-positive rate is measured at zero.
- Deploy to **one** device first via the `software_update` flow
  (`infra/device/update.sh`), watch it for 48 h, then roll out.
- The safety timer (step 1) is independently valuable and much lower risk than the
  ladder. If time is short, ship step 1 alone — it closes F1 by itself.
- Keep `SIGNAGE_WATCHDOG=off` documented in the runbook (T014) as the first thing
  to try if devices start behaving oddly after this release.
- Watch out for the interaction with T017: a device with a full disk or a corrupt
  cache file will produce genuine playback errors. The watchdog will dutifully
  escalate to a reboot, which fixes nothing. **The watchdog must distinguish
  "cannot play because content is broken" from "player is wedged"** — the former
  should report and alert, not reboot. Coordinate the two tasks.
- Any Prisma migration here must follow T011's pre-upgrade backup procedure.
