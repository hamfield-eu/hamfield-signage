# Hardware matrix

Validated playback configurations, one section per model. A configuration is
only trustworthy for the model **and the Chromium version** it was tested
against — VA-API feature flag names have changed between Chromium releases, so a
flag set copied to a newer build is an assumption, not a validated result.

Anything not actually measured is marked **UNVALIDATED**. That is deliberate:
an omitted row reads as "fine", and an operator at 2am cannot tell the
difference between "we tested this" and "nobody looked".

## How to add a model

```bash
# On the device, before installing anything:
./infra/device/preflight.sh   # no sudo needed
```

It degrades gracefully on a bare Debian box — `vulkaninfo`, `vainfo` and
Chromium are all absent until `install.sh` runs, and it reports them as `absent`
rather than failing. Paste its `--- paste into docs/hardware-matrix.md ---`
block into a new section below, then work through the flag matrix in
[T016](tasks/T016-chromebox-x86-player-profile.md) step 4 and record what each
step actually showed.

## Status summary

| Model                | Arch   | Compositing    | H.264 decode                  | Soak | Status             |
| -------------------- | ------ | -------------- | ----------------------------- | ---- | ------------------ |
| Raspberry Pi 4/5     | ARM64  | Vulkan         | software                      | —    | In production      |
| ODROID-C4            | ARM64  | software       | software                      | —    | In production      |
| Acer Chromebox CXI3  | x86-64 | **hardware** ✓ | software (no VA-API in build) | —    | Validated, no soak |
| Asus Chromebox CN62  | x86-64 | **hardware** ✓ | software (no VA-API in build) | —    | Installed, unpaired |

> **Fleet-wide, as of 2026-09-13: nothing has hardware video decode.** No VA-API
> packages are installed by `install.sh` on any platform, and neither the
> `vulkan` nor the `gles` flag block contains a video-decode flag —
> `--use-angle=vulkan` accelerates compositing, not H.264 decode. This is
> established from reading `infra/device/install.sh` and `start-player.sh`; it
> has **not** been measured on a running ARM device. Confirm with `vainfo` and
> `chrome://gpu` before treating it as a validated finding for the Pi rows.

---

## Raspberry Pi 4/5

| Field               | Value                                                                 |
| ------------------- | --------------------------------------------------------------------- |
| Vulkan driver       | `v3dv`                                                                |
| `SIGNAGE_KIOSK_GPU` | `auto` → `vulkan`                                                     |
| Compositing         | ANGLE-on-Vulkan. Removes the tearing software compositing produces    |
| Video decode        | software (**UNVALIDATED** — inferred from the absent VA-API packages) |
| Preflight           | not recorded — predates `preflight.sh`                                |

The V3DV mapping is the original known-good path and is deliberately the first
arm of the driver `case` in `start-player.sh`. **Do not regress it.**

## ODROID-C4

| Field               | Value                                                                       |
| ------------------- | --------------------------------------------------------------------------- |
| Vulkan driver       | none usable (Mali)                                                          |
| `SIGNAGE_KIOSK_GPU` | `auto` → `software`                                                         |
| Compositing         | software. Always renders, never crash-loops the GPU process; expect tearing |
| Video decode        | software (**UNVALIDATED**, as above)                                        |
| Preflight           | not recorded — predates `preflight.sh`                                      |

## Acer Chromebox CXI3 (`hamfield-signage-1`)

**Validated 2026-09-13: hardware compositing works, hardware decode is not
available on this Chromium build.** No soak has run.

| Field                | Value                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------- |
| DMI vendor / product | `Google` / `Sion` (version `1.0`)                                                      |
| Firmware             | `coreboot MrChromebox-2606.1` — already reflashed                                      |
| Arch / kernel        | `x86_64` / `6.12.107+deb13-amd64`                                                      |
| OS                   | Debian GNU/Linux 13 (trixie)                                                           |
| CPU                  | Intel Celeron 3867U @ 1.80 GHz, **2 cores** (Kaby Lake)                                |
| RAM                  | **3.7 GB**                                                                             |
| Storage              | 29.8 GB total; `/` is 27.3 GB with 21 GB free                                          |
| GPU                  | Intel HD Graphics 610 `[8086:5906]` rev 07 (Gen9.5, GT1)                               |
| DRM driver           | `i915`, render node `/dev/dri/renderD128` present                                      |
| Display              | HDMI-A-1 at 1920x1080                                                                  |
| Wireless             | Intel Wireless 7265 `[8086:095a]`, `iwlwifi`/`iwlmvm` — **untested on a real network** |
| Ethernet             | Realtek `r8169` (used for the bring-up session)                                        |
| Vulkan driver        | `Intel open-source Mesa driver` (ANV) — **confirmed on device**                        |
| VA-API driver        | iHD 25.2.3 (`intel-media-va-driver`), VA-API 1.22 — **installed**                      |
| H.264 decode         | Available to the driver: High/Main/ConstrainedBaseline + VLD                           |
| Chromium             | 152.0.7977.82 (Debian trixie)                                                          |
| Validated flags      | none — `SIGNAGE_CHROMIUM_EXTRA_FLAGS` unset                                            |
| Soak                 | not run                                                                                |

### What the numbers decide

- **`intel-media-va-driver` (iHD) is the right driver.** Device `8086:5906` is
  Kaby Lake GT1 — Gen9.5, which iHD supports. It is in Debian **main**, so no
  `non-free` component is needed; the `-non-free` variant only adds codecs that
  are not relevant to H.264 decode. `i965-va-driver` is the fallback if iHD
  misbehaves on this generation.
- **`auto` resolves to `angle` — confirmed on the device.** `player-logs`
  reports the mode with `hardware vulkan driver: intelopen-sourcemesadriver`.
  Mesa reports its Vulkan driver as "Intel open-source Mesa driver" rather than
  the bare `anv` string, which the `*intel*` arm of the map catches. Before the
  T016 mapping fix this unit would have landed on `software`.
- **`standard` is the playback tier, not `high`.** Two 1.8 GHz Celeron cores and
  a GT1 iGPU: 1080p30 with hardware decode is comfortable, 1080p60 at 9000 kbps
  is not. `suggestPlaybackProfile` recognises `Sion` explicitly for this reason.
- **The default 8 GB cache budget fits.** 21 GB free against a 27.3 GB
  filesystem: the 70% disk cap works out to ~19 GB, so the configured 8 GB is
  what applies, leaving comfortable headroom. No `SIGNAGE_MAX_CACHE_GB` override
  needed.
- **3.7 GB RAM is the tightest number here.** Chromium plus X on 4 GB is the
  constraint to watch during the soak, and `--disable-dev-shm-usage` is the
  documented mitigation if renderer OOM crashes appear in `player-logs`.

### Measured results (Chromium 152.0.7977.82, 1080p30 H.264)

| Configuration                    | GPU render (RCS) | GPU video (VCS) | CPU idle (2 cores) |
| -------------------------------- | ---------------- | --------------- | ------------------ |
| `--use-angle=gles` (initial)     | 0.00%            | 0.00%           | ~30%               |
| `--use-angle=gl` (**validated**) | ~17%             | 0.00%           | **~57%**           |

**Validated configuration:** `SIGNAGE_KIOSK_GPU=auto` (resolves to `angle`),
`SIGNAGE_CHROMIUM_EXTRA_FLAGS` unset. Nothing else is needed — the fix is in
`start-player.sh`, not in per-device config.

Hardware compositing roughly halved CPU load and visibly smoothed playback.
`--use-angle=gles` was worse than doing nothing at all: Chromium rejected it and
set `--use-gl=disabled` internally, so the GPU sat in RC6 at 100% while the GPU
process software-composited on the CPU.

### Hardware video decode: NOT AVAILABLE — validated negative

The GPU can do it and the driver exposes it (iHD reports H.264 High/Main/CB with
`VAEntrypointVLD`), but **Debian 13's Chromium 152 is compiled without VA-API**:

```bash
strings -a /usr/lib/chromium/chromium | grep -ci vaapi   # → 0
```

Confirmed from two directions: the binary contains no VA-API symbols at all, and
`--enable-features=VaapiVideoDecoder,VaapiVideoDecodeLinuxGL` with `--v=1`
logging produced no VA-API log lines whatsoever. `iHD_drv_video.so` does get
mapped into the GPU process, but that is libva arriving through the media stack,
not Chromium's decoder — it is misleading evidence and cost time here.

**No Chromium flag can fix this.** The options, none of them taken yet, are a
Chromium build with `use_vaapi=true`, or accepting software decode.

**Software decode is survivable on this unit**, which is why it is not a
blocker: with hardware compositing the box still idles ~57% at 1080p30. Before
the compositing fix the two problems together left only ~30% idle, which would
not have been.

### Open

- **Tearing — no fix available, tested.** Largely resolved by moving compositing
  to the GPU; a faint residual artifact remains during motion. `TearFree` was
  tried and **does not work**: Debian 13's `modesetting` driver does not
  implement the option and logs `(WW) modeset(0): Option "TearFree" is not
used`. The driver that does implement it (`xf86-video-intel`) is deprecated by
  Intel for Gen9+ and was not pursued for an unattended screen. The residual
  artifact may not be tearing at all — 30 fps content on a 60 Hz panel, or
  software decode missing an occasional deadline on a 1.8 GHz core, would both
  look similar and neither is fixable in X.
- **72-hour soak.** Not run. 3.7 GB RAM is the number to watch.
- **Wi-Fi.** This unit deploys to a site where Ethernet cannot reach the screen,
  so Wi-Fi is the production configuration and the soak must run on it — testing
  on Ethernet would validate something that will never ship. The 7265 is
  in-tree Intel hardware and should behave far better than the ODROID's
  out-of-tree parts, but that is an expectation, not a measurement. Disable
  `iwlwifi` power saving first; see the Wi-Fi section of
  [device-install.md](device-install.md). Record signal strength **at the mount
  position**, whether the link survives an AP reboot, and whether any sync
  failed.

## Asus Chromebox CN62 (`hamfield-signage-2`)

**Preflight and install 2026-09-14. Agent and player both running; hardware
compositing confirmed.** The unit is **not yet paired** and is still on Ethernet,
so nothing has played: no CPU/GPU load figures, no soak. Wi-Fi is the production
configuration for this screen and is not configured yet.

| Field                | Value                                                                            |
| -------------------- | -------------------------------------------------------------------------------- |
| Model                | `GOOGLE Guado` — Asus Chromebox CN62                                             |
| DMI vendor / product | `GOOGLE` / `Guado`                                                               |
| Firmware             | `coreboot MrChromebox-2606.1` — already reflashed                                |
| Arch / kernel        | `x86_64` / `6.12.107+deb13-amd64`                                                |
| OS                   | Debian GNU/Linux 13 (trixie)                                                     |
| CPU                  | Intel Celeron 3215U @ 1.70 GHz, **2 cores** (Broadwell)                          |
| RAM                  | 5.7 GB                                                                           |
| Storage              | 13.0 GB total; **7.5 GB free** (7.3 before install → 5.8 after → 7.5 after purging GNOME) |
| GPU                  | Intel HD Graphics `[8086:1606]` rev 09 (**Gen8**, Broadwell GT1)                 |
| DRM driver           | `i915`, render node `/dev/dri/renderD128` present                                |
| Display              | HDMI-A-1 at 1920x1080                                                            |
| Vulkan driver        | `Intel open-source Mesa driver` (ANV), Mesa 25.0.7 — `Intel(R) HD Graphics (BDW GT1)` |
| VA-API driver        | **iHD 25.2.3** (`intel-media-va-driver`), VA-API 1.22 — selected on Gen8        |
| H.264 decode         | Driver offers High/Main/ConstrainedBaseline + VLD; **Chromium cannot use it** (0 VA-API symbols, measured on this box) |
| `SIGNAGE_KIOSK_GPU`  | `auto` → **`angle`**, confirmed in `player-logs` *and* in the live GPU process  |
| Compositing          | **ANGLE on native GL — hardware, verified**                                     |
| Chromium             | 152.0.7977.82 (Debian trixie) — `/usr/bin/chromium`, native (Debian wrapper script, not a snap stub) |
| Network              | **not recorded** — preflight does not probe it; bring-up ran over the LAN        |
| Validated flags      | **none — flag matrix not run**                                                   |
| Soak                 | not run                                                                          |

### What the numbers decide

- **Storage is the binding constraint on this unit, and the default cache budget
  does not fit it.** See the arithmetic below. This is the one field that must
  be configured before the device is put in front of content; everything else
  can wait for the flag matrix.
- **iHD is the driver on Gen8 too — measured, and not what was predicted.**
  Device `8086:1606` is Broadwell GT1, a generation below the CXI3's Kaby Lake
  `8086:5906`, so `i965-va-driver` was the expected selection. It is not what
  happens: libva loads `iHD_drv_video.so` and iHD 25.2.3 reports
  H264 High/Main/ConstrainedBaseline with `VAEntrypointVLD`, exactly as on the
  CXI3. The installer's own claim that iHD "covers Gen8 onwards" holds on this
  part. Both drivers are installed and libva picks per device, so nothing needs
  configuring — but the CXI3's Gen9.5-specific reasoning should not be read as
  applying here by inheritance; this row is its own measurement.
- **It is moot for playback anyway, for the same reason as the CXI3.** Debian
  13's Chromium is built without VA-API, so no VA-API driver on any generation
  produces hardware decode. Expect software decode on this unit.
- **The playback tier is NOT yet decided.** `suggestPlaybackProfile` has no
  `guado` entry and falls through to the `standard` default, so no code change
  is needed for the device to get a sane tier. But `standard` is a fall-through
  here, not a measurement: this CPU is slower than the CXI3's 3867U and decode
  will be software, and the CXI3 only cleared `standard` at ~57% idle *with*
  hardware compositing. If the measurement pass lands materially worse, `light`
  is the honest tier and `guado` gets an explicit entry in
  `packages/shared/src/enums.ts` alongside `sion`.
- **`auto` resolves to `angle`, and Chromium actually used it — both checked.**
  `player-logs` reports `kiosk: GPU mode=angle (hardware vulkan driver:
  intelopen-sourcemesadriver)`, and the live GPU process carries `use-gl=angle`
  rather than the `use-gl=disabled` that the CXI3's `gles` attempt silently fell
  back to. The request and the outcome agree, which is the pair that has to be
  checked separately. Player stable at 0 restarts.
- **Software decode is confirmed on this unit, not inherited.** `strings -a
  /usr/lib/chromium/chromium | grep -ci vaapi` → **0** on this box, same as the
  CXI3. Same Debian Chromium 152.0.7977.82 build, same conclusion, but measured
  here rather than assumed from the other unit.
- **RAM is not the worry on this unit.** 5.7 GB against the CXI3's 3.7 GB, so
  the CXI3 section's "3.7 GB is the tightest number here" does not apply and
  `--disable-dev-shm-usage` is not expected to be needed.

### Storage: the default budget is unreachable

Measured: **13,934,841,856 B total, 7,820,902,400 B available**, with 5.4 GB
already used by a bare Debian install and nothing of ours on the disk yet.

`effectiveCacheBudgetBytes` resolves to **8 GiB**: the configured
`DEFAULT_MAX_CACHE_SIZE_GB` of 8, capped at `MAX_CACHE_DISK_FRACTION` × total =
0.7 × 12.98 GiB = 9.08 GiB. The cap does not bite, so the full 8 GiB stands —
**more than the 7.3 GB the disk actually has free.**

`planStorage` then applies two *independent* ceilings, and they are not the same
number:

| Ceiling                                             | Value on this unit                          |
| --------------------------------------------------- | ------------------------------------------- |
| Whole manifest ≤ cache budget                       | 8.00 GiB                                    |
| Delta to download ≤ free disk − 500 MB headroom     | **6.80 GiB** today, less after `install.sh` |

`requiredBytes` is `bytesToDownload(diff)` — the delta, not the manifest
(`apps/agent/src/sync.ts:376`) — and `reclaimableBytes` is deliberately not
counted as available, because downloads land before the stale files are deleted.

Two consequences:

1. **A playlist between 6.8 and 8 GiB passes the budget check and fails the disk
   check.** The device reports `insufficient_storage` and keeps playing what it
   has, which is T017 working correctly — but the budget is advertising space
   the device cannot use.
2. **A wholesale content swap needs old + new on disk at once.** With free space
   `F` and budget `B`, a full swap requires `F − B ≥ B + 0.5 GiB`, i.e.
   `B ≤ (F − 0.5) / 2`. `install.sh` will consume some of the 7.3 GB for X,
   Chromium and the VA-API packages, so `F` is likely ~6 GiB afterwards, putting
   the always-swappable budget near **3 GiB**.

**Do not finalise the override from these numbers** — measure free space again
after `install.sh` and set it then:

```bash
# After install.sh, on the device:
df -B1 /var/lib/signage
signage config set SIGNAGE_MAX_CACHE_GB 3     # full swaps always fit
# or
signage config set SIGNAGE_MAX_CACHE_GB 5     # more cache; a wholesale swap
                                              # can be refused until it is split
```

The 3 GiB option keeps every swap workable. The 5 GiB option holds more content
and accepts that replacing an entire large playlist in one step may be refused —
which fails safe (the screen carries on) but needs an operator to notice.

### Open

- **Cache budget override — required, not yet set.** As above, after
  `install.sh`.
- **`MAX_CACHE_DISK_FRACTION` is applied to total, not free, disk.** On a 13 GB
  disk with 5.4 GB already spent on the OS it computes a 9.08 GiB cap and
  protects nothing — the configured 8 GiB passes through unchanged and exceeds
  free space. The CXI3 (21 GB free of 27.3 GB) never exposed this. Worth a T017
  follow-up; deliberately **not** changed as part of this unit's bring-up.
- **RESOLVED — `gdm3` owned the console and the player crash-looped.** This box
  was installed from a Debian **desktop** image (GNOME + `gdm3`, default target
  `graphical.target`), not the Lite/netinst image
  [device-install.md](device-install.md) calls for. `xinit` exited 1 within
  ~25 ms on a 5 s restart loop. `install.sh` detects and warns about exactly
  this; it was not an installer bug. Fixed with `systemctl set-default
  multi-user.target` + `systemctl disable --now gdm.service`. **Expect this on
  any x86 thin client imaged from a desktop ISO** — it is the second-most likely
  thing to go wrong on a new Chromebox after the GPU flags.
- **RESOLVED — GNOME purged, ~1.7 GB reclaimed** (5.8 GB → 7.5 GB free). Note
  for the next unit: `sudo`, `openssh-server`, `network-manager`, `wpasupplicant`,
  `iw` and `polkitd` were all **auto-marked**, pulled in as dependencies of the
  desktop task. A plain `apt-get autoremove --purge` after dropping the task
  metapackages would have removed remote access, networking and the polkit
  daemon the `signage` user needs to restart its own units. `apt-mark manual`
  those first. One autoremove pass also only peels the top ~14 metapackages —
  GNOME's Recommends web stalls orphan detection, so the pass must be looped.
- **Not paired.** Pairing code issued; `signage pair` not yet run.
- **Wi-Fi not configured, and it is the production configuration for this
  screen.** Interface is **`wlp2s0`**, not the `wlan0` the docs' examples assume.
  Radio enabled, target SSID visible at signal 89 and 82 (two radios/bands). The
  `iwlwifi` power-save trap and `autoconnect-retries 0` both still to apply; see
  [device-install.md](device-install.md). The soak must run on Wi-Fi with
  Ethernet physically unplugged — a soak on the wired link validates a path this
  screen will never use.
- **No playback figures.** The CXI3 row records measured RCS/CPU numbers; this
  unit has none, because nothing has played yet. `intel_gpu_top` (RCS non-zero)
  and idle CPU at 1080p30 are the numbers to take once content is syncing.
- **Playback tier unmeasured.** See above — `standard` is a fall-through, not a
  result.
- **Network configuration not recorded.** Whether this unit ships on Ethernet or
  Wi-Fi is undetermined; if Wi-Fi, the `iwlwifi` power-save trap in
  [device-install.md](device-install.md) applies and the soak must run on Wi-Fi.
- **72-hour soak.** Not run.

---

## Recording a validated flag set

When the T016 flag matrix produces a working configuration, record it as the
exact `agent.env` lines an operator would set, with the Chromium version beside
them:

```bash
# Validated on <model>, Chromium <version>, <date>, by <who>
signage config set SIGNAGE_KIOSK_GPU gles
signage config set SIGNAGE_CHROMIUM_EXTRA_FLAGS "<flags>"
```

Every change must be revertible from `/etc/signage/agent.env` without a
redeploy — that is what makes a bad flag set a one-line fix on the device rather
than a release.
