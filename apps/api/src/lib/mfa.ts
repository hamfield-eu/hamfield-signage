import { createHmac, randomBytes, randomInt } from 'node:crypto';
import type { PrismaClient } from '@signage/database';
import { hashDeviceToken, safeEqual } from './tokens';

/**
 * TOTP (RFC 6238) over HMAC-SHA1, 6 digits, 30-second steps — the only
 * combination every authenticator app agrees on. Implemented here rather than
 * pulled in as a dependency: it is ~60 lines of node:crypto, and `mfa.test.ts`
 * pins it to the RFC's own published vectors, which is a stronger guarantee
 * than a version range in package.json.
 */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps of clock skew accepted either side of now (±30s). */
export const TOTP_WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, unpadded — the encoding every `otpauth://` URI uses. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Decodes RFC 4648 base32, tolerating the shapes users actually paste: padding,
 * lowercase, and the spaces authenticator apps put in displayed secrets.
 * Returns null on any character outside the alphabet rather than silently
 * decoding to the wrong bytes.
 */
export function base32Decode(input: string): Buffer | null {
  const clean = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (clean.length === 0) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit TOTP secret, base32-encoded (32 characters). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function currentTotpStep(now: number = Date.now()): number {
  return Math.floor(now / 1000 / TOTP_STEP_SECONDS);
}

/**
 * The HOTP value (RFC 4226) for a counter, as a zero-padded decimal string.
 * Exported for the test vectors; routes should call `verifyTotp`.
 */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const buf = Buffer.alloc(8);
  // Counter is a 64-bit big-endian integer. It stays well inside 2^53 for any
  // date this software will see, so the split into two 32-bit halves is exact.
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac('sha1', secret).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export interface TotpVerification {
  valid: boolean;
  /** The step the code belongs to — persist it so the code cannot be replayed. */
  step?: number;
}

/**
 * Verifies a user-entered code against a base32 secret.
 *
 * `lastStep` is the newest step already spent by this account: a code from that
 * step or earlier is refused even though it is arithmetically correct, because
 * a code stays valid for up to 30 seconds after it is used and that window is
 * exactly what a shoulder-surfer or a replayed request would exploit.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  options: { now?: number; lastStep?: number | null; window?: number } = {},
): TotpVerification {
  const secret = base32Decode(secretBase32);
  if (!secret || secret.length === 0) return { valid: false };

  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return { valid: false };

  const window = options.window ?? TOTP_WINDOW;
  const center = currentTotpStep(options.now ?? Date.now());
  for (let offset = -window; offset <= window; offset++) {
    const step = center + offset;
    if (step < 0) continue;
    if (options.lastStep != null && step <= options.lastStep) continue;
    // Constant-time compare: both sides are fixed-length decimal strings.
    if (safeEqual(hotp(secret, step, TOTP_DIGITS), digits)) return { valid: true, step };
  }
  return { valid: false };
}

/**
 * The `otpauth://` URI an authenticator app scans. The label is
 * `issuer:account`, and issuer is repeated as a parameter — apps disagree about
 * which one they read, so both must be present and must match.
 */
export function otpauthUri(params: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.account)}`;
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

// ------------------------------------------------------------------ recovery

export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
const RECOVERY_GROUP = 5;

/**
 * Ten single-use codes, shown once at enrollment. Formatted `XXXXX-XXXXX`
 * (~50 bits) because they are transcribed by hand, from paper, under stress.
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    let code = '';
    for (let c = 0; c < RECOVERY_GROUP * 2; c++) {
      if (c === RECOVERY_GROUP) code += '-';
      code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    }
    codes.push(code);
  }
  return codes;
}

/** Normalizes then hashes a recovery code. Only the hash is ever stored. */
export function hashRecoveryCode(code: string): string {
  return hashDeviceToken(normalizeRecoveryCode(code));
}

export function normalizeRecoveryCode(code: string): string {
  return code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

// ------------------------------------------------------------- server-side ops

export interface DisableMfaResult {
  status: 'disabled' | 'already-off' | 'no-such-user';
  email: string;
}

/**
 * Turns MFA off for one account and drops its recovery codes.
 *
 * This is the whole recovery story for a deployment with no outbound email: an
 * operator with server access runs the CLI. It deliberately touches nothing but
 * these columns — no key material, no password — so it cannot itself fail in a
 * way that locks the account further.
 */
export async function disableMfaForUser(
  prisma: PrismaClient,
  email: string,
): Promise<DisableMfaResult> {
  // Case-insensitive on purpose: accounts are created with the email exactly as
  // typed, and an operator recovering an account at 2am is reading it off a
  // ticket, not off the database.
  const user = await prisma.user.findFirst({
    where: { email: { equals: email.trim(), mode: 'insensitive' } },
    select: { id: true, email: true, mfaConfirmedAt: true, mfaSecret: true },
  });
  if (!user) return { status: 'no-such-user', email };

  const wasOn = user.mfaConfirmedAt !== null || user.mfaSecret !== null;
  await prisma.$transaction([
    prisma.mfaRecoveryCode.deleteMany({ where: { userId: user.id } }),
    prisma.user.update({
      where: { id: user.id },
      data: { mfaSecret: null, mfaConfirmedAt: null, mfaLastStep: null },
    }),
  ]);
  return { status: wasOn ? 'disabled' : 'already-off', email: user.email };
}
