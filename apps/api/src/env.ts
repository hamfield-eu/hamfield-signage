import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().default(4000),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  DATABASE_URL: z.string().min(1).default('postgresql://signage:signage@localhost:5432/signage'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(16).default('dev-only-secret-do-not-use-in-production'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  // Which upstream addresses may set X-Forwarded-For. See trustProxy() below for
  // why this is an address list and not a hop count.
  TRUST_PROXY: z.string().default('loopback, uniquelocal'),
  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('signage-media'),
  S3_ACCESS_KEY: z.string().default('signage'),
  S3_SECRET_KEY: z.string().default('signage-secret'),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  MAX_UPLOAD_SIZE_BYTES: z.coerce
    .number()
    .int()
    .default(1024 * 1024 * 1024),
  PAIRING_CODE_TTL_MINUTES: z.coerce.number().int().default(15),
  // Install-time superadmin bootstrap (all three must be set to take effect).
  // Empty strings (e.g. compose defaults) are treated as unset.
  INITIAL_SUPERADMIN_EMAIL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().email().optional(),
  ),
  INITIAL_SUPERADMIN_PASSWORD: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().optional(),
  ),
  INITIAL_SUPERADMIN_NAME: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (!cached) {
    cached = envSchema.parse(process.env);
    if (cached.NODE_ENV === 'production' && cached.JWT_SECRET.startsWith('dev-only-secret')) {
      throw new Error('JWT_SECRET must be set to a strong value in production');
    }
  }
  return cached;
}

/**
 * Value for Fastify's `trustProxy`, deciding which upstreams may set
 * `X-Forwarded-For` and therefore what `req.ip` is. `req.ip` keys every rate
 * limit and is recorded in the audit log, so getting this wrong is a security
 * bug in both directions: too trusting and a client can forge it, too strict and
 * every user shares the reverse proxy's address.
 *
 * The default trusts loopback plus the RFC1918 ranges Docker allocates from
 * (10/8, 172.16/12, 192.168/16). Measured against the real
 * caddy -> nginx -> api chain, an ADDRESS list is strictly better than the hop
 * count the task file suggested:
 *
 *                       via caddy   caddy bypassed   extra hop injected
 *   trustProxy: true    correct     SPOOFABLE        SPOOFABLE
 *   trustProxy: 2       correct     SPOOFABLE        correct
 *   this default        correct     correct          correct
 *
 * A hop count trusts positions, so shifting the chain by one shifts which entry
 * is believed. An address list walks left to the first address that is not one
 * of our own proxies - which is always the real peer, whatever the chain length.
 *
 * Accepts: a comma-separated list of CIDRs and/or the names `loopback`,
 * `linklocal`, `uniquelocal`; a plain number (hop count); or `false` to use the
 * socket address only. `true` (trust everything) is deliberately NOT special
 * cased - spell out the ranges instead.
 */
export function trustProxy(): string | number | false {
  const raw = getEnv().TRUST_PROXY.trim();
  if (raw === '' || raw.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

export function corsOrigins(): string[] {
  return getEnv()
    .CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
