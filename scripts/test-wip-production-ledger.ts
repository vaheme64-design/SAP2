import { activateTestDatabaseForIntegrationTests } from '../src/server/db/testDatabase';
import { getLocationForProcess } from '../src/server/productionWipEngine';
import { createManufacturingOrderDb } from '../src/server/services/productionWipService';
import { postWipProductionAtomically } from '../src/server/wipProductionLedger';

function assert(description: string, condition: boolean) {
  if (!condition) throw new Error(`❌ ${description}`);
  console.log(`✅ ${description}`);
}

async function run() {
  const { prisma } = await activateTestDatabaseForIntegrationTests();
  const nonce = `TEST-LEDGER-${Date.now()}`;
  const idempotencyKey = `${nonce}-atomic-980-20`;
  const rollbackKey = `${nonce}-rollback-001`;
  const testOwnership = 'WIP_LEDGER_TEST';
  const testContractId = nonce;

  let createdMoId: string | undefined;
  let sourceBalanceId: string | undefined;
  let tempPartId: string | undefined;
  let tempRouteId: string | undefined;

  try {
    const [unitPcs, operations, activeLocations, shift, user, activeMachines, capabilityCount, rawWarehouse, scrapWarehouses] =
      await Promise.all([
        prisma.unitOfMeasure.findFirst({ where: { code: 'PCS', active: true } }) ??
          prisma.unitOfMeasure.findFirst({ where: { active: true }, orderBy: { code: 'asc' } }),
        prisma.operation.findMany({ where: { active: true }, orderBy: { code: 'asc' } }),
        prisma.warehouseLocation.findMany({ where: { active: true, warehouse: { active: true } }, include: { warehouse: true } }),
        prisma.shift.findFirst({ where: { active: true }, orderBy: { code: 'asc' } }),
        prisma.user.findFirst({ orderBy: { id: 'asc' } }),
        prisma.machine.findMany({
          where: { active: true, status: 'ACTIVE' },
          include: { capabilities: { include: { operation: true } } },
          orderBy: { code: 'asc' },
        }),
        prisma.machineCapability.count(),
        prisma.warehouse.findFirst({
          where: { active: true, type: 'RAW_MATERIALS' },
          include: { locations: { where: { active: true }, orderBy: { code: 'asc' }, take: 1 } },
        }),
        prisma.warehouse.findMany({
          where: { type: 'SCRAP', active: true },
          include: { locations: { where: { active: true }, orderBy: { code: 'asc' }, take: 1 } },
        }),
      ]);

    const scrapLocation = scrapWarehouses[0]?.locations[0];
    if (!unitPcs || !shift || !user || activeMachines.length === 0 || !rawWarehouse?.locations[0] || !scrapLocation) {
      throw new Error('Active unit, shift, user, machine, raw warehouse location, and scrap location are required.');
    }

    const locByCode = new Map<string, any[]>();
    for (const loc of activeLocations) {
      const list = locByCode.get(loc.code) ?? [];
      list.push(loc);
      locByCode.set(loc.code, list);
    }

    const findEligibleMachineForOp = (op: (typeof operations)[number]) => {
      if (capabilityCount === 0) {
        return activeMachines[0] ?? null;
      }
      return (
        activeMachines.find(m =>
          m.capabilities.some(
            c => c.operationId === op.id || (op.processType && c.operation?.processType === op.processType),
          ),
        ) ?? null
      );
    };

    const resolveEligibleOp = (op: (typeof operations)[number], stepNumber: number) => {
      const code = getLocationForProcess(op.processType, stepNumber);
      const matches = locByCode.get(code) ?? [];
      if (matches.length !== 1) return null;
      const eligibleMachine = findEligibleMachineForOp(op);
      if (!eligibleMachine) return null;
      return { op, loc: matches[0], machine: eligibleMachine };
    };

    const firstPair = operations
      .filter(op => op.processType !== 'ASSEMBLY')
      .map(op => resolveEligibleOp(op, 10))
      .find((x): x is { op: any; loc: any; machine: any } => Boolean(x));

    const secondPair = operations
      .map(op => resolveEligibleOp(op, 20))
      .find((x): x is { op: any; loc: any; machine: any } => Boolean(x && firstPair && x.loc.id !== firstPair.loc.id));

    if (!firstPair || !secondPair) {
      throw new Error(
        'Two active operations with eligible ACTIVE machines (matching machine_capabilities when seeded) and distinct active warehouse locations are required.',
      );
    }

    const tempPart = await prisma.part.create({
      data: {
        partNumber: nonce,
        name: `قطعه تست لجر ${nonce}`,
        category: 'FINISHED_GOOD',
        unitId: unitPcs.id,
        weightNetKg: 0.5,
        weightGrossKg: 0.6,
        active: true,
      },
    });
    tempPartId = tempPart.id;

    const tempRoute = await prisma.partRoute.create({
      data: {
        partId: tempPart.id,
        version: 'V1.0-LEDGER',
        status: 'ACTIVE',
        isDefault: true,
        operations: {
          create: [
            {
              operationId: firstPair.op.id,
              stepNumber: 10,
              stepCode: 'OP10_LEDGER',
              stepName: 'عملیات ۱۰ تست لجر',
              machineId: firstPair.machine.id,
              setupTimeMin: 10,
              standardCycleTimeSec: 20,
              scrapNormPercent: 1,
              transferBatchQty: 100,
            },
            {
              operationId: secondPair.op.id,
              stepNumber: 20,
              stepCode: 'OP20_LEDGER',
              stepName: 'عملیات ۲۰ تست لجر',
              machineId: secondPair.machine.id,
              setupTimeMin: 10,
              standardCycleTimeSec: 20,
              scrapNormPercent: 1,
              transferBatchQty: 100,
            },
          ],
        },
      },
    });
    tempRouteId = tempRoute.id;

    const sourceLoc = rawWarehouse.locations[0];
    const sourceBal = await prisma.stockBalance.create({
      data: {
        partId: tempPart.id,
        warehouseId: rawWarehouse.id,
        locationId: sourceLoc.id,
        ownership: testOwnership,
        contractId: testContractId,
        contractNumber: testContractId,
        qualityStatus: 'AVAILABLE',
        quantityOnHand: 1000,
        quantityReserved: 0,
        quantityAvailable: 1000,
        weightKgOnHand: 1000 * Number(tempPart.weightNetKg),
        weightKgReserved: 0,
        weightKgAvailable: 1000 * Number(tempPart.weightNetKg),
      },
    });
    sourceBalanceId = sourceBal.id;

    const moDto = await createManufacturingOrderDb({
      partId: tempPart.id,
      routingId: tempRoute.id,
      targetQuantity: 1000,
      initialInputQuantity: 1000,
      sourceStockBalanceId: sourceBal.id,
      notes: 'Isolated relational WIP ledger test MO',
      createdBy: user.fullName,
      createdByUserId: user.id,
    });
    createdMoId = moDto.id;

    const dbMo = await prisma.manufacturingOrder.findUnique({
      where: { id: createdMoId },
      include: {
        operations: {
          include: { operation: true, location: true },
          orderBy: [{ sequence: 'asc' }, { stepNumber: 'asc' }],
        },
      },
    });
    if (!dbMo || dbMo.operations.length < 2) {
      throw new Error('Created test MO must have at least 2 operations.');
    }
    const op10 = dbMo.operations[0];
    const op20 = dbMo.operations[1];

    const input = {
      wipManufacturingOrderId: dbMo.id,
      wipOperationId: op10.id,
      idempotencyKey,
      machineId: op10.plannedMachineId || firstPair.machine.id,
      shiftId: shift.id,
      createdByUserId: user.id,
      goodQty: 980,
      scrapQty: 20,
      reworkQty: 0,
      rejectedQty: 0,
      scrapReason: 'TEST_SCRAP',
      operatorName: user.fullName,
      expectedVersion: op10.version,
    };

    const posted = await postWipProductionAtomically(input);
    assert(
      `980 good and 20 scrap posted in one atomic transaction (txCount=${posted.transactionCount})`,
      !posted.duplicate && posted.transactionCount === 3,
    );
    assert(
      'Production report contains 980 good and 20 scrap',
      Number(posted.report.goodQuantity) === 980 && Number(posted.report.scrapQuantity) === 20,
    );
    assert('Scrap reason is retained in the relational report', posted.report.scrapReasonText === 'TEST_SCRAP');

    const [sourceBalance, targetBalance, scrapBalance, movements, refreshedOp10, refreshedOp20, autoTransfers] =
      await Promise.all([
        prisma.stockBalance.findFirst({
          where: {
            partId: tempPart.id,
            locationId: op10.locationId!,
            ownership: testOwnership,
            contractId: testContractId,
            qualityStatus: 'AVAILABLE',
          },
        }),
        prisma.stockBalance.findFirst({
          where: {
            partId: tempPart.id,
            locationId: op20.locationId!,
            ownership: testOwnership,
            contractId: testContractId,
            qualityStatus: 'AVAILABLE',
          },
        }),
        prisma.stockBalance.findFirst({
          where: {
            partId: tempPart.id,
            locationId: scrapLocation.id,
            ownership: testOwnership,
            contractId: testContractId,
            qualityStatus: 'SCRAP',
          },
        }),
        prisma.inventoryTransaction.findMany({ where: { productionReportId: posted.report.id } }),
        prisma.productionOperation.findUnique({ where: { id: op10.id } }),
        prisma.productionOperation.findUnique({ where: { id: op20.id } }),
        prisma.productionTransfer.findMany({ where: { manufacturingOrderId: dbMo.id, status: 'AUTO_TRANSFERRED' } }),
      ]);

    assert('Source stage stock is reduced to zero', Number(sourceBalance?.quantityOnHand) === 0);
    assert('980 good pieces are added to the next operation location', Number(targetBalance?.quantityOnHand) === 980);
    assert('20 scrap pieces are added to the scrap location', Number(scrapBalance?.quantityOnHand) === 20);
    assert('Expected 3 report-linked ledger movements written', movements.length === 3);
    assert('Op20 waitingInputQty equals 980', Number(refreshedOp20?.waitingInputQty) === 980);
    assert(
      'Op10 outputGoodQty=980, outputScrapQty=20, status=COMPLETED',
      Number(refreshedOp10?.outputGoodQty) === 980 &&
        Number(refreshedOp10?.outputScrapQty) === 20 &&
        refreshedOp10?.status === 'COMPLETED',
    );
    assert('AUTO_TRANSFERRED record created in ProductionTransfer', autoTransfers.length === 1 && Number(autoTransfers[0].quantity) === 980);

    const replay = await postWipProductionAtomically(input);
    assert('Same idempotency key returns the existing report without new transactions', replay.duplicate && replay.transactionCount === 0);
    const movementCountAfterReplay = await prisma.inventoryTransaction.count({ where: { productionReportId: posted.report.id } });
    assert('Idempotent replay does not duplicate kardex movements', movementCountAfterReplay === 3);

    assert('Op20 is active and not completed', refreshedOp20?.status === 'READY');
    const availableOp20Wip = Number(refreshedOp20?.waitingInputQty ?? 0) + Number(refreshedOp20?.inProgressQty ?? 0);
    assert('Op20 has known positive available station WIP', availableOp20Wip > 0 && availableOp20Wip === 980);

    const excessiveQty = availableOp20Wip + 1;
    const preRollbackTxCount = await prisma.inventoryTransaction.count({ where: { manufacturingOrderId: dbMo.id } });
    const preRollbackReportCount = await prisma.productionReport.count({ where: { manufacturingOrderId: dbMo.id } });
    const preRollbackStockBalance = await prisma.stockBalance.findFirst({
      where: {
        partId: tempPart.id,
        locationId: op20.locationId!,
        ownership: testOwnership,
        contractId: testContractId,
        qualityStatus: 'AVAILABLE',
      },
    });

    let rollbackError: Error | null = null;
    try {
      await postWipProductionAtomically({
        wipManufacturingOrderId: dbMo.id,
        wipOperationId: op20.id,
        idempotencyKey: rollbackKey,
        machineId: op20.plannedMachineId || secondPair.machine.id,
        shiftId: shift.id,
        createdByUserId: user.id,
        goodQty: excessiveQty,
        scrapQty: 0,
        reworkQty: 0,
        rejectedQty: 0,
        operatorName: user.fullName,
        expectedVersion: refreshedOp20!.version,
      });
    } catch (error) {
      if (error instanceof Error) {
        rollbackError = error;
      }
    }

    assert('Posting exceeding station WIP threw an error', Boolean(rollbackError));
    assert(
      'Rejected specifically due to insufficient station WIP (not operation completed or overproduction)',
      Boolean(
        rollbackError &&
          rollbackError.message.includes('بیشتر است') &&
          rollbackError.message.includes('موجودی قابل پردازش ایستگاه') &&
          !rollbackError.message.includes('تکمیل') &&
          !rollbackError.message.includes('سقف برنامه'),
      ),
    );
    assert('Insufficient station WIP rejects posting', Boolean(rollbackError && rollbackError.message.includes('بیشتر است')));

    const [postRollbackReport, postRollbackTxCount, postRollbackReportCount, postRollbackOp20, postRollbackStockBalance] =
      await Promise.all([
        prisma.productionReport.findUnique({ where: { wipIdempotencyKey: rollbackKey } }),
        prisma.inventoryTransaction.count({ where: { manufacturingOrderId: dbMo.id } }),
        prisma.productionReport.count({ where: { manufacturingOrderId: dbMo.id } }),
        prisma.productionOperation.findUnique({ where: { id: op20.id } }),
        prisma.stockBalance.findFirst({
          where: {
            partId: tempPart.id,
            locationId: op20.locationId!,
            ownership: testOwnership,
            contractId: testContractId,
            qualityStatus: 'AVAILABLE',
          },
        }),
      ]);

    assert(
      'Failed posting leaves no relational production report',
      !postRollbackReport && postRollbackReportCount === preRollbackReportCount,
    );
    assert('Failed posting leaves no extra inventory transactions', postRollbackTxCount === preRollbackTxCount);
    assert(
      'Failed posting leaves op20 state and version unchanged',
      Number(postRollbackOp20?.waitingInputQty) === Number(refreshedOp20?.waitingInputQty) &&
        Number(postRollbackOp20?.outputGoodQty) === Number(refreshedOp20?.outputGoodQty) &&
        postRollbackOp20?.version === refreshedOp20?.version &&
        postRollbackOp20?.status === refreshedOp20?.status,
    );
    assert(
      'Failed posting leaves inventory stock balance unchanged',
      Number(postRollbackStockBalance?.quantityOnHand) === Number(preRollbackStockBalance?.quantityOnHand),
    );

    console.log('ALL ATOMIC WIP PRODUCTION LEDGER TESTS PASSED');
  } finally {
    if (createdMoId) {
      await prisma.productionActivityLog.deleteMany({ where: { manufacturingOrderId: createdMoId } });
      await prisma.productionTransfer.deleteMany({ where: { manufacturingOrderId: createdMoId } });
      const reports = await prisma.productionReport.findMany({
        where: { manufacturingOrderId: createdMoId },
        select: { id: true },
      });
      const reportIds = reports.map((r: any) => r.id);
      if (reportIds.length) {
        await prisma.productionScrap.deleteMany({ where: { productionReportId: { in: reportIds } } });
      }
      await prisma.inventoryTransaction.deleteMany({ where: { manufacturingOrderId: createdMoId } });
      await prisma.productionReport.deleteMany({ where: { manufacturingOrderId: createdMoId } });
      await prisma.productionOperation.deleteMany({ where: { manufacturingOrderId: createdMoId } });
      await prisma.manufacturingOrder.deleteMany({ where: { id: createdMoId } });
    }
    if (tempPartId) {
      const txs = await prisma.inventoryTransaction.findMany({ where: { partId: tempPartId }, select: { documentId: true } });
      const lines = await prisma.inventoryDocumentLine.findMany({ where: { partId: tempPartId }, select: { documentId: true } });
      const docIds = [...new Set([...txs.map(t => t.documentId), ...lines.map(l => l.documentId)].filter(Boolean))] as string[];
      await prisma.inventoryTransaction.deleteMany({ where: { partId: tempPartId } });
      if (docIds.length) {
        await prisma.inventoryDocumentLine.deleteMany({ where: { documentId: { in: docIds } } });
        await prisma.inventoryDocument.deleteMany({ where: { id: { in: docIds } } });
      }
      await prisma.stockBalance.deleteMany({ where: { partId: tempPartId } });
    }
    if (sourceBalanceId) {
      await prisma.stockBalance.deleteMany({ where: { id: sourceBalanceId } });
    }
    if (tempRouteId) {
      await prisma.routeOperation.deleteMany({ where: { routeId: tempRouteId } });
      await prisma.partRoute.deleteMany({ where: { id: tempRouteId } });
    }
    if (tempPartId) {
      await prisma.part.deleteMany({ where: { id: tempPartId } });
    }
    await prisma.$disconnect();
  }
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
