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
sudo ./infra/device/preflight.sh
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
| Acer Chromebox CXI3  | x86-64 | —           | —            | —    | **UNVALIDATED** |
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

## Acer Chromebox CXI3

**UNVALIDATED — no preflight recorded.**

Run `preflight.sh` on the unit and paste the block here. Until then, nothing
about this model is known: the review that produced T016 deliberately did not
assert its CPU, GPU, storage size or firmware state.

Two values from that output gate everything downstream:

- **GPU generation** decides the VA-API driver — `intel-media-va-driver-non-free`
  (Gen9+, `iHD`) or `i965-va-driver` (older). `va-driver-all` and letting libva
  pick is the safe default when in doubt.
- **eMMC size** sets `SIGNAGE_MAX_CACHE_GB`. Thin clients ship small internal
  storage, which is the whole reason T017's disk guard is a hard prerequisite
  for x86 production use.

| Field               | Value                                                     |
| ------------------- | --------------------------------------------------------- |
| Preflight           | **not run**                                               |
| `SIGNAGE_KIOSK_GPU` | expected `auto` → `gles` once an `anv` driver is detected |
| VA-API driver       | **not determined**                                        |
| H.264 decode        | **not determined**                                        |
| Chromium version    | **not determined**                                        |
| Validated flags     | none — `SIGNAGE_CHROMIUM_EXTRA_FLAGS` unset               |
| Soak                | not run                                                   |

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
