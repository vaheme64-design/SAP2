import { randomUUID } from 'node:crypto';
import {
  __getProductionWipPrisma,
  WipServiceError,
  assertMachineEligibleForOpInTx,
  isOperationPausedInTx,
  postWipProductionDb,
  resolvePostingUser,
  syncWipReadCacheFromPostgres,
} from './services/productionWipService';
import { releaseMoReservationsInTx } from './services/inventoryLedgerService';

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const round1 = (v: number): number => Math.round(v * 10) / 10;
const round2 = (v: number): number => Math.round(v * 100) / 100;
const round6 = (v: number): number => Math.round(v * 1_000_000) / 1_000_000;

export type ShopFloorExecutionState =
  | 'PENDING'
  | 'READY'
  | 'IN_PROGRESS'
  | 'PAUSED'
  | 'COMPLETED'
  | 'SKIPPED';

const OP_LIFECYCLE_TYPES = new Set(['OP_START', 'OP_PAUSE', 'OP_RESUME', 'OP_COMPLETE']);

function wrapShopFloorTxError(err: unknown): never {
  if (err instanceof WipServiceError) throw err;
  const code = String((err as any)?.code || '');
  if (code === 'P2034' || code === 'P2002') {
    throw new WipServiceError(
      'تداخل هم‌زمانی در تراکنش اجرای تولید رخ داد؛ لطفاً صفحه را تازه‌سازی و دوباره تلاش کنید.',
      409,
      true,
    );
  }
  throw err instanceof Error ? err : new Error(String(err));
}

function assertMutableMo(mo: { status: string; moNumber?: string }): void {
  if (mo.status === 'CANCELLED' || mo.status === 'CLOSED') {
    throw new WipServiceError(
      `دستور ساخت «${mo.moNumber || ''}» در وضعیت ${mo.status} قرار دارد و قابل اجرا نیست.`,
      409,
    );
  }
}

function validateIdempotencyKey(raw: unknown): string {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (key.length < 8 || key.length > 160) {
    throw new WipServiceError('کلید یکتای ثبت (idempotencyKey) با طول ۸ تا ۱۶۰ کاراکتر الزامی است.', 400);
  }
  return key;
}

async function safeFindMany(delegate: any, args: any): Promise<any[]> {
  if (!delegate || typeof delegate.findMany !== 'function') return [];
  const rows = await delegate.findMany(args);
  return Array.isArray(rows) ? rows : [];
}

async function findAuditIdempotencyMatch(
  tx: any,
  action: string,
  idempotencyKey: string,
): Promise<any | null> {
  if (typeof tx?.auditLog?.findMany !== 'function') return null;
  const rows = await tx.auditLog.findMany({
    where: { action },
    orderBy: [{ timestamp: 'desc' }],
  });
  return (rows || []).find((r: any) => r?.newValues?.idempotencyKey === idempotencyKey) || null;
}

function computeExecutionState(opStatus: string, logsForOp: any[]): {
  executionState: ShopFloorExecutionState;
  isPaused: boolean;
  lastPausedAt: string | null;
  lastPauseReason: string | null;
  lastPauseIsDowntime: boolean;
  actualStartedAt: string | null;
} {
  const sortedLogs = [...logsForOp].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
  const lifecycle = sortedLogs.filter(l => OP_LIFECYCLE_TYPES.has(String(l.activityType || '')));
  const latestLifecycle = lifecycle[0] || null;
  const startLog = [...lifecycle].reverse().find(l => l.activityType === 'OP_START') || null;
  const isPaused = opStatus === 'IN_PROGRESS' && latestLifecycle?.activityType === 'OP_PAUSE';
  const executionState: ShopFloorExecutionState = isPaused
    ? 'PAUSED'
    : ((opStatus as ShopFloorExecutionState) || 'PENDING');

  return {
    executionState,
    isPaused,
    lastPausedAt: isPaused && latestLifecycle ? new Date(latestLifecycle.timestamp).toISOString() : null,
    lastPauseReason: isPaused && latestLifecycle ? (latestLifecycle.notes || null) : null,
    lastPauseIsDowntime: false,
    actualStartedAt: startLog ? new Date(startLog.timestamp).toISOString() : null,
  };
}

const SHOP_FLOOR_MO_INCLUDE = {
  part: { include: { unit: true } },
  plan: { select: { id: true, planNumber: true, title: true, status: true, startDate: true, endDate: true } },
  planLine: {
    select: {
      id: true,
      plannedQty: true,
      producedQty: true,
      plannedStartDate: true,
      plannedEndDate: true,
      status: true,
      customerOrderLineId: true,
    },
  },
  operations: {
    include: {
      operation: true,
      plannedMachine: true,
      plannedDie: true,
      warehouse: true,
      location: true,
      assignments: {
        include: {
          machine: { select: { id: true, code: true, name: true, status: true, tonnageCapacity: true } },
          shift: { select: { id: true, code: true, name: true, startTime: true, endTime: true, productiveHours: true } },
          assignedOperator: { select: { id: true, fullName: true, personnelCode: true } },
        },
        orderBy: [{ assignedDate: 'asc' as const }, { createdAt: 'asc' as const }],
      },
    },
    orderBy: [{ sequence: 'asc' as const }, { stepNumber: 'asc' as const }],
  },
  coilIssueReturnRecords: true,
};

export async function getRelationalShopFloorBoard(filters?: {
  moId?: string;
  machineId?: string;
  shiftId?: string;
  executionState?: string;
  search?: string;
}) {
  const prisma = __getProductionWipPrisma();

  const [
    mosRaw,
    reportsRaw,
    activityLogsRaw,
    downtimeAuditsRaw,
    machinesRaw,
    shiftsRaw,
    usersRaw,
  ] = await Promise.all([
    safeFindMany(prisma.manufacturingOrder, {
      where: {
        status: { in: ['RELEASED', 'IN_PROGRESS', 'SUSPENDED', 'COMPLETED'] },
      },
      include: SHOP_FLOOR_MO_INCLUDE,
      orderBy: [{ priority: 'desc' }, { scheduledStartDate: 'asc' }, { createdAt: 'desc' }],
    }),
    safeFindMany(prisma.productionReport, {
      include: {
        manufacturingOrder: { select: { id: true, moNumber: true, part: { select: { partNumber: true, name: true } } } },
        productionOperation: { select: { id: true, stepNumber: true, stepCode: true, stepName: true } },
        machine: { select: { id: true, code: true, name: true } },
        shift: { select: { id: true, code: true, name: true } },
        operatorUser: { select: { id: true, fullName: true, personnelCode: true } },
      },
      orderBy: [{ reportDate: 'desc' }, { createdAt: 'desc' }],
      take: 250,
    }),
    safeFindMany(prisma.productionActivityLog, {
      orderBy: [{ timestamp: 'desc' }],
      take: 500,
    }),
    safeFindMany(prisma.auditLog, {
      where: {
        action: { in: ['SHOP_FLOOR_DOWNTIME', 'SHOP_FLOOR_OP_PAUSE', 'SHOP_FLOOR_PRODUCTION_REPORT'] },
      },
      orderBy: [{ timestamp: 'desc' }],
      take: 300,
    }),
    safeFindMany(prisma.machine, {
      include: {
        capabilities: { include: { operation: true } },
        dieCompatibilities: true,
      },
      orderBy: [{ code: 'asc' }],
    }),
    safeFindMany(prisma.shift, {
      where: { active: true },
      orderBy: [{ startTime: 'asc' }],
    }),
    safeFindMany(prisma.user, {
      select: { id: true, username: true, fullName: true, personnelCode: true, active: true },
      orderBy: [{ active: 'desc' }, { fullName: 'asc' }],
    }),
  ]);

  const logsByOpId = new Map<string, any[]>();
  for (const l of activityLogsRaw) {
    if (!l.productionOperationId) continue;
    logsByOpId.set(l.productionOperationId, [...(logsByOpId.get(l.productionOperationId) || []), l]);
  }

  const pauseAuditByOpId = new Map<string, any>();
  const reportAuditByReportId = new Map<string, any>();
  for (const a of downtimeAuditsRaw) {
    if (a.action === 'SHOP_FLOOR_OP_PAUSE' && a.entityId && !pauseAuditByOpId.has(a.entityId)) {
      pauseAuditByOpId.set(a.entityId, a);
    }
    if (a.action === 'SHOP_FLOOR_PRODUCTION_REPORT' && a.entityId && !reportAuditByReportId.has(a.entityId)) {
      reportAuditByReportId.set(a.entityId, a);
    }
  }

  // Filter machines eligible for each operation
  const machineList = machinesRaw.map((m: any) => ({
    id: m.id,
    code: m.code,
    name: m.name,
    hallLocation: m.hallLocation || 'سالن تولید',
    machineType: m.machineType,
    tonnageCapacity: m.tonnageCapacity != null ? num(m.tonnageCapacity) : null,
    status: m.status,
    active: Boolean(m.active),
    capabilities: (m.capabilities || []).map((c: any) => ({
      operationId: c.operationId,
      operationCode: c.operation?.code || '',
      processType: c.operation?.processType || '',
      minThicknessMm: c.minThicknessMm != null ? num(c.minThicknessMm) : null,
      maxThicknessMm: c.maxThicknessMm != null ? num(c.maxThicknessMm) : null,
      maxTonnage: c.maxTonnage != null ? num(c.maxTonnage) : null,
      isPreferred: Boolean(c.isPreferred),
    })),
    compatibleDieIds: (m.dieCompatibilities || []).map((dc: any) => dc.dieId),
  }));

  const hasCapabilitiesMaster = machineList.some(m => m.capabilities.length > 0);
  const machineById = new Map(machineList.map(m => [m.id, m]));

  const computeEligibleMachineIdsForOp = (op: any, part: any): string[] => {
    const reqTonnage = Math.max(
      num(op.routeOperation?.requiredTonnage),
      num(op.plannedDie?.tonnageRequired),
    );
    const thicknessMm = part?.thicknessMm != null ? num(part.thicknessMm) : null;
    return machineList
      .filter(m => {
        if (!m.active || m.status !== 'ACTIVE') return false;
        if (hasCapabilitiesMaster) {
          const cap = m.capabilities.find(
            (c: any) =>
              c.operationId === op.operationId ||
              (op.operation?.processType && c.processType === op.operation.processType),
          );
          if (!cap) return false;
          if (reqTonnage > 0 && ((m.tonnageCapacity != null && m.tonnageCapacity < reqTonnage) || (cap.maxTonnage != null && cap.maxTonnage < reqTonnage))) {
            return false;
          }
          if (thicknessMm != null) {
            if (cap.minThicknessMm != null && thicknessMm < cap.minThicknessMm) return false;
            if (cap.maxThicknessMm != null && thicknessMm > cap.maxThicknessMm) return false;
          }
        } else if (reqTonnage > 0 && m.tonnageCapacity != null && m.tonnageCapacity < reqTonnage) {
          return false;
        }
        if (op.plannedDieId && m.compatibleDieIds.length > 0 && !m.compatibleDieIds.includes(op.plannedDieId)) {
          // Only restrict when compatibility rows exist for that die in master data
          const anyMachineHasDie = machineList.some(cand => cand.compatibleDieIds.includes(op.plannedDieId));
          if (anyMachineHasDie && !m.compatibleDieIds.includes(op.plannedDieId)) return false;
        }
        return true;
      })
      .map(m => m.id);
  };

  // Build Work Orders + Operations Queue
  const reportsByOpId = new Map<string, any[]>();
  for (const r of reportsRaw) {
    if (!r.productionOperationId) continue;
    reportsByOpId.set(r.productionOperationId, [...(reportsByOpId.get(r.productionOperationId) || []), r]);
  }

  const allOperationsQueue: any[] = [];
  const workOrders = mosRaw.map((mo: any) => {
    const opsSorted = [...(mo.operations || [])].sort(
      (a: any, b: any) => (a.sequence ?? a.stepNumber) - (b.sequence ?? b.stepNumber) || a.stepNumber - b.stepNumber,
    );
    const openCoilIssues = (mo.coilIssueReturnRecords || []).filter(
      (rec: any) => num(rec.issuedWeightKg) > 0 && num(rec.outstandingWeightKg) > 1e-6,
    );
    const totalOutstandingMaterialKg = round2(
      openCoilIssues.reduce((s: number, r: any) => s + num(r.outstandingWeightKg), 0),
    );
    const totalIssuedMaterialKg = round2(
      (mo.coilIssueReturnRecords || [])
        .filter((r: any) => num(r.issuedWeightKg) > 0)
        .reduce((s: number, r: any) => s + num(r.issuedWeightKg), 0),
    );
    const totalConsumedMaterialKg = round2(
      (mo.coilIssueReturnRecords || []).reduce(
        (s: number, r: any) => s + num(r.consumedWeightKg) + num(r.varianceWeightKg),
        0,
      ),
    );

    const mappedOps = opsSorted.map((op: any, idx: number) => {
      const prevOp = idx > 0 ? opsSorted[idx - 1] : null;
      const opLogs = logsByOpId.get(op.id) || [];
      const execMeta = computeExecutionState(op.status, opLogs);
      const pauseAudit = pauseAuditByOpId.get(op.id);
      const isPauseDowntime = execMeta.isPaused ? Boolean(pauseAudit?.newValues?.isDowntime) : false;

      const activeAssignments = (op.assignments || []).filter(
        (a: any) => a.status !== 'CANCELLED',
      );
      const currentAssignment =
        activeAssignments.find((a: any) => a.status === 'ACTIVE') ||
        activeAssignments.find((a: any) => a.status === 'SCHEDULED') ||
        activeAssignments[0] ||
        null;

      const effectiveMachineId = currentAssignment?.machineId || op.plannedMachineId || null;
      const effectiveMachine = effectiveMachineId ? machineById.get(effectiveMachineId) : null;
      const eligibleMachineIds = computeEligibleMachineIdsForOp(op, mo.part);

      const waitingInputQty = num(op.waitingInputQty);
      const inProgressQty = num(op.inProgressQty);
      const outputGoodQty = num(op.outputGoodQty);
      const outputScrapQty = num(op.outputScrapQty);
      const outputReworkQty = num(op.outputReworkQty);
      const outputRejectedQty = num(op.outputRejectedQty);
      const plannedQty = num(op.plannedQty);

      const opReports = reportsByOpId.get(op.id) || [];
      const totalRunTimeMinutes = opReports.reduce((s, r) => s + Number(r.runTimeMinutes || 0), 0);
      const totalDowntimeMinutes = opReports.reduce((s, r) => s + Number(r.downtimeMinutes || 0), 0);

      // Sequence lock check: OP20+ cannot start if it has no queued WIP and predecessor hasn't produced or completed/skipped
      const predecessorBlocked =
        Boolean(prevOp) &&
        waitingInputQty <= 0 &&
        inProgressQty <= 0 &&
        num(prevOp.outputGoodQty) <= 0 &&
        !['COMPLETED', 'SKIPPED'].includes(prevOp.status);

      const opEligibleIssues = openCoilIssues.filter(
        (rec: any) => rec.productionOperationId === op.id || (!rec.productionOperationId && idx === 0),
      );
      const opOutstandingMaterialKg = round2(
        opEligibleIssues.reduce((s: number, r: any) => s + num(r.outstandingWeightKg), 0),
      );

      const completionPercent = plannedQty > 0 ? Math.min(100, round1((outputGoodQty / plannedQty) * 100)) : 0;

      const opDto = {
        id: op.id,
        moId: mo.id,
        moNumber: mo.moNumber,
        partId: mo.partId,
        partCode: mo.part?.partNumber || '',
        partName: mo.part?.name || '',
        partWeightGrossKg: num(mo.part?.weightGrossKg),
        partThicknessMm: mo.part?.thicknessMm != null ? num(mo.part.thicknessMm) : null,
        planId: mo.planId || null,
        planNumber: mo.plan?.planNumber || null,
        planLineId: mo.planLineId || null,
        planLinePlannedQty: mo.planLine ? num(mo.planLine.plannedQty) : num(mo.targetQty),
        planLineProducedQty: mo.planLine ? num(mo.planLine.producedQty) : num(mo.completedQty),
        moStatus: mo.status,
        stepNumber: op.stepNumber,
        sequence: op.sequence ?? idx + 1,
        stepCode: op.stepCode || op.operation?.code || `OP${op.stepNumber}`,
        stepName: op.stepName || op.operation?.name || `عملیات ${op.stepNumber}`,
        processType: op.operation?.processType || 'PUNCH_FORM',
        plannedQty,
        waitingInputQty,
        inProgressQty,
        readyForTransferQty: num(op.readyForTransferQty),
        availableStationQty: round6(waitingInputQty + inProgressQty),
        outputGoodQty,
        outputScrapQty,
        outputReworkQty,
        outputRejectedQty,
        remainingQty: Math.max(0, round6(plannedQty - outputGoodQty)),
        completionPercent,
        status: op.status,
        executionState: execMeta.executionState,
        isPaused: execMeta.isPaused,
        lastPausedAt: execMeta.lastPausedAt,
        lastPauseReason: execMeta.lastPauseReason,
        lastPauseIsDowntime: isPauseDowntime,
        actualStartedAt: execMeta.actualStartedAt,
        startDate: op.startDate ? new Date(op.startDate).toISOString() : null,
        endDate: op.endDate ? new Date(op.endDate).toISOString() : null,
        lastActivityAt: op.lastActivityAt ? new Date(op.lastActivityAt).toISOString() : null,
        version: Number(op.version ?? 1),
        plannedMachineId: op.plannedMachineId || null,
        machineId: effectiveMachineId,
        machineCode: effectiveMachine?.code || op.plannedMachine?.code || null,
        machineName: effectiveMachine?.name || op.plannedMachine?.name || null,
        plannedDieId: op.plannedDieId || null,
        dieCode: op.plannedDie?.code || null,
        dieName: op.plannedDie?.name || null,
        assignmentId: currentAssignment?.id || null,
        assignmentStatus: currentAssignment?.status || null,
        shiftId: currentAssignment?.shiftId || shiftsRaw[0]?.id || null,
        shiftName: currentAssignment?.shift?.name || shiftsRaw[0]?.name || null,
        assignedDate: currentAssignment?.assignedDate
          ? new Date(currentAssignment.assignedDate).toISOString().slice(0, 10)
          : mo.scheduledStartDate
          ? new Date(mo.scheduledStartDate).toISOString().slice(0, 10)
          : null,
        assignedOperatorId: currentAssignment?.assignedOperatorId || null,
        assignedOperatorName: currentAssignment?.assignedOperator?.fullName || null,
        eligibleMachineIds,
        predecessorBlocked,
        outstandingMaterialKg: opOutstandingMaterialKg,
        totalRunTimeMinutes,
        totalDowntimeMinutes,
        canLoadMaterial:
          idx === 0 &&
          !execMeta.isPaused &&
          !['COMPLETED', 'SKIPPED'].includes(op.status) &&
          !['COMPLETED', 'CLOSED', 'CANCELLED'].includes(mo.status),
        canStart:
          ['READY', 'PENDING'].includes(op.status) &&
          !predecessorBlocked &&
          !execMeta.isPaused &&
          mo.status !== 'COMPLETED',
        canPause: op.status === 'IN_PROGRESS' && !execMeta.isPaused,
        canResume: execMeta.isPaused,
        canReport:
          !execMeta.isPaused &&
          !['COMPLETED', 'SKIPPED'].includes(op.status) &&
          waitingInputQty + inProgressQty > 0 &&
          mo.status !== 'COMPLETED',
        canComplete:
          !execMeta.isPaused &&
          op.status === 'IN_PROGRESS' &&
          waitingInputQty <= 1e-6 &&
          inProgressQty <= 1e-6 &&
          num(op.readyForTransferQty) <= 1e-6 &&
          outputGoodQty + outputScrapQty + outputReworkQty + outputRejectedQty > 0,
      };
      allOperationsQueue.push(opDto);
      return opDto;
    });

    const targetQty = num(mo.targetQty);
    const completedQty = num(mo.completedQty);
    const scrapQty = num(mo.scrapQty);
    const woCompletionPercent = targetQty > 0 ? Math.min(100, round1((completedQty / targetQty) * 100)) : 0;

    return {
      id: mo.id,
      moNumber: mo.moNumber,
      partId: mo.partId,
      partCode: mo.part?.partNumber || '',
      partName: mo.part?.name || '',
      planId: mo.planId || null,
      planNumber: mo.plan?.planNumber || null,
      planTitle: mo.plan?.title || null,
      planStatus: mo.plan?.status || null,
      planLineId: mo.planLineId || null,
      planLinePlannedQty: mo.planLine ? num(mo.planLine.plannedQty) : targetQty,
      planLineProducedQty: mo.planLine ? num(mo.planLine.producedQty) : completedQty,
      planLineStatus: mo.planLine?.status || null,
      targetQty,
      initialInputQty: num(mo.initialInputQty),
      completedQty,
      scrapQty,
      totalReworkQty: num(mo.totalReworkQty),
      totalRejectedQty: num(mo.totalRejectedQty),
      completionPercent: woCompletionPercent,
      status: mo.status,
      priority: Number(mo.priority || 1),
      scheduledStartDate: mo.scheduledStartDate ? new Date(mo.scheduledStartDate).toISOString().slice(0, 10) : null,
      scheduledEndDate: mo.scheduledEndDate ? new Date(mo.scheduledEndDate).toISOString().slice(0, 10) : null,
      actualStartDate: mo.actualStartDate ? new Date(mo.actualStartDate).toISOString() : null,
      actualEndDate: mo.actualEndDate ? new Date(mo.actualEndDate).toISOString() : null,
      totalIssuedMaterialKg,
      totalConsumedMaterialKg,
      totalOutstandingMaterialKg,
      version: Number(mo.version ?? 1),
      operations: mappedOps,
    };
  });

  // Apply filters to workOrders / operationsQueue
  const searchNorm = (filters?.search || '').trim().toLowerCase();
  const filteredQueue = allOperationsQueue.filter(op => {
    if (filters?.moId && filters.moId !== 'ALL' && op.moId !== filters.moId) return false;
    if (filters?.machineId && filters.machineId !== 'ALL' && op.machineId !== filters.machineId) return false;
    if (filters?.shiftId && filters.shiftId !== 'ALL' && op.shiftId !== filters.shiftId) return false;
    if (filters?.executionState && filters.executionState !== 'ALL' && op.executionState !== filters.executionState) {
      return false;
    }
    if (searchNorm) {
      const hay = `${op.moNumber} ${op.partCode} ${op.partName} ${op.stepCode} ${op.stepName} ${op.machineCode || ''} ${op.planNumber || ''}`.toLowerCase();
      if (!hay.includes(searchNorm)) return false;
    }
    return true;
  });

  const matchedMoIds = new Set(filteredQueue.map(o => o.moId));
  const filteredWorkOrders =
    filters?.moId || filters?.machineId || filters?.shiftId || filters?.executionState || searchNorm
      ? workOrders.filter((w: any) => matchedMoIds.has(w.id))
      : workOrders;

  // Recent production reports
  const recentReports = reportsRaw.map((r: any) => {
    const auditExtra = reportAuditByReportId.get(r.id)?.newValues || null;
    return {
      id: r.id,
      reportNumber: r.reportNumber,
      moId: r.manufacturingOrderId,
      moNumber: r.manufacturingOrder?.moNumber || '',
      partCode: r.manufacturingOrder?.part?.partNumber || '',
      partName: r.manufacturingOrder?.part?.name || '',
      operationId: r.productionOperationId,
      stepCode: r.productionOperation?.stepCode || `OP${r.productionOperation?.stepNumber || ''}`,
      stepName: r.productionOperation?.stepName || '',
      machineId: r.machineId,
      machineCode: r.machine?.code || '',
      machineName: r.machine?.name || '',
      shiftId: r.shiftId,
      shiftName: r.shift?.name || '',
      operatorUserId: r.operatorUserId || null,
      operatorName: r.operatorUser?.fullName || 'اپراتور خط',
      reportDate: r.reportDate ? new Date(r.reportDate).toISOString() : new Date().toISOString(),
      goodQty: num(r.goodQuantity),
      scrapQty: num(r.scrapQuantity),
      reworkQty: num(r.reworkQuantity),
      rejectedQty: num(r.rejectedQuantity),
      scrapReason: r.scrapReasonText || null,
      runTimeMinutes: Number(r.runTimeMinutes || 0),
      downtimeMinutes: Number(r.downtimeMinutes || 0),
      downtimeReason: r.downtimeReason || null,
      strokeCounterStart: r.strokeCounterStart ?? null,
      strokeCounterEnd: r.strokeCounterEnd ?? null,
      actualMaterialConsumedKg:
        auditExtra?.actualMaterialConsumedKg != null ? num(auditExtra.actualMaterialConsumedKg) : null,
    };
  });

  // Build unified Downtime Events list WITHOUT double-counting:
  // 1) All ProductionReports with downtimeMinutes > 0
  // 2) Standalone AuditLog SHOP_FLOOR_DOWNTIME rows that do NOT reference a productionReportId
  const downtimeEvents: any[] = [];
  for (const r of recentReports) {
    if (r.downtimeMinutes > 0) {
      downtimeEvents.push({
        id: `RPT-DT-${r.id}`,
        source: 'PRODUCTION_REPORT',
        machineId: r.machineId,
        machineCode: r.machineCode,
        machineName: r.machineName,
        moId: r.moId,
        moNumber: r.moNumber,
        operationId: r.operationId,
        stepCode: r.stepCode,
        shiftId: r.shiftId,
        shiftName: r.shiftName,
        reason: r.downtimeReason || 'توقف حین تولید',
        durationMinutes: r.downtimeMinutes,
        recordedAt: r.reportDate,
        recordedBy: r.operatorName,
      });
    }
  }
  for (const a of downtimeAuditsRaw) {
    if (a.action !== 'SHOP_FLOOR_DOWNTIME') continue;
    const nv = a.newValues || {};
    if (nv.productionReportId) continue; // already included from ProductionReport above
    const m = machineById.get(nv.machineId || a.entityId);
    downtimeEvents.push({
      id: a.id,
      source: 'STANDALONE_DOWNTIME',
      machineId: nv.machineId || a.entityId,
      machineCode: m?.code || nv.machineCode || a.entityId,
      machineName: m?.name || nv.machineName || 'ماشین',
      moId: nv.manufacturingOrderId || null,
      moNumber: nv.moNumber || null,
      operationId: nv.productionOperationId || null,
      stepCode: nv.stepCode || null,
      shiftId: nv.shiftId || null,
      shiftName: nv.shiftName || null,
      reason: nv.reason || 'توقف ثبت‌شده',
      durationMinutes: Number(nv.durationMinutes || 0),
      recordedAt: new Date(a.timestamp).toISOString(),
      recordedBy: nv.operatorName || 'اپراتور خط',
    });
  }
  downtimeEvents.sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime());

  // KPI Calculations (Planned vs Actual, Completion %, Scrap Rate %, Machine Utilization %, Downtime)
  const totalPlannedQty = round2(workOrders.reduce((s: number, w: any) => s + w.targetQty, 0));
  const totalActualGoodQty = round2(workOrders.reduce((s: number, w: any) => s + w.completedQty, 0));
  const totalScrapQty = round2(workOrders.reduce((s: number, w: any) => s + w.scrapQty, 0));
  const totalReworkQty = round2(workOrders.reduce((s: number, w: any) => s + w.totalReworkQty, 0));
  const totalRejectedQty = round2(workOrders.reduce((s: number, w: any) => s + w.totalRejectedQty, 0));
  const totalOutputAllOps = round2(
    allOperationsQueue.reduce(
      (s, op) => s + op.outputGoodQty + op.outputScrapQty + op.outputReworkQty + op.outputRejectedQty,
      0,
    ),
  );
  const totalScrapAllOps = round2(allOperationsQueue.reduce((s, op) => s + op.outputScrapQty, 0));

  const overallCompletionPercent =
    totalPlannedQty > 0 ? Math.min(100, round1((totalActualGoodQty / totalPlannedQty) * 100)) : 0;

  // Prefer final-stage scrap rate if MO totals exist; otherwise aggregate across ops so mid-routing scrap is always visible
  const scrapDenominator =
    totalActualGoodQty + totalScrapQty + totalReworkQty + totalRejectedQty > 0
      ? totalActualGoodQty + totalScrapQty + totalReworkQty + totalRejectedQty
      : totalOutputAllOps;
  const scrapNumerator =
    totalActualGoodQty + totalScrapQty + totalReworkQty + totalRejectedQty > 0
      ? totalScrapQty
      : totalScrapAllOps;
  const scrapRatePercent = scrapDenominator > 0 ? round2((scrapNumerator / scrapDenominator) * 100) : 0;

  const dailyAvailableMinutesPerMachine = Math.max(
    60,
    round1(
      (shiftsRaw.length > 0
        ? shiftsRaw.reduce((s: number, sh: any) => s + (num(sh.productiveHours) > 0 ? num(sh.productiveHours) : 7.5), 0)
        : 15) * 60,
    ),
  );

  const byReasonMap = new Map<string, { reason: string; minutes: number; count: number }>();
  for (const dt of downtimeEvents) {
    const key = dt.reason || 'سایر';
    const prev = byReasonMap.get(key) || { reason: key, minutes: 0, count: 0 };
    prev.minutes += Number(dt.durationMinutes || 0);
    prev.count += 1;
    byReasonMap.set(key, prev);
  }
  const downtimeByReason = Array.from(byReasonMap.values()).sort((a, b) => b.minutes - a.minutes);

  const shiftHoursById = new Map(
    shiftsRaw.map((sh: any) => [sh.id, num(sh.productiveHours) > 0 ? num(sh.productiveHours) : 7.5]),
  );

  // Compute machine-level KPIs (utilization = runTime / availableShiftTime)
  const perMachineKpis = machineList.map(m => {
    const mReports = recentReports.filter(r => r.machineId === m.id);
    const runTimeMinutes = mReports.reduce((s, r) => s + r.runTimeMinutes, 0);
    const mDowntimes = downtimeEvents.filter(dt => dt.machineId === m.id);
    const downtimeMinutes = mDowntimes.reduce((s, d) => s + d.durationMinutes, 0);
    const goodQty = round2(mReports.reduce((s, r) => s + r.goodQty, 0));
    const scrapQtyM = round2(mReports.reduce((s, r) => s + r.scrapQty, 0));

    // Available capacity minutes: sum shift hours from assigned operations on this machine, or default 1 day if active reports exist
    const assignedShiftIds = new Set<string>();
    const assignedOpsForMachine = allOperationsQueue.filter(op => op.machineId === m.id);
    for (const op of assignedOpsForMachine) {
      if (op.shiftId) assignedShiftIds.add(op.shiftId);
    }
    const availableMinutes =
      assignedShiftIds.size > 0
        ? round1(
            Array.from(assignedShiftIds).reduce(
              (s, sid) => s + Number(shiftHoursById.get(sid) || 7.5) * 60,
              0,
            ),
          )
        : dailyAvailableMinutesPerMachine;

    const utilizationPercent =
      availableMinutes > 0 && runTimeMinutes > 0
        ? Math.min(100, round1((runTimeMinutes / availableMinutes) * 100))
        : 0;

    return {
      machineId: m.id,
      machineCode: m.code,
      machineName: m.name,
      status: m.status,
      activeOpsCount: assignedOpsForMachine.filter(op => !['COMPLETED', 'SKIPPED'].includes(op.status)).length,
      inProgressOpsCount: assignedOpsForMachine.filter(op => op.executionState === 'IN_PROGRESS').length,
      pausedOpsCount: assignedOpsForMachine.filter(op => op.executionState === 'PAUSED').length,
      runTimeMinutes,
      downtimeMinutes,
      availableMinutes,
      utilizationPercent,
      goodQty,
      scrapQty: scrapQtyM,
    };
  });

  const totalRunTimeMinutes = perMachineKpis.reduce((s, m) => s + m.runTimeMinutes, 0);
  const totalDowntimeMinutes = downtimeEvents.reduce((s, d) => s + Number(d.durationMinutes || 0), 0);
  const utilizedMachines = perMachineKpis.filter(m => m.runTimeMinutes > 0 || m.activeOpsCount > 0);
  const totalAvailablePoolMinutes =
    utilizedMachines.length > 0
      ? utilizedMachines.reduce((s, m) => s + m.availableMinutes, 0)
      : dailyAvailableMinutesPerMachine;
  const machineUtilizationPercent =
    totalAvailablePoolMinutes > 0 && totalRunTimeMinutes > 0
      ? Math.min(100, round1((totalRunTimeMinutes / totalAvailablePoolMinutes) * 100))
      : 0;

  const activityTimeline = activityLogsRaw.slice(0, 60).map((l: any) => ({
    id: l.id,
    moId: l.manufacturingOrderId,
    moNumber: l.moNumber,
    operationId: l.productionOperationId,
    stepNumber: l.stepNumber,
    stepName: l.stepName,
    activityType: l.activityType,
    quantity: num(l.quantity),
    goodQty: l.goodQty != null ? num(l.goodQty) : null,
    scrapQty: l.scrapQty != null ? num(l.scrapQty) : null,
    operatorName: l.operatorName,
    machineId: l.machineId,
    notes: l.notes || null,
    timestamp: new Date(l.timestamp).toISOString(),
  }));

  return {
    source: 'postgresql',
    workOrders: filteredWorkOrders,
    operationsQueue: filteredQueue,
    recentReports,
    downtimeEvents,
    activityTimeline,
    kpis: {
      workOrdersCount: workOrders.length,
      activeWorkOrdersCount: workOrders.filter((w: any) => w.status === 'RELEASED' || w.status === 'IN_PROGRESS').length,
      completedWorkOrdersCount: workOrders.filter((w: any) => w.status === 'COMPLETED').length,
      readyOpsCount: allOperationsQueue.filter(o => o.executionState === 'READY').length,
      inProgressOpsCount: allOperationsQueue.filter(o => o.executionState === 'IN_PROGRESS').length,
      pausedOpsCount: allOperationsQueue.filter(o => o.executionState === 'PAUSED').length,
      completedOpsCount: allOperationsQueue.filter(o => o.executionState === 'COMPLETED').length,
      totalPlannedQty,
      totalActualGoodQty,
      totalScrapQty,
      totalReworkQty,
      totalRejectedQty,
      overallCompletionPercent,
      scrapRatePercent,
      machineUtilizationPercent,
      totalRunTimeMinutes,
      totalDowntimeMinutes,
      downtimeByReason,
      perMachine: perMachineKpis,
    },
    masterData: {
      machines: machineList,
      shifts: shiftsRaw.map((s: any) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        startTime: s.startTime,
        endTime: s.endTime,
        productiveHours: num(s.productiveHours) > 0 ? num(s.productiveHours) : 7.5,
      })),
      operators: usersRaw.map((u: any) => ({
        id: u.id,
        username: u.username,
        fullName: u.fullName,
        personnelCode: u.personnelCode || null,
        active: Boolean(u.active),
      })),
    },
  };
}

export async function startShopFloorOperation(params: {
  operationId: string;
  idempotencyKey: string;
  machineId?: string;
  shiftId?: string;
  operatorUserId?: string;
  operatorName?: string;
  moveWaitingToInProgress?: boolean;
  notes?: string;
  expectedVersion?: number;
}) {
  const prisma = __getProductionWipPrisma();
  const idempotencyKey = validateIdempotencyKey(params.idempotencyKey);

  try {
    const result = await prisma.$transaction(
      async (tx: any) => {
        const existingAudit = await findAuditIdempotencyMatch(tx, 'SHOP_FLOOR_OP_START', idempotencyKey);
        if (existingAudit) {
          if (existingAudit.entityId !== params.operationId) {
            throw new WipServiceError('کلید یکتای شروع عملیات قبلاً برای عملیات دیگری استفاده شده است.', 409, true);
          }
          const currentOp = await tx.productionOperation.findUnique({ where: { id: params.operationId } });
          return { duplicate: true, operation: currentOp, executionState: 'IN_PROGRESS' as const };
        }

        const op = await tx.productionOperation.findUnique({
          where: { id: params.operationId },
          include: {
            operation: true,
            plannedMachine: true,
            plannedDie: true,
            routeOperation: true,
            manufacturingOrder: {
              include: {
                part: true,
                operations: { orderBy: [{ sequence: 'asc' }, { stepNumber: 'asc' }] },
              },
            },
          },
        });
        if (!op) throw new WipServiceError('عملیات تولید یافت نشد.', 404);

        const mo = op.manufacturingOrder;
        if (!mo) throw new WipServiceError('دستور ساخت مرتبط یافت نشد.', 404);
        assertMutableMo(mo);
        if (mo.status === 'PLANNED') {
          throw new WipServiceError('دستور ساخت هنوز به خط تولید ابلاغ (RELEASED) نشده است.', 409);
        }

        if (params.expectedVersion != null && op.version !== params.expectedVersion) {
          throw new WipServiceError('وضعیت این مرحله هم‌زمان تغییر کرده است؛ لطفاً اطلاعات را تازه‌سازی کنید.', 409, true);
        }

        if (op.status === 'COMPLETED' || op.status === 'SKIPPED') {
          throw new WipServiceError('این عملیات قبلاً تکمیل یا رد شده است.', 409);
        }
        if (await isOperationPausedInTx(tx, op.id)) {
          throw new WipServiceError('این عملیات در وضعیت توقف (PAUSED) است؛ از دکمه ادامه (Resume) استفاده کنید.', 409);
        }
        if (op.status === 'IN_PROGRESS') {
          throw new WipServiceError('این عملیات هم‌اکنون در حال اجرا (IN_PROGRESS) است.', 409);
        }

        // Enforce strict routing sequence lock for OP20+
        const sortedOps = [...(mo.operations || [])].sort(
          (a: any, b: any) => (a.sequence ?? a.stepNumber) - (b.sequence ?? b.stepNumber) || a.stepNumber - b.stepNumber,
        );
        const opIndex = sortedOps.findIndex((o: any) => o.id === op.id);
        if (opIndex > 0) {
          const prevOp = sortedOps[opIndex - 1];
          const hasQueuedStock = num(op.waitingInputQty) > 0 || num(op.inProgressQty) > 0;
          const prevHasProducedOrDone =
            ['COMPLETED', 'SKIPPED'].includes(prevOp.status) || num(prevOp.outputGoodQty) > 0;
          if (!hasQueuedStock && !prevHasProducedOrDone) {
            throw new WipServiceError(
              `قفل توالی عملیات: پیش از شروع ${op.stepCode || `OP${op.stepNumber}`}، عملیات قبلی (${prevOp.stepCode || `OP${prevOp.stepNumber}`}) باید تولید یا ارسال داشته باشد.`,
              409,
            );
          }
        }

        const effectiveMachineId = params.machineId || op.plannedMachineId;
        if (!effectiveMachineId) {
          throw new WipServiceError('انتخاب ماشین فعال برای شروع عملیات الزامی است.', 400);
        }
        const machine = await tx.machine.findUnique({ where: { id: effectiveMachineId } });
        await assertMachineEligibleForOpInTx(tx, { machine, op, part: mo.part });

        if (params.shiftId && typeof tx.shift?.findUnique === 'function') {
          const shift = await tx.shift.findUnique({ where: { id: params.shiftId } });
          if (!shift || !shift.active) {
            throw new WipServiceError('شیفت انتخاب‌شده معتبر یا فعال نیست.', 400);
          }
        }

        const actorUser = await resolvePostingUser(tx, params.operatorUserId);
        const operatorDisplayName = params.operatorName?.trim() || actorUser.fullName || 'اپراتور تولید';
        const now = new Date();
        const moveQty = params.moveWaitingToInProgress !== false ? num(op.waitingInputQty) : 0;

        const opCas = await tx.productionOperation.updateMany({
          where: { id: op.id, version: op.version, status: { in: ['PENDING', 'READY'] } },
          data: {
            status: 'IN_PROGRESS',
            plannedMachineId: effectiveMachineId,
            startDate: now,
            lastActivityAt: now,
            ...(moveQty > 0
              ? {
                  waitingInputQty: { decrement: moveQty },
                  inProgressQty: { increment: moveQty },
                  inputQty: { increment: moveQty },
                }
              : {}),
            version: { increment: 1 },
          },
        });
        if (opCas.count !== 1) {
          throw new WipServiceError('تداخل هم‌زمانی در شروع عملیات رخ داد؛ اطلاعات را تازه‌سازی کنید.', 409, true);
        }

        await tx.manufacturingOrder.updateMany({
          where: { id: mo.id, status: { notIn: ['CANCELLED', 'CLOSED', 'COMPLETED'] } },
          data: {
            status: 'IN_PROGRESS',
            actualStartDate: mo.actualStartDate || now,
            version: { increment: 1 },
          },
        });

        // Update matching scheduled MachineAssignment -> ACTIVE
        if (typeof tx.machineAssignment?.findMany === 'function') {
          const openAsgs = await tx.machineAssignment.findMany({
            where: { productionOperationId: op.id, status: { in: ['SCHEDULED', 'ACTIVE'] } },
          });
          for (const asg of openAsgs || []) {
            await tx.machineAssignment.update({
              where: { id: asg.id },
              data: {
                status: 'ACTIVE',
                machineId: effectiveMachineId,
                ...(params.shiftId ? { shiftId: params.shiftId } : {}),
                assignedOperatorId: actorUser.id,
              },
            });
          }
        }

        // Update ProductionPlan status to IN_PROGRESS (never modify planned dates/qty)
        if (mo.planLineId && typeof tx.productionPlanLine?.findUnique === 'function') {
          const planLine = await tx.productionPlanLine.findUnique({ where: { id: mo.planLineId } });
          if (planLine && planLine.status === 'RELEASED') {
            await tx.productionPlanLine.update({
              where: { id: planLine.id },
              data: { status: 'IN_PROGRESS' },
            });
          }
        }

        await tx.productionActivityLog.create({
          data: {
            manufacturingOrderId: mo.id,
            moNumber: mo.moNumber,
            partId: mo.partId,
            productionOperationId: op.id,
            stepNumber: op.stepNumber,
            stepName: op.stepName || op.operation?.name || '',
            activityType: 'OP_START',
            quantity: moveQty,
            operatorName: operatorDisplayName,
            machineId: effectiveMachineId,
            timestamp: now,
            notes: params.notes?.trim() || 'شروع اجرای عملیات روی ماشین',
          },
        });

        if (typeof tx.auditLog?.create === 'function') {
          await tx.auditLog.create({
            data: {
              userId: actorUser.id,
              action: 'SHOP_FLOOR_OP_START',
              entityName: 'ProductionOperation',
              entityId: op.id,
              oldValues: { status: op.status, machineId: op.plannedMachineId },
              newValues: {
                status: 'IN_PROGRESS',
                machineId: effectiveMachineId,
                shiftId: params.shiftId || null,
                operatorUserId: actorUser.id,
                operatorName: operatorDisplayName,
                movedWaitingQty: moveQty,
                idempotencyKey,
              },
              timestamp: now,
            },
          });
        }

        const updatedOp = await tx.productionOperation.findUnique({ where: { id: op.id } });
        return { duplicate: false, operation: updatedOp, executionState: 'IN_PROGRESS' as const };
      },
      { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 },
    );
    await syncWipReadCacheFromPostgres();
    return result;
  } catch (err) {
    wrapShopFloorTxError(err);
  }
}

export async function pauseShopFloorOperation(params: {
  operationId: string;
  idempotencyKey: string;
  reason: string;
  isDowntime?: boolean;
  operatorUserId?: string;
  operatorName?: string;
  expectedVersion?: number;
}) {
  const prisma = __getProductionWipPrisma();
  const idempotencyKey = validateIdempotencyKey(params.idempotencyKey);
  const reason = (params.reason || '').trim();
  if (!reason) {
    throw new WipServiceError('درج علت توقف عملیات (reason) الزامی است.', 400);
  }

  try {
    const result = await prisma.$transaction(
      async (tx: any) => {
        const existingAudit = await findAuditIdempotencyMatch(tx, 'SHOP_FLOOR_OP_PAUSE', idempotencyKey);
        if (existingAudit) {
          if (existingAudit.entityId !== params.operationId || existingAudit.newValues?.reason !== reason) {
            throw new WipServiceError('کلید یکتای توقف عملیات قبلاً با مشخصات دیگری استفاده شده است.', 409, true);
          }
          const currentOp = await tx.productionOperation.findUnique({ where: { id: params.operationId } });
          return { duplicate: true, operation: currentOp, executionState: 'PAUSED' as const };
        }

        const op = await tx.productionOperation.findUnique({
          where: { id: params.operationId },
          include: {
            operation: true,
            manufacturingOrder: true,
          },
        });
        if (!op) throw new WipServiceError('عملیات تولید یافت نشد.', 404);
        assertMutableMo(op.manufacturingOrder);

        if (params.expectedVersion != null && op.version !== params.expectedVersion) {
          throw new WipServiceError('وضعیت این مرحله هم‌زمان تغییر کرده است؛ اطلاعات را تازه‌سازی کنید.', 409, true);
        }
        if (op.status !== 'IN_PROGRESS') {
          throw new WipServiceError('فقط عملیات در حال اجرا (IN_PROGRESS) قابل توقف موقت است.', 409);
        }
        if (await isOperationPausedInTx(tx, op.id)) {
          throw new WipServiceError('این عملیات هم‌اکنون در وضعیت توقف (PAUSED) قرار دارد.', 409);
        }

        const actorUser = await resolvePostingUser(tx, params.operatorUserId);
        const operatorDisplayName = params.operatorName?.trim() || actorUser.fullName || 'اپراتور تولید';
        const now = new Date();

        const opCas = await tx.productionOperation.updateMany({
          where: { id: op.id, version: op.version, status: 'IN_PROGRESS' },
          data: {
            lastActivityAt: now,
            version: { increment: 1 },
          },
        });
        if (opCas.count !== 1) {
          throw new WipServiceError('تداخل هم‌زمانی در توقف عملیات رخ داد.', 409, true);
        }

        await tx.productionActivityLog.create({
          data: {
            manufacturingOrderId: op.manufacturingOrderId,
            moNumber: op.manufacturingOrder.moNumber,
            partId: op.manufacturingOrder.partId,
            productionOperationId: op.id,
            stepNumber: op.stepNumber,
            stepName: op.stepName || op.operation?.name || '',
            activityType: 'OP_PAUSE',
            quantity: 0,
            operatorName: operatorDisplayName,
            machineId: op.plannedMachineId || null,
            timestamp: now,
            notes: reason,
          },
        });

        if (typeof tx.auditLog?.create === 'function') {
          await tx.auditLog.create({
            data: {
              userId: actorUser.id,
              action: 'SHOP_FLOOR_OP_PAUSE',
              entityName: 'ProductionOperation',
              entityId: op.id,
              oldValues: { executionState: 'IN_PROGRESS' },
              newValues: {
                executionState: 'PAUSED',
                reason,
                isDowntime: Boolean(params.isDowntime),
                pausedAt: now.toISOString(),
                machineId: op.plannedMachineId || null,
                idempotencyKey,
              },
              timestamp: now,
            },
          });
        }

        const updatedOp = await tx.productionOperation.findUnique({ where: { id: op.id } });
        return { duplicate: false, operation: updatedOp, executionState: 'PAUSED' as const };
      },
      { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 },
    );
    await syncWipReadCacheFromPostgres();
    return result;
  } catch (err) {
    wrapShopFloorTxError(err);
  }
}

export async function resumeShopFloorOperation(params: {
  operationId: string;
  idempotencyKey: string;
  machineId?: string;
  shiftId?: string;
  downtimeMinutesOverride?: number;
  operatorUserId?: string;
  operatorName?: string;
  notes?: string;
  expectedVersion?: number;
}) {
  const prisma = __getProductionWipPrisma();
  const idempotencyKey = validateIdempotencyKey(params.idempotencyKey);

  try {
    const result = await prisma.$transaction(
      async (tx: any) => {
        const existingAudit = await findAuditIdempotencyMatch(tx, 'SHOP_FLOOR_OP_RESUME', idempotencyKey);
        if (existingAudit) {
          if (existingAudit.entityId !== params.operationId) {
            throw new WipServiceError('کلید یکتای ادامه عملیات قبلاً برای عملیات دیگری استفاده شده است.', 409, true);
          }
          const currentOp = await tx.productionOperation.findUnique({ where: { id: params.operationId } });
          return { duplicate: true, operation: currentOp, executionState: 'IN_PROGRESS' as const };
        }

        const op = await tx.productionOperation.findUnique({
          where: { id: params.operationId },
          include: {
            operation: true,
            plannedDie: true,
            routeOperation: true,
            manufacturingOrder: { include: { part: true } },
          },
        });
        if (!op) throw new WipServiceError('عملیات تولید یافت نشد.', 404);
        assertMutableMo(op.manufacturingOrder);

        if (params.expectedVersion != null && op.version !== params.expectedVersion) {
          throw new WipServiceError('وضعیت این مرحله هم‌زمان تغییر کرده است؛ اطلاعات را تازه‌سازی کنید.', 409, true);
        }
        if (op.status !== 'IN_PROGRESS' || !(await isOperationPausedInTx(tx, op.id))) {
          throw new WipServiceError('فقط عملیات متوقف‌شده (PAUSED) قابل ادامه (Resume) است.', 409);
        }

        const effectiveMachineId = params.machineId || op.plannedMachineId;
        if (effectiveMachineId) {
          const machine = await tx.machine.findUnique({ where: { id: effectiveMachineId } });
          await assertMachineEligibleForOpInTx(tx, { machine, op, part: op.manufacturingOrder.part });
        }

        const actorUser = await resolvePostingUser(tx, params.operatorUserId);
        const operatorDisplayName = params.operatorName?.trim() || actorUser.fullName || 'اپراتور تولید';
        const now = new Date();

        const opCas = await tx.productionOperation.updateMany({
          where: { id: op.id, version: op.version, status: 'IN_PROGRESS' },
          data: {
            ...(effectiveMachineId ? { plannedMachineId: effectiveMachineId } : {}),
            lastActivityAt: now,
            version: { increment: 1 },
          },
        });
        if (opCas.count !== 1) {
          throw new WipServiceError('تداخل هم‌زمانی در ازسرگیری عملیات رخ داد.', 409, true);
        }

        // Check if pause was flagged as downtime; if so, log standalone downtime automatically when elapsed >= 1 or override > 0
        let loggedDowntimeMinutes = 0;
        if (typeof tx.auditLog?.findMany === 'function') {
          const pauseLogs = await tx.auditLog.findMany({
            where: { action: 'SHOP_FLOOR_OP_PAUSE', entityId: op.id },
            orderBy: [{ timestamp: 'desc' }],
          });
          const latestPause = pauseLogs?.[0];
          const pauseNv = latestPause?.newValues;
          if (pauseNv?.isDowntime) {
            const elapsedMin = Math.max(
              0,
              Math.round((now.getTime() - new Date(latestPause.timestamp).getTime()) / 60000),
            );
            loggedDowntimeMinutes =
              params.downtimeMinutesOverride != null && params.downtimeMinutesOverride >= 0
                ? Math.round(Number(params.downtimeMinutesOverride))
                : elapsedMin;
            if (loggedDowntimeMinutes > 0 && effectiveMachineId && typeof tx.auditLog?.create === 'function') {
              await tx.auditLog.create({
                data: {
                  userId: actorUser.id,
                  action: 'SHOP_FLOOR_DOWNTIME',
                  entityName: 'Machine',
                  entityId: effectiveMachineId,
                  newValues: {
                    machineId: effectiveMachineId,
                    manufacturingOrderId: op.manufacturingOrderId,
                    moNumber: op.manufacturingOrder.moNumber,
                    productionOperationId: op.id,
                    stepCode: op.stepCode || `OP${op.stepNumber}`,
                    shiftId: params.shiftId || null,
                    reason: pauseNv.reason || 'توقف عملیات',
                    durationMinutes: loggedDowntimeMinutes,
                    operatorName: operatorDisplayName,
                    source: 'PAUSE_RESUME',
                    idempotencyKey: `DT-RESUME-${idempotencyKey}`,
                  },
                  timestamp: now,
                },
              });
            }
          }
        }

        await tx.productionActivityLog.create({
          data: {
            manufacturingOrderId: op.manufacturingOrderId,
            moNumber: op.manufacturingOrder.moNumber,
            partId: op.manufacturingOrder.partId,
            productionOperationId: op.id,
            stepNumber: op.stepNumber,
            stepName: op.stepName || op.operation?.name || '',
            activityType: 'OP_RESUME',
            quantity: 0,
            operatorName: operatorDisplayName,
            machineId: effectiveMachineId || null,
            timestamp: now,
            notes: params.notes?.trim() || 'ازسرگیری اجرای عملیات',
          },
        });

        if (typeof tx.auditLog?.create === 'function') {
          await tx.auditLog.create({
            data: {
              userId: actorUser.id,
              action: 'SHOP_FLOOR_OP_RESUME',
              entityName: 'ProductionOperation',
              entityId: op.id,
              oldValues: { executionState: 'PAUSED' },
              newValues: {
                executionState: 'IN_PROGRESS',
                machineId: effectiveMachineId || null,
                loggedDowntimeMinutes,
                idempotencyKey,
              },
              timestamp: now,
            },
          });
        }

        const updatedOp = await tx.productionOperation.findUnique({ where: { id: op.id } });
        return {
          duplicate: false,
          operation: updatedOp,
          executionState: 'IN_PROGRESS' as const,
          loggedDowntimeMinutes,
        };
      },
      { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 },
    );
    await syncWipReadCacheFromPostgres();
    return result;
  } catch (err) {
    wrapShopFloorTxError(err);
  }
}

export async function completeShopFloorOperation(params: {
  operationId: string;
  idempotencyKey: string;
  operatorUserId?: string;
  operatorName?: string;
  notes?: string;
  expectedVersion?: number;
}) {
  const prisma = __getProductionWipPrisma();
  const idempotencyKey = validateIdempotencyKey(params.idempotencyKey);

  try {
    const result = await prisma.$transaction(
      async (tx: any) => {
        const existingAudit = await findAuditIdempotencyMatch(tx, 'SHOP_FLOOR_OP_COMPLETE', idempotencyKey);
        if (existingAudit) {
          if (existingAudit.entityId !== params.operationId) {
            throw new WipServiceError('کلید یکتای تکمیل عملیات قبلاً برای عملیات دیگری استفاده شده است.', 409, true);
          }
          const currentOp = await tx.productionOperation.findUnique({ where: { id: params.operationId } });
          return { duplicate: true, operation: currentOp, executionState: 'COMPLETED' as const };
        }

        const op = await tx.productionOperation.findUnique({
          where: { id: params.operationId },
          include: {
            operation: true,
            manufacturingOrder: {
              include: {
                operations: true,
              },
            },
          },
        });
        if (!op) throw new WipServiceError('عملیات تولید یافت نشد.', 404);
        const mo = op.manufacturingOrder;
        assertMutableMo(mo);

        if (params.expectedVersion != null && op.version !== params.expectedVersion) {
          throw new WipServiceError('وضعیت این مرحله هم‌زمان تغییر کرده است؛ اطلاعات را تازه‌سازی کنید.', 409, true);
        }
        if (op.status === 'COMPLETED' || op.status === 'SKIPPED') {
          throw new WipServiceError('این عملیات قبلاً تکمیل یا رد شده است.', 409);
        }
        if (await isOperationPausedInTx(tx, op.id)) {
          throw new WipServiceError('عملیات متوقف‌شده (PAUSED) قبل از تکمیل باید از سر گرفته شود.', 409);
        }
        if (
          num(op.waitingInputQty) > 1e-6 ||
          num(op.inProgressQty) > 1e-6 ||
          num(op.readyForTransferQty) > 1e-6
        ) {
          throw new WipServiceError(
            'تا زمانی که موجودی در صف، پای دستگاه یا آماده انتقال در این ایستگاه باقی مانده باشد، بستن عملیات مجاز نیست.',
            409,
          );
        }
        const totalOut =
          num(op.outputGoodQty) + num(op.outputScrapQty) + num(op.outputReworkQty) + num(op.outputRejectedQty);
        if (totalOut <= 0) {
          throw new WipServiceError('بدون ثبت هیچ گزارش تولیدی نمی‌توان عملیات را تکمیل (Complete) کرد.', 409);
        }

        const actorUser = await resolvePostingUser(tx, params.operatorUserId);
        const operatorDisplayName = params.operatorName?.trim() || actorUser.fullName || 'اپراتور تولید';
        const now = new Date();

        const opCas = await tx.productionOperation.updateMany({
          where: { id: op.id, version: op.version },
          data: {
            status: 'COMPLETED',
            endDate: now,
            lastActivityAt: now,
            version: { increment: 1 },
          },
        });
        if (opCas.count !== 1) {
          throw new WipServiceError('تداخل هم‌زمانی در تکمیل عملیات رخ داد.', 409, true);
        }

        if (typeof tx.machineAssignment?.findMany === 'function') {
          const openAsgs = await tx.machineAssignment.findMany({
            where: { productionOperationId: op.id, status: { in: ['SCHEDULED', 'ACTIVE'] } },
          });
          for (const asg of openAsgs || []) {
            await tx.machineAssignment.update({
              where: { id: asg.id },
              data: { status: 'COMPLETED' },
            });
          }
        }

        const otherOpsEmpty = (mo.operations || []).every((cand: any) =>
          cand.id === op.id
            ? true
            : cand.status === 'COMPLETED' ||
              cand.status === 'SKIPPED' ||
              (num(cand.waitingInputQty) <= 1e-6 &&
                num(cand.inProgressQty) <= 1e-6 &&
                num(cand.readyForTransferQty) <= 1e-6 &&
                num(cand.outputGoodQty) > 0),
        );
        const allOpsDone = (mo.operations || []).every((cand: any) =>
          cand.id === op.id ? true : cand.status === 'COMPLETED' || cand.status === 'SKIPPED',
        );
        const pendingTransfersCount =
          typeof tx.productionTransfer?.count === 'function'
            ? await tx.productionTransfer.count({
                where: { manufacturingOrderId: mo.id, status: 'DISPATCHED' },
              })
            : 0;
        if (allOpsDone && otherOpsEmpty && pendingTransfersCount === 0 && num(mo.completedQty) >= num(mo.targetQty)) {
          const moDoneRes = await tx.manufacturingOrder.updateMany({
            where: { id: mo.id, status: { notIn: ['CANCELLED', 'CLOSED', 'COMPLETED'] } },
            data: {
              status: 'COMPLETED',
              actualEndDate: now,
              closedAt: now,
              version: { increment: 1 },
            },
          });
          if (moDoneRes.count === 1 && typeof tx.inventoryReservation?.findMany === 'function') {
            await releaseMoReservationsInTx(tx, mo.id, {
              reason: 'MO_COMPLETED',
              now,
              prismaUserId: actorUser.id,
            });
          }
        }

        await tx.productionActivityLog.create({
          data: {
            manufacturingOrderId: mo.id,
            moNumber: mo.moNumber,
            partId: mo.partId,
            productionOperationId: op.id,
            stepNumber: op.stepNumber,
            stepName: op.stepName || op.operation?.name || '',
            activityType: 'OP_COMPLETE',
            quantity: num(op.outputGoodQty),
            operatorName: operatorDisplayName,
            machineId: op.plannedMachineId || null,
            timestamp: now,
            notes: params.notes?.trim() || 'تکمیل و پایان عملیات ایستگاه',
          },
        });

        if (typeof tx.auditLog?.create === 'function') {
          await tx.auditLog.create({
            data: {
              userId: actorUser.id,
              action: 'SHOP_FLOOR_OP_COMPLETE',
              entityName: 'ProductionOperation',
              entityId: op.id,
              oldValues: { status: op.status },
              newValues: {
                status: 'COMPLETED',
                outputGoodQty: num(op.outputGoodQty),
                idempotencyKey,
              },
              timestamp: now,
            },
          });
        }

        const updatedOp = await tx.productionOperation.findUnique({ where: { id: op.id } });
        return { duplicate: false, operation: updatedOp, executionState: 'COMPLETED' as const };
      },
      { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 },
    );
    await syncWipReadCacheFromPostgres();
    return result;
  } catch (err) {
    wrapShopFloorTxError(err);
  }
}

export async function recordShopFloorProductionReport(params: {
  operationId: string;
  moId?: string;
  idempotencyKey: string;
  machineId?: string;
  shiftId: string;
  operatorUserId?: string;
  createdByUserId?: string;
  operatorName?: string;
  goodQty: number;
  scrapQty: number;
  reworkQty?: number;
  rejectedQty?: number;
  scrapReason?: string;
  runTimeMinutes?: number;
  downtimeMinutes?: number;
  downtimeReason?: string;
  strokeCounterStart?: number;
  strokeCounterEnd?: number;
  actualMaterialConsumedKg?: number;
  allowOverproduction?: boolean;
  autoCompleteOperation?: boolean;
  notes?: string;
  reportDate?: string;
  expectedVersion?: number;
}) {
  const prisma = __getProductionWipPrisma();
  let moId = params.moId?.trim() || '';
  if (!moId) {
    const op = await prisma.productionOperation.findUnique({
      where: { id: params.operationId },
      select: { manufacturingOrderId: true },
    });
    if (!op) throw new WipServiceError('عملیات تولید یافت نشد.', 404);
    moId = op.manufacturingOrderId;
  }

  return postWipProductionDb({
    moId,
    operationId: params.operationId,
    idempotencyKey: params.idempotencyKey,
    relationalMachineId: params.machineId,
    machineId: params.machineId,
    shiftId: params.shiftId,
    createdByUserId: params.createdByUserId || params.operatorUserId,
    operatorUserId: params.operatorUserId,
    operatorName: params.operatorName,
    goodQty: params.goodQty,
    scrapQty: params.scrapQty,
    reworkQty: params.reworkQty,
    rejectedQty: params.rejectedQty,
    scrapReason: params.scrapReason,
    runTimeMinutes: params.runTimeMinutes,
    downtimeMinutes: params.downtimeMinutes,
    downtimeReason: params.downtimeReason,
    strokeCounterStart: params.strokeCounterStart,
    strokeCounterEnd: params.strokeCounterEnd,
    actualMaterialConsumedKg: params.actualMaterialConsumedKg,
    allowOverproduction: params.allowOverproduction,
    autoCompleteOperation: params.autoCompleteOperation ?? false,
    notes: params.notes,
    reportDate: params.reportDate,
    expectedVersion: params.expectedVersion,
  });
}

export async function recordShopFloorDowntime(params: {
  machineId: string;
  idempotencyKey: string;
  reason: string;
  durationMinutes: number;
  shiftId?: string;
  productionOperationId?: string;
  operatorUserId?: string;
  operatorName?: string;
  markMachineBreakdown?: boolean;
  notes?: string;
}) {
  const prisma = __getProductionWipPrisma();
  const idempotencyKey = validateIdempotencyKey(params.idempotencyKey);
  const reason = (params.reason || '').trim();
  const durationMinutes = Math.round(Number(params.durationMinutes));
  if (!params.machineId?.trim()) {
    throw new WipServiceError('انتخاب ماشین برای ثبت توقف الزامی است.', 400);
  }
  if (!reason) {
    throw new WipServiceError('علت توقف (reason) الزامی است.', 400);
  }
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    throw new WipServiceError('مدت زمان توقف باید عددی بزرگتر از صفر (دقیقه) باشد.', 400);
  }

  try {
    const result = await prisma.$transaction(
      async (tx: any) => {
        const existingAudit = await findAuditIdempotencyMatch(tx, 'SHOP_FLOOR_DOWNTIME', idempotencyKey);
        if (existingAudit) {
          const nv = existingAudit.newValues || {};
          if (
            nv.machineId !== params.machineId ||
            nv.reason !== reason ||
            Number(nv.durationMinutes) !== durationMinutes
          ) {
            throw new WipServiceError('کلید یکتای توقف قبلاً با مقادیر متفاوتی ثبت شده است.', 409, true);
          }
          return {
            duplicate: true,
            downtimeEvent: {
              id: existingAudit.id,
              machineId: nv.machineId,
              reason: nv.reason,
              durationMinutes: nv.durationMinutes,
              productionReportId: nv.productionReportId || null,
            },
          };
        }

        const machine = await tx.machine.findUnique({ where: { id: params.machineId } });
        if (!machine) throw new WipServiceError('ماشین انتخاب‌شده یافت نشد.', 404);

        const actorUser = await resolvePostingUser(tx, params.operatorUserId);
        const operatorDisplayName = params.operatorName?.trim() || actorUser.fullName || 'اپراتور خط';
        const now = new Date();

        let linkedOp: any = null;
        let linkedReport: any = null;
        if (params.productionOperationId) {
          linkedOp = await tx.productionOperation.findUnique({
            where: { id: params.productionOperationId },
            include: { operation: true, manufacturingOrder: true },
          });
          if (!linkedOp) throw new WipServiceError('عملیات تولید مرتبط یافت نشد.', 404);
          assertMutableMo(linkedOp.manufacturingOrder);
        }

        let shift: any = null;
        if (params.shiftId && typeof tx.shift?.findUnique === 'function') {
          shift = await tx.shift.findUnique({ where: { id: params.shiftId } });
        } else if (typeof tx.shift?.findFirst === 'function') {
          shift = await tx.shift.findFirst({ where: { active: true }, orderBy: { startTime: 'asc' } });
        }

        if (linkedOp && shift) {
          const reportNumber = `PR-DT-${Date.now()}-${randomUUID().slice(0, 6).toUpperCase()}`;
          linkedReport = await tx.productionReport.create({
            data: {
              reportNumber,
              manufacturingOrderId: linkedOp.manufacturingOrderId,
              productionOperationId: linkedOp.id,
              machineId: machine.id,
              dieId: linkedOp.plannedDieId || null,
              shiftId: shift.id,
              operatorUserId: actorUser.id,
              reportDate: now,
              goodQuantity: 0,
              scrapQuantity: 0,
              reworkQuantity: 0,
              rejectedQuantity: 0,
              runTimeMinutes: 0,
              downtimeMinutes: durationMinutes,
              downtimeReason: reason,
              notes: params.notes?.trim() || `ثبت توقف کارگاهی: ${reason}`,
              documentStatus: 'CONFIRMED',
              postingStatus: 'POSTED',
              wipIdempotencyKey: `DT-${idempotencyKey}`,
            },
          });

          await tx.productionActivityLog.create({
            data: {
              manufacturingOrderId: linkedOp.manufacturingOrderId,
              moNumber: linkedOp.manufacturingOrder.moNumber,
              partId: linkedOp.manufacturingOrder.partId,
              productionOperationId: linkedOp.id,
              stepNumber: linkedOp.stepNumber,
              stepName: linkedOp.stepName || linkedOp.operation?.name || '',
              activityType: 'OP_DOWNTIME',
              quantity: durationMinutes,
              operatorName: operatorDisplayName,
              machineId: machine.id,
              productionReportId: linkedReport.id,
              timestamp: now,
              notes: `${reason} (${durationMinutes} دقیقه)`,
            },
          });
        }

        if (params.markMachineBreakdown && machine.status !== 'BREAKDOWN') {
          await tx.machine.update({
            where: { id: machine.id },
            data: { status: 'BREAKDOWN' },
          });
        }

        let auditRow: any = null;
        if (typeof tx.auditLog?.create === 'function') {
          auditRow = await tx.auditLog.create({
            data: {
              userId: actorUser.id,
              action: 'SHOP_FLOOR_DOWNTIME',
              entityName: 'Machine',
              entityId: machine.id,
              oldValues: { status: machine.status },
              newValues: {
                machineId: machine.id,
                machineCode: machine.code,
                machineName: machine.name,
                manufacturingOrderId: linkedOp?.manufacturingOrderId || null,
                moNumber: linkedOp?.manufacturingOrder?.moNumber || null,
                productionOperationId: linkedOp?.id || null,
                stepCode: linkedOp?.stepCode || null,
                shiftId: shift?.id || null,
                shiftName: shift?.name || null,
                productionReportId: linkedReport?.id || null,
                reason,
                durationMinutes,
                markMachineBreakdown: Boolean(params.markMachineBreakdown),
                operatorName: operatorDisplayName,
                notes: params.notes?.trim() || null,
                idempotencyKey,
              },
              timestamp: now,
            },
          });
        }

        return {
          duplicate: false,
          downtimeEvent: {
            id: linkedReport ? `RPT-DT-${linkedReport.id}` : auditRow?.id || idempotencyKey,
            machineId: machine.id,
            machineCode: machine.code,
            machineName: machine.name,
            moId: linkedOp?.manufacturingOrderId || null,
            moNumber: linkedOp?.manufacturingOrder?.moNumber || null,
            operationId: linkedOp?.id || null,
            reason,
            durationMinutes,
            productionReportId: linkedReport?.id || null,
            machineStatus: params.markMachineBreakdown ? 'BREAKDOWN' : machine.status,
          },
        };
      },
      { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 },
    );
    await syncWipReadCacheFromPostgres();
    return result;
  } catch (err) {
    wrapShopFloorTxError(err);
  }
}
