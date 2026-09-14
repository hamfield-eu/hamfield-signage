-- Local (TOTP) multi-factor authentication for dashboard accounts.
--
-- Everything here is additive and nullable, so the deploy neither logs anyone
-- out nor turns MFA on for anyone: an account has MFA only once it has proved
-- it can generate a code, which is what "mfaConfirmedAt" records. A secret that
-- was written but never confirmed (abandoned enrollment) is inert.
--
-- There is deliberately no email/SMS path, so the only way back into an account
-- whose authenticator is gone is a recovery code or the server-side CLI
-- (`node dist/cli/disable-mfa.js <email>`), which only NULLs these columns.
ALTER TABLE "users" ADD COLUMN "mfaSecret" TEXT;
ALTER TABLE "users" ADD COLUMN "mfaConfirmedAt" TIMESTAMP(3);
-- The last accepted 30-second TOTP step. Without it a code stays replayable for
-- the rest of its window, which is up to 30s of a shoulder-surfed login.
ALTER TABLE "users" ADD COLUMN "mfaLastStep" INTEGER;

CREATE TABLE "mfa_recovery_codes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mfa_recovery_codes_codeHash_key" ON "mfa_recovery_codes"("codeHash");
CREATE INDEX "mfa_recovery_codes_userId_idx" ON "mfa_recovery_codes"("userId");

ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
