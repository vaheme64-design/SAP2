/**
 * =========================================================================
 * KPIMS P1: End-to-End Inventory & Production (WIP) Integration Suite
 * =========================================================================
 * Strictly isolated relational mock verification (ZERO live PG contact).
 * Run with: DATABASE_URL="" npx tsx scripts/test-kpims-p1-integration.ts
 * =========================================================================
 */

import assert from 'node:assert/strict';
import express from 'express';
import {
  postInventoryDocumentInTransaction,
  autoReserveMoMaterialsInDbTransaction,
  issuePhysicalCoilInDbTransaction,
  returnPhysicalCoilRemnantInDbTransaction,
  queryContractsAndSapcoAccountFromDb,
  createReservationInDbTransaction,
} from '../src/server/services/inventoryLedgerService';
import {
  __setProductionWipPrismaForTests,
  WipServiceError,
  loadMaterialIntoMoDb,
  postWipProductionDb,
  createOperationTransferDb,
  approveOperationTransferDb,
  deleteManufacturingOrderWithRollbackDb,
} from '../src/server/services/productionWipService';

if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '') {
  throw new Error('Refusing to run isolated P1 test suite when DATABASE_URL is configured.');
}

const TEST_USER = { uid: 'USR-P1-TEST', displayName: 'اپراتور تست یکپارچه P1' };

type TableKey =
  | 'role'
  | 'user'
  | 'unitOfMeasure'
  | 'warehouse'
  | 'warehouseLocation'
  | 'material'
  | 'part'
  | 'item'
  | 'bomComponent'
  | 'customer'
  | 'materialContract'
  | 'materialLot'
  | 'physicalCoil'
  | 'contractCoilAllocation'
  | 'materialContractTransaction'
  | 'operation'
  | 'partRoute'
  | 'partRouteOperation'
  | 'machine'
  | 'shift'
  | 'die'
  | 'manufacturingOrder'
  | 'productionOperation'
  | 'productionReport'
  | 'productionScrap'
  | 'productionTransfer'
  | 'productionActivityLog'
  | 'machineAssignment'
  | 'wipManufacturingOrderLink'
  | 'wipOperationLink'
  | 'coilIssueReturnRecord'
  | 'inventoryDocument'
  | 'inventoryDocumentLine'
  | 'inventoryTransaction'
  | 'inventoryReservation'
  | 'stockBalance'
  | 'auditLog';

type MockDb = Record<TableKey, any[]>;

let seq = 1;
const uid = (prefix: string) => `${prefix}-${seq++}`;

function num(v: any): number {
  return Number(v ?? 0);
}

function makeP2002(target: string[]): any {
  const err: any = new Error(`Unique constraint failed on (${target.join(', ')})`);
  err.code = 'P2002';
  err.meta = { target };
  return err;
}

function matchCond(val: any, cond: any): boolean {
  if (cond === undefined) return true;
  if (cond === null) return val === null || val === undefined;
  if (typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    if ('equals' in cond && val !== cond.equals) return false;
    if ('in' in cond && (!Array.isArray(cond.in) || !cond.in.includes(val))) return false;
    if ('notIn' in cond && Array.isArray(cond.notIn) && cond.notIn.includes(val)) return false;
    if ('not' in cond) {
      if (cond.not === null) {
        if (val === null || val === undefined) return false;
      } else if (val === cond.not) {
        return false;
      }
    }
    if ('gt' in cond && !(num(val) > num(cond.gt) + 1e-9)) return false;
    if ('gte' in cond && !(num(val) >= num(cond.gte) - 1e-9)) return false;
    if ('lt' in cond && !(num(val) < num(cond.lt) - 1e-9)) return false;
    if ('lte' in cond && !(num(val) <= num(cond.lte) + 1e-9)) return false;
    if ('contains' in cond) {
      const hay = String(val ?? '');
      const needle = String(cond.contains ?? '');
      if (cond.mode === 'insensitive') {
        if (!hay.toLowerCase().includes(needle.toLowerCase())) return false;
      } else if (!hay.includes(needle)) {
        return false;
      }
    }
    return true;
  }
  return val === cond;
}

function matchesWhere(table: TableKey, row: any, where: any, db: MockDb): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (k === 'OR' && Array.isArray(cond)) {
      if (!cond.some(sub => matchesWhere(table, row, sub, db))) return false;
      continue;
    }
    if (k === 'AND' && Array.isArray(cond)) {
      if (!cond.every(sub => matchesWhere(table, row, sub, db))) return false;
      continue;
    }
    if (k === 'part' && typeof cond === 'object' && cond !== null) {
      const p = db.part.find(r => r.id === row.partId);
      if (!p || !matchesWhere('part', p, (cond as any).is ?? cond, db)) return false;
      continue;
    }
    if (k === 'warehouse' && typeof cond === 'object' && cond !== null) {
      const w = db.warehouse.find(r => r.id === row.warehouseId);
      if (!w || !matchesWhere('warehouse', w, (cond as any).is ?? cond, db)) return false;
      continue;
    }
    if (k === 'document' && typeof cond === 'object' && cond !== null) {
      const d = db.inventoryDocument.find(r => r.id === row.documentId);
      if (!d || !matchesWhere('inventoryDocument', d, (cond as any).is ?? cond, db)) return false;
      continue;
    }
    if (k === 'operations' && typeof cond === 'object' && cond !== null && 'some' in (cond as any)) {
      const ops = db.productionOperation.filter(o => o.manufacturingOrderId === row.id);
      if (!ops.some(o => matchesWhere('productionOperation', o, (cond as any).some, db))) return false;
      continue;
    }
    if (!matchCond(row[k], cond)) return false;
  }
  return true;
}

function applyUpdateData(row: any, data: any): any {
  const next = { ...row };
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('increment' in v) {
        next[k] = Number((num(next[k]) + num((v as any).increment)).toFixed(6));
        continue;
      }
      if ('decrement' in v) {
        next[k] = Number((num(next[k]) - num((v as any).decrement)).toFixed(6));
        continue;
      }
    }
    next[k] = v;
  }
  next.updatedAt = new Date();
  return next;
}

function subSpec(spec: any): any {
  if (!spec || typeof spec !== 'object') return undefined;
  return spec.include || spec.select;
}

function hydrate(table: TableKey, row: any, include: any, db: MockDb): any {
  if (!row) return null;
  const out = { ...row };
  if (!include) return out;

  if (table === 'part') {
    if (include.unit) out.unit = db.unitOfMeasure.find(u => u.id === row.unitId) || null;
    if (include.material) out.material = db.material.find(m => m.id === row.materialId) || null;
  }
  if (table === 'warehouse' && include.locations) {
    let locs = db.warehouseLocation.filter(l => l.warehouseId === row.id);
    if (include.locations?.where) {
      locs = locs.filter(l => matchesWhere('warehouseLocation', l, include.locations.where, db));
    }
    out.locations = locs;
  }
  if (table === 'warehouseLocation' && include.warehouse) {
    out.warehouse = db.warehouse.find(w => w.id === row.warehouseId) || null;
  }
  if (table === 'bomComponent' && include.childItem) {
    out.childItem = db.item.find(i => i.id === row.childItemId) || null;
  }
  if (table === 'physicalCoil') {
    if (include.material) out.material = db.material.find(m => m.id === row.materialId) || null;
    if (include.part) out.part = hydrate('part', db.part.find(p => p.id === row.partId), subSpec(include.part), db);
    if (include.warehouse) out.warehouse = db.warehouse.find(w => w.id === row.warehouseId) || null;
    if (include.warehouseLocation) out.warehouseLocation = db.warehouseLocation.find(l => l.id === row.warehouseLocationId) || null;
    if (include.contractAllocations) {
      out.contractAllocations = db.contractCoilAllocation
        .filter(a => a.coilId === row.id)
        .map(a => hydrate('contractCoilAllocation', a, subSpec(include.contractAllocations), db));
    }
    if (include.issueReturnRecords) {
      out.issueReturnRecords = db.coilIssueReturnRecord
        .filter(r => r.coilId === row.id)
        .map(r => hydrate('coilIssueReturnRecord', r, subSpec(include.issueReturnRecords), db));
    }
    if (include.inventoryTransactions) {
      out.inventoryTransactions = db.inventoryTransaction
        .filter(t => t.physicalCoilId === row.id)
        .map(t => hydrate('inventoryTransaction', t, subSpec(include.inventoryTransactions), db));
    }
    if (include.inventoryDocumentLines) {
      out.inventoryDocumentLines = db.inventoryDocumentLine
        .filter(l => l.physicalCoilId === row.id)
        .map(l => hydrate('inventoryDocumentLine', l, subSpec(include.inventoryDocumentLines), db));
    }
  }
  if (table === 'contractCoilAllocation' && include.contract) {
    out.contract = db.materialContract.find(c => c.id === row.contractId) || null;
  }
  if (table === 'materialContract') {
    if (include.material) out.material = db.material.find(m => m.id === row.materialId) || null;
    if (include.supplierCustomer) out.supplierCustomer = db.customer.find(c => c.id === row.supplierCustomerId) || null;
    if (include.coilAllocations || include.contractCoilAllocations) {
      const allocSpec = subSpec(include.coilAllocations || include.contractCoilAllocations);
      const allocRows = db.contractCoilAllocation
        .filter(a => a.contractId === row.id)
        .map(a => ({
          ...a,
          coil: hydrate('physicalCoil', db.physicalCoil.find(c => c.id === a.coilId), subSpec(allocSpec?.coil), db),
        }));
      if (include.coilAllocations) out.coilAllocations = allocRows;
      if (include.contractCoilAllocations) out.contractCoilAllocations = allocRows;
    }
    if (include.transactions) {
      out.transactions = db.materialContractTransaction.filter(t => t.contractId === row.id);
    }
  }
  if (table === 'stockBalance') {
    if (include.part) out.part = hydrate('part', db.part.find(p => p.id === row.partId), subSpec(include.part), db);
    if (include.warehouse) out.warehouse = db.warehouse.find(w => w.id === row.warehouseId) || null;
    if (include.location) out.location = db.warehouseLocation.find(l => l.id === row.locationId) || null;
    if (include.materialLot) out.materialLot = hydrate('materialLot', db.materialLot.find(l => l.id === row.materialLotId), subSpec(include.materialLot), db);
    if (include.physicalCoil) out.physicalCoil = hydrate('physicalCoil', db.physicalCoil.find(c => c.id === row.physicalCoilId), subSpec(include.physicalCoil), db);
  }
  if (table === 'materialLot' && include.material) {
    out.material = db.material.find(m => m.id === row.materialId) || null;
  }
  if (table === 'inventoryDocument') {
    if (include.lines) {
      out.lines = db.inventoryDocumentLine
        .filter(l => l.documentId === row.id)
        .map(l => hydrate('inventoryDocumentLine', l, subSpec(include.lines), db));
    }
    if (include.transactions) {
      out.transactions = db.inventoryTransaction
        .filter(t => t.documentId === row.id)
        .map(t => hydrate('inventoryTransaction', t, subSpec(include.transactions), db));
    }
    if (include.coilIssueReturnRecords) {
      out.coilIssueReturnRecords = db.coilIssueReturnRecord.filter(r => r.inventoryDocumentId === row.id);
    }
    if (include.warehouse) out.warehouse = db.warehouse.find(w => w.id === row.warehouseId) || null;
    if (include.targetWarehouse) out.targetWarehouse = db.warehouse.find(w => w.id === row.targetWarehouseId) || null;
    if (include.createdByUser) out.createdByUser = db.user.find(u => u.id === row.createdByUserId) || null;
    if (include.postedByUser) out.postedByUser = db.user.find(u => u.id === row.postedByUserId) || null;
  }
  if (table === 'inventoryDocumentLine') {
    if (include.document) out.document = db.inventoryDocument.find(d => d.id === row.documentId) || null;
    if (include.part) out.part = hydrate('part', db.part.find(p => p.id === row.partId), subSpec(include.part), db);
  }
  if (table === 'inventoryTransaction') {
    if (include.document) out.document = db.inventoryDocument.find(d => d.id === row.documentId) || null;
    if (include.part) out.part = hydrate('part', db.part.find(p => p.id === row.partId), subSpec(include.part), db);
    if (include.materialLot) out.materialLot = hydrate('materialLot', db.materialLot.find(l => l.id === row.materialLotId), subSpec(include.materialLot), db);
    if (include.physicalCoil) out.physicalCoil = hydrate('physicalCoil', db.physicalCoil.find(c => c.id === row.physicalCoilId), subSpec(include.physicalCoil), db);
    if (include.warehouse) out.warehouse = db.warehouse.find(w => w.id === row.warehouseId) || null;
    if (include.location) out.location = db.warehouseLocation.find(l => l.id === row.locationId) || null;
    if (include.unit) out.unit = db.unitOfMeasure.find(u => u.id === row.unitId) || null;
    if (include.manufacturingOrder) {
      out.manufacturingOrder = hydrate('manufacturingOrder', db.manufacturingOrder.find(m => m.id === row.manufacturingOrderId), subSpec(include.manufacturingOrder), db);
    }
    if (include.productionOperation) {
      out.productionOperation = hydrate('productionOperation', db.productionOperation.find(o => o.id === row.productionOperationId), subSpec(include.productionOperation), db);
    }
  }
  if (table === 'coilIssueReturnRecord') {
    if (include.coil) out.coil = hydrate('physicalCoil', db.physicalCoil.find(c => c.id === row.coilId), subSpec(include.coil), db);
    if (include.inventoryDocument) out.inventoryDocument = db.inventoryDocument.find(d => d.id === row.inventoryDocumentId) || null;
    if (include.manufacturingOrder) out.manufacturingOrder = hydrate('manufacturingOrder', db.manufacturingOrder.find(m => m.id === row.manufacturingOrderId), subSpec(include.manufacturingOrder), db);
    if (include.part) out.part = hydrate('part', db.part.find(p => p.id === row.partId), subSpec(include.part), db);
    if (include.productionOperation) {
      out.productionOperation = hydrate('productionOperation', db.productionOperation.find(o => o.id === row.productionOperationId), subSpec(include.productionOperation), db);
    }
  }
  if (table === 'manufacturingOrder') {
    if (include.part) out.part = hydrate('part', db.part.find(p => p.id === row.partId), subSpec(include.part), db);
    if (include.parentMo) out.parentMo = db.manufacturingOrder.find(m => m.id === row.parentMoId) || null;
    if (include.operations) {
      out.operations = db.productionOperation
        .filter(o => o.manufacturingOrderId === row.id)
        .sort((a, b) => a.stepNumber - b.stepNumber)
        .map(o => hydrate('productionOperation', o, subSpec(include.operations), db));
    }
    if (include.reports) {
      out.reports = db.productionReport
        .filter(r => r.manufacturingOrderId === row.id)
        .map(r => hydrate('productionReport', r, subSpec(include.reports), db));
    }
    if (include.transfers) {
      out.transfers = db.productionTransfer
        .filter(t => t.manufacturingOrderId === row.id)
        .map(t => hydrate('productionTransfer', t, subSpec(include.transfers), db));
    }
    if (include.activityLogs) {
      out.activityLogs = db.productionActivityLog.filter(l => l.manufacturingOrderId === row.id);
    }
  }
  if (table === 'productionOperation') {
    if (include.operation) out.operation = db.operation.find(o => o.id === row.operationId) || null;
    if (include.plannedMachine) out.plannedMachine = db.machine.find(m => m.id === row.plannedMachineId) || null;
    if (include.plannedDie) out.plannedDie = db.die.find(d => d.id === row.plannedDieId) || null;
    if (include.warehouse) out.warehouse = db.warehouse.find(w => w.id === row.warehouseId) || null;
    if (include.location) out.location = hydrate('warehouseLocation', db.warehouseLocation.find(l => l.id === row.locationId), subSpec(include.location), db);
  }
  if (table === 'productionReport') {
    if (include.machine) out.machine = db.machine.find(m => m.id === row.machineId) || null;
    if (include.operatorUser) out.operatorUser = db.user.find(u => u.id === row.operatorUserId) || null;
    if (include.scraps) out.scraps = db.productionScrap.filter(s => s.productionReportId === row.id);
    if (include.productionOperation) out.productionOperation = hydrate('productionOperation', db.productionOperation.find(o => o.id === row.productionOperationId), subSpec(include.productionOperation), db);
  }
  if (table === 'productionTransfer') {
    if (include.manufacturingOrder) out.manufacturingOrder = db.manufacturingOrder.find(m => m.id === row.manufacturingOrderId) || null;
    if (include.part) out.part = db.part.find(p => p.id === row.partId) || null;
    if (include.fromWarehouse) out.fromWarehouse = db.warehouse.find(w => w.id === row.fromWarehouseId) || null;
    if (include.toWarehouse) out.toWarehouse = db.warehouse.find(w => w.id === row.toWarehouseId) || null;
    if (include.fromLocation) out.fromLocation = db.warehouseLocation.find(l => l.id === row.fromLocationId) || null;
    if (include.toLocation) out.toLocation = db.warehouseLocation.find(l => l.id === row.toLocationId) || null;
  }
  return out;
}

function createUnifiedMockPrisma(seed: Partial<MockDb>) {
  let state: MockDb = {
    role: [],
    user: [],
    unitOfMeasure: [],
    warehouse: [],
    warehouseLocation: [],
    material: [],
    part: [],
    item: [],
    bomComponent: [],
    customer: [],
    materialContract: [],
    materialLot: [],
    physicalCoil: [],
    contractCoilAllocation: [],
    materialContractTransaction: [],
    operation: [],
    partRoute: [],
    partRouteOperation: [],
    machine: [],
    shift: [],
    die: [],
    manufacturingOrder: [],
    productionOperation: [],
    productionReport: [],
    productionScrap: [],
    productionTransfer: [],
    productionActivityLog: [],
    machineAssignment: [],
    wipManufacturingOrderLink: [],
    wipOperationLink: [],
    coilIssueReturnRecord: [],
    inventoryDocument: [],
    inventoryDocumentLine: [],
    inventoryTransaction: [],
    inventoryReservation: [],
    stockBalance: [],
    auditLog: [],
    ...structuredClone(seed),
  };

  function checkUnique(table: TableKey, row: any, db: MockDb, excludeId?: string) {
    if (table === 'inventoryDocument') {
      if (row.idempotencyKey && db.inventoryDocument.some(d => d.id !== excludeId && d.idempotencyKey === row.idempotencyKey)) {
        throw makeP2002(['idempotencyKey']);
      }
      if (row.issueRequestKey && db.inventoryDocument.some(d => d.id !== excludeId && d.issueRequestKey === row.issueRequestKey)) {
        throw makeP2002(['issueRequestKey']);
      }
      if (db.inventoryDocument.some(d => d.id !== excludeId && d.documentNumber === row.documentNumber)) {
        throw makeP2002(['documentNumber']);
      }
    }
    if (table === 'stockBalance') {
      const keyMatch = (r: any) =>
        r.id !== excludeId &&
        r.partId === row.partId &&
        r.warehouseId === row.warehouseId &&
        (r.locationId ?? null) === (row.locationId ?? null) &&
        (r.materialLotId ?? null) === (row.materialLotId ?? null) &&
        (r.physicalCoilId ?? null) === (row.physicalCoilId ?? null) &&
        r.ownership === row.ownership &&
        (r.contractId ?? null) === (row.contractId ?? null) &&
        r.qualityStatus === row.qualityStatus;
      if (db.stockBalance.some(keyMatch)) {
        throw makeP2002(['partId', 'warehouseId', 'locationId', 'materialLotId', 'physicalCoilId', 'ownership', 'contractId', 'qualityStatus']);
      }
    }
    if (table === 'productionReport') {
      if (row.wipIdempotencyKey && db.productionReport.some(r => r.id !== excludeId && r.wipIdempotencyKey === row.wipIdempotencyKey)) {
        throw makeP2002(['wipIdempotencyKey']);
      }
    }
  }

  function sortRows(rows: any[], orderBy: any): any[] {
    if (!orderBy) return rows;
    const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...rows].sort((a, b) => {
      for (const spec of specs) {
        const [field, dir] = Object.entries(spec)[0] as [string, 'asc' | 'desc'];
        const av = a[field];
        const bv = b[field];
        if (av === bv) continue;
        const cmp =
          av instanceof Date && bv instanceof Date
            ? av.getTime() - bv.getTime()
            : typeof av === 'number' && typeof bv === 'number'
              ? av - bv
              : String(av ?? '').localeCompare(String(bv ?? ''));
        return dir === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  }

  function makeDelegate(table: TableKey, getDb: () => MockDb) {
    return {
      async findMany(args: any = {}) {
        const db = getDb();
        let rows = db[table].filter(r => matchesWhere(table, r, args.where, db));
        if (args.orderBy) rows = sortRows(rows, args.orderBy);
        if (typeof args.take === 'number') rows = rows.slice(0, args.take);
        return rows.map(r => hydrate(table, r, args.include, db));
      },
      async findFirst(args: any = {}) {
        const db = getDb();
        let rows = db[table].filter(r => matchesWhere(table, r, args.where, db));
        if (args.orderBy) rows = sortRows(rows, args.orderBy);
        return rows[0] ? hydrate(table, rows[0], args.include, db) : null;
      },
      async findUnique(args: any = {}) {
        const db = getDb();
        const row = db[table].find(r => matchesWhere(table, r, args.where, db));
        return row ? hydrate(table, row, args.include, db) : null;
      },
      async count(args: any = {}) {
        const db = getDb();
        return db[table].filter(r => matchesWhere(table, r, args.where, db)).length;
      },
      async create(args: any) {
        const db = getDb();
        const now = new Date();
        const row = {
          id: args.data.id || uid(table.slice(0, 4).toUpperCase()),
          createdAt: now,
          updatedAt: now,
          version: table === 'stockBalance' || table === 'physicalCoil' || table === 'manufacturingOrder' || table === 'productionOperation' ? 1 : undefined,
          ...(table === 'inventoryDocument' ? { isReversed: false } : {}),
          ...(table === 'inventoryTransaction' ? { isReversal: false } : {}),
          ...args.data,
        };
        checkUnique(table, row, db);
        db[table].push(row);
        return hydrate(table, row, args.include, db);
      },
      async update(args: any) {
        const db = getDb();
        const idx = db[table].findIndex(r => matchesWhere(table, r, args.where, db));
        if (idx === -1) throw new Error(`Record not found in ${table}`);
        const next = applyUpdateData(db[table][idx], args.data);
        checkUnique(table, next, db, next.id);
        db[table][idx] = next;
        return hydrate(table, next, args.include, db);
      },
      async updateMany(args: any) {
        const db = getDb();
        let count = 0;
        for (let i = 0; i < db[table].length; i++) {
          if (matchesWhere(table, db[table][i], args.where, db)) {
            db[table][i] = applyUpdateData(db[table][i], args.data);
            count += 1;
          }
        }
        return { count };
      },
      async deleteMany(args: any = {}) {
        const db = getDb();
        const before = db[table].length;
        db[table] = db[table].filter(r => !matchesWhere(table, r, args.where, db));
        return { count: before - db[table].length };
      },
    };
  }

  function makeClient(getDb: () => MockDb): any {
    const client: any = {};
    const keys: TableKey[] = [
      'role', 'user', 'unitOfMeasure', 'warehouse', 'warehouseLocation',
      'material', 'part', 'item', 'bomComponent', 'customer', 'materialContract',
      'materialLot', 'physicalCoil', 'contractCoilAllocation', 'materialContractTransaction',
      'operation', 'partRoute', 'partRouteOperation', 'machine', 'shift', 'die',
      'manufacturingOrder', 'productionOperation', 'productionReport', 'productionScrap',
      'productionTransfer', 'productionActivityLog', 'machineAssignment',
      'wipManufacturingOrderLink', 'wipOperationLink', 'coilIssueReturnRecord',
      'inventoryDocument', 'inventoryDocumentLine', 'inventoryTransaction',
      'inventoryReservation', 'stockBalance', 'auditLog',
    ];
    for (const k of keys) {
      client[k] = makeDelegate(k, getDb);
    }
    client.$transaction = async (fn: (tx: any) => Promise<any>) => {
      const staged = structuredClone(state);
      const tx = makeClient(() => staged);
      const result = await fn(tx);
      state = staged;
      return result;
    };
    return client;
  }

  const root = makeClient(() => state);
  return { client: root, getState: () => state };
}

function buildSeedState(): Partial<MockDb> {
  const now = new Date();
  return {
    role: [{ id: 'role-admin', name: 'ADMIN', displayName: 'مدیر سیستم', active: true }],
    user: [
      { id: 'user-p1', username: 'USR-P1-TEST', email: 'usr@kpims.local', fullName: 'اپراتور خط پ۱', personnelCode: '1001', roleId: 'role-admin', active: true },
    ],
    unitOfMeasure: [
      { id: 'unit-kg', code: 'KG', name: 'کیلوگرم', symbol: 'kg' },
      { id: 'unit-pcs', code: 'PCS', name: 'عدد', symbol: 'pcs' },
    ],
    warehouse: [
      { id: 'wh-raw', code: 'WH-RAW', name: 'انبار مواد اولیه', type: 'RAW_MATERIAL', active: true },
      { id: 'wh-wip', code: 'WH-WIP', name: 'انبار بین‌عملیاتی WIP', type: 'WIP', active: true },
      { id: 'wh-fg', code: 'WH-FIN', name: 'انبار محصول نهایی', type: 'FINISHED_GOODS', active: true },
      { id: 'wh-scrap', code: 'WH-SCRAP', name: 'انبار ضایعات', type: 'SCRAP', active: true },
    ],
    warehouseLocation: [
      { id: 'loc-raw-a1', warehouseId: 'wh-raw', code: 'LOC-RAW-A1', name: 'جایگاه ورق A1', active: true },
      { id: 'loc-wip-blank', warehouseId: 'wh-wip', code: 'LOC-WIP-BLANK', name: 'پای پرس بلنکینگ', active: true },
      { id: 'loc-wip-draw', warehouseId: 'wh-wip', code: 'LOC-WIP-DRAWN', name: 'پای پرس کشش', active: true },
      { id: 'loc-fin-p1', warehouseId: 'wh-fg', code: 'LOC-FIN-P1', name: 'بسته‌بندی محصول نهایی', active: true },
      { id: 'loc-scrap-1', warehouseId: 'wh-scrap', code: 'LOC-SCRAP-01', name: 'قفس ضایعات پرس', active: true },
    ],
    material: [
      { id: 'mat-st14', code: 'ST14-12', name: 'ورق روغنی ST14', grade: 'ST14', standard: 'DIN 1623', active: true },
    ],
    customer: [
      { id: 'cust-sapco', code: 'SAPCO', name: 'ساپکو', active: true },
    ],
    materialContract: [
      {
        id: 'ctr-a', contractNumber: 'CTR-P1-A', title: 'قرارداد ساپکو الف', supplierCustomerId: 'cust-sapco',
        materialId: 'mat-st14', totalAllocatedWeightKg: 5000, status: 'ACTIVE', startDate: now, endDate: new Date(now.getTime() + 86400_000 * 60),
      },
      {
        id: 'ctr-b', contractNumber: 'CTR-P1-B', title: 'قرارداد ساپکو ب', supplierCustomerId: 'cust-sapco',
        materialId: 'mat-st14', totalAllocatedWeightKg: 5000, status: 'ACTIVE', startDate: now, endDate: new Date(now.getTime() + 86400_000 * 60),
      },
    ],
    part: [
      {
        id: 'part-coil-st14', partNumber: 'RM-COIL-ST14', name: 'کلاف ورق ST14 ضخامت ۱.۲', category: 'RAW_MATERIAL',
        unitId: 'unit-kg', materialId: 'mat-st14', weightNetKg: 1, weightGrossKg: 1, thicknessMm: 1.2, active: true,
      },
      {
        id: 'part-bpil-fg', partNumber: 'FG-BPIL-01', name: 'ستون وسط خودرو', category: 'FINISHED_GOOD',
        unitId: 'unit-pcs', materialId: 'mat-st14', weightNetKg: 0.4, weightGrossKg: 0.5, active: true,
      },
    ],
    item: [
      { id: 'item-fg', code: 'FG-BPIL-01', name: 'ستون وسط خودرو', type: 'FINISHED_GOOD', unit: 'PCS', weightNetKg: 0.4, weightGrossKg: 0.5, isDeleted: false },
      { id: 'item-rm', code: 'RM-COIL-ST14', name: 'کلاف ورق ST14 ضخامت ۱.۲', type: 'RAW_MATERIAL', unit: 'KG', weightNetKg: 1, weightGrossKg: 1, isDeleted: false },
    ],
    bomComponent: [
      { id: 'bom-1', parentItemId: 'item-fg', childItemId: 'item-rm', quantity: 0.5, scrapFactor: 0, version: '1.0', isDeleted: false },
    ],
    operation: [
      { id: 'op-blank', code: 'OP-BLANK', name: 'بلنکینگ اولیه', processType: 'BLANKING', active: true },
      { id: 'op-draw', code: 'OP-DRAW', name: 'کشش نهایی', processType: 'DRAWING', active: true },
    ],
    machine: [
      { id: 'mach-400t', code: 'PRS-400T', name: 'پرس ۴۰۰ تن', active: true, status: 'ACTIVE' },
      { id: 'mach-800t', code: 'PRS-800T', name: 'پرس ۸۰۰ تن', active: true, status: 'ACTIVE' },
    ],
    shift: [
      { id: 'shift-a', code: 'SHIFT-A', name: 'شیفت صبح', active: true },
    ],
    die: [],
    materialLot: [
      {
        id: 'lot-1', lotNumber: 'LOT-P1-001', materialId: 'mat-st14', supplierContractId: 'ctr-a',
        initialWeightKg: 1000, remainingWeightKg: 1000, status: 'AVAILABLE', warehouseLocationId: 'loc-raw-a1',
      },
    ],
    physicalCoil: [
      {
        id: 'coil-1', coilId: 'COIL-P1-001', coilPackNumber: 'PK-P1-001', partId: 'part-coil-st14',
        materialId: 'mat-st14', materialLotId: 'lot-1', heatNumber: 'HT-P1-99',
        thicknessMm: 1.2, widthMm: 1000, originalWeightKg: 1000, remainingWeightKg: 1000,
        ownership: 'SAPCO_SUPPLIER_OWNED', qualityStatus: 'AVAILABLE', physicalStatus: 'AVAILABLE',
        warehouseId: 'wh-raw', warehouseLocationId: 'loc-raw-a1', version: 1,
        createdAt: now, updatedAt: now,
      },
    ],
    contractCoilAllocation: [
      { id: 'cca-a', coilId: 'coil-1', contractId: 'ctr-a', allocatedWeightKg: 600, ownership: 'SAPCO_SUPPLIER_OWNED', allocationDate: now },
      { id: 'cca-b', coilId: 'coil-1', contractId: 'ctr-b', allocatedWeightKg: 400, ownership: 'SAPCO_SUPPLIER_OWNED', allocationDate: now },
    ],
    stockBalance: [
      {
        id: 'sb-coil-a', partId: 'part-coil-st14', warehouseId: 'wh-raw', locationId: 'loc-raw-a1',
        materialLotId: 'lot-1', physicalCoilId: 'coil-1', ownership: 'SAPCO_SUPPLIER_OWNED',
        contractId: 'ctr-a', contractNumber: 'CTR-P1-A', qualityStatus: 'AVAILABLE',
        quantityOnHand: 600, quantityReserved: 0, quantityAvailable: 600,
        weightKgOnHand: 600, weightKgReserved: 0, weightKgAvailable: 600, version: 1,
        createdAt: now, updatedAt: now,
      },
      {
        id: 'sb-coil-b', partId: 'part-coil-st14', warehouseId: 'wh-raw', locationId: 'loc-raw-a1',
        materialLotId: 'lot-1', physicalCoilId: 'coil-1', ownership: 'SAPCO_SUPPLIER_OWNED',
        contractId: 'ctr-b', contractNumber: 'CTR-P1-B', qualityStatus: 'AVAILABLE',
        quantityOnHand: 400, quantityReserved: 0, quantityAvailable: 400,
        weightKgOnHand: 400, weightKgReserved: 0, weightKgAvailable: 400, version: 1,
        createdAt: now, updatedAt: now,
      },
    ],
    manufacturingOrder: [
      {
        id: 'mo-1', moNumber: 'MO-P1-001', partId: 'part-bpil-fg', targetQty: 1000,
        initialInputQty: 0, completedQty: 0, scrapQty: 0, totalReworkQty: 0, totalRejectedQty: 0,
        status: 'PLANNED', version: 1, createdAt: now, updatedAt: now,
      },
      {
        id: 'mo-other', moNumber: 'MO-P1-OTHER', partId: 'part-bpil-fg', targetQty: 1200,
        initialInputQty: 0, completedQty: 0, scrapQty: 0, totalReworkQty: 0, totalRejectedQty: 0,
        status: 'PLANNED', version: 1, createdAt: now, updatedAt: now,
      },
    ],
    productionOperation: [
      {
        id: 'op-mo1-10', manufacturingOrderId: 'mo-1', operationId: 'op-blank', stepNumber: 10, sequence: 10,
        stepCode: 'OP-BLANK', stepName: 'بلنکینگ اولیه', plannedMachineId: 'mach-400t',
        warehouseId: 'wh-wip', locationId: 'loc-wip-blank', warehouseLocationCode: 'LOC-WIP-BLANK',
        waitingInputQty: 0, inProgressQty: 0, readyForTransferQty: 0, transferredQty: 0,
        inputQty: 0, outputGoodQty: 0, outputScrapQty: 0, outputReworkQty: 0, outputRejectedQty: 0,
        status: 'PENDING', version: 1, createdAt: now, updatedAt: now,
      },
      {
        id: 'op-mo1-20', manufacturingOrderId: 'mo-1', operationId: 'op-draw', stepNumber: 20, sequence: 20,
        stepCode: 'OP-DRAW', stepName: 'کشش نهایی', plannedMachineId: 'mach-800t',
        warehouseId: 'wh-wip', locationId: 'loc-wip-draw', warehouseLocationCode: 'LOC-WIP-DRAWN',
        waitingInputQty: 0, inProgressQty: 0, readyForTransferQty: 0, transferredQty: 0,
        inputQty: 0, outputGoodQty: 0, outputScrapQty: 0, outputReworkQty: 0, outputRejectedQty: 0,
        status: 'PENDING', version: 1, createdAt: now, updatedAt: now,
      },
      {
        id: 'op-other-10', manufacturingOrderId: 'mo-other', operationId: 'op-blank', stepNumber: 10, sequence: 10,
        stepCode: 'OP-BLANK', stepName: 'بلنکینگ اولیه', plannedMachineId: 'mach-400t',
        warehouseId: 'wh-wip', locationId: 'loc-wip-blank', warehouseLocationCode: 'LOC-WIP-BLANK',
        waitingInputQty: 0, inProgressQty: 0, readyForTransferQty: 0, transferredQty: 0,
        inputQty: 0, outputGoodQty: 0, outputScrapQty: 0, outputReworkQty: 0, outputRejectedQty: 0,
        status: 'PENDING', version: 1, createdAt: now, updatedAt: now,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Test 1: MRP Auto-Reserve + MO Consumption + Cross-MO Reservation Isolation
// ---------------------------------------------------------------------------
async function test1MrpAutoReserveAndCrossMoIsolation() {
  const { client, getState } = createUnifiedMockPrisma(buildSeedState());
  // Adjust stock on coil-1 so MO-1 reserves 500 kg (out of 1000 kg); MO-OTHER tries 600 kg (> 500 unreserved free!)
  const res = await autoReserveMoMaterialsInDbTransaction(client, 'mo-1', { user: TEST_USER });
  assert.equal(res.success, true, `Auto-reserve failed: ${res.error}`);
  assert.equal(res.data?.reserved.length, 1);
  assert.equal(res.data?.reserved[0].quantity, 500);
  assert.equal(res.data?.shortages.length, 0);

  const db = getState();
  assert.equal(db.inventoryReservation.filter(r => r.reservedForMOId === 'mo-1' && r.status === 'ACTIVE').length, 1);
  const totalReserved = db.stockBalance.reduce((s, b) => s + num(b.quantityReserved), 0);
  const totalAvailable = db.stockBalance.reduce((s, b) => s + num(b.quantityAvailable), 0);
  assert.equal(totalReserved, 500);
  assert.equal(totalAvailable, 500);

  // Sibling MO-OTHER cannot steal MO-1's reserved 500 kg when asking for 600 kg
  const stolen = await issuePhysicalCoilInDbTransaction(client, {
    coilIdOrCode: 'coil-1',
    issueRequestKey: 'REQ-P1-STEAL-0001',
    requested: [
      {
        manufacturingOrderRef: 'mo-other',
        operationRef: 'op-other-10',
        partRef: null,
        issuedWeightKg: 600,
        varianceWeightKg: 0,
        initialInputQuantityPcs: 1200,
        wipManufacturingOrderId: null,
      },
    ],
    createdByUserId: 'user-p1',
  });
  assert.equal(stolen.success, false, 'Sibling MO must not steal another MO reservation');
  assert.equal(stolen.statusCode, 409);

  // MO-1 itself CAN issue 500 kg because consumeMoReservationsInTx unlocks MO-1's own active reservation!
  const ownIssue = await issuePhysicalCoilInDbTransaction(client, {
    coilIdOrCode: 'coil-1',
    issueRequestKey: 'REQ-P1-OWN-0001',
    requested: [
      {
        manufacturingOrderRef: 'mo-1',
        operationRef: 'op-mo1-10',
        partRef: null,
        issuedWeightKg: 500,
        varianceWeightKg: 0,
        initialInputQuantityPcs: 1000,
        wipManufacturingOrderId: null,
      },
    ],
    createdByUserId: 'user-p1',
  });
  assert.equal(ownIssue.success, true, `MO-1 own reserved issue failed: ${ownIssue.error}`);
  const dbAfterIssue = getState();
  assert.equal(dbAfterIssue.inventoryReservation.every(r => r.reservedForMOId !== 'mo-1' || r.status === 'CONSUMED'), true);
  assert.equal(dbAfterIssue.physicalCoil[0].remainingWeightKg, 500);
  assert.equal(dbAfterIssue.materialLot[0].status, 'IN_USE');
  console.log('PASS: 1. MRP auto-reserve consumes cleanly for owning MO and blocks sibling MO theft (409)');
}

// ---------------------------------------------------------------------------
// Test 2: Multi-Contract Issue -> First-Op WIP Settlement -> No Op-2 Double-Count
//         -> Over-Return Block (422) -> Exact Remnant Return -> SAPCO Ledger
// ---------------------------------------------------------------------------
async function test2MultiContractWipSettlementRemnantAndSapco() {
  const seed = buildSeedState();
  // Set MO-1 target to 200 pcs and coil contracts 60/40 (600kg CTR-P1-A, 400kg CTR-P1-B -> issue 100kg takes 100kg from CTR-A or split)
  // Let's configure sb-coil-a=60kg & sb-coil-b=40kg (plus CTR-A 600kg originally wait: set coil-1=100kg with 60kg CTR-A & 40kg CTR-B)
  seed.physicalCoil![0].originalWeightKg = 100;
  seed.physicalCoil![0].remainingWeightKg = 100;
  seed.materialLot![0].initialWeightKg = 100;
  seed.materialLot![0].remainingWeightKg = 100;
  seed.contractCoilAllocation![0].allocatedWeightKg = 60;
  seed.contractCoilAllocation![1].allocatedWeightKg = 40;
  seed.stockBalance![0].quantityOnHand = 60;
  seed.stockBalance![0].quantityAvailable = 60;
  seed.stockBalance![0].weightKgOnHand = 60;
  seed.stockBalance![0].weightKgAvailable = 60;
  seed.stockBalance![1].quantityOnHand = 40;
  seed.stockBalance![1].quantityAvailable = 40;
  seed.stockBalance![1].weightKgOnHand = 40;
  seed.stockBalance![1].weightKgAvailable = 40;
  seed.manufacturingOrder![0].targetQty = 200;

  const { client, getState } = createUnifiedMockPrisma(seed);
  __setProductionWipPrismaForTests(client);

  // Issue entire 100 kg (60 CTR-A + 40 CTR-B) for 200 pcs initial input (0.5 kg gross / pc)
  const iss = await issuePhysicalCoilInDbTransaction(client, {
    coilIdOrCode: 'coil-1',
    issueRequestKey: 'REQ-P1-MULTI-0001',
    requested: [
      {
        manufacturingOrderRef: 'mo-1',
        operationRef: 'op-mo1-10',
        partRef: null,
        issuedWeightKg: 100,
        varianceWeightKg: 0,
        initialInputQuantityPcs: 200,
        wipManufacturingOrderId: null,
      },
    ],
    createdByUserId: 'user-p1',
  });
  assert.equal(iss.success, true, iss.error);
  assert.equal(iss.issueRecords?.length, 2, 'Expected 2 contract-split CoilIssueReturnRecords');
  assert.equal(getState().physicalCoil[0].remainingWeightKg, 0);
  assert.equal(getState().materialLot[0].status, 'CONSUMED');

  // Step 10 produces 120 GOOD + 20 SCRAP = 140 PCS (uses 140 * 0.5kg = 70kg steel: 42kg CTR-A + 28kg CTR-B)
  const r1 = await postWipProductionDb({
    moId: 'mo-1',
    operationId: 'op-mo1-10',
    idempotencyKey: 'WIP-OP10-REPORT-001',
    machineId: 'mach-400t',
    shiftId: 'shift-a',
    createdByUserId: 'user-p1',
    goodQty: 120,
    scrapQty: 20,
    scrapReason: 'پارگی کشش',
  });
  assert.equal(r1.duplicate, false);

  const dbAfterOp10 = getState();
  const openCirAfterOp10 = dbAfterOp10.coilIssueReturnRecord.filter(r => r.issuedWeightKg > 0);
  const totalConsumedAfterOp10 = openCirAfterOp10.reduce((s, r) => s + num(r.consumedWeightKg), 0);
  const totalVarianceAfterOp10 = openCirAfterOp10.reduce((s, r) => s + num(r.varianceWeightKg), 0);
  const totalOutstandingAfterOp10 = openCirAfterOp10.reduce((s, r) => s + num(r.outstandingWeightKg), 0);
  assert.ok(Math.abs(totalConsumedAfterOp10 - 60) < 1e-4, `Expected 60kg consumed on OP10, got ${totalConsumedAfterOp10}`);
  assert.ok(Math.abs(totalVarianceAfterOp10 - 10) < 1e-4, `Expected 10kg variance on OP10, got ${totalVarianceAfterOp10}`);
  assert.ok(Math.abs(totalOutstandingAfterOp10 - 30) < 1e-4, `Expected 30kg outstanding after OP10, got ${totalOutstandingAfterOp10}`);

  // Step 20 produces 120 GOOD -> must NOT double-count coil steel consumption!
  const r2 = await postWipProductionDb({
    moId: 'mo-1',
    operationId: 'op-mo1-20',
    idempotencyKey: 'WIP-OP20-REPORT-001',
    machineId: 'mach-800t',
    shiftId: 'shift-a',
    createdByUserId: 'user-p1',
    goodQty: 120,
    scrapQty: 0,
  });
  assert.equal(r2.duplicate, false);
  const totalOutstandingAfterOp20 = getState().coilIssueReturnRecord
    .filter(r => r.issuedWeightKg > 0)
    .reduce((s, r) => s + num(r.outstandingWeightKg), 0);
  assert.ok(Math.abs(totalOutstandingAfterOp20 - 30) < 1e-4, 'Step 20 must NOT double-count raw coil consumption');

  // Over-return attempt (35kg > 30kg outstanding) MUST fail 422!
  const overRet = await returnPhysicalCoilRemnantInDbTransaction(client, {
    coilIdOrCode: 'coil-1',
    returnedWeightKg: 35,
    varianceWeightKg: 0,
    idempotencyKey: 'RET-P1-OVER-0001',
    user: TEST_USER,
  });
  assert.equal(overRet.success, false);
  assert.equal(overRet.statusCode, 422);

  // Valid remnant return of exact 30 kg -> restores 18kg to CTR-A and 12kg to CTR-B!
  const validRet = await returnPhysicalCoilRemnantInDbTransaction(client, {
    coilIdOrCode: 'coil-1',
    returnedWeightKg: 30,
    varianceWeightKg: 0,
    idempotencyKey: 'RET-P1-VALID-0001',
    user: TEST_USER,
  });
  assert.equal(validRet.success, true, `Valid remnant return failed: ${validRet.error}`);
  const dbFinal = getState();
  assert.equal(dbFinal.physicalCoil[0].remainingWeightKg, 30);
  assert.equal(dbFinal.physicalCoil[0].physicalStatus, 'PARTIALLY_ISSUED');
  assert.equal(dbFinal.materialLot[0].status, 'AVAILABLE');
  assert.equal(
    dbFinal.coilIssueReturnRecord.filter(r => r.issuedWeightKg > 0).every(r => num(r.outstandingWeightKg) <= 1e-4),
    true,
  );
  const rawSbA = dbFinal.stockBalance.find(
    b => b.physicalCoilId === 'coil-1' && b.warehouseId === 'wh-raw' && b.contractId === 'ctr-a',
  );
  const rawSbB = dbFinal.stockBalance.find(
    b => b.physicalCoilId === 'coil-1' && b.warehouseId === 'wh-raw' && b.contractId === 'ctr-b',
  );
  // Step 10 consumed 140 pcs = 70 kg FIFO: 120 pcs (60 kg) completely exhausted CTR-A, and 20 pcs (10 kg) came from CTR-B -> all 30 kg remnant belongs to CTR-B
  assert.ok(Math.abs(num(rawSbA?.weightKgOnHand) - 0) < 1e-3, `Expected 0kg left on CTR-A, got ${rawSbA?.weightKgOnHand}`);
  assert.ok(Math.abs(num(rawSbB?.weightKgOnHand) - 30) < 1e-3, `Expected 30kg restored to CTR-B, got ${rawSbB?.weightKgOnHand}`);

  // SAPCO ledger must ONLY count net coil consumption (60kg for A, 10kg for B), excluding WIP transfers/inputs/reports!
  const sapco = await queryContractsAndSapcoAccountFromDb(client);
  const ctrA = sapco.contracts.find(c => c.contractNumber === 'CTR-P1-A');
  const ctrB = sapco.contracts.find(c => c.contractNumber === 'CTR-P1-B');
  assert.ok(ctrA && Math.abs(ctrA.totalConsumedKg - 60) < 1e-3, `Expected CTR-A consumed=60, got ${ctrA?.totalConsumedKg}`);
  assert.ok(ctrB && Math.abs(ctrB.totalConsumedKg - 10) < 1e-3, `Expected CTR-B consumed=10, got ${ctrB?.totalConsumedKg}`);
  const totalSapcoConsumed = sapco.contracts.reduce((s, c) => s + Number(c.totalConsumedKg || 0), 0);
  assert.ok(Math.abs(totalSapcoConsumed - 70) < 1e-3, `Expected total SAPCO consumed=70, got ${totalSapcoConsumed}`);

  __setProductionWipPrismaForTests(null);
  console.log('PASS: 2. Multi-contract issue + first-op coil settlement (no step-20 double count) + over-return 422 + multi-contract remnant return + SAPCO ledger');
}

// ---------------------------------------------------------------------------
// Test 3: Auto-Release Reservations on MO Completion AND on MO Delete Rollback
// ---------------------------------------------------------------------------
async function test3ReservationAutoReleaseOnCompletionAndRollback() {
  // 3A: Completion release
  {
    const seed = buildSeedState();
    seed.manufacturingOrder![0].targetQty = 100;
    seed.productionOperation = [seed.productionOperation![0]]; // single op
    const { client, getState } = createUnifiedMockPrisma(seed);
    __setProductionWipPrismaForTests(client);

    // Reserve 200 kg for MO-1 manually (only 50kg will be used to produce 100 pcs)
    const rsv = await createReservationInDbTransaction(client, {
      partId: 'part-coil-st14',
      partCode: 'RM-COIL-ST14',
      warehouseId: 'wh-raw',
      quantity: 200,
      reservedFor: 'MO-P1-001',
      referenceType: 'MANUFACTURING_ORDER',
      referenceNumber: 'MO-P1-001',
      physicalCoilId: 'coil-1',
      idempotencyKey: 'RSV-COMP-0001',
      user: TEST_USER,
    });
    assert.equal(rsv.success, true, rsv.error);

    // Issue only 50 kg (100 pcs) to MO-1, leaving 150 kg still ACTIVE reserved
    const iss = await issuePhysicalCoilInDbTransaction(client, {
      coilIdOrCode: 'coil-1',
      issueRequestKey: 'REQ-COMP-ISS-0001',
      requested: [
        {
          manufacturingOrderRef: 'mo-1',
          operationRef: 'op-mo1-10',
          partRef: null,
          issuedWeightKg: 50,
          varianceWeightKg: 0,
          initialInputQuantityPcs: 100,
          wipManufacturingOrderId: null,
        },
      ],
      createdByUserId: 'user-p1',
    });
    assert.equal(iss.success, true, iss.error);
    const resRemainingBeforeComplete = getState().stockBalance.reduce((s, b) => s + num(b.quantityReserved), 0);
    assert.equal(resRemainingBeforeComplete, 150);

    // Complete MO-1 by reporting all 100 GOOD pcs -> excess 150 kg reservation must auto-release!
    const postRes = await postWipProductionDb({
      moId: 'mo-1',
      operationId: 'op-mo1-10',
      idempotencyKey: 'WIP-COMP-ALL-001',
      machineId: 'mach-400t',
      shiftId: 'shift-a',
      createdByUserId: 'user-p1',
      goodQty: 100,
      scrapQty: 0,
    });
    assert.equal(postRes.mo?.status, 'COMPLETED');
    const db = getState();
    assert.equal(db.inventoryReservation.every(r => r.status === 'RELEASED' || r.status === 'CONSUMED'), true);
    assert.equal(db.stockBalance.reduce((s, b) => s + num(b.quantityReserved), 0), 0);
    __setProductionWipPrismaForTests(null);
  }

  // 3B: MO delete rollback releases StockBalance.quantityReserved
  {
    const seed = buildSeedState();
    const { client, getState } = createUnifiedMockPrisma(seed);
    __setProductionWipPrismaForTests(client);

    const rsv = await createReservationInDbTransaction(client, {
      partId: 'part-coil-st14',
      partCode: 'RM-COIL-ST14',
      warehouseId: 'wh-raw',
      quantity: 300,
      reservedFor: 'MO-P1-001',
      referenceType: 'MANUFACTURING_ORDER',
      referenceNumber: 'MO-P1-001',
      physicalCoilId: 'coil-1',
      idempotencyKey: 'RSV-DEL-0001',
      user: TEST_USER,
    });
    assert.equal(rsv.success, true);
    assert.equal(getState().stockBalance.reduce((s, b) => s + num(b.quantityReserved), 0), 300);

    await deleteManufacturingOrderWithRollbackDb({
      moIdOrNumber: 'mo-1',
      cascadeSubMos: true,
      reason: 'لغو برنامه تولید پ۱',
      requestedUserId: 'user-p1',
    });
    const db = getState();
    assert.equal(db.manufacturingOrder.some(m => m.id === 'mo-1'), false);
    assert.equal(db.stockBalance.reduce((s, b) => s + num(b.quantityReserved), 0), 0);
    assert.equal(db.stockBalance.reduce((s, b) => s + num(b.quantityAvailable), 0), 1000);
    __setProductionWipPrismaForTests(null);
  }

  console.log('PASS: 3. Excess MO reservations auto-release on MO completion AND on MO deletion rollback');
}

// ---------------------------------------------------------------------------
// Test 4: ISSUE_RAW_MATERIAL MO Linkage + Settled Reversal Block (409) + Unsettled Reversal
// ---------------------------------------------------------------------------
async function test4IssueDocumentMoLinkAndReversalGuard() {
  const seed = buildSeedState();
  // Consolidate coil-1 on sb-coil-a for clean doc-line issue test
  seed.stockBalance = [seed.stockBalance![0]];
  seed.stockBalance[0].quantityOnHand = 1000;
  seed.stockBalance[0].quantityAvailable = 1000;
  seed.stockBalance[0].weightKgOnHand = 1000;
  seed.stockBalance[0].weightKgAvailable = 1000;

  const { client, getState } = createUnifiedMockPrisma(seed);
  __setProductionWipPrismaForTests(client);

  // Post ISSUE_RAW_MATERIAL linked to MO-P1-001
  const postIssue = await postInventoryDocumentInTransaction(
    {
      id: 'doc-iss-1',
      documentNumber: 'ISS-RAW-P1-01',
      documentType: 'ISSUE_RAW_MATERIAL',
      documentDate: new Date().toISOString().slice(0, 10),
      documentStatus: 'CONFIRMED',
      postingStatus: 'DRAFT',
      warehouseId: 'wh-raw',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      contractId: 'ctr-a',
      contractNumber: 'CTR-P1-A',
      referenceType: 'MANUFACTURING_ORDER',
      referenceNumber: 'MO-P1-001',
      lines: [
        {
          id: 'line-iss-1',
          documentId: 'doc-iss-1',
          lineNumber: 1,
          partId: 'part-coil-st14',
          partCode: 'RM-COIL-ST14',
          partName: 'کلاف ST14',
          physicalCoilId: 'coil-1',
          lotNumber: 'LOT-P1-001',
          locationCode: 'LOC-RAW-A1',
          ownership: 'SAPCO_SUPPLIER_OWNED',
          contractId: 'ctr-a',
          contractNumber: 'CTR-P1-A',
          quantity: 100,
          unit: 'KG',
          quantityKg: 100,
          qualityStatus: 'AVAILABLE',
        },
      ],
      totalQuantity: 100,
      totalWeightKg: 100,
      createdByUid: TEST_USER.uid,
      createdByName: TEST_USER.displayName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any,
    TEST_USER,
    { prismaClient: client, idempotencyKey: 'KEY-ISS-RAW-0001' },
  );
  assert.equal(postIssue.success, true, postIssue.error);

  const db = getState();
  const createdTrx = db.inventoryTransaction.find(t => t.documentId === postIssue.dbDocumentId);
  assert.equal(createdTrx?.manufacturingOrderId, 'mo-1');
  const cir = db.coilIssueReturnRecord.find(r => r.inventoryDocumentId === postIssue.dbDocumentId);
  assert.ok(cir, 'ISSUE_RAW_MATERIAL linked to coil+MO must create CoilIssueReturnRecord');

  // Simulate WIP settlement on that CoilIssueReturnRecord -> reversal MUST fail 409 COIL_ISSUE_ALREADY_SETTLED!
  cir.consumedWeightKg = 40;
  cir.outstandingWeightKg = 60;
  const blockedRev = await postInventoryDocumentInTransaction(
    {
      id: 'doc-rev-blocked',
      documentNumber: 'REV-ISS-BLOCKED',
      documentType: 'REVERSAL',
      documentDate: new Date().toISOString().slice(0, 10),
      documentStatus: 'CONFIRMED',
      postingStatus: 'DRAFT',
      warehouseId: 'wh-raw',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      reversalOfDocumentId: postIssue.dbDocumentId,
      isReversalDocument: true,
      lines: [],
      totalQuantity: 100,
      totalWeightKg: 100,
      createdByUid: TEST_USER.uid,
      createdByName: TEST_USER.displayName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any,
    TEST_USER,
    { prismaClient: client, idempotencyKey: 'KEY-REV-BLOCKED-001' },
  );
  assert.equal(blockedRev.success, false);
  assert.equal(blockedRev.errorCode, 'COIL_ISSUE_ALREADY_SETTLED');
  assert.equal(blockedRev.statusCode, 409);

  // Now test reversing an unsettled ISSUE_RAW_MATERIAL document carries manufacturingOrderId onto reversal tx
  cir.consumedWeightKg = 0;
  cir.outstandingWeightKg = 100;
  const allowedRev = await postInventoryDocumentInTransaction(
    {
      id: 'doc-rev-ok',
      documentNumber: 'REV-ISS-OK',
      documentType: 'REVERSAL',
      documentDate: new Date().toISOString().slice(0, 10),
      documentStatus: 'CONFIRMED',
      postingStatus: 'DRAFT',
      warehouseId: 'wh-raw',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      reversalOfDocumentId: postIssue.dbDocumentId,
      isReversalDocument: true,
      lines: [],
      totalQuantity: 100,
      totalWeightKg: 100,
      createdByUid: TEST_USER.uid,
      createdByName: TEST_USER.displayName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any,
    TEST_USER,
    { prismaClient: client, idempotencyKey: 'KEY-REV-OK-0001' },
  );
  assert.equal(allowedRev.success, true, allowedRev.error);
  const revTrx = getState().inventoryTransaction.find(t => t.documentId === allowedRev.dbDocumentId);
  assert.equal(revTrx?.isReversal, true);
  assert.equal(revTrx?.manufacturingOrderId, 'mo-1');

  __setProductionWipPrismaForTests(null);
  console.log('PASS: 4. ISSUE_RAW_MATERIAL MO linkage, settled reversal block (409), and reversal MO metadata');
}

// ---------------------------------------------------------------------------
// Test 5: loadMaterialIntoMoDb Idempotency + Mismatch 409 + Closed MO 409 + CAS Conflict
// ---------------------------------------------------------------------------
async function test5LoadMaterialIdempotencyAndGuards() {
  const { client, getState } = createUnifiedMockPrisma(buildSeedState());
  __setProductionWipPrismaForTests(client);

  const dto1 = await loadMaterialIntoMoDb({
    moId: 'mo-1',
    operationId: 'op-mo1-10',
    quantity: 100,
    sourceStockBalanceId: 'sb-coil-a',
    createdByUserId: 'user-p1',
    idempotencyKey: 'LOAD-MAT-KEY-0001',
  });
  assert.equal(dto1.initialInputQuantity, 100);
  const txCountAfterFirst = getState().inventoryTransaction.length;

  // Replay exact key -> same result, zero duplicate documents or stock deductions
  const dtoReplay = await loadMaterialIntoMoDb({
    moId: 'mo-1',
    operationId: 'op-mo1-10',
    quantity: 100,
    sourceStockBalanceId: 'sb-coil-a',
    createdByUserId: 'user-p1',
    idempotencyKey: 'LOAD-MAT-KEY-0001',
  });
  assert.equal(dtoReplay.initialInputQuantity, 100);
  assert.equal(getState().inventoryTransaction.length, txCountAfterFirst);

  // Replay same key with DIFFERENT quantity -> 409
  await assert.rejects(
    () =>
      loadMaterialIntoMoDb({
        moId: 'mo-1',
        operationId: 'op-mo1-10',
        quantity: 120,
        sourceStockBalanceId: 'sb-coil-a',
        createdByUserId: 'user-p1',
        idempotencyKey: 'LOAD-MAT-KEY-0001',
      }),
    (err: any) => err instanceof WipServiceError && err.statusCode === 409,
  );

  // Closed MO cannot receive coil issue
  getState().manufacturingOrder.find(m => m.id === 'mo-other')!.status = 'CLOSED';
  const closedIssue = await issuePhysicalCoilInDbTransaction(client, {
    coilIdOrCode: 'coil-1',
    issueRequestKey: 'REQ-CLOSED-MO-0001',
    requested: [
      {
        manufacturingOrderRef: 'mo-other',
        operationRef: 'op-other-10',
        partRef: null,
        issuedWeightKg: 50,
        varianceWeightKg: 0,
        initialInputQuantityPcs: 100,
        wipManufacturingOrderId: null,
      },
    ],
  });
  assert.equal(closedIssue.success, false);
  assert.equal(closedIssue.statusCode, 409);
  assert.equal(closedIssue.errorCode, 'MO_NOT_MUTABLE');

  __setProductionWipPrismaForTests(null);
  console.log('PASS: 5. loadMaterialIntoMoDb idempotency/409 conflict & CLOSED MO issue block');
}

// ---------------------------------------------------------------------------
// Test 6: Express HTTP Router E2E (Reserve -> Issue -> WIP Production -> Reports & Genealogy)
// ---------------------------------------------------------------------------
async function test6HttpRouterTraceabilityAndReports() {
  const seed = buildSeedState();
  // Set multi-contract coil: 60kg CTR-A + 40kg CTR-B
  seed.physicalCoil![0].originalWeightKg = 100;
  seed.physicalCoil![0].remainingWeightKg = 100;
  seed.materialLot![0].initialWeightKg = 100;
  seed.materialLot![0].remainingWeightKg = 100;
  seed.contractCoilAllocation![0].allocatedWeightKg = 60;
  seed.contractCoilAllocation![1].allocatedWeightKg = 40;
  seed.stockBalance![0].quantityOnHand = 60;
  seed.stockBalance![0].quantityAvailable = 60;
  seed.stockBalance![0].weightKgOnHand = 60;
  seed.stockBalance![0].weightKgAvailable = 60;
  seed.stockBalance![1].quantityOnHand = 40;
  seed.stockBalance![1].quantityAvailable = 40;
  seed.stockBalance![1].weightKgOnHand = 40;
  seed.stockBalance![1].weightKgAvailable = 40;
  seed.manufacturingOrder![0].targetQty = 200;

  const { client } = createUnifiedMockPrisma(seed);

  const prevClient = (global as any).__prismaClient;
  const prevReachable = (global as any).__kpimsDbReachable;
  const prevUrl = process.env.DATABASE_URL;
  let server: import('node:http').Server | undefined;

  try {
    (global as any).__prismaClient = client;
    (global as any).__kpimsDbReachable = true;
    process.env.DATABASE_URL = 'postgresql://mock:mock@127.0.0.1:5432/isolated_p1_test';
    __setProductionWipPrismaForTests(client);

    const { apiRouter } = await import('../src/server/apiRouter');
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api', apiRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const port = (server.address() as any).port;
    const base = `http://127.0.0.1:${port}`;

    // A. POST /api/mrp/mos/mo-1/reserve
    const rsvResp = await fetch(`${base}/api/mrp/mos/mo-1/reserve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ createdByUserId: 'user-p1' }),
    });
    const rsvJson: any = await rsvResp.json();
    assert.equal(rsvResp.status, 200, JSON.stringify(rsvJson));
    assert.equal(rsvJson.source, 'POSTGRESQL_MRP_RESERVATIONS');
    assert.equal(rsvJson.data.reserved[0].quantity, 100);

    // B. POST /api/inventory/coils/coil-1/issue (multi-contract 60/40)
    const issResp = await fetch(`${base}/api/inventory/coils/coil-1/issue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'HTTP-COIL-ISS-0001' },
      body: JSON.stringify({
        issuedWeightKg: 100,
        scrappedKg: 0,
        moId: 'mo-1',
        moOperationId: 'op-mo1-10',
        initialInputQuantityPcs: 200,
        createdByUserId: 'user-p1',
      }),
    });
    const issJson: any = await issResp.json();
    assert.equal(issResp.status, 200, JSON.stringify(issJson));
    assert.equal(issJson.issueRecords.length, 2);

    // Replay same key -> duplicate: true
    const issReplayResp = await fetch(`${base}/api/inventory/coils/coil-1/issue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'HTTP-COIL-ISS-0001' },
      body: JSON.stringify({
        issuedWeightKg: 100,
        scrappedKg: 0,
        moId: 'mo-1',
        moOperationId: 'op-mo1-10',
        initialInputQuantityPcs: 200,
        createdByUserId: 'user-p1',
      }),
    });
    const issReplayJson: any = await issReplayResp.json();
    assert.equal(issReplayResp.status, 200);
    assert.equal(issReplayJson.duplicate, true);

    // C. Post WIP production on OP10 (160 GOOD, 20 SCRAP = 180 PCS)
    await postWipProductionDb({
      moId: 'mo-1',
      operationId: 'op-mo1-10',
      idempotencyKey: 'HTTP-WIP-REP-0001',
      machineId: 'mach-400t',
      shiftId: 'shift-a',
      createdByUserId: 'user-p1',
      goodQty: 160,
      scrapQty: 20,
      scrapReason: 'خطای قالب',
    });

    // D. GET /api/inventory/coils/coil-1/genealogy
    const genResp = await fetch(`${base}/api/inventory/coils/coil-1/genealogy`);
    const genJson: any = await genResp.json();
    assert.equal(genResp.status, 200);
    assert.ok(genJson.data.relatedDocuments.length >= 1, 'Expected populated relatedDocuments');
    assert.ok(genJson.data.ledgerTransactions.length >= 2, 'Expected populated ledgerTransactions');
    assert.equal(genJson.data.linkedManufacturingOrders.length, 1);
    assert.equal(genJson.data.linkedManufacturingOrders[0].moNumber, 'MO-P1-001');
    assert.deepEqual(genJson.data.traceabilityLimitations, []);

    // E. GET /api/reports/material-consumption-actual -> NO 2x double counting across the 2 contract tx lines!
    const actResp = await fetch(`${base}/api/reports/material-consumption-actual`);
    const actJson: any = await actResp.json();
    assert.equal(actResp.status, 200);
    const row = actJson.data.find((r: any) => r.moNumber === 'MO-P1-001' && r.operationStep === 10);
    assert.ok(row, 'Expected actual consumption row for MO-P1-001 step 10');
    assert.equal(row.actualIssuedMaterialKg, 100);
    assert.equal(row.actualProducedGoodQty, 160, `Must not double-count report qty across dual-contract coil tx lines; got ${row.actualProducedGoodQty}`);
    assert.equal(row.actualScrapQty, 20);
    assert.equal(row.productionReportCount, 1);

    // F. GET /api/reports/lot-consumption -> prorated piecesProduced (total = 160 across 2 contract records), real machine & operator, no limitation note
    const lotResp = await fetch(`${base}/api/reports/lot-consumption`);
    const lotJson: any = await lotResp.json();
    assert.equal(lotResp.status, 200);
    assert.equal(lotJson.note, undefined);
    const totalLotPieces = lotJson.data.reduce((s: number, r: any) => s + num(r.piecesProduced), 0);
    assert.ok(Math.abs(totalLotPieces - 160) < 1e-3, `Expected prorated piecesProduced summing to 160, got ${totalLotPieces}`);
    assert.equal(lotJson.data[0].destinationMachine, 'PRS-400T - پرس ۴۰۰ تن');
    assert.equal(lotJson.data[0].operatorName, 'اپراتور خط پ۱');

    console.log('PASS: 6. HTTP Router Reserve -> Multi-Contract Coil Issue -> WIP Production -> Genealogy & Deduplicated Reports');
  } finally {
    if (server) {
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
    __setProductionWipPrismaForTests(null);
    (global as any).__prismaClient = prevClient;
    (global as any).__kpimsDbReachable = prevReachable;
    if (prevUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevUrl;
  }
}

async function main() {
  console.log('=== KPIMS P1 End-to-End Inventory & WIP Integration Suite (Isolated) ===');
  await test1MrpAutoReserveAndCrossMoIsolation();
  await test2MultiContractWipSettlementRemnantAndSapco();
  await test3ReservationAutoReleaseOnCompletionAndRollback();
  await test4IssueDocumentMoLinkAndReversalGuard();
  await test5LoadMaterialIdempotencyAndGuards();
  await test6HttpRouterTraceabilityAndReports();
  console.log('ALL 6 KPIMS P1 END-TO-END INTEGRATION SUITES PASSED (0 live DB writes).');
}

main().catch(err => {
  console.error('KPIMS P1 INTEGRATION TEST FAILED:', err);
  process.exit(1);
});
