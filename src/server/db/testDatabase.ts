import { PrismaClient } from '@prisma/client';
import {
  getPrismaClient,
  hasMaskedPasswordPlaceholder,
  maskDatabaseUrl,
  probeDatabaseConnectivity,
  setExplicitTestDatabaseUrlOverride,
} from './prisma';

/**
 * Isolated PostgreSQL Integration Test Database Guard & Bootstrap
 *
 * Safety invariants:
 *   1. PostgreSQL integration tests MUST read `TEST_DATABASE_URL` explicitly
 *      and MUST NEVER fall back to `DATABASE_URL`, `.env`, or stored dual-DB
 *      connection configs (`data/kpims-db-connections*.json`).
 *   2. The target database name MUST be strictly `kpims_test` (case-sensitive,
 *      exact match) both in the connection URL and at runtime via
 *      `SELECT current_database()`.
 *   3. Credentials are never printed or included in error messages.
 */

export const REQUIRED_TEST_DATABASE_NAME = 'kpims_test' as const;

export type TestDatabaseValidationResult =
  | {
      ok: true;
      url: string;
      maskedUrl: string;
      databaseName: typeof REQUIRED_TEST_DATABASE_NAME;
      host: string;
      port: string;
    }
  | {
      ok: false;
      error: string;
      maskedUrl?: string;
    };

function normalizeEnvUrl(raw?: string): string {
  if (!raw) return '';
  let val = raw.trim();
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1).trim();
  }
  return val;
}

/**
 * Extracts and validates the PostgreSQL database name from a connection URL.
 * Rejects non-PostgreSQL protocols, empty database names, and multi-segment paths.
 */
export function extractPostgresDatabaseName(rawUrl: string): string {
  const normalized = normalizeEnvUrl(rawUrl);
  if (!normalized) {
    throw new Error('Empty PostgreSQL connection URL.');
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('Invalid PostgreSQL connection URL syntax.');
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(
      `Unsupported protocol "${parsed.protocol}". Expected "postgresql://" or "postgres://".`
    );
  }

  if (!parsed.hostname) {
    throw new Error('PostgreSQL connection URL must include a hostname.');
  }

  const rawPath = parsed.pathname.replace(/^\/+/, '');
  if (!rawPath || rawPath.includes('/')) {
    throw new Error('PostgreSQL connection URL must specify a single database name in the path.');
  }

  let decodedDbName: string;
  try {
    decodedDbName = decodeURIComponent(rawPath);
  } catch {
    throw new Error('PostgreSQL database name in URL path contains invalid percent-encoding.');
  }

  if (!decodedDbName || decodedDbName.includes('/')) {
    throw new Error('PostgreSQL connection URL contains an invalid database name.');
  }

  return decodedDbName;
}

/**
 * Validates `TEST_DATABASE_URL` against strict PostgreSQL integration test safety rules.
 * Never falls back to `DATABASE_URL`.
 */
export function validateTestDatabaseUrl(rawUrl: string | undefined): TestDatabaseValidationResult {
  const normalized = normalizeEnvUrl(rawUrl);
  if (!normalized) {
    return {
      ok: false,
      error:
        'SAFETY ABORT: TEST_DATABASE_URL is not set. PostgreSQL integration tests require an explicit TEST_DATABASE_URL targeting database "kpims_test" and NEVER fall back to DATABASE_URL.',
    };
  }

  const maskedUrl = maskDatabaseUrl(normalized);

  if (hasMaskedPasswordPlaceholder(normalized)) {
    return {
      ok: false,
      maskedUrl,
      error: `SAFETY ABORT: TEST_DATABASE_URL (${maskedUrl}) contains a masked password placeholder.`,
    };
  }

  let parsed: URL;
  let databaseName: string;
  try {
    parsed = new URL(normalized);
    databaseName = extractPostgresDatabaseName(normalized);
  } catch (err) {
    return {
      ok: false,
      maskedUrl,
      error: `SAFETY ABORT: Invalid TEST_DATABASE_URL (${maskedUrl}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const hostLower = parsed.hostname.toLowerCase();
  const userLower = decodeURIComponent(parsed.username || '').toLowerCase();
  if (hostLower === 'your_host' || userLower === 'your_user') {
    return {
      ok: false,
      maskedUrl,
      error: `SAFETY ABORT: TEST_DATABASE_URL (${maskedUrl}) contains placeholder host/user values.`,
    };
  }

  if (databaseName !== REQUIRED_TEST_DATABASE_NAME) {
    return {
      ok: false,
      maskedUrl,
      error:
        `SAFETY ABORT: Refusing to run PostgreSQL integration tests against database "${databaseName}" (${maskedUrl}). ` +
        `TEST_DATABASE_URL MUST target database "${REQUIRED_TEST_DATABASE_NAME}" exactly.`,
    };
  }

  return {
    ok: true,
    url: normalized,
    maskedUrl,
    databaseName: REQUIRED_TEST_DATABASE_NAME,
    host: parsed.hostname,
    port: parsed.port || '5432',
  };
}

/**
 * Fail-fast guard that reads ONLY `TEST_DATABASE_URL` (never `DATABASE_URL`)
 * and throws immediately unless the target database name is strictly `kpims_test`.
 */
export function requireTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const result = validateTestDatabaseUrl(env.TEST_DATABASE_URL);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.url;
}

/**
 * Runtime defense-in-depth verification against the connected PostgreSQL server:
 * confirms `current_database()` is strictly `kpims_test` (guards against proxy/alias routing).
 */
export async function assertConnectedToTestDatabase(
  prisma: PrismaClient
): Promise<{ databaseName: string; serverVersion: string }> {
  const rows = await prisma.$queryRaw<Array<{ db_name: string; server_version: string }>>`
    SELECT current_database() AS db_name, current_setting('server_version') AS server_version
  `;
  const actualDb = rows?.[0]?.db_name;
  const serverVersion = rows?.[0]?.server_version || 'unknown';
  if (actualDb !== REQUIRED_TEST_DATABASE_NAME) {
    throw new Error(
      `SAFETY ABORT: Connected PostgreSQL server reported current_database()="${actualDb ?? ''}", ` +
        `expected "${REQUIRED_TEST_DATABASE_NAME}". Aborting immediately without writing data.`
    );
  }
  return { databaseName: actualDb, serverVersion };
}

/**
 * Activates `TEST_DATABASE_URL` as the exclusive runtime target for `getPrismaClient()`
 * and `apiRouter` inside an integration test process, verifies connectivity, and
 * asserts `current_database() === 'kpims_test'`.
 */
export async function activateTestDatabaseForIntegrationTests(options?: {
  probeTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  prisma: PrismaClient;
  url: string;
  maskedUrl: string;
  serverVersion: string;
}> {
  const env = options?.env ?? process.env;
  const url = requireTestDatabaseUrl(env);
  const maskedUrl = maskDatabaseUrl(url);

  setExplicitTestDatabaseUrlOverride(url);
  const connected = await probeDatabaseConnectivity(options?.probeTimeoutMs ?? 8000, true);
  if (!connected) {
    setExplicitTestDatabaseUrlOverride(null);
    throw new Error(
      `Unable to connect to isolated PostgreSQL test database (${maskedUrl}). ` +
        `Ensure PostgreSQL is running, database "${REQUIRED_TEST_DATABASE_NAME}" exists, and migrations have been applied.`
    );
  }

  const prisma = getPrismaClient();
  const { serverVersion } = await assertConnectedToTestDatabase(prisma);
  return { prisma, url, maskedUrl, serverVersion };
}

/**
 * Creates a standalone PrismaClient strictly bound to validated `TEST_DATABASE_URL`
 * (`kpims_test` only, never falling back to `DATABASE_URL`).
 */
export function createDirectTestPrismaClient(env: NodeJS.ProcessEnv = process.env): {
  prisma: PrismaClient;
  url: string;
  maskedUrl: string;
} {
  const url = requireTestDatabaseUrl(env);
  const maskedUrl = maskDatabaseUrl(url);
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url,
      },
    },
  });
  return { prisma, url, maskedUrl };
}

/**
 * Releases any explicit test database override and disconnects the Prisma client.
 */
export function clearTestDatabaseOverride(): void {
  setExplicitTestDatabaseUrlOverride(null);
}
