import crypto from 'node:crypto';
import { getPrismaClient, isDatabaseUrlConfigured } from './db/prisma';
import {
  InspectionChecklistItem,
  NcrDispositionAction,
  NcrSourceType,
  NcrStatus,
  NonconformanceCategory,
  NonconformanceRecord,
  NonconformanceSeverity,
  QualityDecision,
  QualityInspectionRecord,
  QualityInspectionStatus,
  QualityInspectionType,
  ReworkOrderRecord,
  ReworkOrderStatus,
} from '../types/quality';
import { InventoryDocument, StockOwnership, StockQualityStatus, UnitOfMeasure } from '../types/inventory';

let qualityPrismaOverride: any = null;

export function __setQualityPrismaForTests(client: any): void {
  qualityPrismaOverride = client;
}

export function __getQualityPrisma(): any {
  return qualityPrismaOverride || getPrismaClient();
}

export function isQualityPostgresPersistenceActive(): boolean {
  return Boolean(qualityPrismaOverride) || isDatabaseUrlConfigured();
}

export class QualityTxAbortError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'QualityTxAbortError';
    this.statusCode = statusCode;
  }
}

export function hashQualityPayload(payload: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload ?? {})).digest('hex');
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const iso = (v: unknown): string | undefined => {
  if (!v) return undefined;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  return s || undefined;
};

export interface ResolvedQualityForeignKeys {
  partId: string | null;
  warehouseId: string | null;
  materialLotId: string | null;
  physicalCoilId: string | null;
  manufacturingOrderId: string | null;
  productionOperationId: string | null;
  materialContractId: string | null;
}

export async function resolveQualityForeignKeysInTx(
  tx: any,
  refs: {
    partId?: string;
    partCode?: string;
    warehouseId?: string;
    lotNumber?: string;
    physicalCoilId?: string;
    coilId?: string;
    manufacturingOrderId?: string;
    moNumber?: string;
    operationId?: string;
    operationCode?: string;
    contractId?: string;
    contractNumber?: string;
  }
): Promise<ResolvedQualityForeignKeys> {
  let partId: string | null = null;
  if (tx?.part && typeof tx.part.findFirst === 'function' && (refs.partId || refs.partCode)) {
    const orList: any[] = [];
    if (refs.partId) orList.push({ id: refs.partId });
    if (refs.partCode) orList.push({ partNumber: refs.partCode });
    const found = await tx.part.findFirst({ where: { OR: orList }, select: { id: true } });
    partId = found?.id ?? null;
  }

  let warehouseId: string | null = null;
  if (tx?.warehouse && typeof tx.warehouse.findFirst === 'function' && refs.warehouseId) {
    const found = await tx.warehouse.findFirst({
      where: { OR: [{ id: refs.warehouseId }, { code: refs.warehouseId }] },
      select: { id: true },
    });
    warehouseId = found?.id ?? null;
  }

  let materialLotId: string | null = null;
  if (tx?.materialLot && typeof tx.materialLot.findFirst === 'function' && refs.lotNumber) {
    const found = await tx.materialLot.findFirst({
      where: { lotNumber: refs.lotNumber },
      select: { id: true },
    });
    materialLotId = found?.id ?? null;
  }

  let physicalCoilId: string | null = null;
  if (tx?.physicalCoil && typeof tx.physicalCoil.findFirst === 'function' && (refs.physicalCoilId || refs.coilId)) {
    const orList: any[] = [];
    if (refs.physicalCoilId) orList.push({ id: refs.physicalCoilId }, { coilId: refs.physicalCoilId });
    if (refs.coilId) orList.push({ id: refs.coilId }, { coilId: refs.coilId });
    const found = await tx.physicalCoil.findFirst({
      where: { OR: orList },
      select: { id: true, materialLotId: true },
    });
    if (found) {
      physicalCoilId = found.id;
      if (!materialLotId && found.materialLotId) {
        materialLotId = found.materialLotId;
      }
    }
  }

  let manufacturingOrderId: string | null = null;
  if (
    tx?.manufacturingOrder &&
    typeof tx.manufacturingOrder.findFirst === 'function' &&
    (refs.manufacturingOrderId || refs.moNumber)
  ) {
    const orList: any[] = [];
    if (refs.manufacturingOrderId) orList.push({ id: refs.manufacturingOrderId });
    if (refs.moNumber) orList.push({ moNumber: refs.moNumber });
    const found = await tx.manufacturingOrder.findFirst({
      where: { OR: orList },
      select: { id: true },
    });
    manufacturingOrderId = found?.id ?? null;
  }

  let productionOperationId: string | null = null;
  if (
    tx?.productionOperation &&
    typeof tx.productionOperation.findFirst === 'function' &&
    (refs.operationId || (manufacturingOrderId && refs.operationCode))
  ) {
    let found: any = null;
    if (refs.operationId) {
      found = await tx.productionOperation.findFirst({
        where: { id: refs.operationId },
        select: { id: true },
      });
    }
    if (!found && manufacturingOrderId && refs.operationCode) {
      found = await tx.productionOperation.findFirst({
        where: {
          manufacturingOrderId,
          stepCode: refs.operationCode,
        },
        select: { id: true },
      });
    }
    productionOperationId = found?.id ?? null;
  }

  let materialContractId: string | null = null;
  if (
    tx?.materialContract &&
    typeof tx.materialContract.findFirst === 'function' &&
    (refs.contractId || refs.contractNumber)
  ) {
    const orList: any[] = [];
    if (refs.contractId) orList.push({ id: refs.contractId });
    if (refs.contractNumber) orList.push({ contractNumber: refs.contractNumber });
    const found = await tx.materialContract.findFirst({
      where: { OR: orList },
      select: { id: true },
    });
    materialContractId = found?.id ?? null;
  }

  return {
    partId,
    warehouseId,
    materialLotId,
    physicalCoilId,
    manufacturingOrderId,
    productionOperationId,
    materialContractId,
  };
}

export async function resolveInventoryDocIdInTx(
  tx: any,
  doc?: InventoryDocument | { id?: string; documentNumber?: string } | null
): Promise<string | null> {
  if (!doc || !tx?.inventoryDocument || typeof tx.inventoryDocument.findFirst !== 'function') {
    return null;
  }
  const orList: any[] = [];
  if (doc.id) orList.push({ id: doc.id });
  if (doc.documentNumber) orList.push({ documentNumber: doc.documentNumber });
  if (orList.length === 0) return null;
  const found = await tx.inventoryDocument.findFirst({
    where: { OR: orList },
    select: { id: true },
  });
  return found?.id ?? null;
}

export async function syncLinkedEntityQualityStatusInTx(
  tx: any,
  args: {
    physicalCoilId?: string | null;
    materialLotId?: string | null;
    qualityStatus: StockQualityStatus;
    physicalStatus?: string;
    remainingWeightKg?: number;
  }
): Promise<void> {
  if (args.physicalCoilId && tx?.physicalCoil && typeof tx.physicalCoil.update === 'function') {
    const updateData: Record<string, unknown> = {
      qualityStatus: args.qualityStatus,
    };
    if (args.physicalStatus) {
      updateData.physicalStatus = args.physicalStatus;
    }
    if (typeof args.remainingWeightKg === 'number' && Number.isFinite(args.remainingWeightKg)) {
      updateData.remainingWeightKg = Math.max(0, args.remainingWeightKg);
    }
    await tx.physicalCoil.update({
      where: { id: args.physicalCoilId },
      data: updateData,
    }).catch(() => {});
  }

  if (args.materialLotId && tx?.materialLot && typeof tx.materialLot.update === 'function') {
    const lotStatus =
      args.qualityStatus === 'AVAILABLE'
        ? 'AVAILABLE'
        : args.qualityStatus === 'REJECTED'
        ? 'REJECTED'
        : 'QUARANTINE';
    await tx.materialLot.update({
      where: { id: args.materialLotId },
      data: { status: lotStatus },
    }).catch(() => {});
  }
}

export async function recordQualityAuditInTx(
  tx: any,
  entry: {
    action: string;
    entityName: string;
    entityId: string;
    user: { uid: string; displayName: string };
    details: string;
    oldValues?: Record<string, unknown>;
    newValues?: Record<string, unknown>;
  }
): Promise<void> {
  if (!tx?.auditLog || typeof tx.auditLog.create !== 'function') return;
  let validUserId: string | null = null;
  if (entry.user?.uid && tx?.user && typeof tx.user.findUnique === 'function') {
    const existingUser = await tx.user.findUnique({ where: { id: entry.user.uid }, select: { id: true } }).catch(() => null);
    validUserId = existingUser?.id ?? null;
  }
  await tx.auditLog.create({
    data: {
      userId: validUserId,
      action: entry.action,
      entityName: entry.entityName,
      entityId: entry.entityId,
      oldValues: entry.oldValues ?? undefined,
      newValues: {
        ...(entry.newValues || {}),
        details: entry.details,
        actorUid: entry.user.uid,
        actorName: entry.user.displayName,
      },
    },
  });
}

export async function checkDbQualityIdempotencyInTx(
  tx: any,
  scope: string,
  idempotencyKey: string | undefined,
  fingerprintPayload: unknown
): Promise<
  | { hit: false }
  | { hit: true; conflict: true; error: string }
  | { hit: true; conflict: false; statusCode: number; response: any }
> {
  if (!idempotencyKey || !idempotencyKey.trim()) return { hit: false };
  const key = idempotencyKey.trim();
  const requestHash = hashQualityPayload(fingerprintPayload);
  const existing = await tx.qualityIdempotencyRecord.findUnique({
    where: { scope_idempotencyKey: { scope, idempotencyKey: key } },
  });
  if (!existing) return { hit: false };
  if (existing.requestHash !== requestHash) {
    return {
      hit: true,
      conflict: true,
      error: `کلید یکتای تکراری (Idempotency-Key: ${key}) پیش‌تر با محتوای متفاوت ثبت شده است.`,
    };
  }
  return {
    hit: true,
    conflict: false,
    statusCode: Number(existing.statusCode || 200),
    response: existing.responsePayload,
  };
}

export async function saveDbQualityIdempotencyInTx(
  tx: any,
  scope: string,
  idempotencyKey: string | undefined,
  fingerprintPayload: unknown,
  statusCode: number,
  responsePayload: unknown
): Promise<void> {
  if (!idempotencyKey || !idempotencyKey.trim()) return;
  const key = idempotencyKey.trim();
  const requestHash = hashQualityPayload(fingerprintPayload);
  await tx.qualityIdempotencyRecord.create({
    data: {
      scope,
      idempotencyKey: key,
      requestHash,
      statusCode,
      responsePayload: JSON.parse(JSON.stringify(responsePayload)),
    },
  });
}

export async function runQualityTransaction<T extends { ok: boolean; statusCode: number; error?: string; idempotentReplay?: boolean }>(
  scope: string,
  idempotencyKey: string | undefined,
  fingerprintPayload: unknown,
  fn: (tx: any) => Promise<T>
): Promise<T> {
  const prisma = __getQualityPrisma();
  try {
    return await prisma.$transaction(async (tx: any) => {
      const idem = await checkDbQualityIdempotencyInTx(tx, scope, idempotencyKey, fingerprintPayload);
      if (idem.hit) {
        if (idem.conflict) {
          return { ok: false, statusCode: 409, error: idem.error } as T;
        }
        return { ok: true, statusCode: 200, idempotentReplay: true, ...(idem.response || {}) } as T;
      }
      return await fn(tx);
    });
  } catch (err: any) {
    if (err instanceof QualityTxAbortError) {
      return { ok: false, statusCode: err.statusCode, error: err.message } as T;
    }
    if (err?.code === 'P2002' && idempotencyKey && idempotencyKey.trim()) {
      const key = idempotencyKey.trim();
      const existing = await prisma.qualityIdempotencyRecord
        .findUnique({ where: { scope_idempotencyKey: { scope, idempotencyKey: key } } })
        .catch(() => null);
      if (existing) {
        const expectedHash = hashQualityPayload(fingerprintPayload);
        if (existing.requestHash !== expectedHash) {
          return {
            ok: false,
            statusCode: 409,
            error: `کلید یکتای تکراری (Idempotency-Key: ${key}) پیش‌تر با محتوای متفاوت ثبت شده است.`,
          } as T;
        }
        return { ok: true, statusCode: 200, idempotentReplay: true, ...(existing.responsePayload || {}) } as T;
      }
    }
    throw err;
  }
}

export function mapDbInspectionToDto(row: any): QualityInspectionRecord {
  return {
    id: row.id,
    inspectionNumber: row.inspectionNumber,
    inspectionType: row.inspectionType as QualityInspectionType,
    status: row.status as QualityInspectionStatus,
    decision: row.decision as QualityDecision,
    partId: row.partId || row.partRefId,
    partCode: row.partCode,
    partName: row.partName,
    warehouseId: row.warehouseId || row.warehouseRefId || undefined,
    warehouseName: row.warehouseName || undefined,
    locationCode: row.locationCode || undefined,
    balanceId: row.balanceId || undefined,
    lotNumber: row.lotNumber || undefined,
    heatNumber: row.heatNumber || undefined,
    physicalCoilId: row.physicalCoilId || row.coilRefId || undefined,
    coilId: row.coilId || undefined,
    coilPackNumber: row.coilPackNumber || undefined,
    manufacturingOrderId: row.manufacturingOrderId || row.moRefId || undefined,
    moNumber: row.moNumber || undefined,
    operationId: row.productionOperationId || row.operationRefId || undefined,
    operationCode: row.operationCode || undefined,
    operationName: row.operationName || undefined,
    supplierName: row.supplierName || undefined,
    ownership: (row.ownership as StockOwnership | undefined) || undefined,
    contractId: row.materialContractId || row.contractRefId || undefined,
    contractNumber: row.contractNumber || undefined,
    sourceDocumentNumber: row.sourceDocumentNumber || undefined,
    inspectedQty: num(row.inspectedQty),
    acceptedQty: num(row.acceptedQty),
    rejectedQty: num(row.rejectedQty),
    reworkQty: num(row.reworkQty),
    unit: (row.unit as UnitOfMeasure) || 'PCS',
    weightKg: num(row.weightKg),
    checklist: Array.isArray(row.checklist) ? (row.checklist as InspectionChecklistItem[]) : [],
    defectCodes: Array.isArray(row.defectCodes) ? (row.defectCodes as string[]) : [],
    defectCategory: (row.defectCategory as NonconformanceCategory | undefined) || undefined,
    defectSummary: row.defectSummary || undefined,
    notes: row.notes || undefined,
    linkedQmDocumentNumber: row.linkedQmDocumentNumber || undefined,
    linkedNcrId: row.linkedNcrId || undefined,
    linkedNcrNumber: row.linkedNcrNumber || undefined,
    inspectorUid: row.inspectorUid,
    inspectorName: row.inspectorName,
    inspectedAt: iso(row.inspectedAt) || new Date().toISOString(),
    decidedAt: iso(row.decidedAt),
    idempotencyKey: row.idempotencyKey || undefined,
    createdAt: iso(row.createdAt) || new Date().toISOString(),
    updatedAt: iso(row.updatedAt) || new Date().toISOString(),
  };
}

export function mapDbNcrToDto(row: any): NonconformanceRecord {
  return {
    id: row.id,
    ncrNumber: row.ncrNumber,
    title: row.title,
    sourceType: row.sourceType as NcrSourceType,
    severity: row.severity as NonconformanceSeverity,
    category: row.category as NonconformanceCategory,
    defectCode: row.defectCode,
    defectLabelFa: row.defectLabelFa,
    status: row.status as NcrStatus,
    disposition: row.disposition as NcrDispositionAction,
    inspectionId: row.inspectionId || undefined,
    inspectionNumber: row.inspectionNumber || undefined,
    partId: row.partId || row.partRefId,
    partCode: row.partCode,
    partName: row.partName,
    warehouseId: row.warehouseId || row.warehouseRefId || undefined,
    warehouseName: row.warehouseName || undefined,
    locationCode: row.locationCode || undefined,
    balanceId: row.balanceId || undefined,
    lotNumber: row.lotNumber || undefined,
    heatNumber: row.heatNumber || undefined,
    physicalCoilId: row.physicalCoilId || row.coilRefId || undefined,
    coilId: row.coilId || undefined,
    coilPackNumber: row.coilPackNumber || undefined,
    manufacturingOrderId: row.manufacturingOrderId || row.moRefId || undefined,
    moNumber: row.moNumber || undefined,
    operationId: row.productionOperationId || row.operationRefId || undefined,
    operationCode: row.operationCode || undefined,
    operationName: row.operationName || undefined,
    supplierName: row.supplierName || undefined,
    ownership: (row.ownership as StockOwnership | undefined) || undefined,
    contractId: row.materialContractId || row.contractRefId || undefined,
    contractNumber: row.contractNumber || undefined,
    affectedQty: num(row.affectedQty),
    containedQty: num(row.containedQty),
    reworkedGoodQty: num(row.reworkedGoodQty),
    scrappedQty: num(row.scrappedQty),
    returnedToProductionQty: num(row.returnedToProductionQty),
    returnedToSupplierQty: num(row.returnedToSupplierQty),
    unit: (row.unit as UnitOfMeasure) || 'PCS',
    weightKg: num(row.weightKg),
    description: row.description,
    containmentAction: row.containmentAction || undefined,
    containedAt: iso(row.containedAt),
    containedByName: row.containedByName || undefined,
    containmentQmDocNumber: row.containmentQmDocNumber || undefined,
    rootCause: row.rootCause || undefined,
    correctiveAction: row.correctiveAction || undefined,
    dispositionNotes: row.dispositionNotes || undefined,
    dispositionedAt: iso(row.dispositionedAt),
    dispositionedByName: row.dispositionedByName || undefined,
    dispositionDocNumber: row.dispositionDocNumber || undefined,
    linkedReworkOrderId: row.linkedReworkOrderId || undefined,
    linkedReworkNumber: row.linkedReworkNumber || undefined,
    closedAt: iso(row.closedAt),
    closedByName: row.closedByName || undefined,
    createdByUid: row.createdByUid,
    createdByName: row.createdByName,
    createdAt: iso(row.createdAt) || new Date().toISOString(),
    updatedAt: iso(row.updatedAt) || new Date().toISOString(),
  };
}

export function mapDbReworkToDto(row: any): ReworkOrderRecord {
  return {
    id: row.id,
    reworkNumber: row.reworkNumber,
    ncrId: row.ncrId,
    ncrNumber: row.ncrNumber,
    inspectionId: row.inspectionId || undefined,
    partId: row.partId || row.partRefId,
    partCode: row.partCode,
    partName: row.partName,
    warehouseId: row.warehouseId || row.warehouseRefId || undefined,
    locationCode: row.locationCode || undefined,
    balanceId: row.balanceId || undefined,
    lotNumber: row.lotNumber || undefined,
    physicalCoilId: row.physicalCoilId || row.coilRefId || undefined,
    coilId: row.coilId || undefined,
    manufacturingOrderId: row.manufacturingOrderId || row.moRefId || undefined,
    moNumber: row.moNumber || undefined,
    sourceOperationCode: row.sourceOperationCode || undefined,
    targetOperationCode: row.targetOperationCode || undefined,
    ownership: (row.ownership as StockOwnership | undefined) || undefined,
    contractId: row.materialContractId || row.contractRefId || undefined,
    contractNumber: row.contractNumber || undefined,
    plannedReworkQty: num(row.plannedReworkQty),
    completedGoodQty: num(row.completedGoodQty),
    scrappedQty: num(row.scrappedQty),
    remainingQty: num(row.remainingQty),
    unit: (row.unit as UnitOfMeasure) || 'PCS',
    weightKg: num(row.weightKg),
    status: row.status as ReworkOrderStatus,
    instructions: row.instructions,
    returnToProduction: Boolean(row.returnToProduction),
    returnDocumentNumber: row.returnDocumentNumber || undefined,
    scrapDocumentNumber: row.scrapDocumentNumber || undefined,
    assignedToName: row.assignedToName || undefined,
    completionNotes: row.completionNotes || undefined,
    createdByUid: row.createdByUid,
    createdByName: row.createdByName,
    createdAt: iso(row.createdAt) || new Date().toISOString(),
    updatedAt: iso(row.updatedAt) || new Date().toISOString(),
    completedAt: iso(row.completedAt),
  };
}

export async function dbFindInspectionByIdOrNumber(tx: any, idOrNumber: string): Promise<any | null> {
  return tx.qualityInspection.findFirst({
    where: {
      OR: [{ id: idOrNumber }, { inspectionNumber: idOrNumber }],
    },
  });
}

export async function dbFindNcrByIdOrNumber(tx: any, idOrNumber: string): Promise<any | null> {
  return tx.qualityNonconformance.findFirst({
    where: {
      OR: [{ id: idOrNumber }, { ncrNumber: idOrNumber }],
    },
  });
}

export async function dbFindReworkByIdOrNumber(tx: any, idOrNumber: string): Promise<any | null> {
  return tx.qualityReworkOrder.findFirst({
    where: {
      OR: [{ id: idOrNumber }, { reworkNumber: idOrNumber }],
    },
  });
}

export async function dbListQualityInspections(): Promise<QualityInspectionRecord[]> {
  const prisma = __getQualityPrisma();
  const rows = await prisma.qualityInspection.findMany({
    orderBy: [{ createdAt: 'desc' }],
  });
  return (rows || []).map(mapDbInspectionToDto);
}

export async function dbListNonconformances(): Promise<NonconformanceRecord[]> {
  const prisma = __getQualityPrisma();
  const rows = await prisma.qualityNonconformance.findMany({
    orderBy: [{ createdAt: 'desc' }],
  });
  return (rows || []).map(mapDbNcrToDto);
}

export async function dbListReworkOrders(): Promise<ReworkOrderRecord[]> {
  const prisma = __getQualityPrisma();
  const rows = await prisma.qualityReworkOrder.findMany({
    orderBy: [{ createdAt: 'desc' }],
  });
  return (rows || []).map(mapDbReworkToDto);
}

export async function dbLoadAllQualityRecords(): Promise<{
  inspections: QualityInspectionRecord[];
  ncrs: NonconformanceRecord[];
  reworkOrders: ReworkOrderRecord[];
}> {
  const [inspections, ncrs, reworkOrders] = await Promise.all([
    dbListQualityInspections(),
    dbListNonconformances(),
    dbListReworkOrders(),
  ]);
  return { inspections, ncrs, reworkOrders };
}
