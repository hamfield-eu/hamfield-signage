import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import type { PrismaClient } from '@signage/database';
import { getPrisma } from '@signage/database';
import { corsOrigins, getEnv, trustProxy } from './env';
import { HttpError } from './lib/errors';
import { WsHub } from './lib/ws-hub';
import { makeDeviceAuth } from './plugins/auth';
import { hashDeviceToken } from './lib/tokens';
import { readyReport } from './lib/health';
import { authRoutes } from './routes/auth';
import { orgRoutes } from './routes/orgs';
import { deviceRoutes } from './routes/devices';
import { deviceGroupRoutes } from './routes/device-groups';
import { mediaRoutes } from './routes/media';
import { mediaFolderRoutes } from './routes/media-folders';
import { playlistRoutes } from './routes/playlists';
import { priorityRuleRoutes } from './routes/priority-rules';
import { scheduleRoutes } from './routes/schedules';
import { emergencyRoutes } from './routes/emergency';
import { deviceApiRoutes } from './routes/device-api';
import { deviceWsRoutes } from './routes/device-ws';
import { superadminRoutes } from './routes/superadmin';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    wsHub: WsHub;
    deviceAuth: ReturnType<typeof makeDeviceAuth>;
  }
}

export interface BuildServerOptions {
  prisma?: PrismaClient;
  logger?: boolean;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const env = getEnv();
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: env.NODE_ENV === 'production' ? 'info' : 'debug',
            transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
          },
    bodyLimit: 10 * 1024 * 1024, // JSON bodies (screenshots use base64, capped here)
    // NOT `true`. Trusting every hop means the leftmost X-Forwarded-For entry
    // wins, and nginx appends rather than replaces ($proxy_add_x_forwarded_for),
    // so anything that reaches nginx without passing Caddy first can dictate
    // req.ip - which keys the login/pairing rate limits and is written to the
    // audit log. See trustProxy() in ./env for the measurements.
    trustProxy: trustProxy(),
  });

  const prisma = options.prisma ?? getPrisma();
  app.decorate('prisma', prisma);
  app.decorate('wsHub', new WsHub(app.log));
  app.decorate('deviceAuth', makeDeviceAuth(prisma));

  await app.register(cors, {
    origin: corsOrigins(),
    credentials: false,
  });
  // Rate limiting is GLOBAL. It used to be opt-in, which left /device/heartbeat,
  // /device/logs, /device/playback-events and every /orgs/* route unlimited - one
  // compromised device token could write unbounded telemetry rows. The tight
  // per-route overrides (login 10/min, change-password 5/min, pair 10/min) still
  // apply on top of this default.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // Device routes must NOT be keyed by IP: a site of twenty screens behind one
    // NAT shares an address and would throttle each other. Key them by the
    // device's own token instead.
    //
    // The token is hashed, both because the raw value must not become a cache
    // key and because that hash is already how tokens are stored. This runs on
    // the onRequest hook, BEFORE the device-auth preHandler sets req.device, so
    // the key is derived from the header directly rather than from req.device -
    // which would be undefined here.
    keyGenerator: (req) => {
      const url = req.routeOptions?.url ?? req.url;
      if (url.startsWith('/api/v1/device')) {
        const header = req.headers.authorization;
        const queryToken = (req.query as Record<string, unknown> | undefined)?.token;
        const raw = header?.startsWith('Bearer ')
          ? header.slice(7)
          : typeof queryToken === 'string'
            ? queryToken
            : null;
        // An unauthenticated device request (including /device/pair, which has no
        // token yet) falls through to the IP key.
        if (raw) return `device:${hashDeviceToken(raw)}`;
      }
      return req.ip;
    },
  });
  await app.register(multipart, {
    limits: { fileSize: env.MAX_UPLOAD_SIZE_BYTES, files: 1 },
  });
  await app.register(websocket, {
    options: { maxPayload: 1024 * 1024 },
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({
        statusCode: err.statusCode,
        error: err.statusCode === 400 ? 'Bad Request' : err.message,
        message: err.message,
      });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Validation Error',
        message: err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
      });
    }
    const anyErr = err as { statusCode?: number; message?: string; name?: string };
    if (anyErr.statusCode && anyErr.statusCode < 500) {
      return reply.status(anyErr.statusCode).send({
        statusCode: anyErr.statusCode,
        error: anyErr.name ?? 'Error',
        message: anyErr.message ?? 'Request failed',
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal server error',
    });
  });

  // Liveness probe. Explicitly exempt from the global rate limit: the container
  // healthcheck and any uptime monitor poll this, and a 429 here would report a
  // healthy API as unhealthy.
  app.get('/health', { config: { rateLimit: false } }, async () => ({
    status: 'ok',
    time: new Date().toISOString(),
  }));

  // Deep readiness. Registered OUTSIDE the /api/v1 prefix on purpose, which means
  // infra/docker/web-nginx.conf does not proxy it: that file proxies `/api/` and
  // an EXACT `= /health`, so this is reachable only from inside the Docker
  // network. That is deliberate - it names each dependency and its latency, which
  // is a diagnostic surface, not a public one. Reach it with:
  //   docker compose exec api node -e "fetch('http://127.0.0.1:4000/health/ready').then(r=>r.text()).then(console.log)"
  //
  // 503 when a hard dependency is down so it is scriptable; 200 when merely
  // degraded, because degraded still serves traffic.
  app.get('/health/ready', async (_req, reply) => {
    const report = await readyReport(prisma);
    return reply.status(report.status === 'down' ? 503 : 200).send(report);
  });

  await app.register(authRoutes, { prefix: '/api/v1' });
  await app.register(orgRoutes, { prefix: '/api/v1' });
  await app.register(deviceRoutes, { prefix: '/api/v1' });
  await app.register(deviceGroupRoutes, { prefix: '/api/v1' });
  await app.register(mediaRoutes, { prefix: '/api/v1' });
  await app.register(mediaFolderRoutes, { prefix: '/api/v1' });
  await app.register(playlistRoutes, { prefix: '/api/v1' });
  await app.register(priorityRuleRoutes, { prefix: '/api/v1' });
  await app.register(scheduleRoutes, { prefix: '/api/v1' });
  await app.register(emergencyRoutes, { prefix: '/api/v1' });
  await app.register(deviceApiRoutes, { prefix: '/api/v1' });
  await app.register(deviceWsRoutes, { prefix: '/api/v1' });
  await app.register(superadminRoutes, { prefix: '/api/v1' });

  return app;
}
