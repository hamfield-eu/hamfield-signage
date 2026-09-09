import { describe, expect, it } from 'vitest';
import { tokenPredatesPasswordChange } from './auth';

/**
 * These cases are the whole of T012 S5: a stateless 7-day JWT is revocable only
 * because authentication compares the token's `pwdAt` claim against the stored
 * User.passwordChangedAt. Getting any one of them wrong either fails to revoke a
 * stolen token, or logs the entire user base out on deploy.
 */
describe('tokenPredatesPasswordChange', () => {
  const t = (ms: number) => new Date(ms);

  it('accepts any token when the password has never been changed', () => {
    // The column is nullable and NULL for every existing row after the
    // migration, so sessions outstanding at deploy time must keep working.
    expect(tokenPredatesPasswordChange(undefined, null)).toBe(false);
    expect(tokenPredatesPasswordChange(1_000_000, null)).toBe(false);
  });

  it('rejects a token with no claim once the password has changed', () => {
    // Tokens minted before this feature existed carry no pwdAt. They are only
    // rejected once a password actually changes - which is the intent.
    expect(tokenPredatesPasswordChange(undefined, t(1_000_000))).toBe(true);
  });

  it('rejects a token issued before the change', () => {
    expect(tokenPredatesPasswordChange(500_000, t(1_000_000))).toBe(true);
  });

  it('accepts a token issued after the change', () => {
    expect(tokenPredatesPasswordChange(2_000_000, t(1_000_000))).toBe(false);
  });

  it('accepts a token carrying exactly the change timestamp', () => {
    // The token handed back by POST /auth/change-password carries precisely this
    // value; if it were rejected, changing your password would immediately break
    // the tab you did it in.
    expect(tokenPredatesPasswordChange(1_000_000, t(1_000_000))).toBe(false);
  });

  it('tolerates JWT second-granularity against a millisecond column', () => {
    // jwt `iat` is whole seconds while passwordChangedAt has milliseconds, so a
    // token minted in the same second as the change can look up to ~1s older
    // than it really is. Without slack that self-invalidates the fresh token.
    expect(tokenPredatesPasswordChange(1_000_000, t(1_000_999))).toBe(false);
    // Beyond the slack it is genuinely an older token and must be rejected.
    expect(tokenPredatesPasswordChange(1_000_000, t(1_002_000))).toBe(true);
  });
});
