import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLAYER_PROGRESS_INTERVAL_MS, PLAYER_STALL_REPORTS } from '@signage/shared';
import { baseState, imageItem, startPlayer, videoItem } from './test-harness';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('video safety net (F1)', () => {
  it('advances a video whose `ended` never fires — the F1 regression test', async () => {
    // The hang: a video decodes its first frame, then wedges. `ended` never
    // fires, `error` never fires, and before T015 no timer was armed at all,
    // so the screen stayed on that frame forever with zero telemetry.
    const h = await startPlayer();
    h.pushState(baseState([videoItem({ maxDurationSeconds: 40 }), imageItem()]));
    await h.advance(50);
    expect(h.events('start')).toHaveLength(1);

    // Nothing moves. No timeupdate, no ended, no error.
    await h.advance(41_000);

    const errors = h.events('error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].detail?.reason).toBe('stall_timeout');
    // And it actually moved on rather than merely complaining.
    expect(h.events('start').length).toBeGreaterThan(1);
  });

  it('recovers a single looping video that stalls', async () => {
    // The worst shape: `loop = true` means `ended` never fires even when the
    // video is healthy, so this item previously had no exit of any kind.
    const h = await startPlayer();
    h.pushState(baseState([videoItem({ maxDurationSeconds: 30 })], { loop: true }));
    await h.advance(50);
    expect(h.video()).not.toBeNull();

    await h.advance(31_000);

    const errors = h.events('error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].detail?.reason).toBe('stall_timeout');
  });

  it('does not cut off a healthy video that runs slightly past its probed duration', async () => {
    // 30 s probed → 47 s ceiling. A video that takes 33 s is healthy and must
    // be left alone; cutting it off would be a visible regression on every
    // screen, which is why the ceiling carries slack.
    const h = await startPlayer();
    h.pushState(baseState([videoItem({ maxDurationSeconds: 47 }), imageItem()]));
    await h.advance(50);

    await h.playFor(33_000);

    expect(h.events('error')).toHaveLength(0);
  });

  it('re-arms the ceiling on each loop so a healthy looping video never trips it', async () => {
    // 10 s video, 22 s ceiling, played for a minute. Without the per-loop
    // re-arm the ceiling would fire during the third iteration.
    const h = await startPlayer();
    h.pushState(baseState([videoItem({ maxDurationSeconds: 22 })], { loop: true }));
    await h.advance(50);

    await h.playFor(60_000, { loopEvery: 10 });

    expect(h.events('error')).toHaveLength(0);
  });

  it('arms a fallback ceiling when the natural duration is unknown', async () => {
    // maxDurationSeconds absent (an unprobed video, or a pre-T015 agent).
    // The rule is that no video item may ever have no timer.
    const h = await startPlayer();
    h.pushState(baseState([videoItem({ maxDurationSeconds: null }), imageItem()]));
    await h.advance(50);

    // Keep it "playing" so stall detection stays quiet and only the ceiling
    // can be what fires.
    await h.playFor(1_805_000);

    const errors = h.events('error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].detail?.reason).toBe('stall_timeout');
  });
});

describe('stall detection', () => {
  it('catches a wedged video from timeupdate stagnation, long before the ceiling', async () => {
    // A 10-minute video that wedges at second 3 should not hold the screen for
    // 10 minutes waiting for the ceiling.
    const h = await startPlayer();
    h.pushState(baseState([videoItem({ maxDurationSeconds: 600 }), imageItem()]));
    await h.advance(50);

    h.tick(1);
    await h.advance(PLAYER_PROGRESS_INTERVAL_MS);
    h.tick(3);
    await h.advance(PLAYER_PROGRESS_INTERVAL_MS);

    // Now it stops moving.
    await h.advance(PLAYER_PROGRESS_INTERVAL_MS * (PLAYER_STALL_REPORTS + 1));

    const errors = h.events('error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].detail?.detectedBy).toBe('timeupdate_stagnation');
    // Well inside the 600 s ceiling.
    expect(h.events('start').length).toBeGreaterThan(1);
  });

  it('reports progress to the agent on a steady interval', async () => {
    const h = await startPlayer();
    h.pushState(baseState([videoItem(), imageItem()]));
    await h.advance(50);

    await h.playFor(PLAYER_PROGRESS_INTERVAL_MS * 3);

    const progress = h.sent.filter((m) => m.type === 'player_progress');
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress.at(-1)).toMatchObject({ mediaId: 'vid-1', advancing: true });
  });

  it('does not treat a buffering pause as a stall until stagnation persists', async () => {
    const h = await startPlayer();
    h.pushState(baseState([videoItem({ maxDurationSeconds: 600 }), imageItem()]));
    await h.advance(50);

    // One quiet reporting window — ordinary buffering — then playback resumes.
    await h.advance(PLAYER_PROGRESS_INTERVAL_MS);
    h.tick(4);
    await h.playFor(PLAYER_PROGRESS_INTERVAL_MS * 2);

    expect(h.events('error')).toHaveLength(0);
  });
});

describe('existing behaviour is preserved', () => {
  it('still advances images on their own duration', async () => {
    const h = await startPlayer();
    h.pushState(baseState([imageItem({ durationSeconds: 5 }), imageItem({ id: 'item-image-2' })]));
    await h.advance(50);
    expect(h.events('start')).toHaveLength(1);

    await h.advance(5_100);

    expect(h.events('end')).toHaveLength(1);
    expect(h.events('start')).toHaveLength(2);
  });

  it('still honours an operator-set duration on a video', async () => {
    // An explicit per-item duration owns the normal transition; the ceiling is
    // only a safety net and must not pre-empt it.
    const h = await startPlayer();
    h.pushState(
      baseState([videoItem({ durationSeconds: 6, maxDurationSeconds: 47 }), imageItem()]),
    );
    await h.advance(50);

    await h.playFor(6_500);

    expect(h.events('end')).toHaveLength(1);
    expect(h.events('error')).toHaveLength(0);
  });
});

describe('failure backoff', () => {
  it('backs off when the only item decodes a moment and then wedges', async () => {
    // The corrupt-stream shape F1 is actually about: the video loads, produces
    // a second of movement, then dies. A single `timeupdate` must NOT count as
    // recovery, or the backoff pins at its 3 s floor and the retry cycle runs
    // every ~18 s forever — thousands of error events a day into a buffer that
    // holds 5,000.
    const h = await startPlayer();
    h.pushState(baseState([videoItem({ maxDurationSeconds: 600 })], { loop: true }));
    await h.advance(50);

    // Each time the player mounts a fresh element, it decodes a second and
    // then goes silent — exactly what a corrupt stream does on every retry.
    let seen: Element | null = null;
    for (let elapsed = 0; elapsed < 600_000; elapsed += 1_000) {
      const el = document.querySelector('.layer.visible video') as HTMLVideoElement | null;
      if (el && el !== seen) {
        seen = el;
        el.currentTime = 1;
        (el.ontimeupdate as ((e: Event) => void) | null)?.(new Event('timeupdate'));
        el.currentTime = 2;
        (el.ontimeupdate as ((e: Event) => void) | null)?.(new Event('timeupdate'));
      }
      await h.advance(1_000);
    }

    const errors = h.events('error');
    expect(errors.length).toBeGreaterThan(0);
    // Without backoff this is ~30 in ten minutes.
    expect(errors.length).toBeLessThan(12);
  });

  it('backs off instead of spinning when the only item keeps failing to load', async () => {
    // A one-item playlist whose media is corrupt used to retry every 3 s,
    // which is ~1,200 error events a day into an event buffer capped at 5,000.
    const h = await startPlayer();
    h.failLoads(true);
    h.pushState(baseState([videoItem()], { loop: true }));

    await h.advance(120_000);

    const errors = h.events('error');
    expect(errors.length).toBeGreaterThan(0);
    // Un-backed-off would be ~40 in two minutes.
    expect(errors.length).toBeLessThan(12);
  });
});
