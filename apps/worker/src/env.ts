import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1).default('postgresql://signage:signage@localhost:5432/signage'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('signage-media'),
  S3_ACCESS_KEY: z.string().default('signage'),
  S3_SECRET_KEY: z.string().default('signage-secret'),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  MAX_VIDEO_HEIGHT: z.coerce.number().int().min(240).default(1080),
  // Cap output fps so the H.264 level matches the stream; 30 is safe for every
  // current player (ARM SBC hardware decoders choke on 1080p50/60).
  MAX_VIDEO_FPS: z.coerce.number().int().min(1).max(120).default(30),
  VIDEO_BITRATE_KBPS: z.coerce.number().int().min(250).default(6000),
  FALLBACK_VIDEO_BITRATE_KBPS: z.coerce.number().int().min(250).default(2000),
  CREATE_FALLBACK_VARIANT: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  THUMBNAIL_MAX_DIMENSION: z.coerce.number().int().min(64).default(480),

  // ── Telemetry retention (T013) ────────────────────────────────────────────
  // This job DELETES production rows. It defaults to a dry run, and stays a dry
  // run until someone deliberately sets this to "false".
  RETENTION_DRY_RUN: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  RETENTION_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  // 03:00 UTC, half an hour before the backup at 03:30 so a destructive run is
  // always followed by a fresh backup rather than preceding one by a whole day.
  RETENTION_CRON: z.string().default('0 3 * * *'),
  RETENTION_HEARTBEAT_DAYS: z.coerce.number().int().min(1).default(14),
  RETENTION_DEVICE_LOG_DAYS: z.coerce.number().int().min(1).default(30),
  // Longer than the others on purpose: playback_events back the proof-of-play and
  // play-count features (playStatsFor in apps/api/src/routes/media.ts), so pruning
  // them silently changes numbers customers may have already been shown.
  RETENTION_PLAYBACK_EVENT_DAYS: z.coerce.number().int().min(1).default(90),
  RETENTION_BATCH_SIZE: z.coerce.number().int().min(100).max(50_000).default(5_000),
  RETENTION_MAX_BATCHES: z.coerce.number().int().min(1).default(40),
  // A destructive run is refused if no successful backup is newer than this.
  // Fails closed: an absent marker also refuses.
  RETENTION_REQUIRE_BACKUP_WITHIN_HOURS: z.coerce.number().int().min(1).default(36),

  // ── Alerting (T013) ───────────────────────────────────────────────────────
  // Off unless a destination is configured: an alerting system nobody receives is
  // worse than none, because it looks like coverage.
  ALERT_NTFY_URL: z.string().default(''),
  ALERT_NTFY_TOKEN: z.string().default(''),
  ALERT_CRON: z.string().default('*/5 * * * *'),
  // An override left on blanks a customer's screens; 4h is long enough not to
  // fire during a genuine incident and short enough to catch a forgotten one.
  ALERT_EMERGENCY_HOURS: z.coerce.number().int().min(1).default(4),
  // OFFLINE_THRESHOLD_SECONDS is 90s; 15 minutes avoids paging on a reboot.
  ALERT_OFFLINE_MINUTES: z.coerce.number().int().min(1).default(15),
  ALERT_QUEUE_WAITING: z.coerce.number().int().min(1).default(20),
  // A firing alert repeats at most this often. Re-sending every evaluation trains
  // people to ignore the channel.
  ALERT_REPEAT_HOURS: z.coerce.number().int().min(1).default(6),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (!cached) cached = envSchema.parse(process.env);
  return cached;
}
