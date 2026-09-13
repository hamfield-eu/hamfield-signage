#!/usr/bin/env bash
# Launched by xinit as the X session of the kiosk. Starts Chromium fullscreen
# pointed at the local agent's player server and restarts it if it crashes.
set -u

PLAYER_PORT="${SIGNAGE_PLAYER_PORT:-8080}"
PLAYER_URL="http://127.0.0.1:${PLAYER_PORT}"

# Never blank or power off the screen.
xset s off || true
xset s noblank || true
xset -dpms || true

# Size the kiosk to the connected display's active mode. No window manager runs
# in this kiosk, so nothing auto-maximizes Chromium — we must pass the window
# size explicitly, and some ARM boards come up with an oversized/double-height
# canvas, so we also pin the framebuffer to the visible mode. Detect the active
# mode of the first connected output; fall back to 1080p if detection fails.
SCREEN_W=1920
SCREEN_H=1080
if command -v xrandr > /dev/null 2>&1; then
  OUTPUT="$(xrandr | awk '/ connected/{print $1; exit}')"
  MODE="$(xrandr | awk '/ connected/{c=1; next} c && /\*/{print $1; exit}')"
  if [ -n "$OUTPUT" ] && [ -n "$MODE" ]; then
    xrandr --output "$OUTPUT" --mode "$MODE" --pos 0x0 --fb "$MODE" || true
    SCREEN_W="${MODE%x*}"
    SCREEN_H="${MODE#*x}"
  fi
fi

# Find a Chromium binary (name differs across distros). Prefer the real
# `chromium` over `chromium-browser`, which on Ubuntu is a snap stub that
# cannot run under this systemd service.
CHROMIUM=""
for candidate in chromium chromium-browser google-chrome; do
  if command -v "$candidate" > /dev/null 2>&1; then
    CHROMIUM="$candidate"
    break
  fi
done
if [ -z "$CHROMIUM" ]; then
  echo "No Chromium binary found — install chromium or chromium-browser" >&2
  exit 1
fi

# --- GPU backend selection ---------------------------------------------------
# Chromium's GPU stack is fragile and board-specific on ARM SBCs, so we pick a
# backend per board instead of forcing one everywhere:
#   * Raspberry Pi (V3D / V3DV driver): ANGLE-on-Vulkan initialises cleanly and
#     removes the screen tearing you otherwise get from software compositing.
#   * ODROID C4 (Mali) and any board without a usable Vulkan driver: stay on
#     Chromium's default software compositing — slower, but it always renders
#     and never crash-loops the GPU process.
# Auto-detection can be overridden per device in /etc/signage/agent.env:
#   SIGNAGE_KIOSK_GPU            = auto (default) | vulkan | gles | software
#   SIGNAGE_CHROMIUM_EXTRA_FLAGS = extra space-separated chromium flags
GPU_MODE="${SIGNAGE_KIOSK_GPU:-auto}"

# Echoes the lowercase name of a hardware (non-software) Vulkan driver, if any.
# lavapipe/llvmpipe are CPU implementations and give us nothing over software
# compositing, so they don't count.
hardware_vulkan_driver() {
  command -v vulkaninfo > /dev/null 2>&1 || return 1
  vulkaninfo --summary 2> /dev/null \
    | awk -F= '/driverName/ { gsub(/[ \t]/, "", $2); print tolower($2) }' \
    | grep -viE 'lavapipe|llvmpipe|software|swiftshader' \
    | head -1
}

VK_DRIVER=""
if [ "$GPU_MODE" = auto ]; then
  VK_DRIVER="$(hardware_vulkan_driver || true)"
  # Map the detected driver to a backend. Before this, only the Pi's V3DV
  # mapped to anything accelerated and EVERY other board — including every
  # Intel and AMD thin client — fell through to `software`. The logic treated
  # "not a Pi" as "no GPU", so x86 composited in software by construction.
  case "$VK_DRIVER" in
    *v3dv*) GPU_MODE=vulkan ;;         # Raspberry Pi 4/5 — known good, unchanged
    *anv* | *intel*) GPU_MODE=gles ;;  # Intel: ANGLE-on-GLES, the conservative path
    *radv* | *amd*) GPU_MODE=gles ;;   # AMD: same reasoning. UNVALIDATED — no unit tested
    *) GPU_MODE=software ;;            # Genuinely no GPU, or hardware we don't know
  esac
fi

GPU_FLAGS=()
case "$GPU_MODE" in
  vulkan)
    GPU_FLAGS=(
      --ignore-gpu-blocklist
      --enable-gpu-rasterization
      --enable-zero-copy
      --use-gl=angle
      --use-angle=vulkan
      --enable-features=Vulkan
    )
    ;;
  gles)
    GPU_FLAGS=(
      --ignore-gpu-blocklist
      --enable-gpu-rasterization
      --enable-zero-copy
      --use-gl=angle
      --use-angle=gles
    )
    ;;
  *)
    # software / off / unknown: do not force a GPU path; Chromium composites in
    # software, which renders on every board.
    GPU_FLAGS=()
    ;;
esac

# Optional admin-supplied extra flags (space-separated).
EXTRA_FLAGS=()
if [ -n "${SIGNAGE_CHROMIUM_EXTRA_FLAGS:-}" ]; then
  # shellcheck disable=SC2206
  EXTRA_FLAGS=(${SIGNAGE_CHROMIUM_EXTRA_FLAGS})
fi

# Log the driver name even when we fall back, so a device that ended up on
# software compositing because its hardware is unrecognised is discoverable from
# `signage player-logs` rather than silently slow.
if [ "$GPU_MODE" = software ] && [ -n "$VK_DRIVER" ]; then
  echo "kiosk: GPU mode=software — unrecognised hardware vulkan driver '${VK_DRIVER}'." >&2
  echo "kiosk: add it to the driver map in start-player.sh, or force a mode with" >&2
  echo "kiosk:   signage config set SIGNAGE_KIOSK_GPU gles" >&2
else
  echo "kiosk: GPU mode=${GPU_MODE} (hardware vulkan driver: ${VK_DRIVER:-none})" >&2
fi

PROFILE_DIR=/var/lib/signage/chromium-profile
mkdir -p "$PROFILE_DIR"

# Chromium shows a "restore pages?" bubble after a crash; clear the flag.
sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' "$PROFILE_DIR/Default/Preferences" 2> /dev/null || true
sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/' "$PROFILE_DIR/Default/Preferences" 2> /dev/null || true

# Keep relaunching the browser while the X session is alive; systemd
# restarts the whole unit if X itself dies.
while true; do
  "$CHROMIUM" \
    --kiosk "$PLAYER_URL" \
    "${GPU_FLAGS[@]}" \
    "${EXTRA_FLAGS[@]}" \
    --window-position=0,0 \
    --window-size="${SCREEN_W},${SCREEN_H}" \
    --force-device-scale-factor=1 \
    --user-data-dir="$PROFILE_DIR" \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-features=TranslateUI \
    --disable-pinch \
    --overscroll-history-navigation=0 \
    --autoplay-policy=no-user-gesture-required \
    --check-for-update-interval=31536000 \
    --no-first-run \
    --start-fullscreen
  sleep 2
done
