# T015 — Player watchdog and recovery ladder

|                |                                                                                                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Estimate**   | M                                                                                                                                                                                                                                                                  |
| **Risk**       | Medium-High — the recovery ladder can reboot devices. A false positive means a screen that reboots in a loop in front of customers                                                                                                                                 |
| **Depends on** | None technically. Deploy after T010 so fixes are releasable.                                                                                                                                                                                                       |
| **Blocks**     | Trusting any device — ARM or x86 — for unattended 24/7 operation                                                                                                                                                                                                   |
| **Status**     | **Stages 1–2 done (2026-09-10): the video safety net, stall detection, the progress protocol and a report-only liveness monitor.** The recovery ladder (stages 3–4) and its dashboard surfacing (stage 5) are deliberately NOT shipped — see "Outcome" at the end. |

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

### F1 — A stalled video never advances _(CONFIRMED)_

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

### F2 — Nothing detects a dead player _(CONFIRMED)_

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
  `MediaAsset.durationSeconds` (set by the worker from ffprobe of the _processed_
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
  the cases where Chromium is _running but not rendering_.
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
  {
    "type": "player_progress",
    "itemId": "...",
    "mediaId": "...",
    "currentTime": 12.4, // null for images
    "advancing": true, // false if currentTime has not moved since the last report
    "revision": 7,
  } // PlayerState.revision the player is rendering
  ```
- Also detect the stall _inside_ the player: if `currentTime` has not advanced
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

| Rung | Trigger                                                | Action                                                                                                                                                | Cooldown                |
| ---- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 0    | Progress observed                                      | none                                                                                                                                                  | —                       |
| 1    | No progress for ~90 s while content should be playing  | Send a `force_advance` message to the player; player skips to the next item                                                                           | 60 s                    |
| 2    | Rung 1 did not restore progress within 60 s            | Send `reload` to the player (`location.reload()`), or use the existing `PlayerServer.kickPlayers()` which closes sockets and makes the page reconnect | 2 min                   |
| 3    | Still no progress, **or** no player socket for ~3 min  | `systemctl restart $SIGNAGE_PLAYER_SERVICE` (reuse the `restart_player` path in `apps/agent/src/commands.ts`)                                         | 5 min                   |
| 4    | Rung 3 tried twice within 15 min and still no progress | `systemctl reboot` — **only if `SIGNAGE_ALLOW_REBOOT=true`**                                                                                          | 30 min, hard cap 2/hour |

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

---

## Outcome (2026-09-10)

**F1 is fixed. The recovery ladder is deliberately not built.**

### What shipped

**1. The video safety net.** `videoCeilingSeconds()` in `apps/agent/src/state.ts`
computes a hard ceiling — `probed × 1.25 + 10`, rounded up — and emits it as
`maxDurationSeconds` on every video item. It is a **separate field** from
`durationSeconds`: that one means "advance at exactly this time" and would
truncate a video that runs slightly long.

It is set at **three** construction sites, not the two the plan listed. The
missing one was the emergency single-media item (`state.ts`, the
`resolution.source === 'emergency'` branch) — one looping video with no timer
at all, which is precisely the worst shape of F1 and the one an operator reaches
for in an actual emergency. There is a test for it.

The player (`apps/player/src/main.ts`) now arms a ceiling for **every** video,
including the `single` looping case that previously had no timer of any kind.
When the natural duration is unknown the ceiling falls back to 30 minutes: the
rule is that no video item may ever have no timer, not that the timer must be
tight.

The ceiling is **re-armed on each loop**, detected as a backwards jump in
`timeupdate`. Without that, a one-shot ceiling would fire during the second
iteration of a perfectly healthy looping video and skip it — a visible
regression on every screen running a single-video loop, which is a very common
signage setup.

**2. Stall detection inside the player.** `timeupdate` stagnation across three
progress reports (15 s) is treated as wedged, so a 10-minute video that dies at
second 3 does not hold the screen for 10 minutes waiting for its ceiling.
`waiting` and `stalled` are deliberately **not** triggers — they fire during
ordinary buffering. `timeupdate` having fired at all since the last report is the
primary signal, which also keeps a looping video honest when its `currentTime`
happens to land on the same value twice.

**3. The progress protocol.** `player_progress` on `PlayerToAgentMessage`, sent
every 5 s. `PlayerServer` records it and exposes `getLiveness()`. It is
explicitly **not** routed through `onPlaybackEvent`: that path calls
`db.bufferEvent`, whose 5,000-row cap would evict real playback events within the
hour.

**4. Failure backoff.** Every error path (load failure, element error, ceiling,
stall) now goes through `failCurrent`, which advances **immediately** — the
screen must never keep showing a frame that is not playing — and records the
failed media id. `showCurrent` then applies an exponential backoff (3 s → 60 s)
only when the very same media comes straight back, i.e. a one-item playlist or an
emergency single video. A multi-item playlist moves on with no delay at all,
which is better than the old fixed 3 s gap. Without this, a corrupt single video
would retry every 3 s and fill the event buffer within the hour.

What clears the streak matters as much as the backoff itself, and the first
version of this got it wrong. Resetting on the first `timeupdate` looks right and
is not: a corrupt stream that decodes one second and _then_ wedges — the exact
shape F1 is about — emits one, so the streak returned to zero on every retry and
the backoff pinned at its 3 s floor, cycling roughly every 18 s forever. Measured
in the harness: 30 error events in ten simulated minutes, against 5 with the
streak cleared only on evidence the item actually worked (an image that rendered,
a clean `end`, or two consecutive moving progress reports). There is a test for
that specific cycle, and it was verified to fail against the first version.

**5. D10.** `lastError` is cleared when an item starts rendering again, and when
the liveness monitor sees a recovery. Before this it was set once and never
cleared, so the dashboard showed a stale error as though it were current.

**6. A report-only liveness monitor** in `apps/agent/src/main.ts`, every 10 s. It
notices a player socket absent for 30 s, or progress absent for 90 s, and writes
a **buffered** device log line — so the report survives the device being offline
and reaches the dashboard on the next flush. It is state-aware: an unpaired
device, an empty schedule, or a sync in progress is healthy, not stalled
(`SyncEngine.isSyncing()` was added for that). A connected player that has never
reported progress is treated as healthy — that is a pre-T015 player build, not a
fault. `SIGNAGE_WATCHDOG=off` disables it.

**Be precise about what the agent-side monitor catches**, because it is narrower
than "the agent detects stalls": progress reports go out every 5 s regardless of
what is on screen, so `playback_stalled` fires only when the renderer's own event
loop has died — a hung or crashed Chromium — and `player_disconnected` when the
socket is gone. A _wedged video_ in an otherwise-live page never reaches the
agent as a problem, because the player has already handled it in-process by the
time the 90 s grace elapses. That is the intended division of labour, not a gap,
but the monitor should not be described as covering both.

### NOT implemented — deliberately

**The recovery ladder (stages 3–4), the Prisma migration and the dashboard
surfacing (stage 5).**

This task's own rollback note says to release rungs 0–2, add rung 3 after a week
of clean telemetry, and add rung 4 (reboot) only once the false-positive rate is
**measured at zero**. That measurement cannot be made from here: there is no
staging fleet, the four production devices are the only fleet, and the sole
rollout path is `software_update` per device. Building a ladder that reboots
customer-facing screens against an acceptance criterion that cannot be executed
would be shipping untested recovery — and a screen that reboots in a loop in
front of customers is worse than a frozen frame.

The migration, the heartbeat fields and `DeviceDetail.tsx` exist to surface
ladder recoveries. With no ladder there are no recoveries to surface, so they
would be schema churn for nothing. The report-only monitor gives the same
visibility through the existing device-log path with no schema change at all.

**What would unblock the ladder:** stages 1–2 rolled out to one device via
`software_update`, then a week of its device logs containing zero
`player liveness` warnings during normal operation. That is the false-positive
measurement the task asks for, and the buffered log lines are exactly the
evidence it needs. Note also the T017 interaction, still unresolved: a device
with a full disk or a corrupt cache file produces genuine playback errors that a
reboot fixes nothing about.

### Testing

`apps/player` had `"test": "echo \"no tests\""`. It now has vitest + jsdom and
11 tests that drive the **real** `main.ts` through the two surfaces the agent
uses — the websocket and the media elements — rather than a reimplementation of
it, which is the only way an F1 regression test is worth anything. jsdom
implements no media loading, so `src/test-harness.ts` shims `src` resolution,
`currentTime` and `play()`.

The four tests that matter were verified to **fail** against the pre-T015 logic
(ceiling and stall detection neutered) and pass with it:

- a video whose `ended` never fires still advances — **the F1 regression test**
- a single looping video that stalls is recovered
- a wedged video is caught by stagnation long before its ceiling
- a video with no probed duration still gets a ceiling

Plus: a healthy video running 33 s against a 47 s ceiling is not cut off; a
healthy 10 s loop played for a minute never trips; images still advance on their
own duration; an operator-set duration still owns the transition; buffering is
not mistaken for a stall; progress is reported on interval; and a permanently
failing item produces fewer than 12 error events in two minutes instead of ~40.

Agent-side, `state.test.ts` gains 6 tests over `videoCeilingSeconds` and the
three item-construction sites.

`pnpm -r typecheck` is clean. All suites pass except four pre-existing failures
in `apps/agent/src/sync.test.ts`, which cannot run in this environment at all:
`better-sqlite3` has no compiled binding here and `pnpm rebuild` fails in
`node-gyp`. They fail identically on a clean checkout of `HEAD`.

### Not verified

- **The agent-side liveness monitor has no unit test.** It is a closure inside
  `startAgent`, so exercising it means extracting it first, and that refactor was
  not worth doing for code whose consumer (the ladder) does not exist yet. It
  typechecks; it has not been run. The stage-3 criterion "the agent detects a
  closed player socket within ~30 s" is therefore **not** satisfied.
- **Nothing has been run on a real device.** Every acceptance criterion of the
  form "24 h of normal playback produces zero recovery events" is unmet by
  construction, as is the on-device integration list (a deliberately corrupt
  video, `kill -9` on the renderer, a mid-video network drop).
- Roll out to **one** device first and watch it for 48 h, per this task's own
  staging rule. `SIGNAGE_WATCHDOG=off` is the first thing to try if a device
  behaves oddly afterwards; it is documented in `device-install.md` and in the
  runbook.
