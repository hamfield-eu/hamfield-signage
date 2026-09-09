-- Indexes for the T013 retention job, plus one query fix.
--
-- The three telemetry tables are only indexed on (deviceId, <timestamp>).
-- Retention deletes by age across ALL devices, and Postgres cannot use an index
-- whose leading column is absent from the predicate, so each nightly pass would
-- sequentially scan the largest tables in the database.
--
-- Plain CREATE INDEX, not CONCURRENTLY: these tables are currently ~87k and ~31k
-- rows, where the build takes milliseconds and the brief ACCESS EXCLUSIVE lock is
-- irrelevant. CONCURRENTLY cannot run inside a transaction and Prisma wraps
-- migrations in one, so if these tables ever reach the tens of millions the index
-- must be created by hand outside the migration.
CREATE INDEX "device_heartbeats_createdAt_idx" ON "device_heartbeats"("createdAt");
CREATE INDEX "device_logs_loggedAt_idx" ON "device_logs"("loggedAt");
CREATE INDEX "playback_events_occurredAt_idx" ON "playback_events"("occurredAt");

-- Unrelated to retention: playStatsFor (apps/api/src/routes/media.ts) computes
-- play counts with `WHERE mediaAssetId IN (...) AND eventType = 'start'` GROUP BY
-- mediaAssetId. The existing composite index leads with organizationId, which the
-- query does not filter on, so it cannot be used - the media library page has been
-- sequentially scanning playback_events on every load.
CREATE INDEX "playback_events_mediaAssetId_eventType_occurredAt_idx"
  ON "playback_events"("mediaAssetId", "eventType", "occurredAt");
