import { getPrismaClient } from './db/prisma';
import { postWipProductionDb } from './services/productionWipService';

export interface WipProductionLedgerInput {
  wipManufacturingOrderId: string;
  wipOperationId: string;
  idempotencyKey: string;
  machineId?: string;
  shiftId: string;
  createdByUserId?: string;
  reportDate?: string;
  notes?: string;
  goodQty: number;
  scrapQty: number;
  reworkQty: number;
  rejectedQty: number;
  scrapReason?: string;
  operatorName?: string;
  expectedVersion?: number;
  expectedSnapshotVersion?: number;
  snapshotPayload?: {
    manufacturingOrders: unknown[];
    wipTransfers: unknown[];
    productionLogs: unknown[];
  };
}

export async function findWipProductionReportByKey(idempotencyKey: string) {
  return getPrismaClient().productionReport.findUnique({
    where: { wipIdempotencyKey: idempotencyKey },
    select: {
      id: true,
      reportNumber: true,
      manufacturingOrderId: true,
      productionOperationId: true,
      goodQuantity: true,
      scrapQuantity: true,
      reworkQuantity: true,
      rejectedQuantity: true,
      scrapReasonText: true,
      reportDate: true,
    },
  });
}

export async function postWipProductionAtomically(input: WipProductionLedgerInput) {
  return postWipProductionDb({
    moId: input.wipManufacturingOrderId,
    operationId: input.wipOperationId,
    idempotencyKey: input.idempotencyKey,
    machineId: input.machineId,
    shiftId: input.shiftId,
    createdByUserId: input.createdByUserId,
    reportDate: input.reportDate,
    notes: input.notes,
    goodQty: input.goodQty,
    scrapQty: input.scrapQty,
    reworkQty: input.reworkQty,
    rejectedQty: input.rejectedQty,
    scrapReason: input.scrapReason,
    operatorName: input.operatorName,
    expectedVersion: input.expectedVersion,
  });
}
