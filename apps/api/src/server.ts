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
  await app.register(rateLimit, {
    global: false,
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

  app.get('/health', async () => ({ status: 'ok', time: new Date().toISOString() }));

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
