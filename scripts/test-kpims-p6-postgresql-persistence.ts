/**
 * =========================================================================
 * KPIMS P6: PostgreSQL Relational Persistence Regression Suite
 * =========================================================================
 * Verifies authoritative Prisma/PostgreSQL persistence for P6 Quality Management
 * without requiring or modifying a live database, using a transactional mock
 * Prisma client injected via `__setQualityPrismaForTests(...)`.
 *
 * Covers:
 *   1. IQC Accept (321) & Reject (344 + auto-NCR + RETURN_TO_SUPPLIER) with
 *      full relational FKs (Part, Warehouse, MaterialLot, PhysicalCoil,
 *      MaterialContract, InventoryDocument) and transactional coil/lot sync.
 *   2. IPQC linked to ManufacturingOrder & ProductionOperation with split
 *      accepted/rework/rejected quantities and auto-NCR back-link.
 *   3. FQC + Manual NCR + Containment (344) + MRB Dispositions
 *      (USE_AS_IS, REWORK, SCRAP, SORT_REINSPECT).
 *   4. Rework Order partial & final completion, over-reporting guard (409),
 *      return/scrap InventoryDocument FKs, and automatic NCR closure.
 *   5. Zero in-memory dependency & simulated restart proof:
 *      - In-memory stores remain empty during PostgreSQL mode.
 *      - Wiping in-memory state (`resetQualityStateForTests`) preserves all
 *        service and HTTP GET /api/quality/* reads from Prisma.
 *   6. Restart-safe persistent idempotency (200 replay, 409 payload conflict)
 *      backed by `QualityIdempotencyRecord`.
 *   7. Atomic `$transaction` rollback on bridge or DB failure (zero partial
 *      rows across inspections, NCRs, rework orders, idempotency records, and
 *      coil/lot statuses).
 *
 * Run with: DATABASE_URL="" npx tsx scripts/test-kpims-p6-postgresql-persistence.ts
 * =========================================================================
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { apiRouter } from '../src/server/apiRouter';
import {
  __setQualityPrismaForTests,
  completeReworkOrder,
  computeQualityDashboardAnalyticsAsync,
  containNonconformance,
  createNonconformanceRecord,
  createQualityInspection,
  decideQualityInspection,
  dispositionNonconformance,
  exportQualityStateSnapshot,
  getQualityEntityHistoryAsync,
  isQualityPostgresPersistenceActive,
  listNonconformancesAsync,
  listQualityInspectionsAsync,
  listReworkOrdersAsync,
  resetQualityStateForTests,
  type QualityInventoryBridge,
} from '../src/server/qualityManagementService';
import type {
  DetailedStockBalance,
  InventoryDocument,
  Part,
  PhysicalCoil,
  StockQualityStatus,
  WarehouseDefinition,
} from '../src/types/inventory';

if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '') {
  throw new Error('Refusing to run isolated P6 PostgreSQL persistence test when DATABASE_URL is configured.');
}

// =========================================================================
// Transactional In-Memory Prisma Mock (Supports Snapshot Rollback + FKs)
// =========================================================================
interface MockDbState {
  parts: any[];
  warehouses: any[];
  materialLots: any[];
  physicalCoils: any[];
  manufacturingOrders: any[];
  productionOperations: any[];
  materialContracts: any[];
  inventoryDocuments: any[];
  users: any[];
  auditLogs: any[];
  qualityInspections: any[];
  qualityNonconformances: any[];
  qualityReworkOrders: any[];
  qualityIdempotencyRecords: any[];
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function matchesWhere(row: any, where: any): boolean {
  if (!where || typeof where !== 'object') return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'OR' && Array.isArray(cond)) {
      if (!cond.some(sub => matchesWhere(row, sub))) return false;
      continue;
    }
    if (k === 'AND' && Array.isArray(cond)) {
      if (!cond.every(sub => matchesWhere(row, sub))) return false;
      continue;
    }
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      if ('in' in cond && Array.isArray((cond as any).in)) {
        if (!(cond as any).in.includes(row[k])) return false;
        continue;
      }
    }
    if (row[k] !== cond) return false;
  }
  return true;
}

function applySelect(row: any, select?: Record<string, boolean>): any {
  if (!row) return null;
  if (!select) return deepClone(row);
  const out: any = {};
  for (const [k, v] of Object.entries(select)) {
    if (v) out[k] = row[k];
  }
  return deepClone(out);
}

function applyUpdateData(row: any, data: Record<string, any>) {
  const next = { ...row };
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && 'increment' in v) {
      next[k] = Number(next[k] || 0) + Number(v.increment);
    } else {
      next[k] = v instanceof Date ? v.toISOString() : v;
    }
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

function createTransactionalMockQualityPrisma(initial: MockDbState) {
  let state: MockDbState = deepClone(initial);
  let failOnNextReworkCreate = false;

  const makeUniqueError = (target: string) => {
    const err: any = new Error(`Unique constraint failed on ${target}`);
    err.code = 'P2002';
    err.meta = { target };
    return err;
  };

  function buildDelegates(getState: () => MockDbState) {
    const readOnlyDelegate = (table: keyof MockDbState) => ({
      findFirst: async (args?: any) => {
        const rows = getState()[table] as any[];
        const found = rows.find(r => matchesWhere(r, args?.where));
        return found ? applySelect(found, args?.select) : null;
      },
      findUnique: async (args?: any) => {
        const rows = getState()[table] as any[];
        const found = rows.find(r => matchesWhere(r, args?.where));
        return found ? applySelect(found, args?.select) : null;
      },
      findMany: async (args?: any) => {
        let rows = (getState()[table] as any[]).filter(r => matchesWhere(r, args?.where));
        if (args?.orderBy) {
          rows = [...rows].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
        }
        return rows.map(r => applySelect(r, args?.select));
      },
      update: async (args: any) => {
        const rows = getState()[table] as any[];
        const idx = rows.findIndex(r => matchesWhere(r, args.where));
        if (idx === -1) throw new Error(`Record not found in ${String(table)}`);
        rows[idx] = applyUpdateData(rows[idx], args.data);
        return deepClone(rows[idx]);
      },
    });

    return {
      part: readOnlyDelegate('parts'),
      warehouse: readOnlyDelegate('warehouses'),
      materialLot: readOnlyDelegate('materialLots'),
      physicalCoil: readOnlyDelegate('physicalCoils'),
      manufacturingOrder: readOnlyDelegate('manufacturingOrders'),
      productionOperation: readOnlyDelegate('productionOperations'),
      materialContract: readOnlyDelegate('materialContracts'),
      inventoryDocument: readOnlyDelegate('inventoryDocuments'),
      user: readOnlyDelegate('users'),
      auditLog: {
        create: async (args: any) => {
          const row = {
            id: args.data?.id || `AUD-DB-${crypto.randomUUID().slice(0, 8)}`,
            ...deepClone(args.data),
            createdAt: new Date().toISOString(),
          };
          getState().auditLogs.push(row);
          return deepClone(row);
        },
      },
      qualityInspection: {
        findUnique: async (args?: any) => {
          const found = getState().qualityInspections.find(r => matchesWhere(r, args?.where));
          return found ? applySelect(found, args?.select) : null;
        },
        findFirst: async (args?: any) => {
          const found = getState().qualityInspections.find(r => matchesWhere(r, args?.where));
          return found ? applySelect(found, args?.select) : null;
        },
        findMany: async (args?: any) => {
          let rows = getState().qualityInspections.filter(r => matchesWhere(r, args?.where));
          rows = [...rows].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          return rows.map(r => applySelect(r, args?.select));
        },
        create: async (args: any) => {
          const rows = getState().qualityInspections;
          if (rows.some(r => r.inspectionNumber === args.data.inspectionNumber)) {
            throw makeUniqueError('inspectionNumber');
          }
          const now = new Date().toISOString();
          const row = {
            id: args.data.id || `QIN-${crypto.randomUUID().slice(0, 8)}`,
            version: 1,
            createdAt: now,
            updatedAt: now,
            ...deepClone(args.data),
          };
          if (args.data.inspectedAt instanceof Date) row.inspectedAt = args.data.inspectedAt.toISOString();
          if (args.data.decidedAt instanceof Date) row.decidedAt = args.data.decidedAt.toISOString();
          rows.push(row);
          return deepClone(row);
        },
        update: async (args: any) => {
          const rows = getState().qualityInspections;
          const idx = rows.findIndex(r => matchesWhere(r, args.where));
          if (idx === -1) throw new Error('QualityInspection not found');
          rows[idx] = applyUpdateData(rows[idx], args.data);
          return deepClone(rows[idx]);
        },
      },
      qualityNonconformance: {
        findUnique: async (args?: any) => {
          const found = getState().qualityNonconformances.find(r => matchesWhere(r, args?.where));
          return found ? applySelect(found, args?.select) : null;
        },
        findFirst: async (args?: any) => {
          const found = getState().qualityNonconformances.find(r => matchesWhere(r, args?.where));
          return found ? applySelect(found, args?.select) : null;
        },
        findMany: async (args?: any) => {
          let rows = getState().qualityNonconformances.filter(r => matchesWhere(r, args?.where));
          rows = [...rows].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          return rows.map(r => applySelect(r, args?.select));
        },
        create: async (args: any) => {
          const rows = getState().qualityNonconformances;
          if (rows.some(r => r.ncrNumber === args.data.ncrNumber)) {
            throw makeUniqueError('ncrNumber');
          }
          const now = new Date().toISOString();
          const row = {
            id: args.data.id || `NCR-${crypto.randomUUID().slice(0, 8)}`,
            version: 1,
            containedQty: 0,
            reworkedGoodQty: 0,
            scrappedQty: 0,
            returnedToProductionQty: 0,
            returnedToSupplierQty: 0,
            createdAt: now,
            updatedAt: now,
            ...deepClone(args.data),
          };
          rows.push(row);
          return deepClone(row);
        },
        update: async (args: any) => {
          const rows = getState().qualityNonconformances;
          const idx = rows.findIndex(r => matchesWhere(r, args.where));
          if (idx === -1) throw new Error('QualityNonconformance not found');
          rows[idx] = applyUpdateData(rows[idx], args.data);
          return deepClone(rows[idx]);
        },
      },
      qualityReworkOrder: {
        findUnique: async (args?: any) => {
          const found = getState().qualityReworkOrders.find(r => matchesWhere(r, args?.where));
          return found ? applySelect(found, args?.select) : null;
        },
        findFirst: async (args?: any) => {
          const found = getState().qualityReworkOrders.find(r => matchesWhere(r, args?.where));
          return found ? applySelect(found, args?.select) : null;
        },
        findMany: async (args?: any) => {
          let rows = getState().qualityReworkOrders.filter(r => matchesWhere(r, args?.where));
          rows = [...rows].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          return rows.map(r => applySelect(r, args?.select));
        },
        create: async (args: any) => {
          if (failOnNextReworkCreate) {
            failOnNextReworkCreate = false;
            throw new Error('Simulated PostgreSQL constraint/network failure on quality_rework_orders.create');
          }
          const rows = getState().qualityReworkOrders;
          if (rows.some(r => r.reworkNumber === args.data.reworkNumber)) {
            throw makeUniqueError('reworkNumber');
          }
          const now = new Date().toISOString();
          const row = {
            id: args.data.id || `RWK-${crypto.randomUUID().slice(0, 8)}`,
            version: 1,
            completedGoodQty: 0,
            scrappedQty: 0,
            createdAt: now,
            updatedAt: now,
            ...deepClone(args.data),
          };
          rows.push(row);
          return deepClone(row);
        },
        update: async (args: any) => {
          const rows = getState().qualityReworkOrders;
          const idx = rows.findIndex(r => matchesWhere(r, args.where));
          if (idx === -1) throw new Error('QualityReworkOrder not found');
          rows[idx] = applyUpdateData(rows[idx], args.data);
          return deepClone(rows[idx]);
        },
      },
      qualityIdempotencyRecord: {
        findUnique: async (args: any) => {
          const where = args.where?.scope_idempotencyKey || args.where;
          const found = getState().qualityIdempotencyRecords.find(
            r => r.scope === where.scope && r.idempotencyKey === where.idempotencyKey
          );
          return found ? deepClone(found) : null;
        },
        create: async (args: any) => {
          const rows = getState().qualityIdempotencyRecords;
          const dup = rows.find(
            r => r.scope === args.data.scope && r.idempotencyKey === args.data.idempotencyKey
          );
          if (dup) {
            throw makeUniqueError('scope_idempotencyKey');
          }
          const row = {
            id: `QIDEM-${crypto.randomUUID().slice(0, 8)}`,
            createdAt: new Date().toISOString(),
            ...deepClone(args.data),
          };
          rows.push(row);
          return deepClone(row);
        },
      },
    };
  }

  const rootDelegates = buildDelegates(() => state);
  let activeTxState: MockDbState | null = null;

  return {
    ...rootDelegates,
    $transaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
      // Snapshot state before transaction; commit ONLY if fn resolves without throwing
      const txState = deepClone(state);
      activeTxState = txState;
      const txDelegates = buildDelegates(() => txState);
      try {
        const result = await fn(txDelegates);
        state = txState;
        return result;
      } finally {
        activeTxState = null;
      }
    },
    __getState: () => state,
    __addInventoryDoc: (doc: { id: string; documentNumber: string }) => {
      const row = { ...doc, createdAt: new Date().toISOString() };
      state.inventoryDocuments.push(row);
      if (activeTxState) {
        activeTxState.inventoryDocuments.push(deepClone(row));
      }
    },
    __setFailOnNextReworkCreate: (flag: boolean) => {
      failOnNextReworkCreate = flag;
    },
  };
}

async function run() {
  resetQualityStateForTests();

  const ts = Date.now();
  const now = new Date().toISOString();

  // Seed relational master/transactional entities in mock PostgreSQL
  const parts: Part[] = [
    {
      id: 'PRT-PG-COIL-ST14',
      code: 'RAW-ST14-08',
      name: 'ورق کشش عمیق ST14 ضخامت 0.8',
      category: 'RAW_MATERIAL',
      unit: 'KG',
      weightPerUnitKg: 1,
      minStock: 1000,
    },
    {
      id: 'PRT-PG-WIP-BRK',
      code: 'WIP-ECU-BRK-01',
      name: 'براکت خام پرس‌شده ECU',
      category: 'WIP_PART',
      unit: 'PCS',
      weightPerUnitKg: 0.45,
      minStock: 100,
    },
    {
      id: 'PRT-PG-FG-BRK',
      code: 'FG-ECU-BRK-01',
      name: 'مجموعه نهایی براکت ECU ساپکو',
      category: 'FINISHED_GOOD',
      unit: 'PCS',
      weightPerUnitKg: 0.5,
      minStock: 100,
    },
  ];

  const warehouses: WarehouseDefinition[] = [
    { id: 'WH-RAW', code: 'WH-RAW', name: 'انبار مواد اولیه و کلاف', type: 'RAW_MATERIALS', locations: ['RAW-A1'] },
    { id: 'WH-WIP', code: 'WH-WIP', name: 'انبار نیمه‌ساخته', type: 'WIP', locations: ['WIP-B1'] },
    { id: 'WH-FG', code: 'WH-FG', name: 'انبار محصول نهایی', type: 'FINISHED_GOODS', locations: ['FG-C1'] },
    { id: 'WH-SCRAP', code: 'WH-SCRAP', name: 'انبار ضایعات', type: 'SCRAP', locations: ['SCRAP-01'] },
  ];

  const mockPrisma = createTransactionalMockQualityPrisma({
    parts: parts.map(p => ({ id: p.id, partNumber: p.code, name: p.name, unit: p.unit })),
    warehouses: warehouses.map(w => ({ id: w.id, code: w.code, name: w.name })),
    materialContracts: [
      { id: 'CTR-PG-01', contractNumber: 'SAPCO-CTR-1404-PG' },
    ],
    materialLots: [
      { id: 'LOT-PG-COIL-1', lotNumber: `COIL-PG-OK-${ts}`, partId: 'PRT-PG-COIL-ST14', status: 'QUARANTINE' },
      { id: 'LOT-PG-COIL-2', lotNumber: `COIL-PG-REJ-${ts}`, partId: 'PRT-PG-COIL-ST14', status: 'QUARANTINE' },
      { id: 'LOT-PG-FG-1', lotNumber: `FG-LOT-PG-${ts}`, partId: 'PRT-PG-FG-BRK', status: 'AVAILABLE' },
    ],
    physicalCoils: [
      {
        id: 'PCOIL-PG-1',
        coilId: `COIL-PG-OK-${ts}`,
        coilPackNumber: 'PK-PG-001',
        partId: 'PRT-PG-COIL-ST14',
        materialLotId: 'LOT-PG-COIL-1',
        warehouseId: 'WH-RAW',
        heatNumber: 'HEAT-PG-01',
        thicknessMm: 0.8,
        widthMm: 1000,
        originalWeightKg: 4200,
        remainingWeightKg: 4200,
        ownership: 'SAPCO_SUPPLIER_OWNED',
        qualityStatus: 'QUARANTINE',
        physicalStatus: 'AVAILABLE',
        supplierName: 'فولاد مبارکه اصفهان',
        receiptDate: now,
      },
      {
        id: 'PCOIL-PG-2',
        coilId: `COIL-PG-REJ-${ts}`,
        coilPackNumber: 'PK-PG-002',
        partId: 'PRT-PG-COIL-ST14',
        materialLotId: 'LOT-PG-COIL-2',
        warehouseId: 'WH-RAW',
        heatNumber: 'HEAT-PG-02',
        thicknessMm: 0.8,
        widthMm: 1000,
        originalWeightKg: 3500,
        remainingWeightKg: 3500,
        ownership: 'SAPCO_SUPPLIER_OWNED',
        qualityStatus: 'QUARANTINE',
        physicalStatus: 'AVAILABLE',
        supplierName: 'تامین‌کننده نامنطبق تست',
        receiptDate: now,
      },
    ],
    manufacturingOrders: [
      { id: 'MO-PG-100', moNumber: 'MO-1404-PG-100', partId: 'PRT-PG-WIP-BRK', status: 'IN_PROGRESS' },
    ],
    productionOperations: [
      { id: 'OP-PG-100-20', manufacturingOrderId: 'MO-PG-100', stepCode: 'OP20', operationName: 'پرس کشش و بلنک' },
    ],
    inventoryDocuments: [],
    users: [{ id: 'USR-QC-PG', fullName: 'بازرس کیفی تست PostgreSQL' }],
    auditLogs: [],
    qualityInspections: [],
    qualityNonconformances: [],
    qualityReworkOrders: [],
    qualityIdempotencyRecords: [],
  });

  // Mutable ledger state used by the simulated Inventory Bridge
  const balances: DetailedStockBalance[] = [
    {
      id: 'BAL-COIL-1',
      partId: 'PRT-PG-COIL-ST14',
      partCode: 'RAW-ST14-08',
      partName: 'ورق کشش عمیق ST14 ضخامت 0.8',
      category: 'RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      warehouseName: 'انبار مواد اولیه و کلاف',
      locationCode: 'RAW-A1',
      materialLotId: 'LOT-PG-COIL-1',
      physicalCoilId: 'PCOIL-PG-1',
      lotNumber: `COIL-PG-OK-${ts}`,
      heatNumber: 'HEAT-PG-01',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      contractId: 'CTR-PG-01',
      contractNumber: 'SAPCO-CTR-1404-PG',
      qualityStatus: 'QUARANTINE',
      unit: 'KG',
      physicalQty: 4200,
      unrestrictedQty: 0,
      qualityInspectionQty: 4200,
      blockedQty: 0,
      ownedQty: 0,
      supplierOwnedQty: 4200,
      reservedQty: 0,
      qualityBlockedQty: 4200,
      availableQty: 0,
      physicalKg: 4200,
      unrestrictedKg: 0,
      qualityInspectionKg: 4200,
      blockedKg: 0,
      ownedKg: 0,
      supplierOwnedKg: 4200,
      reservedKg: 0,
      qualityBlockedKg: 4200,
      availableKg: 0,
      lastTransactionAt: now,
    },
    {
      id: 'BAL-COIL-2',
      partId: 'PRT-PG-COIL-ST14',
      partCode: 'RAW-ST14-08',
      partName: 'ورق کشش عمیق ST14 ضخامت 0.8',
      category: 'RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      warehouseName: 'انبار مواد اولیه و کلاف',
      locationCode: 'RAW-A1',
      materialLotId: 'LOT-PG-COIL-2',
      physicalCoilId: 'PCOIL-PG-2',
      lotNumber: `COIL-PG-REJ-${ts}`,
      heatNumber: 'HEAT-PG-02',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      contractId: 'CTR-PG-01',
      contractNumber: 'SAPCO-CTR-1404-PG',
      qualityStatus: 'QUARANTINE',
      unit: 'KG',
      physicalQty: 3500,
      unrestrictedQty: 0,
      qualityInspectionQty: 3500,
      blockedQty: 0,
      ownedQty: 0,
      supplierOwnedQty: 3500,
      reservedQty: 0,
      qualityBlockedQty: 3500,
      availableQty: 0,
      physicalKg: 3500,
      unrestrictedKg: 0,
      qualityInspectionKg: 3500,
      blockedKg: 0,
      ownedKg: 0,
      supplierOwnedKg: 3500,
      reservedKg: 0,
      qualityBlockedKg: 3500,
      availableKg: 0,
      lastTransactionAt: now,
    },
    {
      id: 'BAL-FG-1',
      partId: 'PRT-PG-FG-BRK',
      partCode: 'FG-ECU-BRK-01',
      partName: 'مجموعه نهایی براکت ECU ساپکو',
      category: 'FINISHED_GOOD',
      warehouseId: 'WH-FG',
      warehouseName: 'انبار محصول نهایی',
      locationCode: 'FG-C1',
      materialLotId: 'LOT-PG-FG-1',
      lotNumber: `FG-LOT-PG-${ts}`,
      ownership: 'COMPANY_OWNED',
      qualityStatus: 'AVAILABLE',
      unit: 'PCS',
      physicalQty: 200,
      unrestrictedQty: 200,
      qualityInspectionQty: 0,
      blockedQty: 0,
      ownedQty: 200,
      supplierOwnedQty: 0,
      reservedQty: 0,
      qualityBlockedQty: 0,
      availableQty: 200,
      physicalKg: 100,
      unrestrictedKg: 100,
      qualityInspectionKg: 0,
      blockedKg: 0,
      ownedKg: 100,
      supplierOwnedKg: 0,
      reservedKg: 0,
      qualityBlockedKg: 0,
      availableKg: 100,
      lastTransactionAt: now,
    },
  ];

  let failNextQmTransfer = false;
  let failNextQualityAdjustment = false;
  let docSeq = 1;

  const buildBridge = (): QualityInventoryBridge => {
    const dbCoils: PhysicalCoil[] = mockPrisma.__getState().physicalCoils.map(c => ({
      id: c.id,
      coilId: c.coilId,
      coilPackNumber: c.coilPackNumber,
      partId: c.partId,
      partCode: 'RAW-ST14-08',
      partName: 'ورق کشش عمیق ST14 ضخامت 0.8',
      materialGrade: 'ST14',
      heatNumber: c.heatNumber,
      thicknessMm: c.thicknessMm,
      widthMm: c.widthMm,
      originalWeightKg: c.originalWeightKg,
      remainingWeightKg: c.remainingWeightKg,
      warehouseId: c.warehouseId,
      warehouseName: 'انبار مواد اولیه و کلاف',
      warehouseLocationCode: 'RAW-A1',
      ownership: c.ownership,
      qualityStatus: c.qualityStatus,
      physicalStatus: c.physicalStatus,
      supplierName: c.supplierName,
      receiptDate: c.receiptDate,
      allocations: [
        {
          coilId: c.id,
          contractId: 'CTR-PG-01',
          contractNumber: 'SAPCO-CTR-1404-PG',
          allocatedWeightKg: c.originalWeightKg,
          ownership: 'SAPCO_SUPPLIER_OWNED',
        },
      ],
    }));

    return {
      parts,
      warehouses,
      coils: dbCoils,
      balances,
      manufacturingOrders: [
        {
          id: 'MO-PG-100',
          moNumber: 'MO-1404-PG-100',
          partId: 'PRT-PG-WIP-BRK',
          partCode: 'WIP-ECU-BRK-01',
          partName: 'براکت خام پرس‌شده ECU',
          status: 'IN_PROGRESS',
        },
      ],
      executeQmTransfer: async params => {
        if (failNextQmTransfer) {
          failNextQmTransfer = false;
          return {
            success: false,
            statusCode: 409,
            error: 'Simulated QM transfer ledger rejection (insufficient balance)',
          };
        }
        const docNumber = `QM-TR-${params.movementType}-${docSeq++}`;
        const docId = `DOC-${docNumber}`;
        mockPrisma.__addInventoryDoc({ id: docId, documentNumber: docNumber });

        // Update simulated balance qualityStatus & buckets
        const targetStatus: StockQualityStatus =
          params.movementType === '321'
            ? 'AVAILABLE'
            : params.movementType === '344'
            ? 'QUALITY_BLOCKED'
            : 'QUARANTINE';
        const bal = balances.find(
          b => b.partId === params.partId && b.warehouseId === params.warehouseId && b.lotNumber === params.lotNumber
        );
        if (bal) {
          const moved = Math.min(bal.physicalQty, Math.max(0, Number(params.heldQty || bal.physicalQty)));
          bal.qualityStatus = targetStatus;
          if (targetStatus === 'AVAILABLE') {
            bal.unrestrictedQty = Math.min(bal.physicalQty, bal.unrestrictedQty + moved);
            bal.availableQty = bal.unrestrictedQty;
            bal.qualityInspectionQty = Math.max(0, bal.qualityInspectionQty - moved);
            bal.blockedQty = Math.max(0, bal.blockedQty - moved);
            bal.qualityBlockedQty = bal.qualityInspectionQty + bal.blockedQty;
          } else if (targetStatus === 'QUALITY_BLOCKED') {
            bal.blockedQty = Math.min(bal.physicalQty, bal.blockedQty + moved);
            bal.qualityInspectionQty = Math.max(0, bal.qualityInspectionQty - moved);
            bal.unrestrictedQty = Math.max(0, bal.physicalQty - bal.blockedQty - bal.qualityInspectionQty);
            bal.availableQty = bal.unrestrictedQty;
            bal.qualityBlockedQty = bal.qualityInspectionQty + bal.blockedQty;
          } else {
            bal.qualityInspectionQty = Math.min(bal.physicalQty, bal.qualityInspectionQty + moved);
            bal.unrestrictedQty = Math.max(0, bal.physicalQty - bal.qualityInspectionQty - bal.blockedQty);
            bal.availableQty = bal.unrestrictedQty;
            bal.qualityBlockedQty = bal.qualityInspectionQty + bal.blockedQty;
          }
        }

        const doc = {
          id: docId,
          documentNumber: docNumber,
          documentType: 'TRANSFER',
          movementType: params.movementType,
        } as unknown as InventoryDocument;
        return { success: true, statusCode: 200, document: doc };
      },
      postQualityAdjustment: async params => {
        if (failNextQualityAdjustment) {
          failNextQualityAdjustment = false;
          return {
            success: false,
            statusCode: 409,
            error: 'Simulated Quality Adjustment ledger failure',
          };
        }
        const docNumber = `QM-ADJ-${docSeq++}`;
        const docId = `DOC-${docNumber}`;
        mockPrisma.__addInventoryDoc({ id: docId, documentNumber: docNumber });

        const doc = {
          id: docId,
          documentNumber: docNumber,
          documentType: 'ADJUSTMENT',
          movementType: params.quantityDelta < 0 ? '702' : '701',
        } as unknown as InventoryDocument;
        return { success: true, statusCode: 200, document: doc };
      },
      recordAudit: () => {
        // In-memory audit hook (PostgreSQL mode persists to prisma.auditLog directly)
      },
      persist: async () => {
        // No-op in PostgreSQL mode
      },
    };
  };

  const actor = { uid: 'USR-QC-PG', displayName: 'بازرس کیفی تست PostgreSQL' };

  try {
    // Activate PostgreSQL persistence mode via test Prisma injection
    __setQualityPrismaForTests(mockPrisma);
    assert.equal(isQualityPostgresPersistenceActive(), true, 'PostgreSQL persistence mode must be active');

    // =========================================================================
    // TEST 1: IQC Accept (321) & Reject (344 + Auto-NCR + Supplier Return)
    // =========================================================================
    console.log('--- P6-PG.1: IQC Accept & Reject with Relational FKs and Coil/Lot Sync ---');
    const iqcAcceptRes = await createQualityInspection(
      {
        inspectionType: 'INCOMING_MATERIAL',
        partId: 'PRT-PG-COIL-ST14',
        warehouseId: 'WH-RAW',
        physicalCoilId: 'PCOIL-PG-1',
        lotNumber: `COIL-PG-OK-${ts}`,
        inspectedQty: 4200,
        decision: 'ACCEPTED',
        idempotencyKey: `PG-IQC-ACC-${ts}`,
        user: actor,
      },
      buildBridge()
    );
    assert.equal(iqcAcceptRes.ok, true);
    assert.equal(iqcAcceptRes.statusCode, 201);
    assert.equal(iqcAcceptRes.inspection?.decision, 'ACCEPTED');
    assert.ok(iqcAcceptRes.qmDocument?.documentNumber, 'IQC accept must link MvT 321 document');

    // Verify DB row FKs + PhysicalCoil & MaterialLot sync
    const dbState1 = mockPrisma.__getState();
    assert.equal(dbState1.qualityInspections.length, 1);
    const dbIqcAccept = dbState1.qualityInspections[0];
    assert.equal(dbIqcAccept.partId, 'PRT-PG-COIL-ST14');
    assert.equal(dbIqcAccept.warehouseId, 'WH-RAW');
    assert.equal(dbIqcAccept.physicalCoilId, 'PCOIL-PG-1');
    assert.equal(dbIqcAccept.materialLotId, 'LOT-PG-COIL-1');
    assert.equal(dbIqcAccept.materialContractId, 'CTR-PG-01');
    assert.ok(dbIqcAccept.linkedQmDocumentId, 'linkedQmDocumentId FK must be populated');
    assert.equal(dbIqcAccept.resultingQualityStatus, 'AVAILABLE');

    const dbCoil1 = dbState1.physicalCoils.find(c => c.id === 'PCOIL-PG-1');
    const dbLot1 = dbState1.materialLots.find(l => l.id === 'LOT-PG-COIL-1');
    assert.equal(dbCoil1.qualityStatus, 'AVAILABLE', 'PhysicalCoil.qualityStatus must be synced to AVAILABLE in DB');
    assert.equal(dbLot1.status, 'AVAILABLE', 'MaterialLot.status must be synced to AVAILABLE in DB');

    // Reject Coil 2 -> 344 + Auto-NCR -> RETURN_TO_SUPPLIER
    const iqcRejectRes = await createQualityInspection(
      {
        inspectionType: 'INCOMING_MATERIAL',
        partId: 'PRT-PG-COIL-ST14',
        warehouseId: 'WH-RAW',
        physicalCoilId: 'PCOIL-PG-2',
        lotNumber: `COIL-PG-REJ-${ts}`,
        inspectedQty: 3500,
        decision: 'REJECTED',
        defectCodes: ['DEF-THICK'],
        defectSummary: 'عدم انطباق ضخامت ورق کویل در بازرسی ورودی',
        idempotencyKey: `PG-IQC-REJ-${ts}`,
        user: actor,
      },
      buildBridge()
    );
    assert.equal(iqcRejectRes.ok, true);
    assert.equal(iqcRejectRes.inspection?.decision, 'REJECTED');
    assert.ok(iqcRejectRes.ncr?.id, 'IQC rejection must auto-create linked NCR in same DB transaction');

    const dbState2 = mockPrisma.__getState();
    const dbCoil2 = dbState2.physicalCoils.find(c => c.id === 'PCOIL-PG-2');
    assert.equal(dbCoil2.qualityStatus, 'REJECTED', 'Rejected coil must be REJECTED in DB');
    const dbLot2 = dbState2.materialLots.find(l => l.id === 'LOT-PG-COIL-2');
    assert.equal(dbLot2.status, 'REJECTED', 'Rejected lot must be REJECTED in DB');
    const dbAutoNcr = dbState2.qualityNonconformances.find(n => n.id === iqcRejectRes.ncr?.id);
    assert.ok(dbAutoNcr, 'Auto-NCR must exist in quality_nonconformances table');
    assert.equal(dbAutoNcr.inspectionId, iqcRejectRes.inspection?.id, 'NCR must store inspectionId FK');
    assert.equal(dbAutoNcr.physicalCoilId, 'PCOIL-PG-2', 'NCR must store physicalCoilId FK');
    assert.equal(dbAutoNcr.materialLotId, 'LOT-PG-COIL-2', 'NCR must store materialLotId FK');
    assert.equal(dbAutoNcr.materialContractId, 'CTR-PG-01', 'NCR must store materialContractId FK');

    // Return Coil 2 to supplier via MRB disposition
    const supReturnRes = await dispositionNonconformance(
      dbAutoNcr.id,
      {
        disposition: 'RETURN_TO_SUPPLIER',
        rootCause: 'تولید خارج از تلرانس ضخامت توسط تامین‌کننده',
        correctiveAction: 'عودت کامل کلاف به تامین‌کننده و ثبت امتیاز منفی',
        idempotencyKey: `PG-DISP-RET-${ts}`,
        user: actor,
      },
      buildBridge()
    );
    assert.equal(supReturnRes.ok, true);
    assert.equal(supReturnRes.ncr?.status, 'CLOSED');
    const dbCoil2After = mockPrisma.__getState().physicalCoils.find(c => c.id === 'PCOIL-PG-2');
    assert.equal(dbCoil2After.physicalStatus, 'RETURNED', 'Returned coil physicalStatus must persist as RETURNED');
    assert.equal(dbCoil2After.remainingWeightKg, 0, 'Returned coil remainingWeightKg must persist as 0');
    const dbNcrAfterRet = mockPrisma.__getState().qualityNonconformances.find(n => n.id === dbAutoNcr.id);
    assert.ok(dbNcrAfterRet.dispositionDocId, 'dispositionDocId FK must be persisted');
    assert.equal(dbNcrAfterRet.resultingQualityStatus, 'REJECTED');

    // =========================================================================
    // TEST 2: IPQC Linked to ManufacturingOrder + ProductionOperation (Split Qty)
    // =========================================================================
    console.log('--- P6-PG.2: IPQC Linked to MO + ProductionOperation + Split Qty ---');
    const ipqcCreateRes = await createQualityInspection(
      {
        inspectionType: 'IN_PROCESS',
        partId: 'PRT-PG-WIP-BRK',
        warehouseId: 'WH-WIP',
        manufacturingOrderId: 'MO-PG-100',
        moNumber: 'MO-1404-PG-100',
        operationCode: 'OP20',
        operationName: 'پرس کشش و بلنک',
        inspectedQty: 100,
        idempotencyKey: `PG-IPQC-CREATE-${ts}`,
        user: actor,
      },
      buildBridge()
    );
    assert.equal(ipqcCreateRes.ok, true);
    assert.equal(ipqcCreateRes.inspection?.status, 'PENDING');

    // Decide IPQC separately with split accepted/rework/rejected quantities
    const ipqcDecideRes = await decideQualityInspection(
      ipqcCreateRes.inspection!.id,
      {
        decision: 'QUARANTINED',
        acceptedQty: 75,
        reworkQty: 20,
        rejectedQty: 5,
        defectCodes: ['DEF-BURR'],
        defectSummary: 'پلیسه بیش از حد در لبه برش پرس OP20',
        idempotencyKey: `PG-IPQC-DECIDE-${ts}`,
        user: actor,
      },
      buildBridge()
    );
    assert.equal(ipqcDecideRes.ok, true);
    assert.equal(ipqcDecideRes.inspection?.acceptedQty, 75);
    assert.equal(ipqcDecideRes.inspection?.reworkQty, 20);
    assert.equal(ipqcDecideRes.inspection?.rejectedQty, 5);
    assert.ok(ipqcDecideRes.ncr?.id, 'Split IPQC with non-zero rework+rejected must auto-create NCR');

    const dbIpqc = mockPrisma.__getState().qualityInspections.find(i => i.id === ipqcCreateRes.inspection!.id);
    assert.equal(dbIpqc.manufacturingOrderId, 'MO-PG-100', 'IPQC must store manufacturingOrderId FK');
    assert.equal(dbIpqc.productionOperationId, 'OP-PG-100-20', 'IPQC must resolve productionOperationId FK via (moId, stepCode)');
    assert.equal(dbIpqc.linkedNcrId, ipqcDecideRes.ncr!.id, 'IPQC must store linkedNcrId backlink');

    // =========================================================================
    // TEST 3 & 4: FQC + Manual NCR + Containment + REWORK Disposition + Completion
    // =========================================================================
    console.log('--- P6-PG.3 & 4: FQC, Manual NCR, Containment, Rework Order & Over-Report Guard ---');
    const fqcRes = await createQualityInspection(
      {
        inspectionType: 'FINAL_PRODUCT',
        partId: 'PRT-PG-FG-BRK',
        warehouseId: 'WH-FG',
        lotNumber: `FG-LOT-PG-${ts}`,
        inspectedQty: 200,
        decision: 'ACCEPTED',
        idempotencyKey: `PG-FQC-${ts}`,
        user: actor,
      },
      buildBridge()
    );
    assert.equal(fqcRes.ok, true);

    const manualNcrRes = await createNonconformanceRecord(
      {
        title: 'عیب پوشش کاتافورز روی پالت FG نهایی',
        sourceType: 'WAREHOUSE_AUDIT',
        severity: 'MAJOR',
        defectCode: 'DEF-COAT',
        partId: 'PRT-PG-FG-BRK',
        warehouseId: 'WH-FG',
        lotNumber: `FG-LOT-PG-${ts}`,
        affectedQty: 20,
        description: 'شره رنگ روی ۲۰ عدد قطعه محصول نهایی',
        containImmediately: true,
        containmentAction: 'جداسازی پالت و انتقال به ناحیه قرنطینه',
        idempotencyKey: `PG-NCR-MAN-${ts}`,
        user: actor,
      },
      buildBridge()
    );
    assert.equal(manualNcrRes.ok, true);
    assert.equal(manualNcrRes.ncr?.status, 'CONTAINED');
    assert.ok(manualNcrRes.qmDocument?.documentNumber, 'Immediate containment must link MvT 344 document');

    const dbManNcr = mockPrisma.__getState().qualityNonconformances.find(n => n.id === manualNcrRes.ncr!.id);
    assert.equal(dbManNcr.materialLotId, 'LOT-PG-FG-1');
    assert.ok(dbManNcr.containmentQmDocId, 'containmentQmDocId FK must be persisted');
    assert.equal(dbManNcr.resultingQualityStatus, 'QUALITY_BLOCKED');

    // Disposition as REWORK -> creates QualityReworkOrder row
    const reworkDispRes = await dispositionNonconformance(
      dbManNcr.id,
      {
        disposition: 'REWORK',
        rootCause: 'تنظیم نبودن دمای کوره پخت رنگ',
        correctiveAction: 'سنباده‌زنی و رنگ‌آمیزی مجدد ۲۰ عدد',
        reworkInstructions: 'بازکاری پوشش کاتافورز و بازرسی مجدد ابعادی',
        targetOperationCode: 'OP50',
        returnToProduction: true,
        idempotencyKey: `PG-DISP-RWK-${ts}`,
        user: actor,
      },
      buildBridge()
    );
    assert.equal(reworkDispRes.ok, true);
    assert.ok(reworkDispRes.reworkOrder?.id);
    const reworkId = reworkDispRes.reworkOrder!.id;

    const dbReworkCreated = mockPrisma.__getState().qualityReworkOrders.find(r => r.id === reworkId);
    assert.equal(dbReworkCreated.ncrId, dbManNcr.id);
    assert.equal(dbReworkCreated.partId, 'PRT-PG-FG-BRK');
    assert.equal(dbReworkCreated.materialLotId, 'LOT-PG-FG-1');
    assert.equal(dbReworkCreated.plannedReworkQty, 20);
    assert.equal(dbReworkCreated.remainingQty, 20);

    // Partial completion (12 good, 2 scrap -> 6 remaining)
    const rwkPart1 = await completeReworkOrder(
      reworkId,
      {
        goodQty: 12,
        scrapQty: 2,
        completionNotes: 'تکمیل مرحله اول دوباره‌کاری',
        idempotencyKey: `PG-RWK-P1-${ts}`,
        user: actor,
      },
      buildBridge()
    );
    assert.equal(rwkPart1.ok, true);
    assert.equal(rwkPart1.reworkOrder?.status, 'IN_PROGRESS');
    assert.equal(rwkPart1.reworkOrder?.remainingQty, 6);
    assert.ok(rwkPart1.releaseDocument?.documentNumber);
    assert.ok(rwkPart1.scrapDocument?.documentNumber);

    // Over-reporting guard (attempting 7 when only 6 remain -> 409)
    const rwkOver = await completeReworkOrder(
      reworkId,
      {
        goodQty: 7,
        scrapQty: 0,
        idempotencyKey: `PG-RWK-OVER-${ts}`,
        user: actor,
      },
      buildBridge()
    );
    assert.equal(rwkOver.ok, false);
    assert.equal(rwkOver.statusCode, 409);

    // Final completion (5 good, 1 scrap -> 0 remaining -> COMPLETED & NCR CLOSED)
    const rwkPart2 = await completeReworkOrder(
      reworkId,
      {
        goodQty: 5,
        scrapQty: 1,
        completionNotes: 'اتمام کامل دستور دوباره‌کاری',
        idempotencyKey: `PG-RWK-P2-${ts}`,
        user: actor,
      },
      buildBridge()
    );
    assert.equal(rwkPart2.ok, true);
    assert.equal(rwkPart2.reworkOrder?.status, 'COMPLETED');
    assert.equal(rwkPart2.reworkOrder?.remainingQty, 0);
    assert.equal(rwkPart2.ncr?.status, 'CLOSED');
    assert.equal(rwkPart2.ncr?.reworkedGoodQty, 17);
    assert.equal(rwkPart2.ncr?.scrappedQty, 3);

    const dbReworkFinal = mockPrisma.__getState().qualityReworkOrders.find(r => r.id === reworkId);
    assert.ok(dbReworkFinal.returnDocumentId, 'returnDocumentId FK must be persisted');
    assert.ok(dbReworkFinal.scrapDocumentId, 'scrapDocumentId FK must be persisted');

    // Exercise SORT_REINSPECT and USE_AS_IS on additional NCRs
    const ncrSortRes = await createNonconformanceRecord(
      {
        title: 'نیاز به تفکیک و بازرسی مجدد',
        sourceType: 'IN_PROCESS',
        severity: 'MINOR',
        defectCode: 'DEF-SCRATCH',
        partId: 'PRT-PG-WIP-BRK',
        warehouseId: 'WH-WIP',
        affectedQty: 10,
        description: 'خش جزئی روی ۱۰ قطعه',
        user: actor,
      },
      buildBridge()
    );
    assert.equal(ncrSortRes.ok, true);
    const sortDispRes = await dispositionNonconformance(
      ncrSortRes.ncr!.id,
      {
        disposition: 'SORT_REINSPECT',
        sortedGoodQty: 8,
        sortedDefectQty: 2,
        dispositionNotes: 'تفکیک ۱۰۰ درصدی در خط',
        user: actor,
      },
      buildBridge()
    );
    assert.equal(sortDispRes.ok, true);
    assert.equal(sortDispRes.ncr?.status, 'CLOSED');

    const ncrUseAsIsRes = await createNonconformanceRecord(
      {
        title: 'انحراف جزئی ظاهری قابل قبول با ارفاق مهندسی',
        sourceType: 'IN_PROCESS',
        severity: 'MINOR',
        defectCode: 'DEF-SCRATCH',
        partId: 'PRT-PG-WIP-BRK',
        warehouseId: 'WH-WIP',
        affectedQty: 6,
        description: 'انحراف سطحی داخل محدوده مجاز',
        user: actor,
      },
      buildBridge()
    );
    assert.equal(ncrUseAsIsRes.ok, true);
    const useAsIsRes = await dispositionNonconformance(
      ncrUseAsIsRes.ncr!.id,
      { disposition: 'USE_AS_IS', rootCause: 'در محدوده مجاز انحراف مهندسی', user: actor },
      buildBridge()
    );
    assert.equal(useAsIsRes.ok, true);
    assert.equal(useAsIsRes.ncr?.status, 'CLOSED');

    // =========================================================================
    // TEST 5: Zero In-Memory Dependency & Simulated Process Restart Proof
    // =========================================================================
    console.log('--- P6-PG.5: Zero In-Memory Dependency & Simulated Process Restart Proof ---');
    const memBeforeWipe = exportQualityStateSnapshot();
    assert.equal(memBeforeWipe.inspections.length, 0, 'In-memory inspectionsStore must remain untouched in PostgreSQL mode');
    assert.equal(memBeforeWipe.ncrs.length, 0, 'In-memory ncrsStore must remain untouched in PostgreSQL mode');
    assert.equal(memBeforeWipe.reworkOrders.length, 0, 'In-memory reworkOrdersStore must remain untouched in PostgreSQL mode');

    // Simulate full process restart by wiping all in-memory stores & idempotency map
    resetQualityStateForTests();

    const [reloadedInspections, reloadedNcrs, reloadedReworks, reloadedHistory, reloadedDash] = await Promise.all([
      listQualityInspectionsAsync(),
      listNonconformancesAsync(),
      listReworkOrdersAsync(),
      getQualityEntityHistoryAsync({
        lotNumber: `FG-LOT-PG-${ts}`,
        balances,
        coils: buildBridge().coils,
        documents: [],
      }),
      computeQualityDashboardAnalyticsAsync({
        balances,
        coils: buildBridge().coils,
        shopFloorScrapQtyTotal: 0,
      }),
    ]);

    assert.equal(reloadedInspections.length, 4, 'All 4 persisted inspections must survive restart');
    assert.equal(reloadedNcrs.length, 5, 'All 5 persisted NCRs must survive restart');
    assert.equal(reloadedReworks.length, 1, 'Persisted rework order must survive restart');
    assert.ok(reloadedHistory.inspections.length >= 1 && reloadedHistory.ncrs.length >= 1 && reloadedHistory.reworkOrders.length >= 1);
    assert.equal(reloadedDash.summary.totalInspections, 4);
    assert.equal(reloadedDash.summary.totalNcrCount, 5);
    assert.ok(mockPrisma.__getState().auditLogs.length >= 6, 'DB AuditLog entries must be persisted transactionally');

    // Verify HTTP Express GET /api/quality/* endpoints read from PostgreSQL after memory wipe
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/api', apiRouter);
    const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address();
    assert(addr && typeof addr === 'object');
    const baseUrl = `http://127.0.0.1:${addr.port}/api`;
    try {
      const [httpInsp, httpNcr, httpRwk, httpHist, httpDash] = await Promise.all([
        fetch(`${baseUrl}/quality/inspections`).then(r => r.json()),
        fetch(`${baseUrl}/quality/ncrs`).then(r => r.json()),
        fetch(`${baseUrl}/quality/rework-orders`).then(r => r.json()),
        fetch(`${baseUrl}/quality/history?lotNumber=${encodeURIComponent(`FG-LOT-PG-${ts}`)}`).then(r => r.json()),
        fetch(`${baseUrl}/quality/dashboard`).then(r => r.json()),
      ]);
      assert.equal(httpInsp.success, true);
      assert.equal(httpInsp.count, 4, 'HTTP GET /quality/inspections must read from Prisma');
      assert.equal(httpNcr.count, 5, 'HTTP GET /quality/ncrs must read from Prisma');
      assert.equal(httpRwk.count, 1, 'HTTP GET /quality/rework-orders must read from Prisma');
      assert.equal(httpHist.success, true);
      assert.ok(httpHist.data.reworkOrders.length === 1, 'HTTP GET /quality/history must read from Prisma');
      assert.equal(httpDash.data.summary.totalInspections, 4, 'HTTP GET /quality/dashboard must read from Prisma');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }

    // =========================================================================
    // TEST 6: Restart-Safe Persistent Idempotency (200 Replay & 409 Conflict)
    // =========================================================================
    console.log('--- P6-PG.6: Restart-Safe Persistent Idempotency Proof ---');
    const countBeforeReplay = mockPrisma.__getState().qualityInspections.length;

    // Replay identical IQC accept payload AFTER in-memory wipe -> 200 idempotentReplay
    const replayRes = await createQualityInspection(
      {
        inspectionType: 'INCOMING_MATERIAL',
        partId: 'PRT-PG-COIL-ST14',
        warehouseId: 'WH-RAW',
        physicalCoilId: 'PCOIL-PG-1',
        lotNumber: `COIL-PG-OK-${ts}`,
        inspectedQty: 4200,
        decision: 'ACCEPTED',
        idempotencyKey: `PG-IQC-ACC-${ts}`,
        user: actor,
      },
      buildBridge()
    );
    assert.equal(replayRes.ok, true);
    assert.equal(replayRes.statusCode, 200);
    assert.equal(replayRes.idempotentReplay, true);
    assert.equal(replayRes.inspection?.id, iqcAcceptRes.inspection?.id);
    assert.equal(mockPrisma.__getState().qualityInspections.length, countBeforeReplay, 'Replay must NOT create duplicate rows');

    // Replay same key with mutated payload -> 409 Conflict
    const conflictRes = await createQualityInspection(
      {
        inspectionType: 'INCOMING_MATERIAL',
        partId: 'PRT-PG-COIL-ST14',
        warehouseId: 'WH-RAW',
        physicalCoilId: 'PCOIL-PG-1',
        lotNumber: `COIL-PG-OK-${ts}`,
        inspectedQty: 9999, // mutated!
        decision: 'ACCEPTED',
        idempotencyKey: `PG-IQC-ACC-${ts}`,
        user: actor,
      },
      buildBridge()
    );
    assert.equal(conflictRes.ok, false);
    assert.equal(conflictRes.statusCode, 409, 'Mutated idempotency replay must fail with 409 Conflict');
    assert.equal(mockPrisma.__getState().qualityInspections.length, countBeforeReplay);

    // =========================================================================
    // TEST 7: Atomic Transaction Rollback Proofs
    // =========================================================================
    console.log('--- P6-PG.7: Atomic Transaction Rollback Proofs ---');
    const snapBeforeRollbacks = deepClone(mockPrisma.__getState());

    // 7a. Immediate decision failure on createQualityInspection -> rolls back inspection + auto-NCR + idempotency
    failNextQmTransfer = true;
    const txFailInsp = await createQualityInspection(
      {
        inspectionType: 'INCOMING_MATERIAL',
        partId: 'PRT-PG-COIL-ST14',
        warehouseId: 'WH-RAW',
        physicalCoilId: 'PCOIL-PG-1',
        lotNumber: `COIL-PG-OK-${ts}`,
        inspectedQty: 4200,
        decision: 'REJECTED',
        defectCodes: ['DEF-CRACK'],
        idempotencyKey: `PG-ROLLBACK-INSP-${ts}`,
        user: actor,
      },
      buildBridge()
    );
    assert.equal(txFailInsp.ok, false);
    assert.equal(txFailInsp.statusCode, 409);
    assert.equal(
      mockPrisma.__getState().qualityInspections.length,
      snapBeforeRollbacks.qualityInspections.length,
      'Failed immediate-decision inspection must roll back completely'
    );
    assert.equal(
      mockPrisma.__getState().qualityNonconformances.length,
      snapBeforeRollbacks.qualityNonconformances.length,
      'Failed immediate-decision inspection must NOT leave orphan NCR'
    );
    assert.equal(
      mockPrisma.__getState().qualityIdempotencyRecords.length,
      snapBeforeRollbacks.qualityIdempotencyRecords.length,
      'Failed transaction must NOT leave orphan idempotency key'
    );

    // 7b. Immediate containment failure on createNonconformanceRecord -> rolls back NCR
    failNextQmTransfer = true;
    const txFailNcr = await createNonconformanceRecord(
      {
        title: 'تست بازگشت تراکنش مهار فوری',
        sourceType: 'WAREHOUSE_AUDIT',
        severity: 'CRITICAL',
        defectCode: 'DEF-DIM',
        partId: 'PRT-PG-FG-BRK',
        warehouseId: 'WH-FG',
        lotNumber: `FG-LOT-PG-${ts}`,
        affectedQty: 10,
        description: 'باید در صورت خطای انبار کاملاً Rollback شود',
        containImmediately: true,
        idempotencyKey: `PG-ROLLBACK-NCR-${ts}`,
        user: actor,
      },
      buildBridge()
    );
    assert.equal(txFailNcr.ok, false);
    assert.equal(txFailNcr.statusCode, 409);
    assert.equal(
      mockPrisma.__getState().qualityNonconformances.length,
      snapBeforeRollbacks.qualityNonconformances.length,
      'Failed immediate-containment NCR must roll back completely'
    );

    // 7c. DB failure during REWORK disposition -> rolls back NCR status/disposition changes
    const ncrForRollback = await createNonconformanceRecord(
      {
        title: 'تست بازگشت تراکنش تعیین تکلیف دوباره‌کاری',
        sourceType: 'IN_PROCESS',
        severity: 'MAJOR',
        defectCode: 'DEF-WELD',
        partId: 'PRT-PG-WIP-BRK',
        warehouseId: 'WH-WIP',
        affectedQty: 15,
        description: 'تست خطای دیتابیس حین ایجاد ReworkOrder',
        user: actor,
      },
      buildBridge()
    );
    assert.equal(ncrForRollback.ok, true);
    const ncrIdRb = ncrForRollback.ncr!.id;

    mockPrisma.__setFailOnNextReworkCreate(true);
    let threwOnReworkCreate = false;
    try {
      await dispositionNonconformance(
        ncrIdRb,
        {
          disposition: 'REWORK',
          reworkInstructions: 'باید Rollback شود',
          idempotencyKey: `PG-ROLLBACK-DISP-${ts}`,
          user: actor,
        },
        buildBridge()
      );
    } catch {
      threwOnReworkCreate = true;
    }
    assert.equal(threwOnReworkCreate, true, 'Simulated DB error must reject promise');
    const ncrAfterFailedDisp = mockPrisma.__getState().qualityNonconformances.find(n => n.id === ncrIdRb);
    assert.equal(ncrAfterFailedDisp.status, 'OPEN', 'NCR status must roll back to OPEN after reworkOrder create failure');
    assert.equal(ncrAfterFailedDisp.disposition, 'PENDING', 'NCR disposition must roll back to PENDING');
    assert.equal(ncrAfterFailedDisp.linkedReworkOrderId ?? null, null);

    // 7d. Failure during completeReworkOrder -> rolls back reworkOrder & NCR progress
    const validDisp = await dispositionNonconformance(
      ncrIdRb,
      { disposition: 'REWORK', reworkInstructions: 'دوباره‌کاری جوش', user: actor },
      buildBridge()
    );
    assert.equal(validDisp.ok, true);
    const rwkRbId = validDisp.reworkOrder!.id;

    // Seed balance for PRT-PG-WIP-BRK so completeReworkOrder calls bridge.postQualityAdjustment
    balances.push({
      id: 'BAL-WIP-RB',
      partId: 'PRT-PG-WIP-BRK',
      partCode: 'WIP-ECU-BRK-01',
      partName: 'براکت خام پرس‌شده ECU',
      category: 'WIP_PART',
      warehouseId: 'WH-WIP',
      warehouseName: 'انبار نیمه‌ساخته',
      locationCode: 'WIP-B1',
      ownership: 'COMPANY_OWNED',
      qualityStatus: 'QUALITY_BLOCKED',
      unit: 'PCS',
      physicalQty: 15,
      unrestrictedQty: 0,
      qualityInspectionQty: 0,
      blockedQty: 15,
      ownedQty: 15,
      supplierOwnedQty: 0,
      reservedQty: 0,
      qualityBlockedQty: 15,
      availableQty: 0,
      physicalKg: 6.75,
      unrestrictedKg: 0,
      qualityInspectionKg: 0,
      blockedKg: 6.75,
      ownedKg: 6.75,
      supplierOwnedKg: 0,
      reservedKg: 0,
      qualityBlockedKg: 6.75,
      availableKg: 0,
      lastTransactionAt: now,
    });

    failNextQualityAdjustment = true;
    const failedComplete = await completeReworkOrder(
      rwkRbId,
      {
        goodQty: 0,
        scrapQty: 5,
        idempotencyKey: `PG-ROLLBACK-RWK-${ts}`,
        user: actor,
      },
      buildBridge()
    );
    assert.equal(failedComplete.ok, false);
    assert.equal(failedComplete.statusCode, 409);
    const rwkAfterFail = mockPrisma.__getState().qualityReworkOrders.find(r => r.id === rwkRbId);
    assert.equal(rwkAfterFail.remainingQty, 15, 'Rework remainingQty must roll back cleanly on ledger failure');
    assert.equal(rwkAfterFail.scrappedQty, 0, 'Rework scrappedQty must roll back cleanly on ledger failure');
    assert.equal(rwkAfterFail.status, 'OPEN');

    console.log('\n✅ PASS: All KPIMS P6 PostgreSQL Relational Persistence tests passed!');
  } finally {
    __setQualityPrismaForTests(null);
    resetQualityStateForTests();
    assert.equal(isQualityPostgresPersistenceActive(), false, 'Test cleanup must restore non-DB mode');
  }
}

run().catch(err => {
  console.error('❌ FAIL: KPIMS P6 PostgreSQL Relational Persistence test failed:', err);
  process.exit(1);
});
