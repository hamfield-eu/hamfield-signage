/**
 * Turns two-factor authentication off for one account, from the server.
 *
 * This is the deployment's entire account-recovery path: there is no outbound
 * email, so a user who has lost both their authenticator and their recovery
 * codes can only be helped by someone with shell access to the API host. It
 * clears the MFA columns and nothing else — the password is untouched, and the
 * user can re-enroll from Settings afterwards.
 *
 * Usage (development):
 *   pnpm app:disable-mfa -- <email>
 *
 * Usage (production — tsx is not installed in the image, so call node directly;
 * the container's WORKDIR is the repository root):
 *   docker compose exec api node apps/api/dist/cli/disable-mfa.js <email>
 */
import { getPrisma, disconnectPrisma } from '@signage/database';
import { disableMfaForUser } from '../lib/mfa';

async function main(): Promise<void> {
  const [email] = process.argv.slice(2);
  if (!email) {
    console.error('Usage: pnpm app:disable-mfa -- <email>');
    console.error('   or: node apps/api/dist/cli/disable-mfa.js <email>');
    process.exitCode = 1;
    return;
  }

  const result = await disableMfaForUser(getPrisma(), email);
  switch (result.status) {
    case 'disabled':
      console.log(`Two-factor authentication disabled for ${result.email}.`);
      console.log('Recovery codes were deleted. The user can re-enroll from Settings.');
      break;
    case 'already-off':
      console.log(`Two-factor authentication was already off for ${result.email}. Nothing to do.`);
      break;
    case 'no-such-user':
      // A wrong address must not read as success to a half-awake operator.
      console.error(`No account exists with email ${result.email}`);
      process.exitCode = 1;
      break;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
