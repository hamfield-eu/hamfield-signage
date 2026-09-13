-- Device cache integrity and disk guard (T017).
-- Additive only: one new enum value and four nullable columns. No data is
-- rewritten, and an agent that predates this release simply never sends the
-- new values, so a rollback to the previous application image is safe.

-- A device that cannot fit its playlist is NOT a generic sync error: it is the
-- one sync failure an operator can act on, and it needs a different action
-- (smaller playlist, bigger disk) from "something went wrong".
--
-- `ADD VALUE` is safe inside the transaction Prisma wraps this migration in
-- only because nothing here USES the new value — same shape as
-- 20260624000000_per_device_encoding_tiers, which is already applied in
-- production. Do not add a statement below that references it.
ALTER TYPE "SyncStatusValue" ADD VALUE IF NOT EXISTS 'insufficient_storage';

-- Storage accounting reported by the agent, so the dashboard can state the
-- shortfall in plain language instead of showing a bare status.
ALTER TABLE "devices" ADD COLUMN "cacheBudgetBytes" BIGINT;
ALTER TABLE "devices" ADD COLUMN "storageShortfallBytes" BIGINT;
ALTER TABLE "devices" ADD COLUMN "cachedFileCount" INTEGER;
ALTER TABLE "devices" ADD COLUMN "lastIntegrityCheckAt" TIMESTAMP(3);
