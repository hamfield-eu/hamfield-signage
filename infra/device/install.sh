#!/usr/bin/env bash
# Signage device installer for Raspberry Pi 4/5 and ODROID-C4
# (Debian-based OS: Raspberry Pi OS Lite, Ubuntu, Armbian).
#
# Run from a checkout of the signage-platform repository:
#   sudo ./infra/device/install.sh --server https://signage.example.com --pairing-code ABCD1234
#
# Options:
#   --server <url>         Backend URL (required on first install)
#   --pairing-code <code>  One-time pairing code from the dashboard
#   --no-player            Install the agent only (headless, no Chromium kiosk)
#   --bundle <out.tar.gz>  Don't install; build a release tarball for update.sh
set -eu

SERVER_URL=""
PAIRING_CODE=""
INSTALL_PLAYER=1
BUNDLE_OUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER_URL="$2"; shift 2 ;;
    --pairing-code) PAIRING_CODE="$2"; shift 2 ;;
    --no-player) INSTALL_PLAYER=0; shift ;;
    --bundle) BUNDLE_OUT="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ ! -f "$REPO_ROOT/pnpm-workspace.yaml" ]; then
  echo "Run this script from a signage-platform repository checkout" >&2
  exit 1
fi

log() { echo "==> $*"; }

# ---------------------------------------------------------------------------
# Build the agent and player UI
# ---------------------------------------------------------------------------
build_release() {
  local out_dir="$1"

  # The agent depends on better-sqlite3, which is a native module and only
  # ships prebuilt bindings for a range of Node ABIs. Too NEW is as broken as
  # too old: on Node 24 there is no prebuild, so the install falls back to
  # compiling from source and fails on any device without a C++ toolchain —
  # leaving an agent that cannot open its own database. So pin the supported
  # window rather than only enforcing a floor.
  NODE_MAJOR=0
  if command -v node > /dev/null 2>&1; then
    NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])' 2> /dev/null || echo 0)"
  fi
  if [ "$NODE_MAJOR" -lt 20 ] || [ "$NODE_MAJOR" -gt 22 ]; then
    log "Installing Node.js 22 (NodeSource) — found major version ${NODE_MAJOR:-none}"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi

  log "Enabling pnpm via corepack"
  corepack enable

  log "Installing workspace dependencies (this can take a while on a Pi)"
  cd "$REPO_ROOT"
  pnpm install

  log "Building agent and player UI"
  pnpm --filter "@signage/agent..." build
  pnpm --filter @signage/player build

  log "Creating standalone agent deployment"
  rm -rf "$out_dir/agent"
  pnpm --filter @signage/agent deploy --prod "$out_dir/agent"

  rm -rf "$out_dir/player-ui"
  cp -r "$REPO_ROOT/apps/player/dist" "$out_dir/player-ui"

  mkdir -p "$out_dir/bin"
  cp "$SCRIPT_DIR/start-player.sh" "$SCRIPT_DIR/screenshot.sh" "$SCRIPT_DIR/update.sh" "$out_dir/bin/"
  chmod +x "$out_dir/bin/"*
}

# True when an installed Chromium is usable under our systemd service. On Ubuntu
# the `chromium`/`chromium-browser` apt packages are snap stubs (a shell wrapper
# around `snap run`), and the snap cannot run under our service — snap-confine
# rejects the non-snap service cgroup, so the kiosk never starts.
#
# A real native build is an ELF executable. But a wrapper *script* is NOT
# automatically a snap stub: Raspberry Pi OS ships `/usr/bin/chromium` as a shell
# wrapper that only adds Pi-specific flags and execs the real binary in
# /usr/lib/chromium. So a script counts as native unless it actually routes
# through snap — otherwise we would wrongly purge a perfectly good Pi Chromium.
chromium_is_native() {
  local bin path
  for bin in chromium chromium-browser; do
    path="$(command -v "$bin" 2> /dev/null)" || continue
    if file -L "$path" 2> /dev/null | grep -q 'ELF'; then
      return 0
    fi
    # A wrapper script that does not invoke snap (e.g. the Raspberry Pi launcher)
    # still drives a real Chromium — treat it as native.
    if file -L "$path" 2> /dev/null | grep -qi 'script'; then
      if grep -qi 'snap' "$path" 2> /dev/null; then
        continue
      fi
      return 0
    fi
  done
  return 1
}

install_chromium() {
  if chromium_is_native; then
    log "Native Chromium already present"
    return 0
  fi

  log "Installing Chromium"
  apt-get install -y chromium-browser 2> /dev/null \
    || apt-get install -y chromium 2> /dev/null || true
  if chromium_is_native; then
    return 0
  fi

  # Got the Ubuntu snap stub (or nothing). Remove it and install a real .deb
  # from the xtradeb PPA, which packages Chromium for arm64/amd64 to replace
  # the snap. (On Debian/Armbian the apt package above is already native and we
  # never reach here.)
  log "Distro Chromium is a snap stub — installing native build from ppa:xtradeb/apps"
  apt-get purge -y chromium chromium-browser 2> /dev/null || true
  apt-get install -y software-properties-common
  add-apt-repository -y ppa:xtradeb/apps
  apt-get update
  apt-get install -y chromium || true

  if ! chromium_is_native; then
    echo "Could not install a native (non-snap) Chromium for this distro/arch." >&2
    echo "Install one manually so 'chromium' is an ELF binary, then re-run." >&2
    exit 1
  fi
}

# --bundle mode: produce a tarball for SIGNAGE_UPDATE_URL and exit.
if [ -n "$BUNDLE_OUT" ]; then
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  build_release "$WORK"
  tar -czf "$BUNDLE_OUT" -C "$WORK" agent player-ui bin
  log "Release bundle written to $BUNDLE_OUT"
  exit 0
fi

# ---------------------------------------------------------------------------
# Full device install (root required)
# ---------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0 ..." >&2
  exit 1
fi
if ! command -v apt-get > /dev/null 2>&1; then
  echo "This installer supports Debian-based systems only (apt-get not found)" >&2
  exit 1
fi

log "Installing base packages"
apt-get update
apt-get install -y curl ca-certificates

if [ "$INSTALL_PLAYER" -eq 1 ]; then
  log "Installing kiosk packages (X server, scrot, Vulkan)"
  # mesa-vulkan-drivers provides the Vulkan ICD (V3DV on Raspberry Pi, ANV on
  # Intel); vulkan-tools provides vulkaninfo, which start-player.sh uses to
  # detect a usable GPU. Both are best-effort: on boards without a Vulkan driver
  # the kiosk falls back to software.
  apt-get install -y xserver-xorg xinit x11-xserver-utils scrot file \
    mesa-vulkan-drivers vulkan-tools || true

  # Hardware video decode on Intel. Only meaningful on x86 — the ARM boards have
  # no VA-API driver to install — so it is gated on the architecture rather than
  # pulling Intel packages onto every Raspberry Pi.
  #
  # `intel-media-va-driver` is the iHD driver and is in Debian main, so this
  # needs no `non-free` component. It covers Gen8 onwards, which includes every
  # Chromebox-class part worth deploying. `i965-va-driver` is the fallback for
  # pre-Gen8 hardware; installing both is harmless because libva picks per
  # device. `vainfo` is the diagnostic that decides whether decode is possible
  # at all, so it is not optional.
  #
  # Validated on an Acer Chromebox CXI3 (Kaby Lake GT1, [8086:5906]): iHD
  # 25.2.3 reports VAProfileH264High/Main/ConstrainedBaseline with
  # VAEntrypointVLD. See docs/hardware-matrix.md.
  #
  # IMPORTANT: as of Debian 13, the distro's Chromium is built WITHOUT VA-API
  # (`strings -a /usr/lib/chromium/chromium | grep -ci vaapi` → 0), so these
  # packages do NOT currently deliver hardware decode there. They are installed
  # anyway because `vainfo` is the diagnostic that tells an operator whether the
  # hardware is even capable, and because a Chromium built with `use_vaapi=true`
  # needs them present. Do not read the success message below as "decode is on".
  if [ "$(uname -m)" = "x86_64" ]; then
    log "Installing VA-API packages for Intel hardware video decode"
    apt-get install -y vainfo intel-media-va-driver i965-va-driver || true
    if command -v vainfo > /dev/null 2>&1; then
      if vainfo 2>&1 | grep -qE 'VAProfileH264.*VAEntrypointVLD'; then
        log "VA-API: the driver offers hardware H.264 decode (Chromium must also support it)"
      else
        # Not fatal: the kiosk still plays, in software. But it is the single
        # thing most worth knowing about an x86 device, so say it loudly rather
        # than leaving the operator to wonder why a Celeron is at 100%.
        log "VA-API: WARNING - no H.264 decode entrypoint. Playback will be software-decoded."
        log "VA-API: run 'vainfo' to see what the driver reports."
      fi
    fi
  fi

  install_chromium
fi

build_release /opt/signage

log "Creating signage user and directories"
if ! id signage > /dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/signage \
    --shell /usr/sbin/nologin signage
fi
usermod -aG video,render,input,tty,audio signage 2> /dev/null || true
mkdir -p /var/lib/signage /etc/signage
chown -R signage:signage /opt/signage /var/lib/signage

log "Writing configuration"
if [ ! -f /etc/signage/agent.env ]; then
  if [ -z "$SERVER_URL" ]; then
    echo "First install needs --server <url>" >&2
    exit 1
  fi
  cat > /etc/signage/agent.env <<EOF
# Signage device agent configuration. Edit with: signage config
SIGNAGE_SERVER_URL=$SERVER_URL
SIGNAGE_PAIRING_CODE=$PAIRING_CODE
SIGNAGE_DATA_DIR=/var/lib/signage
SIGNAGE_PLAYER_PORT=8080
SIGNAGE_PLAYER_UI_DIR=/opt/signage/player-ui
SIGNAGE_SCREENSHOT_CMD=/opt/signage/bin/screenshot.sh
SIGNAGE_UPDATE_CMD=/opt/signage/bin/update.sh
SIGNAGE_ALLOW_REBOOT=true
SIGNAGE_PLAYER_SERVICE=signage-player.service
SIGNAGE_LOG_LEVEL=info
# Optional: release tarball used by the software_update command
#SIGNAGE_UPDATE_URL=https://example.com/releases/signage-device.tar.gz
EOF
  chmod 600 /etc/signage/agent.env
  chown signage:signage /etc/signage/agent.env
else
  log "/etc/signage/agent.env already exists — keeping it"
  if [ -n "$PAIRING_CODE" ]; then
    sed -i "s|^SIGNAGE_PAIRING_CODE=.*|SIGNAGE_PAIRING_CODE=$PAIRING_CODE|" /etc/signage/agent.env
    log "Updated pairing code"
  fi
fi

log "Installing signage CLI"
install -m 755 "$SCRIPT_DIR/signage" /usr/local/bin/signage

log "Granting service-management rights (polkit)"
mkdir -p /etc/polkit-1/rules.d
install -m 644 "$SCRIPT_DIR/50-signage.rules" /etc/polkit-1/rules.d/50-signage.rules
systemctl restart polkit 2> /dev/null || true

if [ "$INSTALL_PLAYER" -eq 1 ]; then
  log "Allowing the signage user to start X on the console"
  cat > /etc/X11/Xwrapper.config <<EOF
allowed_users=anybody
needs_root_rights=yes
EOF

  # NOT configuring TearFree here, deliberately.
  #
  # It is the textbook fix for horizontal shear, but Debian 13's `modesetting`
  # driver does not implement it. Setting it produces exactly one effect:
  #
  #   (WW) modeset(0): Option "TearFree" is not used
  #
  # Measured on an Acer Chromebox CXI3 with glamor on Mesa Intel HD 610. The
  # option that would work lives in xf86-video-intel, which Intel deprecates for
  # Gen9+ and which is a poor bet on a screen that must run unattended for
  # months. See docs/hardware-matrix.md.

fi

log "Installing systemd services"
install -m 644 "$SCRIPT_DIR/signage-agent.service" /etc/systemd/system/signage-agent.service
if [ "$INSTALL_PLAYER" -eq 1 ]; then
  install -m 644 "$SCRIPT_DIR/signage-player.service" /etc/systemd/system/signage-player.service
fi
systemctl daemon-reload
systemctl enable --now signage-agent.service

# A desktop install already owns the console, and the kiosk cannot share it:
# xinit dies with "Server is already active for display 0" and systemd restarts
# it forever. The agent is fine — only the screen is blank — so this is a loud
# warning rather than a failed install, and the operator decides.
#
# Installing from a desktop ISO is the normal case on x86 thin clients (the ARM
# boards are usually flashed with a Lite/server image), so this is checked
# before the player is started rather than left to be discovered in the logs.
DISPLAY_MANAGER=""
if systemctl is-enabled display-manager.service > /dev/null 2>&1 ||
  systemctl is-active display-manager.service > /dev/null 2>&1; then
  DISPLAY_MANAGER="$(basename "$(readlink -f /etc/systemd/system/display-manager.service 2> /dev/null || echo display-manager)" .service)"
fi

if [ "$INSTALL_PLAYER" -eq 1 ]; then
  systemctl enable --now signage-player.service
fi

log "Done."
echo
echo "  Agent:   systemctl status signage-agent"
if [ "$INSTALL_PLAYER" -eq 1 ]; then
  echo "  Player:  systemctl status signage-player"
fi
echo "  CLI:     signage status | signage logs | signage pair <code>"
# Only prompt to pair when the device actually has no credentials. This runs on
# every re-install, and telling an already-paired screen to pair again is both
# wrong and alarming.
if [ -z "$PAIRING_CODE" ] && [ ! -s /var/lib/signage/credentials.json ]; then
  echo
  echo "  No pairing code set yet. Create a screen in the dashboard and run:"
  echo "    signage pair <CODE>"
elif [ -s /var/lib/signage/credentials.json ]; then
  echo "  Paired:  yes (existing credentials kept)"
fi

if [ "$INSTALL_PLAYER" -eq 1 ] && [ -n "$DISPLAY_MANAGER" ]; then
  echo
  echo "  =============================================================="
  echo "  WARNING: a display manager ($DISPLAY_MANAGER) owns the console."
  echo
  echo "  The kiosk cannot start while it is running — X refuses with"
  echo "  'Server is already active for display 0' and the player service"
  echo "  restarts in a loop. The agent is unaffected; the screen stays blank."
  echo
  echo "  To hand the console to the kiosk (this removes the local desktop):"
  echo "    sudo systemctl disable --now display-manager"
  echo "    sudo systemctl set-default multi-user.target"
  echo "    sudo rm -f /tmp/.X0-lock"
  echo "    sudo systemctl restart signage-player"
  echo "  =============================================================="
fi
