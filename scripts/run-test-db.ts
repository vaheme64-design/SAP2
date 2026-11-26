/**
 * =========================================================================
 * KPIMS — Isolated PostgreSQL 18.6 Test Database CLI (`kpims_test` only)
 * =========================================================================
 * Safe wrapper for applying Prisma migrations, seeding, checking migration
 * status, and running PostgreSQL integration tests exclusively against
 * `TEST_DATABASE_URL`.
 *
 * Safety invariants:
 *   1. Requires `TEST_DATABASE_URL` explicitly; NEVER falls back to
 *      `DATABASE_URL`, `.env`, or `data/kpims-db-connections*.json`.
 *   2. Fails fast unless the database name in `TEST_DATABASE_URL` is
 *      strictly `kpims_test`.
 *   3. Invokes child binaries with `shell: false` and masked logging so
 *      credentials are never exposed in terminal output.
 *   4. Passes `DATABASE_URL: validatedTestUrl` ONLY inside the Prisma CLI /
 *      seed subprocess environment; integration test subprocesses run with
 *      `DATABASE_URL=""` and `TEST_DATABASE_URL=<validatedTestUrl>`.
 * =========================================================================
 */

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_TEST_DATABASE_NAME,
  validateTestDatabaseUrl,
} from '../src/server/db/testDatabase';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = path.join(PROJECT_ROOT, 'node_modules', '.bin');

export const DEFAULT_PG_INTEGRATION_TESTS: readonly string[] = [
  'scripts/test-physical-coil-persistence.ts',
  'scripts/test-wip-snapshot-concurrency.ts',
  'scripts/test-wip-production-ledger.ts',
  'scripts/test-wip-relational-cutover.ts',
  'scripts/test-first-operation-coil-wip.ts',
  'scripts/test-inventory-http.ts',
  'scripts/test-planning-customer-orders-http.ts',
  'scripts/test-relational-planning-read-model.ts',
];

function resolveLocalBin(name: string): string {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  return path.join(BIN_DIR, `${name}${ext}`);
}

function runSubprocess(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv
): void {
  const result = spawnSync(bin, args, {
    cwd: PROJECT_ROOT,
    env,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
  if (result.signal) {
    throw new Error(`Subprocess terminated by signal ${result.signal}`);
  }
}

function usage(): string {
  return [
    'Usage: tsx scripts/run-test-db.ts <command> [args...]',
    '',
    'Commands (all require explicit TEST_DATABASE_URL targeting database "kpims_test"):',
    '  check                Validate TEST_DATABASE_URL syntax and exact "kpims_test" guard (offline)',
    '  migrate-deploy       Verify migration SQL guard, then run prisma migrate deploy against kpims_test',
    '  migrate-status       Run prisma migrate status against kpims_test',
    '  seed                 Run prisma/seed.ts against kpims_test',
    '  seed-master          Run prisma/seed-master.ts against kpims_test',
    '  test [script...]     Run PostgreSQL integration test script(s) against kpims_test (defaults to full PG suite)',
  ].join('\n');
}

function main() {
  const [, , command, ...restArgs] = process.argv;
  if (!command || command === '--help' || command === '-h') {
    console.log(usage());
    process.exit(command ? 0 : 1);
  }

  const validation = validateTestDatabaseUrl(process.env.TEST_DATABASE_URL);
  if (!validation.ok) {
    console.error(validation.error);
    process.exit(1);
  }

  const testUrl = validation.url;
  const maskedUrl = validation.maskedUrl;
  const tsxBin = resolveLocalBin('tsx');
  const prismaBin = resolveLocalBin('prisma');

  if (command === 'check') {
    console.log(
      `PASS: TEST_DATABASE_URL is valid and strictly targets "${REQUIRED_TEST_DATABASE_NAME}" (${maskedUrl}).`
    );
    return;
  }

  // Child env for Prisma CLI / seed (Prisma schema reads env("DATABASE_URL"))
  const prismaCliEnv: NodeJS.ProcessEnv = {
    ...process.env,
    TEST_DATABASE_URL: testUrl,
    DATABASE_URL: testUrl,
    KPIMS_TEST_DB_MODE: '1',
  };

  // Child env for integration tests: TEST_DATABASE_URL set, DATABASE_URL explicitly cleared
  const integrationTestEnv: NodeJS.ProcessEnv = {
    ...process.env,
    TEST_DATABASE_URL: testUrl,
    DATABASE_URL: '',
    KPIMS_TEST_DB_MODE: '1',
  };

  switch (command) {
    case 'migrate-deploy': {
      console.log(`→ Verifying Prisma migration SQL integrity before deploying to ${maskedUrl}...`);
      runSubprocess(tsxBin, ['scripts/verify-prisma-migrations.ts'], integrationTestEnv);
      console.log(`→ Running prisma migrate deploy on isolated test DB (${maskedUrl})...`);
      runSubprocess(prismaBin, ['migrate', 'deploy'], prismaCliEnv);
      console.log(`→ Verifying applied migration state & NULLS NOT DISTINCT on ${maskedUrl}...`);
      runSubprocess(tsxBin, ['scripts/verify-prisma-migrations.ts', '--check-test-db'], integrationTestEnv);
      return;
    }

    case 'migrate-status': {
      console.log(`→ Checking prisma migrate status on isolated test DB (${maskedUrl})...`);
      runSubprocess(prismaBin, ['migrate', 'status'], prismaCliEnv);
      return;
    }

    case 'seed': {
      console.log(`→ Seeding isolated test DB (${maskedUrl}) via prisma/seed.ts...`);
      runSubprocess(tsxBin, ['prisma/seed.ts'], prismaCliEnv);
      return;
    }

    case 'seed-master': {
      console.log(`→ Seeding canonical master data into isolated test DB (${maskedUrl}) via prisma/seed-master.ts...`);
      runSubprocess(tsxBin, ['prisma/seed-master.ts'], prismaCliEnv);
      return;
    }

    case 'test': {
      console.log(`→ Verifying migration SQL & isolated test DB readiness (${maskedUrl})...`);
      runSubprocess(tsxBin, ['scripts/verify-prisma-migrations.ts', '--check-test-db'], integrationTestEnv);

      const scriptsToRun = restArgs.length > 0 ? restArgs : [...DEFAULT_PG_INTEGRATION_TESTS];
      for (const scriptRelPath of scriptsToRun) {
        const resolved = path.resolve(PROJECT_ROOT, scriptRelPath);
        if (!resolved.startsWith(PROJECT_ROOT + path.sep)) {
          console.error(`SAFETY ABORT: Refusing to execute script outside workspace root: ${scriptRelPath}`);
          process.exit(1);
        }
        console.log(`\n→ Running PostgreSQL integration test: ${scriptRelPath} (${maskedUrl})`);
        runSubprocess(tsxBin, [scriptRelPath], integrationTestEnv);
      }
      console.log(`\n✅ PASS: All ${scriptsToRun.length} PostgreSQL integration test(s) succeeded against ${maskedUrl}.`);
      return;
    }

    default: {
      console.error(`Unknown command: "${command}"\n\n${usage()}`);
      process.exit(1);
    }
  }
}

main();
