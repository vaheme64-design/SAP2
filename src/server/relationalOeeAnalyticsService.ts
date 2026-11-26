/**
 * =========================================================================
 * KPIMS P4: OEE, Machine Performance & Production Analytics Service
 * =========================================================================
 * Single source of truth for Availability, Performance, Quality, OEE,
 * planned/unplanned/setup downtime classification, actual vs planned
 * production, data-quality validation, and CSV export consistency across
 * PostgreSQL and in-memory fallback parity modes.
 *
 * Strict invariants:
 * 1. Read-only over existing P0-P3 operational records (ProductionReport,
 *    ProductionOperation, RouteOperation, MachineAssignment, Shift, Machine,
 *    ManufacturingOrder, AuditLog SHOP_FLOOR_DOWNTIME).
 * 2. Zero double-counting of downtime: AuditLog SHOP_FLOOR_DOWNTIME rows
 *    linked to a ProductionReport (newValues.productionReportId) are skipped.
 * 3. Zero fabricated OEE values: if any required input (operating time,
 *    planned production time denominator, ideal cycle time, or output qty)
 *    is missing, the affected factor and OEE return null with explicit
 *    missingInputs & dataQualityIssues.
 * =========================================================================
 */

import { __getProductionWipPrisma } from './services/productionWipService';
import { manufacturingOrdersStore } from './productionWipEngine';
import { getFallbackShopFloorRawStores } from './inMemoryRelationalFallback';
import type { Machine } from '../types/inventory';
import type {
  OeeAnalyticsDailyRow,
  OeeAnalyticsMachineRow,
  OeeAnalyticsOperationRow,
  OeeAnalyticsResponse,
  OeeAnalyticsShiftRow,
  OeeCoreMetrics,
  OeeDataQualityIssue,
  OeeDataQualityStatus,
  OeeDowntimeCategory,
  OeeDowntimeSummary,
  OeeSourceAssignmentRecord,
  OeeSourceDowntimeEvent,
  OeeSourceReportRecord,
  OeeDashboardSummary,
  OeeMachineRecord,
  MachineUtilizationSummary,
  MachineUtilizationItem,
  ShiftFilterKey,
} from '../types/oeeAndConsumables';

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const round1 = (v: number): number => Math.round(v * 10) / 10;
const round2 = (v: number): number => Math.round(v * 100) / 100;

function toIsoSafe(val: unknown, fallback: Date = new Date()): string {
  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? fallback.toISOString() : val.toISOString();
  }
  if (typeof val === 'string' && val.trim()) {
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? fallback.toISOString() : d.toISOString();
  }
  return fallback.toISOString();
}

function toDateKey(val: unknown): string {
  return toIsoSafe(val).slice(0, 10);
}

// ============================================================================
// 1. DOWNTIME CLASSIFICATION (PLANNED / SETUP / UNPLANNED)
// ============================================================================

const SETUP_KEYWORDS = [
  'ستاپ',
  'setup',
  'smed',
  'تعویض قالب',
  'بستن قالب',
  'قالب‌بندی',
  'تنظیم قالب',
  'تنظیم تیغه',
  'تنظیم گیج',
  'تنظیم ضرب',
  'تنظیم ارتفاع',
  'تایید قطعه اول',
  'تأیید قطعه اول',
  'بررسی نمونه اول',
  'first piece',
  'changeover',
  'راه‌اندازی',
  'کالیبراسیون',
  'فیکسچر',
  'shut height',
  'تنظیم کورس',
  'تنظیم قالب',
  'کلمپ',
  'بستن قالب',
  'باز کردن قالب',
];

const PLANNED_KEYWORDS = [
  'برنامه‌ریزی',
  'planned',
  'نت پیشگیرانه',
  'سرویس دوره‌ای',
  'بازدید دوره‌ای',
  'بازرسی دوره‌ای',
  'روغن‌کاری',
  'pm ',
  '(pm)',
  'استراحت',
  'نهار',
  'تراش و تعویض کلاهک',
  'tip dressing',
  'نظافت',
  'جلسه',
  'scheduled',
];

export function classifyDowntimeCategory(
  reason: string | null | undefined,
  opts?: { explicitCategory?: string | null; markMachineBreakdown?: boolean },
): OeeDowntimeCategory {
  if (opts?.markMachineBreakdown) return 'UNPLANNED';
  const exp = String(opts?.explicitCategory || '').toUpperCase().trim();
  if (exp === 'SETUP' || exp === 'PLANNED_SETUP' || exp === 'SETUP_CHANGE') return 'SETUP';
  if (exp === 'PLANNED' || exp === 'PLANNED_DOWNTIME') return 'PLANNED';
  if (exp === 'UNPLANNED' || exp === 'UNPLANNED_BREAKDOWN' || exp === 'UNPLANNED_DOWNTIME') {
    return 'UNPLANNED';
  }

  const text = String(reason || '').toLowerCase().trim();
  if (!text) return 'UNPLANNED';

  if (SETUP_KEYWORDS.some(k => text.includes(k))) return 'SETUP';
  if (PLANNED_KEYWORDS.some(k => text.includes(k))) return 'PLANNED';
  return 'UNPLANNED';
}

export const OEE_FORMULAS_REFERENCE: OeeAnalyticsResponse['formulas'] = {
  plannedProductionTime:
    'Planned Production Time = Scheduled Shift Time − Planned Downtime (PM / Scheduled Breaks)',
  availability:
    'Availability (%) = (Operating Time ÷ Effective Planned Production Time) × 100; Setup & Unplanned Downtime are Availability losses',
  performance:
    'Performance (%) = ((Σ Total Produced Qty × Ideal Cycle Time [min/pc]) ÷ Operating Time [min]) × 100 (capped at 100% if >100% with UNRELIABLE flag)',
  quality:
    'Quality (%) = (Good Quantity ÷ (Good + Scrap + Rework + Rejected)) × 100',
  oee:
    'OEE (%) = (Availability × Performance × Quality) ÷ 10,000 — computed ONLY when A, P, and Q are all valid (never fabricated)',
  teep:
    'TEEP (%) = OEE × (Effective Planned Production Time ÷ Scheduled Shift Time)',
  downtimeDeduplication:
    'Downtime = ProductionReport.downtimeMinutes + standalone SHOP_FLOOR_DOWNTIME AuditLog events without productionReportId (zero double-counting)',
};

// ============================================================================
// 2. CORE PURE OEE CALCULATION ENGINE (UNIT-TESTABLE & SHARED)
// ============================================================================

export interface ComputeOeeInput {
  scheduledTimeMinutes: number;
  scheduledTimeSource: 'ASSIGNMENTS' | 'REPORT_SHIFTS' | 'REPORTED_SPAN' | 'NONE';
  operatingTimeMinutes: number;
  plannedDowntimeMinutes: number;
  setupTimeMinutes: number;
  unplannedDowntimeMinutes: number;
  plannedQty: number;
  goodQty: number;
  scrapQty: number;
  reworkQty: number;
  rejectedQty: number;
  /** Weighted sum of (qty * idealCycleTimeSec / 60) across reports with valid idealCycleTimeSec */
  idealRunTimeMinutes: number;
  /** Total produced qty covered by a valid idealCycleTimeSec > 0 */
  idealCycleCoveredQty: number;
  /** True if any report's ideal cycle time fell back to Machine.maxStrokesPerMinute instead of Operation/Route */
  usedMachineSpmFallback?: boolean;
}

export function computeOeeMetrics(input: ComputeOeeInput): OeeCoreMetrics {
  const issues: OeeDataQualityIssue[] = [];
  const missingInputs: string[] = [];

  const operatingTimeMinutes = Math.max(0, round1(num(input.operatingTimeMinutes)));
  const plannedDowntimeMinutes = Math.max(0, round1(num(input.plannedDowntimeMinutes)));
  const setupTimeMinutes = Math.max(0, round1(num(input.setupTimeMinutes)));
  const unplannedDowntimeMinutes = Math.max(0, round1(num(input.unplannedDowntimeMinutes)));
  const availabilityLossMinutes = round1(setupTimeMinutes + unplannedDowntimeMinutes);
  const reportedActiveSpan = round1(operatingTimeMinutes + availabilityLossMinutes);

  const plannedQty = Math.max(0, round2(num(input.plannedQty)));
  const goodQty = Math.max(0, round2(num(input.goodQty)));
  const scrapQty = Math.max(0, round2(num(input.scrapQty)));
  const reworkQty = Math.max(0, round2(num(input.reworkQty)));
  const rejectedQty = Math.max(0, round2(num(input.rejectedQty)));
  const totalProducedQty = round2(goodQty + scrapQty + reworkQty + rejectedQty);

  // Resolve scheduled time & planned production time denominator
  let scheduledTimeMinutes = Math.max(0, round1(num(input.scheduledTimeMinutes)));
  let scheduledTimeSource = input.scheduledTimeSource;

  if (scheduledTimeMinutes <= 0 && reportedActiveSpan > 0) {
    scheduledTimeMinutes = round1(reportedActiveSpan + plannedDowntimeMinutes);
    scheduledTimeSource = 'REPORTED_SPAN';
    issues.push({
      code: 'MISSING_SCHEDULED_SHIFT_TIME',
      severity: 'WARNING',
      messageFa:
        'تخصیص شیفت (MachineAssignment) یا ساعت شیفت یافت نشد؛ مخرج دسترس‌پذیری از مجموع زمان کارکرد و توقفات ثبت‌شده استنتاج شده است.',
    });
  } else if (scheduledTimeMinutes <= 0) {
    scheduledTimeSource = 'NONE';
  }

  const plannedProductionTimeMinutes = Math.max(0, round1(scheduledTimeMinutes - plannedDowntimeMinutes));
  let effectivePlannedProductionTimeMinutes = plannedProductionTimeMinutes;

  if (
    (scheduledTimeSource === 'ASSIGNMENTS' || scheduledTimeSource === 'REPORT_SHIFTS') &&
    reportedActiveSpan > plannedProductionTimeMinutes + 1
  ) {
    effectivePlannedProductionTimeMinutes = reportedActiveSpan;
    issues.push({
      code: 'TIME_OVERFLOW_EXCEEDS_SHIFT_DURATION',
      severity: 'WARNING',
      messageFa: `مجموع زمان کارکرد و توقفات (${reportedActiveSpan} دقیقه) از زمان برنامه‌ریزی‌شده شیفت (${plannedProductionTimeMinutes} دقیقه) بیشتر است؛ اضافه کار یا ثبت نادرست زمان بررسی شود.`,
    });
  }

  const idleUnassignedMinutes =
    effectivePlannedProductionTimeMinutes > reportedActiveSpan
      ? round1(effectivePlannedProductionTimeMinutes - reportedActiveSpan)
      : 0;

  // 1) AVAILABILITY
  let availabilityPercent: number | null = null;
  if (effectivePlannedProductionTimeMinutes > 0 && (operatingTimeMinutes > 0 || availabilityLossMinutes > 0)) {
    availabilityPercent = Math.min(
      100,
      Math.max(0, round1((operatingTimeMinutes / effectivePlannedProductionTimeMinutes) * 100)),
    );
  } else if (totalProducedQty > 0 && operatingTimeMinutes <= 0) {
    missingInputs.push('MISSING_RUN_TIME');
    issues.push({
      code: 'MISSING_RUN_TIME',
      severity: 'ERROR',
      messageFa: 'تولید ثبت شده ولی مدت زمان کارکرد (runTimeMinutes) صفر یا ثبت‌نشده است.',
    });
  } else {
    missingInputs.push('NO_ACTIVITY_OR_SCHEDULE');
    issues.push({
      code: 'NO_ACTIVITY_OR_SCHEDULE',
      severity: 'INFO',
      messageFa: 'در بازه انتخاب‌شده هیچ گزارش تولید یا رویداد توقفی ثبت نشده است.',
    });
  }

  // 2) QUALITY
  let qualityPercent: number | null = null;
  let scrapRatePercent: number | null = null;
  if (totalProducedQty > 0) {
    qualityPercent = Math.min(100, Math.max(0, round1((goodQty / totalProducedQty) * 100)));
    scrapRatePercent = round2((scrapQty / totalProducedQty) * 100);
  } else if (operatingTimeMinutes > 0 || availabilityLossMinutes > 0) {
    missingInputs.push('NO_PRODUCTION_OUTPUT');
    issues.push({
      code: 'NO_PRODUCTION_OUTPUT',
      severity: 'INFO',
      messageFa: 'هیچ خروجی تولیدی ثبت نشده است؛ شاخص کیفیت و عملکرد قابل محاسبه نیست.',
    });
  }

  // 3) PERFORMANCE (Ideal Cycle Time * Total Produced Qty / Operating Time)
  let rawPerformancePercent: number | null = null;
  let performancePercent: number | null = null;
  let idealRunTimeMinutes: number | null = null;
  let idealCycleTimeSec: number | null = null;
  let actualCycleTimeSec: number | null = null;

  if (totalProducedQty > 0 && operatingTimeMinutes > 0) {
    actualCycleTimeSec = round2((operatingTimeMinutes * 60) / totalProducedQty);
  }

  const coveredQty = Math.max(0, round2(num(input.idealCycleCoveredQty)));
  if (coveredQty > 0 && num(input.idealRunTimeMinutes) > 0) {
    idealRunTimeMinutes = round2(num(input.idealRunTimeMinutes));
    idealCycleTimeSec = round2((idealRunTimeMinutes * 60) / coveredQty);
  }

  if (totalProducedQty > 0) {
    if (operatingTimeMinutes <= 0) {
      if (!missingInputs.includes('MISSING_RUN_TIME')) {
        missingInputs.push('MISSING_RUN_TIME');
        issues.push({
          code: 'MISSING_RUN_TIME',
          severity: 'ERROR',
          messageFa: 'برای محاسبه عملکرد (Performance)، زمان کارکرد (runTimeMinutes) الزامی است.',
        });
      }
    } else if (coveredQty <= 0 || idealRunTimeMinutes == null || idealRunTimeMinutes <= 0) {
      missingInputs.push('MISSING_IDEAL_CYCLE_TIME');
      issues.push({
        code: 'MISSING_IDEAL_CYCLE_TIME',
        severity: 'ERROR',
        messageFa:
          'زمان سیکل استاندارد (standardCycleTimeSec) یا حداکثر ضرب ماشین (maxStrokesPerMinute) تعریف نشده است؛ عملکرد و OEE جعل نمی‌شوند.',
      });
    } else if (coveredQty < totalProducedQty - 1e-4) {
      missingInputs.push('PARTIAL_IDEAL_CYCLE_COVERAGE');
      issues.push({
        code: 'PARTIAL_IDEAL_CYCLE_COVERAGE',
        severity: 'ERROR',
        messageFa: `تنها ${coveredQty} از ${totalProducedQty} عدد تولید دارای زمان سیکل استاندارد است؛ برای جلوگیری از خطای محاسبه، Performance محاسبه نشد.`,
      });
    } else {
      if (input.usedMachineSpmFallback) {
        issues.push({
          code: 'IDEAL_CYCLE_FROM_MACHINE_SPM',
          severity: 'INFO',
          messageFa:
            'زمان سیکل استاندارد عملیات ثبت نشده بود؛ از حداکثر ضرب در دقیقه اسمی ماشین (maxStrokesPerMinute) به‌عنوان مرجع سیکل استفاده شد.',
        });
      }
      rawPerformancePercent = round1((idealRunTimeMinutes / operatingTimeMinutes) * 100);
      if (rawPerformancePercent > 100.5) {
        performancePercent = 100;
        issues.push({
          code: 'PERFORMANCE_OVER_100_CHECK_CYCLE_TIME',
          severity: 'WARNING',
          messageFa: `عملکرد خام (${rawPerformancePercent}%) بیش از ۱۰۰٪ است؛ زمان سیکل استاندارد یا مدت کارکرد ثبت‌شده نیاز به بازبینی دارد (در محاسبه OEE در ۱۰۰٪ محدود شد).`,
        });
      } else {
        performancePercent = Math.min(100, Math.max(0, rawPerformancePercent));
      }
    }
  }

  // 4) OEE & TEEP (STRICT: ONLY when all three A, P, Q are valid)
  const oeeCalculable =
    availabilityPercent != null && performancePercent != null && qualityPercent != null;
  const oeePercent = oeeCalculable
    ? round1(((availabilityPercent! * performancePercent! * qualityPercent!) / 10000))
    : null;

  const teepPercent =
    oeePercent != null && scheduledTimeMinutes > 0
      ? round1(
          oeePercent *
            (effectivePlannedProductionTimeMinutes /
              Math.max(scheduledTimeMinutes, effectivePlannedProductionTimeMinutes)),
        )
      : null;

  // 5) Actual vs Planned Production
  const planVarianceQty = round2(goodQty - plannedQty);
  const planAdherencePercent = plannedQty > 0 ? round1((goodQty / plannedQty) * 100) : null;

  // 6) Explicit Data Quality Status
  const hasUnreliableIssue = issues.some(
    i =>
      i.code === 'PERFORMANCE_OVER_100_CHECK_CYCLE_TIME' ||
      i.code === 'TIME_OVERFLOW_EXCEEDS_SHIFT_DURATION' ||
      (i.code === 'MISSING_RUN_TIME' && totalProducedQty > 0),
  );
  const hasPartialIssue = issues.some(
    i => i.code === 'MISSING_SCHEDULED_SHIFT_TIME' || i.code === 'IDEAL_CYCLE_FROM_MACHINE_SPM',
  );

  let dataQualityStatus: OeeDataQualityStatus = 'RELIABLE';
  if (!oeeCalculable) {
    dataQualityStatus = hasUnreliableIssue ? 'UNRELIABLE' : 'INSUFFICIENT_DATA';
  } else if (hasUnreliableIssue) {
    dataQualityStatus = 'UNRELIABLE';
  } else if (hasPartialIssue) {
    dataQualityStatus = 'PARTIAL';
  }

  return {
    availabilityPercent,
    performancePercent,
    rawPerformancePercent,
    qualityPercent,
    oeePercent,
    teepPercent,
    oeeCalculable,
    scrapRatePercent,
    plannedQty,
    goodQty,
    scrapQty,
    reworkQty,
    rejectedQty,
    totalProducedQty,
    planVarianceQty,
    planAdherencePercent,
    idealCycleTimeSec,
    actualCycleTimeSec,
    time: {
      scheduledTimeMinutes,
      plannedDowntimeMinutes,
      plannedProductionTimeMinutes,
      effectivePlannedProductionTimeMinutes,
      setupTimeMinutes,
      unplannedDowntimeMinutes,
      availabilityLossMinutes,
      operatingTimeMinutes,
      idleUnassignedMinutes,
      idealRunTimeMinutes,
      scheduledTimeSource,
    },
    dataQualityStatus,
    dataQualityIssues: issues,
    missingInputs,
  };
}

// ============================================================================
// 3. NORMALIZED DATASET -> MULTI-DIMENSIONAL ANALYTICS AGGREGATOR
// ============================================================================

export interface OeeAnalyticsFilters {
  startDate?: string;
  endDate?: string;
  machineId?: string;
  shiftId?: string;
  operationId?: string;
  moId?: string;
  hall?: string;
}

export interface NormalizedMachineInput {
  id: string;
  code: string;
  name: string;
  hallLocation: string;
  machineType: string;
  tonnageCapacity: number | null;
  maxStrokesPerMinute: number | null;
  status: string;
}

export interface NormalizedShiftInput {
  id: string;
  code: string;
  name: string;
  productiveHours: number;
}

export interface NormalizedOperationInput {
  id: string;
  moId: string;
  moNumber: string;
  partId: string;
  partCode: string;
  partName: string;
  stepNumber: number;
  stepCode: string;
  stepName: string;
  plannedMachineId: string | null;
  plannedQty: number;
  standardCycleTimeSec: number;
  routeStandardCycleTimeSec: number;
  routeSetupTimeMin: number;
  status: string;
}

export interface NormalizedAnalyticsDataset {
  source: 'postgresql' | 'memory-fallback';
  machines: NormalizedMachineInput[];
  shifts: NormalizedShiftInput[];
  operations: NormalizedOperationInput[];
  reports: OeeSourceReportRecord[];
  downtimeEvents: OeeSourceDowntimeEvent[];
  assignments: OeeSourceAssignmentRecord[];
}

function resolveUniqueScheduledMinutes(
  assignments: OeeSourceAssignmentRecord[],
  reports: OeeSourceReportRecord[],
  shiftMinutesById: Map<string, number>,
): { scheduledTimeMinutes: number; scheduledTimeSource: ComputeOeeInput['scheduledTimeSource'] } {
  if (assignments.length > 0) {
    const slotMap = new Map<string, number>();
    for (const a of assignments) {
      if (a.status === 'CANCELLED') continue;
      const key = `${a.machineId}::${a.assignedDate}::${a.shiftId}`;
      const mins = a.productiveMinutes > 0 ? a.productiveMinutes : shiftMinutesById.get(a.shiftId) || 0;
      if (!slotMap.has(key) || mins > (slotMap.get(key) || 0)) {
        slotMap.set(key, mins);
      }
    }
    const total = Array.from(slotMap.values()).reduce((s, v) => s + v, 0);
    if (total > 0) return { scheduledTimeMinutes: round1(total), scheduledTimeSource: 'ASSIGNMENTS' };
  }

  if (reports.length > 0) {
    const slotMap = new Map<string, number>();
    for (const r of reports) {
      const mins = shiftMinutesById.get(r.shiftId) || 0;
      if (mins <= 0) continue;
      const key = `${r.machineId}::${r.dateKey}::${r.shiftId}`;
      if (!slotMap.has(key)) slotMap.set(key, mins);
    }
    const total = Array.from(slotMap.values()).reduce((s, v) => s + v, 0);
    if (total > 0) return { scheduledTimeMinutes: round1(total), scheduledTimeSource: 'REPORT_SHIFTS' };
  }

  return { scheduledTimeMinutes: 0, scheduledTimeSource: 'NONE' };
}

function aggregateBucketMetrics(params: {
  reports: OeeSourceReportRecord[];
  downtimes: OeeSourceDowntimeEvent[];
  assignments: OeeSourceAssignmentRecord[];
  plannedQty: number;
  shiftMinutesById: Map<string, number>;
}): OeeCoreMetrics {
  const { reports, downtimes, assignments, plannedQty, shiftMinutesById } = params;

  const operatingTimeMinutes = reports.reduce((s, r) => s + r.runTimeMinutes, 0);
  let plannedDowntimeMinutes = 0;
  let setupTimeMinutes = 0;
  let unplannedDowntimeMinutes = 0;

  for (const dt of downtimes) {
    if (dt.category === 'PLANNED') plannedDowntimeMinutes += dt.durationMinutes;
    else if (dt.category === 'SETUP') setupTimeMinutes += dt.durationMinutes;
    else unplannedDowntimeMinutes += dt.durationMinutes;
  }

  const goodQty = reports.reduce((s, r) => s + r.goodQty, 0);
  const scrapQty = reports.reduce((s, r) => s + r.scrapQty, 0);
  const reworkQty = reports.reduce((s, r) => s + r.reworkQty, 0);
  const rejectedQty = reports.reduce((s, r) => s + r.rejectedQty, 0);

  let idealRunTimeMinutes = 0;
  let idealCycleCoveredQty = 0;
  let usedMachineSpmFallback = false;

  for (const r of reports) {
    if (r.totalProducedQty > 0 && r.idealCycleTimeSec != null && r.idealCycleTimeSec > 0) {
      idealRunTimeMinutes += (r.totalProducedQty * r.idealCycleTimeSec) / 60;
      idealCycleCoveredQty += r.totalProducedQty;
      if (r.idealCycleSource === 'MACHINE_SPM') usedMachineSpmFallback = true;
    }
  }

  const { scheduledTimeMinutes, scheduledTimeSource } = resolveUniqueScheduledMinutes(
    assignments,
    reports,
    shiftMinutesById,
  );

  return computeOeeMetrics({
    scheduledTimeMinutes,
    scheduledTimeSource,
    operatingTimeMinutes,
    plannedDowntimeMinutes,
    setupTimeMinutes,
    unplannedDowntimeMinutes,
    plannedQty,
    goodQty,
    scrapQty,
    reworkQty,
    rejectedQty,
    idealRunTimeMinutes,
    idealCycleCoveredQty,
    usedMachineSpmFallback,
  });
}

function resolveShiftFilterMatch(shift: { id: string; code: string; name: string }, shiftFilter: string): boolean {
  const norm = shiftFilter.trim().toUpperCase();
  if (!norm || norm === 'ALL') return true;
  if (shift.id.toUpperCase() === norm || shift.code.toUpperCase() === norm) return true;
  if (norm === 'MORNING' && (shift.code.toUpperCase().includes('MORN') || shift.name.includes('صبح'))) return true;
  if (norm === 'EVENING' && (shift.code.toUpperCase().includes('EVE') || shift.name.includes('عصر'))) return true;
  if (norm === 'NIGHT' && (shift.code.toUpperCase().includes('NIGHT') || shift.name.includes('شب'))) return true;
  return false;
}

export function computeOeeAnalyticsFromNormalizedInputs(
  dataset: NormalizedAnalyticsDataset,
  filters: OeeAnalyticsFilters = {},
): OeeAnalyticsResponse {
  const startKey = filters.startDate?.trim() ? filters.startDate.trim().slice(0, 10) : null;
  const endKey = filters.endDate?.trim() ? filters.endDate.trim().slice(0, 10) : null;
  const machineFilter = filters.machineId && filters.machineId !== 'ALL' ? filters.machineId.trim() : null;
  const shiftFilter = filters.shiftId && filters.shiftId !== 'ALL' ? filters.shiftId.trim() : null;
  const opFilter = filters.operationId && filters.operationId !== 'ALL' ? filters.operationId.trim() : null;
  const moFilter = filters.moId && filters.moId !== 'ALL' ? filters.moId.trim() : null;
  const hallFilter = filters.hall && filters.hall !== 'ALL' ? filters.hall.trim() : null;

  const shiftById = new Map(dataset.shifts.map(s => [s.id, s]));
  const shiftMinutesById = new Map(
    dataset.shifts.map(s => [s.id, round1((s.productiveHours > 0 ? s.productiveHours : 0) * 60)]),
  );
  const opById = new Map(dataset.operations.map(o => [o.id, o]));

  const filteredMachines = dataset.machines.filter(m => {
    if (machineFilter && m.id !== machineFilter && m.code !== machineFilter) return false;
    if (hallFilter && !m.hallLocation.includes(hallFilter)) return false;
    return true;
  });
  const allowedMachineIds = new Set(filteredMachines.map(m => m.id));

  const matchesShiftId = (shiftId: string | null): boolean => {
    if (!shiftFilter) return true;
    if (!shiftId) return false;
    const sh = shiftById.get(shiftId);
    if (sh) return resolveShiftFilterMatch(sh, shiftFilter);
    return shiftId === shiftFilter;
  };

  const inDateRange = (dateKey: string): boolean => {
    if (startKey && dateKey < startKey) return false;
    if (endKey && dateKey > endKey) return false;
    return true;
  };

  const reports = dataset.reports.filter(r => {
    if (!inDateRange(r.dateKey)) return false;
    if ((machineFilter || hallFilter) && !allowedMachineIds.has(r.machineId)) return false;
    if (!matchesShiftId(r.shiftId)) return false;
    if (opFilter && r.operationId !== opFilter && r.stepCode !== opFilter) return false;
    if (moFilter && r.moId !== moFilter && r.moNumber !== moFilter) return false;
    return true;
  });

  const downtimeEvents = dataset.downtimeEvents.filter(d => {
    if (!inDateRange(d.dateKey)) return false;
    if ((machineFilter || hallFilter) && (!d.machineId || !allowedMachineIds.has(d.machineId))) return false;
    if (shiftFilter && !matchesShiftId(d.shiftId)) return false;
    if (opFilter && d.operationId !== opFilter && d.stepCode !== opFilter) return false;
    if (moFilter && d.moId !== moFilter && d.moNumber !== moFilter) return false;
    return true;
  });

  const assignments = dataset.assignments.filter(a => {
    if (a.status === 'CANCELLED') return false;
    if (!inDateRange(a.assignedDate)) return false;
    if ((machineFilter || hallFilter) && !allowedMachineIds.has(a.machineId)) return false;
    if (!matchesShiftId(a.shiftId)) return false;
    if (opFilter && a.productionOperationId !== opFilter && a.stepCode !== opFilter) return false;
    if (moFilter && a.moId !== moFilter && a.moNumber !== moFilter) return false;
    return true;
  });

  // 1) BY MACHINE
  const machines: OeeAnalyticsMachineRow[] = filteredMachines.map(m => {
    const mReports = reports.filter(r => r.machineId === m.id);
    const mDowntimes = downtimeEvents.filter(d => d.machineId === m.id);
    const mAssignments = assignments.filter(a => a.machineId === m.id);

    const touchedOpIds = new Set<string>();
    for (const r of mReports) touchedOpIds.add(r.operationId);
    for (const a of mAssignments) touchedOpIds.add(a.productionOperationId);

    const machinePlannedQty = Array.from(touchedOpIds).reduce(
      (s, opId) => s + (opById.get(opId)?.plannedQty || 0),
      0,
    );

    const metrics = aggregateBucketMetrics({
      reports: mReports,
      downtimes: mDowntimes,
      assignments: mAssignments,
      plannedQty: machinePlannedQty,
      shiftMinutesById,
    });

    const unplannedEvents = mDowntimes.filter(d => d.category === 'UNPLANNED');
    const mttrMinutes =
      unplannedEvents.length > 0
        ? round1(metrics.time.unplannedDowntimeMinutes / unplannedEvents.length)
        : null;
    const mtbfMinutes =
      unplannedEvents.length > 0 && metrics.time.operatingTimeMinutes > 0
        ? round1(metrics.time.operatingTimeMinutes / unplannedEvents.length)
        : null;

    return {
      machineId: m.id,
      machineCode: m.code,
      machineName: m.name,
      hallLocation: m.hallLocation,
      machineType: m.machineType,
      tonnageCapacity: m.tonnageCapacity,
      maxStrokesPerMinute: m.maxStrokesPerMinute,
      status: m.status,
      reportsCount: mReports.length,
      downtimeEventsCount: mDowntimes.length,
      assignmentsCount: mAssignments.length,
      operationsCount: touchedOpIds.size,
      mtbfMinutes,
      mttrMinutes,
      sourceReportIds: mReports.map(r => r.id),
      sourceDowntimeIds: mDowntimes.map(d => d.id),
      sourceAssignmentIds: mAssignments.map(a => a.id),
      ...metrics,
    };
  });

  // 2) BY SHIFT
  const activeShifts = dataset.shifts.filter(s => !shiftFilter || resolveShiftFilterMatch(s, shiftFilter));
  const byShift: OeeAnalyticsShiftRow[] = activeShifts.map(sh => {
    const sReports = reports.filter(r => r.shiftId === sh.id);
    const sDowntimes = downtimeEvents.filter(d => d.shiftId === sh.id);
    const sAssignments = assignments.filter(a => a.shiftId === sh.id);

    const touchedOpIds = new Set<string>();
    for (const r of sReports) touchedOpIds.add(r.operationId);
    for (const a of sAssignments) touchedOpIds.add(a.productionOperationId);
    const shiftPlannedQty = Array.from(touchedOpIds).reduce(
      (s, opId) => s + (opById.get(opId)?.plannedQty || 0),
      0,
    );

    const metrics = aggregateBucketMetrics({
      reports: sReports,
      downtimes: sDowntimes,
      assignments: sAssignments,
      plannedQty: shiftPlannedQty,
      shiftMinutesById,
    });

    const machineIds = new Set<string>([
      ...sReports.map(r => r.machineId),
      ...sAssignments.map(a => a.machineId),
    ]);

    return {
      shiftId: sh.id,
      shiftCode: sh.code,
      shiftName: sh.name,
      productiveHoursPerShift: sh.productiveHours,
      reportsCount: sReports.length,
      downtimeEventsCount: sDowntimes.length,
      machinesCount: machineIds.size,
      ...metrics,
    };
  });

  // 3) BY OPERATION
  const opIdsInScope = new Set<string>();
  for (const r of reports) opIdsInScope.add(r.operationId);
  for (const a of assignments) opIdsInScope.add(a.productionOperationId);
  for (const d of downtimeEvents) {
    if (d.operationId) opIdsInScope.add(d.operationId);
  }
  const machineById = new Map(dataset.machines.map(m => [m.id, m]));

  const byOperation: OeeAnalyticsOperationRow[] = Array.from(opIdsInScope)
    .map(opId => {
      const op = opById.get(opId);
      const oReports = reports.filter(r => r.operationId === opId);
      const oDowntimes = downtimeEvents.filter(d => d.operationId === opId);
      const oAssignments = assignments.filter(a => a.productionOperationId === opId);
      const firstReport = oReports[0];
      const effMachineId =
        firstReport?.machineId || oAssignments[0]?.machineId || op?.plannedMachineId || null;
      const effMachine = effMachineId ? machineById.get(effMachineId) : null;

      const metrics = aggregateBucketMetrics({
        reports: oReports,
        downtimes: oDowntimes,
        assignments: oAssignments,
        plannedQty: op?.plannedQty || 0,
        shiftMinutesById,
      });

      return {
        operationId: opId,
        moId: op?.moId || firstReport?.moId || '',
        moNumber: op?.moNumber || firstReport?.moNumber || '',
        partId: op?.partId || firstReport?.partId || '',
        partCode: op?.partCode || firstReport?.partCode || '',
        partName: op?.partName || firstReport?.partName || '',
        stepNumber: op?.stepNumber || firstReport?.stepNumber || 0,
        stepCode: op?.stepCode || firstReport?.stepCode || '',
        stepName: op?.stepName || firstReport?.stepName || '',
        machineId: effMachineId,
        machineCode: effMachine?.code || firstReport?.machineCode || null,
        machineName: effMachine?.name || firstReport?.machineName || null,
        operationStatus: op?.status || 'UNKNOWN',
        plannedRouteSetupMinutes: op?.routeSetupTimeMin || 0,
        reportsCount: oReports.length,
        downtimeEventsCount: oDowntimes.length,
        sourceReportIds: oReports.map(r => r.id),
        ...metrics,
      };
    })
    .sort((a, b) => `${a.moNumber}-${String(a.stepNumber).padStart(4, '0')}`.localeCompare(`${b.moNumber}-${String(b.stepNumber).padStart(4, '0')}`));

  // 4) BY DATE
  const dateKeys = new Set<string>();
  for (const r of reports) dateKeys.add(r.dateKey);
  for (const d of downtimeEvents) dateKeys.add(d.dateKey);
  for (const a of assignments) dateKeys.add(a.assignedDate);

  const byDate: OeeAnalyticsDailyRow[] = Array.from(dateKeys)
    .sort()
    .map(dateKey => {
      const dReports = reports.filter(r => r.dateKey === dateKey);
      const dDowntimes = downtimeEvents.filter(d => d.dateKey === dateKey);
      const dAssignments = assignments.filter(a => a.assignedDate === dateKey);

      const touchedOpIds = new Set<string>();
      for (const r of dReports) touchedOpIds.add(r.operationId);
      for (const a of dAssignments) touchedOpIds.add(a.productionOperationId);
      const dayPlannedQty = Array.from(touchedOpIds).reduce(
        (s, opId) => s + (opById.get(opId)?.plannedQty || 0),
        0,
      );

      const metrics = aggregateBucketMetrics({
        reports: dReports,
        downtimes: dDowntimes,
        assignments: dAssignments,
        plannedQty: dayPlannedQty,
        shiftMinutesById,
      });

      const activeMachines = new Set<string>([
        ...dReports.map(r => r.machineId),
        ...dAssignments.map(a => a.machineId),
      ]);

      return {
        date: dateKey,
        reportsCount: dReports.length,
        downtimeEventsCount: dDowntimes.length,
        activeMachinesCount: activeMachines.size,
        ...metrics,
      };
    });

  // 5) PLANT-LEVEL WEIGHTED SUMMARY (exact aggregation across all filtered source records)
  const allTouchedOpIds = new Set<string>();
  for (const r of reports) allTouchedOpIds.add(r.operationId);
  for (const a of assignments) allTouchedOpIds.add(a.productionOperationId);
  const plantPlannedQty = Array.from(allTouchedOpIds).reduce(
    (s, opId) => s + (opById.get(opId)?.plannedQty || 0),
    0,
  );

  const plantCore = aggregateBucketMetrics({
    reports,
    downtimes: downtimeEvents,
    assignments,
    plannedQty: plantPlannedQty,
    shiftMinutesById,
  });

  // 6) DOWNTIME SUMMARY (deduplicated, categorized)
  const catMeta: Record<OeeDowntimeCategory, { labelFa: string; minutes: number; eventsCount: number }> = {
    UNPLANNED: { labelFa: 'توقفات برنامه‌ریزی‌نشده و خرابی (Unplanned)', minutes: 0, eventsCount: 0 },
    SETUP: { labelFa: 'ستاپ، تعویض قالب و تنظیمات (Setup / SMED)', minutes: 0, eventsCount: 0 },
    PLANNED: { labelFa: 'توقفات برنامه‌ریزی‌شده و نت پیشگیرانه (Planned PM)', minutes: 0, eventsCount: 0 },
  };
  const reasonMap = new Map<string, { reason: string; category: OeeDowntimeCategory; minutes: number; eventsCount: number }>();

  for (const dt of downtimeEvents) {
    catMeta[dt.category].minutes = round1(catMeta[dt.category].minutes + dt.durationMinutes);
    catMeta[dt.category].eventsCount += 1;

    const rKey = `${dt.category}::${dt.reason}`;
    const prev = reasonMap.get(rKey) || {
      reason: dt.reason,
      category: dt.category,
      minutes: 0,
      eventsCount: 0,
    };
    prev.minutes = round1(prev.minutes + dt.durationMinutes);
    prev.eventsCount += 1;
    reasonMap.set(rKey, prev);
  }

  const totalDtMin = round1(
    catMeta.UNPLANNED.minutes + catMeta.SETUP.minutes + catMeta.PLANNED.minutes,
  );
  const dtDenom = totalDtMin > 0 ? totalDtMin : 1;

  const downtimeSummary: OeeDowntimeSummary = {
    totalDowntimeMinutes: totalDtMin,
    plannedDowntimeMinutes: catMeta.PLANNED.minutes,
    setupTimeMinutes: catMeta.SETUP.minutes,
    unplannedDowntimeMinutes: catMeta.UNPLANNED.minutes,
    byCategory: (['UNPLANNED', 'SETUP', 'PLANNED'] as OeeDowntimeCategory[]).map(cat => ({
      category: cat,
      labelFa: catMeta[cat].labelFa,
      minutes: catMeta[cat].minutes,
      eventsCount: catMeta[cat].eventsCount,
      sharePercent: totalDtMin > 0 ? round1((catMeta[cat].minutes / dtDenom) * 100) : 0,
    })),
    byReason: Array.from(reasonMap.values())
      .map(r => ({
        ...r,
        sharePercent: totalDtMin > 0 ? round1((r.minutes / dtDenom) * 100) : 0,
      }))
      .sort((a, b) => b.minutes - a.minutes),
  };

  // 7) DATA QUALITY OVERVIEW
  const reliableCount = machines.filter(m => m.dataQualityStatus === 'RELIABLE').length;
  const partialCount = machines.filter(m => m.dataQualityStatus === 'PARTIAL').length;
  const unreliableCount = machines.filter(m => m.dataQualityStatus === 'UNRELIABLE').length;
  const insufficientCount = machines.filter(m => m.dataQualityStatus === 'INSUFFICIENT_DATA').length;

  const uniqueIssuesMap = new Map<string, OeeDataQualityIssue>();
  for (const iss of plantCore.dataQualityIssues) {
    uniqueIssuesMap.set(iss.code, iss);
  }
  for (const m of machines) {
    for (const iss of m.dataQualityIssues) {
      if (!uniqueIssuesMap.has(iss.code)) uniqueIssuesMap.set(iss.code, iss);
    }
  }

  const halls = Array.from(new Set(dataset.machines.map(m => m.hallLocation).filter(Boolean)));

  return {
    source: dataset.source,
    generatedAt: new Date().toISOString(),
    filters: {
      startDate: startKey,
      endDate: endKey,
      machineId: machineFilter,
      shiftId: shiftFilter,
      operationId: opFilter,
      moId: moFilter,
      hall: hallFilter,
    },
    summary: {
      ...plantCore,
      totalMachinesCount: machines.length,
      machinesWithReliableOeeCount: reliableCount,
      machinesWithPartialOrUnreliableOeeCount: partialCount + unreliableCount,
      machinesWithInsufficientDataCount: insufficientCount,
      totalReportsCount: reports.length,
      totalDowntimeEventsCount: downtimeEvents.length,
      totalAssignmentsCount: assignments.length,
      worldClassBenchmarkOee: 85.0,
    },
    dataQualityOverview: {
      status: plantCore.dataQualityStatus,
      reliableCount,
      partialCount,
      unreliableCount,
      insufficientCount,
      issues: Array.from(uniqueIssuesMap.values()),
    },
    downtimeSummary,
    machines,
    byShift,
    byOperation,
    byDate,
    sourceRecords: {
      productionReports: reports.sort(
        (a, b) => new Date(b.reportDate).getTime() - new Date(a.reportDate).getTime(),
      ),
      downtimeEvents: downtimeEvents.sort(
        (a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime(),
      ),
      machineAssignments: assignments,
    },
    masterData: {
      machines: dataset.machines.map(m => ({
        id: m.id,
        code: m.code,
        name: m.name,
        hallLocation: m.hallLocation,
        status: m.status,
      })),
      shifts: dataset.shifts,
      halls,
    },
    formulas: OEE_FORMULAS_REFERENCE,
  };
}

// ============================================================================
// 4. POSTGRESQL RELATIONAL LOADER (READ-ONLY)
// ============================================================================

export async function getRelationalOeeAnalytics(
  filters: OeeAnalyticsFilters = {},
): Promise<OeeAnalyticsResponse> {
  const prisma = __getProductionWipPrisma();

  const [machinesRaw, shiftsRaw, opsRaw, reportsRaw, assignmentsRaw, downtimeAuditsRaw] =
    await Promise.all([
      prisma.machine.findMany({ orderBy: { code: 'asc' } }),
      typeof prisma.shift?.findMany === 'function'
        ? prisma.shift.findMany({ where: { active: true }, orderBy: { startTime: 'asc' } })
        : Promise.resolve([]),
      typeof prisma.productionOperation?.findMany === 'function'
        ? prisma.productionOperation.findMany({
            include: {
              operation: true,
              routeOperation: true,
              manufacturingOrder: { include: { part: true } },
            },
          })
        : Promise.resolve([]),
      typeof prisma.productionReport?.findMany === 'function'
        ? prisma.productionReport.findMany({
            include: {
              machine: true,
              shift: true,
              operatorUser: true,
              manufacturingOrder: { include: { part: true } },
              productionOperation: {
                include: {
                  operation: true,
                  routeOperation: true,
                },
              },
            },
            orderBy: { reportDate: 'desc' },
          })
        : Promise.resolve([]),
      typeof prisma.machineAssignment?.findMany === 'function'
        ? prisma.machineAssignment.findMany({
            where: { status: { not: 'CANCELLED' } },
            include: {
              machine: true,
              shift: true,
              productionOperation: { include: { manufacturingOrder: true } },
            },
          })
        : Promise.resolve([]),
      typeof prisma.auditLog?.findMany === 'function'
        ? prisma.auditLog.findMany({
            where: { action: 'SHOP_FLOOR_DOWNTIME' },
            orderBy: { timestamp: 'desc' },
          })
        : Promise.resolve([]),
    ]);

  const machines: NormalizedMachineInput[] = (machinesRaw || []).map((m: any) => ({
    id: m.id,
    code: m.code,
    name: m.name,
    hallLocation: m.hallLocation || 'سالن تولید',
    machineType: m.machineType || 'PRESS',
    tonnageCapacity: m.tonnageCapacity != null ? num(m.tonnageCapacity) : null,
    maxStrokesPerMinute: m.maxStrokesPerMinute != null ? num(m.maxStrokesPerMinute) : null,
    status: m.status || 'ACTIVE',
  }));
  const machineById = new Map(machines.map(m => [m.id, m]));

  const shifts: NormalizedShiftInput[] = (shiftsRaw || []).map((s: any) => ({
    id: s.id,
    code: s.code,
    name: s.name,
    productiveHours: num(s.productiveHours),
  }));
  const shiftById = new Map(shifts.map(s => [s.id, s]));

  const operations: NormalizedOperationInput[] = (opsRaw || []).map((op: any) => ({
    id: op.id,
    moId: op.manufacturingOrderId,
    moNumber: op.manufacturingOrder?.moNumber || '',
    partId: op.manufacturingOrder?.partId || '',
    partCode: op.manufacturingOrder?.part?.partNumber || '',
    partName: op.manufacturingOrder?.part?.name || '',
    stepNumber: Number(op.stepNumber || 0),
    stepCode: op.stepCode || op.operation?.code || `OP${op.stepNumber}`,
    stepName: op.stepName || op.operation?.name || '',
    plannedMachineId: op.plannedMachineId || null,
    plannedQty: num(op.plannedQty),
    standardCycleTimeSec: Number(op.standardCycleTimeSec || 0),
    routeStandardCycleTimeSec: Number(op.routeOperation?.standardCycleTimeSec || 0),
    routeSetupTimeMin: Number(op.routeOperation?.setupTimeMin || 0),
    status: op.status || 'PENDING',
  }));
  const opById = new Map(operations.map(o => [o.id, o]));

  const normalizedReports: OeeSourceReportRecord[] = [];
  const normalizedDowntimes: OeeSourceDowntimeEvent[] = [];

  for (const r of reportsRaw || []) {
    const m = machineById.get(r.machineId);
    const sh = shiftById.get(r.shiftId);
    const op = opById.get(r.productionOperationId);

    const goodQty = num(r.goodQuantity);
    const scrapQty = num(r.scrapQuantity);
    const reworkQty = num(r.reworkQuantity);
    const rejectedQty = num(r.rejectedQuantity);
    const totalProducedQty = round2(goodQty + scrapQty + reworkQty + rejectedQty);
    const runTimeMinutes = Math.max(0, num(r.runTimeMinutes));
    const downtimeMinutes = Math.max(0, num(r.downtimeMinutes));

    // Resolve ideal cycle time strictly from master data
    const opCycle =
      Number(r.productionOperation?.standardCycleTimeSec || 0) || (op?.standardCycleTimeSec || 0);
    const routeCycle =
      Number(r.productionOperation?.routeOperation?.standardCycleTimeSec || 0) ||
      (op?.routeStandardCycleTimeSec || 0);
    const machineSpm = m?.maxStrokesPerMinute || num(r.machine?.maxStrokesPerMinute);

    let idealCycleTimeSec: number | null = null;
    let idealCycleSource: OeeSourceReportRecord['idealCycleSource'] = 'MISSING';
    if (opCycle > 0) {
      idealCycleTimeSec = opCycle;
      idealCycleSource = 'OPERATION';
    } else if (routeCycle > 0) {
      idealCycleTimeSec = routeCycle;
      idealCycleSource = 'ROUTE';
    } else if (machineSpm > 0) {
      idealCycleTimeSec = round2(60 / machineSpm);
      idealCycleSource = 'MACHINE_SPM';
    }

    const dataFlags: string[] = [];
    if (totalProducedQty > 0 && runTimeMinutes <= 0) dataFlags.push('MISSING_RUN_TIME');
    if (totalProducedQty > 0 && idealCycleTimeSec == null) dataFlags.push('MISSING_IDEAL_CYCLE_TIME');
    if (idealCycleSource === 'MACHINE_SPM') dataFlags.push('IDEAL_CYCLE_FROM_MACHINE_SPM');

    let reportPerformancePercent: number | null = null;
    if (totalProducedQty > 0 && runTimeMinutes > 0 && idealCycleTimeSec != null && idealCycleTimeSec > 0) {
      reportPerformancePercent = round1((((totalProducedQty * idealCycleTimeSec) / 60) / runTimeMinutes) * 100);
      if (reportPerformancePercent > 100.5) dataFlags.push('PERFORMANCE_OVER_100');
    }

    const reportIso = toIsoSafe(r.reportDate || r.createdAt);
    const dateKey = reportIso.slice(0, 10);
    const dtCategory =
      downtimeMinutes > 0 ? classifyDowntimeCategory(r.downtimeReason) : null;

    normalizedReports.push({
      id: r.id,
      reportNumber: r.reportNumber || r.id,
      reportDate: reportIso,
      dateKey,
      moId: r.manufacturingOrderId,
      moNumber: r.manufacturingOrder?.moNumber || op?.moNumber || '',
      partId: r.manufacturingOrder?.partId || op?.partId || '',
      partCode: r.manufacturingOrder?.part?.partNumber || op?.partCode || '',
      partName: r.manufacturingOrder?.part?.name || op?.partName || '',
      operationId: r.productionOperationId,
      stepNumber: Number(r.productionOperation?.stepNumber || op?.stepNumber || 0),
      stepCode: r.productionOperation?.stepCode || op?.stepCode || '',
      stepName: r.productionOperation?.stepName || op?.stepName || '',
      machineId: r.machineId,
      machineCode: m?.code || r.machine?.code || r.machineId,
      machineName: m?.name || r.machine?.name || '',
      hallLocation: m?.hallLocation || r.machine?.hallLocation || 'سالن تولید',
      shiftId: r.shiftId,
      shiftCode: sh?.code || r.shift?.code || r.shiftId,
      shiftName: sh?.name || r.shift?.name || '',
      operatorName: r.operatorUser?.fullName || 'اپراتور خط',
      goodQty,
      scrapQty,
      reworkQty,
      rejectedQty,
      totalProducedQty,
      runTimeMinutes,
      downtimeMinutes,
      downtimeReason: r.downtimeReason || null,
      downtimeCategory: dtCategory,
      strokeCounterStart: r.strokeCounterStart ?? null,
      strokeCounterEnd: r.strokeCounterEnd ?? null,
      idealCycleTimeSec,
      idealCycleSource,
      reportPerformancePercent,
      dataFlags,
    });

    if (downtimeMinutes > 0 && dtCategory) {
      normalizedDowntimes.push({
        id: `RPT-DT-${r.id}`,
        source: 'PRODUCTION_REPORT',
        category: dtCategory,
        machineId: r.machineId,
        machineCode: m?.code || r.machine?.code || r.machineId,
        machineName: m?.name || r.machine?.name || '',
        hallLocation: m?.hallLocation || r.machine?.hallLocation || 'سالن تولید',
        moId: r.manufacturingOrderId,
        moNumber: r.manufacturingOrder?.moNumber || op?.moNumber || null,
        operationId: r.productionOperationId,
        stepCode: r.productionOperation?.stepCode || op?.stepCode || null,
        shiftId: r.shiftId,
        shiftName: sh?.name || r.shift?.name || null,
        reason: r.downtimeReason || 'توقف ثبت‌شده در گزارش تولید',
        durationMinutes: downtimeMinutes,
        recordedAt: reportIso,
        dateKey,
        recordedBy: r.operatorUser?.fullName || 'اپراتور خط',
      });
    }
  }

  // Deduplicated standalone AuditLog SHOP_FLOOR_DOWNTIME rows (skip rows referencing productionReportId)
  for (const a of downtimeAuditsRaw || []) {
    if (a.action !== 'SHOP_FLOOR_DOWNTIME') continue;
    const nv = a.newValues || {};
    if (nv.productionReportId) continue; // Already included via ProductionReport above!
    const durationMinutes = Math.max(0, num(nv.durationMinutes));
    if (durationMinutes <= 0) continue;

    const mId = nv.machineId || a.entityId || null;
    const m = mId ? machineById.get(mId) : null;
    const sh = nv.shiftId ? shiftById.get(nv.shiftId) : null;
    const recIso = toIsoSafe(a.timestamp);
    const cat = classifyDowntimeCategory(nv.reason, {
      explicitCategory: nv.category,
      markMachineBreakdown: Boolean(nv.markMachineBreakdown),
    });

    normalizedDowntimes.push({
      id: a.id,
      source: 'STANDALONE_DOWNTIME',
      category: cat,
      machineId: mId,
      machineCode: m?.code || nv.machineCode || String(mId || ''),
      machineName: m?.name || nv.machineName || 'ماشین',
      hallLocation: m?.hallLocation || 'سالن تولید',
      moId: nv.manufacturingOrderId || null,
      moNumber: nv.moNumber || null,
      operationId: nv.productionOperationId || null,
      stepCode: nv.stepCode || null,
      shiftId: nv.shiftId || null,
      shiftName: sh?.name || nv.shiftName || null,
      reason: nv.reason || 'توقف ثبت‌شده کارگاه',
      durationMinutes,
      recordedAt: recIso,
      dateKey: recIso.slice(0, 10),
      recordedBy: nv.operatorName || 'اپراتور خط',
    });
  }

  const normalizedAssignments: OeeSourceAssignmentRecord[] = (assignmentsRaw || []).map((a: any) => {
    const m = machineById.get(a.machineId);
    const sh = shiftById.get(a.shiftId);
    const op = opById.get(a.productionOperationId);
    return {
      id: a.id,
      machineId: a.machineId,
      machineCode: m?.code || a.machine?.code || a.machineId,
      machineName: m?.name || a.machine?.name || '',
      productionOperationId: a.productionOperationId,
      moId: a.productionOperation?.manufacturingOrderId || op?.moId || '',
      moNumber: a.productionOperation?.manufacturingOrder?.moNumber || op?.moNumber || '',
      stepCode: a.productionOperation?.stepCode || op?.stepCode || '',
      shiftId: a.shiftId,
      shiftCode: sh?.code || a.shift?.code || a.shiftId,
      shiftName: sh?.name || a.shift?.name || '',
      assignedDate: toDateKey(a.assignedDate),
      productiveMinutes: round1(num(sh?.productiveHours ?? a.shift?.productiveHours) * 60),
      status: a.status || 'SCHEDULED',
    };
  });

  return computeOeeAnalyticsFromNormalizedInputs(
    {
      source: 'postgresql',
      machines,
      shifts,
      operations,
      reports: normalizedReports,
      downtimeEvents: normalizedDowntimes,
      assignments: normalizedAssignments,
    },
    filters,
  );
}

// ============================================================================
// 5. IN-MEMORY FALLBACK PARITY LOADER (EXACT SAME CALCULATION CORE)
// ============================================================================

export function getFallbackOeeAnalytics(
  machinesStore: Machine[],
  filters: OeeAnalyticsFilters = {},
): OeeAnalyticsResponse {
  const fb = getFallbackShopFloorRawStores();

  const machines: NormalizedMachineInput[] = machinesStore.map(m => ({
    id: m.id,
    code: m.code,
    name: m.name,
    hallLocation: m.location || 'سالن تولید',
    machineType: m.processType || 'PRESS',
    tonnageCapacity: m.tonnage ?? null,
    maxStrokesPerMinute: m.strokesPerMinute ?? null,
    status: m.status || 'ACTIVE',
  }));
  const machineById = new Map(machines.map(m => [m.id, m]));

  const shifts: NormalizedShiftInput[] = fb.shifts.map(s => ({
    id: s.id,
    code: s.code,
    name: s.name,
    productiveHours: s.productiveHours,
  }));
  const shiftById = new Map(shifts.map(s => [s.id, s]));

  const operations: NormalizedOperationInput[] = [];
  for (const mo of manufacturingOrdersStore) {
    if (mo.status === 'CANCELLED') continue;
    for (const op of mo.operations || []) {
      operations.push({
        id: op.id,
        moId: mo.id,
        moNumber: mo.moNumber,
        partId: mo.partId,
        partCode: mo.partCode,
        partName: mo.partName,
        stepNumber: op.stepNumber,
        stepCode: op.stepCode,
        stepName: op.stepName,
        plannedMachineId: op.machineId || null,
        plannedQty: num((op as any).plannedQuantity || mo.targetQuantity),
        standardCycleTimeSec: Number((op as any).standardCycleTimeSec || 0),
        routeStandardCycleTimeSec: 0,
        routeSetupTimeMin: 0,
        status: op.status,
      });
    }
  }
  const opById = new Map(operations.map(o => [o.id, o]));

  const normalizedReports: OeeSourceReportRecord[] = [];
  const normalizedDowntimes: OeeSourceDowntimeEvent[] = [];

  for (const r of fb.reports) {
    const m = r.machineId ? machineById.get(r.machineId) : null;
    const sh = shiftById.get(r.shiftId) || shifts[0];
    const op = opById.get(r.operationId);

    const goodQty = num(r.goodQty);
    const scrapQty = num(r.scrapQty);
    const reworkQty = num(r.reworkQty);
    const rejectedQty = num(r.rejectedQty);
    const totalProducedQty = round2(goodQty + scrapQty + reworkQty + rejectedQty);
    const runTimeMinutes = Math.max(0, num(r.runTimeMinutes));
    const downtimeMinutes = Math.max(0, num(r.downtimeMinutes));

    let idealCycleTimeSec: number | null = null;
    let idealCycleSource: OeeSourceReportRecord['idealCycleSource'] = 'MISSING';
    if (op && op.standardCycleTimeSec > 0) {
      idealCycleTimeSec = op.standardCycleTimeSec;
      idealCycleSource = 'OPERATION';
    } else if (m?.maxStrokesPerMinute && m.maxStrokesPerMinute > 0) {
      idealCycleTimeSec = round2(60 / m.maxStrokesPerMinute);
      idealCycleSource = 'MACHINE_SPM';
    }

    const dataFlags: string[] = [];
    if (totalProducedQty > 0 && runTimeMinutes <= 0) dataFlags.push('MISSING_RUN_TIME');
    if (totalProducedQty > 0 && idealCycleTimeSec == null) dataFlags.push('MISSING_IDEAL_CYCLE_TIME');
    if (idealCycleSource === 'MACHINE_SPM') dataFlags.push('IDEAL_CYCLE_FROM_MACHINE_SPM');

    let reportPerformancePercent: number | null = null;
    if (totalProducedQty > 0 && runTimeMinutes > 0 && idealCycleTimeSec != null && idealCycleTimeSec > 0) {
      reportPerformancePercent = round1((((totalProducedQty * idealCycleTimeSec) / 60) / runTimeMinutes) * 100);
      if (reportPerformancePercent > 100.5) dataFlags.push('PERFORMANCE_OVER_100');
    }

    const reportIso = toIsoSafe(r.reportDate || r.createdAt);
    const dateKey = reportIso.slice(0, 10);
    const dtCategory = downtimeMinutes > 0 ? classifyDowntimeCategory(r.downtimeReason) : null;

    normalizedReports.push({
      id: r.id,
      reportNumber: r.reportNumber || r.id,
      reportDate: reportIso,
      dateKey,
      moId: r.moId,
      moNumber: r.moNumber || op?.moNumber || '',
      partId: op?.partId || '',
      partCode: r.partCode || op?.partCode || '',
      partName: r.partName || op?.partName || '',
      operationId: r.operationId,
      stepNumber: op?.stepNumber || 0,
      stepCode: r.stepCode || op?.stepCode || '',
      stepName: r.stepName || op?.stepName || '',
      machineId: r.machineId || '',
      machineCode: m?.code || r.machineId || '',
      machineName: m?.name || '',
      hallLocation: m?.hallLocation || 'سالن تولید',
      shiftId: sh?.id || r.shiftId || '',
      shiftCode: sh?.code || '',
      shiftName: sh?.name || '',
      operatorName: r.operatorName || 'اپراتور خط',
      goodQty,
      scrapQty,
      reworkQty,
      rejectedQty,
      totalProducedQty,
      runTimeMinutes,
      downtimeMinutes,
      downtimeReason: r.downtimeReason || null,
      downtimeCategory: dtCategory,
      strokeCounterStart: r.strokeCounterStart ?? null,
      strokeCounterEnd: r.strokeCounterEnd ?? null,
      idealCycleTimeSec,
      idealCycleSource,
      reportPerformancePercent,
      dataFlags,
    });

    if (downtimeMinutes > 0 && dtCategory) {
      normalizedDowntimes.push({
        id: `RPT-DT-${r.id}`,
        source: 'PRODUCTION_REPORT',
        category: dtCategory,
        machineId: r.machineId || null,
        machineCode: m?.code || r.machineId || '',
        machineName: m?.name || '',
        hallLocation: m?.hallLocation || 'سالن تولید',
        moId: r.moId || null,
        moNumber: r.moNumber || null,
        operationId: r.operationId || null,
        stepCode: r.stepCode || op?.stepCode || null,
        shiftId: sh?.id || null,
        shiftName: sh?.name || null,
        reason: r.downtimeReason || 'توقف حین تولید',
        durationMinutes: downtimeMinutes,
        recordedAt: reportIso,
        dateKey,
        recordedBy: r.operatorName || 'اپراتور خط',
      });
    }
  }

  for (const dt of fb.downtimes) {
    const durationMinutes = Math.max(0, num(dt.durationMinutes));
    if (durationMinutes <= 0) continue;
    const m = dt.machineId ? machineById.get(dt.machineId) : null;
    const recIso = toIsoSafe(dt.recordedAt);
    const cat = classifyDowntimeCategory(dt.reason, { explicitCategory: dt.category });

    normalizedDowntimes.push({
      id: dt.id,
      source: dt.source === 'PAUSE_DOWNTIME' ? 'PAUSE_DOWNTIME' : 'STANDALONE_DOWNTIME',
      category: cat,
      machineId: dt.machineId || null,
      machineCode: m?.code || dt.machineCode || '',
      machineName: m?.name || dt.machineName || '',
      hallLocation: m?.hallLocation || 'سالن تولید',
      moId: dt.moId || null,
      moNumber: dt.moNumber || null,
      operationId: dt.operationId || null,
      stepCode: dt.stepCode || null,
      shiftId: dt.shiftId || null,
      shiftName: dt.shiftName || null,
      reason: dt.reason || 'توقف کارگاه',
      durationMinutes,
      recordedAt: recIso,
      dateKey: recIso.slice(0, 10),
      recordedBy: dt.recordedBy || 'اپراتور خط',
    });
  }

  const normalizedAssignments: OeeSourceAssignmentRecord[] = fb.assignments
    .filter(a => a.status !== 'CANCELLED')
    .map(a => {
      const m = machineById.get(a.machineId);
      const sh = shiftById.get(a.shiftId) || shifts[0];
      const op = opById.get(a.productionOperationId);
      return {
        id: a.id,
        machineId: a.machineId,
        machineCode: m?.code || a.machineId,
        machineName: m?.name || '',
        productionOperationId: a.productionOperationId,
        moId: op?.moId || '',
        moNumber: op?.moNumber || '',
        stepCode: op?.stepCode || '',
        shiftId: a.shiftId,
        shiftCode: sh?.code || a.shiftId,
        shiftName: sh?.name || '',
        assignedDate: toDateKey(a.assignedDate),
        productiveMinutes: round1((sh?.productiveHours || 7.5) * 60),
        status: a.status,
      };
    });

  return computeOeeAnalyticsFromNormalizedInputs(
    {
      source: 'memory-fallback',
      machines,
      shifts,
      operations,
      reports: normalizedReports,
      downtimeEvents: normalizedDowntimes,
      assignments: normalizedAssignments,
    },
    filters,
  );
}

// ============================================================================
// 6. CONSISTENT SERVER-SIDE CSV EXPORT GENERATOR
// ============================================================================

function csvCell(val: unknown): string {
  const s = val == null ? '' : String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const fmtPct = (v: number | null) => (v == null ? 'N/A' : `${v}%`);

export function buildOeeAnalyticsCsv(
  analytics: OeeAnalyticsResponse,
  dataset: 'machines' | 'shifts' | 'operations' | 'daily' | 'reports' | 'downtimes' = 'machines',
): { filename: string; csv: string } {
  let headers: string[] = [];
  let rows: Array<Array<unknown>> = [];

  if (dataset === 'machines') {
    headers = [
      'Machine Code',
      'Machine Name',
      'Hall',
      'Status',
      'Data Quality',
      'Availability (%)',
      'Performance (%)',
      'Raw Performance (%)',
      'Quality (%)',
      'OEE (%)',
      'TEEP (%)',
      'Scheduled Time (min)',
      'Planned Production Time (min)',
      'Operating Time (min)',
      'Planned Downtime (min)',
      'Setup Time (min)',
      'Unplanned Downtime (min)',
      'Planned Qty',
      'Good Qty',
      'Scrap Qty',
      'Rework Qty',
      'Rejected Qty',
      'Plan Adherence (%)',
      'Ideal Cycle (sec)',
      'Actual Cycle (sec)',
      'MTBF (min)',
      'MTTR (min)',
      'Missing Inputs',
    ];
    rows = analytics.machines.map(m => [
      m.machineCode,
      m.machineName,
      m.hallLocation,
      m.status,
      m.dataQualityStatus,
      fmtPct(m.availabilityPercent),
      fmtPct(m.performancePercent),
      fmtPct(m.rawPerformancePercent),
      fmtPct(m.qualityPercent),
      fmtPct(m.oeePercent),
      fmtPct(m.teepPercent),
      m.time.scheduledTimeMinutes,
      m.time.effectivePlannedProductionTimeMinutes,
      m.time.operatingTimeMinutes,
      m.time.plannedDowntimeMinutes,
      m.time.setupTimeMinutes,
      m.time.unplannedDowntimeMinutes,
      m.plannedQty,
      m.goodQty,
      m.scrapQty,
      m.reworkQty,
      m.rejectedQty,
      fmtPct(m.planAdherencePercent),
      m.idealCycleTimeSec ?? 'N/A',
      m.actualCycleTimeSec ?? 'N/A',
      m.mtbfMinutes ?? 'N/A',
      m.mttrMinutes ?? 'N/A',
      m.missingInputs.join('; '),
    ]);
  } else if (dataset === 'shifts') {
    headers = [
      'Shift Code',
      'Shift Name',
      'Data Quality',
      'Availability (%)',
      'Performance (%)',
      'Quality (%)',
      'OEE (%)',
      'Operating Time (min)',
      'Planned Downtime (min)',
      'Setup Time (min)',
      'Unplanned Downtime (min)',
      'Planned Qty',
      'Good Qty',
      'Scrap Qty',
      'Plan Adherence (%)',
      'Reports Count',
    ];
    rows = analytics.byShift.map(s => [
      s.shiftCode,
      s.shiftName,
      s.dataQualityStatus,
      fmtPct(s.availabilityPercent),
      fmtPct(s.performancePercent),
      fmtPct(s.qualityPercent),
      fmtPct(s.oeePercent),
      s.time.operatingTimeMinutes,
      s.time.plannedDowntimeMinutes,
      s.time.setupTimeMinutes,
      s.time.unplannedDowntimeMinutes,
      s.plannedQty,
      s.goodQty,
      s.scrapQty,
      fmtPct(s.planAdherencePercent),
      s.reportsCount,
    ]);
  } else if (dataset === 'operations') {
    headers = [
      'MO Number',
      'Part Code',
      'Part Name',
      'Step Code',
      'Step Name',
      'Machine Code',
      'Data Quality',
      'Planned Qty',
      'Good Qty',
      'Scrap Qty',
      'Plan Adherence (%)',
      'Operating Time (min)',
      'Setup Time (min)',
      'Unplanned Downtime (min)',
      'Ideal Cycle (sec)',
      'Actual Cycle (sec)',
      'Availability (%)',
      'Performance (%)',
      'Quality (%)',
      'OEE (%)',
    ];
    rows = analytics.byOperation.map(o => [
      o.moNumber,
      o.partCode,
      o.partName,
      o.stepCode,
      o.stepName,
      o.machineCode || '',
      o.dataQualityStatus,
      o.plannedQty,
      o.goodQty,
      o.scrapQty,
      fmtPct(o.planAdherencePercent),
      o.time.operatingTimeMinutes,
      o.time.setupTimeMinutes,
      o.time.unplannedDowntimeMinutes,
      o.idealCycleTimeSec ?? 'N/A',
      o.actualCycleTimeSec ?? 'N/A',
      fmtPct(o.availabilityPercent),
      fmtPct(o.performancePercent),
      fmtPct(o.qualityPercent),
      fmtPct(o.oeePercent),
    ]);
  } else if (dataset === 'daily') {
    headers = [
      'Date',
      'Active Machines',
      'Reports',
      'Data Quality',
      'Planned Qty',
      'Good Qty',
      'Scrap Qty',
      'Operating Time (min)',
      'Planned Downtime (min)',
      'Setup Time (min)',
      'Unplanned Downtime (min)',
      'Availability (%)',
      'Performance (%)',
      'Quality (%)',
      'OEE (%)',
    ];
    rows = analytics.byDate.map(d => [
      d.date,
      d.activeMachinesCount,
      d.reportsCount,
      d.dataQualityStatus,
      d.plannedQty,
      d.goodQty,
      d.scrapQty,
      d.time.operatingTimeMinutes,
      d.time.plannedDowntimeMinutes,
      d.time.setupTimeMinutes,
      d.time.unplannedDowntimeMinutes,
      fmtPct(d.availabilityPercent),
      fmtPct(d.performancePercent),
      fmtPct(d.qualityPercent),
      fmtPct(d.oeePercent),
    ]);
  } else if (dataset === 'downtimes') {
    headers = [
      'Event ID',
      'Date',
      'Source',
      'Category',
      'Machine Code',
      'Machine Name',
      'Shift',
      'MO Number',
      'Step Code',
      'Reason',
      'Duration (min)',
      'Recorded By',
    ];
    rows = analytics.sourceRecords.downtimeEvents.map(d => [
      d.id,
      d.dateKey,
      d.source,
      d.category,
      d.machineCode,
      d.machineName,
      d.shiftName || '',
      d.moNumber || '',
      d.stepCode || '',
      d.reason,
      d.durationMinutes,
      d.recordedBy,
    ]);
  } else {
    headers = [
      'Report Number',
      'Date',
      'MO Number',
      'Part Code',
      'Step Code',
      'Machine Code',
      'Shift',
      'Operator',
      'Good Qty',
      'Scrap Qty',
      'Rework Qty',
      'Rejected Qty',
      'Run Time (min)',
      'Downtime (min)',
      'Downtime Category',
      'Downtime Reason',
      'Ideal Cycle (sec)',
      'Report Performance (%)',
      'Data Flags',
    ];
    rows = analytics.sourceRecords.productionReports.map(r => [
      r.reportNumber,
      r.dateKey,
      r.moNumber,
      r.partCode,
      r.stepCode,
      r.machineCode,
      r.shiftName,
      r.operatorName,
      r.goodQty,
      r.scrapQty,
      r.reworkQty,
      r.rejectedQty,
      r.runTimeMinutes,
      r.downtimeMinutes,
      r.downtimeCategory || '',
      r.downtimeReason || '',
      r.idealCycleTimeSec ?? 'N/A',
      fmtPct(r.reportPerformancePercent),
      r.dataFlags.join('; '),
    ]);
  }

  const lines = [headers.map(csvCell).join(','), ...rows.map(r => r.map(csvCell).join(','))];
  const csv = `\uFEFF${lines.join('\r\n')}`;
  const dateTag = new Date().toISOString().slice(0, 10);
  return {
    filename: `KPIMS_OEE_${dataset}_${dateTag}.csv`,
    csv,
  };
}

// ============================================================================
// 7. BACKWARD-COMPATIBLE ADAPTERS FOR EXISTING /api/oee/dashboard &
//    /api/machines/utilization-report (SINGLE SOURCE OF TRUTH CONSISTENCY)
// ============================================================================

export function projectOeeAnalyticsToLegacyUtilization(
  analytics: OeeAnalyticsResponse,
  shiftFilter: ShiftFilterKey = 'ALL',
): MachineUtilizationSummary {
  const shiftLabels: Record<ShiftFilterKey, string> = {
    ALL: 'همه شیفت‌ها (داده‌های واقعی کارگاه)',
    MORNING: 'شیفت صبح',
    EVENING: 'شیفت عصر',
    NIGHT: 'شیفت شب',
  };

  const items: MachineUtilizationItem[] = analytics.machines.map(m => {
    const calH = round2(m.time.scheduledTimeMinutes / 60);
    const netOpH = round2(m.time.operatingTimeMinutes / 60);
    const plannedDtH = round2((m.time.plannedDowntimeMinutes + m.time.setupTimeMinutes) / 60);
    const unplannedDtH = round2(m.time.unplannedDowntimeMinutes / 60);
    const idleH = round2(m.time.idleUnassignedMinutes / 60);

    const grossUtil = calH > 0 ? round1((netOpH / calH) * 100) : 0;
    const netLoadEff = m.availabilityPercent ?? 0;

    const nominalSpm =
      m.maxStrokesPerMinute ?? (m.idealCycleTimeSec && m.idealCycleTimeSec > 0 ? round1(60 / m.idealCycleTimeSec) : 0);
    const actualSpm =
      m.actualCycleTimeSec && m.actualCycleTimeSec > 0 ? round1(60 / m.actualCycleTimeSec) : 0;

    const mReports = analytics.sourceRecords.productionReports.filter(r => r.machineId === m.machineId);
    const mDowntimes = analytics.sourceRecords.downtimeEvents.filter(d => d.machineId === m.machineId);
    const latestReport = mReports[0];

    const reasonAgg = new Map<string, { cat: 'PLANNED' | 'UNPLANNED'; min: number; count: number }>();
    for (const d of mDowntimes) {
      const cat: 'PLANNED' | 'UNPLANNED' = d.category === 'UNPLANNED' ? 'UNPLANNED' : 'PLANNED';
      const prev = reasonAgg.get(d.reason) || { cat, min: 0, count: 0 };
      prev.min += d.durationMinutes;
      prev.count += 1;
      reasonAgg.set(d.reason, prev);
    }
    const mTotalDt = Math.max(1, mDowntimes.reduce((s, d) => s + d.durationMinutes, 0));
    const downtimeBreakdown = Array.from(reasonAgg.entries()).map(([reason, v], idx) => ({
      reasonCode: v.cat === 'UNPLANNED' ? `DT-UNP-${idx + 1}` : `DT-PLN-${idx + 1}`,
      reasonTitleFa: reason,
      category: v.cat,
      durationMinutes: round1(v.min),
      occurrencesCount: v.count,
      sharePercent: round1((v.min / mTotalDt) * 100),
    }));

    const setupEvents = mDowntimes.filter(d => d.category === 'SETUP');
    let utilizationStatus: MachineUtilizationItem['utilizationStatus'] = 'OPTIMAL';
    if (m.status === 'BREAKDOWN' || m.status === 'MAINTENANCE' || unplannedDtH >= 1.5) {
      utilizationStatus = 'DOWNTIME_ALERT';
    } else if (grossUtil >= 85) {
      utilizationStatus = 'BOTTLENECK_OVERLOAD';
    } else if (grossUtil < 50) {
      utilizationStatus = 'UNDER_UTILIZED';
    }

    return {
      machineId: m.machineId,
      machineCode: m.machineCode,
      machineName: m.machineName,
      hallName: m.hallLocation,
      processType: (m.machineType || 'PUNCH_FORM') as any,
      tonnage: m.tonnageCapacity || 0,
      operatorName: latestReport?.operatorName || '—',
      shift: shiftFilter,
      shiftLabelFa: shiftLabels[shiftFilter],
      calendarAvailableHours: calH,
      plannedDowntimeHours: plannedDtH,
      unplannedDowntimeHours: unplannedDtH,
      idleNoOrderHours: idleH,
      netOperatingHours: netOpH,
      grossUtilizationPercent: grossUtil,
      netLoadingEfficiencyPercent: netLoadEff,
      tonnageLoadPercent: 0,
      nominalSpm,
      actualAvgSpm: actualSpm,
      spmEfficiencyPercent: m.performancePercent ?? 0,
      totalStrokesCount: m.totalProducedQty,
      goodPartsProduced: m.goodQty,
      scrapPartsCount: m.scrapQty,
      activeMoNumber: latestReport?.moNumber || '—',
      activePartName: latestReport?.partName || '—',
      activeDieCode: '—',
      dieChangeoverCount: setupEvents.length,
      avgDieChangeoverMinutes:
        setupEvents.length > 0 ? round1(m.time.setupTimeMinutes / setupEvents.length) : 0,
      estimatedEnergyKwh: 0,
      status: (m.status as any) || 'ACTIVE',
      utilizationStatus,
      downtimeBreakdown,
    };
  });

  const totalCalendarHours = round2(analytics.summary.time.scheduledTimeMinutes / 60);
  const totalNetOperatingHours = round2(analytics.summary.time.operatingTimeMinutes / 60);
  const totalPlannedDowntimeHours = round2(
    (analytics.summary.time.plannedDowntimeMinutes + analytics.summary.time.setupTimeMinutes) / 60,
  );
  const totalUnplannedDowntimeHours = round2(analytics.summary.time.unplannedDowntimeMinutes / 60);
  const totalIdleHours = round2(analytics.summary.time.idleUnassignedMinutes / 60);

  return {
    generatedAt: analytics.generatedAt,
    periodLabelFa: shiftLabels[shiftFilter],
    totalMachinesCount: items.length,
    activeMachinesCount: items.filter(i => i.status === 'ACTIVE').length,
    maintenanceMachinesCount: items.filter(i => i.status === 'MAINTENANCE' || i.status === 'BREAKDOWN').length,
    totalCalendarHours,
    totalNetOperatingHours,
    totalPlannedDowntimeHours,
    totalUnplannedDowntimeHours,
    totalIdleHours,
    averageGrossUtilizationPercent:
      totalCalendarHours > 0 ? round1((totalNetOperatingHours / totalCalendarHours) * 100) : 0,
    averageNetLoadingEfficiencyPercent: analytics.summary.availabilityPercent ?? 0,
    averageSpmEfficiencyPercent: analytics.summary.performancePercent ?? 0,
    totalStrokesExecuted: analytics.summary.totalProducedQty,
    totalGoodPartsProduced: analytics.summary.goodQty,
    bottleneckMachinesCount: items.filter(i => i.utilizationStatus === 'BOTTLENECK_OVERLOAD').length,
    topDowntimeCauses: analytics.downtimeSummary.byReason.slice(0, 5).map(r => ({
      reasonTitleFa: r.reason,
      category: r.category === 'UNPLANNED' ? 'UNPLANNED' : 'PLANNED',
      totalHours: round2(r.minutes / 60),
      sharePercent: r.sharePercent,
      recommendedAction:
        r.category === 'SETUP'
          ? 'کاهش زمان تعویض قالب با روش SMED و آماده‌سازی پیشاپیش ابزار'
          : r.category === 'PLANNED'
          ? 'زمان‌بندی بهینه سرویس دوره‌ای خارج از پیک شیفت'
          : 'بازرسی علت ریشه‌ای خرابی اضطراری و تکمیل چک‌لیست PM',
    })),
    machines: items,
  };
}

export function projectOeeAnalyticsToLegacyDashboard(
  analytics: OeeAnalyticsResponse,
): OeeDashboardSummary & { analytics: OeeAnalyticsResponse } {
  const oeeMachines: OeeMachineRecord[] = analytics.machines.map(m => {
    const mReports = analytics.sourceRecords.productionReports.filter(r => r.machineId === m.machineId);
    const mDowntimes = analytics.sourceRecords.downtimeEvents.filter(d => d.machineId === m.machineId);
    const latest = mReports[0];
    const a = m.availabilityPercent ?? 0;
    const p = m.performancePercent ?? 0;
    const q = m.qualityPercent ?? 0;
    const oee = m.oeePercent ?? 0;
    const teep = m.teepPercent ?? 0;

    let gradeClass: OeeMachineRecord['gradeClass'] = 'CRITICAL_D';
    if (oee >= 85) gradeClass = 'WORLD_CLASS_A';
    else if (oee >= 72) gradeClass = 'ACCEPTABLE_B';
    else if (oee >= 60) gradeClass = 'NEEDS_IMPROVEMENT_C';

    const speedLossMinutes =
      m.performancePercent != null && m.time.operatingTimeMinutes > 0
        ? round1(m.time.operatingTimeMinutes * (1 - m.performancePercent / 100))
        : 0;
    const netOperatingMinutes = Math.max(0, round1(m.time.operatingTimeMinutes - speedLossMinutes));
    const qualityLossMinutes =
      m.qualityPercent != null && netOperatingMinutes > 0
        ? round1(netOperatingMinutes * (1 - m.qualityPercent / 100))
        : 0;
    const fullyProductiveMinutes = Math.max(0, round1(netOperatingMinutes - qualityLossMinutes));

    return {
      machineId: m.machineId,
      machineCode: m.machineCode,
      machineName: m.machineName,
      hallName: m.hallLocation,
      processType: (m.machineType || 'PUNCH_FORM') as any,
      tonnage: m.tonnageCapacity || 0,
      activePartCode: latest?.partCode || '—',
      activePartName: latest?.partName || '—',
      operatorName: latest?.operatorName || '—',
      status: m.status,
      availabilityPercent: a,
      performancePercent: p,
      qualityPercent: q,
      oeePercent: oee,
      teepPercent: teep,
      worldClassTargetPercent: 85.0,
      varianceFromTargetPercent: round1(oee - 85.0),
      plannedProductionMinutes: m.time.effectivePlannedProductionTimeMinutes,
      downtimeLossMinutes: m.time.availabilityLossMinutes,
      plannedDowntimeMinutes: m.time.plannedDowntimeMinutes,
      unplannedDowntimeMinutes: m.time.unplannedDowntimeMinutes,
      minorStopLossMinutes: 0,
      operatingRunMinutes: m.time.operatingTimeMinutes,
      speedLossMinutes,
      netOperatingMinutes,
      qualityLossMinutes,
      fullyProductiveMinutes,
      mtbfHours: m.mtbfMinutes != null ? round1(m.mtbfMinutes / 60) : 0,
      mttrMinutes: m.mttrMinutes ?? 0,
      idealCycleTimeSeconds: m.idealCycleTimeSec ?? 0,
      actualCycleTimeSeconds: m.actualCycleTimeSec ?? 0,
      totalProducedPieces: m.totalProducedQty,
      goodPieces: m.goodQty,
      scrapAndReworkPieces: round2(m.scrapQty + m.reworkQty + m.rejectedQty),
      firstPassYieldPercent: q,
      gradeClass,
      sixBigLosses: [],
      downtimeLogs: mDowntimes.map(d => ({
        id: d.id,
        reasonCode: d.category,
        reasonTitleFa: d.reason,
        category: d.category === 'UNPLANNED' ? 'UNPLANNED_BREAKDOWN' : 'PLANNED_SETUP',
        categoryLabelFa:
          d.category === 'UNPLANNED'
            ? 'توقف برنامه‌ریزی‌نشده / خرابی'
            : d.category === 'SETUP'
            ? 'ستاپ و تعویض قالب'
            : 'توقف برنامه‌ریزی‌شده (PM)',
        durationMinutes: d.durationMinutes,
        occurrencesCount: 1,
        sharePercent:
          m.time.availabilityLossMinutes + m.time.plannedDowntimeMinutes > 0
            ? round1((d.durationMinutes / (m.time.availabilityLossMinutes + m.time.plannedDowntimeMinutes)) * 100)
            : 0,
        timeRangeFa: d.dateKey,
        shiftLabelFa: d.shiftName || '—',
        operatorOrTechName: d.recordedBy,
        rootCauseFa: d.reason,
        correctiveActionFa: 'ثبت‌شده از سوابق واقعی کارگاه',
      })),
    };
  });

  const shiftComparison = analytics.byShift.map(s => ({
    shiftCode: (s.shiftCode.toUpperCase().includes('EVE')
      ? 'EVENING'
      : s.shiftCode.toUpperCase().includes('NIGHT')
      ? 'NIGHT'
      : 'MORNING') as 'MORNING' | 'EVENING' | 'NIGHT',
    shiftNameFa: s.shiftName,
    supervisorName: 'سرپرست شیفت',
    availabilityPercent: s.availabilityPercent ?? 0,
    performancePercent: s.performancePercent ?? 0,
    qualityPercent: s.qualityPercent ?? 0,
    oeePercent: s.oeePercent ?? 0,
    totalPieces: s.goodQty,
  }));

  return {
    generatedAt: analytics.generatedAt,
    plantOeePercent: analytics.summary.oeePercent ?? 0,
    plantAvailabilityPercent: analytics.summary.availabilityPercent ?? 0,
    plantPerformancePercent: analytics.summary.performancePercent ?? 0,
    plantQualityPercent: analytics.summary.qualityPercent ?? 0,
    plantTeepPercent: analytics.summary.teepPercent ?? 0,
    worldClassBenchmarkOee: 85.0,
    avgMtbfHours: 0,
    avgMttrMinutes: 0,
    totalHiddenCapacityPiecesPerMonth: 0,
    sixBigLossesAggregate: [],
    machines: oeeMachines,
    shiftComparison,
    analytics,
  };
}
