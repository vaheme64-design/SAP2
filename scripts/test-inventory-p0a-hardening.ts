/**
 * =========================================================================
 * KPIMS — Inventory P0-A Isolated Hardening & Regression Suite
 * =========================================================================
 * Strictly isolated in-memory relational verification of P0-A ledger engine:
 *   1. Single coherent sheet-metal receipt + duplicate receipt/coil prevention
 *   2. End-to-end physicalCoilId linkage (receipt -> issue -> transfer -> adjustment)
 *   3. Paired OUT/IN QM status transfers (322, 321, 344) + coil/lot quality sync
 *   4. True reversal semantics (issue, QM transfer, warehouse transfer, receipt,
 *      immutable originals, double-reversal block, downstream-consumption block)
 *   5. Overdraft prevention, zero clamping, strict master-data rejection &
 *      NULLS NOT DISTINCT composite stock_balances uniqueness check
 *   6. Concurrent deduction CAS version/gte conflict simulation
 *      (Note: true multi-connection PostgreSQL Serializable + NULLS NOT DISTINCT
 *       enforcement requires verification against an isolated PostgreSQL instance.)
 *   7. Idempotent retry replay, mismatched payload 409, and raw duplicate 409
 *
 * SAFETY GUARD: Refuses to execute if DATABASE_URL is configured.
 * =========================================================================
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  postInventoryDocumentInTransaction,
  saveDraftDocumentInDbTransaction,
  buildDocumentRequestFingerprint,
  prepareQmTransferRetryInDb,
  resolveDbDocumentPostIdempotency,
  inferDbDocumentSemantics,
  buildQmStatusTransferDocumentFromDb,
  createReservationInDbTransaction,
  releaseReservationInDbTransaction,
  queryReservationsFromDb,
  queryDetailedStockBalancesFromDb,
  queryInventoryDocumentsFromDb,
  querySingleInventoryDocumentFromDb,
  queryContractsAndSapcoAccountFromDb,
  queryStageInventorySummaryFromDb,
  queryInventoryTransactionsFromDb,
  returnPhysicalCoilRemnantInDbTransaction,
  reallocatePhysicalCoilContractsInDbTransaction,
} from '../src/server/services/inventoryLedgerService';
import { InventoryDocument } from '../src/types/inventory';
import {
  verifyNullsNotDistinctMigrations,
  loadWorkspaceMigrations,
  STOCK_BALANCES_UNIQUE_INDEX,
} from './verify-prisma-migrations';

if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '') {
  console.error(
    'ABORT: scripts/test-inventory-p0a-hardening.ts is strictly isolated and MUST NOT run when DATABASE_URL is set.'
  );
  process.exit(1);
}

const TEST_USER = { uid: 'USR-QA-P0A', displayName: 'تستر کنترل انبار P0-A' };

interface MockDbState {
  roles: any[];
  users: any[];
  warehouses: any[];
  warehouseLocations: any[];
  units: any[];
  materials: any[];
  parts: any[];
  materialContracts: any[];
  materialLots: any[];
  physicalCoils: any[];
  contractCoilAllocations: any[];
  materialContractTransactions: any[];
  inventoryDocuments: any[];
  inventoryDocumentLines: any[];
  inventoryTransactions: any[];
  inventoryReservations: any[];
  stockBalances: any[];
  coilIssueReturnRecords: any[];
  auditLogs: any[];
  seq: number;
}

function makePrismaP2002(target: string[]): any {
  const err: any = new Error(`Unique constraint failed on the fields: (${target.join(', ')})`);
  err.code = 'P2002';
  err.meta = { target };
  return err;
}

function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}

function matchCondition(val: any, cond: any): boolean {
  if (cond === undefined) return true;
  if (cond === null) return val === null || val === undefined;
  if (typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    if ('equals' in cond && val !== cond.equals) return false;
    if ('in' in cond && !cond.in.includes(val)) return false;
    if ('not' in cond) {
      if (cond.not === null) {
        if (val === null || val === undefined) return false;
      } else if (val === cond.not) {
        return false;
      }
    }
    if ('gte' in cond && !(Number(val) >= Number(cond.gte) - 1e-9)) return false;
    if ('gt' in cond && !(Number(val) > Number(cond.gt) + 1e-9)) return false;
    if ('lte' in cond && !(Number(val) <= Number(cond.lte) + 1e-9)) return false;
    if ('lt' in cond && !(Number(val) < Number(cond.lt) - 1e-9)) return false;
    return true;
  }
  return val === cond;
}

function matchesWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === 'OR' && Array.isArray(cond)) {
      if (!cond.some(sub => matchesWhere(row, sub))) return false;
      continue;
    }
    if (key === 'AND' && Array.isArray(cond)) {
      if (!cond.every(sub => matchesWhere(row, sub))) return false;
      continue;
    }
    if (!matchCondition(row[key], cond)) return false;
  }
  return true;
}

function applyUpdateData(row: any, data: Record<string, any>): void {
  for (const [key, val] of Object.entries(data)) {
    if (val === undefined) continue;
    if (val && typeof val === 'object' && !(val instanceof Date) && !Array.isArray(val)) {
      if ('increment' in val) {
        row[key] = Number(row[key] || 0) + Number(val.increment);
        continue;
      }
      if ('decrement' in val) {
        row[key] = Number(row[key] || 0) - Number(val.decrement);
        continue;
      }
    }
    row[key] = val;
  }
}

function stockBalanceCompositeKey(b: any): string {
  // Mirrors PostgreSQL NULLS NOT DISTINCT unique index on stock_balances
  const norm = (v: any) => (v === undefined || v === null ? '<NULL>' : String(v));
  return [
    norm(b.partId),
    norm(b.warehouseId),
    norm(b.locationId),
    norm(b.materialLotId),
    norm(b.physicalCoilId),
    norm(b.ownership),
    norm(b.contractId),
    norm(b.qualityStatus),
  ].join('|');
}

function createSeededState(): MockDbState {
  const now = new Date('2026-11-24T08:00:00.000Z');
  return {
    seq: 1,
    roles: [{ id: 'ROLE-ADMIN', name: 'ADMIN', displayName: 'مدیر سیستم', active: true, createdAt: now }],
    users: [
      {
        id: 'USER-QA-1',
        username: TEST_USER.uid,
        email: `${TEST_USER.uid}@kpims.local`,
        fullName: TEST_USER.displayName,
        roleId: 'ROLE-ADMIN',
        active: true,
        createdAt: now,
      },
    ],
    warehouses: [
      { id: 'WH-ID-RAW', code: 'WH-RAW', name: 'انبار ورق و مواد اولیه', type: 'RAW_MATERIALS', active: true },
      { id: 'WH-ID-WIP', code: 'WH-WIP', name: 'انبار نیمه‌ساخته', type: 'WIP', active: true },
      { id: 'WH-ID-FG', code: 'WH-FG', name: 'انبار محصول نهایی', type: 'FINISHED_GOODS', active: true },
    ],
    warehouseLocations: [
      { id: 'LOC-ID-RAW-A1', code: 'LOC-RAW-A1', warehouseId: 'WH-ID-RAW', name: 'ردیف A1', active: true },
      { id: 'LOC-ID-RAW-B1', code: 'LOC-RAW-B1', warehouseId: 'WH-ID-RAW', name: 'ردیف B1', active: true },
      { id: 'LOC-ID-WIP-01', code: 'LOC-WIP-01', warehouseId: 'WH-ID-WIP', name: 'ایستگاه برش', active: true },
    ],
    units: [
      { id: 'UOM-KG', code: 'KG', name: 'کیلوگرم' },
      { id: 'UOM-PCS', code: 'PCS', name: 'عدد' },
    ],
    materials: [
      { id: 'MAT-DC04', code: 'DC04', name: 'ورق کششی DC04', grade: 'DC04', active: true },
    ],
    parts: [
      {
        id: 'PART-SHEET-01',
        partNumber: 'RM-DC04-08',
        name: 'ورق فولادی DC04 ضخامت 0.8',
        category: 'RAW_MATERIAL',
        materialId: 'MAT-DC04',
        materialGrade: 'DC04',
        thicknessMm: 0.8,
        unitId: 'UOM-KG',
        active: true,
      },
      {
        id: 'PART-BOLT-01',
        partNumber: 'RM-BOLT-M8',
        name: 'پیچ M8 گالوانیزه',
        category: 'RAW_MATERIAL',
        materialId: null,
        unitId: 'UOM-PCS',
        active: true,
      },
    ],
    materialContracts: [
      {
        id: 'CNT-A',
        contractNumber: 'SAPCO-1405-A',
        customerName: 'ساپکو',
        materialId: 'MAT-DC04',
        materialGrade: 'DC04',
        thicknessMm: 0.8,
        totalAllocatedWeightKg: 10000,
        receivedWeightKg: 0,
        status: 'ACTIVE',
      },
      {
        id: 'CNT-B',
        contractNumber: 'SAPCO-1405-B',
        customerName: 'ساپکو',
        materialId: 'MAT-DC04',
        materialGrade: 'DC04',
        thicknessMm: 0.8,
        totalAllocatedWeightKg: 8000,
        receivedWeightKg: 0,
        status: 'ACTIVE',
      },
    ],
    materialLots: [
      {
        id: 'LOT-BOLT-01',
        lotNumber: 'LOT-M8-001',
        materialId: null, // Explicitly tests nullable MaterialLot.materialId
        initialWeightKg: 500,
        remainingWeightKg: 500,
        status: 'AVAILABLE',
        ownership: 'COMPANY_OWNED',
        receivedAt: now,
      },
    ],
    physicalCoils: [],
    contractCoilAllocations: [],
    materialContractTransactions: [],
    inventoryDocuments: [],
    inventoryDocumentLines: [],
    inventoryTransactions: [],
    inventoryReservations: [],
    stockBalances: [
      {
        id: 'SB-BOLT-01',
        partId: 'PART-BOLT-01',
        warehouseId: 'WH-ID-RAW',
        locationId: 'LOC-ID-RAW-A1',
        materialLotId: 'LOT-BOLT-01',
        physicalCoilId: null,
        quantityOnHand: 500,
        quantityReserved: 100, // 400 available
        quantityAvailable: 400,
        weightKgOnHand: 500,
        weightKgReserved: 100,
        weightKgAvailable: 400,
        ownership: 'COMPANY_OWNED',
        contractId: null,
        contractNumber: null,
        qualityStatus: 'AVAILABLE',
        version: 1,
        lastTransactionAt: now,
      },
      {
        id: 'SB-NULL-KEYS-01',
        partId: 'PART-BOLT-01',
        warehouseId: 'WH-ID-RAW',
        locationId: null,
        materialLotId: null,
        physicalCoilId: null,
        quantityOnHand: 100,
        quantityReserved: 0,
        quantityAvailable: 100,
        weightKgOnHand: 100,
        weightKgReserved: 0,
        weightKgAvailable: 100,
        ownership: 'COMPANY_OWNED',
        contractId: null,
        contractNumber: null,
        qualityStatus: 'AVAILABLE',
        version: 1,
        lastTransactionAt: now,
      },
    ],
    coilIssueReturnRecords: [],
    auditLogs: [],
  };
}

interface MockHooks {
  onBeforeStockBalanceUpdateMany?: (args: any, state: MockDbState) => void;
  onBeforeMaterialContractUpdateMany?: (args: any, state: MockDbState) => void;
  onBeforeMaterialLotUpdateMany?: (args: any, state: MockDbState) => void;
  onTransactionAttempt?: (attempt: number) => void;
}

function buildTxClient(state: MockDbState, hooks: MockHooks) {
  const nextId = (prefix: string) => `${prefix}-${state.seq++}`;

  const hydrateDocument = (doc: any, include?: any) => {
    if (!doc) return null;
    const out = { ...doc };
    if (include?.warehouse) {
      out.warehouse = state.warehouses.find(w => w.id === doc.warehouseId) || null;
    }
    if (include?.targetWarehouse) {
      out.targetWarehouse = doc.targetWarehouseId
        ? state.warehouses.find(w => w.id === doc.targetWarehouseId) || null
        : null;
    }
    if (include?.lines) {
      let lines = state.inventoryDocumentLines.filter(l => l.documentId === doc.id);
      if (include.lines?.orderBy?.lineNumber === 'asc') {
        lines = [...lines].sort((a, b) => a.lineNumber - b.lineNumber);
      }
      const lineInc = include.lines?.include;
      out.lines = lines.map(l => {
        const hl = { ...l };
        if (lineInc?.part) {
          const p = state.parts.find(x => x.id === l.partId) || null;
          if (p && lineInc.part?.include?.unit) {
            hl.part = { ...p, unit: state.units.find(u => u.id === p.unitId) || null };
          } else {
            hl.part = p;
          }
        }
        if (lineInc?.unit || lineInc?.part?.include?.unit) {
          hl.unit = state.units.find(u => u.id === l.unitId) || null;
        }
        if (lineInc?.location) {
          hl.location = l.locationId
            ? state.warehouseLocations.find(loc => loc.id === l.locationId) || null
            : null;
        }
        if (lineInc?.targetLocation) {
          hl.targetLocation = l.targetLocationId
            ? state.warehouseLocations.find(loc => loc.id === l.targetLocationId) || null
            : null;
        }
        if (lineInc?.materialLot) {
          hl.materialLot = l.materialLotId
            ? state.materialLots.find(lot => lot.id === l.materialLotId) || null
            : null;
        }
        if (lineInc?.physicalCoil) {
          hl.physicalCoil = l.physicalCoilId
            ? state.physicalCoils.find(c => c.id === l.physicalCoilId) || null
            : null;
        }
        return hl;
      });
    }
    if (include?.transactions) {
      let trxs = state.inventoryTransactions.filter(t => t.documentId === doc.id);
      if (include.transactions?.orderBy?.createdAt === 'asc') {
        trxs = [...trxs].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      }
      out.transactions = trxs;
    }
    return out;
  };

  return {
    role: {
      findFirst: async ({ where }: any = {}) => state.roles.find(r => matchesWhere(r, where)) || null,
      create: async ({ data }: any) => {
        const row = { id: nextId('ROLE'), createdAt: new Date(), active: true, ...data };
        state.roles.push(row);
        return row;
      },
    },
    user: {
      findFirst: async ({ where }: any = {}) => state.users.find(u => matchesWhere(u, where)) || null,
      create: async ({ data }: any) => {
        const row = { id: nextId('USR'), createdAt: new Date(), active: true, ...data };
        state.users.push(row);
        return row;
      },
    },
    warehouse: {
      findFirst: async ({ where }: any = {}) => state.warehouses.find(w => matchesWhere(w, where)) || null,
    },
    warehouseLocation: {
      findFirst: async ({ where }: any = {}) => state.warehouseLocations.find(l => matchesWhere(l, where)) || null,
    },
    unitOfMeasure: {
      findUnique: async ({ where }: any) => state.units.find(u => matchesWhere(u, where)) || null,
    },
    material: {
      findUnique: async ({ where }: any) => state.materials.find(m => matchesWhere(m, where)) || null,
      findFirst: async ({ where }: any = {}) => state.materials.find(m => matchesWhere(m, where)) || null,
    },
    part: {
      findUnique: async ({ where }: any) => state.parts.find(p => matchesWhere(p, where)) || null,
      findFirst: async ({ where }: any = {}) => state.parts.find(p => matchesWhere(p, where)) || null,
    },
    materialContract: {
      findUnique: async ({ where }: any) => state.materialContracts.find(c => matchesWhere(c, where)) || null,
      findFirst: async ({ where }: any = {}) => state.materialContracts.find(c => matchesWhere(c, where)) || null,
      findMany: async ({ where, include }: any = {}) => {
        return state.materialContracts
          .filter(c => matchesWhere(c, where))
          .map(c => {
            const out = { ...c };
            if (include?.material) {
              out.material = c.materialId ? state.materials.find(m => m.id === c.materialId) || null : null;
            }
            if (include?.supplierCustomer) {
              out.supplierCustomer = { id: 'CUST-SAPCO', name: c.customerName || 'شرکت ساپکو' };
            }
            if (include?.coilAllocations || include?.contractCoilAllocations) {
              const allocs = state.contractCoilAllocations
                .filter(a => a.contractId === c.id)
                .map(a => {
                  const coil = state.physicalCoils.find(pc => pc.id === (a.coilId ?? a.physicalCoilId)) || null;
                  return {
                    ...a,
                    coil: coil
                      ? {
                          ...coil,
                          warehouse: state.warehouses.find(w => w.id === coil.warehouseId) || null,
                          material: coil.materialId ? state.materials.find(m => m.id === coil.materialId) || null : null,
                        }
                      : null,
                  };
                });
              out.coilAllocations = allocs;
              out.contractCoilAllocations = allocs;
            }
            if (include?.transactions || include?.contractTransactions) {
              const txs = state.materialContractTransactions
                .filter(t => t.contractId === c.id)
                .map(t => ({
                  ...t,
                  lot: t.lotId ? state.materialLots.find(l => l.id === t.lotId) || null : null,
                }));
              out.transactions = txs;
              out.contractTransactions = txs;
            }
            return out;
          });
      },
      update: async ({ where, data }: any) => {
        const row = state.materialContracts.find(c => matchesWhere(c, where));
        if (!row) throw new Error('MaterialContract not found');
        applyUpdateData(row, data);
        return row;
      },
      updateMany: async (args: any) => {
        hooks.onBeforeMaterialContractUpdateMany?.(args, state);
        const targets = state.materialContracts.filter(c => matchesWhere(c, args.where));
        for (const r of targets) applyUpdateData(r, args.data);
        return { count: targets.length };
      },
    },
    materialLot: {
      findUnique: async ({ where }: any) => state.materialLots.find(l => matchesWhere(l, where)) || null,
      findFirst: async ({ where }: any = {}) => state.materialLots.find(l => matchesWhere(l, where)) || null,
      create: async ({ data }: any) => {
        if (state.materialLots.some(l => l.lotNumber === data.lotNumber)) {
          throw makePrismaP2002(['lotNumber']);
        }
        const row = {
          id: nextId('LOT'),
          materialId: null,
          status: 'AVAILABLE',
          ownership: 'COMPANY_OWNED',
          receivedAt: new Date(),
          ...data,
        };
        state.materialLots.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = state.materialLots.find(l => matchesWhere(l, where));
        if (!row) throw new Error('MaterialLot not found');
        applyUpdateData(row, data);
        return row;
      },
      updateMany: async (args: any) => {
        hooks.onBeforeMaterialLotUpdateMany?.(args, state);
        const targets = state.materialLots.filter(l => matchesWhere(l, args.where));
        for (const r of targets) applyUpdateData(r, args.data);
        return { count: targets.length };
      },
    },
    physicalCoil: {
      findUnique: async ({ where, include }: any) => {
        const c = state.physicalCoils.find(x => matchesWhere(x, where)) || null;
        if (!c) return null;
        const out = { ...c };
        if (include?.material) out.material = c.materialId ? state.materials.find(m => m.id === c.materialId) || null : null;
        if (include?.warehouse) out.warehouse = state.warehouses.find(w => w.id === c.warehouseId) || null;
        if (include?.warehouseLocation) {
          out.warehouseLocation = c.warehouseLocationId
            ? state.warehouseLocations.find(l => l.id === c.warehouseLocationId) || null
            : null;
        }
        if (include?.contractAllocations) {
          out.contractAllocations = state.contractCoilAllocations
            .filter(a => (a.coilId ?? a.physicalCoilId) === c.id)
            .map(a => ({
              ...a,
              contract: state.materialContracts.find(mc => mc.id === a.contractId) || null,
            }));
        }
        return out;
      },
      findFirst: async ({ where, include }: any = {}) => {
        const c = state.physicalCoils.find(x => matchesWhere(x, where)) || null;
        if (!c) return null;
        const out = { ...c };
        if (include?.material) out.material = c.materialId ? state.materials.find(m => m.id === c.materialId) || null : null;
        if (include?.warehouse) out.warehouse = state.warehouses.find(w => w.id === c.warehouseId) || null;
        if (include?.warehouseLocation) {
          out.warehouseLocation = c.warehouseLocationId
            ? state.warehouseLocations.find(l => l.id === c.warehouseLocationId) || null
            : null;
        }
        if (include?.contractAllocations) {
          out.contractAllocations = state.contractCoilAllocations
            .filter(a => (a.coilId ?? a.physicalCoilId) === c.id)
            .map(a => ({
              ...a,
              contract: state.materialContracts.find(mc => mc.id === a.contractId) || null,
            }));
        }
        return out;
      },
      findMany: async ({ where, include }: any = {}) =>
        state.physicalCoils
          .filter(c => matchesWhere(c, where))
          .map(c => {
            const out = { ...c };
            if (include?.material) out.material = c.materialId ? state.materials.find(m => m.id === c.materialId) || null : null;
            if (include?.warehouse) out.warehouse = state.warehouses.find(w => w.id === c.warehouseId) || null;
            if (include?.warehouseLocation) {
              out.warehouseLocation = c.warehouseLocationId
                ? state.warehouseLocations.find(l => l.id === c.warehouseLocationId) || null
                : null;
            }
            if (include?.contractAllocations) {
              out.contractAllocations = state.contractCoilAllocations
                .filter(a => (a.coilId ?? a.physicalCoilId) === c.id)
                .map(a => ({
                  ...a,
                  contract: state.materialContracts.find(mc => mc.id === a.contractId) || null,
                }));
            }
            return out;
          }),
      create: async ({ data }: any) => {
        if (state.physicalCoils.some(c => c.coilId === data.coilId)) {
          throw makePrismaP2002(['coilId']);
        }
        const row = {
          id: nextId('COIL'),
          version: 1,
          qualityStatus: 'AVAILABLE',
          physicalStatus: 'AVAILABLE',
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        state.physicalCoils.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const targets = state.physicalCoils.filter(c => matchesWhere(c, where));
        for (const r of targets) applyUpdateData(r, data);
        return { count: targets.length };
      },
    },
    contractCoilAllocation: {
      findMany: async ({ where }: any = {}) => state.contractCoilAllocations.filter(a => matchesWhere(a, where)),
      create: async ({ data }: any) => {
        const targetCoilKey = data.coilId ?? data.physicalCoilId;
        if (
          state.contractCoilAllocations.some(
            a => a.contractId === data.contractId && (a.coilId ?? a.physicalCoilId) === targetCoilKey
          )
        ) {
          throw makePrismaP2002(['contractId', 'coilId']);
        }
        const row = { id: nextId('ALLOC'), allocatedAt: new Date(), ...data };
        state.contractCoilAllocations.push(row);
        return row;
      },
      delete: async ({ where }: any) => {
        const idx = state.contractCoilAllocations.findIndex(a => matchesWhere(a, where));
        if (idx === -1) throw new Error('Allocation not found');
        return state.contractCoilAllocations.splice(idx, 1)[0];
      },
      deleteMany: async ({ where }: any = {}) => {
        const before = state.contractCoilAllocations.length;
        state.contractCoilAllocations = state.contractCoilAllocations.filter(a => {
          if (where?.coilId && (a.coilId ?? a.physicalCoilId) === where.coilId) return false;
          return !matchesWhere(a, where);
        });
        return { count: before - state.contractCoilAllocations.length };
      },
    },
    coilIssueReturnRecord: {
      findMany: async ({ where, orderBy }: any = {}) => {
        let rows = state.coilIssueReturnRecords.filter(r => matchesWhere(r, where));
        if (orderBy?.issuedAt === 'asc') {
          rows = [...rows].sort((a, b) => new Date(a.issuedAt).getTime() - new Date(b.issuedAt).getTime());
        }
        return rows;
      },
      count: async ({ where }: any = {}) =>
        state.coilIssueReturnRecords.filter(r => matchesWhere(r, where)).length,
      create: async ({ data }: any) => {
        const row = { id: nextId('CIR'), issuedAt: new Date(), ...data };
        state.coilIssueReturnRecords.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const targets = state.coilIssueReturnRecords.filter(r => matchesWhere(r, where));
        for (const r of targets) applyUpdateData(r, data);
        return { count: targets.length };
      },
    },
    materialContractTransaction: {
      create: async ({ data }: any) => {
        const row = { id: nextId('MCT'), createdAt: new Date(), ...data };
        state.materialContractTransactions.push(row);
        return row;
      },
    },
    inventoryDocument: {
      findUnique: async ({ where, include }: any) => {
        const doc = state.inventoryDocuments.find(d => matchesWhere(d, where));
        return hydrateDocument(doc, include);
      },
      findFirst: async ({ where, include }: any = {}) => {
        const doc = state.inventoryDocuments.find(d => matchesWhere(d, where));
        return hydrateDocument(doc, include);
      },
      findMany: async ({ where, include, orderBy }: any = {}) => {
        let docs = state.inventoryDocuments.filter(d => matchesWhere(d, where));
        if (orderBy?.documentDate === 'desc') {
          docs = [...docs].sort((a, b) => new Date(b.documentDate).getTime() - new Date(a.documentDate).getTime());
        }
        return docs.map(d => hydrateDocument(d, include));
      },
      create: async ({ data }: any) => {
        if (state.inventoryDocuments.some(d => d.documentNumber === data.documentNumber)) {
          throw makePrismaP2002(['documentNumber']);
        }
        if (data.idempotencyKey && state.inventoryDocuments.some(d => d.idempotencyKey === data.idempotencyKey)) {
          throw makePrismaP2002(['idempotencyKey']);
        }
        if (data.reversalOfId && state.inventoryDocuments.some(d => d.reversalOfId === data.reversalOfId)) {
          throw makePrismaP2002(['reversalOfId']);
        }
        const row = {
          id: nextId('DOC'),
          isReversed: false,
          reversalOfId: null,
          idempotencyKey: null,
          requestFingerprint: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        state.inventoryDocuments.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = state.inventoryDocuments.find(d => matchesWhere(d, where));
        if (!row) throw new Error('InventoryDocument not found');
        applyUpdateData(row, data);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const targets = state.inventoryDocuments.filter(d => matchesWhere(d, where));
        for (const r of targets) applyUpdateData(r, data);
        return { count: targets.length };
      },
      count: async ({ where }: any = {}) =>
        state.inventoryDocuments.filter(d => matchesWhere(d, where)).length,
    },
    inventoryDocumentLine: {
      create: async ({ data }: any) => {
        const row = { id: nextId('DOCLINE'), ...data };
        state.inventoryDocumentLines.push(row);
        return row;
      },
      deleteMany: async ({ where }: any) => {
        const before = state.inventoryDocumentLines.length;
        state.inventoryDocumentLines = state.inventoryDocumentLines.filter(l => !matchesWhere(l, where));
        return { count: before - state.inventoryDocumentLines.length };
      },
    },
    inventoryTransaction: {
      findMany: async ({ where, include, orderBy }: any = {}) => {
        let rows = state.inventoryTransactions.filter(t => matchesWhere(t, where));
        if (orderBy?.transactionDate === 'asc') {
          rows = rows
            .map((r, idx) => ({ r, idx }))
            .sort((a, b) => {
              const da = new Date(a.r.transactionDate || a.r.createdAt).getTime();
              const db = new Date(b.r.transactionDate || b.r.createdAt).getTime();
              if (da !== db) return da - db;
              return a.idx - b.idx;
            })
            .map(e => e.r);
        } else if (orderBy?.transactionDate === 'desc') {
          rows = rows
            .map((r, idx) => ({ r, idx }))
            .sort((a, b) => {
              const da = new Date(a.r.transactionDate || a.r.createdAt).getTime();
              const db = new Date(b.r.transactionDate || b.r.createdAt).getTime();
              if (da !== db) return db - da;
              return b.idx - a.idx;
            })
            .map(e => e.r);
        }
        return rows.map(t => {
          const out = { ...t };
          if (include?.document) {
            out.document = state.inventoryDocuments.find(d => d.id === t.documentId) || null;
          }
          if (include?.part) {
            const p = state.parts.find(x => x.id === t.partId) || null;
            out.part = p
              ? { ...p, unit: state.units.find(u => u.id === p.unitId) || null }
              : null;
          }
          if (include?.warehouse) {
            out.warehouse = state.warehouses.find(w => w.id === t.warehouseId) || null;
          }
          if (include?.location) {
            out.location = t.locationId
              ? state.warehouseLocations.find(l => l.id === t.locationId) || null
              : null;
          }
          if (include?.materialLot) {
            out.materialLot = t.materialLotId
              ? state.materialLots.find(l => l.id === t.materialLotId) || null
              : null;
          }
          if (include?.physicalCoil) {
            out.physicalCoil = t.physicalCoilId
              ? state.physicalCoils.find(c => c.id === t.physicalCoilId) || null
              : null;
          }
          return out;
        });
      },
      count: async ({ where }: any = {}) =>
        state.inventoryTransactions.filter(t => matchesWhere(t, where)).length,
      create: async ({ data }: any) => {
        if (state.inventoryTransactions.some(t => t.transactionNumber === data.transactionNumber)) {
          throw makePrismaP2002(['transactionNumber']);
        }
        const row = {
          id: nextId('TRX'),
          isReversal: false,
          reversalOfTrxId: null,
          ...data,
          createdAt: new Date(Date.now() + state.seq),
        };
        state.inventoryTransactions.push(row);
        return row;
      },
    },
    inventoryReservation: {
      findFirst: async ({ where, include }: any = {}) => {
        const row = state.inventoryReservations.find(r => matchesWhere(r, where)) || null;
        if (!row) return null;
        const out = { ...row };
        if (include?.part) {
          const p = state.parts.find(x => x.id === row.partId) || null;
          out.part = p ? { ...p, unit: state.units.find(u => u.id === p.unitId) || null } : null;
        }
        if (include?.warehouse) out.warehouse = state.warehouses.find(w => w.id === row.warehouseId) || null;
        if (include?.location) out.location = row.locationId ? state.warehouseLocations.find(l => l.id === row.locationId) || null : null;
        if (include?.materialLot) out.materialLot = row.materialLotId ? state.materialLots.find(l => l.id === row.materialLotId) || null : null;
        if (include?.physicalCoil) out.physicalCoil = row.physicalCoilId ? state.physicalCoils.find(c => c.id === row.physicalCoilId) || null : null;
        if (include?.unit) out.unit = state.units.find(u => u.id === row.unitId) || null;
        return out;
      },
      findMany: async ({ where, include }: any = {}) => {
        return state.inventoryReservations
          .filter(r => matchesWhere(r, where))
          .map(row => {
            const out = { ...row };
            if (include?.part) {
              const p = state.parts.find(x => x.id === row.partId) || null;
              out.part = p ? { ...p, unit: state.units.find(u => u.id === p.unitId) || null } : null;
            }
            if (include?.warehouse) out.warehouse = state.warehouses.find(w => w.id === row.warehouseId) || null;
            if (include?.location) out.location = row.locationId ? state.warehouseLocations.find(l => l.id === row.locationId) || null : null;
            if (include?.materialLot) out.materialLot = row.materialLotId ? state.materialLots.find(l => l.id === row.materialLotId) || null : null;
            if (include?.physicalCoil) out.physicalCoil = row.physicalCoilId ? state.physicalCoils.find(c => c.id === row.physicalCoilId) || null : null;
            if (include?.unit) out.unit = state.units.find(u => u.id === row.unitId) || null;
            return out;
          });
      },
      create: async ({ data, include }: any) => {
        if (state.inventoryReservations.some(r => r.reservationNumber === data.reservationNumber)) {
          throw makePrismaP2002(['reservationNumber']);
        }
        const row = {
          id: nextId('RES'),
          status: 'ACTIVE',
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        state.inventoryReservations.push(row);
        const out = { ...row };
        if (include?.part) {
          const p = state.parts.find(x => x.id === row.partId) || null;
          out.part = p ? { ...p, unit: state.units.find(u => u.id === p.unitId) || null } : null;
        }
        if (include?.warehouse) out.warehouse = state.warehouses.find(w => w.id === row.warehouseId) || null;
        if (include?.location) out.location = row.locationId ? state.warehouseLocations.find(l => l.id === row.locationId) || null : null;
        if (include?.materialLot) out.materialLot = row.materialLotId ? state.materialLots.find(l => l.id === row.materialLotId) || null : null;
        if (include?.physicalCoil) out.physicalCoil = row.physicalCoilId ? state.physicalCoils.find(c => c.id === row.physicalCoilId) || null : null;
        if (include?.unit) out.unit = state.units.find(u => u.id === row.unitId) || null;
        return out;
      },
      updateMany: async ({ where, data }: any) => {
        const targets = state.inventoryReservations.filter(r => matchesWhere(r, where));
        for (const r of targets) applyUpdateData(r, data);
        return { count: targets.length };
      },
    },
    stockBalance: {
      findFirst: async ({ where, include }: any = {}) => {
        const row = state.stockBalances.find(b => matchesWhere(b, where)) || null;
        if (!row) return null;
        const out = { ...row };
        if (include?.part) {
          const p = state.parts.find(x => x.id === row.partId) || null;
          out.part = p
            ? {
                ...p,
                unit: state.units.find(u => u.id === p.unitId) || null,
                material: p.materialId ? state.materials.find(m => m.id === p.materialId) || null : null,
              }
            : null;
        }
        if (include?.warehouse) out.warehouse = state.warehouses.find(w => w.id === row.warehouseId) || null;
        if (include?.location) out.location = row.locationId ? state.warehouseLocations.find(l => l.id === row.locationId) || null : null;
        if (include?.materialLot) out.materialLot = row.materialLotId ? state.materialLots.find(l => l.id === row.materialLotId) || null : null;
        if (include?.physicalCoil) {
          const c = row.physicalCoilId ? state.physicalCoils.find(x => x.id === row.physicalCoilId) || null : null;
          out.physicalCoil = c
            ? { ...c, material: c.materialId ? state.materials.find(m => m.id === c.materialId) || null : null }
            : null;
        }
        return out;
      },
      findMany: async ({ where, include }: any = {}) => {
        return state.stockBalances
          .filter(b => matchesWhere(b, where))
          .map(row => {
            const out = { ...row };
            if (include?.part) {
              const p = state.parts.find(x => x.id === row.partId) || null;
              out.part = p
                ? {
                    ...p,
                    unit: state.units.find(u => u.id === p.unitId) || null,
                    material: p.materialId ? state.materials.find(m => m.id === p.materialId) || null : null,
                  }
                : null;
            }
            if (include?.warehouse) out.warehouse = state.warehouses.find(w => w.id === row.warehouseId) || null;
            if (include?.location) out.location = row.locationId ? state.warehouseLocations.find(l => l.id === row.locationId) || null : null;
            if (include?.materialLot) out.materialLot = row.materialLotId ? state.materialLots.find(l => l.id === row.materialLotId) || null : null;
            if (include?.physicalCoil) {
              const c = row.physicalCoilId ? state.physicalCoils.find(x => x.id === row.physicalCoilId) || null : null;
              out.physicalCoil = c
                ? { ...c, material: c.materialId ? state.materials.find(m => m.id === c.materialId) || null : null }
                : null;
            }
            return out;
          });
      },
      create: async ({ data }: any) => {
        const candidate = {
          id: nextId('SB'),
          locationId: null,
          materialLotId: null,
          physicalCoilId: null,
          contractId: null,
          contractNumber: null,
          quantityReserved: 0,
          weightKgReserved: 0,
          version: 1,
          ...data,
        };
        const key = stockBalanceCompositeKey(candidate);
        if (state.stockBalances.some(b => stockBalanceCompositeKey(b) === key)) {
          throw makePrismaP2002([
            'partId',
            'warehouseId',
            'locationId',
            'materialLotId',
            'physicalCoilId',
            'ownership',
            'contractId',
            'qualityStatus',
          ]);
        }
        state.stockBalances.push(candidate);
        return candidate;
      },
      updateMany: async (args: any) => {
        hooks.onBeforeStockBalanceUpdateMany?.(args, state);
        const targets = state.stockBalances.filter(b => matchesWhere(b, args.where));
        for (const r of targets) applyUpdateData(r, args.data);
        return { count: targets.length };
      },
      deleteMany: async ({ where }: any = {}) => {
        const before = state.stockBalances.length;
        state.stockBalances = state.stockBalances.filter(b => !matchesWhere(b, where));
        return { count: before - state.stockBalances.length };
      },
    },
    auditLog: {
      findFirst: async ({ where }: any = {}) => {
        const matches = state.auditLogs.filter(a => matchesWhere(a, where));
        return matches.length > 0 ? matches[matches.length - 1] : null;
      },
      findMany: async ({ where }: any = {}) =>
        [...state.auditLogs].reverse().filter(a => matchesWhere(a, where)),
      create: async ({ data }: any) => {
        const row = { id: nextId('AUD'), timestamp: new Date(), createdAt: new Date(), ...data };
        state.auditLogs.push(row);
        return row;
      },
    },
  };
}

function createMockPrisma() {
  let state = createSeededState();
  const hooks: MockHooks = {};
  let txAttemptCounter = 0;

  const prisma: any = {
    getState: () => state,
    setHooks: (next: MockHooks) => {
      txAttemptCounter = 0;
      Object.assign(hooks, next);
    },
    clearHooks: () => {
      txAttemptCounter = 0;
      hooks.onBeforeStockBalanceUpdateMany = undefined;
      hooks.onBeforeMaterialContractUpdateMany = undefined;
      hooks.onBeforeMaterialLotUpdateMany = undefined;
      hooks.onTransactionAttempt = undefined;
    },
    part: {
      findFirst: async (args: any) => buildTxClient(state, hooks).part.findFirst(args),
      findUnique: async (args: any) => buildTxClient(state, hooks).part.findUnique(args),
    },
    warehouse: {
      findFirst: async (args: any) => buildTxClient(state, hooks).warehouse.findFirst(args),
    },
    warehouseLocation: {
      findFirst: async (args: any) => buildTxClient(state, hooks).warehouseLocation.findFirst(args),
    },
    materialLot: {
      findFirst: async (args: any) => buildTxClient(state, hooks).materialLot.findFirst(args),
      findUnique: async (args: any) => buildTxClient(state, hooks).materialLot.findUnique(args),
    },
    materialContract: {
      findFirst: async (args: any) => buildTxClient(state, hooks).materialContract.findFirst(args),
      findUnique: async (args: any) => buildTxClient(state, hooks).materialContract.findUnique(args),
      findMany: async (args: any) => buildTxClient(state, hooks).materialContract.findMany(args),
    },
    inventoryDocument: {
      findUnique: async (args: any) => buildTxClient(state, hooks).inventoryDocument.findUnique(args),
      findFirst: async (args: any) => buildTxClient(state, hooks).inventoryDocument.findFirst(args),
      findMany: async (args: any) => buildTxClient(state, hooks).inventoryDocument.findMany(args),
      count: async (args: any) => buildTxClient(state, hooks).inventoryDocument.count(args),
    },
    inventoryTransaction: {
      findMany: async (args: any) => buildTxClient(state, hooks).inventoryTransaction.findMany(args),
      count: async (args: any) => buildTxClient(state, hooks).inventoryTransaction.count(args),
    },
    inventoryReservation: {
      findFirst: async (args: any) => buildTxClient(state, hooks).inventoryReservation.findFirst(args),
      findMany: async (args: any) => buildTxClient(state, hooks).inventoryReservation.findMany(args),
      create: async (args: any) => buildTxClient(state, hooks).inventoryReservation.create(args),
      updateMany: async (args: any) => buildTxClient(state, hooks).inventoryReservation.updateMany(args),
    },
    stockBalance: {
      findFirst: async (args: any) => buildTxClient(state, hooks).stockBalance.findFirst(args),
      findMany: async (args: any) => buildTxClient(state, hooks).stockBalance.findMany(args),
      create: async (args: any) => buildTxClient(state, hooks).stockBalance.create(args),
      deleteMany: async (args: any) => buildTxClient(state, hooks).stockBalance.deleteMany(args),
    },
    physicalCoil: {
      findFirst: async (args: any) => buildTxClient(state, hooks).physicalCoil.findFirst(args),
      findUnique: async (args: any) => buildTxClient(state, hooks).physicalCoil.findUnique(args),
      findMany: async (args: any) => buildTxClient(state, hooks).physicalCoil.findMany(args),
    },
    coilIssueReturnRecord: {
      findMany: async (args: any) => buildTxClient(state, hooks).coilIssueReturnRecord.findMany(args),
      count: async (args: any) => buildTxClient(state, hooks).coilIssueReturnRecord.count(args),
      create: async (args: any) => buildTxClient(state, hooks).coilIssueReturnRecord.create(args),
      updateMany: async (args: any) => buildTxClient(state, hooks).coilIssueReturnRecord.updateMany(args),
    },
    auditLog: {
      findFirst: async (args: any) => buildTxClient(state, hooks).auditLog.findFirst(args),
      findMany: async (args: any) => buildTxClient(state, hooks).auditLog.findMany(args),
    },
    $transaction: async <T>(fn: (tx: any) => Promise<T>, _opts?: any): Promise<T> => {
      txAttemptCounter += 1;
      const workingState = deepClone(state);
      const tx = buildTxClient(workingState, hooks);
      hooks.onTransactionAttempt?.(txAttemptCounter);
      const result = await fn(tx);
      // Commit only if fn resolves without throwing
      state = workingState;
      return result;
    },
  };

  return prisma;
}

function makeDoc(overrides: Partial<InventoryDocument>): InventoryDocument {
  const now = new Date('2026-11-24T10:00:00.000Z').toISOString();
  return {
    id: `UI-DOC-${Math.random().toString(36).slice(2, 8)}`,
    documentNumber: `DOC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    documentType: 'RECEIPT_RAW_MATERIAL',
    documentDate: now,
    documentStatus: 'DRAFT',
    postingStatus: 'UNPOSTED',
    warehouseId: 'WH-RAW',
    warehouseName: 'انبار ورق و مواد اولیه',
    ownership: 'SAPCO_SUPPLIER_OWNED',
    lines: [],
    totalQuantity: 0,
    totalWeightKg: 0,
    createdByUid: TEST_USER.uid,
    createdByName: TEST_USER.displayName,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function run() {
  console.log('=== KPIMS Inventory P0-A Hardening Regression Suite (Isolated) ===');
  const prisma = createMockPrisma();

  // -----------------------------------------------------------------------
  // TEST 1: Single Coherent Sheet-Metal Receipt + Duplicate Coil Prevention
  // -----------------------------------------------------------------------
  {
    const receiptDoc = makeDoc({
      documentNumber: 'REC-COIL-001',
      documentType: 'RECEIPT_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      referenceNumber: 'WB-1405-991',
      totalQuantity: 3000,
      totalWeightKg: 3000,
      lines: [
        {
          id: 'L1',
          documentId: 'REC-COIL-001',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          coilId: 'COIL-DC04-001',
          coilPackNumber: 'CP-1405-001',
          lotNumber: 'CP-1405-001',
          heatNumber: 'HT-8801',
          materialGrade: 'DC04',
          thicknessMm: 0.8,
          widthMm: 1250,
          ownership: 'SAPCO_SUPPLIER_OWNED',
          locationCode: 'LOC-RAW-A1',
          quantity: 3000,
          unit: 'KG',
          quantityKg: 3000,
          qualityStatus: 'AVAILABLE',
          contractAllocations: [
            { contractId: 'CNT-A', contractNumber: 'SAPCO-1405-A', allocatedWeightKg: 1800 },
            { contractId: 'CNT-B', contractNumber: 'SAPCO-1405-B', allocatedWeightKg: 1200 },
          ],
        },
      ],
    });

    const res = await postInventoryDocumentInTransaction(receiptDoc, TEST_USER, { prismaClient: prisma });
    assert.equal(res.success, true, `Expected receipt success, got: ${res.error}`);
    assert.equal(res.createdCoilIds?.length, 1);

    const st = prisma.getState();
    assert.equal(st.inventoryDocuments.filter((d: any) => d.documentNumber === 'REC-COIL-001').length, 1);
    assert.equal(st.physicalCoils.length, 1, 'Exactly one PhysicalCoil must be created');
    const coil = st.physicalCoils[0];
    assert.equal(coil.coilId, 'COIL-DC04-001');
    assert.equal(Number(coil.originalWeightKg), 3000);
    assert.equal(Number(coil.remainingWeightKg), 3000);
    assert.equal(coil.version, 1);

    const lot = st.materialLots.find((l: any) => l.lotNumber === 'CP-1405-001');
    assert.ok(lot, 'MaterialLot must be created in same transaction');
    assert.equal(Number(lot.remainingWeightKg), 3000);

    assert.equal(st.contractCoilAllocations.length, 2, 'Both contract allocations persisted');
    assert.equal(st.materialContractTransactions.length, 2, 'Both contract receipt transactions persisted');
    assert.equal(Number(st.materialContracts.find((c: any) => c.id === 'CNT-A').receivedWeightKg), 1800);
    assert.equal(Number(st.materialContracts.find((c: any) => c.id === 'CNT-B').receivedWeightKg), 1200);

    const coilBalances = st.stockBalances.filter((b: any) => b.physicalCoilId === coil.id);
    assert.equal(coilBalances.length, 2, 'Two segmented StockBalance rows linked via physicalCoilId');
    assert.equal(
      coilBalances.reduce((s: number, b: any) => s + Number(b.weightKgOnHand), 0),
      3000
    );
    assert.ok(
      st.inventoryTransactions.every((t: any) => t.documentId === res.dbDocumentId && t.physicalCoilId === coil.id),
      'All receipt transactions carry physicalCoilId'
    );

    // Duplicate coil receipt with new document number MUST be rejected (prevents double-posting)
    const dupCoilDoc = makeDoc({
      documentNumber: 'REC-COIL-DUP',
      documentType: 'RECEIPT_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      totalQuantity: 3000,
      totalWeightKg: 3000,
      lines: [
        {
          id: 'L1',
          documentId: 'REC-COIL-DUP',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          coilId: 'COIL-DC04-001',
          coilPackNumber: 'CP-1405-001',
          lotNumber: 'CP-1405-001',
          ownership: 'SAPCO_SUPPLIER_OWNED',
          locationCode: 'LOC-RAW-A1',
          quantity: 3000,
          unit: 'KG',
          quantityKg: 3000,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const dupRes = await postInventoryDocumentInTransaction(dupCoilDoc, TEST_USER, { prismaClient: prisma });
    assert.equal(dupRes.success, false, 'Duplicate coil receipt must fail');
    assert.equal(dupRes.statusCode, 409);
    assert.equal(prisma.getState().physicalCoils.length, 1, 'No duplicate coil created on rollback');
    console.log('  [PASS] 1. Single coherent sheet-metal receipt & duplicate coil/receipt prevention');
  }

  // -----------------------------------------------------------------------
  // TEST 2: Physical-Coil Linkage Across Issue, Transfer & Adjustment
  // -----------------------------------------------------------------------
  {
    const coilId = prisma.getState().physicalCoils[0].id;
    const issueDoc = makeDoc({
      documentNumber: 'ISS-COIL-001',
      documentType: 'ISSUE_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      contractId: 'CNT-A',
      contractNumber: 'SAPCO-1405-A',
      totalQuantity: 1000,
      totalWeightKg: 1000,
      lines: [
        {
          id: 'L1',
          documentId: 'ISS-COIL-001',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          physicalCoilId: coilId,
          lotNumber: 'CP-1405-001',
          ownership: 'SAPCO_SUPPLIER_OWNED',
          contractId: 'CNT-A',
          contractNumber: 'SAPCO-1405-A',
          locationCode: 'LOC-RAW-A1',
          quantity: 1000,
          unit: 'KG',
          quantityKg: 1000,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });

    const issueRes = await postInventoryDocumentInTransaction(issueDoc, TEST_USER, { prismaClient: prisma });
    assert.equal(issueRes.success, true, `Expected issue success, got: ${issueRes.error}`);

    const st = prisma.getState();
    const coil = st.physicalCoils.find((c: any) => c.id === coilId);
    assert.equal(Number(coil.remainingWeightKg), 2000);
    assert.equal(coil.physicalStatus, 'PARTIALLY_ISSUED');
    assert.equal(coil.version, 2, 'PhysicalCoil optimistic version incremented');

    const lot = st.materialLots.find((l: any) => l.lotNumber === 'CP-1405-001');
    assert.equal(Number(lot.remainingWeightKg), 2000);

    const balA = st.stockBalances.find((b: any) => b.physicalCoilId === coilId && b.contractId === 'CNT-A');
    assert.equal(Number(balA.weightKgOnHand), 800);
    assert.equal(balA.version, 2, 'StockBalance optimistic version incremented');

    const issueTrx = st.inventoryTransactions.find((t: any) => t.documentId === issueRes.dbDocumentId);
    assert.equal(issueTrx.physicalCoilId, coilId, 'Issue transaction linked to physicalCoilId');

    // Dedicated single-segment coil for transfer test (partial coil transfer blocked, full transfer moves coil)
    const trfReceipt = makeDoc({
      documentNumber: 'REC-COIL-TRF',
      documentType: 'RECEIPT_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'COMPANY_OWNED',
      totalQuantity: 1500,
      totalWeightKg: 1500,
      lines: [
        {
          id: 'L1',
          documentId: 'REC-COIL-TRF',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          coilId: 'COIL-TRF-01',
          coilPackNumber: 'CP-TRF-01',
          lotNumber: 'CP-TRF-01',
          materialGrade: 'DC04',
          thicknessMm: 0.8,
          widthMm: 1250,
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-RAW-A1',
          quantity: 1500,
          unit: 'KG',
          quantityKg: 1500,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const trfRecRes = await postInventoryDocumentInTransaction(trfReceipt, TEST_USER, { prismaClient: prisma });
    assert.equal(trfRecRes.success, true);
    const trfCoilId = trfRecRes.createdCoilIds![0];

    // Partial coil transfer (500 of 1500 kg) must be blocked to prevent split physical-coil location
    const partialTrf = makeDoc({
      documentNumber: 'TRF-PARTIAL-BLOCK',
      documentType: 'TRANSFER',
      warehouseId: 'WH-RAW',
      targetWarehouseId: 'WH-WIP',
      ownership: 'COMPANY_OWNED',
      totalQuantity: 500,
      totalWeightKg: 500,
      lines: [
        {
          id: 'L1',
          documentId: 'TRF-PARTIAL-BLOCK',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          physicalCoilId: trfCoilId,
          lotNumber: 'CP-TRF-01',
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-RAW-A1',
          targetLocationCode: 'LOC-WIP-01',
          quantity: 500,
          unit: 'KG',
          quantityKg: 500,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const partialTrfRes = await postInventoryDocumentInTransaction(partialTrf, TEST_USER, { prismaClient: prisma });
    assert.equal(partialTrfRes.success, false, 'Partial transfer of physical coil must be rejected');

    // Full coil transfer (1500 kg) succeeds and moves coil warehouse/location without changing weight
    const fullTrf = makeDoc({
      documentNumber: 'TRF-FULL-001',
      documentType: 'TRANSFER',
      warehouseId: 'WH-RAW',
      targetWarehouseId: 'WH-WIP',
      ownership: 'COMPANY_OWNED',
      totalQuantity: 1500,
      totalWeightKg: 1500,
      lines: [
        {
          id: 'L1',
          documentId: 'TRF-FULL-001',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          physicalCoilId: trfCoilId,
          lotNumber: 'CP-TRF-01',
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-RAW-A1',
          targetLocationCode: 'LOC-WIP-01',
          quantity: 1500,
          unit: 'KG',
          quantityKg: 1500,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const fullTrfRes = await postInventoryDocumentInTransaction(fullTrf, TEST_USER, { prismaClient: prisma });
    assert.equal(fullTrfRes.success, true, `Expected full coil transfer success, got: ${fullTrfRes.error}`);
    const movedCoil = prisma.getState().physicalCoils.find((c: any) => c.id === trfCoilId);
    assert.equal(movedCoil.warehouseId, 'WH-ID-WIP');
    assert.equal(movedCoil.warehouseLocationId, 'LOC-ID-WIP-01');
    assert.equal(Number(movedCoil.remainingWeightKg), 1500);

    // Non-steel lot (materialId = null) negative adjustment works without steel-grade hack
    const boltAdj = makeDoc({
      documentNumber: 'ADJ-BOLT-001',
      documentType: 'ADJUSTMENT',
      warehouseId: 'WH-RAW',
      ownership: 'COMPANY_OWNED',
      totalQuantity: -25,
      totalWeightKg: -25,
      lines: [
        {
          id: 'L1',
          documentId: 'ADJ-BOLT-001',
          lineNumber: 1,
          partId: 'PART-BOLT-01',
          partCode: 'RM-BOLT-M8',
          partName: 'پیچ M8 گالوانیزه',
          materialLotId: 'LOT-BOLT-01',
          lotNumber: 'LOT-M8-001',
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-RAW-A1',
          quantity: -25,
          unit: 'PCS',
          quantityKg: -25,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const boltAdjRes = await postInventoryDocumentInTransaction(boltAdj, TEST_USER, { prismaClient: prisma });
    assert.equal(boltAdjRes.success, true, `Non-steel lot adjustment failed: ${boltAdjRes.error}`);
    assert.equal(Number(prisma.getState().materialLots.find((l: any) => l.id === 'LOT-BOLT-01').remainingWeightKg), 475);
    console.log('  [PASS] 2. Physical-coil linkage across issue, transfer & non-steel lot adjustment');
  }

  // -----------------------------------------------------------------------
  // TEST 3: Paired QM Status Transfers (322, 321, 344) + Coil/Lot Sync
  // -----------------------------------------------------------------------
  {
    const trfCoil = prisma.getState().physicalCoils.find((c: any) => c.coilId === 'COIL-TRF-01');
    const qm322 = makeDoc({
      documentNumber: 'QM-322-001',
      documentType: 'STOCK_STATUS_TRANSFER',
      movementType: '322',
      qmStatusTarget: 'QUALITY_INSPECTION',
      warehouseId: 'WH-WIP',
      ownership: 'COMPANY_OWNED',
      totalQuantity: 1500,
      totalWeightKg: 1500,
      lines: [
        {
          id: 'L1',
          documentId: 'QM-322-001',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          physicalCoilId: trfCoil.id,
          lotNumber: 'CP-TRF-01',
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-WIP-01',
          quantity: 1500,
          unit: 'KG',
          quantityKg: 1500,
          qualityStatus: 'AVAILABLE',
          sourceQualityStatus: 'AVAILABLE',
          targetQualityStatus: 'QUARANTINE',
        },
      ],
    });
    const res322 = await postInventoryDocumentInTransaction(qm322, TEST_USER, { prismaClient: prisma });
    assert.equal(res322.success, true, `QM 322 failed: ${res322.error}`);

    const trxs322 = prisma.getState().inventoryTransactions.filter((t: any) => t.documentId === res322.dbDocumentId);
    assert.equal(trxs322.length, 2, 'QM 322 must emit paired OUT/IN transactions');
    assert.deepEqual(
      trxs322.map((t: any) => [t.transactionType, t.qualityStatus, Number(t.weightKgSigned)]),
      [
        ['ADJUSTMENT_NEG', 'AVAILABLE', -1500],
        ['ADJUSTMENT_POS', 'QUARANTINE', 1500],
      ]
    );
    assert.equal(
      trxs322.reduce((s: number, t: any) => s + Number(t.weightKgSigned), 0),
      0,
      'QM transfer preserves net physical stock'
    );

    const qBal = prisma.getState().stockBalances.find(
      (b: any) => b.physicalCoilId === trfCoil.id && b.qualityStatus === 'QUARANTINE'
    );
    assert.equal(Number(qBal.weightKgOnHand), 1500);
    assert.equal(Number(qBal.quantityAvailable), 0, 'Quarantined stock must have 0 available qty');
    assert.equal(prisma.getState().physicalCoils.find((c: any) => c.id === trfCoil.id).qualityStatus, 'QUARANTINE');
    assert.equal(prisma.getState().materialLots.find((l: any) => l.lotNumber === 'CP-TRF-01').status, 'QUARANTINE');

    // Outbound from QUARANTINE must be blocked
    const badIssueFromQ = makeDoc({
      documentNumber: 'ISS-QUARANTINE-BLOCK',
      documentType: 'ISSUE_RAW_MATERIAL',
      warehouseId: 'WH-WIP',
      ownership: 'COMPANY_OWNED',
      totalQuantity: 100,
      totalWeightKg: 100,
      lines: [
        {
          id: 'L1',
          documentId: 'ISS-QUARANTINE-BLOCK',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          physicalCoilId: trfCoil.id,
          lotNumber: 'CP-TRF-01',
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-WIP-01',
          quantity: 100,
          unit: 'KG',
          quantityKg: 100,
          qualityStatus: 'QUARANTINE',
        },
      ],
    });
    const blockedQRes = await postInventoryDocumentInTransaction(badIssueFromQ, TEST_USER, { prismaClient: prisma });
    assert.equal(blockedQRes.success, false, 'Outbound from QUARANTINE must be blocked');

    // 321: Release QUARANTINE -> AVAILABLE
    const qm321 = makeDoc({
      documentNumber: 'QM-321-001',
      documentType: 'STOCK_STATUS_TRANSFER',
      movementType: '321',
      qmStatusTarget: 'UNRESTRICTED',
      warehouseId: 'WH-WIP',
      ownership: 'COMPANY_OWNED',
      totalQuantity: 1500,
      totalWeightKg: 1500,
      lines: [
        {
          id: 'L1',
          documentId: 'QM-321-001',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          physicalCoilId: trfCoil.id,
          lotNumber: 'CP-TRF-01',
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-WIP-01',
          quantity: 1500,
          unit: 'KG',
          quantityKg: 1500,
          qualityStatus: 'QUARANTINE',
          sourceQualityStatus: 'QUARANTINE',
          targetQualityStatus: 'AVAILABLE',
        },
      ],
    });
    const res321 = await postInventoryDocumentInTransaction(qm321, TEST_USER, { prismaClient: prisma });
    assert.equal(res321.success, true, `QM 321 failed: ${res321.error}`);
    assert.equal(prisma.getState().physicalCoils.find((c: any) => c.id === trfCoil.id).qualityStatus, 'AVAILABLE');
    assert.equal(prisma.getState().materialLots.find((l: any) => l.lotNumber === 'CP-TRF-01').status, 'AVAILABLE');

    // 344: Block AVAILABLE -> QUALITY_BLOCKED
    const qm344 = makeDoc({
      documentNumber: 'QM-344-001',
      documentType: 'STOCK_STATUS_TRANSFER',
      movementType: '344',
      qmStatusTarget: 'BLOCKED',
      warehouseId: 'WH-WIP',
      ownership: 'COMPANY_OWNED',
      totalQuantity: 1500,
      totalWeightKg: 1500,
      lines: [
        {
          id: 'L1',
          documentId: 'QM-344-001',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          physicalCoilId: trfCoil.id,
          lotNumber: 'CP-TRF-01',
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-WIP-01',
          quantity: 1500,
          unit: 'KG',
          quantityKg: 1500,
          qualityStatus: 'AVAILABLE',
          sourceQualityStatus: 'AVAILABLE',
          targetQualityStatus: 'QUALITY_BLOCKED',
        },
      ],
    });
    const res344 = await postInventoryDocumentInTransaction(qm344, TEST_USER, { prismaClient: prisma });
    assert.equal(res344.success, true, `QM 344 failed: ${res344.error}`);
    assert.equal(
      prisma.getState().physicalCoils.find((c: any) => c.id === trfCoil.id).qualityStatus,
      'QUALITY_BLOCKED'
    );
    assert.equal(prisma.getState().materialLots.find((l: any) => l.lotNumber === 'CP-TRF-01').status, 'REJECTED');
    console.log('  [PASS] 3. Paired QM status transfers (322, 321, 344) & coil/lot quality sync');
  }

  // -----------------------------------------------------------------------
  // TEST 4: True Reversal Semantics + Downstream Consumption Protection
  // -----------------------------------------------------------------------
  {
    const stBefore = prisma.getState();
    const recCoil001Doc = stBefore.inventoryDocuments.find((d: any) => d.documentNumber === 'REC-COIL-001');
    const issCoil001Doc = stBefore.inventoryDocuments.find((d: any) => d.documentNumber === 'ISS-COIL-001');
    const qm344Doc = stBefore.inventoryDocuments.find((d: any) => d.documentNumber === 'QM-344-001');

    // 4a. Attempt to reverse REC-COIL-001 while 1,000 kg has been issued downstream -> MUST BLOCK
    const blockedRevRec = makeDoc({
      documentNumber: 'REV-REC-COIL-001-BLOCKED',
      documentType: 'REVERSAL',
      reversalOfDocumentId: recCoil001Doc.id,
      warehouseId: 'WH-RAW',
      adjustmentReason: 'تلاش ابطال رسید پس از مصرف',
    });
    const blockedRevRes = await postInventoryDocumentInTransaction(blockedRevRec, TEST_USER, { prismaClient: prisma });
    assert.equal(blockedRevRes.success, false, 'Reversing receipt after downstream issue must be blocked');
    assert.equal(blockedRevRes.statusCode, 409);
    assert.equal(
      prisma.getState().inventoryDocuments.find((d: any) => d.id === recCoil001Doc.id).postingStatus,
      'POSTED',
      'Original receipt must remain POSTED after blocked reversal rollback'
    );

    // 4b. Reverse ISS-COIL-001 -> succeeds, originals stay POSTED, coil/lot/balance restored
    const revIssDoc = makeDoc({
      documentNumber: 'REV-ISS-COIL-001',
      documentType: 'REVERSAL',
      reversalOfDocumentId: issCoil001Doc.id,
      warehouseId: 'WH-RAW',
      adjustmentReason: 'ابطال حواله اشتباه',
    });
    const revIssRes = await postInventoryDocumentInTransaction(revIssDoc, TEST_USER, { prismaClient: prisma });
    assert.equal(revIssRes.success, true, `Expected issue reversal success, got: ${revIssRes.error}`);

    const stAfterIssRev = prisma.getState();
    const origIssAfter = stAfterIssRev.inventoryDocuments.find((d: any) => d.id === issCoil001Doc.id);
    assert.equal(origIssAfter.postingStatus, 'REVERSED');
    assert.equal(origIssAfter.isReversed, true);

    const origIssTrxs = stAfterIssRev.inventoryTransactions.filter((t: any) => t.documentId === issCoil001Doc.id);
    assert.ok(origIssTrxs.every((t: any) => t.postingStatus === 'POSTED' && t.isReversal === false));

    const revIssTrxs = stAfterIssRev.inventoryTransactions.filter((t: any) => t.documentId === revIssRes.dbDocumentId);
    assert.equal(revIssTrxs.length, origIssTrxs.length);
    assert.equal(revIssTrxs[0].isReversal, true);
    assert.equal(revIssTrxs[0].reversalOfTrxId, origIssTrxs[0].id);
    assert.equal(Number(revIssTrxs[0].weightKgSigned), 1000);

    const restoredCoil = stAfterIssRev.physicalCoils.find((c: any) => c.coilId === 'COIL-DC04-001');
    assert.equal(Number(restoredCoil.remainingWeightKg), 3000, 'PhysicalCoil weight restored identically');
    assert.equal(restoredCoil.physicalStatus, 'AVAILABLE');
    assert.equal(
      Number(stAfterIssRev.materialLots.find((l: any) => l.lotNumber === 'CP-1405-001').remainingWeightKg),
      3000
    );

    // 4c. Double-reversal of ISS-COIL-001 -> blocked with 409
    const doubleRev = makeDoc({
      documentNumber: 'REV-ISS-COIL-001-SECOND',
      documentType: 'REVERSAL',
      reversalOfDocumentId: issCoil001Doc.id,
      warehouseId: 'WH-RAW',
      adjustmentReason: 'تکرار ابطال',
    });
    const doubleRevRes = await postInventoryDocumentInTransaction(doubleRev, TEST_USER, { prismaClient: prisma });
    assert.equal(doubleRevRes.success, false);
    assert.equal(doubleRevRes.statusCode, 409);

    // 4d. Reversing a reversal document -> blocked with 400
    const revOfRev = makeDoc({
      documentNumber: 'REV-OF-REV-001',
      documentType: 'REVERSAL',
      reversalOfDocumentId: revIssRes.dbDocumentId,
      warehouseId: 'WH-RAW',
      adjustmentReason: 'ابطال سند ابطال',
    });
    const revOfRevRes = await postInventoryDocumentInTransaction(revOfRev, TEST_USER, { prismaClient: prisma });
    assert.equal(revOfRevRes.success, false);
    assert.equal(revOfRevRes.statusCode, 400);

    // 4e. Now reverse REC-COIL-001 (no remaining downstream consumption) -> succeeds and reverses contract allocations/receipts!
    const revRecDoc = makeDoc({
      documentNumber: 'REV-REC-COIL-001',
      documentType: 'REVERSAL',
      reversalOfDocumentId: recCoil001Doc.id,
      warehouseId: 'WH-RAW',
      adjustmentReason: 'ابطال کامل رسید اشتباه',
    });
    const revRecRes = await postInventoryDocumentInTransaction(revRecDoc, TEST_USER, { prismaClient: prisma });
    assert.equal(revRecRes.success, true, `Expected receipt reversal success after issue reversal, got: ${revRecRes.error}`);
    assert.equal(Number(prisma.getState().materialContracts.find((c: any) => c.id === 'CNT-A').receivedWeightKg), 0);
    assert.equal(Number(prisma.getState().materialContracts.find((c: any) => c.id === 'CNT-B').receivedWeightKg), 0);
    assert.equal(
      prisma.getState().contractCoilAllocations.filter((a: any) => a.physicalCoilId === restoredCoil.id).length,
      0
    );
    assert.equal(
      Number(prisma.getState().physicalCoils.find((c: any) => c.id === restoredCoil.id).remainingWeightKg),
      0
    );

    // 4f. Reverse QM 344 -> restores coil qualityStatus back to AVAILABLE
    const revQm344 = makeDoc({
      documentNumber: 'REV-QM-344-001',
      documentType: 'REVERSAL',
      reversalOfDocumentId: qm344Doc.id,
      warehouseId: 'WH-WIP',
      adjustmentReason: 'ابطال مسدودسازی کنترل کیفیت',
    });
    const revQmRes = await postInventoryDocumentInTransaction(revQm344, TEST_USER, { prismaClient: prisma });
    assert.equal(revQmRes.success, true, `Expected QM reversal success, got: ${revQmRes.error}`);
    assert.equal(
      prisma.getState().physicalCoils.find((c: any) => c.coilId === 'COIL-TRF-01').qualityStatus,
      'AVAILABLE'
    );
    console.log('  [PASS] 4. True reversal semantics (immutable originals, contract restore & downstream-consumption block)');
  }

  // -----------------------------------------------------------------------
  // TEST 5: Overdraft Prevention, Zero Clamping, Master-Data Guards & NULLS NOT DISTINCT
  // -----------------------------------------------------------------------
  {
    const whCountBefore = prisma.getState().warehouses.length;
    const unknownWhDoc = makeDoc({
      documentNumber: 'REC-BAD-WH',
      documentType: 'RECEIPT_RAW_MATERIAL',
      warehouseId: 'WH-UNKNOWN-GHOST',
      ownership: 'COMPANY_OWNED',
      totalQuantity: 10,
      totalWeightKg: 10,
      lines: [
        {
          id: 'L1',
          documentId: 'REC-BAD-WH',
          lineNumber: 1,
          partId: 'PART-BOLT-01',
          partCode: 'RM-BOLT-M8',
          partName: 'پیچ M8 گالوانیزه',
          ownership: 'COMPANY_OWNED',
          quantity: 10,
          unit: 'PCS',
          quantityKg: 10,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const badWhRes = await postInventoryDocumentInTransaction(unknownWhDoc, TEST_USER, { prismaClient: prisma });
    assert.equal(badWhRes.success, false, 'Unknown warehouse must be rejected');
    assert.equal(prisma.getState().warehouses.length, whCountBefore, 'Unknown warehouse must NOT be auto-created');

    // Unknown location must be rejected
    const unknownLocDoc = makeDoc({
      documentNumber: 'REC-BAD-LOC',
      documentType: 'RECEIPT_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'COMPANY_OWNED',
      totalQuantity: 10,
      totalWeightKg: 10,
      lines: [
        {
          id: 'L1',
          documentId: 'REC-BAD-LOC',
          lineNumber: 1,
          partId: 'PART-BOLT-01',
          partCode: 'RM-BOLT-M8',
          partName: 'پیچ M8 گالوانیزه',
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-NONEXISTENT',
          quantity: 10,
          unit: 'PCS',
          quantityKg: 10,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const badLocRes = await postInventoryDocumentInTransaction(unknownLocDoc, TEST_USER, { prismaClient: prisma });
    assert.equal(badLocRes.success, false, 'Unknown location must be rejected');

    // Overdraft past reserved qty: SB-BOLT-01 currently has 475 onHand, 100 reserved -> 375 available. Requesting 400 MUST fail.
    const overdraftDoc = makeDoc({
      documentNumber: 'ISS-OVERDRAFT-001',
      documentType: 'ISSUE_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'COMPANY_OWNED',
      totalQuantity: 400,
      totalWeightKg: 400,
      lines: [
        {
          id: 'L1',
          documentId: 'ISS-OVERDRAFT-001',
          lineNumber: 1,
          partId: 'PART-BOLT-01',
          partCode: 'RM-BOLT-M8',
          partName: 'پیچ M8 گالوانیزه',
          materialLotId: 'LOT-BOLT-01',
          lotNumber: 'LOT-M8-001',
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-RAW-A1',
          quantity: 400,
          unit: 'PCS',
          quantityKg: 400,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const overdraftRes = await postInventoryDocumentInTransaction(overdraftDoc, TEST_USER, { prismaClient: prisma });
    assert.equal(overdraftRes.success, false, 'Overdraft past reserved stock must be blocked');
    assert.equal(overdraftRes.statusCode, 409);
    assert.equal(
      Number(prisma.getState().stockBalances.find((b: any) => b.id === 'SB-BOLT-01').quantityOnHand),
      475,
      'StockBalance unchanged on rejected overdraft'
    );

    // NULLS NOT DISTINCT uniqueness enforcement check on stock_balances
    let p2002Thrown = false;
    try {
      await prisma.stockBalance.create({
        data: {
          partId: 'PART-BOLT-01',
          warehouseId: 'WH-ID-RAW',
          locationId: null,
          materialLotId: null,
          physicalCoilId: null,
          quantityOnHand: 50,
          quantityAvailable: 50,
          weightKgOnHand: 50,
          weightKgAvailable: 50,
          ownership: 'COMPANY_OWNED',
          contractId: null,
          qualityStatus: 'AVAILABLE',
        },
      });
    } catch (e: any) {
      p2002Thrown = e?.code === 'P2002';
    }
    assert.equal(p2002Thrown, true, 'Duplicate stock_balances row with NULL nullable keys must violate unique index');
    console.log('  [PASS] 5. Overdraft protection, strict master-data rejection & NULLS NOT DISTINCT uniqueness');
  }

  // -----------------------------------------------------------------------
  // TEST 6: Concurrent Deduction CAS Version / Conditional Guard Simulation
  // -----------------------------------------------------------------------
  {
    // SB-NULL-KEYS-01 has 100 PCS/kg available, version 1.
    // Simulate a competing transaction committing an 80-unit deduction right before our CAS updateMany.
    let injected = false;
    prisma.setHooks({
      onBeforeStockBalanceUpdateMany: (args: any, workingState: MockDbState) => {
        if (!injected && args.where?.id === 'SB-NULL-KEYS-01') {
          injected = true;
          const target = workingState.stockBalances.find((b: any) => b.id === 'SB-NULL-KEYS-01');
          if (target) {
            target.quantityOnHand = 20;
            target.quantityAvailable = 20;
            target.weightKgOnHand = 20;
            target.weightKgAvailable = 20;
            target.version += 1; // Competing writer bumped version from 1 -> 2
          }
        }
      },
    });

    const staleIssue = makeDoc({
      documentNumber: 'ISS-RACE-STALE',
      documentType: 'ISSUE_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'COMPANY_OWNED',
      totalQuantity: 80,
      totalWeightKg: 80,
      lines: [
        {
          id: 'L1',
          documentId: 'ISS-RACE-STALE',
          lineNumber: 1,
          partId: 'PART-BOLT-01',
          partCode: 'RM-BOLT-M8',
          partName: 'پیچ M8 گالوانیزه',
          ownership: 'COMPANY_OWNED',
          quantity: 80,
          unit: 'PCS',
          quantityKg: 80,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const raceRes = await postInventoryDocumentInTransaction(staleIssue, TEST_USER, { prismaClient: prisma });
    prisma.clearHooks();

    assert.equal(raceRes.success, false, 'Stale concurrent deduction must fail CAS version/gte check');
    assert.equal(raceRes.statusCode, 409);
    assert.equal(
      prisma.getState().inventoryDocuments.some((d: any) => d.documentNumber === 'ISS-RACE-STALE'),
      false,
      'Failed concurrent transaction rolled back with zero orphaned document'
    );
    assert.equal(
      prisma.getState().inventoryTransactions.some((t: any) => t.transactionNumber.startsWith('ISS-RACE-STALE')),
      false,
      'Failed concurrent transaction rolled back with zero orphaned ledger transactions'
    );
    console.log(
      '  [PASS] 6. Concurrent deduction CAS version/gte conflict rejection (mocked; live PG Serializable test still required)'
    );
  }

  // -----------------------------------------------------------------------
  // TEST 7: Idempotent Retries, Payload Mismatch 409 & Raw Duplicate 409
  // -----------------------------------------------------------------------
  {
    const baseIdemDoc = makeDoc({
      documentNumber: 'REC-IDEM-001',
      documentType: 'RECEIPT_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'COMPANY_OWNED',
      idempotencyKey: 'KEY-IDEM-001',
      totalQuantity: 50,
      totalWeightKg: 50,
      lines: [
        {
          id: 'L1',
          documentId: 'REC-IDEM-001',
          lineNumber: 1,
          partId: 'PART-BOLT-01',
          partCode: 'RM-BOLT-M8',
          partName: 'پیچ M8 گالوانیزه',
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-RAW-B1',
          quantity: 50,
          unit: 'PCS',
          quantityKg: 50,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });

    const first = await postInventoryDocumentInTransaction(structuredClone(baseIdemDoc), TEST_USER, {
      prismaClient: prisma,
      idempotencyKey: 'KEY-IDEM-001',
    });
    assert.equal(first.success, true);
    assert.equal(first.idempotentReplay, false);
    assert.equal(first.statusCode, 201);

    const trxCountAfterFirst = prisma.getState().inventoryTransactions.length;

    // 7a. Identical retry with same idempotencyKey -> safe replay (200), zero duplicate writes
    const replay = await postInventoryDocumentInTransaction(structuredClone(baseIdemDoc), TEST_USER, {
      prismaClient: prisma,
      idempotencyKey: 'KEY-IDEM-001',
    });
    assert.equal(replay.success, true);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.statusCode, 200);
    assert.equal(prisma.getState().inventoryTransactions.length, trxCountAfterFirst, 'Zero extra transactions on replay');
    const balB1 = prisma.getState().stockBalances.find((b: any) => b.locationId === 'LOC-ID-RAW-B1');
    assert.equal(Number(balB1.quantityOnHand), 50, 'Balance not double-incremented on idempotent replay');

    // 7b. Same idempotencyKey with modified payload -> 409 IDEMPOTENCY_PAYLOAD_MISMATCH
    const tamperedDoc = structuredClone(baseIdemDoc);
    tamperedDoc.lines[0].quantity = 999;
    tamperedDoc.lines[0].quantityKg = 999;
    assert.notEqual(
      buildDocumentRequestFingerprint(baseIdemDoc),
      buildDocumentRequestFingerprint(tamperedDoc)
    );
    const mismatch = await postInventoryDocumentInTransaction(tamperedDoc, TEST_USER, {
      prismaClient: prisma,
      idempotencyKey: 'KEY-IDEM-001',
    });
    assert.equal(mismatch.success, false);
    assert.equal(mismatch.statusCode, 409);
    assert.equal(mismatch.errorCode, 'IDEMPOTENCY_PAYLOAD_MISMATCH');

    // 7c. Duplicate documentNumber WITHOUT idempotencyKey -> 409 DUPLICATE_POST
    const rawDup = structuredClone(baseIdemDoc);
    rawDup.idempotencyKey = undefined;
    const rawDupRes = await postInventoryDocumentInTransaction(rawDup, TEST_USER, {
      prismaClient: prisma,
    });
    assert.equal(rawDupRes.success, false);
    assert.equal(rawDupRes.statusCode, 409);
    assert.equal(rawDupRes.errorCode, 'DUPLICATE_POST');
    console.log('  [PASS] 7. Idempotent retry replay, payload-mismatch 409 & raw duplicate 409');
  }

  // -----------------------------------------------------------------------
  // TEST 8: Server-Generated Document Number Idempotency & Replay Hydration
  // -----------------------------------------------------------------------
  {
    const req1 = makeDoc({
      documentNumber: 'REC-RAND-1001',
      documentType: 'RECEIPT_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'COMPANY_OWNED',
      idempotencyKey: 'KEY-SERVER-GEN-008',
      totalQuantity: 30,
      totalWeightKg: 30,
      lines: [
        {
          id: 'L1',
          documentId: 'REC-RAND-1001',
          lineNumber: 1,
          partId: 'PART-BOLT-01',
          partCode: 'RM-BOLT-M8',
          partName: 'پیچ M8 گالوانیزه',
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-RAW-B1',
          quantity: 30,
          unit: 'PCS',
          quantityKg: 30,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const first = await postInventoryDocumentInTransaction(req1, TEST_USER, {
      prismaClient: prisma,
      idempotencyKey: 'KEY-SERVER-GEN-008',
      excludeDocumentNumberFromFingerprint: true,
    });
    assert.equal(first.success, true);
    assert.equal(first.statusCode, 201);
    assert.equal(first.dbDocumentNumber, 'REC-RAND-1001');
    const trxCountAfterFirst = prisma.getState().inventoryTransactions.length;

    // Retry same logical request with a DIFFERENT server-generated random documentNumber
    const req2 = structuredClone(req1);
    req2.id = 'UI-DOC-RETRY-2';
    req2.documentNumber = 'REC-RAND-9999';
    req2.lines[0].documentId = 'REC-RAND-9999';
    const replay = await postInventoryDocumentInTransaction(req2, TEST_USER, {
      prismaClient: prisma,
      idempotencyKey: 'KEY-SERVER-GEN-008',
      excludeDocumentNumberFromFingerprint: true,
    });
    assert.equal(replay.success, true, `Expected server-gen replay success, got: ${replay.error}`);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.dbDocumentId, first.dbDocumentId, 'Replay must return original committed document ID');
    assert.equal(replay.dbDocumentNumber, 'REC-RAND-1001', 'Replay must return original committed documentNumber');
    assert.equal(req2.documentNumber, 'REC-RAND-1001', 'Caller document hydrated with original documentNumber');
    assert.equal(prisma.getState().inventoryTransactions.length, trxCountAfterFirst, 'Zero extra ledger writes on replay');

    // Same key with tampered quantity MUST still fail with 409 IDEMPOTENCY_PAYLOAD_MISMATCH
    const reqTampered = structuredClone(req1);
    reqTampered.documentNumber = 'REC-RAND-8888';
    reqTampered.lines[0].quantity = 99;
    reqTampered.lines[0].quantityKg = 99;
    const tamperedRes = await postInventoryDocumentInTransaction(reqTampered, TEST_USER, {
      prismaClient: prisma,
      idempotencyKey: 'KEY-SERVER-GEN-008',
      excludeDocumentNumberFromFingerprint: true,
    });
    assert.equal(tamperedRes.success, false);
    assert.equal(tamperedRes.statusCode, 409);
    assert.equal(tamperedRes.errorCode, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
    console.log('  [PASS] 8. Server-generated document number excluded from fingerprint & replay returns original ID/number');
  }

  // -----------------------------------------------------------------------
  // TEST 9: Reversal Idempotent Retry AFTER Target Is Already REVERSED
  // -----------------------------------------------------------------------
  {
    const targetDoc = prisma.getState().inventoryDocuments.find((d: any) => d.documentNumber === 'REC-RAND-1001');
    assert.ok(targetDoc);

    const revReq1 = makeDoc({
      documentNumber: 'REV-REC-RAND-1001',
      documentType: 'REVERSAL',
      reversalOfDocumentId: targetDoc.id,
      warehouseId: 'WH-RAW',
      adjustmentReason: 'ابطال سند اشتباهی با کلید یکتا',
      idempotencyKey: 'KEY-REV-009',
    });
    const revFirst = await postInventoryDocumentInTransaction(revReq1, TEST_USER, {
      prismaClient: prisma,
      idempotencyKey: 'KEY-REV-009',
    });
    assert.equal(revFirst.success, true, `Expected reversal success, got: ${revFirst.error}`);
    assert.equal(revFirst.statusCode, 201);
    const trxCountAfterRev = prisma.getState().inventoryTransactions.length;

    // Retry reversal with SAME idempotencyKey even though source document is now REVERSED -> 200 idempotentReplay
    const revReq2 = makeDoc({
      documentNumber: 'REV-REC-RAND-1001',
      documentType: 'REVERSAL',
      reversalOfDocumentId: targetDoc.id,
      warehouseId: 'WH-RAW',
      adjustmentReason: 'ابطال سند اشتباهی با کلید یکتا',
      idempotencyKey: 'KEY-REV-009',
    });
    const revReplay = await postInventoryDocumentInTransaction(revReq2, TEST_USER, {
      prismaClient: prisma,
      idempotencyKey: 'KEY-REV-009',
    });
    assert.equal(revReplay.success, true, `Reversal retry must replay cleanly, got: ${revReplay.error}`);
    assert.equal(revReplay.idempotentReplay, true);
    assert.equal(revReplay.statusCode, 200);
    assert.equal(revReplay.dbDocumentId, revFirst.dbDocumentId);
    assert.equal(revReplay.dbDocumentNumber, revFirst.dbDocumentNumber);
    assert.equal(prisma.getState().inventoryTransactions.length, trxCountAfterRev);

    // Retry with SAME idempotencyKey but DIFFERENT reason -> 409 IDEMPOTENCY_PAYLOAD_MISMATCH
    const revTampered = makeDoc({
      documentNumber: 'REV-REC-RAND-1001',
      documentType: 'REVERSAL',
      reversalOfDocumentId: targetDoc.id,
      warehouseId: 'WH-RAW',
      adjustmentReason: 'دلیل دستکاری شده',
      idempotencyKey: 'KEY-REV-009',
    });
    const revTamperedRes = await postInventoryDocumentInTransaction(revTampered, TEST_USER, {
      prismaClient: prisma,
      idempotencyKey: 'KEY-REV-009',
    });
    assert.equal(revTamperedRes.success, false);
    assert.equal(revTamperedRes.statusCode, 409);
    assert.equal(revTamperedRes.errorCode, 'IDEMPOTENCY_PAYLOAD_MISMATCH');

    // Retry with a DIFFERENT idempotencyKey -> 409 ALREADY_REVERSED
    const revNewKey = makeDoc({
      documentNumber: 'REV-REC-RAND-1001-DUP',
      documentType: 'REVERSAL',
      reversalOfDocumentId: targetDoc.id,
      warehouseId: 'WH-RAW',
      adjustmentReason: 'ابطال تکراری',
      idempotencyKey: 'KEY-REV-009-OTHER',
    });
    const revDupRes = await postInventoryDocumentInTransaction(revNewKey, TEST_USER, {
      prismaClient: prisma,
      idempotencyKey: 'KEY-REV-009-OTHER',
    });
    assert.equal(revDupRes.success, false);
    assert.equal(revDupRes.statusCode, 409);
    assert.equal(revDupRes.errorCode, 'ALREADY_REVERSED');
    console.log('  [PASS] 9. Reversal idempotent retry succeeds after source is REVERSED & rejects mismatch/new-key double reversal');
  }

  // -----------------------------------------------------------------------
  // TEST 10: Transient PG P2034 / 40001 / 40P01 Bounded Retries + Cloning
  // -----------------------------------------------------------------------
  {
    prisma.setHooks({
      onTransactionAttempt: (attempt: number) => {
        if (attempt === 1) {
          const err: any = new Error('Transaction failed due to a write conflict or a deadlock.');
          err.code = 'P2034';
          throw err;
        }
        if (attempt === 2) {
          const err: any = new Error('could not serialize access due to concurrent update');
          err.meta = { code: '40001' };
          throw err;
        }
      },
    });

    const retryDoc = makeDoc({
      documentNumber: 'REC-RETRY-010',
      documentType: 'RECEIPT_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'COMPANY_OWNED',
      idempotencyKey: 'KEY-RETRY-010',
      totalQuantity: 1000,
      totalWeightKg: 1000,
      lines: [
        {
          id: 'L1',
          documentId: 'REC-RETRY-010',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          coilId: 'COIL-RETRY-010',
          coilPackNumber: 'CP-RETRY-010',
          lotNumber: 'CP-RETRY-010',
          materialGrade: 'DC04',
          thicknessMm: 0.8,
          widthMm: 1250,
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-RAW-A1',
          quantity: 1000,
          unit: 'KG',
          quantityKg: 1000,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const retryRes = await postInventoryDocumentInTransaction(retryDoc, TEST_USER, {
      prismaClient: prisma,
      idempotencyKey: 'KEY-RETRY-010',
      maxSerializationRetries: 3,
      retryBaseDelayMs: 0,
    });
    prisma.clearHooks();

    assert.equal(retryRes.success, true, `Expected retry recovery on attempt 3, got: ${retryRes.error}`);
    assert.equal(retryRes.attempts, 3, 'Should succeed cleanly on attempt 3 after P2034 + 40001');
    assert.equal(
      prisma.getState().physicalCoils.filter((c: any) => c.coilId === 'COIL-RETRY-010').length,
      1,
      'Zero duplicate coils created across retries'
    );

    // Exhausted 40P01 deadlock retries -> clean 409 DEADLOCK_CONFLICT with zero caller mutation
    prisma.setHooks({
      onTransactionAttempt: () => {
        const err: any = new Error('deadlock detected');
        err.meta = { code: '40P01' };
        throw err;
      },
    });
    const deadlockedDoc = makeDoc({
      documentNumber: 'REC-DEADLOCK-010',
      documentType: 'RECEIPT_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'COMPANY_OWNED',
      totalQuantity: 20,
      totalWeightKg: 20,
      lines: [
        {
          id: 'L1',
          documentId: 'REC-DEADLOCK-010',
          lineNumber: 1,
          partId: 'PART-BOLT-01',
          partCode: 'RM-BOLT-M8',
          partName: 'پیچ M8 گالوانیزه',
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-RAW-B1',
          quantity: 20,
          unit: 'PCS',
          quantityKg: 20,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const deadlockRes = await postInventoryDocumentInTransaction(deadlockedDoc, TEST_USER, {
      prismaClient: prisma,
      maxSerializationRetries: 2,
      retryBaseDelayMs: 0,
    });
    prisma.clearHooks();

    assert.equal(deadlockRes.success, false);
    assert.equal(deadlockRes.statusCode, 409);
    assert.equal(deadlockRes.errorCode, 'DEADLOCK_CONFLICT');
    assert.equal(deadlockRes.attempts, 3);
    assert.equal(deadlockedDoc.postingStatus, 'UNPOSTED', 'Caller document must not mutate on failed retries');
    console.log('  [PASS] 10. Transient P2034/40001/40P01 retries with per-attempt cloning & clean 409 deadlock mapping');
  }

  // -----------------------------------------------------------------------
  // TEST 11: Multi-Contract Coil Full Transfer + Inconsistent Destination Block
  // -----------------------------------------------------------------------
  {
    const multiCoilRec = makeDoc({
      documentNumber: 'REC-MULTI-TRF-011',
      documentType: 'RECEIPT_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      totalQuantity: 3000,
      totalWeightKg: 3000,
      lines: [
        {
          id: 'L1',
          documentId: 'REC-MULTI-TRF-011',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          coilId: 'COIL-MULTI-011',
          coilPackNumber: 'CP-MULTI-011',
          lotNumber: 'CP-MULTI-011',
          materialGrade: 'DC04',
          thicknessMm: 0.8,
          widthMm: 1250,
          ownership: 'SAPCO_SUPPLIER_OWNED',
          locationCode: 'LOC-RAW-A1',
          quantity: 3000,
          unit: 'KG',
          quantityKg: 3000,
          qualityStatus: 'AVAILABLE',
          contractAllocations: [
            { contractId: 'CNT-A', contractNumber: 'SAPCO-1405-A', allocatedWeightKg: 1800 },
            { contractId: 'CNT-B', contractNumber: 'SAPCO-1405-B', allocatedWeightKg: 1200 },
          ],
        },
      ],
    });
    const recRes = await postInventoryDocumentInTransaction(multiCoilRec, TEST_USER, { prismaClient: prisma });
    assert.equal(recRes.success, true, `Multi-contract receipt failed: ${recRes.error}`);
    const multiCoilId = recRes.createdCoilIds![0];

    // 11a. Partial 1-segment transfer (1,800 of 3,000 kg) must still be blocked
    const partialSegTrf = makeDoc({
      documentNumber: 'TRF-MULTI-PARTIAL-011',
      documentType: 'TRANSFER',
      warehouseId: 'WH-RAW',
      targetWarehouseId: 'WH-WIP',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      totalQuantity: 1800,
      totalWeightKg: 1800,
      lines: [
        {
          id: 'L1',
          documentId: 'TRF-MULTI-PARTIAL-011',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          physicalCoilId: multiCoilId,
          lotNumber: 'CP-MULTI-011',
          ownership: 'SAPCO_SUPPLIER_OWNED',
          contractId: 'CNT-A',
          contractNumber: 'SAPCO-1405-A',
          locationCode: 'LOC-RAW-A1',
          targetLocationCode: 'LOC-WIP-01',
          quantity: 1800,
          unit: 'KG',
          quantityKg: 1800,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const partialSegRes = await postInventoryDocumentInTransaction(partialSegTrf, TEST_USER, { prismaClient: prisma });
    assert.equal(partialSegRes.success, false);
    assert.equal(partialSegRes.errorCode, 'PARTIAL_COIL_TRANSFER_UNSUPPORTED');

    // 11b. 2-segment transfer with conflicting target locations must be rejected
    const badDestTrf = makeDoc({
      documentNumber: 'TRF-MULTI-BADDEST-011',
      documentType: 'TRANSFER',
      warehouseId: 'WH-RAW',
      targetWarehouseId: 'WH-WIP',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      totalQuantity: 3000,
      totalWeightKg: 3000,
      lines: [
        {
          id: 'L1',
          documentId: 'TRF-MULTI-BADDEST-011',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          physicalCoilId: multiCoilId,
          lotNumber: 'CP-MULTI-011',
          ownership: 'SAPCO_SUPPLIER_OWNED',
          contractId: 'CNT-A',
          contractNumber: 'SAPCO-1405-A',
          locationCode: 'LOC-RAW-A1',
          targetLocationCode: 'LOC-WIP-01',
          quantity: 1800,
          unit: 'KG',
          quantityKg: 1800,
          qualityStatus: 'AVAILABLE',
        },
        {
          id: 'L2',
          documentId: 'TRF-MULTI-BADDEST-011',
          lineNumber: 2,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          physicalCoilId: multiCoilId,
          lotNumber: 'CP-MULTI-011',
          ownership: 'SAPCO_SUPPLIER_OWNED',
          contractId: 'CNT-B',
          contractNumber: 'SAPCO-1405-B',
          locationCode: 'LOC-RAW-A1',
          targetLocationCode: undefined,
          quantity: 1200,
          unit: 'KG',
          quantityKg: 1200,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const badDestRes = await postInventoryDocumentInTransaction(badDestTrf, TEST_USER, { prismaClient: prisma });
    assert.equal(badDestRes.success, false);
    assert.equal(badDestRes.errorCode, 'INCONSISTENT_COIL_TRANSFER_DESTINATION');

    // 11c. Full multi-contract transfer across both segments -> succeeds & updates PhysicalCoil ONCE
    const fullMultiTrf = makeDoc({
      documentNumber: 'TRF-MULTI-FULL-011',
      documentType: 'TRANSFER',
      warehouseId: 'WH-RAW',
      targetWarehouseId: 'WH-WIP',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      totalQuantity: 3000,
      totalWeightKg: 3000,
      lines: [
        {
          id: 'L1',
          documentId: 'TRF-MULTI-FULL-011',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          physicalCoilId: multiCoilId,
          lotNumber: 'CP-MULTI-011',
          ownership: 'SAPCO_SUPPLIER_OWNED',
          contractId: 'CNT-A',
          contractNumber: 'SAPCO-1405-A',
          locationCode: 'LOC-RAW-A1',
          targetLocationCode: 'LOC-WIP-01',
          quantity: 1800,
          unit: 'KG',
          quantityKg: 1800,
          qualityStatus: 'AVAILABLE',
        },
        {
          id: 'L2',
          documentId: 'TRF-MULTI-FULL-011',
          lineNumber: 2,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          physicalCoilId: multiCoilId,
          lotNumber: 'CP-MULTI-011',
          ownership: 'SAPCO_SUPPLIER_OWNED',
          contractId: 'CNT-B',
          contractNumber: 'SAPCO-1405-B',
          locationCode: 'LOC-RAW-A1',
          targetLocationCode: 'LOC-WIP-01',
          quantity: 1200,
          unit: 'KG',
          quantityKg: 1200,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const fullMultiRes = await postInventoryDocumentInTransaction(fullMultiTrf, TEST_USER, { prismaClient: prisma });
    assert.equal(fullMultiRes.success, true, `Multi-contract full transfer failed: ${fullMultiRes.error}`);
    const movedMultiCoil = prisma.getState().physicalCoils.find((c: any) => c.id === multiCoilId);
    assert.equal(movedMultiCoil.warehouseId, 'WH-ID-WIP');
    assert.equal(movedMultiCoil.warehouseLocationId, 'LOC-ID-WIP-01');
    assert.equal(movedMultiCoil.version, 2, 'PhysicalCoil must be updated exactly ONCE across multi-line transfer');
    const movedLot = prisma.getState().materialLots.find((l: any) => l.lotNumber === 'CP-MULTI-011');
    assert.equal(movedLot.warehouseLocationId, 'LOC-ID-WIP-01');
    console.log('  [PASS] 11. Multi-contract coil full transfer aggregates lines, updates coil once & blocks conflicting destinations');
  }

  // -----------------------------------------------------------------------
  // TEST 12: Partial QM Transfer Preserves Derived Coil/Lot Quality Status
  // -----------------------------------------------------------------------
  {
    const multiCoil = prisma.getState().physicalCoils.find((c: any) => c.coilId === 'COIL-MULTI-011');
    assert.ok(multiCoil);

    // 12a. Quarantine ONLY segment CNT-A (1,800 kg); CNT-B (1,200 kg) stays AVAILABLE
    const partialQmA = makeDoc({
      documentNumber: 'QM-322-PARTIAL-A',
      documentType: 'STOCK_STATUS_TRANSFER',
      movementType: '322',
      qmStatusTarget: 'QUALITY_INSPECTION',
      warehouseId: 'WH-WIP',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      totalQuantity: 1800,
      totalWeightKg: 1800,
      lines: [
        {
          id: 'L1',
          documentId: 'QM-322-PARTIAL-A',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          physicalCoilId: multiCoil.id,
          lotNumber: 'CP-MULTI-011',
          ownership: 'SAPCO_SUPPLIER_OWNED',
          contractId: 'CNT-A',
          contractNumber: 'SAPCO-1405-A',
          locationCode: 'LOC-WIP-01',
          quantity: 1800,
          unit: 'KG',
          quantityKg: 1800,
          qualityStatus: 'AVAILABLE',
          sourceQualityStatus: 'AVAILABLE',
          targetQualityStatus: 'QUARANTINE',
        },
      ],
    });
    const resQmA = await postInventoryDocumentInTransaction(partialQmA, TEST_USER, { prismaClient: prisma });
    assert.equal(resQmA.success, true, `Partial QM A failed: ${resQmA.error}`);
    assert.equal(
      prisma.getState().physicalCoils.find((c: any) => c.id === multiCoil.id).qualityStatus,
      'AVAILABLE',
      'Partial QM quarantine must NOT overwrite whole-coil qualityStatus while 1,200 kg remains AVAILABLE'
    );
    assert.equal(
      prisma.getState().materialLots.find((l: any) => l.lotNumber === 'CP-MULTI-011').status,
      'AVAILABLE',
      'Partial QM quarantine must NOT overwrite whole-lot status while positive AVAILABLE balance remains'
    );

    // 12b. Now quarantine remaining segment CNT-B (1,200 kg) -> derived coil/lot status becomes QUARANTINE
    const partialQmB = makeDoc({
      documentNumber: 'QM-322-PARTIAL-B',
      documentType: 'STOCK_STATUS_TRANSFER',
      movementType: '322',
      qmStatusTarget: 'QUALITY_INSPECTION',
      warehouseId: 'WH-WIP',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      totalQuantity: 1200,
      totalWeightKg: 1200,
      lines: [
        {
          id: 'L1',
          documentId: 'QM-322-PARTIAL-B',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          physicalCoilId: multiCoil.id,
          lotNumber: 'CP-MULTI-011',
          ownership: 'SAPCO_SUPPLIER_OWNED',
          contractId: 'CNT-B',
          contractNumber: 'SAPCO-1405-B',
          locationCode: 'LOC-WIP-01',
          quantity: 1200,
          unit: 'KG',
          quantityKg: 1200,
          qualityStatus: 'AVAILABLE',
          sourceQualityStatus: 'AVAILABLE',
          targetQualityStatus: 'QUARANTINE',
        },
      ],
    });
    const resQmB = await postInventoryDocumentInTransaction(partialQmB, TEST_USER, { prismaClient: prisma });
    assert.equal(resQmB.success, true, `Partial QM B failed: ${resQmB.error}`);
    assert.equal(
      prisma.getState().physicalCoils.find((c: any) => c.id === multiCoil.id).qualityStatus,
      'QUARANTINE',
      'Once all positive balances are QUARANTINE, coil qualityStatus becomes QUARANTINE'
    );
    assert.equal(
      prisma.getState().materialLots.find((l: any) => l.lotNumber === 'CP-MULTI-011').status,
      'QUARANTINE'
    );

    // 12c. Reverse QM-322-PARTIAL-B -> CNT-B returns to AVAILABLE, so derived status returns to AVAILABLE
    const revQmB = makeDoc({
      documentNumber: 'REV-QM-322-PARTIAL-B',
      documentType: 'REVERSAL',
      reversalOfDocumentId: resQmB.dbDocumentId,
      warehouseId: 'WH-WIP',
      adjustmentReason: 'ابطال قرنطینه بخش دوم',
    });
    const revQmBRes = await postInventoryDocumentInTransaction(revQmB, TEST_USER, { prismaClient: prisma });
    assert.equal(revQmBRes.success, true, `Reversal of QM B failed: ${revQmBRes.error}`);
    assert.equal(
      prisma.getState().physicalCoils.find((c: any) => c.id === multiCoil.id).qualityStatus,
      'AVAILABLE',
      'Reversing one QM segment restores derived AVAILABLE status when positive AVAILABLE stock exists'
    );
    console.log('  [PASS] 12. Partial QM transfer & reversal derive coil/lot quality status from remaining positive balances');
  }

  // -----------------------------------------------------------------------
  // TEST 13: Strict widthMm, Duplicate Contract Rejection, Contract & Lot CAS
  // -----------------------------------------------------------------------
  {
    // 13a. Missing widthMm on sheet-metal coil receipt must fail with 400 INVALID_WIDTH
    const missingWidthDoc = makeDoc({
      documentNumber: 'REC-NO-WIDTH-013',
      documentType: 'RECEIPT_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'COMPANY_OWNED',
      totalQuantity: 1000,
      totalWeightKg: 1000,
      lines: [
        {
          id: 'L1',
          documentId: 'REC-NO-WIDTH-013',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          coilId: 'COIL-NOWIDTH-013',
          coilPackNumber: 'CP-NOWIDTH-013',
          lotNumber: 'CP-NOWIDTH-013',
          materialGrade: 'DC04',
          thicknessMm: 0.8,
          // widthMm intentionally omitted
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-RAW-A1',
          quantity: 1000,
          unit: 'KG',
          quantityKg: 1000,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const noWidthRes = await postInventoryDocumentInTransaction(missingWidthDoc, TEST_USER, { prismaClient: prisma });
    assert.equal(noWidthRes.success, false);
    assert.equal(noWidthRes.statusCode, 400);
    assert.equal(noWidthRes.errorCode, 'INVALID_WIDTH');

    // 13b. Duplicate contractId allocation on same coil must fail with 400 DUPLICATE_CONTRACT_ALLOCATION
    const dupAllocDoc = makeDoc({
      documentNumber: 'REC-DUP-ALLOC-013',
      documentType: 'RECEIPT_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      totalQuantity: 1000,
      totalWeightKg: 1000,
      lines: [
        {
          id: 'L1',
          documentId: 'REC-DUP-ALLOC-013',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          coilId: 'COIL-DUPALLOC-013',
          coilPackNumber: 'CP-DUPALLOC-013',
          lotNumber: 'CP-DUPALLOC-013',
          materialGrade: 'DC04',
          thicknessMm: 0.8,
          widthMm: 1250,
          ownership: 'SAPCO_SUPPLIER_OWNED',
          locationCode: 'LOC-RAW-A1',
          quantity: 1000,
          unit: 'KG',
          quantityKg: 1000,
          qualityStatus: 'AVAILABLE',
          contractAllocations: [
            { contractId: 'CNT-A', contractNumber: 'SAPCO-1405-A', allocatedWeightKg: 500 },
            { contractId: 'CNT-A', contractNumber: 'SAPCO-1405-A', allocatedWeightKg: 500 },
          ],
        },
      ],
    });
    const dupAllocRes = await postInventoryDocumentInTransaction(dupAllocDoc, TEST_USER, { prismaClient: prisma });
    assert.equal(dupAllocRes.success, false);
    assert.equal(dupAllocRes.statusCode, 400);
    assert.equal(dupAllocRes.errorCode, 'DUPLICATE_CONTRACT_ALLOCATION');

    // 13c. Concurrent contract quota overrun fails atomic updateMany guard with 409 CONTRACT_QUOTA_EXCEEDED
    prisma.setHooks({
      onBeforeMaterialContractUpdateMany: (args: any, workingState: MockDbState) => {
        if (args.where?.id === 'CNT-A') {
          const c = workingState.materialContracts.find((x: any) => x.id === 'CNT-A');
          if (c) c.receivedWeightKg = 9950; // Competing receipt nearly exhausted 10,000 kg quota
        }
      },
    });
    const quotaRaceDoc = makeDoc({
      documentNumber: 'REC-QUOTA-RACE-013',
      documentType: 'RECEIPT_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      totalQuantity: 1000,
      totalWeightKg: 1000,
      lines: [
        {
          id: 'L1',
          documentId: 'REC-QUOTA-RACE-013',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          coilId: 'COIL-QUOTA-RACE-013',
          coilPackNumber: 'CP-QUOTA-RACE-013',
          lotNumber: 'CP-QUOTA-RACE-013',
          materialGrade: 'DC04',
          thicknessMm: 0.8,
          widthMm: 1250,
          ownership: 'SAPCO_SUPPLIER_OWNED',
          locationCode: 'LOC-RAW-A1',
          quantity: 1000,
          unit: 'KG',
          quantityKg: 1000,
          qualityStatus: 'AVAILABLE',
          contractAllocations: [
            { contractId: 'CNT-A', contractNumber: 'SAPCO-1405-A', allocatedWeightKg: 1000 },
          ],
        },
      ],
    });
    const quotaRaceRes = await postInventoryDocumentInTransaction(quotaRaceDoc, TEST_USER, { prismaClient: prisma });
    prisma.clearHooks();
    assert.equal(quotaRaceRes.success, false);
    assert.equal(quotaRaceRes.statusCode, 409);
    assert.equal(quotaRaceRes.errorCode, 'CONTRACT_QUOTA_EXCEEDED');
    assert.equal(
      prisma.getState().physicalCoils.some((c: any) => c.coilId === 'COIL-QUOTA-RACE-013'),
      false,
      'Rolled back coil creation after concurrent contract quota overrun'
    );

    // 13d. Concurrent MaterialLot modification fails CAS updateMany guard with 409 LOT_CONCURRENCY_CONFLICT
    prisma.setHooks({
      onBeforeMaterialLotUpdateMany: (args: any, workingState: MockDbState) => {
        if (args.where?.id === 'LOT-BOLT-01') {
          const lot = workingState.materialLots.find((l: any) => l.id === 'LOT-BOLT-01');
          if (lot) lot.remainingWeightKg = Number(lot.remainingWeightKg) - 10;
        }
      },
    });
    const lotRaceDoc = makeDoc({
      documentNumber: 'ADJ-LOT-RACE-013',
      documentType: 'ADJUSTMENT',
      warehouseId: 'WH-RAW',
      ownership: 'COMPANY_OWNED',
      totalQuantity: 10,
      totalWeightKg: 10,
      lines: [
        {
          id: 'L1',
          documentId: 'ADJ-LOT-RACE-013',
          lineNumber: 1,
          partId: 'PART-BOLT-01',
          partCode: 'RM-BOLT-M8',
          partName: 'پیچ M8 گالوانیزه',
          materialLotId: 'LOT-BOLT-01',
          lotNumber: 'LOT-M8-001',
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-RAW-A1',
          quantity: 10,
          unit: 'PCS',
          quantityKg: 10,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const lotRaceRes = await postInventoryDocumentInTransaction(lotRaceDoc, TEST_USER, { prismaClient: prisma });
    prisma.clearHooks();
    assert.equal(lotRaceRes.success, false);
    assert.equal(lotRaceRes.statusCode, 409);
    assert.equal(lotRaceRes.errorCode, 'LOT_CONCURRENCY_CONFLICT');
    console.log('  [PASS] 13. Missing widthMm rejection, duplicate contract rejection & atomic contract/lot CAS guards');
  }

  // -----------------------------------------------------------------------
  // TEST 14: Prisma Migration NULLS NOT DISTINCT Guard (Positive & Negative)
  // -----------------------------------------------------------------------
  {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const { migrations, schemaContent } = loadWorkspaceMigrations(projectRoot);

    const realCheck = verifyNullsNotDistinctMigrations(migrations, schemaContent);
    assert.equal(realCheck.ok, true, `Real migrations must pass guard: ${realCheck.errors.join('; ')}`);
    assert.equal(realCheck.establishedIn, '20261125070000_inventory_p0a_constraints_and_ledger_hardening');

    // Negative test 1: subsequent migration recreates index WITHOUT NULLS NOT DISTINCT -> MUST FAIL
    const downgradedCheck = verifyNullsNotDistinctMigrations(
      [
        ...migrations,
        {
          name: '20261201000000_accidental_prisma_drift',
          sql: `
            DROP INDEX "${STOCK_BALANCES_UNIQUE_INDEX}";
            CREATE UNIQUE INDEX "${STOCK_BALANCES_UNIQUE_INDEX}"
              ON "stock_balances"("partId", "warehouseId", "locationId", "materialLotId", "physicalCoilId", "ownership", "contractId", "qualityStatus");
          `,
        },
      ],
      schemaContent
    );
    assert.equal(downgradedCheck.ok, false, 'Migration removing NULLS NOT DISTINCT must fail verification');
    assert.ok(downgradedCheck.errors.some(e => e.includes('20261201000000_accidental_prisma_drift')));

    // Negative test 2: subsequent migration drops index without recreating it -> MUST FAIL
    const droppedCheck = verifyNullsNotDistinctMigrations(
      [
        ...migrations,
        {
          name: '20261202000000_drop_unique_index',
          sql: `DROP INDEX IF EXISTS "${STOCK_BALANCES_UNIQUE_INDEX}";`,
        },
      ],
      schemaContent
    );
    assert.equal(droppedCheck.ok, false, 'Migration dropping stock_balances unique index must fail verification');
    console.log('  [PASS] 14. Prisma migration NULLS NOT DISTINCT verifier passes real history & blocks drift');
  }

  // -----------------------------------------------------------------------
  // TEST 15: QM Idempotency Retry After Full Source-Balance Transfer
  // -----------------------------------------------------------------------
  {
    const qmCoilRec = makeDoc({
      documentNumber: 'REC-QM-RETRY-015',
      documentType: 'RECEIPT_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'COMPANY_OWNED',
      totalQuantity: 1100,
      totalWeightKg: 1100,
      lines: [
        {
          id: 'L1',
          documentId: 'REC-QM-RETRY-015',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          coilId: 'COIL-QM-RETRY-015',
          coilPackNumber: 'CP-QM-RETRY-015',
          lotNumber: 'CP-QM-RETRY-015',
          materialGrade: 'DC04',
          thicknessMm: 0.8,
          widthMm: 1250,
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-RAW-A1',
          quantity: 1100,
          unit: 'KG',
          quantityKg: 1100,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const rec15 = await postInventoryDocumentInTransaction(qmCoilRec, TEST_USER, { prismaClient: prisma });
    assert.equal(rec15.success, true);
    const coil15Id = rec15.createdCoilIds![0];
    const sourceSb = prisma
      .getState()
      .stockBalances.find((b: any) => b.physicalCoilId === coil15Id && b.qualityStatus === 'AVAILABLE');
    assert.ok(sourceSb);

    // 15a. First full QM 322 transfer moves all 1,100 kg from AVAILABLE -> QUARANTINE
    const qmIdemKey = 'IDEM-QM-322-FULL-015';
    const firstQmDoc = makeDoc({
      documentNumber: 'QM-322-FIRST-015',
      documentType: 'STOCK_STATUS_TRANSFER',
      movementType: '322',
      qmStatusTarget: 'QUALITY_INSPECTION',
      idempotencyKey: qmIdemKey,
      warehouseId: 'WH-RAW',
      ownership: 'COMPANY_OWNED',
      referenceType: 'QM_INSPECTION',
      referenceNumber: 'CP-QM-RETRY-015',
      adjustmentReason: 'قرنطینه اولیه کامل کلاف',
      totalQuantity: 1100,
      totalWeightKg: 1100,
      lines: [
        {
          id: 'L1',
          documentId: 'QM-322-FIRST-015',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          physicalCoilId: coil15Id,
          coilId: 'COIL-QM-RETRY-015',
          coilPackNumber: 'CP-QM-RETRY-015',
          lotNumber: 'CP-QM-RETRY-015',
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-RAW-A1',
          quantity: 1100,
          unit: 'KG',
          quantityKg: 1100,
          qualityStatus: 'QUARANTINE',
          sourceQualityStatus: 'AVAILABLE',
          targetQualityStatus: 'QUARANTINE',
          movementType: '322',
          qmStatusTarget: 'QUALITY_INSPECTION',
          notes: 'قرنطینه اولیه کامل کلاف',
        },
      ],
    });
    const qmFirstRes = await postInventoryDocumentInTransaction(firstQmDoc, TEST_USER, {
      prismaClient: prisma,
      idempotencyKey: qmIdemKey,
      excludeDocumentNumberFromFingerprint: true,
    });
    assert.equal(qmFirstRes.success, true);
    assert.equal(qmFirstRes.idempotentReplay, false);

    // Verify source AVAILABLE balance is now 0 (so any naive pre-query for AVAILABLE > 0 would fail)
    const afterSb = prisma
      .getState()
      .stockBalances.find((b: any) => b.id === sourceSb.id);
    assert.equal(Number(afterSb.quantityOnHand), 0);

    // 15b. Retry with same Idempotency-Key (both by StockBalance key and by dimension fields without explicit qty)
    for (const retryParams of [
      {
        key: sourceSb.id,
        partId: 'PART-SHEET-01',
        partCode: 'RM-DC04-08',
        warehouseId: 'WH-RAW',
        lotNumber: 'CP-QM-RETRY-015',
        movementType: '322' as const,
        targetQualityStatus: 'QUARANTINE' as const,
        heldQty: 1100,
        reasonFa: 'قرنطینه اولیه کامل کلاف',
        idempotencyKey: qmIdemKey,
        user: TEST_USER,
      },
      {
        key: coil15Id,
        partCode: 'RM-DC04-08',
        lotNumber: 'COIL-QM-RETRY-015',
        movementType: '322' as const,
        targetQualityStatus: 'QUARANTINE' as const,
        // Omit heldQty (simulating qc-hold retry where availableQty became 0)
        reasonFa: 'قرنطینه اولیه کامل کلاف',
        idempotencyKey: qmIdemKey,
        user: TEST_USER,
      },
    ]) {
      const prep = await prepareQmTransferRetryInDb(prisma, retryParams);
      assert.equal(prep.matched, true, 'prepareQmTransferRetryInDb must match existing idempotencyKey before stock pre-query');
      assert.equal('replayDocument' in prep, true);
      if ('replayDocument' in prep) {
        const replayRes = await postInventoryDocumentInTransaction(prep.replayDocument, TEST_USER, {
          prismaClient: prisma,
          idempotencyKey: qmIdemKey,
          excludeDocumentNumberFromFingerprint: true,
        });
        assert.equal(replayRes.success, true, `Expected QM idempotent replay 200, got: ${replayRes.error}`);
        assert.equal(replayRes.idempotentReplay, true);
        assert.equal(replayRes.statusCode, 200);
        assert.equal(replayRes.dbDocumentId, qmFirstRes.dbDocumentId);
        assert.equal(replayRes.dbDocumentNumber, 'QM-322-FIRST-015');
      }
    }

    // 15c. Mismatched QM payload with same Idempotency-Key (different quantity or movementType) must return 409
    const badQtyPrep = await prepareQmTransferRetryInDb(prisma, {
      key: sourceSb.id,
      partId: 'PART-SHEET-01',
      movementType: '322',
      targetQualityStatus: 'QUARANTINE',
      heldQty: 500, // Mismatched quantity
      idempotencyKey: qmIdemKey,
      user: TEST_USER,
    });
    assert.equal(badQtyPrep.matched, true);
    assert.equal('errorResult' in badQtyPrep, true);
    if ('errorResult' in badQtyPrep) {
      assert.equal(badQtyPrep.errorResult.statusCode, 409);
      assert.equal(badQtyPrep.errorResult.errorCode, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
    }

    const badMovePrep = await prepareQmTransferRetryInDb(prisma, {
      key: sourceSb.id,
      partId: 'PART-SHEET-01',
      movementType: '344', // Mismatched movement type
      targetQualityStatus: 'QUALITY_BLOCKED',
      heldQty: 1100,
      idempotencyKey: qmIdemKey,
      user: TEST_USER,
    });
    assert.equal(badMovePrep.matched, true);
    assert.equal('errorResult' in badMovePrep, true);
    if ('errorResult' in badMovePrep) {
      assert.equal(badMovePrep.errorResult.statusCode, 409);
      assert.equal(badMovePrep.errorResult.errorCode, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
    }
    console.log('  [PASS] 15. QM idempotent retry reaches ledger replay before stock pre-queries & rejects mismatched payloads with 409');
  }

  // -----------------------------------------------------------------------
  // TEST 16: Document Post Idempotency (Draft ID, Committed ID, DocNumber & Non-RM Types)
  // -----------------------------------------------------------------------
  {
    const mapDbDocHelper = (dbDoc: any, auditPostedDoc?: Partial<InventoryDocument> | null): InventoryDocument => {
      const sem = inferDbDocumentSemantics(dbDoc, auditPostedDoc);
      return {
        id: dbDoc.id,
        documentNumber: dbDoc.documentNumber,
        documentType: sem.documentType,
        movementType: sem.movementType,
        qmStatusTarget: sem.qmStatusTarget,
        documentDate: new Date(dbDoc.documentDate).toISOString(),
        documentStatus: dbDoc.documentStatus,
        postingStatus: dbDoc.postingStatus,
        warehouseId: dbDoc.warehouse?.code || dbDoc.warehouseId,
        warehouseName: dbDoc.warehouse?.name || dbDoc.warehouseId,
        ownership: 'COMPANY_OWNED',
        lines: (dbDoc.lines || []).map((l: any, i: number) => ({
          id: l.id,
          documentId: dbDoc.id,
          lineNumber: l.lineNumber || i + 1,
          partId: l.partId,
          partCode: l.part?.partNumber || l.partId,
          partName: l.part?.name || l.partId,
          ownership: l.ownership || 'COMPANY_OWNED',
          locationCode: l.location?.code,
          quantity: Number(l.quantity),
          unit: l.unit?.code || 'PCS',
          quantityKg: Number(l.weightKg),
          qualityStatus: l.qualityStatus || 'AVAILABLE',
        })),
        totalQuantity: Number(dbDoc.lines?.[0]?.quantity || 0),
        totalWeightKg: Number(dbDoc.lines?.[0]?.weightKg || 0),
        createdByUid: TEST_USER.uid,
        createdByName: TEST_USER.displayName,
        createdAt: new Date(dbDoc.createdAt).toISOString(),
        updatedAt: new Date(dbDoc.updatedAt).toISOString(),
      };
    };

    const originalDraftId = 'DOC-DRAFT-17300016';
    const postIdemKey = 'IDEM-DOC-POST-FG-016';
    const draftDoc: InventoryDocument = makeDoc({
      id: originalDraftId,
      documentNumber: 'REC-FIN-1403-016',
      documentType: 'RECEIPT_FINISHED_GOODS',
      warehouseId: 'WH-RAW',
      ownership: 'COMPANY_OWNED',
      referenceType: 'PRODUCTION_ORDER',
      referenceNumber: 'MO-1405-016',
      adjustmentReason: 'رسید محصول نهایی از خط تولید',
      totalQuantity: 40,
      totalWeightKg: 40,
      lines: [
        {
          id: 'L-FG-016',
          documentId: originalDraftId,
          lineNumber: 1,
          partId: 'PART-BOLT-01',
          partCode: 'RM-BOLT-M8',
          partName: 'پیچ M8 گالوانیزه',
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-RAW-B1',
          quantity: 40,
          unit: 'PCS',
          quantityKg: 40,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });

    // Initial post of draft via resolveDbDocumentPostIdempotency -> postInventoryDocumentInTransaction
    const initResolve = await resolveDbDocumentPostIdempotency(prisma, {
      id: originalDraftId,
      idempotencyKey: postIdemKey,
      memDoc: draftDoc,
      dbDoc: null,
      mapDbDocFn: mapDbDocHelper,
      postUser: TEST_USER,
    });
    assert.equal(initResolve.status, 'POST');
    if (initResolve.status === 'POST') {
      const postRes = await postInventoryDocumentInTransaction(initResolve.docToPost, TEST_USER, {
        prismaClient: prisma,
        idempotencyKey: postIdemKey,
        sourceDraftId: initResolve.sourceDraftId,
      });
      assert.equal(postRes.success, true);
      assert.equal(postRes.idempotentReplay, false);

      const committedDbDoc = await prisma.inventoryDocument.findFirst({
        where: { id: postRes.dbDocumentId },
        include: {
          warehouse: true,
          lines: { include: { part: true, unit: true, location: true } },
          transactions: true,
        },
      });
      assert.ok(committedDbDoc);

      // 16a. Retry by original draft ID (even after draftDoc.id was mutated to dbDocumentId or after server restart with memDoc=null)
      for (const lookupId of [originalDraftId, postRes.dbDocumentId!, 'REC-FIN-1403-016']) {
        const dbLookup = await prisma.inventoryDocument.findFirst({
          where: { OR: [{ id: lookupId }, { documentNumber: lookupId }] },
          include: {
            warehouse: true,
            lines: { include: { part: true, unit: true, location: true } },
            transactions: true,
          },
        });
        const retryResolve = await resolveDbDocumentPostIdempotency(prisma, {
          id: lookupId,
          idempotencyKey: postIdemKey,
          memDoc: null, // Simulate pure PG-mode after process restart
          dbDoc: dbLookup,
          mapDbDocFn: mapDbDocHelper,
          postUser: TEST_USER,
        });
        assert.equal(retryResolve.status, 'REPLAY', `Expected REPLAY for id=${lookupId}`);
        if (retryResolve.status === 'REPLAY') {
          assert.equal(retryResolve.idempotentReplay, true);
          assert.equal(retryResolve.dbDocumentId, postRes.dbDocumentId);
          assert.equal(retryResolve.dbDocumentNumber, 'REC-FIN-1403-016');
          // Verify full original document semantics are preserved (not downgraded to RECEIPT_RAW_MATERIAL)
          assert.equal(retryResolve.postedDocument.documentType, 'RECEIPT_FINISHED_GOODS');
          assert.equal(retryResolve.postedDocument.referenceType, 'PRODUCTION_ORDER');
          assert.equal(retryResolve.postedDocument.referenceNumber, 'MO-1405-016');
        }
      }

      // 16b. Reusing the same Idempotency-Key on a DIFFERENT document ID must NOT replay — it falls through and fails with 409 IDEMPOTENCY_PAYLOAD_MISMATCH
      const otherDoc = makeDoc({
        id: 'DOC-OTHER-016',
        documentNumber: 'ADJ-OTHER-016',
        documentType: 'ADJUSTMENT',
        warehouseId: 'WH-RAW',
        ownership: 'COMPANY_OWNED',
        totalQuantity: 5,
        totalWeightKg: 5,
        lines: [
          {
            id: 'L-OTH',
            documentId: 'DOC-OTHER-016',
            lineNumber: 1,
            partId: 'PART-BOLT-01',
            partCode: 'RM-BOLT-M8',
            partName: 'پیچ M8 گالوانیزه',
            ownership: 'COMPANY_OWNED',
            locationCode: 'LOC-RAW-B1',
            quantity: 5,
            unit: 'PCS',
            quantityKg: 5,
            qualityStatus: 'AVAILABLE',
          },
        ],
      });
      const crossResolve = await resolveDbDocumentPostIdempotency(prisma, {
        id: 'DOC-OTHER-016',
        idempotencyKey: postIdemKey,
        memDoc: otherDoc,
        dbDoc: null,
        mapDbDocFn: mapDbDocHelper,
        postUser: TEST_USER,
      });
      assert.equal(crossResolve.status, 'POST');
      if (crossResolve.status === 'POST') {
        const crossPost = await postInventoryDocumentInTransaction(crossResolve.docToPost, TEST_USER, {
          prismaClient: prisma,
          idempotencyKey: postIdemKey,
        });
        assert.equal(crossPost.success, false);
        assert.equal(crossPost.statusCode, 409);
        assert.equal(crossPost.errorCode, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
      }
    }
    console.log('  [PASS] 16. Document post idempotency preserves full posting semantics across draft/DB IDs & blocks cross-doc key reuse');
  }

  // -----------------------------------------------------------------------
  // TEST 17: TRANSFER Reversal Restores MaterialLot.warehouseLocationId (Coil & Non-Coil)
  // -----------------------------------------------------------------------
  {
    // 17a. Coil-linked TRANSFER and its REVERSAL
    const coilRec17 = makeDoc({
      documentNumber: 'REC-TRF-REV-017',
      documentType: 'RECEIPT_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'COMPANY_OWNED',
      totalQuantity: 900,
      totalWeightKg: 900,
      lines: [
        {
          id: 'L1',
          documentId: 'REC-TRF-REV-017',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          coilId: 'COIL-TRF-REV-017',
          coilPackNumber: 'CP-TRF-REV-017',
          lotNumber: 'CP-TRF-REV-017',
          materialGrade: 'DC04',
          thicknessMm: 0.8,
          widthMm: 1250,
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-RAW-A1',
          quantity: 900,
          unit: 'KG',
          quantityKg: 900,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const rec17Res = await postInventoryDocumentInTransaction(coilRec17, TEST_USER, { prismaClient: prisma });
    assert.equal(rec17Res.success, true);
    const coil17Id = rec17Res.createdCoilIds![0];
    const lot17Before = prisma.getState().materialLots.find((l: any) => l.lotNumber === 'CP-TRF-REV-017');
    assert.equal(lot17Before.warehouseLocationId, 'LOC-ID-RAW-A1');

    const trf17 = makeDoc({
      documentNumber: 'TRF-COIL-017',
      documentType: 'TRANSFER',
      warehouseId: 'WH-RAW',
      targetWarehouseId: 'WH-WIP',
      ownership: 'COMPANY_OWNED',
      totalQuantity: 900,
      totalWeightKg: 900,
      lines: [
        {
          id: 'L1',
          documentId: 'TRF-COIL-017',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          physicalCoilId: coil17Id,
          lotNumber: 'CP-TRF-REV-017',
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-RAW-A1',
          targetLocationCode: 'LOC-WIP-01',
          quantity: 900,
          unit: 'KG',
          quantityKg: 900,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const trf17Res = await postInventoryDocumentInTransaction(trf17, TEST_USER, { prismaClient: prisma });
    assert.equal(trf17Res.success, true);
    assert.equal(
      prisma.getState().materialLots.find((l: any) => l.lotNumber === 'CP-TRF-REV-017').warehouseLocationId,
      'LOC-ID-WIP-01'
    );

    const revTrf17 = makeDoc({
      documentNumber: 'REV-TRF-COIL-017',
      documentType: 'REVERSAL',
      reversalOfDocumentId: trf17Res.dbDocumentId,
      warehouseId: 'WH-WIP',
      adjustmentReason: 'ابطال انتقال کلاف و بازگشت به ردیف A1',
    });
    const revTrf17Res = await postInventoryDocumentInTransaction(revTrf17, TEST_USER, { prismaClient: prisma });
    assert.equal(revTrf17Res.success, true, `Coil transfer reversal failed: ${revTrf17Res.error}`);

    const restoredCoil17 = prisma.getState().physicalCoils.find((c: any) => c.id === coil17Id);
    const restoredLot17 = prisma.getState().materialLots.find((l: any) => l.lotNumber === 'CP-TRF-REV-017');
    assert.equal(restoredCoil17.warehouseId, 'WH-ID-RAW');
    assert.equal(restoredCoil17.warehouseLocationId, 'LOC-ID-RAW-A1');
    assert.equal(
      restoredLot17.warehouseLocationId,
      'LOC-ID-RAW-A1',
      'TRANSFER reversal must restore coil-linked MaterialLot.warehouseLocationId to LOC-ID-RAW-A1'
    );

    // 17b. Non-coil MaterialLot TRANSFER and its REVERSAL
    const boltLot = prisma.getState().materialLots.find((l: any) => l.id === 'LOT-BOLT-01');
    boltLot.warehouseLocationId = 'LOC-ID-RAW-A1';

    const nonCoilTrf = makeDoc({
      documentNumber: 'TRF-LOT-BOLT-017',
      documentType: 'TRANSFER',
      warehouseId: 'WH-RAW',
      targetWarehouseId: 'WH-WIP',
      ownership: 'COMPANY_OWNED',
      totalQuantity: 50,
      totalWeightKg: 50,
      lines: [
        {
          id: 'L1',
          documentId: 'TRF-LOT-BOLT-017',
          lineNumber: 1,
          partId: 'PART-BOLT-01',
          partCode: 'RM-BOLT-M8',
          partName: 'پیچ M8 گالوانیزه',
          materialLotId: 'LOT-BOLT-01',
          lotNumber: 'LOT-M8-001',
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-RAW-A1',
          targetLocationCode: 'LOC-WIP-01',
          quantity: 50,
          unit: 'PCS',
          quantityKg: 50,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const nonCoilTrfRes = await postInventoryDocumentInTransaction(nonCoilTrf, TEST_USER, { prismaClient: prisma });
    assert.equal(nonCoilTrfRes.success, true);
    assert.equal(
      prisma.getState().materialLots.find((l: any) => l.id === 'LOT-BOLT-01').warehouseLocationId,
      'LOC-ID-WIP-01'
    );

    const revNonCoilTrf = makeDoc({
      documentNumber: 'REV-TRF-LOT-BOLT-017',
      documentType: 'REVERSAL',
      reversalOfDocumentId: nonCoilTrfRes.dbDocumentId,
      warehouseId: 'WH-WIP',
      adjustmentReason: 'ابطال انتقال بچ پیچ',
    });
    const revNonCoilRes = await postInventoryDocumentInTransaction(revNonCoilTrf, TEST_USER, { prismaClient: prisma });
    assert.equal(revNonCoilRes.success, true);
    assert.equal(
      prisma.getState().materialLots.find((l: any) => l.id === 'LOT-BOLT-01').warehouseLocationId,
      'LOC-ID-RAW-A1',
      'TRANSFER reversal must restore non-coil MaterialLot.warehouseLocationId to LOC-ID-RAW-A1'
    );
    console.log('  [PASS] 17. TRANSFER reversal restores MaterialLot.warehouseLocationId for both coil-linked and non-coil lots');
  }

  // -----------------------------------------------------------------------
  // TEST 18: Aggregate Coil/Lot Quality Derivation After Partial Issue & Reversal
  // -----------------------------------------------------------------------
  {
    // Create a 2-segment coil (600 kg CNT-A + 400 kg CNT-B)
    const segRec = makeDoc({
      documentNumber: 'REC-AGG-QUAL-018',
      documentType: 'RECEIPT_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      totalQuantity: 1000,
      totalWeightKg: 1000,
      lines: [
        {
          id: 'L1',
          documentId: 'REC-AGG-QUAL-018',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          coilId: 'COIL-AGG-018',
          coilPackNumber: 'CP-AGG-018',
          lotNumber: 'CP-AGG-018',
          materialGrade: 'DC04',
          thicknessMm: 0.8,
          widthMm: 1250,
          ownership: 'SAPCO_SUPPLIER_OWNED',
          locationCode: 'LOC-RAW-A1',
          quantity: 1000,
          unit: 'KG',
          quantityKg: 1000,
          qualityStatus: 'AVAILABLE',
          contractAllocations: [
            { contractId: 'CNT-A', contractNumber: 'SAPCO-1405-A', allocatedWeightKg: 600 },
            { contractId: 'CNT-B', contractNumber: 'SAPCO-1405-B', allocatedWeightKg: 400 },
          ],
        },
      ],
    });
    const segRecRes = await postInventoryDocumentInTransaction(segRec, TEST_USER, { prismaClient: prisma });
    assert.equal(segRecRes.success, true);
    const coil18Id = segRecRes.createdCoilIds![0];

    // Quarantine CNT-B (400 kg) -> CNT-A (600 kg) is still AVAILABLE, so coil/lot remain AVAILABLE
    const qmSegB = makeDoc({
      documentNumber: 'QM-322-SEG-B-018',
      documentType: 'STOCK_STATUS_TRANSFER',
      movementType: '322',
      qmStatusTarget: 'QUALITY_INSPECTION',
      warehouseId: 'WH-RAW',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      totalQuantity: 400,
      totalWeightKg: 400,
      lines: [
        {
          id: 'L1',
          documentId: 'QM-322-SEG-B-018',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          physicalCoilId: coil18Id,
          lotNumber: 'CP-AGG-018',
          ownership: 'SAPCO_SUPPLIER_OWNED',
          contractId: 'CNT-B',
          contractNumber: 'SAPCO-1405-B',
          locationCode: 'LOC-RAW-A1',
          quantity: 400,
          unit: 'KG',
          quantityKg: 400,
          qualityStatus: 'QUARANTINE',
          sourceQualityStatus: 'AVAILABLE',
          targetQualityStatus: 'QUARANTINE',
        },
      ],
    });
    const qmSegBRes = await postInventoryDocumentInTransaction(qmSegB, TEST_USER, { prismaClient: prisma });
    assert.equal(qmSegBRes.success, true);
    assert.equal(prisma.getState().physicalCoils.find((c: any) => c.id === coil18Id).qualityStatus, 'AVAILABLE');

    // Now ISSUE the entire remaining AVAILABLE segment CNT-A (600 kg).
    // Because the only remaining positive stock on coil18Id (400 kg on CNT-B) is QUARANTINE,
    // reconcileCoilWeightDelta & reconcileLotWeightDelta MUST transition coil & lot to QUARANTINE / BLOCKED!
    const issueSegA = makeDoc({
      documentNumber: 'ISS-SEG-A-018',
      documentType: 'ISSUE_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      contractId: 'CNT-A',
      contractNumber: 'SAPCO-1405-A',
      totalQuantity: 600,
      totalWeightKg: 600,
      lines: [
        {
          id: 'L1',
          documentId: 'ISS-SEG-A-018',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          physicalCoilId: coil18Id,
          lotNumber: 'CP-AGG-018',
          ownership: 'SAPCO_SUPPLIER_OWNED',
          contractId: 'CNT-A',
          contractNumber: 'SAPCO-1405-A',
          locationCode: 'LOC-RAW-A1',
          quantity: 600,
          unit: 'KG',
          quantityKg: 600,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const issSegARes = await postInventoryDocumentInTransaction(issueSegA, TEST_USER, { prismaClient: prisma });
    assert.equal(issSegARes.success, true);

    const coilAfterIssueA = prisma.getState().physicalCoils.find((c: any) => c.id === coil18Id);
    const lotAfterIssueA = prisma.getState().materialLots.find((l: any) => l.lotNumber === 'CP-AGG-018');
    assert.equal(Number(coilAfterIssueA.remainingWeightKg), 400);
    assert.equal(
      coilAfterIssueA.qualityStatus,
      'QUARANTINE',
      'Issuing the last AVAILABLE segment must update coil qualityStatus to QUARANTINE when only QUARANTINE stock remains'
    );
    assert.equal(coilAfterIssueA.physicalStatus, 'PARTIALLY_ISSUED');
    assert.equal(
      lotAfterIssueA.status,
      'QUARANTINE',
      'Issuing the last AVAILABLE segment must update MaterialLot.status to QUARANTINE when only QUARANTINE stock remains'
    );

    // Reverse ISS-SEG-A-018 -> 600 kg AVAILABLE is restored, so coil & lot return to AVAILABLE / PARTIALLY_ISSUED
    const revIssueSegA = makeDoc({
      documentNumber: 'REV-ISS-SEG-A-018',
      documentType: 'REVERSAL',
      reversalOfDocumentId: issSegARes.dbDocumentId,
      warehouseId: 'WH-RAW',
      adjustmentReason: 'ابطال حواله بخش آزاد کلاف',
    });
    const revIssARes = await postInventoryDocumentInTransaction(revIssueSegA, TEST_USER, { prismaClient: prisma });
    assert.equal(revIssARes.success, true);
    const coilAfterRevA = prisma.getState().physicalCoils.find((c: any) => c.id === coil18Id);
    const lotAfterRevA = prisma.getState().materialLots.find((l: any) => l.lotNumber === 'CP-AGG-018');
    assert.equal(coilAfterRevA.qualityStatus, 'AVAILABLE');
    assert.equal(coilAfterRevA.physicalStatus, 'AVAILABLE');
    assert.equal(lotAfterRevA.status, 'AVAILABLE');
    console.log('  [PASS] 18. Aggregate coil/lot quality status derives accurately after partial ISSUE & REVERSAL deltas');
  }

  // -----------------------------------------------------------------------
  // TEST 19: DB-Loaded QM & ISSUE_FINISHED_GOODS Semantics Inference
  // -----------------------------------------------------------------------
  {
    // Verify inferDbDocumentSemantics reconstructs STOCK_STATUS_TRANSFER (with movementType & source/target quality)
    // from persisted DB COUNT_ADJUSTMENT + paired ADJUSTMENT_NEG/ADJUSTMENT_POS transactions even without AuditLog
    const qmSem = inferDbDocumentSemantics({
      documentNumber: 'QM-344-9901',
      documentType: 'COUNT_ADJUSTMENT',
      referenceType: 'QM_INSPECTION',
      lines: [{ qualityStatus: 'QUALITY_BLOCKED' }],
      transactions: [
        { transactionType: 'ADJUSTMENT_NEG', qualityStatus: 'AVAILABLE' },
        { transactionType: 'ADJUSTMENT_POS', qualityStatus: 'QUALITY_BLOCKED' },
      ],
    });
    assert.equal(qmSem.documentType, 'STOCK_STATUS_TRANSFER');
    assert.equal(qmSem.movementType, '344');
    assert.equal(qmSem.qmStatusTarget, 'BLOCKED');
    assert.equal(qmSem.sourceQualityStatus, 'AVAILABLE');
    assert.equal(qmSem.targetQualityStatus, 'QUALITY_BLOCKED');

    const issueFgSem = inferDbDocumentSemantics({
      documentNumber: 'OUT-FIN-1403-1122',
      documentType: 'ISSUE',
      lines: [],
      transactions: [],
    });
    assert.equal(issueFgSem.documentType, 'ISSUE_FINISHED_GOODS');
    console.log('  [PASS] 19. DB-loaded QM & ISSUE_FINISHED_GOODS semantics inference preserves exact document types');
  }

  // -----------------------------------------------------------------------
  // TEST 20 (P0-B): Draft Persistence in PostgreSQL & Restart-Safe Draft -> Post Lifecycle
  // -----------------------------------------------------------------------
  {
    const draftDoc = makeDoc({
      id: 'UI-DRAFT-020',
      documentNumber: 'REC-DRAFT-020',
      documentType: 'RECEIPT_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      totalQuantity: 1500,
      totalWeightKg: 1500,
      lines: [
        {
          id: 'L1',
          documentId: 'REC-DRAFT-020',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          coilId: 'COIL-DRAFT-020',
          coilPackNumber: 'CP-DRAFT-020',
          lotNumber: 'CP-DRAFT-020',
          heatNumber: 'HEAT-DRAFT-020',
          materialGrade: 'DC04',
          thicknessMm: 0.8,
          widthMm: 1250,
          ownership: 'SAPCO_SUPPLIER_OWNED',
          locationCode: 'LOC-RAW-A1',
          quantity: 1500,
          unit: 'KG',
          quantityKg: 1500,
          qualityStatus: 'AVAILABLE',
          contractAllocations: [
            { contractId: 'CNT-A', contractNumber: 'SAPCO-1405-A', allocatedWeightKg: 900 },
            { contractId: 'CNT-B', contractNumber: 'SAPCO-1405-B', allocatedWeightKg: 600 },
          ],
        },
      ],
    });

    const trxCountBeforeDraft = prisma.getState().inventoryTransactions.length;
    const draftRes = await saveDraftDocumentInDbTransaction(draftDoc, TEST_USER, {
      prismaClient: prisma,
      idempotencyKey: 'KEY-DRAFT-CREATE-020',
      excludeDocumentNumberFromFingerprint: true,
    });
    assert.equal(draftRes.success, true, `Draft save must succeed: ${draftRes.error}`);
    assert.equal(draftRes.statusCode, 201);
    assert.equal(
      prisma.getState().inventoryTransactions.length,
      trxCountBeforeDraft,
      'Saving an UNPOSTED draft must NEVER write ledger transactions or alter stock balances'
    );

    // 20a. Idempotent replay of draft creation with same key returns 200 without duplicating draft
    const draftReplay = await saveDraftDocumentInDbTransaction(
      { ...structuredClone(draftDoc), documentNumber: 'REC-DRAFT-020-RAND2' },
      TEST_USER,
      {
        prismaClient: prisma,
        idempotencyKey: 'KEY-DRAFT-CREATE-020',
        excludeDocumentNumberFromFingerprint: true,
      }
    );
    assert.equal(draftReplay.success, true);
    assert.equal(draftReplay.idempotentReplay, true);
    assert.equal(draftReplay.statusCode, 200);
    assert.equal(draftReplay.dbDocumentId, draftRes.dbDocumentId);

    // 20b. Same idempotencyKey with tampered draft payload -> 409 IDEMPOTENCY_PAYLOAD_MISMATCH
    const tamperedDraft = structuredClone(draftDoc);
    tamperedDraft.lines[0].quantity = 9999;
    tamperedDraft.lines[0].quantityKg = 9999;
    const draftMismatch = await saveDraftDocumentInDbTransaction(tamperedDraft, TEST_USER, {
      prismaClient: prisma,
      idempotencyKey: 'KEY-DRAFT-CREATE-020',
      excludeDocumentNumberFromFingerprint: true,
    });
    assert.equal(draftMismatch.success, false);
    assert.equal(draftMismatch.statusCode, 409);
    assert.equal(draftMismatch.errorCode, 'IDEMPOTENCY_PAYLOAD_MISMATCH');

    // 20c. Simulate process restart (memDoc = null) and post the persisted draft via resolveDbDocumentPostIdempotency
    const lossyMapper = (dbRow: any, auditSnapshot?: Partial<InventoryDocument> | null): InventoryDocument => {
      if (auditSnapshot && auditSnapshot.id && auditSnapshot.documentNumber && auditSnapshot.lines) {
        return structuredClone(auditSnapshot as InventoryDocument);
      }
      return makeDoc({
        id: dbRow.id,
        documentNumber: dbRow.documentNumber,
        documentType: 'RECEIPT_RAW_MATERIAL',
        postingStatus: dbRow.postingStatus,
        warehouseId: 'WH-RAW',
      });
    };

    const dbDraftRow = await prisma.inventoryDocument.findUnique({
      where: { id: draftRes.dbDocumentId },
      include: { warehouse: true, lines: true, transactions: true },
    });
    assert.ok(dbDraftRow);
    assert.equal(dbDraftRow.postingStatus, 'UNPOSTED');

    const resolvedPost = await resolveDbDocumentPostIdempotency(prisma, {
      id: 'UI-DRAFT-020', // Even by original UI draft ID across restart!
      idempotencyKey: 'KEY-DRAFT-POST-020',
      memDoc: null,
      dbDoc: dbDraftRow,
      mapDbDocFn: lossyMapper,
      postUser: TEST_USER,
    });
    assert.equal(resolvedPost.status, 'POST');
    if (resolvedPost.status === 'POST') {
      assert.equal(
        resolvedPost.docToPost.lines[0].contractAllocations?.length,
        2,
        'DOCUMENT_CREATE AuditLog must preserve multi-contract coil allocations when posting draft after restart'
      );
      const postFromDraftRes = await postInventoryDocumentInTransaction(
        resolvedPost.docToPost,
        TEST_USER,
        {
          prismaClient: prisma,
          idempotencyKey: 'KEY-DRAFT-POST-020',
          sourceDraftId: resolvedPost.sourceDraftId,
        }
      );
      assert.equal(postFromDraftRes.success, true, `Posting persisted draft failed: ${postFromDraftRes.error}`);
      assert.equal(postFromDraftRes.dbDocumentId, draftRes.dbDocumentId, 'Draft row updated in-place to POSTED');
      const postedDbDoc = await prisma.inventoryDocument.findUnique({ where: { id: draftRes.dbDocumentId } });
      assert.equal(postedDbDoc.postingStatus, 'POSTED');
      assert.equal(postedDbDoc.documentStatus, 'CONFIRMED');
    }
    console.log('  [PASS] 20. Draft persistence in PostgreSQL, idempotent replay, and restart-safe draft->post lifecycle');
  }

  // -----------------------------------------------------------------------
  // TEST 21 (P0-B): Whole-Coil QC Hold (322) & Release (321) on Multi-Contract Split Coil
  // -----------------------------------------------------------------------
  {
    const coil20 = prisma.getState().physicalCoils.find((c: any) => c.coilId === 'COIL-DRAFT-020');
    assert.ok(coil20, 'Multi-contract coil COIL-DRAFT-020 must exist from Test 20');

    // Build whole-coil 322 hold (1500 kg across CNT-A 900 kg + CNT-B 600 kg) using only physicalCoilId / key
    const builtHold = await buildQmStatusTransferDocumentFromDb(prisma, {
      key: coil20.id,
      physicalCoilId: coil20.id,
      lotNumber: 'CP-DRAFT-020',
      warehouseId: 'WH-RAW',
      movementType: '322',
      targetQualityStatus: 'QUARANTINE',
      qmTarget: 'QUALITY_INSPECTION',
      heldQty: 1500,
      heldWeightKg: 1500,
      reasonFa: 'قرنطینه کامل کلاف چندقراردادی',
      idempotencyKey: 'KEY-QM-MULTICNT-HOLD-021',
      user: TEST_USER,
    });
    assert.equal(builtHold.success, true, `buildQmStatusTransferDocumentFromDb failed: ${(builtHold as any).error}`);
    if (builtHold.success) {
      assert.equal(builtHold.qmDoc.lines.length, 2, 'Whole-coil QM hold must span both contract segments (900 + 600)');
      const holdPostRes = await postInventoryDocumentInTransaction(builtHold.qmDoc, TEST_USER, {
        prismaClient: prisma,
        idempotencyKey: 'KEY-QM-MULTICNT-HOLD-021',
        excludeDocumentNumberFromFingerprint: true,
      });
      assert.equal(holdPostRes.success, true, `Posting multi-segment QM hold failed: ${holdPostRes.error}`);

      const updatedCoil20 = prisma.getState().physicalCoils.find((c: any) => c.id === coil20.id);
      assert.equal(updatedCoil20.qualityStatus, 'QUARANTINE');
      assert.equal(updatedCoil20.physicalStatus, 'AVAILABLE');
      const updatedLot20 = prisma.getState().materialLots.find((l: any) => l.lotNumber === 'CP-DRAFT-020');
      assert.equal(updatedLot20?.status, 'QUARANTINE');

      // Idempotent retry of whole-coil QM hold after all 1500 kg moved to QUARANTINE
      const retryHoldCheck = await prepareQmTransferRetryInDb(prisma, {
        key: coil20.id,
        physicalCoilId: coil20.id,
        lotNumber: 'CP-DRAFT-020',
        warehouseId: 'WH-RAW',
        movementType: '322',
        targetQualityStatus: 'QUARANTINE',
        heldQty: 1500,
        heldWeightKg: 1500,
        reasonFa: 'قرنطینه کامل کلاف چندقراردادی',
        idempotencyKey: 'KEY-QM-MULTICNT-HOLD-021',
        user: TEST_USER,
      });
      assert.equal(retryHoldCheck.matched, true);
      assert.equal('replayDocument' in retryHoldCheck, true);

      // Now release the whole multi-contract coil back to AVAILABLE (321)
      const builtRelease = await buildQmStatusTransferDocumentFromDb(prisma, {
        key: coil20.id,
        physicalCoilId: coil20.id,
        lotNumber: 'CP-DRAFT-020',
        warehouseId: 'WH-RAW',
        movementType: '321',
        targetQualityStatus: 'AVAILABLE',
        qmTarget: 'UNRESTRICTED',
        heldQty: 1500,
        heldWeightKg: 1500,
        reasonFa: 'آزادسازی کامل کلاف چندقراردادی',
        idempotencyKey: 'KEY-QM-MULTICNT-REL-021',
        user: TEST_USER,
      });
      assert.equal(builtRelease.success, true);
      if (builtRelease.success) {
        assert.equal(builtRelease.qmDoc.lines.length, 2);
        const relPostRes = await postInventoryDocumentInTransaction(builtRelease.qmDoc, TEST_USER, {
          prismaClient: prisma,
          idempotencyKey: 'KEY-QM-MULTICNT-REL-021',
          excludeDocumentNumberFromFingerprint: true,
        });
        assert.equal(relPostRes.success, true);
        const releasedCoil20 = prisma.getState().physicalCoils.find((c: any) => c.id === coil20.id);
        assert.equal(releasedCoil20.qualityStatus, 'AVAILABLE');
        assert.equal(releasedCoil20.physicalStatus, 'AVAILABLE');
      }
    }
    console.log('  [PASS] 21. Whole-coil QC Hold (322) & Release (321) on multi-contract split coil with idempotent retry');
  }

  // -----------------------------------------------------------------------
  // TEST 22 (P0-B): Relational InventoryReservation Lifecycle & Atomic StockBalance CAS
  // -----------------------------------------------------------------------
  {
    const coil20 = prisma.getState().physicalCoils.find((c: any) => c.coilId === 'COIL-DRAFT-020');
    assert.ok(coil20);

    // Reserve 500 kg on CNT-A segment of COIL-DRAFT-020 (which has 900 kg available)
    const resCreate = await createReservationInDbTransaction(prisma, {
      partId: 'PART-SHEET-01',
      warehouseId: 'WH-RAW',
      physicalCoilId: coil20.id,
      contractId: 'CNT-A',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      quantity: 500,
      reservedFor: 'MO-TEST-022',
      idempotencyKey: 'KEY-RES-022',
      user: TEST_USER,
    });
    assert.equal(resCreate.success, true, `Reservation create failed: ${resCreate.error}`);
    assert.equal(resCreate.statusCode, 201);
    assert.ok(resCreate.reservation);

    const sbCntA = prisma
      .getState()
      .stockBalances.find(
        (b: any) => b.physicalCoilId === coil20.id && b.contractId === 'CNT-A' && b.qualityStatus === 'AVAILABLE'
      );
    assert.equal(Number(sbCntA.quantityOnHand), 900);
    assert.equal(Number(sbCntA.quantityReserved), 500, 'StockBalance.quantityReserved must increment by 500');
    assert.equal(Number(sbCntA.quantityAvailable), 400, 'StockBalance.quantityAvailable must decrement to 400');

    // 22a. Idempotent replay of reservation creation
    const resReplay = await createReservationInDbTransaction(prisma, {
      partId: 'PART-SHEET-01',
      warehouseId: 'WH-RAW',
      physicalCoilId: coil20.id,
      contractId: 'CNT-A',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      quantity: 500,
      reservedFor: 'MO-TEST-022',
      idempotencyKey: 'KEY-RES-022',
      user: TEST_USER,
    });
    assert.equal(resReplay.success, true);
    assert.equal(resReplay.idempotentReplay, true);
    assert.equal(resReplay.statusCode, 200);
    assert.equal(Number(sbCntA.quantityReserved), 500, 'Replay must not double-reserve stock');

    // 22b. Attempting to reserve 600 kg on CNT-A (only 400 kg available) must fail with 400 INSUFFICIENT_AVAILABLE_STOCK
    const resOver = await createReservationInDbTransaction(prisma, {
      partId: 'PART-SHEET-01',
      warehouseId: 'WH-RAW',
      physicalCoilId: coil20.id,
      contractId: 'CNT-A',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      quantity: 600,
      reservedFor: 'MO-OVER-022',
      user: TEST_USER,
    });
    assert.equal(resOver.success, false);
    assert.equal(resOver.statusCode, 400);
    assert.equal(resOver.errorCode, 'INSUFFICIENT_AVAILABLE_STOCK');

    // 22c. Release reservation and verify StockBalance.quantityAvailable returns to 900
    const relRes = await releaseReservationInDbTransaction(prisma, resCreate.reservation!.id, {
      user: TEST_USER,
    });
    assert.equal(relRes.success, true, `Reservation release failed: ${relRes.error}`);
    assert.equal(relRes.reservation?.status, 'RELEASED');

    const sbCntAAfterRel = prisma
      .getState()
      .stockBalances.find(
        (b: any) => b.physicalCoilId === coil20.id && b.contractId === 'CNT-A' && b.qualityStatus === 'AVAILABLE'
      );
    assert.equal(Number(sbCntAAfterRel.quantityReserved), 0);
    assert.equal(Number(sbCntAAfterRel.quantityAvailable), 900);

    // 22d. Idempotent repeat release returns 200 idempotentReplay without double-crediting available stock
    const relReplay = await releaseReservationInDbTransaction(prisma, resCreate.reservation!.id, {
      user: TEST_USER,
    });
    assert.equal(relReplay.success, true);
    assert.equal(relReplay.idempotentReplay, true);
    assert.equal(Number(sbCntAAfterRel.quantityAvailable), 900);
    console.log('  [PASS] 22. Relational InventoryReservation create, CAS deduction, overdraft block & idempotent release');
  }

  // -----------------------------------------------------------------------
  // TEST 23 (P0-B): PostgreSQL-Authoritative Read Projections
  // -----------------------------------------------------------------------
  {
    const stockProj = await queryDetailedStockBalancesFromDb(prisma, []);
    assert.ok(stockProj.balances.length > 0, 'queryDetailedStockBalancesFromDb must project StockBalance rows');
    assert.ok(stockProj.metrics.totalPhysicalKg > 0);

    const mapper = (dbRow: any, auditSnapshot?: Partial<InventoryDocument> | null): InventoryDocument =>
      (auditSnapshot && auditSnapshot.id && auditSnapshot.documentNumber && auditSnapshot.lines
        ? (auditSnapshot as InventoryDocument)
        : null) ||
      makeDoc({
        id: dbRow.id,
        documentNumber: dbRow.documentNumber,
        documentType: 'RECEIPT_RAW_MATERIAL',
        postingStatus: dbRow.postingStatus,
        warehouseId: 'WH-RAW',
      });

    const docsProj = await queryInventoryDocumentsFromDb(prisma, mapper);
    assert.ok(docsProj.length > 0, 'queryInventoryDocumentsFromDb must return persisted documents');

    const singleDocProj = await querySingleInventoryDocumentFromDb(prisma, 'REC-DRAFT-020', mapper);
    assert.ok(singleDocProj, 'querySingleInventoryDocumentFromDb must resolve document by number or ID');
    assert.equal(singleDocProj?.documentNumber, 'REC-DRAFT-020');

    const resProj = await queryReservationsFromDb(prisma);
    assert.equal(resProj.length, 1);
    assert.equal(resProj[0].status, 'RELEASED');

    const contractsProj = await queryContractsAndSapcoAccountFromDb(prisma);
    assert.equal(contractsProj.contracts.length, 2);
    const cntA = contractsProj.contracts.find(c => c.id === 'CNT-A');
    assert.ok(cntA);
    assert.ok(cntA.totalReceivedKg > 0, 'Contract received weight must reflect relational ledger transactions');
    assert.ok(contractsProj.ledgerEntries.length > 0, 'Contract ledger entries must project from relational transactions');
    console.log('  [PASS] 23. PostgreSQL-authoritative read projections (stock balances, documents, reservations, contracts)');
  }

  // -----------------------------------------------------------------------
  // TEST 24 (P0-B Review Priority 1): SAPCO Consumption & Closing-Balance From Authoritative Ledger
  // -----------------------------------------------------------------------
  {
    const prisma24 = createMockPrisma();

    // 1. Receive 4,000 kg against SAPCO contract CNT-A
    const rec24 = makeDoc({
      documentNumber: 'REC-SAPCO-024',
      documentType: 'RECEIPT_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      contractId: 'CNT-A',
      contractNumber: 'SAPCO-1405-A',
      referenceNumber: 'WB-SAPCO-024',
      totalQuantity: 4000,
      totalWeightKg: 4000,
      lines: [
        {
          id: 'L-REC-024',
          documentId: 'REC-SAPCO-024',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          coilId: 'COIL-SAPCO-024',
          coilPackNumber: 'CP-SAPCO-024',
          lotNumber: 'CP-SAPCO-024',
          heatNumber: 'HN-024',
          materialGrade: 'DC04',
          thicknessMm: 0.8,
          widthMm: 1250,
          ownership: 'SAPCO_SUPPLIER_OWNED',
          contractId: 'CNT-A',
          contractNumber: 'SAPCO-1405-A',
          locationCode: 'LOC-RAW-A1',
          quantity: 4000,
          unit: 'KG',
          quantityKg: 4000,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const r24 = await postInventoryDocumentInTransaction(rec24, TEST_USER, { prismaClient: prisma24 });
    assert.equal(r24.success, true, `Receipt 24 failed: ${r24.error}`);
    const coil24DbId = r24.createdCoilIds![0];

    // 2. Consume 1,500 kg against CNT-A via ISSUE_RAW_MATERIAL
    const iss24 = makeDoc({
      documentNumber: 'ISS-SAPCO-024',
      documentType: 'ISSUE_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      contractId: 'CNT-A',
      contractNumber: 'SAPCO-1405-A',
      referenceNumber: 'MO-SAPCO-024',
      totalQuantity: 1500,
      totalWeightKg: 1500,
      lines: [
        {
          id: 'L-ISS-024',
          documentId: 'ISS-SAPCO-024',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          physicalCoilId: coil24DbId,
          coilId: 'COIL-SAPCO-024',
          coilPackNumber: 'CP-SAPCO-024',
          lotNumber: 'CP-SAPCO-024',
          ownership: 'SAPCO_SUPPLIER_OWNED',
          contractId: 'CNT-A',
          contractNumber: 'SAPCO-1405-A',
          locationCode: 'LOC-RAW-A1',
          quantity: 1500,
          unit: 'KG',
          quantityKg: 1500,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const i24 = await postInventoryDocumentInTransaction(iss24, TEST_USER, { prismaClient: prisma24 });
    assert.equal(i24.success, true, `Issue 24 failed: ${i24.error}`);

    const sapcoAfterIssue = await queryContractsAndSapcoAccountFromDb(prisma24);
    const cntAAfterIssue = sapcoAfterIssue.contracts.find(c => c.id === 'CNT-A');
    assert.ok(cntAAfterIssue);
    assert.equal(cntAAfterIssue.totalReceivedKg, 4000, 'totalReceivedKg must equal 4000 kg');
    assert.equal(cntAAfterIssue.totalConsumedKg, 1500, 'totalConsumedKg must equal 1500 kg after issue');
    assert.equal(cntAAfterIssue.closingBalanceKg, 2500, 'closingBalanceKg must equal 2500 kg after issue');

    const cntALedger = sapcoAfterIssue.ledgerEntries.filter(e => e.contractId === 'CNT-A');
    assert.equal(cntALedger.length, 2, 'Ledger must contain both RECEIPT and CONSUMPTION entries');
    const consumptionEntry = cntALedger.find(e => e.operationType === 'CONSUMPTION');
    assert.ok(consumptionEntry, 'CONSUMPTION ledger entry must be present');
    assert.equal(consumptionEntry.weightKgSigned, -1500);
    assert.equal(consumptionEntry.runningBalanceKg, 2500);

    // 3. Return 300 kg remnant from production line and verify totalConsumedKg decreases to 1,200 kg and closingBalanceKg rises to 2,800 kg
    const ret24 = await returnPhysicalCoilRemnantInDbTransaction(prisma24, {
      coilIdOrCode: 'COIL-SAPCO-024',
      returnedWeightKg: 300,
      varianceWeightKg: 50,
      idempotencyKey: 'KEY-RET-024',
      user: TEST_USER,
    });
    assert.equal(ret24.success, true, `Return 24 failed: ${ret24.error}`);

    const sapcoAfterReturn = await queryContractsAndSapcoAccountFromDb(prisma24);
    const cntAAfterReturn = sapcoAfterReturn.contracts.find(c => c.id === 'CNT-A');
    assert.ok(cntAAfterReturn);
    assert.equal(cntAAfterReturn.totalReceivedKg, 4000);
    assert.equal(cntAAfterReturn.totalConsumedKg, 1200, 'Production remnant return must reduce totalConsumedKg from 1500 to 1200');
    assert.equal(cntAAfterReturn.closingBalanceKg, 2800, 'Production remnant return must increase closingBalanceKg from 2500 to 2800');
    console.log('  [PASS] 24. SAPCO contract consumption, production remnant return, closingBalanceKg & ledgerEntries from authoritative InventoryTransaction rows');
  }

  // -----------------------------------------------------------------------
  // TEST 25 (P0-B Review Priority 2): QM Transfer Resolution — Key-Only 404, Multi-Lot Ambiguity 409 & Key-Only Whole-Coil Multi-Contract Transfer
  // -----------------------------------------------------------------------
  {
    const prisma25 = createMockPrisma();

    // Receive a multi-contract split coil (1000 kg = 600 kg CNT-A + 400 kg CNT-B)
    const splitDoc25 = makeDoc({
      documentNumber: 'REC-SPLIT-025',
      documentType: 'RECEIPT_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      totalQuantity: 1000,
      totalWeightKg: 1000,
      lines: [
        {
          id: 'L-SPLIT-025',
          documentId: 'REC-SPLIT-025',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          coilId: 'COIL-SPLIT-025',
          coilPackNumber: 'CP-SPLIT-025',
          lotNumber: 'CP-SPLIT-025',
          materialGrade: 'DC04',
          thicknessMm: 0.8,
          widthMm: 1250,
          ownership: 'SAPCO_SUPPLIER_OWNED',
          locationCode: 'LOC-RAW-A1',
          quantity: 1000,
          unit: 'KG',
          quantityKg: 1000,
          qualityStatus: 'AVAILABLE',
          contractAllocations: [
            { contractId: 'CNT-A', contractNumber: 'SAPCO-1405-A', allocatedWeightKg: 600 },
            { contractId: 'CNT-B', contractNumber: 'SAPCO-1405-B', allocatedWeightKg: 400 },
          ],
        },
      ],
    });
    const splitRes25 = await postInventoryDocumentInTransaction(splitDoc25, TEST_USER, { prismaClient: prisma25 });
    assert.equal(splitRes25.success, true);
    const splitCoilDbId = splitRes25.createdCoilIds![0];

    // 25a. Empty selector request must fail with 400 INVALID_QM_TARGET
    const emptyQm = await buildQmStatusTransferDocumentFromDb(prisma25, {
      movementType: '322',
      targetQualityStatus: 'QUARANTINE',
      qmTarget: 'QUALITY_INSPECTION',
      user: TEST_USER,
    });
    assert.equal(emptyQm.success, false);
    if (!emptyQm.success) {
      assert.equal(emptyQm.statusCode, 400);
      assert.equal(emptyQm.errorCode, 'INVALID_QM_TARGET');
    }

    // 25b. Unknown key-only request must return 404 (never fall back to an unfiltered findMany that grabs an arbitrary row)
    const unknownKeyQm = await buildQmStatusTransferDocumentFromDb(prisma25, {
      key: 'NON-EXISTENT-KEY-99999',
      movementType: '322',
      targetQualityStatus: 'QUARANTINE',
      qmTarget: 'QUALITY_INSPECTION',
      user: TEST_USER,
    });
    assert.equal(unknownKeyQm.success, false);
    if (!unknownKeyQm.success) {
      assert.equal(unknownKeyQm.statusCode, 404);
    }

    // 25c. Ambiguous partId-only request matching multiple distinct non-coil stock buckets (SB-BOLT-01 + SB-NULL-KEYS-01) must fail with 409 AMBIGUOUS_QM_TARGET
    const ambigQm = await buildQmStatusTransferDocumentFromDb(prisma25, {
      partId: 'PART-BOLT-01',
      warehouseId: 'WH-RAW',
      movementType: '322',
      targetQualityStatus: 'QUARANTINE',
      qmTarget: 'QUALITY_INSPECTION',
      heldQty: 50,
      user: TEST_USER,
    });
    assert.equal(ambigQm.success, false);
    if (!ambigQm.success) {
      assert.equal(ambigQm.statusCode, 409);
      assert.equal(ambigQm.errorCode, 'AMBIGUOUS_QM_TARGET');
    }

    // 25d. Key-only request where key === physicalCoil.id of a multi-contract split coil (no contractId injected) must resolve BOTH contract segments (600 + 400)
    const keyOnlyMultiCoilQm = await buildQmStatusTransferDocumentFromDb(prisma25, {
      key: splitCoilDbId,
      movementType: '322',
      targetQualityStatus: 'QUARANTINE',
      qmTarget: 'QUALITY_INSPECTION',
      heldQty: 1000,
      heldWeightKg: 1000,
      idempotencyKey: 'KEY-QM-KEYONLY-025',
      user: TEST_USER,
    });
    assert.equal(keyOnlyMultiCoilQm.success, true, `Key-only whole-coil multi-contract QM failed: ${(keyOnlyMultiCoilQm as any).error}`);
    if (keyOnlyMultiCoilQm.success) {
      assert.equal(keyOnlyMultiCoilQm.qmDoc.lines.length, 2, 'Key-only whole-coil QM transfer must build 2 lines across CNT-A and CNT-B');
      const totalLineKg = keyOnlyMultiCoilQm.qmDoc.lines.reduce((s, l) => s + Number(l.quantityKg || 0), 0);
      assert.equal(totalLineKg, 1000);
    }
    console.log('  [PASS] 25. QM transfer resolution rejects empty (400), unknown key-only (404), ambiguous multi-bucket (409), and resolves key-only whole-coil multi-contract transfers');
  }

  // -----------------------------------------------------------------------
  // TEST 26 (P0-B Review Priority 3): PostgreSQL-Authoritative Coil Contract Reallocation, Quota Guards & Idempotency
  // -----------------------------------------------------------------------
  {
    const prisma26 = createMockPrisma();

    // Receive an unallocated / single-contract coil (2,000 kg on CNT-A)
    const rec26 = makeDoc({
      documentNumber: 'REC-ALLOC-026',
      documentType: 'RECEIPT_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      contractId: 'CNT-A',
      contractNumber: 'SAPCO-1405-A',
      totalQuantity: 2000,
      totalWeightKg: 2000,
      lines: [
        {
          id: 'L-ALLOC-026',
          documentId: 'REC-ALLOC-026',
          lineNumber: 1,
          partId: 'PART-SHEET-01',
          partCode: 'RM-DC04-08',
          partName: 'ورق فولادی DC04 ضخامت 0.8',
          coilId: 'COIL-ALLOC-026',
          coilPackNumber: 'CP-ALLOC-026',
          lotNumber: 'CP-ALLOC-026',
          materialGrade: 'DC04',
          thicknessMm: 0.8,
          widthMm: 1250,
          ownership: 'SAPCO_SUPPLIER_OWNED',
          contractId: 'CNT-A',
          contractNumber: 'SAPCO-1405-A',
          locationCode: 'LOC-RAW-A1',
          quantity: 2000,
          unit: 'KG',
          quantityKg: 2000,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const r26 = await postInventoryDocumentInTransaction(rec26, TEST_USER, { prismaClient: prisma26 });
    assert.equal(r26.success, true);
    const coil26Id = r26.createdCoilIds![0];

    // 26a. Reallocate 2,000 kg coil across CNT-A (1,200 kg) and CNT-B (800 kg)
    const reallocRes = await reallocatePhysicalCoilContractsInDbTransaction(prisma26, {
      coilIdOrCode: 'COIL-ALLOC-026',
      mode: 'REPLACE_ALL',
      allocations: [
        { contractId: 'CNT-A', allocatedWeightKg: 1200, notes: 'سهم قرارداد الف' },
        { contractId: 'CNT-B', allocatedWeightKg: 800, notes: 'سهم قرارداد ب' },
      ],
      idempotencyKey: 'KEY-REALLOC-026',
      user: TEST_USER,
    });
    assert.equal(reallocRes.success, true, `Reallocation failed: ${reallocRes.error}`);
    assert.equal(reallocRes.idempotentReplay, false);
    assert.equal(reallocRes.normalizedAllocations?.length, 2);

    const cntA26 = prisma26.getState().materialContracts.find((c: any) => c.id === 'CNT-A');
    const cntB26 = prisma26.getState().materialContracts.find((c: any) => c.id === 'CNT-B');
    assert.equal(Number(cntA26.receivedWeightKg), 1200, 'CNT-A quota must be adjusted from 2000 to 1200 kg');
    assert.equal(Number(cntB26.receivedWeightKg), 800, 'CNT-B quota must be incremented to 800 kg');

    const coilBalances26 = prisma26
      .getState()
      .stockBalances.filter((b: any) => b.physicalCoilId === coil26Id);
    assert.equal(coilBalances26.length, 2, 'StockBalance must be re-segmented into 2 contract rows');
    assert.equal(
      coilBalances26.reduce((s: number, b: any) => s + Number(b.weightKgOnHand), 0),
      2000,
      'Total coil stock balance weight must remain conserved at 2000 kg'
    );

    // 26b. Idempotent replay with same key & payload returns 200 idempotentReplay: true without duplicating transactions
    const txCountBeforeReplay = prisma26.getState().inventoryTransactions.length;
    const reallocReplay = await reallocatePhysicalCoilContractsInDbTransaction(prisma26, {
      coilIdOrCode: 'COIL-ALLOC-026',
      mode: 'REPLACE_ALL',
      allocations: [
        { contractId: 'CNT-A', allocatedWeightKg: 1200, notes: 'سهم قرارداد الف' },
        { contractId: 'CNT-B', allocatedWeightKg: 800, notes: 'سهم قرارداد ب' },
      ],
      idempotencyKey: 'KEY-REALLOC-026',
      user: TEST_USER,
    });
    assert.equal(reallocReplay.success, true);
    assert.equal(reallocReplay.idempotentReplay, true);
    assert.equal(prisma26.getState().inventoryTransactions.length, txCountBeforeReplay);

    // 26c. Reusing the same idempotencyKey with a mutated allocation payload fails with 409 IDEMPOTENCY_PAYLOAD_MISMATCH
    const reallocMismatch = await reallocatePhysicalCoilContractsInDbTransaction(prisma26, {
      coilIdOrCode: 'COIL-ALLOC-026',
      mode: 'REPLACE_ALL',
      allocations: [{ contractId: 'CNT-A', allocatedWeightKg: 1500 }],
      idempotencyKey: 'KEY-REALLOC-026',
      user: TEST_USER,
    });
    assert.equal(reallocMismatch.success, false);
    assert.equal(reallocMismatch.statusCode, 409);
    assert.equal(reallocMismatch.errorCode, 'IDEMPOTENCY_PAYLOAD_MISMATCH');

    // 26d. Attempting to allocate more than coil remaining weight fails with 422 ALLOCATION_EXCEEDS_COIL_WEIGHT
    const overCoilRes = await reallocatePhysicalCoilContractsInDbTransaction(prisma26, {
      coilIdOrCode: 'COIL-ALLOC-026',
      mode: 'UPSERT_SINGLE_CONTRACT',
      singleContractId: 'CNT-B',
      singleAllocatedWeightKg: 1500, // 1200 existing on CNT-A + 1500 on CNT-B = 2700 > 2000
      user: TEST_USER,
    });
    assert.equal(overCoilRes.success, false);
    assert.equal(overCoilRes.statusCode, 422);
    assert.equal(overCoilRes.errorCode, 'ALLOCATION_EXCEEDS_COIL_WEIGHT');
    console.log('  [PASS] 26. PostgreSQL-authoritative coil contract reallocation, StockBalance re-segmentation, quota CAS & idempotency');
  }

  // -----------------------------------------------------------------------
  // TEST 27 (P0-B Review Priority 4): postedDocumentsCount Accuracy & Stage/Transaction Read Projections
  // -----------------------------------------------------------------------
  {
    // Save an UNPOSTED draft into prisma and verify postedDocumentsCount only counts POSTED documents (not transactions or drafts)
    const draft27 = makeDoc({
      id: 'DRAFT-COUNT-027',
      documentNumber: 'DRF-CNT-027',
      documentType: 'RECEIPT_FINISHED_GOODS',
      warehouseId: 'WH-RAW',
      ownership: 'COMPANY_OWNED',
      totalQuantity: 10,
      totalWeightKg: 10,
      lines: [
        {
          id: 'L-DRF-027',
          documentId: 'DRAFT-COUNT-027',
          lineNumber: 1,
          partId: 'PART-BOLT-01',
          partCode: 'RM-BOLT-M8',
          partName: 'پیچ M8 گالوانیزه',
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-RAW-A1',
          quantity: 10,
          unit: 'PCS',
          quantityKg: 10,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });
    const saved27 = await saveDraftDocumentInDbTransaction(draft27, TEST_USER, { prismaClient: prisma });
    assert.equal(saved27.success, true);

    const expectedPostedDocs = prisma
      .getState()
      .inventoryDocuments.filter((d: any) => d.postingStatus === 'POSTED').length;
    const expectedDraftDocs = prisma
      .getState()
      .inventoryDocuments.filter((d: any) => d.postingStatus === 'UNPOSTED').length;
    const totalTransactions = prisma.getState().inventoryTransactions.length;
    assert.ok(
      totalTransactions > expectedPostedDocs,
      'Multi-line/transfer/QM documents produce more transactions than posted documents'
    );

    const stockProj27 = await queryDetailedStockBalancesFromDb(prisma, []);
    assert.equal(
      stockProj27.metrics.postedDocumentsCount,
      expectedPostedDocs,
      'postedDocumentsCount must equal POSTED InventoryDocument count, not InventoryTransaction count'
    );
    assert.equal(
      stockProj27.metrics.draftDocumentsCount,
      expectedDraftDocs,
      'draftDocumentsCount must equal UNPOSTED InventoryDocument count'
    );

    const stageSummary27 = await queryStageInventorySummaryFromDb(prisma, []);
    assert.ok(stageSummary27.stageBalances.length > 0, 'queryStageInventorySummaryFromDb must return stage balances');
    assert.ok(stageSummary27.rawMaterialKg > 0, 'queryStageInventorySummaryFromDb must aggregate rawMaterialKg');

    const txs27 = await queryInventoryTransactionsFromDb(prisma, { voucherType: 'RECEIPT' });
    assert.ok(txs27.length > 0, 'queryInventoryTransactionsFromDb must project relational transactions');
    assert.ok(txs27.every(t => t.voucherType === 'RECEIPT'));
    console.log('  [PASS] 27. postedDocumentsCount counts POSTED documents (not transactions) & stage/transaction read projections');
  }

  // -----------------------------------------------------------------------
  // TEST 28 (P0-B Review Priority 5): Draft-to-Post Idempotency With Server-Generated documentNumber
  // -----------------------------------------------------------------------
  {
    const serverGenDraftId = 'DOC-SRVGEN-028';
    const sharedIdemKey = 'KEY-DRAFT-SRVGEN-028';
    const serverGenDocNumber = 'DOC-1405-SRV999';

    const draftDoc28 = makeDoc({
      id: serverGenDraftId,
      documentNumber: serverGenDocNumber,
      documentType: 'RECEIPT_FINISHED_GOODS',
      warehouseId: 'WH-RAW',
      ownership: 'COMPANY_OWNED',
      totalQuantity: 25,
      totalWeightKg: 25,
      lines: [
        {
          id: 'L-SRVGEN-028',
          documentId: serverGenDraftId,
          lineNumber: 1,
          partId: 'PART-BOLT-01',
          partCode: 'RM-BOLT-M8',
          partName: 'پیچ M8 گالوانیزه',
          ownership: 'COMPANY_OWNED',
          locationCode: 'LOC-RAW-A1',
          quantity: 25,
          unit: 'PCS',
          quantityKg: 25,
          qualityStatus: 'AVAILABLE',
        },
      ],
    });

    // 1. Save draft with excludeDocumentNumberFromFingerprint: true (simulating POST /api/inventory/documents with server-generated documentNumber)
    const draftSave28 = await saveDraftDocumentInDbTransaction(draftDoc28, TEST_USER, {
      prismaClient: prisma,
      idempotencyKey: sharedIdemKey,
      excludeDocumentNumberFromFingerprint: true,
    });
    assert.equal(draftSave28.success, true, `Draft save 28 failed: ${draftSave28.error}`);

    // 2. Resolve draft post after simulated restart (memDoc = null) using the same idempotencyKey
    const dbDraft28 = await prisma.inventoryDocument.findUnique({
      where: { id: draftSave28.dbDocumentId },
      include: {
        warehouse: true,
        lines: { include: { part: true, unit: true, location: true } },
        transactions: true,
      },
    });
    const mapper28 = (dbRow: any, auditSnap?: Partial<InventoryDocument> | null): InventoryDocument =>
      (auditSnap as InventoryDocument) ||
      makeDoc({ id: dbRow.id, documentNumber: dbRow.documentNumber });

    const resolved28 = await resolveDbDocumentPostIdempotency(prisma, {
      id: draftSave28.dbDocumentId!,
      idempotencyKey: sharedIdemKey,
      memDoc: null,
      dbDoc: dbDraft28,
      mapDbDocFn: mapper28,
      postUser: TEST_USER,
    });
    assert.equal(resolved28.status, 'POST');
    if (resolved28.status === 'POST') {
      assert.equal(
        resolved28.excludeDocumentNumberFromFingerprint,
        true,
        'resolveDbDocumentPostIdempotency must recover excludeDocumentNumberFromFingerprint from DOCUMENT_CREATE AuditLog'
      );

      // 3. Post the draft reusing the draft's idempotencyKey (even if caller does not pass excludeDocumentNumberFromFingerprint, matchesStoredFingerprint must accept it)
      const post28 = await postInventoryDocumentInTransaction(resolved28.docToPost, TEST_USER, {
        prismaClient: prisma,
        idempotencyKey: sharedIdemKey,
        sourceDraftId: resolved28.sourceDraftId,
        excludeDocumentNumberFromFingerprint: resolved28.excludeDocumentNumberFromFingerprint,
      });
      assert.equal(post28.success, true, `Posting draft with server-generated docNumber failed: ${post28.error}`);
      assert.equal(post28.idempotentReplay, false);

      // 4. Replay post with same key must return idempotentReplay: true
      const replayPost28 = await postInventoryDocumentInTransaction(resolved28.docToPost, TEST_USER, {
        prismaClient: prisma,
        idempotencyKey: sharedIdemKey,
      });
      assert.equal(replayPost28.success, true, `Replay of posted server-gen draft failed: ${replayPost28.error}`);
      assert.equal(replayPost28.idempotentReplay, true);

      // 5. Mutated payload with same key must still fail with 409 IDEMPOTENCY_PAYLOAD_MISMATCH
      const mutatedDoc28: InventoryDocument = {
        ...resolved28.docToPost,
        totalQuantity: 999,
        lines: [{ ...resolved28.docToPost.lines[0], quantity: 999, quantityKg: 999 }],
      };
      const mutatedPost28 = await postInventoryDocumentInTransaction(mutatedDoc28, TEST_USER, {
        prismaClient: prisma,
        idempotencyKey: sharedIdemKey,
      });
      assert.equal(mutatedPost28.success, false);
      assert.equal(mutatedPost28.statusCode, 409);
      assert.equal(mutatedPost28.errorCode, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
    }
    console.log('  [PASS] 28. Draft-to-post idempotency fingerprint consistency when documentNumber is server-generated');
  }

  console.log('\nALL 28 P0-A & P0-B HARDENING REGRESSION SUITES PASSED (0 live DB writes).');
}

run().catch(err => {
  console.error('P0-A/P0-B REGRESSION TEST FAILED:', err);
  process.exit(1);
});
