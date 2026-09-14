import { randomBytes } from 'node:crypto';
import { CHANNEL_PREFIX, getRedisPub } from './redis';

/**
 * The short-lived server-side handle between "password accepted" and "second
 * factor accepted".
 *
 * It is deliberately NOT a JWT. A JWT minted by `signUserToken` is accepted by
 * `authenticateUser` verbatim, so a half-authenticated token would *be* a
 * session — an extra `purpose` claim only helps while every future verifier
 * remembers to check it. An opaque id in Redis cannot be mistaken for a session
 * by any code path, is single-use for free, and expires on its own.
 */
const KEY_PREFIX = `${CHANNEL_PREFIX}:mfa:challenge:`;

/** Long enough that guessing an id is not a strategy. */
export const CHALLENGE_TTL_SECONDS = 300;
/** Attempts per challenge before it is destroyed and the user starts over. */
export const MAX_CHALLENGE_ATTEMPTS = 5;

export interface MfaChallenge {
  id: string;
  userId: string;
  attempts: number;
}

const key = (id: string) => `${KEY_PREFIX}${id}`;

export async function createMfaChallenge(userId: string): Promise<MfaChallenge> {
  const id = randomBytes(32).toString('hex');
  const challenge: MfaChallenge = { id, userId, attempts: 0 };
  await getRedisPub().set(
    key(id),
    JSON.stringify({ userId, attempts: 0 }),
    'EX',
    CHALLENGE_TTL_SECONDS,
  );
  return challenge;
}

export async function readMfaChallenge(id: string): Promise<MfaChallenge | null> {
  if (!/^[0-9a-f]{64}$/.test(id)) return null;
  const raw = await getRedisPub().get(key(id));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { userId?: unknown; attempts?: unknown };
    if (typeof parsed.userId !== 'string') return null;
    return {
      id,
      userId: parsed.userId,
      attempts: typeof parsed.attempts === 'number' ? parsed.attempts : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Charges one failed attempt. Returns the attempts used so far; at
 * MAX_CHALLENGE_ATTEMPTS the challenge is deleted, so a six-digit code cannot be
 * ground down. Route-level rate limiting is not enough on its own here: it is
 * keyed by IP, and the search space is only a million.
 *
 * The TTL is preserved rather than refreshed — a challenge gets five attempts
 * *and* five minutes, never a rolling window.
 */
export async function recordFailedAttempt(challenge: MfaChallenge): Promise<number> {
  const redis = getRedisPub();
  const attempts = challenge.attempts + 1;
  if (attempts >= MAX_CHALLENGE_ATTEMPTS) {
    await redis.del(key(challenge.id));
    return attempts;
  }
  const ttl = await redis.ttl(key(challenge.id));
  await redis.set(
    key(challenge.id),
    JSON.stringify({ userId: challenge.userId, attempts }),
    'EX',
    ttl > 0 ? ttl : CHALLENGE_TTL_SECONDS,
  );
  return attempts;
}

/** Consumes a challenge — called the moment it succeeds, so it is single-use. */
export async function consumeMfaChallenge(id: string): Promise<void> {
  await getRedisPub().del(key(id));
}
