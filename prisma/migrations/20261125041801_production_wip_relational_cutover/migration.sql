-- AlterEnum
ALTER TYPE "TransferStatus" ADD VALUE 'AUTO_TRANSFERRED';

-- AlterTable
ALTER TABLE "manufacturing_orders" ADD COLUMN     "bomId" TEXT,
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "createdByName" TEXT,
ADD COLUMN     "initialInputQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN     "outputLocationId" TEXT,
ADD COLUMN     "outputWarehouseId" TEXT,
ADD COLUMN     "parentMoId" TEXT,
ADD COLUMN     "totalRejectedQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN     "totalReworkQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "parts" ADD COLUMN     "targetLocationId" TEXT,
ADD COLUMN     "targetWarehouseId" TEXT;

-- AlterTable
ALTER TABLE "production_operations" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "inProgressQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN     "lastActivityAt" TIMESTAMP(3),
ADD COLUMN     "locationId" TEXT,
ADD COLUMN     "readyForTransferQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN     "scrapNormPercent" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN     "sequence" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "standardCycleTimeSec" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stepCode" TEXT,
ADD COLUMN     "stepName" TEXT,
ADD COLUMN     "transferredQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "waitingInputQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN     "warehouseId" TEXT,
ADD COLUMN     "warehouseLocationCode" TEXT;

-- AlterTable
ALTER TABLE "production_transfers" ADD COLUMN     "dispatchedByName" TEXT,
ADD COLUMN     "fromLocationCode" TEXT,
ADD COLUMN     "fromLocationId" TEXT,
ADD COLUMN     "fromStepName" TEXT,
ADD COLUMN     "fromStepNumber" INTEGER,
ADD COLUMN     "receivedByName" TEXT,
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedByName" TEXT,
ADD COLUMN     "rejectedByUserId" TEXT,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "toLocationCode" TEXT,
ADD COLUMN     "toLocationId" TEXT,
ADD COLUMN     "toStepName" TEXT,
ADD COLUMN     "toStepNumber" INTEGER,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "production_activity_logs" (
    "id" TEXT NOT NULL,
    "manufacturingOrderId" TEXT NOT NULL,
    "moNumber" TEXT NOT NULL,
    "partId" TEXT,
    "productionOperationId" TEXT,
    "stepNumber" INTEGER NOT NULL,
    "stepName" TEXT NOT NULL,
    "activityType" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "goodQty" DECIMAL(65,30),
    "scrapQty" DECIMAL(65,30),
    "reworkQty" DECIMAL(65,30),
    "rejectedQty" DECIMAL(65,30),
    "operatorName" TEXT NOT NULL,
    "machineId" TEXT,
    "scrapReason" TEXT,
    "transferId" TEXT,
    "productionReportId" TEXT,
    "notes" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "production_activity_logs_manufacturingOrderId_timestamp_idx" ON "production_activity_logs"("manufacturingOrderId", "timestamp");

-- CreateIndex
CREATE INDEX "production_activity_logs_productionOperationId_timestamp_idx" ON "production_activity_logs"("productionOperationId", "timestamp");

-- CreateIndex
CREATE INDEX "manufacturing_orders_parentMoId_idx" ON "manufacturing_orders"("parentMoId");

-- CreateIndex
CREATE INDEX "production_operations_manufacturingOrderId_sequence_idx" ON "production_operations"("manufacturingOrderId", "sequence");

-- CreateIndex
CREATE INDEX "production_transfers_manufacturingOrderId_idx" ON "production_transfers"("manufacturingOrderId");

-- CreateIndex
CREATE INDEX "production_transfers_fromStageOperationId_idx" ON "production_transfers"("fromStageOperationId");

-- CreateIndex
CREATE INDEX "production_transfers_toStageOperationId_idx" ON "production_transfers"("toStageOperationId");

-- AddForeignKey
ALTER TABLE "parts" ADD CONSTRAINT "parts_targetWarehouseId_fkey" FOREIGN KEY ("targetWarehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parts" ADD CONSTRAINT "parts_targetLocationId_fkey" FOREIGN KEY ("targetLocationId") REFERENCES "warehouse_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manufacturing_orders" ADD CONSTRAINT "manufacturing_orders_parentMoId_fkey" FOREIGN KEY ("parentMoId") REFERENCES "manufacturing_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manufacturing_orders" ADD CONSTRAINT "manufacturing_orders_outputWarehouseId_fkey" FOREIGN KEY ("outputWarehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manufacturing_orders" ADD CONSTRAINT "manufacturing_orders_outputLocationId_fkey" FOREIGN KEY ("outputLocationId") REFERENCES "warehouse_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_operations" ADD CONSTRAINT "production_operations_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_operations" ADD CONSTRAINT "production_operations_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "warehouse_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_transfers" ADD CONSTRAINT "production_transfers_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "warehouse_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_transfers" ADD CONSTRAINT "production_transfers_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "warehouse_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_activity_logs" ADD CONSTRAINT "production_activity_logs_manufacturingOrderId_fkey" FOREIGN KEY ("manufacturingOrderId") REFERENCES "manufacturing_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_activity_logs" ADD CONSTRAINT "production_activity_logs_productionOperationId_fkey" FOREIGN KEY ("productionOperationId") REFERENCES "production_operations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

