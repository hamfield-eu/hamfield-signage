import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@signage/database';
import { SHOW_MESSAGE_DEFAULT_SECONDS, SHOW_MESSAGE_MAX_LENGTH } from '@signage/shared';
import { buildTestApp, call, resetDb, seedFixture, testPrisma, type Fixture } from './helpers';

/**
 * Payload validation for `show_message`.
 *
 * Every other command in the grid is a one-click action with an empty payload;
 * this one carries operator-typed text to a screen in a public space. What is
 * stored on the command row is what the device is told to do, so the row is
 * what these assertions look at.
 */
describe('show_message command', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let fx: Fixture;

  beforeAll(async () => {
    prisma = testPrisma();
    app = await buildTestApp(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    fx = await seedFixture(prisma);
  });

  const send = (payload: unknown) =>
    call(app, {
      method: 'POST',
      url: `/api/v1/orgs/${fx.a.id}/devices/${fx.a.deviceId}/commands`,
      token: fx.a.users.editor.token,
      payload: { type: 'show_message', payload },
    });

  const lastCommand = () =>
    prisma.deviceCommand.findFirstOrThrow({
      where: { deviceId: fx.a.deviceId, type: 'show_message' },
      orderBy: { createdAt: 'desc' },
    });

  it('stores the text and defaults the duration', async () => {
    const res = await send({ text: 'Closing at 4pm today' });
    expect(res.statusCode).toBe(201);

    // The stored payload is normalized, not merely echoed: the device reads
    // this row over the polling fallback, where nothing else fills a default in.
    expect((await lastCommand()).payload).toEqual({
      text: 'Closing at 4pm today',
      durationSeconds: SHOW_MESSAGE_DEFAULT_SECONDS,
    });
  });

  it('keeps an explicit duration', async () => {
    expect((await send({ text: 'Back in 5', durationSeconds: 60 })).statusCode).toBe(201);
    expect((await lastCommand()).payload).toMatchObject({ durationSeconds: 60 });
  });

  it('trims surrounding whitespace', async () => {
    await send({ text: '  Staff meeting at 3  ' });
    expect((await lastCommand()).payload).toMatchObject({ text: 'Staff meeting at 3' });
  });

  it('rejects an empty or whitespace-only message', async () => {
    for (const text of ['', '   ', '\n\t']) {
      expect((await send({ text })).statusCode).toBe(400);
    }
    expect((await send({})).statusCode).toBe(400);
    expect(await prisma.deviceCommand.count({ where: { type: 'show_message' } })).toBe(0);
  });

  it('rejects a message too long to read on a screen', async () => {
    expect((await send({ text: 'a'.repeat(SHOW_MESSAGE_MAX_LENGTH) })).statusCode).toBe(201);
    expect((await send({ text: 'a'.repeat(SHOW_MESSAGE_MAX_LENGTH + 1) })).statusCode).toBe(400);
  });

  it('refuses a duration that would take the screen out of service', async () => {
    // The overlay covers the playlist while it is up, so a typo'd duration is
    // an outage. Anything genuinely long-lived is an emergency override.
    expect((await send({ text: 'ok', durationSeconds: 300 })).statusCode).toBe(201);
    expect((await send({ text: 'ok', durationSeconds: 86_400 })).statusCode).toBe(400);
    expect((await send({ text: 'ok', durationSeconds: 0 })).statusCode).toBe(400);
    expect((await send({ text: 'ok', durationSeconds: -5 })).statusCode).toBe(400);
    expect((await send({ text: 'ok', durationSeconds: 1.5 })).statusCode).toBe(400);
  });

  it('records the message in the audit log', async () => {
    await send({ text: 'Fire drill at noon' });
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'device.command' },
      orderBy: { createdAt: 'desc' },
    });
    // Operator text is deliberately audited: who put what on a public screen is
    // the question this log exists to answer.
    expect(entry.metadata).toMatchObject({
      type: 'show_message',
      payload: { text: 'Fire drill at noon' },
    });
  });

  it('still refuses a viewer, like every other command', async () => {
    const res = await call(app, {
      method: 'POST',
      url: `/api/v1/orgs/${fx.a.id}/devices/${fx.a.deviceId}/commands`,
      token: fx.a.users.viewer.token,
      payload: { type: 'show_message', payload: { text: 'nope' } },
    });
    expect(res.statusCode).toBe(403);
  });
});
