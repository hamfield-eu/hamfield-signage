# T016 — Acer Chromebox CXI3 / x86 thin-client player profile

| | |
|---|---|
| **Estimate** | M |
| **Risk** | Medium — GPU flags can crash-loop the Chromium GPU process or produce a black screen with correct audio. All changes must be revertible from `/etc/signage/agent.env` |
| **Depends on** | T015 (do not soak-test a platform whose known hang is unfixed) |
| **Blocks** | Rolling out x86 thin clients as a supported platform |
| **Status** | Not started |

> Self-contained by design: a fresh Claude Code session has no memory of the
> review that produced this file.

---

## Objective

Make x86 Intel thin clients — starting with the Acer Chromebox CXI3 — a
**supported, validated** playback target: hardware-accelerated where possible,
correctly detected, reported back to the dashboard, and proven by a documented
hardware validation checklist and a 72-hour soak.

---

## Context from the review report

### The GPU auto-detection excludes x86 by construction *(F3 / A8 — Critical, CONFIRMED)*

`infra/device/start-player.sh` detects a hardware Vulkan driver via
`vulkaninfo --summary`, filtering out software implementations
(`lavapipe|llvmpipe|software|swiftshader`), then at lines 72–76:

```bash
case "$VK_DRIVER" in
  *v3dv*) GPU_MODE=vulkan ;;   # Raspberry Pi 4/5
  *) GPU_MODE=software ;;      # ODROID C4 and everything else: safe default
esac
```

**Only the Raspberry Pi's V3DV driver maps to an accelerated backend.** Intel's
Vulkan driver (`anv`) and AMD's (`radv`) both fall through to `software`, so
Chromium composites in software on every x86 device. The logic treats "not a Pi"
as "no GPU".

A `gles` mode already exists in the script and is fully implemented — it is
simply never selected by auto-detection.

### There is no video-decode acceleration on *any* platform *(CONFIRMED)*

Neither the `vulkan` nor the `gles` `GPU_FLAGS` block contains a VA-API or
video-decode flag. `--use-angle=vulkan` accelerates **compositing**, not H.264
**decode**. On Linux, Chromium needs the VA-API path explicitly enabled plus a
VA-API driver present.

`infra/device/install.sh` installs `xserver-xorg xinit x11-xserver-utils scrot
file mesa-vulkan-drivers vulkan-tools` — **no VA-API packages at all**
(`intel-media-va-driver`, `i965-va-driver`, `va-driver-all`, `vainfo` are all
absent).

Conclusion: 1080p H.264 is being **software-decoded and software-composited on
the entire fleet today**, ARM and x86 alike. This is the most likely contributor
to the reported ARM playback problems, and it is the biggest single win available
on x86.

### The escape hatch already exists *(good design — build on it)*

`start-player.sh:57-61` documents two overrides read from
`/etc/signage/agent.env`:

- `SIGNAGE_KIOSK_GPU` = `auto` (default) | `vulkan` | `gles` | `software`
- `SIGNAGE_CHROMIUM_EXTRA_FLAGS` = extra space-separated Chromium flags

So the whole flag matrix below can be tested **without a code change**, one
`signage config set` at a time. Use that for the investigation, then encode the
validated result as a profile.

### The dashboard cannot tell you whether acceleration is on *(F20 — CONFIRMED)*

`apps/agent/src/metrics.ts` `collectMetrics` returns app version, OS, arch,
device model, uptime, CPU, memory, disk, cache size, playback position, manifest
version and `lastError`. It does **not** populate `screenWidth`/`screenHeight`
— even though those columns exist in `Device`
(`packages/database/prisma/schema.prisma`) and in the heartbeat schema, so they
are permanently `null`. There is also no Chromium version, no GPU backend, and no
decode path. You cannot answer "is hardware decode working on screen 12?" from
the dashboard.

`readDeviceModel()` reads `/proc/device-tree/model`, which exists on ARM SBCs but
**not on x86** — so `deviceModel` falls back to `${os.type()} ${os.arch()}` at
pairing (`apps/agent/src/main.ts`). x86 needs DMI
(`/sys/class/dmi/id/product_name`, `sys_vendor`).

### Installer assumptions

`infra/device/install.sh` is Debian/apt-only and runs a full `pnpm install` +
workspace build **on the device** (`build_release()`), requiring a repo checkout
and a Node toolchain on every screen. It also handles the Ubuntu Chromium-snap
problem carefully (`chromium_is_native()` correctly distinguishes a snap stub
from the Raspberry Pi OS wrapper script). That logic is good and should be kept.

### Hardware specifics — deliberately not asserted

The review did **not** confirm this unit's CPU, GPU, storage size or firmware
state. A Chromebox generally requires firmware work before it will boot a stock
Linux distribution, but that is unverified for this model. **Record the actual
values from the pre-flight step below rather than assuming them.** Storage size
matters especially: small eMMC makes T017's disk guard urgent.

---

## Files likely involved

- `infra/device/start-player.sh` — driver→mode mapping, VA-API flags, profiles
- `infra/device/install.sh` — `--profile` flag, x86 package set, DMI model read
- `apps/agent/src/metrics.ts` — `readDeviceModel` for x86; new reported fields
- `packages/shared/src/schemas.ts` — heartbeat schema additions
- `packages/database/prisma/schema.prisma` + additive migration — new `Device` columns
- `apps/web/src/pages/DeviceDetail.tsx` — surface GPU/decode/screen info
- `packages/shared/src/enums.ts` — `suggestPlaybackProfile` (extend for x86 models)
- **Create:** `docs/hardware-matrix.md` — validated configurations per model
- `docs/device-install.md` — x86 section

---

## Non-goals

- Prebuilt device packages / removing the on-device build (report B3). Related
  and valuable, but a separate task.
- Supporting Windows or ChromeOS Flex as the device OS.
- The "lite player" (mpv/GStreamer) alternative (report E1).
- AMD or NVIDIA thin clients — design the mapping so they can be added, but
  validate only Intel now.
- Watchdog/recovery — **T015**.
- Disk/cache guards — **T017**. (Note: small eMMC makes T017 a **hard
  prerequisite for production x86 use**, even though it is not a build-order
  dependency here.)

---

## Implementation plan

### 1. Pre-flight: measure the actual unit before changing anything

Run on the Chromebox and **record the output in `docs/hardware-matrix.md`**:

```bash
uname -m; cat /etc/os-release
lscpu | head -20
free -h
lsblk; df -h /var/lib/signage          # eMMC size drives the T017 cache budget
cat /sys/class/dmi/id/sys_vendor /sys/class/dmi/id/product_name
chromium --version || chromium-browser --version
vulkaninfo --summary 2>/dev/null | grep -iE 'driverName|deviceName'
vainfo 2>&1 | head -30                  # likely "command not found" before step 2
xrandr | head
lspci -nn | grep -i vga
```

Do not proceed on assumptions. Every downstream recommendation depends on these
values.

### 2. VA-API packages for the x86 profile

Add to the installer's kiosk package set when the x86 profile is selected:

- `vainfo` — mandatory; it is the diagnostic that decides everything else
- `intel-media-va-driver-non-free` (Gen9+ / `iHD` driver) **or**
  `i965-va-driver` (older Gen). Which one depends on the actual GPU generation
  from step 1 — install the appropriate one, or `va-driver-all` and let libva
  pick.
- `libva2`, `libva-drm2` as needed by the distro packaging
- Keep `mesa-vulkan-drivers` and `vulkan-tools` (already installed) — they now
  serve a purpose on x86 too.

Verification gate: `vainfo` must list an H.264 decode profile
(`VAProfileH264High` / `VAProfileH264Main` with `VAEntrypointVLD`). **If it does
not, stop** — no Chromium flag can create hardware decode that the driver does
not provide.

Note that the `signage` user is already added to the `video` and `render` groups
(`install.sh`: `usermod -aG video,render,input,tty,audio signage`), which VA-API
requires for `/dev/dri/renderD*` access. Verify this holds on the unit.

### 3. Fix the GPU mode mapping

Replace the Pi-only `case` in `start-player.sh` with an explicit mapping:

| Detected Vulkan driver | Mode | Rationale |
|---|---|---|
| `*v3dv*` | `vulkan` | Raspberry Pi 4/5 — current known-good, do not regress it |
| `*anv*` / `intel` | `gles` | Intel; ANGLE-on-GLES is the conservative accelerated path |
| `*radv*` / `amd` | `gles` | Same reasoning; unvalidated, mark as such |
| `lavapipe` / `llvmpipe` / none | `software` | Genuinely no GPU |
| anything else | `software` | Unknown hardware — stay safe, and **log the driver name** so unknown hardware is discoverable from the logs |

Keep `software` as the fallback for unknown drivers, but log loudly enough that
an operator can see *why* a device ended up there. The script already echoes
`kiosk: GPU mode=… (hardware vulkan driver: …)` to stderr — keep and extend that.

### 4. Chromium flag matrix — test in order, one variable at a time

Set via `signage config set SIGNAGE_CHROMIUM_EXTRA_FLAGS "…"` and
`SIGNAGE_KIOSK_GPU`, then `signage restart-player`. **Record the observable at
each step in the hardware matrix document.**

| Step | Change | Observable that decides it |
|---|---|---|
| 0 | Baseline `SIGNAGE_KIOSK_GPU=software` | `chrome://gpu` all "Software only". `top` during 1080p: expect a core near 100% |
| 1 | `SIGNAGE_KIOSK_GPU=gles` | `chrome://gpu`: Canvas + Compositing "Hardware accelerated". No GPU-process crash loop in `signage player-logs` |
| 2 | Install VA-API driver; confirm `vainfo` | H.264 VLD entrypoint listed. **Gate — do not continue without it** |
| 3 | Add `--enable-features=VaapiVideoDecoder,VaapiVideoDecodeLinuxGL` | `chrome://gpu` → "Video Decode: Hardware accelerated". `chrome://media-internals` during playback shows a VA-API/VDA decoder, **not** `FFmpegVideoDecoder`. CPU drops to single digits |
| 4 | If step 3 gives black video with correct timing: try `--disable-features=UseChromeOSDirectVideoDecoder`, or revert to step 1 | Visual |
| 5 | `--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows` | Guards against Chromium throttling the kiosk tab. Low risk; worth keeping regardless of GPU outcome |
| 6 | `--disable-dev-shm-usage` if `/dev/shm` is small | Renderer OOM crashes in `player-logs` |

**Critical caveat:** VA-API feature flag names change between Chromium major
versions. Check the actual build's `chrome://flags` and `--help` rather than
copying flags from a blog post. Record the Chromium version alongside the
validated flag set — a flag set is only valid for the version it was tested on.

### 5. Installer profile

Add `--profile <auto|rpi|odroid|x86-intel>` to `infra/device/install.sh`:

- `auto` (default) — detect from `uname -m` + DMI/device-tree
- `x86-intel` — install VA-API packages, write `SIGNAGE_KIOSK_GPU=gles` and the
  validated `SIGNAGE_CHROMIUM_EXTRA_FLAGS` into `/etc/signage/agent.env`
- `rpi` / `odroid` — preserve today's behaviour exactly; **this must not regress**

The generated `/etc/signage/agent.env` should carry a comment naming the profile
and the date/Chromium version it was validated against, so a future operator
knows whether it is still trustworthy.

### 6. Report the platform back to the dashboard

Extend `collectMetrics` (`apps/agent/src/metrics.ts`) and the heartbeat schema:

- `screenWidth` / `screenHeight` — from `xrandr` (or `/sys/class/drm/*/modes`).
  **These columns already exist and are permanently null today.**
- `chromiumVersion` — `chromium --version`
- `gpuMode` — the resolved `SIGNAGE_KIOSK_GPU` value
- `gpuDriver` — the detected Vulkan/DRM driver name
- `videoDecode` — `hardware` | `software` | `unknown`
- `vaapiProfiles` — a short summary from `vainfo`, or null

For `videoDecode`, prefer a cheap, reliable signal over parsing `chrome://gpu`
(which is not scriptable from outside the browser). Options, in order of
preference: read the resolved config the launcher applied; or have
`start-player.sh` write a small JSON status file at launch that the agent reads.
Deriving it from configuration is honest as long as the field is labelled as
"configured", not "measured" — and step 4's manual verification is what confirms
it once per model.

Also fix `readDeviceModel()` for x86: fall back to
`/sys/class/dmi/id/sys_vendor` + `/sys/class/dmi/id/product_name` when the
device-tree paths are absent. This feeds `suggestPlaybackProfile` and makes the
dashboard show something useful instead of `Linux x64`.

Surface all of it in `apps/web/src/pages/DeviceDetail.tsx`. Schema changes are
additive; follow T011's migration procedure.

### 7. Playback profile for x86

`Device.playbackProfile` defaults to `standard` (1080p30, 6000 kbps —
`packages/media/src/transcode.ts` `VIDEO_TIERS`). If validation shows the
Chromebox handles 1080p60 comfortably with hardware decode, `high` becomes
available — but note the constraint from `apps/worker/src/processor.ts`
`tiersInUse`: **a tier is only encoded if some device already uses it**, so
switching a device to `high` requires running
`apps/api/src/cli/reprocess-media.ts` to backfill. Until then it falls back to
`standard`, which is safe but silent. Document this.

### 8. Hardware validation checklist

Create `docs/hardware-matrix.md` with a per-model section: pre-flight output,
validated `SIGNAGE_KIOSK_GPU` + flags, Chromium version tested, decode path
confirmed, soak result, date, and who validated it. Mark anything unvalidated as
**UNVALIDATED** rather than omitting it.

### 9. 72-hour soak

Run **after** T015's watchdog is in place, so a hang is recorded rather than
silently ending the test.

- Playlist: ≥ 20 items, mixed 1080p H.264 video and large images, spanning all
  fit modes, with at least one schedule boundary crossing per day and one
  content change (media added mid-soak) to exercise sync-under-playback.
- Sample every 5 minutes and log to CSV:
  `chromium` RSS (`ps -o rss=`), agent RSS, CPU, GPU-process count, `df`,
  free memory, journal error count, playback-event count.
- Pass criteria:
  - Zero unrecovered black screens
  - Chromium renderer RSS growth < 10% over 72 h
  - Playback event count within ~2% of the expected item count
  - Zero watchdog escalations beyond rung 1
  - No thermal throttling (`/sys/class/thermal`) and no disk growth beyond the
    expected cache size
- Include the failure-injection tests from the review's Phase 3 test plan:
  power cut ×10, network cut, renderer kill, agent kill.
- **Two of those tests are expected to fail until T017 lands** (corrupt cached
  file; full disk). Run them anyway and record the actual behaviour as the
  baseline T017 must improve on.

---

## Acceptance criteria

- [ ] Pre-flight output for the actual CXI3 recorded in `docs/hardware-matrix.md`.
- [ ] `vainfo` lists an H.264 decode entrypoint on the unit.
- [ ] `chrome://gpu` reports hardware-accelerated compositing **and** video decode.
- [ ] `chrome://media-internals` shows a hardware decoder during 1080p playback,
      not `FFmpegVideoDecoder`.
- [ ] CPU during sustained 1080p30 playback is measurably lower than the software
      baseline, with the before/after numbers recorded.
- [ ] GPU mode auto-detection selects an accelerated backend on Intel and still
      selects `vulkan` on a Raspberry Pi (**no ARM regression**).
- [ ] `install.sh --profile x86-intel` produces a working kiosk on a clean install.
- [ ] Dashboard shows screen resolution, Chromium version, GPU mode, GPU driver
      and decode path for the device. `screenWidth`/`screenHeight` are no longer null.
- [ ] `deviceModel` shows a meaningful x86 identifier from DMI, not `Linux x64`.
- [ ] `docs/hardware-matrix.md` contains a complete, dated, validated entry for
      the Acer Chromebox CXI3 — or explicitly records which steps could not be
      validated and why.
- [ ] 72-hour soak passes all criteria in step 9.
- [ ] Every change is revertible from `/etc/signage/agent.env` without a redeploy.

---

## Testing checklist

- [ ] Each flag-matrix step tested individually, with the observable recorded.
- [ ] Both fit-mode and rotation coverage: contain/cover × 0°/90° × landscape/portrait
      (8 spot-checks minimum), confirming rotation is CSS-only
      (`apps/player/src/main.ts` `applyState` sets `rot-90/180/270` on the stage)
      and that hardware decode still engages when rotated.
- [ ] Portrait mounting: a 16:9 panel turned sideways = `portrait` + 90°.
      Verify against the definition in `docs/architecture.md`.
- [ ] Multi-resolution: 1920×1080 and, if available, a 4K panel (confirm the
      `xrandr` mode detection in `start-player.sh` handles it — it pins `--fb` to
      the detected mode).
- [ ] Reboot ×10 → kiosk comes up every time; measure boot-to-first-frame.
- [ ] GPU-process crash injection (`chrome://crash-gpu` or `pkill -f gpu-process`)
      → confirm recovery, not a crash loop.
- [ ] **Regression: run the full matrix on a Raspberry Pi 4** to prove the
      detection change did not alter its behaviour.
- [ ] Confirm `chromium_is_native()` still behaves correctly on the x86 distro
      (the snap-stub detection logic in `install.sh`).
- [ ] Verify the `signage` user can access `/dev/dri/renderD128`.
- [ ] 72-hour soak with CSV telemetry retained as evidence.

---

## Rollback / safety notes

- **Every GPU change is revertible without a deploy:**
  `signage config set SIGNAGE_KIOSK_GPU software` +
  `signage config set SIGNAGE_CHROMIUM_EXTRA_FLAGS ""` + `signage restart-player`.
  Put this in the runbook (T014) as the first response to any x86 playback
  regression.
- **Do not change the Raspberry Pi path.** It is currently working; the mapping
  change must be purely additive for `*v3dv*`. Regression-test on real Pi hardware.
- VA-API flag names are Chromium-version-specific. Pin the validated Chromium
  version in the hardware matrix, and re-validate after any Chromium upgrade —
  including one that arrives via unattended OS updates. Consider holding the
  Chromium package version on production devices.
- A bad flag can produce a **black screen with everything else apparently
  healthy** — the hardest failure to diagnose remotely, and exactly why step 6's
  reporting matters. Always have physical or SSH access to the first unit.
- Roll out to one device, soak, then a small group, then the fleet — using the
  existing `software_update` flow (`infra/device/update.sh`), which is idempotent
  by sha256 comparison.
- **Do not put x86 units into customer production until T017 ships.** Thin
  clients typically have small internal storage, and the review confirmed there
  is no free-space precheck and no cache cap — a full disk produces a permanently
  failed, non-converging sync.
