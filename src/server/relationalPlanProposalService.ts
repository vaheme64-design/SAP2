import { randomUUID } from 'node:crypto';
import { getPrismaClient } from './db/prisma';
import { getRelationalPlanningReadModel } from './relationalPlanningReadModel';
import { getLocationForProcess } from './productionWipEngine';
import {
  resolveLocationByCodeOrId,
  resolveOutputDestination,
  syncWipReadCacheFromPostgres,
} from './services/productionWipService';

const today = () => new Date(new Date().toISOString().slice(0, 10));
const dateKey = (date: Date) => date.toISOString().slice(0, 10).replace(/-/g, '');
const makeNumber = (prefix: string, date: Date) => `${prefix}-${dateKey(date)}-${randomUUID().slice(0, 6).toUpperCase()}`;
const numeric = (value: unknown) => Number(value ?? 0);
const round2 = (value: number) => Math.round(value * 100) / 100;

export type OperationAssignment = {
  routeOperationId: string;
  operationId: string;
  stepNumber: number;
  stepCode: string;
  stepName: string;
  processType?: string;
  requiredTonnage?: number;
  setupTimeMin?: number;
  standardCycleTimeSec?: number;
  estimatedHours?: number;
  plannedStartDate?: string;
  plannedEndDate?: string;
  machineId: string | null;
  machineCode?: string | null;
  machineName?: string | null;
  shiftId?: string | null;
  shiftCode?: string | null;
  shiftName?: string | null;
  dieId: string | null;
  dieCode?: string | null;
  dieName?: string | null;
  eligibleMachineIds: string[];
  hasCapacityConflict?: boolean;
  conflictMessage?: string | null;
};

function assertProposalDemandIsCurrent(proposal: any, readModel: any) {
  const current = new Map<string, number>();
  for (const requirement of readModel.requirements || []) {
    for (const line of requirement.demandLines || []) {
      if (line.plannedQty > 0) current.set(line.customerOrderLineId, numeric(line.plannedQty));
    }
  }

  // Compare against the original inputSnapshot demand when available so planner-controlled
  // revisions to plannedQty do not falsely trigger stale-demand rejections, while real
  // underlying demand/stock changes are still strictly caught.
  const snapshotReqs = proposal?.inputSnapshot?.requirements;
  const baseline = new Map<string, number>();
  if (Array.isArray(snapshotReqs)) {
    for (const requirement of snapshotReqs) {
      for (const line of requirement.demandLines || []) {
        if (line.plannedQty > 0) baseline.set(line.customerOrderLineId, numeric(line.plannedQty));
      }
    }
  } else {
    for (const line of proposal?.lines || []) {
      baseline.set(line.customerOrderLineId, numeric(line.plannedQty));
    }
  }

  if (current.size !== baseline.size) {
    throw new Error('تقاضا، موجودی یا برنامه‌های باز پس از تولید این پیشنهاد تغییر کرده‌اند؛ پیش از تایید/صدور، پیشنهاد را دوباره تولید کنید.');
  }
  for (const [lineId, quantity] of current) {
    if (!baseline.has(lineId) || Math.abs((baseline.get(lineId) || 0) - quantity) > 0.05) {
      throw new Error('مقدار تقاضای برنامه‌ریزی‌نشده تغییر کرده است؛ پیشنهاد را دوباره تولید کنید.');
    }
  }
}

function buildAssignments(route: any[], plannedQty: number, shifts: any[]): OperationAssignment[] {
  const defaultShift = Array.isArray(shifts) && shifts.length > 0 ? shifts[0] : null;
  return route.map(step => {
    const candidates = Array.isArray(step.eligibleMachines) ? step.eligibleMachines : [];
    const current = step.assignedMachine?.id;
    const selectedCandidate =
      (current ? candidates.find((item: any) => item.id === current) : undefined) ||
      candidates[0] ||
      null;
    const selectedShift =
      (selectedCandidate?.recommendedShiftId
        ? shifts.find((s: any) => s.id === selectedCandidate.recommendedShiftId)
        : undefined) ||
      defaultShift;
    const eff = numeric(selectedCandidate?.efficiencyFactor || 1) > 0 ? numeric(selectedCandidate?.efficiencyFactor || 1) : 1;
    const estHours = round2(
      Math.max(0, Number(step.setupTimeMin || 0)) / 60 +
        (Math.max(0, plannedQty) * Math.max(0, Number(step.standardCycleTimeSec || 0))) / 3600 / eff,
    );
    return {
      routeOperationId: step.routeOperationId,
      operationId: step.operationId,
      stepNumber: step.stepNumber,
      stepCode: step.stepCode,
      stepName: step.stepName,
      processType: step.processType,
      requiredTonnage: numeric(step.requiredTonnage),
      setupTimeMin: Number(step.setupTimeMin || 0),
      standardCycleTimeSec: Number(step.standardCycleTimeSec || 0),
      estimatedHours: estHours,
      plannedStartDate: step.estimatedStartDate || today().toISOString().slice(0, 10),
      plannedEndDate: step.estimatedEndDate || today().toISOString().slice(0, 10),
      machineId: selectedCandidate?.id || null,
      machineCode: selectedCandidate?.code || null,
      machineName: selectedCandidate?.name || null,
      shiftId: step.recommendedShiftId || selectedShift?.id || null,
      shiftCode: selectedShift?.code || selectedCandidate?.recommendedShiftCode || null,
      shiftName: step.recommendedShiftName || selectedShift?.name || selectedCandidate?.recommendedShiftName || null,
      dieId: step.dieId || null,
      dieCode: step.die?.code || null,
      dieName: step.die?.name || null,
      eligibleMachineIds: candidates.map((item: any) => item.id),
      hasCapacityConflict: Boolean(step.hasCapacityConflict),
      conflictMessage: Array.isArray(step.conflictDetails) && step.conflictDetails.length > 0
        ? step.conflictDetails.join(' | ')
        : null,
    };
  });
}

function annotateProposalLineSlotConflicts(
  lines: Array<{
    plannedStartDate: Date;
    plannedEndDate: Date;
    operationAssignments: OperationAssignment[];
    warnings: string[];
  }>,
  shifts: any[],
  existingAssignments: any[] = [],
) {
  const shiftHoursById = new Map<string, number>();
  for (const s of shifts || []) {
    shiftHoursById.set(s.id, numeric(s.productiveHours) || 7.5);
  }
  const slotLoadMap = new Map<string, Array<{ label: string; hours: number }>>();

  for (const ex of existingAssignments) {
    if (!ex.machineId || !ex.shiftId || !ex.assignedDate) continue;
    const dKey = new Date(ex.assignedDate).toISOString().slice(0, 10);
    const slotKey = `${ex.machineId}::${dKey}::${ex.shiftId}`;
    const list = slotLoadMap.get(slotKey) || [];
    list.push({
      label: ex.productionOperation?.manufacturingOrder?.moNumber || 'دستور فعال کارگاه',
      hours: numeric(ex.shift?.productiveHours) || 7.5,
    });
    slotLoadMap.set(slotKey, list);
  }

  for (const line of lines) {
    for (const op of line.operationAssignments) {
      if (!op.machineId) continue;
      const dKey = (op.plannedStartDate || line.plannedStartDate.toISOString().slice(0, 10)).slice(0, 10);
      const shKey = op.shiftId || 'ANY';
      const slotKey = `${op.machineId}::${dKey}::${shKey}`;
      const existing = slotLoadMap.get(slotKey) || [];
      const capHours = (op.shiftId && shiftHoursById.get(op.shiftId)) || 7.5;
      const prevHours = existing.reduce((s, item) => s + item.hours, 0);
      const nextHours = round2(prevHours + Math.min(capHours, numeric(op.estimatedHours || 1)));
      if (existing.length > 0 || nextHours > capHours) {
        op.hasCapacityConflict = true;
        const reasons: string[] = [];
        if (existing.length > 0) {
          reasons.push(`تداخل در ${dKey} (${op.shiftName || 'شیفت انتخابی'}) با ${existing.map(e => e.label).join('، ')}`);
        }
        if (nextHours > capHours) {
          reasons.push(`بار ساعتی (${nextHours}h) بیش از ظرفیت شیفت (${capHours}h)`);
        }
        op.conflictMessage = reasons.join(' · ');
        const warnMsg = `عملیات ${op.stepCode} (${op.machineCode || op.machineId}): ${op.conflictMessage}`;
        if (!line.warnings.includes(warnMsg)) line.warnings.push(warnMsg);
      }
      existing.push({ label: `${op.stepCode}`, hours: Math.min(capHours, numeric(op.estimatedHours || 1)) });
      slotLoadMap.set(slotKey, existing);
    }
  }
}

export async function createRelationalPlanProposal(notes?: string) {
  const prisma = getPrismaClient() as any;
  const readModel = await getRelationalPlanningReadModel();
  const proposalLines: any[] = [];
  const missingRouteDemand = readModel.requirements.flatMap((requirement: any) =>
    !requirement.routeId || !requirement.route.length
      ? requirement.demandLines.filter((line: any) => line.plannedQty > 0).map((line: any) => `${requirement.partCode} / ${line.customerOrderNumber}`)
      : [],
  );
  if (missingRouteDemand.length) {
    throw new Error(`برای بخشی از تقاضای باز مسیر تولید فعال و پیش‌فرض تعریف نشده است: ${missingRouteDemand.slice(0, 5).join('، ')}. ابتدا مسیر تولید را تکمیل کنید.`);
  }

  const shifts = readModel.masterData?.shifts || [];
  const sortedRequirements = [...readModel.requirements].sort(
    (a: any, b: any) => (a.priority ?? 2) - (b.priority ?? 2) || new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime(),
  );

  for (const requirement of sortedRequirements) {
    if (!requirement.routeId || !requirement.route.length) continue;
    for (const demandLine of requirement.demandLines) {
      if (demandLine.plannedQty <= 0) continue;
      const assignments = buildAssignments(requirement.route, demandLine.plannedQty, shifts);
      const startDate = today();
      const endDate = new Date(Math.max(startDate.getTime(), new Date(demandLine.dueDate).getTime()));
      proposalLines.push({
        customerOrderLineId: demandLine.customerOrderLineId,
        partId: requirement.partId,
        routeId: requirement.routeId,
        requestedQty: demandLine.remainingQty,
        plannedQty: demandLine.plannedQty,
        plannedStartDate: startDate,
        plannedEndDate: endDate,
        priority: demandLine.priority,
        operationAssignments: assignments,
        warnings: [
          ...(requirement.dataWarnings || []),
          ...requirement.route.filter((step: any) => step.machineSelectionStatus === 'NO_ELIGIBLE_MACHINE')
            .map((step: any) => `برای عملیات ${step.stepCode} ماشین واجد شرایط پیدا نشد.`),
        ],
      });
    }
  }

  if (!proposalLines.length) {
    throw new Error('تقاضای تولیدِ برنامه‌ریزی‌نشده‌ای برای ساخت پیشنهاد جدید وجود ندارد؛ موجودی، WIP و برنامه‌های باز تقاضای فعلی را پوشش می‌دهند یا مسیر تولید ناقص است.');
  }

  proposalLines.sort((a, b) => a.priority - b.priority || a.plannedEndDate.getTime() - b.plannedEndDate.getTime());

  let existingAssignments: any[] = [];
  if (typeof prisma.machineAssignment?.findMany === 'function') {
    existingAssignments = await prisma.machineAssignment.findMany({
      where: { status: { in: ['SCHEDULED', 'ACTIVE'] } },
      include: {
        shift: { select: { productiveHours: true } },
        productionOperation: { select: { manufacturingOrder: { select: { moNumber: true } } } },
      },
    }).catch(() => []);
  }
  annotateProposalLineSlotConflicts(proposalLines, shifts, existingAssignments);

  const now = new Date();
  const id = randomUUID();
  const proposalNumber = makeNumber('PRP', now);
  const proposal = await prisma.$transaction(async (tx: any) => {
    const approvedPendingRelease = await tx.productionPlanProposal.count({ where: { status: 'APPROVED' } });
    if (approvedPendingRelease > 0) {
      throw new Error('یک پیشنهاد تاییدشده هنوز صادر نشده است؛ ابتدا آن را صادر یا لغو کنید، سپس پیشنهاد جدید بسازید.');
    }
    await tx.productionPlanProposal.updateMany({
      where: { status: 'DRAFT' },
      data: { status: 'SUPERSEDED' },
    });
    return tx.productionPlanProposal.create({
      data: {
        id,
        proposalNumber,
        revisionGroupId: id,
        version: 1,
        status: 'DRAFT',
        generatedAt: now,
        inputSnapshot: readModel as any,
        notes: notes || 'پیشنهاد تولید محاسبه‌شده از سفارش‌های تاییدشده، موجودی، WIP و اطلاعات پایه relational',
        lines: { create: proposalLines },
      },
      include: {
        lines: {
          include: {
            part: { select: { partNumber: true, name: true } },
            customerOrderLine: { include: { order: { select: { orderNumber: true, priority: true } } } },
          },
          orderBy: [{ priority: 'asc' }, { plannedEndDate: 'asc' }],
        },
      },
    });
  }, { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 });
  return proposal;
}

export async function listRelationalPlanProposals() {
  const prisma = getPrismaClient();
  return prisma.productionPlanProposal.findMany({
    include: {
      lines: {
        include: {
          part: { select: { partNumber: true, name: true } },
          customerOrderLine: { include: { order: { select: { orderNumber: true, priority: true } } } },
        },
        orderBy: [{ priority: 'asc' }, { plannedEndDate: 'asc' }],
      },
      productionPlan: { select: { id: true, planNumber: true, status: true } },
    },
    orderBy: [{ generatedAt: 'desc' }, { version: 'desc' }],
    take: 100,
  });
}

export async function getRelationalPlanProposal(id: string) {
  const prisma = getPrismaClient();
  return prisma.productionPlanProposal.findUnique({
    where: { id },
    include: {
      lines: {
        include: {
          part: { select: { partNumber: true, name: true } },
          route: { include: { operations: { include: { operation: true, machine: true, die: true }, orderBy: { stepNumber: 'asc' } } } },
          customerOrderLine: { include: { order: { select: { id: true, orderNumber: true, priority: true } } } },
        },
        orderBy: [{ priority: 'asc' }, { plannedEndDate: 'asc' }],
      },
      productionPlan: true,
    },
  });
}

export async function reviseRelationalPlanProposal(id: string, changes: any[], note: string) {
  const prisma = getPrismaClient() as any;
  return prisma.$transaction(async (tx: any) => {
    const source = await tx.productionPlanProposal.findUnique({
      where: { id },
      include: {
        lines: {
          include: {
            part: { select: { thicknessMm: true } },
            route: { include: { operations: { include: { die: true } } } },
          },
        },
      },
    });
    if (!source) throw new Error('پیشنهاد برنامه یافت نشد.');
    if (source.status !== 'DRAFT') throw new Error('فقط پیشنهاد در وضعیت پیش‌نویس قابل اصلاح است؛ برای پیشنهاد تاییدشده باید نسخه جدید ایجاد شود.');

    const changeMap = new Map<string, any>();
    for (const change of changes || []) {
      if (!change || typeof change.proposalLineId !== 'string' || !Array.isArray(change.operationAssignments)) {
        throw new Error('ساختار اصلاح تخصیص عملیات معتبر نیست.');
      }
      changeMap.set(change.proposalLineId, change);
    }

    const activeShifts = typeof tx.shift?.findMany === 'function'
      ? await tx.shift.findMany({ where: { active: true }, orderBy: [{ startTime: 'asc' }] }).catch(() => [])
      : [];
    const shiftById = new Map<string, any>(activeShifts.map((s: any) => [s.id, s]));

    const nextLines: any[] = [];
    for (const line of source.lines as any[]) {
      const change = changeMap.get(line.id);
      const nextPlannedQty =
        change?.plannedQty !== undefined && change?.plannedQty !== null
          ? Number(change.plannedQty)
          : numeric(line.plannedQty);
      if (!Number.isFinite(nextPlannedQty) || nextPlannedQty <= 0) {
        throw new Error('مقدار برنامه‌ریزی‌شده ردیف باید عددی مثبت باشد.');
      }

      const nextLineStart = change?.plannedStartDate ? new Date(change.plannedStartDate) : new Date(line.plannedStartDate);
      const nextLineEnd = change?.plannedEndDate ? new Date(change.plannedEndDate) : new Date(line.plannedEndDate);
      if (Number.isNaN(nextLineStart.getTime()) || Number.isNaN(nextLineEnd.getTime()) || nextLineEnd < nextLineStart) {
        throw new Error('بازه تاریخ شروع و پایان ردیف پیشنهاد معتبر نیست.');
      }
      const nextPriority = change?.priority !== undefined ? Number(change.priority) : Number(line.priority);
      if (![1, 2, 3].includes(nextPriority)) {
        throw new Error('اولویت ردیف پیشنهاد باید ۱، ۲ یا ۳ باشد.');
      }

      const assignments: OperationAssignment[] = (line.operationAssignments as any[]) || [];
      if (change && change.operationAssignments.some((item: any) =>
        !assignments.some((original: any) => original.routeOperationId === item.routeOperationId),
      )) {
        throw new Error('عملیاتی در اصلاح انتخاب شده که در مسیر تولید این قطعه وجود ندارد.');
      }

      const nextAssignments: OperationAssignment[] = [];
      for (const original of assignments) {
        const requested = change?.operationAssignments?.find((item: any) => item.routeOperationId === original.routeOperationId);
        if (!requested) {
          nextAssignments.push({
            ...original,
            hasCapacityConflict: false,
            conflictMessage: null,
          });
          continue;
        }
        if (requested.machineId !== undefined && requested.machineId !== null && typeof requested.machineId !== 'string') {
          throw new Error('شناسه ماشین انتخاب‌شده معتبر نیست.');
        }

        const nextMachineId = requested.machineId === undefined ? original.machineId : (requested.machineId || null);
        let machineCode = original.machineCode || null;
        let machineName = original.machineName || null;
        let efficiencyFactor = 1;

        if (nextMachineId !== null) {
          if (!original.eligibleMachineIds.includes(nextMachineId)) {
            throw new Error(`ماشین انتخاب‌شده برای عملیات ${original.stepCode} در فهرست ماشین‌های واجد شرایط نیست.`);
          }
          if (typeof tx.machine?.findUnique === 'function') {
            const machine = await tx.machine.findUnique({
              where: { id: nextMachineId },
              include: {
                capabilities: { where: { operationId: original.operationId } },
                dieCompatibilities: original.dieId ? { where: { dieId: original.dieId } } : true,
              },
            });
            if (machine) {
              const cap = machine.capabilities?.[0];
              const routeOp = line.route?.operations?.find((o: any) => o.id === original.routeOperationId);
              const reqTonnage = numeric(routeOp?.die?.tonnageRequired ?? original.requiredTonnage ?? 0);
              const thickness = line.part?.thicknessMm == null ? null : numeric(line.part.thicknessMm);
              if (!machine.active || machine.status !== 'ACTIVE' || !cap) {
                throw new Error(`ماشین انتخاب‌شده برای عملیات ${original.stepCode} فعال یا دارای قابلیت لازم نیست.`);
              }
              if (reqTonnage > 0 && (numeric(machine.tonnageCapacity) < reqTonnage || (cap.maxTonnage != null && numeric(cap.maxTonnage) < reqTonnage))) {
                throw new Error(`ظرفیت تناژ ماشین برای عملیات ${original.stepCode} کافی نیست.`);
              }
              if ((cap.minThicknessMm != null && (thickness == null || thickness < numeric(cap.minThicknessMm))) ||
                  (cap.maxThicknessMm != null && (thickness == null || thickness > numeric(cap.maxThicknessMm)))) {
                throw new Error(`محدوده ضخامت ورق با ماشین انتخاب‌شده برای عملیات ${original.stepCode} سازگار نیست.`);
              }
              if (original.dieId && !machine.dieCompatibilities.some((d: any) => d.dieId === original.dieId)) {
                throw new Error(`قالب عملیات ${original.stepCode} با ماشین انتخاب‌شده سازگار نیست.`);
              }
              machineCode = machine.code;
              machineName = machine.name;
              efficiencyFactor = numeric(cap.efficiencyFactor) > 0 ? numeric(cap.efficiencyFactor) : 1;
            }
          }
        } else {
          machineCode = null;
          machineName = null;
        }

        let nextShiftId = requested.shiftId === undefined ? (original.shiftId || null) : (requested.shiftId || null);
        let nextShiftCode = original.shiftCode || null;
        let nextShiftName = original.shiftName || null;
        if (nextShiftId && !String(nextShiftId).startsWith('DEFAULT-SHIFT-')) {
          const matchedShift = shiftById.get(nextShiftId);
          if (activeShifts.length > 0 && !matchedShift) {
            throw new Error(`شیفت انتخاب‌شده برای عملیات ${original.stepCode} معتبر یا فعال نیست.`);
          }
          if (matchedShift) {
            nextShiftCode = matchedShift.code;
            nextShiftName = matchedShift.name;
          }
        }

        const nextOpStart = requested.plannedStartDate
          ? String(requested.plannedStartDate).slice(0, 10)
          : (original.plannedStartDate || nextLineStart.toISOString().slice(0, 10));
        const nextOpEnd = requested.plannedEndDate
          ? String(requested.plannedEndDate).slice(0, 10)
          : (original.plannedEndDate || nextLineEnd.toISOString().slice(0, 10));
        if (new Date(nextOpEnd) < new Date(nextOpStart)) {
          throw new Error(`تاریخ پایان عملیات ${original.stepCode} نمی‌تواند قبل از تاریخ شروع باشد.`);
        }

        const estHours = round2(
          Math.max(0, Number(original.setupTimeMin || 0)) / 60 +
            (Math.max(0, nextPlannedQty) * Math.max(0, Number(original.standardCycleTimeSec || 0))) / 3600 / efficiencyFactor,
        );

        nextAssignments.push({
          ...original,
          machineId: nextMachineId,
          machineCode,
          machineName,
          shiftId: nextShiftId,
          shiftCode: nextShiftCode,
          shiftName: nextShiftName,
          plannedStartDate: nextOpStart,
          plannedEndDate: nextOpEnd,
          estimatedHours: estHours,
          hasCapacityConflict: false,
          conflictMessage: null,
        });
      }

      const baseWarnings = Array.isArray(line.warnings)
        ? line.warnings.filter((w: string) => !String(w).startsWith('عملیات ') && !String(w).includes('تداخل'))
        : [];
      nextLines.push({
        customerOrderLineId: line.customerOrderLineId,
        partId: line.partId,
        routeId: line.routeId,
        requestedQty: line.requestedQty,
        plannedQty: nextPlannedQty,
        plannedStartDate: nextLineStart,
        plannedEndDate: nextLineEnd,
        priority: nextPriority,
        operationAssignments: nextAssignments,
        warnings: baseWarnings,
      });
    }

    const existingAssignments = typeof tx.machineAssignment?.findMany === 'function'
      ? await tx.machineAssignment.findMany({
          where: { status: { in: ['SCHEDULED', 'ACTIVE'] } },
          include: {
            shift: { select: { productiveHours: true } },
            productionOperation: { select: { manufacturingOrder: { select: { moNumber: true } } } },
          },
        }).catch(() => [])
      : [];
    annotateProposalLineSlotConflicts(nextLines, activeShifts, existingAssignments);

    const nextVersion = source.version + 1;
    const nextId = randomUUID();
    const created = await tx.productionPlanProposal.create({
      data: {
        id: nextId,
        proposalNumber: makeNumber('PRP', new Date()),
        revisionGroupId: source.revisionGroupId,
        version: nextVersion,
        status: 'DRAFT',
        inputSnapshot: source.inputSnapshot as any,
        notes: note || `اصلاح نسخه ${source.version}`,
        lines: { create: nextLines },
      },
      include: {
        lines: {
          include: {
            part: { select: { partNumber: true, name: true } },
            customerOrderLine: { include: { order: { select: { orderNumber: true, priority: true } } } },
          },
          orderBy: [{ priority: 'asc' }, { plannedEndDate: 'asc' }],
        },
      },
    });
    await tx.productionPlanProposal.update({ where: { id: source.id }, data: { status: 'SUPERSEDED' } });
    return created;
  }, { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 });
}

export async function approveRelationalPlanProposal(id: string, approvedBy: string) {
  const prisma = getPrismaClient();
  const currentReadModel = await getRelationalPlanningReadModel();
  return prisma.$transaction(async tx => {
    const proposal = await tx.productionPlanProposal.findUnique({ where: { id }, include: { lines: true } });
    if (!proposal) throw new Error('پیشنهاد برنامه یافت نشد.');
    if (proposal.status === 'APPROVED' || proposal.status === 'RELEASED') return proposal;
    if (proposal.status !== 'DRAFT') throw new Error('فقط پیشنهاد پیش‌نویس قابل تایید است.');
    if (!proposal.lines.length) throw new Error('پیشنهاد بدون ردیف تولید قابل تایید نیست.');
    assertProposalDemandIsCurrent(proposal, currentReadModel);

    const now = new Date();
    return tx.productionPlanProposal.update({
      where: { id },
      data: { status: 'APPROVED', approvedByUserId: approvedBy, approvedAt: now },
      include: { lines: true },
    });
  }, { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 });
}

export async function releaseRelationalPlanProposal(id: string, releasedBy: string) {
  const prisma = getPrismaClient() as any;
  const currentReadModel = await getRelationalPlanningReadModel();
  const result = await prisma.$transaction(async (tx: any) => {
    const proposal = await tx.productionPlanProposal.findUnique({
      where: { id },
      include: {
        lines: {
          include: {
            customerOrderLine: { include: { order: true } },
            route: { include: { operations: { include: { operation: true, die: true }, orderBy: { stepNumber: 'asc' } } } },
            part: {
              select: {
                id: true,
                partNumber: true,
                name: true,
                thicknessMm: true,
                category: true,
                targetWarehouseId: true,
                targetLocationId: true,
              },
            },
          },
          orderBy: [{ priority: 'asc' }, { plannedEndDate: 'asc' }],
        },
        productionPlan: true,
      },
    });
    if (!proposal) throw new Error('پیشنهاد برنامه یافت نشد.');
    if (proposal.status === 'RELEASED' && proposal.productionPlan) {
      return { proposal, plan: proposal.productionPlan, manufacturingOrders: await tx.manufacturingOrder.findMany({ where: { planId: proposal.productionPlan.id }, include: { operations: true } }), replayed: true };
    }
    if (proposal.status !== 'APPROVED') throw new Error('برای صدور برنامه، ابتدا باید پیشنهاد تایید شود.');
    if (!proposal.lines.length) throw new Error('پیشنهاد بدون ردیف تولید قابل صدور نیست.');
    assertProposalDemandIsCurrent(proposal, currentReadModel);

    const activeShifts = typeof tx.shift?.findMany === 'function'
      ? await tx.shift.findMany({ where: { active: true }, orderBy: [{ startTime: 'asc' }] }).catch(() => [])
      : [];
    const shiftIdSet = new Set<string>(activeShifts.map((s: any) => s.id));
    const defaultShiftId = activeShifts[0]?.id || null;

    const now = new Date();
    const starts = proposal.lines.map((line: any) => line.plannedStartDate.getTime());
    const ends = proposal.lines.map((line: any) => line.plannedEndDate.getTime());
    const plan = await tx.productionPlan.create({
      data: {
        planNumber: makeNumber('PLN', now),
        title: `برنامه تولید بر اساس پیشنهاد ${proposal.proposalNumber} نسخه ${proposal.version}`,
        startDate: new Date(Math.min(...starts)),
        endDate: new Date(Math.max(...ends)),
        status: 'IN_PROGRESS',
        approvedByUserId: proposal.approvedByUserId || releasedBy,
        approvedAt: proposal.approvedAt || now,
        notes: proposal.notes,
        proposal: { connect: { id: proposal.id } },
      },
    });

    const manufacturingOrders: any[] = [];
    for (const line of proposal.lines as any[]) {
      const validationAssignments = (line.operationAssignments as OperationAssignment[]) || [];
      for (const assignment of validationAssignments) {
        if (!assignment.machineId) continue;
        const routeOperation = line.route.operations.find((item: any) => item.id === assignment.routeOperationId);
        const machine = await tx.machine.findUnique({
          where: { id: assignment.machineId },
          include: {
            capabilities: { where: { operationId: assignment.operationId } },
            dieCompatibilities: assignment.dieId ? { where: { dieId: assignment.dieId } } : true,
          },
        });
        const capability = machine?.capabilities?.[0];
        const requiredTonnage = numeric(routeOperation?.die?.tonnageRequired ?? 0);
        const thickness = line.part.thicknessMm == null ? null : numeric(line.part.thicknessMm);
        if (!machine || !machine.active || machine.status !== 'ACTIVE' || !capability) {
          throw new Error(`ماشین انتخاب‌شده برای عملیات ${assignment.stepCode} دیگر فعال یا واجد قابلیت لازم نیست؛ پیشنهاد را اصلاح کنید.`);
        }
        if (requiredTonnage > 0 && (numeric(machine.tonnageCapacity) < requiredTonnage ||
          (capability.maxTonnage != null && numeric(capability.maxTonnage) < requiredTonnage))) {
          throw new Error(`ظرفیت تناژ ماشین برای عملیات ${assignment.stepCode} کافی نیست.`);
        }
        if ((capability.minThicknessMm != null && (thickness == null || thickness < numeric(capability.minThicknessMm))) ||
          (capability.maxThicknessMm != null && (thickness == null || thickness > numeric(capability.maxThicknessMm)))) {
          throw new Error(`محدوده ضخامت ورق با ماشین انتخاب‌شده برای عملیات ${assignment.stepCode} سازگار نیست.`);
        }
        if (assignment.dieId && !machine.dieCompatibilities.some((item: any) => item.dieId === assignment.dieId)) {
          throw new Error(`سازگاری قالب با ماشین برای عملیات ${assignment.stepCode} تایید نشد.`);
        }
      }
      const customerLine = line.customerOrderLine;
      const planLine = await tx.productionPlanLine.create({
        data: {
          planId: plan.id,
          partId: line.partId,
          customerOrderId: customerLine.orderId,
          customerOrderLineId: line.customerOrderLineId,
          plannedQty: line.plannedQty,
          plannedStartDate: line.plannedStartDate,
          plannedEndDate: line.plannedEndDate,
          priority: line.priority,
          status: 'RELEASED',
        },
      });

      const assignments = (line.operationAssignments as OperationAssignment[]) || [];
      const assignmentByRouteOperation = new Map(assignments.map(item => [item.routeOperationId, item]));
      const outputDest = await resolveOutputDestination(tx, null, line.part);
      const operationCreates = [];
      for (let index = 0; index < line.route.operations.length; index += 1) {
        const routeOperation = line.route.operations[index];
        const assignment = assignmentByRouteOperation.get(routeOperation.id);
        const locCode = getLocationForProcess(routeOperation.operation.processType, routeOperation.stepNumber);
        const opLoc = await resolveLocationByCodeOrId(tx, locCode);
        const opStart = assignment?.plannedStartDate ? new Date(`${assignment.plannedStartDate.slice(0, 10)}T07:00:00.000Z`) : line.plannedStartDate;
        const opEnd = assignment?.plannedEndDate ? new Date(`${assignment.plannedEndDate.slice(0, 10)}T23:00:00.000Z`) : line.plannedEndDate;
        operationCreates.push({
          operationId: routeOperation.operationId,
          routeOperationId: routeOperation.id,
          stepNumber: routeOperation.stepNumber,
          sequence: index + 1,
          stepCode: routeOperation.stepCode,
          stepName: routeOperation.stepName,
          plannedMachineId: assignment?.machineId || null,
          plannedDieId: assignment?.dieId || routeOperation.dieId || null,
          plannedQty: line.plannedQty,
          waitingInputQty: 0,
          inProgressQty: 0,
          outputGoodQty: 0,
          outputScrapQty: 0,
          outputReworkQty: 0,
          outputRejectedQty: 0,
          readyForTransferQty: 0,
          transferredQty: 0,
          warehouseLocationCode: opLoc.code,
          warehouseId: opLoc.warehouseId,
          locationId: opLoc.id,
          standardCycleTimeSec: Number(routeOperation.standardCycleTimeSec || 0),
          scrapNormPercent: numeric(routeOperation.scrapNormPercent),
          status: (index === 0 ? 'READY' : 'PENDING') as 'READY' | 'PENDING',
          startDate: opStart,
          endDate: opEnd,
          lastActivityAt: now,
        });
      }

      const mo = await tx.manufacturingOrder.create({
        data: {
          moNumber: makeNumber('MO', now),
          partId: line.partId,
          routeId: line.routeId,
          planId: plan.id,
          planLineId: planLine.id,
          targetQty: line.plannedQty,
          initialInputQty: 0,
          completedQty: 0,
          scrapQty: 0,
          totalReworkQty: 0,
          totalRejectedQty: 0,
          outputWarehouseId: outputDest.warehouseId,
          outputLocationId: outputDest.id,
          scheduledStartDate: line.plannedStartDate,
          scheduledEndDate: line.plannedEndDate,
          priority: line.priority,
          status: 'RELEASED',
          createdByName: releasedBy,
          notes: `صادرشده از پیشنهاد ${proposal.proposalNumber}؛ ${releasedBy}`,
          operations: {
            create: operationCreates,
          },
        },
        include: { operations: { include: { plannedMachine: true, plannedDie: true }, orderBy: { stepNumber: 'asc' } } },
      });

      // Materialize relational MachineAssignment rows for scheduled capacity & conflict tracking
      if (defaultShiftId && typeof tx.machineAssignment?.create === 'function') {
        for (const createdOp of mo.operations || []) {
          if (!createdOp.plannedMachineId) continue;
          const assignMeta = assignmentByRouteOperation.get(createdOp.routeOperationId);
          const resolvedShiftId =
            assignMeta?.shiftId && shiftIdSet.has(assignMeta.shiftId)
              ? assignMeta.shiftId
              : defaultShiftId;
          await tx.machineAssignment.create({
            data: {
              machineId: createdOp.plannedMachineId,
              productionOperationId: createdOp.id,
              shiftId: resolvedShiftId,
              assignedDate: createdOp.startDate || line.plannedStartDate,
              status: 'SCHEDULED',
              notes: `تخصیص صادرشده از پیشنهاد ${proposal.proposalNumber} (${createdOp.stepCode})`,
            },
          });
        }
      }

      manufacturingOrders.push(mo);

      await tx.customerOrderLine.update({
        where: { id: line.customerOrderLineId },
        data: { status: 'IN_PRODUCTION' },
      });
    }

    const updatedProposal = await tx.productionPlanProposal.update({
      where: { id: proposal.id },
      data: { status: 'RELEASED', releasedAt: now },
    });
    return { proposal: updatedProposal, plan, manufacturingOrders, replayed: false };
  }, { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 });

  if (!result.replayed && result.manufacturingOrders.length) {
    await syncWipReadCacheFromPostgres();
  }
  return result;
}
