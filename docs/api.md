# API Reference

Base URL: `/api/v1`. All bodies are JSON unless noted. Errors return
`{ "error": { "message": string, ... } }` with an appropriate HTTP status.

There are two authentication schemes:

- **User API** — `Authorization: Bearer <JWT>` from `/auth/login`. All
  `/orgs/:orgId/...` routes additionally require membership in that organization
  with a sufficient role. Convention: reads require `viewer`, content changes
  require `editor`, organization/member/emergency management requires `admin`,
  and ownership transfer rules are restricted to `owner`.
- **Device API** — `Authorization: Bearer sgd_...` device token obtained once via
  pairing. Device routes live under `/device/...` and are scoped to the calling
  device only.

## Auth

| Method | Path                    | Notes                                                                                                                                              |
| ------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/register`        | **Disabled.** Public registration was removed in v2; always returns `410 Gone`. Accounts are created by a superadmin or an org admin.              |
| POST   | `/auth/login`           | `{ email, password }` → `{ token, user, organizations }`. Rejects disabled accounts. Rate-limited 10/min. Superadmin logins are audit-logged.      |
| GET    | `/auth/me`              | Current user profile + organizations. Rejects disabled accounts.                                                                                   |
| POST   | `/auth/change-password` | Authenticated. `{ currentPassword, newPassword }`; clears `mustChangePassword`. New password must differ from the current one. Rate-limited 5/min. |

Users created with a temporary password have `mustChangePassword=true`; the
dashboard forces a password change before any other action.

### Two-factor authentication (TOTP)

MFA is **opt-in per user** and local-only: an authenticator app (RFC 6238, SHA-1,
6 digits, 30-second steps) plus ten single-use recovery codes. There is no email
or SMS channel anywhere in the product, so the last resort is a server-side CLI —
see [Recovering a locked-out account](#recovering-a-locked-out-account).

**`POST /auth/login` has two possible outcomes.** Both are `200`; branch on
`status`:

```jsonc
// MFA off — unchanged apart from the added discriminator
{ "status": "ok", "token": "...", "user": { … }, "organizations": [ … ] }

// MFA on — no token is issued yet
{ "status": "mfa_required", "challengeId": "<64 hex chars>", "expiresInSeconds": 300 }
```

`challengeId` is **not a credential**. It is an opaque handle held server-side in
Redis, it authenticates nothing on its own, and it is destroyed on first success,
after 5 failed attempts, or after 5 minutes — whichever comes first. The attempt
cap, not the per-IP rate limit, is what puts a 6-digit code out of brute-force
range.

| Method | Path                       | Notes                                                                                                                                                |
| ------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/login/mfa`          | `{ challengeId, code }` → the same `status: "ok"` body as a direct login. `code` is a 6-digit TOTP **or** a recovery code. Rate-limited 10/min.      |
| POST   | `/auth/mfa/setup`          | Authenticated. Starts enrollment; returns `{ secret, otpauthUri }`. Nothing is in force yet. `409`-style `400` if MFA is already on.                 |
| POST   | `/auth/mfa/enable`         | Authenticated. `{ code }` from the app. On success returns `{ ok: true, recoveryCodes: string[] }` — **the only time the codes are readable**.       |
| POST   | `/auth/mfa/disable`        | Authenticated. `{ password }` — the password is re-checked so a borrowed unlocked tab cannot strip the second factor. Deletes recovery codes. 5/min. |
| GET    | `/auth/mfa/recovery-codes` | Authenticated. `{ enabled, remaining }` — how many unused codes are left. Never returns the codes themselves.                                        |

`UserDto` carries `mfaEnabled` (from `/auth/login`, `/auth/me`).

**What is stored.** The base32 secret, `mfaConfirmedAt`, and `mfaLastStep` on
`users`; recovery codes in `mfa_recovery_codes` as SHA-256 hashes (like device
tokens — they are high-entropy, so bcrypt would only add login latency). Used
codes are marked, not deleted, so "codes remaining" stays honest.

**Two properties worth knowing about:**

- _Enrollment is two calls._ A secret written by `/setup` is inert until
  `/enable` proves the user can generate a matching code, so an abandoned
  enrollment can never lock anyone out.
- _A TOTP code is single-use._ `mfaLastStep` records the step spent, so a code
  observed over someone's shoulder cannot be replayed during the rest of its
  30-second window. One step of clock skew is accepted either side.

### Recovering a locked-out account

A user with neither their authenticator nor a recovery code is recovered by
someone with shell access to the API host. It clears the MFA columns and
**nothing else** — the password is untouched, and the user can re-enroll:

```bash
# development
pnpm app:disable-mfa -- user@example.com

# production (WORKDIR is the repository root; tsx is not in the image)
docker compose exec api node apps/api/dist/cli/disable-mfa.js user@example.com
```

The email match is case-insensitive. An address that matches no account exits
non-zero rather than reporting success.

## Organizations & members

| Method | Path                             | Notes                                                                                                     |
| ------ | -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| GET    | `/orgs`                          | Organizations the caller belongs to (with role).                                                          |
| POST   | `/orgs`                          | `{ name }` — create another org; caller becomes `owner`.                                                  |
| GET    | `/orgs/:orgId`                   | Org detail.                                                                                               |
| PATCH  | `/orgs/:orgId`                   | `{ name }` — admin.                                                                                       |
| POST   | `/orgs/:orgId/logo`              | `multipart/form-data` (`file`) — admin/owner/superadmin. Upload/replace the org logo. See below.          |
| DELETE | `/orgs/:orgId/logo`              | Admin/owner/superadmin. Removes the org logo.                                                             |
| GET    | `/orgs/:orgId/members`           | Member list (`id, userId, email, name, role, createdAt`).                                                 |
| POST   | `/orgs/:orgId/members`           | `{ email, role }` — admin. Role cannot be `owner`; the user must already have an account (404 otherwise). |
| PATCH  | `/orgs/:orgId/members/:memberId` | `{ role }` — admin. The owner row is immutable; granting `owner` requires being `owner`.                  |
| DELETE | `/orgs/:orgId/members/:memberId` | Admin. The owner cannot be removed.                                                                       |

**Organization object.** `/auth/login`, `/auth/me`, `/orgs`, `/orgs/:orgId` and
`/superadmin/organizations` return organizations shaped as
`{ id, name, slug, status, planName, maxDevices, maxStorageGb, role?, logoUrl, logoMimeType, logoUpdatedAt, createdAt }`.
`role` is the caller's role in that org. `logoUrl` is a short-lived presigned URL
(≈24 h, refreshed on every `/auth/me`) or `null` when no logo is set.

**Logo upload (`POST /orgs/:orgId/logo`).** Multipart field `file`.

- Allowed formats: **SVG, PNG, JPG/JPEG**. Validated by content (magic bytes for
  raster, XML sniffing for SVG) — the client MIME type and extension are never trusted.
- Max size: **2 MB** (`ORG_LOGO_MAX_BYTES`). Empty files are rejected.
- **SVG safety:** SVGs are rejected if they contain `<script>`, inline `on*`
  handlers, `javascript:` URIs, `<foreignObject>`, `<!DOCTYPE>`/`<!ENTITY>`
  declarations, or external (`http(s)://`) references. Logos are only ever
  rendered via `<img src>` (never inlined), so they cannot execute script.
- Permissions: organization **admin** or **owner**, or any **superadmin**
  (the same route serves superadmins acting in an org context). `viewer`/`editor`
  cannot change branding. The previous logo object is deleted best-effort.
- Audited as `organization.logo.update` / `organization.logo.delete`.

## Devices (screens)

| Method | Path                                                     | Notes                                                                                                                    |
| ------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/orgs/:orgId/devices`                                   | All screens with online/sync status and latest metrics.                                                                  |
| POST   | `/orgs/:orgId/devices`                                   | `{ name, ... }` — creates the screen **and returns a one-time pairing code**.                                            |
| GET    | `/orgs/:orgId/devices/:deviceId`                         | Detail (settings, status, last heartbeat, active command counts).                                                        |
| PATCH  | `/orgs/:orgId/devices/:deviceId`                         | Update name, orientation, rotation, timezone, default playlist, group membership, etc. Changes bump the device manifest. |
| DELETE | `/orgs/:orgId/devices/:deviceId`                         | Soft delete; revokes the device token.                                                                                   |
| POST   | `/orgs/:orgId/devices/:deviceId/regenerate-pairing-code` | Editor. New single-use code (invalidates the previous unused one).                                                       |
| POST   | `/orgs/:orgId/devices/:deviceId/revoke-token`            | Invalidates the device token; the device must re-pair.                                                                   |
| POST   | `/orgs/:orgId/devices/:deviceId/commands`                | `{ type, payload? }` — enqueue one of the command types below; pushed instantly over WS when connected.                  |
| GET    | `/orgs/:orgId/devices/:deviceId/commands`                | Recent commands with status (`pending → sent → acked → completed/failed/expired`).                                       |
| GET    | `/orgs/:orgId/devices/:deviceId/logs?limit=`             | Recent device logs.                                                                                                      |
| GET    | `/orgs/:orgId/devices/:deviceId/heartbeats`              | Recent heartbeats (CPU, memory, disk, temperature, uptime).                                                              |
| GET    | `/orgs/:orgId/devices/:deviceId/playback-events`         | Recent playback start/end/error/skip events.                                                                             |
| GET    | `/orgs/:orgId/devices/:deviceId/screenshot`              | Latest screenshot (presigned URL + metadata). Request a fresh one with the `take_screenshot` command.                    |

### Command types

`restart_player`, `reboot_device`, `refresh_content`, `clear_cache`,
`take_screenshot`, `identify`, `show_message`, `set_orientation`,
`set_playlist`, `update_settings`, `show_emergency`, `stop_emergency`,
`send_logs`, `health_check`, `software_update`.

`set_orientation` takes `payload: { orientation?: 'landscape' | 'portrait', rotation?: 0 | 90 | 180 | 270 }`
— send either or both. `orientation` is the content canvas shape; `rotation` is
software compensation for how the panel is physically mounted.

`show_message` takes `payload: { text, durationSeconds? }` and puts operator
text on the screen using the same full-screen overlay as `identify`:

- `text` — 1–280 characters, trimmed. Rendered as text, never as markup. The cap
  is about legibility: the overlay is sized to be read across a room, so a
  pasted paragraph is a wall, not a message.
- `durationSeconds` — 1–300, default 10. The overlay **covers the playlist**
  while it is up (playback continues underneath and is never interrupted), so
  the ceiling is deliberate: anything longer-lived is an emergency override,
  which is built for it.

The payload is validated and normalized before the command row is written, so
what is stored is exactly what the device is told to do — which matters because
a device on the polling fallback reads that row directly. The text is recorded
in the audit log: who put what on a public screen is the question that log
exists to answer.

## Device groups

| Method | Path                                  | Notes                                                                        |
| ------ | ------------------------------------- | ---------------------------------------------------------------------------- |
| GET    | `/orgs/:orgId/device-groups`          | Groups with `deviceCount`.                                                   |
| POST   | `/orgs/:orgId/device-groups`          | `{ name, description?, deviceIds? }`.                                        |
| GET    | `/orgs/:orgId/device-groups/:groupId` | Group + `deviceIds`.                                                         |
| PATCH  | `/orgs/:orgId/device-groups/:groupId` | `{ name?, description?, deviceIds? }` — `deviceIds` replaces the membership. |
| DELETE | `/orgs/:orgId/device-groups/:groupId` | Schedules targeting the group lose that target.                              |

## Media

| Method | Path                                         | Notes                                                                                                                                                            |
| ------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/orgs/:orgId/media?folderId=`               | `multipart/form-data` upload. Optional `folderId` files it into a folder. Validated by magic bytes; queued for FFmpeg processing (`processingStatus=pending`).   |
| GET    | `/orgs/:orgId/media`                         | Paged library with thumbnails, play counts, and folder paths. Query: `status, type, orientation, search, folderId, usedInPlaylist, sort, order, page, pageSize`. |
| GET    | `/orgs/:orgId/media/:mediaId`                | Asset detail incl. variants, processing error, play count, last played.                                                                                          |
| PATCH  | `/orgs/:orgId/media/:mediaId`                | Rename and/or move to another folder (`{ name?, folderId? }`; `folderId: null` = root).                                                                          |
| POST   | `/orgs/:orgId/media/bulk-move`               | `{ mediaIds, folderId }` — move many at once → `{ moved }`.                                                                                                      |
| GET    | `/orgs/:orgId/media/:mediaId/usage`          | Safe-delete summary: playlists/folder-entries/priority-rules referencing it, affected schedules, play count.                                                     |
| GET    | `/orgs/:orgId/media/:mediaId/playback-stats` | Totals + first/last played + top devices/playlists.                                                                                                              |
| DELETE | `/orgs/:orgId/media/:mediaId`                | Soft delete. Drops direct playlist/priority references; storage objects kept for later cleanup. Call `usage` first to warn.                                      |
| POST   | `/orgs/:orgId/media/bulk-delete`             | `{ mediaIds }` — soft-delete many → `{ deleted }`.                                                                                                               |
| POST   | `/orgs/:orgId/media/:mediaId/reprocess`      | Re-enqueue processing (e.g. after a `failed` status).                                                                                                            |

`folderId` filter accepts a folder id (that folder only), `root` (unfiled media),
or absent (all media). `sort` is one of `name, createdAt, updatedAt, type,
orientation, duration, playCount`.

## Media folders

Folders are organization-scoped, nestable, and a purely logical grouping — moving
or renaming a folder never moves storage objects, and playlists reference folders
by id so they survive renames/moves.

| Method | Path                                         | Notes                                                                                                                         |
| ------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/orgs/:orgId/media/folders`                 | Flat list with computed `path`, `mediaCount`, `subfolderCount`. The dashboard builds the tree client-side.                    |
| POST   | `/orgs/:orgId/media/folders`                 | `{ name, parentFolderId? }` — editor. Names are unique (case-insensitive) within a parent.                                    |
| PATCH  | `/orgs/:orgId/media/folders/:folderId`       | `{ name?, parentFolderId? }` — rename and/or move. Moving into itself or a descendant is rejected.                            |
| GET    | `/orgs/:orgId/media/folders/:folderId/usage` | Safe-delete summary: media count, subfolder count, playlist references, affected schedules.                                   |
| DELETE | `/orgs/:orgId/media/folders/:folderId`       | `{ strategy: move_to_root \| move_to_folder \| delete_media, targetFolderId? }` — soft delete; handles contents per strategy. |

## Playlists

| Method | Path                                                  | Notes                                                                                                                                                                                                                                           |
| ------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/orgs/:orgId/playlists`                              | With item counts.                                                                                                                                                                                                                               |
| POST   | `/orgs/:orgId/playlists`                              | `{ name, description?, loop?, defaultImageDurationSeconds?, playbackOrderMode?, items? }`.                                                                                                                                                      |
| GET    | `/orgs/:orgId/playlists/:playlistId`                  | Playlist + ordered items (media or folder entries) + media summaries with thumbnails.                                                                                                                                                           |
| PATCH  | `/orgs/:orgId/playlists/:playlistId`                  | Update name/description/loop/default duration/`playbackOrderMode` and display defaults `defaultFitMode`, `defaultBackgroundColor`, `defaultPositionMode`.                                                                                       |
| PUT    | `/orgs/:orgId/playlists/:playlistId/items`            | Replace the full ordered list. Each item is `{ type: media\|folder, mediaAssetId?, folderId?, durationSeconds?, fitMode?, backgroundColor?, positionMode?, enabled?, includeSubfolders?, filterMediaType?, filterOrientation? }`.               |
| POST   | `/orgs/:orgId/playlists/:playlistId/clone`            | `{ name? }` — duplicate items, folder entries, and priority rules (not schedules/history). Defaults to "Copy of …". → `201`.                                                                                                                    |
| GET    | `/orgs/:orgId/playlists/:playlistId/resolved-preview` | What devices will receive after resolution. Query `seed`, `sampleSize`. Resolved items also include `effectiveFitMode`, `effectiveBackgroundColor`, `effectivePositionMode` and `displaySource` (`item`/`playlist_default`/`platform_default`). |
| DELETE | `/orgs/:orgId/playlists/:playlistId`                  | Blocked while used as a device default or in schedules. Soft delete.                                                                                                                                                                            |

**Display settings.** `fitMode` is one of `contain` (Fit to screen), `cover`
(Fill / crop), `stretch`, `original`, `scale_down` (scale down only).
`positionMode` is `center`/`top`/`bottom`/`left`/`right`/`top_left`/`top_right`/
`bottom_left`/`bottom_right`. `backgroundColor` must be a `#RGB`/`#RRGGBB` hex
color (normalized to `#rrggbb`). Invalid fit modes, position modes or colors are
rejected with `400`. Item values override playlist defaults, which override the
platform defaults (`contain` / `#000000` / `center`). Single-media emergency
overrides accept the same `fitMode`/`backgroundColor`/`positionMode` fields.

`playbackOrderMode` is one of `manual_order` (default), `alphabetical`, `random`,
`random_with_priority_rules`. Folder entries resolve dynamically: media added to /
removed from a folder is reflected automatically; folder rename/move never breaks
the playlist.

## Playlist priority rules

Priority rules apply only when `playbackOrderMode = random_with_priority_rules`:
after every `intervalCount` normal items, one item from the rule's assignments is
inserted. Multiple rules per playlist are allowed; simultaneous triggers are
broken deterministically (lowest interval, then position, then creation time).

| Method | Path                                                                    | Notes                                                                                                                                                                        |
| ------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/orgs/:orgId/playlists/:playlistId/priority-rules`                     | Rules with resolved assignments and folder paths.                                                                                                                            |
| POST   | `/orgs/:orgId/playlists/:playlistId/priority-rules`                     | `{ name, intervalCount, selectionMode: rotate\|random, enabled?, position?, assignments? }`. → `201`.                                                                        |
| PATCH  | `/orgs/:orgId/playlists/:playlistId/priority-rules/:ruleId`             | Update name/interval/selection/enabled/position.                                                                                                                             |
| DELETE | `/orgs/:orgId/playlists/:playlistId/priority-rules/:ruleId`             | Soft delete.                                                                                                                                                                 |
| PUT    | `/orgs/:orgId/playlists/:playlistId/priority-rules/:ruleId/assignments` | Replace assignments: `{ assignments: [{ mediaAssetId? \| folderId?, includeSubfolders? }] }` (exactly one of media/folder each). Used to assign many selected files at once. |

## Schedules

| Method | Path                                           | Notes                                                                                                                                                                                                                                       |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/orgs/:orgId/schedules`                       | All schedules with targets.                                                                                                                                                                                                                 |
| POST   | `/orgs/:orgId/schedules`                       | `{ name, playlistId, enabled?, priority?, startDate?, endDate?, daysOfWeek?, startTime?, endTime?, timezone?, deviceIds?, groupIds? }`. Empty day set = every day; `startTime > endTime` = overnight window; no timezone = device timezone. |
| GET    | `/orgs/:orgId/schedules/preview?deviceId=&at=` | What a given screen would play at a given instant (runs the same resolver the device uses): `{ source: emergency\|schedule\|default\|none, ... }`.                                                                                          |
| GET    | `/orgs/:orgId/schedules/:scheduleId`           | Detail.                                                                                                                                                                                                                                     |
| PATCH  | `/orgs/:orgId/schedules/:scheduleId`           | Partial update; target arrays replace existing targets.                                                                                                                                                                                     |
| DELETE | `/orgs/:orgId/schedules/:scheduleId`           | Soft delete.                                                                                                                                                                                                                                |

## Emergency overrides

| Method | Path                                      | Notes                                                                                                                                                                         |
| ------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/orgs/:orgId/emergency`                  | Recent overrides, active first.                                                                                                                                               |
| POST   | `/orgs/:orgId/emergency`                  | Admin. Exactly one of `playlistId` / `mediaAssetId` (media must be `ready`), plus `appliesToAll` or explicit `deviceIds`/`groupIds`. Takes over targeted screens immediately. |
| POST   | `/orgs/:orgId/emergency/:overrideId/stop` | Ends the override; screens return to their normal schedule.                                                                                                                   |

## Superadmin

Platform-level administration. Every route requires an authenticated, active user
whose `globalRole` is `superadmin`; non-superadmins get `403`. All mutating
actions are written to the audit log.

| Method | Path                                                     | Notes                                                                                                      |
| ------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| GET    | `/superadmin/organizations`                              | All orgs with `deviceCount`, `userCount`, `mediaCount`, `storageUsedBytes`.                                |
| POST   | `/superadmin/organizations`                              | `{ name, slug?, status?, planName?, maxDevices?, maxStorageGb? }` — slug auto-generated if omitted. `201`. |
| PATCH  | `/superadmin/organizations/:orgId`                       | Update name/status/plan/limits. Status changes log enable/disable.                                         |
| GET    | `/superadmin/users`                                      | All users with global role, disabled state, and memberships.                                               |
| POST   | `/superadmin/users`                                      | `{ name, email, password, mustChangePassword?, memberships: [{ organizationId, role }] }`. `201`.          |
| PATCH  | `/superadmin/users/:userId`                              | `{ name?, disabled? }`. Superadmin accounts cannot be disabled from the dashboard.                         |
| POST   | `/superadmin/users/:userId/reset-password`               | `{ password, mustChangePassword? }`.                                                                       |
| POST   | `/superadmin/organizations/:orgId/members`               | `{ userId, role }` — add an existing user to an org. `201`.                                                |
| PATCH  | `/superadmin/organizations/:orgId/members/:membershipId` | `{ role }`.                                                                                                |
| DELETE | `/superadmin/organizations/:orgId/members/:membershipId` | Remove a membership. `204`.                                                                                |
| GET    | `/superadmin/audit-logs?page=&pageSize=`                 | Paged audit log (actor, action, target, metadata, IP, timestamp).                                          |

## Device API (device-token auth)

| Method | Path                                 | Notes                                                                                                                                          |
| ------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/device/pair`                       | `{ pairingCode, hardwareInfo? }` → `{ token, deviceId, ... }`. Single use; rate-limited 10/min. The token is shown to the device exactly once. |
| GET    | `/device/ws`                         | WebSocket. Server pushes `command` and `sync_required` messages; device sends acks/heartbeats.                                                 |
| POST   | `/device/heartbeat`                  | System metrics, app version, current playback.                                                                                                 |
| GET    | `/device/sync`                       | `{ manifest, commands }` — the full per-device manifest (see [sync-protocol.md](sync-protocol.md)).                                            |
| POST   | `/device/sync-status`                | `{ status: downloading\|applied\|failed, manifestVersion, error? }`.                                                                           |
| POST   | `/device/logs`                       | Batched log upload from the device's ring buffer.                                                                                              |
| POST   | `/device/playback-events`            | Batched playback events.                                                                                                                       |
| POST   | `/device/screenshot`                 | Binary screenshot upload (response to `take_screenshot`).                                                                                      |
| GET    | `/device/commands`                   | Pending commands (polling fallback for WS).                                                                                                    |
| POST   | `/device/commands/:commandId/ack`    | Mark received.                                                                                                                                 |
| POST   | `/device/commands/:commandId/result` | `{ success, output?/error? }` — completes or fails the command.                                                                                |
| GET    | `/device/media/:mediaId/file`        | Streams a media file the device's manifest references (the manifest's `downloadPath` points here).                                             |
