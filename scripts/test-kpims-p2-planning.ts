/**
 * =========================================================================
 * KPIMS P2: Production Planning & Machine Assignment Regression Suite
 * =========================================================================
 * Strictly isolated relational mock + fallback verification (ZERO live PG).
 * Run with: DATABASE_URL="" npx tsx scripts/test-kpims-p2-planning.ts
 * =========================================================================
 */

import assert from 'node:assert/strict';
import express from 'express';
import { getRelationalPlanningReadModel } from '../src/server/relationalPlanningReadModel';
import {
  createRelationalPlanProposal,
  reviseRelationalPlanProposal,
  approveRelationalPlanProposal,
  releaseRelationalPlanProposal,
} from '../src/server/relationalPlanProposalService';
import {
  evaluateRelationalMachineEligibility,
  getRelationalMachineCapacity,
  createRelationalMachineAssignment,
  updateRelationalMachineAssignment,
  cancelRelationalMachineAssignment,
} from '../src/server/relationalMachineSchedulingService';
import { apiRouter } from '../src/server/apiRouter';

if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '') {
  throw new Error('Refusing to run isolated P2 test suite when DATABASE_URL is configured.');
}

let idCounter = 1;
const uid = (prefix: string) => `${prefix}-${idCounter++}`;
const n = (v: any) => Number(v ?? 0);

type Store = {
  customer: any[];
  customerOrder: any[];
  customerOrderLine: any[];
  unitOfMeasure: any[];
  material: any[];
  warehouse: any[];
  warehouseLocation: any[];
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
  stockBalance: any[];
  inventoryReservation: any[];
  productionPlanProposal: any[];
  productionPlanProposalLine: any[];
  productionPlan: any[];
  productionPlanLine: any[];
  manufacturingOrder: any[];
  productionOperation: any[];
  machineAssignment: any[];
  auditLog: any[];
};

function matchesWhere(row: any, where: any, store: Store): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'OR' && Array.isArray(cond)) {
      if (!cond.some(sub => matchesWhere(row, sub, store))) return false;
      continue;
    }
    if (k === 'AND' && Array.isArray(cond)) {
      if (!cond.every(sub => matchesWhere(row, sub, store))) return false;
      continue;
    }

    // Relation filters used in relationalPlanningReadModel / relationalMachineSchedulingService
    if (k === 'warehouse' && cond && typeof cond === 'object') {
      const wh = store.warehouse.find(w => w.id === row.warehouseId);
      if (!wh || !matchesWhere(wh, cond, store)) return false;
      continue;
    }
    if (k === 'part' && cond && typeof cond === 'object') {
      const p = store.part.find(pt => pt.id === row.partId);
      if (!p || !matchesWhere(p, cond, store)) return false;
      continue;
    }
    if (k === 'manufacturingOrder' && cond && typeof cond === 'object') {
      const mo = store.manufacturingOrder.find(m => m.id === row.manufacturingOrderId);
      const subWhere = (cond as any).is ? (cond as any).is : cond;
      if (!mo || !matchesWhere(mo, subWhere, store)) return false;
      continue;
    }

    const val = row[k];
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      const obj = cond as any;
      if ('in' in obj && !obj.in.includes(val)) return false;
      if ('notIn' in obj && obj.notIn.includes(val)) return false;
      if ('not' in obj) {
        if (obj.not === null && (val === null || val === undefined)) return false;
        if (obj.not !== null && val === obj.not) return false;
      }
      if ('gt' in obj && !(val != null && new Date(val).getTime() > new Date(obj.gt).getTime())) return false;
      continue;
    }
    if (val !== cond) return false;
  }
  return true;
}

function hydrate(table: keyof Store, row: any, include: any, store: Store): any {
  if (!row) return null;
  const out: any = { ...row };
  if (!include) return out;

  if (table === 'customerOrder') {
    if (include.customer) out.customer = store.customer.find(c => c.id === row.customerId) || null;
    if (include.orderLines) {
      let lines = store.customerOrderLine.filter(l => l.orderId === row.id);
      if (include.orderLines.where) lines = lines.filter(l => matchesWhere(l, include.orderLines.where, store));
      lines.sort((a, b) => a.lineNumber - b.lineNumber);
      out.orderLines = lines.map(l => hydrate('customerOrderLine', l, include.orderLines.include, store));
    }
  } else if (table === 'customerOrderLine') {
    if (include.part) out.part = hydrate('part', store.part.find(p => p.id === row.partId), include.part.include, store);
    if (include.order) out.order = store.customerOrder.find(o => o.id === row.orderId) || null;
    if (include.productionPlanLines) {
      let pls = store.productionPlanLine.filter(pl => pl.customerOrderLineId === row.id);
      if (include.productionPlanLines.where) pls = pls.filter(pl => matchesWhere(pl, include.productionPlanLines.where, store));
      out.productionPlanLines = pls;
    }
  } else if (table === 'warehouseLocation') {
    if (include.warehouse) out.warehouse = store.warehouse.find(w => w.id === row.warehouseId) || null;
  } else if (table === 'stockBalance') {
    if (include.part) out.part = hydrate('part', store.part.find(p => p.id === row.partId), include.part.include, store);
  } else if (table === 'part') {
    if (include.material) out.material = store.material.find(m => m.id === row.materialId) || null;
    if (include.unit) out.unit = store.unitOfMeasure.find(u => u.id === row.unitId) || null;
    if (include.routes) {
      let routes = store.partRoute.filter(r => r.partId === row.id);
      if (include.routes.where) routes = routes.filter(r => matchesWhere(r, include.routes.where, store));
      if (include.routes.take) routes = routes.slice(0, include.routes.take);
      out.routes = routes.map(r => hydrate('partRoute', r, include.routes.include, store));
    }
  } else if (table === 'partRoute') {
    if (include.operations) {
      const ops = store.routeOperation
        .filter(ro => ro.routeId === row.id)
        .sort((a, b) => a.stepNumber - b.stepNumber);
      out.operations = ops.map(ro => hydrate('routeOperation', ro, include.operations.include, store));
    }
  } else if (table === 'routeOperation') {
    if (include.operation) out.operation = store.operation.find(o => o.id === row.operationId) || null;
    if (include.machine) out.machine = store.machine.find(m => m.id === row.machineId) || null;
    if (include.die) out.die = store.die.find(d => d.id === row.dieId) || null;
  } else if (table === 'machine') {
    if (include.capabilities) {
      let caps = store.machineCapability.filter(c => c.machineId === row.id);
      if (include.capabilities.where) caps = caps.filter(c => matchesWhere(c, include.capabilities.where, store));
      out.capabilities = caps.map(c => ({
        ...c,
        operation: store.operation.find(o => o.id === c.operationId) || null,
      }));
    }
    if (include.dieCompatibilities) {
      let dcs = store.machineDieCompatibility.filter(dc => dc.machineId === row.id);
      if (typeof include.dieCompatibilities === 'object' && include.dieCompatibilities.where) {
        dcs = dcs.filter(dc => matchesWhere(dc, include.dieCompatibilities.where, store));
      }
      out.dieCompatibilities = dcs;
    }
  } else if (table === 'die') {
    if (include.machineCompatibilities) {
      out.machineCompatibilities = store.machineDieCompatibility.filter(dc => dc.dieId === row.id);
    }
  } else if (table === 'item') {
    if (include.bomParents) {
      let cmps = store.bomComponent.filter(b => b.parentItemId === row.id);
      if (include.bomParents.where) cmps = cmps.filter(b => matchesWhere(b, include.bomParents.where, store));
      out.bomParents = cmps.map(b => ({
        ...b,
        childItem: hydrate(
          'item',
          store.item.find(it => it.id === b.childItemId),
          { bomParents: { where: { isDeleted: false }, include: { childItem: true } } },
          store,
        ),
      }));
    }
  } else if (table === 'productionPlanProposal') {
    if (include.lines) {
      const lines = store.productionPlanProposalLine
        .filter(l => l.proposalId === row.id)
        .sort((a, b) => a.priority - b.priority || new Date(a.plannedEndDate).getTime() - new Date(b.plannedEndDate).getTime());
      out.lines = lines.map(l => hydrate('productionPlanProposalLine', l, include.lines.include, store));
    }
    if (include.productionPlan) {
      out.productionPlan = store.productionPlan.find(p => p.proposalId === row.id) || null;
    }
  } else if (table === 'productionPlanProposalLine') {
    if (include.part) out.part = hydrate('part', store.part.find(p => p.id === row.partId), undefined, store);
    if (include.route) out.route = hydrate('partRoute', store.partRoute.find(r => r.id === row.routeId), include.route.include, store);
    if (include.customerOrderLine) {
      out.customerOrderLine = hydrate(
        'customerOrderLine',
        store.customerOrderLine.find(cl => cl.id === row.customerOrderLineId),
        include.customerOrderLine.include,
        store,
      );
    }
  } else if (table === 'productionOperation') {
    if (include.operation) out.operation = store.operation.find(o => o.id === row.operationId) || null;
    if (include.plannedMachine) out.plannedMachine = store.machine.find(m => m.id === row.plannedMachineId) || null;
    if (include.plannedDie) out.plannedDie = store.die.find(d => d.id === row.plannedDieId) || null;
    if (include.routeOperation) {
      out.routeOperation = hydrate('routeOperation', store.routeOperation.find(r => r.id === row.routeOperationId), include.routeOperation.include, store);
    }
    if (include.manufacturingOrder) {
      out.manufacturingOrder = hydrate('manufacturingOrder', store.manufacturingOrder.find(m => m.id === row.manufacturingOrderId), include.manufacturingOrder.include, store);
    }
  } else if (table === 'manufacturingOrder') {
    if (include.part) out.part = store.part.find(p => p.id === row.partId) || null;
    if (include.operations) {
      const ops = store.productionOperation.filter(o => o.manufacturingOrderId === row.id).sort((a, b) => a.stepNumber - b.stepNumber);
      out.operations = ops.map(o => hydrate('productionOperation', o, include.operations.include, store));
    }
  } else if (table === 'machineAssignment') {
    if (include.machine) out.machine = store.machine.find(m => m.id === row.machineId) || null;
    if (include.shift) out.shift = store.shift.find(s => s.id === row.shiftId) || null;
    if (include.productionOperation) {
      out.productionOperation = hydrate(
        'productionOperation',
        store.productionOperation.find(o => o.id === row.productionOperationId),
        include.productionOperation.include,
        store,
      );
    }
  }
  return out;
}

function createMockPrisma(store: Store) {
  const delegateFor = (table: keyof Store) => ({
    async findMany(args: any = {}) {
      let rows = store[table].filter(r => matchesWhere(r, args.where, store));
      if (args.take) rows = rows.slice(0, args.take);
      return rows.map(r => hydrate(table, r, args.include, store));
    },
    async findFirst(args: any = {}) {
      const rows = await this.findMany({ ...args, take: 1 });
      return rows[0] || null;
    },
    async findUnique(args: any = {}) {
      return this.findFirst(args);
    },
    async count(args: any = {}) {
      return store[table].filter(r => matchesWhere(r, args.where, store)).length;
    },
    async create(args: any) {
      const d = args.data || {};
      const rec: any = {
        id: d.id || uid(table.slice(0, 4).toUpperCase()),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...d,
      };

      if (table === 'productionPlanProposal' && d.lines?.create) {
        delete rec.lines;
        store.productionPlanProposal.push(rec);
        for (const ln of d.lines.create) {
          store.productionPlanProposalLine.push({
            id: uid('PRPL'),
            proposalId: rec.id,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...ln,
          });
        }
        return hydrate(table, rec, args.include, store);
      }

      if (table === 'productionPlan' && d.proposal?.connect?.id) {
        rec.proposalId = d.proposal.connect.id;
        delete rec.proposal;
      }

      if (table === 'manufacturingOrder' && d.operations?.create) {
        const opCreates = d.operations.create;
        delete rec.operations;
        store.manufacturingOrder.push(rec);
        for (const op of opCreates) {
          store.productionOperation.push({
            id: uid('OP'),
            manufacturingOrderId: rec.id,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...op,
          });
        }
        return hydrate(table, rec, args.include, store);
      }

      store[table].push(rec);
      return hydrate(table, rec, args.include, store);
    },
    async update(args: any) {
      const idx = store[table].findIndex(r => matchesWhere(r, args.where, store));
      if (idx === -1) throw new Error(`Not found in ${table}`);
      store[table][idx] = { ...store[table][idx], ...args.data };
      return hydrate(table, store[table][idx], args.include, store);
    },
    async updateMany(args: any) {
      let count = 0;
      store[table] = store[table].map(r => {
        if (matchesWhere(r, args.where, store)) {
          count += 1;
          return { ...r, ...args.data };
        }
        return r;
      });
      return { count };
    },
  });

  const client: any = {
    customer: delegateFor('customer'),
    customerOrder: delegateFor('customerOrder'),
    customerOrderLine: delegateFor('customerOrderLine'),
    unitOfMeasure: delegateFor('unitOfMeasure'),
    material: delegateFor('material'),
    warehouse: delegateFor('warehouse'),
    warehouseLocation: delegateFor('warehouseLocation'),
    part: delegateFor('part'),
    item: delegateFor('item'),
    bomComponent: delegateFor('bomComponent'),
    operation: delegateFor('operation'),
    partRoute: delegateFor('partRoute'),
    routeOperation: delegateFor('routeOperation'),
    machine: delegateFor('machine'),
    machineCapability: delegateFor('machineCapability'),
    die: delegateFor('die'),
    machineDieCompatibility: delegateFor('machineDieCompatibility'),
    shift: delegateFor('shift'),
    stockBalance: delegateFor('stockBalance'),
    inventoryReservation: delegateFor('inventoryReservation'),
    productionPlanProposal: delegateFor('productionPlanProposal'),
    productionPlanProposalLine: delegateFor('productionPlanProposalLine'),
    productionPlan: delegateFor('productionPlan'),
    productionPlanLine: delegateFor('productionPlanLine'),
    manufacturingOrder: delegateFor('manufacturingOrder'),
    productionOperation: delegateFor('productionOperation'),
    machineAssignment: delegateFor('machineAssignment'),
    auditLog: delegateFor('auditLog'),
    productionTransfer: { async findMany() { return []; } },
    productionActivityLog: { async findMany() { return []; } },
    async $transaction(fn: any) {
      return fn(client);
    },
  };
  return client;
}

function buildSeedStore(): Store {
  const now = new Date();
  const inDays = (d: number) => new Date(now.getTime() + d * 86400000);

  return {
    customer: [{ id: 'CUST-SAPCO', name: 'ساپکو', active: true }],
    unitOfMeasure: [
      { id: 'UOM-PCS', code: 'PCS', name: 'عدد', symbol: 'pcs' },
      { id: 'UOM-KG', code: 'KG', name: 'کیلوگرم', symbol: 'kg' },
    ],
    material: [
      { id: 'MAT-ST14', code: 'ST14', grade: 'ST14' },
      { id: 'MAT-DC04', code: 'DC04', grade: 'DC04' },
    ],
    warehouse: [
      { id: 'WH-RAW', code: 'WH-RAW', name: 'انبار ورق', type: 'RAW_MATERIALS', active: true },
      { id: 'WH-WIP', code: 'WH-WIP-PRESS', name: 'انبار پای کار پرس', type: 'WIP', active: true },
      { id: 'WH-FG', code: 'WH-FG', name: 'انبار محصول', type: 'FINISHED_GOODS', active: true },
    ],
    warehouseLocation: [
      { id: 'LOC-WIP-BLANK', code: 'LOC-WIP-BLANK', warehouseId: 'WH-WIP', active: true },
      { id: 'LOC-WELD-IN', code: 'LOC-WELD-IN', warehouseId: 'WH-WIP', active: true },
      { id: 'LOC-FG-01', code: 'LOC-FG-A1', warehouseId: 'WH-FG', active: true },
    ],
    part: [
      {
        id: 'PART-FG-A',
        partNumber: 'FG-ECU-01',
        name: 'مجموعه براکت ECU',
        category: 'FINISHED_GOOD',
        unitId: 'UOM-PCS',
        materialId: 'MAT-ST14',
        weightGrossKg: 2.0,
        thicknessMm: 1.5,
        targetWarehouseId: 'WH-FG',
        targetLocationId: 'LOC-FG-01',
        active: true,
      },
      {
        id: 'PART-FG-B',
        partNumber: 'FG-BRK-02',
        name: 'پایه محافظ سنسور (بدون BOM درختی)',
        category: 'FINISHED_GOOD',
        unitId: 'UOM-PCS',
        materialId: 'MAT-ST14',
        weightGrossKg: 3.0,
        thicknessMm: 1.5,
        targetWarehouseId: 'WH-FG',
        targetLocationId: 'LOC-FG-01',
        active: true,
      },
      {
        id: 'PART-WIP-SUB',
        partNumber: 'WIP-SUB-01',
        name: 'پوسته نیمه‌ساخته براکت',
        category: 'WIP_PART',
        unitId: 'UOM-PCS',
        materialId: 'MAT-ST14',
        weightGrossKg: 1.5,
        active: true,
      },
      {
        id: 'PART-RAW-ST14',
        partNumber: 'RM-COIL-ST14',
        name: 'کلاف ورق ST14',
        category: 'RAW_MATERIAL',
        unitId: 'UOM-KG',
        materialId: 'MAT-ST14',
        weightGrossKg: 1,
        active: true,
      },
      {
        id: 'PART-RAW-NUT',
        partNumber: 'RM-NUT-M6',
        name: 'مهره جوشی M6',
        category: 'RAW_MATERIAL',
        unitId: 'UOM-PCS',
        materialId: null,
        weightGrossKg: 0.01,
        active: true,
      },
    ],
    item: [
      { id: 'ITM-FG-A', code: 'FG-ECU-01', name: 'مجموعه براکت ECU', type: 'FINISHED_GOOD', unit: 'PCS', weightGrossKg: 2, isDeleted: false },
      { id: 'ITM-SUB', code: 'WIP-SUB-01', name: 'پوسته نیمه‌ساخته براکت', type: 'SEMI_FINISHED', unit: 'PCS', weightGrossKg: 1.5, isDeleted: false },
      { id: 'ITM-RAW-ST14', code: 'RM-COIL-ST14', name: 'کلاف ورق ST14', type: 'RAW_MATERIAL', unit: 'KG', weightGrossKg: 1, isDeleted: false },
      { id: 'ITM-NUT', code: 'RM-NUT-M6', name: 'مهره جوشی M6', type: 'RAW_MATERIAL', unit: 'PCS', weightGrossKg: 0.01, isDeleted: false },
    ],
    bomComponent: [
      { id: 'BOM-1', parentItemId: 'ITM-FG-A', childItemId: 'ITM-SUB', quantity: 1, scrapFactor: 0, isDeleted: false },
      { id: 'BOM-2', parentItemId: 'ITM-FG-A', childItemId: 'ITM-NUT', quantity: 4, scrapFactor: 0, isDeleted: false },
      { id: 'BOM-3', parentItemId: 'ITM-SUB', childItemId: 'ITM-RAW-ST14', quantity: 2, scrapFactor: 10, isDeleted: false },
    ],
    operation: [
      { id: 'OPER-BLANK', code: 'BLANK', name: 'بلنکینگ', processType: 'BLANKING' },
      { id: 'OPER-WELD', code: 'WELD', name: 'جوش نقطه‌ای', processType: 'SPOT_WELD' },
    ],
    partRoute: [
      { id: 'RT-FG-A', partId: 'PART-FG-A', status: 'ACTIVE', isDefault: true, effectiveFrom: inDays(-30) },
      { id: 'RT-FG-B', partId: 'PART-FG-B', status: 'ACTIVE', isDefault: true, effectiveFrom: inDays(-30) },
    ],
    routeOperation: [
      {
        id: 'RO-A-10',
        routeId: 'RT-FG-A',
        stepNumber: 10,
        stepCode: 'OP10',
        stepName: 'بلنکینگ صفحه',
        operationId: 'OPER-BLANK',
        machineId: 'MCH-250',
        dieId: 'DIE-BLK-200',
        setupTimeMin: 30,
        standardCycleTimeSec: 36,
        scrapNormPercent: 2,
      },
      {
        id: 'RO-A-20',
        routeId: 'RT-FG-A',
        stepNumber: 20,
        stepCode: 'OP20',
        stepName: 'پرس‌جوش مهره',
        operationId: 'OPER-WELD',
        machineId: 'MCH-WLD',
        dieId: null,
        setupTimeMin: 30,
        standardCycleTimeSec: 18,
        scrapNormPercent: 0,
      },
      {
        id: 'RO-B-10',
        routeId: 'RT-FG-B',
        stepNumber: 10,
        stepCode: 'OP10',
        stepName: 'بلنکینگ پایه',
        operationId: 'OPER-BLANK',
        machineId: 'MCH-400',
        dieId: 'DIE-BLK-200',
        setupTimeMin: 30,
        standardCycleTimeSec: 20,
        scrapNormPercent: 5,
      },
    ],
    machine: [
      { id: 'MCH-250', code: 'PRS-250-01', name: 'پرس ۲۵۰ تن', hallLocation: 'سالن پرس', machineType: 'MECHANICAL_PRESS', tonnageCapacity: 250, status: 'ACTIVE', active: true },
      { id: 'MCH-400', code: 'PRS-400-01', name: 'پرس ۴۰۰ تن', hallLocation: 'سالن پرس', machineType: 'HYDRAULIC_PRESS', tonnageCapacity: 400, status: 'ACTIVE', active: true },
      { id: 'MCH-100-LOW', code: 'PRS-100-LOW', name: 'پرس ۱۰۰ تن (تناژ کم)', hallLocation: 'سالن پرس', machineType: 'MECHANICAL_PRESS', tonnageCapacity: 100, status: 'ACTIVE', active: true },
      { id: 'MCH-PM', code: 'PRS-300-PM', name: 'پرس ۳۰۰ تن در تعمیر', hallLocation: 'سالن پرس', machineType: 'MECHANICAL_PRESS', tonnageCapacity: 300, status: 'MAINTENANCE', active: true },
      { id: 'MCH-WLD', code: 'WLD-SPOT-01', name: 'پرس‌جوش ۱', hallLocation: 'سالن جوش', machineType: 'SPOT_WELDER', tonnageCapacity: 0, status: 'ACTIVE', active: true },
    ],
    machineCapability: [
      { id: 'MC-1', machineId: 'MCH-250', operationId: 'OPER-BLANK', maxTonnage: 250, minThicknessMm: 0.5, maxThicknessMm: 2.5, efficiencyFactor: 1.0, isPreferred: true },
      { id: 'MC-2', machineId: 'MCH-400', operationId: 'OPER-BLANK', maxTonnage: 400, minThicknessMm: 0.8, maxThicknessMm: 4.0, efficiencyFactor: 1.2, isPreferred: false },
      { id: 'MC-3', machineId: 'MCH-100-LOW', operationId: 'OPER-BLANK', maxTonnage: 100, minThicknessMm: 0.5, maxThicknessMm: 2.0, efficiencyFactor: 1.0, isPreferred: false },
      { id: 'MC-4', machineId: 'MCH-PM', operationId: 'OPER-BLANK', maxTonnage: 300, minThicknessMm: 0.5, maxThicknessMm: 3.0, efficiencyFactor: 1.0, isPreferred: false },
      { id: 'MC-5', machineId: 'MCH-WLD', operationId: 'OPER-WELD', maxTonnage: null, minThicknessMm: 0.5, maxThicknessMm: 3.0, efficiencyFactor: 1.0, isPreferred: true },
    ],
    die: [
      { id: 'DIE-BLK-200', code: 'DIE-BLK-200', name: 'قالب بلنک ۲۰۰ تن', partId: 'PART-FG-A', tonnageRequired: 200, status: 'READY', active: true },
    ],
    machineDieCompatibility: [
      { id: 'MDC-1', machineId: 'MCH-250', dieId: 'DIE-BLK-200' },
      { id: 'MDC-2', machineId: 'MCH-400', dieId: 'DIE-BLK-200' },
      { id: 'MDC-3', machineId: 'MCH-PM', dieId: 'DIE-BLK-200' },
    ],
    shift: [
      { id: 'SH-MORN', code: 'SHIFT-MORN', name: 'شیفت صبح', startTime: '07:00', endTime: '15:00', breakDurationMin: 30, productiveHours: 7.5, active: true },
      { id: 'SH-EVE', code: 'SHIFT-EVE', name: 'شیفت عصر', startTime: '15:00', endTime: '23:00', breakDurationMin: 30, productiveHours: 7.5, active: true },
    ],
    stockBalance: [
      // 300 FG available minus 100 active reservation = 200 available FG
      { id: 'SB-FG-A', partId: 'PART-FG-A', warehouseId: 'WH-FG', qualityStatus: 'AVAILABLE', quantityOnHand: 300, quantityReserved: 100, quantityAvailable: 200, weightKgAvailable: 600 },
      // 100 FG WIP
      { id: 'SB-WIP-FG-A', partId: 'PART-FG-A', warehouseId: 'WH-WIP', qualityStatus: 'AVAILABLE', quantityOnHand: 100, quantityReserved: 0, quantityAvailable: 100, weightKgAvailable: 200 },
      // 200 intermediate subassembly WIP
      { id: 'SB-WIP-SUB', partId: 'PART-WIP-SUB', warehouseId: 'WH-WIP', qualityStatus: 'AVAILABLE', quantityOnHand: 200, quantityReserved: 0, quantityAvailable: 200, weightKgAvailable: 300 },
      // Raw ST14 pool: 2000 KG (enough for FG-A's remaining 700*1*2.2 = 1540 KG, leaving 460 KG -> shortage for FG-B!)
      { id: 'SB-RAW-ST14', partId: 'PART-RAW-ST14', warehouseId: 'WH-RAW', qualityStatus: 'AVAILABLE', quantityOnHand: 2000, quantityReserved: 0, quantityAvailable: 2000, weightKgAvailable: 2000 },
      // Nut M6: 5000 PCS
      { id: 'SB-RAW-NUT', partId: 'PART-RAW-NUT', warehouseId: 'WH-RAW', qualityStatus: 'AVAILABLE', quantityOnHand: 5000, quantityReserved: 0, quantityAvailable: 5000, weightKgAvailable: 50 },
    ],
    inventoryReservation: [
      { id: 'RES-FG-1', partId: 'PART-FG-A', warehouseId: 'WH-FG', status: 'ACTIVE', validUntil: null, quantity: 100 },
    ],
    customerOrder: [
      { id: 'ORD-1', orderNumber: 'SO-P1-101', customerId: 'CUST-SAPCO', documentStatus: 'CONFIRMED', priority: 1, requestedDeliveryDate: inDays(2) },
      { id: 'ORD-2', orderNumber: 'SO-P2-102', customerId: 'CUST-SAPCO', documentStatus: 'CONFIRMED', priority: 2, requestedDeliveryDate: inDays(6) },
    ],
    customerOrderLine: [
      // Demand FG-A = 1200. FG avail(200) + FG WIP(100) = 300 => Net FG-A = 900.
      { id: 'OL-1', orderId: 'ORD-1', lineNumber: 1, partId: 'PART-FG-A', orderedQty: 1200, deliveredQty: 0, requestedDate: inDays(2), status: 'PENDING' },
      // Demand FG-B = 400. Net = 400 => GrossWeight = 400 * 3 * 1.05 = 1260 KG ST14, but only 460 KG left after FG-A!
      { id: 'OL-2', orderId: 'ORD-2', lineNumber: 1, partId: 'PART-FG-B', orderedQty: 400, deliveredQty: 0, requestedDate: inDays(6), status: 'PENDING' },
    ],
    productionPlanProposal: [],
    productionPlanProposalLine: [],
    productionPlan: [],
    productionPlanLine: [],
    manufacturingOrder: [],
    productionOperation: [],
    machineAssignment: [],
    auditLog: [],
  };
}

async function requestJson(baseUrl: string, path: string, method = 'GET', body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function run() {
  const store = buildSeedStore();
  const mockPrisma = createMockPrisma(store);
  (global as any).__prismaClient = mockPrisma;
  (global as any).__kpimsDbReachable = true;
  process.env.DATABASE_URL = 'postgresql://mock:mock@127.0.0.1:0/mock_kpims_p2_isolated';

  console.log('1) Testing Relational Read Model: Demand prioritization, netting, BOM explosion & cumulative shortages...');
  const readModel = await getRelationalPlanningReadModel();
  assert.equal(readModel.source, 'postgresql');
  assert.equal(readModel.requirements.length, 2);

  // Priority 1 (FG-ECU-01) comes first
  const reqA = readModel.requirements[0];
  const reqB = readModel.requirements[1];
  assert.equal(reqA.partCode, 'FG-ECU-01');
  assert.equal(reqA.grossDemandQty, 1200);
  assert.equal(reqA.availableFinishedGoodsQty, 200, '300 physical FG - 100 reserved FG = 200');
  assert.equal(reqA.downstreamWipQty, 100);
  assert.equal(reqA.netProductionRequirement, 900, '1200 - 200 - 100 = 900');
  assert.equal(reqA.bomSource, 'BOM_COMPONENT_TREE');

  const subComp = reqA.explodedComponents.find(c => c.partCode === 'WIP-SUB-01');
  assert(subComp, 'Level 1 subassembly component must appear in BOM explosion');
  assert.equal(subComp.wipCreditedQty, 200, '200 units of subassembly WIP must be credited');
  assert.equal(subComp.netRequiredQty, 700, '900 - 200 WIP = 700 subassemblies needed');

  const rawSt14Comp = reqA.explodedComponents.find(c => c.partCode === 'RM-COIL-ST14');
  assert(rawSt14Comp, 'Level 2 raw coil ST14 must appear in BOM explosion');
  assert.equal(rawSt14Comp.netRequiredQty, 1540, '700 * 2 * 1.10 = 1540 KG ST14');
  assert.equal(rawSt14Comp.availableQty, 2000);
  assert.equal(rawSt14Comp.hasShortage, false);

  // Competing Priority 2 order (FG-BRK-02) falls back to PART_GROSS_WEIGHT and sees remaining 460 KG of ST14
  assert.equal(reqB.partCode, 'FG-BRK-02');
  assert.equal(reqB.bomSource, 'PART_GROSS_WEIGHT');
  assert.equal(reqB.requiredMaterialKg, 1260, '400 * 3.0 * 1.05 = 1260 KG');
  assert.equal(reqB.availableRawMaterialKg, 460, '2000 - 1540 consumed by Priority 1 = 460 KG left');
  assert.equal(reqB.hasMaterialShortage, true);
  assert.equal(reqB.materialShortageKg, 800, '1260 - 460 = 800 KG cumulative shortage');

  console.log('2) Testing Routing Generation, Machine Eligibility (Capability/Tonnage/Die/Status) & Due-Date Risk...');
  const op10A = reqA.route[0];
  assert.equal(op10A.stepCode, 'OP10');
  const eligibleIds = op10A.eligibleMachines.map(m => m.id);
  assert(eligibleIds.includes('MCH-250') && eligibleIds.includes('MCH-400'), '250T and 400T presses are eligible');
  assert(!eligibleIds.includes('MCH-100-LOW'), '100T press excluded (insufficient tonnage + die incompatibility)');
  assert(!eligibleIds.includes('MCH-PM'), 'MAINTENANCE press excluded');
  assert.equal(op10A.machineSelectionStatus, 'CANDIDATES_FOUND');
  assert(op10A.estimatedHours > 0 && op10A.estimatedStartDate && op10A.estimatedEndDate);

  // Also test dynamic POST /api/planning/evaluate-machine-eligibility
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const eligRes = await requestJson(baseUrl, '/api/planning/evaluate-machine-eligibility', 'POST', {
      operationId: 'OPER-BLANK',
      requiredTonnage: 200,
      plannedQuantity: 900,
      standardCycleTimeSec: 36,
      setupTimeMin: 30,
      assignedDieId: 'DIE-BLK-200',
      partThicknessMm: 1.5,
    });
    assert.equal(eligRes.status, 200);
    assert.equal(eligRes.json.source, 'postgresql');
    const checks = eligRes.json.data as any[];
    assert.equal(checks.find(c => c.machineId === 'MCH-250')?.isEligible, true);
    assert.equal(checks.find(c => c.machineId === 'MCH-100-LOW')?.isEligible, false);
    assert.equal(checks.find(c => c.machineId === 'MCH-PM')?.isEligible, false);

    console.log('3) Testing Planner-Controlled Proposal Flow (No Auto-Commit + Revise Qty/Shift + Approve + Release)...');
    const regenRes = await requestJson(baseUrl, '/api/planning/proposals/regenerate', 'POST', { notes: 'پیشنهاد تست P2' });
    assert.equal(regenRes.status, 201);
    const propV1 = regenRes.json.data;
    assert.equal(propV1.status, 'DRAFT', 'Proposal must stay DRAFT and never auto-commit');
    assert.equal(store.manufacturingOrder.length, 0, 'No MOs may be auto-committed on proposal creation');

    const line1 = propV1.lines.find((l: any) => l.partId === 'PART-FG-A');
    const line1Op10 = line1.operationAssignments.find((o: any) => o.stepCode === 'OP10');
    assert(line1Op10.shiftId, 'Operation assignment should carry a shift suggestion');

    // Reject incompatible machine revision (MCH-100-LOW is not eligible)
    const badRevise = await requestJson(baseUrl, `/api/planning/proposals/${propV1.id}/revise`, 'POST', {
      note: 'تست انتخاب نامعتبر',
      changes: [
        {
          proposalLineId: line1.id,
          operationAssignments: [{ routeOperationId: line1Op10.routeOperationId, machineId: 'MCH-100-LOW' }],
        },
      ],
    });
    assert.equal(badRevise.status, 400, 'Incompatible machine choice must be rejected');

    // Planner revises plannedQty (900 -> 850), switches OP10 machine to MCH-400 & shift to SH-EVE
    const goodRevise = await requestJson(baseUrl, `/api/planning/proposals/${propV1.id}/revise`, 'POST', {
      note: 'انتقال به پرس ۴۰۰ تن شیفت عصر و تعدیل تیراژ به ۸۵۰',
      changes: [
        {
          proposalLineId: line1.id,
          plannedQty: 850,
          operationAssignments: [
            {
              routeOperationId: line1Op10.routeOperationId,
              machineId: 'MCH-400',
              shiftId: 'SH-EVE',
              plannedStartDate: new Date().toISOString().slice(0, 10),
              plannedEndDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
            },
          ],
        },
      ],
    });
    assert.equal(goodRevise.status, 201);
    const propV2 = goodRevise.json.data;
    assert.equal(propV2.version, 2);
    assert.equal(propV2.status, 'DRAFT');
    const revisedLine1 = propV2.lines.find((l: any) => l.partId === 'PART-FG-A');
    assert.equal(n(revisedLine1.plannedQty), 850);
    assert.equal(revisedLine1.operationAssignments[0].machineId, 'MCH-400');
    assert.equal(revisedLine1.operationAssignments[0].shiftId, 'SH-EVE');

    // Approve V2 — must succeed even though planner changed plannedQty from 900 -> 850
    const approveRes = await requestJson(baseUrl, `/api/planning/proposals/${propV2.id}/approve`, 'POST', {
      approvedBy: 'برنامه‌ریز ارشد',
    });
    assert.equal(approveRes.status, 200, `Approve after planner qty revision failed: ${JSON.stringify(approveRes.json)}`);
    assert.equal(approveRes.json.data.status, 'APPROVED');

    // Manual release creates ProductionPlan, MOs, ProductionOperations AND relational MachineAssignments
    const releaseRes = await requestJson(baseUrl, `/api/planning/proposals/${propV2.id}/release`, 'POST', {
      releasedBy: 'مدیر تولید',
    });
    assert.equal(releaseRes.status, 201, `Release failed: ${JSON.stringify(releaseRes.json)}`);
    assert.equal(store.manufacturingOrder.length, 2);
    assert(store.machineAssignment.length >= 3, 'Release must create relational MachineAssignment rows for assigned ops');
    const op10Assignment = store.machineAssignment.find(a => a.machineId === 'MCH-400' && a.shiftId === 'SH-EVE');
    assert(op10Assignment, 'MachineAssignment must preserve planner-selected machine MCH-400 and shift SH-EVE');

    console.log('4) Testing Machine Capacity Endpoint, Conflict Detection (409), Override, Reassign, Audit-Preserved Cancel & Dashboard Utilization...');
    // Check dashboard-metrics reads relational utilization (NOT in-memory machineWorkloadHoursMap)
    const dashRes = await requestJson(baseUrl, '/api/planning/dashboard-metrics');
    assert.equal(dashRes.status, 200);
    assert.equal(dashRes.json.source, 'postgresql');
    assert(dashRes.json.data.averageMachineCapacityUtilizationPercent > 0, 'DB utilization must reflect scheduled MachineAssignments');

    const capRes = await requestJson(baseUrl, '/api/planning/machine-capacity');
    assert.equal(capRes.status, 200);
    assert.equal(capRes.json.source, 'postgresql');
    assert(capRes.json.data.assignments.length >= 3);

    // Create an unassigned operation on a new MO and test direct assignment conflict/override/update/cancel
    const testMoId = uid('MO-TEST');
    store.manufacturingOrder.push({
      id: testMoId,
      moNumber: 'MO-DIRECT-01',
      partId: 'PART-FG-B',
      routeId: 'RT-FG-B',
      targetQty: 150,
      status: 'RELEASED',
      scheduledStartDate: new Date(),
      scheduledEndDate: new Date(Date.now() + 2 * 86400000),
    });
    const unassignedOpId = uid('OP-UNASSIGNED');
    store.productionOperation.push({
      id: unassignedOpId,
      manufacturingOrderId: testMoId,
      operationId: 'OPER-BLANK',
      routeOperationId: 'RO-B-10',
      stepNumber: 10,
      stepCode: 'OP10',
      stepName: 'بلنکینگ پایه',
      plannedMachineId: null,
      plannedDieId: 'DIE-BLK-200',
      plannedQty: 150,
      standardCycleTimeSec: 20,
      status: 'READY',
    });

    const todayStr = new Date().toISOString().slice(0, 10);
    // Attempt incompatible machine -> 400
    const badAssign = await requestJson(baseUrl, '/api/planning/machine-assignments', 'POST', {
      productionOperationId: unassignedOpId,
      machineId: 'MCH-100-LOW',
      shiftId: 'SH-MORN',
      assignedDate: todayStr,
    });
    assert.equal(badAssign.status, 400);

    // Attempt double-booking MCH-400 on SH-EVE today (already booked by op10Assignment) -> 409 conflict
    const op10DateStr = op10Assignment.assignedDate.toISOString().slice(0, 10);
    const conflictAssign = await requestJson(baseUrl, '/api/planning/machine-assignments', 'POST', {
      productionOperationId: unassignedOpId,
      machineId: 'MCH-400',
      shiftId: 'SH-EVE',
      assignedDate: op10DateStr,
    });
    assert.equal(conflictAssign.status, 409, 'Double-booking same machine+date+shift must return 409 without override');

    // Explicit planner conflict override must succeed (201) and log conflictOverridden in AuditLog
    const overrideAssign = await requestJson(baseUrl, '/api/planning/machine-assignments', 'POST', {
      productionOperationId: unassignedOpId,
      machineId: 'MCH-400',
      shiftId: 'SH-EVE',
      assignedDate: op10DateStr,
      allowConflictOverride: true,
      actor: 'برنامه‌ریز ارشد',
    });
    assert.equal(overrideAssign.status, 201, 'Explicit allowConflictOverride=true must succeed');
    const overrideAudit = store.auditLog.find(
      l => l.action === 'MACHINE_ASSIGNMENT_CREATE' && l.entityId === overrideAssign.json.data.id,
    );
    assert(overrideAudit, 'Conflict override assignment must record AuditLog');
    assert.equal(overrideAudit.newValues?.conflictOverridden, true);
    // Cancel the override slot cleanly before testing normal MCH-250 assignment
    const cancelOverride = await requestJson(
      baseUrl,
      `/api/planning/machine-assignments/${overrideAssign.json.data.id}/cancel`,
      'POST',
      { reason: 'آزادسازی پس از تست override', actor: 'برنامه‌ریز ارشد' },
    );
    assert.equal(cancelOverride.status, 200);

    // Assign without conflict on MCH-250 / SH-MORN -> 201
    const cleanAssign = await requestJson(baseUrl, '/api/planning/machine-assignments', 'POST', {
      productionOperationId: unassignedOpId,
      machineId: 'MCH-250',
      shiftId: 'SH-MORN',
      assignedDate: todayStr,
      actor: 'برنامه‌ریز شیفت',
    });
    assert.equal(cleanAssign.status, 201);
    const createdAssignId = cleanAssign.json.data.id;

    // Update shift to SH-EVE on MCH-250 -> 200
    const updateAssign = await requestJson(baseUrl, `/api/planning/machine-assignments/${createdAssignId}`, 'PUT', {
      shiftId: 'SH-EVE',
      actor: 'برنامه‌ریز شیفت',
    });
    assert.equal(updateAssign.status, 200);
    assert.equal(updateAssign.json.data.shiftId, 'SH-EVE');

    // Cancel assignment -> status CANCELLED + AuditLog preserved
    const cancelAssign = await requestJson(baseUrl, `/api/planning/machine-assignments/${createdAssignId}/cancel`, 'POST', {
      reason: 'جابجایی برنامه تولید',
      actor: 'برنامه‌ریز شیفت',
    });
    assert.equal(cancelAssign.status, 200);
    assert.equal(cancelAssign.json.data.status, 'CANCELLED');
    assert(store.auditLog.some(l => l.action === 'MACHINE_ASSIGNMENT_CANCEL' && l.entityId === createdAssignId));

    // Completed assignment cannot be cancelled -> 409
    const doneAssignId = uid('ASGN-DONE');
    store.machineAssignment.push({
      id: doneAssignId,
      machineId: 'MCH-250',
      productionOperationId: unassignedOpId,
      shiftId: 'SH-MORN',
      assignedDate: new Date(),
      status: 'COMPLETED',
    });
    const cancelDone = await requestJson(baseUrl, `/api/planning/machine-assignments/${doneAssignId}/cancel`, 'POST', {});
    assert.equal(cancelDone.status, 409);

    // External demand change after proposal generation must reject approve with 409
    const stalePropRes = await requestJson(baseUrl, '/api/planning/proposals/regenerate', 'POST', { notes: 'تست stale' });
    assert.equal(stalePropRes.status, 201);
    const prevOrderedQty = store.customerOrderLine[0].orderedQty;
    store.customerOrderLine[0].orderedQty = prevOrderedQty + 250;
    const staleApprove = await requestJson(baseUrl, `/api/planning/proposals/${stalePropRes.json.data.id}/approve`, 'POST', {
      approvedBy: 'برنامه‌ریز',
    });
    assert.equal(staleApprove.status, 409, 'External demand change must invalidate stale proposal approval');
    store.customerOrderLine[0].orderedQty = prevOrderedQty;

    console.log('5) Testing Non-DB Fallback Parity Mode (DATABASE_URL="" + __kpimsDbReachable=false)...');
    (global as any).__kpimsDbReachable = false;
    process.env.DATABASE_URL = '';
    const fbCap = await requestJson(baseUrl, '/api/planning/machine-capacity');
    assert.equal(fbCap.status, 200);
    assert.equal(fbCap.json.source, 'memory-fallback');
    assert(Array.isArray(fbCap.json.data.shifts) && fbCap.json.data.shifts.length >= 2);

    // Pick an unassigned operation from fallback capacity and verify POST -> PUT -> cancel
    const fbUnassigned = (fbCap.json.data.unassignedOperations || []).find(
      (op: any) => Array.isArray(op.eligibleMachineIds) && op.eligibleMachineIds.length > 0,
    );
    assert(fbUnassigned, 'Fallback store must expose at least one assignable unassigned operation');
    const fbCreate = await requestJson(baseUrl, '/api/planning/machine-assignments', 'POST', {
      productionOperationId: fbUnassigned.productionOperationId,
      machineId: fbUnassigned.eligibleMachineIds[0],
      shiftId: fbCap.json.data.shifts[0].id,
      assignedDate: todayStr,
    });
    assert.equal(fbCreate.status, 201);
    assert.equal(fbCreate.json.source, 'memory-fallback');
    const fbShift2 = fbCap.json.data.shifts[1]?.id || fbCap.json.data.shifts[0].id;
    const fbUpdate = await requestJson(baseUrl, `/api/planning/machine-assignments/${fbCreate.json.data.id}`, 'PUT', {
      shiftId: fbShift2,
      notes: 'تست ویرایش fallback',
    });
    assert.equal(fbUpdate.status, 200);
    assert.equal(fbUpdate.json.data.shiftId, fbShift2);
    const fbCancel = await requestJson(baseUrl, `/api/planning/machine-assignments/${fbCreate.json.data.id}/cancel`, 'POST', {
      reason: 'تست لغو fallback',
    });
    assert.equal(fbCancel.status, 200);
    assert.equal(fbCancel.json.data.status, 'CANCELLED');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    (global as any).__prismaClient = undefined;
    (global as any).__kpimsDbReachable = null;
    process.env.DATABASE_URL = '';
  }

  console.log('✅ ALL KPIMS P2 PLANNING & MACHINE ASSIGNMENT REGRESSION TESTS PASSED');
}

run().catch(err => {
  console.error('❌ P2 TEST FAILED:', err);
  process.exit(1);
});
