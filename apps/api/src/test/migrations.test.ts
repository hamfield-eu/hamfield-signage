import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, inject, it } from 'vitest';

const databasePackage = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/database',
);

/**
 * Migration drift.
 *
 * Six migrations existed and nothing checked that replaying them produces the
 * schema in `schema.prisma`. Editing the schema without generating a migration
 * is an easy mistake, and the symptom appears at deploy time on production —
 * where migrations are forward-only and the rollback is restore-from-backup.
 *
 * The global setup already ran `prisma migrate deploy` from scratch against
 * this database, so the chain applying cleanly is proven by the suite existing
 * at all. This asserts the other half: that the result matches the model.
 */
describe('database migrations', () => {
  it('replaying every migration reproduces schema.prisma exactly', () => {
    // --exit-code: 0 when the diff is empty, 2 when it is not.
    const run = () =>
      execFileSync(
        'pnpm',
        [
          'exec',
          'prisma',
          'migrate',
          'diff',
          '--from-url',
          inject('databaseUrl'),
          '--to-schema-datamodel',
          'prisma/schema.prisma',
          '--exit-code',
        ],
        { cwd: databasePackage, env: process.env, encoding: 'utf8' },
      );

    let output = '';
    let code = 0;
    try {
      output = run();
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      code = e.status ?? 1;
      output = e.stdout ?? '';
    }

    expect(
      { code, output },
      'schema.prisma has changes with no migration to produce them — run `pnpm db:migrate:dev`',
    ).toMatchObject({ code: 0 });
  });

  it('applied the full chain, not a shortcut', async () => {
    // `db push` would produce the same tables with no history. If this row
    // count ever collapses to zero, the harness stopped testing migrations.
    const { PrismaClient } = await import('@signage/database');
    const prisma = new PrismaClient({ datasources: { db: { url: inject('databaseUrl') } } });
    try {
      const rows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
        SELECT migration_name FROM _prisma_migrations
        WHERE finished_at IS NOT NULL ORDER BY migration_name
      `;
      expect(rows.length).toBeGreaterThanOrEqual(9);
      expect(rows.map((r) => r.migration_name)).toContain('20260910190000_device_storage_guard');
    } finally {
      await prisma.$disconnect();
    }
  });
});
