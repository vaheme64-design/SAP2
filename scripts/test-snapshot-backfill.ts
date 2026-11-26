import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  DECIMAL_ZERO,
  decimalAdd,
  decimalEq,
  decimalSub,
  formatDecimal,
  normalizeFloatArtifact,
  toDecimal,
} from '../src/server/backfill/decimalUtils';
import {
  SnapshotDataBundle,
  loadSnapshotsFromPostgres,
  runSnapshotToRelationalBackfill,
} from '../src/server/backfill/snapshotBackfillService';

type TableName =
  | 'role'
  | 'user'
  | 'unitOfMeasure'
  | 'material'
  | 'warehouse'
  | 'warehouseLocation'
  | 'customer'
  | 'shift'
  | 'part'
  | 'operation'
  | 'machine'
  | 'machineCapability'
  | 'die'
  | 'machineDieCompatibility'
  | 'partRoute'
  | 'routeOperation'
  | 'materialContract'
  | 'contractCommercialLine'
  | 'materialLot'
  | 'physicalCoil'
  | 'contractCoilAllocation'
  | 'customerOrder'
  | 'customerOrderLine'
  | 'productionPlanProposal'
  | 'productionPlanProposalLine'
  | 'productionPlan'
  | 'productionPlanLine'
  | 'manufacturingOrder'
  | 'productionOperation'
  | 'wipManufacturingOrderLink'
  | 'wipOperationLink'
  | 'productionTransfer'
  | 'inventoryDocument'
  | 'inventoryDocumentLine'
  | 'inventoryTransaction'
  | 'stockBalance'
  | 'inventoryReservation'
  | 'auditLog'
  | 'inventoryAppStateSnapshot'
  | 'wipStateSnapshot';

interface ForeignKeyRule {
  field: string;
  targetTable: TableName;
  nullable?: boolean;
}

interface TableSchema {
  uniqueKeys: string[][];
  foreignKeys: ForeignKeyRule[];
}

// Mirrors exact Prisma schema foreign keys and unique constraints from prisma/schema.prisma
const TABLE_SCHEMAS: Record<TableName, TableSchema> = {
  role: { uniqueKeys: [['id'], ['name']], foreignKeys: [] },
  user: {
    uniqueKeys: [['id'], ['username']],
    foreignKeys: [{ field: 'roleId', targetTable: 'role' }],
  },
  unitOfMeasure: { uniqueKeys: [['id'], ['code']], foreignKeys: [] },
  material: { uniqueKeys: [['id'], ['code']], foreignKeys: [] },
  warehouse: { uniqueKeys: [['id'], ['code']], foreignKeys: [] },
  warehouseLocation: {
    uniqueKeys: [['id'], ['warehouseId', 'code']],
    foreignKeys: [{ field: 'warehouseId', targetTable: 'warehouse' }],
  },
  customer: { uniqueKeys: [['id'], ['code']], foreignKeys: [] },
  shift: { uniqueKeys: [['id'], ['code']], foreignKeys: [] },
  part: {
    uniqueKeys: [['id'], ['partNumber']],
    foreignKeys: [
      { field: 'unitId', targetTable: 'unitOfMeasure' },
      { field: 'materialId', targetTable: 'material', nullable: true },
    ],
  },
  operation: { uniqueKeys: [['id'], ['code']], foreignKeys: [] },
  machine: { uniqueKeys: [['id'], ['code']], foreignKeys: [] },
  machineCapability: {
    uniqueKeys: [['id'], ['machineId', 'operationId']],
    foreignKeys: [
      { field: 'machineId', targetTable: 'machine' },
      { field: 'operationId', targetTable: 'operation' },
    ],
  },
  die: {
    uniqueKeys: [['id'], ['code']],
    foreignKeys: [{ field: 'partId', targetTable: 'part', nullable: true }],
  },
  machineDieCompatibility: {
    uniqueKeys: [['id'], ['machineId', 'dieId']],
    foreignKeys: [
      { field: 'machineId', targetTable: 'machine' },
      { field: 'dieId', targetTable: 'die' },
    ],
  },
  partRoute: {
    uniqueKeys: [['id'], ['partId', 'version']],
    foreignKeys: [{ field: 'partId', targetTable: 'part' }],
  },
  routeOperation: {
    uniqueKeys: [['id'], ['routeId', 'stepNumber']],
    foreignKeys: [
      { field: 'routeId', targetTable: 'partRoute' },
      { field: 'operationId', targetTable: 'operation' },
      { field: 'machineId', targetTable: 'machine', nullable: true },
      { field: 'dieId', targetTable: 'die', nullable: true },
    ],
  },
  materialContract: {
    uniqueKeys: [['id'], ['contractNumber']],
    foreignKeys: [
      { field: 'supplierCustomerId', targetTable: 'customer' },
      { field: 'materialId', targetTable: 'material' },
    ],
  },
  contractCommercialLine: {
    uniqueKeys: [['id']],
    foreignKeys: [
      { field: 'contractId', targetTable: 'materialContract' },
      { field: 'partId', targetTable: 'part' },
    ],
  },
  materialLot: {
    uniqueKeys: [['id'], ['lotNumber']],
    foreignKeys: [
      { field: 'materialId', targetTable: 'material' },
      { field: 'partId', targetTable: 'part', nullable: true },
      { field: 'warehouseLocationId', targetTable: 'warehouseLocation', nullable: true },
      { field: 'supplierContractId', targetTable: 'materialContract', nullable: true },
    ],
  },
  physicalCoil: {
    uniqueKeys: [['id'], ['coilId']],
    foreignKeys: [
      { field: 'partId', targetTable: 'part' },
      { field: 'materialId', targetTable: 'material', nullable: true },
      { field: 'materialLotId', targetTable: 'materialLot', nullable: true },
      { field: 'warehouseId', targetTable: 'warehouse' },
      { field: 'warehouseLocationId', targetTable: 'warehouseLocation', nullable: true },
    ],
  },
  contractCoilAllocation: {
    uniqueKeys: [['id'], ['contractId', 'coilId']],
    foreignKeys: [
      { field: 'contractId', targetTable: 'materialContract' },
      { field: 'coilId', targetTable: 'physicalCoil' },
    ],
  },
  customerOrder: {
    uniqueKeys: [['id'], ['orderNumber']],
    foreignKeys: [{ field: 'customerId', targetTable: 'customer' }],
  },
  customerOrderLine: {
    uniqueKeys: [['id'], ['orderId', 'lineNumber']],
    foreignKeys: [
      { field: 'orderId', targetTable: 'customerOrder' },
      { field: 'partId', targetTable: 'part' },
    ],
  },
  productionPlanProposal: {
    uniqueKeys: [['id'], ['proposalNumber']],
    foreignKeys: [],
  },
  productionPlanProposalLine: {
    uniqueKeys: [['id'], ['proposalId', 'customerOrderLineId']],
    foreignKeys: [
      { field: 'proposalId', targetTable: 'productionPlanProposal' },
      { field: 'customerOrderLineId', targetTable: 'customerOrderLine' },
      { field: 'partId', targetTable: 'part' },
      { field: 'routeId', targetTable: 'partRoute' },
    ],
  },
  productionPlan: {
    uniqueKeys: [['id'], ['planNumber']],
    foreignKeys: [{ field: 'proposalId', targetTable: 'productionPlanProposal', nullable: true }],
  },
  productionPlanLine: {
    uniqueKeys: [['id']],
    foreignKeys: [
      { field: 'planId', targetTable: 'productionPlan' },
      { field: 'customerOrderId', targetTable: 'customerOrder', nullable: true },
      { field: 'customerOrderLineId', targetTable: 'customerOrderLine', nullable: true },
      { field: 'partId', targetTable: 'part' },
    ],
  },
  manufacturingOrder: {
    uniqueKeys: [['id'], ['moNumber']],
    foreignKeys: [
      { field: 'partId', targetTable: 'part' },
      { field: 'routeId', targetTable: 'partRoute' },
      { field: 'planId', targetTable: 'productionPlan', nullable: true },
      { field: 'planLineId', targetTable: 'productionPlanLine', nullable: true },
    ],
  },
  productionOperation: {
    uniqueKeys: [['id'], ['manufacturingOrderId', 'stepNumber']],
    foreignKeys: [
      { field: 'manufacturingOrderId', targetTable: 'manufacturingOrder' },
      { field: 'routeOperationId', targetTable: 'routeOperation', nullable: true },
      { field: 'operationId', targetTable: 'operation' },
      { field: 'plannedMachineId', targetTable: 'machine', nullable: true },
      { field: 'plannedDieId', targetTable: 'die', nullable: true },
    ],
  },
  wipManufacturingOrderLink: {
    uniqueKeys: [['id'], ['wipManufacturingOrderId']],
    foreignKeys: [{ field: 'manufacturingOrderId', targetTable: 'manufacturingOrder' }],
  },
  wipOperationLink: {
    uniqueKeys: [['id'], ['wipOperationId']],
    foreignKeys: [
      { field: 'manufacturingOrderLinkId', targetTable: 'wipManufacturingOrderLink' },
      { field: 'productionOperationId', targetTable: 'productionOperation' },
    ],
  },
  productionTransfer: {
    uniqueKeys: [['id'], ['transferNumber']],
    foreignKeys: [
      { field: 'manufacturingOrderId', targetTable: 'manufacturingOrder' },
      { field: 'fromStageOperationId', targetTable: 'productionOperation', nullable: true },
      { field: 'toStageOperationId', targetTable: 'productionOperation', nullable: true },
      { field: 'partId', targetTable: 'part' },
      { field: 'fromWarehouseId', targetTable: 'warehouse' },
      { field: 'toWarehouseId', targetTable: 'warehouse' },
      { field: 'unitId', targetTable: 'unitOfMeasure' },
    ],
  },
  inventoryDocument: {
    uniqueKeys: [['id'], ['documentNumber']],
    foreignKeys: [
      { field: 'warehouseId', targetTable: 'warehouse' },
      { field: 'targetWarehouseId', targetTable: 'warehouse', nullable: true },
      { field: 'createdByUserId', targetTable: 'user' },
      { field: 'postedByUserId', targetTable: 'user', nullable: true },
      { field: 'reversalOfId', targetTable: 'inventoryDocument', nullable: true },
    ],
  },
  inventoryDocumentLine: {
    uniqueKeys: [['id'], ['documentId', 'lineNumber']],
    foreignKeys: [
      { field: 'documentId', targetTable: 'inventoryDocument' },
      { field: 'partId', targetTable: 'part' },
      { field: 'unitId', targetTable: 'unitOfMeasure' },
      { field: 'locationId', targetTable: 'warehouseLocation', nullable: true },
      { field: 'targetLocationId', targetTable: 'warehouseLocation', nullable: true },
      { field: 'materialLotId', targetTable: 'materialLot', nullable: true },
      { field: 'physicalCoilId', targetTable: 'physicalCoil', nullable: true },
      { field: 'contractId', targetTable: 'materialContract', nullable: true },
    ],
  },
  inventoryTransaction: {
    uniqueKeys: [['id'], ['transactionNumber']],
    foreignKeys: [
      { field: 'documentId', targetTable: 'inventoryDocument', nullable: true },
      { field: 'documentLineId', targetTable: 'inventoryDocumentLine', nullable: true },
      { field: 'partId', targetTable: 'part' },
      { field: 'warehouseId', targetTable: 'warehouse' },
      { field: 'locationId', targetTable: 'warehouseLocation', nullable: true },
      { field: 'materialLotId', targetTable: 'materialLot', nullable: true },
      { field: 'physicalCoilId', targetTable: 'physicalCoil', nullable: true },
      { field: 'contractId', targetTable: 'materialContract', nullable: true },
      { field: 'createdByUserId', targetTable: 'user' },
      { field: 'reversalOfTrxId', targetTable: 'inventoryTransaction', nullable: true },
    ],
  },
  stockBalance: {
    uniqueKeys: [['id']],
    foreignKeys: [
      { field: 'partId', targetTable: 'part' },
      { field: 'warehouseId', targetTable: 'warehouse' },
      { field: 'locationId', targetTable: 'warehouseLocation', nullable: true },
      { field: 'materialLotId', targetTable: 'materialLot', nullable: true },
      { field: 'physicalCoilId', targetTable: 'physicalCoil', nullable: true },
      { field: 'contractId', targetTable: 'materialContract', nullable: true },
    ],
  },
  inventoryReservation: {
    uniqueKeys: [['id'], ['reservationNumber']],
    foreignKeys: [
      { field: 'partId', targetTable: 'part' },
      { field: 'warehouseId', targetTable: 'warehouse' },
      { field: 'materialLotId', targetTable: 'materialLot', nullable: true },
      { field: 'createdByUserId', targetTable: 'user' },
    ],
  },
  auditLog: {
    uniqueKeys: [['id']],
    foreignKeys: [{ field: 'userId', targetTable: 'user', nullable: true }],
  },
  inventoryAppStateSnapshot: { uniqueKeys: [['id']], foreignKeys: [] },
  wipStateSnapshot: { uniqueKeys: [['id']], foreignKeys: [] },
};

function cloneValue<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (value instanceof Prisma.Decimal) return new Prisma.Decimal(value.toString()) as unknown as T;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as unknown as T;
  if (typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      copy[k] = cloneValue(v);
    }
    return copy as T;
  }
  return value;
}

interface MockFaultConfig {
  table: TableName;
  op: 'create' | 'update';
  onCall: number;
  message: string;
}

function createTransactionalMockPrisma(
  seed: Partial<Record<TableName, Array<Record<string, any>>>> = {},
  fault?: MockFaultConfig,
) {
  let store: Record<TableName, Array<Record<string, any>>> = {} as any;
  for (const table of Object.keys(TABLE_SCHEMAS) as TableName[]) {
    store[table] = cloneValue(seed[table] ?? []);
  }
  const opCounts = new Map<string, number>();
  let totalWrites = 0;
  let lastTransactionOptions: Record<string, any> | undefined;

  const validateRow = (
    targetStore: Record<TableName, Array<Record<string, any>>>,
    table: TableName,
    row: Record<string, any>,
    excludeId?: string,
  ) => {
    const schema = TABLE_SCHEMAS[table];
    for (const uk of schema.uniqueKeys) {
      const tuple = uk.map((k) => row[k]);
      if (tuple.some((v) => v === undefined || v === null)) continue;
      const dup = targetStore[table].find(
        (existing) =>
          existing.id !== excludeId && uk.every((k, idx) => String(existing[k]) === String(tuple[idx])),
      );
      if (dup) {
        throw new Error(`Unique constraint violation on ${table}(${uk.join(', ')}): ${tuple.join(', ')}`);
      }
    }
    for (const fk of schema.foreignKeys) {
      const val = row[fk.field];
      if (val === null || val === undefined) {
        if (!fk.nullable) {
          throw new Error(`NOT NULL FK violation on ${table}.${fk.field} -> ${fk.targetTable}.id`);
        }
        continue;
      }
      const found = targetStore[fk.targetTable].some((targetRow) => targetRow.id === val);
      if (!found) {
        throw new Error(
          `Foreign key constraint violation on ${table}.${fk.field}="${val}" -> ${fk.targetTable}.id (not found)`,
        );
      }
    }
  };

  const buildDelegates = (getTargetStore: () => Record<TableName, Array<Record<string, any>>>) => {
    const client: Record<string, any> = {};
    for (const table of Object.keys(TABLE_SCHEMAS) as TableName[]) {
      client[table] = {
        findMany: async () => cloneValue(getTargetStore()[table]),
        findUnique: async ({ where }: { where: Record<string, any> }) => {
          const rows = getTargetStore()[table];
          const found = rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
          return found ? cloneValue(found) : null;
        },
        create: async ({ data }: { data: Record<string, any> }) => {
          const countKey = `${table}:create`;
          const callNum = (opCounts.get(countKey) ?? 0) + 1;
          opCounts.set(countKey, callNum);
          if (fault && fault.table === table && fault.op === 'create' && fault.onCall === callNum) {
            throw new Error(fault.message);
          }
          totalWrites += 1;
          const target = getTargetStore();
          const row = cloneValue({
            id: data.id ?? crypto.randomUUID(),
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data,
          });
          validateRow(target, table, row);
          target[table].push(row);
          return cloneValue(row);
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
          const countKey = `${table}:update`;
          const callNum = (opCounts.get(countKey) ?? 0) + 1;
          opCounts.set(countKey, callNum);
          if (fault && fault.table === table && fault.op === 'update' && fault.onCall === callNum) {
            throw new Error(fault.message);
          }
          totalWrites += 1;
          const target = getTargetStore();
          const idx = target[table].findIndex((r) => r.id === where.id);
          if (idx === -1) {
            throw new Error(`Record not found for ${table}.update(id=${where.id})`);
          }
          const updated = cloneValue({ ...target[table][idx], ...data, updatedAt: new Date() });
          validateRow(target, table, updated, where.id);
          target[table][idx] = updated;
          return cloneValue(updated);
        },
      };
    }

    client.$transaction = async (fn: (tx: any) => Promise<any>, options?: Record<string, any>) => {
      lastTransactionOptions = options;
      const txStore = cloneValue(store);
      const txDelegates = buildDelegates(() => txStore);
      const result = await fn(txDelegates);
      // Commit atomically ONLY if fn resolves without error
      store = txStore;
      return result;
    };

    return client as unknown as PrismaClient;
  };

  return {
    prisma: buildDelegates(() => store),
    getStore: () => store,
    getTotalWrites: () => totalWrites,
    getLastTransactionOptions: () => lastTransactionOptions,
  };
}

function buildRealisticSeedAndSnapshot(): {
  seed: Partial<Record<TableName, Array<Record<string, any>>>>;
  bundle: SnapshotDataBundle;
} {
  const seed: Partial<Record<TableName, Array<Record<string, any>>>> = {
    unitOfMeasure: [
      { id: 'UOM-PCS', code: 'PCS', name: 'عدد', symbol: 'عدد', isWeightBased: false },
      { id: 'UOM-KG', code: 'KG', name: 'کیلوگرم', symbol: 'kg', isWeightBased: true },
    ],
    material: [
      {
        id: 'MAT-DC01A',
        code: 'MAT-DC01A',
        name: 'ورق فولادی روغنی DC01A',
        grade: 'DC01A',
        type: 'COLD_ROLLED',
        thicknessMm: new Prisma.Decimal('2.0'),
        densityKgM3: new Prisma.Decimal('7850'),
        active: true,
      },
    ],
    warehouse: [
      { id: 'WH-RAW', code: 'WH-RAW', name: 'انبار مواد اولیه', type: 'RAW_MATERIAL', active: true },
      { id: 'WH-WIP-STAMP', code: 'WH-WIP-STAMP', name: 'انبار نیمه‌ساخته پرس', type: 'WIP', active: true },
      { id: 'WH-WIP-WELD', code: 'WH-WIP-WELD', name: 'انبار نیمه‌ساخته جوش', type: 'WIP', active: true },
      { id: 'WH-FINISHED', code: 'WH-FINISHED', name: 'انبار محصول نهایی', type: 'FINISHED_GOODS', active: true },
    ],
    warehouseLocation: [
      { id: 'LOC-01', warehouseId: 'WH-RAW', code: 'LOC-RAW-A1', active: true },
      { id: 'LOC-02', warehouseId: 'WH-RAW', code: 'LOC-RAW-A2', active: true },
      { id: 'LOC-03', warehouseId: 'WH-FINISHED', code: 'LOC-FIN-P1', active: true },
    ],
    customer: [{ id: 'CUST-SAPCO', code: 'CUST-SAPCO', name: 'ساپکو', active: true }],
    shift: [],
    part: [
      // Canonical UUID parts matching snapshot codes
      { id: 'UUID-611408', partNumber: '611408', name: 'براکت ECU نهایی', category: 'FINISHED_GOOD', unitId: 'UOM-PCS', materialId: 'MAT-DC01A', weightNetKg: new Prisma.Decimal('0.85'), weightGrossKg: new Prisma.Decimal('0.98'), minSafetyStock: DECIMAL_ZERO, active: true },
      { id: 'UUID-700014', partNumber: '700014', name: 'براکت اصلی نیمه‌ساخته', category: 'SEMI_FINISHED', unitId: 'UOM-PCS', materialId: 'MAT-DC01A', weightNetKg: new Prisma.Decimal('0.60'), weightGrossKg: new Prisma.Decimal('0.70'), minSafetyStock: DECIMAL_ZERO, active: true },
      { id: 'UUID-700026', partNumber: '700026', name: 'قطعه مکمل نیمه‌ساخته', category: 'SEMI_FINISHED', unitId: 'UOM-PCS', materialId: 'MAT-DC01A', weightNetKg: new Prisma.Decimal('0.25'), weightGrossKg: new Prisma.Decimal('0.28'), minSafetyStock: DECIMAL_ZERO, active: true },
      { id: 'UUID-RAW-COIL-1', partNumber: 'RM-COIL-DC01A-2.0-1140', name: 'کویل ورق DC01A عرض 1140', category: 'RAW_MATERIAL', unitId: 'UOM-KG', materialId: 'MAT-DC01A', weightNetKg: new Prisma.Decimal('1'), weightGrossKg: new Prisma.Decimal('1'), minSafetyStock: DECIMAL_ZERO, active: true },
      { id: 'UUID-RAW-COIL-2', partNumber: 'RM-SHT-DC01A-2.0-1000', name: 'ورق DC01A عرض 1000', category: 'RAW_MATERIAL', unitId: 'UOM-KG', materialId: 'MAT-DC01A', weightNetKg: new Prisma.Decimal('1'), weightGrossKg: new Prisma.Decimal('1'), minSafetyStock: DECIMAL_ZERO, active: true },
      { id: 'UUID-FST-M6', partNumber: 'FST-NUT-WELD-M6', name: 'مهره جوش M6', category: 'COMPONENT', unitId: 'UOM-PCS', materialId: null, weightNetKg: new Prisma.Decimal('0.006'), weightGrossKg: new Prisma.Decimal('0.006'), minSafetyStock: DECIMAL_ZERO, active: true },
      // 3 relational-only legacy parts that MUST be preserved untouched
      { id: 'PRT-FGD-ECU-BRK', partNumber: 'SAPCO-ASY-ECU-BRK-01', name: 'Legacy Finished ECU Bracket', category: 'FINISHED_GOOD', unitId: 'UOM-PCS', materialId: 'MAT-DC01A', weightNetKg: new Prisma.Decimal('0.85'), weightGrossKg: new Prisma.Decimal('0.98'), minSafetyStock: DECIMAL_ZERO, active: true },
      { id: 'PRT-WIP-ECU-MAIN', partNumber: 'WIP-ECU-MAIN-BRK', name: 'Legacy WIP Main Bracket', category: 'SEMI_FINISHED', unitId: 'UOM-PCS', materialId: 'MAT-DC01A', weightNetKg: new Prisma.Decimal('0.60'), weightGrossKg: new Prisma.Decimal('0.70'), minSafetyStock: DECIMAL_ZERO, active: true },
      { id: 'PRT-WIP-ECU-COMP', partNumber: 'WIP-ECU-COMP-BRK', name: 'Legacy WIP Comp Bracket', category: 'SEMI_FINISHED', unitId: 'UOM-PCS', materialId: 'MAT-DC01A', weightNetKg: new Prisma.Decimal('0.25'), weightGrossKg: new Prisma.Decimal('0.28'), minSafetyStock: DECIMAL_ZERO, active: true },
    ],
    physicalCoil: [
      {
        id: 'REL-COIL-1',
        coilId: 'COIL-ECU-001',
        coilPackNumber: 'MOB-DC01A-2.0-1140-A',
        partId: 'UUID-RAW-COIL-1',
        materialId: 'MAT-DC01A',
        warehouseId: 'WH-RAW',
        thicknessMm: new Prisma.Decimal('2.0'),
        widthMm: new Prisma.Decimal('1140'),
        originalWeightKg: new Prisma.Decimal('10500'),
        remainingWeightKg: new Prisma.Decimal('8499.999999999998'),
        materialLotId: null,
        warehouseLocationId: null,
        ownership: 'SAPCO_SUPPLIER_OWNED',
        qualityStatus: 'AVAILABLE',
        physicalStatus: 'AVAILABLE',
      },
      {
        id: 'REL-COIL-2',
        coilId: 'COIL-ECU-002',
        coilPackNumber: 'MOB-DC01A-2.0-1000-ALT',
        partId: 'UUID-RAW-COIL-2',
        materialId: 'MAT-DC01A',
        warehouseId: 'WH-RAW',
        thicknessMm: new Prisma.Decimal('2.0'),
        widthMm: new Prisma.Decimal('1000'),
        originalWeightKg: new Prisma.Decimal('3200'),
        remainingWeightKg: new Prisma.Decimal('3200'),
        materialLotId: null,
        warehouseLocationId: null,
        ownership: 'COMPANY_OWNED',
        qualityStatus: 'AVAILABLE',
        physicalStatus: 'AVAILABLE',
      },
    ],
  };

  // Build 16 sequential WIP operations & matching routing steps
  const routingOps = Array.from({ length: 16 }, (_, idx) => ({
    stepNumber: (idx + 1) * 10,
    stepCode: `OP-${String(idx + 1).padStart(2, '0')}`,
    stepName: `مرحله ${idx + 1}`,
    processType: idx < 5 ? 'STAMPING' : idx < 10 ? 'BENDING' : idx < 14 ? 'WELDING' : 'PAINTING',
    machineId: idx % 2 === 0 ? 'MCH-001' : 'MCH-002',
    dieId: idx === 0 ? 'DIE-001' : null,
    setupTimeMin: 30,
    cycleTimeSec: 12,
    standardScrapPercent: 1.5,
  }));

  const wipOps = routingOps.map((r, idx) => ({
    id: `WIP-OP-${idx + 1}`,
    stepNumber: r.stepNumber,
    stepCode: r.stepCode,
    operationName: r.stepName,
    processType: r.processType,
    machineId: r.machineId,
    dieMoldId: r.dieId,
    warehouseLocation: idx < 8 ? 'LOC-WIP-PUNCH' : 'LOC-WIP-WELD-01',
    waitingInputQty: idx === 0 ? 745 : 250,
    inProgressQty: 0,
    goodOutputQty: idx === 0 ? 250 : 0,
    scrapQty: idx === 0 ? 5 : 0,
    reworkQty: 0,
    rejectedQty: 0,
    status: idx === 0 ? 'IN_PROGRESS' : 'PENDING',
  }));

  // 7x duplicated legacy transactions matching live snapshot anomaly (49 entries)
  const baseLegacyTx = [
    { id: 'TX-ECU-001', partCode: 'RM-COIL-DC01A-2.0-1140', qty: 8500 },
    { id: 'TX-ECU-002', partCode: 'RM-SHT-DC01A-2.0-1000', qty: 3200 },
    { id: 'TX-ECU-003', partCode: 'FST-NUT-WELD-M6', qty: 18500 },
    { id: 'TX-ECU-004', partCode: '700014', qty: 420 },
    { id: 'TX-ECU-005', partCode: '700026', qty: 460 },
    { id: 'TX-ECU-006', partCode: '611408', qty: 350 },
    { id: 'TX-ECU-007', partCode: '611408', qty: 50 },
  ];
  const duplicated49LegacyTx = Array.from({ length: 7 }, () => baseLegacyTx).flat();

  const bundle: SnapshotDataBundle = {
    inventorySnapshotId: 'inventory-app-state',
    inventoryUpdatedAt: '2026-11-24T10:00:00.000Z',
    wipSnapshotId: 'production-wip-state',
    wipVersion: 4,
    wipUpdatedAt: '2026-11-24T10:05:00.000Z',
    inventoryPayload: {
      units: [
        { id: 'UOM-PCS', code: 'PCS', name: 'عدد' },
        { id: 'UOM-KG', code: 'KG', name: 'کیلوگرم' },
      ],
      materialGrades: [{ id: 'MAT-DC01', code: 'MAT-DC01', grade: 'DC01', name: 'ورق DC01', thicknessMm: 2.0 }],
      warehouses: [
        { id: 'WH-RAW', code: 'WH-RAW', name: 'انبار مواد اولیه', type: 'RAW_MATERIAL', locations: ['LOC-RAW-A1', 'LOC-RAW-A2', 'LOC-RAW-FST-01'] },
        { id: 'WH-WIP-STAMP', code: 'WH-WIP-STAMP', name: 'انبار نیمه‌ساخته پرس', type: 'WIP', locations: [] },
        { id: 'WH-WIP-WELD', code: 'WH-WIP-WELD', name: 'انبار نیمه‌ساخته جوش', type: 'WIP', locations: [] },
        { id: 'WH-FINISHED', code: 'WH-FINISHED', name: 'انبار محصول نهایی', type: 'FINISHED_GOODS', locations: ['LOC-FIN-P1'] },
      ],
      customers: [{ id: 'CUST-SAPCO', code: 'CUST-SAPCO', name: 'ساپکو' }],
      shifts: [{ id: 'SHF-1', code: 'SHF-MORNING', name: 'شیفت صبح', startTime: '07:00', endTime: '15:30', netWorkMinutes: 450 }],
      parts: [
        { id: 'PRT-FGD-ECU-BRK', code: '611408', name: 'براکت ECU نهایی', category: 'FINISHED_GOOD', unit: 'PCS', materialGrade: 'DC01A' },
        { id: 'PRT-WIP-ECU-MAIN', code: '700014', name: 'براکت اصلی نیمه‌ساخته', category: 'SEMI_FINISHED', unit: 'PCS', materialGrade: 'DC01A' },
        { id: 'PRT-WIP-ECU-COMP', code: '700026', name: 'قطعه مکمل نیمه‌ساخته', category: 'SEMI_FINISHED', unit: 'PCS', materialGrade: 'DC01A' },
        { id: 'UUID-RAW-COIL-1', code: 'RM-COIL-DC01A-2.0-1140', name: 'کویل ورق DC01A عرض 1140', category: 'RAW_MATERIAL', unit: 'KG', materialGrade: 'DC01A' },
        { id: 'UUID-RAW-COIL-2', code: 'RM-SHT-DC01A-2.0-1000', name: 'ورق DC01A عرض 1000', category: 'RAW_MATERIAL', unit: 'KG', materialGrade: 'DC01A' },
        { id: 'UUID-FST-M6', code: 'FST-NUT-WELD-M6', name: 'مهره جوش M6', category: 'COMPONENT', unit: 'PCS' },
      ],
      operations: routingOps.map((r) => ({
        code: r.stepCode,
        name: r.stepName,
        processType: r.processType,
      })),
      machines: [
        { id: 'MCH-001', code: 'PRS-400-01', name: 'پرس ۴۰۰ تن', machineType: 'PRESS', tonnage: 400, status: 'AVAILABLE', capabilities: ['OP-01', 'OP-03'] },
        { id: 'MCH-002', code: 'WLD-ROB-01', name: 'ربات جوش', machineType: 'WELDING', tonnage: 0, status: 'AVAILABLE', capabilities: ['OP-02', 'OP-11'] },
      ],
      dies: [
        { id: 'DIE-001', code: 'DIE-ECU-BLK', name: 'قالب بلنک براکت', dieType: 'BLANKING', partId: 'PRT-FGD-ECU-BRK', partCode: '611408', compatibleMachineIds: ['MCH-001'], status: 'READY' },
      ],
      routings: [
        {
          id: 'RTG-ECU-01',
          partId: 'PRT-FGD-ECU-BRK',
          partCode: '611408',
          version: 'V1.0',
          name: 'مسیر ساخت براکت ECU',
          status: 'ACTIVE',
          operations: routingOps,
        },
      ],
      contracts: [
        {
          id: 'CNT-SAPCO-ECU-BRK',
          contractNumber: 'CNT-SAPCO-ECU-BRK',
          customerId: 'CUST-SAPCO',
          materialGrade: 'DC01A',
          allocatedWeightKg: 50000,
          totalReceivedKg: 11700,
          status: 'ACTIVE',
          startDate: '2026-01-01T00:00:00.000Z',
          endDate: '2026-12-31T00:00:00.000Z',
          coils: [
            { coilId: 'COIL-ECU-001', allocatedWeightKg: 8500 },
            { coilId: 'COIL-ECU-002', allocatedWeightKg: 3200 },
          ],
          commercialLines: [
            { id: 'CL-ECU-1', partId: 'PRT-FGD-ECU-BRK', partCode: '611408', contractQty: 10000, contractWeightKg: 8500, unit: 'PCS' },
          ],
        },
      ],
      physicalCoils: [
        {
          id: 'REL-COIL-1',
          coilId: 'COIL-ECU-001',
          coilPackNumber: 'MOB-DC01A-2.0-1140-A',
          partId: 'UUID-RAW-COIL-1',
          partCode: 'RM-COIL-DC01A-2.0-1140',
          materialGrade: 'DC01A',
          warehouseId: 'WH-RAW',
          warehouseLocationCode: 'LOC-RAW-A1',
          thicknessMm: 2.0,
          widthMm: 1140,
          originalWeightKg: 10500,
          remainingWeightKg: 8499.999999999998, // IEEE-754 float artifact
          ownership: 'SAPCO_SUPPLIER_OWNED',
          qualityStatus: 'AVAILABLE',
          physicalStatus: 'AVAILABLE',
          allocations: [], // Empty in snapshot -> fallback to contract.coils
        },
        {
          id: 'REL-COIL-2',
          coilId: 'COIL-ECU-002',
          coilPackNumber: 'MOB-DC01A-2.0-1000-ALT',
          partId: 'UUID-RAW-COIL-2',
          partCode: 'RM-SHT-DC01A-2.0-1000',
          materialGrade: 'DC01A',
          warehouseId: 'WH-RAW',
          warehouseLocationCode: 'LOC-RAW-A2',
          thicknessMm: 2.0,
          widthMm: 1000,
          originalWeightKg: 3200,
          remainingWeightKg: 3200,
          ownership: 'COMPANY_OWNED',
          qualityStatus: 'AVAILABLE',
          physicalStatus: 'AVAILABLE',
          allocations: [],
        },
      ],
      customerOrders: [
        {
          id: 'ORD-ECU-001',
          orderNumber: 'ORD-SAPCO-2026-01',
          customerId: 'CUST-SAPCO',
          contractNumber: 'CNT-SAPCO-ECU-BRK',
          orderDate: '2026-11-01T00:00:00.000Z',
          dueDate: '2026-12-15T00:00:00.000Z',
          lines: [
            { id: 'ORDL-ECU-1', lineNumber: 1, partId: 'PRT-FGD-ECU-BRK', partCode: '611408', orderedQuantity: 2000, dueDate: '2026-12-15T00:00:00.000Z' },
          ],
        },
      ],
      fallbackPlanProposals: [
        {
          id: 'PROP-ECU-001',
          proposalNumber: 'PROP-1405-001',
          status: 'APPROVED',
          generatedAt: '2026-11-05T00:00:00.000Z',
          lines: [
            { id: 'PROPL-1', customerOrderLineId: 'ORDL-ECU-1', partId: 'PRT-FGD-ECU-BRK', partCode: '611408', routeId: 'RTG-ECU-01', requestedQty: 2000, plannedQty: 1000 },
          ],
        },
      ],
      plans: [
        {
          id: 'PLAN-ECU-001',
          planNumber: 'PLN-1405-001',
          partId: 'PRT-FGD-ECU-BRK',
          partCode: '611408',
          plannedQty: 1000,
          producedQty: 250,
          status: 'APPROVED',
          startDate: '2026-11-10T00:00:00.000Z',
          endDate: '2026-11-30T00:00:00.000Z',
        },
      ],
      inventoryDocuments: [
        // 1. Opening Balance Raw (Coils + Fasteners)
        {
          id: 'DOC-OB-ECU-RAW',
          documentNumber: 'OB-ECU-RAW-001',
          documentType: 'OPENING_BALANCE',
          documentStatus: 'POSTED',
          postingStatus: 'POSTED',
          warehouseId: 'WH-RAW',
          documentDate: '2026-11-01T08:00:00.000Z',
          createdByUid: 'USR-ADMIN',
          createdByName: 'مدیر سیستم',
          postedByUid: 'USR-WH-01',
          postedByName: 'انباردار',
          postedAt: '2026-11-01T08:05:00.000Z',
          lines: [
            { lineNumber: 1, partId: 'UUID-RAW-COIL-1', partCode: 'RM-COIL-DC01A-2.0-1140', unit: 'KG', quantity: 8500, quantityKg: 8500, locationCode: 'LOC-RAW-A1', lotNumber: 'MOB-DC01A-2.0-1140-A', physicalCoilId: 'COIL-ECU-001', ownership: 'SAPCO_SUPPLIER_OWNED', contractId: 'CNT-SAPCO-ECU-BRK', qualityStatus: 'AVAILABLE' },
            { lineNumber: 2, partId: 'UUID-RAW-COIL-2', partCode: 'RM-SHT-DC01A-2.0-1000', unit: 'KG', quantity: 3200, quantityKg: 3200, locationCode: 'LOC-RAW-A2', lotNumber: 'MOB-DC01A-2.0-1000-ALT', physicalCoilId: 'COIL-ECU-002', ownership: 'COMPANY_OWNED', contractId: 'CNT-SAPCO-ECU-BRK', qualityStatus: 'AVAILABLE' },
            { lineNumber: 3, partId: 'UUID-FST-M6', partCode: 'FST-NUT-WELD-M6', unit: 'PCS', quantity: 18500, quantityKg: 111, locationCode: 'LOC-RAW-FST-01', lotNumber: 'LOT-NUT-M6-101', ownership: 'SAPCO_SUPPLIER_OWNED', contractId: 'CNT-SAPCO-ECU-BRK', qualityStatus: 'AVAILABLE' },
          ],
        },
        // 2. Active Issue to WIP (19.6 kg from COIL-ECU-001, omitting contractId -> inherited from lot bucket)
        {
          id: 'DOC-ISS-436111',
          documentNumber: 'ISS-WIP-436111',
          documentType: 'ISSUE_TO_PRODUCTION',
          documentStatus: 'POSTED',
          postingStatus: 'POSTED',
          warehouseId: 'WH-RAW',
          documentDate: '2026-11-05T09:00:00.000Z',
          createdByUid: 'USR-WH-01',
          postedByUid: 'USR-WH-01',
          postedAt: '2026-11-05T09:01:00.000Z',
          lines: [
            { lineNumber: 1, partId: 'UUID-RAW-COIL-1', partCode: 'RM-COIL-DC01A-2.0-1140', unit: 'KG', quantity: 19.6, quantityKg: 19.6, locationCode: 'LOC-RAW-A1', lotNumber: 'MOB-DC01A-2.0-1140-A', physicalCoilId: 'COIL-ECU-001', ownership: 'SAPCO_SUPPLIER_OWNED', qualityStatus: 'AVAILABLE' },
          ],
        },
        // 3. Reversed Issue (9.8 kg) + its Reversal document -> MUST net to exact 0
        {
          id: 'DOC-ISS-969472',
          documentNumber: 'ISS-WIP-969472',
          documentType: 'ISSUE_TO_PRODUCTION',
          documentStatus: 'REVERSED',
          postingStatus: 'REVERSED',
          warehouseId: 'WH-RAW',
          documentDate: '2026-11-06T09:00:00.000Z',
          createdByUid: 'USR-WH-01',
          postedByUid: 'USR-WH-01',
          postedAt: '2026-11-06T09:01:00.000Z',
          lines: [
            { lineNumber: 1, partId: 'UUID-RAW-COIL-1', partCode: 'RM-COIL-DC01A-2.0-1140', unit: 'KG', quantity: 9.8, quantityKg: 9.8, locationCode: 'LOC-RAW-A1', lotNumber: 'MOB-DC01A-2.0-1140-A', physicalCoilId: 'COIL-ECU-001', ownership: 'SAPCO_SUPPLIER_OWNED', qualityStatus: 'AVAILABLE' },
          ],
        },
        {
          id: 'DOC-REV-969472',
          documentNumber: 'REV-ISS-WIP-969472',
          documentType: 'REVERSAL',
          documentStatus: 'POSTED',
          postingStatus: 'POSTED',
          warehouseId: 'WH-RAW',
          reversalOfDocId: 'DOC-ISS-969472',
          referenceNumber: 'ISS-WIP-969472',
          documentDate: '2026-11-06T09:10:00.000Z',
          createdByUid: 'USR-WH-01',
          postedByUid: 'USR-WH-01',
          postedAt: '2026-11-06T09:11:00.000Z',
          lines: [
            { lineNumber: 1, partId: 'UUID-RAW-COIL-1', partCode: 'RM-COIL-DC01A-2.0-1140', unit: 'KG', quantity: 9.8, quantityKg: 9.8, locationCode: 'LOC-RAW-A1', lotNumber: 'MOB-DC01A-2.0-1140-A', physicalCoilId: 'COIL-ECU-001', ownership: 'SAPCO_SUPPLIER_OWNED', qualityStatus: 'AVAILABLE' },
          ],
        },
        // 4. QM Status Transfer Pair (MvT 322 AVAILABLE -> QUARANTINE 25 kg, then MvT 321 QUARANTINE -> AVAILABLE 25 kg)
        {
          id: 'DOC-QM-322',
          documentNumber: 'QM-322-528448',
          documentType: 'STOCK_STATUS_TRANSFER',
          documentStatus: 'POSTED',
          postingStatus: 'POSTED',
          warehouseId: 'WH-RAW',
          movementType: '322',
          documentDate: '2026-11-07T10:00:00.000Z',
          createdByUid: 'USR-QC-01',
          postedByUid: 'USR-QC-01',
          postedAt: '2026-11-07T10:01:00.000Z',
          lines: [
            { lineNumber: 1, partId: 'UUID-RAW-COIL-1', partCode: 'RM-COIL-DC01A-2.0-1140', unit: 'KG', quantity: 25, quantityKg: 25, locationCode: 'LOC-RAW-A1', lotNumber: 'MOB-DC01A-2.0-1140-A', physicalCoilId: 'COIL-ECU-001', ownership: 'SAPCO_SUPPLIER_OWNED', contractId: 'CNT-SAPCO-ECU-BRK', fromQualityStatus: 'AVAILABLE', toQualityStatus: 'QUARANTINE' },
          ],
        },
        {
          id: 'DOC-QM-321',
          documentNumber: 'QM-321-528487',
          documentType: 'STOCK_STATUS_TRANSFER',
          documentStatus: 'POSTED',
          postingStatus: 'POSTED',
          warehouseId: 'WH-RAW',
          movementType: '321',
          documentDate: '2026-11-07T12:00:00.000Z',
          createdByUid: 'USR-QC-01',
          postedByUid: 'USR-QC-01',
          postedAt: '2026-11-07T12:01:00.000Z',
          lines: [
            { lineNumber: 1, partId: 'UUID-RAW-COIL-1', partCode: 'RM-COIL-DC01A-2.0-1140', unit: 'KG', quantity: 25, quantityKg: 25, locationCode: 'LOC-RAW-A1', lotNumber: 'MOB-DC01A-2.0-1140-A', physicalCoilId: 'COIL-ECU-001', ownership: 'SAPCO_SUPPLIER_OWNED', contractId: 'CNT-SAPCO-ECU-BRK', fromQualityStatus: 'QUARANTINE', toQualityStatus: 'AVAILABLE' },
          ],
        },
        // 5. Draft document with negative quantity & non-canonical ownership -> 0 transactions/balance impact
        {
          id: 'DOC-1794858905956',
          documentNumber: 'OB-1403-261116-3705',
          documentType: 'OPENING_BALANCE',
          documentStatus: 'DRAFT',
          postingStatus: 'UNPOSTED',
          warehouseId: 'WH-FINISHED',
          documentDate: '2026-11-16T00:00:00.000Z',
          createdByUid: 'USR-ADMIN',
          lines: [
            { lineNumber: 1, partId: 'PRT-FGD-ECU-BRK', partCode: '611408', unit: 'PCS', quantity: -5, quantityKg: -4.25, locationCode: 'LOC-FIN-P1', ownership: 'OWNED', qualityStatus: 'AVAILABLE' },
          ],
        },
        // 6. Cancelled document -> 0 transactions/balance impact
        {
          id: 'DOC-1795009441315',
          documentNumber: 'ISS-CANCELLED-001',
          documentType: 'ISSUE_TO_PRODUCTION',
          documentStatus: 'CANCELLED',
          postingStatus: 'UNPOSTED',
          warehouseId: 'WH-RAW',
          documentDate: '2026-11-17T00:00:00.000Z',
          createdByUid: 'USR-WH-01',
          lines: [
            { lineNumber: 1, partId: 'UUID-RAW-COIL-1', partCode: 'RM-COIL-DC01A-2.0-1140', unit: 'KG', quantity: 500, quantityKg: 500, locationCode: 'LOC-RAW-A1', lotNumber: 'MOB-DC01A-2.0-1140-A', physicalCoilId: 'COIL-ECU-001', ownership: 'SAPCO_SUPPLIER_OWNED', contractId: 'CNT-SAPCO-ECU-BRK', qualityStatus: 'AVAILABLE' },
          ],
        },
      ],
      reservations: [
        {
          id: 'RES-ECU-001',
          reservationNumber: 'RES-ECU-001',
          partId: 'UUID-RAW-COIL-1',
          partCode: 'RM-COIL-DC01A-2.0-1140',
          warehouseId: 'WH-RAW',
          lotNumber: 'MOB-DC01A-2.0-1140-A',
          quantity: 1200,
          quantityKg: 1200,
          status: 'ACTIVE',
          validUntil: '2026-11-23T00:00:00.000Z', // Past date
          createdByUid: 'USR-ADMIN',
        },
      ],
      auditLogs: [
        {
          id: 'AUD-001',
          action: 'POST_DOCUMENT',
          entityName: 'InventoryDocument',
          entityId: 'DOC-OB-ECU-RAW',
          timestamp: '2026-11-01T08:05:00.000Z',
          user: { uid: 'USR-WH-01', displayName: 'انباردار' },
          details: 'Opening balance posted',
        },
      ],
      // Unsupported / excluded keys to verify explicit reporting
      transactions: duplicated49LegacyTx,
      coils: [{ id: 'LEGACY-COIL-1', receivedWeightKg: 10500, consumedWeightKg: 2019.6 }],
      advancedBoms: [{ id: 'BOM-ECU-1', parentPartCode: '611408', components: [] }],
      customUnexpectedSnapshotKey: [{ id: 'UNEXPECTED-1' }],
    },
    wipPayload: {
      manufacturingOrders: [
        {
          id: 'WIP-MO-ECU-001',
          moNumber: 'MO-ECU-2026-001',
          partId: 'PRT-FGD-ECU-BRK',
          partCode: '611408',
          routingId: 'RTG-ECU-01',
          targetQuantity: 1000,
          completedQuantity: 250,
          totalScrapQuantity: 5,
          status: 'IN_PROGRESS',
          operations: wipOps,
        },
      ],
      wipTransfers: [
        {
          id: 'TRF-WIP-001',
          transferNumber: 'TRF-WIP-001',
          moId: 'WIP-MO-ECU-001',
          moNumber: 'MO-ECU-2026-001',
          fromOperationId: 'WIP-OP-1',
          toOperationId: 'WIP-OP-2',
          partId: 'PRT-FGD-ECU-BRK',
          partCode: '611408',
          fromLocation: 'LOC-WIP-PUNCH',
          toLocation: 'LOC-WIP-WELD-01',
          quantity: 150,
          status: 'RECEIVED',
        },
        {
          id: 'TRF-WIP-002',
          transferNumber: 'TRF-WIP-002',
          moId: 'WIP-MO-ECU-001',
          moNumber: 'MO-ECU-2026-001',
          fromOperationId: 'WIP-OP-1',
          toOperationId: 'WIP-OP-2',
          partId: 'PRT-FGD-ECU-BRK',
          partCode: '611408',
          fromLocation: 'LOC-WIP-PUNCH',
          toLocation: 'LOC-WIP-WELD-01',
          quantity: 100,
          status: 'IN_TRANSIT',
        },
      ],
    },
  };

  return { seed, bundle };
}

async function runTests(): Promise<void> {
  const results: Array<{ name: string; status: 'PASS' | 'FAIL'; error?: string }> = [];

  const testCase = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      results.push({ name, status: 'PASS' });
      console.log(`  [PASS] ${name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ name, status: 'FAIL', error: msg });
      console.error(`  [FAIL] ${name}: ${msg}`);
    }
  };

  console.log('Running KPIMS Snapshot-to-Relational Backfill Test Suite...\n');

  // Test 1: Decimal utilities & float artifact normalization
  await testCase('1. Prisma.Decimal precision & IEEE-754 float artifact normalization', async () => {
    const drift = normalizeFloatArtifact(8499.999999999998);
    assert.equal(drift.hadFloatArtifact, true);
    assert.equal(formatDecimal(drift.normalized), '8500');

    const exact = normalizeFloatArtifact('8480.4');
    assert.equal(exact.hadFloatArtifact, false);
    assert.equal(formatDecimal(exact.normalized), '8480.4');

    // Exact arithmetic with no float drift: 8500 - 19.6 - 9.8 + 9.8 - 1200 = 7280.4
    const afterIssue = decimalSub(toDecimal('8500'), toDecimal('19.6'));
    const afterRevPair = decimalAdd(decimalSub(afterIssue, toDecimal('9.8')), toDecimal('9.8'));
    assert.equal(decimalEq(afterRevPair, toDecimal('8480.4')), true);
    const avail = decimalSub(afterRevPair, toDecimal('1200'));
    assert.equal(formatDecimal(avail), '7280.4');

    assert.throws(() => toDecimal(Number.NaN));
    assert.throws(() => toDecimal(Number.POSITIVE_INFINITY));
  });

  // Test 2: Dry-run mode performs ZERO writes and produces full reconciliation report
  await testCase('2. Dry-run mode performs zero writes & reports unsupported keys', async () => {
    const { seed, bundle } = buildRealisticSeedAndSnapshot();
    const mock = createTransactionalMockPrisma(seed);

    const report = await runSnapshotToRelationalBackfill(mock.prisma, bundle, { mode: 'dry-run' });
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.applied, false);
    assert.equal(mock.getTotalWrites(), 0, 'Dry-run must execute zero write calls');
    assert.equal(report.preservedRelationalOnlyParts.length, 3);
    assert.ok(report.summary.totalPlannedInserts > 0);
    assert.ok(report.unsupportedEntities.some((u) => u.snapshotKey === 'transactions' && u.sourceCount === 49));
    assert.ok(report.unsupportedEntities.some((u) => u.snapshotKey === 'advancedBoms'));
    assert.ok(report.unsupportedEntities.some((u) => u.snapshotKey === 'customUnexpectedSnapshotKey'));
  });

  // Test 3: Full apply mapping, FK integrity & relational-only preservation
  await testCase('3. Apply mode preserves FK integrity & relational-only master records', async () => {
    const { seed, bundle } = buildRealisticSeedAndSnapshot();
    const mock = createTransactionalMockPrisma(seed);

    const report = await runSnapshotToRelationalBackfill(mock.prisma, bundle, { mode: 'apply' });
    assert.equal(report.applied, true);
    const store = mock.getStore();

    // All 3 relational-only parts and MAT-DC01A must be preserved untouched
    assert.equal(store.part.length, 9);
    assert.ok(store.part.some((p) => p.id === 'PRT-FGD-ECU-BRK' && p.partNumber === 'SAPCO-ASY-ECU-BRK-01'));
    assert.ok(store.part.some((p) => p.id === 'PRT-WIP-ECU-MAIN' && p.partNumber === 'WIP-ECU-MAIN-BRK'));
    assert.ok(store.part.some((p) => p.id === 'PRT-WIP-ECU-COMP' && p.partNumber === 'WIP-ECU-COMP-BRK'));
    assert.ok(store.material.some((m) => m.id === 'MAT-DC01A'));
    assert.ok(store.material.some((m) => m.code === 'MAT-DC01'));

    // Part divergence warning logged and operational records point to canonical UUID-611408
    assert.ok(report.conflicts.some((c) => c.code === 'PART_ID_CODE_DIVERGENCE'));
    assert.equal(store.manufacturingOrder[0].partId, 'UUID-611408');
    assert.equal(store.partRoute[0].partId, 'UUID-611408');

    // Inactive historical attribution stubs created (non-loginable)
    assert.equal(store.role.length, 1);
    assert.equal(store.role[0].name, 'LEGACY_MIGRATION');
    assert.equal(store.role[0].active, false);
    assert.ok(store.user.length >= 3);
    assert.ok(store.user.every((u) => u.active === false && u.passwordHash === null));
  });

  // Test 4: Strict idempotency & zero-write guarantee on re-run
  await testCase('4. Strict idempotency: second apply run executes ZERO DB writes & 0 planned inserts/updates', async () => {
    const { seed, bundle } = buildRealisticSeedAndSnapshot();
    const mock = createTransactionalMockPrisma(seed);

    const first = await runSnapshotToRelationalBackfill(mock.prisma, bundle, { mode: 'apply' });
    assert.ok(first.summary.totalPlannedInserts > 0);
    assert.equal(mock.getLastTransactionOptions()?.isolationLevel, 'Serializable');
    const writesAfterFirst = mock.getTotalWrites();
    assert.ok(writesAfterFirst > 0);
    const countsAfterFirst = {
      docs: mock.getStore().inventoryDocument.length,
      txs: mock.getStore().inventoryTransaction.length,
      balances: mock.getStore().stockBalance.length,
      allocs: mock.getStore().contractCoilAllocation.length,
      prodOps: mock.getStore().productionOperation.length,
      transfers: mock.getStore().productionTransfer.length,
      auditLogs: mock.getStore().auditLog.length,
    };

    const second = await runSnapshotToRelationalBackfill(mock.prisma, bundle, { mode: 'apply' });
    assert.equal(second.summary.totalPlannedInserts, 0, 'Second run must plan 0 inserts');
    assert.equal(second.summary.totalPlannedUpdates, 0, 'Second run must plan 0 updates');
    assert.equal(
      mock.getTotalWrites(),
      writesAfterFirst,
      `Second apply run must perform literal zero DB writes (delta=${mock.getTotalWrites() - writesAfterFirst})`,
    );
    assert.equal(mock.getStore().inventoryDocument.length, countsAfterFirst.docs);
    assert.equal(mock.getStore().inventoryTransaction.length, countsAfterFirst.txs);
    assert.equal(mock.getStore().stockBalance.length, countsAfterFirst.balances);
    assert.equal(mock.getStore().contractCoilAllocation.length, countsAfterFirst.allocs);
    assert.equal(mock.getStore().productionOperation.length, countsAfterFirst.prodOps);
    assert.equal(mock.getStore().productionTransfer.length, countsAfterFirst.transfers);
    assert.equal(mock.getStore().auditLog.length, countsAfterFirst.auditLogs);
  });

  // Test 5: Inventory posting, reversal, QM status transfer & legacy transaction deduplication
  await testCase('5. Posting/reversal, QM 322/321 status transfer & 49 legacy tx deduplication', async () => {
    const { seed, bundle } = buildRealisticSeedAndSnapshot();
    const mock = createTransactionalMockPrisma(seed);

    const report = await runSnapshotToRelationalBackfill(mock.prisma, bundle, { mode: 'apply' });
    const store = mock.getStore();

    // 49 duplicated legacy transactions skipped
    assert.ok(report.conflicts.some((c) => c.code === 'LEGACY_TRANSACTIONS_DEDUPLICATED_AND_SKIPPED'));
    // Unposted DRAFT negative & CANCELLED docs have 0 ledger transactions
    const draftDoc = store.inventoryDocument.find((d) => d.documentNumber === 'OB-1403-261116-3705');
    const cancelledDoc = store.inventoryDocument.find((d) => d.documentNumber === 'ISS-CANCELLED-001');
    assert.ok(draftDoc && draftDoc.postingStatus === 'UNPOSTED');
    assert.ok(cancelledDoc && cancelledDoc.postingStatus === 'UNPOSTED');
    assert.equal(store.inventoryTransaction.filter((t) => t.documentId === draftDoc!.id).length, 0);
    assert.equal(store.inventoryTransaction.filter((t) => t.documentId === cancelledDoc!.id).length, 0);
    assert.ok(report.conflicts.some((c) => c.code === 'UNPOSTED_DRAFT_NEGATIVE_QUANTITY'));
    assert.ok(report.conflicts.some((c) => c.code === 'NON_CANONICAL_OWNERSHIP'));

    // Reversed issue + reversal pair both exist in immutable ledger and link via reversalOfTrxId
    const origIssueDoc = store.inventoryDocument.find((d) => d.documentNumber === 'ISS-WIP-969472')!;
    const revDoc = store.inventoryDocument.find((d) => d.documentNumber === 'REV-ISS-WIP-969472')!;
    assert.equal(revDoc.reversalOfId, origIssueDoc.id);
    const origTx = store.inventoryTransaction.find((t) => t.documentId === origIssueDoc.id)!;
    const revTx = store.inventoryTransaction.find((t) => t.documentId === revDoc.id)!;
    assert.equal(revTx.isReversal, true);
    assert.equal(revTx.reversalOfTrxId, origTx.id);
    assert.equal(formatDecimal(decimalAdd(toDecimal(origTx.weightKgSigned), toDecimal(revTx.weightKgSigned))), '0');

    // QM 322/321 status transfer pair leaves QUARANTINE at 0 and AVAILABLE conserved at 8480.4
    const coil1Avail = report.derivedStockBalances.find(
      (b) => b.coilId === 'COIL-ECU-001' && b.qualityStatus === 'AVAILABLE',
    );
    const coil1Quarantine = report.derivedStockBalances.find(
      (b) => b.coilId === 'COIL-ECU-001' && b.qualityStatus === 'QUARANTINE',
    );
    assert.ok(coil1Avail);
    assert.equal(coil1Avail!.weightKgOnHand, '8480.4');
    assert.equal(coil1Avail!.weightKgReserved, '1200');
    assert.equal(coil1Avail!.weightKgAvailable, '7280.4');
    assert.equal(coil1Quarantine?.weightKgOnHand ?? '0', '0');

    // Inherited contractId warning emitted for ISS-WIP-* lines
    assert.ok(report.conflicts.some((c) => c.code === 'LINE_CONTRACT_INHERITED_FROM_LOT_BUCKET'));
  });

  // Test 6: Coil stock anti-double-counting & contract allocation cap validation
  await testCase('6. Coil stock reconciliation & over-limit contract allocation rejection', async () => {
    const { seed, bundle } = buildRealisticSeedAndSnapshot();
    const mock = createTransactionalMockPrisma(seed);

    const report = await runSnapshotToRelationalBackfill(mock.prisma, bundle, { mode: 'apply' });
    const store = mock.getStore();

    // PhysicalCoil remainingWeightKg reconciled to 8480.4 (exact Decimal, no 8499.999999999998)
    const coil1 = store.physicalCoil.find((c) => c.coilId === 'COIL-ECU-001')!;
    const coil2 = store.physicalCoil.find((c) => c.coilId === 'COIL-ECU-002')!;
    assert.equal(formatDecimal(toDecimal(coil1.remainingWeightKg)), '8480.4');
    assert.equal(formatDecimal(toDecimal(coil2.remainingWeightKg)), '3200');
    assert.ok(coil1.materialLotId, 'COIL-ECU-001 should link to MaterialLot');
    assert.ok(report.conflicts.some((c) => c.code === 'COIL_FLOATING_POINT_ARTIFACT'));
    assert.ok(report.conflicts.some((c) => c.code === 'COIL_WEIGHT_LEDGER_DRIFT'));
    assert.ok(report.conflicts.some((c) => c.code === 'COIL_ALLOCATION_SNAPSHOT_MISMATCH'));

    // Contract allocations match 8500 + 3200 = 11700 <= 50000
    assert.equal(store.contractCoilAllocation.length, 2);
    assert.equal(report.contractAllocationChecks[0].plannedCoilAllocationsKg, '11700');
    assert.equal(report.contractAllocationChecks[0].withinContractLimit, true);

    // Negative test: contract allocation exceeding contract cap MUST be rejected (throws)
    const overCap = buildRealisticSeedAndSnapshot();
    overCap.bundle.inventoryPayload.contracts[0].allocatedWeightKg = 10000; // < 8500 + 3200 = 11700
    const mockOverCap = createTransactionalMockPrisma(overCap.seed);
    await assert.rejects(
      () => runSnapshotToRelationalBackfill(mockOverCap.prisma, overCap.bundle, { mode: 'apply' }),
      /exceeds contract|allocation limit|totalAllocatedWeightKg/i,
    );
    assert.equal(mockOverCap.getStore().contractCoilAllocation.length, 0, 'Over-limit failure must roll back');
  });

  // Test 7: WIP MO, 16 operations, bridge links & transfers
  await testCase('7. WIP manufacturing orders, 16 operations, links & transfers', async () => {
    const { seed, bundle } = buildRealisticSeedAndSnapshot();
    const mock = createTransactionalMockPrisma(seed);

    const report = await runSnapshotToRelationalBackfill(mock.prisma, bundle, { mode: 'apply' });
    const store = mock.getStore();

    assert.equal(store.manufacturingOrder.length, 1);
    assert.equal(store.productionOperation.length, 16);
    assert.equal(store.wipManufacturingOrderLink.length, 1);
    assert.equal(store.wipOperationLink.length, 16);
    assert.equal(store.productionTransfer.length, 2);
    assert.equal(report.wipReconciliation[0].operationCount, 16);
    assert.equal(report.wipReconciliation[0].transferCount, 2);
    // Missing WIP locations automatically backfilled before transfers
    assert.ok(store.warehouseLocation.some((l) => l.code === 'LOC-WIP-PUNCH'));
    assert.ok(store.warehouseLocation.some((l) => l.code === 'LOC-WIP-WELD-01'));
  });

  // Test 8: Atomic transaction rollback on mid-flight error
  await testCase('8. Atomic transaction rollback on mid-flight failure (0 partial writes)', async () => {
    const { seed, bundle } = buildRealisticSeedAndSnapshot();
    const mock = createTransactionalMockPrisma(seed, {
      table: 'inventoryTransaction',
      op: 'create',
      onCall: 2,
      message: 'Injected mid-transaction PostgreSQL write failure',
    });

    const initialCounts = {
      roles: mock.getStore().role.length,
      users: mock.getStore().user.length,
      contracts: mock.getStore().materialContract.length,
      docs: mock.getStore().inventoryDocument.length,
      txs: mock.getStore().inventoryTransaction.length,
      balances: mock.getStore().stockBalance.length,
      mos: mock.getStore().manufacturingOrder.length,
      coil1Remaining: formatDecimal(toDecimal(mock.getStore().physicalCoil[0].remainingWeightKg)),
    };

    await assert.rejects(
      () => runSnapshotToRelationalBackfill(mock.prisma, bundle, { mode: 'apply' }),
      /Injected mid-transaction PostgreSQL write failure/,
    );

    // Every table MUST remain untouched (zero partial persistence)
    assert.equal(mock.getStore().role.length, initialCounts.roles);
    assert.equal(mock.getStore().user.length, initialCounts.users);
    assert.equal(mock.getStore().materialContract.length, initialCounts.contracts);
    assert.equal(mock.getStore().inventoryDocument.length, initialCounts.docs);
    assert.equal(mock.getStore().inventoryTransaction.length, initialCounts.txs);
    assert.equal(mock.getStore().stockBalance.length, initialCounts.balances);
    assert.equal(mock.getStore().manufacturingOrder.length, initialCounts.mos);
    assert.equal(
      formatDecimal(toDecimal(mock.getStore().physicalCoil[0].remainingWeightKg)),
      initialCounts.coil1Remaining,
    );
  });

  // Test 9: Snapshot loader fails closed when PostgreSQL snapshots are missing
  await testCase('9. loadSnapshotsFromPostgres fails closed when snapshots are absent', async () => {
    const emptyMock = createTransactionalMockPrisma({});
    await assert.rejects(
      () => loadSnapshotsFromPostgres(emptyMock.prisma),
      /inventory-app-state|snapshot/i,
    );

    const partialMock = createTransactionalMockPrisma({
      inventoryAppStateSnapshot: [{ id: 'inventory-app-state', payload: { parts: [] }, updatedAt: new Date() }],
    });
    await assert.rejects(
      () => loadSnapshotsFromPostgres(partialMock.prisma),
      /production-wip-state|snapshot/i,
    );
  });

  // Test 10: Pre-existing posted issue tx + later REVERSAL backfill still links reversalOfTrxId & reversalOfId
  await testCase('10. Incremental REVERSAL backfill links reversalOfTrxId to pre-existing posted issue transaction', async () => {
    const { seed, bundle } = buildRealisticSeedAndSnapshot();
    // Phase A: apply WITHOUT the reversal document
    bundle.inventoryPayload.inventoryDocuments = bundle.inventoryPayload.inventoryDocuments.filter(
      (d: any) => d.documentNumber !== 'REV-ISS-WIP-969472',
    );
    const mock = createTransactionalMockPrisma(seed);
    await runSnapshotToRelationalBackfill(mock.prisma, bundle, { mode: 'apply' });

    // Phase B: re-introduce REVERSAL document and re-run apply
    const { bundle: fullBundle } = buildRealisticSeedAndSnapshot();
    const report2 = await runSnapshotToRelationalBackfill(mock.prisma, fullBundle, { mode: 'apply' });
    const store = mock.getStore();
    const origIssueDoc = store.inventoryDocument.find((d) => d.documentNumber === 'ISS-WIP-969472')!;
    const revDoc = store.inventoryDocument.find((d) => d.documentNumber === 'REV-ISS-WIP-969472')!;
    const origTx = store.inventoryTransaction.find((t) => t.documentId === origIssueDoc.id)!;
    const revTx = store.inventoryTransaction.find((t) => t.documentId === revDoc.id)!;

    assert.equal(revDoc.reversalOfId, origIssueDoc.id);
    assert.equal(revTx.isReversal, true);
    assert.equal(revTx.reversalOfTrxId, origTx.id, 'REVERSAL tx must link to pre-existing original issue tx');
    const coil1Avail = report2.derivedStockBalances.find(
      (b) => b.coilId === 'COIL-ECU-001' && b.qualityStatus === 'AVAILABLE',
    );
    assert.equal(coil1Avail?.weightKgOnHand, '8480.4');
  });

  // Test 11: Customer resolution (non-SAPCO), RouteStatus mapping, dieId fallback & reservation ownership filtering
  await testCase('11. Resolves explicit customerId, RouteStatus, dieId fallback, and reservation ownership filter', async () => {
    const { seed, bundle } = buildRealisticSeedAndSnapshot();
    seed.customer!.push({ id: 'CUST-IKCO', code: 'CUST-IKCO', name: 'ایران خودرو', active: true });
    bundle.inventoryPayload.customers.push({ id: 'CUST-IKCO', code: 'CUST-IKCO', name: 'ایران خودرو' });
    bundle.inventoryPayload.contracts[0].customerId = 'CUST-IKCO';
    bundle.inventoryPayload.customerOrders[0].customerId = 'CUST-IKCO';
    delete bundle.inventoryPayload.customerOrders[0].contractNumber;
    bundle.inventoryPayload.customerOrders[0].contractId = 'CNT-SAPCO-ECU-BRK';
    bundle.inventoryPayload.routings[0].status = 'DRAFT';

    // Add a second COMPANY_OWNED bucket for the same part & warehouse to verify reservation ownership filtering
    bundle.inventoryPayload.inventoryDocuments[0].lines.push({
      lineNumber: 4,
      partId: 'UUID-RAW-COIL-1',
      partCode: 'RM-COIL-DC01A-2.0-1140',
      unit: 'KG',
      quantity: 500,
      quantityKg: 500,
      locationCode: 'LOC-RAW-A1',
      ownership: 'COMPANY_OWNED',
      qualityStatus: 'AVAILABLE',
    });
    // Reservation omits lotNumber but specifies COMPANY_OWNED
    bundle.inventoryPayload.reservations = [
      {
        id: 'RES-OWNED-ONLY',
        reservationNumber: 'RES-OWNED-ONLY',
        partId: 'UUID-RAW-COIL-1',
        partCode: 'RM-COIL-DC01A-2.0-1140',
        warehouseId: 'WH-RAW',
        ownership: 'COMPANY_OWNED',
        quantity: 200,
        quantityKg: 200,
        status: 'ACTIVE',
        createdByUid: 'USR-ADMIN',
      },
    ];

    const mock = createTransactionalMockPrisma(seed);
    const report = await runSnapshotToRelationalBackfill(mock.prisma, bundle, { mode: 'apply' });
    const store = mock.getStore();

    assert.equal(store.materialContract[0].supplierCustomerId, 'CUST-IKCO');
    assert.equal(store.customerOrder[0].customerId, 'CUST-IKCO');
    assert.equal(store.customerOrder[0].customerContractNumber, 'CNT-SAPCO-ECU-BRK');
    assert.equal(store.partRoute[0].status, 'DRAFT');
    // RouteOperation step 10 used dieId in routingOps -> should link DIE-001
    assert.equal(store.routeOperation[0].dieId, 'DIE-001');

    const companyBucket = report.derivedStockBalances.find(
      (b) => b.partNumber === 'RM-COIL-DC01A-2.0-1140' && b.ownership === 'COMPANY_OWNED',
    );
    const sapcoBucket = report.derivedStockBalances.find(
      (b) => b.partNumber === 'RM-COIL-DC01A-2.0-1140' && b.ownership === 'SAPCO_SUPPLIER_OWNED' && b.qualityStatus === 'AVAILABLE',
    );
    assert.equal(companyBucket?.weightKgReserved, '200');
    assert.equal(sapcoBucket?.weightKgReserved, '0');
  });

  // Test 12: --no-reconcile-coil-weights preserves normalized snapshot coil weight (8500) + negative-zero normalization
  await testCase('12. reconcileCoilWeights=false preserves float-normalized snapshot weight & -0 Decimal safety', async () => {
    const negZero = toDecimal(-0);
    assert.equal(negZero.toString(), '0');
    assert.equal(decimalEq(negZero, DECIMAL_ZERO), true);

    const { seed, bundle } = buildRealisticSeedAndSnapshot();
    const mock = createTransactionalMockPrisma(seed);
    const report = await runSnapshotToRelationalBackfill(mock.prisma, bundle, {
      mode: 'apply',
      reconcileCoilWeights: false,
    });
    const coil1 = mock.getStore().physicalCoil.find((c) => c.coilId === 'COIL-ECU-001')!;
    assert.equal(formatDecimal(toDecimal(coil1.remainingWeightKg)), '8500');
    assert.equal(report.coilReconciliation.find((c) => c.coilId === 'COIL-ECU-001')?.reconciledTargetRemainingKg, '8500');
  });

  // Test 13: Expired ACTIVE reservation warning + invalid mode fails closed
  await testCase('13. Expired ACTIVE reservation triggers warning without silent expiry & invalid mode fails closed', async () => {
    const { seed, bundle } = buildRealisticSeedAndSnapshot();
    const mock = createTransactionalMockPrisma(seed);

    const report = await runSnapshotToRelationalBackfill(mock.prisma, bundle, { mode: 'dry-run' });
    assert.ok(report.conflicts.some((c) => c.code === 'ACTIVE_RESERVATION_PAST_VALID_UNTIL'));

    await assert.rejects(
      () => runSnapshotToRelationalBackfill(mock.prisma, bundle, { mode: 'invalid' as any }),
      /Invalid BackfillMode/i,
    );
  });

  const failed = results.filter((r) => r.status === 'FAIL');
  console.log(`\nTest Summary: ${results.length - failed.length}/${results.length} passed.`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('[Test Runner Fatal Error]', err);
  process.exit(1);
});
