# Device installation

Target hardware: Raspberry Pi 4/5 and ODROID-C4 (any Debian-based OS works —
Raspberry Pi OS Lite, Ubuntu Server, Armbian). No desktop environment is needed;
the installer sets up a minimal X + Chromium kiosk.

## Install

1. In the dashboard, create the screen (**Screens → New screen**). You get a
   one-time pairing code like `K7TR2MWP`.
2. On the device:

```bash
sudo apt-get install -y git
git clone <repository url> signage-platform
cd signage-platform
sudo ./infra/device/install.sh --server https://signage.example.com --pairing-code K7TR2MWP
```

The installer:

- installs Node.js 22 (NodeSource) if missing, plus X/Chromium/scrot unless
  `--no-player` is given;
- builds the agent and player UI from the checkout and deploys a standalone
  production bundle to `/opt/signage` (`agent/`, `player-ui/`, `bin/`);
- creates the unprivileged `signage` system user (groups: video, render, input,
  tty, audio) with data in `/var/lib/signage`;
- writes `/etc/signage/agent.env` (mode 600);
- installs the `signage` CLI to `/usr/local/bin`;
- installs polkit rules so the `signage` user may restart the signage units and
  reboot the device — no sudoers entries, no root agent;
- installs and starts `signage-agent.service` and `signage-player.service`.

After boot the screen shows pairing/sync status until content arrives, then plays.

Flags:

| Flag                    | Meaning                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `--server <url>`        | Backend URL (required on first install)                     |
| `--pairing-code <code>` | Pair immediately; otherwise run `signage pair <code>` later |
| `--no-player`           | Agent only — no X/Chromium (headless test boxes)            |
| `--bundle <out.tar.gz>` | Don't install; build a release tarball for remote updates   |

## Configuration (`/etc/signage/agent.env`)

| Key                            | Default                          | Purpose                                                          |
| ------------------------------ | -------------------------------- | ---------------------------------------------------------------- |
| `SIGNAGE_SERVER_URL`           | —                                | Backend base URL                                                 |
| `SIGNAGE_PAIRING_CODE`         | —                                | Consumed once at first start; cleared after pairing              |
| `SIGNAGE_DATA_DIR`             | `/var/lib/signage`               | SQLite DB, cached media, device token                            |
| `SIGNAGE_PLAYER_PORT`          | `8080`                           | Local player server port (127.0.0.1)                             |
| `SIGNAGE_PLAYER_UI_DIR`        | `/opt/signage/player-ui`         | Built player UI                                                  |
| `SIGNAGE_SCREENSHOT_CMD`       | `/opt/signage/bin/screenshot.sh` | Used by `take_screenshot`                                        |
| `SIGNAGE_UPDATE_CMD`           | `/opt/signage/bin/update.sh`     | Used by `software_update`                                        |
| `SIGNAGE_UPDATE_URL`           | (unset)                          | Release tarball URL for self-update                              |
| `SIGNAGE_ALLOW_REBOOT`         | `true`                           | Whether `reboot_device` is honored                               |
| `SIGNAGE_PLAYER_SERVICE`       | `signage-player.service`         | Unit restarted by `restart_player`                               |
| `SIGNAGE_WATCHDOG`             | `on`                             | Playback liveness monitoring; `off` silences it entirely         |
| `SIGNAGE_MAX_CACHE_GB`         | `8`                              | Media cache budget; also capped at 70% of the disk               |
| `SIGNAGE_MIN_FREE_DISK_MB`     | `500`                            | Free space a sync will not eat into                              |
| `SIGNAGE_CACHE_EVICTION`       | `false`                          | LRU eviction of unreferenced cached files (opt-in)               |
| `SIGNAGE_CACHE_HASH_PER_PASS`  | `2`                              | Cached files fully re-hashed per integrity pass                  |
| `SIGNAGE_LOG_LEVEL`            | `info`                           | Agent log level                                                  |
| `SIGNAGE_KIOSK_GPU`            | `auto`                           | Chromium GPU backend: `auto` \| `vulkan` \| `gles` \| `software` |
| `SIGNAGE_CHROMIUM_EXTRA_FLAGS` | (unset)                          | Extra space-separated flags appended to the kiosk Chromium       |

Edit with `signage config set KEY VALUE` (restarts the agent automatically).

### Kiosk GPU acceleration

Chromium's GPU stack is fragile on ARM SBCs, so `start-player.sh` selects a
backend per board (override with `SIGNAGE_KIOSK_GPU`):

- **Raspberry Pi 4/5** — auto-detected (via `vulkaninfo`, driver `V3DV`) and run
  with **ANGLE-on-Vulkan**, which composites through the V3D GPU and eliminates
  the screen tearing that software compositing produces.
- **Intel x86 thin clients (Chromebox and similar)** — auto-detected via the
  `anv` Vulkan driver and run with **ANGLE-on-GLES**, the conservative
  accelerated path. AMD (`radv`) maps the same way but is **unvalidated** — no
  AMD unit has been tested.
- **ODROID C4 (Mali) and any board without a usable hardware Vulkan driver** —
  fall back to Chromium's **software** compositing. It always renders and never
  crash-loops the GPU process; expect tearing and no hardware video decode.

A device that lands on `software` because its driver is not in the map now says
so by name in `signage player-logs`, along with the override command — so
unrecognised hardware is discoverable instead of just being slow.

`auto` only selects an accelerated backend when a hardware (non-`lavapipe`)
Vulkan driver is present, so a misdetect can't strand a screen. To experiment on
other hardware, force a mode, e.g. `signage config set SIGNAGE_KIOSK_GPU gles`,
then `signage restart-player` and check `signage player-logs` for repeated
`Exiting GPU process` lines (= that backend doesn't work there; revert to
`software`).

### Hardware video decode (x86 only)

On `x86_64`, the installer also adds `vainfo`, `intel-media-va-driver` (iHD) and
`i965-va-driver`, then reports whether an H.264 decode entrypoint exists. This
matters more than compositing on a low-power thin client: software-decoding
1080p on two 1.8 GHz cores leaves almost nothing for the rest of the system.

Check it at any time with:

```bash
vainfo | grep VAProfileH264
```

`VAEntrypointVLD` on an H.264 profile means decode is available **to the
driver**. Chromium still has to be told to use it — see
[hardware-matrix.md](hardware-matrix.md) for the validated flag set per model,
and note that VA-API flag names change between Chromium major versions, so a
flag set is only trustworthy for the version it was tested against.

ARM boards install none of this: there is no VA-API driver to install for them.

## The `signage` CLI

```
signage status              Agent + player status and local health
signage logs [-f]           Agent logs (journalctl)
signage player-logs [-f]    Kiosk logs
signage restart             Restart the agent
signage restart-player      Restart the kiosk browser
signage pair <code>         Set a new pairing code and restart the agent
signage config              Show /etc/signage/agent.env
signage config set K V      Change a setting and restart the agent
signage health              Query the local player health endpoint
signage screenshot <file>   Take a test screenshot
signage version             Installed agent version
```

## Services

- `signage-agent.service` — the Node agent, runs as `signage`, `Restart=always`,
  sandboxed with `ProtectSystem=full` and write access only to `/var/lib/signage`.
- `signage-player.service` — starts X on vt1 via `xinit` and runs
  `/opt/signage/bin/start-player.sh`: disables blanking/DPMS, scrubs Chromium
  crash flags, and relaunches Chromium in kiosk mode
  (`--kiosk http://127.0.0.1:8080`, autoplay allowed) in a loop.

Useful commands: `systemctl status signage-agent`, `journalctl -u signage-agent -f`.

## Updates

Two paths (the remote path is documented in full in
[device-updates.md](device-updates.md)):

1. **From a checkout** (hands-on): `git pull` and re-run `install.sh` — the env
   file and pairing are preserved.
2. **Remote** (fleet): build a release tarball on any machine with
   `./infra/device/install.sh --bundle signage-device.tar.gz`, host it at a
   stable URL (e.g. `https://hamfield.eu/signage-device.tar.gz`), set
   `SIGNAGE_UPDATE_URL` to that URL once on the devices, and send the
   `software_update` command from the dashboard. The device downloads the
   tarball, keeps the previous version as `*.previous` for rollback, swaps
   `agent`/`player-ui`/`bin`, and restarts itself.

   The update is **idempotent**: the device compares the tarball's `sha256`
   against the version it is already running and only swaps + restarts when the
   hosted file has actually changed, so you can safely send `software_update` to
   the whole fleet on a schedule — unchanged devices are a cheap no-op. To cut a
   new release, just overwrite the hosted tarball and re-send the command.
   `update.sh --force` re-applies even when the hash matches (for recovery).

## Re-pairing / moving a device

Revoke the token in the dashboard (or delete + recreate the screen), generate a
new pairing code, then on the device run `signage pair <CODE>`.

## Troubleshooting

| Symptom                                                             | Check                                                                                                                                                                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Screen shows "not paired"                                           | `signage logs -f` — wrong/expired code? Run `signage pair <new code>`.                                                                                                              |
| Black screen / no X                                                 | `signage player-logs`; confirm `/etc/X11/Xwrapper.config` has `allowed_users=anybody`.                                                                                              |
| Player restarts in a loop, `Server is already active for display 0` | A desktop session owns the console. See "A desktop install is already running X" below.                                                                                             |
| Online but stale content                                            | `signage status` (sync state), dashboard → screen → Sync status; `refresh_content` command.                                                                                         |
| Media won't download                                                | Server URL reachable over HTTPS from the device? `curl -fsS $SIGNAGE_SERVER_URL/health` → `{"status":"ok",…}`. (`/healthz` is this device's _own_ player server, not the server's.) |
| Disk filling up                                                     | Cache is pruned to the manifest; check `/var/lib/signage/media` vs. assigned playlists.                                                                                             |

### A desktop install is already running X

The kiosk owns the console. If the device was installed from a **desktop** ISO,
a display manager (GDM, LightDM, SDDM) already holds display `:0`, and the
player service dies on every start with:

```
(EE) Fatal server error:
(EE) Server is already active for display 0
```

systemd then restarts it forever. The agent is unaffected — the device pairs,
syncs and reports normally — so the only symptom is a blank screen and a
restart counter climbing in `systemctl status signage-player`.

Hand the console to the kiosk:

```bash
ls -l /etc/systemd/system/display-manager.service   # which DM is it?
sudo systemctl disable --now display-manager
sudo systemctl set-default multi-user.target
sudo rm -f /tmp/.X0-lock
sudo systemctl restart signage-player
```

This removes the local desktop, which is the intent for an appliance. It is
reversible with `systemctl enable --now display-manager` and
`systemctl set-default graphical.target`.

`install.sh` warns about this at the end of an install when it detects an
enabled display manager. Installing from a **Lite / server / netinst** image
avoids it entirely, and is the recommended base for a signage device.
