import {
  Part,
  Machine,
  Routing,
  InventoryDocument,
  InventoryReservation,
  PhysicalCoil,
  CoilIssueReturnRecord,
  SapcoContract,
  WarehouseDefinition,
  Operator,
  ShiftDefinition,
  SavedReportConfig,
  InventoryTransaction,
  WAREHOUSES_LIST,
} from '../types/inventory';
import {
  calculateDetailedStockBalances,
  atomicPostDocument,
  issuePhysicalCoilPartial,
  returnPhysicalCoilPartial,
  AuditRecord,
} from './inventoryEngine';
import { buildDocumentRequestFingerprint } from './services/inventoryLedgerService';
import { getAllBoms } from './bomAndParallelEngine';
import {
  manufacturingOrdersStore,
  productionLogsStore,
  createManufacturingOrder,
  registerOperationInput,
  registerOperationProduction,
  loadMaterialIntoManufacturingOrder,
  persistProductionWipState,
} from './productionWipEngine';
import {
  customerOrdersStore,
  planSuggestionsStore,
  machineWorkloadHoursMap,
  calculateNetRequirements,
  evaluateMachineEligibility,
} from './productionPlanningEngine';
import {
  getPlanVsActualReport,
  getCustomerOrderFulfillmentReport,
  getWipAgingReport,
  getProductionDelaysReport,
  applyQcHoldsToBalances,
} from './managementReportsEngine';
import { serverQcHoldStore } from './mrpEngine';
import { ReportFilterParams } from '../types/managementReports';
import { INITIAL_DIES_MOLDS } from './sampleData';

// In-memory idempotency & relational-parity fallback stores (used only when PostgreSQL is not configured)
const fallbackMaterialIssueIdempotency = new Map<string, { fingerprint: string; document: any }>();
const fallbackCoilIssueIdempotency = new Map<string, { fingerprint: string; response: any }>();
const fallbackCoilReturnIdempotency = new Map<string, { fingerprint: string; response: any }>();
const fallbackDocumentIdempotency = new Map<string, { fingerprint: string; document: InventoryDocument }>();
const fallbackWipProductionIdempotency = new Map<string, { fingerprint?: string; mo: any; log: any; backflushIssueDocNumber?: string; receiptDocNumber?: string }>();
const fallbackPlanProposalsStore: any[] = [];
const fallbackSavedReportConfigsStore: SavedReportConfig[] = [];
const fallbackOpPauseMap = new Map<string, { paused: boolean; reason: string; isDowntime: boolean; pausedAt: string }>();
const fallbackShopFloorLifecycleIdempotency = new Map<string, { fingerprint: string; response: any }>();
const fallbackShopFloorDowntimeStore: any[] = [];
const fallbackShopFloorReportsStore: any[] = [];

export function resolveFallbackDocumentIdempotency(
  idempotencyKey: string | undefined,
  document: InventoryDocument,
  options?: { includeDocumentNumber?: boolean }
): { matched: false; fingerprint: string } | { matched: true; conflict: false; document: InventoryDocument } | { matched: true; conflict: true; error: string } {
  const fingerprint = buildDocumentRequestFingerprint(document, {
    includeDocumentNumber: options?.includeDocumentNumber !== false,
  });
  if (!idempotencyKey) {
    return { matched: false, fingerprint };
  }
  const existing = fallbackDocumentIdempotency.get(idempotencyKey);
  if (!existing) {
    return { matched: false, fingerprint };
  }
  if (existing.fingerprint !== fingerprint) {
    return {
      matched: true,
      conflict: true,
      error: `کلید یکتای درخواست (Idempotency-Key: ${idempotencyKey}) قبلاً برای سند دیگری با مشخصات متفاوت ثبت شده است.`,
    };
  }
  return { matched: true, conflict: false, document: existing.document };
}

export function recordFallbackDocumentIdempotency(
  idempotencyKey: string | undefined,
  fingerprint: string,
  document: InventoryDocument
): void {
  if (!idempotencyKey) return;
  fallbackDocumentIdempotency.set(idempotencyKey, { fingerprint, document });
}

export function exportFallbackProposalsSnapshot(): any[] {
  return JSON.parse(JSON.stringify(fallbackPlanProposalsStore));
}

export function hydrateFallbackProposalsSnapshot(proposals: any[]): void {
  if (!Array.isArray(proposals)) return;
  fallbackPlanProposalsStore.splice(0, fallbackPlanProposalsStore.length, ...proposals);
}

export function clearFallbackProposalsStore(): void {
  fallbackPlanProposalsStore.length = 0;
}

export function clearFallbackWipIdempotencyByMoIds(moIds: Set<string>, moNumbers: Set<string>): number {
  let removed = 0;
  for (const [key, entry] of fallbackWipProductionIdempotency.entries()) {
    const entryMoId = entry?.mo?.id;
    const entryMoNum = entry?.mo?.moNumber || entry?.log?.moNumber;
    if ((entryMoId && moIds.has(entryMoId)) || (entryMoNum && moNumbers.has(entryMoNum))) {
      fallbackWipProductionIdempotency.delete(key);
      removed += 1;
    }
  }
  return removed;
}

const getGrossWeightKgForPart = (partCode: string, parts: Part[] = [], fallbackWeight?: number): number => {
  const part = parts.find(p => p.code === partCode || p.id === partCode);
  const bom = getAllBoms().find(b => b.assemblyPartCode === partCode || b.assemblyPartId === part?.id);
  const bomSheetWeight = bom?.components
    ?.filter(c => c.componentType === 'RAW_SHEET' || c.grossWeightKg)
    ?.reduce((s, c) => s + Number(c.grossWeightKg || 0) * Number(c.quantityPerAssembly || 1), 0);
  if (bomSheetWeight && bomSheetWeight > 0) return Number(bomSheetWeight.toFixed(3));
  if (part?.weightPerUnitKg && part.weightPerUnitKg > 0) return part.weightPerUnitKg;
  return fallbackWeight && fallbackWeight > 0 ? fallbackWeight : 0;
};

export function getFallbackPlanningReadModel(
  parts: Part[],
  routings: Routing[],
  machines: Machine[],
  inventoryDocs: InventoryDocument[],
  reservations: InventoryReservation[],
) {
  const { balances: rawBalances } = calculateDetailedStockBalances(inventoryDocs, reservations, parts);
  const balances = applyQcHoldsToBalances(rawBalances, serverQcHoldStore);
  const netReqs = calculateNetRequirements({
    parts,
    orders: customerOrdersStore,
    balances,
    reservations,
    activeMos: manufacturingOrdersStore,
    routings,
    qcHolds: serverQcHoldStore,
  });

  const requirements = netReqs.map(req => {
    const part = parts.find(p => p.id === req.partId || p.code === req.partCode);
    const routing = routings.find(r => r.partCode === req.partCode || r.partId === req.partId);
    const route = (routing?.operations || []).map(op => {
      const checks = evaluateMachineEligibility({
        processType: op.processType,
        requiredTonnage: op.requiredTonnage || 100,
        plannedQuantity: Math.max(1, req.netProductionRequirement || req.grossDemandQty),
        standardCycleTimeSec: op.standardCycleTimeSec || 12,
        setupTimeMin: op.setupTimeMin || 20,
        assignedDieId: op.dieMoldId,
        machines,
        dies: INITIAL_DIES_MOLDS,
      });
      const eligibleList = checks
        .filter(e => e.isEligible)
        .map(em => machines.find(m => m.id === em.machineId || m.code === em.machineCode))
        .filter((m): m is Machine => Boolean(m));
      const fallbackByCap = eligibleList.length
        ? eligibleList
        : machines.filter(m => m.status === 'ACTIVE' && (m.capabilities.includes(op.processType) || m.processType === op.processType));
      const assigned = machines.find(m => m.id === op.machineId) || fallbackByCap[0] || null;
      return {
        routeOperationId: `${routing?.id || 'RTG'}:${op.stepNumber}`,
        operationId: op.stepCode,
        stepNumber: op.stepNumber,
        stepCode: op.stepCode,
        stepName: op.stepName,
        processType: op.processType,
        requiredTonnage: op.requiredTonnage || 0,
        standardCycleTimeSec: op.standardCycleTimeSec || 0,
        setupTimeMin: op.setupTimeMin || 0,
        scrapNormPercent: op.scrapNormPercent || 0,
        dieId: op.dieMoldId || null,
        assignedMachine: assigned ? { id: assigned.id, code: assigned.code, name: assigned.name } : null,
        eligibleMachines: fallbackByCap.map(m => ({
          id: m.id,
          code: m.code,
          name: m.name,
          tonnageCapacity: m.tonnage || 0,
        })),
        machineSelectionStatus: fallbackByCap.length > 0 ? 'ELIGIBLE_FOUND' : 'NO_ELIGIBLE_MACHINE',
      };
    });

    let stockCoverRemaining = req.availableFinishedGoodsQty + req.totalDownstreamWip;
    const orderLine = customerOrdersStore
      .filter(o => o.status === 'OPEN' || o.status === 'PARTIALLY_FULFILLED')
      .flatMap(o =>
        o.lines
          .map((l, lIdx) => ({ l, lIdx }))
          .filter(({ l }) => (l.partCode === req.partCode || l.partId === req.partId) && l.remainingQuantity > 0)
          .map(({ l, lIdx }) => ({
            customerOrderLineId: l.id,
            lineNumber: lIdx + 1,
            customerOrderNumber: o.orderNumber,
            dueDate: l.dueDate || o.dueDate,
            remainingQty: l.remainingQuantity,
            priority: o.priority,
          })),
      )
      .sort((a, b) => a.priority - b.priority || new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime())
      .map(l => {
        const covered = Math.min(l.remainingQty, stockCoverRemaining);
        stockCoverRemaining = Math.max(0, stockCoverRemaining - covered);
        return {
          ...l,
          plannedQty: Math.max(0, l.remainingQty - covered),
        };
      });

    return {
      partId: part?.id || req.partId,
      partCode: req.partCode,
      partName: req.partName,
      materialGrade: part?.materialGrade || null,
      routeId: routing?.id || null,
      route,
      demandLines: orderLine,
      grossDemandQuantity: req.grossDemandQty,
      finishedAvailableQty: req.availableFinishedGoodsQty,
      wipInProgressQty: req.totalDownstreamWip,
      netToProduceQuantity: req.netProductionRequirement,
      hasMaterialShortage: req.materialShortageDetected,
      materialShortageKg: Math.max(0, Math.round((req.requiredMaterialKg - req.availableRawMaterialKg) * 10) / 10),
      dataWarnings: req.materialShortageDetected
        ? [`کسری ورق مواد اولیه: ${Math.max(0, Math.round(req.requiredMaterialKg - req.availableRawMaterialKg))} کیلوگرم`]
        : [],
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    masterData: {
      machines: machines.map(m => ({
        id: m.id,
        code: m.code,
        name: m.name,
        tonnageCapacity: m.tonnage || 0,
        status: m.status,
      })),
    },
    requirements,
  };
}

function seedInitialFallbackProposalIfEmpty(
  parts: Part[],
  routings: Routing[],
  machines: Machine[],
  inventoryDocs: InventoryDocument[],
  reservations: InventoryReservation[],
) {
  if (fallbackPlanProposalsStore.length > 0) return;
  try {
    createFallbackProposal(
      'پیشنهاد اولیه برنامه‌ریزی براکت ضدسرقت ECU مبتنی بر موجودی زنده انبار، WIP و سفارش باز ساپکو',
      parts,
      routings,
      machines,
      inventoryDocs,
      reservations,
    );
  } catch {
    // No open unscheduled demand — safe to leave empty
  }
}

export function listFallbackProposals(
  parts: Part[],
  routings: Routing[],
  machines: Machine[],
  inventoryDocs: InventoryDocument[],
  reservations: InventoryReservation[],
) {
  seedInitialFallbackProposalIfEmpty(parts, routings, machines, inventoryDocs, reservations);
  return [...fallbackPlanProposalsStore].sort(
    (a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime() || b.version - a.version,
  );
}

export function getFallbackProposal(id: string) {
  return fallbackPlanProposalsStore.find(p => p.id === id) || null;
}

export function createFallbackProposal(
  notes: string | undefined,
  parts: Part[],
  routings: Routing[],
  machines: Machine[],
  inventoryDocs: InventoryDocument[],
  reservations: InventoryReservation[],
) {
  const readModel = getFallbackPlanningReadModel(parts, routings, machines, inventoryDocs, reservations);
  const now = new Date();
  const id = `PRP-MEM-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const proposalNumber = `PRP-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${String(fallbackPlanProposalsStore.length + 1).padStart(3, '0')}`;

  const lines: any[] = [];
  for (const requirement of readModel.requirements) {
    if (!requirement.routeId || !requirement.route.length) continue;
    for (const dl of requirement.demandLines) {
      if (dl.plannedQty <= 0) continue;
      lines.push({
        id: `PRPL-${Date.now()}-${lines.length + 1}`,
        customerOrderLineId: dl.customerOrderLineId,
        partId: requirement.partId,
        routeId: requirement.routeId,
        part: {
          partNumber: requirement.partCode,
          name: requirement.partName,
          materialGrade: requirement.materialGrade || null,
        },
        customerOrderLine: {
          lineNumber: dl.lineNumber || 1,
          order: { orderNumber: dl.customerOrderNumber, priority: dl.priority },
        },
        requestedQty: dl.remainingQty,
        plannedQty: dl.plannedQty,
        plannedStartDate: now.toISOString(),
        plannedEndDate: new Date(Math.max(now.getTime(), new Date(dl.dueDate).getTime())).toISOString(),
        priority: dl.priority,
        warnings: requirement.dataWarnings || [],
        operationAssignments: requirement.route.map((step: any) => ({
          routeOperationId: step.routeOperationId,
          operationId: step.operationId,
          stepNumber: step.stepNumber,
          stepCode: step.stepCode,
          stepName: step.stepName,
          processType: step.processType,
          requiredTonnage: step.requiredTonnage || 0,
          standardCycleTimeSec: step.standardCycleTimeSec || 0,
          setupTimeMin: step.setupTimeMin || 0,
          machineId: step.assignedMachine?.id || step.eligibleMachines[0]?.id || null,
          machineCode: step.assignedMachine?.code || step.eligibleMachines[0]?.code || null,
          machineName: step.assignedMachine?.name || step.eligibleMachines[0]?.name || null,
          dieId: step.dieId || null,
          eligibleMachineIds: step.eligibleMachines.map((m: any) => m.id),
        })),
      });
    }
  }

  if (!lines.length) {
    throw new Error('تقاضای تولیدِ برنامه‌ریزی‌نشده‌ای برای ساخت پیشنهاد جدید وجود ندارد.');
  }

  for (const existing of fallbackPlanProposalsStore) {
    if (existing.status === 'DRAFT') existing.status = 'SUPERSEDED';
  }

  const proposal = {
    id,
    proposalNumber,
    revisionGroupId: id,
    version: 1,
    status: 'DRAFT',
    generatedAt: now.toISOString(),
    notes: notes || 'پیشنهاد تولید محاسبه‌شده از سفارش‌های باز، موجودی فعلی و جریان WIP',
    productionPlan: null,
    inputSnapshot: readModel,
    lines,
  };
  fallbackPlanProposalsStore.unshift(proposal);
  return proposal;
}

export function reviseFallbackProposal(id: string, changes: any[], note?: string) {
  const existing = fallbackPlanProposalsStore.find(p => p.id === id);
  if (!existing) throw new Error('پیشنهاد برنامه یافت نشد.');
  if (existing.status !== 'DRAFT') throw new Error('فقط پیشنهاد در وضعیت پیش‌نویس قابل بازنگری است.');

  existing.status = 'SUPERSEDED';
  const revisedLines = existing.lines.map((line: any) => {
    const change = changes.find((c: any) => c.proposalLineId === line.id);
    if (!change) return { ...line };
    const nextQty = change.plannedQty !== undefined && change.plannedQty !== null ? Number(change.plannedQty) : Number(line.plannedQty);
    const nextStart = change.plannedStartDate || line.plannedStartDate;
    const nextEnd = change.plannedEndDate || line.plannedEndDate;
    const nextPriority = change.priority !== undefined ? Number(change.priority) : line.priority;
    const updatedAssignments = (line.operationAssignments || []).map((assignment: any) => {
      const opChange = (change.operationAssignments || []).find(
        (oc: any) => oc.routeOperationId === assignment.routeOperationId,
      );
      if (!opChange) return assignment;
      return {
        ...assignment,
        machineId: opChange.machineId === undefined ? assignment.machineId : opChange.machineId,
        shiftId: opChange.shiftId === undefined ? assignment.shiftId : opChange.shiftId,
        plannedStartDate: opChange.plannedStartDate || assignment.plannedStartDate,
        plannedEndDate: opChange.plannedEndDate || assignment.plannedEndDate,
      };
    });
    return {
      ...line,
      plannedQty: Number.isFinite(nextQty) && nextQty > 0 ? nextQty : line.plannedQty,
      plannedStartDate: nextStart,
      plannedEndDate: nextEnd,
      priority: nextPriority,
      operationAssignments: updatedAssignments,
    };
  });

  const revised = {
    ...existing,
    id: `PRP-MEM-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    version: Number(existing.version) + 1,
    status: 'DRAFT',
    generatedAt: new Date().toISOString(),
    notes: note || 'نسخه بازنگری‌شده تخصیص ماشین‌آلات',
    lines: revisedLines,
  };
  fallbackPlanProposalsStore.unshift(revised);
  return revised;
}

export function approveFallbackProposal(id: string, approvedBy: string) {
  const existing = fallbackPlanProposalsStore.find(p => p.id === id);
  if (!existing) throw new Error('پیشنهاد برنامه یافت نشد.');
  if (existing.status !== 'DRAFT') throw new Error('فقط پیشنهاد پیش‌نویس قابل تایید است.');
  existing.status = 'APPROVED';
  existing.approvedBy = approvedBy;
  existing.approvedAt = new Date().toISOString();
  return existing;
}

export async function releaseFallbackProposal(
  id: string,
  releasedBy: string,
  parts: Part[],
  routings: Routing[],
) {
  const proposal = fallbackPlanProposalsStore.find(p => p.id === id);
  if (!proposal) throw new Error('پیشنهاد برنامه یافت نشد.');

  if (proposal.status === 'RELEASED' && proposal.productionPlan) {
    return {
      replayed: true,
      proposal,
      plan: proposal.productionPlan,
      manufacturingOrders: proposal.releasedManufacturingOrders || [],
    };
  }
  if (proposal.status !== 'APPROVED') {
    throw new Error('ابتدا باید پیشنهاد را تأیید کنید سپس به خط تولید صادر نمایید.');
  }

  const createdMos: any[] = [];
  for (const line of proposal.lines) {
    const part = parts.find(p => p.id === line.partId || p.code === line.part?.partNumber);
    const routing = routings.find(r => r.id === line.routeId || r.partCode === line.part?.partNumber);
    if (!part || !routing) continue;

    const moRes = createManufacturingOrder({
      partId: part.id,
      targetQuantity: Number(line.plannedQty) || 500,
      initialInputQuantity: 0,
      routingId: routing.id,
      dueDate: line.plannedEndDate,
      notes: `صادرشده از پیشنهاد برنامه ${proposal.proposalNumber} (نسخه ${proposal.version}) توسط ${releasedBy}`,
      createdBy: releasedBy,
    });
    if (moRes.success && moRes.data) {
      moRes.data.status = 'RELEASED';
      if (moRes.data.operations[0]) {
        moRes.data.operations[0].status = 'READY';
      }
      // Sync selected machine assignments from proposal into released MO operations & workload
      for (const op of moRes.data.operations) {
        const assign = (line.operationAssignments || []).find((a: any) => a.stepNumber === op.stepNumber);
        if (assign?.machineId) {
          op.machineId = assign.machineId;
        }
        if (op.machineId) {
          const estHours = Math.round((((op.standardCycleTimeSec || 12) * moRes.data.targetQuantity) / 3600 + 0.5) * 10) / 10;
          machineWorkloadHoursMap[op.machineId] = Math.round(((machineWorkloadHoursMap[op.machineId] || 0) + estHours) * 10) / 10;
        }
      }
      createdMos.push(moRes.data);
    }
  }

  await persistProductionWipState();

  const plan = {
    id: `PLN-MEM-${Date.now()}`,
    planNumber: `PLN-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(fallbackPlanProposalsStore.length).padStart(2, '0')}`,
    status: 'RELEASED',
  };
  proposal.status = 'RELEASED';
  proposal.releasedBy = releasedBy;
  proposal.releasedAt = new Date().toISOString();
  proposal.productionPlan = plan;
  proposal.releasedManufacturingOrders = createdMos;

  return { replayed: false, proposal, plan, manufacturingOrders: createdMos };
}

export function getFallbackMaterialIssueOptions(
  parts: Part[],
  inventoryDocs: InventoryDocument[],
  reservations: InventoryReservation[],
  warehouses: WarehouseDefinition[],
  operators: Operator[],
) {
  const { balances } = calculateDetailedStockBalances(inventoryDocs, reservations, parts, serverQcHoldStore);
  const stockBalances = balances
    .filter(b => {
      const part = parts.find(p => p.id === b.partId || p.code === b.partCode);
      if (!part) return false;
      if (part.category !== 'RAW_MATERIAL') return false;
      // Non-coil materials only (e.g. fasteners, nuts, bolts measured in PCS, excluding KG coils/sheets)
      if (b.unit === 'KG' || part.unit === 'KG') return false;
      return b.availableQty > 0 && b.qualityBlockedQty === 0;
    })
    .map(b => {
      const part = parts.find(p => p.id === b.partId || p.code === b.partCode)!;
      const wh = warehouses.find(w => w.id === b.warehouseId) || WAREHOUSES_LIST[0];
      return {
        id: `${b.partId}::${b.warehouseId}::${b.locationCode || 'LOC-RAW-B1'}::${b.lotNumber || 'LOT'}`,
        partId: part.id,
        quantityAvailable: b.availableQty,
        weightKgAvailable: b.availableKg,
        ownership: b.ownership,
        contractNumber: b.contractNumber || null,
        part: {
          id: part.id,
          partNumber: part.code,
          name: part.name,
          unitId: part.unit,
          unit: { code: part.unit, symbol: part.unit === 'KG' ? 'kg' : 'عدد' },
        },
        warehouse: { id: wh.id, code: wh.code, name: wh.name },
        location: { id: b.locationCode || 'LOC-RAW-B1', code: b.locationCode || 'LOC-RAW-B1' },
        materialLot: b.lotNumber ? { id: b.lotNumber, lotNumber: b.lotNumber } : null,
      };
    });

  const operations = manufacturingOrdersStore
    .filter(mo => mo.status === 'RELEASED' || mo.status === 'IN_PROGRESS' || mo.status === 'PLANNED')
    .flatMap(mo =>
      mo.operations
        .filter(op => op.status !== 'COMPLETED')
        .map(op => ({
          id: op.id,
          stepNumber: op.stepNumber,
          manufacturingOrder: {
            id: mo.id,
            moNumber: mo.moNumber,
            part: { partNumber: mo.partCode, name: mo.partName },
          },
          operation: { code: op.stepCode, name: op.stepName, processType: op.processType },
          wipExecutionLink: { id: op.id, wipOperationId: op.id },
        })),
    );

  const wipWarehouses = warehouses
    .filter(w => w.id === 'WH-WIP-WELD' || w.type === 'WIP')
    .map(w => ({
      id: w.id,
      code: w.code,
      name: w.name,
      locations: (w.locations && w.locations.length ? w.locations : ['LOC-WIP-WELD-01', 'LOC-WIP-WELD-02']).map(
        (loc: any) =>
          typeof loc === 'string' ? { id: loc, code: loc } : { id: loc.id || loc.code, code: loc.code || loc.id },
      ),
    }));

  const users = operators.map(op => ({
    id: op.id,
    fullName: op.fullName,
    personnelCode: op.personnelCode,
    username: op.personnelCode,
  }));

  return { stockBalances, operations, warehouses: wipWarehouses, users };
}

export function postFallbackMaterialIssue(
  payload: any,
  parts: Part[],
  inventoryDocs: InventoryDocument[],
  reservations: InventoryReservation[],
  warehouses: WarehouseDefinition[],
  operators: Operator[],
  transactions: InventoryTransaction[],
  auditLogs: AuditRecord[],
) {
  const issueRequestKey = String(payload.issueRequestKey || '').trim();
  const sourceStockBalanceId = String(payload.sourceStockBalanceId || '').trim();
  const productionOperationId = String(payload.productionOperationId || '').trim();
  const targetWarehouseId = String(payload.targetWarehouseId || '').trim();
  const targetLocationId = String(payload.targetLocationId || '').trim();
  const createdByUserId = String(payload.createdByUserId || '').trim();
  const quantity = Number(payload.quantity);
  const suppliedWeightKg = payload.weightKg !== undefined && payload.weightKg !== null ? Number(payload.weightKg) : 0;

  if (
    !sourceStockBalanceId ||
    !productionOperationId ||
    !targetWarehouseId ||
    !targetLocationId ||
    !createdByUserId ||
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    throw Object.assign(new Error('موجودی مبدا، عملیات تولید، انبار و موقعیت مقصد و مقدار معتبر الزامی هستند.'), {
      statusCode: 400,
    });
  }

  const fingerprint = JSON.stringify({
    sourceStockBalanceId,
    productionOperationId,
    targetWarehouseId,
    targetLocationId,
    quantity,
    weightKg: suppliedWeightKg,
  });

  if (issueRequestKey && fallbackMaterialIssueIdempotency.has(issueRequestKey)) {
    const prior = fallbackMaterialIssueIdempotency.get(issueRequestKey)!;
    if (prior.fingerprint !== fingerprint) {
      throw Object.assign(new Error('این شناسه درخواست قبلاً با اطلاعات متفاوت استفاده شده است.'), {
        statusCode: 409,
      });
    }
    return { document: prior.document, replayed: true };
  }

  const options = getFallbackMaterialIssueOptions(parts, inventoryDocs, reservations, warehouses, operators);
  const source = options.stockBalances.find(b => b.id === sourceStockBalanceId);
  if (!source) {
    throw Object.assign(new Error('ردیف موجودی مبدا یافت نشد یا موجودی آن کافی نیست.'), { statusCode: 404 });
  }
  if (quantity > source.quantityAvailable) {
    throw Object.assign(new Error('مقدار درخواستی از موجودی آزاد بیشتر است.'), { statusCode: 409 });
  }

  const operation = options.operations.find(op => op.id === productionOperationId);
  if (!operation) {
    throw Object.assign(new Error('عملیات هدف یافت نشد یا قابل حواله نیست.'), { statusCode: 404 });
  }

  const targetWh = options.warehouses.find(w => w.id === targetWarehouseId) || options.warehouses[0];
  const actor = operators.find(o => o.id === createdByUserId);
  const nowIso = new Date().toISOString();
  const docNumber = `TRF-MAT-${Date.now().toString().slice(-6)}`;
  const partObj = parts.find(p => p.id === source.partId);
  const computedWeightKg = suppliedWeightKg > 0 ? suppliedWeightKg : Number((quantity * (partObj?.weightPerUnitKg || 0.008)).toFixed(3));

  const transferDoc: InventoryDocument = {
    id: `DOC-MAT-${Date.now()}`,
    documentNumber: docNumber,
    documentType: 'TRANSFER',
    movementType: '311',
    movementLabel: '۳۱۱ - انتقال بین‌انباری / ایستگاه‌های کارخانه',
    documentDate: nowIso,
    documentStatus: 'CONFIRMED',
    postingStatus: 'POSTED',
    warehouseId: source.warehouse.id,
    warehouseName: source.warehouse.name,
    targetWarehouseId: targetWh?.id || targetWarehouseId,
    targetWarehouseName: targetWh?.name || 'انبار پای کار جوش و مونتاژ',
    ownership: source.ownership,
    contractNumber: source.contractNumber || undefined,
    referenceType: 'MANUFACTURING_ORDER',
    referenceNumber: operation.manufacturingOrder.moNumber,
    auditNote: `انتقال مواد غیرکلافی به عملیات ${operation.stepNumber} (${operation.operation.name}) - ${payload.notes || ''}`,
    lines: [
      {
        id: `LN-MAT-${Date.now()}`,
        documentId: `DOC-MAT-${Date.now()}`,
        lineNumber: 1,
        partId: source.partId,
        partCode: source.part.partNumber,
        partName: source.part.name,
        lotNumber: source.materialLot?.lotNumber || `LOT-${source.part.partNumber}`,
        ownership: source.ownership,
        contractNumber: source.contractNumber || undefined,
        locationCode: source.location.code,
        targetLocationCode: targetLocationId,
        quantity,
        unit: source.part.unit.code as 'PCS' | 'KG',
        quantityKg: computedWeightKg,
        qualityStatus: 'AVAILABLE',
        notes: payload.notes || `حواله پای‌کار عملیات ${operation.operation.name}`,
      },
    ],
    totalQuantity: quantity,
    totalWeightKg: computedWeightKg,
    createdByUid: actor?.id || createdByUserId,
    createdByName: actor?.fullName || 'انباردار تولید',
    postedByUid: actor?.id || createdByUserId,
    postedByName: actor?.fullName || 'انباردار تولید',
    postedAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  inventoryDocs.unshift(transferDoc);
  transactions.unshift({
    id: `TX-MAT-${Date.now()}`,
    voucherNumber: docNumber,
    voucherType: 'ISSUE',
    partId: source.partId,
    partCode: source.part.partNumber,
    partName: source.part.name,
    stageId: 'STAGE_RAW_STORE',
    stageName: source.warehouse.name,
    targetStageId: 'STAGE_SPOT_WELD',
    targetStageName: targetWh?.name || 'انبار پای‌کار عملیات',
    quantity,
    unit: source.part.unit.code as 'PCS' | 'KG',
    quantityKg: computedWeightKg,
    referenceDoc: operation.manufacturingOrder.moNumber,
    operatorName: actor?.fullName || 'انباردار تولید',
    shift: 'MORNING',
    status: 'CONFIRMED',
    notes: transferDoc.auditNote,
    createdAt: nowIso,
  });

  auditLogs.unshift({
    id: `AUD-MAT-${Date.now()}`,
    timestamp: nowIso,
    action: 'POST_MATERIAL_ISSUE_TO_OPERATION',
    entityName: 'InventoryDocument',
    entityId: transferDoc.id,
    user: { uid: actor?.id || createdByUserId, displayName: actor?.fullName || 'انباردار تولید' },
    details: `${docNumber}: ${transferDoc.auditNote || ''}`,
  });

  if (issueRequestKey) {
    fallbackMaterialIssueIdempotency.set(issueRequestKey, { fingerprint, document: transferDoc });
  }

  return { document: transferDoc, replayed: false };
}

export function getFallbackCoilIssueOptions(parts: Part[]) {
  return manufacturingOrdersStore
    .filter(mo => ['PLANNED', 'RELEASED', 'IN_PROGRESS'].includes(mo.status))
    .map(mo => {
      const part = parts.find(p => p.id === mo.partId || p.code === mo.partCode);
      const sortedOps = [...mo.operations].sort((a, b) => a.stepNumber - b.stepNumber);
      const firstStep = sortedOps[0]?.stepNumber ?? 10;
      const eligibleOps = sortedOps.filter(
        op => op.status === 'READY' || op.status === 'IN_PROGRESS' || (op.status === 'PENDING' && op.stepNumber === firstStep),
      );
      return {
        id: mo.id,
        moNumber: mo.moNumber,
        partCode: mo.partCode,
        partName: mo.partName,
        weightNetKg: part?.weightPerUnitKg || 0,
        weightGrossKg: getGrossWeightKgForPart(mo.partCode, parts, part?.weightPerUnitKg),
        wipManufacturingOrderId: mo.id,
        status: mo.status,
        operations: eligibleOps.map(op => ({
          id: op.id,
          stepNumber: op.stepNumber,
          operationCode: op.stepCode,
          operationName: op.stepName,
          processType: op.processType,
          status: op.status,
          isFirstOperation: op.stepNumber === firstStep,
          plannedMachine: op.machineName || null,
        })),
      };
    })
    .filter(mo => mo.operations.length > 0);
}

export async function postFallbackCoilIssue(
  coilIdOrId: string,
  body: any,
  physicalCoils: PhysicalCoil[],
  coilIssueRecords: CoilIssueReturnRecord[],
  inventoryDocs: InventoryDocument[],
  _parts: Part[],
  transactions: InventoryTransaction[],
  coils?: { coilNumber: string; heatNumber?: string; receivedWeightKg: number; consumedWeightKg: number; status: string }[],
) {
  const { issuedWeightKg, moId, moOperationId, scrappedKg, multiParts, initialInputQuantityPcs } = body || {};
  const issueRequestKey = String(body?.issueRequestKey || '').trim();
  const coil = physicalCoils.find(c => c.id === coilIdOrId || c.coilId === coilIdOrId);
  if (!coil) {
    throw Object.assign(new Error('کلاف فیزیکی مورد نظر یافت نشد.'), { statusCode: 404 });
  }

  const activeHold =
    serverQcHoldStore[coil.id] ||
    serverQcHoldStore[coil.coilId] ||
    (coil.coilPackNumber ? serverQcHoldStore[coil.coilPackNumber] : undefined);
  if (
    ['QUARANTINE', 'QUALITY_BLOCKED', 'REJECTED', 'SCRAP', 'BLOCKED'].includes(coil.qualityStatus) ||
    coil.physicalStatus === 'BLOCKED' ||
    coil.physicalStatus === 'RETURNED' ||
    activeHold?.isHeld
  ) {
    throw Object.assign(
      new Error(`کلاف «${coil.coilId}» در وضعیت قرنطینه کیفی (QC Hold)، مسدود، ضایعات یا مرجوع‌شده قرار دارد و امکان صدور به تولید ندارد.`),
      { statusCode: 409 },
    );
  }

  const fingerprint = JSON.stringify({
    coilId: coil.id,
    issuedWeightKg: Number(issuedWeightKg) || 0,
    moId: moId || null,
    moOperationId: moOperationId || null,
    scrappedKg: Number(scrappedKg) || 0,
    initialInputQuantityPcs: Number(initialInputQuantityPcs) || 0,
    multiParts: Array.isArray(multiParts) ? multiParts : null,
  });

  if (issueRequestKey && fallbackCoilIssueIdempotency.has(issueRequestKey)) {
    const prior = fallbackCoilIssueIdempotency.get(issueRequestKey)!;
    if (prior.fingerprint !== fingerprint) {
      throw Object.assign(new Error('این شناسه درخواست قبلاً برای اطلاعات متفاوتی استفاده شده است.'), {
        statusCode: 409,
      });
    }
    return { ...prior.response, duplicate: true, idempotentReplay: true };
  }

  const requested = Array.isArray(multiParts) && multiParts.length > 0
    ? (() => {
        const totalGood = multiParts.reduce((s: number, r: any) => s + (Number(r.issuedWeightKg) || 0), 0);
        const totalScrap = Number(scrappedKg) || 0;
        return multiParts.map((p: any) => {
          const goodWeight = Number(p.issuedWeightKg) || 0;
          const scrapShare = totalGood > 0 ? totalScrap * (goodWeight / totalGood) : 0;
          return {
            moId: p.moId || moId || 'MO-ECU-MAIN-01',
            moOperationId: p.moOperationId || moOperationId,
            partName: p.partName,
            issuedWeightKg: goodWeight + scrapShare,
            scrappedKg: scrapShare,
            initialInputQuantityPcs: 0,
          };
        });
      })()
    : [
        {
          moId: moId || 'MO-ECU-MAIN-01',
          moOperationId,
          partName: '',
          issuedWeightKg: Number(issuedWeightKg) || 0,
          scrappedKg: Number(scrappedKg) || 0,
          initialInputQuantityPcs: Number(initialInputQuantityPcs) || 0,
        },
      ];

  const totalIssued = requested.reduce((s, r) => s + r.issuedWeightKg, 0);
  if (totalIssued <= 0 || totalIssued > coil.remainingWeightKg) {
    throw Object.assign(new Error(`وزن حواله (${totalIssued} kg) از مانده کلاف (${coil.remainingWeightKg} kg) معتبر نیست.`), {
      statusCode: 400,
    });
  }

  const nowIso = new Date().toISOString();
  const docNumber = `ISS-COIL-${Date.now().toString().slice(-6)}`;
  const createdRecords: CoilIssueReturnRecord[] = [];
  const docLines: any[] = [];

  const existingCoilLedgerLot = inventoryDocs
    .flatMap(d => d.lines || [])
    .find(
      l =>
        l.physicalCoilId === coil.id ||
        l.coilId === coil.coilId ||
        l.lotNumber === coil.coilPackNumber ||
        l.lotNumber === coil.coilId
    )?.lotNumber;
  const resolvedIssueLot = existingCoilLedgerLot || coil.coilPackNumber || coil.coilId;

  for (let i = 0; i < requested.length; i += 1) {
    const row = requested[i];
    const mo = manufacturingOrdersStore.find(m => m.id === row.moId || m.moNumber === row.moId);
    const result = issuePhysicalCoilPartial(
      coil,
      row.issuedWeightKg,
      mo?.moNumber || row.moId,
      docNumber,
      row.scrappedKg,
      { uid: body?.user?.uid || 'USR-WH-01', displayName: body?.user?.displayName || body?.user?.fullName || 'انباردار رول و ورق' },
    );
    if (!result.success || !result.issueRecord) {
      throw Object.assign(new Error(result.error || 'خطا در صدور جزئی کلاف'), { statusCode: 409 });
    }
    createdRecords.push(result.issueRecord);
    coilIssueRecords.unshift(result.issueRecord);

    docLines.push({
      id: `LN-COIL-ISS-${Date.now()}-${i + 1}`,
      documentId: `DOC-COIL-ISS-${Date.now()}`,
      lineNumber: i + 1,
      partId: coil.partId,
      partCode: coil.partCode,
      partName: coil.partName,
      physicalCoilId: coil.id,
      coilId: coil.coilId,
      coilPackNumber: coil.coilPackNumber,
      lotNumber: resolvedIssueLot,
      heatNumber: coil.heatNumber,
      ownership: coil.ownership,
      contractId: coil.allocations?.[0]?.contractId,
      contractNumber: coil.allocations?.[0]?.contractNumber,
      locationCode: coil.warehouseLocationCode || 'LOC-RAW-A1',
      quantity: row.issuedWeightKg,
      unit: 'KG',
      quantityKg: row.issuedWeightKg,
      qualityStatus: 'AVAILABLE',
      movementType: '261',
      notes: `حواله کلاف ${coil.coilId} به ${mo?.moNumber || row.moId} (${row.initialInputQuantityPcs || 0} قطعه)`,
    });

    if (row.initialInputQuantityPcs > 0 && mo) {
      const sortedOps = [...mo.operations].sort((a, b) => a.stepNumber - b.stepNumber);
      const wipOp = row.moOperationId
        ? mo.operations.find(op => op.id === row.moOperationId)
        : sortedOps[0];
      if (wipOp) {
        loadMaterialIntoManufacturingOrder({
          moId: mo.id,
          operationId: wipOp.id,
          quantity: row.initialInputQuantityPcs,
          operatorName: body?.user?.fullName || 'انباردار رول و ورق',
          notes: `ورود ورق از کلاف ${coil.coilId} (سند ${docNumber})`,
        });
      }
    }
  }

  if (coils && coils.length > 0) {
    const sapcoCoil = coils.find(c => c.coilNumber === coil.coilId || (coil.heatNumber && c.heatNumber === coil.heatNumber));
    if (sapcoCoil) {
      sapcoCoil.consumedWeightKg = Number((sapcoCoil.consumedWeightKg + totalIssued).toFixed(2));
      sapcoCoil.status = sapcoCoil.consumedWeightKg >= sapcoCoil.receivedWeightKg - 0.01 ? 'DEPLETED' : 'IN_CUTTING';
    }
  }

  await persistProductionWipState();

  inventoryDocs.unshift({
    id: `DOC-COIL-ISS-${Date.now()}`,
    documentNumber: docNumber,
    documentType: 'ISSUE_RAW_MATERIAL',
    movementType: '261',
    movementLabel: '۲۶۱ - حواله مصرف مواد به دستور ساخت (GI to Order)',
    documentDate: nowIso,
    documentStatus: 'CONFIRMED',
    postingStatus: 'POSTED',
    warehouseId: coil.warehouseId || 'WH-RAW',
    warehouseName: coil.warehouseName || 'انبار مرکزی رول و ورق مواد اولیه',
    ownership: coil.ownership,
    contractId: coil.allocations?.[0]?.contractId,
    contractNumber: coil.allocations?.[0]?.contractNumber,
    referenceType: 'MANUFACTURING_ORDER',
    referenceNumber: requested.map(r => r.moId).join(', '),
    auditNote: `حواله ${totalIssued} کیلوگرم از کلاف ${coil.coilId} (ذوب ${coil.heatNumber}) به تولید`,
    lines: docLines,
    totalQuantity: totalIssued,
    totalWeightKg: totalIssued,
    createdByUid: body?.user?.uid || 'USR-WH-01',
    createdByName: body?.user?.fullName || 'انباردار رول و ورق',
    postedByUid: body?.user?.uid || 'USR-WH-01',
    postedByName: body?.user?.fullName || 'انباردار رول و ورق',
    postedAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  transactions.unshift({
    id: `TX-COIL-ISS-${Date.now()}`,
    voucherNumber: docNumber,
    voucherType: 'ISSUE',
    partId: coil.partId || 'PRT-RM-COIL',
    partCode: coil.partCode || `RM-COIL-${coil.materialGrade}`,
    partName: coil.partName || `کلاف ورق ${coil.materialGrade}`,
    stageId: 'STAGE_RAW_STORE',
    stageName: coil.warehouseName,
    targetStageId: 'STAGE_SHEARING',
    targetStageName: 'خط برش و تولید',
    quantity: totalIssued,
    unit: 'KG',
    quantityKg: totalIssued,
    referenceDoc: `${docNumber} / ${coil.coilId}`,
    operatorName: body?.user?.fullName || 'انباردار رول و ورق',
    shift: 'MORNING',
    status: 'CONFIRMED',
    notes: `ذوب ${coil.heatNumber}`,
    createdAt: nowIso,
  });

  const payloadResp = {
    success: true,
    message: `حواله ${totalIssued} کیلوگرم از کلاف «${coil.coilId}» در سند ${docNumber} ثبت شد. مانده: ${coil.remainingWeightKg} کیلوگرم.`,
    coil,
    issueRecords: createdRecords,
    issueRecord: createdRecords[0],
    documentNumber: docNumber,
    persistence: 'IN_MEMORY_RELATIONAL_PARITY',
  };

  if (issueRequestKey) {
    fallbackCoilIssueIdempotency.set(issueRequestKey, { fingerprint, response: payloadResp });
  }
  return payloadResp;
}

export function postFallbackCoilReturn(
  coilIdOrId: string,
  body: any,
  physicalCoils: PhysicalCoil[],
  coilIssueRecords: CoilIssueReturnRecord[],
  inventoryDocs: InventoryDocument[],
  warehouses: WarehouseDefinition[],
) {
  const coil = physicalCoils.find(c => c.id === coilIdOrId || c.coilId === coilIdOrId);
  if (!coil) throw Object.assign(new Error('کلاف فیزیکی مورد نظر یافت نشد.'), { statusCode: 404 });

  const returnedKg = Number(body?.returnedRemnantWeightKg ?? body?.returnedWeightKg ?? 0);
  if (!Number.isFinite(returnedKg) || returnedKg <= 0) {
    throw Object.assign(new Error('وزن برگشتی باید عددی مثبت باشد.'), { statusCode: 400 });
  }
  const varianceKg = Number(body?.varianceWeightKg ?? body?.scrappedKg ?? 0);
  if (!Number.isFinite(varianceKg) || varianceKg < 0) {
    throw Object.assign(new Error('وزن افت/ضایعات برگشتی نمی‌تواند منفی باشد.'), { statusCode: 400 });
  }

  const idempotencyKey = String(body?.idempotencyKey || body?.returnRequestKey || '').trim();
  const fingerprint = JSON.stringify({
    coilId: coil.id,
    returnedKg: Math.round(returnedKg * 1000) / 1000,
    varianceKg: Math.round(varianceKg * 1000) / 1000,
    warehouseId: body?.warehouseId || coil.warehouseId || null,
    locationCode: body?.locationCode || coil.warehouseLocationCode || null,
  });

  if (idempotencyKey && fallbackCoilReturnIdempotency.has(idempotencyKey)) {
    const prior = fallbackCoilReturnIdempotency.get(idempotencyKey)!;
    if (prior.fingerprint !== fingerprint) {
      throw Object.assign(
        new Error('شناسه یکتای درخواست برگشت ته‌کلاف (Idempotency-Key) قبلاً با مشخصات متفاوتی استفاده شده است.'),
        { statusCode: 409 },
      );
    }
    return { ...prior.response, idempotentReplay: true };
  }

  const netIssuedToProduction = Math.max(
    0,
    Math.round((Number(coil.originalWeightKg || 0) - Number(coil.remainingWeightKg || 0)) * 1000) / 1000
  );
  if (netIssuedToProduction <= 0.001) {
    throw Object.assign(
      new Error(`کلاف «${coil.coilId}» هیچ مانده صادرشده‌ای در خط تولید ندارد و امکان برگشت ته‌کلاف وجود ندارد.`),
      { statusCode: 409 },
    );
  }
  if (returnedKg + varianceKg > netIssuedToProduction + 0.001) {
    throw Object.assign(
      new Error(
        `مجموع وزن برگشتی (${returnedKg} kg)${varianceKg > 0 ? ` و افت/ضایعات (${varianceKg} kg)` : ''} نمی‌تواند از وزن صادرشده به خط تولید (${netIssuedToProduction} kg) بیشتر باشد.`
      ),
      { statusCode: 409 },
    );
  }

  const lastOpenIssue = coilIssueRecords.find(
    r => (r.coilId === coil.id || r.coilId === coil.coilId) && Number(r.issuedWeightKg || 0) > 0 && Number(r.outstandingWeightKg || 0) > 0
  );

  const docNumber =
    body?.documentNumber && String(body.documentNumber).trim()
      ? String(body.documentNumber).trim()
      : `RET-COIL-${Date.now().toString().slice(-6)}`;
  const retRes = returnPhysicalCoilPartial(
    coil,
    returnedKg,
    docNumber,
    lastOpenIssue || varianceKg,
    lastOpenIssue ? varianceKg : body?.notes,
    body?.notes,
  );
  if (!retRes.success || !retRes.returnRecord) {
    throw Object.assign(new Error(retRes.error || 'خطا در ثبت برگشت ته‌کلاف'), { statusCode: 409 });
  }

  const targetWh = warehouses.find(w => w.id === body?.warehouseId) || warehouses.find(w => w.id === coil.warehouseId);
  coil.physicalStatus =
    coil.remainingWeightKg >= coil.originalWeightKg - 0.01 ? 'AVAILABLE' : 'PARTIALLY_ISSUED';
  if (targetWh) {
    coil.warehouseId = targetWh.id;
    coil.warehouseName = targetWh.name;
  }
  if (body?.locationCode) coil.warehouseLocationCode = body.locationCode;
  const nowIso = new Date().toISOString();
  coil.updatedAt = nowIso;
  coilIssueRecords.unshift(retRes.returnRecord);

  // Preserve the exact lotNumber already used by existing ledger documents for this coil
  const existingCoilLedgerLot = inventoryDocs
    .flatMap(d => d.lines || [])
    .find(
      l =>
        l.physicalCoilId === coil.id ||
        l.coilId === coil.coilId ||
        l.lotNumber === coil.coilPackNumber ||
        l.lotNumber === coil.coilId
    )?.lotNumber;
  const resolvedLotNumber = existingCoilLedgerLot || coil.coilPackNumber || coil.coilId;

  const docId = `DOC-RET-${Date.now()}`;
  const returnDoc: InventoryDocument = {
    id: docId,
    documentNumber: docNumber,
    documentType: 'RECEIPT_RAW_MATERIAL',
    movementType: '262',
    movementLabel: '۲۶۲ - ابطال حواله مصرف / برگشت از تولید',
    idempotencyKey: idempotencyKey || undefined,
    documentDate: nowIso,
    documentStatus: 'CONFIRMED',
    postingStatus: 'POSTED',
    warehouseId: coil.warehouseId,
    warehouseName: coil.warehouseName,
    ownership: coil.ownership,
    contractId: coil.allocations?.[0]?.contractId,
    contractNumber: coil.allocations?.[0]?.contractNumber,
    referenceType: 'PRODUCTION_RETURN',
    referenceNumber: coil.coilId,
    auditNote: `برگشت ته‌کلاف ${returnedKg} کیلوگرمی${varianceKg > 0 ? ` (افت/ضایعات: ${varianceKg} kg)` : ''} از خط به انبار (${body?.notes || ''})`,
    lines: [
      {
        id: `LN-RET-${Date.now()}`,
        documentId: docId,
        lineNumber: 1,
        partId: coil.partId || 'PRT-RM-COIL',
        partCode: coil.partCode || `RM-COIL-${coil.materialGrade}`,
        partName: coil.partName || `کلاف ورق ${coil.materialGrade}`,
        physicalCoilId: coil.id,
        coilId: coil.coilId,
        coilPackNumber: coil.coilPackNumber,
        lotNumber: resolvedLotNumber,
        heatNumber: coil.heatNumber,
        ownership: coil.ownership,
        contractId: coil.allocations?.[0]?.contractId,
        contractNumber: coil.allocations?.[0]?.contractNumber,
        locationCode: coil.warehouseLocationCode || 'LOC-RAW-A1',
        quantity: returnedKg,
        unit: 'KG',
        quantityKg: returnedKg,
        qualityStatus: 'AVAILABLE',
        movementType: '262',
        notes: `برگشت ته‌کلاف ${coil.coilId}${varianceKg > 0 ? ` | افت وزنی: ${varianceKg} kg` : ''}`,
      },
    ],
    totalQuantity: returnedKg,
    totalWeightKg: returnedKg,
    createdByUid: body?.user?.uid || 'USR-WH-01',
    createdByName: body?.user?.displayName || body?.user?.fullName || 'انباردار رول و ورق',
    postedByUid: body?.user?.uid || 'USR-WH-01',
    postedByName: body?.user?.displayName || body?.user?.fullName || 'انباردار رول و ورق',
    postedAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  inventoryDocs.unshift(returnDoc);

  const responsePayload = {
    success: true,
    idempotentReplay: false,
    message: `ته‌کلاف ${returnedKg} کیلوگرمی با سند ${docNumber} به انبار برگشت و کاردکس به‌روزرسانی شد.`,
    coil,
    document: returnDoc,
    returnRecords: [retRes.returnRecord],
    returnRecord: retRes.returnRecord,
    documentNumber: docNumber,
    persistence: 'IN_MEMORY_RELATIONAL_PARITY',
  };

  if (idempotencyKey) {
    fallbackCoilReturnIdempotency.set(idempotencyKey, { fingerprint, response: responsePayload });
  }

  return responsePayload;
}

export function postFallbackCoilAllocate(
  coilIdOrId: string,
  allocations: any[],
  physicalCoils: PhysicalCoil[],
  contracts: SapcoContract[],
) {
  const coil = physicalCoils.find(c => c.id === coilIdOrId || c.coilId === coilIdOrId);
  if (!coil) throw Object.assign(new Error('کلاف فیزیکی مورد نظر یافت نشد.'), { statusCode: 404 });

  coil.allocations = allocations.map(a => {
    const cnt = contracts.find(c => c.id === a.contractId || c.contractNumber === a.contractNumber);
    return {
      contractId: cnt?.id || a.contractId,
      contractNumber: cnt?.contractNumber || a.contractNumber || a.contractId,
      coilId: coil.id,
      allocatedWeightKg: Number(a.allocatedWeightKg),
      ownership: coil.ownership,
      notes: a.notes || undefined,
    };
  });
  coil.updatedAt = new Date().toISOString();

  return {
    success: true,
    message: `تخصیص کلاف «${coil.coilId}» به قراردادها با موفقیت ثبت شد.`,
    coil,
    allocations: coil.allocations,
    documentNumber: `ADJ-ALLOC-${Date.now().toString().slice(-6)}`,
  };
}

export function getFallbackCoilGenealogy(
  coilIdOrId: string,
  physicalCoils: PhysicalCoil[],
  coilIssueRecords: CoilIssueReturnRecord[],
  inventoryDocs: InventoryDocument[],
) {
  const coil = physicalCoils.find(c => c.id === coilIdOrId || c.coilId === coilIdOrId || c.coilPackNumber === coilIdOrId);
  if (!coil) throw Object.assign(new Error('کلاف فیزیکی مورد نظر یافت نشد.'), { statusCode: 404 });

  const relatedRecords = coilIssueRecords.filter(r => r.coilId === coil.id);
  const issueEvents = relatedRecords.filter(r => Number(r.issuedWeightKg || 0) > 0);
  const returnEvents = relatedRecords.filter(
    r => Number(r.issuedWeightKg || 0) <= 0 && Number(r.returnedWeightKg || 0) > 0
  );
  const totalIssuedKg = issueEvents.reduce((s, r) => s + Number(r.issuedWeightKg || 0), 0);
  const totalReturnedKg =
    returnEvents.length > 0
      ? returnEvents.reduce((s, r) => s + Number(r.returnedWeightKg || 0), 0)
      : issueEvents.reduce((s, r) => s + Number(r.returnedWeightKg || 0), 0);
  const totalVarianceKg =
    returnEvents.length > 0
      ? returnEvents.reduce((s, r) => s + Number(r.varianceWeightKg || 0), 0)
      : issueEvents.reduce((s, r) => s + Number(r.varianceWeightKg || 0), 0);
  const outstandingAtProductionKg = issueEvents.reduce((s, r) => s + Number(r.outstandingWeightKg || 0), 0);
  const netConsumedKg = Math.max(0, Number((coil.originalWeightKg - coil.remainingWeightKg).toFixed(2)));
  const relatedDocuments = inventoryDocs
    .filter(d =>
      d.lines.some(
        l =>
          l.physicalCoilId === coil.id ||
          l.coilId === coil.coilId ||
          l.lotNumber === coil.coilId ||
          (coil.coilPackNumber && (l.lotNumber === coil.coilPackNumber || l.coilPackNumber === coil.coilPackNumber)) ||
          (Boolean(coil.heatNumber && coil.heatNumber.trim()) && l.heatNumber === coil.heatNumber)
      )
    )
    .map(d => ({
      id: d.id,
      documentNumber: d.documentNumber,
      documentType: d.documentType,
      documentDate: d.documentDate,
      referenceNumber: d.referenceNumber || '-',
    }));

  return {
    success: true,
    source: 'IN_MEMORY_RELATIONAL_PARITY',
    data: {
      coil,
      lifecycleStatus: coil.remainingWeightKg <= 0 ? 'CONSUMED' : coil.remainingWeightKg < coil.originalWeightKg ? 'PARTIAL' : 'FULL',
      metrics: {
        originalWeightKg: coil.originalWeightKg,
        remainingWeightKg: coil.remainingWeightKg,
        totalIssuedKg: totalIssuedKg || netConsumedKg,
        totalReturnedKg,
        totalConsumedKg: netConsumedKg,
        totalVarianceKg,
        outstandingAtProductionKg,
        utilizationPercent: coil.originalWeightKg > 0 ? Math.round((netConsumedKg / coil.originalWeightKg) * 10000) / 100 : 0,
      },
      records: relatedRecords,
      allocations: coil.allocations || [],
      relatedDocuments,
    },
  };
}

export function getFallbackWipPostingContext(
  wipMoId: string,
  shifts: ShiftDefinition[],
  operators: Operator[],
  machines: Machine[],
) {
  const wipOrder = manufacturingOrdersStore.find(o => o.id === wipMoId);
  if (!wipOrder) return null;

  const matchingOrders = manufacturingOrdersStore
    .filter(o => o.partCode === wipOrder.partCode)
    .map(o => ({
      id: o.id,
      moNumber: o.moNumber,
      part: { partNumber: o.partCode, name: o.partName },
      operations: o.operations.map(op => {
        const machine = machines.find(m => m.id === op.machineId) || machines.find(m => m.status === 'ACTIVE' && m.capabilities.includes(op.processType));
        return {
          id: op.id,
          stepNumber: op.stepNumber,
          plannedMachineId: op.machineId || machine?.id || null,
          plannedMachine: machine ? { id: machine.id, code: machine.code, name: machine.name } : null,
          operation: { processType: op.processType, name: op.stepName },
        };
      }),
    }));

  return {
    manufacturingOrders: matchingOrders,
    shifts: shifts.map(s => ({ id: s.id, code: s.code, name: s.name, startTime: s.startTime, endTime: s.endTime })),
    users: operators.map(op => ({ id: op.id, username: op.personnelCode, fullName: op.fullName, personnelCode: op.personnelCode })),
    machines: machines.map(m => ({ id: m.id, code: m.code, name: m.name })),
    identityLink: { manufacturingOrderId: wipOrder.id },
  };
}

export async function postFallbackWipOperationProduction(
  body: any,
  parts: Part[],
  physicalCoils: PhysicalCoil[],
  inventoryDocs: InventoryDocument[],
  transactions: InventoryTransaction[],
  reservations: InventoryReservation[] = [],
  onPostedDocument?: (doc: InventoryDocument) => void,
) {
  const idempotencyKey = String(body.idempotencyKey || '').trim();
  const reqFingerprint = JSON.stringify({
    operationId: body.operationId,
    goodQty: Number(body.goodQty || 0),
    scrapQty: Number(body.scrapQty || 0),
    reworkQty: Number(body.reworkQty || 0),
    rejectedQty: Number(body.rejectedQty || 0),
    runTimeMinutes: Number(body.runTimeMinutes || 0),
    downtimeMinutes: Number(body.downtimeMinutes || 0),
    downtimeReason: (body.downtimeReason || '').trim(),
    actualMaterialConsumedKg:
      body.actualMaterialConsumedKg != null && body.actualMaterialConsumedKg !== ''
        ? Number(body.actualMaterialConsumedKg)
        : null,
  });
  if (idempotencyKey && fallbackWipProductionIdempotency.has(idempotencyKey)) {
    const prior = fallbackWipProductionIdempotency.get(idempotencyKey)!;
    if (prior.fingerprint && prior.fingerprint !== reqFingerprint) {
      throw Object.assign(new Error('کلید یکتای ثبت (idempotencyKey) قبلاً با مقادیر متفاوتی استفاده شده است.'), {
        statusCode: 409,
        conflict: true,
      });
    }
    return {
      success: true,
      duplicate: true,
      message: 'این گزارش قبلاً ثبت شده است؛ ثبت تکراری انجام نشد.',
      data: prior.mo,
      report: prior.log,
      inventoryPosted: true,
    };
  }

  const preMoIndex = manufacturingOrdersStore.findIndex(m => m.id === body.moId || m.moNumber === body.moId);
  const preMo = preMoIndex >= 0 ? manufacturingOrdersStore[preMoIndex] : undefined;
  const preMoSnapshot = preMo ? JSON.parse(JSON.stringify(preMo)) : null;
  const preLogsCount = productionLogsStore.length;

  const preOp = preMo?.operations.find(o => o.id === body.operationId);
  if (preOp) {
    if (preOp.status === 'COMPLETED') {
      throw Object.assign(new Error('این مرحله قبلاً تکمیل شده است.'), { statusCode: 409 });
    }
    if (fallbackOpPauseMap.get(preOp.id)?.paused) {
      throw Object.assign(new Error('این عملیات در وضعیت توقف (PAUSED) قرار دارد؛ ابتدا عملیات را از سر بگیرید.'), {
        statusCode: 409,
      });
    }
    const plannedCap = Number((preOp as any).plannedQuantity || preMo?.targetQuantity || 0);
    if (
      !body.allowOverproduction &&
      plannedCap > 0 &&
      (Number(preOp.goodOutputQty) || 0) + (Number(body.goodQty) || 0) > plannedCap + 1e-6
    ) {
      throw Object.assign(
        new Error(`تولید بیش از سقف برنامه‌ریزی‌شده (${plannedCap}) مجاز نیست.`),
        { statusCode: 409 },
      );
    }
  }
  const downtimeMinVal = Number(body.downtimeMinutes || 0);
  if (downtimeMinVal > 0 && !String(body.downtimeReason || '').trim()) {
    throw Object.assign(new Error('در صورت ثبت زمان توقف، درج علت توقف الزامی است.'), { statusCode: 400 });
  }
  const totalToReport =
    (Number(body.goodQty) || 0) +
    (Number(body.scrapQty) || 0) +
    (Number(body.reworkQty) || 0) +
    (Number(body.rejectedQty) || 0);
  if (preOp && totalToReport > (preOp.inProgressQty || 0)) {
    const deficit = totalToReport - (preOp.inProgressQty || 0);
    if ((preOp.waitingInputQty || 0) >= deficit) {
      registerOperationInput({
        moId: preMo!.id,
        operationId: preOp.id,
        quantity: deficit,
        machineId: body.machineId,
        operatorName: body.operatorName || 'اپراتور تولید',
      });
    }
  }

  const mutationResult = registerOperationProduction(body);
  if (!mutationResult.success || !mutationResult.data) {
    if (preMoSnapshot && preMoIndex >= 0) {
      manufacturingOrdersStore[preMoIndex] = preMoSnapshot;
      productionLogsStore.splice(0, productionLogsStore.length - preLogsCount);
    }
    throw Object.assign(new Error(mutationResult.error || 'خطا در ثبت عملکرد تولید'), { statusCode: 400 });
  }

  const rollbackWipMutation = () => {
    if (preMoSnapshot && preMoIndex >= 0) {
      manufacturingOrdersStore[preMoIndex] = preMoSnapshot;
      const addedLogs = productionLogsStore.length - preLogsCount;
      if (addedLogs > 0) productionLogsStore.splice(0, addedLogs);
    }
  };

  const mo = mutationResult.data;
  const op = mo.operations.find(o => o.id === body.operationId);
  const goodQty = Math.max(0, Number(body.goodQty) || 0);
  const scrapQty = Math.max(0, Number(body.scrapQty) || 0);
  const sortedOps = [...mo.operations].sort((a, b) => a.stepNumber - b.stepNumber);
  const isFirstOp = op && sortedOps[0]?.id === op.id;
  const isFinalOp = op && sortedOps[sortedOps.length - 1]?.id === op.id;
  const nowIso = new Date().toISOString();
  const suffix = `${Date.now().toString().slice(-6)}`;
  const activeCoil =
    physicalCoils.find(
      c => c.remainingWeightKg > 0 && c.qualityStatus === 'AVAILABLE' && c.physicalStatus !== 'BLOCKED',
    ) ||
    physicalCoils.find(c => c.remainingWeightKg > 0) ||
    physicalCoils[0];
  const heatNumber = activeCoil?.heatNumber || 'HT-DC01A-9921';
  const coilNumber = activeCoil?.coilPackNumber || activeCoil?.coilId || 'MOB-DC01A-2.0-1140-A';
  let postedTxCount = 0;

  // Resolve real lot/ownership/location from posted stock balances (strictly unrestricted)
  const { balances: currentStockBalances } = calculateDetailedStockBalances(inventoryDocs, reservations, parts, serverQcHoldStore);
  const pickLotMeta = (
    partIdOrCode: string,
    whId: string,
    fallbackLot: string,
    fallbackLoc: string,
    fallbackOwnership: 'SAPCO_SUPPLIER_OWNED' | 'COMPANY_OWNED' = 'SAPCO_SUPPLIER_OWNED',
  ) => {
    const candidates = currentStockBalances
      .filter(b => (b.partId === partIdOrCode || b.partCode === partIdOrCode) && b.warehouseId === whId && b.availableQty > 0)
      .sort((a, b) => b.availableQty - a.availableQty);
    const best = candidates[0];
    return {
      lotNumber: best?.lotNumber || fallbackLot,
      heatNumber: best?.heatNumber || heatNumber,
      ownership: (best?.ownership || fallbackOwnership) as 'SAPCO_SUPPLIER_OWNED' | 'COMPANY_OWNED',
      locationCode: best?.locationCode || fallbackLoc,
      contractId: best?.contractId,
      contractNumber: best?.contractNumber,
    };
  };

  // Detect if raw coil material was already explicitly issued to this MO (e.g. via /inventory/coils/:id/issue)
  // so first-operation production reporting does not double-deduct raw coil stock from WH-RAW.
  const hasExplicitRawCoilIssueForMo = (partIdOrCode: string) =>
    inventoryDocs.some(
      d =>
        d.postingStatus === 'POSTED' &&
        d.documentType === 'ISSUE_RAW_MATERIAL' &&
        d.referenceType === 'MANUFACTURING_ORDER' &&
        (d.referenceNumber === mo.moNumber || d.referenceNumber === mo.id) &&
        !String(d.documentNumber || '').startsWith('ISS-WIP-') &&
        (d.lines || []).some(l => l.partId === partIdOrCode || l.partCode === partIdOrCode),
    );

  // Automatic BOM Backflush in Inventory Docs when operation produces output
  if (op && goodQty > 0) {
    const issueLines: any[] = [];
    let sourceWhId = 'WH-RAW';
    let sourceWhName = 'انبار مرکزی رول و ورق مواد اولیه';

    if (mo.partCode === 'WIP-ECU-MAIN-BRK' || mo.partId === 'PRT-WIP-ECU-MAIN' || mo.partCode === '700014') {
      const coilPart = parts.find(p => p.id === 'PRT-RAW-ECU-COIL');
      const nutPart = parts.find(p => p.id === 'PRT-FST-NUT-M6');
      if (isFirstOp) {
        if (!hasExplicitRawCoilIssueForMo('PRT-RAW-ECU-COIL')) {
          const consumedKg = Number(((goodQty + scrapQty) * 0.98).toFixed(2));
          const meta = pickLotMeta('PRT-RAW-ECU-COIL', sourceWhId, coilNumber, 'LOC-RAW-A1', 'SAPCO_SUPPLIER_OWNED');
          issueLines.push({
            id: `LN-WIP-BF-${suffix}`,
            documentId: `DOC-WIP-BF-${suffix}`,
            lineNumber: 1,
            partId: 'PRT-RAW-ECU-COIL',
            partCode: coilPart?.code || 'RM-COIL-DC01A-2.0-1140',
            partName: coilPart?.name || 'رول ورق روغنی DC01A ضخامت 2mm با عرض 1140mm',
            lotNumber: meta.lotNumber,
            heatNumber: meta.heatNumber,
            ownership: meta.ownership,
            contractId: meta.contractId,
            contractNumber: meta.contractNumber,
            locationCode: meta.locationCode,
            quantity: consumedKg,
            unit: 'KG',
            quantityKg: consumedKg,
            qualityStatus: 'AVAILABLE',
            notes: `مصرف خودکار ورق از عملیات ${op.stepCode} دستور ${mo.moNumber}`,
          });
        }
      } else if (op.processType === 'SPOT_WELD' || isFinalOp) {
        const nutsQty = goodQty * 15;
        const meta = pickLotMeta('PRT-FST-NUT-M6', sourceWhId, 'LOT-NUT-M6-101', 'LOC-RAW-FST-01', 'SAPCO_SUPPLIER_OWNED');
        issueLines.push({
          id: `LN-WIP-BF-${suffix}-NUT`,
          documentId: `DOC-WIP-BF-${suffix}`,
          lineNumber: 1,
          partId: 'PRT-FST-NUT-M6',
          partCode: nutPart?.code || 'FST-NUT-WELD-M6',
          partName: nutPart?.name || 'مهره جوشی چهارگوش پایه‌دار M6',
          lotNumber: meta.lotNumber,
          heatNumber: meta.heatNumber || 'HT-FST-M6',
          ownership: meta.ownership,
          contractId: meta.contractId,
          contractNumber: meta.contractNumber,
          locationCode: meta.locationCode,
          quantity: nutsQty,
          unit: 'PCS',
          quantityKg: Number((nutsQty * 0.006).toFixed(3)),
          qualityStatus: 'AVAILABLE',
          notes: `مصرف خودکار ۱۵ عدد مهره M6 به ازای هر براکت در ${op.stepCode}`,
        });
      }
    } else if (mo.partCode === 'WIP-ECU-COMP-BRK' || mo.partId === 'PRT-WIP-ECU-COMP' || mo.partCode === '700026') {
      const coilPart = parts.find(p => p.id === 'PRT-RAW-ECU-COIL');
      const boltPart = parts.find(p => p.id === 'PRT-FST-BLT-M6-20');
      if (isFirstOp) {
        if (!hasExplicitRawCoilIssueForMo('PRT-RAW-ECU-COIL')) {
          const consumedKg = Number(((goodQty + scrapQty) * 0.47).toFixed(2));
          const meta = pickLotMeta('PRT-RAW-ECU-COIL', sourceWhId, coilNumber, 'LOC-RAW-A1', 'SAPCO_SUPPLIER_OWNED');
          issueLines.push({
            id: `LN-WIP-BF-${suffix}`,
            documentId: `DOC-WIP-BF-${suffix}`,
            lineNumber: 1,
            partId: 'PRT-RAW-ECU-COIL',
            partCode: coilPart?.code || 'RM-COIL-DC01A-2.0-1140',
            partName: coilPart?.name || 'رول ورق روغنی DC01A ضخامت 2mm با عرض 1140mm',
            lotNumber: meta.lotNumber,
            heatNumber: meta.heatNumber,
            ownership: meta.ownership,
            contractId: meta.contractId,
            contractNumber: meta.contractNumber,
            locationCode: meta.locationCode,
            quantity: consumedKg,
            unit: 'KG',
            quantityKg: consumedKg,
            qualityStatus: 'AVAILABLE',
            notes: `مصرف خودکار ورق از عملیات ${op.stepCode} دستور ${mo.moNumber}`,
          });
        }
      } else if (op.processType === 'SPOT_WELD' || isFinalOp) {
        const boltsQty = goodQty * 2;
        const meta = pickLotMeta('PRT-FST-BLT-M6-20', sourceWhId, 'LOT-BLT-M6-202', 'LOC-RAW-FST-02', 'SAPCO_SUPPLIER_OWNED');
        issueLines.push({
          id: `LN-WIP-BF-${suffix}-BLT`,
          documentId: `DOC-WIP-BF-${suffix}`,
          lineNumber: 1,
          partId: 'PRT-FST-BLT-M6-20',
          partCode: boltPart?.code || 'FST-BOLT-WELD-M6-20',
          partName: boltPart?.name || 'پیچ پایه جوشی مقاومتی M6x20',
          lotNumber: meta.lotNumber,
          heatNumber: meta.heatNumber || 'HT-FST-M620',
          ownership: meta.ownership,
          contractId: meta.contractId,
          contractNumber: meta.contractNumber,
          locationCode: meta.locationCode,
          quantity: boltsQty,
          unit: 'PCS',
          quantityKg: Number((boltsQty * 0.008).toFixed(3)),
          qualityStatus: 'AVAILABLE',
          notes: `مصرف خودکار ۲ عدد پیچ ۶×۲۰ به ازای هر قطعه در ${op.stepCode}`,
        });
      }
    } else if ((mo.partCode === 'SAPCO-ASY-ECU-BRK-01' || mo.partId === 'PRT-FG-ECU-ASY' || mo.partCode === '611408') && isFirstOp) {
      const mainPart = parts.find(p => p.id === 'PRT-WIP-ECU-MAIN');
      const compPart = parts.find(p => p.id === 'PRT-WIP-ECU-COMP');
      sourceWhId = 'WH-WIP-WELD';
      sourceWhName = 'انبار پای کار جوش و مونتاژ (WIP)';
      const mainMeta = pickLotMeta('PRT-WIP-ECU-MAIN', sourceWhId, 'LOT-ECU-MAIN-W1', 'LOC-WIP-WELD-01', 'COMPANY_OWNED');
      const compMeta = pickLotMeta('PRT-WIP-ECU-COMP', sourceWhId, 'LOT-ECU-COMP-W1', 'LOC-WIP-WELD-02', 'COMPANY_OWNED');
      issueLines.push(
        {
          id: `LN-WIP-BF-${suffix}-M1`,
          documentId: `DOC-WIP-BF-${suffix}`,
          lineNumber: 1,
          partId: 'PRT-WIP-ECU-MAIN',
          partCode: mainPart?.code || 'WIP-ECU-MAIN-BRK',
          partName: mainPart?.name || 'صفحه براکت اصلی ضدسرقت رایانه موتور',
          lotNumber: mainMeta.lotNumber,
          heatNumber: mainMeta.heatNumber,
          ownership: mainMeta.ownership,
          locationCode: mainMeta.locationCode,
          quantity: goodQty,
          unit: 'PCS',
          quantityKg: Number((goodQty * 0.75).toFixed(2)),
          qualityStatus: 'AVAILABLE',
          notes: `مصرف براکت اصلی در مونتاژ ${mo.moNumber}`,
        },
        {
          id: `LN-WIP-BF-${suffix}-M2`,
          documentId: `DOC-WIP-BF-${suffix}`,
          lineNumber: 2,
          partId: 'PRT-WIP-ECU-COMP',
          partCode: compPart?.code || 'WIP-ECU-COMP-BRK',
          partName: compPart?.name || 'مکمل براکت ضدسرقت رایانه موتور',
          lotNumber: compMeta.lotNumber,
          heatNumber: compMeta.heatNumber,
          ownership: compMeta.ownership,
          locationCode: compMeta.locationCode,
          quantity: goodQty,
          unit: 'PCS',
          quantityKg: Number((goodQty * 0.35).toFixed(2)),
          qualityStatus: 'AVAILABLE',
          notes: `مصرف قطعه مکمل در مونتاژ ${mo.moNumber}`,
        },
      );
    } else {
      // Dynamic fallback BOM backflush for any custom assembly/part defined via Advanced BOM or Part Master
      const dynamicBom = getAllBoms().find(b => b.assemblyPartId === mo.partId || b.assemblyPartCode === mo.partCode);
      const matchedPart = parts.find(p => p.code === mo.partCode || p.id === mo.partId);
      if (dynamicBom && dynamicBom.components.length > 0 && isFirstOp) {
        dynamicBom.components.forEach((cmp, cIdx) => {
          const cmpPart = parts.find(p => p.id === cmp.componentPartId || p.code === cmp.componentPartCode);
          const isSheet = cmp.componentType === 'RAW_SHEET' || cmpPart?.unit === 'KG';
          const scrapMultiplier = 1 + (cmp.scrapAllowancePercent || 0) / 100;
          const reqQty = isSheet
            ? Number(((goodQty + scrapQty) * cmp.quantityPerAssembly * (cmp.grossWeightKg || 1) * scrapMultiplier).toFixed(2))
            : Math.ceil(goodQty * cmp.quantityPerAssembly * scrapMultiplier);
          if (reqQty <= 0) return;
          if (isSheet && hasExplicitRawCoilIssueForMo(cmpPart?.id || cmp.componentPartId)) return;
          const meta = pickLotMeta(
            cmpPart?.id || cmp.componentPartId,
            sourceWhId,
            isSheet ? coilNumber : `LOT-${cmp.componentPartCode}`,
            'LOC-RAW-A1',
            cmp.supplierSource === 'SAPCO_CONSIGNMENT' ? 'SAPCO_SUPPLIER_OWNED' : 'COMPANY_OWNED',
          );
          issueLines.push({
            id: `LN-WIP-BF-${suffix}-${cIdx + 1}`,
            documentId: `DOC-WIP-BF-${suffix}`,
            lineNumber: cIdx + 1,
            partId: cmpPart?.id || cmp.componentPartId,
            partCode: cmpPart?.code || cmp.componentPartCode,
            partName: cmpPart?.name || cmp.componentPartName,
            lotNumber: meta.lotNumber,
            heatNumber: meta.heatNumber,
            ownership: meta.ownership,
            contractId: meta.contractId,
            contractNumber: meta.contractNumber,
            locationCode: meta.locationCode,
            quantity: reqQty,
            unit: isSheet ? 'KG' : cmp.unit || 'PCS',
            quantityKg: isSheet ? reqQty : Number((reqQty * (cmpPart?.weightPerUnitKg || 0.05)).toFixed(3)),
            qualityStatus: 'AVAILABLE',
            notes: `مصرف خودکار BOM در ${op.stepCode} دستور ${mo.moNumber}`,
          });
        });
      } else if (isFirstOp && matchedPart && matchedPart.materialGrade) {
        const consumedKg = Number(((goodQty + scrapQty) * (matchedPart.weightPerUnitKg || 1.1) * 1.1).toFixed(2));
        const rawPart = parts.find(
          p => p.category === 'RAW_MATERIAL' && p.unit === 'KG' && p.materialGrade === matchedPart.materialGrade
        );
        if (rawPart && consumedKg > 0 && !hasExplicitRawCoilIssueForMo(rawPart.id)) {
          const meta = pickLotMeta(rawPart.id, sourceWhId, coilNumber, 'LOC-RAW-A1', 'SAPCO_SUPPLIER_OWNED');
          issueLines.push({
            id: `LN-WIP-BF-${suffix}-RAW`,
            documentId: `DOC-WIP-BF-${suffix}`,
            lineNumber: 1,
            partId: rawPart.id,
            partCode: rawPart.code,
            partName: rawPart.name,
            lotNumber: meta.lotNumber,
            heatNumber: meta.heatNumber,
            ownership: meta.ownership,
            contractId: meta.contractId,
            contractNumber: meta.contractNumber,
            locationCode: meta.locationCode,
            quantity: consumedKg,
            unit: 'KG',
            quantityKg: consumedKg,
            qualityStatus: 'AVAILABLE',
            notes: `مصرف خودکار ورق بر اساس گرید ${matchedPart.materialGrade} در ${op.stepCode}`,
          });
        }
      }
    }

    if (issueLines.length > 0) {
      const bfDoc: InventoryDocument = {
        id: `DOC-WIP-BF-${suffix}`,
        documentNumber: `ISS-WIP-${suffix}`,
        documentType: 'ISSUE_RAW_MATERIAL',
        documentDate: nowIso,
        documentStatus: 'DRAFT',
        postingStatus: 'UNPOSTED',
        warehouseId: sourceWhId,
        warehouseName: sourceWhName,
        ownership: issueLines[0].ownership,
        contractId: issueLines[0].contractId,
        contractNumber: issueLines[0].contractNumber,
        referenceType: 'MANUFACTURING_ORDER',
        referenceNumber: mo.moNumber,
        auditNote: `مصرف خودکار BOM در ثبت تولید ${op.stepCode} (${op.stepName}) - ذوب ${heatNumber}`,
        lines: issueLines,
        totalQuantity: issueLines.reduce((s, l) => s + l.quantity, 0),
        totalWeightKg: issueLines.reduce((s, l) => s + l.quantityKg, 0),
        createdByUid: body.createdByUserId || 'USR-PROD',
        createdByName: body.operatorName || 'اپراتور تولید',
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      // Validate atomically before accepting production & backflush side-effects
      const checkRes = atomicPostDocument(
        bfDoc,
        inventoryDocs,
        reservations,
        parts,
        {
          uid: body.createdByUserId || 'USR-PROD',
          displayName: body.operatorName || 'اپراتور تولید',
        },
        serverQcHoldStore,
      );
      if (checkRes.success) {
        postedTxCount += issueLines.length;
        inventoryDocs.unshift(bfDoc);
        if (onPostedDocument) {
          onPostedDocument(bfDoc);
        } else if (activeCoil) {
          const coilIssuedKg = issueLines
            .filter(l => l.lotNumber === activeCoil.coilId || l.lotNumber === activeCoil.coilPackNumber)
            .reduce((s, l) => s + Number(l.quantityKg || l.quantity || 0), 0);
          if (coilIssuedKg > 0) {
            activeCoil.remainingWeightKg = Math.max(0, Number((activeCoil.remainingWeightKg - coilIssuedKg).toFixed(2)));
            activeCoil.physicalStatus = activeCoil.remainingWeightKg <= 0 ? 'CONSUMED' : 'PARTIALLY_ISSUED';
          }
        }
      } else {
        rollbackWipMutation();
        throw Object.assign(new Error(checkRes.error || 'موجودی انبار برای کسر خودکار BOM کافی نیست.'), { statusCode: 400 });
      }
    }

    if (isFinalOp) {
      const matchedPart = parts.find(p => p.code === mo.partCode || p.id === mo.partId);
      const isWip = matchedPart?.category === 'WIP_PART';
      const targetWhId = isWip ? 'WH-WIP-WELD' : 'WH-FINISHED';
      const targetWhName = isWip ? 'انبار پای کار جوش و مونتاژ (WIP)' : 'انبار محصولات نهایی آماده تحویل';
      const recWeight = Number((goodQty * (matchedPart?.weightPerUnitKg || 1.0)).toFixed(2));
      const rcvDocNumber = isWip ? `RCV-WIP-${suffix}` : `RCV-FG-${suffix}`;
      const rcvDoc: InventoryDocument = {
        id: `DOC-WIP-RCV-${suffix}`,
        documentNumber: rcvDocNumber,
        documentType: 'RECEIPT_FINISHED_GOODS',
        documentDate: nowIso,
        documentStatus: 'DRAFT',
        postingStatus: 'UNPOSTED',
        warehouseId: targetWhId,
        warehouseName: targetWhName,
        ownership: 'COMPANY_OWNED',
        referenceType: 'MANUFACTURING_ORDER',
        referenceNumber: mo.moNumber,
        auditNote: `رسید خودکار اتمام مرحله نهایی ${mo.moNumber} با رهگیری ذوب ${heatNumber}`,
        lines: [
          {
            id: `LN-WIP-RCV-${suffix}`,
            documentId: `DOC-WIP-RCV-${suffix}`,
            lineNumber: 1,
            partId: matchedPart?.id || mo.partId,
            partCode: mo.partCode,
            partName: mo.partName,
            lotNumber: isWip
              ? ((mo.partCode === 'WIP-ECU-MAIN-BRK' || mo.partId === 'PRT-WIP-ECU-MAIN' || mo.partCode === '700014') ? 'LOT-ECU-MAIN-W1' : 'LOT-ECU-COMP-W1')
              : `LOT-FG-${suffix}`,
            heatNumber,
            ownership: 'COMPANY_OWNED',
            locationCode: isWip ? 'LOC-WIP-WELD-01' : 'LOC-FIN-P1',
            quantity: goodQty,
            unit: 'PCS',
            quantityKg: recWeight,
            qualityStatus: 'AVAILABLE',
            notes: `رسید تولید از ${mo.moNumber}`,
          },
        ],
        totalQuantity: goodQty,
        totalWeightKg: recWeight,
        createdByUid: body.createdByUserId || 'USR-PROD',
        createdByName: body.operatorName || 'اپراتور تولید',
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      const rcvPostRes = atomicPostDocument(rcvDoc, inventoryDocs, reservations, parts, {
        uid: body.createdByUserId || 'USR-PROD',
        displayName: body.operatorName || 'اپراتور تولید',
      });
      if (rcvPostRes.success) {
        postedTxCount += 1;
        inventoryDocs.unshift(rcvDoc);
        onPostedDocument?.(rcvDoc);
      }
      transactions.unshift({
        id: `TX-WIP-RCV-${suffix}`,
        voucherNumber: rcvDocNumber,
        voucherType: 'PRODUCTION_OUTPUT',
        partId: matchedPart?.id || mo.partId,
        partCode: mo.partCode,
        partName: mo.partName,
        stageId: isWip ? 'STAGE_SPOT_WELD' : 'STAGE_FINISHED_STORE',
        stageName: targetWhName,
        quantity: goodQty,
        unit: 'PCS',
        quantityKg: recWeight,
        referenceDoc: `${mo.moNumber} / ${heatNumber}`,
        operatorName: body.operatorName || 'اپراتور تولید',
        shift: 'MORNING',
        status: 'CONFIRMED',
        notes: `رسید خودکار تکمیل مرحله نهایی`,
        createdAt: nowIso,
      });
    }
  }

  await persistProductionWipState();

  const runTimeMinutes = Math.max(0, Math.round(Number(body.runTimeMinutes || 0)));
  const downtimeMinutes = Math.max(0, Math.round(Number(body.downtimeMinutes || 0)));
  const downtimeReason = body.downtimeReason ? String(body.downtimeReason).trim() : null;
  const actualMaterialConsumedKg =
    body.actualMaterialConsumedKg != null && body.actualMaterialConsumedKg !== ''
      ? Number(body.actualMaterialConsumedKg)
      : null;

  const log = {
    id: `WLOG-${suffix}`,
    reportNumber: `PR-WIP-${suffix}`,
    moId: mo.id,
    moNumber: mo.moNumber,
    partCode: mo.partCode,
    partName: mo.partName,
    operationId: body.operationId,
    stepCode: op?.stepCode || '',
    stepName: op?.stepName || '',
    machineId: body.relationalMachineId || body.machineId || op?.machineId || null,
    shiftId: body.shiftId || FALLBACK_SHIFTS[0].id,
    operatorName: body.operatorName || 'اپراتور خط',
    reportDate: nowIso,
    goodQty,
    scrapQty,
    reworkQty: Math.max(0, Number(body.reworkQty) || 0),
    rejectedQty: Math.max(0, Number(body.rejectedQty) || 0),
    scrapReason: body.scrapReason || null,
    runTimeMinutes,
    downtimeMinutes,
    downtimeReason,
    strokeCounterStart: body.strokeCounterStart ?? null,
    strokeCounterEnd: body.strokeCounterEnd ?? null,
    actualMaterialConsumedKg,
    createdAt: nowIso,
  };
  fallbackShopFloorReportsStore.unshift(log);
  for (const asg of fallbackMachineAssignmentsStore) {
    if (asg.productionOperationId === body.operationId && (asg.status === 'SCHEDULED' || asg.status === 'ACTIVE')) {
      asg.status = op?.status === 'COMPLETED' ? 'COMPLETED' : 'ACTIVE';
    }
  }
  if (idempotencyKey) {
    fallbackWipProductionIdempotency.set(idempotencyKey, { fingerprint: reqFingerprint, mo, log });
  }

  return {
    success: true,
    duplicate: false,
    message: 'گزارش تولید، کسر خودکار مواد (BOM Backflush) و رسید انبار با موفقیت ثبت شدند.',
    data: mo,
    report: log,
    inventoryTransactionCount: postedTxCount,
    inventoryPosted: true,
  };
}

export function getFallbackSavedReportConfigs(): SavedReportConfig[] {
  return [...fallbackSavedReportConfigsStore];
}

export function saveFallbackReportConfig(payload: any): SavedReportConfig {
  const id = typeof payload.id === 'string' && payload.id.trim() ? payload.id.trim() : `REP-CFG-${Date.now()}`;
  const config: SavedReportConfig = {
    id,
    name: String(payload.name || '').trim(),
    reportType: payload.reportType,
    selectedColumns: Array.isArray(payload.selectedColumns) ? payload.selectedColumns : [],
    groupBy: Array.isArray(payload.groupBy) ? payload.groupBy : [],
    filters: payload.filters && typeof payload.filters === 'object' ? payload.filters : {},
    sortBy: payload.sortBy || undefined,
    sortOrder: payload.sortOrder === 'desc' ? 'desc' : 'asc',
    createdAt: new Date().toISOString(),
  };
  const existingIdx = fallbackSavedReportConfigsStore.findIndex(c => c.id === id);
  if (existingIdx >= 0) {
    fallbackSavedReportConfigsStore[existingIdx] = config;
  } else {
    fallbackSavedReportConfigsStore.unshift(config);
  }
  return config;
}

export function deleteFallbackReportConfig(id: string): boolean {
  const idx = fallbackSavedReportConfigsStore.findIndex(c => c.id === id);
  if (idx === -1) return false;
  fallbackSavedReportConfigsStore.splice(idx, 1);
  return true;
}

// =========================================================================
// LIVE-STORE MANAGEMENT REPORT FALLBACKS (PARITY WHEN POSTGRES IS UNSET)
// =========================================================================

function withinDateRange(dateStr: string | undefined, startDate?: string, endDate?: string): boolean {
  if (!dateStr) return true;
  const ts = new Date(dateStr).getTime();
  if (Number.isNaN(ts)) return true;
  if (startDate && ts < new Date(startDate).getTime()) return false;
  if (endDate && ts > new Date(`${endDate}T23:59:59.999Z`).getTime()) return false;
  return true;
}

function makeFallbackMeta(title: string, count: number, filters?: ReportFilterParams) {
  const applied: Record<string, string> = {};
  if (filters?.startDate) applied['از تاریخ'] = filters.startDate;
  if (filters?.endDate) applied['تا تاریخ'] = filters.endDate;
  if (filters?.partId) applied['شناسه قطعه'] = filters.partId;
  if (filters?.customerName) applied['مشتری'] = filters.customerName;
  if (filters?.machineId) applied['ماشین'] = filters.machineId;
  if (filters?.processType) applied['فرایند'] = filters.processType;
  if (filters?.status) applied['وضعیت'] = filters.status;
  return {
    reportTitle: title,
    generatedAt: new Date().toISOString(),
    generatedBy: 'سیستم برنامه‌ریزی و کنترل تولید',
    appliedFilters: applied,
    totalRecordsCount: count,
  };
}

export function getFallbackPlanVsActual(filters?: ReportFilterParams) {
  const base = getPlanVsActualReport(filters);
  const proposalRows = fallbackPlanProposalsStore.flatMap(prop =>
    (prop.lines || [])
      .filter((l: any) => {
        const linePartCode = l.partCode || l.part?.partNumber || '';
        return !filters?.partId || l.partId === filters.partId || linePartCode === filters.partId;
      })
      .map((l: any) => {
        const partCode = l.partCode || l.part?.partNumber || '';
        const partName = l.partName || l.part?.name || '';
        const relatedMos = manufacturingOrdersStore.filter(
          m => m.partCode === partCode || m.partId === l.partId || (l.moId && m.id === l.moId),
        );
        const actualProducedQuantity = relatedMos.reduce((acc, m) => acc + (m.completedQuantity || 0), 0);
        const actualScrapQuantity = relatedMos.reduce((acc, m) => acc + (m.totalScrapQuantity || 0), 0);
        const plannedQuantity = Number(l.plannedQty ?? l.plannedQuantity ?? 0) || 1;
        return {
          planId: prop.id,
          planNumber: `${prop.proposalNumber} (v${prop.version})`,
          planVersion: String(prop.version),
          partId: l.partId,
          partCode,
          partName,
          plannedQuantity,
          actualProducedQuantity,
          actualScrapQuantity,
          achievementRatePercent: Math.round((actualProducedQuantity / plannedQuantity) * 1000) / 10,
          varianceQuantity: actualProducedQuantity - plannedQuantity,
          status: prop.status,
          targetDueDate: l.plannedEndDate || l.dueDate || prop.generatedAt || prop.createdAt,
          isEstimate: prop.status !== 'RELEASED',
          linkedMoNumbers: relatedMos.map(m => m.moNumber),
        };
      }),
  );
  const seen = new Set(proposalRows.map(r => `${r.planId}:${r.partCode}`));
  const merged = [...proposalRows, ...base.data.filter(r => !seen.has(`${r.planId}:${r.partCode}`))];
  return {
    meta: makeFallbackMeta(base.meta.reportTitle, merged.length, filters),
    data: merged,
  };
}

export function getFallbackProductionBacklog(
  filters: ReportFilterParams,
  stores: {
    parts: Part[];
    inventoryDocs: InventoryDocument[];
    reservations: InventoryReservation[];
    qcHolds?: Record<string, any>;
  },
) {
  const fulfillment = getCustomerOrderFulfillmentReport(filters).data;
  const { balances: rawBalances } = calculateDetailedStockBalances(stores.inventoryDocs, stores.reservations, stores.parts);
  const balances = applyQcHoldsToBalances(rawBalances, stores.qcHolds);
  const availableRawKgByGrade = new Map<string, number>();
  for (const b of balances) {
    if (b.category !== 'RAW_MATERIAL') continue;
    const p = stores.parts.find(x => x.id === b.partId || x.code === b.partCode);
    const grade = p?.materialGrade || 'ST14';
    availableRawKgByGrade.set(grade, (availableRawKgByGrade.get(grade) || 0) + (b.availableKg || 0));
  }

  const data = fulfillment
    .filter(item => item.remainingQuantity > 0)
    .map(item => {
      const part = stores.parts.find(p => p.id === item.partId || p.code === item.partCode);
      const weightPerUnit = part?.weightPerUnitKg || 1.2;
      const requiredRawMaterialKg = Math.round(item.remainingQuantity * weightPerUnit * 1.05 * 10) / 10;
      const availKg = availableRawKgByGrade.get(part?.materialGrade || 'ST14') || 0;
      const materialAvailabilityStatus: 'AVAILABLE' | 'PARTIAL' | 'SHORTAGE' =
        availKg >= requiredRawMaterialKg ? 'AVAILABLE' : availKg > 0 ? 'PARTIAL' : 'SHORTAGE';

      let urgencyLevel: 'CRITICAL' | 'HIGH' | 'MEDIUM' = 'MEDIUM';
      if (item.daysOverdue > 5) urgencyLevel = 'CRITICAL';
      else if (item.daysOverdue > 0 || item.remainingQuantity > 1000) urgencyLevel = 'HIGH';

      return {
        orderNumber: item.orderNumber,
        customerName: item.customerName,
        contractNumber: item.contractNumber,
        partId: item.partId,
        partCode: item.partCode,
        partName: item.partName,
        carModel: part?.carModel,
        backlogQuantity: item.remainingQuantity,
        dueDate: item.dueDate,
        daysOverdue: item.daysOverdue,
        urgencyLevel,
        requiredRawMaterialKg,
        materialAvailabilityStatus,
        availableRawMaterialKg: Math.round(availKg * 10) / 10,
      };
    })
    .sort((a, b) => b.daysOverdue - a.daysOverdue);

  return {
    meta: makeFallbackMeta('گزارش تعهدات معوق و سفارشات عقب‌افتاده تولید (Backlog)', data.length, filters),
    data,
  };
}

export function getFallbackMaterialConsumptionActual(
  filters: ReportFilterParams,
  stores: { parts: Part[]; inventoryDocs: InventoryDocument[]; physicalCoils: PhysicalCoil[] },
) {
  const issueDocs = stores.inventoryDocs.filter(
    d =>
      d.postingStatus === 'POSTED' &&
      (d.documentType === 'ISSUE_RAW_MATERIAL' || d.documentType === 'TRANSFER') &&
      withinDateRange(d.documentDate, filters.startDate, filters.endDate),
  );

  const grouped = new Map<string, any>();

  for (const doc of issueDocs) {
    const mo =
      manufacturingOrdersStore.find(m => m.moNumber === doc.referenceNumber || m.id === doc.referenceNumber) ||
      manufacturingOrdersStore[0];
    if (!mo) continue;
    if (filters.partId && mo.partId !== filters.partId && mo.partCode !== filters.partId) continue;

    const firstOp = mo.operations[0];
    if (!firstOp) continue;
    if (filters.processType && firstOp.processType !== filters.processType) continue;
    if (filters.machineId && firstOp.machineId !== filters.machineId) continue;

    for (const line of doc.lines) {
      const part = stores.parts.find(p => p.id === line.partId || p.code === line.partCode);
      const coil = stores.physicalCoils.find(c => c.coilId === line.lotNumber || c.heatNumber === line.heatNumber);
      const key = `${mo.id}|${firstOp.id}|${line.partCode}`;

      if (!grouped.has(key)) {
        const opLogs = productionLogsStore.filter(
          l => l.moId === mo.id || l.operationId === firstOp.id,
        );
        grouped.set(key, {
          moId: mo.id,
          moNumber: mo.moNumber,
          productPartCode: mo.partCode,
          productPartName: mo.partName,
          operationId: firstOp.id,
          operationStep: firstOp.stepNumber,
          operationCode: firstOp.stepCode,
          operationName: firstOp.stepName,
          processType: firstOp.processType,
          materialCode: line.partCode,
          materialName: line.partName,
          materialGrade: part?.materialGrade || coil?.materialGrade || 'ST14',
          actualIssuedMaterialKg: 0,
          actualProducedGoodQty: firstOp.goodOutputQty || mo.completedQuantity || 0,
          actualScrapQty: firstOp.scrapQty || mo.totalScrapQuantity || 0,
          actualScrapWeightKg: Math.round((firstOp.scrapQty || 0) * (part?.weightPerUnitKg || 1.0) * 100) / 100,
          actualMachineNames: firstOp.machineName ? [firstOp.machineName] : [],
          actualOperatorNames: Array.from(
            new Set(opLogs.map(l => l.operatorName).filter((x): x is string => Boolean(x))),
          ),
          coilNumbers: [],
          contractNumbers: [],
          productionReportCount: opLogs.length || (firstOp.goodOutputQty > 0 ? 1 : 0),
          lastProductionReportAt: firstOp.lastActivityAt || doc.documentDate,
        });
      }

      const row = grouped.get(key);
      const weightKg = line.quantityKg ?? (line.unit === 'KG' ? line.quantity : line.quantity * (part?.weightPerUnitKg || 1.0));
      row.actualIssuedMaterialKg = Math.round((row.actualIssuedMaterialKg + weightKg) * 100) / 100;
      if (line.lotNumber && !row.coilNumbers.includes(line.lotNumber)) row.coilNumbers.push(line.lotNumber);
      if (doc.contractNumber && !row.contractNumbers.includes(doc.contractNumber)) {
        row.contractNumbers.push(doc.contractNumber);
      }
    }
  }

  const data = [...grouped.values()];
  return {
    meta: makeFallbackMeta('گزارش مصرف واقعی مواد به تفکیک دستور ساخت، عملیات و عملکرد واقعی خط', data.length, filters),
    summary: {
      inventoryIssueTransactions: issueDocs.length,
      productionReports: productionLogsStore.length,
      reportRows: data.length,
    },
    data,
  };
}

export function getFallbackSapcoMaterialAccount(
  filters: ReportFilterParams,
  stores: {
    contracts: SapcoContract[];
    parts: Part[];
    inventoryDocs: InventoryDocument[];
    reservations: InventoryReservation[];
    qcHolds?: Record<string, any>;
  },
) {
  const { balances: rawBalances } = calculateDetailedStockBalances(stores.inventoryDocs, stores.reservations, stores.parts);
  const balances = applyQcHoldsToBalances(rawBalances, stores.qcHolds);
  const totalRawSupplierKg = balances
    .filter(b => b.category === 'RAW_MATERIAL')
    .reduce((acc, b) => acc + (b.supplierOwnedKg || 0), 0);

  const data = stores.contracts
    .filter(c => {
      if (filters.status && filters.status !== 'ALL' && c.status !== filters.status) return false;
      if (filters.partId && c.materialGrade !== filters.partId && !c.contractNumber.includes(filters.partId)) return false;
      return true;
    })
    .map(c => {
      const gradeSupplierKg = balances
        .filter(b => b.category === 'RAW_MATERIAL' && (!c.materialGrade || b.materialGrade === c.materialGrade))
        .reduce((acc, b) => acc + (b.supplierOwnedKg || 0), 0);
      const physicalStockInPlantKg = gradeSupplierKg > 0 ? gradeSupplierKg : totalRawSupplierKg || c.closingBalanceKg;
      const discrepancyKg = Math.round((physicalStockInPlantKg - c.closingBalanceKg) * 10) / 10;
      return {
        contractId: c.id,
        contractNumber: c.contractNumber,
        title: c.title,
        materialGrade: c.materialGrade,
        allocatedQuotaKg: c.allocatedWeightKg,
        openingBalanceKg: c.openingBalanceKg,
        totalReceivedKg: c.totalReceivedKg || 0,
        totalIssuedKg: c.totalConsumedKg || 0,
        closingBookBalanceKg: c.closingBalanceKg,
        physicalStockInPlantKg,
        discrepancyKg,
        status: c.status,
      };
    });

  return {
    meta: makeFallbackMeta('گزارش بیلان و حساب امانی کلاف‌های ورق ساپکو', data.length, filters),
    data,
  };
}

export function getFallbackInventoryValuationQuantities(
  filters: ReportFilterParams,
  stores: {
    parts: Part[];
    inventoryDocs: InventoryDocument[];
    reservations: InventoryReservation[];
    qcHolds?: Record<string, any>;
  },
) {
  const { balances: rawBalances } = calculateDetailedStockBalances(stores.inventoryDocs, stores.reservations, stores.parts);
  const balances = applyQcHoldsToBalances(rawBalances, stores.qcHolds);
  const data = balances
    .filter(b => !filters.partId || b.partId === filters.partId || b.partCode === filters.partId)
    .map(b => {
      let category: 'FINISHED_GOODS' | 'RAW_SHEET_METAL' | 'WIP_PARTS' | 'QUALITY_BLOCKED' = 'FINISHED_GOODS';
      if (b.category === 'RAW_MATERIAL') category = 'RAW_SHEET_METAL';
      else if (b.category === 'WIP_PART') category = 'WIP_PARTS';
      if (b.qualityBlockedQty > 0 && b.availableQty === 0) category = 'QUALITY_BLOCKED';
      return {
        category,
        partOrMaterialCode: b.partCode,
        description: b.partName,
        unit: b.unit,
        physicalQuantity: b.physicalQty,
        companyOwnedQuantity: b.ownedQty,
        sapcoConsignmentQuantity: b.supplierOwnedQty,
        qualityBlockedQuantity: b.qualityBlockedQty,
        reservedQuantity: b.reservedQty,
        availableFreeQuantity: b.availableQty,
        totalPhysicalWeightKg: b.physicalKg,
      };
    });

  return {
    meta: makeFallbackMeta('گزارش تفکیک مقداری موجودی بر اساس مالکیت و وضعیت کیفی', data.length, filters),
    data,
  };
}

export function getFallbackMachineWorkloadCapacity(
  filters: ReportFilterParams,
  stores: { machines: Machine[] },
) {
  const data = stores.machines
    .filter(m => {
      if (filters.machineId && m.id !== filters.machineId && m.code !== filters.machineId) return false;
      if (filters.processType && m.processType !== filters.processType) return false;
      return true;
    })
    .map(m => {
      const isDown = m.status === 'MAINTENANCE';
      const nominalDailyCapacityHours = isDown ? 0 : 15;
      const scheduledWorkloadHours = isDown ? 0 : machineWorkloadHoursMap[m.id] || 4.5;
      const availableCapacityHours = Math.max(0, nominalDailyCapacityHours - scheduledWorkloadHours);
      const utilizationRatePercent =
        nominalDailyCapacityHours > 0 ? Math.round((scheduledWorkloadHours / nominalDailyCapacityHours) * 1000) / 10 : 0;
      let workloadCategory: 'OPTIMAL' | 'OVERLOADED' | 'HIGH_LOAD' | 'UNDER_UTILIZED' = 'OPTIMAL';
      if (utilizationRatePercent > 90) workloadCategory = 'OVERLOADED';
      else if (utilizationRatePercent > 70) workloadCategory = 'HIGH_LOAD';
      else if (utilizationRatePercent < 30) workloadCategory = 'UNDER_UTILIZED';
      return {
        machineId: m.id,
        machineCode: m.code,
        machineName: m.name,
        hall: m.location || 'سالن پرس‌کاری',
        processType: m.processType,
        tonnage: m.tonnage,
        nominalDailyCapacityHours,
        scheduledWorkloadHours,
        availableCapacityHours,
        utilizationRatePercent,
        isReliableCapacityData: !isDown && nominalDailyCapacityHours > 0,
        workloadCategory,
        machineStatus: m.status,
      };
    });

  return {
    meta: makeFallbackMeta('گزارش لود کاری و ظرفیت آزاد ماشین‌آلات پرس و تجهیزات', data.length, filters),
    data,
  };
}

export function getFallbackInventoryMovements(
  filters: ReportFilterParams,
  stores: { inventoryDocs: InventoryDocument[] },
) {
  const data: any[] = [];
  for (const doc of stores.inventoryDocs) {
    if (!withinDateRange(doc.documentDate, filters.startDate, filters.endDate)) continue;
    if (filters.status && filters.status !== 'ALL' && doc.postingStatus !== filters.status) continue;
    doc.lines.forEach((line, idx) => {
      if (filters.partId && line.partId !== filters.partId && line.partCode !== filters.partId) return;
      data.push({
        transactionId: `${doc.id}-LN-${idx + 1}`,
        documentNumber: doc.documentNumber,
        transactionDate: doc.documentDate,
        documentType: doc.documentType,
        partCode: line.partCode,
        partName: line.partName,
        quantity: line.quantity,
        unit: line.unit,
        sourceLocation: doc.warehouseName || doc.warehouseId || 'تأمین‌کننده',
        targetLocation: doc.targetWarehouseName || doc.targetWarehouseId || line.locationCode || 'انبار اصلی',
        ownership: line.ownership === 'SAPCO_SUPPLIER_OWNED' ? 'امانی ساپکو' : 'ملکی کارخانه',
        operatorOrUser: doc.postedByName || doc.createdByName || doc.createdByUid,
        isReversed: doc.postingStatus === 'REVERSED',
      });
    });
  }
  return {
    meta: makeFallbackMeta('گزارش تحلیلی گردش اسناد و کاردکس جابجایی موجودی‌ها', data.length, filters),
    data,
  };
}

export function getFallbackInventoryReconciliation(
  filters: ReportFilterParams,
  stores: { parts: Part[]; inventoryDocs: InventoryDocument[]; reservations: InventoryReservation[] },
) {
  const { balances } = calculateDetailedStockBalances(stores.inventoryDocs, stores.reservations, stores.parts);
  const data = balances
    .filter(b => !filters.partId || b.partId === filters.partId || b.partCode === filters.partId)
    .map(b => ({
      locationCode: b.category === 'FINISHED_GOOD' ? 'WH-FG-01' : b.category === 'WIP_PART' ? 'WH-WIP-01' : 'WH-RAW-01',
      warehouseName:
        b.category === 'FINISHED_GOOD'
          ? 'انبار محصول نهایی'
          : b.category === 'WIP_PART'
            ? 'انبار قطعات نیمه‌ساخته (WIP)'
            : 'انبار ورق و کلاف ساپکو',
      partCode: b.partCode,
      partName: b.partName,
      bookQuantity: b.physicalQty,
      physicalCountQuantity: b.physicalQty,
      varianceQuantity: 0,
      variancePercent: 0,
      reconciliationStatus: 'BALANCED' as const,
      lastReconciledAt: new Date().toISOString(),
      reconciledBy: 'سرپرست انبارداری و انبارگردانی',
    }));
  return {
    meta: makeFallbackMeta('گزارش انبارگردانی و موازنه مغایرت فیزیکی موجودی (Reconciliation)', data.length, filters),
    data,
  };
}

export function getFallbackCoilInventory(
  filters: ReportFilterParams,
  stores: { physicalCoils: PhysicalCoil[]; contracts: SapcoContract[] },
) {
  const defaultContract = stores.contracts[0]?.contractNumber || 'CNT-SAPCO-2026-01';
  const data = stores.physicalCoils
    .filter(c => {
      if (!withinDateRange(c.receiptDate, filters.startDate, filters.endDate)) return false;
      if (filters.partId && c.materialGrade !== filters.partId && c.coilId !== filters.partId) return false;
      const remaining = c.remainingWeightKg ?? 0;
      const status =
        ['QUARANTINE', 'QUALITY_BLOCKED', 'REJECTED', 'SCRAP', 'BLOCKED'].includes(c.qualityStatus) ||
        c.physicalStatus === 'BLOCKED'
          ? 'BLOCKED'
          : remaining <= 0
            ? 'CONSUMED'
            : remaining < c.originalWeightKg
              ? 'PARTIAL'
              : 'FULL';
      if (filters.status && filters.status !== 'ALL' && status !== filters.status) return false;
      return true;
    })
    .map(c => {
      const remainingWeightKg = c.remainingWeightKg ?? 0;
      const consumedWeightKg = Math.max(0, c.originalWeightKg - remainingWeightKg);
      const status: 'FULL' | 'PARTIAL' | 'CONSUMED' | 'BLOCKED' =
        ['QUARANTINE', 'QUALITY_BLOCKED', 'REJECTED', 'SCRAP', 'BLOCKED'].includes(c.qualityStatus) ||
        c.physicalStatus === 'BLOCKED'
          ? 'BLOCKED'
          : remainingWeightKg <= 0
            ? 'CONSUMED'
            : remainingWeightKg < c.originalWeightKg
              ? 'PARTIAL'
              : 'FULL';
      return {
        coilId: c.id,
        coilNumber: c.coilId,
        materialCode: `MAT-${c.materialGrade}-${c.thicknessMm}`,
        materialGrade: c.materialGrade,
        thicknessMm: c.thicknessMm,
        widthMm: c.widthMm,
        receivedWeightKg: c.originalWeightKg,
        consumedWeightKg,
        remainingWeightKg,
        warehouseLocation: `${c.warehouseName || 'انبار رول خام'} / ${c.warehouseLocationCode || 'R-01'}`,
        ownership: c.ownership === 'COMPANY_OWNED' ? 'FACTORY_OWNED' : 'SAPCO_CONSIGNMENT',
        contractNumber: c.allocations?.[0]?.contractNumber || defaultContract,
        heatNumber: c.heatNumber || '—',
        packingNumber: c.coilPackNumber || `PKG-${c.coilId}`,
        status,
        receiptDate: c.receiptDate,
      };
    });

  return {
    meta: makeFallbackMeta('موجودی رول‌ها و کویل‌های ماده اولیه', data.length, filters),
    data,
  };
}

export function getFallbackLotConsumption(
  filters: ReportFilterParams,
  stores: {
    coilIssueRecords: CoilIssueReturnRecord[];
    inventoryDocs: InventoryDocument[];
    physicalCoils: PhysicalCoil[];
    parts: Part[];
  },
) {
  const fromRecords = stores.coilIssueRecords
    .filter(r => withinDateRange(r.issuedAt, filters.startDate, filters.endDate))
    .map(r => {
      const coil = stores.physicalCoils.find(c => c.id === r.coilId || c.coilId === r.coilId);
      const mo = manufacturingOrdersStore.find(m => m.id === r.manufacturingOrderId || m.moNumber === r.manufacturingOrderId);
      const consumed = r.consumedWeightKg || r.issuedWeightKg || 0;
      const scrapKg = r.scrappedKg ?? Math.round(consumed * 0.035 * 10) / 10;
      const part = stores.parts.find(p => p.code === (mo?.partCode || coil?.partCode));
      return {
        issueDocumentNumber: r.documentNumber || r.id,
        issueDate: r.issuedAt,
        coilNumber: coil?.coilId || r.coilId,
        heatNumber: coil?.heatNumber || '—',
        materialGrade: coil?.materialGrade || 'ST14',
        thicknessMm: coil?.thicknessMm || 1.5,
        consumedKg: consumed,
        destinationMachine: mo?.operations?.[0]?.machineName || 'خط پرس',
        targetMoNumber: mo?.moNumber || r.manufacturingOrderId || '—',
        targetPartCode: mo?.partCode || coil?.partCode || '—',
        targetPartName: mo?.partName || part?.name || '—',
        piecesProduced: part?.weightPerUnitKg ? Math.round(consumed / part.weightPerUnitKg) : 0,
        scrapKg,
        scrapPercent: consumed > 0 ? Math.round((scrapKg / consumed) * 1000) / 10 : 0,
        operatorName: 'اپراتور تولید',
      };
    });

  const issueDocs = stores.inventoryDocs.filter(
    d =>
      (d.documentType === 'ISSUE_RAW_MATERIAL' || d.documentType === 'TRANSFER') &&
      withinDateRange(d.documentDate, filters.startDate, filters.endDate),
  );
  const docRows: any[] = [];
  for (const doc of issueDocs) {
    if (fromRecords.some(r => r.issueDocumentNumber === doc.documentNumber)) continue;
    const matchedMo = manufacturingOrdersStore.find(m => m.moNumber === doc.referenceNumber) || manufacturingOrdersStore[0];
    for (const line of doc.lines) {
      const coil = stores.physicalCoils.find(c => c.coilId === line.lotNumber || c.heatNumber === line.heatNumber);
      const part = stores.parts.find(p => p.code === (matchedMo?.partCode || line.partCode));
      const consumedKg = line.quantityKg || line.quantity;
      const scrapKg = Math.round(consumedKg * 0.03 * 10) / 10;
      docRows.push({
        issueDocumentNumber: doc.documentNumber,
        issueDate: doc.documentDate,
        coilNumber: line.lotNumber || 'LOT-RAW-01',
        heatNumber: line.heatNumber || coil?.heatNumber || '—',
        materialGrade: part?.materialGrade || coil?.materialGrade || 'ST14',
        thicknessMm: coil?.thicknessMm || 1.5,
        consumedKg,
        destinationMachine: doc.targetWarehouseName || 'خط تولید پرس',
        targetMoNumber: doc.referenceNumber || matchedMo?.moNumber || '—',
        targetPartCode: matchedMo?.partCode || line.partCode,
        targetPartName: matchedMo?.partName || line.partName,
        piecesProduced: part?.weightPerUnitKg ? Math.round(consumedKg / part.weightPerUnitKg) : 0,
        scrapKg,
        scrapPercent: 3.0,
        operatorName: doc.createdByName || 'اپراتور شیفت',
      });
    }
  }

  const data = [...fromRecords, ...docRows].filter(
    r => !filters.partId || r.targetPartCode === filters.partId || r.targetMoNumber === filters.partId,
  );
  return {
    meta: makeFallbackMeta('ردیابی مصرف رول/لوت پای پرس‌ها', data.length, filters),
    data,
  };
}

export function getFallbackSupplierMatrix(
  filters: ReportFilterParams,
  stores: { physicalCoils: PhysicalCoil[] },
) {
  const groupMap = new Map<
    string,
    {
      grade: string;
      thicknessMm: number;
      financialReceivedKg: number;
      consignmentReceivedKg: number;
      totalConsumptionKg: number;
      closingBalanceKg: number;
      count: number;
    }
  >();

  for (const c of stores.physicalCoils) {
    if (filters.partId && c.materialGrade !== filters.partId) continue;
    const key = `${c.materialGrade}_${c.thicknessMm}`;
    const existing = groupMap.get(key) || {
      grade: c.materialGrade,
      thicknessMm: c.thicknessMm,
      financialReceivedKg: 0,
      consignmentReceivedKg: 0,
      totalConsumptionKg: 0,
      closingBalanceKg: 0,
      count: 0,
    };
    if (c.ownership === 'COMPANY_OWNED') existing.financialReceivedKg += c.originalWeightKg;
    else existing.consignmentReceivedKg += c.originalWeightKg;

    const remaining = c.remainingWeightKg ?? 0;
    const consumed = Math.max(0, c.originalWeightKg - remaining);
    existing.totalConsumptionKg += consumed;
    existing.closingBalanceKg += remaining;
    existing.count += 1;
    groupMap.set(key, existing);
  }

  const data = Array.from(groupMap.values()).map(g => ({
    grade: g.grade,
    thicknessMm: g.thicknessMm,
    openingBalanceKg: 0,
    financialReceivedKg: Math.round(g.financialReceivedKg * 100) / 100,
    consignmentReceivedKg: Math.round(g.consignmentReceivedKg * 100) / 100,
    totalConsumptionKg: Math.round(g.totalConsumptionKg * 100) / 100,
    otherMovementKg: 0,
    closingBalanceKg: Math.round(g.closingBalanceKg * 100) / 100,
    totalCoilsCount: g.count,
    status: 'BALANCED' as const,
  }));

  return {
    meta: makeFallbackMeta('ماتریس حساب مواد تأمین‌کننده (گرید × ضخامت)', data.length, filters),
    data,
  };
}

export function getFallbackDashboardSummary(
  filters: ReportFilterParams,
  stores: {
    parts: Part[];
    machines: Machine[];
    inventoryDocs: InventoryDocument[];
    reservations: InventoryReservation[];
    routings?: Routing[];
    qcHolds?: Record<string, any>;
  },
) {
  const { balances: rawBalances } = calculateDetailedStockBalances(stores.inventoryDocs, stores.reservations, stores.parts);
  const balances = applyQcHoldsToBalances(rawBalances, stores.qcHolds);
  const activeOrders = customerOrdersStore.filter(o => o.status === 'OPEN' || o.status === 'PARTIALLY_FULFILLED');
  const totalGrossDemandPieces = activeOrders.reduce(
    (acc, o) => acc + o.lines.reduce((lAcc, l) => lAcc + l.remainingQuantity, 0),
    0,
  );
  const totalPlannedProductionPieces =
    fallbackPlanProposalsStore.length > 0
      ? (fallbackPlanProposalsStore[0].lines || []).reduce(
          (acc: number, l: any) => acc + Number(l.plannedQty ?? l.plannedQuantity ?? 0),
          0,
        )
      : planSuggestionsStore.reduce((acc, p) => acc + p.proposedQuantity, 0);
  const totalActualProducedPieces = manufacturingOrdersStore.reduce((acc, m) => acc + (m.completedQuantity || 0), 0);
  const overallPlanAchievementRatePercent =
    totalPlannedProductionPieces > 0
      ? Math.round((totalActualProducedPieces / totalPlannedProductionPieces) * 1000) / 10
      : 0;
  const delaysReport = getProductionDelaysReport(filters).data;
  const totalWipQuantityPieces = manufacturingOrdersStore.reduce(
    (acc, mo) =>
      acc +
      mo.operations.reduce(
        (oAcc, op) => oAcc + (op.waitingInputQty || 0) + (op.inProgressQty || 0) + (op.readyForTransferQty || 0),
        0,
      ),
    0,
  );
  const fgBalances = balances.filter(b => b.category === 'FINISHED_GOOD');
  const totalFinishedGoodsStockPieces = fgBalances.reduce(
    (acc, b) => acc + (b.unit === 'PCS' ? b.availableQty : 0),
    0,
  );
  const totalScrapPieces = manufacturingOrdersStore.reduce((acc, m) => acc + (m.totalScrapQuantity || 0), 0);
  const totalScrapWeightKg =
    Math.round(
      manufacturingOrdersStore.reduce((acc, m) => {
        const part = stores.parts.find(p => p.id === m.partId || p.code === m.partCode);
        return acc + (m.totalScrapQuantity || 0) * (part?.weightPerUnitKg || 1.0);
      }, 0) * 10,
    ) / 10;
  const machineReport = getFallbackMachineWorkloadCapacity(filters, { machines: stores.machines }).data;
  const reliableMachines = machineReport.filter(m => m.isReliableCapacityData);
  const averageMachineUtilizationPercent =
    reliableMachines.length > 0
      ? Math.round((reliableMachines.reduce((acc, m) => acc + m.utilizationRatePercent, 0) / reliableMachines.length) * 10) / 10
      : 0;
  const stagnantWipItemsCount = getWipAgingReport(filters).data.filter(
    i => i.statusSeverity === 'CRITICAL' || i.statusSeverity === 'ATTENTION',
  ).length;
  const netReqs = calculateNetRequirements({
    parts: stores.parts,
    orders: customerOrdersStore,
    balances,
    reservations: stores.reservations,
    activeMos: manufacturingOrdersStore,
    routings: stores.routings,
    qcHolds: stores.qcHolds,
  });
  const totalMaterialShortageKg = Math.round(
    netReqs.reduce((acc, r) => acc + (r.materialShortageKg || 0), 0) * 10,
  ) / 10;

  return {
    activeCustomerOrdersCount: activeOrders.length,
    totalGrossDemandPieces,
    totalPlannedProductionPieces,
    totalActualProducedPieces,
    overallPlanAchievementRatePercent,
    totalDelayedOrdersCount: delaysReport.length,
    totalMaterialShortageKg,
    totalWipQuantityPieces,
    totalFinishedGoodsStockPieces,
    totalScrapPieces,
    totalScrapWeightKg,
    averageMachineUtilizationPercent,
    reliableMachinesCount: reliableMachines.length,
    activeManufacturingOrdersCount: manufacturingOrdersStore.length,
    stagnantWipItemsCount,
    lastUpdatedTimestamp: new Date().toISOString(),
  };
}

export function cascadePartUpdateInFallbackProposals(params: {
  partId: string;
  newCode: string;
  newName: string;
  oldCode?: string;
}): number {
  const { partId, newCode, newName, oldCode } = params;
  const oldUpper = oldCode ? oldCode.trim().toUpperCase() : '';
  const newUpper = newCode.trim().toUpperCase();
  let updated = 0;

  for (const prop of fallbackPlanProposalsStore) {
    for (const line of prop.lines || []) {
      const codeUpper = String(line.partCode || line.part?.partNumber || '').trim().toUpperCase();
      const matches =
        line.partId === partId ||
        (oldUpper !== '' && codeUpper === oldUpper) ||
        codeUpper === newUpper;
      if (matches) {
        line.partId = partId;
        line.partCode = newCode;
        line.partName = newName;
        if (line.part && typeof line.part === 'object') {
          line.part.partNumber = newCode;
          line.part.name = newName;
        }
        updated++;
      }
    }
  }
  return updated;
}

export function reconcileFallbackProposalsWithParts(parts: Part[]): number {
  let changes = 0;
  const byId = new Map(parts.map(p => [p.id, p]));
  const byCode = new Map(parts.map(p => [String(p.code || '').trim().toUpperCase(), p]));

  for (const prop of fallbackPlanProposalsStore) {
    for (const line of prop.lines || []) {
      const part =
        byId.get(line.partId) ||
        byCode.get(String(line.partCode || line.part?.partNumber || '').trim().toUpperCase());
      if (
        part &&
        (line.partCode !== part.code ||
          line.partName !== part.name ||
          line.part?.partNumber !== part.code ||
          line.part?.name !== part.name)
      ) {
        line.partId = part.id;
        line.partCode = part.code;
        line.partName = part.name;
        if (line.part && typeof line.part === 'object') {
          line.part.partNumber = part.code;
          line.part.name = part.name;
        }
        changes++;
      }
    }
  }
  return changes;
}

const FALLBACK_SHIFTS = [
  { id: 'SHIFT-MORN', code: 'SHIFT-MORN', name: 'شیفت صبح', startTime: '07:00', endTime: '15:00', productiveHours: 7.5 },
  { id: 'SHIFT-EVE', code: 'SHIFT-EVE', name: 'شیفت عصر', startTime: '15:00', endTime: '23:00', productiveHours: 7.5 },
];

const fallbackMachineAssignmentsStore: Array<{
  id: string;
  productionOperationId: string;
  machineId: string;
  shiftId: string;
  assignedDate: string;
  status: 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  notes?: string | null;
  createdAt: string;
}> = [];

export function getFallbackMachineCapacity(
  machines: Machine[],
  filters?: { date?: string; hall?: string; machineId?: string; onlyConflicts?: boolean },
  dies = INITIAL_DIES_MOLDS,
) {
  const dailyCapacityHours = FALLBACK_SHIFTS.reduce((s, sh) => s + sh.productiveHours, 0);
  const shiftMap = new Map(FALLBACK_SHIFTS.map(s => [s.id, s]));
  const machineMap = new Map(machines.map(m => [m.id, m]));
  const dieMap = new Map(dies.map(d => [d.id, d]));

  const opLookup = new Map<string, { mo: any; op: any }>();
  for (const mo of manufacturingOrdersStore) {
    for (const op of mo.operations || []) {
      opLookup.set(op.id, { mo, op });
    }
  }

  const activeAssignedOpIds = new Set<string>();
  const unifiedSlots: any[] = [];

  for (const a of fallbackMachineAssignmentsStore) {
    if (a.status === 'CANCELLED') continue;
    if (a.status === 'SCHEDULED' || a.status === 'ACTIVE') {
      activeAssignedOpIds.add(a.productionOperationId);
    }
    const found = opLookup.get(a.productionOperationId);
    const m = machineMap.get(a.machineId);
    const sh = shiftMap.get(a.shiftId) || FALLBACK_SHIFTS[0];
    const mo = found?.mo;
    const op = found?.op;
    const die = op?.dieMoldId ? dieMap.get(op.dieMoldId) : undefined;
    const setupMin = Number(op?.setupTimeMin ?? 20);
    const cycleSec = Number(op?.standardCycleTimeSec ?? 12);
    const plannedQty = Number(op?.plannedQuantity || mo?.targetQuantity || 0);
    const estHours = Math.max(0.5, Math.round((setupMin / 60 + (plannedQty * cycleSec) / 3600) * 100) / 100);

    unifiedSlots.push({
      id: a.id,
      sourceType: 'MACHINE_ASSIGNMENT',
      productionOperationId: a.productionOperationId,
      moId: mo?.id || null,
      moNumber: mo?.moNumber || '—',
      partId: mo?.partId || null,
      partCode: mo?.partCode || '—',
      partName: mo?.partName || '—',
      thicknessMm: null,
      stepNumber: op?.stepNumber || 10,
      stepCode: op?.stepCode || 'OP10',
      stepName: op?.stepName || 'عملیات تولید',
      operationId: op?.stepCode || null,
      processType: op?.processType || null,
      machineId: a.machineId,
      machineCode: m?.code || a.machineId,
      machineName: m?.name || a.machineId,
      hallLocation: m?.location || 'سالن تولید',
      tonnageCapacity: m?.tonnage ?? null,
      shiftId: sh.id,
      shiftCode: sh.code,
      shiftName: sh.name,
      shiftStartTime: sh.startTime,
      shiftEndTime: sh.endTime,
      shiftProductiveHours: sh.productiveHours,
      assignedDate: a.assignedDate,
      plannedQty,
      estimatedHours: estHours,
      setupTimeMin: setupMin,
      dieId: die?.id || op?.dieMoldId || null,
      dieCode: die?.code || null,
      dieName: die?.name || null,
      requiredTonnage: Number(die?.requiredTonnage || op?.requiredTonnage || 0),
      status: a.status,
      assignedOperator: null,
      notes: a.notes || null,
      hasConflict: false,
      conflictReasons: [] as string[],
    });
  }

  for (const mo of manufacturingOrdersStore) {
    if (['COMPLETED', 'CLOSED', 'CANCELLED'].includes(mo.status)) continue;
    for (const op of mo.operations || []) {
      if (!op.machineId || activeAssignedOpIds.has(op.id) || op.status === 'COMPLETED') continue;
      const m = machineMap.get(op.machineId);
      const die = op.dieMoldId ? dieMap.get(op.dieMoldId) : undefined;
      const opExtra = op as any;
      const setupMin = Number(opExtra.setupTimeMin ?? 20);
      const cycleSec = Number(op.standardCycleTimeSec ?? 12);
      const plannedQty = Number(opExtra.plannedQuantity || mo.targetQuantity || 0);
      const estHours = Math.max(0.5, Math.round((setupMin / 60 + (plannedQty * cycleSec) / 3600) * 100) / 100);
      const sh = FALLBACK_SHIFTS[0];
      unifiedSlots.push({
        id: `OP:${op.id}`,
        sourceType: 'OPERATION_SCHEDULE',
        productionOperationId: op.id,
        moId: mo.id,
        moNumber: mo.moNumber,
        partId: mo.partId,
        partCode: mo.partCode,
        partName: mo.partName,
        thicknessMm: null,
        stepNumber: op.stepNumber,
        stepCode: op.stepCode,
        stepName: op.stepName,
        operationId: op.stepCode,
        processType: op.processType,
        machineId: op.machineId,
        machineCode: m?.code || op.machineId,
        machineName: m?.name || op.machineName || op.machineId,
        hallLocation: m?.location || 'سالن تولید',
        tonnageCapacity: m?.tonnage ?? null,
        shiftId: sh.id,
        shiftCode: sh.code,
        shiftName: `${sh.name} (پیش‌فرض عملیات)`,
        shiftStartTime: sh.startTime,
        shiftEndTime: sh.endTime,
        shiftProductiveHours: sh.productiveHours,
        assignedDate: (mo.dueDate || new Date().toISOString()).slice(0, 10),
        plannedQty,
        estimatedHours: estHours,
        setupTimeMin: setupMin,
        dieId: die?.id || op.dieMoldId || null,
        dieCode: die?.code || null,
        dieName: die?.name || null,
        requiredTonnage: Number(die?.requiredTonnage || opExtra.requiredTonnage || 0),
        status: op.status === 'IN_PROGRESS' ? 'ACTIVE' : 'SCHEDULED',
        assignedOperator: null,
        notes: 'زمان‌بندی عملیات دستور ساخت',
        hasConflict: false,
        conflictReasons: [] as string[],
      });
    }
  }

  // Conflict detection
  const activeSlots = unifiedSlots.filter(s => s.status === 'SCHEDULED' || s.status === 'ACTIVE');
  const bySlot = new Map<string, any[]>();
  const byDay = new Map<string, any[]>();
  for (const s of activeSlots) {
    const sk = `${s.machineId}::${s.assignedDate}::${s.shiftId}`;
    bySlot.set(sk, [...(bySlot.get(sk) || []), s]);
    const dk = `${s.machineId}::${s.assignedDate}`;
    byDay.set(dk, [...(byDay.get(dk) || []), s]);
  }

  const conflicts: any[] = [];
  for (const [, list] of bySlot) {
    if (list.length > 1) {
      const f = list[0];
      const msg = `تداخل همزمان روی ${f.machineCode} در تاریخ ${f.assignedDate} (${f.shiftName}) بین ${list.map(x => `${x.moNumber}/${x.stepCode}`).join(' و ')}`;
      list.forEach(item => {
        item.hasConflict = true;
        item.conflictReasons.push(msg);
      });
      conflicts.push({
        id: `CONF-SLOT-${f.machineId}-${f.assignedDate}-${f.shiftId}`,
        conflictType: 'SHIFT_DOUBLE_BOOKING',
        machineId: f.machineId,
        machineCode: f.machineCode,
        machineName: f.machineName,
        assignedDate: f.assignedDate,
        shiftId: f.shiftId,
        shiftName: f.shiftName,
        totalHours: Math.round(list.reduce((s, x) => s + x.estimatedHours, 0) * 100) / 100,
        capacityHours: f.shiftProductiveHours,
        assignmentIds: list.map(x => x.id),
        moNumbers: list.map(x => x.moNumber),
        message: msg,
      });
    }
  }
  for (const [, list] of byDay) {
    const totalHrs = Math.round(list.reduce((s, x) => s + x.estimatedHours, 0) * 100) / 100;
    if (totalHrs > dailyCapacityHours) {
      const f = list[0];
      const msg = `اضافه‌بار روزانه ${f.machineCode} در ${f.assignedDate}: ${totalHrs} ساعت > ${dailyCapacityHours} ساعت ظرفیت`;
      list.forEach(item => {
        item.hasConflict = true;
        item.conflictReasons.push(msg);
      });
      conflicts.push({
        id: `CONF-CAP-${f.machineId}-${f.assignedDate}`,
        conflictType: 'DAILY_OVER_CAPACITY',
        machineId: f.machineId,
        machineCode: f.machineCode,
        machineName: f.machineName,
        assignedDate: f.assignedDate,
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

  const unassignedOperations = manufacturingOrdersStore
    .filter(mo => !['COMPLETED', 'CLOSED', 'CANCELLED'].includes(mo.status))
    .flatMap(mo =>
      (mo.operations || [])
        .filter(op => op.status !== 'COMPLETED' && !activeAssignedOpIds.has(op.id))
        .map(op => {
          const opExtra = op as any;
          const die = op.dieMoldId ? dieMap.get(op.dieMoldId) : undefined;
          const reqTon = Number(die?.requiredTonnage || opExtra.requiredTonnage || 0);
          const eligibleMachineIds = machines
            .filter(m => {
              if (m.status !== 'ACTIVE') return false;
              const supports = (m.capabilities || []).includes(op.processType) || m.processType === op.processType;
              if (!supports) return false;
              if (reqTon > 0 && Number(m.tonnage || 0) < reqTon) return false;
              if (die?.compatibleMachineCodes?.length && !die.compatibleMachineCodes.includes(m.code)) return false;
              return true;
            })
            .map(m => m.id);
          const opPlannedQty = Number(opExtra.plannedQuantity || mo.targetQuantity || 0);
          const opSetupMin = Number(opExtra.setupTimeMin || 20);
          return {
            productionOperationId: op.id,
            moId: mo.id,
            moNumber: mo.moNumber,
            partCode: mo.partCode,
            partName: mo.partName,
            thicknessMm: null,
            stepNumber: op.stepNumber,
            stepCode: op.stepCode,
            stepName: op.stepName,
            operationId: op.stepCode,
            processType: op.processType,
            plannedMachineId: op.machineId || null,
            plannedQty: opPlannedQty,
            estimatedHours: Math.max(0.5, Math.round((opSetupMin / 60 + (opPlannedQty * (op.standardCycleTimeSec || 12)) / 3600) * 100) / 100),
            setupTimeMin: opSetupMin,
            dieId: die?.id || op.dieMoldId || null,
            dieCode: die?.code || null,
            requiredTonnage: reqTon,
            suggestedDate: (mo.dueDate || new Date().toISOString()).slice(0, 10),
            eligibleMachineIds,
          };
        }),
    );

  const draftProposalPreview = fallbackPlanProposalsStore
    .filter(p => p.status === 'DRAFT' || p.status === 'APPROVED')
    .slice(0, 3)
    .flatMap((prop: any) =>
      (prop.lines || []).flatMap((line: any) =>
        (line.operationAssignments || []).map((oa: any) => ({
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
          assignedDate: oa.plannedStartDate || String(line.plannedStartDate || '').slice(0, 10),
          plannedQty: Number(line.plannedQty || 0),
          estimatedHours: Number(oa.estimatedHours || 1),
          hasCapacityConflict: Boolean(oa.hasCapacityConflict),
        })),
      ),
    );

  let filteredSlots = unifiedSlots;
  if (filters?.date) filteredSlots = filteredSlots.filter(s => s.assignedDate === filters.date);
  if (filters?.hall && filters.hall !== 'ALL') filteredSlots = filteredSlots.filter(s => s.hallLocation === filters.hall);
  if (filters?.machineId && filters.machineId !== 'ALL') filteredSlots = filteredSlots.filter(s => s.machineId === filters.machineId);
  if (filters?.onlyConflicts) filteredSlots = filteredSlots.filter(s => s.hasConflict);

  const activeMachines = machines.filter(m => m.status === 'ACTIVE');
  const machineList = activeMachines.map(m => {
    const booked = Math.round(
      filteredSlots
        .filter(s => s.machineId === m.id && (s.status === 'SCHEDULED' || s.status === 'ACTIVE'))
        .reduce((sum, s) => sum + s.estimatedHours, 0) * 100,
    ) / 100;
    return {
      id: m.id,
      code: m.code,
      name: m.name,
      hallLocation: m.location || 'سالن تولید',
      machineType: m.processType,
      tonnageCapacity: m.tonnage ?? null,
      status: m.status,
      dailyCapacityHours,
      scheduledHours: booked,
      availableCapacityHours: Math.max(0, Math.round((dailyCapacityHours - booked) * 100) / 100),
      utilizationPercent: Math.min(100, Math.round((booked / dailyCapacityHours) * 100)),
      conflictsCount: conflicts.filter(c => c.machineId === m.id).length,
      capabilities: (m.capabilities || []).map(c => ({ operationId: c, operationCode: c, processType: c })),
      compatibleDieIds: dies.filter(d => d.compatibleMachineCodes?.includes(m.code)).map(d => d.id),
    };
  });

  const avgUtil = machineList.length > 0
    ? Math.round((machineList.reduce((s, m) => s + m.utilizationPercent, 0) / machineList.length) * 10) / 10
    : 0;

  return {
    source: 'memory-fallback',
    shifts: FALLBACK_SHIFTS,
    machines: machineList,
    assignments: filteredSlots,
    conflicts,
    unassignedOperations,
    draftProposalPreview,
    summary: {
      totalAssignments: filteredSlots.filter(s => s.status !== 'CANCELLED').length,
      activeMachinesCount: machineList.length,
      conflictsCount: conflicts.length,
      unassignedOperationsCount: unassignedOperations.length,
      averageUtilizationPercent: avgUtil,
      totalDailyShiftHours: dailyCapacityHours,
    },
  };
}

export function createFallbackMachineAssignment(
  payload: {
    productionOperationId: string;
    machineId: string;
    shiftId: string;
    assignedDate: string;
    notes?: string;
    allowConflictOverride?: boolean;
  },
  machines: Machine[],
  dies = INITIAL_DIES_MOLDS,
) {
  if (!payload.productionOperationId || !payload.machineId || !payload.shiftId || !payload.assignedDate) {
    throw Object.assign(new Error('شناسه عملیات، ماشین، شیفت و تاریخ تخصیص الزامی هستند.'), { statusCode: 400 });
  }
  const machine = machines.find(m => m.id === payload.machineId || m.code === payload.machineId);
  if (!machine || machine.status !== 'ACTIVE') {
    throw Object.assign(new Error('ماشین انتخاب‌شده یافت نشد یا فعال نیست.'), { statusCode: 400 });
  }
  const shift = FALLBACK_SHIFTS.find(s => s.id === payload.shiftId);
  if (!shift) {
    throw Object.assign(new Error('شیفت انتخاب‌شده معتبر نیست.'), { statusCode: 400 });
  }
  let targetMo: any = null;
  let targetOp: any = null;
  for (const mo of manufacturingOrdersStore) {
    const found = (mo.operations || []).find(o => o.id === payload.productionOperationId);
    if (found) {
      targetMo = mo;
      targetOp = found;
      break;
    }
  }
  if (!targetOp) {
    throw Object.assign(new Error('عملیات تولید یافت نشد.'), { statusCode: 404 });
  }
  const supports = (machine.capabilities || []).includes(targetOp.processType) || machine.processType === targetOp.processType;
  if (!supports) {
    throw Object.assign(new Error(`ماشین ${machine.code} قابلیت انجام فرآیند ${targetOp.processType} را ندارد.`), { statusCode: 400 });
  }
  const die = targetOp.dieMoldId ? dies.find(d => d.id === targetOp.dieMoldId) : undefined;
  const reqTon = Number(die?.requiredTonnage || targetOp.requiredTonnage || 0);
  if (reqTon > 0 && Number(machine.tonnage || 0) < reqTon) {
    throw Object.assign(new Error(`ظرفیت تناژ ماشین ${machine.code} برای عملیات کافی نیست.`), { statusCode: 400 });
  }
  if (die?.compatibleMachineCodes?.length && !die.compatibleMachineCodes.includes(machine.code)) {
    throw Object.assign(new Error(`قالب ${die.code} با ماشین ${machine.code} سازگار نیست.`), { statusCode: 400 });
  }

  const dateKey = payload.assignedDate.slice(0, 10);
  const sameSlot = fallbackMachineAssignmentsStore.filter(
    a =>
      a.machineId === machine.id &&
      a.shiftId === shift.id &&
      a.assignedDate === dateKey &&
      (a.status === 'SCHEDULED' || a.status === 'ACTIVE'),
  );
  if (sameSlot.length > 0 && !payload.allowConflictOverride) {
    throw Object.assign(
      new Error(`تداخل شیفت روی ${machine.code} در تاریخ ${dateKey} (${shift.name}).`),
      { statusCode: 409, conflicts: [`تداخل در ${dateKey} (${shift.name})`] },
    );
  }

  const record = {
    id: `MCH-ASG-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    productionOperationId: targetOp.id,
    machineId: machine.id,
    shiftId: shift.id,
    assignedDate: dateKey,
    status: 'SCHEDULED' as const,
    notes: payload.notes || null,
    createdAt: new Date().toISOString(),
  };
  fallbackMachineAssignmentsStore.push(record);
  targetOp.machineId = machine.id;
  targetOp.machineName = machine.name;
  return record;
}

export function updateFallbackMachineAssignment(
  id: string,
  payload: {
    machineId?: string;
    shiftId?: string;
    assignedDate?: string;
    status?: 'SCHEDULED' | 'ACTIVE' | 'COMPLETED';
    notes?: string;
    allowConflictOverride?: boolean;
  },
  machines: Machine[],
  dies = INITIAL_DIES_MOLDS,
) {
  const existing = fallbackMachineAssignmentsStore.find(a => a.id === id);
  if (!existing) throw Object.assign(new Error('تخصیص ماشین یافت نشد.'), { statusCode: 404 });
  if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
    throw Object.assign(new Error('تخصیص تکمیل‌شده یا لغوشده قابل ویرایش نیست.'), { statusCode: 409 });
  }
  const nextMachineId = payload.machineId || existing.machineId;
  const nextShiftId = payload.shiftId || existing.shiftId;
  const nextDate = (payload.assignedDate || existing.assignedDate).slice(0, 10);
  const machine = machines.find(m => m.id === nextMachineId || m.code === nextMachineId);
  if (!machine || machine.status !== 'ACTIVE') {
    throw Object.assign(new Error('ماشین انتخاب‌شده فعال نیست.'), { statusCode: 400 });
  }
  if (!FALLBACK_SHIFTS.some(s => s.id === nextShiftId)) {
    throw Object.assign(new Error('شیفت انتخاب‌شده معتبر نیست.'), { statusCode: 400 });
  }

  for (const mo of manufacturingOrdersStore) {
    const op = (mo.operations || []).find(o => o.id === existing.productionOperationId);
    if (op) {
      const supports = (machine.capabilities || []).includes(op.processType) || machine.processType === op.processType;
      if (!supports) {
        throw Object.assign(new Error(`ماشین ${machine.code} قابلیت انجام فرآیند ${op.processType} را ندارد.`), { statusCode: 400 });
      }
      const die = op.dieMoldId ? dies.find(d => d.id === op.dieMoldId) : undefined;
      if (die?.compatibleMachineCodes?.length && !die.compatibleMachineCodes.includes(machine.code)) {
        throw Object.assign(new Error(`قالب ${die.code} با ماشین ${machine.code} سازگار نیست.`), { statusCode: 400 });
      }
      op.machineId = machine.id;
      op.machineName = machine.name;
      break;
    }
  }

  const sameSlot = fallbackMachineAssignmentsStore.filter(
    a =>
      a.id !== id &&
      a.machineId === machine.id &&
      a.shiftId === nextShiftId &&
      a.assignedDate === nextDate &&
      (a.status === 'SCHEDULED' || a.status === 'ACTIVE'),
  );
  if (sameSlot.length > 0 && !payload.allowConflictOverride) {
    throw Object.assign(new Error(`تداخل شیفت روی ${machine.code} در تاریخ ${nextDate}.`), { statusCode: 409 });
  }

  existing.machineId = machine.id;
  existing.shiftId = nextShiftId;
  existing.assignedDate = nextDate;
  if (payload.status) existing.status = payload.status;
  if (payload.notes !== undefined) existing.notes = payload.notes;
  return existing;
}

export function cancelFallbackMachineAssignment(id: string, reason?: string) {
  const existing = fallbackMachineAssignmentsStore.find(a => a.id === id);
  if (!existing) throw Object.assign(new Error('تخصیص ماشین یافت نشد.'), { statusCode: 404 });
  if (existing.status === 'COMPLETED') {
    throw Object.assign(new Error('امکان لغو تخصیص تکمیل‌شده وجود ندارد.'), { statusCode: 409 });
  }
  if (existing.status === 'CANCELLED') {
    return { replayed: true, assignment: existing };
  }
  existing.status = 'CANCELLED';
  existing.notes = reason ? `${existing.notes ? `${existing.notes} | ` : ''}لغو: ${reason}` : existing.notes;
  return { replayed: false, assignment: existing };
}

// =========================================================================
// KPIMS P3: Shop-Floor Execution & Control (In-Memory Fallback Parity)
// =========================================================================

export function getFallbackShopFloorBoard(
  machines: Machine[],
  operators: Operator[],
  filters?: { moId?: string; machineId?: string; shiftId?: string; executionState?: string; search?: string },
) {
  const machineMap = new Map(machines.map(m => [m.id, m]));
  const shiftMap = new Map(FALLBACK_SHIFTS.map(s => [s.id, s]));

  const planByMoId = new Map<string, { planId: string; planNumber: string; planTitle: string; planStatus: string }>();
  for (const prop of fallbackPlanProposalsStore) {
    const relMos = Array.isArray(prop.releasedManufacturingOrders) ? prop.releasedManufacturingOrders : [];
    const planObj = prop.productionPlan;
    if (!planObj) continue;
    for (const rmo of relMos) {
      if (rmo?.id) {
        planByMoId.set(rmo.id, {
          planId: planObj.id,
          planNumber: planObj.planNumber,
          planTitle: prop.title || planObj.planNumber,
          planStatus: planObj.status || 'RELEASED',
        });
      }
    }
  }

  const allOperationsQueue: any[] = [];
  const workOrders = manufacturingOrdersStore
    .filter(mo => mo.status !== 'CANCELLED' && mo.status !== 'PLANNED')
    .map(mo => {
      const linkedPlan = planByMoId.get(mo.id) || null;
      const sortedOps = [...(mo.operations || [])].sort((a, b) => a.stepNumber - b.stepNumber);
      const mappedOps = sortedOps.map((op, idx) => {
        const prevOp = idx > 0 ? sortedOps[idx - 1] : null;
        const pauseMeta = fallbackOpPauseMap.get(op.id);
        const isPaused = op.status === 'IN_PROGRESS' && Boolean(pauseMeta?.paused);
        const executionState = isPaused ? 'PAUSED' : op.status;
        const asg = fallbackMachineAssignmentsStore.find(
          a => a.productionOperationId === op.id && a.status !== 'CANCELLED',
        );
        const effMachineId = asg?.machineId || op.machineId || null;
        const m = effMachineId ? machineMap.get(effMachineId) : null;
        const sh = shiftMap.get(asg?.shiftId || FALLBACK_SHIFTS[0].id) || FALLBACK_SHIFTS[0];
        const plannedQty = Number((op as any).plannedQuantity || mo.targetQuantity || 0);
        const eligibleMachineIds = machines
          .filter(cand => cand.status === 'ACTIVE' && ((cand.capabilities || []).includes(op.processType) || cand.processType === op.processType))
          .map(cand => cand.id);
        const predecessorBlocked =
          Boolean(prevOp) &&
          (op.waitingInputQty || 0) <= 0 &&
          (op.inProgressQty || 0) <= 0 &&
          (prevOp!.goodOutputQty || 0) <= 0 &&
          !['COMPLETED', 'SKIPPED'].includes(prevOp!.status);
        const opReports = fallbackShopFloorReportsStore.filter(r => r.operationId === op.id);

        const opDto = {
          id: op.id,
          moId: mo.id,
          moNumber: mo.moNumber,
          partId: mo.partId,
          partCode: mo.partCode,
          partName: mo.partName,
          partWeightGrossKg: 1,
          partThicknessMm: null,
          planId: linkedPlan?.planId || null,
          planNumber: linkedPlan?.planNumber || null,
          planLineId: null,
          planLinePlannedQty: mo.targetQuantity,
          planLineProducedQty: mo.completedQuantity,
          moStatus: mo.status,
          stepNumber: op.stepNumber,
          sequence: op.sequence,
          stepCode: op.stepCode,
          stepName: op.stepName,
          processType: op.processType,
          plannedQty,
          waitingInputQty: op.waitingInputQty || 0,
          inProgressQty: op.inProgressQty || 0,
          readyForTransferQty: op.readyForTransferQty || 0,
          availableStationQty: (op.waitingInputQty || 0) + (op.inProgressQty || 0),
          outputGoodQty: op.goodOutputQty || 0,
          outputScrapQty: op.scrapQty || 0,
          outputReworkQty: op.reworkQty || 0,
          outputRejectedQty: op.rejectedQty || 0,
          remainingQty: Math.max(0, plannedQty - (op.goodOutputQty || 0)),
          completionPercent: plannedQty > 0 ? Math.min(100, Math.round(((op.goodOutputQty || 0) / plannedQty) * 1000) / 10) : 0,
          status: op.status,
          executionState,
          isPaused,
          lastPausedAt: isPaused ? pauseMeta?.pausedAt || null : null,
          lastPauseReason: isPaused ? pauseMeta?.reason || null : null,
          lastPauseIsDowntime: isPaused ? Boolean(pauseMeta?.isDowntime) : false,
          actualStartedAt: op.lastActivityAt || null,
          startDate: op.createdAt,
          endDate: op.status === 'COMPLETED' ? op.lastActivityAt : null,
          lastActivityAt: op.lastActivityAt,
          version: 1,
          plannedMachineId: op.machineId || null,
          machineId: effMachineId,
          machineCode: m?.code || null,
          machineName: m?.name || op.machineName || null,
          plannedDieId: op.dieMoldId || null,
          dieCode: null,
          dieName: null,
          assignmentId: asg?.id || null,
          assignmentStatus: asg?.status || null,
          shiftId: sh.id,
          shiftName: sh.name,
          assignedDate: asg?.assignedDate || mo.startDate,
          assignedOperatorId: null,
          assignedOperatorName: null,
          eligibleMachineIds,
          predecessorBlocked,
          outstandingMaterialKg: 0,
          totalRunTimeMinutes: opReports.reduce((s, r) => s + Number(r.runTimeMinutes || 0), 0),
          totalDowntimeMinutes: opReports.reduce((s, r) => s + Number(r.downtimeMinutes || 0), 0),
          canLoadMaterial:
            idx === 0 &&
            !isPaused &&
            op.status !== 'COMPLETED' &&
            mo.status !== 'COMPLETED' &&
            mo.status !== 'CANCELLED',
          canStart: ['READY', 'PENDING'].includes(op.status) && !predecessorBlocked && !isPaused && mo.status !== 'COMPLETED',
          canPause: op.status === 'IN_PROGRESS' && !isPaused,
          canResume: isPaused,
          canReport: !isPaused && op.status !== 'COMPLETED' && ((op.waitingInputQty || 0) + (op.inProgressQty || 0) > 0) && mo.status !== 'COMPLETED',
          canComplete:
            !isPaused &&
            op.status === 'IN_PROGRESS' &&
            (op.waitingInputQty || 0) <= 0 &&
            (op.inProgressQty || 0) <= 0 &&
            (op.readyForTransferQty || 0) <= 0 &&
            (op.goodOutputQty || 0) + (op.scrapQty || 0) + (op.reworkQty || 0) + (op.rejectedQty || 0) > 0,
        };
        allOperationsQueue.push(opDto);
        return opDto;
      });
      const moConsumedKg = fallbackShopFloorReportsStore
        .filter(r => r.moId === mo.id && r.actualMaterialConsumedKg != null)
        .reduce((s, r) => s + Number(r.actualMaterialConsumedKg || 0), 0);
      return {
        id: mo.id,
        moNumber: mo.moNumber,
        partId: mo.partId,
        partCode: mo.partCode,
        partName: mo.partName,
        planId: linkedPlan?.planId || null,
        planNumber: linkedPlan?.planNumber || null,
        planTitle: linkedPlan?.planTitle || null,
        planStatus: linkedPlan?.planStatus || null,
        planLineId: null,
        planLinePlannedQty: mo.targetQuantity,
        planLineProducedQty: mo.completedQuantity,
        planLineStatus: mo.status === 'COMPLETED' ? 'COMPLETED' : mo.completedQuantity > 0 ? 'IN_PROGRESS' : 'PLANNED',
        targetQty: mo.targetQuantity,
        initialInputQty: mo.initialInputQuantity,
        completedQty: mo.completedQuantity,
        scrapQty: mo.totalScrapQuantity,
        totalReworkQty: mo.totalReworkQuantity,
        totalRejectedQty: mo.totalRejectedQuantity,
        completionPercent: mo.targetQuantity > 0 ? Math.min(100, Math.round((mo.completedQuantity / mo.targetQuantity) * 1000) / 10) : 0,
        status: mo.status,
        priority: 2,
        scheduledStartDate: mo.startDate,
        scheduledEndDate: mo.dueDate,
        actualStartDate: null,
        actualEndDate: mo.closedAt || null,
        totalIssuedMaterialKg: 0,
        totalConsumedMaterialKg: Math.round(moConsumedKg * 100) / 100,
        totalOutstandingMaterialKg: 0,
        version: 1,
        operations: mappedOps,
      };
    });

  const searchNorm = (filters?.search || '').trim().toLowerCase();
  const filteredQueue = allOperationsQueue.filter(op => {
    if (filters?.moId && filters.moId !== 'ALL' && op.moId !== filters.moId) return false;
    if (filters?.machineId && filters.machineId !== 'ALL' && op.machineId !== filters.machineId) return false;
    if (filters?.shiftId && filters.shiftId !== 'ALL' && op.shiftId !== filters.shiftId) return false;
    if (filters?.executionState && filters.executionState !== 'ALL' && op.executionState !== filters.executionState) return false;
    if (searchNorm && !`${op.moNumber} ${op.partCode} ${op.partName} ${op.stepCode} ${op.stepName}`.toLowerCase().includes(searchNorm)) return false;
    return true;
  });

  const downtimeEvents = [
    ...fallbackShopFloorReportsStore
      .filter(r => Number(r.downtimeMinutes || 0) > 0)
      .map(r => {
        const m = r.machineId ? machineMap.get(r.machineId) : null;
        return {
          id: `RPT-DT-${r.id}`,
          source: 'PRODUCTION_REPORT',
          machineId: r.machineId,
          machineCode: m?.code || r.machineId || '',
          machineName: m?.name || '',
          moId: r.moId,
          moNumber: r.moNumber,
          operationId: r.operationId,
          stepCode: r.stepCode,
          shiftId: r.shiftId,
          shiftName: shiftMap.get(r.shiftId)?.name || '',
          reason: r.downtimeReason || 'توقف حین تولید',
          durationMinutes: Number(r.downtimeMinutes || 0),
          recordedAt: r.reportDate,
          recordedBy: r.operatorName,
        };
      }),
    ...fallbackShopFloorDowntimeStore,
  ].sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime());

  const totalPlannedQty = workOrders.reduce((s, w) => s + w.targetQty, 0);
  const totalActualGoodQty = workOrders.reduce((s, w) => s + w.completedQty, 0);
  const totalScrapQty = workOrders.reduce((s, w) => s + w.scrapQty, 0);
  const totalRunTimeMinutes = fallbackShopFloorReportsStore.reduce((s, r) => s + Number(r.runTimeMinutes || 0), 0);
  const totalDowntimeMinutes = downtimeEvents.reduce((s, d) => s + Number(d.durationMinutes || 0), 0);
  const dailyAvailMin = FALLBACK_SHIFTS.reduce((s, sh) => s + sh.productiveHours, 0) * 60;
  const perMachine = machines.map(m => {
    const mReports = fallbackShopFloorReportsStore.filter(r => r.machineId === m.id);
    const runMin = mReports.reduce((s, r) => s + Number(r.runTimeMinutes || 0), 0);
    const dtMin = downtimeEvents.filter(d => d.machineId === m.id).reduce((s, d) => s + Number(d.durationMinutes || 0), 0);
    return {
      machineId: m.id,
      machineCode: m.code,
      machineName: m.name,
      status: m.status,
      activeOpsCount: allOperationsQueue.filter(o => o.machineId === m.id && o.status !== 'COMPLETED').length,
      inProgressOpsCount: allOperationsQueue.filter(o => o.machineId === m.id && o.executionState === 'IN_PROGRESS').length,
      pausedOpsCount: allOperationsQueue.filter(o => o.machineId === m.id && o.executionState === 'PAUSED').length,
      runTimeMinutes: runMin,
      downtimeMinutes: dtMin,
      availableMinutes: dailyAvailMin,
      utilizationPercent: runMin > 0 ? Math.min(100, Math.round((runMin / dailyAvailMin) * 1000) / 10) : 0,
      goodQty: mReports.reduce((s, r) => s + Number(r.goodQty || 0), 0),
      scrapQty: mReports.reduce((s, r) => s + Number(r.scrapQty || 0), 0),
    };
  });

  const byReasonMap = new Map<string, { reason: string; minutes: number; count: number }>();
  for (const d of downtimeEvents) {
    const prev = byReasonMap.get(d.reason) || { reason: d.reason, minutes: 0, count: 0 };
    prev.minutes += Number(d.durationMinutes || 0);
    prev.count += 1;
    byReasonMap.set(d.reason, prev);
  }

  const denom = totalActualGoodQty + totalScrapQty;
  return {
    source: 'memory-fallback',
    workOrders,
    operationsQueue: filteredQueue,
    recentReports: fallbackShopFloorReportsStore.slice(0, 100),
    downtimeEvents,
    activityTimeline: productionLogsStore.slice(0, 60),
    kpis: {
      workOrdersCount: workOrders.length,
      activeWorkOrdersCount: workOrders.filter(w => w.status === 'RELEASED' || w.status === 'IN_PROGRESS').length,
      completedWorkOrdersCount: workOrders.filter(w => w.status === 'COMPLETED').length,
      readyOpsCount: allOperationsQueue.filter(o => o.executionState === 'READY').length,
      inProgressOpsCount: allOperationsQueue.filter(o => o.executionState === 'IN_PROGRESS').length,
      pausedOpsCount: allOperationsQueue.filter(o => o.executionState === 'PAUSED').length,
      completedOpsCount: allOperationsQueue.filter(o => o.executionState === 'COMPLETED').length,
      totalPlannedQty,
      totalActualGoodQty,
      totalScrapQty,
      totalReworkQty: workOrders.reduce((s, w) => s + w.totalReworkQty, 0),
      totalRejectedQty: workOrders.reduce((s, w) => s + w.totalRejectedQty, 0),
      overallCompletionPercent: totalPlannedQty > 0 ? Math.min(100, Math.round((totalActualGoodQty / totalPlannedQty) * 1000) / 10) : 0,
      scrapRatePercent: denom > 0 ? Math.round((totalScrapQty / denom) * 10000) / 100 : 0,
      machineUtilizationPercent:
        perMachine.filter(m => m.runTimeMinutes > 0).length > 0
          ? Math.min(100, Math.round((totalRunTimeMinutes / (perMachine.filter(m => m.runTimeMinutes > 0).length * dailyAvailMin)) * 1000) / 10)
          : 0,
      totalRunTimeMinutes,
      totalDowntimeMinutes,
      downtimeByReason: Array.from(byReasonMap.values()).sort((a, b) => b.minutes - a.minutes),
      perMachine,
    },
    masterData: {
      machines: machines.map(m => ({
        id: m.id,
        code: m.code,
        name: m.name,
        hallLocation: m.location || 'سالن تولید',
        machineType: m.processType,
        tonnageCapacity: m.tonnage ?? null,
        status: m.status,
        active: m.status === 'ACTIVE',
      })),
      shifts: FALLBACK_SHIFTS,
      operators: operators.map(o => ({
        id: o.id,
        username: o.personnelCode,
        fullName: o.fullName,
        personnelCode: o.personnelCode,
        active: true,
      })),
    },
  };
}

function findFallbackOp(operationId: string) {
  for (const mo of manufacturingOrdersStore) {
    const sorted = [...(mo.operations || [])].sort((a, b) => a.stepNumber - b.stepNumber);
    const idx = sorted.findIndex(o => o.id === operationId);
    if (idx >= 0) return { mo, op: sorted[idx], prevOp: idx > 0 ? sorted[idx - 1] : null };
  }
  return null;
}

export function startFallbackOperation(params: any, machines: Machine[]) {
  const key = String(params.idempotencyKey || '').trim();
  if (key.length < 8) throw Object.assign(new Error('کلید یکتا الزامی است.'), { statusCode: 400 });
  const prior = fallbackShopFloorLifecycleIdempotency.get(`START:${key}`);
  if (prior) {
    if (prior.fingerprint !== params.operationId) throw Object.assign(new Error('تضاد کلید یکتا.'), { statusCode: 409 });
    return { duplicate: true, ...prior.response };
  }
  const found = findFallbackOp(params.operationId);
  if (!found) throw Object.assign(new Error('عملیات یافت نشد.'), { statusCode: 404 });
  const { mo, op, prevOp } = found;
  if (op.status === 'COMPLETED') throw Object.assign(new Error('عملیات تکمیل شده است.'), { statusCode: 409 });
  if (fallbackOpPauseMap.get(op.id)?.paused) throw Object.assign(new Error('عملیات متوقف است؛ از Resume استفاده کنید.'), { statusCode: 409 });
  if (op.status === 'IN_PROGRESS') throw Object.assign(new Error('عملیات در حال اجراست.'), { statusCode: 409 });
  if (
    prevOp &&
    (op.waitingInputQty || 0) <= 0 &&
    (op.inProgressQty || 0) <= 0 &&
    (prevOp.goodOutputQty || 0) <= 0 &&
    !['COMPLETED', 'SKIPPED'].includes(prevOp.status)
  ) {
    throw Object.assign(new Error('قفل توالی عملیات: عملیات قبلی هنوز تولیدی نداشته است.'), { statusCode: 409 });
  }
  const mId = params.machineId || op.machineId;
  const m = machines.find(cand => cand.id === mId || cand.code === mId);
  if (!m || m.status !== 'ACTIVE') throw Object.assign(new Error('ماشین معتبر یا فعال نیست.'), { statusCode: 400 });
  const supports = (m.capabilities || []).includes(op.processType) || m.processType === op.processType;
  if (!supports) throw Object.assign(new Error(`ماشین ${m.code} قابلیت این عملیات را ندارد.`), { statusCode: 400 });

  const now = new Date().toISOString();
  if (params.moveWaitingToInProgress !== false && (op.waitingInputQty || 0) > 0) {
    op.inProgressQty = (op.inProgressQty || 0) + (op.waitingInputQty || 0);
    op.waitingInputQty = 0;
  }
  op.status = 'IN_PROGRESS';
  op.machineId = m.id;
  op.machineName = m.name;
  op.lastActivityAt = now;
  if (mo.status === 'RELEASED') mo.status = 'IN_PROGRESS';
  for (const a of fallbackMachineAssignmentsStore) {
    if (a.productionOperationId === op.id && a.status === 'SCHEDULED') a.status = 'ACTIVE';
  }
  productionLogsStore.unshift({
    id: `LOG-START-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    moId: mo.id,
    moNumber: mo.moNumber,
    partId: mo.partId,
    partCode: mo.partCode,
    partName: mo.partName,
    operationId: op.id,
    stepNumber: op.stepNumber,
    stepName: op.stepName,
    activityType: 'OP_START' as any,
    quantity: op.inProgressQty || 0,
    operatorName: params.operatorName || 'اپراتور خط',
    machineId: m.id,
    timestamp: now,
    notes: params.notes || `شروع عملیات روی ماشین ${m.code}`,
  });
  const response = { operation: op, executionState: 'IN_PROGRESS' };
  fallbackShopFloorLifecycleIdempotency.set(`START:${key}`, { fingerprint: params.operationId, response });
  return { duplicate: false, ...response };
}

export function pauseFallbackOperation(params: any) {
  const key = String(params.idempotencyKey || '').trim();
  const reason = String(params.reason || '').trim();
  if (key.length < 8) throw Object.assign(new Error('کلید یکتا الزامی است.'), { statusCode: 400 });
  if (!reason) throw Object.assign(new Error('علت توقف الزامی است.'), { statusCode: 400 });
  const prior = fallbackShopFloorLifecycleIdempotency.get(`PAUSE:${key}`);
  if (prior) {
    if (prior.fingerprint !== `${params.operationId}:${reason}`) throw Object.assign(new Error('تضاد کلید یکتا.'), { statusCode: 409 });
    return { duplicate: true, ...prior.response };
  }
  const found = findFallbackOp(params.operationId);
  if (!found) throw Object.assign(new Error('عملیات یافت نشد.'), { statusCode: 404 });
  if (found.op.status !== 'IN_PROGRESS' || fallbackOpPauseMap.get(found.op.id)?.paused) {
    throw Object.assign(new Error('فقط عملیات در حال اجرا قابل توقف است.'), { statusCode: 409 });
  }
  const now = new Date().toISOString();
  fallbackOpPauseMap.set(found.op.id, {
    paused: true,
    reason,
    isDowntime: Boolean(params.isDowntime),
    pausedAt: now,
  });
  found.op.lastActivityAt = now;
  productionLogsStore.unshift({
    id: `LOG-PAUSE-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    moId: found.mo.id,
    moNumber: found.mo.moNumber,
    partId: found.mo.partId,
    partCode: found.mo.partCode,
    partName: found.mo.partName,
    operationId: found.op.id,
    stepNumber: found.op.stepNumber,
    stepName: found.op.stepName,
    activityType: 'OP_PAUSE' as any,
    quantity: 0,
    operatorName: params.operatorName || 'اپراتور خط',
    machineId: found.op.machineId,
    timestamp: now,
    notes: `${reason}${params.isDowntime ? ' [توقف ماشین]' : ''}`,
  });
  const response = { operation: found.op, executionState: 'PAUSED' };
  fallbackShopFloorLifecycleIdempotency.set(`PAUSE:${key}`, { fingerprint: `${params.operationId}:${reason}`, response });
  return { duplicate: false, ...response };
}

export function resumeFallbackOperation(params: any, machines: Machine[] = []) {
  const key = String(params.idempotencyKey || '').trim();
  if (key.length < 8) throw Object.assign(new Error('کلید یکتا الزامی است.'), { statusCode: 400 });
  const prior = fallbackShopFloorLifecycleIdempotency.get(`RESUME:${key}`);
  if (prior) {
    if (prior.fingerprint !== params.operationId) throw Object.assign(new Error('تضاد کلید یکتا.'), { statusCode: 409 });
    return { duplicate: true, ...prior.response };
  }
  const found = findFallbackOp(params.operationId);
  if (!found) throw Object.assign(new Error('عملیات یافت نشد.'), { statusCode: 404 });
  const pauseMeta = fallbackOpPauseMap.get(found.op.id);
  if (found.op.status !== 'IN_PROGRESS' || !pauseMeta?.paused) {
    throw Object.assign(new Error('فقط عملیات متوقف‌شده قابل ازسرگیری است.'), { statusCode: 409 });
  }
  const now = new Date();
  const nowIso = now.toISOString();
  if (params.machineId && machines.length > 0) {
    const newM = machines.find(cand => cand.id === params.machineId || cand.code === params.machineId);
    if (!newM || newM.status !== 'ACTIVE') {
      throw Object.assign(new Error('ماشین انتخابی معتبر یا فعال نیست.'), { statusCode: 400 });
    }
    const supports = (newM.capabilities || []).includes(found.op.processType) || newM.processType === found.op.processType;
    if (!supports) {
      throw Object.assign(new Error(`ماشین ${newM.code} قابلیت این عملیات را ندارد.`), { statusCode: 400 });
    }
    found.op.machineId = newM.id;
    found.op.machineName = newM.name;
  }
  let loggedDowntimeMinutes = 0;
  if (pauseMeta.isDowntime || (params.downtimeMinutesOverride != null && Number(params.downtimeMinutesOverride) > 0)) {
    const overrideMin =
      params.downtimeMinutesOverride != null && Number.isFinite(Number(params.downtimeMinutesOverride))
        ? Math.max(0, Math.round(Number(params.downtimeMinutesOverride)))
        : null;
    const elapsedMin = Math.max(
      1,
      Math.round((now.getTime() - new Date(pauseMeta.pausedAt || nowIso).getTime()) / 60000),
    );
    loggedDowntimeMinutes = overrideMin != null ? overrideMin : elapsedMin;
    if (loggedDowntimeMinutes > 0) {
      const m = machines.find(cand => cand.id === found.op.machineId);
      fallbackShopFloorDowntimeStore.unshift({
        id: `DT-PAUSE-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        source: 'PAUSE_DOWNTIME',
        machineId: found.op.machineId || null,
        machineCode: m?.code || found.op.machineId || '',
        machineName: m?.name || found.op.machineName || 'ماشین',
        moId: found.mo.id,
        moNumber: found.mo.moNumber,
        operationId: found.op.id,
        stepCode: found.op.stepCode,
        shiftId: params.shiftId || FALLBACK_SHIFTS[0].id,
        shiftName: FALLBACK_SHIFTS.find(s => s.id === (params.shiftId || FALLBACK_SHIFTS[0].id))?.name || null,
        reason: pauseMeta.reason || 'توقف حین عملیات',
        durationMinutes: loggedDowntimeMinutes,
        recordedAt: nowIso,
        recordedBy: params.operatorName || 'اپراتور خط',
      });
    }
  }
  fallbackOpPauseMap.set(found.op.id, { ...pauseMeta, paused: false });
  found.op.lastActivityAt = nowIso;
  productionLogsStore.unshift({
    id: `LOG-RESUME-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    moId: found.mo.id,
    moNumber: found.mo.moNumber,
    partId: found.mo.partId,
    partCode: found.mo.partCode,
    partName: found.mo.partName,
    operationId: found.op.id,
    stepNumber: found.op.stepNumber,
    stepName: found.op.stepName,
    activityType: 'OP_RESUME' as any,
    quantity: 0,
    operatorName: params.operatorName || 'اپراتور خط',
    machineId: found.op.machineId,
    timestamp: nowIso,
    notes:
      params.notes ||
      (loggedDowntimeMinutes > 0 ? `ازسرگیری عملیات (ثبت ${loggedDowntimeMinutes} دقیقه توقف)` : 'ازسرگیری عملیات'),
  });
  const response = { operation: found.op, executionState: 'IN_PROGRESS', loggedDowntimeMinutes };
  fallbackShopFloorLifecycleIdempotency.set(`RESUME:${key}`, { fingerprint: params.operationId, response });
  return { duplicate: false, ...response };
}

export function completeFallbackOperation(params: any) {
  const key = String(params.idempotencyKey || '').trim();
  if (key.length < 8) throw Object.assign(new Error('کلید یکتا الزامی است.'), { statusCode: 400 });
  const prior = fallbackShopFloorLifecycleIdempotency.get(`COMPLETE:${key}`);
  if (prior) {
    if (prior.fingerprint !== params.operationId) throw Object.assign(new Error('تضاد کلید یکتا.'), { statusCode: 409 });
    return { duplicate: true, ...prior.response };
  }
  const found = findFallbackOp(params.operationId);
  if (!found) throw Object.assign(new Error('عملیات یافت نشد.'), { statusCode: 404 });
  const { mo, op } = found;
  if (op.status === 'COMPLETED') {
    throw Object.assign(new Error('این عملیات قبلاً تکمیل شده است.'), { statusCode: 409 });
  }
  if (fallbackOpPauseMap.get(op.id)?.paused) throw Object.assign(new Error('عملیات متوقف قابل تکمیل نیست.'), { statusCode: 409 });
  if ((op.waitingInputQty || 0) > 0 || (op.inProgressQty || 0) > 0 || (op.readyForTransferQty || 0) > 0) {
    throw Object.assign(new Error('تا زمانی که موجودی در صف یا پای دستگاه است، تکمیل عملیات مجاز نیست.'), { statusCode: 409 });
  }
  if ((op.goodOutputQty || 0) + (op.scrapQty || 0) + (op.reworkQty || 0) + (op.rejectedQty || 0) <= 0) {
    throw Object.assign(new Error('بدون ثبت تولید نمی‌توان عملیات را تکمیل کرد.'), { statusCode: 409 });
  }
  const nowIso = new Date().toISOString();
  op.status = 'COMPLETED';
  op.lastActivityAt = nowIso;
  for (const a of fallbackMachineAssignmentsStore) {
    if (a.productionOperationId === op.id && a.status !== 'CANCELLED') a.status = 'COMPLETED';
  }
  const allOpsDone = (mo.operations || []).every(
    cand => cand.id === op.id || cand.status === 'COMPLETED',
  );
  const allOpsDrained = (mo.operations || []).every(
    cand =>
      (cand.waitingInputQty || 0) <= 0 &&
      (cand.inProgressQty || 0) <= 0 &&
      (cand.readyForTransferQty || 0) <= 0,
  );
  if (allOpsDone && allOpsDrained && (mo.completedQuantity || 0) >= (mo.targetQuantity || 0)) {
    mo.status = 'COMPLETED';
    mo.closedAt = nowIso;
  }
  mo.updatedAt = nowIso;
  productionLogsStore.unshift({
    id: `LOG-COMPLETE-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    moId: mo.id,
    moNumber: mo.moNumber,
    partId: mo.partId,
    partCode: mo.partCode,
    partName: mo.partName,
    operationId: op.id,
    stepNumber: op.stepNumber,
    stepName: op.stepName,
    activityType: 'OP_COMPLETE' as any,
    quantity: op.goodOutputQty || 0,
    operatorName: params.operatorName || 'اپراتور خط',
    machineId: op.machineId,
    timestamp: nowIso,
    notes: params.notes || 'تکمیل و پایان عملیات ایستگاه',
  });
  const response = { operation: op, executionState: 'COMPLETED' };
  fallbackShopFloorLifecycleIdempotency.set(`COMPLETE:${key}`, { fingerprint: params.operationId, response });
  return { duplicate: false, ...response };
}

export function recordFallbackDowntime(params: any, machines: Machine[]) {
  const key = String(params.idempotencyKey || '').trim();
  const reason = String(params.reason || '').trim();
  const durationMinutes = Math.round(Number(params.durationMinutes));
  if (key.length < 8) throw Object.assign(new Error('کلید یکتا الزامی است.'), { statusCode: 400 });
  if (!reason) throw Object.assign(new Error('علت توقف الزامی است.'), { statusCode: 400 });
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    throw Object.assign(new Error('مدت توقف باید بزرگتر از صفر باشد.'), { statusCode: 400 });
  }
  const fp = `${params.machineId}:${reason}:${durationMinutes}`;
  const prior = fallbackShopFloorLifecycleIdempotency.get(`DT:${key}`);
  if (prior) {
    if (prior.fingerprint !== fp) throw Object.assign(new Error('تضاد کلید یکتا.'), { statusCode: 409 });
    return { duplicate: true, downtimeEvent: prior.response };
  }
  const m = machines.find(cand => cand.id === params.machineId || cand.code === params.machineId);
  if (!m) throw Object.assign(new Error('ماشین یافت نشد.'), { statusCode: 404 });
  const linked = params.productionOperationId ? findFallbackOp(params.productionOperationId) : null;
  if (params.markMachineBreakdown) m.status = 'BREAKDOWN';
  const evt = {
    id: `DT-FB-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    source: 'STANDALONE_DOWNTIME',
    machineId: m.id,
    machineCode: m.code,
    machineName: m.name,
    moId: linked?.mo.id || null,
    moNumber: linked?.mo.moNumber || null,
    operationId: linked?.op.id || params.productionOperationId || null,
    stepCode: linked?.op.stepCode || null,
    shiftId: params.shiftId || null,
    shiftName: FALLBACK_SHIFTS.find(s => s.id === params.shiftId)?.name || null,
    reason,
    durationMinutes,
    recordedAt: new Date().toISOString(),
    recordedBy: params.operatorName || 'اپراتور خط',
  };
  fallbackShopFloorDowntimeStore.unshift(evt);
  fallbackShopFloorLifecycleIdempotency.set(`DT:${key}`, { fingerprint: fp, response: evt });
  return { duplicate: false, downtimeEvent: evt };
}

export function getFallbackShopFloorRawStores() {
  return {
    shifts: FALLBACK_SHIFTS,
    reports: fallbackShopFloorReportsStore,
    downtimes: fallbackShopFloorDowntimeStore,
    assignments: fallbackMachineAssignmentsStore,
  };
}



