import { describe, expect, it } from 'vitest';
import {
  TOTP_STEP_SECONDS,
  base32Decode,
  base32Encode,
  currentTotpStep,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  hotp,
  normalizeRecoveryCode,
  otpauthUri,
  verifyTotp,
} from './mfa';

describe('base32', () => {
  // RFC 4648 section 10.
  const vectors: Array<[string, string]> = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];

  it.each(vectors)('encodes %j as %j (RFC 4648)', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain, 'ascii'))).toBe(encoded);
  });

  it.each(vectors.slice(1))('decodes %j back from %j', (plain, encoded) => {
    expect(base32Decode(encoded)?.toString('ascii')).toBe(plain);
  });

  it('round-trips random secrets', () => {
    for (let i = 0; i < 50; i++) {
      const secret = generateTotpSecret();
      expect(base32Encode(base32Decode(secret)!)).toBe(secret);
    }
  });

  it('accepts padding, lowercase and the spacing apps display', () => {
    expect(base32Decode('mzxw6ytb')?.toString('ascii')).toBe('fooba');
    expect(base32Decode('MZXW 6YTB')?.toString('ascii')).toBe('fooba');
    expect(base32Decode('MZXW6YTB====')?.toString('ascii')).toBe('fooba');
  });

  it('rejects characters outside the alphabet rather than guessing', () => {
    // 0/1/8/9 are the classic confusions; silently mapping them would decode to
    // the wrong secret and produce codes that never match.
    expect(base32Decode('MZXW6YT0')).toBeNull();
    expect(base32Decode('MZXW6YT1')).toBeNull();
    expect(base32Decode('!!!!')).toBeNull();
  });
});

describe('TOTP (RFC 6238 appendix B)', () => {
  // The RFC's SHA-1 seed: the ASCII string "12345678901234567890".
  const seed = Buffer.from('12345678901234567890', 'ascii');
  const secret = base32Encode(seed);

  // [unix time, expected 8-digit TOTP]. The published table is 8 digits; a
  // 6-digit code is that value mod 10^6, which is what the app uses.
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it.each(vectors)('at t=%i produces %s', (time, expected) => {
    const step = Math.floor(time / TOTP_STEP_SECONDS);
    expect(hotp(seed, step, 8)).toBe(expected);
    expect(hotp(seed, step, 6)).toBe(expected.slice(-6));
  });

  it('verifies the code for the current step', () => {
    const now = 1111111109_000;
    expect(verifyTotp(secret, '081804', { now })).toEqual({
      valid: true,
      step: Math.floor(1111111109 / TOTP_STEP_SECONDS),
    });
  });

  it('accepts one step of clock skew either side', () => {
    const step = Math.floor(1111111109 / TOTP_STEP_SECONDS);
    const now = 1111111109_000;
    for (const offset of [-1, 0, 1]) {
      const code = hotp(seed, step + offset, 6);
      expect(verifyTotp(secret, code, { now }).valid).toBe(true);
    }
    expect(verifyTotp(secret, hotp(seed, step + 2, 6), { now }).valid).toBe(false);
    expect(verifyTotp(secret, hotp(seed, step - 2, 6), { now }).valid).toBe(false);
  });

  it('refuses a code from a step already spent (replay)', () => {
    const now = 1111111109_000;
    const step = Math.floor(1111111109 / TOTP_STEP_SECONDS);
    const code = hotp(seed, step, 6);
    expect(verifyTotp(secret, code, { now }).valid).toBe(true);
    expect(verifyTotp(secret, code, { now, lastStep: step }).valid).toBe(false);
    // ...and the skew window may not be used to reach back before it either.
    expect(verifyTotp(secret, hotp(seed, step - 1, 6), { now, lastStep: step }).valid).toBe(false);
    // The next step is still reachable, so the user is not locked out for 30s.
    expect(verifyTotp(secret, hotp(seed, step + 1, 6), { now, lastStep: step }).valid).toBe(true);
  });

  it('rejects malformed input without throwing', () => {
    const now = 1111111109_000;
    for (const bad of ['', '0818040', '08180', 'abcdef', '  ', '08-18-04']) {
      expect(verifyTotp(secret, bad, { now }).valid).toBe(false);
    }
    // Spaces are not malformed: authenticator apps display "081 804", and
    // people paste what they see.
    expect(verifyTotp(secret, '08 18 04', { now }).valid).toBe(true);
    expect(verifyTotp('not base32!', '081804', { now }).valid).toBe(false);
    expect(verifyTotp('', '081804', { now }).valid).toBe(false);
  });

  it('generates 160-bit secrets', () => {
    const secrets = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const value = generateTotpSecret();
      expect(base32Decode(value)).toHaveLength(20);
      secrets.add(value);
    }
    expect(secrets.size).toBe(20);
  });

  it('tracks the current step from the clock', () => {
    expect(currentTotpStep(59_000)).toBe(1);
    expect(currentTotpStep(60_000)).toBe(2);
  });
});

describe('otpauth URI', () => {
  it('carries the issuer in both places apps look for it', () => {
    const uri = otpauthUri({ secret: 'ABCDEF', account: 'admin@example.com', issuer: 'Signage' });
    expect(uri).toMatch(/^otpauth:\/\/totp\/Signage:admin%40example\.com\?/);
    const query = new URLSearchParams(uri.slice(uri.indexOf('?') + 1));
    expect(query.get('secret')).toBe('ABCDEF');
    expect(query.get('issuer')).toBe('Signage');
    expect(query.get('algorithm')).toBe('SHA1');
    expect(query.get('digits')).toBe('6');
    expect(query.get('period')).toBe('30');
  });

  it('escapes an issuer containing a colon or space', () => {
    const uri = otpauthUri({ secret: 'ABCDEF', account: 'a@b.c', issuer: 'Acme: Signs' });
    // An unescaped colon in the label would split it into the wrong issuer.
    expect(uri.slice('otpauth://totp/'.length, uri.indexOf('?'))).toBe('Acme%3A%20Signs:a%40b.c');
  });
});

describe('recovery codes', () => {
  it('issues ten distinct, transcribable codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
      // The characters people confuse when reading a printed code back.
      expect(code).not.toMatch(/[IO01]/);
    }
  });

  it('hashes independently of how the code was typed back', () => {
    const [code] = generateRecoveryCodes(1);
    const hash = hashRecoveryCode(code);
    expect(hashRecoveryCode(code.toLowerCase())).toBe(hash);
    expect(hashRecoveryCode(` ${code.replace('-', '')} `)).toBe(hash);
    expect(hashRecoveryCode(code.replace('-', ' '))).toBe(hash);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // The stored value must not be the code itself.
    expect(hash).not.toContain(normalizeRecoveryCode(code));
  });
});
