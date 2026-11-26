import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  BackfillMode,
  BackfillReconciliationReport,
  loadSnapshotsFromPostgres,
  runSnapshotToRelationalBackfill,
} from '../src/server/backfill/snapshotBackfillService';

interface CliArgs {
  mode: BackfillMode;
  confirmLiveWrite: boolean;
  useStoredCloudConfig: boolean;
  reconcileCoilWeights: boolean;
  jsonOutput: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let mode: BackfillMode = 'dry-run';
  let sawDryRun = false;
  let sawApply = false;
  let confirmLiveWrite = false;
  let useStoredCloudConfig = false;
  let reconcileCoilWeights = true;
  let jsonOutput = false;
  let help = false;

  for (const arg of argv) {
    if (arg === '--dry-run') {
      sawDryRun = true;
      mode = 'dry-run';
    } else if (arg === '--apply') {
      sawApply = true;
      mode = 'apply';
    } else if (arg === '--confirm-live-write') {
      confirmLiveWrite = true;
    } else if (arg === '--use-stored-cloud-config') {
      useStoredCloudConfig = true;
    } else if (arg === '--no-reconcile-coil-weights') {
      reconcileCoilWeights = false;
    } else if (arg === '--json') {
      jsonOutput = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }

  if (sawDryRun && sawApply) {
    throw new Error('Conflicting CLI flags: cannot specify both --dry-run and --apply.');
  }

  return {
    mode,
    confirmLiveWrite,
    useStoredCloudConfig,
    reconcileCoilWeights,
    jsonOutput,
    help,
  };
}

function printUsage(): void {
  console.log(
    [
      'KPIMS Snapshot-to-Relational Backfill CLI',
      '',
      'Usage:',
      '  npx tsx scripts/backfill-snapshots-to-relational.ts [options]',
      '',
      'Options:',
      '  --dry-run                    Run in read-only reconciliation mode (DEFAULT, zero DB writes)',
      '  --apply                      Execute transactional backfill writes (requires --confirm-live-write)',
      '  --confirm-live-write         Explicit safety acknowledgement required together with --apply',
      '  --use-stored-cloud-config    Resolve PostgreSQL URL in-memory from data/kpims-db-connections.json',
      '                               when DATABASE_URL is not set (never creates .env or prints secrets)',
      '  --no-reconcile-coil-weights  Preserve snapshot coil remainingWeightKg (float-normalized only)',
      '                               instead of reconciling to the derived posted inventory ledger',
      '  --json                       Print full machine-readable BackfillReconciliationReport JSON',
      '  --help, -h                   Show this help text',
    ].join('\n'),
  );
}

function ensureRemoteSslMode(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return trimmed;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (!isLocal && !parsed.searchParams.has('sslmode')) {
      parsed.searchParams.set('sslmode', 'require');
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function sanitizeTargetForLog(rawUrl: string): { host: string; port: string; database: string } {
  try {
    const parsed = new URL(rawUrl);
    return {
      host: parsed.hostname || 'unknown',
      port: parsed.port || '5432',
      database: parsed.pathname.replace(/^\//, '') || 'postgres',
    };
  } catch {
    return { host: 'unparseable', port: '', database: '' };
  }
}

function resolvePostgresUrl(useStoredCloudConfig: boolean): { url: string; source: string } {
  const envUrl = process.env.DATABASE_URL?.trim();
  if (envUrl) {
    return { url: ensureRemoteSslMode(envUrl), source: 'env:DATABASE_URL' };
  }

  if (!useStoredCloudConfig) {
    throw new Error(
      'DATABASE_URL is not set. Provide DATABASE_URL in the environment or pass --use-stored-cloud-config to resolve the active PostgreSQL URL in-memory from data/kpims-db-connections.json.',
    );
  }

  const basePath = path.resolve(process.cwd(), 'data', 'kpims-db-connections.json');
  const localOverlayPath = path.resolve(process.cwd(), 'data', 'kpims-db-connections.local.json');

  if (!fs.existsSync(basePath)) {
    throw new Error('Stored DB connection config data/kpims-db-connections.json does not exist.');
  }

  const baseCfg = JSON.parse(fs.readFileSync(basePath, 'utf-8')) as Record<string, unknown>;
  const overlayCfg = fs.existsSync(localOverlayPath)
    ? (JSON.parse(fs.readFileSync(localOverlayPath, 'utf-8')) as Record<string, unknown>)
    : {};
  const merged = { ...baseCfg, ...overlayCfg };

  const activeTarget = String(merged.activeTarget || 'CLOUD').toUpperCase();
  const cloudUrl = typeof merged.cloudDbUrl === 'string' ? merged.cloudDbUrl.trim() : '';
  const localUrl = typeof merged.localDbUrl === 'string' ? merged.localDbUrl.trim() : '';

  const chosen = activeTarget === 'LOCAL' && localUrl ? localUrl : cloudUrl;
  if (!chosen || (!chosen.startsWith('postgres://') && !chosen.startsWith('postgresql://'))) {
    throw new Error(
      `No valid PostgreSQL URL found in stored DB config (activeTarget=${activeTarget}). Fail-closed: refusing disk or in-memory fallback.`,
    );
  }

  return {
    url: ensureRemoteSslMode(chosen),
    source: `data/kpims-db-connections.json (activeTarget=${activeTarget})`,
  };
}

function printHumanReport(
  report: BackfillReconciliationReport,
  targetInfo: { host: string; port: string; database: string; schema: string; source: string },
): void {
  console.log('========================================================================');
  console.log(`KPIMS SNAPSHOT -> RELATIONAL BACKFILL REPORT (${report.mode.toUpperCase()})`);
  console.log('========================================================================');
  console.log(`Target PostgreSQL : ${targetInfo.host}:${targetInfo.port}/${targetInfo.database} (schema=${targetInfo.schema})`);
  console.log(`Config Source     : ${targetInfo.source}`);
  console.log(`Applied Writes    : ${report.applied ? 'YES (COMMITTED)' : 'NO (READ-ONLY DRY-RUN)'}`);
  console.log(`Executed At       : ${report.executedAt}`);
  console.log(
    `Snapshots         : ${report.snapshotMeta.inventorySnapshotId} (updatedAt=${report.snapshotMeta.inventoryUpdatedAt ?? 'n/a'}) | ${report.snapshotMeta.wipSnapshotId} (v${report.snapshotMeta.wipVersion ?? 'n/a'}, updatedAt=${report.snapshotMeta.wipUpdatedAt ?? 'n/a'})`,
  );
  console.log('');
  console.log('--- ENTITY RECONCILIATION ---');
  console.log(
    'Entity'.padEnd(28) +
      'Table'.padEnd(32) +
      'Src'.padStart(6) +
      'Exist'.padStart(7) +
      'Ins'.padStart(6) +
      'Upd'.padStart(6) +
      'Skip'.padStart(7),
  );
  console.log('-'.repeat(92));
  for (const e of report.entities) {
    console.log(
      e.entity.padEnd(28) +
        e.targetTable.padEnd(32) +
        String(e.sourceCount).padStart(6) +
        String(e.existingCount).padStart(7) +
        String(e.plannedInserts).padStart(6) +
        String(e.plannedUpdates).padStart(6) +
        String(e.plannedSkips).padStart(7),
    );
  }
  console.log('-'.repeat(92));
  console.log(
    `TOTALS: plannedInserts=${report.summary.totalPlannedInserts}, plannedUpdates=${report.summary.totalPlannedUpdates}, plannedSkips=${report.summary.totalPlannedSkips}, warnings=${report.summary.warningCount}, conflicts=${report.summary.conflictCount}`,
  );

  console.log('');
  console.log(`--- PRESERVED RELATIONAL-ONLY PARTS (${report.preservedRelationalOnlyParts.length}) ---`);
  for (const p of report.preservedRelationalOnlyParts) {
    console.log(`  - ${p.partNumber} (id=${p.id}): ${p.name}`);
  }

  console.log('');
  console.log(`--- DERIVED STOCK BALANCES (${report.derivedStockBalances.length}) ---`);
  for (const b of report.derivedStockBalances) {
    console.log(
      `  - ${b.partNumber} @ ${b.warehouseCode}/${b.locationCode ?? '-'} | lot=${b.lotNumber ?? '-'} | coil=${b.coilId ?? '-'} | ${b.ownership}/${b.contractNumber ?? '-'} | ${b.qualityStatus} | qty(onHand=${b.quantityOnHand}, res=${b.quantityReserved}, avail=${b.quantityAvailable}) | kg(onHand=${b.weightKgOnHand}, res=${b.weightKgReserved}, avail=${b.weightKgAvailable})`,
    );
  }

  console.log('');
  console.log(`--- COIL RECONCILIATION (${report.coilReconciliation.length}) ---`);
  for (const c of report.coilReconciliation) {
    console.log(
      `  - ${c.coilId} (${c.coilPackNumber}): orig=${c.originalWeightKg} kg | rel=${c.existingRelationalRemainingKg ?? 'new'} | snap=${c.snapshotRemainingKg} | ledger=${c.derivedLedgerRemainingKg ?? 'n/a'} | target=${c.reconciledTargetRemainingKg} | drift=${c.driftKg} | floatArtifact=${c.hadFloatArtifact} | contractAlloc=${c.contractAllocatedKg} kg`,
    );
  }

  console.log('');
  console.log(`--- CONTRACT ALLOCATION CHECKS (${report.contractAllocationChecks.length}) ---`);
  for (const c of report.contractAllocationChecks) {
    console.log(
      `  - ${c.contractNumber}: allocated=${c.plannedCoilAllocationsKg} / cap=${c.totalAllocatedWeightKg} kg | withinLimit=${c.withinContractLimit} | coils=${c.allocations.map((a) => `${a.coilId}:${a.allocatedWeightKg}kg(${a.source})`).join(', ')}`,
    );
  }

  console.log('');
  console.log(`--- WIP RECONCILIATION (${report.wipReconciliation.length}) ---`);
  for (const w of report.wipReconciliation) {
    console.log(
      `  - ${w.moNumber} (${w.partNumber}): ops=${w.operationCount}, transfers=${w.transferCount}, target=${w.targetQty}, completed=${w.completedQty}, scrap=${w.scrapQty}, wipLink=${w.wipLinkPlanned}`,
    );
  }

  console.log('');
  console.log(`--- UNSUPPORTED / EXCLUDED SNAPSHOT KEYS (${report.unsupportedEntities.length}) ---`);
  for (const u of report.unsupportedEntities) {
    console.log(`  - ${u.snapshotKey} (count=${u.sourceCount}): ${u.reason}`);
  }

  console.log('');
  console.log(`--- CONFLICTS & WARNINGS (${report.conflicts.length}) ---`);
  for (const cf of report.conflicts) {
    console.log(`  [${cf.severity}] ${cf.code} (${cf.entity} / ${cf.reference}): ${cf.message}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  if (args.mode === 'apply' && !args.confirmLiveWrite) {
    throw new Error(
      'Safety gate: --apply requires --confirm-live-write to perform PostgreSQL writes. Re-run with --dry-run (default) for read-only verification or add --confirm-live-write when ready to apply.',
    );
  }

  const { url, source } = resolvePostgresUrl(args.useStoredCloudConfig);
  const sanitized = sanitizeTargetForLog(url);

  // Standalone direct PrismaClient — NEVER uses runtime proxy, disk JSON, or in-memory fallbacks.
  const prisma = new PrismaClient({
    datasources: {
      db: { url },
    },
    log: ['error'],
  });

  try {
    await prisma.$connect();
    const dbMeta = await prisma.$queryRaw<Array<{ db: string; schema: string }>>`
      SELECT current_database() AS db, current_schema() AS schema
    `;
    const activeDb = dbMeta[0]?.db ?? sanitized.database;
    const activeSchema = dbMeta[0]?.schema ?? 'public';

    const bundle = await loadSnapshotsFromPostgres(prisma);
    const report = await runSnapshotToRelationalBackfill(prisma, bundle, {
      mode: args.mode,
      reconcileCoilWeights: args.reconcileCoilWeights,
    });

    if (args.jsonOutput) {
      console.log(
        JSON.stringify(
          {
            target: {
              host: sanitized.host,
              port: sanitized.port,
              database: activeDb,
              schema: activeSchema,
              source,
            },
            report,
          },
          null,
          2,
        ),
      );
    } else {
      printHumanReport(report, {
        host: sanitized.host,
        port: sanitized.port,
        database: activeDb,
        schema: activeSchema,
        source,
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}

function sanitizeErrorMessage(raw: string): string {
  return raw.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, '[REDACTED_POSTGRES_URL]');
}

main().catch((err) => {
  const message = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
  console.error(`[KPIMS Backfill ERROR] ${message}`);
  process.exit(1);
});
