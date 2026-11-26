import { activateTestDatabaseForIntegrationTests } from '../src/server/db/testDatabase';
import { getLocationForProcess } from '../src/server/productionWipEngine';
import {
  approveOperationTransferDb,
  calculateMoReconciliationDb,
  createManufacturingOrderDb,
  createOperationTransferDb,
  deleteManufacturingOrderWithRollbackDb,
  listAvailableMaterialSourcesDb,
  loadMaterialIntoMoDb,
  postWipProductionDb,
  registerOperationInputDb,
  rejectOperationTransferDb,
  WipServiceError,
} from '../src/server/services/productionWipService';

function assert(description: string, condition: boolean) {
  if (!condition) {
    throw new Error(`❌ ASSERTION FAILED: ${description}`);
  }
  console.log(`✅ ${description}`);
}

async function assertThrowsWipError(
  description: string,
  fn: () => Promise<unknown>,
  expectedStatus: number,
  expectedConflict?: boolean,
) {
  let caught: unknown = null;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  const ok =
    caught instanceof WipServiceError &&
    caught.statusCode === expectedStatus &&
    (expectedConflict === undefined || caught.conflict === expectedConflict);
  if (!ok) {
    throw new Error(
      `❌ ASSERTION FAILED: ${description} (expected WipServiceError status=${expectedStatus}${
        expectedConflict !== undefined ? ` conflict=${expectedConflict}` : ''
      }, got ${caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)})`,
    );
  }
  console.log(`✅ ${description}`);
}

async function run() {
  const { prisma } = await activateTestDatabaseForIntegrationTests();
  const nonce = `TEST-CUTOVER-${Date.now()}`;
  const testOwnership = 'CUTOVER_E2E_TEST';
  const testContractId = nonce;

  const createdMoIds: string[] = [];
  let tempPartId: string | undefined;
  let tempRouteId: string | undefined;
  let tempSourceBalId: string | undefined;
  let tempFgLocId: string | undefined;
  let createdTempFgLoc = false;

  const snapshotBefore = await prisma.wipStateSnapshot.findUnique({
    where: { id: 'production-wip-state' },
    select: { version: true, updatedAt: true },
  });

  try {
    const [unitPcs, operations, activeLocations, rawWarehouse, fgWarehouse, scrapWarehouse, machine, shift, user] =
      await Promise.all([
        prisma.unitOfMeasure.findFirst({ where: { code: 'PCS', active: true } }) ??
          prisma.unitOfMeasure.findFirst({ where: { active: true }, orderBy: { code: 'asc' } }),
        prisma.operation.findMany({ where: { active: true }, orderBy: { code: 'asc' } }),
        prisma.warehouseLocation.findMany({ where: { active: true, warehouse: { active: true } }, include: { warehouse: true } }),
        prisma.warehouse.findFirst({
          where: { type: 'RAW_MATERIALS', active: true },
          include: { locations: { where: { active: true }, orderBy: { code: 'asc' }, take: 1 } },
        }),
        prisma.warehouse.findFirst({
          where: { type: 'FINISHED_GOODS', active: true },
          include: { locations: { where: { active: true }, orderBy: { code: 'asc' } } },
        }),
        prisma.warehouse.findFirst({
          where: { type: 'SCRAP', active: true },
          include: { locations: { where: { active: true }, orderBy: { code: 'asc' }, take: 1 } },
        }),
        prisma.machine.findFirst({ where: { active: true, status: 'ACTIVE' }, orderBy: { code: 'asc' } }),
        prisma.shift.findFirst({ where: { active: true }, orderBy: { code: 'asc' } }),
        prisma.user.findFirst({ orderBy: { id: 'asc' } }),
      ]);

    if (
      !unitPcs ||
      !rawWarehouse?.locations[0] ||
      !fgWarehouse ||
      !scrapWarehouse?.locations[0] ||
      !machine ||
      !shift ||
      !user
    ) {
      throw new Error('Required master fixtures (unit, warehouses, machine, shift, user) are missing.');
    }

    // Resolve two operations that map to distinct active locations for testing both same-location & cross-location steps
    const locByCode = new Map<string, any[]>();
    for (const loc of activeLocations) {
      const list = locByCode.get(loc.code) ?? [];
      list.push(loc);
      locByCode.set(loc.code, list);
    }

    const opWithLoc = operations
      .map(op => {
        const code = getLocationForProcess(op.processType, 10);
        const matches = locByCode.get(code) ?? [];
        return matches.length === 1 ? { op, loc: matches[0] } : null;
      })
      .filter((x): x is { op: any; loc: any } => Boolean(x));

    const firstPair = opWithLoc.find(x => x.op.processType !== 'ASSEMBLY');
    const secondPair = opWithLoc.find(x => x.loc.id !== firstPair?.loc.id);
    if (!firstPair || !secondPair) {
      throw new Error('Need at least two active Operations resolving to distinct active WarehouseLocations.');
    }

    // Pick a dedicated FG location (or create an isolated one) that isn't LOC-FIN-P1 to prove Decision #3 (no hardcoding)
    let targetFgLoc = fgWarehouse.locations.find(l => l.code !== 'LOC-FIN-P1');
    if (!targetFgLoc) {
      targetFgLoc = await prisma.warehouseLocation.create({
        data: {
          warehouseId: fgWarehouse.id,
          code: `LOC-FIN-${nonce.slice(-6)}`,
          active: true,
        },
      });
      createdTempFgLoc = true;
    }
    tempFgLocId = targetFgLoc.id;

    // Create isolated test Part + 3-step Route (Step 10 & Step 20 share firstPair.loc; Step 30 uses secondPair.loc)
    const tempPart = await prisma.part.create({
      data: {
        partNumber: nonce,
        name: `قطعه تست کات‌اور ${nonce}`,
        category: 'FINISHED_GOOD',
        unitId: unitPcs.id,
        weightNetKg: 0.5,
        weightGrossKg: 0.6,
        targetWarehouseId: fgWarehouse.id,
        targetLocationId: targetFgLoc.id,
        active: true,
      },
    });
    tempPartId = tempPart.id;

    const tempRoute = await prisma.partRoute.create({
      data: {
        partId: tempPart.id,
        version: 'V1.0-TEST',
        status: 'ACTIVE',
        isDefault: true,
        operations: {
          create: [
            {
              operationId: firstPair.op.id,
              stepNumber: 10,
              stepCode: 'OP10_SAME_A',
              stepName: 'مرحله ۱۰ تست هم‌مکان',
              machineId: machine.id,
              setupTimeMin: 10,
              standardCycleTimeSec: 20,
              scrapNormPercent: 1,
              transferBatchQty: 50,
            },
            {
              operationId: firstPair.op.id,
              stepNumber: 20,
              stepCode: 'OP20_SAME_B',
              stepName: 'مرحله ۲۰ تست هم‌مکان',
              machineId: machine.id,
              setupTimeMin: 10,
              standardCycleTimeSec: 20,
              scrapNormPercent: 1,
              transferBatchQty: 50,
            },
            {
              operationId: secondPair.op.id,
              stepNumber: 30,
              stepCode: 'OP30_FINAL',
              stepName: 'مرحله ۳۰ تست نهایی',
              machineId: machine.id,
              setupTimeMin: 10,
              standardCycleTimeSec: 20,
              scrapNormPercent: 1,
              transferBatchQty: 50,
            },
          ],
        },
      },
    });
    tempRouteId = tempRoute.id;

    // Seed isolated source StockBalance in RAW_MATERIALS
    const rawLoc = rawWarehouse.locations[0];
    const sourceBal = await prisma.stockBalance.create({
      data: {
        partId: tempPart.id,
        warehouseId: rawWarehouse.id,
        locationId: rawLoc.id,
        ownership: testOwnership,
        contractId: testContractId,
        contractNumber: testContractId,
        qualityStatus: 'AVAILABLE',
        quantityOnHand: 200,
        quantityReserved: 0,
        quantityAvailable: 200,
        weightKgOnHand: 100,
        weightKgReserved: 0,
        weightKgAvailable: 100,
      },
    });
    tempSourceBalId = sourceBal.id;

    // -----------------------------------------------------------------------
    // Decision #2: Unbacked MO creation MUST fail; 0-input succeeds; Load needs sourceStockBalanceId
    // -----------------------------------------------------------------------
    await assertThrowsWipError(
      'Decision #2: Reject creating MO with non-zero initialInputQuantity and no sourceStockBalanceId',
      () =>
        createManufacturingOrderDb({
          partId: tempPart.id,
          routingId: tempRoute.id,
          targetQuantity: 100,
          initialInputQuantity: 10,
          createdByUserId: user.id,
        }),
      400,
    );

    const sources = await listAvailableMaterialSourcesDb();
    assert(
      'listAvailableMaterialSourcesDb returns our isolated test StockBalance',
      sources.some((s: any) => s.id === sourceBal.id && Number(s.quantityAvailable) === 200),
    );

    const mo0 = await createManufacturingOrderDb({
      partId: tempPart.id,
      routingId: tempRoute.id,
      targetQuantity: 100,
      initialInputQuantity: 0,
      notes: 'Zero-input relational cutover E2E test MO',
      createdBy: user.fullName,
      createdByUserId: user.id,
    });
    createdMoIds.push(mo0.id);

    assert('0-input MO initialized with initialInputQuantity === 0', mo0.initialInputQuantity === 0);
    assert('0-input MO op10 waitingInputQty === 0', mo0.operations[0].waitingInputQty === 0);

    await assertThrowsWipError(
      'Decision #2: Reject loadMaterialIntoMoDb without sourceStockBalanceId',
      () =>
        loadMaterialIntoMoDb({
          moId: mo0.id,
          quantity: 50,
          createdByUserId: user.id,
        }),
      400,
    );

    // Concurrency CAS check on loadMaterialIntoMoDb
    await assertThrowsWipError(
      'Optimistic concurrency (409): loadMaterialIntoMoDb rejects stale expectedVersion',
      () =>
        loadMaterialIntoMoDb({
          moId: mo0.id,
          quantity: 100,
          sourceStockBalanceId: sourceBal.id,
          createdByUserId: user.id,
          expectedVersion: (mo0.version ?? 1) + 99,
        }),
      409,
      true,
    );

    const loadedMo = await loadMaterialIntoMoDb({
      moId: mo0.id,
      quantity: 100,
      sourceStockBalanceId: sourceBal.id,
      operatorName: user.fullName,
      createdByUserId: user.id,
      expectedVersion: mo0.version,
    });

    assert('Material load updated initialInputQuantity to 100', loadedMo.initialInputQuantity === 100);
    assert('Material load added 100 to op10 waitingInputQty', loadedMo.operations[0].waitingInputQty === 100);

    const refreshedRawBal = await prisma.stockBalance.findUnique({ where: { id: sourceBal.id } });
    const issueDocsCount = await prisma.inventoryDocument.count({
      where: { referenceNumber: loadedMo.moNumber, documentType: 'ISSUE', postingStatus: 'POSTED' },
    });
    const op10WipBalAfterLoad = await prisma.stockBalance.findFirst({
      where: {
        partId: tempPart.id,
        locationId: firstPair.loc.id,
        ownership: testOwnership,
        contractId: testContractId,
        qualityStatus: 'AVAILABLE',
      },
    });
    assert('Source StockBalance decremented from 200 to 100', Number(refreshedRawBal?.quantityAvailable) === 100);
    assert('Posted ISSUE InventoryDocument created for material load', issueDocsCount === 1);
    assert('WIP AVAILABLE balance at op10 created with 100', Number(op10WipBalAfterLoad?.quantityAvailable) === 100);

    // -----------------------------------------------------------------------
    // Concurrency CAS check & registerOperationInputDb + Decision #5 Same-Location Post
    // -----------------------------------------------------------------------
    const op10 = loadedMo.operations[0];
    await assertThrowsWipError(
      'Optimistic concurrency (409): registerOperationInputDb rejects stale expectedVersion',
      () =>
        registerOperationInputDb({
          moId: loadedMo.id,
          operationId: op10.id,
          quantity: 100,
          expectedVersion: (op10.version ?? 1) + 50,
        }),
      409,
      true,
    );

    const afterInputMo = await registerOperationInputDb({
      moId: loadedMo.id,
      operationId: op10.id,
      quantity: 100,
      operatorName: user.fullName,
      machineId: machine.id,
      expectedVersion: op10.version,
    });
    const op10AfterInput = afterInputMo.operations[0];
    assert(
      'registerOperationInputDb moved 100 from waitingInputQty to inProgressQty',
      op10AfterInput.waitingInputQty === 0 && op10AfterInput.inProgressQty === 100,
    );

    // Stale version check on postWipProductionDb
    await assertThrowsWipError(
      'Optimistic concurrency (409): postWipProductionDb rejects stale expectedVersion',
      () =>
        postWipProductionDb({
          moId: loadedMo.id,
          operationId: op10AfterInput.id,
          idempotencyKey: `${nonce}-stale-op10`,
          machineId: machine.id,
          shiftId: shift.id,
          createdByUserId: user.id,
          goodQty: 90,
          scrapQty: 5,
          reworkQty: 3,
          rejectedQty: 2,
          scrapReason: 'پارگی ورق در تست',
          expectedVersion: op10AfterInput.version! + 42,
        }),
      409,
      true,
    );

    // Post Op10 -> Op20 (SAME location: firstPair.loc) with 90 good, 5 scrap, 3 rework, 2 rejected
    const post10 = await postWipProductionDb({
      moId: loadedMo.id,
      operationId: op10AfterInput.id,
      idempotencyKey: `${nonce}-post-op10`,
      machineId: machine.id,
      shiftId: shift.id,
      createdByUserId: user.id,
      goodQty: 90,
      scrapQty: 5,
      reworkQty: 3,
      rejectedQty: 2,
      scrapReason: 'پارگی ورق در تست',
      operatorName: user.fullName,
      expectedVersion: op10AfterInput.version,
    });

    const post10Txs = await prisma.inventoryTransaction.findMany({
      where: { productionReportId: post10.report.id },
    });
    // Decision #5: Because Op10 and Op20 share the exact same location, goodQty (90) MUST NOT generate OUTBOUND+INBOUND!
    // Only non-good classifications: 1 OUTBOUND(10) from AVAILABLE + 1 INBOUND(5 SCRAP) + 1 INBOUND(3 REWORK) + 1 INBOUND(2 REJECTED) = 4 txs.
    assert(
      'Decision #5: Same-location Op10->Op20 skips redundant OUTBOUND+INBOUND for goodQty (4 non-good txs only)',
      post10Txs.length === 4 &&
        post10Txs.filter(t => t.transactionType === 'OUTBOUND' && t.qualityStatus === 'AVAILABLE' && Number(t.quantity) === 10).length === 1 &&
        post10Txs.filter(t => t.transactionType === 'INBOUND' && t.qualityStatus === 'SCRAP' && Number(t.quantity) === 5).length === 1 &&
        post10Txs.filter(t => t.transactionType === 'INBOUND' && t.qualityStatus === 'REWORK' && Number(t.quantity) === 3).length === 1 &&
        post10Txs.filter(t => t.transactionType === 'INBOUND' && t.qualityStatus === 'REJECTED' && Number(t.quantity) === 2).length === 1,
    );

    const [sharedAvailBal, scrapBal, reworkBal, rejectedBal] = await Promise.all([
      prisma.stockBalance.findFirst({
        where: { partId: tempPart.id, locationId: firstPair.loc.id, ownership: testOwnership, contractId: testContractId, qualityStatus: 'AVAILABLE' },
      }),
      prisma.stockBalance.findFirst({
        where: { partId: tempPart.id, locationId: scrapWarehouse.locations[0].id, ownership: testOwnership, contractId: testContractId, qualityStatus: 'SCRAP' },
      }),
      prisma.stockBalance.findFirst({
        where: { partId: tempPart.id, locationId: firstPair.loc.id, ownership: testOwnership, contractId: testContractId, qualityStatus: 'REWORK' },
      }),
      prisma.stockBalance.findFirst({
        where: { partId: tempPart.id, locationId: firstPair.loc.id, ownership: testOwnership, contractId: testContractId, qualityStatus: 'REJECTED' },
      }),
    ]);

    assert(
      'Decision #5: Shared AVAILABLE=90, WH-SCRAP SCRAP=5, source REWORK=3, source REJECTED=2',
      Number(sharedAvailBal?.quantityAvailable) === 90 &&
        Number(scrapBal?.quantityOnHand) === 5 &&
        Number(reworkBal?.quantityOnHand) === 3 &&
        Number(rejectedBal?.quantityOnHand) === 2,
    );

    const op20AfterPost10 = post10.mo!.operations[1];
    assert('Op20 waitingInputQty received 90 via logical auto-transfer', op20AfterPost10.waitingInputQty === 90);

    // Post Op20 -> Op30 (DISTINCT locations: firstPair.loc -> secondPair.loc) with 90 good
    const post20 = await postWipProductionDb({
      moId: loadedMo.id,
      operationId: op20AfterPost10.id,
      idempotencyKey: `${nonce}-post-op20`,
      machineId: machine.id,
      shiftId: shift.id,
      createdByUserId: user.id,
      goodQty: 90,
      scrapQty: 0,
      reworkQty: 0,
      rejectedQty: 0,
      operatorName: user.fullName,
      expectedVersion: op20AfterPost10.version,
    });
    const post20Txs = await prisma.inventoryTransaction.findMany({ where: { productionReportId: post20.report.id } });
    assert('Cross-location Op20->Op30 wrote 2 transactions (OUTBOUND + INBOUND)', post20Txs.length === 2);

    // Post Op30 -> Final Output Destination (Decision #3: targetFgLoc, not hardcoded LOC-FIN-P1)
    const op30AfterPost20 = post20.mo!.operations[2];
    const post30 = await postWipProductionDb({
      moId: loadedMo.id,
      operationId: op30AfterPost20.id,
      idempotencyKey: `${nonce}-post-op30`,
      machineId: machine.id,
      shiftId: shift.id,
      createdByUserId: user.id,
      goodQty: 90,
      scrapQty: 0,
      reworkQty: 0,
      rejectedQty: 0,
      operatorName: user.fullName,
      expectedVersion: op30AfterPost20.version,
    });

    const finalFgBal = await prisma.stockBalance.findFirst({
      where: {
        partId: tempPart.id,
        warehouseId: fgWarehouse.id,
        locationId: targetFgLoc.id,
        ownership: testOwnership,
        contractId: testContractId,
        qualityStatus: 'AVAILABLE',
      },
    });
    assert(
      'Decision #3: Final stage output posted to MO/Part resolved outputLocationId (not hardcoded)',
      Number(finalFgBal?.quantityAvailable) === 90 && post30.mo!.completedQuantity === 90,
    );

    // Reconciliation check (100 input === 90 completed + 5 scrap + 3 rework + 2 rejected)
    const recon1 = await calculateMoReconciliationDb(loadedMo.id);
    assert(
      'calculateMoReconciliationDb confirms 100% quantity conservation (discrepancy === 0)',
      Boolean(recon1 && recon1.discrepancy === 0 && recon1.isConserved && recon1.totalCompleted === 90),
    );

    // -----------------------------------------------------------------------
    // Decision #4: Manual WIP Transfer lifecycle (DISPATCHED -> REJECTED -> DISPATCHED -> RECEIVED)
    // -----------------------------------------------------------------------
    const moTransfer = await createManufacturingOrderDb({
      partId: tempPart.id,
      routingId: tempRoute.id,
      targetQuantity: 40,
      initialInputQuantity: 40,
      sourceStockBalanceId: sourceBal.id,
      notes: 'Manual transfer lifecycle E2E test MO',
      createdBy: user.fullName,
      createdByUserId: user.id,
    });
    createdMoIds.push(moTransfer.id);

    // Move op10's 40 waitingInputQty into readyForTransferQty (simulating pre-transfer staged output) cleanly in DB
    const trOp10 = moTransfer.operations[0];
    const trOp30 = moTransfer.operations[2];
    await prisma.productionOperation.update({
      where: { id: trOp10.id },
      data: {
        waitingInputQty: 0,
        inputQty: 40,
        outputGoodQty: 40,
        readyForTransferQty: 40,
        version: { increment: 1 },
      },
    });

    // Stale CAS check on createOperationTransferDb
    await assertThrowsWipError(
      'Optimistic concurrency (409): createOperationTransferDb rejects stale expectedVersion',
      () =>
        createOperationTransferDb({
          moId: moTransfer.id,
          fromOperationId: trOp10.id,
          toOperationId: trOp30.id,
          quantity: 40,
          expectedVersion: trOp10.version, // stale after +1 above
        }),
      409,
      true,
    );

    const dispatched1 = await createOperationTransferDb({
      moId: moTransfer.id,
      fromOperationId: trOp10.id,
      toOperationId: trOp30.id,
      quantity: 40,
      dispatchedBy: user.fullName,
      createdByUserId: user.id,
      expectedVersion: (trOp10.version ?? 1) + 1,
    });
    assert('Decision #4: Created transfer maps DB DISPATCHED -> UI PENDING_APPROVAL', dispatched1.status === 'PENDING_APPROVAL');

    const inTransitAfterDispatch = await prisma.stockBalance.findFirst({
      where: {
        partId: tempPart.id,
        locationId: secondPair.loc.id,
        ownership: testOwnership,
        contractId: testContractId,
        qualityStatus: 'IN_TRANSIT',
      },
    });
    assert('Decision #4: Dispatch created IN_TRANSIT stock balance of 40 at destination', Number(inTransitAfterDispatch?.quantityOnHand) === 40);

    // Reject with stale expectedVersion -> 409
    await assertThrowsWipError(
      'Optimistic concurrency (409): rejectOperationTransferDb rejects stale expectedVersion',
      () =>
        rejectOperationTransferDb({
          transferId: dispatched1.id,
          rejectedBy: user.fullName,
          expectedVersion: (dispatched1.version ?? 1) + 77,
        }),
      409,
      true,
    );

    const rejectedTr = await rejectOperationTransferDb({
      transferId: dispatched1.id,
      rejectedBy: user.fullName,
      rejectionReason: 'تست عودت حواله',
      createdByUserId: user.id,
      expectedVersion: dispatched1.version,
    });
    assert('Decision #4: Rejected transfer status is REJECTED', rejectedTr.status === 'REJECTED');

    const op10AfterReject = await prisma.productionOperation.findUnique({ where: { id: trOp10.id } });
    const inTransitAfterReject = await prisma.stockBalance.findFirst({
      where: {
        partId: tempPart.id,
        locationId: secondPair.loc.id,
        ownership: testOwnership,
        contractId: testContractId,
        qualityStatus: 'IN_TRANSIT',
      },
    });
    assert(
      'Decision #4: Rejection reverted op10 readyForTransferQty to 40 and cleared IN_TRANSIT',
      Number(op10AfterReject?.readyForTransferQty) === 40 && Number(inTransitAfterReject?.quantityOnHand ?? 0) === 0,
    );

    // Re-dispatch and approve -> finalizes destination AVAILABLE + toOp.waitingInputQty
    const dispatched2 = await createOperationTransferDb({
      moId: moTransfer.id,
      fromOperationId: trOp10.id,
      toOperationId: trOp30.id,
      quantity: 40,
      dispatchedBy: user.fullName,
      createdByUserId: user.id,
      expectedVersion: op10AfterReject!.version,
    });

    await assertThrowsWipError(
      'Optimistic concurrency (409): approveOperationTransferDb rejects stale expectedVersion',
      () =>
        approveOperationTransferDb({
          transferId: dispatched2.id,
          receivedBy: user.fullName,
          expectedVersion: (dispatched2.version ?? 1) + 88,
        }),
      409,
      true,
    );

    const approvedTr = await approveOperationTransferDb({
      transferId: dispatched2.id,
      receivedBy: user.fullName,
      createdByUserId: user.id,
      expectedVersion: dispatched2.version,
    });
    assert('Decision #4: Approved transfer maps DB RECEIVED -> UI APPROVED', approvedTr.status === 'APPROVED');

    const [op30AfterApprove, destAvailAfterApprove, reconTransferMo] = await Promise.all([
      prisma.productionOperation.findUnique({ where: { id: trOp30.id } }),
      prisma.stockBalance.findFirst({
        where: {
          partId: tempPart.id,
          locationId: secondPair.loc.id,
          ownership: testOwnership,
          contractId: testContractId,
          qualityStatus: 'AVAILABLE',
        },
      }),
      calculateMoReconciliationDb(moTransfer.id),
    ]);
    assert(
      'Decision #4: Approval incremented toOp.waitingInputQty=40 & destination AVAILABLE=40',
      Number(op30AfterApprove?.waitingInputQty) === 40 && Number(destAvailAfterApprove?.quantityAvailable) === 40,
    );
    assert(
      'Decision #4: MO conservation remains exact after reject + approve cycle',
      Boolean(reconTransferMo && reconTransferMo.discrepancy === 0 && reconTransferMo.isConserved),
    );

    // -----------------------------------------------------------------------
    // Cascading Delete Rollback verification
    // -----------------------------------------------------------------------
    const del1 = await deleteManufacturingOrderWithRollbackDb({
      moIdOrNumber: moTransfer.id,
      cascadeSubMos: true,
      reason: 'E2E cutover rollback test cleanup',
      requestedUserId: user.id,
    });
    const del2 = await deleteManufacturingOrderWithRollbackDb({
      moIdOrNumber: loadedMo.id,
      cascadeSubMos: true,
      reason: 'E2E cutover rollback test cleanup',
      requestedUserId: user.id,
    });
    assert(
      'deleteManufacturingOrderWithRollbackDb deleted both test MOs & reversed posted docs',
      del1.deletedMoCount === 1 && del2.deletedMoCount === 1 && del2.reversalDocumentsCount >= 1,
    );

    const remainingTestMos = await prisma.manufacturingOrder.count({
      where: { id: { in: createdMoIds } },
    });
    const rawBalAfterRollback = await prisma.stockBalance.findUnique({ where: { id: sourceBal.id } });
    assert('Zero leftover test MO rows remain after rollback delete', remainingTestMos === 0);
    assert(
      'Source StockBalance quantityAvailable restored to original 200 after rollback delete',
      Number(rawBalAfterRollback?.quantityAvailable) === 200,
    );

    const snapshotAfter = await prisma.wipStateSnapshot.findUnique({
      where: { id: 'production-wip-state' },
      select: { version: true, updatedAt: true },
    });
    assert(
      'wip_state_snapshots remained completely untouched during all relational operations',
      snapshotBefore?.version === snapshotAfter?.version &&
        snapshotBefore?.updatedAt?.getTime() === snapshotAfter?.updatedAt?.getTime(),
    );

    console.log('ALL PRODUCTION & WIP RELATIONAL CUTOVER TESTS PASSED');
  } finally {
    // Full cleanup of all isolated test rows in reverse FK dependency order
    if (createdMoIds.length > 0) {
      await prisma.auditLog.deleteMany({
        where: { entityName: 'ManufacturingOrder', entityId: { in: createdMoIds } },
      });
      await prisma.productionActivityLog.deleteMany({ where: { manufacturingOrderId: { in: createdMoIds } } });
      await prisma.productionTransfer.deleteMany({ where: { manufacturingOrderId: { in: createdMoIds } } });
      const reps = await prisma.productionReport.findMany({
        where: { manufacturingOrderId: { in: createdMoIds } },
        select: { id: true },
      });
      if (reps.length > 0) {
        await prisma.productionScrap.deleteMany({ where: { productionReportId: { in: reps.map(r => r.id) } } });
      }
      await prisma.inventoryTransaction.deleteMany({ where: { manufacturingOrderId: { in: createdMoIds } } });
      await prisma.productionReport.deleteMany({ where: { manufacturingOrderId: { in: createdMoIds } } });
      await prisma.productionOperation.deleteMany({ where: { manufacturingOrderId: { in: createdMoIds } } });
      await prisma.manufacturingOrder.deleteMany({ where: { id: { in: createdMoIds } } });
    }
    if (tempPartId) {
      const txs = await prisma.inventoryTransaction.findMany({
        where: { partId: tempPartId },
        select: { documentId: true },
      });
      const lines = await prisma.inventoryDocumentLine.findMany({
        where: { partId: tempPartId },
        select: { documentId: true },
      });
      const docIds = [
        ...new Set([...txs.map(t => t.documentId), ...lines.map(l => l.documentId)].filter(Boolean)),
      ] as string[];
      await prisma.inventoryTransaction.deleteMany({ where: { partId: tempPartId } });
      if (docIds.length > 0) {
        await prisma.inventoryDocumentLine.deleteMany({ where: { documentId: { in: docIds } } });
        await prisma.inventoryDocument.deleteMany({ where: { id: { in: docIds } } });
      }
      await prisma.stockBalance.deleteMany({ where: { partId: tempPartId } });
    }
    if (tempSourceBalId) {
      await prisma.stockBalance.deleteMany({ where: { id: tempSourceBalId } });
    }
    if (tempRouteId) {
      await prisma.routeOperation.deleteMany({ where: { routeId: tempRouteId } });
      await prisma.partRoute.deleteMany({ where: { id: tempRouteId } });
    }
    if (tempPartId) {
      await prisma.part.deleteMany({ where: { id: tempPartId } });
    }
    if (createdTempFgLoc && tempFgLocId) {
      await prisma.warehouseLocation.deleteMany({ where: { id: tempFgLocId } });
    }
    await prisma.$disconnect();
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
