-- KPIMS Inventory P0-A: Database Constraints and Ledger Engine Hardening
-- Target PostgreSQL: 17.11 (supports CREATE UNIQUE INDEX ... NULLS NOT DISTINCT, PG >= 15)
-- Strictly additive & non-destructive; preserves all existing live records.

-- 1. InventoryDocument: idempotency key & request payload fingerprint for retry safety
ALTER TABLE "inventory_documents"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "requestFingerprint" TEXT;

-- 2. Optimistic concurrency version columns on StockBalance and PhysicalCoil
ALTER TABLE "stock_balances"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "physical_coils"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- 3. MaterialContract: sheet thickness specification (nullable for existing contracts)
ALTER TABLE "material_contracts"
  ADD COLUMN "thicknessMm" DECIMAL(65,30);

-- 4. InventoryReservation: physical coil, location, ownership, and contract linkage (nullable for existing rows)
ALTER TABLE "inventory_reservations"
  ADD COLUMN "locationId" TEXT,
  ADD COLUMN "physicalCoilId" TEXT,
  ADD COLUMN "ownership" TEXT,
  ADD COLUMN "contractId" TEXT;

-- 5. MaterialLot: allow nullable materialId for non-steel material lots (fasteners, rubber, WIP/FG batches)
ALTER TABLE "material_lots" DROP CONSTRAINT IF EXISTS "material_lots_materialId_fkey";
ALTER TABLE "material_lots" ALTER COLUMN "materialId" DROP NOT NULL;
ALTER TABLE "material_lots"
  ADD CONSTRAINT "material_lots_materialId_fkey"
  FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 6. StockBalance: replace standard unique index with PostgreSQL NULLS NOT DISTINCT
--    so nullable key columns (locationId, materialLotId, physicalCoilId, contractId)
--    cannot permit duplicate stock balance rows under concurrent writes.
DROP INDEX IF EXISTS "stock_balances_partId_warehouseId_locationId_materialLotId__key";
CREATE UNIQUE INDEX "stock_balances_partId_warehouseId_locationId_materialLotId__key"
  ON "stock_balances"("partId", "warehouseId", "locationId", "materialLotId", "physicalCoilId", "ownership", "contractId", "qualityStatus")
  NULLS NOT DISTINCT;

-- 7. Unique & Foreign-Key Indexes
CREATE UNIQUE INDEX "inventory_documents_idempotencyKey_key"
  ON "inventory_documents"("idempotencyKey");

CREATE INDEX "inventory_document_lines_physicalCoilId_idx"
  ON "inventory_document_lines"("physicalCoilId");

CREATE INDEX "inventory_transactions_physicalCoilId_idx"
  ON "inventory_transactions"("physicalCoilId");

CREATE INDEX "inventory_transactions_documentId_idx"
  ON "inventory_transactions"("documentId");

CREATE INDEX "inventory_transactions_reversalOfTrxId_idx"
  ON "inventory_transactions"("reversalOfTrxId");

CREATE INDEX "inventory_reservations_physicalCoilId_idx"
  ON "inventory_reservations"("physicalCoilId");

CREATE INDEX "inventory_reservations_locationId_idx"
  ON "inventory_reservations"("locationId");

CREATE INDEX "inventory_reservations_contractId_idx"
  ON "inventory_reservations"("contractId");

-- 8. Foreign Keys for new InventoryReservation links
ALTER TABLE "inventory_reservations"
  ADD CONSTRAINT "inventory_reservations_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "warehouse_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "inventory_reservations"
  ADD CONSTRAINT "inventory_reservations_physicalCoilId_fkey"
  FOREIGN KEY ("physicalCoilId") REFERENCES "physical_coils"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "inventory_reservations"
  ADD CONSTRAINT "inventory_reservations_contractId_fkey"
  FOREIGN KEY ("contractId") REFERENCES "material_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
