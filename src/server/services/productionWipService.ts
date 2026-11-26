import { createHash, randomUUID } from 'node:crypto';
import {
  ManufacturingOrder as WipManufacturingOrderDto,
  ManufacturingOperation as WipOperationDto,
  WipTransfer as WipTransferDto,
  ProductionActivityLog as WipActivityLogDto,
  WipDashboardMetrics,
  MoReconciliationReport,
  ManufacturingOrderStatus,
  OperationExecutionStatus,
  WipTransferStatus,
} from '../../types/productionWip';
import { ProcessType } from '../../types/inventory';
import { getPrismaClient, isDatabaseUrlConfigured } from '../db/prisma';
import {
  getLocationForProcess,
  manufacturingOrdersStore,
  wipTransfersStore,
  productionLogsStore,
} from '../productionWipEngine';
import { consumeMoReservationsInTx, releaseMoReservationsInTx } from './inventoryLedgerService';

let testPrismaOverride: any = null;

export function __setProductionWipPrismaForTests(client: any): void {
  testPrismaOverride = client;
}

function getWipPrisma(): any {
  return testPrismaOverride || getPrismaClient();
}

export function __getProductionWipPrisma(): any {
  return getWipPrisma();
}

export async function isOperationPausedInTx(tx: any, productionOperationId: string): Promise<boolean> {
  if (!productionOperationId || typeof tx?.productionActivityLog?.findMany !== 'function') {
    return false;
  }
  const logs = await tx.productionActivityLog.findMany({
    where: { productionOperationId },
    orderBy: [{ timestamp: 'desc' }],
  });
  if (!Array.isArray(logs) || logs.length === 0) return false;
  const lifecycle = logs.filter((l: any) =>
    ['OP_START', 'OP_PAUSE', 'OP_RESUME', 'OP_COMPLETE'].includes(String(l.activityType || '')),
  );
  if (lifecycle.length === 0) return false;
  lifecycle.sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return lifecycle[0]?.activityType === 'OP_PAUSE';
}

export async function assertMachineEligibleForOpInTx(
  tx: any,
  args: { machine: any; op: any; part?: any; strictIfCapabilitiesSeeded?: boolean },
): Promise<void> {
  const { machine, op, part } = args;
  if (!machine || !machine.active || machine.status !== 'ACTIVE') {
    throw new WipServiceError('ماشین انتخاب‌شده معتبر یا در وضعیت فعال (ACTIVE) نیست.', 409);
  }

  let die: any = op.plannedDie || null;
  if (!die && op.plannedDieId && typeof tx?.die?.findUnique === 'function') {
    die = await tx.die.findUnique({ where: { id: op.plannedDieId } });
  }
  const requiredTonnage = Math.max(
    num(op.routeOperation?.requiredTonnage),
    num(die?.tonnageRequired),
  );
  const machineTonnage = num(machine.tonnageCapacity);

  if (typeof tx?.machineCapability?.findMany === 'function') {
    const allCaps = await tx.machineCapability.findMany({});
    if (Array.isArray(allCaps) && allCaps.length > 0) {
      const machineCaps = await tx.machineCapability.findMany({
        where: { machineId: machine.id },
        include: { operation: true },
      });
      const matchingCap = (machineCaps || []).find(
        (c: any) =>
          c.operationId === op.operationId ||
          (op.operation?.processType && c.operation?.processType === op.operation.processType),
      );
      if (!matchingCap) {
        throw new WipServiceError(
          `ماشین ${machine.code || machine.name} قابلیت فنی انجام عملیات ${op.stepCode || op.operation?.code || ''} را ندارد.`,
          400,
        );
      }
      const capMaxTonnage = matchingCap.maxTonnage != null ? num(matchingCap.maxTonnage) : null;
      if (
        requiredTonnage > 0 &&
        (machineTonnage < requiredTonnage || (capMaxTonnage !== null && capMaxTonnage < requiredTonnage))
      ) {
        throw new WipServiceError(
          `تناژ ماشین ${machine.code || machine.name} (${machineTonnage} تن) کمتر از تناژ مورد نیاز عملیات (${requiredTonnage} تن) است.`,
          400,
        );
      }
      const thicknessMm = part?.thicknessMm != null ? num(part.thicknessMm) : null;
      if (thicknessMm != null) {
        if (
          (matchingCap.minThicknessMm != null && thicknessMm < num(matchingCap.minThicknessMm)) ||
          (matchingCap.maxThicknessMm != null && thicknessMm > num(matchingCap.maxThicknessMm))
        ) {
          throw new WipServiceError(
            `ضخامت قطعه (${thicknessMm} mm) خارج از محدوده مجاز ماشین ${machine.code || machine.name} است.`,
            400,
          );
        }
      }
    }
  } else if (requiredTonnage > 0 && machineTonnage > 0 && machineTonnage < requiredTonnage) {
    throw new WipServiceError(
      `تناژ ماشین ${machine.code || machine.name} (${machineTonnage} تن) کمتر از تناژ مورد نیاز عملیات (${requiredTonnage} تن) است.`,
      400,
    );
  }

  if (op.plannedDieId && typeof tx?.machineDieCompatibility?.findMany === 'function') {
    const dieCompats = await tx.machineDieCompatibility.findMany({
      where: { dieId: op.plannedDieId },
    });
    if (Array.isArray(dieCompats) && dieCompats.length > 0) {
      const compatible = dieCompats.some((dc: any) => dc.machineId === machine.id);
      if (!compatible) {
        throw new WipServiceError(
          `قالب ${die?.code || op.plannedDieId} با ماشین ${machine.code || machine.name} سازگار نیست.`,
          400,
        );
      }
    }
  }
}

export class WipServiceError extends Error {
  statusCode: number;
  conflict: boolean;

  constructor(message: string, statusCode = 400, conflict = false) {
    super(message);
    this.name = 'WipServiceError';
    this.statusCode = statusCode;
    this.conflict = conflict;
  }
}

function wrapWipTxError(err: unknown): never {
  if (err instanceof WipServiceError) throw err;
  const code = String((err as any)?.code || '');
  if (code === 'P2034' || code === 'P2002') {
    throw new WipServiceError(
      'تداخل هم‌زمانی در تراکنش پایگاه داده رخ داد؛ لطفاً اطلاعات را تازه‌سازی و دوباره تلاش کنید.',
      409,
      true,
    );
  }
  throw err instanceof Error ? err : new Error(String(err));
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const round6 = (v: number): number => Math.round(v * 1_000_000) / 1_000_000;

function assertMoMutable(mo: { status: string; moNumber?: string }): void {
  if (mo.status === 'CANCELLED' || mo.status === 'CLOSED') {
    throw new WipServiceError(
      `دستور تولید «${mo.moNumber || ''}» در وضعیت ${mo.status} قرار دارد و قابل تغییر نیست.`,
      409,
    );
  }
}

function buildStockKey(row: {
  partId: string;
  warehouseId: string;
  locationId?: string | null;
  materialLotId?: string | null;
  physicalCoilId?: string | null;
  ownership?: string | null;
  contractId?: string | null;
  qualityStatus?: string | null;
}): string {
  return [
    row.partId,
    row.warehouseId,
    row.locationId ?? '',
    row.materialLotId ?? '',
    row.physicalCoilId ?? '',
    row.ownership ?? 'COMPANY_OWNED',
    row.contractId ?? '',
    row.qualityStatus ?? 'AVAILABLE',
  ].join('::');
}

function mapMoStatusToDto(status: string): ManufacturingOrderStatus {
  if (status === 'PLANNED' || status === 'RELEASED' || status === 'IN_PROGRESS' || status === 'COMPLETED' || status === 'CANCELLED') {
    return status;
  }
  if (status === 'CLOSED') return 'COMPLETED';
  if (status === 'SUSPENDED') return 'IN_PROGRESS';
  return 'RELEASED';
}

function mapOpStatusToDto(status: string): OperationExecutionStatus {
  if (status === 'PENDING' || status === 'READY' || status === 'IN_PROGRESS' || status === 'COMPLETED') {
    return status;
  }
  if (status === 'SKIPPED') return 'COMPLETED';
  return 'PENDING';
}

function mapTransferStatusToDto(status: string): WipTransferStatus {
  if (status === 'DISPATCHED') return 'PENDING_APPROVAL';
  if (status === 'RECEIVED') return 'APPROVED';
  if (status === 'AUTO_TRANSFERRED') return 'AUTO_TRANSFERRED';
  return 'REJECTED';
}

export function mapScrapReasonEnum(text?: string | null):
  | 'TEAR_CRACK'
  | 'WRINKLING'
  | 'DIMENSIONAL_OUT_OF_SPEC'
  | 'BURR_HIGH'
  | 'SURFACE_SCRATCH'
  | 'MATERIAL_DEFECT'
  | 'SETUP_SCRAP'
  | 'MACHINE_MALFUNCTION'
  | 'OTHER' {
  if (!text) return 'OTHER';
  const upper = text.trim().toUpperCase();
  const direct = [
    'TEAR_CRACK',
    'WRINKLING',
    'DIMENSIONAL_OUT_OF_SPEC',
    'BURR_HIGH',
    'SURFACE_SCRATCH',
    'MATERIAL_DEFECT',
    'SETUP_SCRAP',
    'MACHINE_MALFUNCTION',
    'OTHER',
  ] as const;
  if ((direct as readonly string[]).includes(upper)) {
    return upper as (typeof direct)[number];
  }
  const lower = text.trim();
  if (/پارگی|ترک|شکست|tear|crack/i.test(lower)) return 'TEAR_CRACK';
  if (/چروک|تاب|wrinkl/i.test(lower)) return 'WRINKLING';
  if (/تلرانس|ابعاد|اندازه|dimension|spec/i.test(lower)) return 'DIMENSIONAL_OUT_OF_SPEC';
  if (/پلیسه|تیز|burr/i.test(lower)) return 'BURR_HIGH';
  if (/خط|خش|زدگی|سطح|scratch|surface/i.test(lower)) return 'SURFACE_SCRATCH';
  if (/متریال|ورق|فولاد|متالورژ|defect/i.test(lower)) return 'MATERIAL_DEFECT';
  if (/ستاپ|تنظیم|راه‌اندازی|setup/i.test(lower)) return 'SETUP_SCRAP';
  if (/پرس|دستگاه|ماشین|فشار|روغن|machine|malfunction/i.test(lower)) return 'MACHINE_MALFUNCTION';
  return 'OTHER';
}

export function mapRelationalMoToWipDto(moRow: any): WipManufacturingOrderDto & { version: number } {
  const opsSorted = [...(moRow.operations || [])].sort(
    (a: any, b: any) => (a.sequence ?? a.stepNumber) - (b.sequence ?? b.stepNumber) || a.stepNumber - b.stepNumber,
  );
  const operations: (WipOperationDto & { version: number })[] = opsSorted.map((op: any, idx: number) => {
    const processType = (op.operation?.processType || 'PUNCH_FORM') as ProcessType;
    const warehouseLocation =
      op.warehouseLocationCode ||
      op.location?.code ||
      getLocationForProcess(processType, op.stepNumber);
    return {
      id: op.id,
      moId: moRow.id,
      moNumber: moRow.moNumber,
      stepNumber: op.stepNumber,
      stepCode: op.stepCode || op.operation?.code || `OP${op.stepNumber}`,
      stepName: op.stepName || op.operation?.name || `مرحله ${op.stepNumber}`,
      processType,
      sequence: op.sequence || idx + 1,
      machineId: op.plannedMachineId || undefined,
      machineName: op.plannedMachine?.name || undefined,
      dieMoldId: op.plannedDieId || undefined,
      dieMoldName: op.plannedDie?.name || undefined,
      warehouseLocation,
      status: mapOpStatusToDto(op.status),
      waitingInputQty: num(op.waitingInputQty),
      inProgressQty: num(op.inProgressQty),
      goodOutputQty: num(op.outputGoodQty),
      scrapQty: num(op.outputScrapQty),
      reworkQty: num(op.outputReworkQty),
      rejectedQty: num(op.outputRejectedQty),
      readyForTransferQty: num(op.readyForTransferQty),
      transferredQty: num(op.transferredQty),
      standardCycleTimeSec: Number(op.standardCycleTimeSec || 0),
      scrapNormPercent: num(op.scrapNormPercent),
      lastActivityAt: toIsoSafe(op.lastActivityAt || op.updatedAt || moRow.updatedAt || op.createdAt),
      createdAt: toIsoSafe(op.createdAt || moRow.createdAt),
      version: Number(op.version ?? 1),
    };
  });

  return {
    id: moRow.id,
    moNumber: moRow.moNumber,
    partId: moRow.partId,
    partCode: moRow.part?.partNumber || '',
    partName: moRow.part?.name || '',
    targetQuantity: num(moRow.targetQty),
    initialInputQuantity: num(moRow.initialInputQty),
    completedQuantity: num(moRow.completedQty),
    totalScrapQuantity: num(moRow.scrapQty),
    totalReworkQuantity: num(moRow.totalReworkQty),
    totalRejectedQuantity: num(moRow.totalRejectedQty),
    routingId: moRow.routeId,
    routingVersion: moRow.route?.version || 'V1.0',
    parentMoId: moRow.parentMoId || undefined,
    parentMoNumber: moRow.parentMo?.moNumber || undefined,
    bomId: moRow.bomId || undefined,
    status: mapMoStatusToDto(moRow.status),
    startDate: toIsoSafe(moRow.scheduledStartDate || moRow.createdAt).slice(0, 10),
    dueDate: toIsoSafe(moRow.scheduledEndDate || moRow.createdAt).slice(0, 10),
    closedAt: moRow.closedAt ? toIsoSafe(moRow.closedAt) : undefined,
    operations,
    notes: moRow.notes || undefined,
    createdBy: moRow.createdByName || 'مدیر برنامه‌ریزی تولید',
    createdAt: toIsoSafe(moRow.createdAt),
    updatedAt: toIsoSafe(moRow.updatedAt || moRow.createdAt),
    version: Number(moRow.version ?? 1),
  };
}

function toIsoSafe(val: unknown, fallback: Date = new Date()): string {
  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? fallback.toISOString() : val.toISOString();
  }
  if (typeof val === 'string' && val.trim()) {
    const parsed = new Date(val);
    return Number.isNaN(parsed.getTime()) ? fallback.toISOString() : parsed.toISOString();
  }
  if (typeof val === 'number' && Number.isFinite(val)) {
    const parsed = new Date(val);
    return Number.isNaN(parsed.getTime()) ? fallback.toISOString() : parsed.toISOString();
  }
  return fallback.toISOString();
}

export function mapRelationalTransferToDto(trRow: any): WipTransferDto & { version: number } {
  return {
    id: trRow.id,
    transferNumber: trRow.transferNumber,
    moId: trRow.manufacturingOrderId,
    moNumber: trRow.manufacturingOrder?.moNumber || '',
    partId: trRow.partId,
    partCode: trRow.part?.partNumber || '',
    partName: trRow.part?.name || '',
    fromOperationId: trRow.fromStageOperationId || '',
    fromStepNumber: Number(trRow.fromStepNumber || 0),
    fromStepName: trRow.fromStepName || trRow.fromWarehouse?.name || '',
    fromLocation: trRow.fromLocationCode || trRow.fromLocation?.code || trRow.fromWarehouse?.code || '',
    toOperationId: trRow.toStageOperationId || 'STORE-FINISHED',
    toStepNumber: Number(trRow.toStepNumber || 999),
    toStepName: trRow.toStepName || trRow.toWarehouse?.name || 'انبار محصول نهایی',
    toLocation: trRow.toLocationCode || trRow.toLocation?.code || trRow.toWarehouse?.code || '',
    quantity: num(trRow.quantity),
    status: mapTransferStatusToDto(trRow.status),
    dispatchedBy: trRow.dispatchedByName || 'سرپرست تولید',
    dispatchedAt: toIsoSafe(trRow.dispatchedAt),
    receivedBy: trRow.receivedByName || undefined,
    receivedAt: trRow.receivedAt ? toIsoSafe(trRow.receivedAt) : undefined,
    rejectionReason: trRow.rejectionReason || undefined,
    notes: trRow.notes || undefined,
    version: Number(trRow.version ?? 1),
  };
}

export function mapRelationalActivityLogToDto(row: any): WipActivityLogDto {
  return {
    id: row.id,
    moId: row.manufacturingOrderId,
    moNumber: row.moNumber,
    partId: row.partId || row.manufacturingOrder?.partId || undefined,
    partCode: row.manufacturingOrder?.part?.partNumber || undefined,
    partName: row.manufacturingOrder?.part?.name || undefined,
    operationId: row.productionOperationId || '',
    stepNumber: Number(row.stepNumber || 0),
    stepName: row.stepName,
    activityType: (row.activityType || 'PRODUCTION_RUN') as WipActivityLogDto['activityType'],
    quantity: num(row.quantity),
    goodQty: row.goodQty == null ? undefined : num(row.goodQty),
    scrapQty: row.scrapQty == null ? undefined : num(row.scrapQty),
    reworkQty: row.reworkQty == null ? undefined : num(row.reworkQty),
    rejectedQty: row.rejectedQty == null ? undefined : num(row.rejectedQty),
    operatorName: row.operatorName,
    machineId: row.machineId || undefined,
    scrapReason: row.scrapReason || undefined,
    timestamp: toIsoSafe(row.timestamp),
    notes: row.notes || undefined,
  };
}

/**
 * Auth/RBAC is deferred: resolve any existing User record even when active=false.
 */
export async function resolvePostingUser(tx: any, requestedUserId?: string) {
  if (requestedUserId && requestedUserId.trim()) {
    const reqId = requestedUserId.trim();
    const byId = await tx.user.findFirst({
      where: { OR: [{ id: reqId }, { username: reqId }, { personnelCode: reqId }] },
    });
    if (byId) return byId;
  }
  const activeUser = await tx.user.findFirst({ where: { active: true }, orderBy: { createdAt: 'asc' } });
  if (activeUser) return activeUser;

  const preferred = await tx.user.findFirst({
    where: { OR: [{ id: 'USR-OP-01' }, { id: 'USR-ADMIN' }, { id: 'OPR-001' }, { username: 'admin' }] },
    orderBy: { createdAt: 'asc' },
  });
  if (preferred) return preferred;

  const anyUser = await tx.user.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!anyUser) {
    throw new WipServiceError('هیچ رکورد کاربری در جدول users پایگاه داده یافت نشد.', 400);
  }
  return anyUser;
}

export async function resolveLocationByCodeOrId(tx: any, codeOrId: string) {
  if (!codeOrId || !codeOrId.trim()) {
    throw new WipServiceError('کد موقعیت انبار الزامی است.', 400);
  }
  const key = codeOrId.trim();
  const byId = await tx.warehouseLocation.findFirst({
    where: { id: key, active: true },
    include: { warehouse: true },
  });
  if (byId) return byId;

  const rows = await tx.warehouseLocation.findMany({
    where: { code: key, active: true },
    include: { warehouse: true },
  });
  if (rows.length !== 1) {
    throw new WipServiceError(
      `موقعیت انبار با کد «${key}» باید دقیقاً به یک لوکیشن فعال متصل شود (تعداد یافت‌شده: ${rows.length}).`,
      400,
    );
  }
  return rows[0];
}

export async function resolveOutputDestination(tx: any, mo: any, part: any) {
  if (mo?.outputWarehouseId && mo?.outputLocationId) {
    const loc = await tx.warehouseLocation.findFirst({
      where: { id: mo.outputLocationId, warehouseId: mo.outputWarehouseId, active: true },
      include: { warehouse: true },
    });
    if (loc && loc.warehouse?.active) return loc;
  }
  if (mo?.outputWarehouseId) {
    const loc = await tx.warehouseLocation.findFirst({
      where: { warehouseId: mo.outputWarehouseId, active: true, warehouse: { active: true } },
      include: { warehouse: true },
      orderBy: { code: 'asc' },
    });
    if (loc) return loc;
  }
  if (part?.targetWarehouseId && part?.targetLocationId) {
    const loc = await tx.warehouseLocation.findFirst({
      where: { id: part.targetLocationId, warehouseId: part.targetWarehouseId, active: true },
      include: { warehouse: true },
    });
    if (loc && loc.warehouse?.active) return loc;
  }
  if (part?.targetWarehouseId) {
    const loc = await tx.warehouseLocation.findFirst({
      where: { warehouseId: part.targetWarehouseId, active: true, warehouse: { active: true } },
      include: { warehouse: true },
      orderBy: { code: 'asc' },
    });
    if (loc) return loc;
  }

  const desiredWarehouseType = part?.category === 'FINISHED_GOOD' ? 'FINISHED_GOODS' : 'WIP';
  const warehouses = await tx.warehouse.findMany({
    where: { type: desiredWarehouseType, active: true },
    include: {
      locations: {
        where: { active: true },
        orderBy: { code: 'asc' },
      },
    },
    orderBy: { code: 'asc' },
  });

  for (const wh of warehouses) {
    if (wh.locations?.length) {
      const loc = wh.locations[0];
      return { ...loc, warehouse: wh };
    }
  }

  throw new WipServiceError(
    `انبار و موقعیت مقصد نهایی برای قطعه «${part?.partNumber || ''}» (${desiredWarehouseType}) تعریف نشده است.`,
    400,
  );
}

const MO_INCLUDE = {
  part: { include: { unit: true } },
  route: { select: { id: true, version: true } },
  parentMo: { select: { id: true, moNumber: true } },
  outputWarehouse: true,
  outputLocation: true,
  operations: {
    include: {
      operation: true,
      plannedMachine: true,
      plannedDie: true,
      warehouse: true,
      location: true,
    },
    orderBy: [{ sequence: 'asc' as const }, { stepNumber: 'asc' as const }],
  },
};

function computeMoReconciliationFromRow(moRow: any, pendingTransfers: any[]): MoReconciliationReport {
  const opsSorted = [...(moRow.operations || [])].sort(
    (a: any, b: any) => (a.sequence ?? a.stepNumber) - (b.sequence ?? b.stepNumber) || a.stepNumber - b.stepNumber,
  );

  let totalWaiting = 0;
  let totalInProgress = 0;
  let totalReady = 0;
  let totalScrap = 0;
  let totalRework = 0;
  let totalRejected = 0;

  const operationsBreakdown = opsSorted.map((op: any) => {
    const w = num(op.waitingInputQty);
    const p = num(op.inProgressQty);
    const r = num(op.readyForTransferQty);
    const s = num(op.outputScrapQty);
    const rw = num(op.outputReworkQty);
    const rj = num(op.outputRejectedQty);
    const trOut = num(op.transferredQty);

    totalWaiting += w;
    totalInProgress += p;
    totalReady += r;
    totalScrap += s;
    totalRework += rw;
    totalRejected += rj;

    return {
      stepNumber: op.stepNumber,
      stepCode: op.stepCode || op.operation?.code || `OP${op.stepNumber}`,
      stepName: op.stepName || op.operation?.name || '',
      waitingInput: w,
      inProgress: p,
      readyForTransfer: r,
      transferredOut: trOut,
      scrap: s,
      rework: rw,
      rejected: rj,
    };
  });

  const totalInTransit = pendingTransfers
    .filter(t => t.manufacturingOrderId === moRow.id && t.status === 'DISPATCHED')
    .reduce((sum, t) => sum + num(t.quantity), 0);

  const initialInput = num(moRow.initialInputQty);
  const totalCurrentWip = round6(totalWaiting + totalInProgress + totalReady);
  const totalCompleted = num(moRow.completedQty);
  const accountedTotal = round6(
    totalCurrentWip + totalInTransit + totalCompleted + totalScrap + totalRework + totalRejected,
  );
  const discrepancy = round6(accountedTotal - initialInput);

  return {
    moId: moRow.id,
    moNumber: moRow.moNumber,
    partCode: moRow.part?.partNumber || '',
    partName: moRow.part?.name || '',
    initialInputQuantity: initialInput,
    totalCurrentWip,
    totalInTransit,
    totalCompleted,
    totalScrap,
    totalRework,
    totalRejected,
    accountedTotal,
    discrepancy,
    isConserved: Math.abs(discrepancy) < 1e-6,
    operationsBreakdown,
    auditTimestamp: new Date().toISOString(),
  };
}

export async function listManufacturingOrdersDb(): Promise<Array<WipManufacturingOrderDto & { version: number }>> {
  const prisma = getWipPrisma();
  const rows = await prisma.manufacturingOrder.findMany({
    include: MO_INCLUDE,
    orderBy: [{ createdAt: 'desc' }],
  });
  return rows.map(mapRelationalMoToWipDto);
}

export async function getManufacturingOrderByIdDb(idOrNumber: string) {
  const prisma = getWipPrisma();
  const row = await prisma.manufacturingOrder.findFirst({
    where: { OR: [{ id: idOrNumber }, { moNumber: idOrNumber }] },
    include: MO_INCLUDE,
  });
  if (row) return mapRelationalMoToWipDto(row);

  const link = await prisma.wipManufacturingOrderLink.findUnique({
    where: { wipManufacturingOrderId: idOrNumber },
    select: { manufacturingOrderId: true },
  });
  if (!link) return null;
  const linkedRow = await prisma.manufacturingOrder.findUnique({
    where: { id: link.manufacturingOrderId },
    include: MO_INCLUDE,
  });
  return linkedRow ? mapRelationalMoToWipDto(linkedRow) : null;
}

export async function listWipTransfersDb() {
  const prisma = getWipPrisma();
  const rows = await prisma.productionTransfer.findMany({
    include: {
      manufacturingOrder: { select: { id: true, moNumber: true } },
      part: { select: { id: true, partNumber: true, name: true } },
      fromWarehouse: { select: { id: true, code: true, name: true } },
      toWarehouse: { select: { id: true, code: true, name: true } },
      fromLocation: { select: { id: true, code: true } },
      toLocation: { select: { id: true, code: true } },
    },
    orderBy: [{ dispatchedAt: 'desc' }],
    take: 500,
  });
  return rows.map(mapRelationalTransferToDto);
}

export async function listProductionActivityLogsDb() {
  const prisma = getWipPrisma();
  const rows = await prisma.productionActivityLog.findMany({
    include: {
      manufacturingOrder: {
        select: { partId: true, part: { select: { partNumber: true, name: true } } },
      },
    },
    orderBy: [{ timestamp: 'desc' }],
    take: 500,
  });
  return rows.map(mapRelationalActivityLogToDto);
}

export async function calculateMoReconciliationDb(moIdOrNumber: string): Promise<MoReconciliationReport | null> {
  const prisma = getWipPrisma();
  let moRow = await prisma.manufacturingOrder.findFirst({
    where: { OR: [{ id: moIdOrNumber }, { moNumber: moIdOrNumber }] },
    include: MO_INCLUDE,
  });
  if (!moRow) {
    const link = await prisma.wipManufacturingOrderLink.findUnique({
      where: { wipManufacturingOrderId: moIdOrNumber },
      select: { manufacturingOrderId: true },
    });
    if (link) {
      moRow = await prisma.manufacturingOrder.findUnique({
        where: { id: link.manufacturingOrderId },
        include: MO_INCLUDE,
      });
    }
  }
  if (!moRow) return null;

  const pendingTransfers = await prisma.productionTransfer.findMany({
    where: { manufacturingOrderId: moRow.id, status: 'DISPATCHED' },
  });
  return computeMoReconciliationFromRow(moRow, pendingTransfers);
}

export async function getWipDashboardMetricsDb(): Promise<WipDashboardMetrics> {
  const prisma = getWipPrisma();
  const [moRows, pendingTransfers] = await Promise.all([
    prisma.manufacturingOrder.findMany({ include: MO_INCLUDE }),
    prisma.productionTransfer.findMany({ where: { status: 'DISPATCHED' } }),
  ]);

  let totalWaitingQty = 0;
  let totalInProgressQty = 0;
  let totalReadyForTransferQty = 0;
  let totalCompletedQty = 0;
  let totalScrapQty = 0;
  let totalReworkQty = 0;
  let totalRejectedQty = 0;

  const opStatsMap = new Map<string, {
    operationName: string;
    stepCode: string;
    waitingQty: number;
    inProgressQty: number;
    readyQty: number;
    totalAgingHours: number;
    count: number;
  }>();

  const nowMs = Date.now();
  let allConserved = true;

  for (const mo of moRows) {
    totalCompletedQty += num(mo.completedQty);
    totalScrapQty += num(mo.scrapQty);
    totalReworkQty += num(mo.totalReworkQty);
    totalRejectedQty += num(mo.totalRejectedQty);

    const rec = computeMoReconciliationFromRow(mo, pendingTransfers);
    if (!rec.isConserved) allConserved = false;

    for (const op of mo.operations || []) {
      const wait = num(op.waitingInputQty);
      const prog = num(op.inProgressQty);
      const ready = num(op.readyForTransferQty);
      totalWaitingQty += wait;
      totalInProgressQty += prog;
      totalReadyForTransferQty += ready;

      const stepCode = op.stepCode || op.operation?.code || `OP${op.stepNumber}`;
      const stepName = op.stepName || op.operation?.name || '';
      const key = `${stepCode}_${stepName}`;
      const stat = opStatsMap.get(key) || {
        operationName: stepName,
        stepCode,
        waitingQty: 0,
        inProgressQty: 0,
        readyQty: 0,
        totalAgingHours: 0,
        count: 0,
      };
      stat.waitingQty += wait;
      stat.inProgressQty += prog;
      stat.readyQty += ready;
      const actTime = new Date(op.lastActivityAt || op.updatedAt || op.createdAt).getTime();
      stat.totalAgingHours += Math.max(0, (nowMs - actTime) / 3600000);
      stat.count += 1;
      opStatsMap.set(key, stat);
    }
  }

  const totalInTransitQty = pendingTransfers.reduce((sum: number, t: any) => sum + num(t.quantity), 0);
  const bottleneckOperations = Array.from(opStatsMap.values())
    .map(stat => ({
      operationName: stat.operationName,
      stepCode: stat.stepCode,
      waitingQty: stat.waitingQty,
      inProgressQty: stat.inProgressQty,
      readyQty: stat.readyQty,
      agingHoursAvg: stat.count > 0 ? Math.round((stat.totalAgingHours / stat.count) * 10) / 10 : 0,
    }))
    .sort((a, b) => (b.waitingQty + b.inProgressQty) - (a.waitingQty + a.inProgressQty));

  return {
    totalMoCount: moRows.length,
    activeMoCount: moRows.filter((m: any) => m.status === 'IN_PROGRESS' || m.status === 'RELEASED').length,
    totalWaitingQty,
    totalInProgressQty,
    totalReadyForTransferQty,
    totalInTransitQty,
    totalCompletedQty,
    totalScrapQty,
    totalReworkQty,
    totalRejectedQty,
    overallConservationIntegrity: allConserved,
    bottleneckOperations,
    pendingTransfersCount: pendingTransfers.length,
  };
}

export async function listAvailableMaterialSourcesDb() {
  const prisma = getWipPrisma();
  const rows = await prisma.stockBalance.findMany({
    where: {
      qualityStatus: 'AVAILABLE',
      quantityAvailable: { gt: 0 },
      warehouse: { active: true, type: { not: 'SCRAP' } },
      part: { active: true },
    },
    include: {
      part: { include: { unit: true } },
      warehouse: { select: { id: true, code: true, name: true, type: true } },
      location: { select: { id: true, code: true } },
      materialLot: { select: { id: true, lotNumber: true } },
      physicalCoil: { select: { id: true, coilId: true, coilPackNumber: true } },
    },
    orderBy: [{ part: { partNumber: 'asc' } }, { updatedAt: 'desc' }],
  });

  return rows.map((row: any) => ({
    id: row.id,
    partId: row.partId,
    partCode: row.part.partNumber,
    partName: row.part.name,
    partCategory: row.part.category,
    unitCode: row.part.unit.code,
    unitSymbol: row.part.unit.symbol,
    warehouseId: row.warehouseId,
    warehouseCode: row.warehouse.code,
    warehouseName: row.warehouse.name,
    warehouseType: row.warehouse.type,
    locationId: row.locationId,
    locationCode: row.location?.code || '',
    physicalCoilId: row.physicalCoilId,
    coilId: row.physicalCoil?.coilId || null,
    coilPackNumber: row.physicalCoil?.coilPackNumber || null,
    materialLotId: row.materialLotId,
    lotNumber: row.materialLot?.lotNumber || null,
    ownership: row.ownership,
    contractId: row.contractId,
    contractNumber: row.contractNumber,
    quantityAvailable: num(row.quantityAvailable),
    weightKgAvailable: num(row.weightKgAvailable),
  }));
}

export async function getDatabaseWipReportRowsDb(filters: { partId?: string; processType?: string; machineId?: string }) {
  const prisma = getWipPrisma();
  const orders = await prisma.manufacturingOrder.findMany({
    where: {
      status: { in: ['PLANNED', 'RELEASED', 'IN_PROGRESS', 'SUSPENDED'] },
      ...(filters.partId ? { OR: [{ partId: filters.partId }, { part: { is: { partNumber: filters.partId } } }] } : {}),
    },
    include: {
      part: { select: { id: true, partNumber: true, name: true } },
      operations: {
        where: {
          ...(filters.processType ? { operation: { is: { processType: filters.processType as any } } } : {}),
          ...(filters.machineId ? { plannedMachineId: filters.machineId } : {}),
        },
        include: {
          operation: { select: { code: true, name: true, processType: true } },
          plannedMachine: { select: { id: true, code: true, name: true, hallLocation: true } },
          location: { select: { id: true, code: true } },
          warehouse: { select: { id: true, code: true, name: true } },
          reports: { orderBy: { reportDate: 'desc' }, take: 1, select: { reportDate: true } },
        },
        orderBy: [{ sequence: 'asc' }, { stepNumber: 'asc' }],
      },
    },
    orderBy: [{ scheduledEndDate: 'asc' }, { priority: 'desc' }],
  });

  const rows: any[] = [];
  for (const order of orders) {
    for (const operation of order.operations) {
      const waitingInputQty = num(operation.waitingInputQty);
      const inProgressQty = num(operation.inProgressQty);
      const readyForTransferQty = num(operation.readyForTransferQty);
      const transferredQty = num(operation.transferredQty);
      const totalActiveWipQty = waitingInputQty + inProgressQty + readyForTransferQty;

      const lastActivityAt = (
        operation.lastActivityAt ||
        operation.reports[0]?.reportDate ||
        operation.startDate ||
        order.updatedAt
      ).toISOString();

      const warehouseLocation =
        operation.warehouseLocationCode ||
        operation.location?.code ||
        getLocationForProcess(operation.operation.processType, operation.stepNumber);

      if (totalActiveWipQty > 0 || transferredQty > 0) {
        rows.push({
          partId: order.part.id,
          partCode: order.part.partNumber,
          partName: order.part.name,
          moId: order.id,
          moNumber: order.moNumber,
          stepNumber: operation.stepNumber,
          stepCode: operation.stepCode || operation.operation.code,
          stepName: operation.stepName || operation.operation.name,
          processType: operation.operation.processType,
          machineId: operation.plannedMachineId,
          machineName: operation.plannedMachine?.name,
          warehouseLocation,
          waitingInputQty,
          inProgressQty,
          readyForTransferQty,
          transferredQty,
          totalActiveWipQty,
          lastActivityAt,
          dataBasis: 'POSTGRESQL_PRODUCTION_OPERATIONS_RELATIONAL',
        });
      }
    }
  }
  return rows;
}

export async function getWipPostingContextDb(moIdOrNumber: string) {
  const prisma = getWipPrisma();
  let targetOrder = await prisma.manufacturingOrder.findFirst({
    where: { OR: [{ id: moIdOrNumber }, { moNumber: moIdOrNumber }] },
    include: {
      part: { select: { id: true, partNumber: true, name: true } },
      operations: {
        include: {
          operation: { select: { processType: true, name: true } },
          plannedMachine: { select: { id: true, code: true, name: true } },
        },
        orderBy: [{ sequence: 'asc' }, { stepNumber: 'asc' }],
      },
    },
  });

  if (!targetOrder && moIdOrNumber) {
    const link = await prisma.wipManufacturingOrderLink.findUnique({
      where: { wipManufacturingOrderId: moIdOrNumber },
      select: { manufacturingOrderId: true },
    });
    if (link) {
      targetOrder = await prisma.manufacturingOrder.findUnique({
        where: { id: link.manufacturingOrderId },
        include: {
          part: { select: { id: true, partNumber: true, name: true } },
          operations: {
            include: {
              operation: { select: { processType: true, name: true } },
              plannedMachine: { select: { id: true, code: true, name: true } },
            },
            orderBy: [{ sequence: 'asc' }, { stepNumber: 'asc' }],
          },
        },
      });
    }
  }

  if (!targetOrder) return null;

  const [dbManufacturingOrders, dbShifts, dbUsers, dbMachines] = await Promise.all([
    prisma.manufacturingOrder.findMany({
      where: { partId: targetOrder.partId },
      include: {
        part: { select: { partNumber: true, name: true } },
        operations: {
          include: {
            operation: { select: { processType: true, name: true } },
            plannedMachine: { select: { id: true, code: true, name: true } },
          },
          orderBy: [{ sequence: 'asc' }, { stepNumber: 'asc' }],
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.shift.findMany({
      where: { active: true },
      select: { id: true, code: true, name: true, startTime: true, endTime: true },
      orderBy: { startTime: 'asc' },
    }),
    // Auth deferred: return all configured users even if active=false
    prisma.user.findMany({
      select: { id: true, username: true, fullName: true, personnelCode: true, active: true },
      orderBy: [{ active: 'desc' }, { fullName: 'asc' }],
    }),
    prisma.machine.findMany({
      where: { active: true, status: 'ACTIVE' },
      select: { id: true, code: true, name: true },
      orderBy: { code: 'asc' },
    }),
  ]);

  return {
    manufacturingOrders: dbManufacturingOrders,
    shifts: dbShifts,
    users: dbUsers,
    machines: dbMachines,
    identityLink: { manufacturingOrderId: targetOrder.id },
  };
}

/**
 * Syncs in-memory read mirrors strictly from PostgreSQL relational tables (never wip_state_snapshots or JSON).
 * Supports secondary synchronous read consumers (managementReportsEngine, oeeAndConsumablesEngine, mrpEngine).
 */
export async function syncWipReadCacheFromPostgres(): Promise<void> {
  if (testPrismaOverride || !isDatabaseUrlConfigured()) return;
  try {
    const [mos, transfers, logs] = await Promise.all([
      listManufacturingOrdersDb(),
      listWipTransfersDb(),
      listProductionActivityLogsDb(),
    ]);
    manufacturingOrdersStore.splice(0, manufacturingOrdersStore.length, ...mos);
    wipTransfersStore.splice(0, wipTransfersStore.length, ...transfers);
    productionLogsStore.splice(0, productionLogsStore.length, ...logs);
  } catch (err) {
    console.warn('[KPIMS WIP Cache Sync] Could not refresh WIP read mirrors from PostgreSQL:', err);
  }
}

/**
 * Resolves StockBalance rows at a given location strictly scoped to the quantities owned by `moId`
 * (and optionally a specific transfer's `documentId` for IN_TRANSIT stock) according to POSTED
 * InventoryTransaction ledger entries. Prevents cross-MO or cross-transfer stock/coil/lot theft.
 */
async function resolveMoScopedBalancesInTx(
  tx: any,
  args: {
    moId: string;
    partId: string;
    warehouseId: string;
    locationId: string | null;
    qualityStatus: string;
    documentId?: string | null;
  },
): Promise<Array<{ balance: any; allowedQty: number }>> {
  const rawBalances = await tx.stockBalance.findMany({
    where: {
      partId: args.partId,
      warehouseId: args.warehouseId,
      locationId: args.locationId,
      qualityStatus: args.qualityStatus,
      ...(args.qualityStatus === 'AVAILABLE'
        ? { quantityAvailable: { gt: 0 } }
        : { quantityOnHand: { gt: 0 } }),
    },
    orderBy: [{ contractNumber: 'asc' }, { id: 'asc' }],
  });

  if (rawBalances.length === 0) return [];

  const moLedgerRows = await tx.inventoryTransaction.findMany({
    where: {
      manufacturingOrderId: args.moId,
      partId: args.partId,
      warehouseId: args.warehouseId,
      locationId: args.locationId,
      qualityStatus: args.qualityStatus,
      postingStatus: 'POSTED',
      ...(args.documentId ? { documentId: args.documentId } : {}),
    },
    select: {
      partId: true,
      warehouseId: true,
      locationId: true,
      materialLotId: true,
      physicalCoilId: true,
      ownership: true,
      contractId: true,
      qualityStatus: true,
      quantitySigned: true,
    },
  });

  const moOwnedByKey = new Map<string, number>();
  for (const row of moLedgerRows) {
    const key = buildStockKey(row);
    moOwnedByKey.set(key, round6((moOwnedByKey.get(key) || 0) + num(row.quantitySigned)));
  }

  const scoped: Array<{ balance: any; allowedQty: number }> = [];
  for (const sb of rawBalances) {
    const key = buildStockKey(sb);
    const moOwned = round6(moOwnedByKey.get(key) || 0);
    if (moOwned <= 1e-9) continue;
    const sbAvail = args.qualityStatus === 'AVAILABLE' ? num(sb.quantityAvailable) : num(sb.quantityOnHand);
    const allowedQty = round6(Math.min(sbAvail, moOwned));
    if (allowedQty > 1e-9) {
      scoped.push({ balance: sb, allowedQty });
    }
  }
  return scoped;
}

async function decrementInTransitBalance(
  tx: any,
  args: { sb: any; take: number; takeWeight: number; now: Date },
): Promise<{ quantityAfter: number; weightAfter: number }> {
  const { sb, take, takeWeight, now } = args;
  const curQty = num(sb.quantityOnHand);
  const curWeight = num(sb.weightKgOnHand);
  if (curQty + 1e-6 < take || curWeight + 1e-5 < takeWeight) {
    throw new WipServiceError('موجودی در راه (IN_TRANSIT) برای تکمیل حواله کافی نیست یا هم‌زمان تغییر کرده است.', 409, true);
  }
  const rawNextQty = round6(curQty - take);
  const rawNextWeight = round6(curWeight - takeWeight);
  if (rawNextQty < -1e-6 || rawNextWeight < -1e-5) {
    throw new WipServiceError('کسر از موجودی در راه (IN_TRANSIT) منجر به مانده منفی می‌شود؛ عملیات لغو شد.', 409, true);
  }
  const safeNextQty = rawNextQty < 0 ? 0 : rawNextQty;
  const safeNextWeight = rawNextWeight < 0 ? 0 : rawNextWeight;

  const updated = await tx.stockBalance.updateMany({
    where: {
      id: sb.id,
      qualityStatus: 'IN_TRANSIT',
      quantityOnHand: { gte: Math.max(0, take - 1e-6) },
      weightKgOnHand: { gte: Math.max(0, takeWeight - 1e-5) },
    },
    data: {
      quantityOnHand: safeNextQty,
      weightKgOnHand: safeNextWeight,
      lastTransactionAt: now,
    },
  });
  if (updated.count !== 1) {
    throw new WipServiceError('موجودی در راه (IN_TRANSIT) هم‌زمان تغییر کرده است؛ لطفاً صفحه را تازه‌سازی کنید.', 409, true);
  }
  return { quantityAfter: safeNextQty, weightAfter: safeNextWeight };
}

async function adjustStockBalance(
  tx: any,
  args: {
    partId: string;
    warehouseId: string;
    locationId: string | null;
    materialLotId?: string | null;
    physicalCoilId?: string | null;
    ownership: string;
    contractId?: string | null;
    contractNumber?: string | null;
    qualityStatus: string;
    quantity: number;
    weightKg: number;
    direction: 1 | -1;
    now: Date;
  },
) {
  const {
    partId,
    warehouseId,
    locationId,
    materialLotId = null,
    physicalCoilId = null,
    ownership,
    contractId = null,
    contractNumber = null,
    qualityStatus,
    quantity,
    weightKg,
    direction,
    now,
  } = args;

  const existing = await tx.stockBalance.findFirst({
    where: {
      partId,
      warehouseId,
      locationId,
      materialLotId,
      physicalCoilId,
      ownership,
      contractId,
      qualityStatus,
    },
  });

  if (direction < 0) {
    if (
      !existing ||
      num(existing.quantityOnHand) + 1e-6 < quantity ||
      (qualityStatus === 'AVAILABLE' && num(existing.quantityAvailable) + 1e-6 < quantity) ||
      num(existing.weightKgOnHand) + 1e-5 < weightKg ||
      (qualityStatus === 'AVAILABLE' && num(existing.weightKgAvailable) + 1e-5 < weightKg)
    ) {
      throw new WipServiceError('موجودی آزاد در موقعیت مبدأ کافی نیست یا هم‌زمان تغییر کرده است.', 409, true);
    }
    const rawOnHand = round6(num(existing.quantityOnHand) - quantity);
    const rawAvail =
      qualityStatus === 'AVAILABLE'
        ? round6(num(existing.quantityAvailable) - quantity)
        : num(existing.quantityAvailable);
    const rawWeightOnHand = round6(num(existing.weightKgOnHand) - weightKg);
    const rawWeightAvail =
      qualityStatus === 'AVAILABLE'
        ? round6(num(existing.weightKgAvailable) - weightKg)
        : num(existing.weightKgAvailable);

    if (rawOnHand < -1e-6 || rawAvail < -1e-6 || rawWeightOnHand < -1e-5 || rawWeightAvail < -1e-5) {
      throw new WipServiceError('کسر موجودی منجر به مانده منفی در کاردکس می‌شود؛ عملیات لغو شد.', 409, true);
    }

    const nextOnHand = rawOnHand < 0 ? 0 : rawOnHand;
    const nextAvail = rawAvail < 0 ? 0 : rawAvail;
    const nextWeightOnHand = rawWeightOnHand < 0 ? 0 : rawWeightOnHand;
    const nextWeightAvail = rawWeightAvail < 0 ? 0 : rawWeightAvail;

    const updated = await tx.stockBalance.updateMany({
      where: {
        id: existing.id,
        ...(existing.version != null ? { version: existing.version } : {}),
        quantityOnHand: { gte: Math.max(0, quantity - 1e-6) },
        weightKgOnHand: { gte: Math.max(0, weightKg - 1e-5) },
        ...(qualityStatus === 'AVAILABLE'
          ? {
              quantityAvailable: { gte: Math.max(0, quantity - 1e-6) },
              weightKgAvailable: { gte: Math.max(0, weightKg - 1e-5) },
            }
          : {}),
      },
      data: {
        quantityOnHand: nextOnHand,
        quantityAvailable: nextAvail,
        weightKgOnHand: nextWeightOnHand,
        weightKgAvailable: nextWeightAvail,
        version: { increment: 1 },
        lastTransactionAt: now,
      },
    });
    if (updated.count !== 1) {
      throw new WipServiceError('موجودی مبدأ هم‌زمان تغییر کرده است؛ لطفاً صفحه را تازه‌سازی کنید.', 409, true);
    }
    return { quantityAfter: nextOnHand, weightAfter: nextWeightOnHand };
  }

  if (existing) {
    const nextOnHand = round6(num(existing.quantityOnHand) + quantity);
    const nextAvail =
      qualityStatus === 'AVAILABLE'
        ? round6(num(existing.quantityAvailable) + quantity)
        : num(existing.quantityAvailable);
    const nextWeightOnHand = round6(num(existing.weightKgOnHand) + weightKg);
    const nextWeightAvail =
      qualityStatus === 'AVAILABLE'
        ? round6(num(existing.weightKgAvailable) + weightKg)
        : num(existing.weightKgAvailable);

    const incRes = await tx.stockBalance.updateMany({
      where: {
        id: existing.id,
        ...(existing.version != null ? { version: existing.version } : {}),
      },
      data: {
        quantityOnHand: nextOnHand,
        quantityAvailable: nextAvail,
        weightKgOnHand: nextWeightOnHand,
        weightKgAvailable: nextWeightAvail,
        version: { increment: 1 },
        lastTransactionAt: now,
      },
    });
    if (incRes.count !== 1) {
      throw new WipServiceError('موجودی مقصد هم‌زمان تغییر کرده است؛ لطفاً صفحه را تازه‌سازی کنید.', 409, true);
    }
    return { quantityAfter: nextOnHand, weightAfter: nextWeightOnHand };
  }

  await tx.stockBalance.create({
    data: {
      partId,
      warehouseId,
      locationId,
      materialLotId,
      physicalCoilId,
      ownership,
      contractId,
      contractNumber,
      qualityStatus,
      quantityOnHand: quantity,
      quantityReserved: 0,
      quantityAvailable: qualityStatus === 'AVAILABLE' ? quantity : 0,
      weightKgOnHand: weightKg,
      weightKgReserved: 0,
      weightKgAvailable: qualityStatus === 'AVAILABLE' ? weightKg : 0,
      version: 1,
      lastTransactionAt: now,
    },
  });
  return { quantityAfter: quantity, weightAfter: weightKg };
}

/**
 * Helper to execute an initial or subsequent backed material load inside an active Serializable tx.
 */
async function performBackedMaterialLoadInTx(
  tx: any,
  args: {
    mo: any;
    targetOp: any;
    part: any;
    quantity: number;
    sourceStockBalanceId: string;
    sourceWeightKg?: number;
    operatorName: string;
    requestedUserId?: string;
    notes?: string;
    idempotencyKey?: string;
    requestFingerprint?: string;
    now: Date;
  },
) {
  const {
    mo,
    targetOp,
    part,
    quantity,
    sourceStockBalanceId,
    sourceWeightKg,
    operatorName,
    requestedUserId,
    notes,
    idempotencyKey,
    requestFingerprint,
    now,
  } = args;

  let source = await tx.stockBalance.findUnique({
    where: { id: sourceStockBalanceId },
    include: {
      part: { include: { unit: true } },
      warehouse: true,
      location: true,
      physicalCoil: true,
    },
  });
  if (!source) {
    throw new WipServiceError('ردیف موجودی مبدأ (sourceStockBalanceId) در پایگاه داده یافت نشد.', 404);
  }
  if (source.qualityStatus !== 'AVAILABLE') {
    throw new WipServiceError('فقط موجودی با وضعیت کیفی AVAILABLE قابل بارگذاری به خط تولید است.', 409);
  }

  const destLoc = targetOp.locationId
    ? await tx.warehouseLocation.findUnique({ where: { id: targetOp.locationId }, include: { warehouse: true } })
    : await resolveLocationByCodeOrId(
        tx,
        targetOp.warehouseLocationCode || getLocationForProcess(targetOp.operation.processType, targetOp.stepNumber),
      );
  if (!destLoc) {
    throw new WipServiceError('موقعیت انبار پای کار عملیات مقصد یافت نشد.', 400);
  }

  const postingUser = await resolvePostingUser(tx, requestedUserId);
  const isWeightBasedSource = source.part.unit.code === 'KG' && source.partId !== part.id;

  const unitGrossKg = num(part.weightGrossKg) > 0 ? num(part.weightGrossKg) : num(part.weightNetKg) > 0 ? num(part.weightNetKg) : 1;
  const unitNetKg = num(part.weightNetKg) > 0 ? num(part.weightNetKg) : unitGrossKg;

  const deductQty = isWeightBasedSource
    ? (sourceWeightKg && sourceWeightKg > 0 ? sourceWeightKg : round6(quantity * unitGrossKg))
    : quantity;
  const deductWeightKg = isWeightBasedSource
    ? deductQty
    : round6(quantity * (num(source.part.weightNetKg) > 0 ? num(source.part.weightNetKg) : unitNetKg));

  // Unlock MO-bound active reservations on this source material before free-balance check
  const unlockedRes = await consumeMoReservationsInTx(tx, {
    moId: mo.id,
    partId: source.partId,
    warehouseId: source.warehouseId,
    locationId: source.locationId || null,
    materialLotId: source.materialLotId || null,
    physicalCoilId: source.physicalCoilId || null,
    contractId: source.contractId || null,
    consumeQuantity: deductQty,
    consumeWeightKg: deductWeightKg,
    now,
  });
  if (unlockedRes.unlockedQty > 0) {
    source = await tx.stockBalance.findUnique({
      where: { id: sourceStockBalanceId },
      include: {
        part: { include: { unit: true } },
        warehouse: true,
        location: true,
        physicalCoil: true,
      },
    });
  }

  if (num(source.quantityAvailable) + 1e-6 < deductQty) {
    throw new WipServiceError(
      `موجودی آزاد در منبع انتخابی کافی نیست. موجودی آزاد: ${num(source.quantityAvailable)} ${source.part.unit.symbol}، مقدار درخواستی: ${deductQty}.`,
      409,
    );
  }
  if (isWeightBasedSource && num(source.weightKgAvailable) + 1e-6 < deductWeightKg) {
    throw new WipServiceError(
      `وزن آزاد در منبع انتخابی کافی نیست. وزن آزاد: ${num(source.weightKgAvailable)} kg، وزن مورد نیاز: ${deductWeightKg} kg.`,
      409,
    );
  }

  const safeDeductWeightKg = Math.min(num(source.weightKgAvailable), deductWeightKg);
  const srcAfter = await adjustStockBalance(tx, {
    partId: source.partId,
    warehouseId: source.warehouseId,
    locationId: source.locationId,
    materialLotId: source.materialLotId,
    physicalCoilId: source.physicalCoilId,
    ownership: source.ownership,
    contractId: source.contractId,
    contractNumber: source.contractNumber,
    qualityStatus: 'AVAILABLE',
    quantity: deductQty,
    weightKg: safeDeductWeightKg,
    direction: -1,
    now,
  });

  if (source.physicalCoilId) {
    const coilWhereGuard: Record<string, any> = {
      id: source.physicalCoilId,
      remainingWeightKg: { gte: safeDeductWeightKg },
      qualityStatus: 'AVAILABLE',
    };
    if (source.physicalCoil?.version != null) {
      coilWhereGuard.version = source.physicalCoil.version;
    }
    const coilRes = await tx.physicalCoil.updateMany({
      where: coilWhereGuard,
      data: {
        remainingWeightKg: { decrement: safeDeductWeightKg },
        physicalStatus: num(source.physicalCoil?.remainingWeightKg) - safeDeductWeightKg <= 0.001 ? 'CONSUMED' : 'PARTIALLY_ISSUED',
        version: { increment: 1 },
      },
    });
    if (coilRes.count !== 1) {
      throw new WipServiceError('مانده کویل انتخاب‌شده هم‌زمان تغییر کرده است.', 409, true);
    }
  }

  if (source.materialLotId) {
    const dbLot =
      typeof tx.materialLot?.findUnique === 'function'
        ? await tx.materialLot.findUnique({ where: { id: source.materialLotId } })
        : null;
    const nextLotWeight = dbLot ? Math.max(0, round6(num(dbLot.remainingWeightKg) - safeDeductWeightKg)) : 0;
    const nextLotStatus = dbLot
      ? nextLotWeight <= 1e-6
        ? 'CONSUMED'
        : source.physicalCoilId
          ? 'IN_USE'
          : dbLot.status
      : undefined;
    const lotRes = await tx.materialLot.updateMany({
      where: { id: source.materialLotId, remainingWeightKg: { gte: safeDeductWeightKg } },
      data: {
        remainingWeightKg: { decrement: safeDeductWeightKg },
        ...(nextLotStatus ? { status: nextLotStatus } : {}),
      },
    });
    if (lotRes.count !== 1) {
      throw new WipServiceError('مانده لات متریال انتخاب‌شده هم‌زمان تغییر کرده است.', 409, true);
    }
  }

  const wipCreditWeightKg = round6(quantity * unitNetKg);
  const destAfter = await adjustStockBalance(tx, {
    partId: part.id,
    warehouseId: destLoc.warehouseId,
    locationId: destLoc.id,
    materialLotId: source.materialLotId,
    physicalCoilId: source.physicalCoilId,
    ownership: source.ownership,
    contractId: source.contractId,
    contractNumber: source.contractNumber,
    qualityStatus: 'AVAILABLE',
    quantity,
    weightKg: wipCreditWeightKg,
    direction: 1,
    now,
  });

  const docNumber = `ISS-WIP-${Date.now()}-${randomUUID().slice(0, 5).toUpperCase()}`;
  const doc = await tx.inventoryDocument.create({
    data: {
      documentNumber: docNumber,
      documentType: 'ISSUE',
      documentDate: now,
      documentStatus: 'CONFIRMED',
      postingStatus: 'POSTED',
      warehouseId: source.warehouseId,
      targetWarehouseId: destLoc.warehouseId,
      referenceType: 'MANUFACTURING_ORDER',
      referenceNumber: mo.moNumber,
      createdByUserId: postingUser.id,
      postedByUserId: postingUser.id,
      postedAt: now,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(requestFingerprint ? { requestFingerprint } : {}),
      notes: notes || `حواله و بارگذاری مواد اولیه برای دستور ساخت ${mo.moNumber} (مرحله ${targetOp.stepNumber})`,
    },
  });

  const docLine = await tx.inventoryDocumentLine.create({
    data: {
      documentId: doc.id,
      lineNumber: 1,
      partId: source.partId,
      materialLotId: source.materialLotId,
      physicalCoilId: source.physicalCoilId,
      productionOperationId: targetOp.id,
      locationId: source.locationId,
      targetLocationId: destLoc.id,
      quantity: deductQty,
      unitId: source.part.unitId,
      weightKg: safeDeductWeightKg,
      ownership: source.ownership,
      contractId: source.contractId,
      contractNumber: source.contractNumber,
      qualityStatus: 'AVAILABLE',
      notes: notes || `بارگذاری به مرحله ${targetOp.stepNumber}`,
    },
  });

  if (source.physicalCoilId && typeof tx.coilIssueReturnRecord?.create === 'function') {
    await tx.coilIssueReturnRecord.create({
      data: {
        id: `CIR-WIP-${Date.now()}-${randomUUID().slice(0, 5).toUpperCase()}`,
        coilId: source.physicalCoilId,
        inventoryDocumentId: doc.id,
        contractId: source.contractId || null,
        partId: part.id,
        productionOperationId: targetOp.id,
        manufacturingOrderId: mo.id,
        documentNumber: docNumber,
        issuedWeightKg: safeDeductWeightKg,
        consumedWeightKg: 0,
        returnedWeightKg: 0,
        outstandingWeightKg: safeDeductWeightKg,
        varianceWeightKg: 0,
        status: safeDeductWeightKg <= 0.001 ? 'CONSUMED' : 'ISSUED',
        issuedAt: now,
        notes: notes || `حواله و بارگذاری مستقیم به دستور ساخت ${mo.moNumber} (مرحله ${targetOp.stepNumber})`,
      },
    });
  }

  await tx.inventoryTransaction.create({
    data: {
      transactionNumber: `${docNumber}-OUT`,
      documentId: doc.id,
      documentLineId: docLine.id,
      partId: source.partId,
      materialLotId: source.materialLotId,
      physicalCoilId: source.physicalCoilId,
      productionOperationId: targetOp.id,
      warehouseId: source.warehouseId,
      locationId: source.locationId,
      transactionType: 'OUTBOUND',
      quantity: deductQty,
      quantitySigned: -deductQty,
      unitId: source.part.unitId,
      weightKg: safeDeductWeightKg,
      weightKgSigned: -safeDeductWeightKg,
      ownership: source.ownership,
      contractId: source.contractId,
      contractNumber: source.contractNumber,
      qualityStatus: 'AVAILABLE',
      balanceAfter: srcAfter.quantityAfter,
      balanceKgAfter: srcAfter.weightAfter,
      transactionDate: now,
      postingStatus: 'POSTED',
      createdByUserId: postingUser.id,
      manufacturingOrderId: mo.id,
    },
  });

  await tx.inventoryTransaction.create({
    data: {
      transactionNumber: `${docNumber}-IN`,
      documentId: doc.id,
      documentLineId: docLine.id,
      partId: part.id,
      materialLotId: source.materialLotId,
      physicalCoilId: source.physicalCoilId,
      productionOperationId: targetOp.id,
      warehouseId: destLoc.warehouseId,
      locationId: destLoc.id,
      transactionType: 'INBOUND',
      quantity,
      quantitySigned: quantity,
      unitId: part.unitId,
      weightKg: wipCreditWeightKg,
      weightKgSigned: wipCreditWeightKg,
      ownership: source.ownership,
      contractId: source.contractId,
      contractNumber: source.contractNumber,
      qualityStatus: 'AVAILABLE',
      balanceAfter: destAfter.quantityAfter,
      balanceKgAfter: destAfter.weightAfter,
      transactionDate: now,
      postingStatus: 'POSTED',
      createdByUserId: postingUser.id,
      manufacturingOrderId: mo.id,
    },
  });

  const opCas = await tx.productionOperation.updateMany({
    where: { id: targetOp.id, version: targetOp.version },
    data: {
      waitingInputQty: { increment: quantity },
      status: targetOp.status === 'PENDING' || targetOp.status === 'COMPLETED' ? 'READY' : targetOp.status,
      lastActivityAt: now,
      version: { increment: 1 },
    },
  });
  if (opCas.count !== 1) {
    throw new WipServiceError('نسخه عملیات هدف هم‌زمان تغییر کرده است؛ بارگذاری مواد لغو شد.', 409, true);
  }

  const moCas = await tx.manufacturingOrder.updateMany({
    where: {
      id: mo.id,
      version: mo.version,
      status: { notIn: ['CANCELLED', 'CLOSED'] },
    },
    data: {
      initialInputQty: { increment: quantity },
      status: mo.status === 'PLANNED' ? 'RELEASED' : mo.status,
      version: { increment: 1 },
    },
  });
  if (moCas.count !== 1) {
    throw new WipServiceError('وضعیت یا نسخه دستور تولید هم‌زمان تغییر کرده است؛ بارگذاری مواد لغو شد.', 409, true);
  }

  await tx.productionActivityLog.create({
    data: {
      manufacturingOrderId: mo.id,
      moNumber: mo.moNumber,
      partId: part.id,
      productionOperationId: targetOp.id,
      stepNumber: targetOp.stepNumber,
      stepName: targetOp.stepName || targetOp.operation?.name || '',
      activityType: 'INPUT_LOAD',
      quantity,
      operatorName,
      timestamp: now,
      notes: notes || `بارگذاری از منبع ${source.part.partNumber} (${docNumber})`,
    },
  });

  return doc;
}

export async function createManufacturingOrderDb(params: {
  partId?: string;
  partCode?: string;
  routingId?: string;
  parentMoId?: string;
  parentMoNumber?: string;
  bomId?: string;
  targetQuantity: number;
  initialInputQuantity?: number;
  sourceStockBalanceId?: string;
  sourceWeightKg?: number;
  startDate?: string;
  dueDate?: string;
  notes?: string;
  createdBy?: string;
  createdByUserId?: string;
}) {
  const prisma = getWipPrisma();
  const targetQty = Number(params.targetQuantity);
  const initialInputQty = params.initialInputQuantity == null ? 0 : Number(params.initialInputQuantity);
  if (!Number.isFinite(targetQty) || targetQty <= 0) {
    throw new WipServiceError('تعداد هدف دستور تولید باید عددی مثبت باشد.', 400);
  }
  if (!Number.isFinite(initialInputQty) || initialInputQty < 0) {
    throw new WipServiceError('مقدار ورودی اولیه نمی‌تواند منفی باشد.', 400);
  }
  if (initialInputQty > 0 && !params.sourceStockBalanceId) {
    throw new WipServiceError(
      'ایجاد دستور تولید با موجودی ورودی غیرصفر بدون انتخاب منبع موجودی انبار (sourceStockBalanceId) مجاز نیست. مقدار ورودی را ۰ قرار دهید یا منبع موجودی را انتخاب کنید.',
      400,
    );
  }

  try {
    const createdMo = await prisma.$transaction(
      async (tx: any) => {
        const part = await tx.part.findFirst({
          where: {
            OR: [
              ...(params.partId ? [{ id: params.partId }] : []),
              ...(params.partCode ? [{ partNumber: params.partCode }] : []),
            ],
          },
          include: { unit: true },
        });
        if (!part) {
          throw new WipServiceError('قطعه انتخاب‌شده در پایگاه داده یافت نشد.', 404);
        }

        const route = await tx.partRoute.findFirst({
          where: params.routingId
            ? { id: params.routingId, partId: part.id }
            : { partId: part.id, status: 'ACTIVE' },
          include: {
            operations: {
              include: { operation: true, machine: true, die: true },
              orderBy: { stepNumber: 'asc' },
            },
          },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
        });
        if (!route || !route.operations.length) {
          throw new WipServiceError(
            `مسیر تولید فعال با عملیات مشخص برای قطعه «${part.partNumber}» در پایگاه داده یافت نشد.`,
            400,
          );
        }

        let resolvedParentMoId = params.parentMoId || null;
        if (resolvedParentMoId) {
          const parentMo = await tx.manufacturingOrder.findUnique({
            where: { id: resolvedParentMoId },
            select: { id: true, moNumber: true, status: true },
          });
          if (!parentMo) {
            throw new WipServiceError('دستور تولید والد انتخاب‌شده در پایگاه داده یافت نشد.', 404);
          }
          assertMoMutable(parentMo);
        } else if (params.parentMoNumber) {
          const parentMo = await tx.manufacturingOrder.findFirst({
            where: { OR: [{ moNumber: params.parentMoNumber }, { id: params.parentMoNumber }] },
            select: { id: true, moNumber: true, status: true },
          });
          if (parentMo) {
            assertMoMutable(parentMo);
            resolvedParentMoId = parentMo.id;
          }
        }

        const outputDest = await resolveOutputDestination(tx, null, part);
        const now = new Date();
        const moNumber = `MO-${now.getFullYear()}-${String(Date.now()).slice(-6)}-${randomUUID().slice(0, 3).toUpperCase()}`;
        const scheduledStartDate = params.startDate ? new Date(params.startDate) : now;
        const scheduledEndDate = params.dueDate ? new Date(params.dueDate) : new Date(now.getTime() + 7 * 86400_000);

        const opCreates = [];
        for (let idx = 0; idx < route.operations.length; idx += 1) {
          const rOp = route.operations[idx];
          const locCode = getLocationForProcess(rOp.operation.processType, rOp.stepNumber);
          const loc = await resolveLocationByCodeOrId(tx, locCode);
          opCreates.push({
            operationId: rOp.operationId,
            routeOperationId: rOp.id,
            stepNumber: rOp.stepNumber,
            sequence: idx + 1,
            stepCode: rOp.stepCode,
            stepName: rOp.stepName,
            plannedMachineId: rOp.machineId || null,
            plannedDieId: rOp.dieId || null,
            plannedQty: targetQty,
            waitingInputQty: 0,
            inProgressQty: 0,
            outputGoodQty: 0,
            outputScrapQty: 0,
            outputReworkQty: 0,
            outputRejectedQty: 0,
            readyForTransferQty: 0,
            transferredQty: 0,
            warehouseLocationCode: loc.code,
            warehouseId: loc.warehouseId,
            locationId: loc.id,
            standardCycleTimeSec: Number(rOp.standardCycleTimeSec || 0),
            scrapNormPercent: num(rOp.scrapNormPercent),
            status: idx === 0 ? 'READY' : 'PENDING',
            lastActivityAt: now,
          });
        }

        const mo = await tx.manufacturingOrder.create({
          data: {
            moNumber,
            partId: part.id,
            routeId: route.id,
            targetQty,
            initialInputQty: 0,
            completedQty: 0,
            scrapQty: 0,
            totalReworkQty: 0,
            totalRejectedQty: 0,
            parentMoId: resolvedParentMoId,
            bomId: params.bomId || null,
            outputWarehouseId: outputDest.warehouseId,
            outputLocationId: outputDest.id,
            scheduledStartDate,
            scheduledEndDate,
            priority: 1,
            status: 'RELEASED',
            notes: params.notes || null,
            createdByName: params.createdBy || 'مدیر برنامه‌ریزی تولید',
            operations: { create: opCreates },
          },
          include: MO_INCLUDE,
        });

        if (initialInputQty > 0 && params.sourceStockBalanceId) {
          const firstOp = mo.operations[0];
          await performBackedMaterialLoadInTx(tx, {
            mo,
            targetOp: firstOp,
            part,
            quantity: initialInputQty,
            sourceStockBalanceId: params.sourceStockBalanceId,
            sourceWeightKg: params.sourceWeightKg,
            operatorName: params.createdBy || 'انباردار خط تولید',
            requestedUserId: params.createdByUserId,
            notes: params.notes,
            now,
          });
        }

        return tx.manufacturingOrder.findUnique({ where: { id: mo.id }, include: MO_INCLUDE });
      },
      { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 },
    );

    await syncWipReadCacheFromPostgres();
    return mapRelationalMoToWipDto(createdMo);
  } catch (err) {
    wrapWipTxError(err);
  }
}

export async function createSubManufacturingOrdersBatchDb(params: {
  masterMoNumber?: string;
  bomId: string;
  bomAssemblyPartCode: string;
  startDate?: string;
  dueDate?: string;
  createdBy?: string;
  createdByUserId?: string;
  items: Array<{
    componentId?: string;
    partId?: string;
    partCode: string;
    partName?: string;
    routingId?: string;
    requiredQty: number;
    unit?: string;
    stageJoined?: number;
    sourceStockBalanceId?: string;
    sourceWeightKg?: number;
  }>;
}) {
  const prisma = getWipPrisma();
  if (!Array.isArray(params.items) || params.items.length === 0) {
    throw new WipServiceError('فهرست زیرقطعات برای صدور دستورات ساخت فرعی خالی است.', 400);
  }

  try {
    const createdRows = await prisma.$transaction(
      async (tx: any) => {
        const masterRef = String(params.masterMoNumber || '').trim();
        let parentMo: any = null;
        if (masterRef) {
          parentMo = await tx.manufacturingOrder.findFirst({
            where: { OR: [{ moNumber: masterRef }, { id: masterRef }] },
            select: { id: true, moNumber: true, status: true },
          });
          if (parentMo) {
            assertMoMutable(parentMo);
          }
        }

        const now = new Date();
        const scheduledStartDate = params.startDate ? new Date(params.startDate) : now;
        const scheduledEndDate = params.dueDate
          ? new Date(params.dueDate)
          : new Date(now.getTime() + 5 * 86400_000);

        const batchResults: Array<{
          item: (typeof params.items)[number];
          mo: any;
          routeVersion: string;
        }> = [];

        for (let i = 0; i < params.items.length; i += 1) {
          const item = params.items[i];
          const reqQty = Number(item.requiredQty);
          if (!Number.isFinite(reqQty) || reqQty <= 0) {
            throw new WipServiceError(
              `تیراژ مورد نیاز برای زیرقطعه «${item.partCode}» باید عددی بزرگ‌تر از صفر باشد.`,
              400,
            );
          }

          const part = await tx.part.findFirst({
            where: {
              OR: [
                ...(item.partId ? [{ id: item.partId }] : []),
                ...(item.partCode ? [{ partNumber: item.partCode }] : []),
              ],
            },
            include: { unit: true },
          });
          if (!part) {
            throw new WipServiceError(
              `زیرقطعه «${item.partCode}» در کاتالوگ مرکزی قطعات (PostgreSQL) یافت نشد.`,
              404,
            );
          }

          const route = await tx.partRoute.findFirst({
            where: item.routingId
              ? { id: item.routingId, partId: part.id }
              : { partId: part.id, status: 'ACTIVE' },
            include: {
              operations: {
                include: { operation: true, machine: true, die: true },
                orderBy: { stepNumber: 'asc' },
              },
            },
            orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
          });
          if (!route || !route.operations.length) {
            throw new WipServiceError(
              `مسیر تولید فعال با ایستگاه‌های عملیاتی برای زیرقطعه «${part.partNumber}» در پایگاه داده یافت نشد.`,
              400,
            );
          }

          const outputDest = await resolveOutputDestination(tx, null, part);
          const moNumber = `MO-${now.getFullYear()}-${String(Date.now()).slice(-6)}-${String(i + 1).padStart(2, '0')}-${randomUUID().slice(0, 3).toUpperCase()}`;

          const opCreates = [];
          for (let idx = 0; idx < route.operations.length; idx += 1) {
            const rOp = route.operations[idx];
            const locCode = getLocationForProcess(rOp.operation.processType, rOp.stepNumber);
            const loc = await resolveLocationByCodeOrId(tx, locCode);
            opCreates.push({
              operationId: rOp.operationId,
              routeOperationId: rOp.id,
              stepNumber: rOp.stepNumber,
              sequence: idx + 1,
              stepCode: rOp.stepCode,
              stepName: rOp.stepName,
              plannedMachineId: rOp.machineId || null,
              plannedDieId: rOp.dieId || null,
              plannedQty: reqQty,
              waitingInputQty: 0,
              inProgressQty: 0,
              outputGoodQty: 0,
              outputScrapQty: 0,
              outputReworkQty: 0,
              outputRejectedQty: 0,
              readyForTransferQty: 0,
              transferredQty: 0,
              warehouseLocationCode: loc.code,
              warehouseId: loc.warehouseId,
              locationId: loc.id,
              standardCycleTimeSec: Number(rOp.standardCycleTimeSec || 0),
              scrapNormPercent: num(rOp.scrapNormPercent),
              status: idx === 0 ? 'READY' : 'PENDING',
              lastActivityAt: now,
            });
          }

          const createdMo = await tx.manufacturingOrder.create({
            data: {
              moNumber,
              partId: part.id,
              routeId: route.id,
              targetQty: reqQty,
              initialInputQty: 0,
              completedQty: 0,
              scrapQty: 0,
              totalReworkQty: 0,
              totalRejectedQty: 0,
              parentMoId: parentMo?.id || null,
              bomId: params.bomId || null,
              outputWarehouseId: outputDest.warehouseId,
              outputLocationId: outputDest.id,
              scheduledStartDate,
              scheduledEndDate,
              priority: 1,
              status: 'RELEASED',
              notes: `دستور ساخت فرعی (Sub-MO) منشعب از BOM «${params.bomAssemblyPartCode}» و دستور کار اصلی ${masterRef || parentMo?.moNumber || '-'}`,
              createdByName: params.createdBy || 'موتور انفجار BOM (SAP PP)',
              operations: { create: opCreates },
            },
            include: MO_INCLUDE,
          });

          if (item.sourceStockBalanceId) {
            const firstOp = createdMo.operations[0];
            await performBackedMaterialLoadInTx(tx, {
              mo: createdMo,
              targetOp: firstOp,
              part,
              quantity: reqQty,
              sourceStockBalanceId: item.sourceStockBalanceId,
              sourceWeightKg: item.sourceWeightKg,
              operatorName: params.createdBy || 'موتور انفجار BOM (SAP PP)',
              requestedUserId: params.createdByUserId,
              notes: `بارگذاری اولیه خودکار Sub-MO ${moNumber}`,
              now,
            });
          }

          const hydrated = await tx.manufacturingOrder.findUnique({
            where: { id: createdMo.id },
            include: MO_INCLUDE,
          });
          batchResults.push({
            item,
            mo: hydrated,
            routeVersion: route.version || '1.0',
          });
        }

        return batchResults;
      },
      { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 },
    );

    await syncWipReadCacheFromPostgres();
    return createdRows.map((entry: any) => {
      const dto = mapRelationalMoToWipDto(entry.mo);
      return {
        moId: dto.id,
        subMoNumber: dto.moNumber,
        masterMoNumber: String(params.masterMoNumber || '').trim(),
        parentMoId: dto.parentMoId || null,
        componentPartCode: dto.partCode,
        componentPartName: dto.partName,
        requiredQty: entry.item.requiredQty,
        unit: entry.item.unit || entry.mo.part?.unit?.code || 'PCS',
        stageJoined: entry.item.stageJoined || 30,
        routingId: dto.routingId,
        routingVersion: entry.routeVersion,
        operationsCount: dto.operations.length,
        operations: dto.operations.map(op => ({
          stepNumber: op.stepNumber,
          stepCode: op.stepCode,
          stepName: op.stepName,
          machineName: op.machineName,
        })),
        status: dto.status,
        createdAt: dto.createdAt,
      };
    });
  } catch (err) {
    wrapWipTxError(err);
  }
}

export async function loadMaterialIntoMoDb(params: {
  moId: string;
  operationId?: string;
  quantity: number;
  sourceStockBalanceId?: string;
  sourceWeightKg?: number;
  operatorName?: string;
  createdByUserId?: string;
  notes?: string;
  expectedVersion?: number;
  idempotencyKey?: string;
}) {
  const prisma = getWipPrisma();
  const qty = Number(params.quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new WipServiceError('مقدار بارگذاری مواد باید عددی مثبت باشد.', 400);
  }
  if (!params.sourceStockBalanceId || !params.sourceStockBalanceId.trim()) {
    throw new WipServiceError(
      'برای بارگذاری مواد به دستور ساخت، انتخاب ردیف موجودی مبدأ از انبار (sourceStockBalanceId) الزامی است.',
      400,
    );
  }
  const cleanIdempotencyKey = params.idempotencyKey?.trim() || undefined;
  if (cleanIdempotencyKey && (cleanIdempotencyKey.length < 8 || cleanIdempotencyKey.length > 160)) {
    throw new WipServiceError('کلید یکتای بارگذاری مواد (idempotencyKey) باید بین ۸ تا ۱۶۰ کاراکتر باشد.', 400);
  }
  const requestFingerprint = cleanIdempotencyKey
    ? createHash('sha256')
        .update(
          JSON.stringify({
            op: 'MO_LOAD_MATERIAL',
            moId: params.moId,
            operationId: params.operationId || null,
            quantity: qty,
            sourceStockBalanceId: params.sourceStockBalanceId.trim(),
            sourceWeightKg: params.sourceWeightKg ?? null,
          }),
        )
        .digest('hex')
    : undefined;

  try {
    const updatedMo = await prisma.$transaction(
      async (tx: any) => {
        if (cleanIdempotencyKey) {
          const existingByKey = await tx.inventoryDocument.findUnique({
            where: { idempotencyKey: cleanIdempotencyKey },
          });
          if (existingByKey) {
            if (existingByKey.requestFingerprint && existingByKey.requestFingerprint !== requestFingerprint) {
              throw new WipServiceError(
                `کلید یکتای بارگذاری «${cleanIdempotencyKey}» قبلاً با اطلاعات متفاوتی استفاده شده است.`,
                409,
                true,
              );
            }
            const replayMo = await tx.manufacturingOrder.findFirst({
              where: {
                OR: [
                  { id: params.moId },
                  { moNumber: params.moId },
                  ...(existingByKey.referenceNumber ? [{ moNumber: existingByKey.referenceNumber }] : []),
                ],
              },
              include: MO_INCLUDE,
            });
            if (replayMo) return replayMo;
          }
        }

        let mo = await tx.manufacturingOrder.findFirst({
          where: { OR: [{ id: params.moId }, { moNumber: params.moId }] },
          include: MO_INCLUDE,
        });
        if (!mo) {
          const link = await tx.wipManufacturingOrderLink.findUnique({
            where: { wipManufacturingOrderId: params.moId },
            select: { manufacturingOrderId: true },
          });
          if (link) {
            mo = await tx.manufacturingOrder.findUnique({
              where: { id: link.manufacturingOrderId },
              include: MO_INCLUDE,
            });
          }
        }
        if (!mo) throw new WipServiceError('دستور تولید مورد نظر یافت نشد.', 404);
        assertMoMutable(mo);

        if (params.expectedVersion != null && mo.version !== params.expectedVersion) {
          throw new WipServiceError('نسخه دستور تولید هم‌زمان تغییر کرده است؛ اطلاعات را تازه‌سازی کنید.', 409, true);
        }

        const ops = [...mo.operations].sort(
          (a: any, b: any) => (a.sequence ?? a.stepNumber) - (b.sequence ?? b.stepNumber) || a.stepNumber - b.stepNumber,
        );
        const targetOp = params.operationId
          ? ops.find((o: any) => o.id === params.operationId)
          : ops[0];
        if (!targetOp) throw new WipServiceError('مرحله عملیاتی هدف در دستور تولید یافت نشد.', 404);

        await performBackedMaterialLoadInTx(tx, {
          mo,
          targetOp,
          part: mo.part,
          quantity: qty,
          sourceStockBalanceId: params.sourceStockBalanceId!.trim(),
          sourceWeightKg: params.sourceWeightKg,
          operatorName: params.operatorName || 'انباردار رول و ورق',
          requestedUserId: params.createdByUserId,
          notes: params.notes,
          idempotencyKey: cleanIdempotencyKey,
          requestFingerprint,
          now: new Date(),
        });

        return tx.manufacturingOrder.findUnique({ where: { id: mo.id }, include: MO_INCLUDE });
      },
      { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 },
    );

    await syncWipReadCacheFromPostgres();
    return mapRelationalMoToWipDto(updatedMo);
  } catch (err) {
    wrapWipTxError(err);
  }
}

export async function registerOperationInputDb(params: {
  moId: string;
  operationId: string;
  quantity: number;
  operatorName?: string;
  machineId?: string;
  notes?: string;
  expectedVersion?: number;
}) {
  const prisma = getWipPrisma();
  const qty = Number(params.quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new WipServiceError('مقدار ورودی باید عددی بزرگتر از صفر باشد.', 400);
  }

  try {
    const updatedMo = await prisma.$transaction(
      async (tx: any) => {
        const mo = await tx.manufacturingOrder.findFirst({
          where: { OR: [{ id: params.moId }, { moNumber: params.moId }] },
          include: MO_INCLUDE,
        });
        if (!mo) throw new WipServiceError('دستور تولید یافت نشد.', 404);
        assertMoMutable(mo);

        const op = mo.operations.find((o: any) => o.id === params.operationId);
        if (!op) throw new WipServiceError('مرحله عملیاتی یافت نشد.', 404);

        if (params.expectedVersion != null && op.version !== params.expectedVersion) {
          throw new WipServiceError('وضعیت این مرحله هم‌زمان تغییر کرده است؛ اطلاعات را تازه‌سازی کنید.', 409, true);
        }
        if (op.status === 'COMPLETED' || op.status === 'SKIPPED') {
          throw new WipServiceError('این مرحله قبلاً تکمیل یا رد شده است.', 409);
        }
        if (await isOperationPausedInTx(tx, op.id)) {
          throw new WipServiceError('این عملیات در وضعیت توقف (PAUSED) قرار دارد؛ ابتدا عملیات را از سر بگیرید.', 409);
        }

        const waitQty = num(op.waitingInputQty);
        if (qty > waitQty + 1e-6) {
          throw new WipServiceError(
            `موجودی در انتظار برای شروع پردازش کافی نیست. موجودی در انتظار: ${waitQty}، مقدار درخواستی: ${qty}`,
            400,
          );
        }

        const now = new Date();
        const opUpdate = await tx.productionOperation.updateMany({
          where: {
            id: op.id,
            version: op.version,
            waitingInputQty: { gte: qty },
          },
          data: {
            waitingInputQty: { decrement: qty },
            inProgressQty: { increment: qty },
            inputQty: { increment: qty },
            status: 'IN_PROGRESS',
            startDate: op.startDate || now,
            lastActivityAt: now,
            ...(params.machineId ? { plannedMachineId: params.machineId } : {}),
            version: { increment: 1 },
          },
        });
        if (opUpdate.count !== 1) {
          throw new WipServiceError('تداخل هم‌زمانی در ثبت ورودی ایستگاه رخ داد؛ دوباره تلاش کنید.', 409, true);
        }

        const moCas = await tx.manufacturingOrder.updateMany({
          where: {
            id: mo.id,
            version: mo.version,
            status: { notIn: ['CANCELLED', 'CLOSED'] },
          },
          data: {
            status: 'IN_PROGRESS',
            actualStartDate: mo.actualStartDate || now,
            version: { increment: 1 },
          },
        });
        if (moCas.count !== 1) {
          throw new WipServiceError('وضعیت یا نسخه دستور تولید هم‌زمان تغییر کرده است؛ دوباره تلاش کنید.', 409, true);
        }

        await tx.productionActivityLog.create({
          data: {
            manufacturingOrderId: mo.id,
            moNumber: mo.moNumber,
            partId: mo.partId,
            productionOperationId: op.id,
            stepNumber: op.stepNumber,
            stepName: op.stepName || op.operation?.name || '',
            activityType: 'INPUT_LOAD',
            quantity: qty,
            operatorName: params.operatorName || 'اپراتور شیفت جاری',
            machineId: params.machineId || op.plannedMachineId || null,
            timestamp: now,
            notes: params.notes || null,
          },
        });

        return tx.manufacturingOrder.findUnique({ where: { id: mo.id }, include: MO_INCLUDE });
      },
      { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 },
    );

    await syncWipReadCacheFromPostgres();
    return mapRelationalMoToWipDto(updatedMo);
  } catch (err) {
    wrapWipTxError(err);
  }
}

export async function postWipProductionDb(input: {
  moId: string;
  operationId: string;
  idempotencyKey: string;
  relationalManufacturingOrderId?: string;
  relationalMachineId?: string;
  machineId?: string;
  shiftId: string;
  createdByUserId?: string;
  operatorUserId?: string;
  reportDate?: string;
  notes?: string;
  goodQty: number;
  scrapQty: number;
  reworkQty?: number;
  rejectedQty?: number;
  scrapReason?: string;
  operatorName?: string;
  runTimeMinutes?: number;
  downtimeMinutes?: number;
  downtimeReason?: string;
  strokeCounterStart?: number;
  strokeCounterEnd?: number;
  actualMaterialConsumedKg?: number;
  allowOverproduction?: boolean;
  autoCompleteOperation?: boolean;
  expectedVersion?: number;
}) {
  const prisma = getWipPrisma();
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 160) {
    throw new WipServiceError('کلید یکتای ثبت (idempotencyKey) با طول ۸ تا ۱۶۰ کاراکتر الزامی است.', 400);
  }

  const goodQty = Number(input.goodQty ?? 0);
  const scrapQty = Number(input.scrapQty ?? 0);
  const reworkQty = Number(input.reworkQty ?? 0);
  const rejectedQty = Number(input.rejectedQty ?? 0);
  for (const [lbl, val] of [
    ['goodQty', goodQty],
    ['scrapQty', scrapQty],
    ['reworkQty', reworkQty],
    ['rejectedQty', rejectedQty],
  ] as const) {
    if (!Number.isFinite(val) || val < 0) {
      throw new WipServiceError(`${lbl} باید عددی غیرمنفی و معتبر باشد.`, 400);
    }
  }
  const totalReported = round6(goodQty + scrapQty + reworkQty + rejectedQty);
  if (totalReported <= 0) {
    throw new WipServiceError('حداقل یکی از مقادیر تولید سالم، ضایعات، دوباره‌کاری یا مردودی باید بزرگتر از صفر باشد.', 400);
  }
  if (scrapQty > 0 && (!input.scrapReason || !input.scrapReason.trim())) {
    throw new WipServiceError('در صورت وجود ضایعات، انتخاب علت ضایعات الزامی است.', 400);
  }

  const runTimeMinutes = input.runTimeMinutes != null ? Number(input.runTimeMinutes) : 0;
  const downtimeMinutes = input.downtimeMinutes != null ? Number(input.downtimeMinutes) : 0;
  if (!Number.isFinite(runTimeMinutes) || runTimeMinutes < 0) {
    throw new WipServiceError('مدت کارکرد (runTimeMinutes) باید عددی غیرمنفی باشد.', 400);
  }
  if (!Number.isFinite(downtimeMinutes) || downtimeMinutes < 0) {
    throw new WipServiceError('مدت توقف (downtimeMinutes) باید عددی غیرمنفی باشد.', 400);
  }
  const downtimeReasonTrimmed = input.downtimeReason ? input.downtimeReason.trim() : '';
  if (downtimeMinutes > 0 && !downtimeReasonTrimmed) {
    throw new WipServiceError('در صورت ثبت زمان توقف، درج علت توقف الزامی است.', 400);
  }

  const strokeCounterStart =
    input.strokeCounterStart != null && input.strokeCounterStart !== ('' as any)
      ? Number(input.strokeCounterStart)
      : null;
  const strokeCounterEnd =
    input.strokeCounterEnd != null && input.strokeCounterEnd !== ('' as any)
      ? Number(input.strokeCounterEnd)
      : null;
  if (strokeCounterStart != null && (!Number.isFinite(strokeCounterStart) || strokeCounterStart < 0)) {
    throw new WipServiceError('شمارنده ضرب شروع باید عددی غیرمنفی باشد.', 400);
  }
  if (strokeCounterEnd != null && (!Number.isFinite(strokeCounterEnd) || strokeCounterEnd < 0)) {
    throw new WipServiceError('شمارنده ضرب پایان باید عددی غیرمنفی باشد.', 400);
  }
  if (strokeCounterStart != null && strokeCounterEnd != null && strokeCounterEnd < strokeCounterStart) {
    throw new WipServiceError('شمارنده ضرب پایان نمی‌تواند از شمارنده ضرب شروع کمتر باشد.', 400);
  }

  const actualMaterialConsumedKg =
    input.actualMaterialConsumedKg != null && input.actualMaterialConsumedKg !== ('' as any)
      ? Number(input.actualMaterialConsumedKg)
      : null;
  if (actualMaterialConsumedKg != null && (!Number.isFinite(actualMaterialConsumedKg) || actualMaterialConsumedKg < 0)) {
    throw new WipServiceError('مقدار مصرف واقعی مواد اولیه باید عددی غیرمنفی باشد.', 400);
  }

  const runTimeInt = Math.round(runTimeMinutes);
  const downtimeInt = Math.round(downtimeMinutes);

  try {
    const result = await prisma.$transaction(
      async (tx: any) => {
        const existingReport = await tx.productionReport.findUnique({
          where: { wipIdempotencyKey: idempotencyKey },
          select: {
            id: true,
            reportNumber: true,
            manufacturingOrderId: true,
            productionOperationId: true,
            machineId: true,
            shiftId: true,
            operatorUserId: true,
            goodQuantity: true,
            scrapQuantity: true,
            reworkQuantity: true,
            rejectedQuantity: true,
            scrapReasonText: true,
            runTimeMinutes: true,
            downtimeMinutes: true,
            downtimeReason: true,
            strokeCounterStart: true,
            strokeCounterEnd: true,
            reportDate: true,
          },
        });
        if (existingReport) {
          let payloadConflict =
            (input.operationId &&
              existingReport.productionOperationId &&
              existingReport.productionOperationId !== input.operationId) ||
            Math.abs(num(existingReport.goodQuantity) - goodQty) > 1e-6 ||
            Math.abs(num(existingReport.scrapQuantity) - scrapQty) > 1e-6 ||
            Math.abs(num(existingReport.reworkQuantity) - reworkQty) > 1e-6 ||
            Math.abs(num(existingReport.rejectedQuantity) - rejectedQty) > 1e-6 ||
            (input.runTimeMinutes != null && Number(existingReport.runTimeMinutes || 0) !== runTimeInt) ||
            (input.downtimeMinutes != null && Number(existingReport.downtimeMinutes || 0) !== downtimeInt) ||
            (input.downtimeReason != null && (existingReport.downtimeReason || '') !== downtimeReasonTrimmed);

          if (!payloadConflict && typeof tx.auditLog?.findFirst === 'function') {
            const auditRow = await tx.auditLog.findFirst({
              where: {
                entityName: 'ProductionReport',
                entityId: existingReport.id,
                action: 'SHOP_FLOOR_PRODUCTION_REPORT',
              },
            });
            const priorConsumed = auditRow?.newValues?.actualMaterialConsumedKg;
            if (priorConsumed != null || actualMaterialConsumedKg != null) {
              if (
                priorConsumed == null ||
                actualMaterialConsumedKg == null ||
                Math.abs(num(priorConsumed) - actualMaterialConsumedKg) > 1e-4
              ) {
                payloadConflict = true;
              }
            }
          }

          if (payloadConflict) {
            throw new WipServiceError(
              'کلید یکتای ثبت (idempotencyKey) قبلاً با مقادیر متفاوتی استفاده شده است.',
              409,
              true,
            );
          }

          const currentMo = await tx.manufacturingOrder.findUnique({
            where: { id: existingReport.manufacturingOrderId },
            include: MO_INCLUDE,
          });
          return { duplicate: true, report: existingReport, transactionCount: 0, mo: currentMo };
        }

        // Resolve MO natively or via identity bridge link
        let mo: any = null;
        if (input.relationalManufacturingOrderId) {
          mo = await tx.manufacturingOrder.findUnique({
            where: { id: input.relationalManufacturingOrderId },
            include: MO_INCLUDE,
          });
        }
        if (!mo) {
          mo = await tx.manufacturingOrder.findFirst({
            where: { OR: [{ id: input.moId }, { moNumber: input.moId }] },
            include: MO_INCLUDE,
          });
        }
        if (!mo) {
          const link = await tx.wipManufacturingOrderLink.findUnique({
            where: { wipManufacturingOrderId: input.moId },
            select: { manufacturingOrderId: true },
          });
          if (link) {
            mo = await tx.manufacturingOrder.findUnique({
              where: { id: link.manufacturingOrderId },
              include: MO_INCLUDE,
            });
          }
        }
        if (!mo) {
          throw new WipServiceError('دستور ساخت در پایگاه داده یافت نشد.', 404);
        }
        assertMoMutable(mo);

        // Resolve Operation natively or via operation link
        let op = mo.operations.find((o: any) => o.id === input.operationId);
        if (!op) {
          const opLink = await tx.wipOperationLink.findUnique({
            where: { wipOperationId: input.operationId },
            select: { productionOperationId: true },
          });
          if (opLink) {
            op = mo.operations.find((o: any) => o.id === opLink.productionOperationId);
          }
        }
        if (!op) {
          throw new WipServiceError('مرحله عملیاتی در دستور ساخت یافت نشد.', 404);
        }

        if (input.expectedVersion != null && op.version !== input.expectedVersion) {
          throw new WipServiceError(
            'وضعیت این مرحله هم‌زمان توسط کاربر یا فرآیند دیگری تغییر کرده است؛ لطفاً اطلاعات را تازه‌سازی کنید.',
            409,
            true,
          );
        }

        if (op.status === 'COMPLETED' || op.status === 'SKIPPED') {
          throw new WipServiceError('این مرحله قبلاً تکمیل یا رد شده است و امکان ثبت گزارش جدید وجود ندارد.', 409);
        }
        if (await isOperationPausedInTx(tx, op.id)) {
          throw new WipServiceError(
            'این عملیات در وضعیت توقف (PAUSED) قرار دارد؛ قبل از ثبت تولید باید عملیات از سر گرفته شود.',
            409,
          );
        }

        const inProgress = num(op.inProgressQty);
        const waitingInput = num(op.waitingInputQty);
        const availableStationQty = round6(inProgress + waitingInput);
        if (op.status === 'PENDING' && availableStationQty <= 0) {
          throw new WipServiceError(
            'عملیات هنوز آماده یا شروع نشده و موجودی در صف/پای دستگاه ندارد (قفل توالی مراحل).',
            409,
          );
        }
        if (
          !input.allowOverproduction &&
          num(op.plannedQty) > 0 &&
          round6(num(op.outputGoodQty) + goodQty) > num(op.plannedQty) + 1e-6
        ) {
          throw new WipServiceError(
            `تولید بیش از سقف برنامه‌ریزی‌شده مجاز نیست (سقف برنامه: ${num(op.plannedQty)}، تولید قبلی: ${num(op.outputGoodQty)}، اعلام فعلی: ${goodQty}).`,
            409,
          );
        }
        if (totalReported > availableStationQty + 1e-6) {
          throw new WipServiceError(
            `مجموع قطعات اعلامی (${totalReported}) از مجموع موجودی قابل پردازش ایستگاه (پای دستگاه ${inProgress} + صف ورودی ${waitingInput} = ${availableStationQty}) بیشتر است.`,
            400,
          );
        }

        const autoConsumeFromWaiting = Math.max(0, round6(totalReported - inProgress));
        const consumeFromInProgress = round6(totalReported - autoConsumeFromWaiting);

        const effectiveMachineId = input.relationalMachineId || input.machineId || op.plannedMachineId;
        if (!effectiveMachineId) {
          throw new WipServiceError('انتخاب ماشین فعال برای ثبت گزارش تولید الزامی است.', 400);
        }
        const machine = await tx.machine.findUnique({ where: { id: effectiveMachineId } });
        if (!machine || !machine.active || machine.status !== 'ACTIVE') {
          throw new WipServiceError('ماشین انتخاب‌شده معتبر یا در وضعیت فعال (ACTIVE) نیست.', 400);
        }
        await assertMachineEligibleForOpInTx(tx, { machine, op, part: mo.part });

        const shift = await tx.shift.findUnique({ where: { id: input.shiftId } });
        if (!shift || !shift.active) {
          throw new WipServiceError('شیفت تولید انتخاب‌شده معتبر یا فعال نیست.', 400);
        }

        const postingUser = await resolvePostingUser(tx, input.operatorUserId || input.createdByUserId);
        const reportDate = input.reportDate ? new Date(input.reportDate) : new Date();
        if (Number.isNaN(reportDate.getTime())) {
          throw new WipServiceError('تاریخ گزارش نامعتبر است.', 400);
        }

        const opsSorted = [...mo.operations].sort(
          (a: any, b: any) => (a.sequence ?? a.stepNumber) - (b.sequence ?? b.stepNumber) || a.stepNumber - b.stepNumber,
        );
        const opIndex = opsSorted.findIndex((o: any) => o.id === op.id);
        const nextOp = opIndex >= 0 && opIndex + 1 < opsSorted.length ? opsSorted[opIndex + 1] : null;

        const sourceLocation = op.locationId
          ? await tx.warehouseLocation.findUnique({ where: { id: op.locationId }, include: { warehouse: true } })
          : await resolveLocationByCodeOrId(
              tx,
              op.warehouseLocationCode || getLocationForProcess(op.operation.processType, op.stepNumber),
            );
        if (!sourceLocation) {
          throw new WipServiceError('موقعیت انبار مبدأ عملیات یافت نشد.', 400);
        }

        const targetLocation = nextOp
          ? nextOp.locationId
            ? await tx.warehouseLocation.findUnique({ where: { id: nextOp.locationId }, include: { warehouse: true } })
            : await resolveLocationByCodeOrId(
                tx,
                nextOp.warehouseLocationCode || getLocationForProcess(nextOp.operation.processType, nextOp.stepNumber),
              )
          : await resolveOutputDestination(tx, mo, mo.part);

        if (!targetLocation) {
          throw new WipServiceError('موقعیت انبار مقصد یافت نشد.', 400);
        }

        const scrapWarehouse = scrapQty > 0
          ? await tx.warehouse.findFirst({
              where: { type: 'SCRAP', active: true },
              include: { locations: { where: { active: true }, orderBy: { code: 'asc' }, take: 1 } },
              orderBy: { code: 'asc' },
            })
          : null;
        if (scrapQty > 0 && (!scrapWarehouse || !scrapWarehouse.locations?.[0])) {
          throw new WipServiceError('یک انبار فعال از نوع SCRAP با حداقل یک موقعیت فعال برای ثبت ضایعات لازم است.', 400);
        }
        const scrapLocation = scrapWarehouse?.locations?.[0] || null;

        // Check MO-scoped AVAILABLE stock balances before committing anything (prevents cross-MO theft)
        const part = mo.part;
        const unitId = part.unitId;
        const unitWeightKg = num(part.weightNetKg);

        const scopedSources = await resolveMoScopedBalancesInTx(tx, {
          moId: mo.id,
          partId: part.id,
          warehouseId: sourceLocation.warehouseId,
          locationId: sourceLocation.id,
          qualityStatus: 'AVAILABLE',
        });
        const availableStockQty = scopedSources.reduce((sum: number, item) => sum + item.allowedQty, 0);
        if (availableStockQty + 1e-6 < totalReported) {
          throw new WipServiceError(
            `موجودی کاردکس متعلق به دستور ساخت ${mo.moNumber} در موقعیت ${sourceLocation.code} (${availableStockQty}) از مقدار اعلام‌شده (${totalReported}) کمتر است؛ هیچ تراکنشی ثبت نشد.`,
            409,
          );
        }

        // Update Die strokes if linked
        let diePmNotice = '';
        const targetDieId = op.plannedDieId;
        const die = targetDieId
          ? await tx.die.findUnique({ where: { id: targetDieId } })
          : await tx.die.findFirst({ where: { partId: part.id, active: true }, orderBy: { code: 'asc' } });
        if (die) {
          const nextStrokes = Number(die.currentStrokes || 0) + Math.round(totalReported);
          const reachedTarget = die.totalStrokeTarget > 0 && nextStrokes >= die.totalStrokeTarget;
          await tx.die.update({
            where: { id: die.id },
            data: {
              currentStrokes: nextStrokes,
              ...(reachedTarget ? { status: 'MAINTENANCE' } : {}),
            },
          });
          if (reachedTarget) {
            diePmNotice = ` [هشدار PM قالب ${die.code}: ضربه فعلی ${nextStrokes} به حد نصاب سرویس رسید]`;
          }
        }

        // Validate explicit actualMaterialConsumedKg BEFORE committing report/ledger mutations
        let preloadedOpenIssues: any[] | null = null;
        if (typeof tx.coilIssueReturnRecord?.findMany === 'function') {
          const allMoIssues = await tx.coilIssueReturnRecord.findMany({
            where: {
              manufacturingOrderId: mo.id,
              issuedWeightKg: { gt: 0 },
            },
            orderBy: [{ issuedAt: 'asc' }, { createdAt: 'asc' }],
          });
          const openIssues = (allMoIssues || []).filter((rec: any) => num(rec.outstandingWeightKg) > 1e-6);
          const eligibleOpIssues = openIssues.filter(
            (rec: any) => rec.productionOperationId === op.id || (!rec.productionOperationId && opIndex === 0),
          );
          preloadedOpenIssues = eligibleOpIssues;

          if (actualMaterialConsumedKg != null && actualMaterialConsumedKg > 0) {
            if ((allMoIssues || []).length > 0 && eligibleOpIssues.length === 0) {
              if (opIndex > 0) {
                throw new WipServiceError(
                  'ثبت مصرف مستقیم ماده اولیه (کویل/ورق) فقط در عملیاتی مجاز است که ماده اولیه به آن صادر شده باشد.',
                  409,
                );
              }
              throw new WipServiceError(
                'مانده کویل تحویل‌شده برای این دستور ساخت به اتمام رسیده است؛ امکان ثبت مصرف بیش از موجودی وجود ندارد.',
                409,
              );
            }
            if (eligibleOpIssues.length > 0) {
              const totalOutstandingKg = round6(
                eligibleOpIssues.reduce((s: number, r: any) => s + num(r.outstandingWeightKg), 0),
              );
              if (actualMaterialConsumedKg > totalOutstandingKg + 1e-4) {
                throw new WipServiceError(
                  `مصرف واقعی ماده اولیه (${actualMaterialConsumedKg} کیلوگرم) از مانده تحویل‌شده پای خط (${totalOutstandingKg} کیلوگرم) بیشتر است.`,
                  409,
                );
              }
            }
          }
        }

        const reportNumber = `PR-WIP-${Date.now()}-${randomUUID().slice(0, 6).toUpperCase()}`;
        const report = await tx.productionReport.create({
          data: {
            reportNumber,
            manufacturingOrderId: mo.id,
            productionOperationId: op.id,
            machineId: effectiveMachineId,
            dieId: die?.id || null,
            shiftId: shift.id,
            operatorUserId: postingUser.id,
            reportDate,
            strokeCounterStart: strokeCounterStart != null ? Math.round(strokeCounterStart) : null,
            strokeCounterEnd: strokeCounterEnd != null ? Math.round(strokeCounterEnd) : null,
            goodQuantity: goodQty,
            scrapQuantity: scrapQty,
            reworkQuantity: reworkQty,
            rejectedQuantity: rejectedQty,
            scrapReasonText: input.scrapReason || null,
            runTimeMinutes: runTimeInt,
            downtimeMinutes: downtimeInt,
            downtimeReason: downtimeReasonTrimmed || null,
            notes: input.notes || null,
            documentStatus: 'CONFIRMED',
            postingStatus: 'POSTED',
            wipIdempotencyKey: idempotencyKey,
          },
        });

        if (scrapQty > 0) {
          await tx.productionScrap.create({
            data: {
              productionReportId: report.id,
              productionOperationId: op.id,
              scrapReason: mapScrapReasonEnum(input.scrapReason),
              quantity: scrapQty,
              weightKg: round6(scrapQty * unitWeightKg),
              isRecoverable: false,
              notes: input.scrapReason || null,
            },
          });
        }

        // Decision #5: if consecutive operations share the EXACT same locationId & warehouseId,
        // skip artificial OUTBOUND+INBOUND on AVAILABLE balance for goodQty.
        const isSameLocationGoodTransfer =
          Boolean(nextOp) &&
          sourceLocation.id === targetLocation.id &&
          sourceLocation.warehouseId === targetLocation.warehouseId;

        let transactionIndex = 0;
        const postTxMovement = async (args: {
          base: any;
          warehouseId: string;
          locationId: string | null;
          quantity: number;
          direction: 1 | -1;
          qualityStatus: string;
          transactionType: 'INBOUND' | 'OUTBOUND';
        }) => {
          if (args.quantity <= 0) return;
          const weightKg = round6(args.quantity * unitWeightKg);
          const bal = await adjustStockBalance(tx, {
            partId: part.id,
            warehouseId: args.warehouseId,
            locationId: args.locationId,
            materialLotId: args.base.materialLotId,
            physicalCoilId: args.base.physicalCoilId,
            ownership: args.base.ownership,
            contractId: args.base.contractId,
            contractNumber: args.base.contractNumber,
            qualityStatus: args.qualityStatus,
            quantity: args.quantity,
            weightKg,
            direction: args.direction,
            now: reportDate,
          });
          transactionIndex += 1;
          await tx.inventoryTransaction.create({
            data: {
              transactionNumber: `${reportNumber}-${String(transactionIndex).padStart(2, '0')}`,
              partId: part.id,
              materialLotId: args.base.materialLotId,
              physicalCoilId: args.base.physicalCoilId,
              productionOperationId: op.id,
              warehouseId: args.warehouseId,
              locationId: args.locationId,
              transactionType: args.transactionType,
              quantity: args.quantity,
              quantitySigned: args.quantity * args.direction,
              unitId,
              weightKg,
              weightKgSigned: round6(weightKg * args.direction),
              ownership: args.base.ownership,
              contractId: args.base.contractId,
              contractNumber: args.base.contractNumber,
              qualityStatus: args.qualityStatus,
              balanceAfter: bal.quantityAfter,
              balanceKgAfter: bal.weightAfter,
              transactionDate: reportDate,
              postingStatus: 'POSTED',
              createdByUserId: postingUser.id,
              productionReportId: report.id,
              manufacturingOrderId: mo.id,
            },
          });
        };

        const pieceConsumptionKg = num(part.weightGrossKg) > 0 ? num(part.weightGrossKg) : unitWeightKg;
        const coilDeltasByKey = new Map<
          string,
          { coilId: string; contractId: string | null; consumedKg: number; varianceKg: number }
        >();

        let remainingToProcess = totalReported;
        let remainingGood = goodQty;
        let remainingScrap = scrapQty;
        let remainingRework = reworkQty;
        let remainingRejected = rejectedQty;

        for (const scoped of scopedSources) {
          if (remainingToProcess <= 1e-9) break;
          const source = scoped.balance;
          const take = Math.min(remainingToProcess, scoped.allowedQty);
          if (take <= 1e-9) continue;

          const isLastSlice = remainingToProcess - take <= 1e-9;
          const proportional = (orig: number, rem: number) =>
            isLastSlice ? rem : Math.min(rem, round6(orig * (take / totalReported)));

          const goodSlice = proportional(goodQty, remainingGood);
          const scrapSlice = proportional(scrapQty, remainingScrap);
          const reworkSlice = proportional(reworkQty, remainingRework);
          const rejectedSlice = proportional(rejectedQty, remainingRejected);

          remainingGood = round6(remainingGood - goodSlice);
          remainingScrap = round6(remainingScrap - scrapSlice);
          remainingRework = round6(remainingRework - reworkSlice);
          remainingRejected = round6(remainingRejected - rejectedSlice);

          if (source.physicalCoilId && pieceConsumptionKg > 0) {
            const consumedWeightDelta = round6((goodSlice + reworkSlice) * pieceConsumptionKg);
            const varianceWeightDelta = round6((scrapSlice + rejectedSlice) * pieceConsumptionKg);
            if (consumedWeightDelta > 1e-9 || varianceWeightDelta > 1e-9) {
              const deltaKey = `${source.physicalCoilId}::${source.contractId || ''}`;
              const prevDelta = coilDeltasByKey.get(deltaKey) || {
                coilId: source.physicalCoilId,
                contractId: source.contractId || null,
                consumedKg: 0,
                varianceKg: 0,
              };
              prevDelta.consumedKg = round6(prevDelta.consumedKg + consumedWeightDelta);
              prevDelta.varianceKg = round6(prevDelta.varianceKg + varianceWeightDelta);
              coilDeltasByKey.set(deltaKey, prevDelta);
            }
          }

          const outboundQty = isSameLocationGoodTransfer
            ? round6(scrapSlice + reworkSlice + rejectedSlice)
            : take;

          if (outboundQty > 1e-9) {
            await postTxMovement({
              base: source,
              warehouseId: sourceLocation.warehouseId,
              locationId: sourceLocation.id,
              quantity: outboundQty,
              direction: -1,
              qualityStatus: 'AVAILABLE',
              transactionType: 'OUTBOUND',
            });
          }

          if (!isSameLocationGoodTransfer && goodSlice > 1e-9) {
            await postTxMovement({
              base: source,
              warehouseId: targetLocation.warehouseId,
              locationId: targetLocation.id,
              quantity: goodSlice,
              direction: 1,
              qualityStatus: 'AVAILABLE',
              transactionType: 'INBOUND',
            });
          }
          if (scrapSlice > 1e-9 && scrapLocation) {
            await postTxMovement({
              base: source,
              warehouseId: scrapLocation.warehouseId,
              locationId: scrapLocation.id,
              quantity: scrapSlice,
              direction: 1,
              qualityStatus: 'SCRAP',
              transactionType: 'INBOUND',
            });
          }
          if (reworkSlice > 1e-9) {
            await postTxMovement({
              base: source,
              warehouseId: sourceLocation.warehouseId,
              locationId: sourceLocation.id,
              quantity: reworkSlice,
              direction: 1,
              qualityStatus: 'REWORK',
              transactionType: 'INBOUND',
            });
          }
          if (rejectedSlice > 1e-9) {
            await postTxMovement({
              base: source,
              warehouseId: sourceLocation.warehouseId,
              locationId: sourceLocation.id,
              quantity: rejectedSlice,
              direction: 1,
              qualityStatus: 'REJECTED',
              transactionType: 'INBOUND',
            });
          }

          remainingToProcess = round6(remainingToProcess - take);
        }

        if ([remainingGood, remainingScrap, remainingRework, remainingRejected].some(v => Math.abs(v) > 1e-4)) {
          throw new WipServiceError('تخصیص تراکنش‌های انبار با مقادیر گزارش تولید تراز نشد.', 500);
        }

        // Settle CoilIssueReturnRecord only for the operation that received raw-material coil issues (prevents double-counting in downstream steps)
        if (typeof tx.coilIssueReturnRecord?.findMany === 'function') {
          const eligibleOpIssues = preloadedOpenIssues ?? [];
          if (eligibleOpIssues.length > 0 && (actualMaterialConsumedKg != null || coilDeltasByKey.size > 0)) {
            const workingIssues = eligibleOpIssues.map((r: any) => ({ ...r }));

            if (actualMaterialConsumedKg != null) {
              // Explicit operator-reported actual material consumption (kg) settled strictly FIFO / contract-weighted
              const goodRatio = totalReported > 0 ? (goodQty + reworkQty) / totalReported : 1;
              let remTotalActual = round6(actualMaterialConsumedKg);
              let remConsumedTarget = round6(actualMaterialConsumedKg * goodRatio);
              let remVarianceTarget = round6(remTotalActual - remConsumedTarget);

              // Prioritize matching coils/contracts present in coilDeltasByKey, then remaining open records
              const preferredPairs = new Set(Array.from(coilDeltasByKey.keys()));
              workingIssues.sort((a: any, b: any) => {
                const aMatch = preferredPairs.has(`${a.coilId}::${a.contractId || ''}`) ? 0 : 1;
                const bMatch = preferredPairs.has(`${b.coilId}::${b.contractId || ''}`) ? 0 : 1;
                return aMatch - bMatch;
              });

              for (const rec of workingIssues) {
                if (remTotalActual <= 1e-6) break;
                const availOut = num(rec.outstandingWeightKg);
                if (availOut <= 1e-6) continue;
                const totalTake = Math.min(availOut, remTotalActual);
                const isFinalTake = remTotalActual - totalTake <= 1e-6;
                const consumeTake = isFinalTake
                  ? Math.min(totalTake, remConsumedTarget)
                  : Math.min(totalTake, round6(totalTake * goodRatio));
                const varianceTake = round6(totalTake - consumeTake);
                const nextOut = Math.max(0, round6(availOut - totalTake));
                const nextStatus =
                  nextOut <= 1e-4 ? 'CONSUMED' : rec.status === 'PARTIALLY_RETURNED' ? 'PARTIALLY_RETURNED' : 'ISSUED';

                const cirCas = await tx.coilIssueReturnRecord.updateMany({
                  where: { id: rec.id, outstandingWeightKg: rec.outstandingWeightKg },
                  data: {
                    consumedWeightKg: { increment: consumeTake },
                    varianceWeightKg: { increment: varianceTake },
                    outstandingWeightKg: nextOut,
                    status: nextStatus,
                  },
                });
                if (cirCas.count !== 1) {
                  throw new WipServiceError('رکورد مصرف کویل هم‌زمان تغییر کرده است؛ گزارش تولید لغو شد.', 409, true);
                }
                rec.outstandingWeightKg = nextOut;
                rec.status = nextStatus;
                remTotalActual = Math.max(0, round6(remTotalActual - totalTake));
                remConsumedTarget = Math.max(0, round6(remConsumedTarget - consumeTake));
                remVarianceTarget = Math.max(0, round6(remVarianceTarget - varianceTake));
              }
            } else if (coilDeltasByKey.size > 0) {
              for (const delta of coilDeltasByKey.values()) {
                let remConsumed = delta.consumedKg;
                let remVariance = delta.varianceKg;
                const matches = workingIssues
                  .filter((r: any) => r.coilId === delta.coilId && num(r.outstandingWeightKg) > 1e-6)
                  .sort((a: any, b: any) => {
                    const aExact = delta.contractId && a.contractId === delta.contractId ? 0 : 1;
                    const bExact = delta.contractId && b.contractId === delta.contractId ? 0 : 1;
                    return aExact - bExact;
                  });
                for (const rec of matches) {
                  if (remConsumed <= 1e-6 && remVariance <= 1e-6) break;
                  const availOut = num(rec.outstandingWeightKg);
                  if (availOut <= 1e-6) continue;
                  const consumeTake = Math.min(availOut, remConsumed);
                  const availAfterConsume = round6(availOut - consumeTake);
                  const varianceTake = Math.min(availAfterConsume, remVariance);
                  const totalTake = round6(consumeTake + varianceTake);
                  if (totalTake <= 1e-6) continue;
                  const nextOut = Math.max(0, round6(availOut - totalTake));
                  const nextStatus =
                    nextOut <= 1e-4 ? 'CONSUMED' : rec.status === 'PARTIALLY_RETURNED' ? 'PARTIALLY_RETURNED' : 'ISSUED';
                  const cirCas = await tx.coilIssueReturnRecord.updateMany({
                    where: { id: rec.id, outstandingWeightKg: rec.outstandingWeightKg },
                    data: {
                      consumedWeightKg: { increment: consumeTake },
                      varianceWeightKg: { increment: varianceTake },
                      outstandingWeightKg: nextOut,
                      status: nextStatus,
                    },
                  });
                  if (cirCas.count !== 1) {
                    throw new WipServiceError('رکورد مصرف کویل هم‌زمان تغییر کرده است؛ گزارش تولید لغو شد.', 409, true);
                  }
                  rec.outstandingWeightKg = nextOut;
                  rec.status = nextStatus;
                  remConsumed = Math.max(0, round6(remConsumed - consumeTake));
                  remVariance = Math.max(0, round6(remVariance - varianceTake));
                }
              }
            }
          }
        }

        const nextWaiting = round6(waitingInput - autoConsumeFromWaiting);
        const nextInProgress = round6(inProgress - consumeFromInProgress);
        const autoComplete = input.autoCompleteOperation !== false;
        const opDrained = nextWaiting <= 1e-6 && nextInProgress <= 1e-6 && num(op.readyForTransferQty) <= 1e-6;
        const opFinished = autoComplete && opDrained;
        const nextOpStatus = opFinished
          ? 'COMPLETED'
          : autoComplete && num(op.readyForTransferQty) > 0 && nextWaiting <= 1e-6 && nextInProgress <= 1e-6
          ? 'READY'
          : 'IN_PROGRESS';

        const opCas = await tx.productionOperation.updateMany({
          where: { id: op.id, version: op.version },
          data: {
            waitingInputQty: nextWaiting,
            inProgressQty: nextInProgress,
            inputQty: { increment: autoConsumeFromWaiting },
            outputGoodQty: { increment: goodQty },
            outputScrapQty: { increment: scrapQty },
            outputReworkQty: { increment: reworkQty },
            outputRejectedQty: { increment: rejectedQty },
            transferredQty: { increment: goodQty },
            status: nextOpStatus,
            startDate: op.startDate || reportDate,
            ...(opFinished ? { endDate: reportDate } : {}),
            lastActivityAt: reportDate,
            version: { increment: 1 },
          },
        });
        if (opCas.count !== 1) {
          throw new WipServiceError('نسخه عملیات هم‌زمان تغییر کرده است؛ ثبت تولید لغو شد.', 409, true);
        }

        let createdTransfer: any = null;
        const finalDestinationName =
          targetLocation.warehouse?.name ||
          (part.category === 'FINISHED_GOOD' ? 'انبار محصول نهایی' : 'انبار نیمه‌ساخته');
        if (goodQty > 0) {
          if (nextOp) {
            const nextOpCas = await tx.productionOperation.updateMany({
              where: { id: nextOp.id, version: nextOp.version },
              data: {
                waitingInputQty: { increment: goodQty },
                status: nextOp.status === 'PENDING' ? 'READY' : nextOp.status,
                lastActivityAt: reportDate,
                version: { increment: 1 },
              },
            });
            if (nextOpCas.count !== 1) {
              throw new WipServiceError('نسخه عملیات بعدی هم‌زمان تغییر کرده است؛ ثبت تولید لغو شد.', 409, true);
            }
          }

          const transferNumber = `AUTO-${mo.moNumber}-${op.stepNumber}-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`;
          createdTransfer = await tx.productionTransfer.create({
            data: {
              transferNumber,
              manufacturingOrderId: mo.id,
              partId: part.id,
              fromStageOperationId: op.id,
              toStageOperationId: nextOp?.id || null,
              fromWarehouseId: sourceLocation.warehouseId,
              toWarehouseId: targetLocation.warehouseId,
              fromLocationId: sourceLocation.id,
              toLocationId: targetLocation.id,
              fromLocationCode: sourceLocation.code,
              toLocationCode: targetLocation.code,
              fromStepNumber: op.stepNumber,
              toStepNumber: nextOp?.stepNumber || 999,
              fromStepName: op.stepName || op.operation.name,
              toStepName: nextOp ? nextOp.stepName || nextOp.operation.name : finalDestinationName,
              quantity: goodQty,
              unitId,
              dispatchedByUserId: postingUser.id,
              dispatchedByName: input.operatorName || postingUser.fullName || 'اپراتور تولید',
              dispatchedAt: reportDate,
              receivedByUserId: postingUser.id,
              receivedByName: input.operatorName || postingUser.fullName || 'اپراتور تولید',
              receivedAt: reportDate,
              status: 'AUTO_TRANSFERRED',
              notes: nextOp
                ? isSameLocationGoodTransfer
                  ? 'انتقال منطقی خودکار بین دو عملیات هم‌مکان (بدون جابه‌جایی فیزیکی انبار)'
                  : 'انتقال خودکار خروجی سالم به صف انتظار عملیات بعد؛ بدون تأیید دریافت'
                : `انتقال خودکار خروجی سالم به مقصد نهایی (${targetLocation.code})`,
            },
          });

          await tx.productionActivityLog.create({
            data: {
              manufacturingOrderId: mo.id,
              moNumber: mo.moNumber,
              partId: part.id,
              productionOperationId: op.id,
              stepNumber: op.stepNumber,
              stepName: op.stepName || op.operation.name,
              activityType: 'AUTO_TRANSFER',
              quantity: goodQty,
              operatorName: input.operatorName || postingUser.fullName || 'اپراتور تولید',
              machineId: effectiveMachineId,
              transferId: createdTransfer.id,
              productionReportId: report.id,
              timestamp: reportDate,
              notes: nextOp
                ? `انتقال خودکار ${goodQty} عدد به صف انتظار ${nextOp.stepName || nextOp.operation.name}`
                : `انتقال خودکار ${goodQty} عدد به ${finalDestinationName} (${targetLocation.code})`,
            },
          });
        }

        await tx.productionActivityLog.create({
          data: {
            manufacturingOrderId: mo.id,
            moNumber: mo.moNumber,
            partId: part.id,
            productionOperationId: op.id,
            stepNumber: op.stepNumber,
            stepName: op.stepName || op.operation.name,
            activityType: 'PRODUCTION_RUN',
            quantity: totalReported,
            goodQty,
            scrapQty,
            reworkQty,
            rejectedQty,
            operatorName: input.operatorName || postingUser.fullName || 'اپراتور تولید',
            machineId: effectiveMachineId,
            scrapReason: input.scrapReason || null,
            productionReportId: report.id,
            timestamp: reportDate,
            notes: `${input.notes || ''}${diePmNotice}`.trim() || null,
          },
        });

        // Recompute MO totals & completion state cleanly inside same tx
        const refreshedOps = await tx.productionOperation.findMany({ where: { manufacturingOrderId: mo.id } });
        const pendingTransfersCount = await tx.productionTransfer.count({
          where: { manufacturingOrderId: mo.id, status: 'DISPATCHED' },
        });
        const newCompleted = nextOp ? num(mo.completedQty) : round6(num(mo.completedQty) + goodQty);
        const allOpsEmpty = refreshedOps.every(
          (candidate: any) =>
            num(candidate.inProgressQty) <= 1e-6 &&
            num(candidate.waitingInputQty) <= 1e-6 &&
            num(candidate.readyForTransferQty) <= 1e-6,
        );
        const moCompleted =
          autoComplete && newCompleted >= num(mo.targetQty) && pendingTransfersCount === 0 && allOpsEmpty;

        const moCas = await tx.manufacturingOrder.updateMany({
          where: {
            id: mo.id,
            version: mo.version,
            status: { notIn: ['CANCELLED', 'CLOSED'] },
          },
          data: {
            ...(nextOp ? {} : { completedQty: { increment: goodQty } }),
            scrapQty: { increment: scrapQty },
            totalReworkQty: { increment: reworkQty },
            totalRejectedQty: { increment: rejectedQty },
            status: moCompleted ? 'COMPLETED' : 'IN_PROGRESS',
            actualStartDate: mo.actualStartDate || reportDate,
            ...(moCompleted ? { actualEndDate: reportDate, closedAt: reportDate } : {}),
            version: { increment: 1 },
          },
        });
        if (moCas.count !== 1) {
          throw new WipServiceError('وضعیت یا نسخه دستور تولید هم‌زمان تغییر کرده است؛ ثبت تولید لغو شد.', 409, true);
        }

        if (moCompleted) {
          await releaseMoReservationsInTx(tx, mo.id, {
            reason: 'MO_COMPLETED',
            now: reportDate,
            prismaUserId: postingUser.id,
          });
        }

        // Sync MachineAssignment statuses cleanly (SCHEDULED -> ACTIVE, or COMPLETED on opFinished)
        if (typeof tx.machineAssignment?.findMany === 'function') {
          const openAssignments = await tx.machineAssignment.findMany({
            where: {
              productionOperationId: op.id,
              status: { in: ['SCHEDULED', 'ACTIVE'] },
            },
          });
          for (const asg of openAssignments || []) {
            const targetAsgStatus = opFinished ? 'COMPLETED' : 'ACTIVE';
            if (asg.status !== targetAsgStatus || (!asg.assignedOperatorId && postingUser.id)) {
              await tx.machineAssignment.update({
                where: { id: asg.id },
                data: {
                  status: targetAsgStatus,
                  ...(!asg.assignedOperatorId && postingUser.id ? { assignedOperatorId: postingUser.id } : {}),
                },
              });
            }
          }
        }

        // Update read-only progress on linked ProductionPlanLine / ProductionPlan (never alter plannedQty or planned dates)
        if (!nextOp && goodQty > 0 && mo.planLineId && typeof tx.productionPlanLine?.findUnique === 'function') {
          const planLine = await tx.productionPlanLine.findUnique({ where: { id: mo.planLineId } });
          if (planLine) {
            const nextProduced = round6(num(planLine.producedQty) + goodQty);
            const nextLineStatus = nextProduced >= num(planLine.plannedQty) ? 'COMPLETED' : 'IN_PROGRESS';
            await tx.productionPlanLine.update({
              where: { id: planLine.id },
              data: {
                producedQty: nextProduced,
                status: nextLineStatus,
              },
            });
            if (mo.planId && typeof tx.productionPlan?.findUnique === 'function') {
              const parentPlan = await tx.productionPlan.findUnique({
                where: { id: mo.planId },
                include: { planLines: true },
              });
              if (parentPlan && parentPlan.status !== 'CANCELLED') {
                const allLinesDone =
                  Array.isArray(parentPlan.planLines) &&
                  parentPlan.planLines.length > 0 &&
                  parentPlan.planLines.every((l: any) =>
                    l.id === planLine.id ? nextLineStatus === 'COMPLETED' : l.status === 'COMPLETED',
                  );
                const nextPlanStatus = allLinesDone ? 'COMPLETED' : 'IN_PROGRESS';
                if (parentPlan.status !== nextPlanStatus) {
                  await tx.productionPlan.update({
                    where: { id: parentPlan.id },
                    data: { status: nextPlanStatus },
                  });
                }
              }
            }
          }
        }

        if (typeof tx.auditLog?.create === 'function') {
          await tx.auditLog.create({
            data: {
              userId: postingUser.id,
              action: 'SHOP_FLOOR_PRODUCTION_REPORT',
              entityName: 'ProductionReport',
              entityId: report.id,
              newValues: {
                manufacturingOrderId: mo.id,
                productionOperationId: op.id,
                machineId: effectiveMachineId,
                shiftId: shift.id,
                goodQty,
                scrapQty,
                reworkQty,
                rejectedQty,
                runTimeMinutes: runTimeInt,
                downtimeMinutes: downtimeInt,
                downtimeReason: downtimeReasonTrimmed || null,
                actualMaterialConsumedKg,
                idempotencyKey,
              },
              timestamp: reportDate,
            },
          });
        }

        const updatedMo = await tx.manufacturingOrder.findUnique({ where: { id: mo.id }, include: MO_INCLUDE });
        return { duplicate: false, report, transactionCount: transactionIndex, mo: updatedMo };
      },
      { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 },
    );

    await syncWipReadCacheFromPostgres();
    return {
      duplicate: result.duplicate,
      report: result.report,
      transactionCount: result.transactionCount,
      mo: result.mo ? mapRelationalMoToWipDto(result.mo) : null,
    };
  } catch (err) {
    wrapWipTxError(err);
  }
}

export async function createOperationTransferDb(params: {
  moId: string;
  fromOperationId: string;
  toOperationId: string;
  quantity: number;
  dispatchedBy?: string;
  createdByUserId?: string;
  notes?: string;
  expectedVersion?: number;
}) {
  const prisma = getWipPrisma();
  const qty = Number(params.quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new WipServiceError('تعداد انتقال باید بزرگتر از صفر باشد.', 400);
  }

  try {
    const transferRow = await prisma.$transaction(
      async (tx: any) => {
        const mo = await tx.manufacturingOrder.findFirst({
          where: { OR: [{ id: params.moId }, { moNumber: params.moId }] },
          include: MO_INCLUDE,
        });
        if (!mo) throw new WipServiceError('دستور تولید یافت نشد.', 404);
        assertMoMutable(mo);

        const fromOp = mo.operations.find((o: any) => o.id === params.fromOperationId);
        if (!fromOp) throw new WipServiceError('مرحله مبدأ یافت نشد.', 404);

        if (params.expectedVersion != null && fromOp.version !== params.expectedVersion) {
          throw new WipServiceError('نسخه عملیات مبدأ هم‌زمان تغییر کرده است؛ اطلاعات را تازه‌سازی کنید.', 409, true);
        }

        if (qty > num(fromOp.readyForTransferQty) + 1e-6) {
          throw new WipServiceError(
            `موجودی آماده انتقال (${num(fromOp.readyForTransferQty)}) کمتر از مقدار درخواستی (${qty}) است.`,
            400,
          );
        }

        const fromLoc = fromOp.locationId
          ? await tx.warehouseLocation.findUnique({ where: { id: fromOp.locationId }, include: { warehouse: true } })
          : await resolveLocationByCodeOrId(
              tx,
              fromOp.warehouseLocationCode || getLocationForProcess(fromOp.operation.processType, fromOp.stepNumber),
            );
        if (!fromLoc) throw new WipServiceError('موقعیت انبار مبدأ یافت نشد.', 400);

        const isFinalStore = !params.toOperationId || params.toOperationId === 'STORE-FINISHED';
        let toOp: any = null;
        let toLoc: any = null;
        if (!isFinalStore) {
          toOp = mo.operations.find((o: any) => o.id === params.toOperationId);
          if (!toOp) throw new WipServiceError('مرحله مقصد یافت نشد.', 404);
          toLoc = toOp.locationId
            ? await tx.warehouseLocation.findUnique({ where: { id: toOp.locationId }, include: { warehouse: true } })
            : await resolveLocationByCodeOrId(
                tx,
                toOp.warehouseLocationCode || getLocationForProcess(toOp.operation.processType, toOp.stepNumber),
              );
        } else {
          toLoc = await resolveOutputDestination(tx, mo, mo.part);
        }
        if (!toLoc) throw new WipServiceError('موقعیت انبار مقصد یافت نشد.', 400);

        const now = new Date();
        const postingUser = await resolvePostingUser(tx, params.createdByUserId);
        const unitWeightKg = num(mo.part.weightNetKg);

        // Ensure MO was not cancelled/closed concurrently
        const moCas = await tx.manufacturingOrder.updateMany({
          where: { id: mo.id, version: mo.version, status: { notIn: ['CANCELLED', 'CLOSED'] } },
          data: { version: { increment: 1 } },
        });
        if (moCas.count !== 1) {
          throw new WipServiceError('وضعیت یا نسخه دستور تولید هم‌زمان تغییر کرده است؛ دوباره تلاش کنید.', 409, true);
        }

        // Conditional decrement on fromOp
        const opUpdate = await tx.productionOperation.updateMany({
          where: {
            id: fromOp.id,
            version: fromOp.version,
            readyForTransferQty: { gte: qty },
          },
          data: {
            readyForTransferQty: { decrement: qty },
            transferredQty: { increment: qty },
            lastActivityAt: now,
            version: { increment: 1 },
          },
        });
        if (opUpdate.count !== 1) {
          throw new WipServiceError('موجودی آماده انتقال هم‌زمان تغییر کرده است؛ دوباره تلاش کنید.', 409, true);
        }

        // Move MO-scoped stock: source AVAILABLE -> destination IN_TRANSIT
        const scopedSrcBalances = await resolveMoScopedBalancesInTx(tx, {
          moId: mo.id,
          partId: mo.partId,
          warehouseId: fromLoc.warehouseId,
          locationId: fromLoc.id,
          qualityStatus: 'AVAILABLE',
        });
        const totalAvail = scopedSrcBalances.reduce((s: number, item) => s + item.allowedQty, 0);
        if (totalAvail + 1e-6 < qty) {
          throw new WipServiceError(
            `موجودی کاردکس متعلق به دستور ساخت ${mo.moNumber} در مبدأ (${totalAvail}) برای صدور حواله انتقال (${qty}) کافی نیست.`,
            409,
          );
        }

        const transferNumber = `TRF-${now.getFullYear()}-${String(Date.now()).slice(-6)}-${randomUUID().slice(0, 3).toUpperCase()}`;
        const doc = await tx.inventoryDocument.create({
          data: {
            documentNumber: `DOC-${transferNumber}`,
            documentType: 'WIP_TRANSFER',
            documentDate: now,
            documentStatus: 'CONFIRMED',
            postingStatus: 'POSTED',
            warehouseId: fromLoc.warehouseId,
            targetWarehouseId: toLoc.warehouseId,
            referenceType: 'MANUFACTURING_ORDER',
            referenceNumber: mo.moNumber,
            createdByUserId: postingUser.id,
            postedByUserId: postingUser.id,
            postedAt: now,
            notes: params.notes || `حواله انتقال ${transferNumber} (در حال انتقال IN_TRANSIT)`,
          },
        });

        const primarySrc = scopedSrcBalances[0]?.balance;
        const docLine = await tx.inventoryDocumentLine.create({
          data: {
            documentId: doc.id,
            lineNumber: 1,
            partId: mo.partId,
            productionOperationId: fromOp.id,
            locationId: fromLoc.id,
            targetLocationId: toLoc.id,
            quantity: qty,
            unitId: mo.part.unitId,
            weightKg: round6(qty * unitWeightKg),
            ownership: primarySrc?.ownership || 'COMPANY_OWNED',
            contractId: primarySrc?.contractId || null,
            contractNumber: primarySrc?.contractNumber || null,
            qualityStatus: 'IN_TRANSIT',
            notes: params.notes || null,
          },
        });

        let remaining = qty;
        let trxIdx = 0;
        for (const scoped of scopedSrcBalances) {
          if (remaining <= 1e-9) break;
          const sb = scoped.balance;
          const take = Math.min(remaining, scoped.allowedQty);
          if (take <= 1e-9) continue;
          const takeWeight = round6(take * unitWeightKg);

          const srcAfter = await adjustStockBalance(tx, {
            partId: mo.partId,
            warehouseId: fromLoc.warehouseId,
            locationId: fromLoc.id,
            materialLotId: sb.materialLotId,
            physicalCoilId: sb.physicalCoilId,
            ownership: sb.ownership,
            contractId: sb.contractId,
            contractNumber: sb.contractNumber,
            qualityStatus: 'AVAILABLE',
            quantity: take,
            weightKg: takeWeight,
            direction: -1,
            now,
          });
          trxIdx += 1;
          await tx.inventoryTransaction.create({
            data: {
              transactionNumber: `${transferNumber}-OUT-${trxIdx}`,
              documentId: doc.id,
              documentLineId: docLine.id,
              partId: mo.partId,
              materialLotId: sb.materialLotId,
              physicalCoilId: sb.physicalCoilId,
              productionOperationId: fromOp.id,
              warehouseId: fromLoc.warehouseId,
              locationId: fromLoc.id,
              transactionType: 'TRANSFER_OUT',
              quantity: take,
              quantitySigned: -take,
              unitId: mo.part.unitId,
              weightKg: takeWeight,
              weightKgSigned: -takeWeight,
              ownership: sb.ownership,
              contractId: sb.contractId,
              contractNumber: sb.contractNumber,
              qualityStatus: 'AVAILABLE',
              balanceAfter: srcAfter.quantityAfter,
              balanceKgAfter: srcAfter.weightAfter,
              transactionDate: now,
              postingStatus: 'POSTED',
              createdByUserId: postingUser.id,
              manufacturingOrderId: mo.id,
            },
          });

          const dstAfter = await adjustStockBalance(tx, {
            partId: mo.partId,
            warehouseId: toLoc.warehouseId,
            locationId: toLoc.id,
            materialLotId: sb.materialLotId,
            physicalCoilId: sb.physicalCoilId,
            ownership: sb.ownership,
            contractId: sb.contractId,
            contractNumber: sb.contractNumber,
            qualityStatus: 'IN_TRANSIT',
            quantity: take,
            weightKg: takeWeight,
            direction: 1,
            now,
          });
          trxIdx += 1;
          await tx.inventoryTransaction.create({
            data: {
              transactionNumber: `${transferNumber}-IN-${trxIdx}`,
              documentId: doc.id,
              documentLineId: docLine.id,
              partId: mo.partId,
              materialLotId: sb.materialLotId,
              physicalCoilId: sb.physicalCoilId,
              productionOperationId: toOp?.id || fromOp.id,
              warehouseId: toLoc.warehouseId,
              locationId: toLoc.id,
              transactionType: 'TRANSFER_IN',
              quantity: take,
              quantitySigned: take,
              unitId: mo.part.unitId,
              weightKg: takeWeight,
              weightKgSigned: takeWeight,
              ownership: sb.ownership,
              contractId: sb.contractId,
              contractNumber: sb.contractNumber,
              qualityStatus: 'IN_TRANSIT',
              balanceAfter: dstAfter.quantityAfter,
              balanceKgAfter: dstAfter.weightAfter,
              transactionDate: now,
              postingStatus: 'POSTED',
              createdByUserId: postingUser.id,
              manufacturingOrderId: mo.id,
            },
          });

          remaining = round6(remaining - take);
        }

        const toStepName = toOp
          ? toOp.stepName || toOp.operation.name
          : toLoc.warehouse?.name || (mo.part.category === 'FINISHED_GOOD' ? 'انبار محصول نهایی' : 'انبار نیمه‌ساخته');
        const created = await tx.productionTransfer.create({
          data: {
            transferNumber,
            manufacturingOrderId: mo.id,
            partId: mo.partId,
            fromStageOperationId: fromOp.id,
            toStageOperationId: toOp?.id || null,
            fromWarehouseId: fromLoc.warehouseId,
            toWarehouseId: toLoc.warehouseId,
            fromLocationId: fromLoc.id,
            toLocationId: toLoc.id,
            fromLocationCode: fromLoc.code,
            toLocationCode: toLoc.code,
            fromStepNumber: fromOp.stepNumber,
            toStepNumber: toOp?.stepNumber || 999,
            fromStepName: fromOp.stepName || fromOp.operation.name,
            toStepName,
            quantity: qty,
            unitId: mo.part.unitId,
            dispatchedByUserId: postingUser.id,
            dispatchedByName: params.dispatchedBy || 'سرپرست خط تولید',
            dispatchedAt: now,
            status: 'DISPATCHED',
            inventoryDocId: doc.id,
            notes: params.notes || null,
          },
          include: {
            manufacturingOrder: { select: { id: true, moNumber: true } },
            part: { select: { id: true, partNumber: true, name: true } },
            fromWarehouse: { select: { id: true, code: true, name: true } },
            toWarehouse: { select: { id: true, code: true, name: true } },
            fromLocation: { select: { id: true, code: true } },
            toLocation: { select: { id: true, code: true } },
          },
        });

        await tx.productionActivityLog.create({
          data: {
            manufacturingOrderId: mo.id,
            moNumber: mo.moNumber,
            partId: mo.partId,
            productionOperationId: fromOp.id,
            stepNumber: fromOp.stepNumber,
            stepName: fromOp.stepName || fromOp.operation.name,
            activityType: 'TRANSFER_DISPATCH',
            quantity: qty,
            operatorName: params.dispatchedBy || 'سرپرست خط تولید',
            transferId: created.id,
            timestamp: now,
            notes: `ارسال محموله شماره ${transferNumber} به ${toStepName} (در انتظار تأیید و تحویل)`,
          },
        });

        return created;
      },
      { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 },
    );

    await syncWipReadCacheFromPostgres();
    return mapRelationalTransferToDto(transferRow);
  } catch (err) {
    wrapWipTxError(err);
  }
}

export async function approveOperationTransferDb(params: {
  transferId: string;
  receivedBy?: string;
  createdByUserId?: string;
  notes?: string;
  expectedVersion?: number;
}) {
  const prisma = getWipPrisma();
  try {
    const transferRow = await prisma.$transaction(
      async (tx: any) => {
        const tr = await tx.productionTransfer.findFirst({
          where: { OR: [{ id: params.transferId }, { transferNumber: params.transferId }] },
          include: {
            manufacturingOrder: { include: MO_INCLUDE },
            part: { include: { unit: true } },
          },
        });
        if (!tr) throw new WipServiceError('حواله انتقال یافت نشد.', 404);
        if (tr.status !== 'DISPATCHED') {
          throw new WipServiceError('این حواله قبلاً تعیین تکلیف شده است.', 409, true);
        }
        if (params.expectedVersion != null && tr.version !== params.expectedVersion) {
          throw new WipServiceError('وضعیت این حواله هم‌زمان تغییر کرده است؛ اطلاعات را تازه‌سازی کنید.', 409, true);
        }

        const mo = tr.manufacturingOrder;
        assertMoMutable(mo);
        const qty = num(tr.quantity);
        const now = new Date();
        const postingUser = await resolvePostingUser(tx, params.createdByUserId);
        const unitWeightKg = num(tr.part.weightNetKg);

        const toOp = tr.toStageOperationId
          ? mo.operations.find((o: any) => o.id === tr.toStageOperationId)
          : null;
        const destLoc = tr.toLocationId
          ? await tx.warehouseLocation.findUnique({ where: { id: tr.toLocationId }, include: { warehouse: true } })
          : toOp
          ? await resolveLocationByCodeOrId(
              tx,
              toOp.warehouseLocationCode || getLocationForProcess(toOp.operation.processType, toOp.stepNumber),
            )
          : await resolveOutputDestination(tx, mo, tr.part);

        if (!destLoc) throw new WipServiceError('موقعیت انبار مقصد حواله یافت نشد.', 400);

        // Strictly verify transfer/MO-scoped IN_TRANSIT stock BEFORE mutating any record (zero stock minting)
        const scopedInTransit = await resolveMoScopedBalancesInTx(tx, {
          moId: mo.id,
          partId: tr.partId,
          warehouseId: destLoc.warehouseId,
          locationId: destLoc.id,
          qualityStatus: 'IN_TRANSIT',
          documentId: tr.inventoryDocId || null,
        });
        const totalInTransitAvail = scopedInTransit.reduce((s: number, item) => s + item.allowedQty, 0);
        if (totalInTransitAvail + 1e-6 < qty) {
          throw new WipServiceError(
            `موجودی در راه (IN_TRANSIT) متعلق به حواله ${tr.transferNumber} در موقعیت ${destLoc.code} (${totalInTransitAvail}) برای تأیید تحویل (${qty}) کافی نیست؛ هیچ تغییری اعمال نشد.`,
            409,
            true,
          );
        }

        const trCas = await tx.productionTransfer.updateMany({
          where: { id: tr.id, status: 'DISPATCHED', version: tr.version },
          data: {
            status: 'RECEIVED',
            receivedByUserId: postingUser.id,
            receivedByName: params.receivedBy || 'سرپرست ایستگاه مقصد',
            receivedAt: now,
            notes: params.notes ? (tr.notes ? `${tr.notes} | ${params.notes}` : params.notes) : tr.notes,
            version: { increment: 1 },
          },
        });
        if (trCas.count !== 1) {
          throw new WipServiceError('این حواله هم‌زمان توسط کاربر دیگری تغییر یافته است.', 409, true);
        }

        const doc = await tx.inventoryDocument.create({
          data: {
            documentNumber: `RCV-${tr.transferNumber}-${Date.now()}`,
            documentType: 'WIP_TRANSFER',
            documentDate: now,
            documentStatus: 'CONFIRMED',
            postingStatus: 'POSTED',
            warehouseId: tr.fromWarehouseId,
            targetWarehouseId: destLoc.warehouseId,
            referenceType: 'MANUFACTURING_ORDER',
            referenceNumber: mo.moNumber,
            createdByUserId: postingUser.id,
            postedByUserId: postingUser.id,
            postedAt: now,
            notes: `تحویل قطعی حواله ${tr.transferNumber}`,
          },
        });

        const primaryInTransit = scopedInTransit[0]?.balance;
        const docLine = await tx.inventoryDocumentLine.create({
          data: {
            documentId: doc.id,
            lineNumber: 1,
            partId: tr.partId,
            productionOperationId: toOp?.id || tr.fromStageOperationId,
            locationId: tr.fromLocationId,
            targetLocationId: destLoc.id,
            quantity: qty,
            unitId: tr.part.unitId,
            weightKg: round6(qty * unitWeightKg),
            ownership: primaryInTransit?.ownership || 'COMPANY_OWNED',
            contractId: primaryInTransit?.contractId || null,
            contractNumber: primaryInTransit?.contractNumber || null,
            qualityStatus: 'AVAILABLE',
          },
        });

        let remaining = qty;
        let trxIdx = 0;
        for (const scoped of scopedInTransit) {
          if (remaining <= 1e-9) break;
          const sb = scoped.balance;
          const take = Math.min(remaining, scoped.allowedQty);
          if (take <= 1e-9) continue;
          const takeWeight = round6(take * unitWeightKg);

          const inTransitAfter = await decrementInTransitBalance(tx, { sb, take, takeWeight, now });
          trxIdx += 1;
          await tx.inventoryTransaction.create({
            data: {
              transactionNumber: `${tr.transferNumber}-REL-${trxIdx}`,
              documentId: doc.id,
              documentLineId: docLine.id,
              partId: tr.partId,
              materialLotId: sb.materialLotId,
              physicalCoilId: sb.physicalCoilId,
              productionOperationId: toOp?.id || tr.fromStageOperationId,
              warehouseId: destLoc.warehouseId,
              locationId: destLoc.id,
              transactionType: 'TRANSFER_OUT',
              quantity: take,
              quantitySigned: -take,
              unitId: tr.part.unitId,
              weightKg: takeWeight,
              weightKgSigned: -takeWeight,
              ownership: sb.ownership,
              contractId: sb.contractId,
              contractNumber: sb.contractNumber,
              qualityStatus: 'IN_TRANSIT',
              balanceAfter: inTransitAfter.quantityAfter,
              balanceKgAfter: inTransitAfter.weightAfter,
              transactionDate: now,
              postingStatus: 'POSTED',
              createdByUserId: postingUser.id,
              manufacturingOrderId: mo.id,
            },
          });

          const availAfter = await adjustStockBalance(tx, {
            partId: tr.partId,
            warehouseId: destLoc.warehouseId,
            locationId: destLoc.id,
            materialLotId: sb.materialLotId,
            physicalCoilId: sb.physicalCoilId,
            ownership: sb.ownership,
            contractId: sb.contractId,
            contractNumber: sb.contractNumber,
            qualityStatus: 'AVAILABLE',
            quantity: take,
            weightKg: takeWeight,
            direction: 1,
            now,
          });
          trxIdx += 1;
          await tx.inventoryTransaction.create({
            data: {
              transactionNumber: `${tr.transferNumber}-RCV-${trxIdx}`,
              documentId: doc.id,
              documentLineId: docLine.id,
              partId: tr.partId,
              materialLotId: sb.materialLotId,
              physicalCoilId: sb.physicalCoilId,
              productionOperationId: toOp?.id || tr.fromStageOperationId,
              warehouseId: destLoc.warehouseId,
              locationId: destLoc.id,
              transactionType: 'TRANSFER_IN',
              quantity: take,
              quantitySigned: take,
              unitId: tr.part.unitId,
              weightKg: takeWeight,
              weightKgSigned: takeWeight,
              ownership: sb.ownership,
              contractId: sb.contractId,
              contractNumber: sb.contractNumber,
              qualityStatus: 'AVAILABLE',
              balanceAfter: availAfter.quantityAfter,
              balanceKgAfter: availAfter.weightAfter,
              transactionDate: now,
              postingStatus: 'POSTED',
              createdByUserId: postingUser.id,
              manufacturingOrderId: mo.id,
            },
          });

          remaining = round6(remaining - take);
        }

        if (remaining > 1e-5) {
          throw new WipServiceError('تخصیص موجودی در راه (IN_TRANSIT) برای تأیید حواله کامل نشد.', 409, true);
        }

        if (toOp) {
          const toOpCas = await tx.productionOperation.updateMany({
            where: { id: toOp.id, version: toOp.version },
            data: {
              waitingInputQty: { increment: qty },
              status: toOp.status === 'PENDING' ? 'READY' : toOp.status,
              lastActivityAt: now,
              version: { increment: 1 },
            },
          });
          if (toOpCas.count !== 1) {
            throw new WipServiceError('نسخه عملیات مقصد هم‌زمان تغییر کرده است؛ تأیید حواله لغو شد.', 409, true);
          }

          const moCas = await tx.manufacturingOrder.updateMany({
            where: { id: mo.id, version: mo.version, status: { notIn: ['CANCELLED', 'CLOSED'] } },
            data: { version: { increment: 1 } },
          });
          if (moCas.count !== 1) {
            throw new WipServiceError('وضعیت یا نسخه دستور تولید هم‌زمان تغییر کرده است؛ تأیید حواله لغو شد.', 409, true);
          }
        } else {
          const nextCompleted = round6(num(mo.completedQty) + qty);
          const refreshedOps = await tx.productionOperation.findMany({ where: { manufacturingOrderId: mo.id } });
          const pendingCount = await tx.productionTransfer.count({
            where: { manufacturingOrderId: mo.id, status: 'DISPATCHED' },
          });
          const allEmpty = refreshedOps.every(
            (o: any) => num(o.waitingInputQty) <= 1e-6 && num(o.inProgressQty) <= 1e-6 && num(o.readyForTransferQty) <= 1e-6,
          );
          const isFinished = nextCompleted >= num(mo.targetQty) && pendingCount === 0 && allEmpty;
          const moCas = await tx.manufacturingOrder.updateMany({
            where: { id: mo.id, version: mo.version, status: { notIn: ['CANCELLED', 'CLOSED'] } },
            data: {
              completedQty: { increment: qty },
              ...(isFinished ? { status: 'COMPLETED', actualEndDate: now, closedAt: now } : {}),
              version: { increment: 1 },
            },
          });
          if (moCas.count !== 1) {
            throw new WipServiceError('وضعیت یا نسخه دستور تولید هم‌زمان تغییر کرده است؛ تأیید حواله لغو شد.', 409, true);
          }
          if (isFinished) {
            await releaseMoReservationsInTx(tx, mo.id, {
              reason: 'MO_COMPLETED',
              now,
              prismaUserId: postingUser.id,
            });
          }
        }

        await tx.productionActivityLog.create({
          data: {
            manufacturingOrderId: mo.id,
            moNumber: mo.moNumber,
            partId: tr.partId,
            productionOperationId: toOp?.id || null,
            stepNumber: tr.toStepNumber || 999,
            stepName: tr.toStepName || destLoc.warehouse?.name || 'انبار مقصد',
            activityType: 'TRANSFER_RECEIVE',
            quantity: qty,
            operatorName: params.receivedBy || 'سرپرست ایستگاه مقصد',
            transferId: tr.id,
            timestamp: now,
            notes: `تحویل قطعی حواله شماره ${tr.transferNumber} در مقصد`,
          },
        });

        return tx.productionTransfer.findUnique({
          where: { id: tr.id },
          include: {
            manufacturingOrder: { select: { id: true, moNumber: true } },
            part: { select: { id: true, partNumber: true, name: true } },
            fromWarehouse: { select: { id: true, code: true, name: true } },
            toWarehouse: { select: { id: true, code: true, name: true } },
            fromLocation: { select: { id: true, code: true } },
            toLocation: { select: { id: true, code: true } },
          },
        });
      },
      { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 },
    );

    await syncWipReadCacheFromPostgres();
    return mapRelationalTransferToDto(transferRow);
  } catch (err) {
    wrapWipTxError(err);
  }
}

export async function rejectOperationTransferDb(params: {
  transferId: string;
  rejectedBy?: string;
  rejectionReason?: string;
  createdByUserId?: string;
  expectedVersion?: number;
}) {
  const prisma = getWipPrisma();
  try {
    const transferRow = await prisma.$transaction(
      async (tx: any) => {
        const tr = await tx.productionTransfer.findFirst({
          where: { OR: [{ id: params.transferId }, { transferNumber: params.transferId }] },
          include: {
            manufacturingOrder: { include: MO_INCLUDE },
            part: { include: { unit: true } },
          },
        });
        if (!tr) throw new WipServiceError('حواله انتقال یافت نشد.', 404);
        if (tr.status !== 'DISPATCHED') {
          throw new WipServiceError('امکان رد این حواله وجود ندارد (قبلاً تعیین تکلیف شده است).', 409, true);
        }
        if (params.expectedVersion != null && tr.version !== params.expectedVersion) {
          throw new WipServiceError('وضعیت این حواله هم‌زمان تغییر کرده است؛ اطلاعات را تازه‌سازی کنید.', 409, true);
        }

        const mo = tr.manufacturingOrder;
        assertMoMutable(mo);
        const fromOp = tr.fromStageOperationId
          ? mo.operations.find((o: any) => o.id === tr.fromStageOperationId)
          : null;
        if (!fromOp) throw new WipServiceError('مرحله مبدأ یافت نشد.', 404);

        const qty = num(tr.quantity);
        const now = new Date();
        const postingUser = await resolvePostingUser(tx, params.createdByUserId);
        const unitWeightKg = num(tr.part.weightNetKg);

        const fromLoc = tr.fromLocationId
          ? await tx.warehouseLocation.findUnique({ where: { id: tr.fromLocationId }, include: { warehouse: true } })
          : await resolveLocationByCodeOrId(
              tx,
              fromOp.warehouseLocationCode || getLocationForProcess(fromOp.operation.processType, fromOp.stepNumber),
            );
        const destLoc = tr.toLocationId
          ? await tx.warehouseLocation.findUnique({ where: { id: tr.toLocationId }, include: { warehouse: true } })
          : await resolveOutputDestination(tx, mo, tr.part);

        if (!fromLoc || !destLoc) {
          throw new WipServiceError('موقعیت انبار مبدأ یا مقصد حواله یافت نشد.', 400);
        }

        // Strictly verify transfer/MO-scoped IN_TRANSIT stock BEFORE mutating any record (zero stock minting)
        const scopedInTransit = await resolveMoScopedBalancesInTx(tx, {
          moId: mo.id,
          partId: tr.partId,
          warehouseId: destLoc.warehouseId,
          locationId: destLoc.id,
          qualityStatus: 'IN_TRANSIT',
          documentId: tr.inventoryDocId || null,
        });
        const totalInTransitAvail = scopedInTransit.reduce((s: number, item) => s + item.allowedQty, 0);
        if (totalInTransitAvail + 1e-6 < qty) {
          throw new WipServiceError(
            `موجودی در راه (IN_TRANSIT) متعلق به حواله ${tr.transferNumber} در موقعیت ${destLoc.code} (${totalInTransitAvail}) برای رد و عودت (${qty}) کافی نیست؛ هیچ تغییری اعمال نشد.`,
            409,
            true,
          );
        }

        const trCas = await tx.productionTransfer.updateMany({
          where: { id: tr.id, status: 'DISPATCHED', version: tr.version },
          data: {
            status: 'REJECTED',
            rejectedByUserId: postingUser.id,
            rejectedByName: params.rejectedBy || 'بازرس کنترل کیفیت',
            rejectedAt: now,
            rejectionReason: params.rejectionReason || 'مغایرت تعداد یا عدم انطباق کیفی در ورودی',
            version: { increment: 1 },
          },
        });
        if (trCas.count !== 1) {
          throw new WipServiceError('این حواله هم‌زمان تغییر یافته است.', 409, true);
        }

        const fromOpCas = await tx.productionOperation.updateMany({
          where: {
            id: fromOp.id,
            version: fromOp.version,
            transferredQty: { gte: Math.max(0, qty - 1e-6) },
          },
          data: {
            readyForTransferQty: { increment: qty },
            transferredQty: { decrement: qty },
            status: fromOp.status === 'COMPLETED' ? 'READY' : fromOp.status,
            lastActivityAt: now,
            version: { increment: 1 },
          },
        });
        if (fromOpCas.count !== 1) {
          throw new WipServiceError('وضعیت یا مقدار انتقال‌یافته مرحله مبدأ هم‌زمان تغییر کرده است؛ رد حواله لغو شد.', 409, true);
        }

        const moCas = await tx.manufacturingOrder.updateMany({
          where: { id: mo.id, version: mo.version, status: { notIn: ['CANCELLED', 'CLOSED'] } },
          data: { version: { increment: 1 } },
        });
        if (moCas.count !== 1) {
          throw new WipServiceError('وضعیت یا نسخه دستور تولید هم‌زمان تغییر کرده است؛ رد حواله لغو شد.', 409, true);
        }

        const doc = await tx.inventoryDocument.create({
          data: {
            documentNumber: `REJ-${tr.transferNumber}-${Date.now()}`,
            documentType: 'WIP_TRANSFER',
            documentDate: now,
            documentStatus: 'CONFIRMED',
            postingStatus: 'POSTED',
            warehouseId: destLoc.warehouseId,
            targetWarehouseId: fromLoc.warehouseId,
            referenceType: 'MANUFACTURING_ORDER',
            referenceNumber: mo.moNumber,
            createdByUserId: postingUser.id,
            postedByUserId: postingUser.id,
            postedAt: now,
            notes: `عودت حواله ${tr.transferNumber}: ${params.rejectionReason || ''}`,
          },
        });

        const primaryInTransit = scopedInTransit[0]?.balance;
        const docLine = await tx.inventoryDocumentLine.create({
          data: {
            documentId: doc.id,
            lineNumber: 1,
            partId: tr.partId,
            productionOperationId: fromOp.id,
            locationId: destLoc.id,
            targetLocationId: fromLoc.id,
            quantity: qty,
            unitId: tr.part.unitId,
            weightKg: round6(qty * unitWeightKg),
            ownership: primaryInTransit?.ownership || 'COMPANY_OWNED',
            contractId: primaryInTransit?.contractId || null,
            contractNumber: primaryInTransit?.contractNumber || null,
            qualityStatus: 'AVAILABLE',
          },
        });

        let remaining = qty;
        let trxIdx = 0;
        for (const scoped of scopedInTransit) {
          if (remaining <= 1e-9) break;
          const sb = scoped.balance;
          const take = Math.min(remaining, scoped.allowedQty);
          if (take <= 1e-9) continue;
          const takeWeight = round6(take * unitWeightKg);

          const inTransitAfter = await decrementInTransitBalance(tx, { sb, take, takeWeight, now });
          trxIdx += 1;
          await tx.inventoryTransaction.create({
            data: {
              transactionNumber: `${tr.transferNumber}-REJ-OUT-${trxIdx}`,
              documentId: doc.id,
              documentLineId: docLine.id,
              partId: tr.partId,
              materialLotId: sb.materialLotId,
              physicalCoilId: sb.physicalCoilId,
              productionOperationId: fromOp.id,
              warehouseId: destLoc.warehouseId,
              locationId: destLoc.id,
              transactionType: 'TRANSFER_OUT',
              quantity: take,
              quantitySigned: -take,
              unitId: tr.part.unitId,
              weightKg: takeWeight,
              weightKgSigned: -takeWeight,
              ownership: sb.ownership,
              contractId: sb.contractId,
              contractNumber: sb.contractNumber,
              qualityStatus: 'IN_TRANSIT',
              balanceAfter: inTransitAfter.quantityAfter,
              balanceKgAfter: inTransitAfter.weightAfter,
              transactionDate: now,
              postingStatus: 'POSTED',
              createdByUserId: postingUser.id,
              manufacturingOrderId: mo.id,
            },
          });

          const srcAvailAfter = await adjustStockBalance(tx, {
            partId: tr.partId,
            warehouseId: fromLoc.warehouseId,
            locationId: fromLoc.id,
            materialLotId: sb.materialLotId,
            physicalCoilId: sb.physicalCoilId,
            ownership: sb.ownership,
            contractId: sb.contractId,
            contractNumber: sb.contractNumber,
            qualityStatus: 'AVAILABLE',
            quantity: take,
            weightKg: takeWeight,
            direction: 1,
            now,
          });
          trxIdx += 1;
          await tx.inventoryTransaction.create({
            data: {
              transactionNumber: `${tr.transferNumber}-REJ-IN-${trxIdx}`,
              documentId: doc.id,
              documentLineId: docLine.id,
              partId: tr.partId,
              materialLotId: sb.materialLotId,
              physicalCoilId: sb.physicalCoilId,
              productionOperationId: fromOp.id,
              warehouseId: fromLoc.warehouseId,
              locationId: fromLoc.id,
              transactionType: 'TRANSFER_IN',
              quantity: take,
              quantitySigned: take,
              unitId: tr.part.unitId,
              weightKg: takeWeight,
              weightKgSigned: takeWeight,
              ownership: sb.ownership,
              contractId: sb.contractId,
              contractNumber: sb.contractNumber,
              qualityStatus: 'AVAILABLE',
              balanceAfter: srcAvailAfter.quantityAfter,
              balanceKgAfter: srcAvailAfter.weightAfter,
              transactionDate: now,
              postingStatus: 'POSTED',
              createdByUserId: postingUser.id,
              manufacturingOrderId: mo.id,
            },
          });

          remaining = round6(remaining - take);
        }

        if (remaining > 1e-5) {
          throw new WipServiceError('تخصیص موجودی در راه (IN_TRANSIT) برای رد حواله کامل نشد.', 409, true);
        }

        await tx.productionActivityLog.create({
          data: {
            manufacturingOrderId: mo.id,
            moNumber: mo.moNumber,
            partId: tr.partId,
            productionOperationId: fromOp.id,
            stepNumber: fromOp.stepNumber,
            stepName: fromOp.stepName || fromOp.operation.name,
            activityType: 'TRANSFER_REJECT',
            quantity: qty,
            operatorName: params.rejectedBy || 'بازرس کنترل کیفیت',
            transferId: tr.id,
            timestamp: now,
            notes: `رد و عودت حواله ${tr.transferNumber}: ${params.rejectionReason || ''}`,
          },
        });

        return tx.productionTransfer.findUnique({
          where: { id: tr.id },
          include: {
            manufacturingOrder: { select: { id: true, moNumber: true } },
            part: { select: { id: true, partNumber: true, name: true } },
            fromWarehouse: { select: { id: true, code: true, name: true } },
            toWarehouse: { select: { id: true, code: true, name: true } },
            fromLocation: { select: { id: true, code: true } },
            toLocation: { select: { id: true, code: true } },
          },
        });
      },
      { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 },
    );

    await syncWipReadCacheFromPostgres();
    return mapRelationalTransferToDto(transferRow);
  } catch (err) {
    wrapWipTxError(err);
  }
}

async function collectMoTreeDb(tx: any, rootMoIdOrNumber: string, cascadeSubMos: boolean) {
  let root = await tx.manufacturingOrder.findFirst({
    where: { OR: [{ id: rootMoIdOrNumber }, { moNumber: rootMoIdOrNumber }] },
    include: MO_INCLUDE,
  });
  if (!root) {
    const link = await tx.wipManufacturingOrderLink.findUnique({
      where: { wipManufacturingOrderId: rootMoIdOrNumber },
      select: { manufacturingOrderId: true },
    });
    if (link) {
      root = await tx.manufacturingOrder.findUnique({
        where: { id: link.manufacturingOrderId },
        include: MO_INCLUDE,
      });
    }
  }
  if (!root) return null;

  const tree = [root];
  if (cascadeSubMos) {
    const seen = new Set<string>([root.id]);
    const queue = [root.id];
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      const children = await tx.manufacturingOrder.findMany({
        where: { parentMoId: parentId },
        include: MO_INCLUDE,
      });
      for (const child of children) {
        if (!seen.has(child.id)) {
          seen.add(child.id);
          tree.push(child);
          queue.push(child.id);
        }
      }
    }
  }
  return { root, tree };
}

async function analyzeMoRollbackImpactInTx(tx: any, moIdOrNumber: string, cascadeSubMos: boolean) {
  const collected = await collectMoTreeDb(tx, moIdOrNumber, cascadeSubMos);
  if (!collected) return null;

  const { root, tree } = collected;
  const moIds = tree.map((m: any) => m.id);
  const moNumbers = tree.map((m: any) => m.moNumber);
  const opIds = tree.flatMap((m: any) => (m.operations || []).map((o: any) => o.id));

  const linkedDocs = await tx.inventoryDocument.findMany({
    where: {
      isReversed: false,
      documentStatus: { not: 'CANCELLED' },
      postingStatus: { not: 'REVERSED' },
      OR: [
        { referenceNumber: { in: [...moNumbers, ...moIds] } },
        ...(opIds.length > 0 ? [{ lines: { some: { productionOperationId: { in: opIds } } } }] : []),
      ],
    },
    include: {
      warehouse: true,
      lines: { include: { part: true, unit: true, materialLot: true } },
    },
  });

  const linkedDocIds = linkedDocs.map((d: any) => d.id);

  // Gather ALL posted non-reversal InventoryTransactions linked to this MO tree or its documents
  const rawMoTxs = await tx.inventoryTransaction.findMany({
    where: {
      postingStatus: 'POSTED',
      isReversal: false,
      OR: [
        { manufacturingOrderId: { in: moIds } },
        ...(linkedDocIds.length > 0 ? [{ documentId: { in: linkedDocIds } }] : []),
      ],
    },
    include: {
      part: { include: { unit: true } },
      warehouse: true,
      location: true,
      materialLot: true,
    },
    orderBy: [{ transactionDate: 'desc' }, { createdAt: 'desc' }],
  });

  // Deduplicate by ID and exclude any transaction that already has a POSTED reversal row
  const txById = new Map<string, any>();
  for (const t of rawMoTxs) {
    txById.set(t.id, t);
  }
  const candidateTxs = Array.from(txById.values());
  const candidateIds = candidateTxs.map(t => t.id);

  let alreadyReversedIds = new Set<string>();
  if (candidateIds.length > 0) {
    const existingReversals = await tx.inventoryTransaction.findMany({
      where: {
        reversalOfTrxId: { in: candidateIds },
        postingStatus: 'POSTED',
      },
      select: { reversalOfTrxId: true },
    });
    alreadyReversedIds = new Set(
      existingReversals.map((r: any) => r.reversalOfTrxId).filter(Boolean),
    );
  }

  const moTxsToReverse = candidateTxs.filter(t => !alreadyReversedIds.has(t.id));

  const postedIssues = linkedDocs.filter(
    (d: any) => d.postingStatus === 'POSTED' && !['RECEIPT', 'INITIAL_BALANCE', 'RETURN'].includes(d.documentType),
  );
  const postedReceipts = linkedDocs.filter(
    (d: any) => d.postingStatus === 'POSTED' && d.documentType === 'RECEIPT',
  );
  const draftDocs = linkedDocs.filter((d: any) => d.postingStatus !== 'POSTED');

  const materialsToReturn: any[] = [];
  for (const doc of postedIssues) {
    for (const line of doc.lines || []) {
      const qty = num(line.quantity);
      if (qty <= 0) continue;
      materialsToReturn.push({
        documentId: doc.id,
        documentNumber: doc.documentNumber,
        partId: line.partId,
        partCode: line.part.partNumber,
        partName: line.part.name,
        quantity: qty,
        quantityKg: num(line.weightKg),
        unit: line.unit.code,
        warehouseId: doc.warehouseId,
        warehouseName: doc.warehouse.name,
        lotNumber: line.materialLot?.lotNumber,
      });
    }
  }

  // Group net reversal deltas across EVERY exact StockBalance key (catches RECEIPT docs,
  // postWipProductionDb outputs without documentId, WIP transfers, and scrap balances!)
  const netByStockKey = new Map<
    string,
    {
      sample: any;
      netDeltaQty: number;
      netDeltaWeight: number;
    }
  >();

  for (const trx of moTxsToReverse) {
    const signedQty = num(trx.quantitySigned);
    const signedWeight = num(trx.weightKgSigned);
    if (Math.abs(signedQty) <= 1e-9 && Math.abs(signedWeight) <= 1e-9) continue;
    const key = buildStockKey(trx);
    const existing = netByStockKey.get(key);
    if (existing) {
      existing.netDeltaQty = round6(existing.netDeltaQty - signedQty);
      existing.netDeltaWeight = round6(existing.netDeltaWeight - signedWeight);
    } else {
      netByStockKey.set(key, {
        sample: trx,
        netDeltaQty: round6(-signedQty),
        netDeltaWeight: round6(-signedWeight),
      });
    }
  }

  const outputsToDeduct: any[] = [];
  const blockingErrors: string[] = [];

  for (const [, entry] of netByStockKey) {
    const { sample, netDeltaQty, netDeltaWeight } = entry;
    const existingBal = await tx.stockBalance.findFirst({
      where: {
        partId: sample.partId,
        warehouseId: sample.warehouseId,
        locationId: sample.locationId,
        materialLotId: sample.materialLotId,
        physicalCoilId: sample.physicalCoilId,
        ownership: sample.ownership,
        contractId: sample.contractId,
        qualityStatus: sample.qualityStatus,
      },
    });

    const curOnHand = existingBal ? num(existingBal.quantityOnHand) : 0;
    const curAvail = existingBal ? num(existingBal.quantityAvailable) : 0;
    const curWeightOnHand = existingBal ? num(existingBal.weightKgOnHand) : 0;
    const curWeightAvail = existingBal ? num(existingBal.weightKgAvailable) : 0;

    const afterOnHand = round6(curOnHand + netDeltaQty);
    const afterAvail = sample.qualityStatus === 'AVAILABLE' ? round6(curAvail + netDeltaQty) : curAvail;
    const afterWeightOnHand = round6(curWeightOnHand + netDeltaWeight);
    const afterWeightAvail = sample.qualityStatus === 'AVAILABLE' ? round6(curWeightAvail + netDeltaWeight) : curWeightAvail;

    const effectiveAvail = sample.qualityStatus === 'AVAILABLE' ? Math.min(curOnHand, curAvail) : curOnHand;
    const qtyToDeduct = netDeltaQty < -1e-6 ? round6(Math.abs(netDeltaQty)) : 0;
    const qtyShortage = Math.max(0, round6(qtyToDeduct - effectiveAvail));

    const hasNegativeBalance =
      afterOnHand < -1e-5 ||
      afterAvail < -1e-5 ||
      afterWeightOnHand < -1e-5 ||
      afterWeightAvail < -1e-5;

    if (qtyToDeduct > 1e-6 || hasNegativeBalance) {
      const partCode = sample.part?.partNumber || sample.partId;
      const partName = sample.part?.name || partCode;
      const whName = sample.warehouse?.name || sample.warehouseId;
      const locCode = sample.location?.code || sample.locationId || '-';
      outputsToDeduct.push({
        documentId: sample.documentId || null,
        documentNumber: sample.transactionNumber,
        partId: sample.partId,
        partCode,
        partName,
        quantity: qtyToDeduct,
        quantityKg: netDeltaWeight < -1e-6 ? round6(Math.abs(netDeltaWeight)) : 0,
        unit: sample.part?.unit?.code || 'PCS',
        warehouseId: sample.warehouseId,
        warehouseName: whName,
        locationCode: locCode,
        qualityStatus: sample.qualityStatus,
        lotNumber: sample.materialLot?.lotNumber,
        availableAfterIssueReturn: effectiveAvail,
        shortage: qtyShortage,
      });

      if (hasNegativeBalance) {
        blockingErrors.push(
          `خروجی/موجودی «${partName} (${partCode})» در انبار «${whName}» (موقعیت ${locCode}، وضعیت ${sample.qualityStatus}) به مقدار ${qtyToDeduct} پس از تولید مصرف، منتقل یا رزرو شده است (موجودی قابل کسر: ${effectiveAvail}؛ کسری: ${qtyShortage}).`,
        );
      }
    }
  }

  const [transfersCount, logsCount, reservationsCount, txsCount] = await Promise.all([
    tx.productionTransfer.count({ where: { manufacturingOrderId: { in: moIds } } }),
    tx.productionActivityLog.count({ where: { manufacturingOrderId: { in: moIds } } }),
    tx.inventoryReservation.count({ where: { reservedForMOId: { in: moIds } } }),
    tx.inventoryTransaction.count({ where: { manufacturingOrderId: { in: moIds } } }),
  ]);

  return {
    root,
    tree,
    rootMo: mapRelationalMoToWipDto(root),
    treeDtos: tree.map(mapRelationalMoToWipDto),
    moIds,
    moNumbers,
    opIds,
    linkedDocs,
    moTxsToReverse,
    postedIssues,
    postedReceipts,
    draftDocs,
    materialsToReturn,
    outputsToDeduct,
    transfersCount,
    logsCount,
    reservationsCount,
    txsCount,
    blockingErrors,
  };
}

export async function analyzeMoRollbackImpactDb(moIdOrNumber: string, cascadeSubMos = true) {
  const prisma = getWipPrisma();
  const impact = await analyzeMoRollbackImpactInTx(prisma, moIdOrNumber, cascadeSubMos);
  if (!impact) return null;

  return {
    rootMo: impact.rootMo,
    tree: impact.treeDtos,
    moIds: impact.moIds,
    moNumbers: impact.moNumbers,
    opIds: impact.opIds,
    postedIssues: impact.postedIssues,
    postedReceipts: impact.postedReceipts,
    draftDocs: impact.draftDocs,
    materialsToReturn: impact.materialsToReturn,
    outputsToDeduct: impact.outputsToDeduct,
    transfersCount: impact.transfersCount,
    logsCount: impact.logsCount,
    reservationsCount: impact.reservationsCount,
    txsCount: impact.txsCount,
    blockingErrors: impact.blockingErrors,
    canRollback: impact.blockingErrors.length === 0,
  };
}

export async function deleteManufacturingOrderWithRollbackDb(params: {
  moIdOrNumber: string;
  cascadeSubMos: boolean;
  reason: string;
  requestedUserId?: string;
}) {
  const prisma = getWipPrisma();
  try {
    const summary = await prisma.$transaction(
      async (tx: any) => {
        // Re-evaluate full rollback impact atomically inside the Serializable tx (closes TOCTOU races)
        const impact = await analyzeMoRollbackImpactInTx(tx, params.moIdOrNumber, params.cascadeSubMos);
        if (!impact) {
          throw new WipServiceError('دستور تولید مورد نظر جهت حذف یافت نشد.', 404);
        }
        if (impact.blockingErrors.length > 0) {
          throw new WipServiceError(
            `امکان حذف و بازگشت دستور تولید وجود ندارد: ${impact.blockingErrors.join(' | ')}`,
            409,
            true,
          );
        }

        const { root, moIds, moNumbers, opIds, linkedDocs, moTxsToReverse, outputsToDeduct } = impact;
        const now = new Date();
        const postingUser = await resolvePostingUser(tx, params.requestedUserId);

        // Apply positive reversal deltas (+delta) BEFORE negative reversal deltas (-delta) so that
        // intermediate StockBalance steps never dip below zero when reversing paired movements.
        const orderedReversals = [...moTxsToReverse].sort((a: any, b: any) => {
          const da = -num(a.quantitySigned);
          const db = -num(b.quantitySigned);
          if (da > 0 && db <= 0) return -1;
          if (da <= 0 && db > 0) return 1;
          return 0;
        });

        for (const trx of orderedReversals) {
          const signedQty = num(trx.quantitySigned);
          const signedWeight = num(trx.weightKgSigned);
          if (Math.abs(signedQty) <= 1e-9 && Math.abs(signedWeight) <= 1e-9) continue;

          const existingBal = await tx.stockBalance.findFirst({
            where: {
              partId: trx.partId,
              warehouseId: trx.warehouseId,
              locationId: trx.locationId,
              materialLotId: trx.materialLotId,
              physicalCoilId: trx.physicalCoilId,
              ownership: trx.ownership,
              contractId: trx.contractId,
              qualityStatus: trx.qualityStatus,
            },
          });

          const deltaQty = round6(-signedQty);
          const deltaWeight = round6(-signedWeight);
          let balanceAfter = 0;
          let balanceKgAfter = 0;

          if (existingBal) {
            const rawOnHand = round6(num(existingBal.quantityOnHand) + deltaQty);
            const rawAvail =
              trx.qualityStatus === 'AVAILABLE'
                ? round6(num(existingBal.quantityAvailable) + deltaQty)
                : num(existingBal.quantityAvailable);
            const rawWeightOnHand = round6(num(existingBal.weightKgOnHand) + deltaWeight);
            const rawWeightAvail =
              trx.qualityStatus === 'AVAILABLE'
                ? round6(num(existingBal.weightKgAvailable) + deltaWeight)
                : num(existingBal.weightKgAvailable);

            // Fail closed — NEVER clamp real negative stock discrepancies to zero
            if (
              rawOnHand < -1e-5 ||
              rawAvail < -1e-5 ||
              rawWeightOnHand < -1e-5 ||
              rawWeightAvail < -1e-5
            ) {
              throw new WipServiceError(
                `عدم تطابق مانده انبار هنگام ابطال تراکنش ${trx.transactionNumber}: مانده پس از ابطال منفی می‌شود (مقدار=${rawOnHand}، آزاد=${rawAvail}، وزن=${rawWeightOnHand}).`,
                409,
                true,
              );
            }

            const nextOnHand = rawOnHand < 0 ? 0 : rawOnHand;
            const nextAvail = rawAvail < 0 ? 0 : rawAvail;
            const nextW = rawWeightOnHand < 0 ? 0 : rawWeightOnHand;
            const nextWAvail = rawWeightAvail < 0 ? 0 : rawWeightAvail;

            await tx.stockBalance.update({
              where: { id: existingBal.id },
              data: {
                quantityOnHand: nextOnHand,
                quantityAvailable: nextAvail,
                weightKgOnHand: nextW,
                weightKgAvailable: nextWAvail,
                lastTransactionAt: now,
              },
            });
            balanceAfter = nextOnHand;
            balanceKgAfter = nextW;
          } else {
            if (deltaQty < -1e-5 || deltaWeight < -1e-5) {
              throw new WipServiceError(
                `ردیف مانده موجودی برای کسر جبرانی تراکنش ${trx.transactionNumber} یافت نشد؛ عملیات ابطال لغو شد.`,
                409,
                true,
              );
            }
            const safeQty = deltaQty < 0 ? 0 : deltaQty;
            const safeWeight = deltaWeight < 0 ? 0 : deltaWeight;
            await tx.stockBalance.create({
              data: {
                partId: trx.partId,
                warehouseId: trx.warehouseId,
                locationId: trx.locationId,
                materialLotId: trx.materialLotId,
                physicalCoilId: trx.physicalCoilId,
                ownership: trx.ownership,
                contractId: trx.contractId,
                contractNumber: trx.contractNumber,
                qualityStatus: trx.qualityStatus,
                quantityOnHand: safeQty,
                quantityReserved: 0,
                quantityAvailable: trx.qualityStatus === 'AVAILABLE' ? safeQty : 0,
                weightKgOnHand: safeWeight,
                weightKgReserved: 0,
                weightKgAvailable: trx.qualityStatus === 'AVAILABLE' ? safeWeight : 0,
                lastTransactionAt: now,
              },
            });
            balanceAfter = safeQty;
            balanceKgAfter = safeWeight;
          }

          // Create offsetting POSTED reversal entry while keeping original entry POSTED
          // so SUM(quantitySigned WHERE postingStatus = 'POSTED') === StockBalance is conserved!
          await tx.inventoryTransaction.create({
            data: {
              transactionNumber: `REV-${trx.transactionNumber}-${randomUUID().slice(0, 4).toUpperCase()}`,
              documentId: trx.documentId,
              partId: trx.partId,
              materialLotId: trx.materialLotId,
              physicalCoilId: trx.physicalCoilId,
              warehouseId: trx.warehouseId,
              locationId: trx.locationId,
              transactionType: deltaQty >= 0 ? 'ADJUSTMENT_POS' : 'ADJUSTMENT_NEG',
              quantity: Math.abs(deltaQty),
              quantitySigned: deltaQty,
              unitId: trx.unitId,
              weightKg: Math.abs(deltaWeight),
              weightKgSigned: deltaWeight,
              ownership: trx.ownership,
              contractId: trx.contractId,
              contractNumber: trx.contractNumber,
              qualityStatus: trx.qualityStatus,
              balanceAfter,
              balanceKgAfter,
              transactionDate: now,
              postingStatus: 'POSTED',
              isReversal: true,
              reversalOfTrxId: trx.id,
              createdByUserId: postingUser.id,
            },
          });

          // Detach FK links before deleting MO/op/report, but KEEP postingStatus = 'POSTED'
          await tx.inventoryTransaction.update({
            where: { id: trx.id },
            data: {
              manufacturingOrderId: null,
              productionOperationId: null,
              productionReportId: null,
            },
          });
        }

        // Restore PhysicalCoil & MaterialLot weights for BOTH CoilIssueReturnRecord issues
        // AND performBackedMaterialLoadInTx raw-material issues (zero double-restoration)
        const coilRecords = await tx.coilIssueReturnRecord.findMany({
          where: { manufacturingOrderId: { in: moIds } },
        });
        const coilRecordDocIds = new Set<string>();
        const restoreKgByCoilId = new Map<string, number>();
        const restoreKgByLotId = new Map<string, number>();

        for (const rec of coilRecords) {
          if (rec.inventoryDocumentId) coilRecordDocIds.add(rec.inventoryDocumentId);
          const netIssuedKg = round6(Math.max(0, num(rec.issuedWeightKg) - num(rec.returnedWeightKg)));
          if (netIssuedKg > 1e-9 && rec.coilId) {
            restoreKgByCoilId.set(rec.coilId, round6((restoreKgByCoilId.get(rec.coilId) || 0) + netIssuedKg));
            const coilRow = await tx.physicalCoil.findUnique({
              where: { id: rec.coilId },
              select: { materialLotId: true },
            });
            if (coilRow?.materialLotId) {
              restoreKgByLotId.set(
                coilRow.materialLotId,
                round6((restoreKgByLotId.get(coilRow.materialLotId) || 0) + netIssuedKg),
              );
            }
          }
        }

        for (const trx of moTxsToReverse) {
          if (
            trx.transactionType === 'OUTBOUND' &&
            trx.productionReportId == null &&
            num(trx.weightKgSigned) < -1e-9 &&
            (!trx.documentId || !coilRecordDocIds.has(trx.documentId))
          ) {
            const restoreKg = round6(Math.abs(num(trx.weightKgSigned)));
            if (trx.physicalCoilId) {
              restoreKgByCoilId.set(
                trx.physicalCoilId,
                round6((restoreKgByCoilId.get(trx.physicalCoilId) || 0) + restoreKg),
              );
            }
            if (trx.materialLotId) {
              restoreKgByLotId.set(
                trx.materialLotId,
                round6((restoreKgByLotId.get(trx.materialLotId) || 0) + restoreKg),
              );
            }
          }
        }

        for (const [coilId, restoreKg] of restoreKgByCoilId) {
          if (restoreKg <= 1e-9) continue;
          const coil = await tx.physicalCoil.findUnique({ where: { id: coilId } });
          if (!coil) continue;
          const origWeight = num(coil.originalWeightKg);
          const nextRemaining = round6(num(coil.remainingWeightKg) + restoreKg);
          if (origWeight > 0 && nextRemaining > origWeight + 1e-4) {
            throw new WipServiceError(
              `بازگشت وزن کلاف ${coil.coilId} (${nextRemaining} kg) از وزن اولیه (${origWeight} kg) بیشتر می‌شود؛ ابطال لغو شد.`,
              409,
              true,
            );
          }
          const safeRemaining = origWeight > 0 ? Math.min(origWeight, nextRemaining) : nextRemaining;
          const nextStatus =
            origWeight > 0 && safeRemaining < origWeight - 1e-4 ? 'PARTIALLY_ISSUED' : 'AVAILABLE';
          await tx.physicalCoil.update({
            where: { id: coil.id },
            data: {
              remainingWeightKg: safeRemaining,
              physicalStatus: nextStatus,
            },
          });
        }

        for (const [lotId, restoreKg] of restoreKgByLotId) {
          if (restoreKg <= 1e-9) continue;
          const lot = await tx.materialLot.findUnique({ where: { id: lotId } });
          if (!lot) continue;
          const initWeight = num(lot.initialWeightKg);
          const nextRemaining = round6(num(lot.remainingWeightKg) + restoreKg);
          if (initWeight > 0 && nextRemaining > initWeight + 1e-4) {
            throw new WipServiceError(
              `بازگشت وزن لات ${lot.lotNumber} (${nextRemaining} kg) از وزن اولیه (${initWeight} kg) بیشتر می‌شود؛ ابطال لغو شد.`,
              409,
              true,
            );
          }
          const safeRemaining = initWeight > 0 ? Math.min(initWeight, nextRemaining) : nextRemaining;
          await tx.materialLot.update({
            where: { id: lot.id },
            data: {
              remainingWeightKg: safeRemaining,
              status: 'AVAILABLE',
            },
          });
        }

        await tx.coilIssueReturnRecord.deleteMany({ where: { manufacturingOrderId: { in: moIds } } });

        const reversalDocumentNumbers: string[] = [];
        let draftsCancelled = 0;
        for (const doc of linkedDocs) {
          if (doc.postingStatus === 'POSTED') {
            await tx.inventoryDocument.update({
              where: { id: doc.id },
              data: {
                isReversed: true,
                postingStatus: 'REVERSED',
                notes: `${doc.notes ? doc.notes + ' | ' : ''}ابطال بابت حذف ${root.moNumber}: ${params.reason}`,
              },
            });
            reversalDocumentNumbers.push(doc.documentNumber);
          } else {
            await tx.inventoryDocument.update({
              where: { id: doc.id },
              data: {
                documentStatus: 'CANCELLED',
                notes: `${doc.notes ? doc.notes + ' | ' : ''}لغو بابت حذف ${root.moNumber}: ${params.reason}`,
              },
            });
            draftsCancelled += 1;
          }
        }

        for (const mId of moIds) {
          await releaseMoReservationsInTx(tx, mId, {
            reason: params.reason,
            now,
            prismaUserId: postingUser.id,
          });
        }
        const reservationsRes = await tx.inventoryReservation.deleteMany({ where: { reservedForMOId: { in: moIds } } });
        await tx.inventoryDocumentLine.updateMany({
          where: { productionOperationId: { in: opIds } },
          data: { productionOperationId: null },
        });
        await tx.productionScrap.deleteMany({ where: { productionOperationId: { in: opIds } } });
        await tx.machineAssignment.deleteMany({ where: { productionOperationId: { in: opIds } } });
        await tx.productionReport.deleteMany({ where: { manufacturingOrderId: { in: moIds } } });
        const transfersRes = await tx.productionTransfer.deleteMany({ where: { manufacturingOrderId: { in: moIds } } });
        const logsRes = await tx.productionActivityLog.deleteMany({ where: { manufacturingOrderId: { in: moIds } } });

        if (opIds.length > 0) {
          await tx.wipOperationLink.deleteMany({ where: { productionOperationId: { in: opIds } } });
        }
        await tx.wipManufacturingOrderLink.deleteMany({ where: { manufacturingOrderId: { in: moIds } } });
        await tx.productionOperation.deleteMany({ where: { manufacturingOrderId: { in: moIds } } });
        await tx.manufacturingOrder.deleteMany({ where: { id: { in: moIds } } });

        await tx.auditLog.create({
          data: {
            userId: postingUser.id,
            action: 'CASCADE_DELETE_MO_ROLLBACK',
            entityName: 'ManufacturingOrder',
            entityId: root.id,
            newValues: {
              deletedMoNumbers: moNumbers,
              reason: params.reason,
              reversalDocumentNumbers,
              restoredCoils: Array.from(restoreKgByCoilId.entries()),
              restoredLots: Array.from(restoreKgByLotId.entries()),
            },
          },
        });

        return {
          rootMoNumber: root.moNumber,
          deletedMoNumbers: moNumbers,
          deletedMoCount: moIds.length,
          deletedTransfersCount: transfersRes.count,
          deletedLogsCount: logsRes.count,
          reversalDocumentsCount: reversalDocumentNumbers.length,
          reversalDocumentNumbers,
          draftsCancelled,
          reservationsRemoved: reservationsRes.count,
          transactionsRemoved: moTxsToReverse.length,
          materialsReturnedCount: impact.materialsToReturn.length,
          outputsDeductedCount: outputsToDeduct.length,
        };
      },
      { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 },
    );

    await syncWipReadCacheFromPostgres();
    return summary;
  } catch (err) {
    wrapWipTxError(err);
  }
}
