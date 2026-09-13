import { describe, expect, it } from 'vitest';
import type { SyncManifest } from '@signage/sync-protocol';
import {
  VIDEO_CEILING_FALLBACK_SECONDS,
  VIDEO_CEILING_SLACK_RATIO,
  VIDEO_CEILING_SLACK_SECONDS,
} from '@signage/shared';
import { computePlayerState, stateFingerprint, videoCeilingSeconds } from './state';

function manifest(overrides: Partial<SyncManifest> = {}): SyncManifest {
  return {
    protocolVersion: 1,
    version: 'v1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    deviceId: 'dev-1',
    settings: {
      name: 'Lobby screen',
      orientation: 'landscape',
      timezone: 'Europe/Amsterdam',
      defaultPlaylistId: 'pl-1',
    },
    emergency: { active: false, playlistId: null, mediaAssetId: null, startedAt: null },
    schedules: [],
    playlists: [
      {
        id: 'pl-1',
        name: 'Default playlist',
        loop: true,
        defaultImageDurationSeconds: 10,
        items: [
          {
            id: 'item-1',
            mediaId: 'img-1',
            position: 0,
            durationSeconds: null,
            fitMode: null,
            enabled: true,
          },
          {
            id: 'item-2',
            mediaId: 'vid-1',
            position: 1,
            durationSeconds: null,
            fitMode: 'cover',
            enabled: true,
          },
          {
            id: 'item-3',
            mediaId: 'img-1',
            position: 2,
            durationSeconds: 5,
            fitMode: null,
            enabled: false,
          },
        ],
      },
    ],
    media: [
      {
        id: 'img-1',
        name: 'Poster',
        type: 'image',
        mimeType: 'image/jpeg',
        checksum: 'a'.repeat(64),
        sizeBytes: 100,
        width: 1920,
        height: 1080,
        orientation: 'landscape',
        durationSeconds: null,
        downloadPath: '/api/v1/device/media/img-1/download',
      },
      {
        id: 'vid-1',
        name: 'Promo video',
        type: 'video',
        mimeType: 'video/mp4',
        checksum: 'b'.repeat(64),
        sizeBytes: 5000,
        width: 1920,
        height: 1080,
        orientation: 'landscape',
        durationSeconds: 30,
        downloadPath: '/api/v1/device/media/vid-1/download',
      },
    ],
    ...overrides,
  };
}

const allCached = new Set(['img-1', 'vid-1']);

describe('computePlayerState', () => {
  it('shows pairing instructions when there is no manifest and no pairing', () => {
    const state = computePlayerState(null, {
      paired: false,
      online: false,
      cachedMediaIds: new Set(),
    });
    expect(state.items).toHaveLength(0);
    expect(state.statusMessage).toMatch(/not paired/i);
  });

  it('shows a waiting message when paired but never synced', () => {
    const state = computePlayerState(null, {
      paired: true,
      online: true,
      cachedMediaIds: new Set(),
    });
    expect(state.statusMessage).toMatch(/first content sync/i);
  });

  it('plays the default playlist with cached, enabled items only', () => {
    const state = computePlayerState(manifest(), {
      paired: true,
      online: true,
      cachedMediaIds: allCached,
    });
    expect(state.source).toBe('default');
    expect(state.playlistId).toBe('pl-1');
    expect(state.loop).toBe(true);
    expect(state.items.map((i) => i.id)).toEqual(['item-1', 'item-2']);
    expect(state.statusMessage).toBeNull();
  });

  it('applies the playlist default duration to images and natural duration to videos', () => {
    const state = computePlayerState(manifest(), {
      paired: true,
      online: true,
      cachedMediaIds: allCached,
    });
    expect(state.items[0].durationSeconds).toBe(10); // image inherits playlist default
    expect(state.items[1].durationSeconds).toBeNull(); // video plays its natural length
    expect(state.items[0].fitMode).toBe('contain'); // platform default fit
    expect(state.items[1].fitMode).toBe('cover'); // explicit per-item override
  });

  it('skips media that is not cached yet and explains why', () => {
    const state = computePlayerState(manifest(), {
      paired: true,
      online: true,
      cachedMediaIds: new Set(['img-1']),
    });
    expect(state.items.map((i) => i.mediaId)).toEqual(['img-1']);

    const nothingCached = computePlayerState(manifest(), {
      paired: true,
      online: true,
      cachedMediaIds: new Set(),
    });
    expect(nothingCached.items).toHaveLength(0);
    expect(nothingCached.statusMessage).toMatch(/downloading/i);
  });

  it('plays a single emergency media asset on loop when cached', () => {
    const m = manifest({
      emergency: {
        active: true,
        playlistId: null,
        mediaAssetId: 'img-1',
        startedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const state = computePlayerState(m, { paired: true, online: true, cachedMediaIds: allCached });
    expect(state.source).toBe('emergency');
    expect(state.loop).toBe(true);
    expect(state.items).toHaveLength(1);
    expect(state.items[0].mediaId).toBe('img-1');

    const notCached = computePlayerState(m, {
      paired: true,
      online: true,
      cachedMediaIds: new Set(),
    });
    expect(notCached.items).toHaveLength(0);
    expect(notCached.statusMessage).toMatch(/downloading/i);
  });

  it('reports when nothing is scheduled', () => {
    const m = manifest({
      settings: {
        name: 'Lobby screen',
        orientation: 'landscape',
        timezone: 'Europe/Amsterdam',
        defaultPlaylistId: null,
      },
    });
    const state = computePlayerState(m, { paired: true, online: true, cachedMediaIds: allCached });
    expect(state.source).toBe('none');
    expect(state.items).toHaveLength(0);
    expect(state.statusMessage).toMatch(/no content scheduled/i);
  });
});

describe('playback order modes (v2 manifests)', () => {
  it('defaults to manual_order for v1 manifests without the field', () => {
    const state = computePlayerState(manifest(), {
      paired: true,
      online: true,
      cachedMediaIds: allCached,
    });
    expect(state.playbackOrderMode).toBe('manual_order');
    expect(state.priorityRules).toEqual([]);
  });

  it('passes the order mode through for the player to apply', () => {
    const m = manifest();
    m.playlists[0].playbackOrderMode = 'random';
    const state = computePlayerState(m, {
      paired: true,
      online: true,
      cachedMediaIds: allCached,
    });
    expect(state.playbackOrderMode).toBe('random');
    // The pool itself stays in manifest order — shuffling happens on screen.
    expect(state.items.map((i) => i.id)).toEqual(['item-1', 'item-2']);
  });

  it('builds playable priority rules from cached media only', () => {
    const m = manifest();
    m.playlists[0].playbackOrderMode = 'random_with_priority_rules';
    m.playlists[0].priorityRules = [
      {
        id: 'rule-1',
        name: 'Sponsors',
        intervalCount: 5,
        selectionMode: 'rotate',
        position: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        mediaIds: ['img-1', 'vid-1', 'missing-media'],
      },
      {
        id: 'rule-2',
        name: 'Empty rule',
        intervalCount: 3,
        selectionMode: 'random',
        position: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        mediaIds: ['not-cached'],
      },
    ];
    const state = computePlayerState(m, {
      paired: true,
      online: true,
      cachedMediaIds: allCached,
    });
    expect(state.priorityRules).toHaveLength(1);
    expect(state.priorityRules[0].id).toBe('rule-1');
    expect(state.priorityRules[0].items.map((i) => i.mediaId)).toEqual(['img-1', 'vid-1']);
    // Rule images inherit the playlist default duration.
    expect(state.priorityRules[0].items[0].durationSeconds).toBe(10);
  });

  it('ignores priority rules unless the mode is random_with_priority_rules', () => {
    const m = manifest();
    m.playlists[0].playbackOrderMode = 'random';
    m.playlists[0].priorityRules = [
      {
        id: 'rule-1',
        name: 'Sponsors',
        intervalCount: 5,
        selectionMode: 'rotate',
        position: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        mediaIds: ['img-1'],
      },
    ];
    const state = computePlayerState(m, {
      paired: true,
      online: true,
      cachedMediaIds: allCached,
    });
    expect(state.priorityRules).toEqual([]);
  });

  it('treats a playlist with only priority content as playable', () => {
    const m = manifest();
    m.playlists[0].playbackOrderMode = 'random_with_priority_rules';
    m.playlists[0].items = [];
    m.playlists[0].priorityRules = [
      {
        id: 'rule-1',
        name: 'Sponsors',
        intervalCount: 5,
        selectionMode: 'rotate',
        position: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        mediaIds: ['img-1'],
      },
    ];
    const state = computePlayerState(m, {
      paired: true,
      online: true,
      cachedMediaIds: allCached,
    });
    expect(state.statusMessage).toBeNull();
    expect(state.priorityRules[0].items).toHaveLength(1);
  });
});

describe('display settings resolution', () => {
  const ctx = { paired: true, online: true, cachedMediaIds: allCached };

  it('falls back to platform defaults (contain / #000000 / center)', () => {
    const state = computePlayerState(manifest(), ctx);
    expect(state.items[0].fitMode).toBe('contain');
    expect(state.items[0].backgroundColor).toBe('#000000');
    expect(state.items[0].positionMode).toBe('center');
  });

  it('item override wins over the playlist default', () => {
    const m = manifest();
    m.playlists[0].defaultFitMode = 'stretch';
    m.playlists[0].items[1].fitMode = 'cover'; // explicit override on item-2
    const state = computePlayerState(m, ctx);
    expect(state.items[1].fitMode).toBe('cover');
  });

  it('playlist default applies to items with no override', () => {
    const m = manifest();
    m.playlists[0].defaultFitMode = 'scale_down';
    m.playlists[0].defaultBackgroundColor = '#1f2937';
    m.playlists[0].defaultPositionMode = 'top';
    const state = computePlayerState(m, ctx);
    expect(state.items[0].fitMode).toBe('scale_down'); // item-1 has fitMode null
    expect(state.items[0].backgroundColor).toBe('#1f2937');
    expect(state.items[0].positionMode).toBe('top');
  });

  it('carries per-item background and position from the manifest', () => {
    const m = manifest();
    m.playlists[0].items[0].backgroundColor = '#ffffff';
    m.playlists[0].items[0].positionMode = 'bottom_right';
    const state = computePlayerState(m, ctx);
    expect(state.items[0].backgroundColor).toBe('#ffffff');
    expect(state.items[0].positionMode).toBe('bottom_right');
  });

  it('resolves emergency single-media display settings', () => {
    const m = manifest({
      emergency: {
        active: true,
        playlistId: null,
        mediaAssetId: 'img-1',
        startedAt: '2026-01-01T00:00:00.000Z',
        fitMode: 'cover',
        backgroundColor: '#222222',
        positionMode: 'left',
      },
    });
    const state = computePlayerState(m, ctx);
    expect(state.items[0].fitMode).toBe('cover');
    expect(state.items[0].backgroundColor).toBe('#222222');
    expect(state.items[0].positionMode).toBe('left');
  });

  it('priority-rule items use the playlist display defaults', () => {
    const m = manifest();
    m.playlists[0].playbackOrderMode = 'random_with_priority_rules';
    m.playlists[0].defaultFitMode = 'cover';
    m.playlists[0].priorityRules = [
      {
        id: 'rule-1',
        name: 'Sponsors',
        intervalCount: 5,
        selectionMode: 'rotate',
        position: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        mediaIds: ['img-1'],
      },
    ];
    const state = computePlayerState(m, ctx);
    expect(state.priorityRules[0].items[0].fitMode).toBe('cover');
  });
});

describe('stateFingerprint', () => {
  it('is stable for identical states and differs when content changes', () => {
    const ctx = { paired: true, online: true, cachedMediaIds: allCached };
    const a = stateFingerprint(computePlayerState(manifest(), ctx));
    const b = stateFingerprint(computePlayerState(manifest(), ctx));
    expect(a).toBe(b);

    const offline = stateFingerprint(computePlayerState(manifest(), { ...ctx, online: false }));
    expect(offline).not.toBe(a);
  });
});

// ---------------------------------------------------------------- T015 (F1)

describe('videoCeilingSeconds', () => {
  it('gives images no ceiling — they already advance on their own duration', () => {
    expect(videoCeilingSeconds({ type: 'image', durationSeconds: null })).toBeNull();
    expect(videoCeilingSeconds({ type: 'image', durationSeconds: 12 })).toBeNull();
  });

  it('adds slack so a video that runs slightly long is not cut off', () => {
    const ceiling = videoCeilingSeconds({ type: 'video', durationSeconds: 30 });
    expect(ceiling).toBe(Math.ceil(30 * VIDEO_CEILING_SLACK_RATIO + VIDEO_CEILING_SLACK_SECONDS));
    // The point of the slack: the ceiling must be comfortably beyond the
    // natural end, never at it.
    expect(ceiling as number).toBeGreaterThan(30);
  });

  it('still gives very short clips usable room', () => {
    // 1.25x of a 2 s clip is 2.5 s — without the absolute term the ceiling
    // would fire during ordinary decode latency.
    expect(videoCeilingSeconds({ type: 'video', durationSeconds: 2 })).toBeGreaterThan(10);
  });

  it('falls back to the ceiling when the duration is unknown', () => {
    // No video item may ever have no timer, so an unprobed video gets the
    // generous absolute ceiling rather than nothing.
    expect(videoCeilingSeconds({ type: 'video', durationSeconds: null })).toBe(
      VIDEO_CEILING_FALLBACK_SECONDS,
    );
    expect(videoCeilingSeconds({ type: 'video', durationSeconds: 0 })).toBe(
      VIDEO_CEILING_FALLBACK_SECONDS,
    );
    expect(videoCeilingSeconds({ type: 'video', durationSeconds: -5 })).toBe(
      VIDEO_CEILING_FALLBACK_SECONDS,
    );
  });
});

describe('maxDurationSeconds reaches the player', () => {
  it('is set on playlist video items and left null on images', () => {
    const state = computePlayerState(manifest(), {
      paired: true,
      online: true,
      cachedMediaIds: allCached,
    });
    const [image, video] = state.items;
    expect(image.maxDurationSeconds).toBeNull();
    expect(video.maxDurationSeconds).toBe(
      videoCeilingSeconds({ type: 'video', durationSeconds: 30 }),
    );
  });

  it('is set on an emergency single video — the worst case for F1', () => {
    // One looping video with no timer at all was the hang with the least
    // telemetry, and an emergency override is exactly that shape.
    const state = computePlayerState(
      manifest({
        emergency: {
          active: true,
          playlistId: null,
          mediaAssetId: 'vid-1',
          startedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      { paired: true, online: true, cachedMediaIds: allCached },
    );
    expect(state.source).toBe('emergency');
    expect(state.loop).toBe(true);
    expect(state.items).toHaveLength(1);
    expect(state.items[0].maxDurationSeconds).toBeGreaterThan(0);
  });

  it('is set on priority-rule items', () => {
    const base = manifest();
    const playlist = {
      ...base.playlists[0],
      playbackOrderMode: 'random_with_priority_rules' as const,
      priorityRules: [
        {
          id: 'rule-1',
          name: 'Sponsor',
          intervalCount: 3,
          selectionMode: 'random' as const,
          position: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          mediaIds: ['vid-1'],
        },
      ],
    };
    const state = computePlayerState(manifest({ playlists: [playlist] }), {
      paired: true,
      online: true,
      cachedMediaIds: allCached,
    });
    expect(state.priorityRules[0].items[0].maxDurationSeconds).toBeGreaterThan(0);
  });
});
