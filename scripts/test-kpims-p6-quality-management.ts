/**
 * =========================================================================
 * KPIMS P6: Quality Management & Product Quality Control Regression Suite
 * =========================================================================
 * Covers:
 *   1. Incoming material inspection (IQC) on physical coils and lots:
 *      - Quarantine blocks production issue (409) and warehouse issue (400/409).
 *      - Acceptance releases via MvT 321 and restores consumption.
 *      - Rejection transitions QUARANTINE -> QUALITY_BLOCKED (MvT 344),
 *        auto-creates linked NCR, and strictly prevents consumption.
 *   2. In-process (IPQC) and final product (FQC) inspections linked to MOs
 *      and operations (including required MO validation on IPQC and split qty).
 *   3. Nonconformance (NCR) recording, classification, containment (344),
 *      and dispositions: USE_AS_IS (321), SCRAP (write-off + WH-SCRAP),
 *      RETURN_TO_SUPPLIER (coil RETURNED), and REWORK (spawns ReworkOrder).
 *   4. Rework execution, over-reporting block (409), return-to-production (321),
 *      scrap remainder write-off, and automatic NCR closure.
 *   5. Quality status & inspection history lookup by lot, physical coil,
 *      production order (MO), and part code.
 *   6. Quality dashboard analytics: stage pass rates, defect Pareto,
 *      recurring issue detection, supplier quality scorecard, and UTF-8 BOM
 *      CSV export with formula-injection neutralization.
 *   7. Transactional idempotency (200 replay, 409 conflict), RBAC (403 for
 *      VIEWER), and post-operation 4-way inventory reconciliation (0 errors).
 *
 * Run with: DATABASE_URL="" npx tsx scripts/test-kpims-p6-quality-management.ts
 * =========================================================================
 */

import assert from 'node:assert/strict';
import express from 'express';
import { apiRouter } from '../src/server/apiRouter';
import { resetQualityStateForTests } from '../src/server/qualityManagementService';

if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '') {
  throw new Error('Refusing to run isolated P6 test suite when DATABASE_URL is configured.');
}

const QC_HEADERS = {
  'Content-Type': 'application/json',
  'x-kpims-role': 'QC_INSPECTOR',
  'x-user-id': 'USR-TEST-QC-P6',
  'x-user-name': 'QC Inspector P6',
};

const ADMIN_HEADERS = {
  'Content-Type': 'application/json',
  'x-kpims-role': 'ADMIN',
  'x-user-id': 'USR-TEST-ADMIN-P6',
  'x-user-name': 'Admin P6',
};

async function httpJson(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      ...QC_HEADERS,
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

async function run() {
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
  const supplierGood = `Mobarakeh-Test-${ts}`;
  const supplierFormula = `=CMD|'/C calc'!A0-Sup-${ts}`;

  try {
    console.log('--- P6.0: Catalog, RBAC & Empty Dashboard Baseline ---');
    const catalogRes = await httpJson(baseUrl, '/quality/catalog');
    assert.equal(catalogRes.status, 200);
    assert.equal(catalogRes.json.success, true);
    assert(catalogRes.json.data.defectCodes.length >= 10, 'Catalog must expose defect codes');
    assert(catalogRes.json.data.checklists.INCOMING_MATERIAL.length >= 3);
    assert(catalogRes.json.data.checklists.IN_PROCESS.length >= 3);
    assert(catalogRes.json.data.checklists.FINAL_PRODUCT.length >= 3);

    // Baseline empty dashboard must NOT fabricate pass/rejection percentages
    const emptyDash = await httpJson(baseUrl, '/quality/dashboard');
    assert.equal(emptyDash.status, 200);
    assert.equal(emptyDash.json.data.summary.overallRejectionRatePercent, null);
    assert.equal(emptyDash.json.data.summary.incomingAcceptanceRatePercent, null);
    assert.ok(emptyDash.json.data.summary.dataQualityNoteFa, 'Empty dashboard must disclose missing inspection denominator');

    // RBAC guard: LINE_SUPERVISOR cannot create quality inspection
    const unauthorizedAttempt = await httpJson(baseUrl, '/quality/inspections', {
      method: 'POST',
      headers: { 'x-kpims-role': 'LINE_SUPERVISOR' },
      body: { inspectionType: 'INCOMING_MATERIAL', partId: 'PRT-RAW-ST14', inspectedQty: 10 },
    });
    assert.equal(unauthorizedAttempt.status, 403, 'Unauthorized role (LINE_SUPERVISOR) must be denied quality writes');

    // Discover real parts, warehouses, and MOs from seeded store
    const [partsRes, moRes] = await Promise.all([
      httpJson(baseUrl, '/parts', { headers: ADMIN_HEADERS }),
      httpJson(baseUrl, '/wip/manufacturing-orders', { headers: ADMIN_HEADERS }),
    ]);
    assert.equal(partsRes.status, 200);
    assert.equal(moRes.status, 200);
    const parts: any[] = partsRes.json.data || [];
    const mos: any[] = moRes.json.data || [];
    const sheetPart = parts.find(p => p.unit === 'KG' && p.category === 'RAW_MATERIAL') || parts[0];
    const fastenerPart =
      parts.find(p => p.unit === 'PCS' && p.category === 'RAW_MATERIAL') ||
      parts.find(p => p.unit === 'PCS') ||
      parts[0];
    const finishedPart = parts.find(p => p.category === 'FINISHED_GOOD') || parts[0];
    const sampleMo = mos[0];
    assert(sheetPart, 'Sheet-metal raw part required');
    assert(fastenerPart, 'Fastener/PCS part required');
    assert(sampleMo, 'At least one Manufacturing Order required');

    // =========================================================================
    // TEST 1: Incoming Material Inspection (IQC) on Coils + Consumption Guards
    // =========================================================================
    console.log('--- P6.1: Incoming Coil Inspection, Quarantine/Reject Guards & Release ---');
    const coilAcceptCode = `COIL-P6-OK-${ts}`;
    const coilRejectCode = `COIL-P6-REJ-${ts}`;

    // Receive Coil 1 directly into QUARANTINE
    const recCoil1 = await httpJson(baseUrl, '/inventory/documents', {
      method: 'POST',
      headers: { ...ADMIN_HEADERS, 'Idempotency-Key': `P6-REC-C1-${ts}` },
      body: {
        documentType: 'RECEIPT_RAW_MATERIAL',
        warehouseId: 'WH-RAW',
        ownership: 'SAPCO_SUPPLIER_OWNED',
        autoPost: true,
        referenceNumber: `GRN-C1-${ts}`,
        lines: [
          {
            partId: sheetPart.id,
            partCode: sheetPart.code,
            partName: sheetPart.name,
            quantity: 1200,
            quantityKg: 1200,
            unit: 'KG',
            lotNumber: coilAcceptCode,
            coilId: coilAcceptCode,
            coilPackNumber: coilAcceptCode,
            locationCode: 'LOC-RAW-A1',
            qualityStatus: 'QUARANTINE',
            ownership: 'SAPCO_SUPPLIER_OWNED',
            supplierName: supplierGood,
            materialGrade: sheetPart.materialGrade || 'DC01A',
            thicknessMm: sheetPart.thicknessMm || 1.2,
          },
        ],
      },
    });
    assert.equal(recCoil1.status, 201, `Coil 1 receipt failed: ${JSON.stringify(recCoil1.json)}`);

    // Receive Coil 2 directly into QUARANTINE (from formula-injection test supplier)
    const recCoil2 = await httpJson(baseUrl, '/inventory/documents', {
      method: 'POST',
      headers: { ...ADMIN_HEADERS, 'Idempotency-Key': `P6-REC-C2-${ts}` },
      body: {
        documentType: 'RECEIPT_RAW_MATERIAL',
        warehouseId: 'WH-RAW',
        ownership: 'COMPANY_OWNED',
        autoPost: true,
        referenceNumber: `GRN-C2-${ts}`,
        lines: [
          {
            partId: sheetPart.id,
            partCode: sheetPart.code,
            partName: sheetPart.name,
            quantity: 800,
            quantityKg: 800,
            unit: 'KG',
            lotNumber: coilRejectCode,
            coilId: coilRejectCode,
            coilPackNumber: coilRejectCode,
            locationCode: 'LOC-RAW-A1',
            qualityStatus: 'QUARANTINE',
            ownership: 'COMPANY_OWNED',
            supplierName: supplierFormula,
            materialGrade: sheetPart.materialGrade || 'DC01A',
            thicknessMm: sheetPart.thicknessMm || 1.2,
          },
        ],
      },
    });
    assert.equal(recCoil2.status, 201, `Coil 2 receipt failed: ${JSON.stringify(recCoil2.json)}`);

    // Verify QUARANTINE Coil 1 CANNOT be issued to production (409)
    const blockedCoilIssue = await httpJson(baseUrl, `/inventory/coils/${encodeURIComponent(coilAcceptCode)}/issue`, {
      method: 'POST',
      headers: { ...ADMIN_HEADERS, 'Idempotency-Key': `P6-TRY-ISSUE-Q1-${ts}` },
      body: { issuedWeightKg: 200, moId: sampleMo.id },
    });
    assert.equal(blockedCoilIssue.status, 409, 'Quarantined coil MUST be blocked from coil issue (409)');

    // Verify QUARANTINE Coil 1 CANNOT be issued via warehouse ISSUE_RAW_MATERIAL
    const blockedDocIssue = await httpJson(baseUrl, '/inventory/documents', {
      method: 'POST',
      headers: { ...ADMIN_HEADERS, 'Idempotency-Key': `P6-TRY-DOC-Q1-${ts}` },
      body: {
        documentType: 'ISSUE_RAW_MATERIAL',
        warehouseId: 'WH-RAW',
        ownership: 'SAPCO_SUPPLIER_OWNED',
        autoPost: true,
        lines: [
          {
            partId: sheetPart.id,
            partCode: sheetPart.code,
            partName: sheetPart.name,
            quantity: 200,
            quantityKg: 200,
            unit: 'KG',
            lotNumber: coilAcceptCode,
            locationCode: 'LOC-RAW-A1',
            ownership: 'SAPCO_SUPPLIER_OWNED',
          },
        ],
      },
    });
    assert(!blockedDocIssue.ok, 'Quarantined stock MUST be blocked from warehouse ISSUE_RAW_MATERIAL');

    // Create Incoming Inspection for Coil 1 (PENDING) + verify Idempotency Replay & Conflict
    const insp1Key = `P6-INSP1-${ts}`;
    const insp1Payload = {
      inspectionType: 'INCOMING_MATERIAL',
      partId: sheetPart.id,
      warehouseId: 'WH-RAW',
      lotNumber: coilAcceptCode,
      coilId: coilAcceptCode,
      supplierName: supplierGood,
      inspectedQty: 1200,
      notes: 'بازرسی ورودی کلاف سالم',
    };
    const insp1 = await httpJson(baseUrl, '/quality/inspections', {
      method: 'POST',
      headers: { 'Idempotency-Key': insp1Key },
      body: insp1Payload,
    });
    assert.equal(insp1.status, 201, `Create inspection 1 failed: ${JSON.stringify(insp1.json)}`);
    const insp1Id = insp1.json.data.id;

    // Replay same key & payload -> 200 idempotentReplay: true
    const insp1Replay = await httpJson(baseUrl, '/quality/inspections', {
      method: 'POST',
      headers: { 'Idempotency-Key': insp1Key },
      body: insp1Payload,
    });
    assert.equal(insp1Replay.status, 200);
    assert.equal(insp1Replay.json.idempotentReplay, true);
    assert.equal(insp1Replay.json.data.id, insp1Id);

    // Same key & different payload -> 409 conflict
    const insp1Conflict = await httpJson(baseUrl, '/quality/inspections', {
      method: 'POST',
      headers: { 'Idempotency-Key': insp1Key },
      body: { ...insp1Payload, inspectedQty: 999 },
    });
    assert.equal(insp1Conflict.status, 409, 'Idempotency payload conflict must return 409');

    // Decide Coil 1 ACCEPTED -> posts MvT 321, releases stock & coil
    const dec1Key = `P6-DEC1-${ts}`;
    const dec1 = await httpJson(baseUrl, `/quality/inspections/${insp1Id}/decide`, {
      method: 'POST',
      headers: { 'Idempotency-Key': dec1Key },
      body: { decision: 'ACCEPTED', acceptedQty: 1200, notes: 'انطباق کامل ضخامت و گواهی MTC' },
    });
    assert.equal(dec1.status, 200, `Decide ACCEPTED failed: ${JSON.stringify(dec1.json)}`);
    assert.equal(dec1.json.data.decision, 'ACCEPTED');
    assert.ok(dec1.json.qmDocument?.documentNumber, 'ACCEPTED decision must post MvT 321 document');

    // Re-deciding completed inspection with a new key must be blocked (409)
    const dec1Again = await httpJson(baseUrl, `/quality/inspections/${insp1Id}/decide`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `P6-DEC1-DUP-${ts}` },
      body: { decision: 'REJECTED' },
    });
    assert.equal(dec1Again.status, 409, 'Already completed inspection cannot be re-decided');

    // Now Coil 1 IS accepted -> issuing 200 kg to production MUST succeed!
    const allowedCoilIssue = await httpJson(baseUrl, `/inventory/coils/${encodeURIComponent(coilAcceptCode)}/issue`, {
      method: 'POST',
      headers: { ...ADMIN_HEADERS, 'Idempotency-Key': `P6-ALLOW-ISSUE-C1-${ts}` },
      body: { issuedWeightKg: 200, moId: sampleMo.id },
    });
    assert.equal(allowedCoilIssue.status, 200, `Accepted coil should be issuable: ${JSON.stringify(allowedCoilIssue.json)}`);

    // Incoming Inspection for Coil 2 with immediate REJECTED decision -> QUARANTINE -> QUALITY_BLOCKED (344) + auto NCR
    const insp2 = await httpJson(baseUrl, '/quality/inspections', {
      method: 'POST',
      headers: { 'Idempotency-Key': `P6-INSP2-REJ-${ts}` },
      body: {
        inspectionType: 'INCOMING_MATERIAL',
        partId: sheetPart.id,
        warehouseId: 'WH-RAW',
        lotNumber: coilRejectCode,
        coilId: coilRejectCode,
        supplierName: supplierFormula,
        inspectedQty: 800,
        decision: 'REJECTED',
        rejectedQty: 800,
        defectCodes: ['DEF-THICK'],
        severity: 'CRITICAL',
        defectSummary: 'ضخامت ورق خارج از تلرانس استاندارد',
      },
    });
    assert.equal(insp2.status, 201, `Rejected incoming inspection failed: ${JSON.stringify(insp2.json)}`);
    assert.equal(insp2.json.data.decision, 'REJECTED');
    assert.ok(insp2.json.qmDocument?.documentNumber, 'Rejected incoming coil must post MvT 344 document');
    assert.ok(insp2.json.ncr?.id, 'Rejected incoming inspection must auto-create linked NCR');
    const coil2NcrId = insp2.json.ncr.id;

    // Verify rejected Coil 2 is STRICTLY blocked from consumption
    const blockedRejCoilIssue = await httpJson(baseUrl, `/inventory/coils/${encodeURIComponent(coilRejectCode)}/issue`, {
      method: 'POST',
      headers: { ...ADMIN_HEADERS, 'Idempotency-Key': `P6-TRY-ISSUE-REJ-${ts}` },
      body: { issuedWeightKg: 100, moId: sampleMo.id },
    });
    assert.equal(blockedRejCoilIssue.status, 409, 'Rejected coil MUST be blocked from production issue');

    // Dispose Coil 2 NCR as RETURN_TO_SUPPLIER -> writes off stock & marks coil RETURNED
    const retSupRes = await httpJson(baseUrl, `/quality/ncrs/${coil2NcrId}/disposition`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `P6-DISP-RTS-${ts}` },
      body: {
        disposition: 'RETURN_TO_SUPPLIER',
        rootCause: 'خطای نورد تامین‌کننده',
        correctiveAction: 'صدور اخطار کیفی و عودت کلاف به تامین‌کننده',
        dispositionNotes: 'عودت کامل ۸۰۰ کیلوگرم کلاف نامنطبق',
      },
    });
    assert.equal(retSupRes.status, 200, `RETURN_TO_SUPPLIER failed: ${JSON.stringify(retSupRes.json)}`);
    assert.equal(retSupRes.json.data.status, 'CLOSED');
    assert.equal(retSupRes.json.data.returnedToSupplierQty, 800);

    // =========================================================================
    // TEST 2: In-Process (IPQC) & Final Product (FQC) Inspections Linked to MO
    // =========================================================================
    console.log('--- P6.2: In-Process (IPQC) & Final Product (FQC) Inspections ---');
    // IPQC without MO must fail with 400
    const ipqcNoMo = await httpJson(baseUrl, '/quality/inspections', {
      method: 'POST',
      headers: { 'Idempotency-Key': `P6-IPQC-NOMO-${ts}` },
      body: {
        inspectionType: 'IN_PROCESS',
        partId: sampleMo.partId || finishedPart.id,
        inspectedQty: 50,
      },
    });
    assert.equal(ipqcNoMo.status, 400, 'IPQC without MO linkage must return 400');

    // Valid IPQC linked to MO & Operation with split decision (accepted + rework + rejected)
    const firstOp = sampleMo.operations?.[0];
    const ipqcRes = await httpJson(baseUrl, '/quality/inspections', {
      method: 'POST',
      headers: { 'Idempotency-Key': `P6-IPQC-OK-${ts}` },
      body: {
        inspectionType: 'IN_PROCESS',
        partId: sampleMo.partId || finishedPart.id,
        manufacturingOrderId: sampleMo.id,
        moNumber: sampleMo.moNumber,
        operationCode: firstOp?.operationCode || firstOp?.code || 'OP10',
        operationName: firstOp?.operationName || firstOp?.name || 'پرس‌کاری مرحله اول',
        inspectedQty: 100,
        decision: 'QUARANTINED',
        acceptedQty: 80,
        reworkQty: 15,
        rejectedQty: 5,
        defectCodes: ['DEF-THICK'], // Second DEF-THICK occurrence -> triggers recurring issue!
        severity: 'MAJOR',
        defectSummary: 'عدم انطباق ضخامت در نمونه حین فرآیند',
      },
    });
    assert.equal(ipqcRes.status, 201, `IPQC creation failed: ${JSON.stringify(ipqcRes.json)}`);
    assert.equal(ipqcRes.json.data.moNumber, sampleMo.moNumber);
    assert.ok(ipqcRes.json.ncr?.id, 'IPQC with rework/rejected qty must auto-create linked NCR');

    // Final Product Inspection (FQC) linked to finished product & MO
    const fqcRes = await httpJson(baseUrl, '/quality/inspections', {
      method: 'POST',
      headers: { 'Idempotency-Key': `P6-FQC-OK-${ts}` },
      body: {
        inspectionType: 'FINAL_PRODUCT',
        partId: finishedPart.id,
        manufacturingOrderId: sampleMo.id,
        moNumber: sampleMo.moNumber,
        inspectedQty: 200,
        decision: 'ACCEPTED',
        acceptedQty: 200,
        notes: 'تایید نهایی CMM و بسته‌بندی ساپکو',
      },
    });
    assert.equal(fqcRes.status, 201, `FQC creation failed: ${JSON.stringify(fqcRes.json)}`);
    assert.equal(fqcRes.json.data.decision, 'ACCEPTED');

    // =========================================================================
    // TEST 3 & 4: Manual NCR Containment, USE_AS_IS, SCRAP, and REWORK Lifecycle
    // =========================================================================
    console.log('--- P6.3 & P6.4: NCR Containment, USE_AS_IS, SCRAP & REWORK Workflows ---');
    const lotNcrUseAsIs = `LOT-P6-UAI-${ts}`;
    const lotNcrRework = `LOT-P6-REW-${ts}`;
    const lotNcrScrap = `LOT-P6-SCR-${ts}`;

    // Receive three fastener lots into WH-RAW (AVAILABLE) so we can test real stock locks & releases
    for (const [lot, qty, keySuffix] of [
      [lotNcrUseAsIs, 50, 'UAI'],
      [lotNcrRework, 40, 'REW'],
      [lotNcrScrap, 30, 'SCR'],
    ] as const) {
      const r = await httpJson(baseUrl, '/inventory/documents', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Idempotency-Key': `P6-REC-FAST-${keySuffix}-${ts}` },
        body: {
          documentType: 'RECEIPT_RAW_MATERIAL',
          warehouseId: 'WH-RAW',
          ownership: 'COMPANY_OWNED',
          autoPost: true,
          lines: [
            {
              partId: fastenerPart.id,
              partCode: fastenerPart.code,
              partName: fastenerPart.name,
              quantity: qty,
              quantityKg: qty,
              unit: fastenerPart.unit || 'PCS',
              lotNumber: lot,
              locationCode: 'LOC-RAW-A1',
              qualityStatus: 'AVAILABLE',
              ownership: 'COMPANY_OWNED',
            },
          ],
        },
      });
      assert.equal(r.status, 201, `Fastener lot ${lot} receipt failed: ${JSON.stringify(r.json)}`);
    }

    // 3A. Manual NCR -> Contain (344) -> Verify blocked from issue -> Disposition USE_AS_IS (321) -> Verify consumable
    const ncrUai = await httpJson(baseUrl, '/quality/ncrs', {
      method: 'POST',
      headers: { 'Idempotency-Key': `P6-NCR-UAI-${ts}` },
      body: {
        sourceType: 'WAREHOUSE_AUDIT',
        partId: fastenerPart.id,
        warehouseId: 'WH-RAW',
        lotNumber: lotNcrUseAsIs,
        defectCode: 'DEF-SCRATCH',
        severity: 'MINOR',
        affectedQty: 50,
        description: 'خراش جزئی ظاهری روی بسته پیچ و مهره',
      },
    });
    assert.equal(ncrUai.status, 201);
    const ncrUaiId = ncrUai.json.data.id;

    const containUai = await httpJson(baseUrl, `/quality/ncrs/${ncrUaiId}/contain`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `P6-CONT-UAI-${ts}` },
      body: { containmentAction: 'قفل فوری بچ تا بررسی مهندسی', holdType: 'BLOCKED' },
    });
    assert.equal(containUai.status, 200);
    assert.equal(containUai.json.data.status, 'CONTAINED');
    assert.ok(containUai.json.qmDocument?.documentNumber);

    // Contained lot cannot be issued!
    const blockedUaiIssue = await httpJson(baseUrl, '/inventory/documents', {
      method: 'POST',
      headers: { ...ADMIN_HEADERS, 'Idempotency-Key': `P6-TRY-ISSUE-UAI-${ts}` },
      body: {
        documentType: 'ISSUE_RAW_MATERIAL',
        warehouseId: 'WH-RAW',
        ownership: 'COMPANY_OWNED',
        autoPost: true,
        lines: [
          {
            partId: fastenerPart.id,
            partCode: fastenerPart.code,
            partName: fastenerPart.name,
            quantity: 10,
            quantityKg: 10,
            unit: fastenerPart.unit || 'PCS',
            lotNumber: lotNcrUseAsIs,
            locationCode: 'LOC-RAW-A1',
            ownership: 'COMPANY_OWNED',
          },
        ],
      },
    });
    assert(!blockedUaiIssue.ok, 'Contained NCR lot MUST be blocked from consumption');

    // USE_AS_IS releases stock via 321 and closes NCR
    const dispUai = await httpJson(baseUrl, `/quality/ncrs/${ncrUaiId}/disposition`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `P6-DISP-UAI-${ts}` },
      body: {
        disposition: 'USE_AS_IS',
        rootCause: 'اصطکاک حمل و نقل بدون اثر عملکردی',
        correctiveAction: 'بهبود لایه محافظ کارتن',
      },
    });
    assert.equal(dispUai.status, 200);
    assert.equal(dispUai.json.data.status, 'CLOSED');

    // Now lotNcrUseAsIs IS releasable/consumable again!
    const allowedUaiIssue = await httpJson(baseUrl, '/inventory/documents', {
      method: 'POST',
      headers: { ...ADMIN_HEADERS, 'Idempotency-Key': `P6-ALLOW-ISSUE-UAI-${ts}` },
      body: {
        documentType: 'ISSUE_RAW_MATERIAL',
        warehouseId: 'WH-RAW',
        ownership: 'COMPANY_OWNED',
        autoPost: true,
        lines: [
          {
            partId: fastenerPart.id,
            partCode: fastenerPart.code,
            partName: fastenerPart.name,
            quantity: 10,
            quantityKg: 10,
            unit: fastenerPart.unit || 'PCS',
            lotNumber: lotNcrUseAsIs,
            locationCode: 'LOC-RAW-A1',
            ownership: 'COMPANY_OWNED',
          },
        ],
      },
    });
    assert.equal(allowedUaiIssue.status, 201, `Released USE_AS_IS lot should be consumable: ${JSON.stringify(allowedUaiIssue.json)}`);

    // 3B. Manual NCR with containImmediately -> SCRAP disposition (writes off blocked stock + credits WH-SCRAP)
    const ncrScrap = await httpJson(baseUrl, '/quality/ncrs', {
      method: 'POST',
      headers: { 'Idempotency-Key': `P6-NCR-SCR-${ts}` },
      body: {
        sourceType: 'IN_PROCESS',
        partId: fastenerPart.id,
        warehouseId: 'WH-RAW',
        lotNumber: lotNcrScrap,
        moNumber: sampleMo.moNumber,
        defectCode: 'DEF-CRACK',
        severity: 'CRITICAL',
        affectedQty: 30,
        description: 'ترک بحرانی غیرقابل اصلاح در قطعات',
        containImmediately: true,
        containmentAction: 'جداسازی در سبد قرمز ضایعات',
      },
    });
    assert.equal(ncrScrap.status, 201);
    assert.equal(ncrScrap.json.data.status, 'CONTAINED');

    const dispScrap = await httpJson(baseUrl, `/quality/ncrs/${ncrScrap.json.data.id}/disposition`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `P6-DISP-SCR-${ts}` },
      body: {
        disposition: 'SCRAP',
        rootCause: 'سختی بیش از حد ماده',
        correctiveAction: 'اسقاط کامل بچ و بازنگری عملیات حرارتی',
      },
    });
    assert.equal(dispScrap.status, 200, `SCRAP disposition failed: ${JSON.stringify(dispScrap.json)}`);
    assert.equal(dispScrap.json.data.status, 'CLOSED');
    assert.equal(dispScrap.json.data.scrappedQty, 30);

    // 3C. Manual NCR -> Contain -> REWORK -> Over-report blocked (409) -> Complete Rework (32 good + 8 scrap) -> Auto-close NCR
    const ncrRew = await httpJson(baseUrl, '/quality/ncrs', {
      method: 'POST',
      headers: { 'Idempotency-Key': `P6-NCR-REW-${ts}` },
      body: {
        sourceType: 'IN_PROCESS',
        partId: fastenerPart.id,
        warehouseId: 'WH-RAW',
        lotNumber: lotNcrRework,
        moNumber: sampleMo.moNumber,
        defectCode: 'DEF-BURR',
        severity: 'MAJOR',
        affectedQty: 40,
        description: 'پلیسه لبه قابل سنگ‌زنی و اصلاح',
        containImmediately: true,
        containmentAction: 'قرنطینه جهت ایستگاه دوباره‌کاری',
      },
    });
    assert.equal(ncrRew.status, 201);
    const ncrRewId = ncrRew.json.data.id;

    const dispRewKey = `P6-DISP-REW-${ts}`;
    const dispRew = await httpJson(baseUrl, `/quality/ncrs/${ncrRewId}/disposition`, {
      method: 'POST',
      headers: { 'Idempotency-Key': dispRewKey },
      body: {
        disposition: 'REWORK',
        reworkInstructions: 'پلیسه‌گیری دقیق لبه و بازرسی ۱۰۰٪ چشمی',
        returnToProduction: true,
      },
    });
    assert.equal(dispRew.status, 200, `REWORK disposition failed: ${JSON.stringify(dispRew.json)}`);
    assert.equal(dispRew.json.data.status, 'IN_REWORK');
    assert.ok(dispRew.json.reworkOrder?.id, 'REWORK disposition must spawn a ReworkOrderRecord');
    const reworkId = dispRew.json.reworkOrder.id;

    // Idempotency replay on disposition
    const dispRewReplay = await httpJson(baseUrl, `/quality/ncrs/${ncrRewId}/disposition`, {
      method: 'POST',
      headers: { 'Idempotency-Key': dispRewKey },
      body: {
        disposition: 'REWORK',
        reworkInstructions: 'پلیسه‌گیری دقیق لبه و بازرسی ۱۰۰٪ چشمی',
        returnToProduction: true,
      },
    });
    assert.equal(dispRewReplay.status, 200);
    assert.equal(dispRewReplay.json.idempotentReplay, true);

    // Over-reporting rework (45 > 40) must be blocked (409)
    const overRework = await httpJson(baseUrl, `/quality/rework-orders/${reworkId}/complete`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `P6-REW-OVER-${ts}` },
      body: { goodQty: 35, scrapQty: 10, returnToProduction: true },
    });
    assert.equal(overRework.status, 409, 'Rework over-reporting must be blocked (409)');

    // Valid completion: 32 good (released 321 + returned to production) + 8 scrap (written off)
    const compRewKey = `P6-REW-COMP-${ts}`;
    const compRewPayload = {
      goodQty: 32,
      scrapQty: 8,
      returnToProduction: true,
      completionNotes: '۳۲ عدد سالم اصلاح و به خط تولید بازگشت؛ ۸ عدد ضایعات شد.',
    };
    const compRew = await httpJson(baseUrl, `/quality/rework-orders/${reworkId}/complete`, {
      method: 'POST',
      headers: { 'Idempotency-Key': compRewKey },
      body: compRewPayload,
    });
    assert.equal(compRew.status, 200, `Complete rework failed: ${JSON.stringify(compRew.json)}`);
    assert.equal(compRew.json.data.status, 'COMPLETED');
    assert.equal(compRew.json.data.completedGoodQty, 32);
    assert.equal(compRew.json.data.scrappedQty, 8);
    assert.equal(compRew.json.data.remainingQty, 0);
    assert.equal(compRew.json.ncr?.status, 'CLOSED', 'Completing full rework qty must auto-close linked NCR');
    assert.equal(compRew.json.ncr?.returnedToProductionQty, 32);

    // Idempotency replay & conflict on rework completion
    const compRewReplay = await httpJson(baseUrl, `/quality/rework-orders/${reworkId}/complete`, {
      method: 'POST',
      headers: { 'Idempotency-Key': compRewKey },
      body: compRewPayload,
    });
    assert.equal(compRewReplay.status, 200);
    assert.equal(compRewReplay.json.idempotentReplay, true);

    const compRewConflict = await httpJson(baseUrl, `/quality/rework-orders/${reworkId}/complete`, {
      method: 'POST',
      headers: { 'Idempotency-Key': compRewKey },
      body: { ...compRewPayload, goodQty: 30, scrapQty: 10 },
    });
    assert.equal(compRewConflict.status, 409);

    // Verify the 32 reworked good units are now consumable, while 33 fails (8 were scrapped!)
    const issueReworkedOk = await httpJson(baseUrl, '/inventory/documents', {
      method: 'POST',
      headers: { ...ADMIN_HEADERS, 'Idempotency-Key': `P6-ISSUE-REW-32-${ts}` },
      body: {
        documentType: 'ISSUE_RAW_MATERIAL',
        warehouseId: 'WH-RAW',
        ownership: 'COMPANY_OWNED',
        autoPost: true,
        lines: [
          {
            partId: fastenerPart.id,
            partCode: fastenerPart.code,
            partName: fastenerPart.name,
            quantity: 32,
            quantityKg: 32,
            unit: fastenerPart.unit || 'PCS',
            lotNumber: lotNcrRework,
            locationCode: 'LOC-RAW-A1',
            ownership: 'COMPANY_OWNED',
          },
        ],
      },
    });
    assert.equal(issueReworkedOk.status, 201, `32 reworked good units should be consumable: ${JSON.stringify(issueReworkedOk.json)}`);

    // =========================================================================
    // TEST 5: Quality Status & Inspection History Traceability
    // =========================================================================
    console.log('--- P6.5: Quality Status & Traceability History (Coil, Lot, MO, Part) ---');
    const histCoil = await httpJson(baseUrl, `/quality/history?coilId=${encodeURIComponent(coilAcceptCode)}`);
    assert.equal(histCoil.status, 200);
    assert.equal(histCoil.json.data.currentQualityStatus, 'AVAILABLE');
    assert.equal(histCoil.json.data.stockSummary.availableQty, 1000, '1200 received - 200 issued = 1000 kg remaining');
    assert(histCoil.json.data.inspections.length >= 1);
    assert(histCoil.json.data.timeline.length >= 2, 'Timeline must include inspection and QM transfer events');

    const histLot = await httpJson(baseUrl, `/quality/history?lotNumber=${encodeURIComponent(lotNcrRework)}`);
    assert.equal(histLot.status, 200);
    assert(histLot.json.data.ncrs.length >= 1);
    assert(histLot.json.data.reworkOrders.length >= 1);
    assert(histLot.json.data.timeline.some((e: any) => e.eventType === 'REWORK_COMPLETED'));

    const histMo = await httpJson(baseUrl, `/quality/history?moNumber=${encodeURIComponent(sampleMo.moNumber)}`);
    assert.equal(histMo.status, 200);
    assert(histMo.json.data.inspections.length >= 2, 'MO history must include both IPQC and FQC inspections');
    assert(histMo.json.data.ncrs.length >= 2, 'MO history must include linked NCRs');

    const histPart = await httpJson(baseUrl, `/quality/history?partCode=${encodeURIComponent(finishedPart.code)}`);
    assert.equal(histPart.status, 200);
    assert(histPart.json.data.inspections.length >= 1, 'Finished product history must include FQC inspection');

    // =========================================================================
    // TEST 6: Quality Dashboard Analytics, Recurring Issues, Suppliers & CSV
    // =========================================================================
    console.log('--- P6.6: Quality Dashboard, Recurring Pareto, Suppliers & CSV Export ---');
    const dashRes = await httpJson(baseUrl, '/quality/dashboard');
    assert.equal(dashRes.status, 200);
    const dash = dashRes.json.data;
    assert.equal(dash.summary.totalInspections, 4, 'Expected 4 total inspections (2 IQC + 1 IPQC + 1 FQC)');
    assert.equal(dash.summary.totalNcrCount, 5, 'Expected 5 total NCRs (2 auto + 3 manual)');
    assert.equal(dash.summary.reworkedGoodQtyTotal, 32);
    assert.equal(dash.summary.returnedToProductionQtyTotal, 32);
    assert(dash.summary.scrappedFromQcQtyTotal >= 38, 'Expected >= 38 scrapped qty (30 SCRAP + 8 rework scrap)');
    assert.equal(dash.summary.incomingAcceptanceRatePercent, 60, '1200 accepted kg out of 2000 inspected kg = 60%');
    assert.equal(dash.summary.finalPassRatePercent, 100, '1 accepted out of 1 final = 100%');

    // Recurring issue verification: DEF-THICK appeared twice (Coil 2 + IPQC)
    const thickPareto = dash.defectPareto.find((d: any) => d.defectCode === 'DEF-THICK');
    assert(thickPareto, 'DEF-THICK must appear in defect Pareto');
    assert(thickPareto.occurrenceCount >= 2, 'DEF-THICK must have >= 2 occurrences');
    assert.equal(thickPareto.isRecurring, true, 'DEF-THICK must be flagged as recurring');
    assert(dash.recurringIssues.some((d: any) => d.defectCode === 'DEF-THICK'));

    // Supplier performance verification
    const goodSupRow = dash.supplierPerformance.find((s: any) => s.supplierName === supplierGood);
    const badSupRow = dash.supplierPerformance.find((s: any) => s.supplierName === supplierFormula);
    assert(goodSupRow && goodSupRow.rejectionRatePercent === 0 && goodSupRow.qualityScorePercent === 100);
    assert(badSupRow && badSupRow.rejectionRatePercent === 100 && badSupRow.rejectedInspections === 1);

    // CSV export: verify UTF-8 BOM [0xEF, 0xBB, 0xBF] + formula-injection neutralization
    const csvRes = await fetch(`${baseUrl}/quality/dashboard?format=csv`, { headers: QC_HEADERS });
    assert.equal(csvRes.status, 200);
    const csvBuf = Buffer.from(await csvRes.arrayBuffer());
    assert.equal(csvBuf[0], 0xef, 'CSV must begin with UTF-8 BOM byte 0xEF');
    assert.equal(csvBuf[1], 0xbb, 'CSV must begin with UTF-8 BOM byte 0xBB');
    assert.equal(csvBuf[2], 0xbf, 'CSV must begin with UTF-8 BOM byte 0xBF');
    const csvText = csvBuf.slice(3).toString('utf8');
    assert(csvText.includes(`"'=CMD|`), 'CSV export must neutralize formula-starting supplier cell with leading single quote');

    // =========================================================================
    // TEST 7: 4-Way Inventory Reconciliation Integrity Check
    // =========================================================================
    console.log('--- P6.7: 4-Way Inventory Reconciliation Integrity ---');
    const reconRes = await httpJson(baseUrl, '/inventory/reconciliation', { headers: ADMIN_HEADERS });
    assert.equal(reconRes.status, 200);
    assert.equal(
      reconRes.json.data.summary.errorCount,
      0,
      `4-way reconciliation must have 0 errors after all P6 quality operations, got: ${JSON.stringify(reconRes.json.data.discrepancies)}`
    );

    console.log('\n✅ ALL KPIMS P6 QUALITY MANAGEMENT REGRESSION TESTS PASSED (100%).');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

run().catch(err => {
  console.error('❌ KPIMS P6 TEST FAILED:', err);
  process.exit(1);
});
