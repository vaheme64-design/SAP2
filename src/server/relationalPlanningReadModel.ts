import { getPrismaClient } from './db/prisma';

export interface RelationalMachineCandidate {
  id: string;
  code: string;
  name: string;
  tonnageCapacity: number | null;
  preferred: boolean;
  efficiencyFactor: number;
  estimatedHours: number;
  dailyCapacityHours: number;
  scheduledHours: number;
  availableCapacityHours: number;
  utilizationPercent: number;
  existingConflictsCount: number;
  wouldExceedDailyCapacity: boolean;
  recommendedShiftId: string | null;
  recommendedShiftCode: string | null;
  recommendedShiftName: string | null;
  suitabilityScore: number;
}

export interface RelationalExplodedComponent {
  partId: string | null;
  partCode: string;
  partName: string;
  unitCode: string;
  materialId: string | null;
  materialGrade: string | null;
  level: number;
  qtyPerParent: number;
  scrapFactorPercent: number;
  grossRequiredQty: number;
  wipCreditedQty: number;
  netRequiredQty: number;
  availableQty: number;
  shortageQty: number;
  hasShortage: boolean;
}

export interface RelationalNetRequirement {
  partId: string;
  partCode: string;
  partName: string;
  materialId: string | null;
  materialCode: string | null;
  materialGrade: string | null;
  dueDate: string;
  priority: number;
  customerOrderIds: string[];
  customerOrderNumbers: string[];
  demandLines: Array<{
    customerOrderLineId: string;
    customerOrderId: string;
    customerOrderNumber: string;
    lineNumber: number;
    priority: number;
    requestedQty: number;
    deliveredQty: number;
    remainingQty: number;
    alreadyPlannedQty: number;
    plannedQty: number;
    dueDate: string;
  }>;
  grossDemandQty: number;
  physicalFinishedGoodsQty: number;
  reservedFinishedGoodsQty: number;
  availableFinishedGoodsQty: number;
  downstreamWipQty: number;
  netProductionRequirement: number;
  requiredMaterialKg: number;
  availableRawMaterialKg: number;
  totalRawMaterialPoolKg: number;
  materialShortageKg: number;
  hasMaterialShortage: boolean;
  bomSource: 'BOM_COMPONENT_TREE' | 'PART_GROSS_WEIGHT';
  explodedComponents: RelationalExplodedComponent[];
  estimatedStartDate: string;
  estimatedCompletionDate: string;
  hasDueDateRisk: boolean;
  hasCapacityConflict: boolean;
  routeId: string | null;
  route: Array<{
    routeOperationId: string;
    stepNumber: number;
    stepCode: string;
    stepName: string;
    operationId: string;
    operationCode: string;
    dieId: string | null;
    processType: string;
    requiredTonnage: number;
    eligibleMachines: RelationalMachineCandidate[];
    machineSelectionStatus: 'CANDIDATES_FOUND' | 'NO_ELIGIBLE_MACHINE';
    setupTimeMin: number;
    standardCycleTimeSec: number;
    scrapNormPercent: number;
    estimatedHours: number;
    estimatedStartDate: string;
    estimatedEndDate: string;
    recommendedShiftId: string | null;
    recommendedShiftName: string | null;
    hasCapacityConflict: boolean;
    conflictDetails: string[];
    assignedMachine: { id: string; code: string; name: string } | null;
    die: { id: string; code: string; name: string; tonnageRequired: number } | null;
  }>;
  dataWarnings: string[];
}

const n = (value: unknown): number => Number(value ?? 0);
const round1 = (value: number): number => Math.round(value * 10) / 10;
const round2 = (value: number): number => Math.round(value * 100) / 100;
const toDateKey = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (d: Date, days: number): Date => new Date(d.getTime() + days * 86400000);

function estimateOperationHours(
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

export async function getRelationalPlanningReadModel() {
  const prisma = getPrismaClient() as any;
  const now = new Date();
  const todayUtc = new Date(`${toDateKey(now)}T00:00:00.000Z`);

  const safeFindMany = async (delegate: any, args: any): Promise<any[]> => {
    if (!delegate || typeof delegate.findMany !== 'function') return [];
    try {
      const rows = await delegate.findMany(args);
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  };

  const [
    orders,
    finishedBalances,
    wipBalances,
    reservations,
    rawBalances,
    parts,
    machines,
    dies,
    shifts,
    machineAssignments,
    openProductionOps,
    bomItems,
    allParts,
  ] = await Promise.all([
    prisma.customerOrder.findMany({
      where: { documentStatus: { in: ['CONFIRMED'] } },
      include: {
        customer: { select: { id: true, name: true } },
        orderLines: {
          where: { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
          include: {
            part: { include: { material: true } },
            productionPlanLines: {
              where: { status: { in: ['PLANNED', 'RELEASED', 'IN_PROGRESS'] } },
              select: { plannedQty: true, producedQty: true },
            },
          },
          orderBy: [{ requestedDate: 'asc' }, { lineNumber: 'asc' }],
        },
      },
      orderBy: [{ priority: 'asc' }, { requestedDeliveryDate: 'asc' }],
    }),
    prisma.stockBalance.findMany({
      where: {
        warehouse: { type: 'FINISHED_GOODS', active: true },
        qualityStatus: 'AVAILABLE',
        part: { active: true, category: 'FINISHED_GOOD' },
      },
      select: { partId: true, quantityOnHand: true, quantityReserved: true, quantityAvailable: true },
    }),
    prisma.stockBalance.findMany({
      where: {
        warehouse: { type: 'WIP', active: true },
        qualityStatus: 'AVAILABLE',
        part: { active: true },
      },
      select: { partId: true, quantityAvailable: true },
    }),
    prisma.inventoryReservation.findMany({
      where: {
        status: 'ACTIVE',
        OR: [{ validUntil: null }, { validUntil: { gt: now } }],
        warehouse: { type: 'FINISHED_GOODS', active: true },
      },
      select: { partId: true, quantity: true },
    }),
    prisma.stockBalance.findMany({
      where: {
        warehouse: { type: 'RAW_MATERIALS', active: true },
        qualityStatus: 'AVAILABLE',
        part: { active: true, category: { in: ['RAW_MATERIAL', 'CONSUMABLE'] } },
      },
      include: {
        part: {
          select: {
            id: true,
            partNumber: true,
            materialId: true,
            unit: { select: { code: true } },
            material: { select: { id: true, code: true, grade: true } },
          },
        },
      },
    }),
    prisma.part.findMany({
      where: { active: true, category: 'FINISHED_GOOD' },
      include: {
        material: true,
        routes: {
          where: { status: 'ACTIVE', isDefault: true },
          orderBy: { effectiveFrom: 'desc' },
          take: 1,
          include: {
            operations: {
              orderBy: { stepNumber: 'asc' },
              include: {
                operation: true,
                machine: true,
                die: true,
              },
            },
          },
        },
      },
    }),
    prisma.machine.findMany({
      where: { active: true },
      include: { capabilities: { include: { operation: true } }, dieCompatibilities: true },
    }),
    prisma.die.findMany({
      where: { active: true, status: { in: ['READY', 'ON_MACHINE'] } },
      include: { machineCompatibilities: true },
    }),
    safeFindMany(prisma.shift, {
      where: { active: true },
      orderBy: [{ startTime: 'asc' }],
    }),
    safeFindMany(prisma.machineAssignment, {
      where: { status: { in: ['SCHEDULED', 'ACTIVE'] } },
      include: {
        shift: { select: { id: true, code: true, name: true, startTime: true, endTime: true, productiveHours: true } },
        productionOperation: {
          select: {
            id: true,
            stepNumber: true,
            stepCode: true,
            plannedQty: true,
            standardCycleTimeSec: true,
            startDate: true,
            endDate: true,
            manufacturingOrder: {
              select: { id: true, moNumber: true, status: true, scheduledStartDate: true, scheduledEndDate: true },
            },
            routeOperation: { select: { setupTimeMin: true, standardCycleTimeSec: true } },
          },
        },
      },
      orderBy: [{ assignedDate: 'asc' }],
    }),
    safeFindMany(prisma.productionOperation, {
      where: {
        plannedMachineId: { not: null },
        status: { in: ['PENDING', 'READY', 'IN_PROGRESS'] },
        manufacturingOrder: { is: { status: { in: ['PLANNED', 'RELEASED', 'IN_PROGRESS', 'SUSPENDED'] } } },
      },
      include: {
        manufacturingOrder: {
          select: { id: true, moNumber: true, status: true, targetQty: true, completedQty: true, scheduledStartDate: true, scheduledEndDate: true },
        },
        routeOperation: { select: { setupTimeMin: true, standardCycleTimeSec: true } },
      },
    }),
    safeFindMany(prisma.item, {
      where: { isDeleted: false },
      include: {
        bomParents: {
          where: { isDeleted: false },
          include: { childItem: true },
        },
      },
    }),
    safeFindMany(prisma.part, {
      where: { active: true },
      include: { material: true, unit: true },
    }),
  ]);

  // -------------------------------------------------------------------------
  // 1. Shift & Existing Machine Capacity Ledger
  // -------------------------------------------------------------------------
  const activeShifts = shifts.length > 0
    ? shifts.map((s: any) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        startTime: s.startTime,
        endTime: s.endTime,
        breakDurationMin: Number(s.breakDurationMin ?? 60),
        productiveHours: n(s.productiveHours) > 0 ? n(s.productiveHours) : 7.5,
      }))
    : [
        { id: 'DEFAULT-SHIFT-A', code: 'SHIFT-MORN', name: 'شیفت صبح (پیش‌فرض)', startTime: '07:00', endTime: '15:00', breakDurationMin: 30, productiveHours: 7.5 },
        { id: 'DEFAULT-SHIFT-B', code: 'SHIFT-EVE', name: 'شیفت عصر (پیش‌فرض)', startTime: '15:00', endTime: '23:00', breakDurationMin: 30, productiveHours: 7.5 },
      ];

  const totalDailyShiftHours = Math.max(
    1,
    round2(activeShifts.reduce((sum: number, s: any) => sum + s.productiveHours, 0)),
  );

  const assignmentCountByOpId = new Set<string>();
  const machineSlotUsage = new Map<string, number>(); // key: `${machineId}::${dateKey}::${shiftId}` -> count
  const machineBookedHoursTotal = new Map<string, number>();
  const machineExistingConflictCount = new Map<string, number>();
  const machineShiftLoad = new Map<string, number>(); // key: `${machineId}::${shiftId}` -> booked hours

  for (const assign of machineAssignments) {
    if (assign.productionOperationId) assignmentCountByOpId.add(assign.productionOperationId);
    const shiftHours = n(assign.shift?.productiveHours) || 7.5;
    const op = assign.productionOperation;
    const estHours = op
      ? Math.min(
          shiftHours,
          Math.max(
            0.5,
            estimateOperationHours(
              Number(op.routeOperation?.setupTimeMin ?? 20),
              Number(op.standardCycleTimeSec || op.routeOperation?.standardCycleTimeSec || 12),
              n(op.plannedQty),
            ),
          ),
        )
      : shiftHours;
    machineBookedHoursTotal.set(assign.machineId, round2((machineBookedHoursTotal.get(assign.machineId) || 0) + estHours));
    if (assign.shiftId) {
      const shKey = `${assign.machineId}::${assign.shiftId}`;
      machineShiftLoad.set(shKey, round2((machineShiftLoad.get(shKey) || 0) + estHours));
    }
    const dKey = assign.assignedDate ? toDateKey(new Date(assign.assignedDate)) : toDateKey(todayUtc);
    const slotKey = `${assign.machineId}::${dKey}::${assign.shiftId || 'ANY'}`;
    const nextSlotCount = (machineSlotUsage.get(slotKey) || 0) + 1;
    machineSlotUsage.set(slotKey, nextSlotCount);
    if (nextSlotCount > 1) {
      machineExistingConflictCount.set(assign.machineId, (machineExistingConflictCount.get(assign.machineId) || 0) + 1);
    }
  }

  // Also include open ProductionOperations that have plannedMachineId but no MachineAssignment yet
  const unlinkedOpsByMachine = new Map<string, any[]>();
  for (const op of openProductionOps) {
    if (!op.plannedMachineId || assignmentCountByOpId.has(op.id)) continue;
    const list = unlinkedOpsByMachine.get(op.plannedMachineId) || [];
    list.push(op);
    unlinkedOpsByMachine.set(op.plannedMachineId, list);
    const estHours = Math.max(
      0.5,
      estimateOperationHours(
        Number(op.routeOperation?.setupTimeMin ?? 20),
        Number(op.standardCycleTimeSec || op.routeOperation?.standardCycleTimeSec || 12),
        n(op.plannedQty),
      ),
    );
    machineBookedHoursTotal.set(
      op.plannedMachineId,
      round2((machineBookedHoursTotal.get(op.plannedMachineId) || 0) + Math.min(totalDailyShiftHours, estHours)),
    );
  }
  for (const [machineId, list] of unlinkedOpsByMachine) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const aStart = list[i].startDate ? new Date(list[i].startDate).getTime() : list[i].manufacturingOrder?.scheduledStartDate?.getTime?.();
        const aEnd = list[i].endDate ? new Date(list[i].endDate).getTime() : list[i].manufacturingOrder?.scheduledEndDate?.getTime?.();
        const bStart = list[j].startDate ? new Date(list[j].startDate).getTime() : list[j].manufacturingOrder?.scheduledStartDate?.getTime?.();
        const bEnd = list[j].endDate ? new Date(list[j].endDate).getTime() : list[j].manufacturingOrder?.scheduledEndDate?.getTime?.();
        if (aStart && aEnd && bStart && bEnd && Math.max(aStart, bStart) < Math.min(aEnd, bEnd)) {
          machineExistingConflictCount.set(machineId, (machineExistingConflictCount.get(machineId) || 0) + 1);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2. Inventory Pools (FG, WIP, Reservations, Raw Material by Material & Part)
  // -------------------------------------------------------------------------
  const finishedByPart = new Map<string, number>();
  for (const row of finishedBalances) {
    finishedByPart.set(row.partId, (finishedByPart.get(row.partId) || 0) + n(row.quantityOnHand));
  }

  const wipByPart = new Map<string, number>();
  for (const row of wipBalances) {
    wipByPart.set(row.partId, (wipByPart.get(row.partId) || 0) + n(row.quantityAvailable));
  }

  const reservedByPart = new Map<string, number>();
  for (const row of reservations) {
    reservedByPart.set(row.partId, (reservedByPart.get(row.partId) || 0) + n(row.quantity));
  }

  const rawByMaterial = new Map<string, number>();
  const rawByPartId = new Map<string, { qty: number; weightKg: number }>();
  for (const row of rawBalances) {
    const qtyAvail = n(row.quantityAvailable);
    const kgAvail = n(row.weightKgAvailable);
    const curPart = rawByPartId.get(row.partId) || { qty: 0, weightKg: 0 };
    curPart.qty += qtyAvail;
    curPart.weightKg += kgAvail;
    rawByPartId.set(row.partId, curPart);

    const materialId = row.part?.materialId;
    if (materialId) {
      rawByMaterial.set(materialId, (rawByMaterial.get(materialId) || 0) + kgAvail);
    }
  }

  const remainingRawByMaterial = new Map<string, number>(rawByMaterial);
  const remainingRawByPartId = new Map<string, { qty: number; weightKg: number }>();
  for (const [pId, bal] of rawByPartId) {
    remainingRawByPartId.set(pId, { ...bal });
  }
  const remainingWipByPart = new Map<string, number>(wipByPart);

  // Lookup maps for BOM explosion
  const effectiveAllParts = allParts.length > 0 ? allParts : parts;
  const partById = new Map<string, any>(parts.map((part: any) => [part.id, part] as [string, any]));
  const anyPartByCode = new Map<string, any>(
    effectiveAllParts.map((part: any) => [String(part.partNumber || '').trim().toUpperCase(), part]),
  );
  const itemByCode = new Map<string, any>(
    bomItems.map((item: any) => [String(item.code || '').trim().toUpperCase(), item]),
  );

  // -------------------------------------------------------------------------
  // 3. Aggregate & Prioritize Open Customer Demand
  // -------------------------------------------------------------------------
  type DemandLineEntry = {
    customerOrderLineId: string;
    customerOrderId: string;
    customerOrderNumber: string;
    lineNumber: number;
    priority: number;
    requestedQty: number;
    deliveredQty: number;
    remainingQty: number;
    alreadyPlannedQty: number;
    plannedQty: number;
    dueDate: Date;
  };
  type DemandEntry = {
    gross: number;
    dueDate: Date;
    priority: number;
    orderIds: Set<string>;
    orderNumbers: Set<string>;
    demandLines: DemandLineEntry[];
  };
  const demand = new Map<string, DemandEntry>();

  for (const order of orders) {
    for (const line of order.orderLines) {
      const orderedRemainder = Math.max(0, n(line.orderedQty) - n(line.deliveredQty));
      const alreadyPlannedQty = (line.productionPlanLines || []).reduce(
        (sum: number, planLine: any) => sum + Math.max(0, n(planLine.plannedQty) - n(planLine.producedQty)),
        0,
      );
      const remaining = Math.max(0, orderedRemainder - alreadyPlannedQty);
      if (remaining <= 0 || !partById.has(line.partId)) continue;
      const current: DemandEntry = demand.get(line.partId) || {
        gross: 0,
        dueDate: line.requestedDate,
        priority: Number(order.priority || 2),
        orderIds: new Set<string>(),
        orderNumbers: new Set<string>(),
        demandLines: [],
      };
      current.gross += remaining;
      if (line.requestedDate < current.dueDate) current.dueDate = line.requestedDate;
      if (Number(order.priority || 2) < current.priority) current.priority = Number(order.priority || 2);
      current.orderIds.add(order.id);
      current.orderNumbers.add(order.orderNumber);
      current.demandLines.push({
        customerOrderLineId: line.id,
        customerOrderId: order.id,
        customerOrderNumber: order.orderNumber,
        lineNumber: line.lineNumber,
        priority: Number(order.priority || 2),
        requestedQty: n(line.orderedQty),
        deliveredQty: n(line.deliveredQty),
        remainingQty: remaining,
        alreadyPlannedQty: round1(alreadyPlannedQty),
        plannedQty: 0,
        dueDate: line.requestedDate,
      });
      demand.set(line.partId, current);
    }
  }

  // Sort parts by priority ASC, earliest dueDate ASC for sequential raw material & capacity allocation
  const prioritizedDemandEntries = [...demand.entries()].sort(
    ([, a], [, b]) => a.priority - b.priority || a.dueDate.getTime() - b.dueDate.getTime(),
  );

  // Track cumulative in-run machine schedule hours across this planning run
  const plannedRunLoadByMachineDate = new Map<string, number>(); // key: `${machineId}::${dateKey}` -> hours
  const plannedRunLoadByMachineTotal = new Map<string, number>(); // key: machineId -> hours

  // Helper: multi-level BOM explosion for a finished part
  const explodeBomForPart = (part: any, netQty: number): {
    exploded: RelationalExplodedComponent[];
    usedBomTree: boolean;
    totalMaterialKg: number;
  } => {
    const rootCode = String(part.partNumber || '').trim().toUpperCase();
    const rootItem = itemByCode.get(rootCode);
    if (!rootItem || !Array.isArray(rootItem.bomParents) || rootItem.bomParents.length === 0) {
      return { exploded: [], usedBomTree: false, totalMaterialKg: 0 };
    }

    const exploded: RelationalExplodedComponent[] = [];
    let totalMaterialKg = 0;

    const visit = (item: any, parentQty: number, level: number, visited: Set<string>) => {
      const children = Array.isArray(item.bomParents) ? item.bomParents : [];
      for (const cmp of children) {
        const childItem = cmp.childItem;
        if (!childItem || childItem.isDeleted) continue;
        const childCodeUpper = String(childItem.code || '').trim().toUpperCase();
        if (visited.has(childCodeUpper)) continue;

        const qtyPerParent = n(cmp.quantity) > 0 ? n(cmp.quantity) : 1;
        const scrapPct = Math.max(0, n(cmp.scrapFactor));
        const grossRequired = round2(parentQty * qtyPerParent * (1 + scrapPct / 100));
        const matchedPart = anyPartByCode.get(childCodeUpper) || null;

        let wipCredited = 0;
        let netRequired = grossRequired;
        const hasGrandchildren = Array.isArray(childItem.bomParents) && childItem.bomParents.length > 0;
        if (matchedPart && (hasGrandchildren || childItem.type === 'SEMI_FINISHED' || matchedPart.category === 'WIP_PART')) {
          const availWip = remainingWipByPart.get(matchedPart.id) || 0;
          wipCredited = round2(Math.min(netRequired, availWip));
          if (wipCredited > 0) {
            remainingWipByPart.set(matchedPart.id, round2(Math.max(0, availWip - wipCredited)));
          }
          netRequired = round2(Math.max(0, grossRequired - wipCredited));
        }

        const unitCode = matchedPart?.unit?.code || childItem.unit || 'PCS';
        let availableQty = 0;
        if (!hasGrandchildren) {
          if (matchedPart && remainingRawByPartId.has(matchedPart.id)) {
            const pBal = remainingRawByPartId.get(matchedPart.id)!;
            if (unitCode === 'KG') {
              const matCap = matchedPart.materialId
                ? round2(remainingRawByMaterial.get(matchedPart.materialId) ?? pBal.weightKg)
                : round2(pBal.weightKg);
              availableQty = round2(Math.min(pBal.weightKg, matCap));
              const consumedKg = Math.min(availableQty, netRequired);
              pBal.weightKg = Math.max(0, round2(pBal.weightKg - consumedKg));
              if (matchedPart.materialId) {
                remainingRawByMaterial.set(
                  matchedPart.materialId,
                  Math.max(0, round2(matCap - consumedKg)),
                );
              }
            } else {
              availableQty = round2(pBal.qty);
              pBal.qty = Math.max(0, round2(pBal.qty - netRequired));
            }
          } else if (matchedPart?.materialId && unitCode === 'KG') {
            availableQty = round2(remainingRawByMaterial.get(matchedPart.materialId) || 0);
            remainingRawByMaterial.set(
              matchedPart.materialId,
              Math.max(0, round2(availableQty - netRequired)),
            );
          }
          if (unitCode === 'KG' || childItem.type === 'RAW_MATERIAL') {
            const kgPerUnit = unitCode === 'KG' ? 1 : n(matchedPart?.weightGrossKg || childItem.weightGrossKg || 0);
            if (unitCode === 'KG') {
              totalMaterialKg += netRequired;
            } else if (kgPerUnit > 0) {
              totalMaterialKg += round2(netRequired * kgPerUnit);
            }
          }
        } else {
          availableQty = wipCredited;
        }

        const shortageQty = hasGrandchildren ? 0 : round2(Math.max(0, netRequired - availableQty));
        exploded.push({
          partId: matchedPart?.id || null,
          partCode: matchedPart?.partNumber || childItem.code,
          partName: matchedPart?.name || childItem.name,
          unitCode,
          materialId: matchedPart?.materialId || null,
          materialGrade: matchedPart?.material?.grade || null,
          level,
          qtyPerParent,
          scrapFactorPercent: scrapPct,
          grossRequiredQty: grossRequired,
          wipCreditedQty: wipCredited,
          netRequiredQty: netRequired,
          availableQty,
          shortageQty,
          hasShortage: shortageQty > 0,
        });

        if (hasGrandchildren && netRequired > 0) {
          const nextVisited = new Set(visited);
          nextVisited.add(childCodeUpper);
          visit(childItem, netRequired, level + 1, nextVisited);
        }
      }
    };

    visit(rootItem, netQty, 1, new Set([rootCode]));
    return { exploded, usedBomTree: exploded.length > 0, totalMaterialKg: round1(totalMaterialKg) };
  };

  // -------------------------------------------------------------------------
  // 4. Build Requirements with Routing, Eligible Machines, Shift Capacity & Netting
  // -------------------------------------------------------------------------
  const requirements: RelationalNetRequirement[] = [];
  for (const [partId, info] of prioritizedDemandEntries) {
    const part: any = partById.get(partId);
    const physicalFg = finishedByPart.get(partId) || 0;
    const reservedFg = reservedByPart.get(partId) || 0;
    const availableFg = Math.max(0, physicalFg - reservedFg);
    const wipQty = wipByPart.get(partId) || 0;
    const netQty = Math.max(0, info.gross - availableFg - wipQty);

    let stockCoverRemaining = availableFg + wipQty;
    const allocatedDemandLines = [...info.demandLines].sort(
      (a, b) => a.priority - b.priority || a.dueDate.getTime() - b.dueDate.getTime() || a.lineNumber - b.lineNumber,
    );
    for (const line of allocatedDemandLines) {
      const covered = Math.min(line.remainingQty, stockCoverRemaining);
      stockCoverRemaining = Math.max(0, stockCoverRemaining - covered);
      line.plannedQty = round1(Math.max(0, line.remainingQty - covered));
    }

    const routeRow = part.routes?.[0];
    let stepCursorDate = new Date(todayUtc.getTime());
    let partHasCapacityConflict = false;

    const route = (routeRow?.operations || []).map((step: any) => {
      const qtyForEstimate = netQty > 0 ? netQty : Math.max(1, info.gross);
      const requiredTonnage = n(step.die?.tonnageRequired);
      const thickness = part.thicknessMm == null ? null : n(part.thicknessMm);

      const eligibleMachines: RelationalMachineCandidate[] = machines
        .map((machine: any) => {
          const capability = machine.capabilities.find((item: any) => item.operationId === step.operationId);
          const hasDieCompatibility = !step.dieId || machine.dieCompatibilities.some((item: any) => item.dieId === step.dieId);
          const tonnageFits = requiredTonnage <= 0
            ? true
            : n(machine.tonnageCapacity) >= requiredTonnage &&
              (!capability?.maxTonnage || n(capability.maxTonnage) >= requiredTonnage);
          const thicknessFits = !capability ||
            ((capability.minThicknessMm == null || (thickness != null && thickness >= n(capability.minThicknessMm))) &&
             (capability.maxThicknessMm == null || (thickness != null && thickness <= n(capability.maxThicknessMm))));

          if (!capability || machine.status !== 'ACTIVE' || !hasDieCompatibility || !tonnageFits || !thicknessFits) {
            return null;
          }

          const efficiencyFactor = n(capability.efficiencyFactor) > 0 ? n(capability.efficiencyFactor) : 1;
          const estHours = estimateOperationHours(
            Number(step.setupTimeMin || 0),
            Number(step.standardCycleTimeSec || 0),
            qtyForEstimate,
            efficiencyFactor,
          );
          const scheduledHours = round2(
            (machineBookedHoursTotal.get(machine.id) || 0) + (plannedRunLoadByMachineTotal.get(machine.id) || 0),
          );
          const availableCapacityHours = round2(Math.max(0, totalDailyShiftHours - scheduledHours));
          const utilizationPercent = Math.min(100, Math.round((scheduledHours / totalDailyShiftHours) * 100));
          const existingConflicts = machineExistingConflictCount.get(machine.id) || 0;
          const wouldExceedDailyCapacity = estHours > availableCapacityHours;

          // Pick active shift with lowest current load on this machine
          const sortedShifts = [...activeShifts].sort(
            (a, b) =>
              (machineShiftLoad.get(`${machine.id}::${a.id}`) || 0) -
              (machineShiftLoad.get(`${machine.id}::${b.id}`) || 0),
          );
          const recommendedShift = sortedShifts[0] || null;

          // Suitability score (0-100) balancing preference, capacity availability, tonnage fit, efficiency, and conflict-free status
          let score = 35;
          if (capability.isPreferred) score += 20;
          score += Math.round((availableCapacityHours / totalDailyShiftHours) * 25);
          if (requiredTonnage > 0 && machine.tonnageCapacity != null) {
            const excessRatio = (n(machine.tonnageCapacity) - requiredTonnage) / requiredTonnage;
            score += excessRatio <= 0.35 ? 10 : excessRatio <= 0.8 ? 6 : 3;
          } else {
            score += 7;
          }
          score += Math.min(10, Math.round(efficiencyFactor * 8));
          if (existingConflicts > 0) score = Math.max(5, score - existingConflicts * 15);

          return {
            id: machine.id,
            code: machine.code,
            name: machine.name,
            tonnageCapacity: machine.tonnageCapacity == null ? null : n(machine.tonnageCapacity),
            preferred: Boolean(capability.isPreferred),
            efficiencyFactor: round2(efficiencyFactor),
            estimatedHours: estHours,
            dailyCapacityHours: totalDailyShiftHours,
            scheduledHours,
            availableCapacityHours,
            utilizationPercent,
            existingConflictsCount: existingConflicts,
            wouldExceedDailyCapacity,
            recommendedShiftId: recommendedShift?.id || null,
            recommendedShiftCode: recommendedShift?.code || null,
            recommendedShiftName: recommendedShift?.name || null,
            suitabilityScore: Math.min(100, Math.max(0, score)),
          };
        })
        .filter((candidate: RelationalMachineCandidate | null): candidate is RelationalMachineCandidate => candidate !== null)
        .sort((a: RelationalMachineCandidate, b: RelationalMachineCandidate) =>
          b.suitabilityScore - a.suitabilityScore ||
          Number(b.preferred) - Number(a.preferred) ||
          ((a.tonnageCapacity ?? Number.MAX_SAFE_INTEGER) - (b.tonnageCapacity ?? Number.MAX_SAFE_INTEGER)),
        );

      const preferredCandidate =
        (step.machineId ? eligibleMachines.find(m => m.id === step.machineId) : undefined) ||
        eligibleMachines[0] ||
        null;

      const stepEff = preferredCandidate?.efficiencyFactor || 1;
      const stepEstHours = estimateOperationHours(
        Number(step.setupTimeMin || 0),
        Number(step.standardCycleTimeSec || 0),
        netQty,
        stepEff,
      );
      const stepDurationDays = Math.max(1, Math.ceil(Math.max(0.5, stepEstHours) / totalDailyShiftHours));
      const opStartDate = new Date(stepCursorDate.getTime());
      const opEndDate = addDays(opStartDate, Math.max(0, stepDurationDays - 1));
      const opStartKey = toDateKey(opStartDate);

      const conflictDetails: string[] = [];
      let opHasConflict = false;
      if (preferredCandidate && netQty > 0) {
        const machineDateKey = `${preferredCandidate.id}::${opStartKey}`;
        const prevDateLoad = plannedRunLoadByMachineDate.get(machineDateKey) || 0;
        const existingBooked = machineBookedHoursTotal.get(preferredCandidate.id) || 0;
        const dailyLoadWithThisOp = round2(prevDateLoad + Math.min(totalDailyShiftHours, stepEstHours));
        if (preferredCandidate.existingConflictsCount > 0) {
          opHasConflict = true;
          conflictDetails.push(`ماشین ${preferredCandidate.code} در حال حاضر ${preferredCandidate.existingConflictsCount} تداخل برنامه‌ریزی ثبت‌شده دارد.`);
        }
        if (dailyLoadWithThisOp > totalDailyShiftHours || existingBooked + prevDateLoad + Math.min(totalDailyShiftHours, stepEstHours) > totalDailyShiftHours) {
          opHasConflict = true;
          conflictDetails.push(
            `بارکاری روزانه ${preferredCandidate.code} از ظرفیت ${totalDailyShiftHours} ساعت شیفت فراتر می‌رود (نیاز گام: ${stepEstHours} ساعت).`,
          );
        }
        plannedRunLoadByMachineDate.set(machineDateKey, dailyLoadWithThisOp);
        plannedRunLoadByMachineTotal.set(
          preferredCandidate.id,
          round2((plannedRunLoadByMachineTotal.get(preferredCandidate.id) || 0) + stepEstHours),
        );
      }

      if (opHasConflict) partHasCapacityConflict = true;
      stepCursorDate = addDays(opEndDate, 1);

      return {
        routeOperationId: step.id,
        stepNumber: step.stepNumber,
        stepCode: step.stepCode,
        stepName: step.stepName,
        operationId: step.operationId,
        operationCode: step.operation.code,
        dieId: step.dieId || null,
        processType: step.operation.processType,
        requiredTonnage,
        eligibleMachines,
        machineSelectionStatus: eligibleMachines.length > 0 ? ('CANDIDATES_FOUND' as const) : ('NO_ELIGIBLE_MACHINE' as const),
        setupTimeMin: step.setupTimeMin,
        standardCycleTimeSec: step.standardCycleTimeSec,
        scrapNormPercent: n(step.scrapNormPercent),
        estimatedHours: stepEstHours,
        estimatedStartDate: opStartKey,
        estimatedEndDate: toDateKey(opEndDate),
        recommendedShiftId: preferredCandidate?.recommendedShiftId || activeShifts[0]?.id || null,
        recommendedShiftName: preferredCandidate?.recommendedShiftName || activeShifts[0]?.name || null,
        hasCapacityConflict: opHasConflict,
        conflictDetails,
        assignedMachine: step.machine ? { id: step.machine.id, code: step.machine.code, name: step.machine.name } : null,
        die: step.die
          ? {
              id: step.die.id,
              code: step.die.code,
              name: step.die.name,
              tonnageRequired: n(step.die.tonnageRequired),
            }
          : null,
      };
    });

    // Multi-level BOM explosion or gross-weight fallback
    const bomExplosion = explodeBomForPart(part, netQty);
    const scrapPercent = route.reduce((sum: number, step: any) => sum + step.scrapNormPercent, 0);
    const directRequiredKg = round1(netQty * n(part.weightGrossKg) * (1 + scrapPercent / 100));
    const totalPoolKg = part.materialId ? (rawByMaterial.get(part.materialId) || 0) : 0;

    let requiredMaterialKg = 0;
    let availableRawKg = 0;
    let materialShortageKg = 0;
    let hasMaterialShortage = false;

    if (bomExplosion.usedBomTree) {
      requiredMaterialKg = bomExplosion.totalMaterialKg;
      const kgLeafComponents = bomExplosion.exploded.filter(c => c.unitCode === 'KG');
      availableRawKg = round1(kgLeafComponents.reduce((s, c) => s + c.availableQty, 0));
      materialShortageKg = round1(kgLeafComponents.reduce((s, c) => s + c.shortageQty, 0));
      hasMaterialShortage = bomExplosion.exploded.some(c => c.hasShortage);
    } else if (part.materialId && n(part.weightGrossKg) > 0) {
      requiredMaterialKg = directRequiredKg;
      availableRawKg = round1(remainingRawByMaterial.get(part.materialId) || 0);
      materialShortageKg = round1(Math.max(0, requiredMaterialKg - availableRawKg));
      hasMaterialShortage = requiredMaterialKg > availableRawKg;
      remainingRawByMaterial.set(
        part.materialId,
        Math.max(0, round1(availableRawKg - requiredMaterialKg)),
      );
    }

    const estimatedStartDate = route.length > 0 ? route[0].estimatedStartDate : toDateKey(todayUtc);
    const estimatedCompletionDate = route.length > 0 ? route[route.length - 1].estimatedEndDate : toDateKey(todayUtc);
    const dueDateStr = toDateKey(info.dueDate);
    const hasDueDateRisk = netQty > 0 && new Date(estimatedCompletionDate).getTime() > new Date(dueDateStr).getTime();

    const warnings: string[] = [];
    if (!route.length) warnings.push('برای این قطعه مسیر تولید فعال و پیش‌فرض تعریف نشده است.');
    if (!part.materialId && !bomExplosion.usedBomTree) warnings.push('متریال اصلی قطعه در اطلاعات پایه مشخص نشده است.');
    if (n(part.weightGrossKg) <= 0 && netQty > 0 && !bomExplosion.usedBomTree) {
      warnings.push('وزن ناخالص مهندسی قطعه صفر است؛ محاسبه نیاز ورق معتبر نیست.');
    }
    if (hasMaterialShortage) {
      if (bomExplosion.usedBomTree) {
        const shortageParts = bomExplosion.exploded
          .filter(c => c.hasShortage)
          .map(c => `${c.partCode} (${c.shortageQty} ${c.unitCode})`)
          .slice(0, 3);
        warnings.push(`کسری اقلام BOM: ${shortageParts.join('، ')}`);
      } else {
        warnings.push(`کسری ماده اولیه: ${materialShortageKg} کیلوگرم`);
      }
    }
    if (hasDueDateRisk) {
      warnings.push(`احتمال تاخیر از موعد تحویل: اتمام برآوردی (${estimatedCompletionDate}) بعد از موعد (${dueDateStr}) است.`);
    }
    if (partHasCapacityConflict) {
      warnings.push('تداخل یا اشغال بیش‌ازحد ظرفیت شیفت در یکی از ایستگاه‌های پیشنهادی وجود دارد.');
    }

    requirements.push({
      partId,
      partCode: part.partNumber,
      partName: part.name,
      materialId: part.materialId || null,
      materialCode: part.material?.code || null,
      materialGrade: part.material?.grade || null,
      dueDate: dueDateStr,
      priority: info.priority,
      customerOrderIds: [...info.orderIds],
      customerOrderNumbers: [...info.orderNumbers],
      demandLines: allocatedDemandLines.map(line => ({
        customerOrderLineId: line.customerOrderLineId,
        customerOrderId: line.customerOrderId,
        customerOrderNumber: line.customerOrderNumber,
        lineNumber: line.lineNumber,
        priority: line.priority,
        requestedQty: round1(line.requestedQty),
        deliveredQty: round1(line.deliveredQty),
        remainingQty: round1(line.remainingQty),
        alreadyPlannedQty: round1(line.alreadyPlannedQty),
        plannedQty: round1(line.plannedQty),
        dueDate: toDateKey(line.dueDate),
      })),
      grossDemandQty: round1(info.gross),
      physicalFinishedGoodsQty: round1(physicalFg),
      reservedFinishedGoodsQty: round1(reservedFg),
      availableFinishedGoodsQty: round1(availableFg),
      downstreamWipQty: round1(wipQty),
      netProductionRequirement: round1(netQty),
      requiredMaterialKg,
      availableRawMaterialKg: round1(availableRawKg),
      totalRawMaterialPoolKg: round1(totalPoolKg),
      materialShortageKg,
      hasMaterialShortage,
      bomSource: bomExplosion.usedBomTree ? 'BOM_COMPONENT_TREE' : 'PART_GROSS_WEIGHT',
      explodedComponents: bomExplosion.exploded,
      estimatedStartDate,
      estimatedCompletionDate,
      hasDueDateRisk,
      hasCapacityConflict: partHasCapacityConflict,
      routeId: routeRow?.id || null,
      route,
      dataWarnings: warnings,
    });
  }

  const activeMachinesList = machines.filter((m: any) => m.status === 'ACTIVE');
  const totalCap = Math.max(1, activeMachinesList.length * totalDailyShiftHours);
  const totalScheduled = activeMachinesList.reduce(
    (s: number, m: any) => s + (machineBookedHoursTotal.get(m.id) || 0),
    0,
  );
  const totalConflictsCount = Array.from(machineExistingConflictCount.values()).reduce((s, c) => s + c, 0);

  return {
    source: 'postgresql',
    generatedAt: now.toISOString(),
    counts: {
      openOrders: orders.length,
      demandedParts: requirements.length,
      activeParts: parts.length,
      activeMachines: machines.length,
      availableDies: dies.length,
      activeShifts: activeShifts.length,
      scheduledAssignments: machineAssignments.length,
      capacityConflictsCount: totalConflictsCount,
    },
    capacitySummary: {
      totalDailyShiftHours,
      averageUtilizationPercent: Math.min(100, Math.round((totalScheduled / totalCap) * 1000) / 10),
      totalScheduledHours: round2(totalScheduled),
      totalAvailableHours: round2(Math.max(0, totalCap - totalScheduled)),
      existingConflictsCount: totalConflictsCount,
      shiftSource: shifts.length > 0 ? 'DATABASE_SHIFTS' : 'DEFAULT_NOMINAL',
    },
    requirements,
    masterData: {
      shifts: activeShifts,
      machines: machines.map((machine: any) => {
        const booked = round2(machineBookedHoursTotal.get(machine.id) || 0);
        return {
          id: machine.id,
          code: machine.code,
          name: machine.name,
          hallLocation: machine.hallLocation || 'سالن تولید',
          machineType: machine.machineType,
          tonnageCapacity: machine.tonnageCapacity == null ? null : n(machine.tonnageCapacity),
          maxStrokesPerMinute: machine.maxStrokesPerMinute,
          status: machine.status,
          dailyCapacityHours: totalDailyShiftHours,
          scheduledHours: booked,
          availableCapacityHours: round2(Math.max(0, totalDailyShiftHours - booked)),
          utilizationPercent: Math.min(100, Math.round((booked / totalDailyShiftHours) * 100)),
          existingConflictsCount: machineExistingConflictCount.get(machine.id) || 0,
          capabilities: machine.capabilities.map((capability: any) => ({
            operationId: capability.operationId,
            operationCode: capability.operation.code,
            operationName: capability.operation.name,
            processType: capability.operation.processType,
            maxTonnage: n(capability.maxTonnage),
            minThicknessMm: capability.minThicknessMm == null ? null : n(capability.minThicknessMm),
            maxThicknessMm: capability.maxThicknessMm == null ? null : n(capability.maxThicknessMm),
            efficiencyFactor: n(capability.efficiencyFactor),
            preferred: capability.isPreferred,
          })),
          compatibleDieIds: machine.dieCompatibilities.map((item: any) => item.dieId),
        };
      }),
      dies: dies.map((die: any) => ({
        id: die.id,
        code: die.code,
        name: die.name,
        partId: die.partId,
        tonnageRequired: n(die.tonnageRequired),
        status: die.status,
        compatibleMachineIds: die.machineCompatibilities.map((item: any) => item.machineId),
      })),
    },
  };
}
