/**
 * =========================================================================
 * KPIMS — Offline Safety Guard Unit Tests for Isolated PostgreSQL Test DB
 * =========================================================================
 * Verifies all fail-fast TEST_DATABASE_URL safety guards WITHOUT connecting
 * to or modifying any PostgreSQL database.
 *
 * Run with: npx tsx scripts/test-database-guard.ts
 * =========================================================================
 */

import assert from 'node:assert/strict';
import {
  REQUIRED_TEST_DATABASE_NAME,
  clearTestDatabaseOverride,
  extractPostgresDatabaseName,
  requireTestDatabaseUrl,
  validateTestDatabaseUrl,
} from '../src/server/db/testDatabase';
import {
  getExplicitTestDatabaseUrlOverride,
  setExplicitTestDatabaseUrlOverride,
} from '../src/server/db/prisma';

function run() {
  console.log('--- Testing TEST_DATABASE_URL Fail-Fast Safety Guards (Offline) ---');

  assert.equal(REQUIRED_TEST_DATABASE_NAME, 'kpims_test');

  // 1. Missing TEST_DATABASE_URL must ALWAYS fail — even when DATABASE_URL is set to kpims_test!
  const envWithOnlyDatabaseUrl: NodeJS.ProcessEnv = {
    DATABASE_URL: 'postgresql://postgres:secret@localhost:5432/kpims_test?schema=public',
  };
  assert.throws(
    () => requireTestDatabaseUrl(envWithOnlyDatabaseUrl),
    /TEST_DATABASE_URL is not set.*NEVER fall back to DATABASE_URL/i,
    'Must NEVER fall back to DATABASE_URL when TEST_DATABASE_URL is unset'
  );

  // 2. Empty / whitespace TEST_DATABASE_URL must fail
  assert.equal(validateTestDatabaseUrl('').ok, false);
  assert.equal(validateTestDatabaseUrl('   ').ok, false);

  // 3. Reject every database name that is not strictly "kpims_test"
  const forbiddenUrls = [
    'postgresql://postgres:secret@localhost:5432/kpims_db?schema=public',
    'postgresql://postgres:secret@localhost:5432/kpims_prod',
    'postgresql://postgres:secret@localhost:5432/postgres',
    'postgresql://postgres:secret@localhost:5432/kpims_test_2',
    'postgresql://postgres:secret@localhost:5432/kpims_test2',
    'postgresql://postgres:secret@localhost:5432/my_kpims_test',
    'postgresql://postgres:secret@localhost:5432/KPIMS_TEST',
    'postgresql://postgres:secret@localhost:5432/kpims_test/extra',
    'postgresql://postgres:secret@localhost:5432/',
    'postgresql://postgres:secret@localhost:5432',
    'mysql://root:secret@localhost:3306/kpims_test',
    'http://localhost:5432/kpims_test',
    'postgresql://postgres:****@localhost:5432/kpims_test',
    'postgresql://your_user:secret@localhost:5432/kpims_test',
    'postgresql://postgres:secret@your_host:5432/kpims_test',
  ];

  for (const badUrl of forbiddenUrls) {
    const res = validateTestDatabaseUrl(badUrl);
    assert.equal(res.ok, false, `Expected safety guard to reject URL: ${badUrl}`);
    if (!res.ok) {
      assert.equal(
        res.error.includes('secret'),
        false,
        `Error message must NEVER leak raw password for URL: ${badUrl}`
      );
    }
  }

  // 4. Valid PostgreSQL URLs targeting exact database "kpims_test" must pass
  const validUrls = [
    'postgresql://postgres:test_pass_123@localhost:5432/kpims_test?schema=public',
    'postgres://kpims_tester:test_pass_123@127.0.0.1:5433/kpims_test',
    '"postgresql://postgres:test_pass_123@127.0.0.1:5432/kpims_test?sslmode=disable"',
  ];

  for (const goodUrl of validUrls) {
    const res = validateTestDatabaseUrl(goodUrl);
    assert.equal(res.ok, true, `Expected valid kpims_test URL to pass: ${goodUrl}`);
    if (res.ok) {
      assert.equal(res.databaseName, 'kpims_test');
      assert.equal(res.maskedUrl.includes('test_pass_123'), false, 'maskedUrl must redact password');
      assert.equal(res.maskedUrl.includes(':****@'), true, 'maskedUrl must include masked password marker');
    }
  }

  assert.equal(
    extractPostgresDatabaseName('postgresql://u:p@127.0.0.1:5432/kpims_test?schema=public'),
    'kpims_test'
  );

  // 5. Defense-in-depth inside prisma.ts setExplicitTestDatabaseUrlOverride
  try {
    assert.throws(
      () => setExplicitTestDatabaseUrlOverride('postgresql://postgres:secret@localhost:5432/kpims_db'),
      /Only "kpims_test" is permitted/
    );
    assert.equal(getExplicitTestDatabaseUrlOverride(), undefined);

    setExplicitTestDatabaseUrlOverride('postgresql://postgres:test_pass_123@localhost:5432/kpims_test?schema=public');
    assert.equal(
      getExplicitTestDatabaseUrlOverride(),
      'postgresql://postgres:test_pass_123@localhost:5432/kpims_test?schema=public'
    );
  } finally {
    clearTestDatabaseOverride();
    assert.equal(getExplicitTestDatabaseUrlOverride(), undefined);
  }

  console.log('✅ PASS: All TEST_DATABASE_URL fail-fast safety guards verified (zero DB contact).');
}

run();
