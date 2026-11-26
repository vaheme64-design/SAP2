/**
 * =========================================================================
 * KPIMS P4: OEE, Machine Performance & Production Analytics Regression Suite
 * =========================================================================
 * Covers:
 *   1. Exact ISO 22400 / TPM formulas (Availability, Performance, Quality, OEE, TEEP).
 *   2. Downtime categorization (PLANNED vs SETUP vs UNPLANNED) & deduplication.
 *   3. Edge cases & explicit data-quality flagging (ZERO fabricated OEE values).
 *   4. Multi-dimensional aggregation (machine, shift, operation, date, weighted plant summary) + filters.
 *   5. Relational Prisma read-path (mocked in-memory, ZERO live PG) including AuditLog deduplication.
 *   6. End-to-end HTTP fallback parity + consistency across /api/oee/analytics, /api/oee/dashboard,
 *      /api/machines/utilization-report, and /api/oee/analytics/export CSV.
 *
 * Run with: DATABASE_URL="" npx tsx scripts/test-kpims-p4-oee-analytics.ts
 * =========================================================================
 */

import assert from 'node:assert/strict';
import express from 'express';
import {
  classifyDowntimeCategory,
  computeOeeMetrics,
  computeOeeAnalyticsFromNormalizedInputs,
  getRelationalOeeAnalytics,
  buildOeeAnalyticsCsv,
  type NormalizedAnalyticsDataset,
} from '../src/server/relationalOeeAnalyticsService';
import { __setProductionWipPrismaForTests } from '../src/server/services/productionWipService';
import { apiRouter } from '../src/server/apiRouter';

if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '') {
  throw new Error('Refusing to run isolated P4 test suite when DATABASE_URL is configured.');
}

function approxEqual(actual: number | null, expected: number, tolerance = 0.15, label = '') {
  assert.notEqual(actual, null, `${label}: expected ${expected}, got null`);
  assert.ok(
    Math.abs((actual as number) - expected) <= tolerance,
    `${label}: expected ~${expected} (±${tolerance}), got ${actual}`,
  );
}

// -------------------------------------------------------------------------
// TEST 1: Downtime classification & exact ISO 22400 / TPM OEE formulas
// -------------------------------------------------------------------------
function testFormulasAndDowntimeClassification() {
  assert.equal(classifyDowntimeCategory('تعویض قالب و ستاپ خط پرس (SMED)'), 'SETUP');
  assert.equal(classifyDowntimeCategory('تنظیم کورس و کلمپ هیدرولیک'), 'SETUP');
  assert.equal(classifyDowntimeCategory('سرویس دوره‌ای PM و روانکاری برنامه‌ریزی‌شده'), 'PLANNED');
  assert.equal(classifyDowntimeCategory('Planned Maintenance Check'), 'PLANNED');
  assert.equal(classifyDowntimeCategory('خرابی کلاچ و افت فشار هوا'), 'UNPLANNED');
  assert.equal(classifyDowntimeCategory('توقف نامشخص بدون توضیح'), 'UNPLANNED');
  assert.equal(classifyDowntimeCategory('هر دلیلی', { explicitCategory: 'PLANNED' }), 'PLANNED');

  // Exact numerical example:
  // Scheduled = 480 min (8h)
  // Planned DT (PM) = 30 min  => Planned Production Time = 450 min
  // Setup = 30 min, Unplanned DT = 60 min => Availability Loss = 90 min
  // Operating Time = 360 min
  // Availability = 360 / 450 = 80.0%
  // Total Produced = 1000 pcs (950 good, 40 scrap, 10 rework)
  // Ideal Cycle Time = 18 sec/pc => Ideal Run Time = (1000 * 18) / 60 = 300 min
  // Performance = 300 / 360 = 83.3% (83.333...)
  // Quality = 950 / 1000 = 95.0%
  // OEE = (80.0 * 83.333... * 95.0) / 10000 = 63.3% (63.333...)
  // TEEP = (OEE * 450 / 480) = 59.4%
  const m = computeOeeMetrics({
    scheduledTimeMinutes: 480,
    scheduledTimeSource: 'ASSIGNMENTS',
    plannedDowntimeMinutes: 30,
    setupTimeMinutes: 30,
    unplannedDowntimeMinutes: 60,
    operatingTimeMinutes: 360,
    plannedQty: 1200,
    goodQty: 950,
    scrapQty: 40,
    reworkQty: 10,
    rejectedQty: 0,
    idealRunTimeMinutes: 300,
    idealCycleCoveredQty: 1000,
    usedMachineSpmFallback: false,
  });

  assert.equal(m.oeeCalculable, true);
  assert.equal(m.dataQualityStatus, 'RELIABLE');
  assert.equal(m.missingInputs.length, 0);
  assert.equal(m.time.plannedProductionTimeMinutes, 450);
  assert.equal(m.time.availabilityLossMinutes, 90);
  approxEqual(m.availabilityPercent, 80.0, 0.1, 'Availability');
  approxEqual(m.performancePercent, 83.3, 0.1, 'Performance');
  approxEqual(m.qualityPercent, 95.0, 0.1, 'Quality');
  approxEqual(m.oeePercent, 63.3, 0.2, 'OEE');
  approxEqual(m.teepPercent, 59.4, 0.2, 'TEEP');
  approxEqual(m.scrapRatePercent, 4.0, 0.1, 'Scrap rate');
  approxEqual(m.planAdherencePercent, 79.2, 0.2, 'Plan adherence');
  assert.equal(m.planVarianceQty, -250);
  approxEqual(m.idealCycleTimeSec, 18.0, 0.1, 'Ideal cycle');
  approxEqual(m.actualCycleTimeSec, 21.6, 0.1, 'Actual cycle');

  console.log('PASS [1/6]: ISO 22400 / TPM formulas & downtime classification');
}

// -------------------------------------------------------------------------
// TEST 2: Edge cases & ZERO fabricated OEE when required inputs are missing
// -------------------------------------------------------------------------
function testEdgeCasesAndDataQuality() {
  // 2a. Missing ideal cycle time => P = null, OEE = null (NEVER fabricated)
  const missingCycle = computeOeeMetrics({
    scheduledTimeMinutes: 450,
    scheduledTimeSource: 'ASSIGNMENTS',
    plannedDowntimeMinutes: 0,
    setupTimeMinutes: 20,
    unplannedDowntimeMinutes: 30,
    operatingTimeMinutes: 400,
    plannedQty: 500,
    goodQty: 480,
    scrapQty: 20,
    reworkQty: 0,
    rejectedQty: 0,
    idealRunTimeMinutes: 0,
    idealCycleCoveredQty: 0,
    usedMachineSpmFallback: false,
  });
  approxEqual(missingCycle.availabilityPercent, 88.9, 0.1, 'MissingCycle A');
  assert.equal(missingCycle.performancePercent, null, 'MissingCycle P must be null');
  approxEqual(missingCycle.qualityPercent, 96.0, 0.1, 'MissingCycle Q');
  assert.equal(missingCycle.oeePercent, null, 'MissingCycle OEE must be null');
  assert.equal(missingCycle.oeeCalculable, false);
  assert.equal(missingCycle.dataQualityStatus, 'INSUFFICIENT_DATA');
  assert.ok(missingCycle.dataQualityIssues.some(i => i.code === 'MISSING_IDEAL_CYCLE_TIME'));

  // 2b. Output reported with runTimeMinutes = 0 => UNRELIABLE, A/P/OEE null
  const zeroRunWithOutput = computeOeeMetrics({
    scheduledTimeMinutes: 450,
    scheduledTimeSource: 'ASSIGNMENTS',
    plannedDowntimeMinutes: 0,
    setupTimeMinutes: 0,
    unplannedDowntimeMinutes: 0,
    operatingTimeMinutes: 0,
    plannedQty: 200,
    goodQty: 180,
    scrapQty: 20,
    reworkQty: 0,
    rejectedQty: 0,
    idealRunTimeMinutes: 60,
    idealCycleCoveredQty: 200,
    usedMachineSpmFallback: false,
  });
  assert.equal(zeroRunWithOutput.availabilityPercent, null);
  assert.equal(zeroRunWithOutput.performancePercent, null);
  assert.equal(zeroRunWithOutput.oeePercent, null);
  approxEqual(zeroRunWithOutput.qualityPercent, 90.0, 0.1, 'ZeroRun Q still valid');
  assert.equal(zeroRunWithOutput.dataQualityStatus, 'UNRELIABLE');
  assert.ok(zeroRunWithOutput.dataQualityIssues.some(i => i.code === 'MISSING_RUN_TIME'));

  // 2c. Performance > 100.5% (miscalibrated standard cycle time) => flagged UNRELIABLE, capped at 100, raw exposed
  const over100Perf = computeOeeMetrics({
    scheduledTimeMinutes: 450,
    scheduledTimeSource: 'ASSIGNMENTS',
    plannedDowntimeMinutes: 0,
    setupTimeMinutes: 0,
    unplannedDowntimeMinutes: 50,
    operatingTimeMinutes: 200,
    plannedQty: 500,
    goodQty: 500,
    scrapQty: 0,
    reworkQty: 0,
    rejectedQty: 0,
    idealRunTimeMinutes: 260, // 130% raw performance
    idealCycleCoveredQty: 500,
    usedMachineSpmFallback: false,
  });
  approxEqual(over100Perf.rawPerformancePercent, 130.0, 0.1, 'Raw Performance');
  assert.equal(over100Perf.performancePercent, 100, 'Capped Performance');
  assert.equal(over100Perf.dataQualityStatus, 'UNRELIABLE');
  assert.ok(over100Perf.dataQualityIssues.some(i => i.code === 'PERFORMANCE_OVER_100_CHECK_CYCLE_TIME'));

  // 2d. 100% Breakdown with zero production output => A = 0, P = null, Q = null, OEE = null
  const fullBreakdown = computeOeeMetrics({
    scheduledTimeMinutes: 450,
    scheduledTimeSource: 'ASSIGNMENTS',
    plannedDowntimeMinutes: 0,
    setupTimeMinutes: 0,
    unplannedDowntimeMinutes: 450,
    operatingTimeMinutes: 0,
    plannedQty: 300,
    goodQty: 0,
    scrapQty: 0,
    reworkQty: 0,
    rejectedQty: 0,
    idealRunTimeMinutes: 0,
    idealCycleCoveredQty: 0,
    usedMachineSpmFallback: false,
  });
  assert.equal(fullBreakdown.availabilityPercent, 0);
  assert.equal(fullBreakdown.performancePercent, null);
  assert.equal(fullBreakdown.qualityPercent, null);
  assert.equal(fullBreakdown.oeePercent, null);
  assert.ok(fullBreakdown.dataQualityIssues.some(i => i.code === 'NO_PRODUCTION_OUTPUT'));

  // 2e. Zero activity & no schedule => all null, NO_ACTIVITY_OR_SCHEDULE
  const idleMachine = computeOeeMetrics({
    scheduledTimeMinutes: 0,
    scheduledTimeSource: 'NONE',
    plannedDowntimeMinutes: 0,
    setupTimeMinutes: 0,
    unplannedDowntimeMinutes: 0,
    operatingTimeMinutes: 0,
    plannedQty: 0,
    goodQty: 0,
    scrapQty: 0,
    reworkQty: 0,
    rejectedQty: 0,
    idealRunTimeMinutes: 0,
    idealCycleCoveredQty: 0,
    usedMachineSpmFallback: false,
  });
  assert.equal(idleMachine.availabilityPercent, null);
  assert.equal(idleMachine.performancePercent, null);
  assert.equal(idleMachine.qualityPercent, null);
  assert.equal(idleMachine.oeePercent, null);
  assert.equal(idleMachine.dataQualityStatus, 'INSUFFICIENT_DATA');
  assert.ok(idleMachine.dataQualityIssues.some(i => i.code === 'NO_ACTIVITY_OR_SCHEDULE'));

  // 2f. Partial cycle coverage across reports => P = null, PARTIAL_IDEAL_CYCLE_COVERAGE
  const partialCycle = computeOeeMetrics({
    scheduledTimeMinutes: 450,
    scheduledTimeSource: 'ASSIGNMENTS',
    plannedDowntimeMinutes: 0,
    setupTimeMinutes: 0,
    unplannedDowntimeMinutes: 50,
    operatingTimeMinutes: 400,
    plannedQty: 1000,
    goodQty: 900,
    scrapQty: 100,
    reworkQty: 0,
    rejectedQty: 0,
    idealRunTimeMinutes: 150,
    idealCycleCoveredQty: 500, // only half of 1000 covered
    usedMachineSpmFallback: false,
  });
  assert.equal(partialCycle.performancePercent, null);
  assert.equal(partialCycle.oeePercent, null);
  assert.ok(partialCycle.dataQualityIssues.some(i => i.code === 'PARTIAL_IDEAL_CYCLE_COVERAGE'));

  // 2g. Overtime / time overflow exceeding shift duration => warning + Availability capped <= 100%
  const timeOverflow = computeOeeMetrics({
    scheduledTimeMinutes: 450,
    scheduledTimeSource: 'REPORT_SHIFTS',
    plannedDowntimeMinutes: 0,
    setupTimeMinutes: 30,
    unplannedDowntimeMinutes: 30,
    operatingTimeMinutes: 480, // 480 + 60 = 540 > 450
    plannedQty: 1000,
    goodQty: 960,
    scrapQty: 40,
    reworkQty: 0,
    rejectedQty: 0,
    idealRunTimeMinutes: 400,
    idealCycleCoveredQty: 1000,
    usedMachineSpmFallback: false,
  });
  assert.ok((timeOverflow.availabilityPercent ?? 999) <= 100);
  assert.equal(timeOverflow.time.effectivePlannedProductionTimeMinutes, 540);
  assert.ok(timeOverflow.dataQualityIssues.some(i => i.code === 'TIME_OVERFLOW_EXCEEDS_SHIFT_DURATION'));

  console.log('PASS [2/6]: Edge cases & explicit data-quality flagging (zero fabrication)');
}

// -------------------------------------------------------------------------
// TEST 3: Multi-dimensional aggregation, weighted plant summary & filtering
// -------------------------------------------------------------------------
function testAggregationAndWeighting() {
  const dataset: NormalizedAnalyticsDataset = {
    source: 'memory-fallback',
    machines: [
      {
        id: 'M1',
        code: 'PRS-400',
        name: 'پرس ۴۰۰ تن هیدرولیک',
        hallLocation: 'سالن پرس ۱',
        machineType: 'DRAWING',
        tonnageCapacity: 400,
        maxStrokesPerMinute: 12,
        status: 'ACTIVE',
      },
      {
        id: 'M2',
        code: 'PRS-160',
        name: 'پرس ۱۶۰ تن ضربه‌ای',
        hallLocation: 'سالن پرس ۲',
        machineType: 'PUNCH_FORM',
        tonnageCapacity: 160,
        maxStrokesPerMinute: null,
        status: 'ACTIVE',
      },
      {
        id: 'M3',
        code: 'WLD-01',
        name: 'ربات جوش نقطه',
        hallLocation: 'سالن جوش',
        machineType: 'WELDING',
        tonnageCapacity: null,
        maxStrokesPerMinute: null,
        status: 'ACTIVE',
      },
    ],
    shifts: [
      { id: 'SH-A', code: 'SHIFT-MORNING', name: 'شیفت صبح (A)', productiveHours: 8 },
      { id: 'SH-B', code: 'SHIFT-EVENING', name: 'شیفت عصر (B)', productiveHours: 8 },
    ],
    operations: [
      {
        id: 'OP-1',
        moId: 'MO-1',
        moNumber: 'MO-1404-001',
        partId: 'P-1',
        partCode: 'PRT-001',
        partName: 'سینی کف جلو',
        stepNumber: 1,
        stepCode: 'OP10',
        stepName: 'کشش اولیه',
        plannedMachineId: 'M1',
        plannedQty: 1000,
        standardCycleTimeSec: 18,
        routeStandardCycleTimeSec: 18,
        routeSetupTimeMin: 25,
        status: 'IN_PROGRESS',
      },
      {
        id: 'OP-2',
        moId: 'MO-2',
        moNumber: 'MO-1404-002',
        partId: 'P-2',
        partCode: 'PRT-002',
        partName: 'براکت ستون',
        stepNumber: 1,
        stepCode: 'OP20',
        stepName: 'پانچ و خم',
        plannedMachineId: 'M2',
        plannedQty: 500,
        standardCycleTimeSec: 12,
        routeStandardCycleTimeSec: 12,
        routeSetupTimeMin: 15,
        status: 'IN_PROGRESS',
      },
    ],
    assignments: [
      {
        id: 'ASG-1',
        machineId: 'M1',
        machineCode: 'PRS-400',
        machineName: 'پرس ۴۰۰ تن هیدرولیک',
        productionOperationId: 'OP-1',
        moId: 'MO-1',
        moNumber: 'MO-1404-001',
        stepCode: 'OP10',
        shiftId: 'SH-A',
        shiftCode: 'SHIFT-MORNING',
        shiftName: 'شیفت صبح (A)',
        assignedDate: '2026-11-24',
        productiveMinutes: 480,
        status: 'CONFIRMED',
      },
      {
        id: 'ASG-2',
        machineId: 'M1',
        machineCode: 'PRS-400',
        machineName: 'پرس ۴۰۰ تن هیدرولیک',
        productionOperationId: 'OP-1',
        moId: 'MO-1',
        moNumber: 'MO-1404-001',
        stepCode: 'OP10',
        shiftId: 'SH-B',
        shiftCode: 'SHIFT-EVENING',
        shiftName: 'شیفت عصر (B)',
        assignedDate: '2026-11-25',
        productiveMinutes: 480,
        status: 'CONFIRMED',
      },
      {
        id: 'ASG-3',
        machineId: 'M2',
        machineCode: 'PRS-160',
        machineName: 'پرس ۱۶۰ تن ضربه‌ای',
        productionOperationId: 'OP-2',
        moId: 'MO-2',
        moNumber: 'MO-1404-002',
        stepCode: 'OP20',
        shiftId: 'SH-A',
        shiftCode: 'SHIFT-MORNING',
        shiftName: 'شیفت صبح (A)',
        assignedDate: '2026-11-24',
        productiveMinutes: 480,
        status: 'CONFIRMED',
      },
    ],
    reports: [
      // M1 Day 1 Shift A: 420 min run, 30 min setup, 30 min planned PM => A = 420/450 = 93.33%
      // 1200 produced (1140 good, 60 scrap), ideal = 18s => idealRun = 360 min => P = 360/420 = 85.71%, Q = 95.0%
      {
        id: 'REP-1',
        reportNumber: 'PR-001',
        reportDate: '2026-11-24T10:00:00.000Z',
        dateKey: '2026-11-24',
        moId: 'MO-1',
        moNumber: 'MO-1404-001',
        partId: 'P-1',
        partCode: 'PRT-001',
        partName: 'سینی کف جلو',
        operationId: 'OP-1',
        stepNumber: 1,
        stepCode: 'OP10',
        stepName: 'کشش اولیه',
        machineId: 'M1',
        machineCode: 'PRS-400',
        machineName: 'پرس ۴۰۰ تن هیدرولیک',
        hallLocation: 'سالن پرس ۱',
        shiftId: 'SH-A',
        shiftCode: 'SHIFT-MORNING',
        shiftName: 'شیفت صبح (A)',
        operatorName: 'علی رضایی',
        goodQty: 1140,
        scrapQty: 60,
        reworkQty: 0,
        rejectedQty: 0,
        totalProducedQty: 1200,
        runTimeMinutes: 420,
        downtimeMinutes: 30,
        downtimeReason: 'تعویض قالب و ستاپ خط',
        downtimeCategory: 'SETUP',
        strokeCounterStart: 1000,
        strokeCounterEnd: 2200,
        idealCycleTimeSec: 18,
        idealCycleSource: 'OPERATION',
        reportPerformancePercent: 85.7,
        dataFlags: [],
      },
      // M1 Day 2 Shift B: 300 min run, 180 min unplanned breakdown
      {
        id: 'REP-2',
        reportNumber: 'PR-002',
        reportDate: '2026-11-25T16:00:00.000Z',
        dateKey: '2026-11-25',
        moId: 'MO-1',
        moNumber: 'MO-1404-001',
        partId: 'P-1',
        partCode: 'PRT-001',
        partName: 'سینی کف جلو',
        operationId: 'OP-1',
        stepNumber: 1,
        stepCode: 'OP10',
        stepName: 'کشش اولیه',
        machineId: 'M1',
        machineCode: 'PRS-400',
        machineName: 'پرس ۴۰۰ تن هیدرولیک',
        hallLocation: 'سالن پرس ۱',
        shiftId: 'SH-B',
        shiftCode: 'SHIFT-EVENING',
        shiftName: 'شیفت عصر (B)',
        operatorName: 'رضا کریمی',
        goodQty: 800,
        scrapQty: 0,
        reworkQty: 0,
        rejectedQty: 0,
        totalProducedQty: 800,
        runTimeMinutes: 300,
        downtimeMinutes: 180,
        downtimeReason: 'خرابی سیستم هیدرولیک',
        downtimeCategory: 'UNPLANNED',
        strokeCounterStart: null,
        strokeCounterEnd: null,
        idealCycleTimeSec: 18,
        idealCycleSource: 'OPERATION',
        reportPerformancePercent: 80.0,
        dataFlags: [],
      },
      // M2 Day 1 Shift A: 200 min run, 100 min breakdown; 500 produced (400 good, 100 scrap), ideal = 12s => idealRun = 100 min => P = 50%, Q = 80%
      {
        id: 'REP-3',
        reportNumber: 'PR-003',
        reportDate: '2026-11-24T12:00:00.000Z',
        dateKey: '2026-11-24',
        moId: 'MO-2',
        moNumber: 'MO-1404-002',
        partId: 'P-2',
        partCode: 'PRT-002',
        partName: 'براکت ستون',
        operationId: 'OP-2',
        stepNumber: 1,
        stepCode: 'OP20',
        stepName: 'پانچ و خم',
        machineId: 'M2',
        machineCode: 'PRS-160',
        machineName: 'پرس ۱۶۰ تن ضربه‌ای',
        hallLocation: 'سالن پرس ۲',
        shiftId: 'SH-A',
        shiftCode: 'SHIFT-MORNING',
        shiftName: 'شیفت صبح (A)',
        operatorName: 'مهدی حسینی',
        goodQty: 400,
        scrapQty: 100,
        reworkQty: 0,
        rejectedQty: 0,
        totalProducedQty: 500,
        runTimeMinutes: 200,
        downtimeMinutes: 100,
        downtimeReason: 'خرابی فیدر ورق',
        downtimeCategory: 'UNPLANNED',
        strokeCounterStart: null,
        strokeCounterEnd: null,
        idealCycleTimeSec: 12,
        idealCycleSource: 'OPERATION',
        reportPerformancePercent: 50.0,
        dataFlags: [],
      },
    ],
    downtimeEvents: [
      {
        id: 'DT-REP-1',
        source: 'PRODUCTION_REPORT',
        category: 'SETUP',
        machineId: 'M1',
        machineCode: 'PRS-400',
        machineName: 'پرس ۴۰۰ تن هیدرولیک',
        hallLocation: 'سالن پرس ۱',
        moId: 'MO-1',
        moNumber: 'MO-1404-001',
        operationId: 'OP-1',
        stepCode: 'OP10',
        shiftId: 'SH-A',
        shiftName: 'شیفت صبح (A)',
        reason: 'تعویض قالب و ستاپ خط',
        durationMinutes: 30,
        recordedAt: '2026-11-24T10:00:00.000Z',
        dateKey: '2026-11-24',
        recordedBy: 'علی رضایی',
      },
      {
        id: 'DT-PM-1',
        source: 'STANDALONE_DOWNTIME',
        category: 'PLANNED',
        machineId: 'M1',
        machineCode: 'PRS-400',
        machineName: 'پرس ۴۰۰ تن هیدرولیک',
        hallLocation: 'سالن پرس ۱',
        moId: 'MO-1',
        moNumber: 'MO-1404-001',
        operationId: 'OP-1',
        stepCode: 'OP10',
        shiftId: 'SH-A',
        shiftName: 'شیفت صبح (A)',
        reason: 'سرویس دوره‌ای PM',
        durationMinutes: 30,
        recordedAt: '2026-11-24T08:00:00.000Z',
        dateKey: '2026-11-24',
        recordedBy: 'واحد نت',
      },
      {
        id: 'DT-REP-2',
        source: 'PRODUCTION_REPORT',
        category: 'UNPLANNED',
        machineId: 'M1',
        machineCode: 'PRS-400',
        machineName: 'پرس ۴۰۰ تن هیدرولیک',
        hallLocation: 'سالن پرس ۱',
        moId: 'MO-1',
        moNumber: 'MO-1404-001',
        operationId: 'OP-1',
        stepCode: 'OP10',
        shiftId: 'SH-B',
        shiftName: 'شیفت عصر (B)',
        reason: 'خرابی سیستم هیدرولیک',
        durationMinutes: 180,
        recordedAt: '2026-11-25T16:00:00.000Z',
        dateKey: '2026-11-25',
        recordedBy: 'رضا کریمی',
      },
      {
        id: 'DT-REP-3',
        source: 'PRODUCTION_REPORT',
        category: 'UNPLANNED',
        machineId: 'M2',
        machineCode: 'PRS-160',
        machineName: 'پرس ۱۶۰ تن ضربه‌ای',
        hallLocation: 'سالن پرس ۲',
        moId: 'MO-2',
        moNumber: 'MO-1404-002',
        operationId: 'OP-2',
        stepCode: 'OP20',
        shiftId: 'SH-A',
        shiftName: 'شیفت صبح (A)',
        reason: 'خرابی فیدر ورق',
        durationMinutes: 100,
        recordedAt: '2026-11-24T12:00:00.000Z',
        dateKey: '2026-11-24',
        recordedBy: 'مهدی حسینی',
      },
    ],
  };

  const res = computeOeeAnalyticsFromNormalizedInputs(dataset, {});

  // Check machine rows
  const m1 = res.machines.find(m => m.machineId === 'M1')!;
  const m2 = res.machines.find(m => m.machineId === 'M2')!;
  const m3 = res.machines.find(m => m.machineId === 'M3')!;

  // M1: Scheduled = 960, Planned PM = 30 => PlannedProd = 930; Operating = 720; Setup = 30; Unplanned = 180
  // A = 720 / 930 = 77.4%; IdealRun = 360 + 240 = 600 => P = 600 / 720 = 83.3%; Q = 1940 / 2000 = 97.0%
  // OEE = 77.42% * 83.33% * 97.0% = 62.6%
  assert.equal(m1.dataQualityStatus, 'RELIABLE');
  approxEqual(m1.availabilityPercent, 77.4, 0.2, 'M1 A');
  approxEqual(m1.performancePercent, 83.3, 0.2, 'M1 P');
  approxEqual(m1.qualityPercent, 97.0, 0.1, 'M1 Q');
  approxEqual(m1.oeePercent, 62.6, 0.2, 'M1 OEE');
  assert.equal(m1.time.plannedDowntimeMinutes, 30);
  assert.equal(m1.time.setupTimeMinutes, 30);
  assert.equal(m1.time.unplannedDowntimeMinutes, 180);
  assert.equal(m1.mttrMinutes, 180);
  assert.equal(m1.mtbfMinutes, 720);

  // M2: Scheduled = 480, Operating = 200, Unplanned = 100 => A = 200/480 = 41.7%, P = 100/200 = 50.0%, Q = 400/500 = 80.0%, OEE = 16.7%
  approxEqual(m2.availabilityPercent, 41.7, 0.2, 'M2 A');
  approxEqual(m2.performancePercent, 50.0, 0.2, 'M2 P');
  approxEqual(m2.qualityPercent, 80.0, 0.1, 'M2 Q');
  approxEqual(m2.oeePercent, 16.7, 0.2, 'M2 OEE');

  // M3: No activity => null metrics, INSUFFICIENT_DATA
  assert.equal(m3.oeePercent, null);
  assert.equal(m3.dataQualityStatus, 'INSUFFICIENT_DATA');

  // Weighted Plant Summary vs Unweighted Average:
  // Plant totals: Scheduled = 1440, Planned PM = 30 => PlannedProd = 1410, Operating = 920 => A = 65.25%
  // IdealRun = 700 / 920 => P = 76.09%; Q = 2340 / 2500 = 93.6%; Weighted OEE = 46.5%
  // (Whereas unweighted average of M1=62.6 and M2=16.7 would be 39.65%!)
  approxEqual(res.summary.availabilityPercent, 65.2, 0.2, 'Weighted Plant A');
  approxEqual(res.summary.performancePercent, 76.1, 0.2, 'Weighted Plant P');
  approxEqual(res.summary.qualityPercent, 93.6, 0.1, 'Weighted Plant Q');
  approxEqual(res.summary.oeePercent, 46.5, 0.2, 'Weighted Plant OEE');
  assert.ok(Math.abs((res.summary.oeePercent as number) - 39.65) > 5, 'Plant OEE must be weighted, not unweighted avg');

  // Dimensions check
  assert.equal(res.byShift.length, 2);
  assert.equal(res.byOperation.length, 2);
  assert.equal(res.byDate.length, 2);
  assert.equal(res.downtimeSummary.totalDowntimeMinutes, 340);
  assert.equal(res.downtimeSummary.plannedDowntimeMinutes, 30);
  assert.equal(res.downtimeSummary.setupTimeMinutes, 30);
  assert.equal(res.downtimeSummary.unplannedDowntimeMinutes, 280);

  // Filter check: date = 2026-11-25 only => only M1 REP-2
  const day2 = computeOeeAnalyticsFromNormalizedInputs(dataset, {
    startDate: '2026-11-25',
    endDate: '2026-11-25',
  });
  assert.equal(day2.sourceRecords.productionReports.length, 1);
  assert.equal(day2.sourceRecords.productionReports[0].id, 'REP-2');
  assert.equal(day2.byDate.length, 1);
  assert.equal(day2.byDate[0].date, '2026-11-25');

  // Filter check: hall = سالن پرس ۲ => only M2
  const hall2 = computeOeeAnalyticsFromNormalizedInputs(dataset, { hall: 'سالن پرس ۲' });
  assert.equal(hall2.machines.length, 1);
  assert.equal(hall2.machines[0].machineId, 'M2');

  console.log('PASS [3/6]: Multi-dimensional aggregation, weighted plant summary & filters');
}

// -------------------------------------------------------------------------
// TEST 4: Relational Prisma read-path & AuditLog downtime deduplication
// -------------------------------------------------------------------------
async function testRelationalPrismaPathAndDeduplication() {
  const reportDate = new Date('2026-11-24T09:30:00.000Z');
  const mockPrisma = {
    machine: {
      findMany: async () => [
        {
          id: 'DB-M1',
          code: 'PRS-600',
          name: 'پرس ۶۰۰ تن کشش',
          hallLocation: 'سالن پرس سنگین',
          machineType: 'DRAWING',
          tonnageCapacity: 600,
          maxStrokesPerMinute: 10,
          status: 'ACTIVE',
        },
      ],
    },
    shift: {
      findMany: async () => [
        { id: 'DB-SH1', code: 'SHIFT-MORNING', name: 'شیفت صبح', productiveHours: 8, isActive: true },
      ],
    },
    productionOperation: {
      findMany: async () => [
        {
          id: 'DB-OP1',
          manufacturingOrderId: 'DB-MO1',
          stepNumber: 1,
          stepCode: 'OP10',
          stepName: 'کشش اصلی',
          plannedQty: 600,
          standardCycleTimeSec: 20,
          plannedMachineId: 'DB-M1',
          status: 'IN_PROGRESS',
          manufacturingOrder: {
            id: 'DB-MO1',
            moNumber: 'MO-DB-100',
            partId: 'DB-P1',
            status: 'IN_PROGRESS',
            part: { id: 'DB-P1', code: 'PRT-DB-1', name: 'درب موتور' },
          },
          routeOperation: { standardCycleTimeSec: 20, setupTimeMin: 20 },
        },
      ],
    },
    productionReport: {
      findMany: async () => [
        {
          id: 'DB-REP-1',
          reportNumber: 'PR-DB-001',
          reportDate,
          manufacturingOrderId: 'DB-MO1',
          productionOperationId: 'DB-OP1',
          machineId: 'DB-M1',
          shiftId: 'DB-SH1',
          goodQuantity: 540,
          scrapQuantity: 60,
          reworkQuantity: 0,
          rejectedQuantity: 0,
          runTimeMinutes: 360,
          downtimeMinutes: 40,
          downtimeReason: 'تعویض قالب (ستاپ)',
          strokeCounterStart: 0,
          strokeCounterEnd: 600,
          manufacturingOrder: {
            id: 'DB-MO1',
            moNumber: 'MO-DB-100',
            partId: 'DB-P1',
            part: { id: 'DB-P1', code: 'PRT-DB-1', name: 'درب موتور' },
          },
          productionOperation: {
            id: 'DB-OP1',
            stepNumber: 1,
            stepCode: 'OP10',
            stepName: 'کشش اصلی',
            standardCycleTimeSec: 20,
            routeOperation: { standardCycleTimeSec: 20, setupTimeMin: 20 },
          },
          machine: {
            id: 'DB-M1',
            code: 'PRS-600',
            name: 'پرس ۶۰۰ تن کشش',
            hallLocation: 'سالن پرس سنگین',
            maxStrokesPerMinute: 10,
          },
          shift: { id: 'DB-SH1', code: 'SHIFT-MORNING', name: 'شیفت صبح', productiveHours: 8 },
          operator: { id: 'U1', fullName: 'اپراتور تست', username: 'op1' },
        },
      ],
    },
    machineAssignment: {
      findMany: async () => [
        {
          id: 'DB-ASG-1',
          machineId: 'DB-M1',
          productionOperationId: 'DB-OP1',
          shiftId: 'DB-SH1',
          assignedDate: new Date('2026-11-24T00:00:00.000Z'),
          status: 'CONFIRMED',
          machine: { id: 'DB-M1', code: 'PRS-600', name: 'پرس ۶۰۰ تن کشش' },
          shift: { id: 'DB-SH1', code: 'SHIFT-MORNING', name: 'شیفت صبح', productiveHours: 8 },
          productionOperation: {
            id: 'DB-OP1',
            stepCode: 'OP10',
            manufacturingOrderId: 'DB-MO1',
            manufacturingOrder: { id: 'DB-MO1', moNumber: 'MO-DB-100' },
          },
        },
      ],
    },
    auditLog: {
      findMany: async () => [
        // 1. Linked AuditLog (has productionReportId) => MUST be deduplicated and NOT double-counted!
        {
          id: 'AUD-DUP-1',
          action: 'SHOP_FLOOR_DOWNTIME',
          createdAt: reportDate,
          newValues: {
            productionReportId: 'DB-REP-1',
            machineId: 'DB-M1',
            shiftId: 'DB-SH1',
            operationId: 'DB-OP1',
            moId: 'DB-MO1',
            reason: 'تعویض قالب (ستاپ)',
            durationMinutes: 40,
          },
          user: { fullName: 'اپراتور تست', username: 'op1' },
        },
        // 2. Standalone unplanned breakdown => MUST be counted once!
        {
          id: 'AUD-UNP-2',
          action: 'SHOP_FLOOR_DOWNTIME',
          createdAt: reportDate,
          newValues: {
            machineId: 'DB-M1',
            shiftId: 'DB-SH1',
            operationId: 'DB-OP1',
            moId: 'DB-MO1',
            reason: 'خرابی سنسور محافظ قالب',
            durationMinutes: 20,
          },
          user: { fullName: 'تکنسین نت', username: 'maint1' },
        },
      ],
    },
  };

  __setProductionWipPrismaForTests(mockPrisma as any);
  try {
    const analytics = await getRelationalOeeAnalytics({});
    assert.equal(analytics.source, 'postgresql');
    assert.equal(analytics.sourceRecords.downtimeEvents.length, 2, 'Linked AuditLog must be deduplicated');
    assert.equal(analytics.downtimeSummary.setupTimeMinutes, 40, 'Setup downtime counted once (40 min, not 80)');
    assert.equal(analytics.downtimeSummary.unplannedDowntimeMinutes, 20, 'Standalone breakdown counted once');
    assert.equal(analytics.downtimeSummary.totalDowntimeMinutes, 60);

    // Scheduled = 480, Planned DT = 0 => PlannedProd = 480, Operating = 360 => A = 75.0%
    // 600 pcs * 20s / 60 = 200 min ideal run => P = 200 / 360 = 55.6%
    // Q = 540 / 600 = 90.0%
    // OEE = 75.0 * 55.56 * 90.0 / 10000 = 37.5%
    approxEqual(analytics.summary.availabilityPercent, 75.0, 0.1, 'DB A');
    approxEqual(analytics.summary.performancePercent, 55.6, 0.1, 'DB P');
    approxEqual(analytics.summary.qualityPercent, 90.0, 0.1, 'DB Q');
    approxEqual(analytics.summary.oeePercent, 37.5, 0.2, 'DB OEE');

    const { csv } = buildOeeAnalyticsCsv(analytics, 'machines');
    assert.ok(csv.startsWith('\uFEFF'), 'CSV should include UTF-8 BOM');
    assert.ok(csv.includes('PRS-600'), 'CSV should contain machine code');
    assert.ok(csv.includes('37.5%'), 'CSV OEE must match analytics summary OEE');
  } finally {
    __setProductionWipPrismaForTests(null);
  }

  console.log('PASS [4/6]: Relational Prisma read-path, AuditLog deduplication & CSV export');
}

// -------------------------------------------------------------------------
// TEST 5 & 6: End-to-End HTTP Fallback Parity + Cross-View/Export Consistency
// -------------------------------------------------------------------------
async function testHttpEndpointsAndConsistency() {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);

  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  try {
    // 1. Inspect existing shop-floor execution board (fallback mode, zero live DB)
    const boardRes = await fetch(`${baseUrl}/shop-floor/execution-board`);
    assert.equal(boardRes.status, 200);
    const boardJson: any = await boardRes.json();
    assert.equal(boardJson.success, true);

    const queue: any[] = boardJson.operationsQueue || [];
    assert.ok(queue.length > 0, 'Expected at least one operation in fallback operationsQueue');

    // Find an executable operation with available station WIP (or startable)
    const candidateOp =
      queue.find((op: any) => op.status !== 'COMPLETED' && !op.predecessorBlocked && (op.availableStationQty || 0) >= 2) ||
      queue.find((op: any) => op.canStart) ||
      queue.find((op: any) => op.status !== 'COMPLETED' && !op.predecessorBlocked) ||
      queue[0];
    assert.ok(candidateOp, 'Expected at least one executable shop-floor operation in fallback seed');

    const opId = candidateOp.id;
    const machineId = candidateOp.machineId || candidateOp.eligibleMachineIds?.[0] || boardJson.masterData?.machines?.[0]?.id;
    assert.ok(machineId, 'Expected valid machineId for operation');
    const shiftId = candidateOp.shiftId || boardJson.masterData?.shifts?.[0]?.id || 'SHIFT-MORNING';

    // Start operation if startable
    if (candidateOp.canStart) {
      const startRes = await fetch(`${baseUrl}/shop-floor/operations/${encodeURIComponent(opId)}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          machineId,
          shiftId,
          operatorName: 'اپراتور تست P4',
          idempotencyKey: `P4-START-${Date.now()}`,
        }),
      });
      assert.ok(startRes.status < 300, `Start failed with ${startRes.status}`);
    }

    // Re-read operation to inspect availableStationQty
    const boardAfterStart: any = await (await fetch(`${baseUrl}/shop-floor/execution-board`)).json();
    const liveOp = (boardAfterStart.operationsQueue || []).find((o: any) => o.id === opId) || candidateOp;
    const availQty = Math.floor(Number(liveOp.availableStationQty || 0));
    const reportGood = availQty >= 2 ? Math.min(90, availQty - 1) : availQty >= 1 ? 1 : 0;
    const reportScrap = availQty >= 2 ? 1 : 0;

    let postedReport = false;
    if (reportGood + reportScrap > 0) {
      const reportRes = await fetch(`${baseUrl}/shop-floor/operations/${encodeURIComponent(opId)}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          machineId,
          shiftId,
          operatorName: 'اپراتور تست P4',
          goodQty: reportGood,
          scrapQty: reportScrap,
          scrapReason: reportScrap > 0 ? 'پارگی لبه ورق حین کشش' : undefined,
          runTimeMinutes: 120,
          downtimeMinutes: 20,
          downtimeReason: 'تعویض قالب و ستاپ خط (SMED)',
          idempotencyKey: `P4-REP-${Date.now()}`,
        }),
      });
      const reportJson: any = await reportRes.json();
      assert.ok(reportRes.status === 200 || reportRes.status === 201, `Report failed (${reportRes.status}): ${JSON.stringify(reportJson)}`);
      assert.equal(reportJson.success, true);
      postedReport = true;
    }

    // Record a standalone unplanned breakdown downtime event on the same machine
    const dtRes = await fetch(`${baseUrl}/shop-floor/downtime`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machineId,
        operationId: opId,
        shiftId,
        reason: 'خرابی کلید اضطراری پرس',
        durationMinutes: 30,
        operatorName: 'اپراتور تست P4',
        idempotencyKey: `P4-DT-${Date.now()}`,
      }),
    });
    const dtJson: any = await dtRes.json();
    assert.ok(dtRes.status === 200 || dtRes.status === 201, `Downtime failed (${dtRes.status}): ${JSON.stringify(dtJson)}`);
    assert.equal(dtJson.success, true);

    // 2. Fetch all analytics/reporting/export endpoints for the same machine
    const [analyticsRes, dashboardRes, utilRes, exportMachinesRes, exportReportsRes, exportDtRes] =
      await Promise.all([
        fetch(`${baseUrl}/oee/analytics?machineId=${encodeURIComponent(machineId)}`),
        fetch(`${baseUrl}/oee/dashboard?machineId=${encodeURIComponent(machineId)}`),
        fetch(`${baseUrl}/machines/utilization-report?machineId=${encodeURIComponent(machineId)}`),
        fetch(`${baseUrl}/oee/analytics/export?dataset=machines&machineId=${encodeURIComponent(machineId)}`),
        fetch(`${baseUrl}/oee/analytics/export?dataset=reports&machineId=${encodeURIComponent(machineId)}`),
        fetch(`${baseUrl}/oee/analytics/export?dataset=downtimes&machineId=${encodeURIComponent(machineId)}`),
      ]);

    assert.equal(analyticsRes.status, 200);
    assert.equal(dashboardRes.status, 200);
    assert.equal(utilRes.status, 200);
    assert.equal(exportMachinesRes.status, 200);
    assert.equal(exportReportsRes.status, 200);
    assert.equal(exportDtRes.status, 200);

    const analyticsJson: any = await analyticsRes.json();
    const dashboardJson: any = await dashboardRes.json();
    const utilJson: any = await utilRes.json();
    const machinesCsvBuf = Buffer.from(await exportMachinesRes.arrayBuffer());
    const machinesCsv = machinesCsvBuf.toString('utf8');
    const reportsCsv = await exportReportsRes.text();
    const downtimesCsv = await exportDtRes.text();

    assert.equal(analyticsJson.success, true);
    assert.equal(analyticsJson.data.source, 'memory-fallback');

    const mRow = analyticsJson.data.machines.find((m: any) => m.machineId === machineId);
    assert.ok(mRow, 'Machine row must exist in /api/oee/analytics');
    if (postedReport) {
      assert.ok(mRow.goodQty >= reportGood, 'Good qty from shop-floor report must reflect in OEE analytics');
      assert.ok(mRow.scrapQty >= reportScrap, 'Scrap qty from shop-floor report must reflect in OEE analytics');
      assert.ok(mRow.time.operatingTimeMinutes >= 120, 'Operating time must reflect report runTimeMinutes');
      assert.ok(mRow.time.setupTimeMinutes >= 20, 'Setup downtime must be classified under setupTimeMinutes');
      assert.ok(
        analyticsJson.data.sourceRecords.productionReports.some((r: any) => r.machineId === machineId),
        'Source productionReports drill-down must contain the recorded report',
      );
      assert.ok(reportsCsv.includes(mRow.machineCode), 'Exported reports CSV must contain machine code');
    }
    assert.ok(
      mRow.time.unplannedDowntimeMinutes >= 30,
      'Standalone breakdown must be classified under unplannedDowntimeMinutes',
    );
    assert.ok(
      analyticsJson.data.sourceRecords.downtimeEvents.some(
        (d: any) => d.machineId === machineId && d.category === 'UNPLANNED' && d.durationMinutes === 30,
      ),
      'Source downtimeEvents drill-down must contain the standalone unplanned event',
    );

    console.log('PASS [5/6]: End-to-end HTTP fallback parity & source-record drill-down');

    // 3. Verify 100% KPI consistency across /api/oee/analytics, /api/oee/dashboard, /api/machines/utilization-report, and CSV export
    const dashMachine = dashboardJson.data.machines.find((m: any) => m.machineId === machineId);
    const utilMachine = utilJson.data.machines.find((m: any) => m.machineId === machineId);
    assert.ok(dashMachine, 'Machine must exist in /api/oee/dashboard');
    assert.ok(utilMachine, 'Machine must exist in /api/machines/utilization-report');

    assert.equal(
      dashboardJson.data.plantOeePercent,
      analyticsJson.data.summary.oeePercent ?? 0,
      '/api/oee/dashboard plantOeePercent must match /api/oee/analytics summary.oeePercent',
    );
    assert.equal(
      dashMachine.availabilityPercent,
      mRow.availabilityPercent ?? 0,
      'Dashboard machine availability must match analytics',
    );
    assert.equal(
      dashMachine.performancePercent,
      mRow.performancePercent ?? 0,
      'Dashboard machine performance must match analytics',
    );
    assert.equal(
      dashMachine.qualityPercent,
      mRow.qualityPercent ?? 0,
      'Dashboard machine quality must match analytics',
    );
    assert.equal(
      dashMachine.oeePercent,
      mRow.oeePercent ?? 0,
      'Dashboard machine OEE must match analytics',
    );
    assert.equal(
      utilMachine.netLoadingEfficiencyPercent,
      mRow.availabilityPercent ?? 0,
      'Utilization report netLoadingEfficiencyPercent must match analytics availabilityPercent',
    );
    assert.equal(
      utilMachine.goodPartsProduced,
      mRow.goodQty,
      'Utilization report goodPartsProduced must match analytics goodQty',
    );
    assert.equal(
      utilMachine.scrapPartsCount,
      mRow.scrapQty,
      'Utilization report scrapPartsCount must match analytics scrapQty',
    );

    // CSV export consistency check
    assert.equal(machinesCsvBuf[0], 0xef, 'Exported machines CSV must start with UTF-8 BOM');
    assert.equal(machinesCsvBuf[1], 0xbb, 'Exported machines CSV must start with UTF-8 BOM');
    assert.equal(machinesCsvBuf[2], 0xbf, 'Exported machines CSV must start with UTF-8 BOM');
    assert.ok(machinesCsv.includes(mRow.machineCode), 'Exported machines CSV must contain machine code');
    const expectedOeeToken = mRow.oeePercent == null ? 'N/A' : `${mRow.oeePercent}%`;
    assert.ok(
      machinesCsv.includes(expectedOeeToken),
      `Exported machines CSV must contain exact OEE token "${expectedOeeToken}"`,
    );
    assert.ok(
      downtimesCsv.includes('خرابی کلید اضطراری پرس'),
      'Exported downtimes CSV must contain standalone downtime reason',
    );

    console.log('PASS [6/6]: 100% KPI consistency across analytics, dashboard, utilization report & CSV exports');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function main() {
  testFormulasAndDowntimeClassification();
  testEdgeCasesAndDataQuality();
  testAggregationAndWeighting();
  await testRelationalPrismaPathAndDeduplication();
  await testHttpEndpointsAndConsistency();
  console.log('\nALL KPIMS P4 OEE & ANALYTICS REGRESSION TESTS PASSED (6/6)');
}

main().catch(err => {
  console.error('KPIMS P4 REGRESSION SUITE FAILED:', err);
  process.exit(1);
});
