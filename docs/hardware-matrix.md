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
| Chromebox (2nd unit) | x86-64 | —              | —                             | —    | **UNVALIDATED**    |

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

## Chromebox — second unit

**UNVALIDATED — model not yet identified.**

A second, different Chromebox is in play. It needs its own section rather than
being assumed identical to the CXI3: a different GPU generation can need a
different VA-API driver, and `suggestPlaybackProfile` matches on the DMI product
name, which will differ.

| Field            | Value              |
| ---------------- | ------------------ |
| Preflight        | **not run**        |
| DMI product name | **not determined** |

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
