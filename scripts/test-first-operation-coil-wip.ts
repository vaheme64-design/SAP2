import express from 'express';
import { activateTestDatabaseForIntegrationTests } from '../src/server/db/testDatabase';
import { apiRouter, loadInventoryAppState } from '../src/server/apiRouter';
import { createManufacturingOrderDb } from '../src/server/services/productionWipService';
import { INITIAL_PARTS } from '../src/server/sampleData';

const nonce = `TEST-WIP-COIL-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let server: import('node:http').Server | undefined;
let coilId: string | undefined;
let materialLotId: string | undefined;
let testMoId: string | undefined;
let createdOp30LocationId: string | undefined;
const op30LocationCode = 'LOC-WIP-OP30';
const contractIds: string[] = [];

function assert(description: string, condition: boolean) {
  if (!condition) throw new Error(`❌ ${description}`);
  console.log(`✅ ${description}`);
}

async function requestJson(baseUrl: string, path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function run() {
  const { prisma } = await activateTestDatabaseForIntegrationTests();

  const candidateParts = await prisma.part.findMany({
    where: {
      active: true,
      weightNetKg: { gt: 0 },
      unit: { is: { code: 'PCS' } },
      routes: { some: { status: 'ACTIVE', operations: { some: {} } } },
    },
    include: {
      unit: true,
      routes: { where: { status: 'ACTIVE' }, include: { operations: true } },
    },
    orderBy: { partNumber: 'asc' },
  });
  const targetPart = candidateParts.find((p: any) => p.routes.some((r: any) => r.operations.length >= 2));
  if (!targetPart) throw new Error('Active PCS part with >= 2 route operations is required.');
  const targetRoute = targetPart.routes.find((r: any) => r.operations.length >= 2)!;

  const [warehouse, customer, rawParts, wipWarehouse] = await Promise.all([
    prisma.warehouse.findFirst({ where: { code: 'WH-RAW', active: true } }),
    prisma.customer.findFirst({ where: { active: true } }),
    prisma.part.findMany({
      where: { active: true, category: 'RAW_MATERIAL', materialId: { not: null } },
      include: { unit: true, material: true },
    }),
    prisma.warehouse.findFirst({ where: { code: 'WH-WIP-STAMP', active: true } }) ??
      prisma.warehouse.findFirst({ where: { type: 'WIP', active: true } }),
  ]);
  const rawPart = rawParts.find(
    (row: any) =>
      row.unit.code === 'KG' &&
      row.material &&
      INITIAL_PARTS.some((app: any) => app.code === row.partNumber),
  );
  const appPart = rawPart ? INITIAL_PARTS.find((row: any) => row.code === rawPart.partNumber) : undefined;
  if (!warehouse || !customer || !rawPart?.material || !appPart || !wipWarehouse) {
    throw new Error('Test requires WH-RAW, a customer, a mapped KG raw-material part, and an active WIP warehouse.');
  }

  try {
    const existingOp30 = await prisma.warehouseLocation.findFirst({
      where: { code: op30LocationCode, active: true },
    });
    if (!existingOp30) {
      const op30Loc = await prisma.warehouseLocation.create({
        data: {
          warehouseId: wipWarehouse.id,
          code: op30LocationCode,
          aisle: 'P',
          rack: 'TRIM',
          bin: 'T-30',
          maxCapacityKg: 10000,
          active: true,
        },
      });
      createdOp30LocationId = op30Loc.id;
    }

    await loadInventoryAppState();

    const moDto = await createManufacturingOrderDb({
      partId: targetPart.id,
      routingId: targetRoute.id,
      targetQuantity: 50,
      initialInputQuantity: 0,
      notes: 'CI first-operation coil issue relational fixture',
      createdBy: 'CI',
    });
    testMoId = moDto.id;

    const relationalOrder = await prisma.manufacturingOrder.findUnique({
      where: { id: testMoId },
      include: {
        part: { include: { unit: true } },
        operations: {
          include: { operation: true, location: true },
          orderBy: [{ sequence: 'asc' }, { stepNumber: 'asc' }],
        },
      },
    });
    if (!relationalOrder || relationalOrder.operations.length < 2) {
      throw new Error('Test MO must have at least two relational operations.');
    }
    const operation10 = relationalOrder.operations[0];
    const sourceLocation = operation10.location;
    if (!sourceLocation) throw new Error('Operation 10 requires an assigned relational location.');

    const contractA = await prisma.materialContract.create({
      data: {
        contractNumber: `${nonce}-A`,
        supplierCustomerId: customer.id,
        title: 'CI WIP coil issue contract A',
        materialId: rawPart.materialId!,
        totalAllocatedWeightKg: 60,
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 86400000),
      },
    });
    contractIds.push(contractA.id);
    const contractB = await prisma.materialContract.create({
      data: {
        contractNumber: `${nonce}-B`,
        supplierCustomerId: customer.id,
        title: 'CI WIP coil issue contract B',
        materialId: rawPart.materialId!,
        totalAllocatedWeightKg: 40,
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 86400000),
      },
    });
    contractIds.push(contractB.id);

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api', apiRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server!.once('listening', resolve);
      server!.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('HTTP test server did not bind.');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const receipt = await requestJson(baseUrl, '/api/inventory/coils', 'POST', {
      coilId: `${nonce}-COIL`,
      coilPackNumber: `${nonce}-PACK`,
      partId: appPart.id,
      partCode: appPart.code,
      partName: appPart.name,
      materialGrade: rawPart.material.grade,
      thicknessMm: Number(rawPart.thicknessMm || 1),
      widthMm: 1000,
      originalWeightKg: 100,
      remainingWeightKg: 100,
      warehouseId: 'WH-RAW',
      warehouseLocationCode: 'LOC-RAW-A1',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      qualityStatus: 'AVAILABLE',
      physicalStatus: 'AVAILABLE',
      allocations: [],
    });
    assert('HTTP receipt creates the test physical coil', receipt.response.status === 201 && !!receipt.payload.data?.id);
    coilId = receipt.payload.data.id;
    materialLotId = (await prisma.physicalCoil.findUnique({ where: { id: coilId } }))?.materialLotId || undefined;
    if (!materialLotId) throw new Error('Test coil receipt did not create a material lot.');

    const allocation = await requestJson(baseUrl, `/api/inventory/coils/${coilId}/allocate`, 'POST', {
      allocations: [
        { contractId: contractA.id, contractNumber: contractA.contractNumber, allocatedWeightKg: 60 },
        { contractId: contractB.id, contractNumber: contractB.contractNumber, allocatedWeightKg: 40 },
      ],
    });
    assert('One physical coil can be allocated across two contracts', allocation.response.status === 200 && allocation.payload.success === true);

    const issuePayload = {
      issueRequestKey: `${nonce}-ISSUE-REQUEST-1`,
      issuedWeightKg: 70,
      moId: relationalOrder.moNumber,
      moOperationId: operation10.id,
      partId: relationalOrder.partId,
      scrappedKg: 0,
      initialInputQuantityPcs: 15,
      wipManufacturingOrderId: relationalOrder.id,
    };
    const issue = await requestJson(baseUrl, `/api/inventory/coils/${coilId}/issue`, 'POST', issuePayload);
    assert(
      `Coil issue and operator-confirmed 15 PCS WIP input post successfully: HTTP ${issue.response.status}`,
      issue.response.status === 200 && issue.payload.success === true && issue.payload.duplicate !== true,
    );

    const coilListAfterIssue = await requestJson(baseUrl, `/api/inventory/coils?search=${encodeURIComponent(nonce)}`);
    const listedCoilAfterIssue = coilListAfterIssue.payload.data?.find((row: any) => row.id === coilId);
    assert(
      'Coil inventory inquiry reads the committed 30 kg balance from PostgreSQL',
      coilListAfterIssue.response.status === 200 && Number(listedCoilAfterIssue?.remainingWeightKg) === 30,
    );

    const duplicateIssue = await requestJson(baseUrl, `/api/inventory/coils/${coilId}/issue`, 'POST', issuePayload);
    const coilAfterDuplicate = await prisma.physicalCoil.findUnique({ where: { id: coilId } });
    const wipQtyAfterDuplicate = Number(
      (
        await prisma.stockBalance.aggregate({
          where: { physicalCoilId: coilId, partId: relationalOrder.partId },
          _sum: { quantityOnHand: true },
        })
      )._sum.quantityOnHand,
    );
    assert(
      'Retrying the same issue request returns the original document without a second stock deduction or WIP posting',
      duplicateIssue.response.status === 200 &&
        duplicateIssue.payload.duplicate === true &&
        duplicateIssue.payload.documentNumber === issue.payload.documentNumber &&
        Number(coilAfterDuplicate?.remainingWeightKg) === 30 &&
        wipQtyAfterDuplicate === 15,
    );

    const changedPayload = { ...issuePayload, issuedWeightKg: 71 };
    const conflictingRetry = await requestJson(baseUrl, `/api/inventory/coils/${coilId}/issue`, 'POST', changedPayload);
    const coilAfterConflict = await prisma.physicalCoil.findUnique({ where: { id: coilId } });
    assert(
      'Reusing an idempotency key with a changed payload is rejected without changing stock',
      conflictingRetry.response.status === 409 && Number(coilAfterConflict?.remainingWeightKg) === 30,
    );

    const [coilAfterIssue, lotAfterIssue, rawBalances, wipBalances, wipTransactions, moAfterIssue, opAfterIssue, apiMoRes] =
      await Promise.all([
        prisma.physicalCoil.findUnique({ where: { id: coilId } }),
        prisma.materialLot.findUnique({ where: { id: materialLotId } }),
        prisma.stockBalance.findMany({ where: { physicalCoilId: coilId, partId: rawPart.id, qualityStatus: 'AVAILABLE' } }),
        prisma.stockBalance.findMany({ where: { physicalCoilId: coilId, partId: relationalOrder.partId, qualityStatus: 'AVAILABLE' } }),
        prisma.inventoryTransaction.findMany({ where: { physicalCoilId: coilId, manufacturingOrderId: relationalOrder.id, locationId: sourceLocation.id } }),
        prisma.manufacturingOrder.findUnique({ where: { id: relationalOrder.id } }),
        prisma.productionOperation.findUnique({ where: { id: operation10.id } }),
        requestJson(baseUrl, `/api/wip/manufacturing-orders/${encodeURIComponent(relationalOrder.id)}`),
      ]);
    const rawA = rawBalances.find((row: any) => row.contractId === contractA.id);
    const rawB = rawBalances.find((row: any) => row.contractId === contractB.id);
    const wipA = wipBalances.find((row: any) => row.contractId === contractA.id);
    const wipB = wipBalances.find((row: any) => row.contractId === contractB.id);
    assert(
      'Raw coil remaining weight and material lot both reconcile to 30 kg after a 70 kg issue',
      Number(coilAfterIssue?.remainingWeightKg) === 30 && Number(lotAfterIssue?.remainingWeightKg) === 30,
    );
    assert('Contract A raw stock is fully issued (60 kg)', Number(rawA?.weightKgAvailable) === 0);
    assert('Contract B raw stock decreases from 40 to 30 kg', Number(rawB?.weightKgAvailable) === 30);
    assert('WIP receives 15 PCS split 12/3 across the original contract lineage', Number(wipA?.quantityOnHand) === 12 && Number(wipB?.quantityOnHand) === 3);
    assert(
      'WIP input transactions retain coil, lot, MO and both contract identities',
      wipTransactions.length === 2 &&
        wipTransactions.every((row: any) => row.physicalCoilId === coilId && row.materialLotId === materialLotId) &&
        new Set(wipTransactions.map((row: any) => row.contractId)).size === 2,
    );
    assert(
      'Relational MO and OP10 waitingInputQty increment by 15 and expose via API',
      Number(moAfterIssue?.initialInputQty) === 15 &&
        Number(opAfterIssue?.waitingInputQty) === 15 &&
        opAfterIssue?.status === 'READY' &&
        apiMoRes.response.status === 200 &&
        Number(apiMoRes.payload.data?.initialInputQuantity) === 15 &&
        Number(apiMoRes.payload.data?.operations?.[0]?.waitingInputQty) === 15,
    );

    const returnResult = await requestJson(baseUrl, `/api/inventory/coils/${coilId}/return`, 'POST', {
      returnedRemnantWeightKg: 5,
      warehouseId: 'WH-RAW',
      locationCode: 'LOC-RAW-A1',
      notes: 'CI WIP coil issue remnant return',
    });
    assert('Partial remnant return restores 5 kg to the same physical coil', returnResult.response.status === 200 && returnResult.payload.success === true);
    const [coilAfterReturn, lotAfterReturn, rawAfterReturn] = await Promise.all([
      prisma.physicalCoil.findUnique({ where: { id: coilId } }),
      prisma.materialLot.findUnique({ where: { id: materialLotId } }),
      prisma.stockBalance.findMany({ where: { physicalCoilId: coilId, partId: rawPart.id, qualityStatus: 'AVAILABLE' } }),
    ]);
    assert(
      'Remnant return reconciles coil and lot to 35 kg without changing WIP PCS',
      Number(coilAfterReturn?.remainingWeightKg) === 35 &&
        Number(lotAfterReturn?.remainingWeightKg) === 35 &&
        Number(
          (
            await prisma.stockBalance.aggregate({
              where: { physicalCoilId: coilId, partId: relationalOrder.partId },
              _sum: { quantityOnHand: true },
            })
          )._sum.quantityOnHand,
        ) === 15,
    );
    const coilListAfterReturn = await requestJson(baseUrl, `/api/inventory/coils?search=${encodeURIComponent(nonce)}`);
    const listedCoilAfterReturn = coilListAfterReturn.payload.data?.find((row: any) => row.id === coilId);
    assert(
      'Coil inventory inquiry reads the committed 35 kg remnant balance from PostgreSQL',
      coilListAfterReturn.response.status === 200 && Number(listedCoilAfterReturn?.remainingWeightKg) === 35,
    );
    assert(
      'Returned raw material is available again under its original contract identity',
      rawAfterReturn.some((row: any) => row.contractId === contractA.id || row.contractId === contractB.id),
    );

    await prisma.materialLot.update({ where: { id: materialLotId }, data: { remainingWeightKg: 0 } });
    const beforeRollback = await prisma.physicalCoil.findUnique({ where: { id: coilId } });
    const beforeWipQty = Number(
      (
        await prisma.stockBalance.aggregate({
          where: { physicalCoilId: coilId, partId: relationalOrder.partId },
          _sum: { quantityOnHand: true },
        })
      )._sum.quantityOnHand,
    );
    const failedIssue = await requestJson(baseUrl, `/api/inventory/coils/${coilId}/issue`, 'POST', {
      issueRequestKey: `${nonce}-ROLLBACK-REQUEST-1`,
      issuedWeightKg: 1,
      moId: relationalOrder.moNumber,
      moOperationId: operation10.id,
      partId: relationalOrder.partId,
      scrappedKg: 0,
      initialInputQuantityPcs: 1,
      wipManufacturingOrderId: relationalOrder.id,
    });
    assert('Material-lot mismatch rejects the issue request', failedIssue.response.status === 409 && failedIssue.payload.success === false);
    const [afterRollbackCoil, afterRollbackWip, afterRollbackRaw, failedDocs] = await Promise.all([
      prisma.physicalCoil.findUnique({ where: { id: coilId } }),
      prisma.stockBalance.aggregate({ where: { physicalCoilId: coilId, partId: relationalOrder.partId }, _sum: { quantityOnHand: true } }),
      prisma.stockBalance.aggregate({ where: { physicalCoilId: coilId, partId: rawPart.id }, _sum: { weightKgOnHand: true } }),
      prisma.inventoryDocument.count({ where: { referenceNumber: relationalOrder.moNumber, documentType: 'ISSUE' } }),
    ]);
    assert('Failed issue leaves coil balance unchanged', Number(afterRollbackCoil?.remainingWeightKg) === Number(beforeRollback?.remainingWeightKg));
    assert('Failed issue leaves WIP quantity unchanged', Number(afterRollbackWip._sum.quantityOnHand) === beforeWipQty);
    assert('Failed issue creates no extra issue document or stock movement', failedDocs === 1 && Number(afterRollbackRaw._sum.weightKgOnHand) === 35);

    console.log('ALL FIRST-OPERATION COIL-TO-WIP INTEGRATION TESTS PASSED');
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
    if (coilId) {
      const docs = await prisma.inventoryDocument.findMany({ where: { lines: { some: { physicalCoilId: coilId } } }, select: { id: true } });
      await prisma.inventoryTransaction.deleteMany({ where: { physicalCoilId: coilId } });
      await prisma.inventoryDocumentLine.deleteMany({ where: { physicalCoilId: coilId } });
      await prisma.coilIssueReturnRecord.deleteMany({ where: { coilId } });
      await prisma.stockBalance.deleteMany({ where: { physicalCoilId: coilId } });
      await prisma.contractCoilAllocation.deleteMany({ where: { coilId } });
      if (docs.length) await prisma.inventoryDocument.deleteMany({ where: { id: { in: docs.map((row: any) => row.id) } } });
      await prisma.physicalCoil.deleteMany({ where: { id: coilId } });
    }
    if (contractIds.length) await prisma.materialContractTransaction.deleteMany({ where: { contractId: { in: contractIds } } });
    if (materialLotId) await prisma.materialLot.deleteMany({ where: { id: materialLotId } });
    if (contractIds.length) {
      await prisma.materialContract.deleteMany({ where: { id: { in: contractIds } } });
    }
    if (testMoId) {
      await prisma.productionActivityLog.deleteMany({ where: { manufacturingOrderId: testMoId } });
      await prisma.productionOperation.deleteMany({ where: { manufacturingOrderId: testMoId } });
      await prisma.manufacturingOrder.deleteMany({ where: { id: testMoId } });
    }
    if (createdOp30LocationId) {
      await prisma.warehouseLocation.delete({ where: { id: createdOp30LocationId } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch(error => {
    console.error('First-operation coil-to-WIP integration test failed:', error);
    process.exit(1);
  });
