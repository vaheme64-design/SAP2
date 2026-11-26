/**
 * =========================================================================
 * KPIMS — Prisma Migration Integrity Verifier (NULLS NOT DISTINCT Guard)
 * =========================================================================
 * Prisma 6 schema syntax cannot natively express PostgreSQL 15+
 * `NULLS NOT DISTINCT` on `@@unique(...)`. As a result, future
 * `prisma migrate dev` / `prisma migrate diff` / `prisma db push` runs
 * can silently generate SQL that drops and recreates the `stock_balances`
 * composite unique index WITHOUT `NULLS NOT DISTINCT`, reopening duplicate
 * balance row corruption under NULL nullable keys.
 *
 * This verifier scans `prisma/migrations` chronologically and FAILS
 * (exit code 1) if:
 *   1. No migration establishes `NULLS NOT DISTINCT` on the `stock_balances`
 *      composite unique index, OR
 *   2. Any subsequent migration drops that index or recreates it without
 *      `NULLS NOT DISTINCT`, OR
 *   3. `prisma/schema.prisma` removes the 8-column `@@unique(...)` on
 *      `StockBalance`.
 * =========================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertConnectedToTestDatabase,
  createDirectTestPrismaClient,
} from '../src/server/db/testDatabase';

export interface MigrationFileInput {
  name: string;
  sql: string;
}

export interface MigrationVerificationResult {
  ok: boolean;
  errors: string[];
  establishedIn?: string;
  checkedMigrations: number;
}

export const STOCK_BALANCES_UNIQUE_INDEX =
  'stock_balances_partId_warehouseId_locationId_materialLotId__key';

function stripSqlComments(sql: string): string {
  // Remove /* ... */ block comments and -- ... line comments
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

function splitSqlStatements(sql: string): string[] {
  return stripSqlComments(sql)
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
}

function isTargetDropStatement(stmt: string): boolean {
  const normalized = stmt.replace(/\s+/g, ' ').trim();
  return new RegExp(
    `^DROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?(?:"?public"?\\.)?"?${STOCK_BALANCES_UNIQUE_INDEX}"?\\b`,
    'i'
  ).test(normalized);
}

function isTargetCreateUniqueIndex(stmt: string): boolean {
  const normalized = stmt.replace(/\s+/g, ' ').trim();
  const isCreateUnique = /^CREATE\s+UNIQUE\s+INDEX\b/i.test(normalized);
  if (!isCreateUnique) return false;
  const targetsTable = /\bON\s+(?:"?public"?\.)?"?stock_balances"?\s*\(/i.test(normalized);
  const targetsName = new RegExp(`"?${STOCK_BALANCES_UNIQUE_INDEX}"?`, 'i').test(normalized);
  return targetsTable && targetsName;
}

function hasNullsNotDistinctClause(stmt: string): boolean {
  const normalized = stmt.replace(/\s+/g, ' ').trim();
  return /\bNULLS\s+NOT\s+DISTINCT\b/i.test(normalized);
}

export function verifyNullsNotDistinctMigrations(
  migrations: MigrationFileInput[],
  schemaContent?: string
): MigrationVerificationResult {
  const errors: string[] = [];
  let indexPresent = false;
  let hasNullsNotDistinct = false;
  let establishedIn: string | undefined;

  for (const mig of migrations) {
    const statements = splitSqlStatements(mig.sql);
    let droppedInThisMigration = false;
    let recreatedWithNndInThisMigration = false;
    let recreatedWithoutNndInThisMigration = false;

    for (const stmt of statements) {
      if (isTargetDropStatement(stmt)) {
        indexPresent = false;
        hasNullsNotDistinct = false;
        droppedInThisMigration = true;
      } else if (isTargetCreateUniqueIndex(stmt)) {
        indexPresent = true;
        if (hasNullsNotDistinctClause(stmt)) {
          hasNullsNotDistinct = true;
          recreatedWithNndInThisMigration = true;
          establishedIn = mig.name;
        } else {
          hasNullsNotDistinct = false;
          recreatedWithoutNndInThisMigration = true;
        }
      }
    }

    if (establishedIn && establishedIn !== mig.name) {
      if (recreatedWithoutNndInThisMigration && !recreatedWithNndInThisMigration) {
        errors.push(
          `Migration "${mig.name}" recreates "${STOCK_BALANCES_UNIQUE_INDEX}" WITHOUT PostgreSQL "NULLS NOT DISTINCT" (established in "${establishedIn}").`
        );
      } else if (droppedInThisMigration && !recreatedWithNndInThisMigration) {
        errors.push(
          `Migration "${mig.name}" drops "${STOCK_BALANCES_UNIQUE_INDEX}" without restoring "NULLS NOT DISTINCT" (established in "${establishedIn}").`
        );
      }
    }
  }

  if (!establishedIn) {
    errors.push(
      `No Prisma migration creates "${STOCK_BALANCES_UNIQUE_INDEX}" on "stock_balances" with "NULLS NOT DISTINCT".`
    );
  } else if (!indexPresent || !hasNullsNotDistinct) {
    errors.push(
      `Final effective state of "${STOCK_BALANCES_UNIQUE_INDEX}" is missing "NULLS NOT DISTINCT".`
    );
  }

  if (schemaContent !== undefined) {
    const stockBalanceModelMatch = schemaContent.match(/model\s+StockBalance\s*\{[\s\S]*?\n\}/);
    if (!stockBalanceModelMatch) {
      errors.push('prisma/schema.prisma is missing model StockBalance.');
    } else {
      const modelBody = stockBalanceModelMatch[0];
      const expectedUniqueRegex =
        /@@unique\(\[\s*partId\s*,\s*warehouseId\s*,\s*locationId\s*,\s*materialLotId\s*,\s*physicalCoilId\s*,\s*ownership\s*,\s*contractId\s*,\s*qualityStatus\s*\]\)/;
      if (!expectedUniqueRegex.test(modelBody)) {
        errors.push(
          'prisma/schema.prisma model StockBalance must retain the 8-column @@unique([partId, warehouseId, locationId, materialLotId, physicalCoilId, ownership, contractId, qualityStatus]) constraint.'
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    establishedIn,
    checkedMigrations: migrations.length,
  };
}

export function loadWorkspaceMigrations(projectRoot: string): {
  migrations: MigrationFileInput[];
  schemaContent: string;
} {
  const migrationsDir = path.join(projectRoot, 'prisma', 'migrations');
  const schemaPath = path.join(projectRoot, 'prisma', 'schema.prisma');

  const entries = fs.existsSync(migrationsDir)
    ? fs
        .readdirSync(migrationsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort((a, b) => a.localeCompare(b))
    : [];

  const migrations: MigrationFileInput[] = [];
  for (const dirName of entries) {
    const sqlPath = path.join(migrationsDir, dirName, 'migration.sql');
    if (fs.existsSync(sqlPath)) {
      migrations.push({
        name: dirName,
        sql: fs.readFileSync(sqlPath, 'utf8'),
      });
    }
  }

  const schemaContent = fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, 'utf8') : '';
  return { migrations, schemaContent };
}

export async function verifyTestDatabaseMigrationState(): Promise<{
  ok: boolean;
  errors: string[];
  maskedUrl: string;
  serverVersion: string;
  appliedMigrations: string[];
}> {
  const { prisma, maskedUrl } = createDirectTestPrismaClient();
  const errors: string[] = [];
  let serverVersion = 'unknown';
  let appliedMigrations: string[] = [];

  try {
    const info = await assertConnectedToTestDatabase(prisma);
    serverVersion = info.serverVersion;

    const majorMatch = serverVersion.match(/^(\d+)/);
    const majorVersion = majorMatch ? Number(majorMatch[1]) : 0;
    if (majorVersion > 0 && majorVersion < 15) {
      errors.push(
        `PostgreSQL server version ${serverVersion} does not support NULLS NOT DISTINCT (PostgreSQL >= 15 required).`
      );
    }

    const migrationRows = await prisma.$queryRaw<
      Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>
    >`
      SELECT migration_name, finished_at, rolled_back_at
      FROM "_prisma_migrations"
      ORDER BY started_at ASC
    `;

    for (const row of migrationRows) {
      if (row.rolled_back_at) {
        errors.push(`Migration "${row.migration_name}" in kpims_test is marked rolled_back.`);
      } else if (!row.finished_at) {
        errors.push(`Migration "${row.migration_name}" in kpims_test did not finish cleanly.`);
      } else {
        appliedMigrations.push(row.migration_name);
      }
    }

    const indexRows = await prisma.$queryRaw<
      Array<{ index_name: string; is_unique: boolean; nulls_not_distinct: boolean }>
    >`
      SELECT
        c.relname AS index_name,
        i.indisunique AS is_unique,
        i.indnullsnotdistinct AS nulls_not_distinct
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relname = ${STOCK_BALANCES_UNIQUE_INDEX}
      LIMIT 1
    `;

    const idx = indexRows[0];
    if (!idx) {
      errors.push(
        `Index "${STOCK_BALANCES_UNIQUE_INDEX}" was not found in kpims_test. Apply migrations with "npm run test:db:migrate".`
      );
    } else if (!idx.is_unique || !idx.nulls_not_distinct) {
      errors.push(
        `Index "${STOCK_BALANCES_UNIQUE_INDEX}" in kpims_test is missing PostgreSQL UNIQUE NULLS NOT DISTINCT (is_unique=${idx.is_unique}, indnullsnotdistinct=${idx.nulls_not_distinct}).`
      );
    }

    return {
      ok: errors.length === 0,
      errors,
      maskedUrl,
      serverVersion,
      appliedMigrations,
    };
  } finally {
    await prisma.$disconnect();
  }
}

const isDirectExecution =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  (async () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const { migrations, schemaContent } = loadWorkspaceMigrations(projectRoot);
    const result = verifyNullsNotDistinctMigrations(migrations, schemaContent);

    if (!result.ok) {
      console.error('FAIL: Prisma migration NULLS NOT DISTINCT guard failed:');
      for (const err of result.errors) {
        console.error(`  - ${err}`);
      }
      process.exit(1);
    }

    console.log(
      `PASS: Verified ${result.checkedMigrations} Prisma migration(s); "${STOCK_BALANCES_UNIQUE_INDEX}" preserves PostgreSQL NULLS NOT DISTINCT (established in ${result.establishedIn}).`
    );

    if (process.argv.includes('--check-test-db')) {
      const dbResult = await verifyTestDatabaseMigrationState();
      if (!dbResult.ok) {
        console.error(`FAIL: Isolated test DB verification failed (${dbResult.maskedUrl}):`);
        for (const err of dbResult.errors) {
          console.error(`  - ${err}`);
        }
        process.exit(1);
      }
      const expectedNames = migrations.map(m => m.name);
      const missing = expectedNames.filter(name => !dbResult.appliedMigrations.includes(name));
      if (missing.length > 0) {
        console.error(
          `FAIL: Isolated test DB (${dbResult.maskedUrl}) is missing ${missing.length} committed migration(s): ${missing.join(', ')}`
        );
        process.exit(1);
      }
      console.log(
        `PASS: Isolated PostgreSQL ${dbResult.serverVersion} test DB (${dbResult.maskedUrl}) has all ${dbResult.appliedMigrations.length} migration(s) applied and enforces NULLS NOT DISTINCT on "${STOCK_BALANCES_UNIQUE_INDEX}".`
      );
    }
  })().catch(err => {
    console.error('FAIL: Migration verification error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
