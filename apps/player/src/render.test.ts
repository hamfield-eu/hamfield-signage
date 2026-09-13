import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIT_MODES } from '@signage/shared';
import { baseState, imageItem, startPlayer, videoItem, type Harness } from './test-harness';

/**
 * Rendering and state-transition behaviour, as distinct from the F1 watchdog
 * covered in `main.test.ts`.
 *
 * These are the parts of the player a dashboard change can silently break: how
 * a fit mode and a physical rotation reach the DOM, what a state update does to
 * an item that is already on screen, and the token that stops two playbacks
 * running at once.
 */
describe('player rendering and state transitions', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startPlayer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const stage = () => document.getElementById('stage')!;
  const media = () => document.querySelector('#stage img, #stage video');

  describe('fit mode and rotation reach the DOM', () => {
    // Every mode the dashboard can set, so a new one added there without a
    // matching CSS class shows up here.
    for (const fitMode of FIT_MODES) {
      it(`an item with fitMode "${fitMode}" renders with the matching class`, async () => {
        h.pushState(baseState([imageItem({ fitMode })]));
        await h.advance(50);
        expect(media()?.className).toBe(`fit-${fitMode}`);
      });
    }

    for (const rotation of [90, 180, 270] as const) {
      it(`rotation ${rotation} rotates the stage, not the item`, async () => {
        h.pushState(baseState([imageItem()], { rotation }));
        await h.advance(50);
        expect(stage().classList.contains(`rot-${rotation}`)).toBe(true);
        // The item's own class is about fit, never about rotation.
        expect(media()?.className).toBe('fit-contain');
      });
    }

    it('rotation 0 leaves no rotation class behind', async () => {
      h.pushState(baseState([imageItem()], { rotation: 90 }));
      await h.advance(50);
      expect(stage().classList.contains('rot-90')).toBe(true);

      h.pushState(baseState([imageItem()], { rotation: 0, revision: 2 }));
      await h.advance(50);
      expect(stage().className).not.toMatch(/rot-/);
    });

    it('fit mode and rotation compose without interfering', async () => {
      h.pushState(baseState([imageItem({ fitMode: 'cover' })], { rotation: 270 }));
      await h.advance(50);
      expect(stage().classList.contains('rot-270')).toBe(true);
      expect(media()?.className).toBe('fit-cover');
    });
  });

  describe('a state update mid-item', () => {
    const two = () => [
      imageItem({ id: 'one', mediaId: 'img-1', url: '/media/img-1', durationSeconds: 60 }),
      imageItem({ id: 'two', mediaId: 'img-2', url: '/media/img-2', durationSeconds: 60 }),
    ];

    it('keeps playing the current item in manual_order when it survives', async () => {
      h.pushState(baseState(two()));
      await h.advance(50);
      expect(h.events('start')).toHaveLength(1);
      expect(h.events('start')[0].itemId).toBe('one');

      // A third item appears — the content fingerprint changes, so the update
      // is not a no-op, but item "one" is still on screen and must stay there.
      h.pushState(
        baseState([...two(), imageItem({ id: 'three', mediaId: 'img-3', url: '/media/img-3' })], {
          revision: 2,
        }),
      );
      await h.advance(50);

      expect(h.events('start')).toHaveLength(1);
      expect(h.events('end')).toHaveLength(0);
    });

    it('restarts from the top in manual_order when the current item is gone', async () => {
      h.pushState(baseState(two()));
      await h.advance(50);
      expect(h.events('start')[0].itemId).toBe('one');

      // "one" is removed underneath the player.
      h.pushState(baseState([two()[1]], { revision: 2 }));
      await h.advance(50);

      const starts = h.events('start');
      expect(starts).toHaveLength(2);
      expect(starts[1].itemId).toBe('two');
    });

    it('restarts in a random mode, because the shuffle is rebuilt', async () => {
      // Random order has no stable position to preserve: the pool changed, so
      // a fresh shuffle is the only correct answer.
      h.pushState(baseState(two(), { playbackOrderMode: 'random' }));
      await h.advance(50);
      expect(h.events('start')).toHaveLength(1);

      h.pushState(
        baseState([...two(), imageItem({ id: 'three', mediaId: 'img-3', url: '/media/img-3' })], {
          playbackOrderMode: 'random',
          revision: 2,
        }),
      );
      await h.advance(50);

      expect(h.events('start').length).toBeGreaterThan(1);
    });

    it('an update that changes nothing about the content does not restart', async () => {
      h.pushState(baseState(two()));
      await h.advance(50);
      expect(h.events('start')).toHaveLength(1);

      // Only the revision and a non-content field move. The agent bumps the
      // revision for any state change at all, including going offline.
      h.pushState(baseState(two(), { revision: 2, online: false }));
      await h.advance(50);

      expect(h.events('start')).toHaveLength(1);
    });
  });

  describe('playToken invalidation', () => {
    it('a second state update mid-load leaves only the newest item playing', async () => {
      // Media loading resolves on a macrotask, so pushing twice before
      // advancing timers is exactly the race the token exists to lose safely:
      // the first load completes into a player that has already moved on.
      h.pushState(baseState([videoItem({ id: 'first', mediaId: 'vid-1', url: '/media/vid-1' })]));
      h.pushState(
        baseState([videoItem({ id: 'second', mediaId: 'vid-2', url: '/media/vid-2' })], {
          revision: 2,
        }),
      );
      await h.advance(100);

      const starts = h.events('start');
      expect(starts).toHaveLength(1);
      expect(starts[0].itemId).toBe('second');
      expect(document.querySelectorAll('#stage video')).toHaveLength(1);
      expect(h.video()?.getAttribute('src')).toBe('/media/vid-2');
    });

    it('an abandoned video’s ended event cannot advance the new one', async () => {
      h.pushState(
        baseState([
          videoItem({ id: 'first', mediaId: 'vid-1', url: '/media/vid-1', maxDurationSeconds: 40 }),
        ]),
      );
      await h.advance(50);
      const abandoned = h.video()!;
      expect(h.events('start')).toHaveLength(1);

      h.pushState(
        baseState([imageItem({ id: 'later', mediaId: 'img-9', url: '/media/img-9' })], {
          revision: 2,
        }),
      );
      await h.advance(50);
      expect(h.events('start')).toHaveLength(2);

      // The old element fires late, as a detached decoder genuinely can.
      (abandoned.onended as (() => void) | null)?.();
      await h.advance(50);

      // No third start: the stale token was refused.
      expect(h.events('start')).toHaveLength(2);
      expect(media()?.tagName).toBe('IMG');
    });

    it('clearing the playlist stops playback and shows the fallback', async () => {
      h.pushState(baseState([videoItem()]));
      await h.advance(50);
      expect(h.video()).not.toBeNull();

      h.pushState(baseState([], { revision: 2, statusMessage: 'Nothing scheduled' }));
      await h.advance(50);

      expect(document.getElementById('fallback')!.classList.contains('hidden')).toBe(false);
      expect(document.getElementById('fb-message')!.textContent).toBe('Nothing scheduled');
    });
  });
});
