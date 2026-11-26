import { Prisma, PrismaClient } from '@prisma/client';
import { DECIMAL_ZERO, decimalEq, toDecimal } from './decimalUtils';

export type WipCutoverMode = 'dry-run' | 'apply';

interface SnapshotOp {
  id: string;
  moId: string;
  moNumber: string;
  stepNumber: number;
  stepCode: string;
  stepName: string;
  processType: string;
  sequence: number;
  machineId?: string;
  warehouseLocation: string;
  status: string;
  waitingInputQty: number;
  inProgressQty: number;
  goodOutputQty: number;
  scrapQty: number;
  reworkQty: number;
  rejectedQty: number;
  readyForTransferQty: number;
  transferredQty: number;
  standardCycleTimeSec?: number;
  scrapNormPercent?: number;
  lastActivityAt?: string;
}

interface SnapshotMo {
  id: string;
  moNumber: string;
  partId: string;
  partCode: string;
  partName: string;
  targetQuantity: number;
  initialInputQuantity: number;
  completedQuantity: number;
  totalScrapQuantity: number;
  totalReworkQuantity: number;
  totalRejectedQuantity: number;
  routingId?: string;
  status: string;
  notes?: string;
  createdBy?: string;
  operations: SnapshotOp[];
}

interface SnapshotTransfer {
  id: string;
  transferNumber: string;
  moId: string;
  moNumber: string;
  partId: string;
  partCode: string;
  fromOperationId?: string;
  fromStepNumber?: number;
  fromStepName?: string;
  fromLocation?: string;
  toOperationId?: string;
  toStepNumber?: number;
  toStepName?: string;
  toLocation?: string;
  quantity: number;
  status: string;
  dispatchedBy?: string;
  dispatchedAt?: string;
  receivedBy?: string;
  receivedAt?: string;
  notes?: string;
}

export interface WipCutoverPlannedBalance {
  partNumber: string;
  partId: string;
  warehouseCode: string;
  warehouseId: string;
  locationCode: string;
  locationId: string;
  qualityStatus: string;
  quantity: string;
  weightKg: string;
  moId: string;
  moNumber: string;
}

export interface WipCutoverMoCheck {
  moNumber: string;
  partNumber: string;
  initialInputQty: string;
  activeWipQty: string;
  inTransitQty: string;
  completedQty: string;
  scrapQty: string;
  reworkQty: string;
  rejectedQty: string;
  discrepancy: string;
  isConserved: boolean;
}

export interface WipCutoverReport {
  mode: WipCutoverMode;
  applied: boolean;
  executedAt: string;
  snapshotVersion: number | null;
  planned: {
    partUpdates: number;
    moUpdates: number;
    operationUpdates: number;
    transferUpdates: number;
    openingDocInserts: number;
    openingLineInserts: number;
    openingTxInserts: number;
    openingBalanceInserts: number;
    totalWrites: number;
  };
  openingBalances: WipCutoverPlannedBalance[];
  moChecks: WipCutoverMoCheck[];
  warnings: string[];
}

const OPENING_DOC_ID = 'DOC-OPEN-WIP-CUTOVER-01';
const OPENING_DOC_NUMBER = 'OB-WIP-CUTOVER-01';
const OPENING_REF_NUMBER = 'WIP-CUTOVER-V1';

const PART_TARGET_LOCATIONS: Record<string, { warehouseCode: string; locationCode: string }> = {
  '700014': { warehouseCode: 'WH-WIP-WELD', locationCode: 'LOC-WIP-WELD-01' },
  '700026': { warehouseCode: 'WH-WIP-WELD', locationCode: 'LOC-WIP-WELD-02' },
  '611408': { warehouseCode: 'WH-FINISHED', locationCode: 'LOC-FIN-P1' },
};

function mapMoStatus(raw: string): 'PLANNED' | 'RELEASED' | 'IN_PROGRESS' | 'SUSPENDED' | 'COMPLETED' | 'CLOSED' | 'CANCELLED' {
  switch (String(raw || '').toUpperCase()) {
    case 'PLANNED':
    case 'RELEASED':
    case 'IN_PROGRESS':
    case 'SUSPENDED':
    case 'COMPLETED':
    case 'CLOSED':
    case 'CANCELLED':
      return String(raw).toUpperCase() as any;
    default:
      return 'IN_PROGRESS';
  }
}

function mapOpStatus(raw: string): 'PENDING' | 'READY' | 'IN_PROGRESS' | 'COMPLETED' | 'SKIPPED' {
  switch (String(raw || '').toUpperCase()) {
    case 'PENDING':
    case 'READY':
    case 'IN_PROGRESS':
    case 'COMPLETED':
    case 'SKIPPED':
      return String(raw).toUpperCase() as any;
    default:
      return 'PENDING';
  }
}

function sameDateNullable(a: Date | null | undefined, b: Date | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return Math.abs(a.getTime() - b.getTime()) < 1000;
}

export async function runWipCutoverBackfill(
  prisma: PrismaClient,
  mode: WipCutoverMode,
): Promise<WipCutoverReport> {
  const executedAt = new Date().toISOString();
  const warnings: string[] = [];

  const snapshot = await prisma.wipStateSnapshot.findUnique({
    where: { id: 'production-wip-state' },
  });
  if (!snapshot) {
    throw new Error('WipStateSnapshot "production-wip-state" was not found.');
  }
  const payload = snapshot.payload as {
    manufacturingOrders?: SnapshotMo[];
    wipTransfers?: SnapshotTransfer[];
  };
  const snapMos = payload?.manufacturingOrders || [];
  const snapTransfers = payload?.wipTransfers || [];
  if (snapMos.length === 0) {
    throw new Error('WipStateSnapshot "production-wip-state" contains zero manufacturing orders.');
  }

  const [
    parts,
    warehouses,
    locations,
    relMos,
    relOps,
    relTransfers,
    existingBalances,
    existingOpeningDoc,
    users,
  ] = await Promise.all([
    prisma.part.findMany({ include: { unit: true } }),
    prisma.warehouse.findMany(),
    prisma.warehouseLocation.findMany({ include: { warehouse: true } }),
    prisma.manufacturingOrder.findMany(),
    prisma.productionOperation.findMany(),
    prisma.productionTransfer.findMany(),
    prisma.stockBalance.findMany(),
    prisma.inventoryDocument.findUnique({ where: { id: OPENING_DOC_ID } }),
    prisma.user.findMany({ orderBy: { id: 'asc' } }),
  ]);

  const partByNumber = new Map(parts.map(p => [p.partNumber, p]));
  const partById = new Map(parts.map(p => [p.id, p]));
  const whByCode = new Map(warehouses.map(w => [w.code, w]));
  const locByCode = new Map(locations.map(l => [l.code, l]));
  const relMoById = new Map(relMos.map(m => [m.id, m]));
  const relOpById = new Map(relOps.map(o => [o.id, o]));
  const relTransferById = new Map(relTransfers.map(t => [t.id, t]));

  const migrationUser =
    users.find(u => u.id === 'MIGRATION_SYSTEM') ||
    users.find(u => u.id === 'USR-ADMIN') ||
    users[0];
  if (!migrationUser) {
    throw new Error('No user record exists in users table to attribute opening inventory document.');
  }

  const scrapWh = warehouses.find(w => w.type === 'SCRAP' && w.active) || whByCode.get('WH-SCRAP');
  const scrapLoc = locations.find(l => l.warehouseId === scrapWh?.id && l.active);

  // 1. Part target warehouse/location updates
  const partUpdates: Array<{ partId: string; targetWarehouseId: string; targetLocationId: string }> = [];
  for (const [partNumber, target] of Object.entries(PART_TARGET_LOCATIONS)) {
    const part = partByNumber.get(partNumber);
    const wh = whByCode.get(target.warehouseCode);
    const loc = locByCode.get(target.locationCode);
    if (!part || !wh || !loc) {
      warnings.push(`Could not resolve target warehouse/location for part ${partNumber}`);
      continue;
    }
    if (part.targetWarehouseId !== wh.id || part.targetLocationId !== loc.id) {
      partUpdates.push({
        partId: part.id,
        targetWarehouseId: wh.id,
        targetLocationId: loc.id,
      });
    }
  }

  // 2. MO updates
  const moUpdates: Array<{ id: string; data: Prisma.ManufacturingOrderUncheckedUpdateInput }> = [];
  const moChecks: WipCutoverMoCheck[] = [];

  // 3. Operation updates
  const opUpdates: Array<{ id: string; data: Prisma.ProductionOperationUncheckedUpdateInput }> = [];

  // Opening WIP / Scrap buckets per (partId, warehouseId, locationId, qualityStatus)
  interface Bucket {
    partId: string;
    partNumber: string;
    unitId: string;
    unitWeightKg: Prisma.Decimal;
    warehouseId: string;
    warehouseCode: string;
    locationId: string;
    locationCode: string;
    qualityStatus: string;
    quantity: Prisma.Decimal;
    moId: string;
    moNumber: string;
  }
  const buckets = new Map<string, Bucket>();

  const addToBucket = (b: Omit<Bucket, 'quantity'> & { qty: Prisma.Decimal }) => {
    if (b.qty.lte(DECIMAL_ZERO)) return;
    const key = `${b.partId}::${b.warehouseId}::${b.locationId}::${b.qualityStatus}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.quantity = existing.quantity.plus(b.qty);
    } else {
      buckets.set(key, {
        partId: b.partId,
        partNumber: b.partNumber,
        unitId: b.unitId,
        unitWeightKg: b.unitWeightKg,
        warehouseId: b.warehouseId,
        warehouseCode: b.warehouseCode,
        locationId: b.locationId,
        locationCode: b.locationCode,
        qualityStatus: b.qualityStatus,
        quantity: b.qty,
        moId: b.moId,
        moNumber: b.moNumber,
      });
    }
  };

  for (const sMo of snapMos) {
    const relMo = relMoById.get(sMo.id) || relMos.find(m => m.moNumber === sMo.moNumber);
    if (!relMo) {
      throw new Error(`Relational ManufacturingOrder missing for snapshot MO ${sMo.moNumber}`);
    }
    const part = partById.get(relMo.partId);
    if (!part) {
      throw new Error(`Part missing for MO ${sMo.moNumber}`);
    }

    const targetMeta = PART_TARGET_LOCATIONS[part.partNumber];
    const outWh = targetMeta ? whByCode.get(targetMeta.warehouseCode) : undefined;
    const outLoc = targetMeta ? locByCode.get(targetMeta.locationCode) : undefined;

    const initialInputDec = toDecimal(sMo.initialInputQuantity);
    const completedDec = toDecimal(sMo.completedQuantity);
    const scrapDec = toDecimal(sMo.totalScrapQuantity);
    const reworkDec = toDecimal(sMo.totalReworkQuantity);
    const rejectedDec = toDecimal(sMo.totalRejectedQuantity);
    const desiredMoStatus = mapMoStatus(sMo.status);

    const moNeedsUpdate =
      !decimalEq(toDecimal(relMo.initialInputQty), initialInputDec) ||
      !decimalEq(toDecimal(relMo.completedQty), completedDec) ||
      !decimalEq(toDecimal(relMo.scrapQty), scrapDec) ||
      !decimalEq(toDecimal(relMo.totalReworkQty), reworkDec) ||
      !decimalEq(toDecimal(relMo.totalRejectedQty), rejectedDec) ||
      (outWh && relMo.outputWarehouseId !== outWh.id) ||
      (outLoc && relMo.outputLocationId !== outLoc.id) ||
      (sMo.createdBy && relMo.createdByName !== sMo.createdBy) ||
      relMo.status !== desiredMoStatus;

    if (moNeedsUpdate) {
      moUpdates.push({
        id: relMo.id,
        data: {
          initialInputQty: initialInputDec,
          completedQty: completedDec,
          scrapQty: scrapDec,
          totalReworkQty: reworkDec,
          totalRejectedQty: rejectedDec,
          outputWarehouseId: outWh?.id ?? relMo.outputWarehouseId,
          outputLocationId: outLoc?.id ?? relMo.outputLocationId,
          createdByName: sMo.createdBy ?? relMo.createdByName,
          status: desiredMoStatus,
          notes: sMo.notes ?? relMo.notes,
        },
      });
    }

    let moActiveWip = DECIMAL_ZERO;
    let moOpScrap = DECIMAL_ZERO;
    let moOpRework = DECIMAL_ZERO;
    let moOpRejected = DECIMAL_ZERO;

    for (const sOp of sMo.operations || []) {
      const relOp = relOpById.get(sOp.id) || relOps.find(o => o.manufacturingOrderId === relMo.id && o.stepNumber === sOp.stepNumber);
      if (!relOp) {
        throw new Error(`Relational ProductionOperation missing for snapshot op ${sOp.id} (${sMo.moNumber} step ${sOp.stepNumber})`);
      }

      const loc = locByCode.get(sOp.warehouseLocation);
      if (!loc) {
        throw new Error(`WarehouseLocation code "${sOp.warehouseLocation}" missing in DB for op ${sOp.id}`);
      }

      const waitDec = toDecimal(sOp.waitingInputQty);
      const inProgDec = toDecimal(sOp.inProgressQty);
      const goodDec = toDecimal(sOp.goodOutputQty);
      const opScrapDec = toDecimal(sOp.scrapQty);
      const opReworkDec = toDecimal(sOp.reworkQty);
      const opRejectedDec = toDecimal(sOp.rejectedQty);
      const readyDec = toDecimal(sOp.readyForTransferQty);
      const transDec = toDecimal(sOp.transferredQty);
      const startedAtMachineDec = inProgDec.plus(goodDec).plus(opScrapDec).plus(opReworkDec).plus(opRejectedDec);
      const desiredOpStatus = mapOpStatus(sOp.status);
      const desiredLastActivity = sOp.lastActivityAt ? new Date(sOp.lastActivityAt) : null;
      const desiredCycle = Number(sOp.standardCycleTimeSec ?? relOp.standardCycleTimeSec ?? 0);
      const desiredScrapNorm = toDecimal(sOp.scrapNormPercent ?? relOp.scrapNormPercent ?? 0);

      const opNeedsUpdate =
        relOp.sequence !== sOp.sequence ||
        relOp.stepCode !== sOp.stepCode ||
        relOp.stepName !== sOp.stepName ||
        !decimalEq(toDecimal(relOp.inputQty), startedAtMachineDec) ||
        !decimalEq(toDecimal(relOp.waitingInputQty), waitDec) ||
        !decimalEq(toDecimal(relOp.inProgressQty), inProgDec) ||
        !decimalEq(toDecimal(relOp.outputGoodQty), goodDec) ||
        !decimalEq(toDecimal(relOp.outputScrapQty), opScrapDec) ||
        !decimalEq(toDecimal(relOp.outputReworkQty), opReworkDec) ||
        !decimalEq(toDecimal(relOp.outputRejectedQty), opRejectedDec) ||
        !decimalEq(toDecimal(relOp.readyForTransferQty), readyDec) ||
        !decimalEq(toDecimal(relOp.transferredQty), transDec) ||
        relOp.warehouseLocationCode !== sOp.warehouseLocation ||
        relOp.warehouseId !== loc.warehouseId ||
        relOp.locationId !== loc.id ||
        relOp.standardCycleTimeSec !== desiredCycle ||
        !decimalEq(toDecimal(relOp.scrapNormPercent), desiredScrapNorm) ||
        !sameDateNullable(relOp.lastActivityAt, desiredLastActivity) ||
        relOp.status !== desiredOpStatus;

      if (opNeedsUpdate) {
        opUpdates.push({
          id: relOp.id,
          data: {
            sequence: sOp.sequence,
            stepCode: sOp.stepCode,
            stepName: sOp.stepName,
            inputQty: startedAtMachineDec,
            waitingInputQty: waitDec,
            inProgressQty: inProgDec,
            outputGoodQty: goodDec,
            outputScrapQty: opScrapDec,
            outputReworkQty: opReworkDec,
            outputRejectedQty: opRejectedDec,
            readyForTransferQty: readyDec,
            transferredQty: transDec,
            warehouseLocationCode: sOp.warehouseLocation,
            warehouseId: loc.warehouseId,
            locationId: loc.id,
            standardCycleTimeSec: desiredCycle,
            scrapNormPercent: desiredScrapNorm,
            lastActivityAt: desiredLastActivity,
            status: desiredOpStatus,
          },
        });
      }

      const activeStageAvailable = waitDec.plus(inProgDec).plus(readyDec);
      moActiveWip = moActiveWip.plus(activeStageAvailable);
      moOpScrap = moOpScrap.plus(opScrapDec);
      moOpRework = moOpRework.plus(opReworkDec);
      moOpRejected = moOpRejected.plus(opRejectedDec);

      addToBucket({
        partId: part.id,
        partNumber: part.partNumber,
        unitId: part.unitId,
        unitWeightKg: toDecimal(part.weightNetKg),
        warehouseId: loc.warehouseId,
        warehouseCode: loc.warehouse.code,
        locationId: loc.id,
        locationCode: loc.code,
        qualityStatus: 'AVAILABLE',
        qty: activeStageAvailable,
        moId: relMo.id,
        moNumber: relMo.moNumber,
      });

      if (opScrapDec.gt(DECIMAL_ZERO) && scrapWh && scrapLoc) {
        addToBucket({
          partId: part.id,
          partNumber: part.partNumber,
          unitId: part.unitId,
          unitWeightKg: toDecimal(part.weightNetKg),
          warehouseId: scrapWh.id,
          warehouseCode: scrapWh.code,
          locationId: scrapLoc.id,
          locationCode: scrapLoc.code,
          qualityStatus: 'SCRAP',
          qty: opScrapDec,
          moId: relMo.id,
          moNumber: relMo.moNumber,
        });
      }
    }

    const inTransit = snapTransfers
      .filter(t => t.moId === sMo.id && t.status === 'PENDING_APPROVAL')
      .reduce((acc, t) => acc.plus(toDecimal(t.quantity)), DECIMAL_ZERO);

    const accounted = moActiveWip.plus(inTransit).plus(completedDec).plus(moOpScrap).plus(moOpRework).plus(moOpRejected);
    const discrepancy = accounted.minus(initialInputDec);

    moChecks.push({
      moNumber: relMo.moNumber,
      partNumber: part.partNumber,
      initialInputQty: initialInputDec.toString(),
      activeWipQty: moActiveWip.toString(),
      inTransitQty: inTransit.toString(),
      completedQty: completedDec.toString(),
      scrapQty: moOpScrap.toString(),
      reworkQty: moOpRework.toString(),
      rejectedQty: moOpRejected.toString(),
      discrepancy: discrepancy.toString(),
      isConserved: discrepancy.isZero(),
    });

    if (!discrepancy.isZero()) {
      throw new Error(`Conservation check failed for ${relMo.moNumber}: discrepancy=${discrepancy.toString()}`);
    }
  }

  // 4. Transfer enrichment updates
  const transferUpdates: Array<{ id: string; data: Prisma.ProductionTransferUncheckedUpdateInput }> = [];
  for (const sTr of snapTransfers) {
    const relTr = relTransferById.get(sTr.id) || relTransfers.find(t => t.transferNumber === sTr.transferNumber);
    if (!relTr) {
      warnings.push(`Snapshot transfer ${sTr.transferNumber} not found in relational table`);
      continue;
    }
    const fromLoc = sTr.fromLocation ? locByCode.get(sTr.fromLocation) : undefined;
    const toLoc = sTr.toLocation ? locByCode.get(sTr.toLocation) : undefined;

    const trNeedsUpdate =
      (fromLoc && relTr.fromLocationId !== fromLoc.id) ||
      (toLoc && relTr.toLocationId !== toLoc.id) ||
      (sTr.fromLocation && relTr.fromLocationCode !== sTr.fromLocation) ||
      (sTr.toLocation && relTr.toLocationCode !== sTr.toLocation) ||
      (sTr.fromStepNumber != null && relTr.fromStepNumber !== sTr.fromStepNumber) ||
      (sTr.toStepNumber != null && relTr.toStepNumber !== sTr.toStepNumber) ||
      (sTr.fromStepName && relTr.fromStepName !== sTr.fromStepName) ||
      (sTr.toStepName && relTr.toStepName !== sTr.toStepName) ||
      (sTr.dispatchedBy && relTr.dispatchedByName !== sTr.dispatchedBy) ||
      (sTr.receivedBy && relTr.receivedByName !== sTr.receivedBy);

    if (trNeedsUpdate) {
      transferUpdates.push({
        id: relTr.id,
        data: {
          fromLocationId: fromLoc?.id ?? relTr.fromLocationId,
          toLocationId: toLoc?.id ?? relTr.toLocationId,
          fromLocationCode: sTr.fromLocation ?? relTr.fromLocationCode,
          toLocationCode: sTr.toLocation ?? relTr.toLocationCode,
          fromStepNumber: sTr.fromStepNumber ?? relTr.fromStepNumber,
          toStepNumber: sTr.toStepNumber ?? relTr.toStepNumber,
          fromStepName: sTr.fromStepName ?? relTr.fromStepName,
          toStepName: sTr.toStepName ?? relTr.toStepName,
          dispatchedByName: sTr.dispatchedBy ?? relTr.dispatchedByName,
          receivedByName: sTr.receivedBy ?? relTr.receivedByName,
          notes: sTr.notes ?? relTr.notes,
        },
      });
    }
  }

  // 5. Opening active WIP stock balances & INITIAL_BALANCE document (idempotent)
  const bucketList = Array.from(buckets.values());
  const openingBalances: WipCutoverPlannedBalance[] = existingOpeningDoc
    ? []
    : bucketList.map(b => ({
        partNumber: b.partNumber,
        partId: b.partId,
        warehouseCode: b.warehouseCode,
        warehouseId: b.warehouseId,
        locationCode: b.locationCode,
        locationId: b.locationId,
        qualityStatus: b.qualityStatus,
        quantity: b.quantity.toString(),
        weightKg: b.quantity.mul(b.unitWeightKg).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP).toString(),
        moId: b.moId,
        moNumber: b.moNumber,
      }));

  if (!existingOpeningDoc) {
    // Safety guard: make sure none of the target active WIP locations already carry StockBalance
    for (const b of bucketList) {
      const conflict = existingBalances.find(
        eb =>
          eb.partId === b.partId &&
          eb.warehouseId === b.warehouseId &&
          eb.locationId === b.locationId &&
          eb.qualityStatus === b.qualityStatus,
      );
      if (conflict) {
        throw new Error(
          `Existing StockBalance found at opening WIP location ${b.warehouseCode}/${b.locationCode} for part ${b.partNumber} (qty=${conflict.quantityOnHand.toString()}). Refusing to duplicate.`,
        );
      }
    }
  }

  const openingDocInserts = existingOpeningDoc ? 0 : 1;
  const openingLineInserts = existingOpeningDoc ? 0 : bucketList.length;
  const openingTxInserts = existingOpeningDoc ? 0 : bucketList.length;
  const openingBalanceInserts = existingOpeningDoc ? 0 : bucketList.length;

  const totalWrites =
    partUpdates.length +
    moUpdates.length +
    opUpdates.length +
    transferUpdates.length +
    openingDocInserts +
    openingLineInserts +
    openingTxInserts +
    openingBalanceInserts;

  if (mode === 'apply' && totalWrites > 0) {
    const now = new Date();
    const docWh = whByCode.get('WH-WIP-STAMP') || warehouses[0];
    await prisma.$transaction(
      async (tx) => {
        for (const pu of partUpdates) {
          await tx.part.update({
            where: { id: pu.partId },
            data: {
              targetWarehouseId: pu.targetWarehouseId,
              targetLocationId: pu.targetLocationId,
            },
          });
        }
        for (const mu of moUpdates) {
          await tx.manufacturingOrder.update({
            where: { id: mu.id },
            data: mu.data,
          });
        }
        for (const ou of opUpdates) {
          await tx.productionOperation.update({
            where: { id: ou.id },
            data: ou.data,
          });
        }
        for (const tu of transferUpdates) {
          await tx.productionTransfer.update({
            where: { id: tu.id },
            data: tu.data,
          });
        }

        if (!existingOpeningDoc && bucketList.length > 0) {
          await tx.inventoryDocument.create({
            data: {
              id: OPENING_DOC_ID,
              documentNumber: OPENING_DOC_NUMBER,
              documentType: 'INITIAL_BALANCE',
              documentDate: now,
              documentStatus: 'CONFIRMED',
              postingStatus: 'POSTED',
              warehouseId: docWh.id,
              referenceType: 'MANUFACTURING_ORDER',
              referenceNumber: OPENING_REF_NUMBER,
              createdByUserId: migrationUser.id,
              postedByUserId: migrationUser.id,
              postedAt: now,
              notes: 'سند افتتاحیه موجودی در جریان ساخت (WIP) استخراج‌شده از وضعیت تاییدشده خط تولید در لحظه قطع اسنپ‌شات',
            },
          });

          for (let i = 0; i < bucketList.length; i++) {
            const b = bucketList[i];
            const weightKg = b.quantity.mul(b.unitWeightKg).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
            const lineId = `${OPENING_DOC_ID}-L${String(i + 1).padStart(2, '0')}`;
            const txNum = `TRX-${OPENING_DOC_NUMBER}-${String(i + 1).padStart(2, '0')}`;
            const isAvailable = b.qualityStatus === 'AVAILABLE';

            await tx.inventoryDocumentLine.create({
              data: {
                id: lineId,
                documentId: OPENING_DOC_ID,
                lineNumber: i + 1,
                partId: b.partId,
                locationId: b.locationId,
                quantity: b.quantity,
                unitId: b.unitId,
                weightKg,
                ownership: 'COMPANY_OWNED',
                contractId: 'CNT-SAPCO-ECU-BRK',
                contractNumber: 'CNT-SAPCO-ECU-BRK',
                qualityStatus: b.qualityStatus,
                notes: `موجودی اول دوره WIP دستور کار ${b.moNumber} در موقعیت ${b.locationCode}`,
              },
            });

            await tx.stockBalance.create({
              data: {
                partId: b.partId,
                warehouseId: b.warehouseId,
                locationId: b.locationId,
                quantityOnHand: b.quantity,
                quantityReserved: DECIMAL_ZERO,
                quantityAvailable: isAvailable ? b.quantity : DECIMAL_ZERO,
                weightKgOnHand: weightKg,
                weightKgReserved: DECIMAL_ZERO,
                weightKgAvailable: isAvailable ? weightKg : DECIMAL_ZERO,
                ownership: 'COMPANY_OWNED',
                contractId: 'CNT-SAPCO-ECU-BRK',
                contractNumber: 'CNT-SAPCO-ECU-BRK',
                qualityStatus: b.qualityStatus,
                lastTransactionAt: now,
              },
            });

            await tx.inventoryTransaction.create({
              data: {
                transactionNumber: txNum,
                documentId: OPENING_DOC_ID,
                documentLineId: lineId,
                partId: b.partId,
                warehouseId: b.warehouseId,
                locationId: b.locationId,
                transactionType: 'INBOUND',
                quantity: b.quantity,
                quantitySigned: b.quantity,
                unitId: b.unitId,
                weightKg,
                weightKgSigned: weightKg,
                ownership: 'COMPANY_OWNED',
                contractId: 'CNT-SAPCO-ECU-BRK',
                contractNumber: 'CNT-SAPCO-ECU-BRK',
                qualityStatus: b.qualityStatus,
                balanceAfter: b.quantity,
                balanceKgAfter: weightKg,
                transactionDate: now,
                postingStatus: 'POSTED',
                createdByUserId: migrationUser.id,
                manufacturingOrderId: b.moId,
              },
            });
          }
        }
      },
      { isolationLevel: 'Serializable', timeout: 30000 },
    );
  }

  return {
    mode,
    applied: mode === 'apply' && totalWrites > 0,
    executedAt,
    snapshotVersion: snapshot.version ?? null,
    planned: {
      partUpdates: partUpdates.length,
      moUpdates: moUpdates.length,
      operationUpdates: opUpdates.length,
      transferUpdates: transferUpdates.length,
      openingDocInserts,
      openingLineInserts,
      openingTxInserts,
      openingBalanceInserts,
      totalWrites,
    },
    openingBalances,
    moChecks,
    warnings,
  };
}
