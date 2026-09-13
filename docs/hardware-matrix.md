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

| Model                | Arch   | Compositing | H.264 decode | Soak | Status          |
| -------------------- | ------ | ----------- | ------------ | ---- | --------------- |
| Raspberry Pi 4/5     | ARM64  | Vulkan      | software     | —    | In production   |
| ODROID-C4            | ARM64  | software    | software     | —    | In production   |
| Acer Chromebox CXI3  | x86-64 | expect gles | not yet      | —    | Preflight done  |
| Chromebox (2nd unit) | x86-64 | —           | —            | —    | **UNVALIDATED** |

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

**Preflight recorded 2026-09-13. Playback UNVALIDATED** — no VA-API driver
installed yet, no flag matrix run, no soak.

| Field                | Value                                                             |
| -------------------- | ----------------------------------------------------------------- |
| DMI vendor / product | `Google` / `Sion` (version `1.0`)                                 |
| Firmware             | `coreboot MrChromebox-2606.1` — already reflashed                 |
| Arch / kernel        | `x86_64` / `6.12.107+deb13-amd64`                                 |
| OS                   | Debian GNU/Linux 13 (trixie)                                      |
| CPU                  | Intel Celeron 3867U @ 1.80 GHz, **2 cores** (Kaby Lake)           |
| RAM                  | **3.7 GB**                                                        |
| Storage              | 29.8 GB total; `/` is 27.3 GB with 21 GB free                     |
| GPU                  | Intel HD Graphics 610 `[8086:5906]` rev 07 (Gen9.5, GT1)          |
| DRM driver           | `i915`, render node `/dev/dri/renderD128` present                 |
| Display              | HDMI-A-1 at 1920x1080                                             |
| Vulkan driver        | not installed yet — expect `anv` once `mesa-vulkan-drivers` lands |
| VA-API driver        | **not installed**                                                 |
| H.264 decode         | **not determined**                                                |
| Chromium             | **not installed**                                                 |
| Validated flags      | none — `SIGNAGE_CHROMIUM_EXTRA_FLAGS` unset                       |
| Soak                 | not run                                                           |

### What the numbers decide

- **`intel-media-va-driver` (iHD) is the right driver.** Device `8086:5906` is
  Kaby Lake GT1 — Gen9.5, which iHD supports. It is in Debian **main**, so no
  `non-free` component is needed; the `-non-free` variant only adds codecs that
  are not relevant to H.264 decode. `i965-va-driver` is the fallback if iHD
  misbehaves on this generation.
- **`auto` should resolve to `gles`.** The `i915` driver means Mesa's `anv`
  Vulkan driver will be reported once `mesa-vulkan-drivers` is installed, and
  the driver map added in T016 sends `anv` to `gles`. Before that change this
  unit would have landed on `software` — see the note at the top of this file.
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

**Hardware decode is not optional on this unit.** Software-decoding 1080p on two
1.8 GHz cores leaves almost no headroom for compositing — this is the model that
most needs VA-API working, and the one where it is easiest to measure.

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
