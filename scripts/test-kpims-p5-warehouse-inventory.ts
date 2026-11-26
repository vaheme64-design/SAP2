/**
 * =========================================================================
 * KPIMS P5: Warehouse Operations & Inventory Management Regression Suite
 * =========================================================================
 * Covers:
 *   1. Material family classification (SHEET_METAL, FASTENER, RUBBER, WIP, FINISHED_GOOD)
 *      and guard against creating fake PhysicalCoil records for fasteners/rubber.
 *   2. End-to-end warehouse receipt (101), production issue (261), production return (262),
 *      and inter-warehouse transfer (311) for sheet metal, fasteners, and rubber —
 *      including ownership/contract preservation across transfers and overdraft protection.
 *   3. Full physical coil lifecycle: register/receive coil, partial-roll issue, whole-roll
 *      issue (CONSUMED / 0 kg), remnant return with varianceWeightKg, over-return block (409),
 *      inter-warehouse coil transfer moving warehouseId, and genealogy traceability.
 *   4. Sheet-metal multi-filter stock inquiry & coil queries (materialGrade, thicknessMm,
 *      coilPackNumber, warehouseId, contractNumber, materialFamily, stockStatus) plus
 *      Available / Reserved / Quality-Hold / Total stock equation verification.
 *   5. Contract-level stock visibility & SAPCO consignment balance consistency.
 *   6. Transactional idempotency (200 replay, 409 payload conflict) across documents,
 *      coil issue, coil return, and physical cycle-count reconciliation.
 *   7. 4-Way inventory reconciliation, physical cycle-count adjustments (701/702, zero-variance
 *      no-op, reserved+QC-hold floor block 409), chronological ledger running balance, and
 *      UTF-8 BOM CSV export with formula-injection neutralization.
 *
 * Run with: DATABASE_URL="" npx tsx scripts/test-kpims-p5-warehouse-inventory.ts
 * =========================================================================
 */

import assert from 'node:assert/strict';
import express from 'express';
import { apiRouter } from '../src/server/apiRouter';
import {
  classifyMaterialFamily,
  isSheetMetalCoilLine,
} from '../src/utils/materialClassification';
import {
  computeInventoryReconciliationReport,
  buildCycleCountAdjustmentPlan,
} from '../src/server/inventoryReconciliationService';
import type {
  DetailedStockBalance,
  Part,
  PhysicalCoil,
  SapcoContract,
  WarehouseDefinition,
} from '../src/types/inventory';

if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '') {
  throw new Error('Refusing to run isolated P5 test suite when DATABASE_URL is configured.');
}

const ADMIN_HEADERS = {
  'Content-Type': 'application/json',
  'x-user-role': 'ADMIN',
  'x-user-id': 'USR-TEST-P5',
  'x-user-name': 'Warehouse Keeper P5',
};

async function httpJson(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: any } = {}
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

// -------------------------------------------------------------------------
// TEST 1: Material Family Classification & Coil Creation Guard
// -------------------------------------------------------------------------
function testMaterialClassificationUnit() {
  assert.equal(
    classifyMaterialFamily({
      category: 'RAW_MATERIAL',
      partCode: 'RAW-ST14-08',
      partName: 'ورق روغنی ST14 ضخامت 0.8',
      unit: 'KG',
      materialGrade: 'ST14',
      thicknessMm: 0.8,
    }),
    'SHEET_METAL'
  );
  assert.equal(
    classifyMaterialFamily({
      category: 'RAW_MATERIAL',
      partCode: 'FAST-BOLT-M8',
      partName: 'پیچ و مهره جوشی M8',
      unit: 'PCS',
    }),
    'FASTENER'
  );
  assert.equal(
    classifyMaterialFamily({
      category: 'RAW_MATERIAL',
      partCode: 'RUB-EPDM-01',
      partName: 'بوش لاستیکی ضد لرزش EPDM',
      unit: 'PCS',
    }),
    'RUBBER'
  );
  assert.equal(
    classifyMaterialFamily({
      category: 'WIP_PART',
      partCode: 'WIP-BRK-01',
      partName: 'قطعه نیمه‌ساخته براکت',
      unit: 'PCS',
    }),
    'WIP'
  );
  assert.equal(
    classifyMaterialFamily({
      category: 'FINISHED_GOOD',
      partCode: 'FG-001',
      partName: 'مجموعه نهایی ضربه‌گیر',
      unit: 'PCS',
    }),
    'FINISHED_GOOD'
  );

  assert.equal(
    isSheetMetalCoilLine(
      { category: 'RAW_MATERIAL', code: 'FAST-BOLT-M8', name: 'پیچ جوشی M8', unit: 'PCS' },
      { partCode: 'FAST-BOLT-M8', unit: 'PCS' }
    ),
    false,
    'Fastener receipt must never be treated as a sheet-metal physical coil'
  );
  assert.equal(
    isSheetMetalCoilLine(
      { category: 'RAW_MATERIAL', code: 'RUB-EPDM-01', name: 'لاستیک EPDM', unit: 'PCS' },
      { partCode: 'RUB-EPDM-01', unit: 'PCS' }
    ),
    false,
    'Rubber receipt must never be treated as a sheet-metal physical coil'
  );
  assert.equal(
    isSheetMetalCoilLine(
      {
        category: 'RAW_MATERIAL',
        code: 'RAW-ST14-08',
        name: 'ورق ST14',
        unit: 'KG',
        materialGrade: 'ST14',
        thicknessMm: 0.8,
      },
      { coilId: 'COIL-X1', unit: 'KG' }
    ),
    true,
    'Sheet-metal coil receipt must be recognized as a physical coil'
  );
}

// -------------------------------------------------------------------------
// TEST 2: Pure 4-Way Reconciliation & Cycle-Count Planner Unit Checks
// -------------------------------------------------------------------------
function testReconciliationAndCycleCountUnit() {
  const parts: Part[] = [
    {
      id: 'PART-U1',
      code: 'FAST-U1',
      name: 'مهره جوشی M10',
      category: 'RAW_MATERIAL',
      unit: 'PCS',
      weightPerUnitKg: 0.02,
      minStock: 100,
    },
  ];
  const warehouses: WarehouseDefinition[] = [
    { id: 'WH-RAW', code: 'WH-RAW', name: 'انبار مواد اولیه', type: 'RAW_MATERIALS', locations: ['R1'] },
  ];
  const balancedRow: DetailedStockBalance = {
    id: 'BAL-1',
    partId: 'PART-U1',
    partCode: 'FAST-U1',
    partName: 'مهره جوشی M10',
    category: 'RAW_MATERIAL',
    unit: 'PCS',
    warehouseId: 'WH-RAW',
    warehouseName: 'انبار مواد اولیه',
    locationCode: 'R1',
    ownership: 'COMPANY_OWNED',
    lotNumber: 'LOT-U1',
    physicalQty: 100,
    unrestrictedQty: 70,
    reservedQty: 40,
    availableQty: 30,
    qualityInspectionQty: 20,
    blockedQty: 10,
    ownedQty: 100,
    supplierOwnedQty: 0,
    qualityBlockedQty: 30,
    physicalKg: 2,
    unrestrictedKg: 1.4,
    reservedKg: 0.8,
    availableKg: 0.6,
    qualityInspectionKg: 0.4,
    blockedKg: 0.2,
    ownedKg: 2,
    supplierOwnedKg: 0,
    qualityBlockedKg: 0.6,
    lastTransactionAt: new Date().toISOString(),
  };

  const okReport = computeInventoryReconciliationReport({
    source: 'IN_MEMORY_LEDGER',
    balances: [balancedRow],
    coils: [],
    coilIssueRecords: [],
    contracts: [],
    reservations: [],
  });
  assert.equal(okReport.overallStatus, 'BALANCED');
  assert.equal(okReport.summary.errorCount, 0);
  assert.equal(okReport.summary.byMaterialFamily.FASTENER.physicalQty, 100);
  assert.equal(okReport.summary.byMaterialFamily.FASTENER.qualityHoldQty, 30);

  // Broken stock equation detection
  const brokenRow: DetailedStockBalance = { ...balancedRow, availableQty: 99 };
  const badReport = computeInventoryReconciliationReport({
    source: 'IN_MEMORY_LEDGER',
    balances: [brokenRow],
    coils: [],
    coilIssueRecords: [],
    contracts: [],
    reservations: [],
  });
  assert.equal(badReport.overallStatus, 'DISCREPANCY');
  assert.ok(badReport.discrepancies.some(d => d.category === 'STOCK_EQUATION'));

  // Cycle-count protected floor (reserved 40 + qualityHold 30 = 70)
  const blockedPlan = buildCycleCountAdjustmentPlan({
    partId: 'PART-U1',
    warehouseId: 'WH-RAW',
    lotNumber: 'LOT-U1',
    countedQty: 65,
    reason: 'شمارش دوره‌ای تست',
    user: { uid: 'U1', displayName: 'تست' },
    balances: [balancedRow],
    parts,
    warehouses,
  });
  assert.equal(blockedPlan.ok, false);
  if (!blockedPlan.ok) assert.equal(blockedPlan.statusCode, 409);

  // Zero-variance no-op
  const noopPlan = buildCycleCountAdjustmentPlan({
    partId: 'PART-U1',
    warehouseId: 'WH-RAW',
    lotNumber: 'LOT-U1',
    countedQty: 100,
    reason: 'شمارش دوره‌ای بدون اختلاف',
    user: { uid: 'U1', displayName: 'تست' },
    balances: [balancedRow],
    parts,
    warehouses,
  });
  assert.equal(noopPlan.ok, true);
  if (noopPlan.ok) assert.equal(noopPlan.noVariance, true);

  // Positive gain -> MvT 701
  const gainPlan = buildCycleCountAdjustmentPlan({
    partId: 'PART-U1',
    warehouseId: 'WH-RAW',
    lotNumber: 'LOT-U1',
    countedQty: 112,
    reason: 'یافتن کارتن اضافه در قفسه R1',
    user: { uid: 'U1', displayName: 'تست' },
    balances: [balancedRow],
    parts,
    warehouses,
  });
  assert.equal(gainPlan.ok, true);
  if (gainPlan.ok && !gainPlan.noVariance) {
    assert.equal(gainPlan.varianceQty, 12);
    assert.equal(gainPlan.adjustmentDocument.movementType, '701');
    assert.equal(gainPlan.adjustmentDocument.documentType, 'ADJUSTMENT');
  }
}

// -------------------------------------------------------------------------
// TEST 3: Full End-to-End HTTP Workflows (Fallback Ledger, Zero Live PG)
// -------------------------------------------------------------------------
async function testEndToEndHttpWorkflows() {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);

  const server = await new Promise<import('http').Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}/api`;

  try {
    // -----------------------------------------------------------------------
    // A. Create Fastener & Rubber parts and inspect existing sheet-metal parts/contracts
    // -----------------------------------------------------------------------
    const initPartsRes = await httpJson(baseUrl, '/parts');
    assert.equal(initPartsRes.status, 200);
    const existingParts: Part[] = initPartsRes.json.data || initPartsRes.json.parts || [];
    const sheetPart = existingParts.find(
      p => p.category === 'RAW_MATERIAL' && (p.unit === 'KG' || Boolean(p.materialGrade))
    );
    assert.ok(sheetPart, 'Expected at least one seeded sheet-metal raw material part');

    const contractsRes = await httpJson(baseUrl, '/inventory/contracts');
    assert.equal(contractsRes.status, 200);
    const contracts: SapcoContract[] = contractsRes.json.data || [];
    const sapcoContract = contracts.find(c => c.ownership === 'SAPCO_SUPPLIER_OWNED') || contracts[0];
    assert.ok(sapcoContract, 'Expected at least one seeded SAPCO contract');

    const fastenerCreate = await httpJson(baseUrl, '/parts', {
      method: 'POST',
      body: {
        code: 'FAST-M10-P5',
        name: 'پیچ و مهره جوشی M10 تست P5',
        category: 'RAW_MATERIAL',
        unit: 'PCS',
        weightPerUnitKg: 0.025,
        minStock: 200,
      },
    });
    assert.equal(fastenerCreate.status, 201, `Fastener creation failed: ${JSON.stringify(fastenerCreate.json)}`);
    const fastenerPart: Part = fastenerCreate.json.data;

    const rubberCreate = await httpJson(baseUrl, '/parts', {
      method: 'POST',
      body: {
        code: 'RUB-EPDM-P5',
        name: 'بوش لاستیکی ضربه‌گیر EPDM تست P5',
        category: 'RAW_MATERIAL',
        unit: 'PCS',
        weightPerUnitKg: 0.08,
        minStock: 100,
      },
    });
    assert.equal(rubberCreate.status, 201, `Rubber creation failed: ${JSON.stringify(rubberCreate.json)}`);
    const rubberPart: Part = rubberCreate.json.data;

    // Record initial coil count so we verify fasteners/rubber never spawn coils
    const coilsBeforeRes = await httpJson(baseUrl, '/inventory/coils');
    const coilsBeforeCount = (coilsBeforeRes.json.data || []).length;

    // -----------------------------------------------------------------------
    // B. Fastener & Rubber Workflows: Receipt (101) -> Issue (261) -> Return (262) -> Transfer (311)
    //    + Idempotency Replay & Conflict + Overdraft Guard
    // -----------------------------------------------------------------------
    const fastReceiptKey = `IDEMP-FAST-REC-${Date.now()}`;
    const fastReceiptPayload = {
      documentType: 'RECEIPT_RAW_MATERIAL',
      warehouseId: 'WH-RAW',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      contractId: sapcoContract.id,
      contractNumber: sapcoContract.contractNumber,
      referenceType: 'PURCHASE_ORDER',
      referenceNumber: 'PO-FAST-P5-01',
      autoPost: true,
      idempotencyKey: fastReceiptKey,
      lines: [
        {
          partId: fastenerPart.id,
          partCode: fastenerPart.code,
          partName: fastenerPart.name,
          quantity: 1000,
          unit: 'PCS',
          quantityKg: 25,
          lotNumber: 'LOT-FAST-P5-A',
          locationCode: 'FAST-R1',
          ownership: 'SAPCO_SUPPLIER_OWNED',
          contractId: sapcoContract.id,
          contractNumber: sapcoContract.contractNumber,
          qualityStatus: 'AVAILABLE',
        },
      ],
    };

    const fastRec1 = await httpJson(baseUrl, '/inventory/documents', {
      method: 'POST',
      headers: { 'Idempotency-Key': fastReceiptKey },
      body: fastReceiptPayload,
    });
    assert.equal(fastRec1.status, 201, `Fastener receipt failed: ${JSON.stringify(fastRec1.json)}`);

    // Replay same Idempotency-Key -> 200 idempotentReplay: true (must NOT double stock)
    const fastRecReplay = await httpJson(baseUrl, '/inventory/documents', {
      method: 'POST',
      headers: { 'Idempotency-Key': fastReceiptKey },
      body: fastReceiptPayload,
    });
    assert.equal(fastRecReplay.status, 200);
    assert.equal(fastRecReplay.json.idempotentReplay, true);

    // Same Idempotency-Key with modified quantity -> 409 conflict
    const fastRecConflict = await httpJson(baseUrl, '/inventory/documents', {
      method: 'POST',
      headers: { 'Idempotency-Key': fastReceiptKey },
      body: {
        ...fastReceiptPayload,
        lines: [{ ...fastReceiptPayload.lines[0], quantity: 1500 }],
      },
    });
    assert.equal(fastRecConflict.status, 409);

    // Rubber receipt (with formula-injection-like audit note to test CSV neutralization later)
    const rubReceipt = await httpJson(baseUrl, '/inventory/documents', {
      method: 'POST',
      headers: { 'Idempotency-Key': `IDEMP-RUB-REC-${Date.now()}` },
      body: {
        documentType: 'RECEIPT_RAW_MATERIAL',
        warehouseId: 'WH-RAW',
        ownership: 'COMPANY_OWNED',
        referenceType: 'PURCHASE_ORDER',
        referenceNumber: '=SUM(A1:A5)',
        autoPost: true,
        lines: [
          {
            partId: rubberPart.id,
            partCode: rubberPart.code,
            partName: rubberPart.name,
            quantity: 400,
            unit: 'PCS',
            quantityKg: 32,
            lotNumber: 'LOT-RUB-P5-A',
            locationCode: 'RUB-R1',
            ownership: 'COMPANY_OWNED',
            qualityStatus: 'AVAILABLE',
          },
        ],
      },
    });
    assert.equal(rubReceipt.status, 201);

    // Verify ZERO fake PhysicalCoils were created for fastener & rubber receipts
    const coilsAfterFastRub = await httpJson(baseUrl, '/inventory/coils');
    assert.equal(
      (coilsAfterFastRub.json.data || []).length,
      coilsBeforeCount,
      'Fastener and rubber receipts must not create PhysicalCoil entries'
    );

    // Unknown documentType must be rejected with 400 (no silent zero-impact posting)
    const invalidDocTypeRes = await httpJson(baseUrl, '/inventory/documents', {
      method: 'POST',
      body: {
        documentType: 'UNKNOWN_DOC_TYPE',
        warehouseId: 'WH-RAW',
        ownership: 'COMPANY_OWNED',
        autoPost: true,
        lines: [
          {
            partId: fastenerPart.id,
            partCode: fastenerPart.code,
            partName: fastenerPart.name,
            quantity: 10,
            unit: 'PCS',
            quantityKg: 0.25,
          },
        ],
      },
    });
    assert.equal(invalidDocTypeRes.status, 400, 'Unknown documentType must return 400');

    // Issue 300 fasteners to production (MvT 261)
    const fastIssue = await httpJson(baseUrl, '/inventory/documents', {
      method: 'POST',
      headers: { 'Idempotency-Key': `IDEMP-FAST-ISS-${Date.now()}` },
      body: {
        documentType: 'ISSUE_RAW_MATERIAL',
        movementType: '261',
        warehouseId: 'WH-RAW',
        ownership: 'SAPCO_SUPPLIER_OWNED',
        contractId: sapcoContract.id,
        contractNumber: sapcoContract.contractNumber,
        referenceType: 'MANUFACTURING_ORDER',
        referenceNumber: 'MO-P5-FAST-01',
        autoPost: true,
        lines: [
          {
            partId: fastenerPart.id,
            partCode: fastenerPart.code,
            partName: fastenerPart.name,
            quantity: 300,
            unit: 'PCS',
            quantityKg: 7.5,
            lotNumber: 'LOT-FAST-P5-A',
            locationCode: 'FAST-R1',
            ownership: 'SAPCO_SUPPLIER_OWNED',
            contractId: sapcoContract.id,
            contractNumber: sapcoContract.contractNumber,
            qualityStatus: 'AVAILABLE',
          },
        ],
      },
    });
    assert.equal(fastIssue.status, 201);

    // Return 50 unused fasteners from production (MvT 262) -> net stock should be 1000 - 300 + 50 = 750
    const fastReturn = await httpJson(baseUrl, '/inventory/documents', {
      method: 'POST',
      headers: { 'Idempotency-Key': `IDEMP-FAST-RET-${Date.now()}` },
      body: {
        documentType: 'RECEIPT_RAW_MATERIAL',
        movementType: '262',
        warehouseId: 'WH-RAW',
        ownership: 'SAPCO_SUPPLIER_OWNED',
        contractId: sapcoContract.id,
        contractNumber: sapcoContract.contractNumber,
        referenceType: 'PRODUCTION_RETURN',
        referenceNumber: 'MO-P5-FAST-01',
        autoPost: true,
        lines: [
          {
            partId: fastenerPart.id,
            partCode: fastenerPart.code,
            partName: fastenerPart.name,
            quantity: 50,
            unit: 'PCS',
            quantityKg: 1.25,
            lotNumber: 'LOT-FAST-P5-A',
            locationCode: 'FAST-R1',
            ownership: 'SAPCO_SUPPLIER_OWNED',
            contractId: sapcoContract.id,
            contractNumber: sapcoContract.contractNumber,
            qualityStatus: 'AVAILABLE',
          },
        ],
      },
    });
    assert.equal(fastReturn.status, 201);

    // Inter-warehouse Transfer (311) of 200 SAPCO-owned fasteners from WH-RAW -> WH-WIP
    // Must preserve SAPCO_SUPPLIER_OWNED + contractNumber at destination!
    const fastTransfer = await httpJson(baseUrl, '/inventory/documents', {
      method: 'POST',
      headers: { 'Idempotency-Key': `IDEMP-FAST-TRF-${Date.now()}` },
      body: {
        documentType: 'TRANSFER',
        movementType: '311',
        warehouseId: 'WH-RAW',
        targetWarehouseId: 'WH-WIP',
        ownership: 'SAPCO_SUPPLIER_OWNED',
        contractId: sapcoContract.id,
        contractNumber: sapcoContract.contractNumber,
        referenceType: 'INTERNAL_TRANSFER',
        referenceNumber: 'TRF-FAST-P5-01',
        autoPost: true,
        lines: [
          {
            partId: fastenerPart.id,
            partCode: fastenerPart.code,
            partName: fastenerPart.name,
            quantity: 200,
            unit: 'PCS',
            quantityKg: 5,
            lotNumber: 'LOT-FAST-P5-A',
            locationCode: 'FAST-R1',
            ownership: 'SAPCO_SUPPLIER_OWNED',
            contractId: sapcoContract.id,
            contractNumber: sapcoContract.contractNumber,
            qualityStatus: 'AVAILABLE',
          },
        ],
      },
    });
    assert.equal(fastTransfer.status, 201);

    // Verify fastener balances across WH-RAW (550) & WH-WIP (200) and ownership preservation
    const fastStockRes = await httpJson(
      baseUrl,
      `/inventory/stock-inquiry?materialFamily=FASTENER&contractNumber=${encodeURIComponent(sapcoContract.contractNumber)}`
    );
    assert.equal(fastStockRes.status, 200);
    const fastRows: DetailedStockBalance[] = fastStockRes.json.data || [];
    const rawFast = fastRows.find(b => b.partId === fastenerPart.id && b.warehouseId === 'WH-RAW');
    const wipFast = fastRows.find(b => b.partId === fastenerPart.id && b.warehouseId === 'WH-WIP');
    assert.ok(rawFast && wipFast, 'Expected fastener balances in both WH-RAW and WH-WIP');
    assert.equal(rawFast.physicalQty, 550);
    assert.equal(wipFast.physicalQty, 200);
    assert.equal(wipFast.ownership, 'SAPCO_SUPPLIER_OWNED');
    assert.equal(wipFast.contractNumber, sapcoContract.contractNumber);

    // Overdraft attempt on rubber (only 400 available, try issuing 900) -> blocked (400)
    const rubOverdraft = await httpJson(baseUrl, '/inventory/documents', {
      method: 'POST',
      body: {
        documentType: 'ISSUE_RAW_MATERIAL',
        warehouseId: 'WH-RAW',
        ownership: 'COMPANY_OWNED',
        autoPost: true,
        lines: [
          {
            partId: rubberPart.id,
            partCode: rubberPart.code,
            partName: rubberPart.name,
            quantity: 900,
            unit: 'PCS',
            quantityKg: 72,
            lotNumber: 'LOT-RUB-P5-A',
            locationCode: 'RUB-R1',
            ownership: 'COMPANY_OWNED',
            qualityStatus: 'AVAILABLE',
          },
        ],
      },
    });
    assert.equal(rubOverdraft.status, 400, 'Overdraft issue must be blocked with 400');

    // -----------------------------------------------------------------------
    // C. Physical Coil Lifecycle: Register -> Partial Issue -> Remnant Return (+Idempotency & Over-Return 409)
    //    -> Transfer Coil -> Whole-Roll Issue on Second Coil (CONSUMED / 0 kg)
    // -----------------------------------------------------------------------
    const uniqueSuffix = Date.now().toString().slice(-5);
    const coilARes = await httpJson(baseUrl, '/inventory/coils', {
      method: 'POST',
      body: {
        coilId: `COIL-P5-A-${uniqueSuffix}`,
        coilPackNumber: `CP-P5-${uniqueSuffix}`,
        partId: sheetPart.id,
        partCode: sheetPart.code,
        partName: sheetPart.name,
        materialGrade: 'ST14-P5',
        heatNumber: `HEAT-P5-${uniqueSuffix}`,
        thicknessMm: 1.25,
        widthMm: 1000,
        originalWeightKg: 2000,
        warehouseId: 'WH-RAW',
        warehouseLocationCode: 'COIL-BAY-P5',
        ownership: 'SAPCO_SUPPLIER_OWNED',
        qualityStatus: 'AVAILABLE',
        supplierName: 'فولاد مبارکه تست P5',
        allocations: [
          {
            contractId: sapcoContract.id,
            contractNumber: sapcoContract.contractNumber,
            allocatedWeightKg: 2000,
            ownership: 'SAPCO_SUPPLIER_OWNED',
          },
        ],
      },
    });
    assert.equal(coilARes.status, 201, `Coil A creation failed: ${JSON.stringify(coilARes.json)}`);
    const coilA: PhysicalCoil = coilARes.json.data;

    // Partial-roll issue: 800 kg out of 2000 kg -> 1200 kg remaining, PARTIALLY_ISSUED
    const coilIssueKey = `IDEMP-COIL-ISS-${uniqueSuffix}`;
    const coilIssuePayload = {
      issuedWeightKg: 800,
      manufacturingOrderId: 'MO-P5-COIL-01',
      notes: 'حواله جزئی کلاف به خط پرس P5',
      user: { uid: 'USR-TEST-P5', displayName: 'انباردار تست P5' },
    };
    const coilIssue1 = await httpJson(baseUrl, `/inventory/coils/${coilA.id}/issue`, {
      method: 'POST',
      headers: { 'Idempotency-Key': coilIssueKey },
      body: coilIssuePayload,
    });
    assert.equal(coilIssue1.status, 200, `Coil partial issue failed: ${JSON.stringify(coilIssue1.json)}`);
    assert.equal(coilIssue1.json.success, true);
    assert.equal(coilIssue1.json.coil.remainingWeightKg, 1200);
    assert.equal(coilIssue1.json.coil.physicalStatus, 'PARTIALLY_ISSUED');

    // Duplicate coil issue replay -> 200 idempotentReplay: true, remaining STILL 1200
    const coilIssueReplay = await httpJson(baseUrl, `/inventory/coils/${coilA.id}/issue`, {
      method: 'POST',
      headers: { 'Idempotency-Key': coilIssueKey },
      body: coilIssuePayload,
    });
    assert.equal(coilIssueReplay.status, 200);
    assert.equal(coilIssueReplay.json.idempotentReplay, true);
    assert.equal(coilIssueReplay.json.coil.remainingWeightKg, 1200);

    // Over-return attempt: issued 800, try returning 850 -> 409 blocked
    const coilOverReturn = await httpJson(baseUrl, `/inventory/coils/${coilA.id}/return`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `IDEMP-OVER-RET-${uniqueSuffix}` },
      body: {
        returnedWeightKg: 850,
        targetWarehouseId: 'WH-RAW',
        notes: 'تلاش برگشت بیش از حد مجاز',
      },
    });
    assert.equal(coilOverReturn.status, 409, 'Over-return exceeding net issued weight must return 409');

    // Valid remnant return: 300 kg returned + 10 kg variance (trim/scale tolerance) -> remaining = 1500 kg
    const coilReturnKey = `IDEMP-COIL-RET-${uniqueSuffix}`;
    const coilReturnPayload = {
      returnedWeightKg: 300,
      varianceWeightKg: 10,
      targetWarehouseId: 'WH-RAW',
      notes: 'برگشت ته‌کلاف از خط پرس P5',
      user: { uid: 'USR-TEST-P5', displayName: 'انباردار تست P5' },
    };
    const coilRet1 = await httpJson(baseUrl, `/inventory/coils/${coilA.id}/return`, {
      method: 'POST',
      headers: { 'Idempotency-Key': coilReturnKey },
      body: coilReturnPayload,
    });
    assert.equal(coilRet1.status, 200, `Coil remnant return failed: ${JSON.stringify(coilRet1.json)}`);
    assert.equal(coilRet1.json.success, true);
    assert.equal(coilRet1.json.coil.remainingWeightKg, 1500);
    assert.equal(coilRet1.json.coil.physicalStatus, 'PARTIALLY_ISSUED');

    // Replay same return idempotency key -> 200 idempotentReplay: true, remaining STILL 1500
    const coilRetReplay = await httpJson(baseUrl, `/inventory/coils/${coilA.id}/return`, {
      method: 'POST',
      headers: { 'Idempotency-Key': coilReturnKey },
      body: coilReturnPayload,
    });
    assert.equal(coilRetReplay.status, 200);
    assert.equal(coilRetReplay.json.idempotentReplay, true);

    // Conflict on return idempotency key with different weight -> 409
    const coilRetConflict = await httpJson(baseUrl, `/inventory/coils/${coilA.id}/return`, {
      method: 'POST',
      headers: { 'Idempotency-Key': coilReturnKey },
      body: { ...coilReturnPayload, returnedWeightKg: 250 },
    });
    assert.equal(coilRetConflict.status, 409);

    // Inter-warehouse transfer of remaining 1500 kg of Coil A from WH-RAW -> WH-WIP
    const coilTransfer = await httpJson(baseUrl, '/inventory/documents', {
      method: 'POST',
      headers: { 'Idempotency-Key': `IDEMP-COIL-TRF-${uniqueSuffix}` },
      body: {
        documentType: 'TRANSFER',
        movementType: '311',
        warehouseId: 'WH-RAW',
        targetWarehouseId: 'WH-WIP',
        ownership: 'SAPCO_SUPPLIER_OWNED',
        contractId: sapcoContract.id,
        contractNumber: sapcoContract.contractNumber,
        autoPost: true,
        lines: [
          {
            partId: sheetPart.id,
            partCode: sheetPart.code,
            partName: sheetPart.name,
            physicalCoilId: coilA.id,
            coilId: coilA.coilId,
            coilPackNumber: coilA.coilPackNumber,
            lotNumber: coilA.coilId,
            heatNumber: coilA.heatNumber,
            locationCode: 'COIL-BAY-P5',
            quantity: 1500,
            unit: 'KG',
            quantityKg: 1500,
            ownership: 'SAPCO_SUPPLIER_OWNED',
            contractId: sapcoContract.id,
            contractNumber: sapcoContract.contractNumber,
            qualityStatus: 'AVAILABLE',
          },
        ],
      },
    });
    assert.equal(coilTransfer.status, 201, `Coil transfer failed: ${JSON.stringify(coilTransfer.json)}`);

    // Verify Coil A now resides in WH-WIP via multi-filter /api/inventory/coils
    const coilFilterRes = await httpJson(
      baseUrl,
      `/inventory/coils?materialGrade=ST14-P5&thicknessMm=1.25&coilPackNumber=${encodeURIComponent(
        coilA.coilPackNumber
      )}&warehouseId=WH-WIP&contractNumber=${encodeURIComponent(sapcoContract.contractNumber)}`
    );
    assert.equal(coilFilterRes.status, 200);
    assert.equal((coilFilterRes.json.data || []).length, 1);
    assert.equal(coilFilterRes.json.data[0].warehouseId, 'WH-WIP');
    assert.equal(coilFilterRes.json.data[0].remainingWeightKg, 1500);

    // Whole-roll issue on Coil B -> remaining = 0, physicalStatus = CONSUMED
    const coilBRes = await httpJson(baseUrl, '/inventory/coils', {
      method: 'POST',
      body: {
        coilId: `COIL-P5-B-${uniqueSuffix}`,
        coilPackNumber: `CP-P5-B-${uniqueSuffix}`,
        partId: sheetPart.id,
        partCode: sheetPart.code,
        partName: sheetPart.name,
        materialGrade: 'ST14-P5',
        heatNumber: `HEAT-P5-B-${uniqueSuffix}`,
        thicknessMm: 1.25,
        widthMm: 1000,
        originalWeightKg: 1200,
        warehouseId: 'WH-RAW',
        warehouseLocationCode: 'COIL-BAY-P5',
        ownership: 'COMPANY_OWNED',
        qualityStatus: 'AVAILABLE',
      },
    });
    assert.equal(coilBRes.status, 201);
    const coilB: PhysicalCoil = coilBRes.json.data;

    const wholeIssue = await httpJson(baseUrl, `/inventory/coils/${coilB.id}/issue`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `IDEMP-WHOLE-ISS-${uniqueSuffix}` },
      body: {
        issuedWeightKg: 1200,
        manufacturingOrderId: 'MO-P5-COIL-WHOLE',
        notes: 'حواله کامل رول ورق P5',
      },
    });
    assert.equal(wholeIssue.status, 200);
    assert.equal(wholeIssue.json.success, true);
    assert.equal(wholeIssue.json.coil.remainingWeightKg, 0);
    assert.equal(wholeIssue.json.coil.physicalStatus, 'CONSUMED');

    // -----------------------------------------------------------------------
    // D. Sheet-Metal Multi-Filter Stock Inquiry & Stock Status Views
    //    (Available / Reserved / Quality-Hold / Total) + Contract Visibility
    // -----------------------------------------------------------------------
    const sheetInquiry = await httpJson(
      baseUrl,
      `/inventory/stock-inquiry?materialFamily=SHEET_METAL&warehouseId=WH-WIP&coilPackNumber=${encodeURIComponent(
        coilA.coilId
      )}&contractNumber=${encodeURIComponent(sapcoContract.contractNumber)}`
    );
    assert.equal(sheetInquiry.status, 200);
    const sheetRows: DetailedStockBalance[] = sheetInquiry.json.data || [];
    assert.ok(sheetRows.length >= 1, 'Expected sheet-metal stock row for transferred coilA');
    assert.equal(sheetRows[0].physicalQty, 1500);
    assert.equal(sheetRows[0].availableQty, 1500);
    assert.ok(sheetInquiry.json.summary, 'Expected stock-inquiry summary totals');
    assert.ok(
      Array.isArray(sheetInquiry.json.summary.byContract) &&
        sheetInquiry.json.summary.byContract.some(
          (c: any) => c.contractNumber === sapcoContract.contractNumber
        ),
      'Expected contract-level breakdown in stock-inquiry summary'
    );

    // Move 100 pcs of rubber into QUALITY_INSPECTION (MvT 322) to verify Quality-Hold visibility & cycle-count floor
    const qmHoldRes = await httpJson(baseUrl, '/inventory/documents', {
      method: 'POST',
      headers: { 'Idempotency-Key': `IDEMP-RUB-QM-${uniqueSuffix}` },
      body: {
        documentType: 'STOCK_STATUS_TRANSFER',
        movementType: '322',
        qmStatusTarget: 'QUALITY_INSPECTION',
        warehouseId: 'WH-RAW',
        ownership: 'COMPANY_OWNED',
        autoPost: true,
        lines: [
          {
            partId: rubberPart.id,
            partCode: rubberPart.code,
            partName: rubberPart.name,
            quantity: 100,
            unit: 'PCS',
            quantityKg: 8,
            lotNumber: 'LOT-RUB-P5-A',
            locationCode: 'RUB-R1',
            ownership: 'COMPANY_OWNED',
            qualityStatus: 'QUALITY_INSPECTION',
          },
        ],
      },
    });
    assert.equal(qmHoldRes.status, 201, `QM hold transfer failed: ${JSON.stringify(qmHoldRes.json)}`);

    const qhInquiry = await httpJson(
      baseUrl,
      `/inventory/stock-inquiry?materialFamily=RUBBER&stockStatus=QUALITY_HOLD`
    );
    assert.equal(qhInquiry.status, 200);
    const rubQhRow = (qhInquiry.json.data || []).find((b: any) => b.partId === rubberPart.id);
    assert.ok(rubQhRow, 'Rubber row with quality hold must appear under stockStatus=QUALITY_HOLD');
    assert.equal(rubQhRow.physicalQty, 400);
    assert.equal(rubQhRow.unrestrictedQty, 300);
    assert.equal(rubQhRow.qualityInspectionQty, 100);
    assert.equal(rubQhRow.availableQty, 300);

    // -----------------------------------------------------------------------
    // E. Physical Cycle-Count Reconciliation & 4-Way Reconciliation Report
    // -----------------------------------------------------------------------
    // 1. Floor violation: rubber has 100 in QI, try counting 80 -> 409 blocked
    const cycleFloorBlocked = await httpJson(baseUrl, '/inventory/reconciliation/count', {
      method: 'POST',
      headers: { 'Idempotency-Key': `IDEMP-CC-FLOOR-${uniqueSuffix}` },
      body: {
        partId: rubberPart.id,
        warehouseId: 'WH-RAW',
        lotNumber: 'LOT-RUB-P5-A',
        countedQty: 80,
        reason: 'شمارش کمتر از قرنطینه کیفی',
      },
    });
    assert.equal(cycleFloorBlocked.status, 409, 'Cycle count below quality-hold floor must return 409');

    // 2. Zero-variance count (400 == 400) -> 200 noVariance: true
    const cycleNoop = await httpJson(baseUrl, '/inventory/reconciliation/count', {
      method: 'POST',
      headers: { 'Idempotency-Key': `IDEMP-CC-NOOP-${uniqueSuffix}` },
      body: {
        partId: rubberPart.id,
        warehouseId: 'WH-RAW',
        lotNumber: 'LOT-RUB-P5-A',
        countedQty: 400,
        reason: 'شمارش دوره‌ای بدون اختلاف',
      },
    });
    assert.equal(cycleNoop.status, 200);
    assert.equal(cycleNoop.json.noVariance, true);

    // 3. Real variance count (400 -> 392 => -8 pcs MvT 702) + idempotency replay & conflict
    const cycleAdjKey = `IDEMP-CC-ADJ-${uniqueSuffix}`;
    const cycleAdjPayload = {
      partId: rubberPart.id,
      warehouseId: 'WH-RAW',
      lotNumber: 'LOT-RUB-P5-A',
      countedQty: 392,
      reason: 'کسری ۸ عددی در انبارگردانی ماهانه',
      referenceNumber: `CC-P5-${uniqueSuffix}`,
    };
    const cycleAdj1 = await httpJson(baseUrl, '/inventory/reconciliation/count', {
      method: 'POST',
      headers: { 'Idempotency-Key': cycleAdjKey },
      body: cycleAdjPayload,
    });
    assert.equal(cycleAdj1.status, 201, `Cycle count adjustment failed: ${JSON.stringify(cycleAdj1.json)}`);
    assert.equal(cycleAdj1.json.varianceQty, -8);
    assert.equal(cycleAdj1.json.data.movementType, '702');

    // Replay same cycle-count key -> 200 idempotentReplay: true (must NOT treat as noVariance!)
    const cycleAdjReplay = await httpJson(baseUrl, '/inventory/reconciliation/count', {
      method: 'POST',
      headers: { 'Idempotency-Key': cycleAdjKey },
      body: cycleAdjPayload,
    });
    assert.equal(cycleAdjReplay.status, 200);
    assert.equal(cycleAdjReplay.json.idempotentReplay, true);

    // Conflict same cycle-count key with different countedQty -> 409
    const cycleAdjConflict = await httpJson(baseUrl, '/inventory/reconciliation/count', {
      method: 'POST',
      headers: { 'Idempotency-Key': cycleAdjKey },
      body: { ...cycleAdjPayload, countedQty: 390 },
    });
    assert.equal(cycleAdjConflict.status, 409);

    // 4-Way Reconciliation Report after all operations
    const reconRes = await httpJson(baseUrl, '/inventory/reconciliation');
    assert.equal(reconRes.status, 200, `Reconciliation failed: ${JSON.stringify(reconRes.json)}`);
    const recon = reconRes.json.data;
    assert.equal(recon.summary.errorCount, 0, `Unexpected reconciliation errors: ${JSON.stringify(recon.discrepancies)}`);
    assert.ok(recon.checks.every((c: any) => c.status !== 'FAIL'));
    assert.ok(recon.summary.byMaterialFamily.SHEET_METAL.rowCount > 0);
    assert.ok(recon.summary.byMaterialFamily.FASTENER.physicalQty >= 750);
    assert.ok(recon.summary.byMaterialFamily.RUBBER.physicalQty >= 392);

    // SAPCO Account Endpoint Consistency
    const sapcoRes = await httpJson(baseUrl, '/inventory/sapco-account');
    assert.equal(sapcoRes.status, 200);
    assert.ok(Array.isArray(sapcoRes.json.contracts) && sapcoRes.json.contracts.length > 0);

    // -----------------------------------------------------------------------
    // F. Stock Movement History (Running Balance + Filters + CSV BOM/Sanitization)
    //    & Material Traceability (Coil Genealogy + Document Flow)
    // -----------------------------------------------------------------------
    const ledgerRes = await httpJson(
      baseUrl,
      `/inventory/ledger?partId=${encodeURIComponent(rubberPart.id)}&warehouseId=WH-RAW`
    );
    assert.equal(ledgerRes.status, 200);
    const ledgerEntries = ledgerRes.json.data || [];
    assert.ok(ledgerEntries.length >= 2, 'Expected receipt and adjustment entries in rubber ledger');
    assert.ok(
      ledgerEntries.every((e: any) => typeof e.runningBalanceQty === 'number'),
      'Expected chronological runningBalanceQty on every ledger row'
    );

    // CSV Export: verify UTF-8 BOM bytes [0xEF, 0xBB, 0xBF] and formula neutralization ('=SUM...)
    const csvHttpRes = await fetch(
      `${baseUrl}/inventory/ledger?partId=${encodeURIComponent(rubberPart.id)}&format=csv`,
      { headers: { 'x-user-role': 'ADMIN' } }
    );
    assert.equal(csvHttpRes.status, 200);
    const csvBuf = Buffer.from(await csvHttpRes.arrayBuffer());
    assert.equal(csvBuf[0], 0xef, 'CSV must begin with UTF-8 BOM byte 0xEF');
    assert.equal(csvBuf[1], 0xbb, 'CSV must begin with UTF-8 BOM byte 0xBB');
    assert.equal(csvBuf[2], 0xbf, 'CSV must begin with UTF-8 BOM byte 0xBF');
    const csvText = csvBuf.slice(3).toString('utf8');
    assert.ok(csvText.includes("'=SUM(A1:A5)"), 'CSV export must neutralize formula injection payloads');

    // Coil Genealogy Traceability
    const genealogyRes = await httpJson(baseUrl, `/inventory/coils/${coilA.id}/genealogy`);
    assert.equal(genealogyRes.status, 200);
    assert.equal(genealogyRes.json.data.metrics.originalWeightKg, 2000);
    assert.equal(genealogyRes.json.data.metrics.remainingWeightKg, 1500);
    assert.equal(genealogyRes.json.data.metrics.totalIssuedKg, 800);
    assert.equal(genealogyRes.json.data.metrics.totalReturnedKg, 300);
    assert.ok(
      genealogyRes.json.data.relatedDocuments.length >= 3,
      'Expected receipt, issue, return, and transfer documents linked in coil genealogy'
    );

    // Document Flow Traceability
    const flowRes = await httpJson(
      baseUrl,
      `/traceability/document-flow?q=${encodeURIComponent(fastenerPart.code)}`
    );
    assert.equal(flowRes.status, 200);
    assert.ok((flowRes.json.nodes || []).length >= 3, 'Expected multi-document chain in document-flow traceability');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function main() {
  testMaterialClassificationUnit();
  console.log('✓ P5 Test 1: Material family classification & non-coil guard passed');

  testReconciliationAndCycleCountUnit();
  console.log('✓ P5 Test 2: 4-way reconciliation & cycle-count planner unit tests passed');

  await testEndToEndHttpWorkflows();
  console.log('✓ P5 Test 3: End-to-end warehouse operations, coil lifecycle, SAPCO contracts, idempotency, cycle-count, CSV ledger & traceability passed');

  console.log('\nALL KPIMS P5 REGRESSION TESTS PASSED.');
}

main().catch(err => {
  console.error('KPIMS P5 TEST SUITE FAILED:', err);
  process.exit(1);
});
