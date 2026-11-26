/**
 * =========================================================================
 * KPIMS P7: Final End-to-End System Acceptance Test Suite
 * =========================================================================
 * Executes a continuous, realistic automotive manufacturing workflow across
 * ALL P0–P6 modules in two integrated tracks (strictly isolated, ZERO live DB):
 *
 * TRACK A — Full HTTP End-to-End Workflow (Express apiRouter, Steps 1–10):
 *   1. Receive raw material coils & fasteners under a new SAPCO contract
 *      (incoming coils gated in QUARANTINE for IQC).
 *   2. Verify inventory, coil/lot identity, non-coil guard, and contract balances.
 *   3. Perform Incoming Quality Inspection (IQC): accept production coil (321),
 *      reject defective coil (344 + auto-NCR + RETURN_TO_SUPPLIER disposition),
 *      and verify quarantine/rejection strictly blocks consumption.
 *   4. Create customer demand (CustomerOrder) and generate/revise/approve
 *      production plan proposal.
 *   5. Release Manufacturing Order (MO) and assign eligible machines & shifts
 *      with capacity/conflict verification.
 *   6. Reserve material & issue raw material, including partial-coil consumption
 *      and remnant return with variance (plus over-return block).
 *   7. Execute production operations on shop floor: start -> pause/downtime ->
 *      resume -> production report (good + scrap + runtime + downtime + material
 *      consumption) -> standalone downtime -> WIP inter-operation transfers ->
 *      complete all operations through finished good receipt.
 *   8. Perform In-Process (IPQC) & Final Product (FQC) quality inspections linked
 *      to the MO and finished goods lot.
 *   9. Exercise NCR, quarantine containment (344), REWORK (with good + scrap split
 *      and auto-closure), USE_AS_IS (321), SCRAP, and REJECT/RETURN_TO_SUPPLIER.
 *  10. Verify finished inventory, reservations (create + release), end-to-end
 *      traceability (coil genealogy, document flow, full chain, quality history),
 *      SAPCO contract balances, 4-way inventory reconciliation, WIP reconciliation,
 *      OEE reporting consistency, and Quality dashboard analytics.
 *
 * TRACK B — Unified Relational Prisma Service-Layer End-to-End Workflow:
 *   Chains inventoryLedgerService + relationalPlanningReadModel +
 *   relationalPlanProposalService + relationalMachineSchedulingService +
 *   productionWipService + relationalShopFloorService + relationalOeeAnalyticsService
 *   on ONE single shared relational database state (mock Prisma client, ZERO live PG).
 *
 * Run with: DATABASE_URL="" npx tsx scripts/test-kpims-p7-e2e-acceptance.ts
 * =========================================================================
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { apiRouter } from '../src/server/apiRouter';
import { resetQualityStateForTests } from '../src/server/qualityManagementService';
import {
  postInventoryDocumentInTransaction,
  issuePhysicalCoilInDbTransaction,
  returnPhysicalCoilRemnantInDbTransaction,
  queryContractsAndSapcoAccountFromDb,
  createReservationInDbTransaction,
} from '../src/server/services/inventoryLedgerService';
import { getRelationalPlanningReadModel } from '../src/server/relationalPlanningReadModel';
import {
  createRelationalPlanProposal,
  approveRelationalPlanProposal,
  releaseRelationalPlanProposal,
} from '../src/server/relationalPlanProposalService';
import {
  createRelationalMachineAssignment,
  getRelationalMachineCapacity,
} from '../src/server/relationalMachineSchedulingService';
import {
  __setProductionWipPrismaForTests,
} from '../src/server/services/productionWipService';
import {
  getRelationalShopFloorBoard,
  startShopFloorOperation,
  pauseShopFloorOperation,
  resumeShopFloorOperation,
  recordShopFloorProductionReport,
  completeShopFloorOperation,
  recordShopFloorDowntime,
} from '../src/server/relationalShopFloorService';
import { getRelationalOeeAnalytics } from '../src/server/relationalOeeAnalyticsService';

if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '') {
  throw new Error('Refusing to run isolated P7 acceptance test suite when DATABASE_URL is configured.');
}

const ADMIN_HEADERS = {
  'Content-Type': 'application/json',
  'x-kpims-role': 'ADMIN',
  'x-user-role': 'ADMIN',
  'x-user-id': 'USR-P7-ADMIN',
  'x-user-name': 'Admin P7 Acceptance',
};

const QC_HEADERS = {
  'Content-Type': 'application/json',
  'x-kpims-role': 'QC_INSPECTOR',
  'x-user-role': 'QC_INSPECTOR',
  'x-user-id': 'USR-P7-QC',
  'x-user-name': 'QC Inspector P7',
};

interface ScenarioResult {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL';
  details: string;
}

const scenarioResults: ScenarioResult[] = [];

async function runScenario(id: string, name: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    scenarioResults.push({ id, name, status: 'PASS', details: detail || 'OK' });
    console.log(`✅ [${id}] PASS — ${name}${detail ? ` (${detail})` : ''}`);
  } catch (err: any) {
    const msg = err?.message || String(err);
    scenarioResults.push({ id, name, status: 'FAIL', details: msg });
    console.error(`❌ [${id}] FAIL — ${name}\n   ↳ ${msg}`);
    throw err;
  }
}

async function httpJson(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      ...ADMIN_HEADERS,
      ...(options.headers || {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ok: res.ok, json, headers: res.headers };
}

// =========================================================================
// TRACK A: FULL HTTP END-TO-END SYSTEM ACCEPTANCE (STEPS 1–10)
// =========================================================================
async function runTrackAHttpEndToEnd() {
  console.log('\n=========================================================================');
  console.log('TRACK A: FULL HTTP END-TO-END ACCEPTANCE (P0–P6 UNIFIED WORKFLOW)');
  console.log('=========================================================================');

  const snapshotPaths = [
    path.resolve(process.cwd(), 'data', 'kpims-enterprise-db.json'),
    path.resolve(process.cwd(), 'data', 'kpims-wip-db.json'),
  ];
  const savedSnapshots = snapshotPaths.map(p => ({
    filePath: p,
    existed: fs.existsSync(p),
    content: fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null,
  }));

  resetQualityStateForTests();

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', apiRouter);

  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  assert(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}/api`;

  const ts = Date.now();
  const suffix = String(ts).slice(-5);
  const contractNumber = `CNT-SAPCO-P7-${suffix}`;
  const coilGoodCode = `COIL-P7-A-${suffix}`;
  const coilGoodPack = `CP-P7-A-${suffix}`;
  const coilGoodHeat = `HT-P7-A-${suffix}`;
  const coilBadCode = `COIL-P7-B-${suffix}`;
  const coilBadPack = `CP-P7-B-${suffix}`;
  const coilBadHeat = `HT-P7-B-${suffix}`;
  const fastenerLot = `LOT-P7-NUT-${suffix}`;
  const supplierGood = `فولاد مبارکه اصفهان P7-${suffix}`;
  const supplierBad = `نورد آزمایشی نامنطبق P7-${suffix}`;

  let contractId = '';
  let coilGoodId = '';
  let coilBadId = '';
  let customerOrderNumber = `ORD-SAPCO-P7-${suffix}`;
  let releasedMainMo: any = null;
  let releasedFgMo: any = null;
  let fgProducedLot = '';
  let fgProducedQty = 0;
  let assignedOp1MachineId = '';

  try {
    // -----------------------------------------------------------------------
    // SCENARIO 1: Receive Raw Material Under a Contract (Coils + Fasteners)
    // -----------------------------------------------------------------------
    await runScenario('S1', 'Receive raw material under a SAPCO contract', async () => {
      const cntRes = await httpJson(baseUrl, '/inventory/contracts', {
        method: 'POST',
        body: {
          contractNumber,
          title: 'قرارداد تامین ورق DC01A و اتصالات براکت ECU تست پذیرش P7',
          customerName: 'شرکت ساپکو',
          contractType: 'HYBRID',
          ownership: 'SAPCO_SUPPLIER_OWNED',
          materialGrade: 'DC01A',
          allocatedWeightKg: 5000,
          openingBalanceKg: 0,
          associatedPartCodes: ['WIP-ECU-MAIN-BRK', 'SAPCO-ASY-ECU-BRK-01'],
        },
      });
      assert.equal(cntRes.status, 201, `Contract creation failed: ${JSON.stringify(cntRes.json)}`);
      contractId = cntRes.json.contract.id;

      // Record coil count before receiving
      const beforeCoils = await httpJson(baseUrl, '/inventory/coils');
      const coilsCountBefore = (beforeCoils.json.data || []).length;

      // Receive Coil A (2,000 kg DC01A) in QUARANTINE for IQC
      const recA = await httpJson(baseUrl, '/inventory/documents', {
        method: 'POST',
        headers: { 'Idempotency-Key': `P7-REC-COILA-${ts}` },
        body: {
          documentType: 'RECEIPT_RAW_MATERIAL',
          warehouseId: 'WH-RAW',
          ownership: 'SAPCO_SUPPLIER_OWNED',
          contractId,
          contractNumber,
          referenceType: 'SAPCO_WAYBILL',
          referenceNumber: `WB-P7-A-${suffix}`,
          autoPost: true,
          lines: [
            {
              partId: 'PRT-RAW-ECU-COIL',
              partCode: 'RM-COIL-DC01A-2.0-1140',
              partName: 'رول ورق روغنی DC01A ضخامت 2mm با عرض 1140mm',
              quantity: 2000,
              quantityKg: 2000,
              unit: 'KG',
              lotNumber: coilGoodCode,
              coilId: coilGoodCode,
              coilPackNumber: coilGoodPack,
              heatNumber: coilGoodHeat,
              materialGrade: 'DC01A',
              thicknessMm: 2.0,
              widthMm: 1140,
              locationCode: 'LOC-RAW-A1',
              ownership: 'SAPCO_SUPPLIER_OWNED',
              contractId,
              contractNumber,
              qualityStatus: 'QUARANTINE',
              supplierName: supplierGood,
            },
          ],
        },
      });
      assert.equal(recA.status, 201, `Coil A receipt failed: ${JSON.stringify(recA.json)}`);

      // Receive Coil B (1,000 kg DC01A) in QUARANTINE for IQC rejection scenario
      const recB = await httpJson(baseUrl, '/inventory/documents', {
        method: 'POST',
        headers: { 'Idempotency-Key': `P7-REC-COILB-${ts}` },
        body: {
          documentType: 'RECEIPT_RAW_MATERIAL',
          warehouseId: 'WH-RAW',
          ownership: 'SAPCO_SUPPLIER_OWNED',
          contractId,
          contractNumber,
          referenceType: 'SAPCO_WAYBILL',
          referenceNumber: `WB-P7-B-${suffix}`,
          autoPost: true,
          lines: [
            {
              partId: 'PRT-RAW-ECU-COIL',
              partCode: 'RM-COIL-DC01A-2.0-1140',
              partName: 'رول ورق روغنی DC01A ضخامت 2mm با عرض 1140mm',
              quantity: 1000,
              quantityKg: 1000,
              unit: 'KG',
              lotNumber: coilBadCode,
              coilId: coilBadCode,
              coilPackNumber: coilBadPack,
              heatNumber: coilBadHeat,
              materialGrade: 'DC01A',
              thicknessMm: 2.0,
              widthMm: 1140,
              locationCode: 'LOC-RAW-A1',
              ownership: 'SAPCO_SUPPLIER_OWNED',
              contractId,
              contractNumber,
              qualityStatus: 'QUARANTINE',
              supplierName: supplierBad,
            },
          ],
        },
      });
      assert.equal(recB.status, 201, `Coil B receipt failed: ${JSON.stringify(recB.json)}`);

      // Receive Fastener lot (5,000 PCS M6 weld nuts = 30 kg) under same contract (must NOT create PhysicalCoil)
      const recNut = await httpJson(baseUrl, '/inventory/documents', {
        method: 'POST',
        headers: { 'Idempotency-Key': `P7-REC-NUT-${ts}` },
        body: {
          documentType: 'RECEIPT_RAW_MATERIAL',
          warehouseId: 'WH-RAW',
          ownership: 'SAPCO_SUPPLIER_OWNED',
          contractId,
          contractNumber,
          referenceType: 'PURCHASE_ORDER',
          referenceNumber: `PO-P7-NUT-${suffix}`,
          autoPost: true,
          lines: [
            {
              partId: 'PRT-FST-NUT-M6',
              partCode: 'FST-NUT-WELD-M6',
              partName: 'مهره جوشی چهارگوش پایه‌دار M6',
              quantity: 5000,
              quantityKg: 30,
              unit: 'PCS',
              lotNumber: fastenerLot,
              locationCode: 'LOC-RAW-FST-01',
              ownership: 'SAPCO_SUPPLIER_OWNED',
              contractId,
              contractNumber,
              qualityStatus: 'AVAILABLE',
            },
          ],
        },
      });
      assert.equal(recNut.status, 201, `Fastener receipt failed: ${JSON.stringify(recNut.json)}`);

      const afterCoils = await httpJson(baseUrl, '/inventory/coils');
      assert.equal(
        (afterCoils.json.data || []).length,
        coilsCountBefore + 2,
        'Exactly 2 PhysicalCoils (Coil A & B) must be created; fastener must NOT create a PhysicalCoil'
      );

      return `Contract ${contractNumber}: received 2000kg Coil A + 1000kg Coil B (QUARANTINE) + 5000 PCS nuts`;
    });

    // -----------------------------------------------------------------------
    // SCENARIO 2: Verify Inventory, Coil/Lot Identity & Contract Balances
    // -----------------------------------------------------------------------
    await runScenario('S2', 'Verify inventory, coil/lot identity, and contract balances', async () => {
      const coilsRes = await httpJson(
        baseUrl,
        `/inventory/coils?contractNumber=${encodeURIComponent(contractNumber)}`
      );
      assert.equal(coilsRes.status, 200);
      const contractCoils: any[] = coilsRes.json.data || [];
      assert.equal(contractCoils.length, 2, 'Expected 2 coils linked to the new contract');

      const cA = contractCoils.find(c => c.coilId === coilGoodCode);
      const cB = contractCoils.find(c => c.coilId === coilBadCode);
      assert(cA && cB, 'Both Coil A and Coil B must be found by contract filter');
      assert.equal(cA.heatNumber, coilGoodHeat);
      assert.equal(cA.coilPackNumber, coilGoodPack);
      assert.equal(cA.remainingWeightKg, 2000);
      assert.equal(cA.qualityStatus, 'QUARANTINE');
      assert.equal(cB.remainingWeightKg, 1000);
      assert.equal(cB.qualityStatus, 'QUARANTINE');
      coilGoodId = cA.id;
      coilBadId = cB.id;

      // Verify stock inquiry shows QUARANTINE stock in qualityInspectionQty (availableQty = 0)
      const stockRes = await httpJson(
        baseUrl,
        `/inventory/stock-inquiry?contractNumber=${encodeURIComponent(contractNumber)}`
      );
      assert.equal(stockRes.status, 200);
      const rows: any[] = stockRes.json.data || [];
      const rowA = rows.find(r => r.lotNumber === coilGoodCode);
      const rowB = rows.find(r => r.lotNumber === coilBadCode);
      const rowNut = rows.find(r => r.lotNumber === fastenerLot);
      assert(rowA && rowB && rowNut, 'Expected stock balances for Coil A, Coil B, and fastener lot');
      assert.equal(rowA.physicalQty, 2000);
      assert.equal(rowA.availableQty, 0, 'Quarantined Coil A must have 0 availableQty');
      assert.equal(rowA.qualityInspectionQty, 2000);
      assert.equal(rowNut.physicalQty, 5000);
      assert.equal(rowNut.availableQty, 5000);

      // Verify SAPCO contract balance before consumption: 2000 + 1000 + 30 = 3030 kg
      const sapcoRes = await httpJson(baseUrl, '/inventory/sapco-account');
      assert.equal(sapcoRes.status, 200);
      const cnt = (sapcoRes.json.contracts || []).find((c: any) => c.id === contractId);
      assert(cnt, 'New contract must appear in /api/inventory/sapco-account');
      assert.equal(cnt.totalReceivedKg, 3030, `Expected 3030kg received, got ${cnt.totalReceivedKg}`);
      assert.equal(cnt.totalConsumedKg, 0);
      assert.equal(cnt.closingBalanceKg, 3030);

      // Verify quarantined Coil A CANNOT be issued before IQC acceptance
      const blockedIssue = await httpJson(baseUrl, `/inventory/coils/${encodeURIComponent(coilGoodId)}/issue`, {
        method: 'POST',
        headers: { 'Idempotency-Key': `P7-PRE-IQC-BLOCK-${ts}` },
        body: { issuedWeightKg: 200, moId: 'MO-PRE-TEST' },
      });
      assert.equal(blockedIssue.status, 409, 'Quarantined coil MUST be blocked from issue before IQC');

      return `Coils verified (heat/pack/contract), QUARANTINE issue blocked (409), contract balance=3030kg`;
    });

    // -----------------------------------------------------------------------
    // SCENARIO 8A & 9A: Incoming Quality Inspection (IQC) — Accept Coil A,
    //                   Reject Coil B -> Auto-NCR -> RETURN_TO_SUPPLIER
    // -----------------------------------------------------------------------
    await runScenario('S8a+S9a', 'Incoming Quality Inspection (IQC): accept Coil A & reject/return Coil B', async () => {
      // IQC Coil A -> PENDING -> ACCEPTED (MvT 321)
      const iqcA = await httpJson(baseUrl, '/quality/inspections', {
        method: 'POST',
        headers: { ...QC_HEADERS, 'Idempotency-Key': `P7-IQC-A-${ts}` },
        body: {
          inspectionType: 'INCOMING_MATERIAL',
          partId: 'PRT-RAW-ECU-COIL',
          warehouseId: 'WH-RAW',
          lotNumber: coilGoodCode,
          coilId: coilGoodCode,
          supplierName: supplierGood,
          inspectedQty: 2000,
          notes: 'بازرسی ورودی کلاف اصلی P7',
        },
      });
      assert.equal(iqcA.status, 201, `IQC A create failed: ${JSON.stringify(iqcA.json)}`);

      const decA = await httpJson(baseUrl, `/quality/inspections/${iqcA.json.data.id}/decide`, {
        method: 'POST',
        headers: { ...QC_HEADERS, 'Idempotency-Key': `P7-IQC-A-DEC-${ts}` },
        body: { decision: 'ACCEPTED', acceptedQty: 2000, notes: 'انطباق کامل متالورژی و ضخامت ۲ میلی‌متر' },
      });
      assert.equal(decA.status, 200, `IQC A decide failed: ${JSON.stringify(decA.json)}`);
      assert.ok(decA.json.qmDocument?.documentNumber, 'IQC acceptance must post MvT 321');

      // IQC Coil B -> Immediate REJECTED (MvT 344) + auto-NCR
      const iqcB = await httpJson(baseUrl, '/quality/inspections', {
        method: 'POST',
        headers: { ...QC_HEADERS, 'Idempotency-Key': `P7-IQC-B-${ts}` },
        body: {
          inspectionType: 'INCOMING_MATERIAL',
          partId: 'PRT-RAW-ECU-COIL',
          warehouseId: 'WH-RAW',
          lotNumber: coilBadCode,
          coilId: coilBadCode,
          supplierName: supplierBad,
          inspectedQty: 1000,
          decision: 'REJECTED',
          rejectedQty: 1000,
          defectCodes: ['DEF-THICK'],
          severity: 'CRITICAL',
          defectSummary: 'ضخامت خارج از تلرانس ۱.۷۵ به جای ۲.۰۰ میلی‌متر',
        },
      });
      assert.equal(iqcB.status, 201, `IQC B reject failed: ${JSON.stringify(iqcB.json)}`);
      assert.ok(iqcB.json.ncr?.id, 'Rejected IQC must auto-create NCR');

      // Rejected Coil B MUST be strictly blocked from issue
      const blockedB = await httpJson(baseUrl, `/inventory/coils/${encodeURIComponent(coilBadId)}/issue`, {
        method: 'POST',
        headers: { 'Idempotency-Key': `P7-TRY-ISS-BADB-${ts}` },
        body: { issuedWeightKg: 100, moId: 'MO-PRE-TEST' },
      });
      assert.equal(blockedB.status, 409, 'Rejected coil MUST remain blocked from production issue');

      // Dispose Coil B NCR as RETURN_TO_SUPPLIER
      const dispB = await httpJson(baseUrl, `/quality/ncrs/${iqcB.json.ncr.id}/disposition`, {
        method: 'POST',
        headers: { ...QC_HEADERS, 'Idempotency-Key': `P7-DISP-RTS-B-${ts}` },
        body: {
          disposition: 'RETURN_TO_SUPPLIER',
          rootCause: 'خطای کنترل ضخامت در خط نورد تامین‌کننده',
          correctiveAction: 'عودت کامل کلاف ۱۰۰۰ کیلوگرمی و جایگزینی توسط ساپکو',
        },
      });
      assert.equal(dispB.status, 200, `RETURN_TO_SUPPLIER failed: ${JSON.stringify(dispB.json)}`);
      assert.equal(dispB.json.data.status, 'CLOSED');

      // Verify Coil A is now AVAILABLE (2000 kg) and Coil B is RETURNED (0 kg)
      const stockAfterIqc = await httpJson(
        baseUrl,
        `/inventory/stock-inquiry?contractNumber=${encodeURIComponent(contractNumber)}`
      );
      const rowA = (stockAfterIqc.json.data || []).find((r: any) => r.lotNumber === coilGoodCode);
      assert(rowA && rowA.availableQty === 2000, `Expected Coil A available=2000, got ${JSON.stringify(rowA)}`);

      return `Coil A released (321, 2000kg AVAILABLE); Coil B rejected (344), NCR auto-created & returned to supplier`;
    });

    // -----------------------------------------------------------------------
    // SCENARIO 3: Create Customer Demand & Production Plan Proposal
    // -----------------------------------------------------------------------
    await runScenario('S3', 'Create customer demand and production plan proposal', async () => {
      const dueDate = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
      // Create high-demand SAPCO customer order for WIP-ECU-MAIN-BRK AND SAPCO-ASY-ECU-BRK-01
      // so net requirements are strictly positive even above any seeded stock/WIP
      const ordRes = await httpJson(baseUrl, '/planning/customer-orders', {
        method: 'POST',
        body: {
          orderNumber: customerOrderNumber,
          customerName: 'شرکت ساپکو',
          contractNumber,
          dueDate,
          priority: 1,
          notes: 'سفارش واقعی پذیرش نهایی P7',
          lines: [
            {
              partId: 'PRT-WIP-ECU-MAIN',
              partCode: 'WIP-ECU-MAIN-BRK',
              orderedQuantity: 5000,
              dueDate,
            },
            {
              partId: 'PRT-FGD-ECU-BRK',
              partCode: 'SAPCO-ASY-ECU-BRK-01',
              orderedQuantity: 5000,
              dueDate,
            },
          ],
        },
      });
      assert.equal(ordRes.status, 201, `Create customer order failed: ${JSON.stringify(ordRes.json)}`);

      // Verify planning read-model picks up positive net demand
      const rmRes = await httpJson(baseUrl, '/planning/read-model');
      assert.equal(rmRes.status, 200);
      const reqs: any[] = rmRes.json.data?.requirements || rmRes.json.requirements || [];
      const mainReq = reqs.find(r => r.partCode === 'WIP-ECU-MAIN-BRK');
      const fgReq = reqs.find(r => r.partCode === 'SAPCO-ASY-ECU-BRK-01');
      assert(mainReq && mainReq.netToProduceQuantity > 0, 'Expected positive net requirement for WIP-ECU-MAIN-BRK');
      assert(fgReq && fgReq.netToProduceQuantity > 0, 'Expected positive net requirement for SAPCO-ASY-ECU-BRK-01');

      // Generate planning proposal from live demand, inventory & WIP
      const propRes = await httpJson(baseUrl, '/planning/proposals/regenerate', {
        method: 'POST',
        body: { notes: `پیشنهاد برنامه تولید پذیرش P7 برای ${customerOrderNumber}` },
      });
      assert.equal(propRes.status, 201, `Proposal regenerate failed: ${JSON.stringify(propRes.json)}`);
      const proposal = propRes.json.data;
      assert(proposal && proposal.status === 'DRAFT' && proposal.lines.length >= 2);

      // Revise proposal line quantities to a controlled batch (100 pcs MAIN, 60 pcs FG) for execution
      const mainLine = proposal.lines.find(
        (l: any) => l.part?.partNumber === 'WIP-ECU-MAIN-BRK' && l.customerOrderLine?.order?.orderNumber === customerOrderNumber
      );
      const fgLine = proposal.lines.find(
        (l: any) => l.part?.partNumber === 'SAPCO-ASY-ECU-BRK-01' && l.customerOrderLine?.order?.orderNumber === customerOrderNumber
      );
      assert(mainLine && fgLine, 'Proposal must include lines for both ordered parts');

      const revRes = await httpJson(baseUrl, `/planning/proposals/${proposal.id}/revise`, {
        method: 'POST',
        body: {
          note: 'تنظیم لات اجرایی بچ پذیرش P7 (۱۰۰ عدد براکت اصلی، ۶۰ عدد مجموعه نهایی)',
          changes: [
            { proposalLineId: mainLine.id, plannedQty: 100 },
            { proposalLineId: fgLine.id, plannedQty: 60 },
          ],
        },
      });
      assert.ok(revRes.status === 200 || revRes.status === 201, `Proposal revise failed: ${JSON.stringify(revRes.json)}`);
      const revisedProposal = revRes.json.data;
      assert.equal(revisedProposal.version, 2);

      // Approve revised proposal
      const appRes = await httpJson(baseUrl, `/planning/proposals/${revisedProposal.id}/approve`, {
        method: 'POST',
        body: { approvedBy: 'مدیر برنامه‌ریزی P7' },
      });
      assert.equal(appRes.status, 200, `Proposal approve failed: ${JSON.stringify(appRes.json)}`);
      assert.equal(appRes.json.data.status, 'APPROVED');

      // Store approved proposal id on global helper for S4
      (global as any).__p7ApprovedProposalId = revisedProposal.id;
      return `Order ${customerOrderNumber} -> Proposal v2 (${revisedProposal.proposalNumber}) APPROVED`;
    });

    // -----------------------------------------------------------------------
    // SCENARIO 4: Release Manufacturing Order & Assign Machines
    // -----------------------------------------------------------------------
    await runScenario('S4', 'Release manufacturing orders and assign eligible machines', async () => {
      const proposalId = (global as any).__p7ApprovedProposalId;
      const relRes = await httpJson(baseUrl, `/planning/proposals/${proposalId}/release`, {
        method: 'POST',
        body: { releasedBy: 'مدیر تولید P7' },
      });
      assert.equal(relRes.status, 201, `Proposal release failed: ${JSON.stringify(relRes.json)}`);
      const mos: any[] = relRes.json.data?.manufacturingOrders || relRes.json.manufacturingOrders || [];
      assert(mos.length >= 2, `Expected >=2 released MOs, got ${mos.length}`);

      releasedMainMo = mos.find(m => m.partCode === 'WIP-ECU-MAIN-BRK' && m.targetQuantity === 100);
      releasedFgMo = mos.find(m => m.partCode === 'SAPCO-ASY-ECU-BRK-01' && m.targetQuantity === 60);
      assert(releasedMainMo && releasedFgMo, 'Expected released MOs for both MAIN (100) and FG (60)');
      assert.equal(releasedMainMo.status, 'RELEASED');
      assert.equal(releasedFgMo.status, 'RELEASED');

      // Verify machine eligibility & assign machine+shift for OP10 of releasedMainMo
      const op10 = releasedMainMo.operations[0];
      const eligRes = await httpJson(baseUrl, '/planning/evaluate-machine-eligibility', {
        method: 'POST',
        body: {
          processType: op10.processType,
          requiredTonnage: op10.requiredTonnage || 0,
          plannedQuantity: 100,
          standardCycleTimeSec: op10.standardCycleTimeSec || 6,
          setupTimeMin: 15,
        },
      });
      assert.equal(eligRes.status, 200);
      const eligible = (eligRes.json.data || []).filter((m: any) => m.isEligible);
      assert(eligible.length >= 1, 'Expected at least 1 eligible machine for OP10');
      assignedOp1MachineId = op10.machineId || eligible[0].machineId;

      const assignDate = new Date().toISOString().slice(0, 10);
      const asg1 = await httpJson(baseUrl, '/planning/machine-assignments', {
        method: 'POST',
        body: {
          productionOperationId: op10.id,
          machineId: assignedOp1MachineId,
          shiftId: 'SHIFT-MORN',
          assignedDate: assignDate,
          notes: 'تخصیص شیفت صبح برای تست پذیرش P7',
        },
      });
      assert.equal(asg1.status, 201, `Machine assignment failed: ${JSON.stringify(asg1.json)}`);

      // Assign OP60 of FG MO to its machine as well
      const fgOp1 = releasedFgMo.operations[0];
      const asgFg = await httpJson(baseUrl, '/planning/machine-assignments', {
        method: 'POST',
        body: {
          productionOperationId: fgOp1.id,
          machineId: fgOp1.machineId || 'MCH-007',
          shiftId: 'SHIFT-MORN',
          assignedDate: assignDate,
          notes: 'تخصیص ایستگاه مونتاژ نهایی P7',
        },
      });
      assert.equal(asgFg.status, 201, `FG machine assignment failed: ${JSON.stringify(asgFg.json)}`);

      // Verify machine capacity timeline & Shop-Floor Execution Board display our MO
      const capRes = await httpJson(baseUrl, `/planning/machine-capacity?date=${assignDate}`);
      assert.equal(capRes.status, 200);
      const boardRes = await httpJson(
        baseUrl,
        `/shop-floor/execution-board?moId=${encodeURIComponent(releasedMainMo.id)}`
      );
      assert.equal(boardRes.status, 200);
      assert(
        (boardRes.json.workOrders || []).some((w: any) => w.id === releasedMainMo.id),
        'Released MO must appear on Shop-Floor Execution Board'
      );

      return `Released ${releasedMainMo.moNumber} (100 pcs) & ${releasedFgMo.moNumber} (60 pcs); assigned machines`;
    });

    // -----------------------------------------------------------------------
    // SCENARIO 5: Reserve & Issue Raw Material (Partial Coil + Remnant Return)
    // -----------------------------------------------------------------------
    await runScenario('S5', 'Reserve & issue raw material: partial coil consumption + remnant return', async () => {
      // Reserve 500 kg of raw coil for our MO
      const resvRes = await httpJson(baseUrl, '/inventory/reservations', {
        method: 'POST',
        body: {
          partId: 'PRT-RAW-ECU-COIL',
          warehouseId: 'WH-RAW',
          lotNumber: coilGoodCode,
          ownership: 'SAPCO_SUPPLIER_OWNED',
          reservedFor: `رزرو برای دستور ساخت ${releasedMainMo.moNumber}`,
          quantity: 500,
        },
      });
      assert.equal(resvRes.status, 201, `Raw material reservation failed: ${JSON.stringify(resvRes.json)}`);
      const rawResvId = resvRes.json.data.id;

      // Verify reservedQty is reflected in stock inquiry
      const inqReserved = await httpJson(
        baseUrl,
        `/inventory/stock-inquiry?contractNumber=${encodeURIComponent(contractNumber)}`
      );
      const rowARes = (inqReserved.json.data || []).find((r: any) => r.lotNumber === coilGoodCode);
      assert.equal(rowARes.reservedQty, 500, 'Expected 500 kg reserved on Coil A');
      assert.equal(rowARes.availableQty, 1500, 'Expected 1500 kg available after 500 kg reservation');

      // Release reservation prior to physical coil issue (or convert to issue)
      const relResv = await httpJson(baseUrl, `/inventory/reservations/${rawResvId}/release`, {
        method: 'POST',
        body: {},
      });
      assert.equal(relResv.status, 200, `Reservation release failed: ${JSON.stringify(relResv.json)}`);

      // Issue 400 kg (partial coil) from Coil A (2000 kg -> 1600 kg) to releasedMainMo OP10, loading 100 pcs WIP
      const op10 = releasedMainMo.operations[0];
      const issRes = await httpJson(baseUrl, `/inventory/coils/${encodeURIComponent(coilGoodId)}/issue`, {
        method: 'POST',
        headers: { 'Idempotency-Key': `P7-COIL-ISS-${ts}` },
        body: {
          issuedWeightKg: 400,
          moId: releasedMainMo.id,
          moOperationId: op10.id,
          initialInputQuantityPcs: 100,
          notes: 'حواله جزئی ۴۰۰ کیلوگرمی کلاف به عملیات OP10',
        },
      });
      assert.equal(issRes.status, 200, `Partial coil issue failed: ${JSON.stringify(issRes.json)}`);
      assert.equal(issRes.json.coil.remainingWeightKg, 1600);
      assert.equal(issRes.json.coil.physicalStatus, 'PARTIALLY_ISSUED');

      // Over-return (> 400 kg issued) must be blocked (409)
      const overRet = await httpJson(baseUrl, `/inventory/coils/${encodeURIComponent(coilGoodId)}/return`, {
        method: 'POST',
        headers: { 'Idempotency-Key': `P7-COIL-OVERRET-${ts}` },
        body: { returnedWeightKg: 420, targetWarehouseId: 'WH-RAW' },
      });
      assert.equal(overRet.status, 409, 'Over-return exceeding issued weight must return 409');

      // Remnant return: return 150 kg usable remnant + 10 kg trim variance -> remaining becomes 1750 kg (net consumed = 250 kg)
      const retRes = await httpJson(baseUrl, `/inventory/coils/${encodeURIComponent(coilGoodId)}/return`, {
        method: 'POST',
        headers: { 'Idempotency-Key': `P7-COIL-RET-${ts}` },
        body: {
          returnedWeightKg: 150,
          varianceWeightKg: 10,
          targetWarehouseId: 'WH-RAW',
          notes: 'برگشت ته‌کلاف ۱۵۰ کیلوگرمی از خط نواربری',
        },
      });
      assert.equal(retRes.status, 200, `Remnant return failed: ${JSON.stringify(retRes.json)}`);
      assert.equal(retRes.json.coil.remainingWeightKg, 1750);
      assert.equal(retRes.json.coil.physicalStatus, 'PARTIALLY_ISSUED');

      // Verify SAPCO contract balance immediately after partial issue (400) + remnant return (150):
      // Coil A received 2000, Coil B received 1000 & returned to supplier (-1000), Fastener received 30.
      // Net consumed on contract from Coil A = 400 - 150 = 250 kg!
      // totalReceivedKg MUST NOT be inflated by the 150 kg remnant return!
      const sapcoMid = await httpJson(baseUrl, '/inventory/sapco-account');
      const cntMid = (sapcoMid.json.contracts || []).find((c: any) => c.id === contractId);
      assert(cntMid, 'Contract must exist in SAPCO account');
      assert.equal(
        cntMid.totalConsumedKg,
        250,
        `Contract net consumed must be 400 - 150 = 250 kg (got ${cntMid.totalConsumedKg}; totalReceivedKg=${cntMid.totalReceivedKg}, closing=${cntMid.closingBalanceKg})`
      );

      return `Reserved/released 500kg; partial issued 400kg -> returned 150kg (+10kg var) -> Coil A=1750kg, net consumed=250kg`;
    });

    // -----------------------------------------------------------------------
    // SCENARIO 6 & 7: Execute Production Operations (Start, Pause/Downtime,
    //                 Resume, Report Good/Scrap/Downtime, WIP Transfers,
    //                 Material Consumption, Complete through FG Receipt)
    // -----------------------------------------------------------------------
    await runScenario('S6+S7', 'Execute production operations, scrap, downtime, WIP transfers & material consumption', async () => {
      // Refresh releasedMainMo from API so we have up-to-date waitingInputQty (100 pcs loaded by coil issue)
      const moGet = await httpJson(baseUrl, `/wip/manufacturing-orders/${releasedMainMo.id}`);
      assert.equal(moGet.status, 200);
      const moData = moGet.json.data;
      const sortedOps = [...moData.operations].sort((a: any, b: any) => a.stepNumber - b.stepNumber);
      const op10 = sortedOps[0];
      assert.equal(op10.waitingInputQty, 100, 'OP10 should have 100 pcs waitingInputQty from coil issue');

      // 1. Start OP10 on shop floor
      const start10 = await httpJson(baseUrl, `/shop-floor/operations/${op10.id}/start`, {
        method: 'POST',
        body: {
          idempotencyKey: `P7-START-OP10-${ts}`,
          machineId: assignedOp1MachineId,
          shiftId: 'SHIFT-MORN',
          operatorName: 'اپراتور خط پرس P7',
        },
      });
      assert.equal(start10.status, 200, `Start OP10 failed: ${JSON.stringify(start10.json)}`);
      assert.equal(start10.json.executionState, 'IN_PROGRESS');

      // 2. Pause OP10 with downtime & verify report is blocked while PAUSED
      const pause10 = await httpJson(baseUrl, `/shop-floor/operations/${op10.id}/pause`, {
        method: 'POST',
        body: {
          idempotencyKey: `P7-PAUSE-OP10-${ts}`,
          reason: 'تعویض تیغه و ستاپ رول‌بازکن (SMED)',
          isDowntime: true,
        },
      });
      assert.equal(pause10.status, 200);
      assert.equal(pause10.json.executionState, 'PAUSED');

      const blockedReport = await httpJson(baseUrl, `/shop-floor/operations/${op10.id}/report`, {
        method: 'POST',
        body: {
          idempotencyKey: `P7-RPT-PAUSED-${ts}`,
          shiftId: 'SHIFT-MORN',
          machineId: assignedOp1MachineId,
          goodQty: 10,
          scrapQty: 0,
        },
      });
      assert.equal(blockedReport.status, 409, 'Production report must be blocked while operation is PAUSED');

      // 3. Resume OP10 logging 18 min setup downtime
      const resume10 = await httpJson(baseUrl, `/shop-floor/operations/${op10.id}/resume`, {
        method: 'POST',
        body: {
          idempotencyKey: `P7-RESUME-OP10-${ts}`,
          machineId: assignedOp1MachineId,
          shiftId: 'SHIFT-MORN',
          downtimeMinutesOverride: 18,
        },
      });
      assert.equal(resume10.status, 200);
      assert.equal(resume10.json.loggedDowntimeMinutes, 18);

      // Record Coil A remaining weight BEFORE OP10 report to check for double-deduction!
      const coilBeforeReport = await httpJson(baseUrl, `/inventory/coils?coilPackNumber=${encodeURIComponent(coilGoodPack)}`);
      const coilWeightBeforeReport = coilBeforeReport.json.data[0].remainingWeightKg;

      // 4. Report OP10 production: 95 good + 5 scrap = 100 total, 60 min runtime, 12 min inline downtime
      const rpt10 = await httpJson(baseUrl, `/shop-floor/operations/${op10.id}/report`, {
        method: 'POST',
        body: {
          idempotencyKey: `P7-RPT-OP10-${ts}`,
          moId: releasedMainMo.id,
          shiftId: 'SHIFT-MORN',
          machineId: assignedOp1MachineId,
          operatorName: 'اپراتور خط پرس P7',
          goodQty: 95,
          scrapQty: 5,
          scrapReason: 'پارگی لبه ورق در شروع رول',
          runTimeMinutes: 60,
          downtimeMinutes: 12,
          downtimeReason: 'تنظیم فشار غلتک تغذیه',
          actualMaterialConsumedKg: 98,
        },
      });
      assert.equal(rpt10.status, 201, `Report OP10 failed: ${JSON.stringify(rpt10.json)}`);

      // Record standalone downtime (20 min unplanned hydraulic issue) on OP10 machine
      const dtStandalone = await httpJson(baseUrl, '/shop-floor/downtime', {
        method: 'POST',
        body: {
          idempotencyKey: `P7-DT-STAND-${ts}`,
          machineId: assignedOp1MachineId,
          shiftId: 'SHIFT-MORN',
          productionOperationId: op10.id,
          reason: 'نشتی شیلنگ هیدرولیک فیدر',
          durationMinutes: 20,
          markMachineBreakdown: false,
        },
      });
      assert.equal(dtStandalone.status, 201, `Standalone downtime failed: ${JSON.stringify(dtStandalone.json)}`);

      // 5. Verify Inter-Operation WIP Transfer OP10 -> OP15 (auto-transferred on report with traceability record)
      const op15 = sortedOps[1];
      const moAfterOp10 = await httpJson(baseUrl, `/wip/manufacturing-orders/${releasedMainMo.id}`);
      const op10State = moAfterOp10.json.data.operations.find((o: any) => o.id === op10.id);
      const op15State = moAfterOp10.json.data.operations.find((o: any) => o.id === op15.id);
      assert.equal(op10State.goodOutputQty, 95);
      assert.equal(op10State.scrapQty, 5);
      assert.equal(op10State.transferredQty, 95, 'OP10 should have transferred 95 pcs to OP15');
      assert.equal(op15State.waitingInputQty, 95, 'OP15 should have 95 pcs waitingInputQty after OP10 transfer');

      const trfListRes = await httpJson(baseUrl, `/wip/transfers?moId=${encodeURIComponent(releasedMainMo.id)}`);
      assert.equal(trfListRes.status, 200);
      const op10To15Trf = (trfListRes.json.data || []).find(
        (t: any) => t.moId === releasedMainMo.id && t.fromOperationId === op10.id && t.toOperationId === op15.id
      );
      assert(op10To15Trf && op10To15Trf.quantity === 95, 'Expected WIP transfer traceability record OP10 -> OP15 (95 pcs)');

      // Complete OP10 now that all WIP is drained
      const comp10 = await httpJson(baseUrl, `/shop-floor/operations/${op10.id}/complete`, {
        method: 'POST',
        body: { idempotencyKey: `P7-COMP-OP10-${ts}` },
      });
      assert.equal(comp10.status, 200, `Complete OP10 failed: ${JSON.stringify(comp10.json)}`);

      // Execute remaining operations of releasedMainMo (OP15 -> OP50) to produce 95 WIP-ECU-MAIN-BRK into WH-WIP-WELD
      let currentQty = 95;
      for (let i = 1; i < sortedOps.length; i++) {
        const curOp = sortedOps[i];
        const nextOp = sortedOps[i + 1];
        const startOp = await httpJson(baseUrl, `/shop-floor/operations/${curOp.id}/start`, {
          method: 'POST',
          body: {
            idempotencyKey: `P7-START-M-${curOp.stepNumber}-${ts}`,
            machineId: curOp.machineId,
            shiftId: 'SHIFT-MORN',
          },
        });
        assert.equal(startOp.status, 200, `Start ${curOp.stepCode} failed: ${JSON.stringify(startOp.json)}`);

        const rptOp = await httpJson(baseUrl, `/shop-floor/operations/${curOp.id}/report`, {
          method: 'POST',
          body: {
            idempotencyKey: `P7-RPT-M-${curOp.stepNumber}-${ts}`,
            moId: releasedMainMo.id,
            shiftId: 'SHIFT-MORN',
            machineId: curOp.machineId,
            goodQty: currentQty,
            scrapQty: 0,
            runTimeMinutes: 30,
          },
        });
        assert.equal(rptOp.status, 201, `Report ${curOp.stepCode} failed: ${JSON.stringify(rptOp.json)}`);

        if (nextOp) {
          const moStepCheck = await httpJson(baseUrl, `/wip/manufacturing-orders/${releasedMainMo.id}`);
          const nextState = moStepCheck.json.data.operations.find((o: any) => o.id === nextOp.id);
          assert.equal(nextState.waitingInputQty, currentQty, `Expected ${nextOp.stepCode} waitingInputQty=${currentQty}`);
        }

        const compOp = await httpJson(baseUrl, `/shop-floor/operations/${curOp.id}/complete`, {
          method: 'POST',
          body: { idempotencyKey: `P7-COMP-M-${curOp.stepNumber}-${ts}` },
        });
        assert.equal(compOp.status, 200, `Complete ${curOp.stepCode} failed: ${JSON.stringify(compOp.json)}`);
      }

      // Now execute releasedFgMo (60 pcs of SAPCO-ASY-ECU-BRK-01) so we produce REAL FINISHED GOODS in WH-FINISHED!
      const fgGet = await httpJson(baseUrl, `/wip/manufacturing-orders/${releasedFgMo.id}`);
      const fgOps = [...fgGet.json.data.operations].sort((a: any, b: any) => a.stepNumber - b.stepNumber);
      // Load 60 sets into FG OP60
      const loadFg = await httpJson(baseUrl, `/wip/manufacturing-orders/${releasedFgMo.id}/load-material`, {
        method: 'POST',
        body: { operationId: fgOps[0].id, quantity: 60, operatorName: 'انباردار پای خط مونتاژ' },
      });
      assert.equal(loadFg.status, 200, `Load FG MO failed: ${JSON.stringify(loadFg.json)}`);

      let fgQty = 60;
      for (let i = 0; i < fgOps.length; i++) {
        const curOp = fgOps[i];
        const nextOp = fgOps[i + 1];
        const sRes = await httpJson(baseUrl, `/shop-floor/operations/${curOp.id}/start`, {
          method: 'POST',
          body: { idempotencyKey: `P7-START-FG-${curOp.stepNumber}-${ts}`, machineId: curOp.machineId, shiftId: 'SHIFT-MORN' },
        });
        assert.equal(sRes.status, 200, `Start FG ${curOp.stepCode} failed: ${JSON.stringify(sRes.json)}`);

        const scrapOnFirst = i === 0 ? 2 : 0;
        const goodNow = fgQty - scrapOnFirst;
        const rRes = await httpJson(baseUrl, `/shop-floor/operations/${curOp.id}/report`, {
          method: 'POST',
          body: {
            idempotencyKey: `P7-RPT-FG-${curOp.stepNumber}-${ts}`,
            moId: releasedFgMo.id,
            shiftId: 'SHIFT-MORN',
            machineId: curOp.machineId,
            goodQty: goodNow,
            scrapQty: scrapOnFirst,
            scrapReason: scrapOnFirst > 0 ? 'پاشش جوش CO2' : undefined,
            runTimeMinutes: 45,
          },
        });
        assert.equal(rRes.status, 201, `Report FG ${curOp.stepCode} failed: ${JSON.stringify(rRes.json)}`);
        fgQty = goodNow;

        if (nextOp) {
          const fgCheck = await httpJson(baseUrl, `/wip/manufacturing-orders/${releasedFgMo.id}`);
          const nextFg = fgCheck.json.data.operations.find((o: any) => o.id === nextOp.id);
          assert.equal(nextFg.waitingInputQty, fgQty, `Expected FG ${nextOp.stepCode} waitingInputQty=${fgQty}`);
        }

        const cRes = await httpJson(baseUrl, `/shop-floor/operations/${curOp.id}/complete`, {
          method: 'POST',
          body: { idempotencyKey: `P7-COMP-FG-${curOp.stepNumber}-${ts}` },
        });
        assert.equal(cRes.status, 200, `Complete FG ${curOp.stepCode} failed: ${JSON.stringify(cRes.json)}`);
      }

      fgProducedQty = fgQty; // 58 good finished goods
      // Discover the auto-received FG lot in WH-FINISHED for releasedFgMo
      const docsRes = await httpJson(baseUrl, `/inventory/documents?documentType=RECEIPT_FINISHED_GOODS`);
      const fgRcvDoc = (docsRes.json.data || []).find(
        (d: any) => d.referenceNumber === releasedFgMo.moNumber && d.warehouseId === 'WH-FINISHED'
      );
      assert(fgRcvDoc, `Expected auto-posted RECEIPT_FINISHED_GOODS for ${releasedFgMo.moNumber}`);
      fgProducedLot = fgRcvDoc.lines[0].lotNumber;
      assert.equal(fgRcvDoc.lines[0].quantity, fgProducedQty);

      // Verify Coil A was NOT silently double-deducted if it was already explicitly issued to releasedMainMo
      const coilAfterReport = await httpJson(baseUrl, `/inventory/coils?coilPackNumber=${encodeURIComponent(coilGoodPack)}`);
      const coilWeightAfterReport = coilAfterReport.json.data[0].remainingWeightKg;
      assert.equal(
        coilWeightAfterReport,
        coilWeightBeforeReport,
        `Coil A (already explicitly issued via /coils/:id/issue to ${releasedMainMo.moNumber}) MUST NOT be double-deducted during OP10 report! Before=${coilWeightBeforeReport}, After=${coilWeightAfterReport}`
      );
      const issDocsRes = await httpJson(baseUrl, `/inventory/documents?documentType=ISSUE_RAW_MATERIAL`);
      const dupCoilBackflush = (issDocsRes.json.data || []).filter(
        (d: any) =>
          d.referenceNumber === releasedMainMo.moNumber &&
          String(d.documentNumber || '').startsWith('ISS-WIP-') &&
          (d.lines || []).some((l: any) => l.partId === 'PRT-RAW-ECU-COIL')
      );
      assert.equal(
        dupCoilBackflush.length,
        0,
        `Explicitly coil-issued MO ${releasedMainMo.moNumber} MUST NOT trigger duplicate ISS-WIP raw-coil backflush! Found: ${JSON.stringify(dupCoilBackflush)}`
      );

      // Verify WIP reconciliation for both MOs
      const wipRecMain = await httpJson(baseUrl, `/wip/reconciliation/${releasedMainMo.id}`);
      assert.equal(wipRecMain.status, 200);
      assert.equal(wipRecMain.json.data.isConserved, true, `Main MO WIP reconciliation must be conserved: ${JSON.stringify(wipRecMain.json.data)}`);
      assert.equal(wipRecMain.json.data.discrepancy, 0);

      const wipRecFg = await httpJson(baseUrl, `/wip/reconciliation/${releasedFgMo.id}`);
      assert.equal(wipRecFg.status, 200);
      assert.equal(wipRecFg.json.data.isConserved, true, `FG MO WIP reconciliation must be conserved: ${JSON.stringify(wipRecFg.json.data)}`);
      assert.equal(wipRecFg.json.data.discrepancy, 0);

      return `MAIN MO produced 95 good + 5 scrap (all 7 ops + transfers); FG MO produced ${fgProducedQty} good + 2 scrap -> Lot ${fgProducedLot} in WH-FINISHED`;
    });

    // -----------------------------------------------------------------------
    // SCENARIO 8B & 9B: IPQC, FQC, Quarantine, NCR, REWORK, USE_AS_IS & SCRAP
    // -----------------------------------------------------------------------
    await runScenario('S8b+S9b', 'IPQC & FQC inspections, NCR containment, REWORK, USE_AS_IS & SCRAP', async () => {
      const op10 = releasedMainMo.operations[0];

      // 1. In-Process Inspection (IPQC) on MAIN MO OP10 with split decision (accepted + rework + rejected)
      const ipqc = await httpJson(baseUrl, '/quality/inspections', {
        method: 'POST',
        headers: { ...QC_HEADERS, 'Idempotency-Key': `P7-IPQC-${ts}` },
        body: {
          inspectionType: 'IN_PROCESS',
          partId: 'PRT-WIP-ECU-MAIN',
          manufacturingOrderId: releasedMainMo.id,
          moNumber: releasedMainMo.moNumber,
          operationCode: op10.stepCode,
          operationName: op10.stepName,
          inspectedQty: 95,
          decision: 'QUARANTINED',
          acceptedQty: 85,
          reworkQty: 7,
          rejectedQty: 3,
          defectCodes: ['DEF-BURR'],
          severity: 'MAJOR',
          defectSummary: 'پلیسه جزئی لبه در ۷ قطعه حین بلنکینگ',
        },
      });
      assert.equal(ipqc.status, 201, `IPQC failed: ${JSON.stringify(ipqc.json)}`);
      assert.ok(ipqc.json.ncr?.id, 'IPQC with rework/rejected must auto-create NCR');

      // 2. Final Product Inspection (FQC) on the 58 finished goods in WH-FINISHED
      const fqc = await httpJson(baseUrl, '/quality/inspections', {
        method: 'POST',
        headers: { ...QC_HEADERS, 'Idempotency-Key': `P7-FQC-${ts}` },
        body: {
          inspectionType: 'FINAL_PRODUCT',
          partId: 'PRT-FGD-ECU-BRK',
          warehouseId: 'WH-FINISHED',
          lotNumber: fgProducedLot,
          manufacturingOrderId: releasedFgMo.id,
          moNumber: releasedFgMo.moNumber,
          inspectedQty: fgProducedQty,
          decision: 'ACCEPTED',
          acceptedQty: fgProducedQty,
          notes: 'تایید CMM و ضخامت پوشش کاتافورز ساپکو',
        },
      });
      assert.equal(fqc.status, 201, `FQC failed: ${JSON.stringify(fqc.json)}`);

      // 3. NCR on 10 units of finished lot -> Contain immediately (344 BLOCKED) -> REWORK -> Complete (8 good returned + 2 scrap)
      const ncrRework = await httpJson(baseUrl, '/quality/ncrs', {
        method: 'POST',
        headers: { ...QC_HEADERS, 'Idempotency-Key': `P7-NCR-REW-${ts}` },
        body: {
          sourceType: 'FINAL_INSPECTION',
          partId: 'PRT-FGD-ECU-BRK',
          warehouseId: 'WH-FINISHED',
          lotNumber: fgProducedLot,
          manufacturingOrderId: releasedFgMo.id,
          moNumber: releasedFgMo.moNumber,
          defectCode: 'DEF-COAT',
          severity: 'MAJOR',
          affectedQty: 10,
          description: 'شره جزئی رنگ کاتافورز روی ۱۰ عدد محصول نهایی',
          containImmediately: true,
          containmentAction: 'جداسازی ۱۰ عدد جهت اصلاح پوشش',
        },
      });
      assert.equal(ncrRework.status, 201, `NCR rework create failed: ${JSON.stringify(ncrRework.json)}`);
      assert.equal(ncrRework.json.data.status, 'CONTAINED');

      // Verify while 10 units are contained (BLOCKED), only 48 units are available (trying to ship 50 MUST fail)
      const tryShipBlocked = await httpJson(baseUrl, '/inventory/documents', {
        method: 'POST',
        headers: { 'Idempotency-Key': `P7-TRY-SHIP-BLK-${ts}` },
        body: {
          documentType: 'DELIVERY_CUSTOMER',
          warehouseId: 'WH-FINISHED',
          ownership: 'COMPANY_OWNED',
          autoPost: true,
          lines: [
            {
              partId: 'PRT-FGD-ECU-BRK',
              partCode: 'SAPCO-ASY-ECU-BRK-01',
              partName: 'مجموعه براکت ضدسرقت رایانه موتور با پوشش رنگ کاتافورز ED',
              quantity: 50,
              quantityKg: 57.5,
              unit: 'PCS',
              lotNumber: fgProducedLot,
              locationCode: 'LOC-FIN-P1',
              ownership: 'COMPANY_OWNED',
            },
          ],
        },
      });
      assert(!tryShipBlocked.ok, 'Must NOT allow shipping quarantined/blocked FG units');

      // Disposition -> REWORK
      const dispRew = await httpJson(baseUrl, `/quality/ncrs/${ncrRework.json.data.id}/disposition`, {
        method: 'POST',
        headers: { ...QC_HEADERS, 'Idempotency-Key': `P7-DISP-REW-${ts}` },
        body: {
          disposition: 'REWORK',
          reworkInstructions: 'سمباده‌زنی موضعی و پوشش مجدد رنگ ED',
          returnToProduction: true,
        },
      });
      assert.equal(dispRew.status, 200);
      const reworkId = dispRew.json.reworkOrder.id;

      // Complete Rework: 8 good (released via 321) + 2 scrap (written off)
      const compRew = await httpJson(baseUrl, `/quality/rework-orders/${reworkId}/complete`, {
        method: 'POST',
        headers: { ...QC_HEADERS, 'Idempotency-Key': `P7-COMP-REW-${ts}` },
        body: { goodQty: 8, scrapQty: 2, returnToProduction: true },
      });
      assert.equal(compRew.status, 200, `Rework complete failed: ${JSON.stringify(compRew.json)}`);
      assert.equal(compRew.json.ncr.status, 'CLOSED');

      // 4. NCR with USE_AS_IS (4 pcs) and NCR with SCRAP (2 pcs) on finished lot
      const ncrUai = await httpJson(baseUrl, '/quality/ncrs', {
        method: 'POST',
        headers: { ...QC_HEADERS, 'Idempotency-Key': `P7-NCR-UAI-${ts}` },
        body: {
          sourceType: 'WAREHOUSE_AUDIT',
          partId: 'PRT-FGD-ECU-BRK',
          warehouseId: 'WH-FINISHED',
          lotNumber: fgProducedLot,
          moNumber: releasedFgMo.moNumber,
          defectCode: 'DEF-PACK',
          severity: 'MINOR',
          affectedQty: 4,
          description: 'عدم هم‌ترازی برچسب پالت قابل قبول با مجوز مشتری',
          containImmediately: true,
        },
      });
      assert.equal(ncrUai.status, 201);
      const dispUai = await httpJson(baseUrl, `/quality/ncrs/${ncrUai.json.data.id}/disposition`, {
        method: 'POST',
        headers: { ...QC_HEADERS, 'Idempotency-Key': `P7-DISP-UAI-${ts}` },
        body: {
          disposition: 'USE_AS_IS',
          rootCause: 'تنظیم چاپگر لیبل',
          correctiveAction: 'تایید ارفاقی مهندسی کیفیت',
        },
      });
      assert.equal(dispUai.status, 200);
      assert.equal(dispUai.json.data.status, 'CLOSED');

      const ncrScr = await httpJson(baseUrl, '/quality/ncrs', {
        method: 'POST',
        headers: { ...QC_HEADERS, 'Idempotency-Key': `P7-NCR-SCR-${ts}` },
        body: {
          sourceType: 'FINAL_INSPECTION',
          partId: 'PRT-FGD-ECU-BRK',
          warehouseId: 'WH-FINISHED',
          lotNumber: fgProducedLot,
          moNumber: releasedFgMo.moNumber,
          defectCode: 'DEF-DIM',
          severity: 'CRITICAL',
          affectedQty: 2,
          description: 'انحراف ابعادی خارج از تلرانس روی فیکسچر CMM',
          containImmediately: true,
        },
      });
      assert.equal(ncrScr.status, 201);
      const dispScr = await httpJson(baseUrl, `/quality/ncrs/${ncrScr.json.data.id}/disposition`, {
        method: 'POST',
        headers: { ...QC_HEADERS, 'Idempotency-Key': `P7-DISP-SCR-${ts}` },
        body: {
          disposition: 'SCRAP',
          rootCause: 'لقی پین فیکسچر جوش',
          correctiveAction: 'اسقاط ۲ قطعه و کالیبراسیون فیکسچر',
        },
      });
      assert.equal(dispScr.status, 200);
      assert.equal(dispScr.json.data.status, 'CLOSED');

      // Net finished goods remaining in fgProducedLot = 58 - 2 (rework scrap) - 2 (NCR scrap) = 54 pcs!
      return `IPQC + FQC posted; NCR quarantine blocked shipment; REWORK (8 good/2 scrap), USE_AS_IS (4), SCRAP (2) closed`;
    });

    // -----------------------------------------------------------------------
    // SCENARIO 10: Verify Finished Inventory, Reservations, Traceability,
    //              SAPCO Balances, 4-Way Reconciliation & OEE Reporting
    // -----------------------------------------------------------------------
    await runScenario('S10', 'Verify finished inventory, reservations, traceability, SAPCO, reconciliation & OEE', async () => {
      // 1. Finished Goods Inventory Verification (expected: 54 pcs available in fgProducedLot)
      const expectedFgQty = fgProducedQty - 4; // 58 - 2 (rework scrap) - 2 (NCR scrap) = 54
      const fgInq = await httpJson(
        baseUrl,
        `/inventory/stock-inquiry?warehouseId=WH-FINISHED&partId=PRT-FGD-ECU-BRK`
      );
      assert.equal(fgInq.status, 200);
      const fgRow = (fgInq.json.data || []).find((r: any) => r.lotNumber === fgProducedLot);
      assert(fgRow, `Expected finished goods row for lot ${fgProducedLot}`);
      assert.equal(fgRow.physicalQty, expectedFgQty, `Expected FG physical=${expectedFgQty}, got ${fgRow.physicalQty}`);
      assert.equal(fgRow.availableQty, expectedFgQty, `Expected FG available=${expectedFgQty}, got ${fgRow.availableQty}`);
      assert.equal(fgRow.blockedQty, 0, 'All NCR holds should be resolved/closed');

      // 2. Customer Delivery Reservation on Finished Goods (reserve 20 -> verify -> release -> verify)
      const fgResv = await httpJson(baseUrl, '/inventory/reservations', {
        method: 'POST',
        body: {
          partId: 'PRT-FGD-ECU-BRK',
          warehouseId: 'WH-FINISHED',
          lotNumber: fgProducedLot,
          ownership: 'COMPANY_OWNED',
          reservedFor: `ارسال به مشتری برای ${customerOrderNumber}`,
          quantity: 20,
        },
      });
      assert.equal(fgResv.status, 201, `FG reservation failed: ${JSON.stringify(fgResv.json)}`);

      const fgInqRes = await httpJson(baseUrl, `/inventory/stock-inquiry?warehouseId=WH-FINISHED&partId=PRT-FGD-ECU-BRK`);
      const fgRowRes = (fgInqRes.json.data || []).find((r: any) => r.lotNumber === fgProducedLot);
      assert.equal(fgRowRes.reservedQty, 20);
      assert.equal(fgRowRes.availableQty, expectedFgQty - 20);

      const fgRel = await httpJson(baseUrl, `/inventory/reservations/${fgResv.json.data.id}/release`, {
        method: 'POST',
        body: {},
      });
      assert.equal(fgRel.status, 200);

      // 3. End-to-End Traceability (Coil Genealogy + Document Flow + Full Chain + Quality History)
      const genRes = await httpJson(baseUrl, `/inventory/coils/${encodeURIComponent(coilGoodId)}/genealogy`);
      assert.equal(genRes.status, 200);
      assert.equal(genRes.json.data.metrics.originalWeightKg, 2000);
      assert.equal(genRes.json.data.metrics.remainingWeightKg, 1750);
      assert.equal(genRes.json.data.metrics.totalIssuedKg, 400);
      assert.equal(genRes.json.data.metrics.totalReturnedKg, 150);
      assert(genRes.json.data.relatedDocuments.length >= 3, 'Coil genealogy must link receipt, QM release, issue, return');

      const flowRes = await httpJson(baseUrl, `/traceability/document-flow?q=${encodeURIComponent(releasedFgMo.moNumber)}`);
      assert.equal(flowRes.status, 200);
      assert((flowRes.json.nodes || []).length >= 2, 'Document flow must contain linked nodes for FG MO');

      const fullChainRes = await httpJson(baseUrl, '/traceability/full-chain');
      assert.equal(fullChainRes.status, 200);
      assert((fullChainRes.json.data.documentChain || []).length >= 5);

      const qHistCoil = await httpJson(baseUrl, `/quality/history?coilId=${encodeURIComponent(coilGoodCode)}`);
      assert.equal(qHistCoil.status, 200);
      assert.equal(qHistCoil.json.data.currentQualityStatus, 'AVAILABLE');
      assert(qHistCoil.json.data.inspections.length >= 1);

      const qHistFg = await httpJson(baseUrl, `/quality/history?lotNumber=${encodeURIComponent(fgProducedLot)}`);
      assert.equal(qHistFg.status, 200);
      assert(qHistFg.json.data.inspections.length >= 1);
      assert(qHistFg.json.data.ncrs.length >= 3);
      assert(qHistFg.json.data.reworkOrders.length >= 1);

      // 4. SAPCO Consignment Contract Balances (both /inventory/sapco-account and /reports/sapco-material-account)
      const sapcoAcc = await httpJson(baseUrl, '/inventory/sapco-account');
      assert.equal(sapcoAcc.status, 200);
      const cntFinal = (sapcoAcc.json.contracts || []).find((c: any) => c.id === contractId);
      assert(cntFinal, 'Contract must be present in SAPCO account');
      // Received: 2000 (Coil A) + 1000 (Coil B) + 30 (nuts) - 1000 (Coil B returned to supplier) = 2030 net received (or 3030 received with 1000 return adjustment)
      // Consumed: 400 (Coil A issue) - 150 (Coil A remnant return) = 250 kg (+ any contract nuts consumed)
      // Closing balance MUST equal actual physical stock held under this contract!
      const stockContract = await httpJson(
        baseUrl,
        `/inventory/stock-inquiry?contractNumber=${encodeURIComponent(contractNumber)}`
      );
      const actualContractPhysicalKg = Number(
        (stockContract.json.data || [])
          .reduce((s: number, r: any) => s + Number(r.physicalKg || 0), 0)
          .toFixed(2)
      );
      assert(
        Math.abs(cntFinal.closingBalanceKg - actualContractPhysicalKg) <= 0.5,
        `SAPCO contract closingBalanceKg (${cntFinal.closingBalanceKg}) MUST match actual physical stock under contract (${actualContractPhysicalKg})!`
      );

      const sapcoRep = await httpJson(baseUrl, '/reports/sapco-material-account');
      assert.equal(sapcoRep.status, 200);

      // 5. 4-Way Inventory Reconciliation — MUST have ZERO errors!
      const reconRes = await httpJson(baseUrl, '/inventory/reconciliation');
      assert.equal(reconRes.status, 200);
      assert.equal(
        reconRes.json.data.summary.errorCount,
        0,
        `4-way inventory reconciliation MUST have 0 errors after full E2E flow! Discrepancies: ${JSON.stringify(
          reconRes.json.data.discrepancies
        )}`
      );

      // 6. Unified OEE Analytics, Dashboard & Machine Utilization Report Consistency
      const [oeeAna, oeeDash, utilRep, qDash] = await Promise.all([
        httpJson(baseUrl, `/oee/analytics?machineId=${encodeURIComponent(assignedOp1MachineId)}`),
        httpJson(baseUrl, `/oee/dashboard?machineId=${encodeURIComponent(assignedOp1MachineId)}`),
        httpJson(baseUrl, `/machines/utilization-report?machineId=${encodeURIComponent(assignedOp1MachineId)}`),
        httpJson(baseUrl, '/quality/dashboard'),
      ]);
      assert.equal(oeeAna.status, 200);
      assert.equal(oeeDash.status, 200);
      assert.equal(utilRep.status, 200);
      assert.equal(qDash.status, 200);

      const plant = oeeAna.json.data.summary;
      assert(plant.goodQty >= 95, `Expected OEE goodQty >= 95 on OP10 machine, got ${plant.goodQty}`);
      assert(plant.scrapQty >= 5, `Expected OEE scrapQty >= 5 on OP10 machine, got ${plant.scrapQty}`);
      // Downtime on OP10 machine: 18 (pause setup) + 12 (inline report) + 20 (standalone) = 50 min
      const totalDt =
        plant.time.plannedDowntimeMinutes + plant.time.setupTimeMinutes + plant.time.unplannedDowntimeMinutes;
      assert(totalDt >= 50, `Expected OEE total downtime >= 50 min (18+12+20), got ${totalDt}`);
      assert(plant.time.operatingTimeMinutes >= 60, `Expected operatingTime >= 60 min, got ${plant.time.operatingTimeMinutes}`);
      assert.equal(
        oeeDash.json.data.plantOeePercent,
        plant.oeePercent ?? 0,
        'OEE dashboard plantOeePercent must stay consistent with /api/oee/analytics'
      );

      // Quality Dashboard sanity
      const qSum = qDash.json.data.summary;
      assert.equal(qSum.totalInspections, 4, 'Expected 4 inspections (2 IQC + 1 IPQC + 1 FQC)');
      assert(qSum.totalNcrCount >= 5, `Expected >= 5 NCRs, got ${qSum.totalNcrCount}`);
      assert.equal(qSum.reworkedGoodQtyTotal, 8);
      assert(qSum.scrappedFromQcQtyTotal >= 4);

      return `FG=${expectedFgQty} pcs, SAPCO closing=${cntFinal.closingBalanceKg}kg == physical ${actualContractPhysicalKg}kg, 4-way recon=0 errors, OEE downtime=${totalDt}m, Q-dashboard=4 insp`;
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const snap of savedSnapshots) {
      if (snap.existed && snap.content !== null) {
        fs.writeFileSync(snap.filePath, snap.content, 'utf8');
      } else if (!snap.existed && fs.existsSync(snap.filePath)) {
        fs.unlinkSync(snap.filePath);
      }
    }
  }
}

// =========================================================================
// TRACK B: UNIFIED RELATIONAL PRISMA SERVICE-LAYER E2E ACCEPTANCE
// =========================================================================
async function runTrackBUnifiedRelationalFlow() {
  console.log('\n=========================================================================');
  console.log('TRACK B: UNIFIED RELATIONAL PRISMA SERVICE-LAYER E2E ACCEPTANCE (P1–P5)');
  console.log('=========================================================================');

  let seq = 1;
  const uid = (p: string) => `${p}-${seq++}`;
  const num = (v: any) => Number(v ?? 0);

  type RStore = Record<string, any[]>;
  const now = new Date('2026-12-01T07:00:00Z');
  const due = new Date('2026-12-08T15:00:00Z');

  const store: RStore = {
    role: [{ id: 'ROLE-ADMIN', code: 'ADMIN', name: 'مدیر سیستم' }],
    user: [
      { id: 'USR-REL-1', username: 'op_p7', fullName: 'اپراتور تست یکپارچه P7', personnelCode: 'EMP-P7', active: true, roleId: 'ROLE-ADMIN' },
    ],
    unitOfMeasure: [
      { id: 'UOM-KG', code: 'KG', name: 'کیلوگرم', symbol: 'kg' },
      { id: 'UOM-PCS', code: 'PCS', name: 'عدد', symbol: 'pcs' },
    ],
    warehouse: [
      { id: 'WH-RAW', code: 'WH-RAW', name: 'انبار مواد اولیه', type: 'RAW_MATERIALS', active: true },
      { id: 'WH-WIP-PRESS', code: 'WH-WIP-PRESS', name: 'انبار پای خط پرس', type: 'WIP', active: true },
      { id: 'WH-FINISHED', code: 'WH-FINISHED', name: 'انبار محصول نهایی', type: 'FINISHED_GOODS', active: true },
      { id: 'WH-SCRAP', code: 'WH-SCRAP', name: 'انبار ضایعات', type: 'SCRAP', active: true },
    ],
    warehouseLocation: [
      { id: 'LOC-RAW-01', warehouseId: 'WH-RAW', code: 'LOC-RAW-A1', name: 'جایگاه کلاف A1', active: true },
      { id: 'LOC-WIP-01', warehouseId: 'WH-WIP-PRESS', code: 'LOC-WIP-BLANK', name: 'ایستگاه بلنک', active: true },
      { id: 'LOC-WIP-02', warehouseId: 'WH-WIP-PRESS', code: 'LOC-WIP-BEND', name: 'ایستگاه خم', active: true },
      { id: 'LOC-FIN-01', warehouseId: 'WH-FINISHED', code: 'LOC-FIN-P1', name: 'محصول نهایی ردیف ۱', active: true },
      { id: 'LOC-SCR-01', warehouseId: 'WH-SCRAP', code: 'LOC-SCRAP-01', name: 'قفس ضایعات', active: true },
    ],
    customer: [
      { id: 'CUST-SAPCO', code: 'SAPCO', name: 'شرکت ساپکو', active: true },
    ],
    material: [
      { id: 'MAT-DC01A', code: 'DC01A', name: 'ورق روغنی DC01A', grade: 'DC01A', standard: 'DIN EN 10130' },
    ],
    materialContract: [
      {
        id: 'CNT-REL-P7',
        contractNumber: 'CNT-SAPCO-REL-P7',
        title: 'قرارداد امانی ساپکو تست رابطه‌ای P7',
        supplierCustomerId: 'CUST-SAPCO',
        materialId: 'MAT-DC01A',
        ownership: 'SAPCO_SUPPLIER_OWNED',
        totalQuotaKg: 5000,
        totalAllocatedWeightKg: 5000,
        usedQuotaKg: 0,
        receivedWeightKg: 0,
        consumedWeightKg: 0,
        remainingWeightKg: 0,
        status: 'ACTIVE',
        startDate: now,
        endDate: due,
        createdAt: now,
        updatedAt: now,
      },
    ],
    materialContractTransaction: [],
    contractCoilAllocation: [],
    materialLot: [],
    physicalCoil: [],
    part: [
      {
        id: 'PRT-REL-RAW',
        partNumber: 'RM-DC01A-2MM',
        name: 'رول ورق DC01A ضخامت 2mm',
        category: 'RAW_MATERIAL',
        unitId: 'UOM-KG',
        materialId: 'MAT-DC01A',
        thicknessMm: 2.0,
        weightGrossKg: 1.0,
        weightNetKg: 1.0,
        active: true,
      },
      {
        id: 'PRT-REL-FG',
        partNumber: 'FG-ECU-BRK-P7',
        name: 'براکت نهایی ضدسرقت ECU (رابطه‌ای)',
        category: 'FINISHED_GOOD',
        unitId: 'UOM-PCS',
        materialId: 'MAT-DC01A',
        thicknessMm: 2.0,
        weightGrossKg: 1.5,
        weightNetKg: 1.35,
        active: true,
      },
    ],
    item: [
      { id: 'ITM-REL-RAW', code: 'RM-DC01A-2MM', name: 'رول ورق DC01A ضخامت 2mm', itemType: 'RAW_MATERIAL', unit: 'KG' },
      { id: 'ITM-REL-FG', code: 'FG-ECU-BRK-P7', name: 'براکت نهایی ضدسرقت ECU (رابطه‌ای)', itemType: 'FINISHED_GOOD', unit: 'PCS' },
    ],
    bomComponent: [
      {
        id: 'BOM-REL-1',
        parentItemId: 'ITM-REL-FG',
        childItemId: 'ITM-REL-RAW',
        quantityRequired: 1.5,
        scrapFactorPercent: 0,
        unit: 'KG',
        isDeleted: false,
      },
    ],
    operation: [
      { id: 'OPER-REL-BLK', code: 'BLANKING', name: 'بلنکینگ', processType: 'BLANKING', defaultSequence: 10 },
      { id: 'OPER-REL-BND', code: 'BENDING', name: 'خم‌کاری نهایی', processType: 'BENDING', defaultSequence: 20 },
    ],
    partRoute: [
      { id: 'RT-REL-FG', partId: 'PRT-REL-FG', routeCode: 'RT-FG-P7', status: 'ACTIVE', active: true, isDefault: true, effectiveFrom: now, version: 'V1' },
    ],
    routeOperation: [
      { id: 'RO-REL-10', routeId: 'RT-REL-FG', operationId: 'OPER-REL-BLK', stepNumber: 10, requiredTonnage: 200, standardCycleTimeSec: 12, setupTimeMin: 15, machineId: 'MCH-REL-250', dieId: 'DIE-REL-BLK' },
      { id: 'RO-REL-20', routeId: 'RT-REL-FG', operationId: 'OPER-REL-BND', stepNumber: 20, requiredTonnage: 150, standardCycleTimeSec: 18, setupTimeMin: 10, machineId: 'MCH-REL-250', dieId: 'DIE-REL-BND' },
    ],
    machine: [
      { id: 'MCH-REL-250', code: 'PRS-250-P7', name: 'پرس ۲۵۰ تن پذیرش P7', hallLocation: 'سالن پرس سنگین', machineType: 'PRESS_250T', tonnageCapacity: 250, status: 'ACTIVE', active: true },
    ],
    machineCapability: [
      { id: 'MCAP-1', machineId: 'MCH-REL-250', operationId: 'OPER-REL-BLK', minThicknessMm: 0.8, maxThicknessMm: 3.0, maxTonnage: 250, isPreferred: true },
      { id: 'MCAP-2', machineId: 'MCH-REL-250', operationId: 'OPER-REL-BND', minThicknessMm: 0.8, maxThicknessMm: 3.0, maxTonnage: 250, isPreferred: true },
    ],
    die: [
      { id: 'DIE-REL-BLK', code: 'DIE-BLK-P7', name: 'قالب بلنک P7', tonnageRequired: 180, active: true, status: 'READY', strokeLifeTarget: 100000, currentStrokes: 0 },
      { id: 'DIE-REL-BND', code: 'DIE-BND-P7', name: 'قالب خم P7', tonnageRequired: 120, active: true, status: 'READY', strokeLifeTarget: 100000, currentStrokes: 0 },
    ],
    machineDieCompatibility: [
      { id: 'MDC-1', machineId: 'MCH-REL-250', dieId: 'DIE-REL-BLK' },
      { id: 'MDC-2', machineId: 'MCH-REL-250', dieId: 'DIE-REL-BND' },
    ],
    shift: [
      { id: 'SH-REL-MORN', code: 'MORNING', name: 'شیفت صبح', startTime: '07:00', endTime: '15:00', productiveHours: 7.5, active: true },
      { id: 'SH-REL-EVE', code: 'EVENING', name: 'شیفت عصر', startTime: '15:00', endTime: '23:00', productiveHours: 7.5, active: true },
    ],
    customerOrder: [
      {
        id: 'CORD-REL-1',
        orderNumber: 'ORD-REL-P7-001',
        customerId: 'CUST-SAPCO',
        customerContractNumber: 'CNT-SAPCO-REL-P7',
        orderDate: now,
        requestedDeliveryDate: due,
        priority: 1,
        documentStatus: 'CONFIRMED',
        createdAt: now,
        updatedAt: now,
      },
    ],
    customerOrderLine: [
      {
        id: 'CORDL-REL-1',
        orderId: 'CORD-REL-1',
        partId: 'PRT-REL-FG',
        lineNumber: 1,
        orderedQty: 100,
        deliveredQty: 0,
        requestedDate: due,
        status: 'PENDING',
      },
    ],
    productionPlanProposal: [],
    productionPlanProposalLine: [],
    productionPlan: [],
    productionPlanLine: [],
    manufacturingOrder: [],
    productionOperation: [],
    machineAssignment: [],
    productionReport: [],
    productionScrap: [],
    productionTransfer: [],
    productionActivityLog: [],
    coilIssueReturnRecord: [],
    stockBalance: [],
    inventoryDocument: [],
    inventoryDocumentLine: [],
    inventoryTransaction: [],
    inventoryReservation: [],
    auditLog: [],
  };

  function matchCond(val: any, cond: any): boolean {
    if (cond === undefined) return true;
    if (cond === null) return val === null || val === undefined;
    if (typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ('equals' in cond && val !== cond.equals) return false;
      if ('in' in cond && (!Array.isArray(cond.in) || !cond.in.includes(val))) return false;
      if ('notIn' in cond && Array.isArray(cond.notIn) && cond.notIn.includes(val)) return false;
      if ('not' in cond) {
        if (cond.not === null) {
          if (val === null || val === undefined) return false;
        } else if (val === cond.not) return false;
      }
      if ('gt' in cond) {
        const a = val instanceof Date ? val.getTime() : num(val);
        const b = cond.gt instanceof Date ? cond.gt.getTime() : num(cond.gt);
        if (!(a > b + 1e-9)) return false;
      }
      if ('gte' in cond) {
        const a = val instanceof Date ? val.getTime() : num(val);
        const b = cond.gte instanceof Date ? cond.gte.getTime() : num(cond.gte);
        if (!(a >= b - 1e-9)) return false;
      }
      if ('lt' in cond) {
        const a = val instanceof Date ? val.getTime() : num(val);
        const b = cond.lt instanceof Date ? cond.lt.getTime() : num(cond.lt);
        if (!(a < b - 1e-9)) return false;
      }
      if ('lte' in cond) {
        const a = val instanceof Date ? val.getTime() : num(val);
        const b = cond.lte instanceof Date ? cond.lte.getTime() : num(cond.lte);
        if (!(a <= b + 1e-9)) return false;
      }
      if ('contains' in cond) {
        const hay = String(val ?? '');
        const needle = String(cond.contains ?? '');
        if (cond.mode === 'insensitive') {
          if (!hay.toLowerCase().includes(needle.toLowerCase())) return false;
        } else if (!hay.includes(needle)) return false;
      }
      return true;
    }
    return val === cond;
  }

  function matchesWhere(table: string, row: any, where: any): boolean {
    if (!where) return true;
    for (const [k, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (k === 'OR' && Array.isArray(cond)) {
        if (!cond.some(sub => matchesWhere(table, row, sub))) return false;
        continue;
      }
      if (k === 'AND' && Array.isArray(cond)) {
        if (!cond.every(sub => matchesWhere(table, row, sub))) return false;
        continue;
      }
      if (k === 'part' && cond && typeof cond === 'object') {
        const p = store.part.find(r => r.id === row.partId);
        if (!p || !matchesWhere('part', p, (cond as any).is ?? cond)) return false;
        continue;
      }
      if (k === 'warehouse' && cond && typeof cond === 'object') {
        const w = store.warehouse.find(r => r.id === row.warehouseId);
        if (!w || !matchesWhere('warehouse', w, (cond as any).is ?? cond)) return false;
        continue;
      }
      if (k === 'manufacturingOrder' && cond && typeof cond === 'object') {
        const mo = store.manufacturingOrder.find(r => r.id === row.manufacturingOrderId);
        if (!mo || !matchesWhere('manufacturingOrder', mo, (cond as any).is ?? cond)) return false;
        continue;
      }
      if (k === 'document' && cond && typeof cond === 'object') {
        const d = store.inventoryDocument.find(r => r.id === row.documentId);
        if (!d || !matchesWhere('inventoryDocument', d, (cond as any).is ?? cond)) return false;
        continue;
      }
      if (k.includes('_') && cond && typeof cond === 'object' && !(cond instanceof Date)) {
        if (!matchesWhere(table, row, cond)) return false;
        continue;
      }
      if (!matchCond(row[k], cond)) return false;
    }
    return true;
  }

  function applyUpdate(row: any, data: any): any {
    const next = { ...row };
    for (const [k, v] of Object.entries(data || {})) {
      if (v === undefined) continue;
      if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
        if ('increment' in v) {
          next[k] = Number((num(next[k]) + num((v as any).increment)).toFixed(6));
          continue;
        }
        if ('decrement' in v) {
          next[k] = Number((num(next[k]) - num((v as any).decrement)).toFixed(6));
          continue;
        }
      }
      next[k] = v;
    }
    next.updatedAt = new Date();
    return next;
  }

  const subSpec = (spec: any) => (spec && typeof spec === 'object' ? spec.include || spec.select : undefined);

  function hydrate(table: string, row: any, inc: any): any {
    if (!row) return null;
    const out: any = { ...row };
    if (!inc) return out;
    if (table === 'part') {
      if (inc.unit) out.unit = store.unitOfMeasure.find(u => u.id === row.unitId) || null;
      if (inc.material) out.material = store.material.find(m => m.id === row.materialId) || null;
      if (inc.routes) {
        let rts = store.partRoute.filter(r => r.partId === row.id);
        if (inc.routes.where) rts = rts.filter(r => matchesWhere('partRoute', r, inc.routes.where));
        if (inc.routes.take) rts = rts.slice(0, inc.routes.take);
        out.routes = rts.map(r => hydrate('partRoute', r, subSpec(inc.routes)));
      }
    } else if (table === 'partRoute') {
      if (inc.operations) {
        const ops = store.routeOperation
          .filter(ro => ro.routeId === row.id)
          .sort((a, b) => a.stepNumber - b.stepNumber);
        out.operations = ops.map(ro => hydrate('routeOperation', ro, subSpec(inc.operations)));
      }
    } else if (table === 'routeOperation') {
      if (inc.operation) out.operation = store.operation.find(o => o.id === row.operationId) || null;
      if (inc.machine) out.machine = store.machine.find(m => m.id === row.machineId) || null;
      if (inc.die) out.die = store.die.find(d => d.id === row.dieId) || null;
    } else if (table === 'warehouse') {
      if (inc.locations) {
        let locs = store.warehouseLocation.filter(l => l.warehouseId === row.id);
        if (inc.locations?.where) locs = locs.filter(l => matchesWhere('warehouseLocation', l, inc.locations.where));
        out.locations = locs;
      }
    } else if (table === 'warehouseLocation') {
      if (inc.warehouse) out.warehouse = store.warehouse.find(w => w.id === row.warehouseId) || null;
    } else if (table === 'customerOrder') {
      if (inc.customer) out.customer = store.customer.find(c => c.id === row.customerId) || null;
      if (inc.orderLines) {
        let lines = store.customerOrderLine.filter(l => l.orderId === row.id);
        if (inc.orderLines.where) lines = lines.filter(l => matchesWhere('customerOrderLine', l, inc.orderLines.where));
        out.orderLines = lines.map(l => hydrate('customerOrderLine', l, subSpec(inc.orderLines)));
      }
    } else if (table === 'customerOrderLine') {
      if (inc.part) out.part = hydrate('part', store.part.find(p => p.id === row.partId), subSpec(inc.part));
      if (inc.order) out.order = store.customerOrder.find(o => o.id === row.orderId) || null;
      if (inc.productionPlanLines) {
        let pls = store.productionPlanLine.filter(pl => pl.customerOrderLineId === row.id);
        if (inc.productionPlanLines.where) pls = pls.filter(pl => matchesWhere('productionPlanLine', pl, inc.productionPlanLines.where));
        out.productionPlanLines = pls;
      }
    } else if (table === 'item') {
      if (inc.bomParents) {
        let cmps = store.bomComponent.filter(b => b.parentItemId === row.id);
        if (inc.bomParents.where) cmps = cmps.filter(b => matchesWhere('bomComponent', b, inc.bomParents.where));
        out.bomParents = cmps.map(b => ({ ...b, childItem: store.item.find(i => i.id === b.childItemId) || null }));
      }
    } else if (table === 'bomComponent') {
      if (inc.childItem) out.childItem = store.item.find(i => i.id === row.childItemId) || null;
    } else if (table === 'machine') {
      if (inc.capabilities) {
        let caps = store.machineCapability.filter(c => c.machineId === row.id);
        if (inc.capabilities.where) caps = caps.filter(c => matchesWhere('machineCapability', c, inc.capabilities.where));
        out.capabilities = caps.map(c => ({ ...c, operation: store.operation.find(o => o.id === c.operationId) || null }));
      }
      if (inc.dieCompatibilities) {
        out.dieCompatibilities = store.machineDieCompatibility.filter(dc => dc.machineId === row.id);
      }
    } else if (table === 'die') {
      if (inc.machineCompatibilities) out.machineCompatibilities = store.machineDieCompatibility.filter(dc => dc.dieId === row.id);
    } else if (table === 'materialContract') {
      if (inc.supplierCustomer) out.supplierCustomer = store.customer.find(c => c.id === row.supplierCustomerId) || null;
      if (inc.material) out.material = store.material.find(m => m.id === row.materialId) || null;
      if (inc.contractCoilAllocations) {
        out.contractCoilAllocations = store.contractCoilAllocation
          .filter(a => a.contractId === row.id)
          .map(a => ({ ...a, coil: hydrate('physicalCoil', store.physicalCoil.find(c => c.id === a.coilId), { warehouse: true, material: true }) }));
      }
      if (inc.transactions) {
        out.transactions = store.materialContractTransaction
          .filter(t => t.contractId === row.id)
          .map(t => ({ ...t, lot: store.materialLot.find(l => l.id === t.lotId) || null }));
      }
    } else if (table === 'physicalCoil') {
      if (inc.material) out.material = store.material.find(m => m.id === row.materialId) || null;
      if (inc.warehouse) out.warehouse = store.warehouse.find(w => w.id === row.warehouseId) || null;
      if (inc.warehouseLocation) out.warehouseLocation = store.warehouseLocation.find(l => l.id === row.warehouseLocationId) || null;
      if (inc.part) out.part = hydrate('part', store.part.find(p => p.id === row.partId), subSpec(inc.part));
      if (inc.materialLot) out.materialLot = store.materialLot.find(l => l.id === row.materialLotId) || null;
      if (inc.contractAllocations) {
        out.contractAllocations = store.contractCoilAllocation
          .filter(a => a.coilId === row.id)
          .map(a => ({ ...a, contract: store.materialContract.find(c => c.id === a.contractId) || null }));
      }
    } else if (table === 'inventoryDocument') {
      if (inc.lines) out.lines = store.inventoryDocumentLine.filter(l => l.documentId === row.id);
    } else if (table === 'inventoryTransaction') {
      if (inc.document) out.document = store.inventoryDocument.find(d => d.id === row.documentId) || null;
      if (inc.part) out.part = hydrate('part', store.part.find(p => p.id === row.partId), subSpec(inc.part));
      if (inc.materialLot) out.materialLot = store.materialLot.find(l => l.id === row.materialLotId) || null;
      if (inc.physicalCoil) out.physicalCoil = store.physicalCoil.find(c => c.id === row.physicalCoilId) || null;
    } else if (table === 'stockBalance') {
      if (inc.part) out.part = hydrate('part', store.part.find(p => p.id === row.partId), subSpec(inc.part));
      if (inc.warehouse) out.warehouse = store.warehouse.find(w => w.id === row.warehouseId) || null;
      if (inc.location) out.location = store.warehouseLocation.find(l => l.id === row.locationId) || null;
    } else if (table === 'productionPlanProposal') {
      if (inc.lines) {
        out.lines = store.productionPlanProposalLine
          .filter(l => l.proposalId === row.id)
          .map(l => hydrate('productionPlanProposalLine', l, subSpec(inc.lines)));
      }
      if (inc.productionPlan) out.productionPlan = store.productionPlan.find(p => p.proposalId === row.id) || null;
    } else if (table === 'productionPlanProposalLine') {
      if (inc.part) out.part = hydrate('part', store.part.find(p => p.id === row.partId), subSpec(inc.part));
      if (inc.route) out.route = hydrate('partRoute', store.partRoute.find(r => r.id === row.routeId), subSpec(inc.route));
      if (inc.customerOrderLine) out.customerOrderLine = hydrate('customerOrderLine', store.customerOrderLine.find(cl => cl.id === row.customerOrderLineId), subSpec(inc.customerOrderLine));
    } else if (table === 'productionPlan') {
      if (inc.lines) out.lines = store.productionPlanLine.filter(l => l.planId === row.id);
    } else if (table === 'manufacturingOrder') {
      if (inc.part) out.part = hydrate('part', store.part.find(p => p.id === row.partId), subSpec(inc.part));
      if (inc.plan) out.plan = store.productionPlan.find(p => p.id === row.planId) || null;
      if (inc.planLine) out.planLine = store.productionPlanLine.find(pl => pl.id === row.planLineId) || null;
      if (inc.coilIssueReturnRecords) out.coilIssueReturnRecords = store.coilIssueReturnRecord.filter(r => r.manufacturingOrderId === row.id);
      if (inc.operations) {
        const ops = store.productionOperation
          .filter(o => o.manufacturingOrderId === row.id)
          .sort((a, b) => (a.sequence ?? a.stepNumber) - (b.sequence ?? b.stepNumber) || a.stepNumber - b.stepNumber);
        out.operations = ops.map(o => hydrate('productionOperation', o, subSpec(inc.operations)));
      }
      if (inc.transfers) out.transfers = store.productionTransfer.filter(t => t.manufacturingOrderId === row.id);
      if (inc.productionReports) out.productionReports = store.productionReport.filter(r => r.manufacturingOrderId === row.id);
    } else if (table === 'productionOperation') {
      if (inc.operation) out.operation = store.operation.find(o => o.id === row.operationId) || null;
      if (inc.plannedMachine) out.plannedMachine = store.machine.find(m => m.id === row.plannedMachineId) || null;
      if (inc.plannedDie) out.plannedDie = store.die.find(d => d.id === row.plannedDieId) || null;
      if (inc.routeOperation) out.routeOperation = store.routeOperation.find(ro => ro.id === row.routeOperationId) || null;
      if (inc.warehouse) out.warehouse = store.warehouse.find(w => w.id === row.warehouseId) || null;
      if (inc.location) out.location = store.warehouseLocation.find(l => l.id === row.locationId) || null;
      if (inc.manufacturingOrder) {
        out.manufacturingOrder = hydrate('manufacturingOrder', store.manufacturingOrder.find(m => m.id === row.manufacturingOrderId), subSpec(inc.manufacturingOrder));
      }
      if (inc.assignments) {
        out.assignments = store.machineAssignment
          .filter(a => a.productionOperationId === row.id)
          .map(a => hydrate('machineAssignment', a, subSpec(inc.assignments)));
      }
    } else if (table === 'machineAssignment') {
      if (inc.machine) out.machine = store.machine.find(m => m.id === row.machineId) || null;
      if (inc.shift) out.shift = store.shift.find(s => s.id === row.shiftId) || null;
      if (inc.assignedOperator) out.assignedOperator = store.user.find(u => u.id === row.assignedOperatorId) || null;
      if (inc.productionOperation) {
        out.productionOperation = hydrate('productionOperation', store.productionOperation.find(o => o.id === row.productionOperationId), subSpec(inc.productionOperation));
      }
    } else if (table === 'productionReport') {
      if (inc.manufacturingOrder) {
        out.manufacturingOrder = hydrate('manufacturingOrder', store.manufacturingOrder.find(m => m.id === row.manufacturingOrderId), subSpec(inc.manufacturingOrder));
      }
      if (inc.productionOperation) {
        out.productionOperation = hydrate('productionOperation', store.productionOperation.find(o => o.id === row.productionOperationId), subSpec(inc.productionOperation));
      }
      if (inc.machine) out.machine = store.machine.find(m => m.id === row.machineId) || null;
      if (inc.shift) out.shift = store.shift.find(s => s.id === row.shiftId) || null;
      if (inc.operatorUser) out.operatorUser = store.user.find(u => u.id === row.operatorUserId) || null;
    }
    return out;
  }

  function sortRows(rows: any[], orderBy: any): any[] {
    if (!orderBy) return rows;
    const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...rows].sort((a, b) => {
      for (const c of clauses) {
        const [k, dir] = Object.entries(c)[0] as [string, string];
        const av = a[k] instanceof Date ? a[k].getTime() : a[k];
        const bv = b[k] instanceof Date ? b[k].getTime() : b[k];
        if (av === bv) continue;
        if (av == null) return dir === 'desc' ? 1 : -1;
        if (bv == null) return dir === 'desc' ? -1 : 1;
        return (av > bv ? 1 : -1) * (dir === 'desc' ? -1 : 1);
      }
      return 0;
    });
  }

  const mockPrisma: any = {};
  for (const table of Object.keys(store)) {
    mockPrisma[table] = {
      async findMany(args: any = {}) {
        let rows = store[table].filter(r => matchesWhere(table, r, args.where));
        if (args.orderBy) rows = sortRows(rows, args.orderBy);
        if (args.take) rows = rows.slice(0, args.take);
        return rows.map(r => hydrate(table, r, args.include || args.select));
      },
      async findFirst(args: any = {}) {
        const rows = await this.findMany({ ...args, take: 1 });
        return rows[0] || null;
      },
      async findUnique(args: any = {}) {
        return this.findFirst(args);
      },
      async count(args: any = {}) {
        return store[table].filter(r => matchesWhere(table, r, args.where)).length;
      },
      async create(args: any) {
        const d = { ...(args.data || {}) };
        if (table === 'inventoryDocument' && d.idempotencyKey) {
          if (store.inventoryDocument.some(r => r.idempotencyKey === d.idempotencyKey)) {
            throw Object.assign(new Error('Unique idempotencyKey'), { code: 'P2002' });
          }
        }
        if (table === 'productionReport' && d.wipIdempotencyKey) {
          if (store.productionReport.some(r => r.wipIdempotencyKey === d.wipIdempotencyKey)) {
            throw Object.assign(new Error('Unique wipIdempotencyKey'), { code: 'P2002' });
          }
        }
        const rec: any = {
          id: d.id || uid(table.slice(0, 4).toUpperCase()),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...d,
        };
        if (['productionOperation', 'manufacturingOrder', 'coilIssueReturnRecord', 'physicalCoil', 'stockBalance'].includes(table) && rec.version == null) {
          rec.version = 1;
        }
        if (table === 'inventoryDocument' && d.lines?.create) {
          const linesCreate = d.lines.create;
          delete rec.lines;
          store.inventoryDocument.push(rec);
          for (const ln of linesCreate) {
            store.inventoryDocumentLine.push({ id: uid('DOCLN'), documentId: rec.id, createdAt: new Date(), ...ln });
          }
          return hydrate(table, rec, args.include);
        }
        if (table === 'productionPlanProposal' && d.lines?.create) {
          const linesCreate = d.lines.create;
          delete rec.lines;
          store.productionPlanProposal.push(rec);
          for (const ln of linesCreate) {
            store.productionPlanProposalLine.push({ id: uid('PRPL'), proposalId: rec.id, createdAt: new Date(), ...ln });
          }
          return hydrate(table, rec, args.include);
        }
        if (table === 'productionPlan') {
          if (d.proposal?.connect?.id) {
            rec.proposalId = d.proposal.connect.id;
            delete rec.proposal;
          }
          if (d.lines?.create) {
            const linesCreate = d.lines.create;
            delete rec.lines;
            store.productionPlan.push(rec);
            for (const ln of linesCreate) {
              store.productionPlanLine.push({ id: uid('PLNL'), planId: rec.id, createdAt: new Date(), ...ln });
            }
            return hydrate(table, rec, args.include);
          }
        }
        if (table === 'manufacturingOrder' && d.operations?.create) {
          const opsCreate = d.operations.create;
          delete rec.operations;
          store.manufacturingOrder.push(rec);
          for (const op of opsCreate) {
            store.productionOperation.push({
              id: op.id || uid('POP'),
              manufacturingOrderId: rec.id,
              version: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
              ...op,
            });
          }
          return hydrate(table, rec, args.include);
        }
        store[table].push(rec);
        return hydrate(table, rec, args.include || args.select);
      },
      async createMany(args: any) {
        const items = Array.isArray(args.data) ? args.data : [];
        for (const item of items) {
          await this.create({ data: item });
        }
        return { count: items.length };
      },
      async update(args: any) {
        const idx = store[table].findIndex(r => matchesWhere(table, r, args.where));
        if (idx === -1) throw new Error(`Record not found in ${table}`);
        store[table][idx] = applyUpdate(store[table][idx], args.data);
        return hydrate(table, store[table][idx], args.include || args.select);
      },
      async updateMany(args: any) {
        let count = 0;
        store[table] = store[table].map(r => {
          if (matchesWhere(table, r, args.where)) {
            count++;
            return applyUpdate(r, args.data);
          }
          return r;
        });
        return { count };
      },
      async upsert(args: any) {
        const flatWhere = Object.entries(args.where || {}).reduce((acc: any, [k, v]) => {
          if (k.includes('_') && v && typeof v === 'object') Object.assign(acc, v);
          else acc[k] = v;
          return acc;
        }, {});
        const idx = store[table].findIndex(r => matchesWhere(table, r, flatWhere));
        if (idx >= 0) {
          store[table][idx] = applyUpdate(store[table][idx], args.update);
          return hydrate(table, store[table][idx], args.include);
        }
        return this.create({ data: args.create, include: args.include });
      },
    };
  }
  mockPrisma.$transaction = async (fn: any) => {
    const snap = structuredClone(store);
    try {
      return await fn(mockPrisma);
    } catch (err) {
      for (const k of Object.keys(store)) store[k] = snap[k];
      throw err;
    }
  };

  __setProductionWipPrismaForTests(mockPrisma);
  const prevReachable = (global as any).__kpimsDbReachable;
  const prevDbUrl = process.env.DATABASE_URL;
  (global as any).__prismaClient = mockPrisma;
  (global as any).__kpimsDbReachable = true;
  process.env.DATABASE_URL = 'postgresql://mock:mock@127.0.0.1:0/mock_kpims_p7_isolated';

  try {
    let relCoilId = '';
    let relMo: any = null;
    let relOp10: any = null;
    let relOp20: any = null;

    await runScenario('B1', 'Relational: Receive 2000kg SAPCO coil & verify contract ledger', async () => {
      const recRes = await postInventoryDocumentInTransaction(
        {
          id: 'DOC-REL-RCV-1',
          documentNumber: 'RCV-REL-P7-001',
          documentType: 'RECEIPT_RAW_MATERIAL',
          documentDate: now.toISOString(),
          documentStatus: 'DRAFT',
          postingStatus: 'UNPOSTED',
          warehouseId: 'WH-RAW',
          warehouseName: 'انبار مواد اولیه',
          ownership: 'SAPCO_SUPPLIER_OWNED',
          contractId: 'CNT-REL-P7',
          contractNumber: 'CNT-SAPCO-REL-P7',
          referenceType: 'SAPCO_WAYBILL',
          referenceNumber: 'WB-REL-P7-01',
          totalQuantity: 2000,
          totalWeightKg: 2000,
          createdByUid: 'USR-REL-1',
          createdByName: 'اپراتور تست P7',
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          lines: [
            {
              id: 'LN-REL-RCV-1',
              documentId: 'DOC-REL-RCV-1',
              lineNumber: 1,
              partId: 'PRT-REL-RAW',
              partCode: 'RM-DC01A-2MM',
              partName: 'رول ورق DC01A ضخامت 2mm',
              quantity: 2000,
              quantityKg: 2000,
              unit: 'KG',
              lotNumber: 'COIL-REL-P7-01',
              coilId: 'COIL-REL-P7-01',
              coilPackNumber: 'CP-REL-P7-01',
              heatNumber: 'HT-REL-P7-01',
              materialGrade: 'DC01A',
              thicknessMm: 2.0,
              widthMm: 1140,
              locationCode: 'LOC-RAW-A1',
              ownership: 'SAPCO_SUPPLIER_OWNED',
              contractId: 'CNT-REL-P7',
              contractNumber: 'CNT-SAPCO-REL-P7',
              qualityStatus: 'AVAILABLE',
            },
          ],
        } as any,
        { uid: 'USR-REL-1', displayName: 'اپراتور تست P7' },
        { prismaClient: mockPrisma, idempotencyKey: 'REL-P7-RCV-001' }
      );
      assert.equal(recRes.success, true, `Relational coil receipt failed: ${JSON.stringify(recRes)}`);
      assert.equal(store.physicalCoil.length, 1);
      relCoilId = store.physicalCoil[0].id;

      const sapco = await queryContractsAndSapcoAccountFromDb(mockPrisma);
      const c = sapco.contracts.find(x => x.id === 'CNT-REL-P7');
      assert(c && c.totalReceivedKg === 2000 && c.closingBalanceKg === 2000, `Expected 2000kg contract balance, got ${JSON.stringify(c)}`);
      return `PhysicalCoil ${store.physicalCoil[0].coilId} (2000kg) & MaterialContract closing=2000kg`;
    });

    await runScenario('B2', 'Relational: Plan proposal -> approve -> release MO -> assign machines', async () => {
      const rm = await getRelationalPlanningReadModel();
      const fgReq = rm.requirements.find(r => r.partCode === 'FG-ECU-BRK-P7');
      assert(fgReq && fgReq.netProductionRequirement === 100, `Expected net=100, got ${fgReq?.netProductionRequirement}`);

      const prop = await createRelationalPlanProposal('Relational P7 Proposal');
      assert.equal(prop.status, 'DRAFT');

      const approved = await approveRelationalPlanProposal(prop.id, 'مدیر برنامه‌ریزی P7');
      assert.equal(approved.status, 'APPROVED');

      const released = await releaseRelationalPlanProposal(prop.id, 'مدیر تولید P7');
      assert.equal(released.manufacturingOrders.length, 1);
      relMo = released.manufacturingOrders[0];
      const ops = store.productionOperation
        .filter(o => o.manufacturingOrderId === relMo.id)
        .sort((a, b) => a.stepNumber - b.stepNumber);
      assert.equal(ops.length, 2);
      relOp10 = ops[0];
      relOp20 = ops[1];

      await createRelationalMachineAssignment({
        productionOperationId: relOp10.id,
        machineId: 'MCH-REL-250',
        shiftId: 'SH-REL-MORN',
        assignedDate: '2026-12-01',
        assignedOperatorId: 'USR-REL-1',
      });
      await createRelationalMachineAssignment({
        productionOperationId: relOp20.id,
        machineId: 'MCH-REL-250',
        shiftId: 'SH-REL-EVE',
        assignedDate: '2026-12-01',
        assignedOperatorId: 'USR-REL-1',
      });
      const cap = await getRelationalMachineCapacity({ date: '2026-12-01' });
      assert(cap.summary.totalAssignments >= 2);
      return `Released ${relMo.moNumber} (2 ops) & scheduled 2 MachineAssignments on PRS-250-P7`;
    });

    await runScenario('B3', 'Relational: Partial coil issue (300kg) + remnant return (100kg) + SAPCO balance', async () => {
      // Reserve 200 kg & verify
      const rsv = await createReservationInDbTransaction(mockPrisma, {
        partId: 'PRT-REL-RAW',
        warehouseId: 'WH-RAW',
        locationCode: 'LOC-RAW-A1',
        lotNumber: 'COIL-REL-P7-01',
        physicalCoilId: relCoilId,
        ownership: 'SAPCO_SUPPLIER_OWNED',
        contractId: 'CNT-REL-P7',
        reservedFor: relMo.moNumber,
        quantity: 200,
        idempotencyKey: 'REL-P7-RSV-001',
      });
      assert.equal(rsv.success, true, `Relational reservation failed: ${JSON.stringify(rsv)}`);

      // Issue 300 kg partial coil to MO/OP10 (loading 100 pcs into OP10)
      const iss = await issuePhysicalCoilInDbTransaction(mockPrisma, {
        coilIdOrCode: relCoilId,
        issueRequestKey: 'REL-P7-COIL-ISS-001',
        createdByUserId: 'USR-REL-1',
        requested: [
          {
            manufacturingOrderRef: relMo.id,
            operationRef: relOp10.id,
            partRef: 'PRT-REL-FG',
            issuedWeightKg: 300,
            varianceWeightKg: 0,
            initialInputQuantityPcs: 100,
            wipManufacturingOrderId: relMo.id,
          },
        ],
      });
      assert.equal(iss.success, true, `Relational coil issue failed: ${JSON.stringify(iss)}`);
      assert.equal(Number(iss.coil.remainingWeightKg), 1700);

      // Return 100 kg remnant + 10 kg variance -> remaining=1800kg, net consumed=200kg
      const ret = await returnPhysicalCoilRemnantInDbTransaction(mockPrisma, {
        coilIdOrCode: relCoilId,
        returnedWeightKg: 100,
        varianceWeightKg: 10,
        idempotencyKey: 'REL-P7-COIL-RET-001',
        user: { uid: 'USR-REL-1', displayName: 'اپراتور تست P7' },
      });
      assert.equal(ret.success, true, `Relational remnant return failed: ${JSON.stringify(ret)}`);
      assert.equal(Number(ret.coil.remainingWeightKg), 1800);

      // Verify SAPCO contract balance: 2000 received, 200 net consumed (300 - 100), 1800 closing!
      const sapco = await queryContractsAndSapcoAccountFromDb(mockPrisma);
      const cnt = sapco.contracts.find(c => c.id === 'CNT-REL-P7');
      assert(cnt);
      assert.equal(cnt.totalReceivedKg, 2000, `Relational SAPCO totalReceivedKg must stay 2000, got ${cnt.totalReceivedKg}`);
      assert.equal(cnt.totalConsumedKg, 200, `Relational SAPCO totalConsumedKg must be 200, got ${cnt.totalConsumedKg}`);
      assert.equal(cnt.closingBalanceKg, 1800, `Relational SAPCO closingBalanceKg must be 1800, got ${cnt.closingBalanceKg}`);
      return `Coil remaining=1800kg; SAPCO received=2000kg, consumed=200kg, closing=1800kg`;
    });

    await runScenario('B4', 'Relational: Shop-floor execution (OP10 + OP20), coil settlement, FG receipt & OEE', async () => {
      // Check board shows our MO & 190kg outstanding material (300 issued - 100 returned - 10 variance = 190)
      const board = await getRelationalShopFloorBoard({ moId: relMo.id });
      assert.equal(board.workOrders.length, 1);

      // OP10: Start -> Pause -> Resume (15m setup downtime) -> Report (95 good + 5 scrap, 150kg consumed, 60m run, 10m inline DT) -> Complete
      await startShopFloorOperation({
        operationId: relOp10.id,
        idempotencyKey: 'REL-START-OP10-001',
        machineId: 'MCH-REL-250',
        shiftId: 'SH-REL-MORN',
        operatorUserId: 'USR-REL-1',
      });
      await pauseShopFloorOperation({
        operationId: relOp10.id,
        idempotencyKey: 'REL-PAUSE-OP10-001',
        reason: 'تنظیم و تعویض قالب بلنک (SMED)',
        isDowntime: true,
        operatorUserId: 'USR-REL-1',
      });
      await resumeShopFloorOperation({
        operationId: relOp10.id,
        idempotencyKey: 'REL-RESUME-OP10-001',
        machineId: 'MCH-REL-250',
        shiftId: 'SH-REL-MORN',
        downtimeMinutesOverride: 15,
        operatorUserId: 'USR-REL-1',
      });
      await recordShopFloorProductionReport({
        operationId: relOp10.id,
        moId: relMo.id,
        idempotencyKey: 'REL-RPT-OP10-001',
        machineId: 'MCH-REL-250',
        shiftId: 'SH-REL-MORN',
        operatorUserId: 'USR-REL-1',
        goodQty: 95,
        scrapQty: 5,
        scrapReason: 'ترک لبه ورق',
        actualMaterialConsumedKg: 150,
        runTimeMinutes: 60,
        downtimeMinutes: 10,
        downtimeReason: 'تنظیم گیج تغذیه',
      });
      await completeShopFloorOperation({
        operationId: relOp10.id,
        idempotencyKey: 'REL-COMP-OP10-001',
        operatorUserId: 'USR-REL-1',
      });

      // OP20: Auto-transferred 95 pcs waiting -> Start -> Report (95 good, 50m run) -> Complete
      await startShopFloorOperation({
        operationId: relOp20.id,
        idempotencyKey: 'REL-START-OP20-001',
        machineId: 'MCH-REL-250',
        shiftId: 'SH-REL-EVE',
        operatorUserId: 'USR-REL-1',
      });
      await recordShopFloorProductionReport({
        operationId: relOp20.id,
        moId: relMo.id,
        idempotencyKey: 'REL-RPT-OP20-001',
        machineId: 'MCH-REL-250',
        shiftId: 'SH-REL-EVE',
        operatorUserId: 'USR-REL-1',
        goodQty: 95,
        scrapQty: 0,
        runTimeMinutes: 50,
      });
      await completeShopFloorOperation({
        operationId: relOp20.id,
        idempotencyKey: 'REL-COMP-OP20-001',
        operatorUserId: 'USR-REL-1',
      });

      // Standalone downtime (20 min)
      await recordShopFloorDowntime({
        machineId: 'MCH-REL-250',
        idempotencyKey: 'REL-DT-STAND-001',
        shiftId: 'SH-REL-EVE',
        productionOperationId: relOp20.id,
        reason: 'افت فشار باد کلاچ',
        durationMinutes: 20,
        operatorUserId: 'USR-REL-1',
      });

      // Verify FG stock balance in WH-FINISHED == 95 pcs!
      const fgBal = store.stockBalance.find(
        b => b.partId === 'PRT-REL-FG' && b.warehouseId === 'WH-FINISHED'
      );
      assert(fgBal && num(fgBal.quantityOnHand) === 95, `Expected 95 FG in WH-FINISHED, got ${JSON.stringify(fgBal)}`);

      // Verify Unified Relational OEE Analytics computes non-fabricated A/P/Q/OEE with exact downtime (15+10+20=45m)
      const oee = await getRelationalOeeAnalytics({ machineId: 'MCH-REL-250' });
      const sum = oee.summary;
      assert.equal(sum.goodQty, 190, 'Total good across OP10 (95) + OP20 (95) = 190');
      assert.equal(sum.scrapQty, 5);
      assert.equal(sum.time.operatingTimeMinutes, 110, 'Operating time = 60 + 50 = 110 min');
      const totalDt = sum.time.plannedDowntimeMinutes + sum.time.setupTimeMinutes + sum.time.unplannedDowntimeMinutes;
      assert.equal(totalDt, 45, `Downtime must be 15 + 10 + 20 = 45 min (zero double-counting), got ${totalDt}`);
      assert.equal(sum.oeeCalculable, true, 'OEE must be calculable with real assignments, runTime, and standardCycleTimeSec');
      assert(sum.oeePercent !== null && sum.oeePercent > 0 && sum.oeePercent <= 100);

      return `MO completed (95 FG in WH-FINISHED); OEE=${sum.oeePercent}% (A=${sum.availabilityPercent}%, P=${sum.performancePercent}%, Q=${sum.qualityPercent}%, DT=${totalDt}m)`;
    });
  } finally {
    __setProductionWipPrismaForTests(null);
    (global as any).__prismaClient = undefined;
    (global as any).__kpimsDbReachable = prevReachable;
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
  }
}

async function main() {
  await runTrackAHttpEndToEnd();
  await runTrackBUnifiedRelationalFlow();

  console.log('\n=========================================================================');
  console.log('KPIMS P7 ACCEPTANCE SUMMARY');
  console.log('=========================================================================');
  for (const s of scenarioResults) {
    console.log(`${s.status === 'PASS' ? '✅' : '❌'} [${s.id}] ${s.name} — ${s.details}`);
  }
  const failed = scenarioResults.filter(s => s.status === 'FAIL');
  assert.equal(failed.length, 0, `${failed.length} scenario(s) failed`);
  console.log(`\nALL ${scenarioResults.length} KPIMS P7 END-TO-END ACCEPTANCE SCENARIOS PASSED.`);
}

main().catch(err => {
  console.error('\n❌ KPIMS P7 END-TO-END ACCEPTANCE FAILED:', err);
  process.exit(1);
});
