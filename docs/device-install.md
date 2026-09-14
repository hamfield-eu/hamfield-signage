# Device installation

Target hardware: ARM SBCs (Raspberry Pi 4/5, ODROID-C4) and x86 thin clients
(Chromeboxes with coreboot — Acer CXI3, Asus CN62). Any Debian-based OS works:
Raspberry Pi OS Lite, Ubuntu Server, Armbian, Debian netinst. No desktop
environment is needed; the installer sets up a minimal X + Chromium kiosk.

**Install from a Lite / server / netinst image.** A desktop image gives the
console to a display manager, which the kiosk cannot share — see
[A desktop install is already running X](#a-desktop-install-is-already-running-x).
This is the single most common way a new x86 unit ends up with a blank screen.

Two things differ between the two families and are called out where they matter:
x86 boards use **predictable network interface names** (`wlp2s0`, not `wlan0`),
and only x86 gets the VA-API packages. Per-model measurements live in
[hardware-matrix.md](hardware-matrix.md).

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

| Key                            | Default                          | Purpose                                                           |
| ------------------------------ | -------------------------------- | ----------------------------------------------------------------- |
| `SIGNAGE_SERVER_URL`           | —                                | Backend base URL                                                  |
| `SIGNAGE_PAIRING_CODE`         | —                                | Consumed once at first start; cleared after pairing               |
| `SIGNAGE_DATA_DIR`             | `/var/lib/signage`               | SQLite DB, cached media, device token                             |
| `SIGNAGE_PLAYER_PORT`          | `8080`                           | Local player server port (127.0.0.1)                              |
| `SIGNAGE_PLAYER_UI_DIR`        | `/opt/signage/player-ui`         | Built player UI                                                   |
| `SIGNAGE_SCREENSHOT_CMD`       | `/opt/signage/bin/screenshot.sh` | Used by `take_screenshot`                                         |
| `SIGNAGE_UPDATE_CMD`           | `/opt/signage/bin/update.sh`     | Used by `software_update`                                         |
| `SIGNAGE_UPDATE_URL`           | (unset)                          | Release tarball URL for self-update                               |
| `SIGNAGE_ALLOW_REBOOT`         | `true`                           | Whether `reboot_device` is honored                                |
| `SIGNAGE_PLAYER_SERVICE`       | `signage-player.service`         | Unit restarted by `restart_player`                                |
| `SIGNAGE_WATCHDOG`             | `on`                             | Playback liveness monitoring; `off` silences it entirely          |
| `SIGNAGE_MAX_CACHE_GB`         | `8`                              | Media cache budget; also capped at 70% of the disk                |
| `SIGNAGE_MIN_FREE_DISK_MB`     | `500`                            | Free space a sync will not eat into                               |
| `SIGNAGE_CACHE_EVICTION`       | `false`                          | LRU eviction of unreferenced cached files (opt-in)                |
| `SIGNAGE_CACHE_HASH_PER_PASS`  | `2`                              | Cached files fully re-hashed per integrity pass                   |
| `SIGNAGE_LOG_LEVEL`            | `info`                           | Agent log level                                                   |
| `SIGNAGE_KIOSK_GPU`            | `auto`                           | Chromium GPU backend: `auto` \| `vulkan` \| `angle` \| `software` |
| `SIGNAGE_CHROMIUM_EXTRA_FLAGS` | (unset)                          | Extra space-separated flags appended to the kiosk Chromium        |

Edit with `signage config set KEY VALUE` (restarts the agent automatically).

### Kiosk GPU acceleration

Chromium's GPU stack is fragile on ARM SBCs, so `start-player.sh` selects a
backend per board (override with `SIGNAGE_KIOSK_GPU`):

- **Raspberry Pi 4/5** — auto-detected (via `vulkaninfo`, driver `V3DV`) and run
  with **ANGLE-on-Vulkan**, which composites through the V3D GPU and eliminates
  the screen tearing that software compositing produces.
- **Intel x86 thin clients (Chromebox and similar)** — auto-detected via the
  Intel Vulkan driver and run with **ANGLE on native desktop GL**
  (`--use-angle=gl`). AMD (`radv`) maps the same way but is **unvalidated** — no
  AMD unit has been tested.
- **ODROID C4 (Mali) and any board without a usable hardware Vulkan driver** —
  fall back to Chromium's **software** compositing. It always renders and never
  crash-loops the GPU process; expect tearing and no hardware video decode.

A device that lands on `software` because its driver is not in the map now says
so by name in `signage player-logs`, along with the override command — so
unrecognised hardware is discoverable instead of just being slow.

`auto` only selects an accelerated backend when a hardware (non-`lavapipe`)
Vulkan driver is present, so a misdetect can't strand a screen. To experiment on
other hardware, force a mode, e.g. `signage config set SIGNAGE_KIOSK_GPU angle`,
then `signage restart-player` and check `signage player-logs` for repeated
`Exiting GPU process` lines (= that backend doesn't work there; revert to
`software`).

**The logged GPU mode is what was requested, not what Chromium used.** Given a
backend it cannot initialise, Chromium does not error and does not fall back —
it sets `--use-gl=disabled` internally and composites in software, while the
launcher's log line still reports the mode it asked for. Verify the outcome, not
the request:

```bash
pgrep -af 'type=gpu-process' | grep -o 'use-gl=[a-z]*'   # 'disabled' means software
sudo intel_gpu_top                                       # Intel: RCS must be non-zero
```

This is not hypothetical: `--use-angle=gles` did exactly that on a Chromebox and
halved the machine's usable CPU while every log line looked correct.

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
# display-manager.service is an ALIAS. Resolve it to the real unit first —
# `systemctl disable` on the alias does not reliably disable the target.
basename "$(readlink -f /etc/systemd/system/display-manager.service)" .service
sudo systemctl set-default multi-user.target
sudo systemctl disable --now gdm.service    # ...or lightdm/sddm, from above
sudo rm -f /tmp/.X0-lock
sudo systemctl restart signage-player
```

On Debian 13 the `gdm3` **package** ships `gdm.service`, so the unit name is not
the package name. Verified on an Asus Chromebox CN62 imaged from a Debian 13
desktop ISO: the player was crash-looping every 5 s with `xinit` exiting within
~25 ms, and this fixed it.

This removes the local desktop, which is the intent for an appliance. It is
reversible with `systemctl enable --now display-manager` and
`systemctl set-default graphical.target`.

`install.sh` warns about this at the end of an install when it detects an
enabled display manager. Installing from a **Lite / server / netinst** image
avoids it entirely, and is the recommended base for a signage device.

### Reclaiming the disk after a desktop install

Disabling the display manager is enough to make the kiosk work, but the desktop
is still installed and still costing disk — which matters, because the media
cache budget is bounded by free space (see `SIGNAGE_MAX_CACHE_GB` above). On a
CN62 with a 13 GB disk, purging GNOME returned **~1.7 GB**.

**Mark the appliance's own dependencies manual before purging anything.** On a
Debian desktop image, `sudo`, `openssh-server`, `network-manager`,
`wpasupplicant`, `iw` and `polkitd` are all pulled in as *dependencies of the
desktop task*, not installed manually. Dropping the task and running
`apt-get autoremove --purge` therefore removes remote access, networking, and the
polkit daemon the `signage` user needs to restart its own units:

```bash
sudo apt-mark manual sudo openssh-server network-manager wpasupplicant iw polkitd
sudo apt-get purge -y task-gnome-desktop task-desktop gnome gnome-core gdm3 \
  firefox-esr libreoffice-core evolution-common gnome-user-docs ibus-data

# One pass only peels the top metapackages — GNOME's web of Recommends stalls
# orphan detection. Loop until a pass removes nothing.
while [ "$(sudo apt-get -s autoremove --purge | grep -cE '^(Remv|Purg)')" -gt 0 ]; do
  sudo apt-get autoremove --purge -y
done
sudo apt-get clean
```

Then confirm the protected packages survived and the services are still up
before you walk away from the device.

### Tearing

Moving compositing onto the GPU (see above) removes most of it. A faint residual
artifact during motion may remain.

**`TearFree` does not work on Debian 13 and is not configured.** It is the
textbook fix, but this Xorg's `modesetting` driver does not implement the
option — setting it yields only:

```
(WW) modeset(0): Option "TearFree" is not used
```

The driver that does implement it, `xf86-video-intel`, is deprecated by Intel
for Gen9 and newer and is not a good bet on an unattended screen. If you try it
anyway, verify with `grep -i tearfree /var/log/Xorg.0.log` — a config file that
Xorg ignores looks identical to one that works.

## Wi-Fi

Ethernet is preferable and often impossible: screens get mounted where there is
power and a wall, not where there is a network drop. Treat Wi-Fi as the normal
case for x86 thin clients.

The agent tolerates a flaky link better than most things on a screen would: it
is **outbound-only** (no inbound ports, works behind NAT and on guest networks)
and **offline-first**, so a dropped link delays sync rather than blanking the
screen. What it does not tolerate well is a _first_ sync over a marginal link —
that is when the whole playlist transfers.

### Hardware

| Platform            | Chip                       | Driver             | Assessment                                                       |
| ------------------- | -------------------------- | ------------------ | ---------------------------------------------------------------- |
| Acer Chromebox CXI3 | Intel Wireless 7265 (095a) | `iwlwifi`/`mvm`    | In-tree, first-party, dual-band 802.11ac 2x2. Best of the three. |
| Asus Chromebox CN62 | **not recorded**           | `iwlwifi`          | Interface is `wlp2s0`; chip not yet identified with `lspci`.     |
| Raspberry Pi 4/5    | Broadcom                   | `brcmfmac`         | In-tree; generally dependable.                                   |
| ODROID-C4           | usually Realtek USB/SDIO   | vendor/out-of-tree | Source of "works on this network, not that one" reports.         |

If a board misbehaves on some networks and not others, suspect the driver before
the access point — WPA3/PMF negotiation and power-save quirks are where
out-of-tree drivers fail first.

### Setup (NetworkManager)

**Find the interface name first.** Only the ARM SBCs call it `wlan0`; x86 thin
clients use predictable names (`wlp2s0` on a CN62). Every `iw` command below
needs the real one:

```bash
WIFI_IF="$(nmcli -t -f DEVICE,TYPE device | awk -F: '$2=="wifi"{print $1; exit}')"
echo "$WIFI_IF"
```

```bash
sudo nmcli device wifi list
sudo nmcli device wifi connect "<SSID>" password "<PASSWORD>"

# Survive reboots AND an access point that reboots overnight. The default
# retry count gives up after a few failures, which leaves a screen offline
# until someone physically visits it. 0 means retry forever.
sudo nmcli connection modify "<SSID>" connection.autoconnect yes \
                                     connection.autoconnect-retries 0
```

### Disable Wi-Fi power saving — the one that matters

`iwlwifi` power-saves aggressively by default. On an always-on screen this shows
up as latency spikes, slow or stalling syncs, and links that look like
disconnects. It is easy to misread as an access-point problem.

```bash
sudo tee /etc/NetworkManager/conf.d/wifi-powersave-off.conf >/dev/null <<'CONF'
[connection]
wifi.powersave = 2
CONF
sudo systemctl restart NetworkManager
```

`2` means disabled (`3` is enabled — the default).

Without NetworkManager, do the same with a systemd unit running
`iw dev "$WIFI_IF" set power_save off` after the interface appears, or a udev
rule.

### Verify the outcome, not the request

```bash
iw dev "$WIFI_IF" get power_save   # want: "Power save: off"
iw dev "$WIFI_IF" link             # signal (dBm), bitrate, SSID
nmcli -f NAME,AUTOCONNECT,AUTOCONNECT-RETRIES connection show
```

Signal is measured **at the screen's mounted position**, not where the installer
is standing. Better than −65 dBm is comfortable; worse than −75 dBm is where a
2x2 ac link starts costing real throughput, and the first full sync is when that
hurts.

### Troubleshooting

| Symptom                                   | Check                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Syncs stall or crawl, playback fine       | `iw dev $WIFI_IF get power_save` — powersave on is the usual cause                             |
| Offline after an overnight AP reboot      | `connection.autoconnect-retries` — the default gives up                                        |
| Connects at the desk, not at the mount    | `iw dev $WIFI_IF link` at the mount; below −75 dBm, move the screen or add an AP               |
| Works on one network, not another         | WPA3/PMF or band steering; try `wpa-pmf optional`, or pin the band with `802-11-wireless.band` |
| Device online, dashboard shows it offline | Outbound HTTPS/WSS blocked by the site firewall; `curl -fsS $SIGNAGE_SERVER_URL/health`        |

### Not yet validated

No signage device has been soaked on Wi-Fi. The 7265 assessment above is from
the driver and chip, not from a 72-hour run on a customer network. When the
first one is done, record the result here: signal at the mount, whether the link
survived AP reboots, and whether any sync failed.

Both Chromeboxes are Wi-Fi-dependent in production, so one of them will be the
first: `hamfield-signage-2` (CN62) is Wi-Fi-only at its site. **Unplug Ethernet
for the soak.** A soak with the wired link still connected validates a path the
screen will never use, and the failure mode being tested — a marginal link
during a first full-playlist sync — cannot occur while Ethernet is carrying the
traffic.
