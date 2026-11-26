-- =========================================================================
-- KPIMS P6: Quality Management Relational Persistence Migration
-- =========================================================================
-- Persists inspections (IQC/IPQC/FQC), NCRs, MRB dispositions, rework orders,
-- quality status snapshots, and restart-safe idempotency records in PostgreSQL
-- with foreign-key links to parts, warehouses, lots, coils, contracts,
-- manufacturing orders, production operations, and inventory/QM documents.
--
-- NOTE: Intentionally does NOT alter `stock_balances` or its NULLS NOT DISTINCT
-- unique index established in 20261125070000_inventory_p0a_constraints_and_ledger_hardening.
-- =========================================================================

-- CreateEnum
CREATE TYPE "QualityInspectionType" AS ENUM ('INCOMING_MATERIAL', 'IN_PROCESS', 'FINAL_PRODUCT');

-- CreateEnum
CREATE TYPE "QualityInspectionStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "QualityDecision" AS ENUM ('PENDING', 'ACCEPTED', 'ACCEPTED_WITH_CONCESSION', 'QUARANTINED', 'REJECTED');

-- CreateEnum
CREATE TYPE "NonconformanceSeverity" AS ENUM ('MINOR', 'MAJOR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "NonconformanceCategory" AS ENUM ('DIMENSIONAL', 'SURFACE_DEFECT', 'MATERIAL_PROPERTY', 'WELDING', 'COATING_PAINT', 'BURR_CRACK', 'PACKAGING_LABEL', 'OTHER');

-- CreateEnum
CREATE TYPE "NcrSourceType" AS ENUM ('INCOMING_MATERIAL', 'IN_PROCESS', 'FINAL_PRODUCT', 'WAREHOUSE_AUDIT', 'CUSTOMER_COMPLAINT');

-- CreateEnum
CREATE TYPE "NcrStatus" AS ENUM ('OPEN', 'CONTAINED', 'DISPOSITIONED', 'IN_REWORK', 'CLOSED');

-- CreateEnum
CREATE TYPE "NcrDispositionAction" AS ENUM ('PENDING', 'USE_AS_IS', 'REWORK', 'SCRAP', 'RETURN_TO_SUPPLIER', 'SORT_REINSPECT');

-- CreateEnum
CREATE TYPE "ReworkOrderStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateTable: quality_inspections
CREATE TABLE "quality_inspections" (
    "id" TEXT NOT NULL,
    "inspectionNumber" TEXT NOT NULL,
    "inspectionType" "QualityInspectionType" NOT NULL,
    "status" "QualityInspectionStatus" NOT NULL DEFAULT 'PENDING',
    "decision" "QualityDecision" NOT NULL DEFAULT 'PENDING',
    "resultingQualityStatus" TEXT,
    "partId" TEXT,
    "partRefId" TEXT NOT NULL,
    "partCode" TEXT NOT NULL,
    "partName" TEXT NOT NULL,
    "warehouseId" TEXT,
    "warehouseRefId" TEXT,
    "warehouseName" TEXT,
    "locationCode" TEXT,
    "balanceId" TEXT,
    "materialLotId" TEXT,
    "lotNumber" TEXT,
    "heatNumber" TEXT,
    "physicalCoilId" TEXT,
    "coilRefId" TEXT,
    "coilId" TEXT,
    "coilPackNumber" TEXT,
    "manufacturingOrderId" TEXT,
    "moRefId" TEXT,
    "moNumber" TEXT,
    "productionOperationId" TEXT,
    "operationRefId" TEXT,
    "operationCode" TEXT,
    "operationName" TEXT,
    "materialContractId" TEXT,
    "contractRefId" TEXT,
    "contractNumber" TEXT,
    "supplierName" TEXT,
    "ownership" TEXT,
    "sourceDocumentNumber" TEXT,
    "inspectedQty" DECIMAL(65,30) NOT NULL,
    "acceptedQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "rejectedQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "reworkQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL,
    "weightKg" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "checklist" JSONB NOT NULL,
    "defectCodes" JSONB NOT NULL,
    "defectCategory" "NonconformanceCategory",
    "defectSummary" TEXT,
    "notes" TEXT,
    "linkedQmDocumentId" TEXT,
    "linkedQmDocumentNumber" TEXT,
    "linkedNcrId" TEXT,
    "linkedNcrNumber" TEXT,
    "inspectorUid" TEXT NOT NULL,
    "inspectorName" TEXT NOT NULL,
    "inspectedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quality_inspections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quality_inspections_qty_nonneg_chk" CHECK (
        "inspectedQty" > 0 AND "acceptedQty" >= 0 AND "rejectedQty" >= 0 AND "reworkQty" >= 0 AND "weightKg" >= 0
    )
);

-- CreateTable: quality_nonconformances
CREATE TABLE "quality_nonconformances" (
    "id" TEXT NOT NULL,
    "ncrNumber" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sourceType" "NcrSourceType" NOT NULL,
    "severity" "NonconformanceSeverity" NOT NULL,
    "category" "NonconformanceCategory" NOT NULL,
    "defectCode" TEXT NOT NULL,
    "defectLabelFa" TEXT NOT NULL,
    "status" "NcrStatus" NOT NULL DEFAULT 'OPEN',
    "disposition" "NcrDispositionAction" NOT NULL DEFAULT 'PENDING',
    "resultingQualityStatus" TEXT,
    "inspectionId" TEXT,
    "inspectionNumber" TEXT,
    "partId" TEXT,
    "partRefId" TEXT NOT NULL,
    "partCode" TEXT NOT NULL,
    "partName" TEXT NOT NULL,
    "warehouseId" TEXT,
    "warehouseRefId" TEXT,
    "warehouseName" TEXT,
    "locationCode" TEXT,
    "balanceId" TEXT,
    "materialLotId" TEXT,
    "lotNumber" TEXT,
    "heatNumber" TEXT,
    "physicalCoilId" TEXT,
    "coilRefId" TEXT,
    "coilId" TEXT,
    "coilPackNumber" TEXT,
    "manufacturingOrderId" TEXT,
    "moRefId" TEXT,
    "moNumber" TEXT,
    "productionOperationId" TEXT,
    "operationRefId" TEXT,
    "operationCode" TEXT,
    "operationName" TEXT,
    "materialContractId" TEXT,
    "contractRefId" TEXT,
    "contractNumber" TEXT,
    "supplierName" TEXT,
    "ownership" TEXT,
    "affectedQty" DECIMAL(65,30) NOT NULL,
    "containedQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "reworkedGoodQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "scrappedQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "returnedToProductionQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "returnedToSupplierQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL,
    "weightKg" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "containmentAction" TEXT,
    "containedAt" TIMESTAMP(3),
    "containedByName" TEXT,
    "containmentQmDocId" TEXT,
    "containmentQmDocNumber" TEXT,
    "rootCause" TEXT,
    "correctiveAction" TEXT,
    "dispositionNotes" TEXT,
    "dispositionedAt" TIMESTAMP(3),
    "dispositionedByName" TEXT,
    "dispositionDocId" TEXT,
    "dispositionDocNumber" TEXT,
    "linkedReworkOrderId" TEXT,
    "linkedReworkNumber" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedByName" TEXT,
    "createdByUid" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quality_nonconformances_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quality_nonconformances_qty_nonneg_chk" CHECK (
        "affectedQty" > 0
        AND "containedQty" >= 0
        AND "reworkedGoodQty" >= 0
        AND "scrappedQty" >= 0
        AND "returnedToProductionQty" >= 0
        AND "returnedToSupplierQty" >= 0
        AND "weightKg" >= 0
    )
);

-- CreateTable: quality_rework_orders
CREATE TABLE "quality_rework_orders" (
    "id" TEXT NOT NULL,
    "reworkNumber" TEXT NOT NULL,
    "ncrId" TEXT NOT NULL,
    "ncrNumber" TEXT NOT NULL,
    "inspectionId" TEXT,
    "partId" TEXT,
    "partRefId" TEXT NOT NULL,
    "partCode" TEXT NOT NULL,
    "partName" TEXT NOT NULL,
    "warehouseId" TEXT,
    "warehouseRefId" TEXT,
    "locationCode" TEXT,
    "balanceId" TEXT,
    "materialLotId" TEXT,
    "lotNumber" TEXT,
    "physicalCoilId" TEXT,
    "coilRefId" TEXT,
    "coilId" TEXT,
    "manufacturingOrderId" TEXT,
    "moRefId" TEXT,
    "moNumber" TEXT,
    "productionOperationId" TEXT,
    "sourceOperationCode" TEXT,
    "targetOperationCode" TEXT,
    "materialContractId" TEXT,
    "contractRefId" TEXT,
    "contractNumber" TEXT,
    "ownership" TEXT,
    "plannedReworkQty" DECIMAL(65,30) NOT NULL,
    "completedGoodQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "scrappedQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "remainingQty" DECIMAL(65,30) NOT NULL,
    "unit" TEXT NOT NULL,
    "weightKg" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" "ReworkOrderStatus" NOT NULL DEFAULT 'OPEN',
    "instructions" TEXT NOT NULL,
    "returnToProduction" BOOLEAN NOT NULL DEFAULT true,
    "returnDocumentId" TEXT,
    "returnDocumentNumber" TEXT,
    "scrapDocumentId" TEXT,
    "scrapDocumentNumber" TEXT,
    "assignedToName" TEXT,
    "completionNotes" TEXT,
    "createdByUid" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "quality_rework_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quality_rework_orders_qty_nonneg_chk" CHECK (
        "plannedReworkQty" > 0
        AND "completedGoodQty" >= 0
        AND "scrappedQty" >= 0
        AND "remainingQty" >= 0
        AND "weightKg" >= 0
    )
);

-- CreateTable: quality_idempotency_records
CREATE TABLE "quality_idempotency_records" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "responsePayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_idempotency_records_pkey" PRIMARY KEY ("id")
);

-- Unique Indexes
CREATE UNIQUE INDEX "quality_inspections_inspectionNumber_key" ON "quality_inspections"("inspectionNumber");
CREATE UNIQUE INDEX "quality_inspections_idempotencyKey_key" ON "quality_inspections"("idempotencyKey");
CREATE UNIQUE INDEX "quality_nonconformances_ncrNumber_key" ON "quality_nonconformances"("ncrNumber");
CREATE UNIQUE INDEX "quality_nonconformances_idempotencyKey_key" ON "quality_nonconformances"("idempotencyKey");
CREATE UNIQUE INDEX "quality_rework_orders_reworkNumber_key" ON "quality_rework_orders"("reworkNumber");
CREATE UNIQUE INDEX "quality_idempotency_records_scope_idempotencyKey_key" ON "quality_idempotency_records"("scope", "idempotencyKey");

-- Secondary Indexes: quality_inspections
CREATE INDEX "quality_inspections_inspectionType_status_idx" ON "quality_inspections"("inspectionType", "status");
CREATE INDEX "quality_inspections_decision_idx" ON "quality_inspections"("decision");
CREATE INDEX "quality_inspections_partId_idx" ON "quality_inspections"("partId");
CREATE INDEX "quality_inspections_materialLotId_idx" ON "quality_inspections"("materialLotId");
CREATE INDEX "quality_inspections_physicalCoilId_idx" ON "quality_inspections"("physicalCoilId");
CREATE INDEX "quality_inspections_manufacturingOrderId_idx" ON "quality_inspections"("manufacturingOrderId");
CREATE INDEX "quality_inspections_productionOperationId_idx" ON "quality_inspections"("productionOperationId");
CREATE INDEX "quality_inspections_lotNumber_idx" ON "quality_inspections"("lotNumber");
CREATE INDEX "quality_inspections_moNumber_idx" ON "quality_inspections"("moNumber");
CREATE INDEX "quality_inspections_createdAt_idx" ON "quality_inspections"("createdAt");

-- Secondary Indexes: quality_nonconformances
CREATE INDEX "quality_nonconformances_status_severity_idx" ON "quality_nonconformances"("status", "severity");
CREATE INDEX "quality_nonconformances_disposition_idx" ON "quality_nonconformances"("disposition");
CREATE INDEX "quality_nonconformances_inspectionId_idx" ON "quality_nonconformances"("inspectionId");
CREATE INDEX "quality_nonconformances_partId_idx" ON "quality_nonconformances"("partId");
CREATE INDEX "quality_nonconformances_materialLotId_idx" ON "quality_nonconformances"("materialLotId");
CREATE INDEX "quality_nonconformances_physicalCoilId_idx" ON "quality_nonconformances"("physicalCoilId");
CREATE INDEX "quality_nonconformances_manufacturingOrderId_idx" ON "quality_nonconformances"("manufacturingOrderId");
CREATE INDEX "quality_nonconformances_productionOperationId_idx" ON "quality_nonconformances"("productionOperationId");
CREATE INDEX "quality_nonconformances_lotNumber_idx" ON "quality_nonconformances"("lotNumber");
CREATE INDEX "quality_nonconformances_moNumber_idx" ON "quality_nonconformances"("moNumber");
CREATE INDEX "quality_nonconformances_createdAt_idx" ON "quality_nonconformances"("createdAt");

-- Secondary Indexes: quality_rework_orders
CREATE INDEX "quality_rework_orders_ncrId_idx" ON "quality_rework_orders"("ncrId");
CREATE INDEX "quality_rework_orders_status_idx" ON "quality_rework_orders"("status");
CREATE INDEX "quality_rework_orders_partId_idx" ON "quality_rework_orders"("partId");
CREATE INDEX "quality_rework_orders_materialLotId_idx" ON "quality_rework_orders"("materialLotId");
CREATE INDEX "quality_rework_orders_physicalCoilId_idx" ON "quality_rework_orders"("physicalCoilId");
CREATE INDEX "quality_rework_orders_manufacturingOrderId_idx" ON "quality_rework_orders"("manufacturingOrderId");
CREATE INDEX "quality_rework_orders_moNumber_idx" ON "quality_rework_orders"("moNumber");
CREATE INDEX "quality_rework_orders_createdAt_idx" ON "quality_rework_orders"("createdAt");

-- Secondary Indexes: quality_idempotency_records
CREATE INDEX "quality_idempotency_records_createdAt_idx" ON "quality_idempotency_records"("createdAt");

-- Foreign Keys: quality_inspections
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_materialLotId_fkey" FOREIGN KEY ("materialLotId") REFERENCES "material_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_physicalCoilId_fkey" FOREIGN KEY ("physicalCoilId") REFERENCES "physical_coils"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_manufacturingOrderId_fkey" FOREIGN KEY ("manufacturingOrderId") REFERENCES "manufacturing_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_productionOperationId_fkey" FOREIGN KEY ("productionOperationId") REFERENCES "production_operations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_materialContractId_fkey" FOREIGN KEY ("materialContractId") REFERENCES "material_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_linkedQmDocumentId_fkey" FOREIGN KEY ("linkedQmDocumentId") REFERENCES "inventory_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Foreign Keys: quality_nonconformances
ALTER TABLE "quality_nonconformances" ADD CONSTRAINT "quality_nonconformances_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "quality_inspections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_nonconformances" ADD CONSTRAINT "quality_nonconformances_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_nonconformances" ADD CONSTRAINT "quality_nonconformances_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_nonconformances" ADD CONSTRAINT "quality_nonconformances_materialLotId_fkey" FOREIGN KEY ("materialLotId") REFERENCES "material_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_nonconformances" ADD CONSTRAINT "quality_nonconformances_physicalCoilId_fkey" FOREIGN KEY ("physicalCoilId") REFERENCES "physical_coils"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_nonconformances" ADD CONSTRAINT "quality_nonconformances_manufacturingOrderId_fkey" FOREIGN KEY ("manufacturingOrderId") REFERENCES "manufacturing_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_nonconformances" ADD CONSTRAINT "quality_nonconformances_productionOperationId_fkey" FOREIGN KEY ("productionOperationId") REFERENCES "production_operations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_nonconformances" ADD CONSTRAINT "quality_nonconformances_materialContractId_fkey" FOREIGN KEY ("materialContractId") REFERENCES "material_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_nonconformances" ADD CONSTRAINT "quality_nonconformances_containmentQmDocId_fkey" FOREIGN KEY ("containmentQmDocId") REFERENCES "inventory_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_nonconformances" ADD CONSTRAINT "quality_nonconformances_dispositionDocId_fkey" FOREIGN KEY ("dispositionDocId") REFERENCES "inventory_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Foreign Keys: quality_rework_orders
ALTER TABLE "quality_rework_orders" ADD CONSTRAINT "quality_rework_orders_ncrId_fkey" FOREIGN KEY ("ncrId") REFERENCES "quality_nonconformances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quality_rework_orders" ADD CONSTRAINT "quality_rework_orders_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "quality_inspections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_rework_orders" ADD CONSTRAINT "quality_rework_orders_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_rework_orders" ADD CONSTRAINT "quality_rework_orders_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_rework_orders" ADD CONSTRAINT "quality_rework_orders_materialLotId_fkey" FOREIGN KEY ("materialLotId") REFERENCES "material_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_rework_orders" ADD CONSTRAINT "quality_rework_orders_physicalCoilId_fkey" FOREIGN KEY ("physicalCoilId") REFERENCES "physical_coils"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_rework_orders" ADD CONSTRAINT "quality_rework_orders_manufacturingOrderId_fkey" FOREIGN KEY ("manufacturingOrderId") REFERENCES "manufacturing_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_rework_orders" ADD CONSTRAINT "quality_rework_orders_productionOperationId_fkey" FOREIGN KEY ("productionOperationId") REFERENCES "production_operations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_rework_orders" ADD CONSTRAINT "quality_rework_orders_materialContractId_fkey" FOREIGN KEY ("materialContractId") REFERENCES "material_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_rework_orders" ADD CONSTRAINT "quality_rework_orders_returnDocumentId_fkey" FOREIGN KEY ("returnDocumentId") REFERENCES "inventory_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quality_rework_orders" ADD CONSTRAINT "quality_rework_orders_scrapDocumentId_fkey" FOREIGN KEY ("scrapDocumentId") REFERENCES "inventory_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
