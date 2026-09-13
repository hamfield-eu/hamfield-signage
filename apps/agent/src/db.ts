import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { SyncManifest, CachedMediaEntry } from '@signage/sync-protocol';

export interface BufferedLog {
  id: number;
  level: string;
  message: string;
  context: string | null;
  loggedAt: string;
}

export interface BufferedEvent {
  id: number;
  eventType: string;
  mediaAssetId: string | null;
  playlistId: string | null;
  /** Generated when buffering; lets the backend deduplicate resubmissions. */
  clientEventId: string | null;
  playedAs: string | null;
  priorityRuleId: string | null;
  durationSeconds: number | null;
  detail: string | null;
  occurredAt: string;
}

/**
 * Local device state: the last applied manifest, the media cache index and
 * offline buffers for logs/playback events. All writes that must be atomic
 * (manifest apply) run inside a SQLite transaction.
 */
export class AgentDb {
  private db: Database.Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, 'state.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS media_cache (
        media_id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        downloaded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS log_buffer (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        context TEXT,
        logged_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event_buffer (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        media_asset_id TEXT,
        playlist_id TEXT,
        detail TEXT,
        occurred_at TEXT NOT NULL
      );
    `);
    this.migrateEventBuffer();
    this.migrateMediaCache();
  }

  /** Adds T017 integrity/LRU columns to databases created by older agents. */
  private migrateMediaCache(): void {
    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(media_cache)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    // Both stay nullable: a null means "never verified" / "never played", which
    // is exactly right for rows that predate this migration and makes them the
    // first candidates for verification and for eviction.
    for (const [name, type] of [
      ['last_verified_at', 'TEXT'],
      ['last_used_at', 'TEXT'],
    ] as Array<[string, string]>) {
      if (!columns.has(name)) {
        this.db.exec(`ALTER TABLE media_cache ADD COLUMN ${name} ${type}`);
      }
    }
  }

  /** Adds v2 event columns to databases created by older agent versions. */
  private migrateEventBuffer(): void {
    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(event_buffer)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    const wanted: Array<[string, string]> = [
      ['client_event_id', 'TEXT'],
      ['played_as', 'TEXT'],
      ['priority_rule_id', 'TEXT'],
      ['duration_seconds', 'REAL'],
    ];
    for (const [name, type] of wanted) {
      if (!columns.has(name)) {
        this.db.exec(`ALTER TABLE event_buffer ADD COLUMN ${name} ${type}`);
      }
    }
  }

  // ---------- kv ----------

  getValue(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setValue(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  deleteValue(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  getManifest(): SyncManifest | null {
    const raw = this.getValue('manifest');
    return raw ? (JSON.parse(raw) as SyncManifest) : null;
  }

  getManifestVersion(): string | null {
    return this.getManifest()?.version ?? null;
  }

  // ---------- media cache ----------

  listCachedMedia(): (CachedMediaEntry & { filePath: string })[] {
    const rows = this.db.prepare('SELECT * FROM media_cache').all() as Array<{
      media_id: string;
      checksum: string;
      size_bytes: number;
      file_path: string;
    }>;
    return rows.map((r) => ({
      mediaId: r.media_id,
      checksum: r.checksum,
      sizeBytes: r.size_bytes,
      filePath: r.file_path,
    }));
  }

  /** The cache index with the columns integrity and eviction need. */
  listCacheDetail(): Array<{
    mediaId: string;
    checksum: string;
    sizeBytes: number;
    filePath: string;
    downloadedAt: string | null;
    lastVerifiedAt: string | null;
    lastUsedAt: string | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT media_id, checksum, size_bytes, file_path, downloaded_at,
                last_verified_at, last_used_at
         FROM media_cache`,
      )
      .all() as Array<{
      media_id: string;
      checksum: string;
      size_bytes: number;
      file_path: string;
      downloaded_at: string | null;
      last_verified_at: string | null;
      last_used_at: string | null;
    }>;
    return rows.map((r) => ({
      mediaId: r.media_id,
      checksum: r.checksum,
      sizeBytes: r.size_bytes,
      filePath: r.file_path,
      downloadedAt: r.downloaded_at,
      lastVerifiedAt: r.last_verified_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  cachedFileCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM media_cache').get() as { n: number };
    return row.n;
  }

  /**
   * Records that the player actually read this file, which is what makes the
   * eviction order a real LRU rather than "oldest download".
   */
  touchCacheUse(mediaId: string): void {
    this.db
      .prepare('UPDATE media_cache SET last_used_at = ? WHERE media_id = ?')
      .run(new Date().toISOString(), mediaId);
  }

  markVerified(mediaIds: string[], at = new Date().toISOString()): void {
    const stmt = this.db.prepare('UPDATE media_cache SET last_verified_at = ? WHERE media_id = ?');
    this.db.transaction(() => mediaIds.forEach((id) => stmt.run(at, id)))();
  }

  /**
   * Drops cache index rows without touching the stored manifest.
   *
   * Used for repair and eviction. Removing the row is what makes `diffManifest`
   * put the media back in `toDownload` — the file is then re-fetched through
   * the ordinary download path, checksum verification and all.
   */
  removeCacheEntries(mediaIds: string[]): void {
    const stmt = this.db.prepare('DELETE FROM media_cache WHERE media_id = ?');
    this.db.transaction(() => mediaIds.forEach((id) => stmt.run(id)))();
  }

  getCachedMedia(mediaId: string): { filePath: string; mimeType: string } | null {
    const row = this.db
      .prepare('SELECT file_path, mime_type FROM media_cache WHERE media_id = ?')
      .get(mediaId) as { file_path: string; mime_type: string } | undefined;
    return row ? { filePath: row.file_path, mimeType: row.mime_type } : null;
  }

  cacheUsedBytes(): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM media_cache')
      .get() as {
      total: number;
    };
    return row.total;
  }

  /**
   * Atomically applies a synced manifest: stores it and replaces the cache
   * index. Files themselves are written before and deleted after this commit,
   * so a crash can leave orphan files but never a broken index.
   */
  applyManifest(
    manifest: SyncManifest,
    upserts: Array<{
      mediaId: string;
      checksum: string;
      sizeBytes: number;
      mimeType: string;
      filePath: string;
    }>,
    deleteMediaIds: string[],
  ): void {
    const upsert = this.db.prepare(`
      INSERT INTO media_cache (media_id, checksum, size_bytes, mime_type, file_path, downloaded_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(media_id) DO UPDATE SET
        checksum = excluded.checksum,
        size_bytes = excluded.size_bytes,
        mime_type = excluded.mime_type,
        file_path = excluded.file_path,
        downloaded_at = excluded.downloaded_at
    `);
    const remove = this.db.prepare('DELETE FROM media_cache WHERE media_id = ?');

    this.db.transaction(() => {
      this.setValue('manifest', JSON.stringify(manifest));
      this.setValue('manifestAppliedAt', new Date().toISOString());
      const now = new Date().toISOString();
      for (const u of upserts) {
        upsert.run(u.mediaId, u.checksum, u.sizeBytes, u.mimeType, u.filePath, now);
      }
      for (const id of deleteMediaIds) remove.run(id);
    })();
  }

  clearCache(): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM media_cache').run();
      this.deleteValue('manifest');
      this.deleteValue('manifestAppliedAt');
    })();
  }

  // ---------- offline buffers ----------

  bufferLog(level: string, message: string, context?: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO log_buffer (level, message, context, logged_at) VALUES (?, ?, ?, ?)')
      .run(
        level,
        message.slice(0, 4000),
        context ? JSON.stringify(context) : null,
        new Date().toISOString(),
      );
    // Bound the buffer so long offline periods cannot fill the disk.
    this.db.exec(
      'DELETE FROM log_buffer WHERE id NOT IN (SELECT id FROM log_buffer ORDER BY id DESC LIMIT 5000)',
    );
  }

  takeLogs(limit: number): BufferedLog[] {
    return this.db
      .prepare(
        'SELECT id, level, message, context, logged_at AS loggedAt FROM log_buffer ORDER BY id ASC LIMIT ?',
      )
      .all(limit) as BufferedLog[];
  }

  deleteLogs(ids: number[]): void {
    const stmt = this.db.prepare('DELETE FROM log_buffer WHERE id = ?');
    this.db.transaction(() => ids.forEach((id) => stmt.run(id)))();
  }

  bufferEvent(event: {
    eventType: string;
    mediaAssetId: string | null;
    playlistId: string | null;
    clientEventId?: string | null;
    playedAs?: string | null;
    priorityRuleId?: string | null;
    durationSeconds?: number | null;
    detail?: Record<string, unknown>;
    occurredAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO event_buffer
           (event_type, media_asset_id, playlist_id, client_event_id, played_as, priority_rule_id, duration_seconds, detail, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventType,
        event.mediaAssetId,
        event.playlistId,
        event.clientEventId ?? null,
        event.playedAs ?? null,
        event.priorityRuleId ?? null,
        event.durationSeconds ?? null,
        event.detail ? JSON.stringify(event.detail) : null,
        event.occurredAt,
      );
    this.db.exec(
      'DELETE FROM event_buffer WHERE id NOT IN (SELECT id FROM event_buffer ORDER BY id DESC LIMIT 5000)',
    );
  }

  takeEvents(limit: number): BufferedEvent[] {
    return this.db
      .prepare(
        `SELECT id, event_type AS eventType, media_asset_id AS mediaAssetId, playlist_id AS playlistId,
                client_event_id AS clientEventId, played_as AS playedAs, priority_rule_id AS priorityRuleId,
                duration_seconds AS durationSeconds, detail, occurred_at AS occurredAt
         FROM event_buffer ORDER BY id ASC LIMIT ?`,
      )
      .all(limit) as BufferedEvent[];
  }

  deleteEvents(ids: number[]): void {
    const stmt = this.db.prepare('DELETE FROM event_buffer WHERE id = ?');
    this.db.transaction(() => ids.forEach((id) => stmt.run(id)))();
  }

  close(): void {
    this.db.close();
  }
}
