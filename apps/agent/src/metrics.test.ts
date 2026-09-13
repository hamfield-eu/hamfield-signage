import { describe, expect, it } from 'vitest';
import { composeDmiModel, isPlaceholderDmi } from './metrics';

/**
 * x86 thin clients have no device tree, so DMI is the only way they can report
 * a meaningful model. Before this every Chromebox in the fleet showed as
 * "Linux x64" — which identifies nothing, and gives `suggestPlaybackProfile`
 * nothing to match on.
 */
describe('composeDmiModel', () => {
  it('joins vendor and product', () => {
    expect(composeDmiModel('Acer', 'Chromebox CXI3')).toBe('Acer Chromebox CXI3');
  });

  it('does not repeat a vendor the product already names', () => {
    // Vendors do this constantly, and "Acer Acer Chromebox CXI3" reads as a bug.
    expect(composeDmiModel('Acer', 'Acer Chromebox CXI3')).toBe('Acer Chromebox CXI3');
  });

  it('keeps whichever field is real when the other is missing', () => {
    expect(composeDmiModel('Acer', null)).toBe('Acer');
    expect(composeDmiModel(null, 'Chromebox CXI3')).toBe('Chromebox CXI3');
  });

  it('returns null when nothing usable is present', () => {
    expect(composeDmiModel(null, null)).toBeNull();
  });

  describe('placeholders', () => {
    // An unset DMI field is worse than an absent one: it looks like an answer.
    for (const placeholder of [
      'To Be Filled By O.E.M.',
      'To be filled by O.E.M.',
      'Default string',
      'System Product Name',
      'System manufacturer',
      'None',
      'N/A',
      'Unknown',
    ]) {
      it(`treats "${placeholder}" as absent`, () => {
        expect(isPlaceholderDmi(placeholder)).toBe(true);
      });
    }

    it('drops only the placeholder half', () => {
      expect(composeDmiModel('To Be Filled By O.E.M.', 'Chromebox CXI3')).toBe('Chromebox CXI3');
      expect(composeDmiModel('Acer', 'Default string')).toBe('Acer');
    });

    it('returns null when both halves are placeholders', () => {
      expect(composeDmiModel('System manufacturer', 'System Product Name')).toBeNull();
    });

    it('does not mistake a real model for a placeholder', () => {
      expect(isPlaceholderDmi('Acer')).toBe(false);
      expect(isPlaceholderDmi('Chromebox CXI3')).toBe(false);
      expect(isPlaceholderDmi('NUC7i5BNH')).toBe(false);
      // Starts with "None" as a substring but is a real name.
      expect(isPlaceholderDmi('Nonesuch Systems X1')).toBe(false);
    });
  });
});
