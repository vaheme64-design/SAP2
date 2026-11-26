import { getPrismaClient } from './db/prisma';
import type { MachineEligibilityCheck } from '../types/productionPlanning';
import type { ProcessType } from '../types/inventory';

const n = (value: unknown): number => Number(value ?? 0);
const round1 = (value: number): number => Math.round(value * 10) / 10;
const round2 = (value: number): number => Math.round(value * 100) / 100;
const toDateKey = (value: Date | string): string => new Date(value).toISOString().slice(0, 10);

function estimateOpHours(
  setupTimeMin: number,
  standardCycleTimeSec: number,
  quantity: number,
  efficiencyFactor = 1,
): number {
  const eff = efficiencyFactor > 0 ? efficiencyFactor : 1;
  const setupHrs = Math.max(0, setupTimeMin) / 60;
  const runHrs = (Math.max(0, quantity) * Math.max(0, standardCycleTimeSec)) / 3600 / eff;
  return round2(setupHrs + runHrs);
}

const DEFAULT_SHIFTS = [
  { id: 'DEFAULT-SHIFT-A', code: 'SHIFT-MORN', name: 'شیفت صبح', startTime: '07:00', endTime: '15:00', productiveHours: 7.5 },
  { id: 'DEFAULT-SHIFT-B', code: 'SHIFT-EVE', name: 'شیفت عصر', startTime: '15:00', endTime: '23:00', productiveHours: 7.5 },
];

export async function evaluateRelationalMachineEligibility(params: {
  processType?: ProcessType | string;
  operationId?: string;
  operationCode?: string;
  requiredTonnage?: number;
  plannedQuantity?: number;
  standardCycleTimeSec?: number;
  setupTimeMin?: number;
  assignedDieId?: string;
  assignedDieCode?: string;
  partThicknessMm?: number | null;
  assignedDate?: string;
}): Promise<MachineEligibilityCheck[]> {
  const prisma = getPrismaClient() as any;

  const safeFindMany = async (delegate: any, args: any): Promise<any[]> => {
    if (!delegate || typeof delegate.findMany !== 'function') return [];
    try {
      const rows = await delegate.findMany(args);
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  };

  const [machines, shifts, dies, activeAssignments, openOps] = await Promise.all([
    prisma.machine.findMany({
      include: {
        capabilities: { include: { operation: true } },
        dieCompatibilities: true,
      },
      orderBy: [{ code: 'asc' }],
    }),
    safeFindMany(prisma.shift, { where: { active: true }, orderBy: [{ startTime: 'asc' }] }),
    prisma.die.findMany({
      where: { active: true },
      include: { machineCompatibilities: true },
    }),
    safeFindMany(prisma.machineAssignment, {
      where: { status: { in: ['SCHEDULED', 'ACTIVE'] } },
      include: {
        shift: { select: { id: true, productiveHours: true } },
        productionOperation: {
          select: {
            id: true,
            plannedQty: true,
            standardCycleTimeSec: true,
            routeOperation: { select: { setupTimeMin: true, standardCycleTimeSec: true } },
          },
        },
      },
    }),
    safeFindMany(prisma.productionOperation, {
      where: {
        plannedMachineId: { not: null },
        status: { in: ['PENDING', 'READY', 'IN_PROGRESS'] },
        manufacturingOrder: { is: { status: { in: ['PLANNED', 'RELEASED', 'IN_PROGRESS', 'SUSPENDED'] } } },
      },
      include: {
        routeOperation: { select: { setupTimeMin: true, standardCycleTimeSec: true } },
      },
    }),
  ]);

  const effectiveShifts = shifts.length > 0
    ? shifts.map((s: any) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        productiveHours: n(s.productiveHours) > 0 ? n(s.productiveHours) : 7.5,
      }))
    : DEFAULT_SHIFTS;

  const dailyShiftHours = Math.max(
    1,
    round2(effectiveShifts.reduce((sum: number, s: any) => sum + s.productiveHours, 0)),
  );

  const targetDateKey = params.assignedDate ? toDateKey(params.assignedDate) : null;
  const assignedOpIds = new Set<string>();
  const machineLoadHours = new Map<string, number>();

  for (const a of activeAssignments) {
    if (a.productionOperationId) assignedOpIds.add(a.productionOperationId);
    if (targetDateKey && a.assignedDate && toDateKey(a.assignedDate) !== targetDateKey) continue;
    const op = a.productionOperation;
    const shiftCap = n(a.shift?.productiveHours) || 7.5;
    const hrs = op
      ? Math.min(
          shiftCap,
          Math.max(
            0.5,
            estimateOpHours(
              Number(op.routeOperation?.setupTimeMin ?? 20),
              Number(op.standardCycleTimeSec || op.routeOperation?.standardCycleTimeSec || 12),
              n(op.plannedQty),
            ),
          ),
        )
      : shiftCap;
    machineLoadHours.set(a.machineId, round2((machineLoadHours.get(a.machineId) || 0) + hrs));
  }

  for (const op of openOps) {
    if (!op.plannedMachineId || assignedOpIds.has(op.id)) continue;
    if (targetDateKey && op.startDate && toDateKey(op.startDate) !== targetDateKey) continue;
    const hrs = Math.min(
      dailyShiftHours,
      Math.max(
        0.5,
        estimateOpHours(
          Number(op.routeOperation?.setupTimeMin ?? 20),
          Number(op.standardCycleTimeSec || op.routeOperation?.standardCycleTimeSec || 12),
          n(op.plannedQty),
        ),
      ),
    );
    machineLoadHours.set(op.plannedMachineId, round2((machineLoadHours.get(op.plannedMachineId) || 0) + hrs));
  }

  const hasAssignedDie = Boolean(params.assignedDieId || params.assignedDieCode);
  const assignedDie = params.assignedDieId
    ? dies.find((d: any) => d.id === params.assignedDieId)
    : params.assignedDieCode
      ? dies.find((d: any) => d.code === params.assignedDieCode)
      : undefined;

  const setupMin = Number(params.setupTimeMin ?? 25);
  const cycleSec = Number(params.standardCycleTimeSec || 15);
  const plannedQty = Math.max(0, Number(params.plannedQuantity || 0));
  const requiredTonnage = Math.max(
    n(params.requiredTonnage),
    n(assignedDie?.tonnageRequired),
  );
  const thicknessMm = params.partThicknessMm == null ? null : n(params.partThicknessMm);

  const results: MachineEligibilityCheck[] = machines.map((machine: any) => {
    const ineligibilityReasons: string[] = [];

    const matchingCap = (machine.capabilities || []).find((c: any) => {
      if (params.operationId && c.operationId === params.operationId) return true;
      if (params.operationCode && c.operation?.code === params.operationCode) return true;
      if (params.processType && c.operation?.processType === params.processType) return true;
      return false;
    });
    const supportsProcess = Boolean(matchingCap);
    if (!supportsProcess) {
      ineligibilityReasons.push(`دستگاه فرایند ${params.operationCode || params.processType || 'موردنظر'} را پشتیبانی نمی‌کند.`);
    }

    const machineTonnage = n(machine.tonnageCapacity);
    const capMaxTonnage = matchingCap?.maxTonnage != null ? n(matchingCap.maxTonnage) : null;
    const tonnageSufficient =
      requiredTonnage <= 0 ||
      (machineTonnage >= requiredTonnage && (capMaxTonnage === null || capMaxTonnage >= requiredTonnage));
    if (!tonnageSufficient) {
      ineligibilityReasons.push(
        `تناژ ناکافی: ظرفیت دستگاه ${machineTonnage} تن کمتر از تناژ مورد نیاز (${requiredTonnage} تن) است.`,
      );
    }

    if (matchingCap && thicknessMm != null) {
      if (
        (matchingCap.minThicknessMm != null && thicknessMm < n(matchingCap.minThicknessMm)) ||
        (matchingCap.maxThicknessMm != null && thicknessMm > n(matchingCap.maxThicknessMm))
      ) {
        ineligibilityReasons.push(`ضخامت ورق (${thicknessMm} mm) خارج از محدوده مجاز دستگاه است.`);
      }
    } else if (matchingCap && (matchingCap.minThicknessMm != null || matchingCap.maxThicknessMm != null) && thicknessMm == null && params.partThicknessMm !== undefined) {
      ineligibilityReasons.push('ضخامت قطعه برای کنترل محدوده ضخامت دستگاه مشخص نشده است.');
    }

    let dieCompatible = !hasAssignedDie || Boolean(assignedDie);
    if (hasAssignedDie && !assignedDie) {
      dieCompatible = false;
      ineligibilityReasons.push(`قالب «${params.assignedDieCode || params.assignedDieId}» در اطلاعات پایه یافت نشد.`);
    } else if (assignedDie) {
      const compat = (machine.dieCompatibilities || []).some((dc: any) => dc.dieId === assignedDie.id);
      if (!compat) {
        dieCompatible = false;
        ineligibilityReasons.push(`قالب ${assignedDie.code} با میز/کورس این دستگاه سازگار نیست.`);
      }
    }

    const isMachineActive = Boolean(machine.active) && machine.status === 'ACTIVE';
    if (!isMachineActive) {
      ineligibilityReasons.push(
        machine.status === 'MAINTENANCE'
          ? 'دستگاه در وضعیت تعمیرات دوره‌ای (PM) است.'
          : machine.status === 'BREAKDOWN'
            ? 'دستگاه به دلیل خرابی متوقف است.'
            : 'دستگاه در حال حاضر فعال نیست.',
      );
    }

    const eff = n(matchingCap?.efficiencyFactor) > 0 ? n(matchingCap.efficiencyFactor) : 1;
    const estimatedRunHours = round1(estimateOpHours(setupMin, cycleSec, plannedQty, eff));
    const currentWorkload = round1(machineLoadHours.get(machine.id) || 0);
    const availableHoursRemaining = round1(Math.max(0, dailyShiftHours - currentWorkload));
    const minRequired = Math.min(1.0, Math.max(0.25, estimatedRunHours));
    const capacityAvailable = availableHoursRemaining >= minRequired;
    if (!capacityAvailable) {
      ineligibilityReasons.push(
        `ظرفیت شیفت‌های فعال پر است (آزاد: ${availableHoursRemaining} ساعت، حداقل نیاز: ${minRequired} ساعت).`,
      );
    }

    const thicknessOk =
      !matchingCap ||
      thicknessMm == null ||
      ((matchingCap.minThicknessMm == null || thicknessMm >= n(matchingCap.minThicknessMm)) &&
        (matchingCap.maxThicknessMm == null || thicknessMm <= n(matchingCap.maxThicknessMm)));

    const isEligible = supportsProcess && tonnageSufficient && thicknessOk && dieCompatible && isMachineActive && capacityAvailable;

    let suitabilityScore = 0;
    let recommendationReason = '';
    if (isEligible) {
      suitabilityScore = 45;
      if (matchingCap?.isPreferred) suitabilityScore += 15;
      suitabilityScore += Math.round((availableHoursRemaining / dailyShiftHours) * 25);
      if (requiredTonnage > 0 && machineTonnage > 0) {
        const excessRatio = (machineTonnage - requiredTonnage) / requiredTonnage;
        suitabilityScore += excessRatio <= 0.25 ? 10 : excessRatio <= 0.6 ? 7 : 4;
      } else {
        suitabilityScore += 7;
      }
      if (eff >= 1) suitabilityScore += 5;
      suitabilityScore = Math.min(100, suitabilityScore);
      recommendationReason = `${machine.name} با تناژ ${machineTonnage} تن، ضریب راندمان ${eff} و ${availableHoursRemaining} ساعت ظرفیت آزاد واجد شرایط است.`;
    } else {
      recommendationReason = ineligibilityReasons.join(' | ');
    }

    return {
      machineId: machine.id,
      machineCode: machine.code,
      machineName: machine.name,
      isEligible,
      ineligibilityReasons,
      supportsProcess,
      tonnageSufficient,
      dieCompatible,
      isMachineActive,
      capacityAvailable,
      dailyCapacityHours: dailyShiftHours,
      currentWorkloadHours: currentWorkload,
      availableHoursRemaining,
      estimatedSetupTimeMin: setupMin,
      estimatedRunTimeHours: estimatedRunHours,
      currentWorkloadPercent: Math.min(100, Math.round((currentWorkload / dailyShiftHours) * 100)),
      suitabilityScore,
      recommendationRank: 999,
      recommendationReason,
    };
  });

  results.sort((a, b) => {
    if (a.isEligible !== b.isEligible) return a.isEligible ? -1 : 1;
    return b.suitabilityScore - a.suitabilityScore;
  });
  let rank = 1;
  for (const r of results) {
    r.recommendationRank = r.isEligible ? rank++ : 999;
  }
  return results;
}

export async function getRelationalMachineCapacity(filters?: {
  date?: string;
  hall?: string;
  machineId?: string;
  onlyConflicts?: boolean;
}) {
  const prisma = getPrismaClient() as any;

  const safeFindMany = async (delegate: any, args: any): Promise<any[]> => {
    if (!delegate || typeof delegate.findMany !== 'function') return [];
    try {
      const rows = await delegate.findMany(args);
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  };

  const [shifts, machines, assignmentsRaw, openOps, proposals] = await Promise.all([
    safeFindMany(prisma.shift, { where: { active: true }, orderBy: [{ startTime: 'asc' }] }),
    prisma.machine.findMany({
      where: { active: true },
      include: { capabilities: { include: { operation: true } }, dieCompatibilities: true },
      orderBy: [{ code: 'asc' }],
    }),
    safeFindMany(prisma.machineAssignment, {
      where: { status: { in: ['SCHEDULED', 'ACTIVE', 'COMPLETED'] } },
      include: {
        machine: true,
        shift: true,
        assignedOperator: { select: { id: true, fullName: true, personnelCode: true } },
        productionOperation: {
          include: {
            operation: true,
            plannedDie: true,
            routeOperation: { include: { die: true } },
            manufacturingOrder: {
              include: { part: { select: { id: true, partNumber: true, name: true, thicknessMm: true } } },
            },
          },
        },
      },
      orderBy: [{ assignedDate: 'asc' }, { createdAt: 'asc' }],
    }),
    safeFindMany(prisma.productionOperation, {
      where: {
        status: { in: ['PENDING', 'READY', 'IN_PROGRESS'] },
        manufacturingOrder: { is: { status: { in: ['PLANNED', 'RELEASED', 'IN_PROGRESS', 'SUSPENDED'] } } },
      },
      include: {
        operation: true,
        plannedMachine: true,
        plannedDie: true,
        routeOperation: { include: { die: true } },
        manufacturingOrder: {
          include: { part: { select: { id: true, partNumber: true, name: true, thicknessMm: true } } },
        },
      },
      orderBy: [{ stepNumber: 'asc' }],
    }),
    safeFindMany(prisma.productionPlanProposal, {
      where: { status: { in: ['DRAFT', 'APPROVED'] } },
      include: {
        lines: {
          include: {
            part: { select: { id: true, partNumber: true, name: true } },
            customerOrderLine: { include: { order: { select: { orderNumber: true } } } },
          },
        },
      },
      orderBy: [{ generatedAt: 'desc' }],
      take: 3,
    }),
  ]);

  const effectiveShifts = shifts.length > 0
    ? shifts.map((s: any) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        startTime: s.startTime,
        endTime: s.endTime,
        productiveHours: n(s.productiveHours) > 0 ? n(s.productiveHours) : 7.5,
      }))
    : DEFAULT_SHIFTS;

  const dailyCapacityHours = Math.max(
    1,
    round2(effectiveShifts.reduce((s: number, sh: any) => s + sh.productiveHours, 0)),
  );

  const activeAssignedOpIds = new Set<string>();
  const unifiedSlots: any[] = [];

  for (const a of assignmentsRaw) {
    if (a.status === 'SCHEDULED' || a.status === 'ACTIVE') {
      activeAssignedOpIds.add(a.productionOperationId);
    }
    const op = a.productionOperation;
    const mo = op?.manufacturingOrder;
    const die = op?.plannedDie || op?.routeOperation?.die;
    const setupMin = Number(op?.routeOperation?.setupTimeMin ?? 20);
    const cycleSec = Number(op?.standardCycleTimeSec || op?.routeOperation?.standardCycleTimeSec || 12);
    const plannedQty = n(op?.plannedQty);
    const estHours = Math.max(0.5, estimateOpHours(setupMin, cycleSec, plannedQty));
    const dateKey = a.assignedDate ? toDateKey(a.assignedDate) : toDateKey(new Date());

    unifiedSlots.push({
      id: a.id,
      sourceType: 'MACHINE_ASSIGNMENT',
      productionOperationId: a.productionOperationId,
      moId: mo?.id || null,
      moNumber: mo?.moNumber || '—',
      partId: mo?.partId || null,
      partCode: mo?.part?.partNumber || '—',
      partName: mo?.part?.name || '—',
      thicknessMm: mo?.part?.thicknessMm == null ? null : n(mo.part.thicknessMm),
      stepNumber: op?.stepNumber || 10,
      stepCode: op?.stepCode || op?.operation?.code || 'OP10',
      stepName: op?.stepName || op?.operation?.name || 'عملیات تولید',
      operationId: op?.operationId || null,
      processType: op?.operation?.processType || null,
      machineId: a.machineId,
      machineCode: a.machine?.code || '—',
      machineName: a.machine?.name || '—',
      hallLocation: a.machine?.hallLocation || 'سالن تولید',
      tonnageCapacity: a.machine?.tonnageCapacity == null ? null : n(a.machine.tonnageCapacity),
      shiftId: a.shiftId,
      shiftCode: a.shift?.code || '—',
      shiftName: a.shift?.name || 'شیفت',
      shiftStartTime: a.shift?.startTime || '07:00',
      shiftEndTime: a.shift?.endTime || '15:00',
      shiftProductiveHours: n(a.shift?.productiveHours) || 7.5,
      assignedDate: dateKey,
      plannedQty,
      estimatedHours: estHours,
      setupTimeMin: setupMin,
      dieId: die?.id || null,
      dieCode: die?.code || null,
      dieName: die?.name || null,
      requiredTonnage: die?.tonnageRequired ? n(die.tonnageRequired) : 0,
      status: a.status,
      assignedOperator: a.assignedOperator || null,
      notes: a.notes || null,
      hasConflict: false,
      conflictReasons: [] as string[],
    });
  }

  // Also expose open operations that already carry plannedMachineId but don't yet have a MachineAssignment row
  for (const op of openOps) {
    if (!op.plannedMachineId || activeAssignedOpIds.has(op.id)) continue;
    const mo = op.manufacturingOrder;
    const die = op.plannedDie || op.routeOperation?.die;
    const setupMin = Number(op.routeOperation?.setupTimeMin ?? 20);
    const cycleSec = Number(op.standardCycleTimeSec || op.routeOperation?.standardCycleTimeSec || 12);
    const plannedQty = n(op.plannedQty);
    const estHours = Math.max(0.5, estimateOpHours(setupMin, cycleSec, plannedQty));
    const dDate = op.startDate || mo?.scheduledStartDate || new Date();
    const firstShift = effectiveShifts[0];

    unifiedSlots.push({
      id: `OP:${op.id}`,
      sourceType: 'OPERATION_SCHEDULE',
      productionOperationId: op.id,
      moId: mo?.id || null,
      moNumber: mo?.moNumber || '—',
      partId: mo?.partId || null,
      partCode: mo?.part?.partNumber || '—',
      partName: mo?.part?.name || '—',
      thicknessMm: mo?.part?.thicknessMm == null ? null : n(mo.part.thicknessMm),
      stepNumber: op.stepNumber,
      stepCode: op.stepCode || op.operation?.code || 'OP10',
      stepName: op.stepName || op.operation?.name || 'عملیات تولید',
      operationId: op.operationId,
      processType: op.operation?.processType || null,
      machineId: op.plannedMachineId,
      machineCode: op.plannedMachine?.code || '—',
      machineName: op.plannedMachine?.name || '—',
      hallLocation: op.plannedMachine?.hallLocation || 'سالن تولید',
      tonnageCapacity: op.plannedMachine?.tonnageCapacity == null ? null : n(op.plannedMachine.tonnageCapacity),
      shiftId: firstShift.id,
      shiftCode: firstShift.code,
      shiftName: `${firstShift.name} (پیش‌فرض عملیات)`,
      shiftStartTime: firstShift.startTime,
      shiftEndTime: firstShift.endTime,
      shiftProductiveHours: firstShift.productiveHours,
      assignedDate: toDateKey(dDate),
      plannedQty,
      estimatedHours: estHours,
      setupTimeMin: setupMin,
      dieId: die?.id || null,
      dieCode: die?.code || null,
      dieName: die?.name || null,
      requiredTonnage: die?.tonnageRequired ? n(die.tonnageRequired) : 0,
      status: op.status === 'IN_PROGRESS' ? 'ACTIVE' : 'SCHEDULED',
      assignedOperator: null,
      notes: 'زمان‌بندی مستقیم عملیات دستور ساخت (نیازمند ثبت شیفت دقیق)',
      hasConflict: false,
      conflictReasons: [] as string[],
    });
  }

  // Conflict detection on ACTIVE/SCHEDULED slots
  const activeSlots = unifiedSlots.filter(s => s.status === 'SCHEDULED' || s.status === 'ACTIVE');
  const byMachineDateShift = new Map<string, any[]>();
  const byMachineDate = new Map<string, any[]>();

  for (const s of activeSlots) {
    const sKey = `${s.machineId}::${s.assignedDate}::${s.shiftId}`;
    const sList = byMachineDateShift.get(sKey) || [];
    sList.push(s);
    byMachineDateShift.set(sKey, sList);

    const dKey = `${s.machineId}::${s.assignedDate}`;
    const dList = byMachineDate.get(dKey) || [];
    dList.push(s);
    byMachineDate.set(dKey, dList);
  }

  const conflicts: Array<{
    id: string;
    conflictType: 'SHIFT_DOUBLE_BOOKING' | 'DAILY_OVER_CAPACITY';
    machineId: string;
    machineCode: string;
    machineName: string;
    assignedDate: string;
    shiftId: string | null;
    shiftName: string | null;
    totalHours: number;
    capacityHours: number;
    assignmentIds: string[];
    moNumbers: string[];
    message: string;
  }> = [];

  for (const [, list] of byMachineDateShift) {
    if (list.length > 1) {
      const first = list[0];
      const msg = `تداخل همزمان روی ${first.machineCode} در تاریخ ${first.assignedDate} (${first.shiftName}) بین ${list.map(x => `${x.moNumber}/${x.stepCode}`).join(' و ')}`;
      for (const item of list) {
        item.hasConflict = true;
        if (!item.conflictReasons.includes(msg)) item.conflictReasons.push(msg);
      }
      conflicts.push({
        id: `CONF-SLOT-${first.machineId}-${first.assignedDate}-${first.shiftId}`,
        conflictType: 'SHIFT_DOUBLE_BOOKING',
        machineId: first.machineId,
        machineCode: first.machineCode,
        machineName: first.machineName,
        assignedDate: first.assignedDate,
        shiftId: first.shiftId,
        shiftName: first.shiftName,
        totalHours: round2(list.reduce((s, x) => s + x.estimatedHours, 0)),
        capacityHours: first.shiftProductiveHours,
        assignmentIds: list.map(x => x.id),
        moNumbers: list.map(x => x.moNumber),
        message: msg,
      });
    }
  }

  for (const [, list] of byMachineDate) {
    const totalHrs = round2(list.reduce((s, x) => s + x.estimatedHours, 0));
    if (totalHrs > dailyCapacityHours) {
      const first = list[0];
      const msg = `اضافه‌بار روزانه ${first.machineCode} در ${first.assignedDate}: ${totalHrs} ساعت بارگذاری > ${dailyCapacityHours} ساعت ظرفیت`;
      for (const item of list) {
        item.hasConflict = true;
        if (!item.conflictReasons.includes(msg)) item.conflictReasons.push(msg);
      }
      conflicts.push({
        id: `CONF-CAP-${first.machineId}-${first.assignedDate}`,
        conflictType: 'DAILY_OVER_CAPACITY',
        machineId: first.machineId,
        machineCode: first.machineCode,
        machineName: first.machineName,
        assignedDate: first.assignedDate,
        shiftId: null,
        shiftName: 'کل روز کاری',
        totalHours: totalHrs,
        capacityHours: dailyCapacityHours,
        assignmentIds: list.map(x => x.id),
        moNumbers: list.map(x => x.moNumber),
        message: msg,
      });
    }
  }

  // Unassigned open operations eligible for planner assignment
  const unassignedOperations = openOps
    .filter(op => !activeAssignedOpIds.has(op.id))
    .map(op => {
      const mo = op.manufacturingOrder;
      const die = op.plannedDie || op.routeOperation?.die;
      const requiredTonnage = n(die?.tonnageRequired);
      const thickness = mo?.part?.thicknessMm == null ? null : n(mo.part.thicknessMm);
      const eligibleMachineIds = machines
        .filter((m: any) => {
          if (m.status !== 'ACTIVE') return false;
          const cap = (m.capabilities || []).find((c: any) => c.operationId === op.operationId);
          if (!cap) return false;
          if (requiredTonnage > 0 && (n(m.tonnageCapacity) < requiredTonnage || (cap.maxTonnage != null && n(cap.maxTonnage) < requiredTonnage))) {
            return false;
          }
          if (
            (cap.minThicknessMm != null && (thickness == null || thickness < n(cap.minThicknessMm))) ||
            (cap.maxThicknessMm != null && (thickness == null || thickness > n(cap.maxThicknessMm)))
          ) {
            return false;
          }
          if (die?.id && !(m.dieCompatibilities || []).some((dc: any) => dc.dieId === die.id)) {
            return false;
          }
          return true;
        })
        .map((m: any) => m.id);

      const setupMin = Number(op.routeOperation?.setupTimeMin ?? 20);
      const cycleSec = Number(op.standardCycleTimeSec || op.routeOperation?.standardCycleTimeSec || 12);

      return {
        productionOperationId: op.id,
        moId: mo?.id || null,
        moNumber: mo?.moNumber || '—',
        partCode: mo?.part?.partNumber || '—',
        partName: mo?.part?.name || '—',
        thicknessMm: thickness,
        stepNumber: op.stepNumber,
        stepCode: op.stepCode || op.operation?.code || 'OP',
        stepName: op.stepName || op.operation?.name || 'عملیات',
        operationId: op.operationId,
        processType: op.operation?.processType || null,
        plannedMachineId: op.plannedMachineId || null,
        plannedQty: n(op.plannedQty),
        estimatedHours: Math.max(0.5, estimateOpHours(setupMin, cycleSec, n(op.plannedQty))),
        setupTimeMin: setupMin,
        dieId: die?.id || null,
        dieCode: die?.code || null,
        requiredTonnage,
        suggestedDate: toDateKey(op.startDate || mo?.scheduledStartDate || new Date()),
        eligibleMachineIds,
      };
    });

  // Read-only draft proposal preview (never committed until planner approves/releases)
  const draftProposalPreview = proposals.flatMap((prop: any) =>
    (prop.lines || []).flatMap((line: any) =>
      ((line.operationAssignments as any[]) || []).map((oa: any) => ({
        proposalId: prop.id,
        proposalNumber: prop.proposalNumber,
        proposalStatus: prop.status,
        isDraftPreview: true,
        partCode: line.part?.partNumber || '—',
        partName: line.part?.name || '—',
        orderNumber: line.customerOrderLine?.order?.orderNumber || '—',
        stepNumber: oa.stepNumber,
        stepCode: oa.stepCode,
        stepName: oa.stepName,
        machineId: oa.machineId || null,
        machineCode: oa.machineCode || null,
        machineName: oa.machineName || null,
        shiftId: oa.shiftId || null,
        shiftName: oa.shiftName || null,
        assignedDate: oa.plannedStartDate || toDateKey(line.plannedStartDate),
        plannedQty: n(line.plannedQty),
        estimatedHours: n(oa.estimatedHours || 1),
        hasCapacityConflict: Boolean(oa.hasCapacityConflict),
      })),
    ),
  );

  // Filter outputs cleanly when query params provided
  let filteredSlots = unifiedSlots;
  if (filters?.date) {
    filteredSlots = filteredSlots.filter(s => s.assignedDate === filters.date);
  }
  if (filters?.hall && filters.hall !== 'ALL') {
    filteredSlots = filteredSlots.filter(s => s.hallLocation === filters.hall);
  }
  if (filters?.machineId && filters.machineId !== 'ALL') {
    filteredSlots = filteredSlots.filter(s => s.machineId === filters.machineId);
  }
  if (filters?.onlyConflicts) {
    filteredSlots = filteredSlots.filter(s => s.hasConflict);
  }

  // Machine summaries
  const machineList = machines.map((m: any) => {
    const mSlots = filteredSlots.filter(s => s.machineId === m.id && (s.status === 'SCHEDULED' || s.status === 'ACTIVE'));
    const bookedHours = round2(mSlots.reduce((sum, s) => sum + s.estimatedHours, 0));
    return {
      id: m.id,
      code: m.code,
      name: m.name,
      hallLocation: m.hallLocation || 'سالن تولید',
      machineType: m.machineType,
      tonnageCapacity: m.tonnageCapacity == null ? null : n(m.tonnageCapacity),
      status: m.status,
      dailyCapacityHours,
      scheduledHours: bookedHours,
      availableCapacityHours: round2(Math.max(0, dailyCapacityHours - bookedHours)),
      utilizationPercent: Math.min(100, Math.round((bookedHours / dailyCapacityHours) * 100)),
      conflictsCount: conflicts.filter(c => c.machineId === m.id).length,
      capabilities: (m.capabilities || []).map((c: any) => ({
        operationId: c.operationId,
        operationCode: c.operation?.code || '',
        processType: c.operation?.processType || '',
        maxTonnage: c.maxTonnage == null ? null : n(c.maxTonnage),
        minThicknessMm: c.minThicknessMm == null ? null : n(c.minThicknessMm),
        maxThicknessMm: c.maxThicknessMm == null ? null : n(c.maxThicknessMm),
        efficiencyFactor: n(c.efficiencyFactor) || 1,
        isPreferred: Boolean(c.isPreferred),
      })),
      compatibleDieIds: (m.dieCompatibilities || []).map((d: any) => d.dieId),
    };
  });

  const activeOnlyMachines = machineList.filter((m: any) => m.status === 'ACTIVE');
  const avgUtil = activeOnlyMachines.length > 0
    ? Math.round((activeOnlyMachines.reduce((s: number, m: any) => s + m.utilizationPercent, 0) / activeOnlyMachines.length) * 10) / 10
    : 0;

  return {
    source: 'postgresql',
    shifts: effectiveShifts,
    machines: machineList,
    assignments: filteredSlots,
    conflicts,
    unassignedOperations,
    draftProposalPreview,
    summary: {
      totalAssignments: filteredSlots.filter(s => s.status !== 'CANCELLED').length,
      activeMachinesCount: activeOnlyMachines.length,
      conflictsCount: conflicts.length,
      unassignedOperationsCount: unassignedOperations.length,
      averageUtilizationPercent: avgUtil,
      totalDailyShiftHours: dailyCapacityHours,
    },
  };
}

function validateMachineOperationCompatibility(params: {
  machine: any;
  operationId: string;
  stepCode: string;
  requiredTonnage: number;
  thicknessMm: number | null;
  dieId: string | null;
}) {
  const { machine, operationId, stepCode, requiredTonnage, thicknessMm, dieId } = params;
  if (!machine || !machine.active || machine.status !== 'ACTIVE') {
    throw Object.assign(
      new Error(`ماشین انتخاب‌شده برای عملیات ${stepCode} فعال یا آماده به کار نیست.`),
      { statusCode: 400 },
    );
  }
  const cap = (machine.capabilities || []).find((c: any) => c.operationId === operationId);
  if (!cap) {
    throw Object.assign(
      new Error(`ماشین ${machine.code} قابلیت فنی انجام عملیات ${stepCode} را ندارد.`),
      { statusCode: 400 },
    );
  }
  if (
    requiredTonnage > 0 &&
    (n(machine.tonnageCapacity) < requiredTonnage || (cap.maxTonnage != null && n(cap.maxTonnage) < requiredTonnage))
  ) {
    throw Object.assign(
      new Error(`ظرفیت تناژ ماشین ${machine.code} (${n(machine.tonnageCapacity)} تن) برای عملیات ${stepCode} (${requiredTonnage} تن) کافی نیست.`),
      { statusCode: 400 },
    );
  }
  if (
    (cap.minThicknessMm != null && (thicknessMm == null || thicknessMm < n(cap.minThicknessMm))) ||
    (cap.maxThicknessMm != null && (thicknessMm == null || thicknessMm > n(cap.maxThicknessMm)))
  ) {
    throw Object.assign(
      new Error(`ضخامت ورق با محدوده مجاز ماشین ${machine.code} برای عملیات ${stepCode} سازگار نیست.`),
      { statusCode: 400 },
    );
  }
  if (dieId && !(machine.dieCompatibilities || []).some((dc: any) => dc.dieId === dieId)) {
    throw Object.assign(
      new Error(`قالب عملیات ${stepCode} با ماشین ${machine.code} سازگار نیست.`),
      { statusCode: 400 },
    );
  }
  return cap;
}

export async function createRelationalMachineAssignment(payload: {
  productionOperationId: string;
  machineId: string;
  shiftId: string;
  assignedDate: string;
  assignedOperatorId?: string | null;
  notes?: string | null;
  allowConflictOverride?: boolean;
  actor?: string;
}) {
  const prisma = getPrismaClient() as any;
  if (!payload.productionOperationId || !payload.machineId || !payload.shiftId || !payload.assignedDate) {
    throw Object.assign(
      new Error('شناسه عملیات تولید، ماشین، شیفت و تاریخ تخصیص الزامی هستند.'),
      { statusCode: 400 },
    );
  }
  const assignedDay = new Date(`${toDateKey(payload.assignedDate)}T00:00:00.000Z`);
  if (Number.isNaN(assignedDay.getTime())) {
    throw Object.assign(new Error('تاریخ تخصیص معتبر نیست.'), { statusCode: 400 });
  }

  return prisma.$transaction(async (tx: any) => {
    const [op, machine, shift] = await Promise.all([
      tx.productionOperation.findUnique({
        where: { id: payload.productionOperationId },
        include: {
          plannedDie: true,
          routeOperation: { include: { die: true } },
          manufacturingOrder: { include: { part: true } },
        },
      }),
      tx.machine.findUnique({
        where: { id: payload.machineId },
        include: { capabilities: true, dieCompatibilities: true },
      }),
      tx.shift.findUnique({ where: { id: payload.shiftId } }),
    ]);

    if (!op) {
      throw Object.assign(new Error('عملیات تولید یافت نشد.'), { statusCode: 404 });
    }
    if (['COMPLETED', 'SKIPPED'].includes(op.status) || ['CANCELLED', 'CLOSED'].includes(op.manufacturingOrder?.status)) {
      throw Object.assign(new Error('امکان تخصیص ماشین به عملیات تکمیل‌شده یا لغوشده وجود ندارد.'), { statusCode: 409 });
    }
    if (!shift || !shift.active) {
      throw Object.assign(new Error('شیفت انتخاب‌شده یافت نشد یا غیرفعال است.'), { statusCode: 400 });
    }

    const die = op.plannedDie || op.routeOperation?.die;
    const cap = validateMachineOperationCompatibility({
      machine,
      operationId: op.operationId,
      stepCode: op.stepCode || `STEP-${op.stepNumber}`,
      requiredTonnage: n(die?.tonnageRequired),
      thicknessMm: op.manufacturingOrder?.part?.thicknessMm == null ? null : n(op.manufacturingOrder.part.thicknessMm),
      dieId: die?.id || null,
    });

    const dateKey = toDateKey(assignedDay);
    const sameDayAssignments = await tx.machineAssignment.findMany({
      where: {
        machineId: payload.machineId,
        status: { in: ['SCHEDULED', 'ACTIVE'] },
      },
      include: {
        shift: true,
        productionOperation: {
          select: {
            id: true,
            stepCode: true,
            plannedQty: true,
            standardCycleTimeSec: true,
            manufacturingOrder: { select: { moNumber: true } },
            routeOperation: { select: { setupTimeMin: true, standardCycleTimeSec: true } },
          },
        },
      },
    });

    const sameDayList = sameDayAssignments.filter((a: any) => toDateKey(a.assignedDate) === dateKey);
    const sameShiftConflicts = sameDayList.filter((a: any) => a.shiftId === payload.shiftId);

    const activeShifts = await tx.shift.findMany({ where: { active: true } });
    const dailyCapHours = Math.max(
      1,
      activeShifts.reduce((s: number, sh: any) => s + (n(sh.productiveHours) || 7.5), 0),
    );
    const newOpHours = Math.max(
      0.5,
      estimateOpHours(
        Number(op.routeOperation?.setupTimeMin ?? 20),
        Number(op.standardCycleTimeSec || op.routeOperation?.standardCycleTimeSec || 12),
        n(op.plannedQty),
        n(cap.efficiencyFactor) || 1,
      ),
    );
    const existingHours = sameDayList.reduce((sum: number, a: any) => {
      const o = a.productionOperation;
      return sum + (o
        ? Math.max(
            0.5,
            estimateOpHours(
              Number(o.routeOperation?.setupTimeMin ?? 20),
              Number(o.standardCycleTimeSec || o.routeOperation?.standardCycleTimeSec || 12),
              n(o.plannedQty),
            ),
          )
        : 7.5);
    }, 0);

    const conflictMessages: string[] = [];
    if (sameShiftConflicts.length > 0) {
      conflictMessages.push(
        `ماشین ${machine.code} در تاریخ ${dateKey} و ${shift.name} قبلاً به ${sameShiftConflicts.map((c: any) => c.productionOperation?.manufacturingOrder?.moNumber || c.id).join('، ')} تخصیص یافته است.`,
      );
    }
    if (round2(existingHours + newOpHours) > dailyCapHours) {
      conflictMessages.push(
        `بارگذاری روزانه (${round2(existingHours + newOpHours)} ساعت) از ظرفیت کل شیفت‌ها (${dailyCapHours} ساعت) فراتر می‌رود.`,
      );
    }

    if (conflictMessages.length > 0 && !payload.allowConflictOverride) {
      throw Object.assign(
        new Error(conflictMessages.join(' | ')),
        { statusCode: 409, conflicts: conflictMessages },
      );
    }

    const created = await tx.machineAssignment.create({
      data: {
        machineId: payload.machineId,
        productionOperationId: payload.productionOperationId,
        shiftId: payload.shiftId,
        assignedDate: assignedDay,
        assignedOperatorId: payload.assignedOperatorId || null,
        status: 'SCHEDULED',
        notes: payload.notes || (payload.allowConflictOverride && conflictMessages.length ? `[تایید دستی با تداخل] ${conflictMessages.join(' | ')}` : null),
      },
      include: {
        machine: true,
        shift: true,
        productionOperation: { include: { manufacturingOrder: true } },
      },
    });

    await tx.productionOperation.update({
      where: { id: op.id },
      data: {
        plannedMachineId: payload.machineId,
        startDate: op.startDate || assignedDay,
        endDate: op.endDate && op.endDate >= assignedDay ? op.endDate : assignedDay,
      },
    });

    if (typeof tx.auditLog?.create === 'function') {
      await tx.auditLog.create({
        data: {
          action: 'MACHINE_ASSIGNMENT_CREATE',
          entityName: 'MachineAssignment',
          entityId: created.id,
          newValues: {
            machineId: created.machineId,
            machineCode: created.machine?.code,
            shiftId: created.shiftId,
            assignedDate: dateKey,
            productionOperationId: created.productionOperationId,
            moNumber: op.manufacturingOrder?.moNumber,
            conflictOverridden: Boolean(payload.allowConflictOverride && conflictMessages.length > 0),
            actor: payload.actor || 'برنامه‌ریز تولید',
          },
        },
      });
    }

    return created;
  }, { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 });
}

export async function updateRelationalMachineAssignment(
  id: string,
  payload: {
    machineId?: string;
    shiftId?: string;
    assignedDate?: string;
    status?: 'SCHEDULED' | 'ACTIVE' | 'COMPLETED';
    assignedOperatorId?: string | null;
    notes?: string | null;
    allowConflictOverride?: boolean;
    actor?: string;
  },
) {
  const prisma = getPrismaClient() as any;

  return prisma.$transaction(async (tx: any) => {
    const existing = await tx.machineAssignment.findUnique({
      where: { id },
      include: {
        machine: true,
        shift: true,
        productionOperation: {
          include: {
            plannedDie: true,
            routeOperation: { include: { die: true } },
            manufacturingOrder: { include: { part: true } },
          },
        },
      },
    });
    if (!existing) {
      throw Object.assign(new Error('تخصیص ماشین یافت نشد.'), { statusCode: 404 });
    }
    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
      throw Object.assign(new Error('تخصیص تکمیل‌شده یا لغوشده قابل ویرایش نیست.'), { statusCode: 409 });
    }

    const nextMachineId = payload.machineId || existing.machineId;
    const nextShiftId = payload.shiftId || existing.shiftId;
    const nextAssignedDay = payload.assignedDate
      ? new Date(`${toDateKey(payload.assignedDate)}T00:00:00.000Z`)
      : new Date(existing.assignedDate);
    if (Number.isNaN(nextAssignedDay.getTime())) {
      throw Object.assign(new Error('تاریخ تخصیص معتبر نیست.'), { statusCode: 400 });
    }

    const [machine, shift] = await Promise.all([
      tx.machine.findUnique({
        where: { id: nextMachineId },
        include: { capabilities: true, dieCompatibilities: true },
      }),
      tx.shift.findUnique({ where: { id: nextShiftId } }),
    ]);

    if (!shift || !shift.active) {
      throw Object.assign(new Error('شیفت انتخاب‌شده یافت نشد یا غیرفعال است.'), { statusCode: 400 });
    }

    const op = existing.productionOperation;
    const die = op?.plannedDie || op?.routeOperation?.die;
    if (op) {
      validateMachineOperationCompatibility({
        machine,
        operationId: op.operationId,
        stepCode: op.stepCode || `STEP-${op.stepNumber}`,
        requiredTonnage: n(die?.tonnageRequired),
        thicknessMm: op.manufacturingOrder?.part?.thicknessMm == null ? null : n(op.manufacturingOrder.part.thicknessMm),
        dieId: die?.id || null,
      });
    }

    const dateKey = toDateKey(nextAssignedDay);
    const otherAssignments = await tx.machineAssignment.findMany({
      where: {
        id: { not: id },
        machineId: nextMachineId,
        status: { in: ['SCHEDULED', 'ACTIVE'] },
      },
      include: {
        shift: true,
        productionOperation: {
          select: {
            id: true,
            plannedQty: true,
            standardCycleTimeSec: true,
            manufacturingOrder: { select: { moNumber: true } },
            routeOperation: { select: { setupTimeMin: true, standardCycleTimeSec: true } },
          },
        },
      },
    });
    const sameDayOthers = otherAssignments.filter((a: any) => toDateKey(a.assignedDate) === dateKey);
    const sameShiftConflicts = sameDayOthers.filter((a: any) => a.shiftId === nextShiftId);

    const conflictMessages: string[] = [];
    if (sameShiftConflicts.length > 0) {
      conflictMessages.push(
        `تداخل شیفت روی ${machine.code} در ${dateKey} (${shift.name}) با ${sameShiftConflicts.map((c: any) => c.productionOperation?.manufacturingOrder?.moNumber || c.id).join('، ')}`,
      );
    }

    if (conflictMessages.length > 0 && !payload.allowConflictOverride) {
      throw Object.assign(new Error(conflictMessages.join(' | ')), { statusCode: 409, conflicts: conflictMessages });
    }

    const updated = await tx.machineAssignment.update({
      where: { id },
      data: {
        machineId: nextMachineId,
        shiftId: nextShiftId,
        assignedDate: nextAssignedDay,
        assignedOperatorId: payload.assignedOperatorId === undefined ? existing.assignedOperatorId : payload.assignedOperatorId,
        status: payload.status || existing.status,
        notes: payload.notes === undefined ? existing.notes : payload.notes,
      },
      include: { machine: true, shift: true },
    });

    if (op && nextMachineId !== existing.machineId) {
      await tx.productionOperation.update({
        where: { id: op.id },
        data: { plannedMachineId: nextMachineId },
      });
    }

    if (typeof tx.auditLog?.create === 'function') {
      await tx.auditLog.create({
        data: {
          action: 'MACHINE_ASSIGNMENT_UPDATE',
          entityName: 'MachineAssignment',
          entityId: id,
          oldValues: {
            machineId: existing.machineId,
            shiftId: existing.shiftId,
            assignedDate: toDateKey(existing.assignedDate),
            status: existing.status,
          },
          newValues: {
            machineId: updated.machineId,
            shiftId: updated.shiftId,
            assignedDate: dateKey,
            status: updated.status,
            actor: payload.actor || 'برنامه‌ریز تولید',
          },
        },
      });
    }

    return updated;
  }, { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 });
}

export async function cancelRelationalMachineAssignment(id: string, reason?: string, actor?: string) {
  const prisma = getPrismaClient() as any;

  return prisma.$transaction(async (tx: any) => {
    const existing = await tx.machineAssignment.findUnique({
      where: { id },
      include: { machine: true, shift: true, productionOperation: true },
    });
    if (!existing) {
      throw Object.assign(new Error('تخصیص ماشین یافت نشد.'), { statusCode: 404 });
    }
    if (existing.status === 'COMPLETED') {
      throw Object.assign(new Error('امکان لغو تخصیص تکمیل‌شده وجود ندارد.'), { statusCode: 409 });
    }
    if (existing.status === 'CANCELLED') {
      return { replayed: true, assignment: existing };
    }

    const updated = await tx.machineAssignment.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        notes: reason ? `${existing.notes ? `${existing.notes} | ` : ''}لغو: ${reason}` : existing.notes,
      },
      include: { machine: true, shift: true },
    });

    if (typeof tx.auditLog?.create === 'function') {
      await tx.auditLog.create({
        data: {
          action: 'MACHINE_ASSIGNMENT_CANCEL',
          entityName: 'MachineAssignment',
          entityId: id,
          oldValues: {
            machineId: existing.machineId,
            shiftId: existing.shiftId,
            assignedDate: toDateKey(existing.assignedDate),
            status: existing.status,
          },
          newValues: {
            status: 'CANCELLED',
            reason: reason || 'لغو توسط برنامه‌ریز تولید',
            actor: actor || 'برنامه‌ریز تولید',
          },
        },
      });
    }

    return { replayed: false, assignment: updated };
  }, { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 });
}
