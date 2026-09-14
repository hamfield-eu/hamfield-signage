import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseState, imageItem, startPlayer, type Harness } from './test-harness';

/**
 * The two transient full-screen overlays: `identify` (the device's own name)
 * and `show_message` (operator text).
 *
 * They share one element and one timer on purpose, so the interesting cases are
 * not "does text appear" but what happens when they overlap — which is exactly
 * what an operator does when a message does not land the first time.
 */
describe('screen overlays', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startPlayer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const overlay = () => document.getElementById('overlay')!;
  const visible = () => !overlay().classList.contains('hidden');

  it('shows operator text and clears it when the duration is up', async () => {
    h.push({ type: 'show_message', text: 'Closing at 4pm today', durationSeconds: 10 });

    expect(visible()).toBe(true);
    expect(overlay().textContent).toBe('Closing at 4pm today');

    await h.advance(9_000);
    expect(visible()).toBe(true);

    await h.advance(1_100);
    expect(visible()).toBe(false);
  });

  it('renders the text as text, never as markup', async () => {
    // The dashboard is a free-text field; the only thing standing between it
    // and the screen is that this is textContent rather than innerHTML.
    h.push({ type: 'show_message', text: '<img src=x onerror=alert(1)>', durationSeconds: 5 });

    expect(overlay().querySelector('img')).toBeNull();
    expect(overlay().textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('keeps identify looking like identify, and a message looking like a message', async () => {
    h.push({ type: 'identify', deviceName: 'Lobby screen', durationSeconds: 10 });
    expect(overlay().textContent).toBe('Lobby screen');
    expect(overlay().classList.contains('message')).toBe(false);

    h.push({ type: 'show_message', text: 'Back in 5 minutes', durationSeconds: 10 });
    expect(overlay().classList.contains('message')).toBe(true);

    // ...and back again: the variant class must not accumulate.
    h.push({ type: 'identify', deviceName: 'Lobby screen', durationSeconds: 10 });
    expect(overlay().classList.contains('message')).toBe(false);
  });

  it('lets a second message replace the first, timer included', async () => {
    h.push({ type: 'show_message', text: 'First', durationSeconds: 10 });
    await h.advance(8_000);

    // Sent 8s into a 10s message: the replacement must get its own full 10s,
    // not the 2s left on the one it replaced.
    h.push({ type: 'show_message', text: 'Second', durationSeconds: 10 });
    expect(overlay().textContent).toBe('Second');

    await h.advance(3_000);
    expect(visible()).toBe(true);
    expect(overlay().textContent).toBe('Second');

    await h.advance(7_100);
    expect(visible()).toBe(false);
  });

  it('does not disturb playback underneath it', async () => {
    h.pushState(baseState([imageItem({ durationSeconds: 5 })]));
    await h.advance(10);
    const before = document.querySelector('#stage img');
    expect(before).not.toBeNull();

    h.push({ type: 'show_message', text: 'Staff meeting at 3', durationSeconds: 5 });
    await h.advance(6_000);

    // The overlay covers the content; it must never replace it. A message that
    // stopped the playlist would be an outage, not a notice.
    expect(document.querySelector('#stage img')).not.toBeNull();
    expect(visible()).toBe(false);
  });
});
