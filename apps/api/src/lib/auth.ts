import * as bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { OrgRole } from '@signage/shared';
import { getEnv } from '../env';

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export interface UserJwtPayload {
  sub: string;
  email: string;
  /**
   * `User.passwordChangedAt` as epoch milliseconds at the time the token was
   * issued, or undefined if the password had never been changed. This is what
   * makes a stateless token revocable: see requireFreshCredentials.
   */
  pwdAt?: number;
}

export function signUserToken(payload: UserJwtPayload): string {
  const env = getEnv();
  return jwt.sign(
    { email: payload.email, ...(payload.pwdAt !== undefined ? { pwdAt: payload.pwdAt } : {}) },
    env.JWT_SECRET,
    {
      subject: payload.sub,
      expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    },
  );
}

export function verifyUserToken(token: string): UserJwtPayload | null {
  try {
    const decoded = jwt.verify(token, getEnv().JWT_SECRET);
    if (typeof decoded === 'string' || !decoded.sub) return null;
    const claims = decoded as jwt.JwtPayload;
    return {
      sub: decoded.sub,
      email: claims.email as string,
      pwdAt: typeof claims.pwdAt === 'number' ? claims.pwdAt : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * True when a token predates the user's most recent password change.
 *
 * Tokens issued before `passwordChangedAt` existed carry no `pwdAt` claim. Those
 * stay valid while the column is NULL (nothing has changed since the migration)
 * and are rejected the moment a password actually changes - which is exactly the
 * intent, and keeps the deploy from logging everyone out.
 */
export function tokenPredatesPasswordChange(
  claim: number | undefined,
  passwordChangedAt: Date | null,
): boolean {
  if (!passwordChangedAt) return false;
  if (claim === undefined) return true;
  // One second of slack: the JWT `iat` is second-granular and the column is
  // millisecond-granular, so a token minted in the same second as the change
  // must not invalidate itself.
  return claim + 1000 < passwordChangedAt.getTime();
}

const ROLE_RANK: Record<OrgRole, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

/** True when `actual` grants at least the privileges of `required`. */
export function roleSatisfies(actual: OrgRole, required: OrgRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}
