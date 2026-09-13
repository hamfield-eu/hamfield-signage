#!/usr/bin/env bash
# Signage device pre-flight: record what a candidate device actually is, before
# anything is installed or configured on it.
#
#   sudo ./infra/device/preflight.sh                 # human-readable report
#   sudo ./infra/device/preflight.sh --matrix        # block to paste into the matrix
#
# Every downstream decision for a new platform depends on these values — which
# VA-API driver to install, whether hardware decode is even possible, what the
# cache budget may be — so they are measured rather than assumed. Paste the
# output into docs/hardware-matrix.md under the model's section.
#
# Runs on a BARE Debian box. Nothing here is installed by this script, and every
# probe is optional: a missing tool reports `absent` instead of failing, because
# the most useful time to run this is before install.sh has added anything.
#
# Safe to run repeatedly. Reads only; changes nothing.
set -u

MATRIX_ONLY=0
[ "${1:-}" = "--matrix" ] && MATRIX_ONLY=1

have() { command -v "$1" > /dev/null 2>&1; }

# Reads a sysfs/procfs file, trimming the NUL padding device-tree nodes carry.
slurp() {
  [ -r "$1" ] || return 1
  tr -d '\0' < "$1" | head -1 | sed 's/[[:space:]]*$//'
}

section() {
  [ "$MATRIX_ONLY" -eq 1 ] && return 0
  printf '\n=== %s ===\n' "$1"
}

# ---------------------------------------------------------------- identity

ARCH="$(uname -m)"
KERNEL="$(uname -r)"
OS_NAME="$(. /etc/os-release 2> /dev/null && echo "${PRETTY_NAME:-unknown}")"

# x86 exposes the model over DMI; ARM SBCs over the device tree. Try both, in
# that order, so one script covers a Chromebox and a Raspberry Pi.
DMI_VENDOR="$(slurp /sys/class/dmi/id/sys_vendor || echo '')"
DMI_PRODUCT="$(slurp /sys/class/dmi/id/product_name || echo '')"
DT_MODEL="$(slurp /proc/device-tree/model || slurp /sys/firmware/devicetree/base/model || echo '')"
if [ -n "$DT_MODEL" ]; then
  MODEL="$DT_MODEL"
elif [ -n "$DMI_VENDOR$DMI_PRODUCT" ]; then
  MODEL="$(echo "$DMI_VENDOR $DMI_PRODUCT" | sed 's/^ *//;s/ *$//')"
else
  MODEL="unknown"
fi

BIOS_VENDOR="$(slurp /sys/class/dmi/id/bios_vendor || echo 'absent')"
BIOS_VERSION="$(slurp /sys/class/dmi/id/bios_version || echo 'absent')"

section "Identity"
if [ "$MATRIX_ONLY" -eq 0 ]; then
  echo "model:        $MODEL"
  echo "arch:         $ARCH"
  echo "os:           $OS_NAME"
  echo "kernel:       $KERNEL"
  # Firmware matters on a Chromebox: a stock unit needs replacement firmware
  # before it boots a general-purpose Linux distribution at all, so recording
  # what is on there is part of knowing whether the unit is reproducible.
  echo "bios:         $BIOS_VENDOR $BIOS_VERSION"
fi

# --------------------------------------------------------------------- cpu

CPU_MODEL="$(awk -F: '/model name/ {gsub(/^ /,"",$2); print $2; exit}' /proc/cpuinfo 2> /dev/null || echo unknown)"
[ -z "$CPU_MODEL" ] && CPU_MODEL="$(awk -F: '/Hardware|Model/ {gsub(/^ /,"",$2); print $2; exit}' /proc/cpuinfo 2> /dev/null || echo unknown)"
CPU_CORES="$(nproc 2> /dev/null || echo '?')"
MEM_TOTAL="$(awk '/MemTotal/ {printf "%.1f GB", $2/1024/1024}' /proc/meminfo 2> /dev/null || echo '?')"

section "CPU and memory"
if [ "$MATRIX_ONLY" -eq 0 ]; then
  echo "cpu:          $CPU_MODEL"
  echo "cores:        $CPU_CORES"
  echo "memory:       $MEM_TOTAL"
fi

# ----------------------------------------------------------------- storage
#
# The data directory's filesystem is what the cache budget is computed against
# (T017). Small eMMC is the norm on thin clients and is the whole reason the
# disk guard exists, so this is recorded even before the agent is installed.

DATA_DIR="${SIGNAGE_DATA_DIR:-/var/lib/signage}"
PROBE_DIR="$DATA_DIR"
[ -d "$PROBE_DIR" ] || PROBE_DIR=/var
DISK_TOTAL="$(df -h --output=size "$PROBE_DIR" 2> /dev/null | tail -1 | tr -d ' ' || echo '?')"
DISK_AVAIL="$(df -h --output=avail "$PROBE_DIR" 2> /dev/null | tail -1 | tr -d ' ' || echo '?')"
ROOT_DEV="$(findmnt -no SOURCE --target "$PROBE_DIR" 2> /dev/null || echo '?')"

section "Storage"
if [ "$MATRIX_ONLY" -eq 0 ]; then
  echo "probed path:  $PROBE_DIR ($ROOT_DEV)"
  echo "size:         $DISK_TOTAL total, $DISK_AVAIL available"
  have lsblk && lsblk -o NAME,SIZE,TYPE,MOUNTPOINT 2> /dev/null | head -15
fi

# --------------------------------------------------------------------- gpu

GPU_PCI="absent"
if have lspci; then
  GPU_PCI="$(lspci -nn 2> /dev/null | grep -iE 'vga|display|3d' | head -2 | sed 's/^/              /' | sed 's/^ *//' | paste -sd'; ' - || echo 'none found')"
fi

DRM_DRIVERS="absent"
if [ -d /sys/class/drm ]; then
  DRM_DRIVERS="$(for c in /sys/class/drm/card[0-9]; do
    [ -e "$c/device/driver" ] && basename "$(readlink -f "$c/device/driver")"
  done 2> /dev/null | sort -u | paste -sd',' - )"
  [ -z "$DRM_DRIVERS" ] && DRM_DRIVERS="none"
fi

# vulkaninfo arrives with install.sh (vulkan-tools); absent on a bare box.
VK_DRIVER="absent (vulkan-tools not installed)"
if have vulkaninfo; then
  VK_DRIVER="$(vulkaninfo --summary 2> /dev/null \
    | awk -F= '/driverName/ {gsub(/[ \t]/,"",$2); print tolower($2)}' \
    | head -2 | paste -sd',' -)"
  [ -z "$VK_DRIVER" ] && VK_DRIVER="none reported"
fi

section "GPU"
if [ "$MATRIX_ONLY" -eq 0 ]; then
  echo "pci:          $GPU_PCI"
  echo "drm driver:   $DRM_DRIVERS"
  echo "vulkan:       $VK_DRIVER"
  RENDER_NODES="$(ls /dev/dri/renderD* 2> /dev/null | paste -sd',' -)"
  # VA-API needs one of these and needs the signage user in the `render` group.
  echo "render nodes: ${RENDER_NODES:-absent}"
fi

# ------------------------------------------------------------------- vaapi
#
# The gate for hardware video decode. If no H.264 VLD entrypoint is listed here
# after installing a driver, no Chromium flag can create one.

VAAPI="absent (vainfo not installed)"
VAAPI_H264="unknown"
if have vainfo; then
  VA_OUT="$(vainfo 2>&1 || true)"
  VAAPI="$(echo "$VA_OUT" | grep -iE 'vainfo: Driver version|Driver version' | head -1 | sed 's/^ *//')"
  [ -z "$VAAPI" ] && VAAPI="present, no driver version line"
  if echo "$VA_OUT" | grep -qE 'VAProfileH264(High|Main|ConstrainedBaseline).*VAEntrypointVLD'; then
    VAAPI_H264="YES — hardware H.264 decode available"
  else
    VAAPI_H264="NO — no H.264 VLD entrypoint"
  fi
fi

section "VA-API (hardware video decode)"
if [ "$MATRIX_ONLY" -eq 0 ]; then
  echo "driver:       $VAAPI"
  echo "h264 decode:  $VAAPI_H264"
  if have vainfo; then
    vainfo 2>&1 | grep -E 'VAProfileH264|VAProfileHEVC' | sed 's/^/              /' | head -12
  fi
fi

# ---------------------------------------------------------------- chromium
#
# The flag set for hardware decode is only valid for the Chromium major version
# it was tested against — the VA-API feature flag names have changed between
# releases. Recording the version is what makes a validated flag set traceable.

CHROMIUM_BIN="absent"
CHROMIUM_VER="absent"
for candidate in chromium chromium-browser google-chrome; do
  if have "$candidate"; then
    CHROMIUM_BIN="$candidate"
    CHROMIUM_VER="$("$candidate" --version 2> /dev/null | head -1 || echo 'present, version unreadable')"
    break
  fi
done

section "Chromium"
if [ "$MATRIX_ONLY" -eq 0 ]; then
  echo "binary:       $CHROMIUM_BIN"
  echo "version:      $CHROMIUM_VER"
fi

# ------------------------------------------------------------------ display

DISPLAY_MODE="absent (xrandr needs a running X session)"
if have xrandr && [ -n "${DISPLAY:-}" ]; then
  DISPLAY_MODE="$(xrandr 2> /dev/null | awk '/ connected/{c=1; out=$1; next} c && /\*/{print out" "$1; exit}')"
  [ -z "$DISPLAY_MODE" ] && DISPLAY_MODE="no active mode detected"
elif [ -d /sys/class/drm ]; then
  # Works without X: the kernel knows the connected mode.
  DISPLAY_MODE="$(for c in /sys/class/drm/card*-*; do
    [ -r "$c/status" ] && [ "$(cat "$c/status")" = connected ] &&
      echo "$(basename "$c") $(head -1 "$c/modes" 2> /dev/null || echo '?')"
  done 2> /dev/null | head -2 | paste -sd'; ' -)"
  [ -z "$DISPLAY_MODE" ] && DISPLAY_MODE="no connected output"
fi

section "Display"
[ "$MATRIX_ONLY" -eq 0 ] && echo "active mode:  $DISPLAY_MODE"

# ------------------------------------------------------------ matrix block

cat << EOF

--- paste into docs/hardware-matrix.md ---
| Field | Value |
| --- | --- |
| Model | \`$MODEL\` |
| DMI vendor / product | \`${DMI_VENDOR:-–}\` / \`${DMI_PRODUCT:-–}\` |
| Firmware | \`$BIOS_VENDOR $BIOS_VERSION\` |
| Arch / kernel | \`$ARCH\` / \`$KERNEL\` |
| OS | \`$OS_NAME\` |
| CPU / cores / RAM | \`$CPU_MODEL\` / $CPU_CORES / $MEM_TOTAL |
| Storage (\`$PROBE_DIR\`) | $DISK_TOTAL total, $DISK_AVAIL free (\`$ROOT_DEV\`) |
| GPU (PCI) | \`$GPU_PCI\` |
| DRM driver | \`$DRM_DRIVERS\` |
| Vulkan driver | \`$VK_DRIVER\` |
| VA-API driver | \`$VAAPI\` |
| H.264 decode | $VAAPI_H264 |
| Chromium | \`$CHROMIUM_VER\` |
| Display | \`$DISPLAY_MODE\` |
| Preflight date | $(date -u +%Y-%m-%d) |
--- end ---
EOF
