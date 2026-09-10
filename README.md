# Signage Platform

A self-hostable digital signage platform: a cloud backend, a web admin dashboard, and a
Linux device agent/player for Raspberry Pi 4/5 and ODROID-C4. Devices boot straight into
fullscreen content playback, are managed entirely from the dashboard, and keep playing
through network outages from a local cache.

## Highlights

- **Outbound-only devices** — devices connect out via HTTPS + WebSocket (with polling
  fallback). No inbound ports, no VPN, works behind NAT/firewalls.
- **Secure pairing** — single-use expiring pairing codes; devices hold a revocable token
  that is stored server-side only as a SHA-256 hash.
- **Offline-first playback** — media is cached on disk with checksums and a SQLite index;
  manifests apply transactionally; the screen never goes blank because of a network blip.
- **Flexible scheduling** — always / date-range / weekly-days / time-of-day windows with
  priorities, computed on-device so schedules keep switching while offline. DST-safe via
  IANA timezones. Emergency overrides win over everything.
- **Media pipeline** — uploads are validated (magic bytes, sanitized filenames), then
  processed with FFmpeg (transcode, thumbnails, metadata) through a Redis/BullMQ queue
  into S3/MinIO storage.
- **Portrait and landscape** — four screen orientations, per-item fit modes
  (`contain`, `cover`, `stretch`, `original`).
- **14 remote commands** — restart player, reboot, refresh content, clear cache,
  screenshot, identify, set orientation/playlist/settings, emergency start/stop,
  send logs, health check, software update.
- **Media folders** — nestable, organization-scoped folders (a logical grouping;
  storage objects never move), with bulk move, cross-folder search, play counts,
  and safe-delete warnings.
- **Smart playlists** — dynamic folder entries that track folder contents,
  playback order modes (manual / alphabetical / random / random with priority
  rules), per-playlist priority rules ("after every X items, play a sponsor"),
  a resolved preview, and one-click cloning. All order modes play offline.
- **Superadmin & accounts** — install-time superadmin, a platform admin area for
  managing organizations and users, forced first-login password change, and an
  audit log of privileged actions. Public self-service registration is disabled.
- **Multi-organization switching** — users who belong to several organizations
  switch between them from the sidebar; the active organization (logo, name, role)
  is always visible. Superadmins work in a "System / Superadmin" context and can
  open any organization and return to system context.
- **Display / fit modes** — per-item and per-playlist control of how media fills the
  screen: Fit to screen (`contain`), Fill / crop (`cover`), Stretch, Original size,
  and Scale down only — plus a background color and alignment. Resolved at sync time
  so devices render correctly offline; settings survive restarts. See the fit-mode
  table in [docs/sync-protocol.md](docs/sync-protocol.md).
- **Organization logos** — upload an SVG, PNG or JPG logo (≤ 2 MB) per organization
  in its settings; it appears in the sidebar, the organization switcher, and the
  superadmin companies list. SVGs are validated for safety and shown via `<img>`.

See [CHANGELOG.md](CHANGELOG.md) for the full v0.2 feature upgrade.

## Stack

| Part         | Tech                                                               |
| ------------ | ------------------------------------------------------------------ |
| API          | Node.js 22, TypeScript, Fastify, Prisma, PostgreSQL, Redis, BullMQ |
| Storage      | S3-compatible object storage (MinIO in dev)                        |
| Dashboard    | React 18, Vite, Tailwind CSS                                       |
| Device agent | Node.js + better-sqlite3, systemd, Chromium kiosk                  |
| Player UI    | Vanilla TypeScript + Vite, served by the agent's local HTTP server |
| Monorepo     | pnpm workspaces                                                    |

## Repository layout

```
apps/
  api/          Fastify backend (user API + device API + WebSocket)
  worker/       Media processing worker (BullMQ + FFmpeg)
  web/          Admin dashboard (React + Vite + Tailwind)
  agent/        Device agent (sync, cache, commands, local player server)
  player/       Player UI rendered by the kiosk browser
  mock-device/  Simulated device for development without hardware
packages/
  shared/       Shared types, enums, zod schemas, DTOs
  database/     Prisma schema, migrations, seed
  scheduler/    Pure schedule-resolution engine (used by API and agent)
  sync-protocol/ Versioned sync manifest types + diffing
  media/        Media validation/probing helpers
infra/
  docker/       Dockerfiles + nginx config for the compose stack
  device/       install.sh, update.sh, systemd units, signage CLI, kiosk scripts
docs/           Architecture, API, device install, sync protocol
```

## Quick start (Docker Compose)

Requirements: Docker with the compose plugin.

The real `docker-compose.yml` is git-ignored (it can hold secrets); create it
once from the committed template, then start the stack:

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up -d --build
```

This starts PostgreSQL, Redis, MinIO (+ bucket setup), runs database migrations,
and launches the API (`:4000`), worker, and dashboard (`:5173`).

For production (HTTPS, real secrets, external object storage), see
[docs/deployment.md](docs/deployment.md).

Seed demo data:

```bash
docker compose run --rm api node packages/database/dist/seed.js
```

Then open <http://localhost:5173> and log in:

- **Email:** `admin@example.com`
- **Password:** `password123`

The seed also creates a demo screen with pairing code **`DEMO2345`**.

### Accounts and the superadmin

Public self-service registration is disabled. Accounts are created by a platform
**superadmin** (or, within an organization, by an org admin). Bootstrap the first
superadmin by setting these before the API starts (see `.env.example`):

```bash
INITIAL_SUPERADMIN_EMAIL=admin@yourco.com
INITIAL_SUPERADMIN_PASSWORD=a-strong-password-min-12-chars
INITIAL_SUPERADMIN_NAME="Platform Admin"
```

The account is created on startup only if no superadmin exists yet (existing
superadmins are never overwritten, and the password is never logged). You can also
manage it from the CLI at any time:

```bash
pnpm app:create-superadmin -- <email> <password> [name]
pnpm app:reset-superadmin-password -- <email> <new-password>
```

Superadmins sign in at the normal login page and get a **Superadmin** area for
managing organizations, users, and memberships.

### Simulated device

You can pair a virtual screen without any hardware:

```bash
MOCK_DEVICE_PAIRING_CODE=DEMO2345 docker compose --profile mock-device up -d --build
```

The mock device pairs, syncs, and serves its player at <http://localhost:8081>.

## Local development (without Docker for the apps)

Requirements: Node.js >= 20 (22 recommended), pnpm via corepack, Docker for infra.

```bash
corepack enable
pnpm install

# Start postgres + redis + minio only
pnpm dev:infra

# Database
pnpm db:generate
pnpm db:migrate
pnpm db:seed

# In separate terminals
pnpm dev:api          # http://localhost:4000
pnpm dev:worker
pnpm dev:web          # http://localhost:5173 (proxies /api to :4000)
pnpm dev:mock-device  # optional simulated screen
```

Workspace-wide checks:

```bash
pnpm build        # build all packages and apps
pnpm typecheck
pnpm test
pnpm format
```

## Installing on a real device

See [docs/device-install.md](docs/device-install.md). Short version, on a fresh
Raspberry Pi OS Lite / Ubuntu / Armbian install:

```bash
git clone <this repo> && cd signage-platform
sudo ./infra/device/install.sh --server https://signage.example.com --pairing-code ABCD1234
```

The device boots into a Chromium kiosk and appears online in the dashboard.

## Documentation

- [docs/architecture.md](docs/architecture.md) — components, data flow, security model
- [docs/deployment.md](docs/deployment.md) — full cloud server deployment (Docker, DNS, TLS)
- [docs/runbook.md](docs/runbook.md) — **production runbook**: deploy, update, back up, restore, roll back, troubleshoot
- [docs/api.md](docs/api.md) — REST + WebSocket API reference
- [docs/device-install.md](docs/device-install.md) — device setup, `signage` CLI, updates
- [docs/sync-protocol.md](docs/sync-protocol.md) — manifest format and sync semantics
- [CHANGELOG.md](CHANGELOG.md) — release history (v0.2 adds folders, smart playlists, superadmin)

## Notes

- Audio is out of scope for v1; videos play muted. The pipeline and player do not
  strip or prevent audio, so it can be enabled later without architectural changes.
- Default image duration is 10 seconds; default fit mode is `contain`.
