/**
 * Isolated Regression Test Suite for KPIMS Production & WIP Relational Cutover Audit Fixes.
 *
 * Strictly in-memory via `__setProductionWipPrismaForTests` — ZERO contact with live PostgreSQL.
 * Run with: DATABASE_URL="" npx tsx scripts/test-wip-audit-regressions.ts
 */

import assert from 'node:assert/strict';
import {
  __setProductionWipPrismaForTests,
  WipServiceError,
  createManufacturingOrderDb,
  createSubManufacturingOrdersBatchDb,
  loadMaterialIntoMoDb,
  registerOperationInputDb,
  postWipProductionDb,
  createOperationTransferDb,
  approveOperationTransferDb,
  rejectOperationTransferDb,
  analyzeMoRollbackImpactDb,
  deleteManufacturingOrderWithRollbackDb,
} from '../src/server/services/productionWipService';

if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0) {
  throw new Error('Refusing to run isolated regression test suite while DATABASE_URL is set.');
}

// ---------------------------------------------------------------------------
// Self-contained transactional in-memory Prisma mock
// ---------------------------------------------------------------------------

type TableName =
  | 'user'
  | 'unit'
  | 'warehouse'
  | 'warehouseLocation'
  | 'part'
  | 'operation'
  | 'partRoute'
  | 'partRouteOperation'
  | 'machine'
  | 'shift'
  | 'die'
  | 'physicalCoil'
  | 'materialLot'
  | 'coilIssueReturnRecord'
  | 'manufacturingOrder'
  | 'productionOperation'
  | 'productionReport'
  | 'productionScrap'
  | 'productionTransfer'
  | 'productionActivityLog'
  | 'machineAssignment'
  | 'wipManufacturingOrderLink'
  | 'wipOperationLink'
  | 'inventoryDocument'
  | 'inventoryDocumentLine'
  | 'inventoryTransaction'
  | 'stockBalance'
  | 'inventoryReservation'
  | 'auditLog';

type DbState = Record<TableName, any[]>;

let seqCounter = 1;
const nextId = (prefix: string) => `${prefix}-${seqCounter++}`;

function cloneState(state: DbState): DbState {
  return structuredClone(state);
}

function toNum(v: any): number {
  return Number(v ?? 0);
}

function createMockPrisma(initial: Partial<DbState>) {
  let state: DbState = {
    user: [],
    unit: [],
    warehouse: [],
    warehouseLocation: [],
    part: [],
    operation: [],
    partRoute: [],
    partRouteOperation: [],
    machine: [],
    shift: [],
    die: [],
    physicalCoil: [],
    materialLot: [],
    coilIssueReturnRecord: [],
    manufacturingOrder: [],
    productionOperation: [],
    productionReport: [],
    productionScrap: [],
    productionTransfer: [],
    productionActivityLog: [],
    machineAssignment: [],
    wipManufacturingOrderLink: [],
    wipOperationLink: [],
    inventoryDocument: [],
    inventoryDocumentLine: [],
    inventoryTransaction: [],
    stockBalance: [],
    inventoryReservation: [],
    auditLog: [],
    ...structuredClone(initial),
  };

  function getDb(): DbState {
    return state;
  }

  function hydrate(table: TableName, row: any, include: any, db: DbState): any {
    if (!row) return null;
    const out = { ...row };
    if (!include) return out;

    if (table === 'warehouse' && include.locations) {
      let locs = db.warehouseLocation.filter(l => l.warehouseId === row.id);
      if (include.locations?.where) {
        locs = locs.filter(l => matchesWhere('warehouseLocation', l, include.locations.where, db));
      }
      locs.sort((a, b) => String(a.code).localeCompare(String(b.code)));
      out.locations = locs;
    }
    if (table === 'warehouseLocation' && include.warehouse) {
      out.warehouse = db.warehouse.find(w => w.id === row.warehouseId) || null;
    }
    if (table === 'part' && include.unit) {
      out.unit = db.unit.find(u => u.id === row.unitId) || null;
    }
    if (table === 'partRoute' && include.operations) {
      let ops = db.partRouteOperation.filter(s => s.partRouteId === row.id);
      ops.sort((a, b) => a.stepNumber - b.stepNumber);
      out.operations = ops.map(s => hydrate('partRouteOperation', s, include.operations?.include, db));
    }
    if (table === 'partRouteOperation') {
      if (include.operation) out.operation = db.operation.find(o => o.id === row.operationId) || null;
      if (include.machine) out.machine = db.machine.find(m => m.id === row.machineId) || null;
      if (include.die) out.die = db.die.find(d => d.id === row.dieId) || null;
    }
    if (table === 'stockBalance') {
      if (include.part) out.part = hydrate('part', db.part.find(p => p.id === row.partId), include.part?.include, db);
      if (include.warehouse) out.warehouse = db.warehouse.find(w => w.id === row.warehouseId) || null;
      if (include.location) out.location = db.warehouseLocation.find(l => l.id === row.locationId) || null;
      if (include.materialLot) out.materialLot = db.materialLot.find(l => l.id === row.materialLotId) || null;
      if (include.physicalCoil) out.physicalCoil = db.physicalCoil.find(c => c.id === row.physicalCoilId) || null;
    }
    if (table === 'productionOperation') {
      if (include.operation) out.operation = db.operation.find(o => o.id === row.operationId) || null;
      if (include.plannedMachine) out.plannedMachine = db.machine.find(m => m.id === row.plannedMachineId) || null;
      if (include.plannedDie) out.plannedDie = db.die.find(d => d.id === row.plannedDieId) || null;
      if (include.warehouse) out.warehouse = db.warehouse.find(w => w.id === row.warehouseId) || null;
      if (include.location) {
        out.location = hydrate(
          'warehouseLocation',
          db.warehouseLocation.find(l => l.id === row.locationId),
          include.location?.include,
          db
        );
      }
      if (include.machine) out.machine = db.machine.find(m => m.id === row.plannedMachineId || m.id === row.machineId) || null;
      if (include.wipLink) {
        out.wipLink = db.wipOperationLink.find(l => l.productionOperationId === row.id) || null;
      }
      if (include.reports) {
        out.reports = db.productionReport
          .filter(r => r.productionOperationId === row.id)
          .map(r => hydrate('productionReport', r, include.reports?.include, db));
      }
    }
    if (table === 'manufacturingOrder') {
      if (include.part) out.part = hydrate('part', db.part.find(p => p.id === row.partId), include.part?.include, db);
      if (include.route) out.route = db.partRoute.find(r => r.id === row.routeId) || null;
      if (include.parentMo) {
        out.parentMo = db.manufacturingOrder.find(m => m.id === row.parentMoId) || null;
      }
      if (include.outputWarehouse) {
        out.outputWarehouse = db.warehouse.find(w => w.id === row.outputWarehouseId) || null;
      }
      if (include.outputLocation) {
        out.outputLocation = db.warehouseLocation.find(l => l.id === row.outputLocationId) || null;
      }
      if (include.wipLink) {
        out.wipLink = db.wipManufacturingOrderLink.find(l => l.manufacturingOrderId === row.id) || null;
      }
      if (include.operations) {
        let ops = db.productionOperation.filter(o => o.manufacturingOrderId === row.id);
        ops.sort((a, b) => (a.sequence ?? a.stepNumber) - (b.sequence ?? b.stepNumber));
        out.operations = ops.map(o => hydrate('productionOperation', o, include.operations?.include, db));
      }
      if (include.transfers) {
        out.transfers = db.productionTransfer.filter(t => t.manufacturingOrderId === row.id);
      }
      if (include.reports) {
        out.reports = db.productionReport.filter(r => r.manufacturingOrderId === row.id);
      }
      if (include.activityLogs) {
        out.activityLogs = db.productionActivityLog.filter(l => l.manufacturingOrderId === row.id);
      }
    }
    if (table === 'productionTransfer') {
      if (include.manufacturingOrder) {
        out.manufacturingOrder = hydrate(
          'manufacturingOrder',
          db.manufacturingOrder.find(m => m.id === row.manufacturingOrderId),
          include.manufacturingOrder?.include,
          db
        );
      }
      if (include.part) out.part = hydrate('part', db.part.find(p => p.id === row.partId), include.part?.include, db);
      if (include.fromLocation) out.fromLocation = db.warehouseLocation.find(l => l.id === row.fromLocationId) || null;
      if (include.toLocation) out.toLocation = db.warehouseLocation.find(l => l.id === row.toLocationId) || null;
    }
    if (table === 'inventoryDocument') {
      if (include.lines) out.lines = db.inventoryDocumentLine.filter(l => l.documentId === row.id);
      if (include.transactions) out.transactions = db.inventoryTransaction.filter(t => t.documentId === row.id);
    }
    return out;
  }

  function matchesWhere(table: TableName, row: any, where: any, db: DbState): boolean {
    if (!where) return true;
    for (const [k, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (k === 'OR') {
        if (!Array.isArray(cond) || !cond.some(sub => matchesWhere(table, row, sub, db))) return false;
        continue;
      }
      if (k === 'AND') {
        if (!Array.isArray(cond) || !cond.every(sub => matchesWhere(table, row, sub, db))) return false;
        continue;
      }
      // Relation filters
      if (k === 'part' && typeof cond === 'object' && cond !== null) {
        const part = db.part.find(p => p.id === row.partId);
        if (!part || !matchesWhere('part', part, (cond as any).is ?? cond, db)) return false;
        continue;
      }
      if (k === 'warehouse' && typeof cond === 'object' && cond !== null) {
        const wh = db.warehouse.find(w => w.id === row.warehouseId);
        if (!wh || !matchesWhere('warehouse', wh, (cond as any).is ?? cond, db)) return false;
        continue;
      }

      const val = row[k];
      if (cond === null) {
        if (val !== null && val !== undefined) return false;
        continue;
      }
      if (typeof cond === 'object' && !(cond instanceof Date)) {
        const c = cond as any;
        if ('equals' in c && val !== c.equals) return false;
        if ('in' in c && (!Array.isArray(c.in) || !c.in.includes(val))) return false;
        if ('notIn' in c && Array.isArray(c.notIn) && c.notIn.includes(val)) return false;
        if ('not' in c) {
          if (c.not === null) {
            if (val === null || val === undefined) return false;
          } else if (val === c.not) {
            return false;
          }
        }
        if ('gt' in c && !(toNum(val) > toNum(c.gt))) return false;
        if ('gte' in c && !(toNum(val) >= toNum(c.gte))) return false;
        if ('lt' in c && !(toNum(val) < toNum(c.lt))) return false;
        if ('lte' in c && !(toNum(val) <= toNum(c.lte))) return false;
        if ('contains' in c) {
          const hay = String(val ?? '');
          const needle = String(c.contains ?? '');
          if (c.mode === 'insensitive') {
            if (!hay.toLowerCase().includes(needle.toLowerCase())) return false;
          } else if (!hay.includes(needle)) {
            return false;
          }
        }
      } else {
        if (val !== cond) return false;
      }
    }
    return true;
  }

  function applyUpdateData(row: any, data: any): any {
    const updated = { ...row };
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('increment' in v) {
          updated[k] = Number((toNum(updated[k]) + toNum((v as any).increment)).toFixed(6));
          continue;
        }
        if ('decrement' in v) {
          updated[k] = Number((toNum(updated[k]) - toNum((v as any).decrement)).toFixed(6));
          continue;
        }
      }
      updated[k] = v;
    }
    updated.updatedAt = new Date();
    return updated;
  }

  function applyOrderBy(rows: any[], orderBy: any): any[] {
    if (!orderBy) return rows;
    const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...rows].sort((a, b) => {
      for (const spec of specs) {
        const [field, dir] = Object.entries(spec)[0] as [string, 'asc' | 'desc'];
        const av = a[field];
        const bv = b[field];
        if (av === bv) continue;
        const cmp = av instanceof Date && bv instanceof Date
          ? av.getTime() - bv.getTime()
          : typeof av === 'number' && typeof bv === 'number'
            ? av - bv
            : String(av ?? '').localeCompare(String(bv ?? ''));
        return dir === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  }

  function buildDelegate(table: TableName, dbGetter: () => DbState) {
    return {
      async findMany(args: any = {}) {
        const db = dbGetter();
        let rows = db[table].filter(r => matchesWhere(table, r, args.where, db));
        if (args.orderBy) rows = applyOrderBy(rows, args.orderBy);
        if (typeof args.take === 'number') rows = rows.slice(0, args.take);
        return rows.map(r => hydrate(table, r, args.include, db));
      },
      async findFirst(args: any = {}) {
        const db = dbGetter();
        let rows = db[table].filter(r => matchesWhere(table, r, args.where, db));
        if (args.orderBy) rows = applyOrderBy(rows, args.orderBy);
        const found = rows[0] || null;
        return hydrate(table, found, args.include, db);
      },
      async findUnique(args: any = {}) {
        const db = dbGetter();
        const found = db[table].find(r => matchesWhere(table, r, args.where, db)) || null;
        return hydrate(table, found, args.include, db);
      },
      async count(args: any = {}) {
        const db = dbGetter();
        return db[table].filter(r => matchesWhere(table, r, args.where, db)).length;
      },
      async create(args: any) {
        const db = dbGetter();
        const now = new Date();
        const data = { ...(args.data || {}) };
        if (!data.id) data.id = nextId(table.toUpperCase());
        if (!data.createdAt) data.createdAt = now;
        if (!data.updatedAt) data.updatedAt = now;
        if (table === 'manufacturingOrder' && data.version === undefined) data.version = 1;
        if (table === 'productionOperation' && data.version === undefined) data.version = 1;
        if (table === 'productionTransfer' && data.version === undefined) data.version = 1;
        if (table === 'inventoryTransaction') {
          if (data.isReversal === undefined) data.isReversal = false;
          if (data.postingStatus === undefined) data.postingStatus = 'POSTED';
          if (data.locationId === undefined) data.locationId = null;
          if (data.materialLotId === undefined) data.materialLotId = null;
          if (data.physicalCoilId === undefined) data.physicalCoilId = null;
          if (data.contractId === undefined) data.contractId = null;
          if (data.documentId === undefined) data.documentId = null;
          if (data.manufacturingOrderId === undefined) data.manufacturingOrderId = null;
          if (data.productionOperationId === undefined) data.productionOperationId = null;
          if (data.productionReportId === undefined) data.productionReportId = null;
          if (data.reversalOfTrxId === undefined) data.reversalOfTrxId = null;
        }
        if (table === 'stockBalance') {
          if (data.locationId === undefined) data.locationId = null;
          if (data.materialLotId === undefined) data.materialLotId = null;
          if (data.physicalCoilId === undefined) data.physicalCoilId = null;
          if (data.contractId === undefined) data.contractId = null;
        }
        if (table === 'productionReport' && data.idempotencyKey) {
          const dup = db.productionReport.find(r => r.idempotencyKey === data.idempotencyKey);
          if (dup) {
            const err: any = new Error('Unique constraint failed on idempotencyKey');
            err.code = 'P2002';
            throw err;
          }
        }
        // Handle nested creates (e.g., operations.create on manufacturingOrder)
        let nestedOps: any[] | null = null;
        if (table === 'manufacturingOrder' && data.operations?.create) {
          nestedOps = data.operations.create;
          delete data.operations;
        }
        db[table].push(data);
        if (nestedOps) {
          for (const op of nestedOps) {
            db.productionOperation.push({
              id: op.id || nextId('OP'),
              manufacturingOrderId: data.id,
              version: 1,
              createdAt: now,
              updatedAt: now,
              waitingInputQty: 0,
              inProcessQty: 0,
              completedQty: 0,
              scrapQty: 0,
              reworkQty: 0,
              readyForTransferQty: 0,
              transferredQty: 0,
              ...op,
            });
          }
        }
        return hydrate(table, data, args.include, db);
      },
      async update(args: any) {
        const db = dbGetter();
        const idx = db[table].findIndex(r => matchesWhere(table, r, args.where, db));
        if (idx === -1) throw new Error(`Record not found for ${table}.update`);
        db[table][idx] = applyUpdateData(db[table][idx], args.data);
        return hydrate(table, db[table][idx], args.include, db);
      },
      async updateMany(args: any) {
        const db = dbGetter();
        let count = 0;
        for (let i = 0; i < db[table].length; i++) {
          if (matchesWhere(table, db[table][i], args.where, db)) {
            db[table][i] = applyUpdateData(db[table][i], args.data);
            count++;
          }
        }
        return { count };
      },
      async deleteMany(args: any = {}) {
        const db = dbGetter();
        const before = db[table].length;
        db[table] = db[table].filter(r => !matchesWhere(table, r, args.where, db));
        return { count: before - db[table].length };
      },
    };
  }

  const tables: TableName[] = [
    'user', 'unit', 'warehouse', 'warehouseLocation', 'part', 'operation', 'partRoute', 'partRouteOperation',
    'machine', 'shift', 'die', 'physicalCoil', 'materialLot', 'coilIssueReturnRecord',
    'manufacturingOrder', 'productionOperation', 'productionReport', 'productionScrap',
    'productionTransfer', 'productionActivityLog', 'machineAssignment',
    'wipManufacturingOrderLink', 'wipOperationLink', 'inventoryDocument',
    'inventoryDocumentLine', 'inventoryTransaction', 'stockBalance',
    'inventoryReservation', 'auditLog',
  ];

  function buildClient(dbGetter: () => DbState) {
    const client: any = {};
    for (const t of tables) {
      client[t] = buildDelegate(t, dbGetter);
    }
    client.$transaction = async (fn: (tx: any) => Promise<any>, _opts?: any) => {
      const snapshot = cloneState(state);
      const txClient = buildClient(() => snapshot);
      const result = await fn(txClient);
      state = snapshot;
      return result;
    };
    return client;
  }

  const rootClient = buildClient(getDb);
  return { client: rootClient, getState: getDb };
}

// ---------------------------------------------------------------------------
// Base Seed Fixture & Ledger Conservation Assertion Helper
// ---------------------------------------------------------------------------

function buildBaseFixture(): Partial<DbState> {
  const now = new Date();
  return {
    user: [{ id: 'USR-TEST-1', fullName: 'Test Operator', active: true }],
    unit: [
      { id: 'UNIT-PCS', code: 'PCS', name: 'عدد' },
      { id: 'UNIT-KG', code: 'KG', name: 'کیلوگرم' },
    ],
    warehouse: [
      { id: 'WH-RAW', code: 'WH-RAW', name: 'انبار مواد اولیه', type: 'RAW_MATERIAL', active: true },
      { id: 'WH-WIP-PRESS', code: 'WH-WIP-PRESS', name: 'انبار WIP پرس', type: 'WIP', active: true },
      { id: 'WH-WIP-WELD', code: 'WH-WIP-WELD', name: 'انبار WIP جوش', type: 'WIP', active: true },
      { id: 'WH-FG', code: 'WH-FG', name: 'انبار محصول نهایی', type: 'FINISHED_GOODS', active: true },
      { id: 'WH-SCRAP', code: 'WH-SCRAP', name: 'انبار ضایعات', type: 'SCRAP', active: true },
    ],
    warehouseLocation: [
      { id: 'LOC-RAW-1', warehouseId: 'WH-RAW', code: 'LOC-RAW-A1', name: 'ردیف رول A1', active: true },
      { id: 'LOC-PRESS-1', warehouseId: 'WH-WIP-PRESS', code: 'LOC-WIP-BLANK', name: 'پای خط بلانکینگ', active: true },
      { id: 'LOC-WELD-1', warehouseId: 'WH-WIP-WELD', code: 'LOC-WELD-IN', name: 'پای خط جوش نقطه‌ای', active: true },
      { id: 'LOC-WELD-2', warehouseId: 'WH-WIP-WELD', code: 'LOC-WELD-OUT', name: 'پای خط جوش CO2', active: true },
      { id: 'LOC-FG-1', warehouseId: 'WH-FG', code: 'LOC-FIN-P1', name: 'انبار محصول نهایی ۱', active: true },
      { id: 'LOC-SCRAP-1', warehouseId: 'WH-SCRAP', code: 'LOC-SCRAP-01', name: 'محل ضایعات ۱', active: true },
    ],
    part: [
      {
        id: 'PART-RAW-COIL',
        partNumber: 'RM-COIL-DC01A',
        name: 'رول ورق DC01A',
        category: 'RAW_MATERIAL',
        unitId: 'UNIT-KG',
        weightNetKg: 1,
        weightGrossKg: 1,
        active: true,
      },
      {
        id: 'PART-WIP-BRK',
        partNumber: 'WIP-ECU-MAIN-BRK',
        name: 'براکت اصلی ECU',
        category: 'WIP_PART',
        unitId: 'UNIT-PCS',
        weightNetKg: 0.9,
        weightGrossKg: 1.0,
        active: true,
      },
      {
        id: 'PART-FG-ECU',
        partNumber: 'FG-ECU-ASY-01',
        name: 'مجموعه نهایی براکت ECU',
        category: 'FINISHED_GOOD',
        unitId: 'UNIT-PCS',
        weightNetKg: 1.4,
        weightGrossKg: 1.5,
        active: true,
      },
    ],
    operation: [
      { id: 'OP-DEF-PRESS', code: 'OP-PRESS', name: 'بلانکینگ و برش', processType: 'BLANKING' },
      { id: 'OP-DEF-WELD', code: 'OP-WELD', name: 'جوش نقطه‌ای', processType: 'SPOT_WELD' },
      { id: 'OP-DEF-ASM', code: 'OP-ASM', name: 'جوش CO2 و تکمیل', processType: 'CO2_WELD' },
    ],
    partRoute: [
      { id: 'RT-WIP-BRK', partId: 'PART-WIP-BRK', code: 'RT-WIP-BRK', name: 'مسیر ساخت براکت', version: 1, status: 'ACTIVE', isDefault: true, createdAt: now },
      { id: 'RT-FG-ECU', partId: 'PART-FG-ECU', code: 'RT-FG-ECU', name: 'مسیر ساخت نهایی', version: 1, status: 'ACTIVE', isDefault: true, createdAt: now },
    ],
    partRouteOperation: [
      {
        id: 'RS-10',
        partRouteId: 'RT-WIP-BRK',
        operationId: 'OP-DEF-PRESS',
        stepNumber: 10,
        stepCode: 'OP10',
        stepName: 'بلانکینگ و برش',
        machineId: 'MCH-P1',
        dieId: null,
        standardCycleTimeSec: 12,
        scrapNormPercent: 2,
      },
      {
        id: 'RS-20',
        partRouteId: 'RT-WIP-BRK',
        operationId: 'OP-DEF-WELD',
        stepNumber: 20,
        stepCode: 'OP20',
        stepName: 'جوشکاری زیرمجموعه',
        machineId: 'MCH-W1',
        dieId: null,
        standardCycleTimeSec: 20,
        scrapNormPercent: 1,
      },
      {
        id: 'RS-FG-10',
        partRouteId: 'RT-FG-ECU',
        operationId: 'OP-DEF-ASM',
        stepNumber: 10,
        stepCode: 'OP10',
        stepName: 'مونتاژ نهایی',
        machineId: 'MCH-W1',
        dieId: null,
        standardCycleTimeSec: 25,
        scrapNormPercent: 1,
      },
    ],
    machine: [
      { id: 'MCH-P1', code: 'P-400', name: 'پرس ۴۰۰ تن', status: 'ACTIVE', active: true },
      { id: 'MCH-W1', code: 'W-100', name: 'ایستگاه جوش ۱', status: 'ACTIVE', active: true },
    ],
    shift: [{ id: 'SHIFT-M', code: 'MORNING', name: 'شیفت صبح', active: true }],
    materialLot: [
      {
        id: 'LOT-COIL-1',
        lotNumber: 'LOT-C1',
        heatNumber: 'HT-C1',
        partId: 'PART-RAW-COIL',
        initialWeightKg: 1000,
        remainingWeightKg: 1000,
        status: 'AVAILABLE',
        qualityStatus: 'AVAILABLE',
      },
      {
        id: 'LOT-COIL-2',
        lotNumber: 'LOT-C2',
        heatNumber: 'HT-C2',
        partId: 'PART-RAW-COIL',
        initialWeightKg: 1000,
        remainingWeightKg: 1000,
        status: 'AVAILABLE',
        qualityStatus: 'AVAILABLE',
      },
    ],
    physicalCoil: [
      {
        id: 'COIL-1',
        coilCode: 'COIL-001',
        coilPackNumber: 'CP-001',
        heatNumber: 'HT-C1',
        partId: 'PART-RAW-COIL',
        materialLotId: 'LOT-COIL-1',
        warehouseId: 'WH-RAW',
        locationId: 'LOC-RAW-1',
        originalWeightKg: 1000,
        remainingWeightKg: 1000,
        physicalStatus: 'AVAILABLE',
        qualityStatus: 'AVAILABLE',
        ownership: 'COMPANY_OWNED',
      },
      {
        id: 'COIL-2',
        coilCode: 'COIL-002',
        coilPackNumber: 'CP-002',
        heatNumber: 'HT-C2',
        partId: 'PART-RAW-COIL',
        materialLotId: 'LOT-COIL-2',
        warehouseId: 'WH-RAW',
        locationId: 'LOC-RAW-1',
        originalWeightKg: 1000,
        remainingWeightKg: 1000,
        physicalStatus: 'AVAILABLE',
        qualityStatus: 'AVAILABLE',
        ownership: 'COMPANY_OWNED',
      },
    ],
    stockBalance: [
      {
        id: 'BAL-COIL-1',
        partId: 'PART-RAW-COIL',
        warehouseId: 'WH-RAW',
        locationId: 'LOC-RAW-1',
        materialLotId: 'LOT-COIL-1',
        physicalCoilId: 'COIL-1',
        ownership: 'COMPANY_OWNED',
        qualityStatus: 'AVAILABLE',
        quantityOnHand: 1000,
        quantityReserved: 0,
        quantityAvailable: 1000,
        weightKgOnHand: 1000,
        weightKgReserved: 0,
        weightKgAvailable: 1000,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'BAL-COIL-2',
        partId: 'PART-RAW-COIL',
        warehouseId: 'WH-RAW',
        locationId: 'LOC-RAW-1',
        materialLotId: 'LOT-COIL-2',
        physicalCoilId: 'COIL-2',
        ownership: 'COMPANY_OWNED',
        qualityStatus: 'AVAILABLE',
        quantityOnHand: 1000,
        quantityReserved: 0,
        quantityAvailable: 1000,
        weightKgOnHand: 1000,
        weightKgReserved: 0,
        weightKgAvailable: 1000,
        createdAt: now,
        updatedAt: now,
      },
    ],
    inventoryTransaction: [
      {
        id: 'TX-OPEN-COIL-1',
        transactionType: 'OPENING_BALANCE',
        postingStatus: 'POSTED',
        partId: 'PART-RAW-COIL',
        warehouseId: 'WH-RAW',
        locationId: 'LOC-RAW-1',
        materialLotId: 'LOT-COIL-1',
        physicalCoilId: 'COIL-1',
        ownership: 'COMPANY_OWNED',
        qualityStatus: 'AVAILABLE',
        quantitySigned: 1000,
        weightKgSigned: 1000,
        balanceAfter: 1000,
        balanceKgAfter: 1000,
        transactionDate: now,
        createdAt: now,
      },
      {
        id: 'TX-OPEN-COIL-2',
        transactionType: 'OPENING_BALANCE',
        postingStatus: 'POSTED',
        partId: 'PART-RAW-COIL',
        warehouseId: 'WH-RAW',
        locationId: 'LOC-RAW-1',
        materialLotId: 'LOT-COIL-2',
        physicalCoilId: 'COIL-2',
        ownership: 'COMPANY_OWNED',
        qualityStatus: 'AVAILABLE',
        quantitySigned: 1000,
        weightKgSigned: 1000,
        balanceAfter: 1000,
        balanceKgAfter: 1000,
        transactionDate: now,
        createdAt: now,
      },
    ],
  };
}

function stockKey(row: any): string {
  return [
    row.partId,
    row.warehouseId,
    row.locationId || '',
    row.materialLotId || '',
    row.physicalCoilId || '',
    row.ownership || 'COMPANY_OWNED',
    row.qualityStatus || 'AVAILABLE',
  ].join('|');
}

function assertLedgerConserved(state: DbState, label: string) {
  const txTotals = new Map<string, { qty: number; kg: number }>();
  for (const tx of state.inventoryTransaction) {
    if (tx.postingStatus !== 'POSTED') continue;
    const key = stockKey(tx);
    const cur = txTotals.get(key) || { qty: 0, kg: 0 };
    cur.qty = Number((cur.qty + toNum(tx.quantitySigned)).toFixed(4));
    cur.kg = Number((cur.kg + toNum(tx.weightKgSigned)).toFixed(4));
    txTotals.set(key, cur);
  }
  const balMap = new Map<string, { qty: number; kg: number }>();
  for (const b of state.stockBalance) {
    const key = stockKey(b);
    balMap.set(key, {
      qty: Number(toNum(b.quantityOnHand).toFixed(4)),
      kg: Number(toNum(b.weightKgOnHand).toFixed(4)),
    });
    assert.ok(toNum(b.quantityOnHand) >= -1e-6, `[${label}] Negative StockBalance qty for ${key}: ${b.quantityOnHand}`);
    assert.ok(toNum(b.weightKgOnHand) >= -1e-6, `[${label}] Negative StockBalance kg for ${key}: ${b.weightKgOnHand}`);
  }
  const allKeys = new Set([...txTotals.keys(), ...balMap.keys()]);
  for (const key of allKeys) {
    const txSum = txTotals.get(key) || { qty: 0, kg: 0 };
    const bal = balMap.get(key) || { qty: 0, kg: 0 };
    assert.ok(
      Math.abs(txSum.qty - bal.qty) < 1e-3,
      `[${label}] Ledger qty mismatch for ${key}: SUM(POSTED)=${txSum.qty} vs StockBalance=${bal.qty}`
    );
    assert.ok(
      Math.abs(txSum.kg - bal.kg) < 1e-3,
      `[${label}] Ledger kg mismatch for ${key}: SUM(POSTED)=${txSum.kg} vs StockBalance=${bal.kg}`
    );
  }
}

// ---------------------------------------------------------------------------
// Test Runner
// ---------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

// ===========================================================================
// TEST 1: MO Rollback Ledger Conservation & PhysicalCoil / MaterialLot Restore
// ===========================================================================
test('1. MO Rollback preserves SUM(POSTED)===StockBalance, keeps originals POSTED, and restores PhysicalCoil & MaterialLot', async () => {
  const { client, getState } = createMockPrisma(buildBaseFixture());
  __setProductionWipPrismaForTests(client);

  const mo = await createManufacturingOrderDb({
    partId: 'PART-FG-ECU',
    targetQuantity: 100,
    initialInputQuantity: 50,
    sourceStockBalanceId: 'BAL-COIL-1',
    sourceWeightKg: 75,
    createdByUserId: 'USR-TEST-1',
  });

  // Verify coil & lot were deducted during material load
  let s = getState();
  assert.equal(s.physicalCoil.find(c => c.id === 'COIL-1')!.remainingWeightKg, 925);
  assert.equal(s.physicalCoil.find(c => c.id === 'COIL-1')!.physicalStatus, 'PARTIALLY_ISSUED');
  assert.equal(s.materialLot.find(l => l.id === 'LOT-COIL-1')!.remainingWeightKg, 925);
  assertLedgerConserved(s, 'after MO creation + load');

  // Post production through final op (OP10) so FG output is created without an InventoryDocument
  const op10 = mo.operations[0];
  await postWipProductionDb({
    moId: mo.id,
    operationId: op10.id,
    idempotencyKey: 'KEY-T1-OP10',
    shiftId: 'SHIFT-M',
    createdByUserId: 'USR-TEST-1',
    goodQty: 30,
    scrapQty: 5,
    scrapReason: 'ترک ورق',
    expectedVersion: mo.version,
  });

  s = getState();
  assertLedgerConserved(s, 'after OP10 production');

  // Impact preview must allow rollback cleanly
  const preview = await analyzeMoRollbackImpactDb(mo.id, true);
  assert.ok(preview);
  assert.equal(preview.canRollback, true);
  assert.equal(preview.blockingErrors.length, 0);

  // Execute rollback
  const summary = await deleteManufacturingOrderWithRollbackDb({
    moIdOrNumber: mo.id,
    cascadeSubMos: true,
    reason: 'Regression test rollback',
    requestedUserId: 'USR-TEST-1',
  });
  assert.equal(summary.deletedMoCount, 1);

  s = getState();
  // Every InventoryTransaction stays POSTED (originals NOT mutated to REVERSED!)
  const nonPosted = s.inventoryTransaction.filter(tx => tx.postingStatus !== 'POSTED');
  assert.equal(nonPosted.length, 0, 'Original InventoryTransactions must remain POSTED; offsetting reversals must be POSTED');

  // Mathematical conservation across ALL stock keys
  assertLedgerConserved(s, 'after MO rollback');

  // PhysicalCoil & MaterialLot restored to exact pre-MO state!
  const coil1 = s.physicalCoil.find(c => c.id === 'COIL-1')!;
  const lot1 = s.materialLot.find(l => l.id === 'LOT-COIL-1')!;
  assert.equal(coil1.remainingWeightKg, 1000);
  assert.equal(coil1.physicalStatus, 'AVAILABLE');
  assert.equal(lot1.remainingWeightKg, 1000);
  assert.equal(lot1.status, 'AVAILABLE');

  // Coil balance back to 1000; FG and WIP and SCRAP balances back to 0
  const balCoil1 = s.stockBalance.find(b => b.id === 'BAL-COIL-1')!;
  assert.equal(balCoil1.quantityOnHand, 1000);
  assert.equal(balCoil1.weightKgOnHand, 1000);
  const fgBals = s.stockBalance.filter(b => b.partId === 'PART-FG-ECU');
  for (const b of fgBals) {
    assert.equal(b.quantityOnHand, 0);
    assert.equal(b.weightKgOnHand, 0);
  }
});

// ===========================================================================
// TEST 2: Downstream Consumption Blocks Unsafe MO Rollback (Zero Clamping)
// ===========================================================================
test('2. Downstream consumption of production outputs blocks MO rollback with 409 and zero clamping', async () => {
  const { client, getState } = createMockPrisma(buildBaseFixture());
  __setProductionWipPrismaForTests(client);

  const mo = await createManufacturingOrderDb({
    partId: 'PART-FG-ECU',
    targetQuantity: 40,
    initialInputQuantity: 40,
    sourceStockBalanceId: 'BAL-COIL-1',
    sourceWeightKg: 60,
    createdByUserId: 'USR-TEST-1',
  });

  await postWipProductionDb({
    moId: mo.id,
    operationId: mo.operations[0].id,
    idempotencyKey: 'KEY-T2-OP10',
    shiftId: 'SHIFT-M',
    createdByUserId: 'USR-TEST-1',
    goodQty: 40,
    scrapQty: 0,
  });

  // Simulate downstream customer shipment consuming 15 PCS of FG output
  const s = getState();
  const fgBal = s.stockBalance.find(b => b.partId === 'PART-FG-ECU' && b.warehouseId === 'WH-FG')!;
  assert.ok(fgBal && fgBal.quantityOnHand === 40);
  fgBal.quantityOnHand = 25;
  fgBal.quantityAvailable = 25;
  fgBal.weightKgOnHand = Number((25 * 1.4).toFixed(4));
  fgBal.weightKgAvailable = fgBal.weightKgOnHand;
  s.inventoryTransaction.push({
    id: 'TX-DOWNSTREAM-SHIP-1',
    transactionType: 'CUSTOMER_SHIPMENT',
    postingStatus: 'POSTED',
    partId: fgBal.partId,
    warehouseId: fgBal.warehouseId,
    locationId: fgBal.locationId,
    materialLotId: fgBal.materialLotId,
    physicalCoilId: fgBal.physicalCoilId,
    ownership: fgBal.ownership,
    qualityStatus: fgBal.qualityStatus,
    quantitySigned: -15,
    weightKgSigned: -21,
    balanceAfter: 25,
    balanceKgAfter: 35,
    transactionDate: new Date(),
    createdAt: new Date(),
  });

  // Preview must block rollback
  const preview = await analyzeMoRollbackImpactDb(mo.id, true);
  assert.ok(preview);
  assert.equal(preview.canRollback, false);
  assert.ok(preview.blockingErrors.length > 0, 'Expected blockingErrors for downstream consumption');

  const txCountBefore = getState().inventoryTransaction.length;

  // Delete attempt must reject with 409 and mutate NOTHING
  await assert.rejects(
    () =>
      deleteManufacturingOrderWithRollbackDb({
        moIdOrNumber: mo.id,
        cascadeSubMos: true,
        reason: 'Unsafe rollback attempt',
        requestedUserId: 'USR-TEST-1',
      }),
    (err: any) => err instanceof WipServiceError && err.statusCode === 409
  );

  const after = getState();
  assert.equal(after.manufacturingOrder.length, 1, 'MO must not be deleted');
  assert.equal(after.inventoryTransaction.length, txCountBefore, 'No reversal tx should be written');
  assert.equal(after.stockBalance.find(b => b.id === fgBal.id)!.quantityOnHand, 25, 'FG balance must remain untouched (no clamping)');
  assertLedgerConserved(after, 'after blocked unsafe rollback');
});

// ===========================================================================
// TEST 3: Transfer Integrity — Zero Stock Minting & Atomic Guards
// ===========================================================================
test('3. Transfer approve & reject fail closed (409) when IN_TRANSIT stock is missing/insufficient, and conserve ledger on valid flow', async () => {
  const { client, getState } = createMockPrisma(buildBaseFixture());
  __setProductionWipPrismaForTests(client);

  // Two-operation WIP MO (OP10 PRESS -> OP20 WELD)
  const mo = await createManufacturingOrderDb({
    partId: 'PART-WIP-BRK',
    targetQuantity: 100,
    initialInputQuantity: 100,
    sourceStockBalanceId: 'BAL-COIL-1',
    sourceWeightKg: 100,
    createdByUserId: 'USR-TEST-1',
  });
  const op10 = mo.operations[0];
  const op20 = mo.operations[1];

  // Mark 60 PCS of OP10's MO-backed WIP as readyForTransferQty and dispatch a manual transfer (OP10 -> OP20)
  const op10Row = getState().productionOperation.find(o => o.id === op10.id)!;
  op10Row.readyForTransferQty = 60;
  op10Row.waitingInputQty = 40;

  const manualDispatch = await createOperationTransferDb({
    moId: mo.id,
    fromOperationId: op10.id,
    toOperationId: op20.id,
    quantity: 60,
    createdByUserId: 'USR-TEST-1',
  });
  const transferId = manualDispatch.id;
  assert.equal(getState().productionTransfer.find(t => t.id === transferId)!.status, 'DISPATCHED');
  assertLedgerConserved(getState(), 'after OP10 manual transfer dispatch');

  // Tamper: deplete IN_TRANSIT balance to simulate missing/insufficient in-transit stock
  const inTransitBal = getState().stockBalance.find(b => b.qualityStatus === 'IN_TRANSIT')!;
  assert.ok(inTransitBal && inTransitBal.quantityOnHand === 60, 'Expected 60 PCS in IN_TRANSIT');
  const savedQty = inTransitBal.quantityOnHand;
  const savedKg = inTransitBal.weightKgOnHand;
  inTransitBal.quantityOnHand = 10;
  inTransitBal.quantityAvailable = 10;
  inTransitBal.weightKgOnHand = 9;
  inTransitBal.weightKgAvailable = 9;

  // Approve MUST reject with 409 without minting stock or altering transfer status
  await assert.rejects(
    () =>
      approveOperationTransferDb({
        transferId,
        createdByUserId: 'USR-TEST-1',
      }),
    (err: any) => err instanceof WipServiceError && err.statusCode === 409
  );
  assert.equal(getState().productionTransfer.find(t => t.id === transferId)!.status, 'DISPATCHED');
  assert.equal(getState().stockBalance.find(b => b.id === inTransitBal.id)!.quantityOnHand, 10);

  // Reject MUST also reject with 409 without minting stock or altering transfer status
  await assert.rejects(
    () =>
      rejectOperationTransferDb({
        transferId,
        rejectionReason: 'Damaged pallet',
        createdByUserId: 'USR-TEST-1',
      }),
    (err: any) => err instanceof WipServiceError && err.statusCode === 409
  );
  assert.equal(getState().productionTransfer.find(t => t.id === transferId)!.status, 'DISPATCHED');

  // Restore genuine IN_TRANSIT stock and test valid REJECT -> manual TRANSFER -> APPROVE
  inTransitBal.quantityOnHand = savedQty;
  inTransitBal.quantityAvailable = savedQty;
  inTransitBal.weightKgOnHand = savedKg;
  inTransitBal.weightKgAvailable = savedKg;

  const rejected = await rejectOperationTransferDb({
    transferId,
    rejectionReason: 'Recount needed',
    createdByUserId: 'USR-TEST-1',
  });
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(getState().productionTransfer.find(t => t.id === transferId)!.status, 'REJECTED');
  assertLedgerConserved(getState(), 'after valid transfer rejection');

  // Verify rejection activity log type is TRANSFER_REJECT (not TRANSFER_APPROVE)
  const rejectLog = getState().productionActivityLog.find(l => l.activityType === 'TRANSFER_REJECT');
  assert.ok(rejectLog, 'Expected TRANSFER_REJECT activity log entry');

  // Now create a manual transfer of 40 PCS and approve it
  const manualTr = await createOperationTransferDb({
    moId: mo.id,
    fromOperationId: op10.id,
    toOperationId: op20.id,
    quantity: 40,
    createdByUserId: 'USR-TEST-1',
  });
  assert.equal(getState().productionTransfer.find(t => t.id === manualTr.id)!.status, 'DISPATCHED');
  assertLedgerConserved(getState(), 'after manual transfer creation');

  const approved = await approveOperationTransferDb({
    transferId: manualTr.id,
    createdByUserId: 'USR-TEST-1',
  });
  assert.equal(approved.status, 'APPROVED');
  assert.equal(getState().productionTransfer.find(t => t.id === manualTr.id)!.status, 'RECEIVED');
  assertLedgerConserved(getState(), 'after valid transfer approval');
});

// ===========================================================================
// TEST 4: Cross-MO Isolation & Optimistic Concurrency (CAS)
// ===========================================================================
test('4. Cross-MO isolation prevents stealing sibling MO stock and optimistic version CAS rejects stale writes', async () => {
  const { client, getState } = createMockPrisma(buildBaseFixture());
  __setProductionWipPrismaForTests(client);

  // Create MO-A (50 PCS loaded from COIL-1) and MO-B (100 PCS loaded from COIL-2) for the SAME part at SAME location
  const moA = await createManufacturingOrderDb({
    partId: 'PART-FG-ECU',
    targetQuantity: 100,
    initialInputQuantity: 50,
    sourceStockBalanceId: 'BAL-COIL-1',
    sourceWeightKg: 75,
    createdByUserId: 'USR-TEST-1',
  });
  const moB = await createManufacturingOrderDb({
    partId: 'PART-FG-ECU',
    targetQuantity: 100,
    initialInputQuantity: 100,
    sourceStockBalanceId: 'BAL-COIL-2',
    sourceWeightKg: 150,
    createdByUserId: 'USR-TEST-1',
  });

  // Artificially inflate MO-A's waitingInputQty to 80 to prove ledger-scoped MO check stops MO-A from stealing MO-B's 100 PCS!
  const opRowA = getState().productionOperation.find(o => o.id === moA.operations[0].id)!;
  opRowA.waitingInputQty = 80;

  await assert.rejects(
    () =>
      postWipProductionDb({
        moId: moA.id,
        operationId: moA.operations[0].id,
        idempotencyKey: 'KEY-T4-STEAL',
        shiftId: 'SHIFT-M',
        createdByUserId: 'USR-TEST-1',
        goodQty: 60, // exceeds MO-A's 50 owned balance even though location total is 150!
        scrapQty: 0,
      }),
    (err: any) => err instanceof WipServiceError && err.statusCode === 409
  );
  assertLedgerConserved(getState(), 'after blocked cross-MO steal');

  // Valid MO-A post of 40 succeeds and only consumes COIL-1's WIP balance (MO-B's COIL-2 untouched)
  opRowA.waitingInputQty = 50;
  const postedA = await postWipProductionDb({
    moId: moA.id,
    operationId: moA.operations[0].id,
    idempotencyKey: 'KEY-T4-VALID',
    shiftId: 'SHIFT-M',
    createdByUserId: 'USR-TEST-1',
    goodQty: 40,
    scrapQty: 0,
    expectedVersion: moA.version,
  });
  assert.ok(postedA.mo, 'Expected updated MO DTO after production post');
  assert.equal(postedA.mo.version, moA.version + 1);
  const balCoil2Wip = getState().stockBalance.find(
    b => b.partId === 'PART-FG-ECU' && b.warehouseId === 'WH-WIP-WELD' && b.physicalCoilId === 'COIL-2'
  )!;
  assert.equal(balCoil2Wip.quantityOnHand, 100, 'MO-B COIL-2 WIP stock must remain 100% untouched');
  assertLedgerConserved(getState(), 'after isolated MO-A production');

  // Stale expectedVersion CAS rejection across mutations
  await assert.rejects(
    () =>
      loadMaterialIntoMoDb({
        moId: moA.id,
        quantity: 10,
        sourceStockBalanceId: 'BAL-COIL-1',
        sourceWeightKg: 15,
        createdByUserId: 'USR-TEST-1',
        expectedVersion: 1, // stale!
      }),
    (err: any) => err instanceof WipServiceError && err.statusCode === 409 && err.conflict === true
  );

  await assert.rejects(
    () =>
      registerOperationInputDb({
        moId: moA.id,
        operationId: moA.operations[0].id,
        quantity: 5,
        expectedVersion: 1, // stale!
      }),
    (err: any) => err instanceof WipServiceError && err.statusCode === 409 && err.conflict === true
  );

  await assert.rejects(
    () =>
      postWipProductionDb({
        moId: moA.id,
        operationId: moA.operations[0].id,
        idempotencyKey: 'KEY-T4-STALE',
        shiftId: 'SHIFT-M',
        createdByUserId: 'USR-TEST-1',
        goodQty: 5,
        scrapQty: 0,
        expectedVersion: 1, // stale!
      }),
    (err: any) => err instanceof WipServiceError && err.statusCode === 409 && err.conflict === true
  );
});

// ===========================================================================
// TEST 5: Closed / Cancelled MOs Reject All Mutations
// ===========================================================================
test('5. CANCELLED and CLOSED manufacturing orders reject all material/production/transfer mutations with 409', async () => {
  const { client, getState } = createMockPrisma(buildBaseFixture());
  __setProductionWipPrismaForTests(client);

  const mo = await createManufacturingOrderDb({
    partId: 'PART-WIP-BRK',
    targetQuantity: 50,
    initialInputQuantity: 50,
    sourceStockBalanceId: 'BAL-COIL-1',
    sourceWeightKg: 50,
    createdByUserId: 'USR-TEST-1',
  });
  const op10 = mo.operations[0];
  const op20 = mo.operations[1];
  const op10Row = getState().productionOperation.find(o => o.id === op10.id)!;
  op10Row.readyForTransferQty = 20;
  op10Row.waitingInputQty = 30;
  const pendingTr = await createOperationTransferDb({
    moId: mo.id,
    fromOperationId: op10.id,
    toOperationId: op20.id,
    quantity: 20,
    createdByUserId: 'USR-TEST-1',
  });
  const trId = pendingTr.id;

  // Test both CANCELLED and CLOSED states
  for (const terminalStatus of ['CANCELLED', 'CLOSED'] as const) {
    getState().manufacturingOrder.find(m => m.id === mo.id)!.status = terminalStatus;

    await assert.rejects(
      () =>
        loadMaterialIntoMoDb({
          moId: mo.id,
          quantity: 5,
          sourceStockBalanceId: 'BAL-COIL-1',
          sourceWeightKg: 5,
          createdByUserId: 'USR-TEST-1',
        }),
      (err: any) => err instanceof WipServiceError && err.statusCode === 409
    );

    await assert.rejects(
      () =>
        registerOperationInputDb({
          moId: mo.id,
          operationId: op10.id,
          quantity: 5,
        }),
      (err: any) => err instanceof WipServiceError && err.statusCode === 409
    );

    await assert.rejects(
      () =>
        postWipProductionDb({
          moId: mo.id,
          operationId: op10.id,
          idempotencyKey: `KEY-T5-${terminalStatus}`,
          shiftId: 'SHIFT-M',
          createdByUserId: 'USR-TEST-1',
          goodQty: 5,
          scrapQty: 0,
        }),
      (err: any) => err instanceof WipServiceError && err.statusCode === 409
    );

    await assert.rejects(
      () =>
        createOperationTransferDb({
          moId: mo.id,
          fromOperationId: op10.id,
          toOperationId: op20.id,
          quantity: 5,
          createdByUserId: 'USR-TEST-1',
        }),
      (err: any) => err instanceof WipServiceError && err.statusCode === 409
    );

    await assert.rejects(
      () => approveOperationTransferDb({ transferId: trId, createdByUserId: 'USR-TEST-1' }),
      (err: any) => err instanceof WipServiceError && err.statusCode === 409
    );

    await assert.rejects(
      () => rejectOperationTransferDb({ transferId: trId, createdByUserId: 'USR-TEST-1' }),
      (err: any) => err instanceof WipServiceError && err.statusCode === 409
    );
  }
});

// ===========================================================================
// TEST 6: Atomic Sub-MO Batch Generation (All-or-Nothing Rollback)
// ===========================================================================
test('6. createSubManufacturingOrdersBatchDb links parentMo relationally and rolls back completely on mid-batch failure', async () => {
  const { client, getState } = createMockPrisma(buildBaseFixture());
  __setProductionWipPrismaForTests(client);

  const parentMo = await createManufacturingOrderDb({
    partId: 'PART-FG-ECU',
    targetQuantity: 50,
    createdByUserId: 'USR-TEST-1',
  });

  // Mid-batch failure: item 1 is valid with material load, item 2 references nonexistent part
  await assert.rejects(
    () =>
      createSubManufacturingOrdersBatchDb({
        masterMoNumber: parentMo.moNumber,
        bomId: 'BOM-ECU-01',
        bomAssemblyPartCode: 'FG-ECU-ASY-01',
        createdByUserId: 'USR-TEST-1',
        items: [
          {
            partId: 'PART-WIP-BRK',
            partCode: 'WIP-ECU-MAIN-BRK',
            requiredQty: 50,
            sourceStockBalanceId: 'BAL-COIL-1',
            sourceWeightKg: 50,
          },
          {
            partCode: 'NON-EXISTENT-PART-999',
            requiredQty: 50,
          },
        ],
      }),
    (err: any) => err instanceof WipServiceError && err.statusCode === 404
  );

  // Confirm ZERO Sub-MOs were created and COIL-1 was NOT touched!
  let s = getState();
  assert.equal(s.manufacturingOrder.length, 1, 'Failed batch must leave 0 Sub-MOs');
  assert.equal(s.physicalCoil.find(c => c.id === 'COIL-1')!.remainingWeightKg, 1000, 'Failed batch must not deduct coil');
  assertLedgerConserved(s, 'after rolled-back Sub-MO batch');

  // Now run a valid atomic batch
  const batchRes = await createSubManufacturingOrdersBatchDb({
    masterMoNumber: parentMo.moNumber,
    bomId: 'BOM-ECU-01',
    bomAssemblyPartCode: 'FG-ECU-ASY-01',
    createdByUserId: 'USR-TEST-1',
    items: [
      {
        partId: 'PART-WIP-BRK',
        partCode: 'WIP-ECU-MAIN-BRK',
        requiredQty: 50,
        sourceStockBalanceId: 'BAL-COIL-1',
        sourceWeightKg: 50,
      },
    ],
  });
  assert.equal(batchRes.length, 1);
  const subMoRow = getState().manufacturingOrder.find(m => m.id === batchRes[0].moId)!;
  assert.equal(subMoRow.parentMoId, parentMo.id, 'Sub-MO must be linked to parentMoId relationally');
  assertLedgerConserved(getState(), 'after successful Sub-MO batch');
});

// ===========================================================================
// TEST 7: Retired Legacy Endpoint & Scenarios Execute Guard
// ===========================================================================
test('7. POST /api/production/execute-op-backflush is explicitly retired with HTTP 410 Gone', async () => {
  const { apiRouter } = await import('../src/server/apiRouter');
  const layer = (apiRouter as any).stack.find(
    (l: any) => l.route && l.route.path === '/production/execute-op-backflush' && l.route.methods.post
  );
  assert.ok(layer, 'Expected /production/execute-op-backflush route to be registered');

  let statusCode = 200;
  let body: any = null;
  const mockRes: any = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: any) {
      body = payload;
      return this;
    },
  };
  await layer.route.stack[0].handle({ body: { partCode: 'WIP-ECU-MAIN-BRK', shiftDeltaGoodQty: 10 } } as any, mockRes, () => {});
  assert.equal(statusCode, 410);
  assert.equal(body?.success, false);
  assert.equal(body?.retired, true);
  assert.equal(body?.replacementEndpoints?.loadMaterial, '/api/wip/manufacturing-orders/:id/load-material');
  assert.equal(body?.replacementEndpoints?.postProduction, '/api/wip/operations/production');
});

// ---------------------------------------------------------------------------
// Execute All Tests
// ---------------------------------------------------------------------------
async function main() {
  let passed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`PASS: ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`FAIL: ${t.name}`);
      console.error(err);
      process.exitCode = 1;
    } finally {
      __setProductionWipPrismaForTests(null);
    }
  }
  console.log(`\nSummary: ${passed}/${tests.length} isolated WIP audit regression tests passed.`);
  if (passed !== tests.length) process.exit(1);
}

main();
