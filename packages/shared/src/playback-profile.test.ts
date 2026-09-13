import { describe, expect, it } from 'vitest';
import { suggestPlaybackProfile } from './enums';

/**
 * The dashboard shows this as a hint next to the playback-tier dropdown. It is
 * advisory — the operator's choice wins — but a wrong hint is still acted on,
 * and accepting one costs a full media reprocess to encode the new tier.
 */
describe('suggestPlaybackProfile', () => {
  it('suggests the light tier for Amlogic boards', () => {
    expect(suggestPlaybackProfile('Hardkernel ODROID-C4')).toBe('light');
    expect(suggestPlaybackProfile('Amlogic S905X3')).toBe('light');
  });

  it('suggests high only for a Raspberry Pi 5', () => {
    expect(suggestPlaybackProfile('Raspberry Pi 5 Model B Rev 1.0')).toBe('high');
    expect(suggestPlaybackProfile('Raspberry Pi 4 Model B Rev 1.4')).toBe('standard');
  });

  describe('x86 thin clients', () => {
    it('does not suggest the heaviest tier for a bare architecture string', () => {
      // The regression this guards. `Linux x64` is what EVERY x86 device
      // reported before the agent's DMI fallback, and it used to map to
      // `high` — 1080p60 at 9000 kbps — on the reasoning that x86 means a
      // desktop. The x86 fleet here is 2-core Celeron thin clients.
      expect(suggestPlaybackProfile('x86_64')).toBe('standard');
      expect(suggestPlaybackProfile('Linux x64')).toBe('standard');
      expect(suggestPlaybackProfile('x64')).toBe('standard');
    });

    it('recognises the Acer Chromebox CXI3 by its DMI board name', () => {
      // Celeron 3867U, 2 cores, 3.7 GB, Intel HD 610. Measured 2026-09-13.
      expect(suggestPlaybackProfile('Google Sion')).toBe('standard');
    });
  });

  it('falls back to standard for unknown or absent hardware', () => {
    expect(suggestPlaybackProfile(null)).toBe('standard');
    expect(suggestPlaybackProfile(undefined)).toBe('standard');
    expect(suggestPlaybackProfile('')).toBe('standard');
    expect(suggestPlaybackProfile('Some Unreleased Board v2')).toBe('standard');
  });

  it('never suggests a tier that is not a real tier', () => {
    for (const input of ['Google Sion', 'x86_64', 'Raspberry Pi 5', 'Hardkernel ODROID-C4', null]) {
      expect(['light', 'standard', 'high']).toContain(suggestPlaybackProfile(input));
    }
  });
});
