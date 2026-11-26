/**
 * =========================================================================
 * KPIMS P3: Shop-Floor Production Execution & Control Regression Suite
 * =========================================================================
 * Strictly isolated relational mock + fallback HTTP verification (ZERO live PG).
 * Run with: DATABASE_URL="" npx tsx scripts/test-kpims-p3-shop-floor.ts
 * =========================================================================
 */

import assert from 'node:assert/strict';
import express from 'express';
import {
  __setProductionWipPrismaForTests,
  registerOperationInputDb,
} from '../src/server/services/productionWipService';
import { apiRouter } from '../src/server/apiRouter';

if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '') {
  throw new Error('Refusing to run isolated P3 test suite when DATABASE_URL is configured.');
}

let seq = 1;
const uid = (prefix: string) => `${prefix}-${seq++}`;
const num = (v: any) => Number(v ?? 0);

type Store = {
  role: any[];
  user: any[];
  unitOfMeasure: any[];
  warehouse: any[];
  warehouseLocation: any[];
  material: any[];
  part: any[];
  item: any[];
  bomComponent: any[];
  operation: any[];
  partRoute: any[];
  routeOperation: any[];
  machine: any[];
  machineCapability: any[];
  die: any[];
  machineDieCompatibility: any[];
  shift: any[];
  productionPlan: any[];
  productionPlanLine: any[];
  manufacturingOrder: any[];
  productionOperation: any[];
  machineAssignment: any[];
  productionReport: any[];
  productionScrap: any[];
  productionTransfer: any[];
  productionActivityLog: any[];
  coilIssueReturnRecord: any[];
  physicalCoil: any[];
  materialLot: any[];
  stockBalance: any[];
  inventoryDocument: any[];
  inventoryDocumentLine: any[];
  inventoryTransaction: any[];
  inventoryReservation: any[];
  auditLog: any[];
};

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

function matchesWhere(table: keyof Store, row: any, where: any, store: Store): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (k === 'OR' && Array.isArray(cond)) {
      if (!cond.some(sub => matchesWhere(table, row, sub, store))) return false;
      continue;
    }
    if (k === 'AND' && Array.isArray(cond)) {
      if (!cond.every(sub => matchesWhere(table, row, sub, store))) return false;
      continue;
    }
    if (k === 'part' && typeof cond === 'object' && cond !== null) {
      const p = store.part.find(r => r.id === row.partId);
      if (!p || !matchesWhere('part', p, (cond as any).is ?? cond, store)) return false;
      continue;
    }
    if (k === 'warehouse' && typeof cond === 'object' && cond !== null) {
      const w = store.warehouse.find(r => r.id === row.warehouseId);
      if (!w || !matchesWhere('warehouse', w, (cond as any).is ?? cond, store)) return false;
      continue;
    }
    if (k.includes('_') && typeof cond === 'object' && cond !== null) {
      if (!matchesWhere(table, row, cond, store)) return false;
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

function hydrate(table: keyof Store, row: any, include: any, store: Store): any {
  if (!row) return null;
  const out: any = { ...row };
  if (!include) return out;

  if (table === 'part') {
    if (include.unit) out.unit = store.unitOfMeasure.find(u => u.id === row.unitId) || null;
    if (include.material) out.material = store.material.find(m => m.id === row.materialId) || null;
  } else if (table === 'warehouse') {
    if (include.locations) {
      let locs = store.warehouseLocation.filter(l => l.warehouseId === row.id);
      if (include.locations?.where) {
        locs = locs.filter(l => matchesWhere('warehouseLocation', l, include.locations.where, store));
      }
      out.locations = locs;
    }
  } else if (table === 'warehouseLocation') {
    if (include.warehouse) out.warehouse = store.warehouse.find(w => w.id === row.warehouseId) || null;
  } else if (table === 'machine') {
    if (include.capabilities) {
      let caps = store.machineCapability.filter(c => c.machineId === row.id);
      if (include.capabilities.where) caps = caps.filter(c => matchesWhere('machineCapability', c, include.capabilities.where, store));
      out.capabilities = caps.map(c => ({
        ...c,
        operation: store.operation.find(o => o.id === c.operationId) || null,
      }));
    }
    if (include.dieCompatibilities) {
      out.dieCompatibilities = store.machineDieCompatibility.filter(dc => dc.machineId === row.id);
    }
  } else if (table === 'manufacturingOrder') {
    if (include.part) out.part = hydrate('part', store.part.find(p => p.id === row.partId), subSpec(include.part), store);
    if (include.plan) out.plan = store.productionPlan.find(p => p.id === row.planId) || null;
    if (include.planLine) out.planLine = store.productionPlanLine.find(pl => pl.id === row.planLineId) || null;
    if (include.coilIssueReturnRecords) {
      out.coilIssueReturnRecords = store.coilIssueReturnRecord.filter(r => r.manufacturingOrderId === row.id);
    }
    if (include.operations) {
      const ops = store.productionOperation
        .filter(o => o.manufacturingOrderId === row.id)
        .sort((a, b) => (a.sequence ?? a.stepNumber) - (b.sequence ?? b.stepNumber) || a.stepNumber - b.stepNumber);
      out.operations = ops.map(o => hydrate('productionOperation', o, subSpec(include.operations), store));
    }
    if (include.transfers) {
      out.transfers = store.productionTransfer.filter(t => t.manufacturingOrderId === row.id);
    }
    if (include.productionReports) {
      out.productionReports = store.productionReport.filter(r => r.manufacturingOrderId === row.id);
    }
  } else if (table === 'productionOperation') {
    if (include.operation) out.operation = store.operation.find(o => o.id === row.operationId) || null;
    if (include.plannedMachine) out.plannedMachine = store.machine.find(m => m.id === row.plannedMachineId) || null;
    if (include.plannedDie) out.plannedDie = store.die.find(d => d.id === row.plannedDieId) || null;
    if (include.routeOperation) out.routeOperation = store.routeOperation.find(r => r.id === row.routeOperationId) || null;
    if (include.warehouse) out.warehouse = store.warehouse.find(w => w.id === row.warehouseId) || null;
    if (include.location) out.location = store.warehouseLocation.find(l => l.id === row.locationId) || null;
    if (include.manufacturingOrder) {
      out.manufacturingOrder = hydrate(
        'manufacturingOrder',
        store.manufacturingOrder.find(m => m.id === row.manufacturingOrderId),
        subSpec(include.manufacturingOrder),
        store,
      );
    }
    if (include.assignments) {
      out.assignments = store.machineAssignment
        .filter(a => a.productionOperationId === row.id)
        .map(a => hydrate('machineAssignment', a, subSpec(include.assignments), store));
    }
  } else if (table === 'machineAssignment') {
    if (include.machine) out.machine = store.machine.find(m => m.id === row.machineId) || null;
    if (include.shift) out.shift = store.shift.find(s => s.id === row.shiftId) || null;
    if (include.assignedOperator) out.assignedOperator = store.user.find(u => u.id === row.assignedOperatorId) || null;
  } else if (table === 'productionReport') {
    if (include.manufacturingOrder) {
      out.manufacturingOrder = hydrate(
        'manufacturingOrder',
        store.manufacturingOrder.find(m => m.id === row.manufacturingOrderId),
        subSpec(include.manufacturingOrder),
        store,
      );
    }
    if (include.productionOperation) {
      out.productionOperation = store.productionOperation.find(o => o.id === row.productionOperationId) || null;
    }
    if (include.machine) out.machine = store.machine.find(m => m.id === row.machineId) || null;
    if (include.shift) out.shift = store.shift.find(s => s.id === row.shiftId) || null;
    if (include.operatorUser) out.operatorUser = store.user.find(u => u.id === row.operatorUserId) || null;
  } else if (table === 'productionTransfer') {
    if (include.fromOperation) out.fromOperation = store.productionOperation.find(o => o.id === row.fromOperationId) || null;
    if (include.toOperation) out.toOperation = store.productionOperation.find(o => o.id === row.toOperationId) || null;
    if (include.fromLocation) out.fromLocation = store.warehouseLocation.find(l => l.id === row.fromLocationId) || null;
    if (include.toLocation) out.toLocation = store.warehouseLocation.find(l => l.id === row.toLocationId) || null;
  } else if (table === 'bomComponent') {
    if (include.childItem) out.childItem = store.item.find(i => i.id === row.childItemId) || null;
  } else if (table === 'stockBalance') {
    if (include.part) out.part = hydrate('part', store.part.find(p => p.id === row.partId), subSpec(include.part), store);
    if (include.warehouse) out.warehouse = store.warehouse.find(w => w.id === row.warehouseId) || null;
    if (include.location) out.location = store.warehouseLocation.find(l => l.id === row.locationId) || null;
  }

  return out;
}

function sortRows(rows: any[], orderBy: any): any[] {
  if (!orderBy) return rows;
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const c of clauses) {
      const [k, dir] = Object.entries(c)[0] as [string, string];
      const av = a[k] instanceof Date ? a[k].getTime() : a[k];
      const bv = b[k] instanceof Date ? b[k].getTime() : b[k];
      if (av === bv) continue;
      if (av == null) return dir === 'desc' ? 1 : -1;
      if (bv == null) return dir === 'desc' ? -1 : 1;
      return (av > bv ? 1 : -1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

function createMockPrisma(store: Store) {
  const delegateFor = (table: keyof Store) => ({
    async findMany(args: any = {}) {
      let rows = store[table].filter(r => matchesWhere(table, r, args.where, store));
      if (args.orderBy) rows = sortRows(rows, args.orderBy);
      if (args.take) rows = rows.slice(0, args.take);
      return rows.map(r => hydrate(table, r, args.include || args.select, store));
    },
    async findFirst(args: any = {}) {
      const rows = await this.findMany({ ...args, take: 1 });
      return rows[0] || null;
    },
    async findUnique(args: any = {}) {
      return this.findFirst(args);
    },
    async count(args: any = {}) {
      return store[table].filter(r => matchesWhere(table, r, args.where, store)).length;
    },
    async create(args: any) {
      const d = { ...(args.data || {}) };
      if (table === 'productionReport' && d.wipIdempotencyKey) {
        if (store.productionReport.some(r => r.wipIdempotencyKey === d.wipIdempotencyKey)) {
          const e: any = new Error('Unique wipIdempotencyKey violation');
          e.code = 'P2002';
          throw e;
        }
      }
      if (table === 'inventoryDocument' && d.idempotencyKey) {
        if (store.inventoryDocument.some(r => r.idempotencyKey === d.idempotencyKey)) {
          const e: any = new Error('Unique idempotencyKey violation');
          e.code = 'P2002';
          throw e;
        }
      }

      const rec: any = {
        id: d.id || uid(table.slice(0, 4).toUpperCase()),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...d,
      };
      if (table === 'productionOperation' && rec.version == null) rec.version = 1;
      if (table === 'manufacturingOrder' && rec.version == null) rec.version = 1;
      if (table === 'coilIssueReturnRecord' && rec.version == null) rec.version = 1;

      if (table === 'inventoryDocument' && d.lines?.create) {
        const linesCreate = d.lines.create;
        delete rec.lines;
        store.inventoryDocument.push(rec);
        for (const ln of linesCreate) {
          store.inventoryDocumentLine.push({
            id: uid('DOCLN'),
            documentId: rec.id,
            createdAt: new Date(),
            ...ln,
          });
        }
        return hydrate(table, rec, args.include, store);
      }

      store[table].push(rec);
      return hydrate(table, rec, args.include || args.select, store);
    },
    async update(args: any) {
      const idx = store[table].findIndex(r => matchesWhere(table, r, args.where, store));
      if (idx === -1) throw new Error(`Not found in ${table}`);
      store[table][idx] = applyUpdateData(store[table][idx], args.data || {});
      return hydrate(table, store[table][idx], args.include || args.select, store);
    },
    async updateMany(args: any) {
      let count = 0;
      store[table] = store[table].map(r => {
        if (matchesWhere(table, r, args.where, store)) {
          count += 1;
          return applyUpdateData(r, args.data || {});
        }
        return r;
      });
      return { count };
    },
    async upsert(args: any) {
      const flatWhere = Object.entries(args.where || {}).reduce((acc: any, [k, v]) => {
        if (k.includes('_') && typeof v === 'object' && v !== null) Object.assign(acc, v);
        else acc[k] = v;
        return acc;
      }, {});
      const idx = store[table].findIndex(r => matchesWhere(table, r, flatWhere, store));
      if (idx >= 0) {
        store[table][idx] = applyUpdateData(store[table][idx], args.update || {});
        return hydrate(table, store[table][idx], args.include, store);
      }
      return this.create({ data: args.create, include: args.include });
    },
  });

  const client: any = {};
  const tables: (keyof Store)[] = [
    'role',
    'user',
    'unitOfMeasure',
    'warehouse',
    'warehouseLocation',
    'material',
    'part',
    'item',
    'bomComponent',
    'operation',
    'partRoute',
    'routeOperation',
    'machine',
    'machineCapability',
    'die',
    'machineDieCompatibility',
    'shift',
    'productionPlan',
    'productionPlanLine',
    'manufacturingOrder',
    'productionOperation',
    'machineAssignment',
    'productionReport',
    'productionScrap',
    'productionTransfer',
    'productionActivityLog',
    'coilIssueReturnRecord',
    'physicalCoil',
    'materialLot',
    'stockBalance',
    'inventoryDocument',
    'inventoryDocumentLine',
    'inventoryTransaction',
    'inventoryReservation',
    'auditLog',
  ];
  for (const t of tables) client[t] = delegateFor(t);

  client.$transaction = async (fn: any) => {
    const snapshot = structuredClone(store);
    try {
      return await fn(client);
    } catch (err) {
      for (const k of Object.keys(store) as (keyof Store)[]) {
        (store as any)[k] = snapshot[k];
      }
      throw err;
    }
  };
  return client;
}

function buildSeedStore(): Store {
  const planStart = new Date('2026-12-01T00:00:00Z');
  const planEnd = new Date('2026-12-07T00:00:00Z');
  return {
    role: [{ id: 'ROLE-OP', code: 'OPERATOR', name: 'اپراتور تولید' }],
    user: [
      { id: 'USR-OP1', username: 'op1', fullName: 'حسین رضایی', personnelCode: 'EMP-101', active: true, roleId: 'ROLE-OP' },
      { id: 'USR-SUP1', username: 'sup1', fullName: 'مهندس محمدی', personnelCode: 'SUP-01', active: true, roleId: 'ROLE-OP' },
    ],
    unitOfMeasure: [{ id: 'UOM-PCS', code: 'PCS', name: 'عدد' }],
    warehouse: [
      { id: 'WH-WIP-PRESS', code: 'WH-WIP-PRESS', name: 'انبار پای خط پرس', type: 'WIP', active: true },
      { id: 'WH-FINISHED', code: 'WH-FINISHED', name: 'انبار محصول نهایی', type: 'FINISHED_GOODS', active: true },
      { id: 'WH-SCRAP', code: 'WH-SCRAP', name: 'انبار ضایعات', type: 'SCRAP', active: true },
    ],
    warehouseLocation: [
      { id: 'LOC-PRS-01', warehouseId: 'WH-WIP-PRESS', code: 'LOC-WIP-PRS-01', name: 'ایستگاه پرس ۱', active: true },
      { id: 'LOC-PRS-02', warehouseId: 'WH-WIP-PRESS', code: 'LOC-WIP-PRS-02', name: 'ایستگاه پرس ۲', active: true },
      { id: 'LOC-FIN-01', warehouseId: 'WH-FINISHED', code: 'LOC-FIN-P1', name: 'محصول نهایی ردیف ۱', active: true },
      { id: 'LOC-SCRAP-01', warehouseId: 'WH-SCRAP', code: 'LOC-SCRAP-01', name: 'قفس ضایعات', active: true },
    ],
    material: [{ id: 'MAT-DC01', code: 'DC01A', name: 'ورق روغنی DC01A' }],
    part: [
      {
        id: 'PRT-BRK-01',
        partNumber: '700014',
        name: 'براکت اصلی ضدسرقت ECU',
        category: 'FINISHED_GOOD',
        thicknessMm: 2.0,
        weightGrossKg: 1.0,
        weightNetKg: 0.9,
        unitId: 'UOM-PCS',
        materialId: 'MAT-DC01',
        active: true,
      },
    ],
    item: [{ id: 'ITM-BRK-01', code: '700014', name: 'براکت اصلی ضدسرقت ECU', itemType: 'FINISHED_GOOD' }],
    bomComponent: [],
    operation: [
      { id: 'OPER-BLANK', code: 'BLANKING', name: 'بلنکینگ', processType: 'BLANKING', defaultSequence: 10 },
      { id: 'OPER-BEND', code: 'BENDING', name: 'خم‌کاری', processType: 'BENDING', defaultSequence: 20 },
    ],
    partRoute: [{ id: 'RT-BRK-01', partId: 'PRT-BRK-01', routeCode: 'RT-700014', active: true }],
    routeOperation: [
      {
        id: 'RO-10',
        routeId: 'RT-BRK-01',
        operationId: 'OPER-BLANK',
        stepNumber: 10,
        requiredTonnage: 200,
        standardCycleTimeSec: 12,
      },
      {
        id: 'RO-20',
        routeId: 'RT-BRK-01',
        operationId: 'OPER-BEND',
        stepNumber: 20,
        requiredTonnage: 150,
        standardCycleTimeSec: 15,
      },
    ],
    machine: [
      {
        id: 'MCH-PRS-250',
        code: 'PRS-250-01',
        name: 'پرس مکانیکی ۲۵۰ تن',
        hallLocation: 'سالن پرس سنگین',
        machineType: 'PRESS_250T',
        tonnageCapacity: 250,
        status: 'ACTIVE',
        active: true,
      },
      {
        id: 'MCH-PRS-80-LOW',
        code: 'PRS-80-01',
        name: 'پرس سبک ۸۰ تن',
        hallLocation: 'سالن پرس سبک',
        machineType: 'PRESS_80T',
        tonnageCapacity: 80,
        status: 'ACTIVE',
        active: true,
      },
    ],
    machineCapability: [
      { id: 'CAP-1', machineId: 'MCH-PRS-250', operationId: 'OPER-BLANK', minThicknessMm: 0.8, maxThicknessMm: 3.0, maxTonnage: 250, isPreferred: true },
      { id: 'CAP-2', machineId: 'MCH-PRS-250', operationId: 'OPER-BEND', minThicknessMm: 0.8, maxThicknessMm: 3.0, maxTonnage: 250, isPreferred: true },
      { id: 'CAP-3', machineId: 'MCH-PRS-80-LOW', operationId: 'OPER-BEND', minThicknessMm: 0.5, maxThicknessMm: 2.5, maxTonnage: 80, isPreferred: false },
    ],
    die: [
      { id: 'DIE-BLK-01', code: 'DIE-BLK-700014', name: 'قالب بلنک ۷۰۰۰۱۴', tonnageRequired: 180 },
      { id: 'DIE-BND-01', code: 'DIE-BND-700014', name: 'قالب خم ۷۰۰۰۱۴', tonnageRequired: 120 },
    ],
    machineDieCompatibility: [
      { id: 'MDC-1', machineId: 'MCH-PRS-250', dieId: 'DIE-BLK-01' },
      { id: 'MDC-2', machineId: 'MCH-PRS-250', dieId: 'DIE-BND-01' },
    ],
    shift: [
      { id: 'SH-MORN', code: 'MORNING', name: 'شیفت صبح', startTime: '07:00', endTime: '15:00', productiveHours: 7.5, active: true },
      { id: 'SH-EVE', code: 'EVENING', name: 'شیفت عصر', startTime: '15:00', endTime: '23:00', productiveHours: 7.5, active: true },
    ],
    productionPlan: [
      {
        id: 'PLAN-REL-1',
        planNumber: 'PLN-1405-001',
        title: 'برنامه هفتگی ابلاغ‌شده براکت ECU',
        status: 'RELEASED',
        startDate: planStart,
        endDate: planEnd,
      },
    ],
    productionPlanLine: [
      {
        id: 'PLNL-1',
        planId: 'PLAN-REL-1',
        partId: 'PRT-BRK-01',
        plannedQty: 100,
        producedQty: 0,
        plannedStartDate: planStart,
        plannedEndDate: planEnd,
        status: 'RELEASED',
      },
    ],
    manufacturingOrder: [
      {
        id: 'MO-SF-1',
        moNumber: 'MO-1405-SF01',
        partId: 'PRT-BRK-01',
        planId: 'PLAN-REL-1',
        planLineId: 'PLNL-1',
        targetQty: 100,
        initialInputQty: 100,
        completedQty: 0,
        scrapQty: 0,
        totalReworkQty: 0,
        totalRejectedQty: 0,
        status: 'RELEASED',
        priority: 3,
        scheduledStartDate: planStart,
        scheduledEndDate: planEnd,
        actualStartDate: null,
        actualEndDate: null,
        createdAt: planStart,
        updatedAt: planStart,
        version: 1,
      },
    ],
    productionOperation: [
      {
        id: 'OP-SF-10',
        manufacturingOrderId: 'MO-SF-1',
        operationId: 'OPER-BLANK',
        routeOperationId: 'RO-10',
        stepNumber: 10,
        sequence: 1,
        stepCode: 'OP10',
        stepName: 'بلنکینگ ورق DC01A',
        plannedMachineId: 'MCH-PRS-250',
        plannedDieId: 'DIE-BLK-01',
        warehouseId: 'WH-WIP-PRESS',
        locationId: 'LOC-PRS-01',
        plannedQty: 100,
        waitingInputQty: 100,
        inProgressQty: 0,
        inputQty: 0,
        outputGoodQty: 0,
        outputScrapQty: 0,
        outputReworkQty: 0,
        outputRejectedQty: 0,
        readyForTransferQty: 0,
        transferredQty: 0,
        status: 'READY',
        startDate: planStart,
        endDate: null,
        lastActivityAt: null,
        createdAt: planStart,
        updatedAt: planStart,
        version: 1,
      },
      {
        id: 'OP-SF-20',
        manufacturingOrderId: 'MO-SF-1',
        operationId: 'OPER-BEND',
        routeOperationId: 'RO-20',
        stepNumber: 20,
        sequence: 2,
        stepCode: 'OP20',
        stepName: 'خم‌کاری نهایی',
        plannedMachineId: 'MCH-PRS-250',
        plannedDieId: 'DIE-BND-01',
        warehouseId: 'WH-WIP-PRESS',
        locationId: 'LOC-PRS-02',
        plannedQty: 100,
        waitingInputQty: 0,
        inProgressQty: 0,
        inputQty: 0,
        outputGoodQty: 0,
        outputScrapQty: 0,
        outputReworkQty: 0,
        outputRejectedQty: 0,
        readyForTransferQty: 0,
        transferredQty: 0,
        status: 'PENDING',
        startDate: planStart,
        endDate: null,
        lastActivityAt: null,
        createdAt: planStart,
        updatedAt: planStart,
        version: 1,
      },
    ],
    machineAssignment: [
      {
        id: 'ASG-10',
        machineId: 'MCH-PRS-250',
        productionOperationId: 'OP-SF-10',
        shiftId: 'SH-MORN',
        assignedDate: planStart,
        assignedOperatorId: 'USR-OP1',
        status: 'SCHEDULED',
      },
      {
        id: 'ASG-20',
        machineId: 'MCH-PRS-250',
        productionOperationId: 'OP-SF-20',
        shiftId: 'SH-EVE',
        assignedDate: planStart,
        assignedOperatorId: 'USR-OP1',
        status: 'SCHEDULED',
      },
    ],
    productionReport: [],
    productionScrap: [],
    productionTransfer: [],
    productionActivityLog: [],
    coilIssueReturnRecord: [
      {
        id: 'CIR-1',
        coilId: 'COIL-1',
        manufacturingOrderId: 'MO-SF-1',
        productionOperationId: 'OP-SF-10',
        issuedWeightKg: 200,
        returnedWeightKg: 0,
        consumedWeightKg: 0,
        varianceWeightKg: 0,
        outstandingWeightKg: 200,
        issuedAt: planStart,
        version: 1,
      },
    ],
    physicalCoil: [
      {
        id: 'COIL-1',
        coilId: 'COIL-SF-001',
        materialId: 'MAT-DC01',
        materialLotId: 'LOT-SF-1',
        heatNumber: 'HT-SF-01',
        remainingWeightKg: 0,
        physicalStatus: 'ISSUED',
        qualityStatus: 'AVAILABLE',
        version: 1,
      },
    ],
    materialLot: [
      {
        id: 'LOT-SF-1',
        lotNumber: 'LOT-SF-001',
        materialId: 'MAT-DC01',
        initialWeightKg: 200,
        remainingWeightKg: 200,
        status: 'AVAILABLE',
        warehouseLocationId: 'LOC-PRS-01',
      },
    ],
    stockBalance: [
      {
        id: 'SB-SF-OP10',
        partId: 'PRT-BRK-01',
        warehouseId: 'WH-WIP-PRESS',
        locationId: 'LOC-PRS-01',
        materialLotId: 'LOT-SF-1',
        physicalCoilId: 'COIL-1',
        ownership: 'COMPANY_OWNED',
        contractId: null,
        contractNumber: null,
        qualityStatus: 'AVAILABLE',
        quantityOnHand: 100,
        quantityReserved: 0,
        quantityAvailable: 100,
        weightKgOnHand: 100,
        weightKgReserved: 0,
        weightKgAvailable: 100,
        version: 1,
      },
    ],
    inventoryDocument: [],
    inventoryDocumentLine: [],
    inventoryTransaction: [
      {
        id: 'TX-SF-INIT',
        manufacturingOrderId: 'MO-SF-1',
        partId: 'PRT-BRK-01',
        warehouseId: 'WH-WIP-PRESS',
        locationId: 'LOC-PRS-01',
        materialLotId: 'LOT-SF-1',
        physicalCoilId: 'COIL-1',
        ownership: 'COMPANY_OWNED',
        contractId: null,
        qualityStatus: 'AVAILABLE',
        postingStatus: 'POSTED',
        quantitySigned: 100,
        weightKgSigned: 100,
        transactionDate: planStart,
      },
    ],
    inventoryReservation: [],
    auditLog: [],
  };
}

async function reqJson(baseUrl: string, path: string, method = 'GET', body?: any) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function run() {
  const store = buildSeedStore();
  const mockPrisma = createMockPrisma(store);

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);

  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address() as any;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    (global as any).__kpimsDbReachable = true;
    process.env.DATABASE_URL = 'postgresql://mock:mock@127.0.0.1:5432/mock';
    __setProductionWipPrismaForTests(mockPrisma);

    console.log('1) Testing Shop-Floor Board projection from Released Plan & MachineAssignment...');
    const board1 = await reqJson(baseUrl, '/api/shop-floor/execution-board');
    assert.equal(board1.status, 200);
    assert.equal(board1.json.source, 'postgresql');
    assert.equal(board1.json.workOrders.length, 1);
    assert.equal(board1.json.workOrders[0].planNumber, 'PLN-1405-001');
    assert.equal(board1.json.workOrders[0].totalOutstandingMaterialKg, 200);
    const qOp10 = board1.json.operationsQueue.find((o: any) => o.id === 'OP-SF-10');
    const qOp20 = board1.json.operationsQueue.find((o: any) => o.id === 'OP-SF-20');
    assert.equal(qOp10.canStart, true);
    assert.equal(qOp10.assignmentStatus, 'SCHEDULED');
    assert.equal(qOp10.outstandingMaterialKg, 200);
    assert.equal(qOp20.predecessorBlocked, true);
    assert.equal(qOp20.canStart, false);

    console.log('2) Testing Sequence Lock & Machine Eligibility Guards...');
    const outOfOrder = await reqJson(baseUrl, '/api/shop-floor/operations/OP-SF-20/start', 'POST', {
      idempotencyKey: 'START-OP20-PRE-CHECK',
      machineId: 'MCH-PRS-250',
      shiftId: 'SH-EVE',
    });
    assert.equal(outOfOrder.status, 409, 'OP20 must be blocked before OP10 produces or transfers WIP');

    const badMachine = await reqJson(baseUrl, '/api/shop-floor/operations/OP-SF-10/start', 'POST', {
      idempotencyKey: 'START-OP10-BAD-MCH',
      machineId: 'MCH-PRS-80-LOW',
      shiftId: 'SH-MORN',
    });
    assert.equal(badMachine.status, 400, 'Ineligible tonnage/capability machine must be rejected');

    console.log('3) Testing Start -> Pause -> Guarded Report/Input -> Resume + Idempotency...');
    const startRes = await reqJson(baseUrl, '/api/shop-floor/operations/OP-SF-10/start', 'POST', {
      idempotencyKey: 'START-OP10-KEY-01',
      machineId: 'MCH-PRS-250',
      shiftId: 'SH-MORN',
      operatorUserId: 'USR-OP1',
    });
    assert.equal(startRes.status, 200);
    assert.equal(startRes.json.executionState, 'IN_PROGRESS');
    assert.equal(store.productionOperation[0].waitingInputQty, 0);
    assert.equal(store.productionOperation[0].inProgressQty, 100);
    assert.equal(store.machineAssignment[0].status, 'ACTIVE');
    assert.equal(store.productionPlanLine[0].status, 'IN_PROGRESS');

    const startReplay = await reqJson(baseUrl, '/api/shop-floor/operations/OP-SF-10/start', 'POST', {
      idempotencyKey: 'START-OP10-KEY-01',
      machineId: 'MCH-PRS-250',
      shiftId: 'SH-MORN',
    });
    assert.equal(startReplay.status, 200);
    assert.equal(startReplay.json.duplicate, true);

    const startCrossOpConflict = await reqJson(baseUrl, '/api/shop-floor/operations/OP-SF-20/start', 'POST', {
      idempotencyKey: 'START-OP10-KEY-01',
      machineId: 'MCH-PRS-250',
    });
    assert.equal(startCrossOpConflict.status, 409);

    const pauseMissingReason = await reqJson(baseUrl, '/api/shop-floor/operations/OP-SF-10/pause', 'POST', {
      idempotencyKey: 'PAUSE-BAD-REASON-1',
      reason: '   ',
    });
    assert.equal(pauseMissingReason.status, 400);

    const pauseRes = await reqJson(baseUrl, '/api/shop-floor/operations/OP-SF-10/pause', 'POST', {
      idempotencyKey: 'PAUSE-OP10-KEY-01',
      reason: 'تنظیم مجدد کورس قالب',
      isDowntime: true,
      operatorUserId: 'USR-OP1',
    });
    assert.equal(pauseRes.status, 200);
    assert.equal(pauseRes.json.executionState, 'PAUSED');

    // While PAUSED, both production report and registerOperationInputDb must be blocked (409)
    const reportWhilePaused = await reqJson(baseUrl, '/api/shop-floor/operations/OP-SF-10/report', 'POST', {
      idempotencyKey: 'RPT-WHILE-PAUSED-01',
      shiftId: 'SH-MORN',
      machineId: 'MCH-PRS-250',
      goodQty: 10,
      scrapQty: 0,
    });
    assert.equal(reportWhilePaused.status, 409);

    await assert.rejects(
      () =>
        registerOperationInputDb({
          moId: 'MO-SF-1',
          operationId: 'OP-SF-10',
          quantity: 1,
        }),
      (err: any) => err?.statusCode === 409,
    );

    const resumeRes = await reqJson(baseUrl, '/api/shop-floor/operations/OP-SF-10/resume', 'POST', {
      idempotencyKey: 'RESUME-OP10-KEY-01',
      machineId: 'MCH-PRS-250',
      shiftId: 'SH-MORN',
      downtimeMinutesOverride: 12,
    });
    assert.equal(resumeRes.status, 200);
    assert.equal(resumeRes.json.executionState, 'IN_PROGRESS');
    assert.equal(resumeRes.json.loggedDowntimeMinutes, 12);

    console.log('4) Testing Material Consumption Settlement, Overproduction/Over-consume Rejections & Report Idempotency...');
    const overConsume = await reqJson(baseUrl, '/api/shop-floor/operations/OP-SF-10/report', 'POST', {
      idempotencyKey: 'RPT-OVERCONSUME-01',
      shiftId: 'SH-MORN',
      machineId: 'MCH-PRS-250',
      goodQty: 50,
      scrapQty: 0,
      actualMaterialConsumedKg: 250, // > 200 outstanding
    });
    assert.equal(overConsume.status, 409, 'Consuming more coil weight than outstanding must fail with 409');

    const overProduce = await reqJson(baseUrl, '/api/shop-floor/operations/OP-SF-10/report', 'POST', {
      idempotencyKey: 'RPT-OVERPRODUCE-01',
      shiftId: 'SH-MORN',
      machineId: 'MCH-PRS-250',
      goodQty: 105, // > plannedQty 100
      scrapQty: 0,
    });
    assert.equal(overProduce.status, 409, 'Producing beyond plannedQty without supervisor override must fail');

    const rpt1 = await reqJson(baseUrl, '/api/shop-floor/operations/OP-SF-10/report', 'POST', {
      idempotencyKey: 'RPT-OP10-BATCH-01',
      shiftId: 'SH-MORN',
      machineId: 'MCH-PRS-250',
      operatorUserId: 'USR-OP1',
      goodQty: 60,
      scrapQty: 5,
      scrapReason: 'پارگی لبه ورق',
      actualMaterialConsumedKg: 65,
      runTimeMinutes: 90,
      downtimeMinutes: 15,
      downtimeReason: 'تنظیم گیج تغذیه',
      strokeCounterStart: 1000,
      strokeCounterEnd: 1065,
    });
    assert.equal(rpt1.status, 201, `rpt1 failed: ${JSON.stringify(rpt1.json)}`);
    // P1 coil settlement split: 60 good -> consumedWeightKg=60, 5 scrap -> varianceWeightKg=5 (total settled 65kg, outstanding 135kg)
    assert.equal(store.coilIssueReturnRecord[0].consumedWeightKg, 60);
    assert.equal(store.coilIssueReturnRecord[0].varianceWeightKg, 5);
    assert.equal(
      store.coilIssueReturnRecord[0].consumedWeightKg + store.coilIssueReturnRecord[0].varianceWeightKg,
      65,
    );
    assert.equal(store.coilIssueReturnRecord[0].outstandingWeightKg, 135);
    assert.equal(store.productionOperation[0].outputGoodQty, 60);
    assert.equal(store.productionOperation[0].outputScrapQty, 5);
    assert.equal(store.productionOperation[0].inProgressQty, 35);
    // Auto-transfer moves 60 good immediately into OP-SF-20 waitingInputQty
    assert.equal(store.productionOperation[0].readyForTransferQty, 0);
    assert.equal(store.productionOperation[1].waitingInputQty, 60);

    // Released plan plannedQty and dates MUST NEVER be mutated by execution
    assert.equal(store.productionPlanLine[0].plannedQty, 100);
    assert.equal(store.productionPlanLine[0].plannedStartDate.toISOString(), new Date('2026-12-01T00:00:00Z').toISOString());
    assert.equal(store.productionPlanLine[0].plannedEndDate.toISOString(), new Date('2026-12-07T00:00:00Z').toISOString());

    // Exact replay returns 200 duplicate without double-posting coil or WIP
    const rpt1Replay = await reqJson(baseUrl, '/api/shop-floor/operations/OP-SF-10/report', 'POST', {
      idempotencyKey: 'RPT-OP10-BATCH-01',
      shiftId: 'SH-MORN',
      machineId: 'MCH-PRS-250',
      goodQty: 60,
      scrapQty: 5,
      scrapReason: 'پارگی لبه ورق',
      actualMaterialConsumedKg: 65,
      runTimeMinutes: 90,
      downtimeMinutes: 15,
      downtimeReason: 'تنظیم گیج تغذیه',
    });
    assert.equal(rpt1Replay.status, 200);
    assert.equal(rpt1Replay.json.duplicate, true);
    assert.equal(store.coilIssueReturnRecord[0].consumedWeightKg, 60);
    assert.equal(store.coilIssueReturnRecord[0].outstandingWeightKg, 135);

    // Same key with changed actualMaterialConsumedKg returns 409
    const rpt1Conflict = await reqJson(baseUrl, '/api/shop-floor/operations/OP-SF-10/report', 'POST', {
      idempotencyKey: 'RPT-OP10-BATCH-01',
      shiftId: 'SH-MORN',
      machineId: 'MCH-PRS-250',
      goodQty: 60,
      scrapQty: 5,
      scrapReason: 'پارگی لبه ورق',
      actualMaterialConsumedKg: 70,
      runTimeMinutes: 90,
      downtimeMinutes: 15,
      downtimeReason: 'تنظیم گیج تغذیه',
    });
    assert.equal(rpt1Conflict.status, 409);

    // Reusing same idempotency key across a DIFFERENT operation returns 409
    const rptCrossOpConflict = await reqJson(baseUrl, '/api/shop-floor/operations/OP-SF-20/report', 'POST', {
      idempotencyKey: 'RPT-OP10-BATCH-01',
      shiftId: 'SH-MORN',
      machineId: 'MCH-PRS-250',
      goodQty: 60,
      scrapQty: 5,
      scrapReason: 'پارگی لبه ورق',
      actualMaterialConsumedKg: 65,
      runTimeMinutes: 90,
      downtimeMinutes: 15,
      downtimeReason: 'تنظیم گیج تغذیه',
    });
    assert.equal(rptCrossOpConflict.status, 409);

    console.log('5) Testing Complete Guard, Auto-Transfer -> OP20 -> Explicit Completion...');
    const prematureComplete = await reqJson(baseUrl, '/api/shop-floor/operations/OP-SF-10/complete', 'POST', {
      idempotencyKey: 'COMP-OP10-EARLY',
    });
    assert.equal(prematureComplete.status, 409, 'Cannot complete OP10 while inProgressQty > 0');

    // Finish remaining 35 good units on OP10 + consume remaining 35kg coil (explicit completion stays IN_PROGRESS)
    const rpt2 = await reqJson(baseUrl, '/api/shop-floor/operations/OP-SF-10/report', 'POST', {
      idempotencyKey: 'RPT-OP10-BATCH-02',
      shiftId: 'SH-MORN',
      machineId: 'MCH-PRS-250',
      operatorUserId: 'USR-OP1',
      goodQty: 35,
      scrapQty: 0,
      actualMaterialConsumedKg: 35,
      runTimeMinutes: 45,
    });
    assert.equal(rpt2.status, 201, `rpt2 failed: ${JSON.stringify(rpt2.json)}`);
    assert.equal(store.productionOperation[0].inProgressQty, 0);
    assert.equal(store.productionOperation[0].status, 'IN_PROGRESS', 'Shop-floor report keeps OP IN_PROGRESS for explicit Complete');
    assert.equal(store.productionOperation[0].readyForTransferQty, 0);
    assert.equal(store.productionOperation[1].waitingInputQty, 95);
    assert(
      store.productionTransfer.filter((t: any) => t.status === 'AUTO_TRANSFERRED').length >= 2,
      'Auto-transfer records must exist for OP10 -> OP20',
    );
    assert.equal(store.coilIssueReturnRecord[0].consumedWeightKg, 95);
    assert.equal(store.coilIssueReturnRecord[0].varianceWeightKg, 5);
    assert.equal(store.coilIssueReturnRecord[0].outstandingWeightKg, 100);

    // Complete OP10 explicitly now that all WIP is drained
    const comp10 = await reqJson(baseUrl, '/api/shop-floor/operations/OP-SF-10/complete', 'POST', {
      idempotencyKey: 'COMP-OP10-FINAL',
      operatorUserId: 'USR-OP1',
    });
    assert.equal(comp10.status, 200, `comp10 failed: ${JSON.stringify(comp10.json)}`);
    assert.equal(comp10.json.executionState, 'COMPLETED');
    assert.equal(store.productionOperation[0].status, 'COMPLETED');
    assert.equal(store.machineAssignment[0].status, 'COMPLETED');

    // Replay complete OP10 idempotently
    const comp10Replay = await reqJson(baseUrl, '/api/shop-floor/operations/OP-SF-10/complete', 'POST', {
      idempotencyKey: 'COMP-OP10-FINAL',
      operatorUserId: 'USR-OP1',
    });
    assert.equal(comp10Replay.status, 200);
    assert.equal(comp10Replay.json.duplicate, true);

    // Start OP20, report 95 good, then explicitly complete OP20
    const start20 = await reqJson(baseUrl, '/api/shop-floor/operations/OP-SF-20/start', 'POST', {
      idempotencyKey: 'START-OP20-KEY-01',
      machineId: 'MCH-PRS-250',
      shiftId: 'SH-EVE',
      operatorUserId: 'USR-OP1',
    });
    assert.equal(start20.status, 200);
    assert.equal(store.productionOperation[1].inProgressQty, 95);

    const rpt20 = await reqJson(baseUrl, '/api/shop-floor/operations/OP-SF-20/report', 'POST', {
      idempotencyKey: 'RPT-OP20-BATCH-01',
      shiftId: 'SH-EVE',
      machineId: 'MCH-PRS-250',
      operatorUserId: 'USR-OP1',
      goodQty: 95,
      scrapQty: 0,
      runTimeMinutes: 90,
    });
    assert.equal(rpt20.status, 201, `rpt20 failed: ${JSON.stringify(rpt20.json)}`);
    assert.equal(store.manufacturingOrder[0].completedQty, 95);
    assert.equal(store.productionPlanLine[0].producedQty, 95);
    assert.equal(store.productionPlanLine[0].plannedQty, 100, 'Plan targetQty must never change during execution');
    assert.equal(store.productionOperation[1].status, 'IN_PROGRESS');

    const comp20 = await reqJson(baseUrl, '/api/shop-floor/operations/OP-SF-20/complete', 'POST', {
      idempotencyKey: 'COMP-OP20-FINAL',
    });
    assert.equal(comp20.status, 200, `comp20 failed: ${JSON.stringify(comp20.json)}`);
    assert.equal(store.productionOperation[1].status, 'COMPLETED');
    assert.equal(store.machineAssignment[1].status, 'COMPLETED');

    console.log('6) Testing Standalone Downtime, Machine Breakdown & Non-Double-Counted Supervisor KPIs...');
    const dtRes = await reqJson(baseUrl, '/api/shop-floor/downtime', 'POST', {
      idempotencyKey: 'DT-STANDALONE-01',
      machineId: 'MCH-PRS-250',
      shiftId: 'SH-EVE',
      productionOperationId: 'OP-SF-20',
      reason: 'خرابی جک کلاچ پرس',
      durationMinutes: 20,
      markMachineBreakdown: true,
      operatorUserId: 'USR-OP1',
    });
    assert.equal(dtRes.status, 201);
    assert.equal(dtRes.json.data.machineStatus, 'BREAKDOWN');
    assert.equal(store.machine[0].status, 'BREAKDOWN');

    const dtReplay = await reqJson(baseUrl, '/api/shop-floor/downtime', 'POST', {
      idempotencyKey: 'DT-STANDALONE-01',
      machineId: 'MCH-PRS-250',
      reason: 'خرابی جک کلاچ پرس',
      durationMinutes: 20,
    });
    assert.equal(dtReplay.status, 200);
    assert.equal(dtReplay.json.duplicate, true);

    const dtConflict = await reqJson(baseUrl, '/api/shop-floor/downtime', 'POST', {
      idempotencyKey: 'DT-STANDALONE-01',
      machineId: 'MCH-PRS-250',
      reason: 'خرابی جک کلاچ پرس',
      durationMinutes: 45,
    });
    assert.equal(dtConflict.status, 409);

    const boardFinal = await reqJson(baseUrl, '/api/shop-floor/execution-board');
    assert.equal(boardFinal.status, 200);
    const kpis = boardFinal.json.kpis;
    assert.equal(kpis.totalPlannedQty, 100);
    assert.equal(kpis.totalActualGoodQty, 95);
    assert.equal(kpis.totalScrapQty, 5);
    assert.equal(kpis.overallCompletionPercent, 95);
    assert.equal(kpis.scrapRatePercent, 5);
    assert.equal(kpis.totalRunTimeMinutes, 225); // 90 + 45 + 90
    // Downtime: 12 (pause/resume) + 15 (inline report) + 20 (standalone linked) = 47, ZERO double counting!
    assert.equal(kpis.totalDowntimeMinutes, 47);
    assert.equal(boardFinal.json.downtimeEvents.length, 3);
    assert(kpis.machineUtilizationPercent > 0);
    assert(kpis.downtimeByReason.some((r: any) => r.reason === 'خرابی جک کلاچ پرس' && r.minutes === 20));

    console.log('7) Testing Non-DB Fallback Parity Mode (DATABASE_URL="" + __kpimsDbReachable=false)...');
    (global as any).__kpimsDbReachable = false;
    process.env.DATABASE_URL = '';
    __setProductionWipPrismaForTests(null);

    const fbBoard = await reqJson(baseUrl, '/api/shop-floor/execution-board');
    assert.equal(fbBoard.status, 200);
    assert.equal(fbBoard.json.source, 'memory-fallback');
    assert(fbBoard.json.operationsQueue.length > 0);
    const fbOp =
      fbBoard.json.operationsQueue.find((o: any) => o.canStart) ||
      fbBoard.json.operationsQueue[0];
    assert(fbOp, 'Fallback queue should expose at least one operation');

    if (fbOp.canStart) {
      const fbStart = await reqJson(
        baseUrl,
        `/api/shop-floor/operations/${encodeURIComponent(fbOp.id)}/start`,
        'POST',
        {
          idempotencyKey: 'FB-START-KEY-01',
          machineId: fbOp.machineId || fbOp.eligibleMachineIds[0],
        },
      );
      assert.equal(fbStart.status, 200);
      assert.equal(fbStart.json.executionState, 'IN_PROGRESS');

      const fbPause = await reqJson(
        baseUrl,
        `/api/shop-floor/operations/${encodeURIComponent(fbOp.id)}/pause`,
        'POST',
        { idempotencyKey: 'FB-PAUSE-KEY-01', reason: 'بررسی نمونه اول', isDowntime: true },
      );
      assert.equal(fbPause.status, 200);
      assert.equal(fbPause.json.executionState, 'PAUSED');

      const fbBlocked = await reqJson(
        baseUrl,
        `/api/shop-floor/operations/${encodeURIComponent(fbOp.id)}/report`,
        'POST',
        {
          idempotencyKey: 'FB-RPT-PAUSED-01',
          shiftId: fbBoard.json.masterData.shifts[0].id,
          goodQty: 1,
          scrapQty: 0,
        },
      );
      assert.equal(fbBlocked.status, 409);

      const fbResume = await reqJson(
        baseUrl,
        `/api/shop-floor/operations/${encodeURIComponent(fbOp.id)}/resume`,
        'POST',
        { idempotencyKey: 'FB-RESUME-KEY-01', downtimeMinutesOverride: 8 },
      );
      assert.equal(fbResume.status, 200);
      assert.equal(fbResume.json.loggedDowntimeMinutes, 8);

      // Test fallback production report + idempotency + conflict if station has WIP
      const fbBoardAfter = await reqJson(baseUrl, '/api/shop-floor/execution-board');
      const fbOpLive = fbBoardAfter.json.operationsQueue.find((o: any) => o.id === fbOp.id);
      if (fbOpLive && fbOpLive.availableStationQty >= 1) {
        const fbRpt1 = await reqJson(
          baseUrl,
          `/api/shop-floor/operations/${encodeURIComponent(fbOp.id)}/report`,
          'POST',
          {
            idempotencyKey: 'FB-RPT-KEY-01',
            shiftId: fbBoard.json.masterData.shifts[0].id,
            machineId: fbOp.machineId || fbOp.eligibleMachineIds[0],
            goodQty: 1,
            scrapQty: 0,
            actualMaterialConsumedKg: 1.5,
            runTimeMinutes: 15,
          },
        );
        assert.equal(fbRpt1.status, 201, `fbRpt1 failed: ${JSON.stringify(fbRpt1.json)}`);
        const fbRptReplay = await reqJson(
          baseUrl,
          `/api/shop-floor/operations/${encodeURIComponent(fbOp.id)}/report`,
          'POST',
          {
            idempotencyKey: 'FB-RPT-KEY-01',
            shiftId: fbBoard.json.masterData.shifts[0].id,
            machineId: fbOp.machineId || fbOp.eligibleMachineIds[0],
            goodQty: 1,
            scrapQty: 0,
            actualMaterialConsumedKg: 1.5,
            runTimeMinutes: 15,
          },
        );
        assert.equal(fbRptReplay.status, 200);
        assert.equal(fbRptReplay.json.duplicate, true);
        const fbRptConflict = await reqJson(
          baseUrl,
          `/api/shop-floor/operations/${encodeURIComponent(fbOp.id)}/report`,
          'POST',
          {
            idempotencyKey: 'FB-RPT-KEY-01',
            shiftId: fbBoard.json.masterData.shifts[0].id,
            machineId: fbOp.machineId || fbOp.eligibleMachineIds[0],
            goodQty: 1,
            scrapQty: 0,
            actualMaterialConsumedKg: 2.5,
            runTimeMinutes: 15,
          },
        );
        assert.equal(fbRptConflict.status, 409);
      }
    }

    const fbDt = await reqJson(baseUrl, '/api/shop-floor/downtime', 'POST', {
      idempotencyKey: 'FB-DT-KEY-01',
      machineId: fbBoard.json.masterData.machines[0].id,
      productionOperationId: fbOp.id,
      reason: 'بازرسی دوره‌ای شیفت',
      durationMinutes: 10,
    });
    assert.equal(fbDt.status, 201);
    assert.equal(fbDt.json.source, 'memory-fallback');
    assert.equal(fbDt.json.data.moId, fbOp.moId);
    assert.equal(fbDt.json.data.stepCode, fbOp.stepCode);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    __setProductionWipPrismaForTests(null);
    (global as any).__kpimsDbReachable = null;
    process.env.DATABASE_URL = '';
  }

  console.log('✅ ALL KPIMS P3 SHOP-FLOOR EXECUTION & CONTROL REGRESSION TESTS PASSED');
}

run().catch(err => {
  console.error('❌ P3 TEST FAILED:', err);
  process.exit(1);
});
