import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { runWipCutoverBackfill, WipCutoverMode } from '../src/server/backfill/wipCutoverBackfillService';

interface CliArgs {
  mode: WipCutoverMode;
  confirmLiveWrite: boolean;
  useStoredCloudConfig: boolean;
  jsonOutput: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let mode: WipCutoverMode = 'dry-run';
  let sawDryRun = false;
  let sawApply = false;
  let confirmLiveWrite = false;
  let useStoredCloudConfig = false;
  let jsonOutput = false;

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
    } else if (arg === '--json') {
      jsonOutput = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (sawDryRun && sawApply) {
    throw new Error('Cannot specify both --dry-run and --apply.');
  }
  return { mode, confirmLiveWrite, useStoredCloudConfig, jsonOutput };
}

function resolvePostgresUrl(useStoredCloudConfig: boolean): string {
  const envUrl = process.env.DATABASE_URL?.trim();
  if (envUrl) return envUrl;
  if (!useStoredCloudConfig) {
    throw new Error('DATABASE_URL is not set. Pass --use-stored-cloud-config to resolve it in-memory.');
  }
  const basePath = path.resolve(process.cwd(), 'data', 'kpims-db-connections.json');
  const localPath = path.resolve(process.cwd(), 'data', 'kpims-db-connections.local.json');
  const base = fs.existsSync(basePath) ? JSON.parse(fs.readFileSync(basePath, 'utf-8')) : {};
  const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf-8')) : {};
  const merged = { ...base, ...local };
  const target = String(merged.activeTarget || 'CLOUD').toUpperCase();
  const chosen = target === 'LOCAL' && merged.localDbUrl ? String(merged.localDbUrl) : String(merged.cloudDbUrl || '');
  if (!chosen) throw new Error('No PostgreSQL URL found in stored DB config.');
  const parsed = new URL(chosen);
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1' && !parsed.searchParams.has('sslmode')) {
    parsed.searchParams.set('sslmode', 'require');
  }
  return parsed.toString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'apply' && !args.confirmLiveWrite) {
    throw new Error('--apply requires --confirm-live-write');
  }
  const url = resolvePostgresUrl(args.useStoredCloudConfig);
  const parsed = new URL(url);
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    await prisma.$connect();
    const report = await runWipCutoverBackfill(prisma, args.mode);
    if (args.jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('========================================================================');
      console.log(`KPIMS WIP RELATIONAL CUTOVER BACKFILL (${report.mode.toUpperCase()})`);
      console.log(`Target: ${parsed.hostname}:${parsed.port || '5432'}/${parsed.pathname.replace(/^\//, '')}`);
      console.log(`Snapshot version: ${report.snapshotVersion} | Applied: ${report.applied}`);
      console.log('Planned:', JSON.stringify(report.planned));
      console.log('MO Conservation Checks:');
      for (const mc of report.moChecks) {
        console.log(`  - ${mc.moNumber} (${mc.partNumber}): init=${mc.initialInputQty}, activeWip=${mc.activeWipQty}, inTransit=${mc.inTransitQty}, completed=${mc.completedQty}, scrap=${mc.scrapQty}, disc=${mc.discrepancy}, conserved=${mc.isConserved}`);
      }
      console.log(`Opening Balances (${report.openingBalances.length}):`);
      for (const ob of report.openingBalances) {
        console.log(`  - ${ob.partNumber} @ ${ob.warehouseCode}/${ob.locationCode} [${ob.qualityStatus}]: qty=${ob.quantity}, kg=${ob.weightKg} (${ob.moNumber})`);
      }
      if (report.warnings.length > 0) {
        console.log('Warnings:', report.warnings);
      }
      console.log('========================================================================');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
