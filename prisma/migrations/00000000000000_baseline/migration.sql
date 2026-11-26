-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PartCategory" AS ENUM ('RAW_MATERIAL', 'WIP_PART', 'FINISHED_GOOD', 'CONSUMABLE');

-- CreateEnum
CREATE TYPE "ProcessType" AS ENUM ('SHEARING', 'BLANKING', 'DRAWING', 'PUNCH_FORM', 'BENDING', 'TRIMMING', 'SPOT_WELD', 'CO2_WELD', 'PAINT', 'ASSEMBLY');

-- CreateEnum
CREATE TYPE "MachineType" AS ENUM ('HYDRAULIC_PRESS', 'MECHANICAL_PRESS', 'PRESS_BRAKE', 'SHEARING_MACHINE', 'SPOT_WELDER', 'CO2_WELDING_CELL', 'PAINT_LINE', 'ASSEMBLY_BENCH');

-- CreateEnum
CREATE TYPE "MachineStatus" AS ENUM ('ACTIVE', 'MAINTENANCE', 'BREAKDOWN', 'IDLE');

-- CreateEnum
CREATE TYPE "DieType" AS ENUM ('BLANKING_DIE', 'DRAWING_DIE', 'FORMING_DIE', 'TRIMMING_DIE', 'PIERCING_DIE', 'PROGRESSIVE_DIE', 'COMPOUND_DIE');

-- CreateEnum
CREATE TYPE "DieStatus" AS ENUM ('READY', 'ON_MACHINE', 'MAINTENANCE', 'CALIBRATION', 'RETIRED');

-- CreateEnum
CREATE TYPE "WarehouseType" AS ENUM ('RAW_MATERIALS', 'WIP', 'FINISHED_GOODS', 'SCRAP', 'TOOLING_DIES');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PostingStatus" AS ENUM ('UNPOSTED', 'POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "InventoryDocType" AS ENUM ('RECEIPT', 'ISSUE', 'WIP_TRANSFER', 'RETURN', 'SCRAP', 'COUNT_ADJUSTMENT', 'INITIAL_BALANCE');

-- CreateEnum
CREATE TYPE "DocReferenceType" AS ENUM ('SAPCO_COIL', 'CUSTOMER_ORDER', 'MANUFACTURING_ORDER', 'SCRAP_REPORT', 'PHYSICAL_COUNT', 'MANUAL');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('INBOUND', 'OUTBOUND', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT_POS', 'ADJUSTMENT_NEG');

-- CreateEnum
CREATE TYPE "OrderLineStatus" AS ENUM ('PENDING', 'IN_PRODUCTION', 'PARTIALLY_FULFILLED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('DRAFT', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PlanLineStatus" AS ENUM ('PLANNED', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PlanProposalStatus" AS ENUM ('DRAFT', 'APPROVED', 'SUPERSEDED', 'RELEASED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MOStatus" AS ENUM ('PLANNED', 'RELEASED', 'IN_PROGRESS', 'SUSPENDED', 'COMPLETED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProductionOpStatus" AS ENUM ('PENDING', 'READY', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ScrapReason" AS ENUM ('TEAR_CRACK', 'WRINKLING', 'DIMENSIONAL_OUT_OF_SPEC', 'BURR_HIGH', 'SURFACE_SCRATCH', 'MATERIAL_DEFECT', 'SETUP_SCRAP', 'MACHINE_MALFUNCTION', 'OTHER');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('DISPATCHED', 'RECEIVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "LotStatus" AS ENUM ('AVAILABLE', 'IN_USE', 'CONSUMED', 'QUARANTINE', 'REJECTED');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('DRAFT', 'ACTIVE', 'FULFILLED', 'EXPIRED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "ContractTxType" AS ENUM ('RECEIPT', 'RETURN', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "RouteStatus" AS ENUM ('DRAFT', 'ACTIVE', 'OBSOLETE');

-- CreateTable
CREATE TABLE "units_of_measure" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "isBase" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "units_of_measure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "materials" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "standard" TEXT,
    "densityKgM3" DECIMAL(65,30) NOT NULL DEFAULT 7850,
    "tensileStrengthMpa" DECIMAL(65,30),
    "yieldStrengthMpa" DECIMAL(65,30),
    "elongationPercent" DECIMAL(65,30),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parts" (
    "id" TEXT NOT NULL,
    "partNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "PartCategory" NOT NULL,
    "unitId" TEXT NOT NULL,
    "materialId" TEXT,
    "thicknessMm" DECIMAL(65,30),
    "weightNetKg" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "weightGrossKg" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "scrapNormPercent" DECIMAL(65,30),
    "customerPartNumber" TEXT,
    "supplierPartNumber" TEXT,
    "carModel" TEXT,
    "minSafetyStock" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "maxStock" DECIMAL(65,30),
    "leadTimeDays" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operations" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "processType" "ProcessType" NOT NULL,
    "standardLaborCostPerHour" DECIMAL(65,30),
    "standardMachineCostPerHour" DECIMAL(65,30),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_routes" (
    "id" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT 'V1.0',
    "status" "RouteStatus" NOT NULL DEFAULT 'ACTIVE',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "isDefault" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "part_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_operations" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "stepCode" TEXT NOT NULL,
    "stepName" TEXT NOT NULL,
    "machineId" TEXT,
    "dieId" TEXT,
    "setupTimeMin" INTEGER NOT NULL DEFAULT 30,
    "standardCycleTimeSec" INTEGER NOT NULL DEFAULT 45,
    "scrapNormPercent" DECIMAL(65,30) NOT NULL DEFAULT 1.5,
    "transferBatchQty" DECIMAL(65,30) NOT NULL DEFAULT 100,

    CONSTRAINT "route_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machines" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "machineType" "MachineType" NOT NULL,
    "tonnageCapacity" DECIMAL(65,30),
    "bolsterLengthMm" DECIMAL(65,30),
    "bolsterWidthMm" DECIMAL(65,30),
    "strokeLengthMm" DECIMAL(65,30),
    "maxStrokesPerMinute" INTEGER,
    "shutHeightMm" DECIMAL(65,30),
    "hallLocation" TEXT NOT NULL DEFAULT 'سالن پرس سنگین',
    "status" "MachineStatus" NOT NULL DEFAULT 'ACTIVE',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "machines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_capabilities" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "maxTonnage" DECIMAL(65,30),
    "minThicknessMm" DECIMAL(65,30),
    "maxThicknessMm" DECIMAL(65,30),
    "efficiencyFactor" DECIMAL(65,30) NOT NULL DEFAULT 1.0,
    "isPreferred" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,

    CONSTRAINT "machine_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dies" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "dieType" "DieType" NOT NULL,
    "tonnageRequired" DECIMAL(65,30) NOT NULL,
    "shutHeightMm" DECIMAL(65,30),
    "upperWeightKg" DECIMAL(65,30),
    "lowerWeightKg" DECIMAL(65,30),
    "totalWeightKg" DECIMAL(65,30),
    "totalStrokeTarget" INTEGER NOT NULL DEFAULT 200000,
    "currentStrokes" INTEGER NOT NULL DEFAULT 0,
    "lastMaintenanceStrokes" INTEGER NOT NULL DEFAULT 0,
    "strokesBetweenSharpening" INTEGER NOT NULL DEFAULT 25000,
    "status" "DieStatus" NOT NULL DEFAULT 'READY',
    "storageLocation" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_die_compatibilities" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "dieId" TEXT NOT NULL,
    "isOptimal" BOOLEAN NOT NULL DEFAULT true,
    "adapterPlateRequired" BOOLEAN NOT NULL DEFAULT false,
    "adapterPlateCode" TEXT,
    "clampingType" TEXT,
    "setupDifficulty" TEXT,
    "notes" TEXT,

    CONSTRAINT "machine_die_compatibilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouses" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "WarehouseType" NOT NULL,
    "address" TEXT,
    "managerName" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_locations" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "aisle" TEXT,
    "rack" TEXT,
    "shelf" TEXT,
    "bin" TEXT,
    "maxCapacityKg" DECIMAL(65,30),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "breakDurationMin" INTEGER NOT NULL DEFAULT 60,
    "productiveHours" DECIMAL(65,30) NOT NULL DEFAULT 7.5,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "commercialCode" TEXT,
    "nationalId" TEXT,
    "economicCode" TEXT,
    "phone" TEXT,
    "contactPerson" TEXT,
    "address" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_orders" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderDate" TIMESTAMP(3) NOT NULL,
    "requestedDeliveryDate" TIMESTAMP(3) NOT NULL,
    "customerContractNumber" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 2,
    "documentStatus" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "totalAmount" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_order_lines" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "orderedQty" DECIMAL(65,30) NOT NULL,
    "deliveredQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "unitPrice" DECIMAL(65,30),
    "requestedDate" TIMESTAMP(3) NOT NULL,
    "status" "OrderLineStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "customer_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_plans" (
    "id" TEXT NOT NULL,
    "planNumber" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" "PlanStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "proposalId" TEXT,

    CONSTRAINT "production_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_plan_proposals" (
    "id" TEXT NOT NULL,
    "proposalNumber" TEXT NOT NULL,
    "revisionGroupId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "PlanProposalStatus" NOT NULL DEFAULT 'DRAFT',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inputSnapshot" JSONB NOT NULL,
    "notes" TEXT,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "production_plan_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_plan_proposal_lines" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "customerOrderLineId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "requestedQty" DECIMAL(65,30) NOT NULL,
    "plannedQty" DECIMAL(65,30) NOT NULL,
    "plannedStartDate" TIMESTAMP(3) NOT NULL,
    "plannedEndDate" TIMESTAMP(3) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 2,
    "operationAssignments" JSONB NOT NULL,
    "warnings" JSONB,

    CONSTRAINT "production_plan_proposal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_plan_lines" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "customerOrderId" TEXT,
    "customerOrderLineId" TEXT,
    "plannedQty" DECIMAL(65,30) NOT NULL,
    "producedQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "plannedStartDate" TIMESTAMP(3) NOT NULL,
    "plannedEndDate" TIMESTAMP(3) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "status" "PlanLineStatus" NOT NULL DEFAULT 'PLANNED',

    CONSTRAINT "production_plan_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manufacturing_orders" (
    "id" TEXT NOT NULL,
    "moNumber" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "planId" TEXT,
    "planLineId" TEXT,
    "targetQty" DECIMAL(65,30) NOT NULL,
    "completedQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "scrapQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "scheduledStartDate" TIMESTAMP(3) NOT NULL,
    "scheduledEndDate" TIMESTAMP(3) NOT NULL,
    "actualStartDate" TIMESTAMP(3),
    "actualEndDate" TIMESTAMP(3),
    "priority" INTEGER NOT NULL DEFAULT 1,
    "status" "MOStatus" NOT NULL DEFAULT 'PLANNED',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manufacturing_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_operations" (
    "id" TEXT NOT NULL,
    "manufacturingOrderId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "routeOperationId" TEXT,
    "stepNumber" INTEGER NOT NULL,
    "plannedMachineId" TEXT,
    "plannedDieId" TEXT,
    "plannedQty" DECIMAL(65,30) NOT NULL,
    "inputQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "outputGoodQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "outputScrapQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "outputReworkQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "outputRejectedQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" "ProductionOpStatus" NOT NULL DEFAULT 'PENDING',
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),

    CONSTRAINT "production_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_reports" (
    "id" TEXT NOT NULL,
    "reportNumber" TEXT NOT NULL,
    "manufacturingOrderId" TEXT NOT NULL,
    "productionOperationId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "dieId" TEXT,
    "shiftId" TEXT NOT NULL,
    "operatorUserId" TEXT,
    "supervisorUserId" TEXT,
    "reportDate" TIMESTAMP(3) NOT NULL,
    "strokeCounterStart" INTEGER,
    "strokeCounterEnd" INTEGER,
    "goodQuantity" DECIMAL(65,30) NOT NULL,
    "scrapQuantity" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "reworkQuantity" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "rejectedQuantity" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "scrapReasonText" TEXT,
    "wipIdempotencyKey" TEXT,
    "runTimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "downtimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "downtimeReason" TEXT,
    "notes" TEXT,
    "documentStatus" "DocumentStatus" NOT NULL DEFAULT 'CONFIRMED',
    "postingStatus" "PostingStatus" NOT NULL DEFAULT 'POSTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_scraps" (
    "id" TEXT NOT NULL,
    "productionReportId" TEXT NOT NULL,
    "productionOperationId" TEXT NOT NULL,
    "scrapReason" "ScrapReason" NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "weightKg" DECIMAL(65,30) NOT NULL,
    "isRecoverable" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_scraps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_transfers" (
    "id" TEXT NOT NULL,
    "transferNumber" TEXT NOT NULL,
    "manufacturingOrderId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "fromStageOperationId" TEXT,
    "toStageOperationId" TEXT,
    "fromWarehouseId" TEXT NOT NULL,
    "toWarehouseId" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "unitId" TEXT NOT NULL,
    "dispatchedByUserId" TEXT,
    "dispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedByUserId" TEXT,
    "receivedAt" TIMESTAMP(3),
    "status" "TransferStatus" NOT NULL DEFAULT 'DISPATCHED',
    "inventoryDocId" TEXT,
    "notes" TEXT,

    CONSTRAINT "production_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_assignments" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "productionOperationId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "assignedDate" TIMESTAMP(3) NOT NULL,
    "assignedOperatorId" TEXT,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machine_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_documents" (
    "id" TEXT NOT NULL,
    "documentNumber" TEXT NOT NULL,
    "documentType" "InventoryDocType" NOT NULL,
    "documentDate" TIMESTAMP(3) NOT NULL,
    "documentStatus" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "postingStatus" "PostingStatus" NOT NULL DEFAULT 'UNPOSTED',
    "warehouseId" TEXT NOT NULL,
    "targetWarehouseId" TEXT,
    "referenceType" "DocReferenceType",
    "referenceNumber" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "postedByUserId" TEXT,
    "postedAt" TIMESTAMP(3),
    "isReversed" BOOLEAN NOT NULL DEFAULT false,
    "reversalOfId" TEXT,
    "issueRequestKey" TEXT,
    "issueRequestFingerprint" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_document_lines" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "partId" TEXT NOT NULL,
    "materialLotId" TEXT,
    "physicalCoilId" TEXT,
    "productionOperationId" TEXT,
    "locationId" TEXT,
    "targetLocationId" TEXT,
    "quantity" DECIMAL(65,30) NOT NULL,
    "unitId" TEXT NOT NULL,
    "weightKg" DECIMAL(65,30) NOT NULL,
    "ownership" TEXT NOT NULL DEFAULT 'COMPANY_OWNED',
    "contractId" TEXT,
    "contractNumber" TEXT,
    "qualityStatus" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "unitCost" DECIMAL(65,30),
    "notes" TEXT,

    CONSTRAINT "inventory_document_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_transactions" (
    "id" TEXT NOT NULL,
    "transactionNumber" TEXT NOT NULL,
    "documentId" TEXT,
    "documentLineId" TEXT,
    "partId" TEXT NOT NULL,
    "materialLotId" TEXT,
    "physicalCoilId" TEXT,
    "productionOperationId" TEXT,
    "warehouseId" TEXT NOT NULL,
    "locationId" TEXT,
    "transactionType" "TransactionType" NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "quantitySigned" DECIMAL(65,30) NOT NULL,
    "unitId" TEXT NOT NULL,
    "weightKg" DECIMAL(65,30) NOT NULL,
    "weightKgSigned" DECIMAL(65,30) NOT NULL,
    "ownership" TEXT NOT NULL DEFAULT 'COMPANY_OWNED',
    "contractId" TEXT,
    "contractNumber" TEXT,
    "qualityStatus" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "balanceAfter" DECIMAL(65,30),
    "balanceKgAfter" DECIMAL(65,30),
    "transactionDate" TIMESTAMP(3) NOT NULL,
    "postingStatus" "PostingStatus" NOT NULL DEFAULT 'POSTED',
    "isReversal" BOOLEAN NOT NULL DEFAULT false,
    "reversalOfTrxId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "productionReportId" TEXT,
    "manufacturingOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_reservations" (
    "id" TEXT NOT NULL,
    "reservationNumber" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "materialLotId" TEXT,
    "reservedForMOId" TEXT,
    "reservedForCOId" TEXT,
    "quantity" DECIMAL(65,30) NOT NULL,
    "weightKg" DECIMAL(65,30) NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "validUntil" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
    "id" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "locationId" TEXT,
    "materialLotId" TEXT,
    "physicalCoilId" TEXT,
    "quantityOnHand" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "quantityReserved" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "quantityAvailable" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "weightKgOnHand" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "weightKgReserved" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "weightKgAvailable" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "ownership" TEXT NOT NULL DEFAULT 'COMPANY_OWNED',
    "contractId" TEXT,
    "contractNumber" TEXT,
    "qualityStatus" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "lastTransactionAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_lots" (
    "id" TEXT NOT NULL,
    "lotNumber" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "partId" TEXT,
    "supplierContractId" TEXT,
    "heatNumber" TEXT,
    "coilSerialNumber" TEXT,
    "thicknessMm" DECIMAL(65,30) NOT NULL,
    "widthMm" DECIMAL(65,30) NOT NULL,
    "lengthMm" DECIMAL(65,30),
    "initialWeightKg" DECIMAL(65,30) NOT NULL,
    "remainingWeightKg" DECIMAL(65,30) NOT NULL,
    "warehouseLocationId" TEXT,
    "status" "LotStatus" NOT NULL DEFAULT 'AVAILABLE',
    "receivedDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "material_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_contracts" (
    "id" TEXT NOT NULL,
    "contractNumber" TEXT NOT NULL,
    "supplierCustomerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "totalAllocatedWeightKg" DECIMAL(65,30) NOT NULL,
    "receivedWeightKg" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" "ContractStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "material_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_contract_transactions" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "lotId" TEXT,
    "transactionType" "ContractTxType" NOT NULL,
    "weightKg" DECIMAL(65,30) NOT NULL,
    "waybillNumber" TEXT,
    "receiptDate" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_contract_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "personnelCode" TEXT,
    "passwordHash" TEXT,
    "roleId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityName" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "oldValues" JSONB,
    "newValues" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_sequences" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "currentValue" INTEGER NOT NULL DEFAULT 0,
    "step" INTEGER NOT NULL DEFAULT 1,
    "padding" INTEGER NOT NULL DEFAULT 4,
    "year" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'GENERAL',
    "description" TEXT,
    "isEncrypted" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "physical_coils" (
    "id" TEXT NOT NULL,
    "coilId" TEXT NOT NULL,
    "coilPackNumber" TEXT NOT NULL,
    "partId" TEXT,
    "materialId" TEXT,
    "materialLotId" TEXT,
    "heatNumber" TEXT,
    "thicknessMm" DECIMAL(65,30) NOT NULL,
    "widthMm" DECIMAL(65,30) NOT NULL,
    "originalWeightKg" DECIMAL(65,30) NOT NULL,
    "remainingWeightKg" DECIMAL(65,30) NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "warehouseLocationId" TEXT,
    "ownership" TEXT NOT NULL DEFAULT 'SAPCO_SUPPLIER_OWNED',
    "qualityStatus" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "physicalStatus" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "parentCoilId" TEXT,
    "supplierName" TEXT DEFAULT 'ساپکو (ایران‌خودرو)',
    "receiptDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "physical_coils_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_coil_allocations" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "coilId" TEXT NOT NULL,
    "allocatedWeightKg" DECIMAL(65,30) NOT NULL,
    "ownership" TEXT NOT NULL DEFAULT 'SAPCO_SUPPLIER_OWNED',
    "sourceDocumentId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_coil_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coil_issue_return_records" (
    "id" TEXT NOT NULL,
    "coilId" TEXT NOT NULL,
    "inventoryDocumentId" TEXT,
    "contractId" TEXT,
    "partId" TEXT,
    "productionOperationId" TEXT,
    "manufacturingOrderId" TEXT,
    "documentNumber" TEXT NOT NULL,
    "issuedWeightKg" DECIMAL(65,30) NOT NULL,
    "consumedWeightKg" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "returnedWeightKg" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "outstandingWeightKg" DECIMAL(65,30) NOT NULL,
    "varianceWeightKg" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "returnedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "coil_issue_return_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_tracking_profiles" (
    "id" TEXT NOT NULL,
    "itemCategory" "PartCategory" NOT NULL,
    "partId" TEXT,
    "requiresCoilPack" BOOLEAN NOT NULL DEFAULT false,
    "requiresCoilId" BOOLEAN NOT NULL DEFAULT false,
    "requiresHeatNumber" BOOLEAN NOT NULL DEFAULT false,
    "requiresBatchLot" BOOLEAN NOT NULL DEFAULT false,
    "requiresExpirationDate" BOOLEAN NOT NULL DEFAULT false,
    "requiresActualWeight" BOOLEAN NOT NULL DEFAULT false,
    "trackOwnership" BOOLEAN NOT NULL DEFAULT true,
    "trackContract" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "item_tracking_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_attribute_definitions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "dataType" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "isSearchable" BOOLEAN NOT NULL DEFAULT true,
    "isReportable" BOOLEAN NOT NULL DEFAULT true,
    "applicableCategories" JSONB NOT NULL,
    "validationRules" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_attribute_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_attribute_values" (
    "id" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "attributeKey" TEXT NOT NULL,
    "textValue" TEXT,
    "numberValue" DECIMAL(65,30),
    "dateValue" TIMESTAMP(3),
    "booleanValue" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_attribute_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_commercial_lines" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "lineType" TEXT NOT NULL,
    "partId" TEXT,
    "partCode" TEXT NOT NULL,
    "partName" TEXT NOT NULL,
    "contractQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "contractWeightKg" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "deliveredOrReceivedQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "deliveredOrReceivedKg" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "remainingQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "remainingKg" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT 'KG',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_commercial_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_report_configs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "reportType" TEXT NOT NULL,
    "selectedColumns" JSONB NOT NULL,
    "groupBy" JSONB NOT NULL,
    "filters" JSONB NOT NULL,
    "sortBy" TEXT,
    "sortOrder" TEXT DEFAULT 'asc',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_report_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" TEXT NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "templateType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'VALIDATING',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "importedBy" TEXT NOT NULL DEFAULT 'مدیر سیستم',
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_error_records" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "fieldName" TEXT,
    "errorMessage" TEXT NOT NULL,
    "rowData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_error_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_categories" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "master_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_items" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "master_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_logs" (
    "id" TEXT NOT NULL,
    "entityName" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "oldValues" JSONB,
    "newValues" JSONB,
    "reason" TEXT NOT NULL,
    "userId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menus" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "path" TEXT,
    "icon" TEXT,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "permissionCode" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "items" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "carModel" TEXT,
    "unitId" TEXT,
    "unit" TEXT DEFAULT 'PCS',
    "weightNetKg" DECIMAL(65,30),
    "weightGrossKg" DECIMAL(65,30),
    "minSafetyStock" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bom_components" (
    "id" TEXT NOT NULL,
    "parentItemId" TEXT NOT NULL,
    "childItemId" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL DEFAULT 1,
    "version" TEXT NOT NULL DEFAULT '1.0',
    "scrapFactor" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bom_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_centers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hallLocation" TEXT,
    "capacityPerHour" DECIMAL(65,30),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_centers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routing_operations" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "opNumber" INTEGER NOT NULL,
    "opCode" TEXT NOT NULL,
    "opName" TEXT NOT NULL,
    "workCenterId" TEXT NOT NULL,
    "requiresOpId" TEXT,
    "setupTimeMin" INTEGER NOT NULL DEFAULT 0,
    "cycleTimeSec" INTEGER NOT NULL DEFAULT 0,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routing_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_orders" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "plannedQuantity" DECIMAL(65,30) NOT NULL,
    "completedQuantity" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "scrapQuantity" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "actualStartDate" TIMESTAMP(3),
    "actualEndDate" TIMESTAMP(3),
    "notes" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_logs" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "goodQuantity" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "scrapQuantity" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "operatorId" TEXT,
    "isApproved" BOOLEAN NOT NULL DEFAULT false,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "logDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shiftName" TEXT,
    "notes" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "downtime_logs" (
    "id" TEXT NOT NULL,
    "workCenterId" TEXT NOT NULL,
    "downtimeReasonId" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "durationMinutes" INTEGER NOT NULL DEFAULT 0,
    "operatorNotes" TEXT,
    "isPlanned" BOOLEAN NOT NULL DEFAULT false,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "downtime_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wip_state_snapshots" (
    "id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wip_state_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_app_state_snapshots" (
    "id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_app_state_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wip_manufacturing_order_links" (
    "id" TEXT NOT NULL,
    "wipManufacturingOrderId" TEXT NOT NULL,
    "manufacturingOrderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "notes" TEXT,

    CONSTRAINT "wip_manufacturing_order_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wip_operation_links" (
    "id" TEXT NOT NULL,
    "wipOperationId" TEXT NOT NULL,
    "manufacturingOrderLinkId" TEXT NOT NULL,
    "productionOperationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wip_operation_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "units_of_measure_code_key" ON "units_of_measure"("code");

-- CreateIndex
CREATE UNIQUE INDEX "materials_code_key" ON "materials"("code");

-- CreateIndex
CREATE UNIQUE INDEX "parts_partNumber_key" ON "parts"("partNumber");

-- CreateIndex
CREATE INDEX "parts_category_active_idx" ON "parts"("category", "active");

-- CreateIndex
CREATE INDEX "parts_carModel_idx" ON "parts"("carModel");

-- CreateIndex
CREATE UNIQUE INDEX "operations_code_key" ON "operations"("code");

-- CreateIndex
CREATE INDEX "part_routes_partId_status_idx" ON "part_routes"("partId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "part_routes_partId_version_key" ON "part_routes"("partId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "route_operations_routeId_stepNumber_key" ON "route_operations"("routeId", "stepNumber");

-- CreateIndex
CREATE UNIQUE INDEX "machines_code_key" ON "machines"("code");

-- CreateIndex
CREATE INDEX "machines_machineType_status_idx" ON "machines"("machineType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "machine_capabilities_machineId_operationId_key" ON "machine_capabilities"("machineId", "operationId");

-- CreateIndex
CREATE UNIQUE INDEX "dies_code_key" ON "dies"("code");

-- CreateIndex
CREATE INDEX "dies_partId_status_idx" ON "dies"("partId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "machine_die_compatibilities_machineId_dieId_key" ON "machine_die_compatibilities"("machineId", "dieId");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_code_key" ON "warehouses"("code");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_locations_warehouseId_code_key" ON "warehouse_locations"("warehouseId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "shifts_code_key" ON "shifts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "customers_code_key" ON "customers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "customer_orders_orderNumber_key" ON "customer_orders"("orderNumber");

-- CreateIndex
CREATE INDEX "customer_orders_customerId_documentStatus_idx" ON "customer_orders"("customerId", "documentStatus");

-- CreateIndex
CREATE INDEX "customer_order_lines_partId_status_idx" ON "customer_order_lines"("partId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "customer_order_lines_orderId_lineNumber_key" ON "customer_order_lines"("orderId", "lineNumber");

-- CreateIndex
CREATE UNIQUE INDEX "production_plans_planNumber_key" ON "production_plans"("planNumber");

-- CreateIndex
CREATE UNIQUE INDEX "production_plans_proposalId_key" ON "production_plans"("proposalId");

-- CreateIndex
CREATE INDEX "production_plans_status_startDate_idx" ON "production_plans"("status", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "production_plan_proposals_proposalNumber_key" ON "production_plan_proposals"("proposalNumber");

-- CreateIndex
CREATE INDEX "production_plan_proposals_status_generatedAt_idx" ON "production_plan_proposals"("status", "generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "production_plan_proposals_revisionGroupId_version_key" ON "production_plan_proposals"("revisionGroupId", "version");

-- CreateIndex
CREATE INDEX "production_plan_proposal_lines_partId_plannedStartDate_idx" ON "production_plan_proposal_lines"("partId", "plannedStartDate");

-- CreateIndex
CREATE UNIQUE INDEX "production_plan_proposal_lines_proposalId_customerOrderLine_key" ON "production_plan_proposal_lines"("proposalId", "customerOrderLineId");

-- CreateIndex
CREATE INDEX "production_plan_lines_partId_status_idx" ON "production_plan_lines"("partId", "status");

-- CreateIndex
CREATE INDEX "production_plan_lines_customerOrderLineId_idx" ON "production_plan_lines"("customerOrderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "manufacturing_orders_moNumber_key" ON "manufacturing_orders"("moNumber");

-- CreateIndex
CREATE INDEX "manufacturing_orders_partId_status_idx" ON "manufacturing_orders"("partId", "status");

-- CreateIndex
CREATE INDEX "manufacturing_orders_scheduledStartDate_scheduledEndDate_idx" ON "manufacturing_orders"("scheduledStartDate", "scheduledEndDate");

-- CreateIndex
CREATE INDEX "production_operations_status_idx" ON "production_operations"("status");

-- CreateIndex
CREATE UNIQUE INDEX "production_operations_manufacturingOrderId_stepNumber_key" ON "production_operations"("manufacturingOrderId", "stepNumber");

-- CreateIndex
CREATE UNIQUE INDEX "production_reports_reportNumber_key" ON "production_reports"("reportNumber");

-- CreateIndex
CREATE UNIQUE INDEX "production_reports_wipIdempotencyKey_key" ON "production_reports"("wipIdempotencyKey");

-- CreateIndex
CREATE INDEX "production_reports_manufacturingOrderId_reportDate_idx" ON "production_reports"("manufacturingOrderId", "reportDate");

-- CreateIndex
CREATE INDEX "production_reports_machineId_reportDate_idx" ON "production_reports"("machineId", "reportDate");

-- CreateIndex
CREATE INDEX "production_scraps_productionReportId_idx" ON "production_scraps"("productionReportId");

-- CreateIndex
CREATE INDEX "production_scraps_scrapReason_idx" ON "production_scraps"("scrapReason");

-- CreateIndex
CREATE UNIQUE INDEX "production_transfers_transferNumber_key" ON "production_transfers"("transferNumber");

-- CreateIndex
CREATE INDEX "production_transfers_partId_status_idx" ON "production_transfers"("partId", "status");

-- CreateIndex
CREATE INDEX "machine_assignments_machineId_assignedDate_shiftId_idx" ON "machine_assignments"("machineId", "assignedDate", "shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_documents_documentNumber_key" ON "inventory_documents"("documentNumber");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_documents_reversalOfId_key" ON "inventory_documents"("reversalOfId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_documents_issueRequestKey_key" ON "inventory_documents"("issueRequestKey");

-- CreateIndex
CREATE INDEX "inventory_documents_documentType_documentDate_idx" ON "inventory_documents"("documentType", "documentDate");

-- CreateIndex
CREATE INDEX "inventory_documents_warehouseId_postingStatus_idx" ON "inventory_documents"("warehouseId", "postingStatus");

-- CreateIndex
CREATE INDEX "inventory_document_lines_partId_materialLotId_idx" ON "inventory_document_lines"("partId", "materialLotId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_document_lines_documentId_lineNumber_key" ON "inventory_document_lines"("documentId", "lineNumber");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_transactions_transactionNumber_key" ON "inventory_transactions"("transactionNumber");

-- CreateIndex
CREATE INDEX "inventory_transactions_partId_warehouseId_transactionDate_idx" ON "inventory_transactions"("partId", "warehouseId", "transactionDate");

-- CreateIndex
CREATE INDEX "inventory_transactions_warehouseId_transactionDate_idx" ON "inventory_transactions"("warehouseId", "transactionDate");

-- CreateIndex
CREATE INDEX "inventory_transactions_materialLotId_idx" ON "inventory_transactions"("materialLotId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reservations_reservationNumber_key" ON "inventory_reservations"("reservationNumber");

-- CreateIndex
CREATE INDEX "inventory_reservations_partId_warehouseId_status_idx" ON "inventory_reservations"("partId", "warehouseId", "status");

-- CreateIndex
CREATE INDEX "stock_balances_partId_warehouseId_idx" ON "stock_balances"("partId", "warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_balances_partId_warehouseId_locationId_materialLotId__key" ON "stock_balances"("partId", "warehouseId", "locationId", "materialLotId", "physicalCoilId", "ownership", "contractId", "qualityStatus");

-- CreateIndex
CREATE UNIQUE INDEX "material_lots_lotNumber_key" ON "material_lots"("lotNumber");

-- CreateIndex
CREATE INDEX "material_lots_materialId_status_idx" ON "material_lots"("materialId", "status");

-- CreateIndex
CREATE INDEX "material_lots_heatNumber_idx" ON "material_lots"("heatNumber");

-- CreateIndex
CREATE UNIQUE INDEX "material_contracts_contractNumber_key" ON "material_contracts"("contractNumber");

-- CreateIndex
CREATE INDEX "material_contracts_supplierCustomerId_status_idx" ON "material_contracts"("supplierCustomerId", "status");

-- CreateIndex
CREATE INDEX "material_contract_transactions_contractId_receiptDate_idx" ON "material_contract_transactions"("contractId", "receiptDate");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_personnelCode_key" ON "users"("personnelCode");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_roleId_permissionId_key" ON "role_permissions"("roleId", "permissionId");

-- CreateIndex
CREATE INDEX "audit_logs_entityName_entityId_idx" ON "audit_logs"("entityName", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_userId_timestamp_idx" ON "audit_logs"("userId", "timestamp");

-- CreateIndex
CREATE INDEX "audit_logs_action_timestamp_idx" ON "audit_logs"("action", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "document_sequences_code_key" ON "document_sequences"("code");

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_key_key" ON "system_settings"("key");

-- CreateIndex
CREATE UNIQUE INDEX "physical_coils_coilId_key" ON "physical_coils"("coilId");

-- CreateIndex
CREATE INDEX "physical_coils_coilPackNumber_idx" ON "physical_coils"("coilPackNumber");

-- CreateIndex
CREATE INDEX "physical_coils_warehouseId_physicalStatus_idx" ON "physical_coils"("warehouseId", "physicalStatus");

-- CreateIndex
CREATE INDEX "physical_coils_heatNumber_idx" ON "physical_coils"("heatNumber");

-- CreateIndex
CREATE INDEX "contract_coil_allocations_contractId_idx" ON "contract_coil_allocations"("contractId");

-- CreateIndex
CREATE INDEX "contract_coil_allocations_coilId_idx" ON "contract_coil_allocations"("coilId");

-- CreateIndex
CREATE UNIQUE INDEX "contract_coil_allocations_contractId_coilId_key" ON "contract_coil_allocations"("contractId", "coilId");

-- CreateIndex
CREATE INDEX "coil_issue_return_records_coilId_status_idx" ON "coil_issue_return_records"("coilId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "item_tracking_profiles_partId_key" ON "item_tracking_profiles"("partId");

-- CreateIndex
CREATE UNIQUE INDEX "item_attribute_definitions_key_key" ON "item_attribute_definitions"("key");

-- CreateIndex
CREATE UNIQUE INDEX "item_attribute_values_partId_attributeKey_key" ON "item_attribute_values"("partId", "attributeKey");

-- CreateIndex
CREATE INDEX "contract_commercial_lines_contractId_lineType_idx" ON "contract_commercial_lines"("contractId", "lineType");

-- CreateIndex
CREATE UNIQUE INDEX "import_batches_batchNumber_key" ON "import_batches"("batchNumber");

-- CreateIndex
CREATE INDEX "import_error_records_batchId_rowNumber_idx" ON "import_error_records"("batchId", "rowNumber");

-- CreateIndex
CREATE UNIQUE INDEX "master_categories_code_key" ON "master_categories"("code");

-- CreateIndex
CREATE INDEX "master_items_categoryId_isActive_idx" ON "master_items"("categoryId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "master_items_categoryId_code_key" ON "master_items"("categoryId", "code");

-- CreateIndex
CREATE INDEX "action_logs_entityName_entityId_idx" ON "action_logs"("entityName", "entityId");

-- CreateIndex
CREATE INDEX "action_logs_actionType_createdAt_idx" ON "action_logs"("actionType", "createdAt");

-- CreateIndex
CREATE INDEX "menus_parentId_orderIndex_idx" ON "menus"("parentId", "orderIndex");

-- CreateIndex
CREATE UNIQUE INDEX "items_code_key" ON "items"("code");

-- CreateIndex
CREATE INDEX "items_type_isDeleted_idx" ON "items"("type", "isDeleted");

-- CreateIndex
CREATE INDEX "items_code_idx" ON "items"("code");

-- CreateIndex
CREATE INDEX "bom_components_parentItemId_idx" ON "bom_components"("parentItemId");

-- CreateIndex
CREATE INDEX "bom_components_childItemId_idx" ON "bom_components"("childItemId");

-- CreateIndex
CREATE UNIQUE INDEX "bom_components_parentItemId_childItemId_version_key" ON "bom_components"("parentItemId", "childItemId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "work_centers_code_key" ON "work_centers"("code");

-- CreateIndex
CREATE INDEX "work_centers_status_isDeleted_idx" ON "work_centers"("status", "isDeleted");

-- CreateIndex
CREATE INDEX "routing_operations_itemId_idx" ON "routing_operations"("itemId");

-- CreateIndex
CREATE INDEX "routing_operations_workCenterId_idx" ON "routing_operations"("workCenterId");

-- CreateIndex
CREATE UNIQUE INDEX "routing_operations_itemId_opNumber_key" ON "routing_operations"("itemId", "opNumber");

-- CreateIndex
CREATE UNIQUE INDEX "work_orders_orderNumber_key" ON "work_orders"("orderNumber");

-- CreateIndex
CREATE INDEX "work_orders_itemId_status_idx" ON "work_orders"("itemId", "status");

-- CreateIndex
CREATE INDEX "work_orders_startDate_endDate_idx" ON "work_orders"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "production_logs_workOrderId_operationId_idx" ON "production_logs"("workOrderId", "operationId");

-- CreateIndex
CREATE INDEX "production_logs_logDate_idx" ON "production_logs"("logDate");

-- CreateIndex
CREATE INDEX "downtime_logs_workCenterId_startTime_idx" ON "downtime_logs"("workCenterId", "startTime");

-- CreateIndex
CREATE INDEX "downtime_logs_downtimeReasonId_idx" ON "downtime_logs"("downtimeReasonId");

-- CreateIndex
CREATE UNIQUE INDEX "wip_manufacturing_order_links_wipManufacturingOrderId_key" ON "wip_manufacturing_order_links"("wipManufacturingOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "wip_manufacturing_order_links_manufacturingOrderId_key" ON "wip_manufacturing_order_links"("manufacturingOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "wip_operation_links_wipOperationId_key" ON "wip_operation_links"("wipOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "wip_operation_links_productionOperationId_key" ON "wip_operation_links"("productionOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "wip_operation_links_manufacturingOrderLinkId_productionOper_key" ON "wip_operation_links"("manufacturingOrderLinkId", "productionOperationId");

-- AddForeignKey
ALTER TABLE "parts" ADD CONSTRAINT "parts_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parts" ADD CONSTRAINT "parts_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_routes" ADD CONSTRAINT "part_routes_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_operations" ADD CONSTRAINT "route_operations_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "part_routes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_operations" ADD CONSTRAINT "route_operations_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_operations" ADD CONSTRAINT "route_operations_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_operations" ADD CONSTRAINT "route_operations_dieId_fkey" FOREIGN KEY ("dieId") REFERENCES "dies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_capabilities" ADD CONSTRAINT "machine_capabilities_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_capabilities" ADD CONSTRAINT "machine_capabilities_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dies" ADD CONSTRAINT "dies_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_die_compatibilities" ADD CONSTRAINT "machine_die_compatibilities_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_die_compatibilities" ADD CONSTRAINT "machine_die_compatibilities_dieId_fkey" FOREIGN KEY ("dieId") REFERENCES "dies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_locations" ADD CONSTRAINT "warehouse_locations_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_order_lines" ADD CONSTRAINT "customer_order_lines_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "customer_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_order_lines" ADD CONSTRAINT "customer_order_lines_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_plans" ADD CONSTRAINT "production_plans_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "production_plan_proposals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_plan_proposal_lines" ADD CONSTRAINT "production_plan_proposal_lines_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "production_plan_proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_plan_proposal_lines" ADD CONSTRAINT "production_plan_proposal_lines_customerOrderLineId_fkey" FOREIGN KEY ("customerOrderLineId") REFERENCES "customer_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_plan_proposal_lines" ADD CONSTRAINT "production_plan_proposal_lines_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_plan_proposal_lines" ADD CONSTRAINT "production_plan_proposal_lines_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "part_routes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_plan_lines" ADD CONSTRAINT "production_plan_lines_planId_fkey" FOREIGN KEY ("planId") REFERENCES "production_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_plan_lines" ADD CONSTRAINT "production_plan_lines_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_plan_lines" ADD CONSTRAINT "production_plan_lines_customerOrderId_fkey" FOREIGN KEY ("customerOrderId") REFERENCES "customer_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_plan_lines" ADD CONSTRAINT "production_plan_lines_customerOrderLineId_fkey" FOREIGN KEY ("customerOrderLineId") REFERENCES "customer_order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manufacturing_orders" ADD CONSTRAINT "manufacturing_orders_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manufacturing_orders" ADD CONSTRAINT "manufacturing_orders_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "part_routes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manufacturing_orders" ADD CONSTRAINT "manufacturing_orders_planId_fkey" FOREIGN KEY ("planId") REFERENCES "production_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manufacturing_orders" ADD CONSTRAINT "manufacturing_orders_planLineId_fkey" FOREIGN KEY ("planLineId") REFERENCES "production_plan_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_operations" ADD CONSTRAINT "production_operations_manufacturingOrderId_fkey" FOREIGN KEY ("manufacturingOrderId") REFERENCES "manufacturing_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_operations" ADD CONSTRAINT "production_operations_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_operations" ADD CONSTRAINT "production_operations_routeOperationId_fkey" FOREIGN KEY ("routeOperationId") REFERENCES "route_operations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_operations" ADD CONSTRAINT "production_operations_plannedMachineId_fkey" FOREIGN KEY ("plannedMachineId") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_operations" ADD CONSTRAINT "production_operations_plannedDieId_fkey" FOREIGN KEY ("plannedDieId") REFERENCES "dies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_reports" ADD CONSTRAINT "production_reports_manufacturingOrderId_fkey" FOREIGN KEY ("manufacturingOrderId") REFERENCES "manufacturing_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_reports" ADD CONSTRAINT "production_reports_productionOperationId_fkey" FOREIGN KEY ("productionOperationId") REFERENCES "production_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_reports" ADD CONSTRAINT "production_reports_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_reports" ADD CONSTRAINT "production_reports_dieId_fkey" FOREIGN KEY ("dieId") REFERENCES "dies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_reports" ADD CONSTRAINT "production_reports_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_reports" ADD CONSTRAINT "production_reports_operatorUserId_fkey" FOREIGN KEY ("operatorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_reports" ADD CONSTRAINT "production_reports_supervisorUserId_fkey" FOREIGN KEY ("supervisorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_scraps" ADD CONSTRAINT "production_scraps_productionReportId_fkey" FOREIGN KEY ("productionReportId") REFERENCES "production_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_scraps" ADD CONSTRAINT "production_scraps_productionOperationId_fkey" FOREIGN KEY ("productionOperationId") REFERENCES "production_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_transfers" ADD CONSTRAINT "production_transfers_manufacturingOrderId_fkey" FOREIGN KEY ("manufacturingOrderId") REFERENCES "manufacturing_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_transfers" ADD CONSTRAINT "production_transfers_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_transfers" ADD CONSTRAINT "production_transfers_fromWarehouseId_fkey" FOREIGN KEY ("fromWarehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_transfers" ADD CONSTRAINT "production_transfers_toWarehouseId_fkey" FOREIGN KEY ("toWarehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_transfers" ADD CONSTRAINT "production_transfers_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_assignments" ADD CONSTRAINT "machine_assignments_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_assignments" ADD CONSTRAINT "machine_assignments_productionOperationId_fkey" FOREIGN KEY ("productionOperationId") REFERENCES "production_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_assignments" ADD CONSTRAINT "machine_assignments_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_assignments" ADD CONSTRAINT "machine_assignments_assignedOperatorId_fkey" FOREIGN KEY ("assignedOperatorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_documents" ADD CONSTRAINT "inventory_documents_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_documents" ADD CONSTRAINT "inventory_documents_targetWarehouseId_fkey" FOREIGN KEY ("targetWarehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_documents" ADD CONSTRAINT "inventory_documents_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_document_lines" ADD CONSTRAINT "inventory_document_lines_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "inventory_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_document_lines" ADD CONSTRAINT "inventory_document_lines_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_document_lines" ADD CONSTRAINT "inventory_document_lines_materialLotId_fkey" FOREIGN KEY ("materialLotId") REFERENCES "material_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_document_lines" ADD CONSTRAINT "inventory_document_lines_physicalCoilId_fkey" FOREIGN KEY ("physicalCoilId") REFERENCES "physical_coils"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_document_lines" ADD CONSTRAINT "inventory_document_lines_productionOperationId_fkey" FOREIGN KEY ("productionOperationId") REFERENCES "production_operations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_document_lines" ADD CONSTRAINT "inventory_document_lines_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "warehouse_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_document_lines" ADD CONSTRAINT "inventory_document_lines_targetLocationId_fkey" FOREIGN KEY ("targetLocationId") REFERENCES "warehouse_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_document_lines" ADD CONSTRAINT "inventory_document_lines_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "inventory_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_materialLotId_fkey" FOREIGN KEY ("materialLotId") REFERENCES "material_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_physicalCoilId_fkey" FOREIGN KEY ("physicalCoilId") REFERENCES "physical_coils"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_productionOperationId_fkey" FOREIGN KEY ("productionOperationId") REFERENCES "production_operations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "warehouse_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_productionReportId_fkey" FOREIGN KEY ("productionReportId") REFERENCES "production_reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_manufacturingOrderId_fkey" FOREIGN KEY ("manufacturingOrderId") REFERENCES "manufacturing_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_materialLotId_fkey" FOREIGN KEY ("materialLotId") REFERENCES "material_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_reservedForMOId_fkey" FOREIGN KEY ("reservedForMOId") REFERENCES "manufacturing_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_reservedForCOId_fkey" FOREIGN KEY ("reservedForCOId") REFERENCES "customer_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "warehouse_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_materialLotId_fkey" FOREIGN KEY ("materialLotId") REFERENCES "material_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_physicalCoilId_fkey" FOREIGN KEY ("physicalCoilId") REFERENCES "physical_coils"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_lots" ADD CONSTRAINT "material_lots_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_lots" ADD CONSTRAINT "material_lots_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_lots" ADD CONSTRAINT "material_lots_supplierContractId_fkey" FOREIGN KEY ("supplierContractId") REFERENCES "material_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_lots" ADD CONSTRAINT "material_lots_warehouseLocationId_fkey" FOREIGN KEY ("warehouseLocationId") REFERENCES "warehouse_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_contracts" ADD CONSTRAINT "material_contracts_supplierCustomerId_fkey" FOREIGN KEY ("supplierCustomerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_contracts" ADD CONSTRAINT "material_contracts_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_contract_transactions" ADD CONSTRAINT "material_contract_transactions_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "material_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_contract_transactions" ADD CONSTRAINT "material_contract_transactions_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "material_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "physical_coils" ADD CONSTRAINT "physical_coils_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "physical_coils" ADD CONSTRAINT "physical_coils_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "physical_coils" ADD CONSTRAINT "physical_coils_materialLotId_fkey" FOREIGN KEY ("materialLotId") REFERENCES "material_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "physical_coils" ADD CONSTRAINT "physical_coils_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "physical_coils" ADD CONSTRAINT "physical_coils_warehouseLocationId_fkey" FOREIGN KEY ("warehouseLocationId") REFERENCES "warehouse_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "physical_coils" ADD CONSTRAINT "physical_coils_parentCoilId_fkey" FOREIGN KEY ("parentCoilId") REFERENCES "physical_coils"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_coil_allocations" ADD CONSTRAINT "contract_coil_allocations_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "material_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_coil_allocations" ADD CONSTRAINT "contract_coil_allocations_coilId_fkey" FOREIGN KEY ("coilId") REFERENCES "physical_coils"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coil_issue_return_records" ADD CONSTRAINT "coil_issue_return_records_coilId_fkey" FOREIGN KEY ("coilId") REFERENCES "physical_coils"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coil_issue_return_records" ADD CONSTRAINT "coil_issue_return_records_inventoryDocumentId_fkey" FOREIGN KEY ("inventoryDocumentId") REFERENCES "inventory_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coil_issue_return_records" ADD CONSTRAINT "coil_issue_return_records_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "material_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coil_issue_return_records" ADD CONSTRAINT "coil_issue_return_records_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coil_issue_return_records" ADD CONSTRAINT "coil_issue_return_records_productionOperationId_fkey" FOREIGN KEY ("productionOperationId") REFERENCES "production_operations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coil_issue_return_records" ADD CONSTRAINT "coil_issue_return_records_manufacturingOrderId_fkey" FOREIGN KEY ("manufacturingOrderId") REFERENCES "manufacturing_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_tracking_profiles" ADD CONSTRAINT "item_tracking_profiles_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_attribute_values" ADD CONSTRAINT "item_attribute_values_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_commercial_lines" ADD CONSTRAINT "contract_commercial_lines_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "material_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_error_records" ADD CONSTRAINT "import_error_records_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_items" ADD CONSTRAINT "master_items_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "master_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menus" ADD CONSTRAINT "menus_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "menus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_components" ADD CONSTRAINT "bom_components_parentItemId_fkey" FOREIGN KEY ("parentItemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_components" ADD CONSTRAINT "bom_components_childItemId_fkey" FOREIGN KEY ("childItemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_operations" ADD CONSTRAINT "routing_operations_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_operations" ADD CONSTRAINT "routing_operations_workCenterId_fkey" FOREIGN KEY ("workCenterId") REFERENCES "work_centers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_operations" ADD CONSTRAINT "routing_operations_requiresOpId_fkey" FOREIGN KEY ("requiresOpId") REFERENCES "routing_operations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_logs" ADD CONSTRAINT "production_logs_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_logs" ADD CONSTRAINT "production_logs_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "routing_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "downtime_logs" ADD CONSTRAINT "downtime_logs_workCenterId_fkey" FOREIGN KEY ("workCenterId") REFERENCES "work_centers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "downtime_logs" ADD CONSTRAINT "downtime_logs_downtimeReasonId_fkey" FOREIGN KEY ("downtimeReasonId") REFERENCES "master_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wip_manufacturing_order_links" ADD CONSTRAINT "wip_manufacturing_order_links_manufacturingOrderId_fkey" FOREIGN KEY ("manufacturingOrderId") REFERENCES "manufacturing_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wip_operation_links" ADD CONSTRAINT "wip_operation_links_manufacturingOrderLinkId_fkey" FOREIGN KEY ("manufacturingOrderLinkId") REFERENCES "wip_manufacturing_order_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wip_operation_links" ADD CONSTRAINT "wip_operation_links_productionOperationId_fkey" FOREIGN KEY ("productionOperationId") REFERENCES "production_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

