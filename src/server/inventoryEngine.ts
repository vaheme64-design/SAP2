/**
 * =========================================================================
 * KPIMS - Advanced Industrial Inventory & Kardex Engine
 * Persistent Database Storage, Concurrency Control, Atomic Posting,
 * Reservation Logic, Physical Coil & Partial Return Traceability,
 * Multi-Contract Allocations, SAPCO Ledger & Custom Report Builder
 * =========================================================================
 */

import {
  InventoryDocument,
  InventoryDocumentLine,
  InventoryDocType,
  InventoryReservation,
  DetailedStockBalance,
  SapcoContract,
  SapcoContractLedgerEntry,
  InventoryDashboardMetrics,
  Part,
  StockOwnership,
  StockQualityStatus,
  PhysicalCoil,
  ContractCoilAllocation,
  CoilIssueReturnRecord,
  SavedReportConfig,
  ImportBatchSummary,
  SapMovementType,
  SAP_MOVEMENT_CATALOG,
  resolveSapMovementType,
  getSapMovementReversal,
  WAREHOUSES_LIST,
} from '../types/inventory';
import { getPrismaClient, isDatabaseUrlConfigured } from './db/prisma';
import {
  postInventoryDocumentInTransaction,
  saveDraftDocumentInDbTransaction as saveDraftInDbTransaction,
  PostDocumentDbOptions,
} from './services/inventoryLedgerService';

export interface AuditRecord {
  id: string;
  action: string;
  entityName: string;
  entityId: string;
  user: { uid: string; displayName: string };
  details: string;
  timestamp: string;
}

export interface PostDocumentResult {
  success: boolean;
  error?: string;
  errorCode?: string;
  statusCode?: number;
  idempotentReplay?: boolean;
  dbDocumentId?: string;
  dbDocumentNumber?: string;
  createdCoilIds?: string[];
  attempts?: number;
  postedDocument?: InventoryDocument;
  createdLedgerEntries?: SapcoContractLedgerEntry[];
  auditRecord?: AuditRecord;
}

export interface ReversalResult {
  success: boolean;
  error?: string;
  originalDocument?: InventoryDocument;
  reversalDocument?: InventoryDocument;
  auditRecord?: AuditRecord;
}

/**
 * -------------------------------------------------------------------------
 * 1. MULTIDIMENSIONAL STOCK BALANCES & RESERVATION ALLOCATION ENGINE
 * -------------------------------------------------------------------------
 * Calculates complete multidimensional stock balances strictly from POSTED
 * inventory documents.
 * 
 * Critical Rules:
 * - DRAFT documents are completely excluded from official stock.
 * - Dimensions are never falsely merged (Item, Warehouse, Location, Ownership, Lot/Coil, Heat, Contract, Quality).
 * - Actual weight is preserved and not replaced by standard weight calculation.
 * - General reservations are NEVER multiplied across multiple lots; reserved quantity is allocated once.
 * - Expired, cancelled, or released reservations do NOT reduce available inventory.
 */
export function calculateDetailedStockBalances(
  documents: InventoryDocument[],
  reservations: InventoryReservation[],
  parts: Part[],
  qcHolds?: Record<string, any>
): {
  balances: DetailedStockBalance[];
  metrics: InventoryDashboardMetrics;
} {
  const partsMap = new Map<string, Part>();
  parts.forEach(p => partsMap.set(p.id, p));

  // Key includes all traceability dimensions
  const balanceMap = new Map<string, DetailedStockBalance>();

  const getOrCreateBalance = (
    part: Part,
    warehouseId: string,
    warehouseName: string,
    locationCode: string,
    ownership: StockOwnership,
    lotNumber?: string,
    heatNumber?: string,
    materialLotId?: string,
    contractId?: string,
    contractNumber?: string,
    qualityStatus: StockQualityStatus = 'AVAILABLE'
  ): DetailedStockBalance => {
    const safeLot = lotNumber || 'NO_LOT';
    const safeQuality = qualityStatus || 'AVAILABLE';
    const safeContract = contractId || 'NO_CONTRACT';
    const key = `${part.id}:::${warehouseId}:::${locationCode}:::${ownership}:::${safeLot}:::${safeQuality}:::${safeContract}`;

    if (!balanceMap.has(key)) {
      balanceMap.set(key, {
        id: `STK-${key}`,
        partId: part.id,
        partCode: part.code,
        partName: part.name,
        category: part.category,
        materialGrade: part.materialGrade,
        thicknessMm: part.thicknessMm,
        warehouseId,
        warehouseName,
        locationCode: locationCode || 'MAIN',
        materialLotId,
        lotNumber: lotNumber || undefined,
        heatNumber,
        ownership,
        contractId: contractId || undefined,
        contractNumber: contractNumber || undefined,
        unit: part.unit,
        physicalQty: 0,
        unrestrictedQty: 0,
        qualityInspectionQty: 0,
        blockedQty: 0,
        ownedQty: 0,
        supplierOwnedQty: 0,
        reservedQty: 0,
        qualityBlockedQty: 0,
        availableQty: 0,
        physicalKg: 0,
        unrestrictedKg: 0,
        qualityInspectionKg: 0,
        blockedKg: 0,
        ownedKg: 0,
        supplierOwnedKg: 0,
        reservedKg: 0,
        qualityBlockedKg: 0,
        availableKg: 0,
        lastTransactionAt: new Date().toISOString(),
      });
    }
    return balanceMap.get(key)!;
  };

  // 1. Process all historical POSTED documents chronologically
  const postedDocs = documents
    .filter(d => d.postingStatus === 'POSTED' || d.postingStatus === 'REVERSED')
    .sort((a, b) => new Date(a.documentDate).getTime() - new Date(b.documentDate).getTime());

  for (const doc of postedDocs) {
    const docMovement =
      doc.movementType ||
      resolveSapMovementType(doc.documentType, {
        totalQuantity: doc.totalQuantity,
        qmTarget: doc.qmStatusTarget,
      });

    for (const line of doc.lines) {
      const part = partsMap.get(line.partId);
      if (!part) continue;

      const qty = Number(line.quantity) || 0;
      // Preserve actual weight if specified; otherwise calculate from standard unit weight
      const weightKg =
        line.quantityKg !== undefined && line.quantityKg !== null && Number(line.quantityKg) !== 0
          ? Number(line.quantityKg)
          : part.unit === 'KG'
          ? qty
          : Number((qty * (part.weightPerUnitKg || 1)).toFixed(3));

      switch (doc.documentType) {
        case 'OPENING_BALANCE':
        case 'RECEIPT_RAW_MATERIAL':
        case 'RECEIPT_FINISHED_GOODS': {
          const entry = getOrCreateBalance(
            part,
            doc.warehouseId,
            doc.warehouseName,
            line.locationCode || 'LOC-01',
            line.ownership,
            line.lotNumber,
            line.heatNumber,
            line.materialLotId,
            line.contractId,
            line.contractNumber,
            line.qualityStatus
          );
          entry.physicalQty += qty;
          entry.physicalKg += weightKg;
          if (line.ownership === 'COMPANY_OWNED') {
            entry.ownedQty += qty;
            entry.ownedKg += weightKg;
          } else {
            entry.supplierOwnedQty += qty;
            entry.supplierOwnedKg += weightKg;
          }
          if (line.qualityStatus === 'QUARANTINE') {
            entry.qualityInspectionQty += qty;
            entry.qualityInspectionKg += weightKg;
            entry.qualityBlockedQty += qty;
            entry.qualityBlockedKg += weightKg;
          } else if (line.qualityStatus === 'QUALITY_BLOCKED' || line.qualityStatus === 'REJECTED') {
            entry.blockedQty += qty;
            entry.blockedKg += weightKg;
            entry.qualityBlockedQty += qty;
            entry.qualityBlockedKg += weightKg;
          } else {
            entry.unrestrictedQty += qty;
            entry.unrestrictedKg += weightKg;
          }
          entry.lastTransactionAt = doc.postedAt || doc.documentDate;
          break;
        }

        case 'ISSUE_RAW_MATERIAL':
        case 'ISSUE_FINISHED_GOODS':
        case 'DELIVERY_CUSTOMER':
        case 'SHIPMENT_CUSTOMER': {
          const targetLoc = line.locationCode || 'LOC-01';
          const targetLot = line.lotNumber || 'NO_LOT';
          const targetContract = line.contractId || 'NO_CONTRACT';
          const entry =
            Array.from(balanceMap.values()).find(
              b =>
                b.partId === part.id &&
                b.warehouseId === doc.warehouseId &&
                b.locationCode === targetLoc &&
                b.ownership === line.ownership &&
                (b.lotNumber || 'NO_LOT') === targetLot &&
                (b.contractId || 'NO_CONTRACT') === targetContract &&
                b.unrestrictedQty > 0
            ) ||
            getOrCreateBalance(
              part,
              doc.warehouseId,
              doc.warehouseName,
              targetLoc,
              line.ownership,
              line.lotNumber,
              line.heatNumber,
              line.materialLotId,
              line.contractId,
              line.contractNumber,
              line.qualityStatus
            );
          entry.physicalQty -= qty;
          entry.physicalKg -= weightKg;
          entry.unrestrictedQty -= qty;
          entry.unrestrictedKg -= weightKg;
          if (line.ownership === 'COMPANY_OWNED') {
            entry.ownedQty -= qty;
            entry.ownedKg -= weightKg;
          } else {
            entry.supplierOwnedQty -= qty;
            entry.supplierOwnedKg -= weightKg;
          }
          entry.lastTransactionAt = doc.postedAt || doc.documentDate;
          break;
        }

        case 'TRANSFER': {
          // Source Warehouse deduction
          const srcLoc = line.locationCode || 'LOC-01';
          const srcLot = line.lotNumber || 'NO_LOT';
          const srcContract = line.contractId || 'NO_CONTRACT';
          const sourceEntry =
            Array.from(balanceMap.values()).find(
              b =>
                b.partId === part.id &&
                b.warehouseId === doc.warehouseId &&
                b.locationCode === srcLoc &&
                b.ownership === line.ownership &&
                (b.lotNumber || 'NO_LOT') === srcLot &&
                (b.contractId || 'NO_CONTRACT') === srcContract &&
                b.physicalQty > 0
            ) ||
            getOrCreateBalance(
              part,
              doc.warehouseId,
              doc.warehouseName,
              srcLoc,
              line.ownership,
              line.lotNumber,
              line.heatNumber,
              line.materialLotId,
              line.contractId,
              line.contractNumber,
              line.qualityStatus
            );
          sourceEntry.physicalQty -= qty;
          sourceEntry.physicalKg -= weightKg;
          sourceEntry.unrestrictedQty -= qty;
          sourceEntry.unrestrictedKg -= weightKg;
          if (line.ownership === 'COMPANY_OWNED') {
            sourceEntry.ownedQty -= qty;
            sourceEntry.ownedKg -= weightKg;
          } else {
            sourceEntry.supplierOwnedQty -= qty;
            sourceEntry.supplierOwnedKg -= weightKg;
          }
          sourceEntry.lastTransactionAt = doc.postedAt || doc.documentDate;

          // Target Warehouse addition
          if (doc.targetWarehouseId) {
            const targetWarehouse = WAREHOUSES_LIST.find(w => w.id === doc.targetWarehouseId);
            const targetEntry = getOrCreateBalance(
              part,
              doc.targetWarehouseId,
              targetWarehouse ? targetWarehouse.name : doc.targetWarehouseName || doc.targetWarehouseId,
              line.targetLocationCode || line.locationCode || 'LOC-01',
              line.ownership,
              line.lotNumber,
              line.heatNumber,
              line.materialLotId,
              line.contractId,
              line.contractNumber,
              line.qualityStatus
            );
            targetEntry.physicalQty += qty;
            targetEntry.physicalKg += weightKg;
            if (line.qualityStatus === 'QUARANTINE') {
              targetEntry.qualityInspectionQty += qty;
              targetEntry.qualityInspectionKg += weightKg;
              targetEntry.qualityBlockedQty += qty;
              targetEntry.qualityBlockedKg += weightKg;
            } else if (line.qualityStatus === 'QUALITY_BLOCKED' || line.qualityStatus === 'REJECTED') {
              targetEntry.blockedQty += qty;
              targetEntry.blockedKg += weightKg;
              targetEntry.qualityBlockedQty += qty;
              targetEntry.qualityBlockedKg += weightKg;
            } else {
              targetEntry.unrestrictedQty += qty;
              targetEntry.unrestrictedKg += weightKg;
            }
            if (line.ownership === 'COMPANY_OWNED') {
              targetEntry.ownedQty += qty;
              targetEntry.ownedKg += weightKg;
            } else {
              targetEntry.supplierOwnedQty += qty;
              targetEntry.supplierOwnedKg += weightKg;
            }
            targetEntry.lastTransactionAt = doc.postedAt || doc.documentDate;
          }
          break;
        }

        case 'STOCK_STATUS_TRANSFER': {
          // QM movement 321 (QI/Blocked -> Unrestricted), 322 (Unrestricted -> QI), 344 (Unrestricted -> Blocked)
          const lineMovement: SapMovementType =
            line.movementType || docMovement || '321';
          const candidateEntry =
            Array.from(balanceMap.values()).find(
              b =>
                b.partId === part.id &&
                b.warehouseId === doc.warehouseId &&
                (!line.lotNumber || b.lotNumber === line.lotNumber) &&
                (!line.locationCode || b.locationCode === line.locationCode)
            ) ||
            getOrCreateBalance(
              part,
              doc.warehouseId,
              doc.warehouseName,
              line.locationCode || 'LOC-01',
              line.ownership,
              line.lotNumber,
              line.heatNumber,
              line.materialLotId,
              line.contractId,
              line.contractNumber,
              'AVAILABLE'
            );

          if (lineMovement === '322') {
            const shiftQty = Math.min(qty, Math.max(0, candidateEntry.unrestrictedQty));
            const shiftKg = Math.min(weightKg, Math.max(0, candidateEntry.unrestrictedKg));
            candidateEntry.unrestrictedQty = Math.max(0, candidateEntry.unrestrictedQty - shiftQty);
            candidateEntry.unrestrictedKg = Math.max(0, candidateEntry.unrestrictedKg - shiftKg);
            candidateEntry.qualityInspectionQty += shiftQty;
            candidateEntry.qualityInspectionKg += shiftKg;
            candidateEntry.qualityBlockedQty = candidateEntry.qualityInspectionQty + candidateEntry.blockedQty;
            candidateEntry.qualityBlockedKg = candidateEntry.qualityInspectionKg + candidateEntry.blockedKg;
          } else if (lineMovement === '344') {
            // 344: Transition from Quality Inspection (if rejecting quarantined lot) and/or Unrestricted -> Blocked
            let remQty = qty;
            let remKg = weightKg;
            const preferQiFirst =
              line.sourceQualityStatus === 'QUARANTINE' ||
              (candidateEntry.qualityInspectionQty > 0 && candidateEntry.unrestrictedQty < remQty);

            let totalShiftedQty = 0;
            let totalShiftedKg = 0;

            if (preferQiFirst) {
              const fromQiQty = Math.min(remQty, Math.max(0, candidateEntry.qualityInspectionQty));
              const fromQiKg = Math.min(remKg, Math.max(0, candidateEntry.qualityInspectionKg));
              candidateEntry.qualityInspectionQty -= fromQiQty;
              candidateEntry.qualityInspectionKg -= fromQiKg;
              remQty -= fromQiQty;
              remKg -= fromQiKg;
              totalShiftedQty += fromQiQty;
              totalShiftedKg += fromQiKg;
            }

            if (remQty > 0) {
              const fromUnrQty = Math.min(remQty, Math.max(0, candidateEntry.unrestrictedQty));
              const fromUnrKg = Math.min(remKg, Math.max(0, candidateEntry.unrestrictedKg));
              candidateEntry.unrestrictedQty -= fromUnrQty;
              candidateEntry.unrestrictedKg -= fromUnrKg;
              remQty -= fromUnrQty;
              remKg -= fromUnrKg;
              totalShiftedQty += fromUnrQty;
              totalShiftedKg += fromUnrKg;
            }

            if (!preferQiFirst && remQty > 0) {
              const fromQiQty = Math.min(remQty, Math.max(0, candidateEntry.qualityInspectionQty));
              const fromQiKg = Math.min(remKg, Math.max(0, candidateEntry.qualityInspectionKg));
              candidateEntry.qualityInspectionQty -= fromQiQty;
              candidateEntry.qualityInspectionKg -= fromQiKg;
              totalShiftedQty += fromQiQty;
              totalShiftedKg += fromQiKg;
            }

            candidateEntry.blockedQty += totalShiftedQty;
            candidateEntry.blockedKg += totalShiftedKg;
            candidateEntry.qualityBlockedQty = candidateEntry.qualityInspectionQty + candidateEntry.blockedQty;
            candidateEntry.qualityBlockedKg = candidateEntry.qualityInspectionKg + candidateEntry.blockedKg;
          } else {
            // 321: Release from Quality Inspection (then Blocked if needed) -> Unrestricted
            let remQty = qty;
            let remKg = weightKg;
            const fromQiQty = Math.min(remQty, Math.max(0, candidateEntry.qualityInspectionQty));
            const fromQiKg = Math.min(remKg, Math.max(0, candidateEntry.qualityInspectionKg));
            candidateEntry.qualityInspectionQty -= fromQiQty;
            candidateEntry.qualityInspectionKg -= fromQiKg;
            remQty -= fromQiQty;
            remKg -= fromQiKg;

            let fromBlkQty = 0;
            let fromBlkKg = 0;
            if (remQty > 0) {
              fromBlkQty = Math.min(remQty, Math.max(0, candidateEntry.blockedQty));
              fromBlkKg = Math.min(remKg, Math.max(0, candidateEntry.blockedKg));
              candidateEntry.blockedQty -= fromBlkQty;
              candidateEntry.blockedKg -= fromBlkKg;
            }
            const totalReleasedQty = fromQiQty + fromBlkQty;
            const totalReleasedKg = fromQiKg + fromBlkKg;
            candidateEntry.unrestrictedQty = Math.min(
              candidateEntry.physicalQty,
              candidateEntry.unrestrictedQty + totalReleasedQty
            );
            candidateEntry.unrestrictedKg = Math.min(
              candidateEntry.physicalKg,
              candidateEntry.unrestrictedKg + totalReleasedKg
            );
            candidateEntry.qualityBlockedQty = candidateEntry.qualityInspectionQty + candidateEntry.blockedQty;
            candidateEntry.qualityBlockedKg = candidateEntry.qualityInspectionKg + candidateEntry.blockedKg;
          }
          candidateEntry.lastTransactionAt = doc.postedAt || doc.documentDate;
          break;
        }

        case 'ADJUSTMENT':
        case 'REVERSAL': {
          const adjLoc = line.locationCode || 'LOC-01';
          const adjLot = line.lotNumber || 'NO_LOT';
          const adjContract = line.contractId || 'NO_CONTRACT';
          const entry =
            (qty < 0
              ? Array.from(balanceMap.values()).find(
                  b =>
                    b.partId === part.id &&
                    b.warehouseId === doc.warehouseId &&
                    b.locationCode === adjLoc &&
                    b.ownership === line.ownership &&
                    (b.lotNumber || 'NO_LOT') === adjLot &&
                    (b.contractId || 'NO_CONTRACT') === adjContract &&
                    b.physicalQty > 0
                )
              : undefined) ||
            getOrCreateBalance(
              part,
              doc.warehouseId,
              doc.warehouseName,
              adjLoc,
              line.ownership,
              line.lotNumber,
              line.heatNumber,
              line.materialLotId,
              line.contractId,
              line.contractNumber,
              line.qualityStatus
            );
          entry.physicalQty += qty;
          entry.physicalKg += weightKg;
          if (line.qualityStatus === 'QUARANTINE') {
            if (qty < 0) {
              const absQ = Math.abs(qty);
              const absW = Math.abs(weightKg);
              const fromQi = Math.min(absQ, Math.max(0, entry.qualityInspectionQty));
              const fromBlk = Math.min(absQ - fromQi, Math.max(0, entry.blockedQty));
              const ratioQi = absQ > 0 ? fromQi / absQ : 0;
              const ratioBlk = absQ > 0 ? fromBlk / absQ : 0;
              entry.qualityInspectionQty = Math.max(0, entry.qualityInspectionQty - fromQi);
              entry.qualityInspectionKg = Math.max(0, entry.qualityInspectionKg - absW * ratioQi);
              entry.blockedQty = Math.max(0, entry.blockedQty - fromBlk);
              entry.blockedKg = Math.max(0, entry.blockedKg - absW * ratioBlk);
            } else {
              entry.qualityInspectionQty += qty;
              entry.qualityInspectionKg += weightKg;
            }
            entry.qualityBlockedQty = entry.qualityInspectionQty + entry.blockedQty;
            entry.qualityBlockedKg = entry.qualityInspectionKg + entry.blockedKg;
          } else if (line.qualityStatus === 'QUALITY_BLOCKED' || line.qualityStatus === 'REJECTED') {
            if (qty < 0) {
              const absQ = Math.abs(qty);
              const absW = Math.abs(weightKg);
              const fromBlk = Math.min(absQ, Math.max(0, entry.blockedQty));
              const fromQi = Math.min(absQ - fromBlk, Math.max(0, entry.qualityInspectionQty));
              const ratioBlk = absQ > 0 ? fromBlk / absQ : 0;
              const ratioQi = absQ > 0 ? fromQi / absQ : 0;
              entry.blockedQty = Math.max(0, entry.blockedQty - fromBlk);
              entry.blockedKg = Math.max(0, entry.blockedKg - absW * ratioBlk);
              entry.qualityInspectionQty = Math.max(0, entry.qualityInspectionQty - fromQi);
              entry.qualityInspectionKg = Math.max(0, entry.qualityInspectionKg - absW * ratioQi);
            } else {
              entry.blockedQty += qty;
              entry.blockedKg += weightKg;
            }
            entry.qualityBlockedQty = entry.qualityInspectionQty + entry.blockedQty;
            entry.qualityBlockedKg = entry.qualityInspectionKg + entry.blockedKg;
          } else {
            entry.unrestrictedQty += qty;
            entry.unrestrictedKg += weightKg;
          }
          if (line.ownership === 'COMPANY_OWNED') {
            entry.ownedQty += qty;
            entry.ownedKg += weightKg;
          } else {
            entry.supplierOwnedQty += qty;
            entry.supplierOwnedKg += weightKg;
          }
          entry.lastTransactionAt = doc.postedAt || doc.documentDate;
          break;
        }
      }
    }
  }

  // 2. Controlled Reservation Allocation (Fixing multiple-deduction bug)
  // Only ACTIVE reservations reduce available inventory.
  for (const res of reservations) {
    if (res.status !== 'ACTIVE') continue;
    const part = partsMap.get(res.partId);
    if (!part) continue;

    if (res.lotNumber) {
      // Case A: Specific Lot / Coil Allocation (allocate iteratively without duplicating across rows)
      let remainingLotQty = res.quantity;
      let remainingLotKg = res.quantityKg;
      const lotEntries = Array.from(balanceMap.values()).filter(
        entry =>
          entry.partId === res.partId &&
          entry.warehouseId === res.warehouseId &&
          entry.lotNumber === res.lotNumber
      );

      for (const entry of lotEntries) {
        if (remainingLotQty <= 0) break;
        const availableToReserve = Math.max(0, entry.physicalQty - entry.reservedQty - entry.qualityBlockedQty);
        const qtyAllocated = Math.min(availableToReserve, remainingLotQty);
        const kgAllocated =
          part.unit === 'KG'
            ? qtyAllocated
            : Math.min(Math.max(0, entry.physicalKg - entry.reservedKg - entry.qualityBlockedKg), remainingLotKg);
        entry.reservedQty += qtyAllocated;
        entry.reservedKg += kgAllocated;
        remainingLotQty -= qtyAllocated;
        remainingLotKg -= kgAllocated;
      }

      if (remainingLotQty > 0 && lotEntries.length > 0) {
        lotEntries[0].reservedQty += remainingLotQty;
        lotEntries[0].reservedKg += Math.max(0, remainingLotKg);
      }
    } else {
      // Case B: General Item & Warehouse Reservation
      // Distribute total reserved quantity ONCE across eligible lots without duplication!
      let remainingQtyToAllocate = res.quantity;
      let remainingKgToAllocate = res.quantityKg;

      const matchingEntries = Array.from(balanceMap.values()).filter(
        entry => entry.partId === res.partId && entry.warehouseId === res.warehouseId && entry.physicalQty > 0
      );

      for (const entry of matchingEntries) {
        if (remainingQtyToAllocate <= 0) break;
        const availableToReserve = Math.max(0, entry.physicalQty - entry.reservedQty - entry.qualityBlockedQty);
        const qtyAllocated = Math.min(availableToReserve, remainingQtyToAllocate);
        const kgAllocated =
          part.unit === 'KG'
            ? qtyAllocated
            : Math.min(Math.max(0, entry.physicalKg - entry.reservedKg - entry.qualityBlockedKg), remainingKgToAllocate);

        entry.reservedQty += qtyAllocated;
        entry.reservedKg += kgAllocated;
        remainingQtyToAllocate -= qtyAllocated;
        remainingKgToAllocate -= kgAllocated;
      }

      // If stock was lower than reservation, record remainder on first matching entry for audit
      if (remainingQtyToAllocate > 0 && matchingEntries.length > 0) {
        matchingEntries[0].reservedQty += remainingQtyToAllocate;
        matchingEntries[0].reservedKg += remainingKgToAllocate;
      }
    }
  }

  // 2.1. Ensure every defined catalog part exists in balanceMap so stock inquiry finds it
  for (const part of partsMap.values()) {
    const hasEntry = Array.from(balanceMap.values()).some(b => b.partId === part.id);
    if (!hasEntry) {
      const defaultWhId =
        part.category === 'FINISHED_GOOD'
          ? 'WH-FINISHED'
          : part.category === 'WIP_PART'
          ? 'WH-WIP-STAMP'
          : 'WH-RAW';
      const defaultWh = WAREHOUSES_LIST.find(w => w.id === defaultWhId) || WAREHOUSES_LIST[0];
      getOrCreateBalance(
        part,
        defaultWh.id,
        defaultWh.name,
        'LOC-01',
        'COMPANY_OWNED',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'AVAILABLE'
      );
    }
  }

  // 3. Compute available stock = physical - reserved - qualityBlocked
  const balances: DetailedStockBalance[] = [];
  let totalPhysicalKg = 0;
  let totalPhysicalPcs = 0;
  let totalAvailableKg = 0;
  let totalAvailablePcs = 0;
  let totalReservedKg = 0;
  let totalReservedPcs = 0;
  let totalQualityBlockedKg = 0;
  let totalQualityBlockedPcs = 0;
  let totalSapcoConsignmentKg = 0;
  let totalCompanyOwnedKg = 0;
  const activeLots = new Set<string>();

  let totalUnrestrictedKg = 0;
  let totalQualityInspectionKg = 0;
  let totalBlockedKg = 0;

  for (const item of balanceMap.values()) {
    if (qcHolds && Object.keys(qcHolds).length > 0) {
      const hold =
        qcHolds[item.id] ||
        (item.lotNumber ? qcHolds[item.lotNumber] : undefined) ||
        qcHolds[`${item.partId}-${item.warehouseId}`];
      // Only apply raw qcHold override if not already recorded via a posted STOCK_STATUS_TRANSFER document
      if (hold && hold.isHeld && !hold.backedByDocumentNumber) {
        const addedBlocked =
          item.unit === 'KG'
            ? Number(hold.heldWeightKg || hold.heldQty || Math.max(0, item.unrestrictedKg) || 0)
            : Number(hold.heldQty || Math.max(0, item.unrestrictedQty) || 0);
        const clamped = Math.min(Math.max(0, item.unrestrictedQty), Math.max(0, addedBlocked));
        const unitWeight = item.physicalQty > 0 ? item.physicalKg / item.physicalQty : 1;
        const clampedKg = Math.min(Math.max(0, item.unrestrictedKg), Math.round(clamped * unitWeight * 1000) / 1000);
        item.unrestrictedQty = Math.max(0, item.unrestrictedQty - clamped);
        item.unrestrictedKg = Math.max(0, item.unrestrictedKg - clampedKg);
        if (hold.holdType === 'BLOCKED') {
          item.blockedQty += clamped;
          item.blockedKg += clampedKg;
        } else {
          item.qualityInspectionQty += clamped;
          item.qualityInspectionKg += clampedKg;
        }
      }
    }

    item.unrestrictedQty = Math.max(0, item.unrestrictedQty);
    item.qualityInspectionQty = Math.max(0, item.qualityInspectionQty);
    item.blockedQty = Math.max(0, item.blockedQty);
    item.unrestrictedKg = Math.max(0, item.unrestrictedKg);
    item.qualityInspectionKg = Math.max(0, item.qualityInspectionKg);
    item.blockedKg = Math.max(0, item.blockedKg);

    item.qualityBlockedQty = item.qualityInspectionQty + item.blockedQty;
    item.qualityBlockedKg = item.qualityInspectionKg + item.blockedKg;
    item.availableQty = Math.max(0, item.unrestrictedQty - item.reservedQty);
    item.availableKg = Math.max(0, item.unrestrictedKg - item.reservedKg);

    // Round for floating-point stability
    item.physicalQty = Math.round(item.physicalQty * 1000) / 1000;
    item.unrestrictedQty = Math.round(item.unrestrictedQty * 1000) / 1000;
    item.qualityInspectionQty = Math.round(item.qualityInspectionQty * 1000) / 1000;
    item.blockedQty = Math.round(item.blockedQty * 1000) / 1000;
    item.availableQty = Math.round(item.availableQty * 1000) / 1000;
    item.reservedQty = Math.round(item.reservedQty * 1000) / 1000;
    item.qualityBlockedQty = Math.round(item.qualityBlockedQty * 1000) / 1000;

    item.physicalKg = Math.round(item.physicalKg * 1000) / 1000;
    item.unrestrictedKg = Math.round(item.unrestrictedKg * 1000) / 1000;
    item.qualityInspectionKg = Math.round(item.qualityInspectionKg * 1000) / 1000;
    item.blockedKg = Math.round(item.blockedKg * 1000) / 1000;
    item.availableKg = Math.round(item.availableKg * 1000) / 1000;
    item.reservedKg = Math.round(item.reservedKg * 1000) / 1000;
    item.qualityBlockedKg = Math.round(item.qualityBlockedKg * 1000) / 1000;

    balances.push(item);

    if (item.lotNumber && item.physicalQty > 0) {
      activeLots.add(item.lotNumber);
    }

    totalUnrestrictedKg += item.unrestrictedKg;
    totalQualityInspectionKg += item.qualityInspectionKg;
    totalBlockedKg += item.blockedKg;

    if (item.unit === 'KG') {
      totalPhysicalKg += item.physicalQty;
      totalAvailableKg += item.availableQty;
      totalReservedKg += item.reservedKg;
      totalQualityBlockedKg += item.qualityBlockedKg;
    } else {
      totalPhysicalPcs += item.physicalQty;
      totalAvailablePcs += item.availableQty;
      totalReservedPcs += item.reservedQty;
      totalQualityBlockedPcs += item.qualityBlockedQty;
      totalPhysicalKg += item.physicalKg;
      totalAvailableKg += item.availableKg;
      totalReservedKg += item.reservedKg;
      totalQualityBlockedKg += item.qualityBlockedKg;
    }

    if (item.ownership === 'SAPCO_SUPPLIER_OWNED' || item.ownership === 'CUSTOMER_SUPPLIED') {
      totalSapcoConsignmentKg += item.physicalKg;
    } else {
      totalCompanyOwnedKg += item.physicalKg;
    }
  }

  const metrics: InventoryDashboardMetrics = {
    totalPhysicalKg: Math.round(totalPhysicalKg * 100) / 100,
    totalPhysicalPcs: Math.round(totalPhysicalPcs),
    totalAvailableKg: Math.round(totalAvailableKg * 100) / 100,
    totalAvailablePcs: Math.round(totalAvailablePcs),
    totalReservedKg: Math.round(totalReservedKg * 100) / 100,
    totalReservedPcs: Math.round(totalReservedPcs),
    totalQualityBlockedKg: Math.round(totalQualityBlockedKg * 100) / 100,
    totalQualityBlockedPcs: Math.round(totalQualityBlockedPcs),
    totalUnrestrictedKg: Math.round(totalUnrestrictedKg * 100) / 100,
    totalQualityInspectionKg: Math.round(totalQualityInspectionKg * 100) / 100,
    totalBlockedKg: Math.round(totalBlockedKg * 100) / 100,
    totalSapcoConsignmentKg: Math.round(totalSapcoConsignmentKg * 100) / 100,
    totalCompanyOwnedKg: Math.round(totalCompanyOwnedKg * 100) / 100,
    activeLotsCount: activeLots.size,
    draftDocumentsCount: documents.filter(d => d.postingStatus === 'UNPOSTED').length,
    postedDocumentsCount: postedDocs.length,
    activeContractsCount: 0,
  };

  return { balances, metrics };
}

/**
 * -------------------------------------------------------------------------
 * 2. ATOMIC DOCUMENT POSTING & CUMULATIVE NEGATIVE-STOCK PROTECTION
 * -------------------------------------------------------------------------
 * Validates document and all lines cumulatively.
 * Prevents overdraft, duplicate posting, and zero/negative quantities.
 */
export function atomicPostDocument(
  document: InventoryDocument,
  allDocuments: InventoryDocument[],
  reservations: InventoryReservation[],
  parts: Part[],
  user: { uid: string; displayName: string },
  qcHolds?: Record<string, any>
): PostDocumentResult {
  // Rule 4: Prevent duplicate posting
  if (document.postingStatus === 'POSTED') {
    return {
      success: false,
      error: `سند شماره «${document.documentNumber}» قبلاً قطعی (POSTED) شده است. ثبت مجدد مجاز نیست.`,
    };
  }

  if (document.documentStatus === 'CANCELLED') {
    return {
      success: false,
      error: `سند شماره «${document.documentNumber}» لغو شده است و امکان ثبت قطعی ندارد.`,
    };
  }

  if (!document.lines || document.lines.length === 0) {
    return {
      success: false,
      error: 'سند فاقد هرگونه ردیف کالا یا مواد است.',
    };
  }

  // Reject zero and negative quantities for ordinary opening balance, receipt, issue, and transfer lines
  const standardDocTypes: InventoryDocType[] = [
    'OPENING_BALANCE',
    'RECEIPT_RAW_MATERIAL',
    'RECEIPT_FINISHED_GOODS',
    'ISSUE_RAW_MATERIAL',
    'ISSUE_FINISHED_GOODS',
    'DELIVERY_CUSTOMER',
    'SHIPMENT_CUSTOMER',
    'TRANSFER',
    'STOCK_STATUS_TRANSFER',
  ];
  if (standardDocTypes.includes(document.documentType)) {
    for (const line of document.lines) {
      if (
        !Number.isFinite(Number(line.quantity)) ||
        Number(line.quantity) <= 0 ||
        (line.quantityKg !== undefined && (!Number.isFinite(Number(line.quantityKg)) || Number(line.quantityKg) <= 0))
      ) {
        return {
          success: false,
          error: `خطای اعتبارسنجی مقداری: مقدار ردیف «${line.lineNumber}» قطعه «${line.partCode}» باید بزرگتر از صفر باشد. مقادیر منفی یا صفر مجاز نیستند.`,
        };
      }
    }
  }

  // Transfer validation: must have distinct target warehouse or location
  if (document.documentType === 'TRANSFER') {
    if (!document.targetWarehouseId) {
      return {
        success: false,
        error: 'برای ثبت سند انتقال بین‌انباری، انتخاب انبار مقصد الزامی است.',
      };
    }
    if (
      document.warehouseId === document.targetWarehouseId &&
      document.lines.every(l => !l.targetLocationCode || l.targetLocationCode === l.locationCode)
    ) {
      return {
        success: false,
        error: 'انبار و موقعیت مبدأ و مقصد انتقال نمی‌توانند یکسان باشند.',
      };
    }
  }

  // Adjustments require reason
  if (document.documentType === 'ADJUSTMENT' && (!document.adjustmentReason || !document.adjustmentReason.trim())) {
    return {
      success: false,
      error: 'ثبت سند تعدیل انبارگردانی بدون ذکر علت تعدیل و مجوز ممیزی مجاز نمی‌باشد.',
    };
  }

  // Assign SAP MM Movement Type automatically if not specified
  const resolvedMovType = resolveSapMovementType(document.documentType, {
    explicitMovementType: document.movementType,
    totalQuantity: document.totalQuantity,
    qmTarget: document.qmStatusTarget,
  });
  document.movementType = resolvedMovType;
  document.movementLabel = SAP_MOVEMENT_CATALOG[resolvedMovType]?.labelFa;

  // Validate QM Stock Status Transfers (321 / 322 / 344)
  if (document.documentType === 'STOCK_STATUS_TRANSFER') {
    const { balances } = calculateDetailedStockBalances(allDocuments, reservations, parts, qcHolds);
    for (const line of document.lines) {
      const lineMov = line.movementType || resolvedMovType;
      const matchingBalances = balances.filter(
        b =>
          b.partId === line.partId &&
          b.warehouseId === document.warehouseId &&
          (!line.lotNumber || b.lotNumber === line.lotNumber)
      );
      if (lineMov === '322') {
        const unrestrictedAvail = matchingBalances.reduce((sum, b) => sum + Math.max(0, b.unrestrictedQty - b.reservedQty), 0);
        if (Number(line.quantity) > unrestrictedAvail + 0.001) {
          return {
            success: false,
            error: `خطای کنترل کیفی (کد ۳۲۲): موجودی آزاد (Unrestricted) برای انتقال به قرنطینه (${unrestrictedAvail}) کمتر از مقدار درخواستی (${line.quantity}) است.`,
          };
        }
      } else if (lineMov === '344') {
        const blockableTotal = matchingBalances.reduce(
          (sum, b) => sum + Math.max(0, b.unrestrictedQty - b.reservedQty) + Math.max(0, b.qualityInspectionQty),
          0
        );
        if (Number(line.quantity) > blockableTotal + 0.001) {
          return {
            success: false,
            error: `خطای مسدودسازی کیفی (کد ۳۴۴): مجموع موجودی آزاد و قرنطینه (${blockableTotal}) کمتر از مقدار درخواستی (${line.quantity}) است.`,
          };
        }
      } else if (lineMov === '321') {
        const heldTotal = matchingBalances.reduce((sum, b) => sum + b.qualityInspectionQty + b.blockedQty, 0);
        if (Number(line.quantity) > heldTotal + 0.001) {
          return {
            success: false,
            error: `خطای آزادسازی کیفی (کد ۳۲۱): موجودی در قرنطینه/مسدود (${heldTotal}) کمتر از مقدار درخواستی (${line.quantity}) است.`,
          };
        }
      }
    }
  }

  // Negative Stock & Quality Quarantine (QC Hold) Protection with CUMULATIVE validation across all lines
  const isStockDeduction = ['ISSUE_RAW_MATERIAL', 'ISSUE_FINISHED_GOODS', 'DELIVERY_CUSTOMER', 'SHIPMENT_CUSTOMER', 'TRANSFER'].includes(document.documentType);
  if (isStockDeduction) {
    const { balances } = calculateDetailedStockBalances(allDocuments, reservations, parts, qcHolds);

    // Group requested deductions by part + warehouse + lot to check cumulative demand
    const requestedMap = new Map<string, { partCode: string; totalRequested: number; lotNumber?: string }>();

    for (const line of document.lines) {
      const key = `${line.partId}:::${document.warehouseId}:::${line.lotNumber || 'ALL'}`;
      const existing = requestedMap.get(key) || {
        partCode: line.partCode,
        totalRequested: 0,
        lotNumber: line.lotNumber,
      };
      existing.totalRequested += Number(line.quantity);
      requestedMap.set(key, existing);
    }

    // Validate each cumulative requirement strictly against UNRESTRICTED available stock
    for (const [key, req] of requestedMap.entries()) {
      const [partId, warehouseId, lot] = key.split(':::');
      const matchingBalances = balances.filter(
        b =>
          b.partId === partId &&
          b.warehouseId === warehouseId &&
          (lot === 'ALL' || b.lotNumber === lot)
      );

      const totalAvailableInStore = matchingBalances.reduce((sum, b) => sum + b.availableQty, 0);
      const totalQiInStore = matchingBalances.reduce((sum, b) => sum + b.qualityInspectionQty, 0);
      const totalBlockedInStore = matchingBalances.reduce((sum, b) => sum + b.blockedQty, 0);

      if (req.totalRequested > totalAvailableInStore) {
        const qmNotes: string[] = [];
        if (totalQiInStore > 0) qmNotes.push(`${totalQiInStore} واحد در قرنطینه کنترل کیفی (QI)`);
        if (totalBlockedInStore > 0) qmNotes.push(`${totalBlockedInStore} واحد مسدود کیفی (Blocked)`);
        const qcNote = qmNotes.length > 0 ? ` [${qmNotes.join(' و ')} — تخصیص مجاز نیست]` : '';
        return {
          success: false,
          error: `خطای کنترل موجودی (حرکت ${resolvedMovType}): مجموع تقاضا برای «${req.partCode}» (${req.totalRequested}) بیش از موجودی آزاد انبار (${totalAvailableInStore}) است${qcNote}.`,
        };
      }
    }
  }

  // Negative adjustment validation: validate against the targeted stock bucket
  // (quality-held bucket for QC scrap/return write-offs, available non-reserved bucket for normal cycle counts)
  if (document.documentType === 'ADJUSTMENT') {
    const { balances } = calculateDetailedStockBalances(allDocuments, reservations, parts, qcHolds);
    for (const line of document.lines) {
      if (Number(line.quantity) < 0) {
        const absQty = Math.abs(Number(line.quantity));
        const matchingBalances = balances.filter(
          b =>
            b.partId === line.partId &&
            b.warehouseId === document.warehouseId &&
            (!line.lotNumber || b.lotNumber === line.lotNumber)
        );
        if (line.qualityStatus === 'QUALITY_BLOCKED' || line.qualityStatus === 'REJECTED') {
          const heldAvailable = matchingBalances.reduce(
            (sum, b) => sum + b.blockedQty + b.qualityInspectionQty,
            0
          );
          if (absQty > heldAvailable + 0.001) {
            return {
              success: false,
              error: `خطای خروج ضایعات/مرجوعی کیفی (کد ۷۰۲): موجودی مسدود/قرنطینه قطعه «${line.partCode}» (${heldAvailable}) کمتر از مقدار درخواستی (${absQty}) است.`,
            };
          }
        } else if (line.qualityStatus === 'QUARANTINE') {
          const qiAvailable = matchingBalances.reduce((sum, b) => sum + b.qualityInspectionQty, 0);
          if (absQty > qiAvailable + 0.001) {
            return {
              success: false,
              error: `خطای تعدیل منفی قرنطینه (کد ۷۰۲): موجودی قرنطینه قطعه «${line.partCode}» (${qiAvailable}) کمتر از مقدار درخواستی (${absQty}) است.`,
            };
          }
        } else {
          const available = matchingBalances.reduce((sum, b) => sum + b.availableQty, 0);
          if (absQty > available + 0.001) {
            return {
              success: false,
              error: `خطای تعدیل منفی (کد ۷۰۲): موجودی آزاد برای قطعه «${line.partCode}» (${available}) کمتر از مقدار تعدیل منفی درخواستی (${absQty}) است.`,
            };
          }
        }
      }
    }
  }

  // Atomically transition state
  const now = new Date().toISOString();
  document.postingStatus = 'POSTED';
  document.documentStatus = 'CONFIRMED';
  document.postedByUid = user.uid;
  document.postedByName = user.displayName;
  document.postedAt = now;
  document.updatedAt = now;

  const auditRecord: AuditRecord = {
    id: `AUD-${Date.now()}`,
    action: 'DOCUMENT_POST',
    entityName: 'InventoryDocument',
    entityId: document.documentNumber,
    user,
    details: `ثبت قطعی سند [حرکت ${resolvedMovType}] شماره ${document.documentNumber} شامل ${document.lines.length} قلم به وزن کل ${document.totalWeightKg} کیلوگرم`,
    timestamp: now,
  };

  return {
    success: true,
    postedDocument: document,
    auditRecord,
  };
}

/**
 * -------------------------------------------------------------------------
 * 3. TRANSFER REVERSAL & CORRECTION ENGINE
 * -------------------------------------------------------------------------
 * Safely reverses transfers and issues by creating compensating reversal documents.
 * Verifies that the transferred goods are still available in the destination warehouse.
 */
export function createReversalDocument(
  targetDocument: InventoryDocument,
  reason: string,
  user: { uid: string; displayName: string },
  currentStockBalances?: DetailedStockBalance[]
): ReversalResult {
  if (targetDocument.postingStatus !== 'POSTED') {
    return {
      success: false,
      error: 'فقط اسناد قطعی‌شده (POSTED) قابلیت صدور سند اصلاحی و ابطال را دارند.',
    };
  }

  if (targetDocument.documentType === 'REVERSAL') {
    return {
      success: false,
      error: 'یک سند برگشتی خود نمی‌تواند مجدداً معکوس شود.',
    };
  }

  if (!reason || !reason.trim()) {
    return {
      success: false,
      error: 'علت ابطال و ارجاع مجوز ممیزی برای صدور سند اصلاحی الزامی است.',
    };
  }

  // Transfer reversal validation: destination warehouse must still have the goods available
  if (targetDocument.documentType === 'TRANSFER' && currentStockBalances && targetDocument.targetWarehouseId) {
    for (const line of targetDocument.lines) {
      const destBalances = currentStockBalances.filter(
        b =>
          b.partId === line.partId &&
          b.warehouseId === targetDocument.targetWarehouseId &&
          (!line.lotNumber || b.lotNumber === line.lotNumber)
      );
      const available = destBalances.reduce((s, b) => s + b.availableQty, 0);
      if (available < line.quantity) {
        return {
          success: false,
          error: `امکان ابطال انتقال وجود ندارد؛ موجودی منتقل‌شده قطعه «${line.partCode}» در انبار مقصد (${targetDocument.targetWarehouseName}) مصرف شده یا انتقال یافته است. موجودی آزاد مقصد: ${available}، مورد نیاز: ${line.quantity}.`,
        };
      }
    }
  }

  // Receipt / opening-balance / positive adjustment reversal validation: source warehouse must still hold unconsumed stock
  if (
    currentStockBalances &&
    (targetDocument.documentType === 'RECEIPT_RAW_MATERIAL' ||
      targetDocument.documentType === 'RECEIPT_FINISHED_GOODS' ||
      targetDocument.documentType === 'OPENING_BALANCE' ||
      targetDocument.documentType === 'ADJUSTMENT')
  ) {
    for (const line of targetDocument.lines) {
      if (Number(line.quantity) <= 0) continue;
      const matchingBalances = currentStockBalances.filter(
        b =>
          b.partId === line.partId &&
          b.warehouseId === targetDocument.warehouseId &&
          (!line.lotNumber || b.lotNumber === line.lotNumber)
      );
      const available = matchingBalances.reduce((s, b) => s + b.availableQty, 0);
      if (available < line.quantity) {
        return {
          success: false,
          error: `امکان ابطال سند رسید وجود ندارد؛ بخشی از موجودی قطعه «${line.partCode}» در انبار «${targetDocument.warehouseName}» قبلاً حواله/مصرف یا رزرو شده است (موجودی آزاد فعلی: ${available}، مقدار رسید: ${line.quantity}). جلوگیری از منفی شدن موجودی.`,
        };
      }
    }
  }

  const now = new Date().toISOString();
  const reversalDocNumber = `REV-${targetDocument.documentNumber}`;
  const isOriginalIssue = [
    'ISSUE_RAW_MATERIAL',
    'ISSUE_FINISHED_GOODS',
    'DELIVERY_CUSTOMER',
    'SHIPMENT_CUSTOMER',
  ].includes(targetDocument.documentType);

  // For a transfer: origin was A, destination was B.
  // The reversal must decrease B and restore A.
  const isTransfer = targetDocument.documentType === 'TRANSFER';
  const isQmTransfer = targetDocument.documentType === 'STOCK_STATUS_TRANSFER';

  const origMovementType =
    targetDocument.movementType ||
    resolveSapMovementType(targetDocument.documentType, {
      totalQuantity: targetDocument.totalQuantity,
      qmTarget: targetDocument.qmStatusTarget,
    });
  const reversalMovementType = getSapMovementReversal(origMovementType);
  const reversalMovementLabel = SAP_MOVEMENT_CATALOG[reversalMovementType]?.labelFa;

  const reversedLines: InventoryDocumentLine[] = targetDocument.lines.map((l, index) => {
    // If it's a transfer or QM transfer reversal, quantity remains positive with compensating movementType
    const revQty = (isTransfer || isQmTransfer) ? Math.abs(l.quantity) : isOriginalIssue ? Math.abs(l.quantity) : -l.quantity;
    const revQtyKg = (isTransfer || isQmTransfer) ? Math.abs(l.quantityKg) : isOriginalIssue ? Math.abs(l.quantityKg) : -l.quantityKg;

    return {
      ...l,
      id: `REV-LINE-${Date.now()}-${index}`,
      documentId: `DOC-${reversalDocNumber}`,
      movementType: reversalMovementType,
      quantity: revQty,
      quantityKg: revQtyKg,
      notes: `ابطال ردیف ${l.lineNumber} سند ${targetDocument.documentNumber} [حرکت ${reversalMovementType}]: ${reason}`,
    };
  });

  const reversalDoc: InventoryDocument = {
    id: `DOC-REV-${Date.now()}`,
    documentNumber: reversalDocNumber,
    documentType: isTransfer ? 'TRANSFER' : isQmTransfer ? 'STOCK_STATUS_TRANSFER' : 'REVERSAL',
    movementType: reversalMovementType,
    movementLabel: reversalMovementLabel,
    documentDate: now,
    documentStatus: 'CONFIRMED',
    postingStatus: 'POSTED',
    // In transfer reversal: source is old target, target is old source
    warehouseId: isTransfer ? targetDocument.targetWarehouseId! : targetDocument.warehouseId,
    warehouseName: isTransfer ? targetDocument.targetWarehouseName! : targetDocument.warehouseName,
    targetWarehouseId: isTransfer ? targetDocument.warehouseId : targetDocument.targetWarehouseId,
    targetWarehouseName: isTransfer ? targetDocument.warehouseName : targetDocument.targetWarehouseName,
    ownership: targetDocument.ownership,
    contractId: targetDocument.contractId,
    contractNumber: targetDocument.contractNumber,
    referenceType: 'REVERSAL_OF',
    referenceNumber: targetDocument.documentNumber,
    reversalOfDocumentId: targetDocument.id,
    reversalOfDocNumber: targetDocument.documentNumber,
    reversalOfDocumentNumber: targetDocument.documentNumber,
    adjustmentReason: reason,
    auditNote: `سند ابطال [حرکت ${reversalMovementType}] صادره توسط ${user.displayName} جهت ابطال سند ${targetDocument.documentNumber} (حرکت ${origMovementType}). علت: ${reason}`,
    lines: reversedLines,
    totalQuantity: (isTransfer || isQmTransfer)
      ? Math.abs(targetDocument.totalQuantity)
      : isOriginalIssue
      ? Math.abs(targetDocument.totalQuantity)
      : -targetDocument.totalQuantity,
    totalWeightKg: (isTransfer || isQmTransfer)
      ? Math.abs(targetDocument.totalWeightKg)
      : isOriginalIssue
      ? Math.abs(targetDocument.totalWeightKg)
      : -targetDocument.totalWeightKg,
    createdByUid: user.uid,
    createdByName: user.displayName,
    postedByUid: user.uid,
    postedByName: user.displayName,
    postedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  // Mark original document as REVERSED
  targetDocument.postingStatus = 'REVERSED';
  targetDocument.updatedAt = now;

  const auditRecord: AuditRecord = {
    id: `AUD-${Date.now()}`,
    action: 'DOCUMENT_REVERSE',
    entityName: 'InventoryDocument',
    entityId: targetDocument.documentNumber,
    user,
    details: `ابطال سند شماره ${targetDocument.documentNumber} (حرکت ${origMovementType}) و صدور سند جبرانی ${reversalDocNumber} (حرکت ${reversalMovementType}). دلیل: ${reason}`,
    timestamp: now,
  };

  return {
    success: true,
    originalDocument: targetDocument,
    reversalDocument: reversalDoc,
    auditRecord,
  };
}

/**
 * -------------------------------------------------------------------------
 * 4. SAPCO & CUSTOMER CONTRACT LEDGER ENGINE
 * -------------------------------------------------------------------------
 * Tracks Opening, Receipts, Consumption, Returns, and Closing balance in kilograms.
 * 
 * Critical Rules:
 * - Never auto-assign unlinked transactions to the first contract!
 * - Never count company-owned material as customer/SAPCO material.
 * - Opening balance is never counted twice.
 * - Reconciles contract balances against physical inventory and transactions.
 */
export function calculateSapcoContractLedger(
  contracts: SapcoContract[],
  documents: InventoryDocument[]
): {
  contractsWithBalances: SapcoContract[];
  ledgerEntries: SapcoContractLedgerEntry[];
} {
  const postedDocs = documents
    .filter(d => d.postingStatus === 'POSTED' || d.postingStatus === 'REVERSED')
    .sort((a, b) => new Date(a.documentDate).getTime() - new Date(b.documentDate).getTime());

  const contractMap = new Map<string, SapcoContract>();
  contracts.forEach(c => {
    contractMap.set(c.id, {
      ...c,
      totalReceivedKg: 0,
      totalConsumedKg: 0,
      closingBalanceKg: c.openingBalanceKg || 0,
    });
  });

  const ledgerEntries: SapcoContractLedgerEntry[] = [];

  // Track if an opening balance document exists in postedDocs to avoid double-counting
  const contractsWithOpeningDoc = new Set<string>();
  for (const doc of postedDocs) {
    if (doc.documentType === 'OPENING_BALANCE' && doc.contractId) {
      contractsWithOpeningDoc.add(doc.contractId);
    }
  }

  // Seed opening balance entries only if NO explicit opening balance document is present
  contracts.forEach(c => {
    if (c.openingBalanceKg > 0 && !contractsWithOpeningDoc.has(c.id)) {
      ledgerEntries.push({
        id: `LEDGER-OP-${c.id}`,
        contractId: c.id,
        contractNumber: c.contractNumber,
        documentNumber: `INIT-${c.contractNumber}`,
        date: c.startDate,
        operationType: 'OPENING',
        weightKgSigned: c.openingBalanceKg,
        runningBalanceKg: c.openingBalanceKg,
        notes: 'مانده سهمیه اولیه دوره',
      });
    } else if (contractsWithOpeningDoc.has(c.id)) {
      // Set initial closing balance to 0 so the opening doc accumulates it cleanly
      const contract = contractMap.get(c.id);
      if (contract) contract.closingBalanceKg = 0;
    }
  });

  for (const doc of postedDocs) {
    for (const line of doc.lines) {
      // Rule: Do not count company-owned material as contract material
      if (line.ownership === 'COMPANY_OWNED') continue;

      // Rule: Do NOT auto-assign to first contract! Must have explicit matching contractId
      if (!line.contractId) continue;
      const contract = contractMap.get(line.contractId);
      if (!contract) continue;

      let signedKg = 0;
      let opType: SapcoContractLedgerEntry['operationType'] = 'RECEIPT';

      if (doc.documentType === 'OPENING_BALANCE') {
        signedKg = line.quantityKg;
        opType = 'OPENING';
        contract.closingBalanceKg += signedKg;
      } else if (['RECEIPT_RAW_MATERIAL'].includes(doc.documentType)) {
        const isProductionReturn =
          doc.movementType === '262' ||
          line.movementType === '262' ||
          doc.referenceType === 'PRODUCTION_RETURN';
        signedKg = line.quantityKg;
        if (isProductionReturn) {
          opType = 'RETURN';
          contract.totalConsumedKg = Math.max(0, contract.totalConsumedKg - signedKg);
          contract.closingBalanceKg += signedKg;
        } else {
          opType = 'RECEIPT';
          contract.totalReceivedKg += signedKg;
          contract.closingBalanceKg += signedKg;
        }
      } else if (doc.documentType === 'ISSUE_RAW_MATERIAL') {
        signedKg = -line.quantityKg;
        opType = 'CONSUMPTION';
        contract.totalConsumedKg += line.quantityKg;
        contract.closingBalanceKg -= line.quantityKg;
      } else if (doc.documentType === 'REVERSAL' || doc.documentType === 'ADJUSTMENT') {
        signedKg = line.quantityKg;
        opType = doc.referenceType === 'SUPPLIER_RETURN' ? 'RETURN' : 'ADJUSTMENT';
        contract.closingBalanceKg += signedKg;
        if (doc.documentType === 'REVERSAL' && signedKg > 0) {
          contract.totalConsumedKg = Math.max(0, contract.totalConsumedKg - signedKg);
        } else if (doc.referenceType === 'SUPPLIER_RETURN' && signedKg < 0) {
          contract.totalReceivedKg = Math.max(0, contract.totalReceivedKg + signedKg);
        }
      }

      ledgerEntries.push({
        id: `LEDGER-${doc.documentNumber}-${line.id}`,
        contractId: contract.id,
        contractNumber: contract.contractNumber,
        documentNumber: doc.documentNumber,
        date: doc.postedAt || doc.documentDate,
        waybillNumber: doc.referenceNumber || line.heatNumber,
        lotNumber: line.lotNumber,
        heatNumber: line.heatNumber,
        operationType: opType,
        weightKgSigned: Math.round(signedKg * 100) / 100,
        runningBalanceKg: Math.round(contract.closingBalanceKg * 100) / 100,
        notes: line.notes || doc.adjustmentReason || doc.referenceType,
      });
    }
  }

  const contractsWithBalances = Array.from(contractMap.values()).map(c => ({
    ...c,
    totalReceivedKg: Math.round(c.totalReceivedKg * 100) / 100,
    totalConsumedKg: Math.round(c.totalConsumedKg * 100) / 100,
    closingBalanceKg: Math.round(c.closingBalanceKg * 100) / 100,
  }));

  return { contractsWithBalances, ledgerEntries };
}

/**
 * -------------------------------------------------------------------------
 * 5. PHYSICAL COIL & PARTIAL ISSUE / RETURN MANAGEMENT
 * -------------------------------------------------------------------------
 * Supports:
 * - 1 Physical coil allocated to multiple contracts
 * - 1 Contract covering multiple physical coils
 * - Partial issue to production and partial return to warehouse
 * - Split coils / remnants with parent-child links
 */
export function issuePhysicalCoilPartial(
  coil: PhysicalCoil,
  issuedWeightKg: number,
  manufacturingOrderId: string,
  documentNumberOrOp?: string,
  scrappedKg: number = 0,
  user?: { uid: string; displayName: string }
): { success: boolean; error?: string; record?: CoilIssueReturnRecord; issueRecord?: CoilIssueReturnRecord } {
  if (issuedWeightKg <= 0) {
    return { success: false, error: 'وزن خروجی کلاف باید بزرگتر از صفر باشد.' };
  }

  if (issuedWeightKg > coil.remainingWeightKg) {
    return {
      success: false,
      error: `خطای وزن: وزن درخواستی (${issuedWeightKg} kg) بیش از مانده کلاف «${coil.coilPackNumber}» (${coil.remainingWeightKg} kg) است.`,
    };
  }

  coil.remainingWeightKg = Math.round((coil.remainingWeightKg - issuedWeightKg) * 1000) / 1000;
  coil.physicalStatus = coil.remainingWeightKg === 0 ? 'CONSUMED' : 'PARTIALLY_ISSUED';
  coil.updatedAt = new Date().toISOString();

  const record: CoilIssueReturnRecord = {
    id: `CIR-${Date.now()}`,
    coilId: coil.id,
    manufacturingOrderId,
    documentNumber: documentNumberOrOp || `ISS-${coil.coilId}`,
    issuedWeightKg,
    consumedWeightKg: 0,
    returnedWeightKg: 0,
    outstandingWeightKg: issuedWeightKg,
    varianceWeightKg: scrappedKg,
    scrappedKg,
    status: 'ISSUED',
    issuedAt: new Date().toISOString(),
    notes: `حواله ${issuedWeightKg} کیلوگرم به کارت ساخت ${manufacturingOrderId}`,
  };

  return { success: true, record, issueRecord: record };
}

export function returnPhysicalCoilPartial(
  coil: PhysicalCoil,
  returnedWeightKg: number,
  param3?: any,
  param4?: any,
  param5?: any,
  param6?: any
): { success: boolean; error?: string; record?: CoilIssueReturnRecord; returnRecord?: CoilIssueReturnRecord } {
  if (returnedWeightKg <= 0) {
    return { success: false, error: 'وزن برگشتی به انبار باید بزرگتر از صفر باشد.' };
  }

  coil.remainingWeightKg = Math.round((coil.remainingWeightKg + returnedWeightKg) * 1000) / 1000;
  coil.physicalStatus = 'AVAILABLE';
  coil.updatedAt = new Date().toISOString();

  const lastIssueRecord: CoilIssueReturnRecord | undefined =
    typeof param3 === 'object' && param3 !== null && 'outstandingWeightKg' in param3
      ? param3
      : typeof param4 === 'object' && param4 !== null && 'outstandingWeightKg' in param4
      ? param4
      : undefined;

  const varianceWeightKg =
    typeof param4 === 'number'
      ? param4
      : typeof param5 === 'number'
      ? param5
      : 0;

  if (lastIssueRecord) {
    lastIssueRecord.returnedWeightKg += returnedWeightKg;
    lastIssueRecord.varianceWeightKg += varianceWeightKg;
    lastIssueRecord.outstandingWeightKg = Math.max(
      0,
      lastIssueRecord.outstandingWeightKg - returnedWeightKg - varianceWeightKg
    );
    lastIssueRecord.status = lastIssueRecord.outstandingWeightKg === 0 ? 'FULLY_RETURNED' : 'PARTIALLY_RETURNED';
    lastIssueRecord.returnedAt = new Date().toISOString();
  }

  const returnRecord: CoilIssueReturnRecord = {
    id: `CRR-${Date.now()}`,
    coilId: coil.id,
    manufacturingOrderId: lastIssueRecord?.manufacturingOrderId || 'MO-RETURN',
    documentNumber: typeof param3 === 'string' ? param3 : `RET-${coil.coilId}`,
    issuedWeightKg: 0,
    consumedWeightKg: 0,
    returnedWeightKg,
    outstandingWeightKg: 0,
    varianceWeightKg,
    status: 'FULLY_RETURNED',
    issuedAt: lastIssueRecord?.issuedAt || new Date().toISOString(),
    returnedAt: new Date().toISOString(),
    notes: typeof param4 === 'string' ? param4 : typeof param5 === 'string' ? param5 : 'برگشت ته‌کلاف به انبار',
  };

  return { success: true, record: returnRecord, returnRecord };
}

/**
 * -------------------------------------------------------------------------
 * 6. CUSTOMIZABLE INVENTORY REPORT BUILDER
 * -------------------------------------------------------------------------
 * Generates custom reports A through E with grouping, column projection, and aggregations.
 */
export function buildCustomInventoryReport(
  param1: any,
  param2?: any,
  param3?: any,
  param4?: any,
  param5?: any
): any {
  // Support both object options pattern and positional arguments
  let reportType = 'COILS_SUMMARY';
  let filters: any = {};
  let coils: PhysicalCoil[] = [];
  let balances: DetailedStockBalance[] = [];
  let contracts: SapcoContract[] = [];

  if (typeof param1 === 'object' && param1 !== null && param1.reportType) {
    reportType = param1.reportType;
    filters = param1.filters || {};
    coils = param1.coils || [];
    balances = param1.stockBalances || param1.balances || [];
    contracts = param1.contracts || [];
  } else {
    reportType = param1 || 'COILS_SUMMARY';
    filters = param2 || {};
    coils = param3 || [];
    balances = param4 || [];
    contracts = param5 || [];
  }

  let columns: string[] = [];
  let rows: any[] = [];
  let summary: Record<string, any> = {};

  switch (reportType) {
    case 'COILS_SUMMARY': {
      columns = ['گرید متریال', 'ضخامت (mm)', 'عرض (mm)', 'شماره پکینگ ساپکو', 'تعداد کلاف', 'مجموع وزن اولیه (kg)', 'موجودی باقیمانده (kg)', 'وضعیت'];
      const groups = new Map<string, any>();
      for (const coil of coils) {
        if (filters.materialGrade && coil.materialGrade !== filters.materialGrade) continue;
        if (filters.coilPackNumber && !coil.coilPackNumber.toLowerCase().includes(filters.coilPackNumber.toLowerCase())) continue;
        if (filters.warehouseId && coil.warehouseId !== filters.warehouseId) continue;
        if (filters.ownership && coil.ownership !== filters.ownership) continue;

        const groupKey = `${coil.materialGrade}:::${coil.thicknessMm}:::${coil.widthMm}:::${coil.coilPackNumber}`;
        if (!groups.has(groupKey)) {
          groups.set(groupKey, {
            materialGrade: coil.materialGrade,
            thicknessMm: coil.thicknessMm,
            widthMm: coil.widthMm,
            coilPackNumber: coil.coilPackNumber,
            totalCoilsCount: 0,
            totalPhysicalWeightKg: 0,
            totalRemainingWeightKg: 0,
            status: coil.physicalStatus,
          });
        }
        const g = groups.get(groupKey)!;
        g.totalCoilsCount += 1;
        g.totalPhysicalWeightKg += coil.originalWeightKg;
        g.totalRemainingWeightKg += coil.remainingWeightKg;
      }
      rows = Array.from(groups.values());
      const totalCoils = rows.reduce((s, r) => s + r.totalCoilsCount, 0);
      const totalWeightKg = rows.reduce((s, r) => s + r.totalRemainingWeightKg, 0);
      summary = { totalCoils, totalWeightKg, totalPhysicalWeightKg: totalWeightKg };
      break;
    }

    case 'COIL_PACK_INQUIRY': {
      columns = ['شناسه کویل', 'شماره پکینگ', 'کد کالا', 'شرح ورق', 'گرید', 'ضخامت', 'عرض', 'وزن اولیه', 'وزن باقیمانده', 'انبار', 'مالکیت', 'وضعیت'];
      rows = coils
        .filter(c => {
          if (filters.partId && c.partId !== filters.partId) return false;
          if (filters.materialGrade && c.materialGrade !== filters.materialGrade) return false;
          if (filters.coilPackNumber && !c.coilPackNumber.toLowerCase().includes(filters.coilPackNumber.toLowerCase())) return false;
          if (filters.warehouseId && c.warehouseId !== filters.warehouseId) return false;
          if (filters.ownership && c.ownership !== filters.ownership) return false;
          return true;
        })
        .map(c => ({
          coilId: c.coilId,
          coilPackNumber: c.coilPackNumber,
          partCode: c.partCode,
          partName: c.partName,
          materialGrade: c.materialGrade,
          thicknessMm: c.thicknessMm,
          widthMm: c.widthMm,
          originalWeightKg: c.originalWeightKg,
          remainingWeightKg: c.remainingWeightKg,
          warehouseName: c.warehouseName,
          ownership: c.ownership,
          status: c.physicalStatus,
          allocations: c.allocations || [],
        }));
      summary = {
        totalCoils: rows.length,
        totalWeightKg: rows.reduce((s, r) => s + r.remainingWeightKg, 0),
      };
      break;
    }

    case 'CONTRACT_STOCK':
    case 'CONTRACT_INVENTORY': {
      columns = ['شناسه قرارداد', 'عنوان قرارداد / سهمیه', 'وزن تخصیصی (kg)', 'تعداد کلاف‌های مرتبط'];
      const contractAllocMap = new Map<string, { contractId: string; contractNumber: string; title: string; allocatedWeightKg: number; coilsCount: number }>();

      // Populate from known contracts
      for (const contract of contracts) {
        contractAllocMap.set(contract.id, {
          contractId: contract.id,
          contractNumber: contract.contractNumber,
          title: contract.title,
          allocatedWeightKg: 0,
          coilsCount: 0,
        });
      }

      // Aggregate allocations from coils
      for (const coil of coils) {
        if (coil.allocations) {
          for (const a of coil.allocations) {
            const cId = a.contractId || a.contractNumber;
            if (!contractAllocMap.has(cId)) {
              contractAllocMap.set(cId, {
                contractId: cId,
                contractNumber: a.contractNumber || cId,
                title: `قرارداد ${a.contractNumber || cId}`,
                allocatedWeightKg: 0,
                coilsCount: 0,
              });
            }
            const entry = contractAllocMap.get(cId)!;
            entry.allocatedWeightKg += a.allocatedWeightKg;
            entry.coilsCount += 1;
          }
        }
      }

      rows = Array.from(contractAllocMap.values()).filter(r => {
        if (filters.contractId && r.contractId !== filters.contractId && r.contractNumber !== filters.contractId) return false;
        return true;
      });

      summary = {
        totalContracts: rows.length,
        totalAllocatedWeightKg: rows.reduce((s, r) => s + r.allocatedWeightKg, 0),
      };
      break;
    }

    case 'WAREHOUSE_STOCK': {
      columns = ['کد قطعه', 'نام کالا', 'انبار', 'موقعیت (LOC)', 'موجودی فیزیکی', 'رزرو', 'مسدود کیفی', 'موجودی آزاد', 'واحد'];
      rows = balances
        .filter(b => !filters.warehouseId || b.warehouseId === filters.warehouseId)
        .map(b => ({
          partCode: b.partCode,
          partName: b.partName,
          warehouseName: b.warehouseName,
          locationCode: b.locationCode,
          physicalQty: b.physicalQty,
          physicalKg: b.physicalKg,
          reservedQty: b.reservedQty,
          reservedKg: b.reservedKg,
          qualityBlockedQty: b.qualityBlockedQty,
          qualityBlockedKg: b.qualityBlockedKg,
          availableQty: b.availableQty,
          availableKg: b.availableKg,
          unit: b.unit,
        }));
      summary = {
        totalItems: rows.length,
        totalPhysicalKg: rows.reduce((s, r) => s + r.physicalKg, 0),
        totalAvailableKg: rows.reduce((s, r) => s + r.availableKg, 0),
      };
      break;
    }

    case 'OWNERSHIP_REPORT': {
      columns = ['کد قطعه', 'نام کالا', 'انبار', 'نوع مالکیت', 'موجودی فیزیکی', 'وزن (kg)', 'موجودی آزاد', 'شماره قرارداد'];
      rows = balances
        .filter(b => !filters.ownership || b.ownership === filters.ownership)
        .map(b => ({
          partCode: b.partCode,
          partName: b.partName,
          warehouseName: b.warehouseName,
          ownership: b.ownership,
          physicalQty: b.physicalQty,
          physicalKg: b.physicalKg,
          availableKg: b.availableKg,
          contractNumber: b.contractNumber || 'سهمیه آزاد / ملکی',
        }));
      summary = {
        totalRows: rows.length,
        totalKg: rows.reduce((s, r) => s + r.physicalKg, 0),
      };
      break;
    }
  }

  const resultArr: any = [...rows];
  resultArr.rows = rows;
  resultArr.columns = columns;
  resultArr.summary = summary;
  return resultArr;
}

/**
 * -------------------------------------------------------------------------
 * 7. IMPORT & EXPORT VALIDATION ENGINE
 * -------------------------------------------------------------------------
 * Validates rows, checks duplicate IDs, unknown codes, negative stock,
 * and guards against CSV formula injection.
 */
export function sanitizeCsvValue(val: any): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  // Prevent spreadsheet formula injection (=, +, -, @)
  if (/^[=+\-@]/.test(str)) {
    return `'${str}`;
  }
  return str;
}

export function normalizeExcelDigits(val: any): string {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .trim();
}

export function parseExcelNumber(val: any, fallback = 0): number {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  const cleaned = normalizeExcelDigits(val)
    .replace(/[,٬،\s]/g, '')
    .replace(/\/(?=\d+$)/, '.');
  if (!cleaned) return fallback;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : fallback;
}

export function normalizePartCategory(
  raw: any,
  codeHint?: string
): 'RAW_MATERIAL' | 'WIP_PART' | 'FINISHED_GOOD' {
  const s = normalizeExcelDigits(raw).toUpperCase();
  if (
    s === 'WIP_PART' ||
    s === 'WIP' ||
    s === 'SEMI_FINISHED' ||
    s.includes('نیمه') ||
    s.includes('WIP')
  ) {
    return 'WIP_PART';
  }
  if (
    s === 'FINISHED_GOOD' ||
    s === 'FINISHED' ||
    s === 'FG' ||
    s === 'PRODUCT' ||
    s.includes('نهایی') ||
    s.includes('محصول')
  ) {
    return 'FINISHED_GOOD';
  }
  if (
    s === 'RAW_MATERIAL' ||
    s === 'RAW' ||
    s === 'SHEET' ||
    s === 'COIL' ||
    s === 'CONSUMABLE' ||
    s === 'SPARE_PART' ||
    s.includes('ماده') ||
    s.includes('مواد') ||
    s.includes('ورق') ||
    s.includes('کویل') ||
    s.includes('رول')
  ) {
    return 'RAW_MATERIAL';
  }
  const upperCode = normalizeExcelDigits(codeHint).toUpperCase();
  if (upperCode.startsWith('WIP-')) return 'WIP_PART';
  if (upperCode.startsWith('FG-') || upperCode.startsWith('SAPCO-ASY')) return 'FINISHED_GOOD';
  return 'RAW_MATERIAL';
}

export function normalizePartUnit(
  raw: any,
  category?: 'RAW_MATERIAL' | 'WIP_PART' | 'FINISHED_GOOD'
): 'KG' | 'PCS' {
  const s = normalizeExcelDigits(raw).toUpperCase();
  if (s === 'KG' || s === 'KILOGRAM' || s === 'COIL' || s === 'ROLL' || s.includes('کیلو') || s.includes('کيلو') || s.includes('رول') || s.includes('کلاف')) return 'KG';
  if (s === 'PCS' || s === 'PC' || s === 'PIECE' || s === 'EA' || s === 'SHEET' || s === 'PALLET' || s.includes('عدد') || s.includes('قطعه') || s.includes('شیت') || s.includes('برگ') || s.includes('پالت')) return 'PCS';
  return category === 'RAW_MATERIAL' ? 'KG' : 'PCS';
}

function getRowFieldByAliases(row: Record<string, any>, aliases: string[]): any {
  for (const alias of aliases) {
    if (row[alias] !== undefined && row[alias] !== null && String(row[alias]).trim() !== '') {
      return row[alias];
    }
  }
  const entries = Object.entries(row || {});
  for (const alias of aliases) {
    const normAlias = alias.toLowerCase().trim();
    for (const [k, v] of entries) {
      if (v === undefined || v === null || String(v).trim() === '') continue;
      const normKey = k.toLowerCase().trim();
      const keyBase = normKey.split('(')[0].trim();
      if (normKey === normAlias || keyBase === normAlias || normKey.includes(normAlias)) {
        return v;
      }
    }
  }
  return undefined;
}

export function extractPartRowFields(row: Record<string, any>) {
  const codeRaw = getRowFieldByAliases(row, [
    'code',
    'partCode',
    'partNumber',
    'itemCode',
    'کد کالا / قطعه',
    'کد قطعه',
    'کد کالا',
    'کد فنی',
    'شماره فنی',
    'کد',
  ]);
  const nameRaw = getRowFieldByAliases(row, [
    'name',
    'partName',
    'itemName',
    'title',
    'description',
    'شرح قطعه',
    'نام قطعه',
    'عنوان فارسی قطعه',
    'نام کالا',
    'عنوان قطعه',
    'شرح کالا',
    'عنوان',
    'شرح',
  ]);
  const categoryRaw = getRowFieldByAliases(row, [
    'category',
    'type',
    'group',
    'دسته کالا (RAW_MATERIAL / FINISHED_GOOD / WIP)',
    'دسته کالا',
    'دسته‌بندی',
    'دسته بندی',
    'گروه کالا',
    'گروه',
    'نوع کالا',
    'نوع قطعه',
  ]);
  const unitRaw = getRowFieldByAliases(row, [
    'unit',
    'uom',
    'unitCode',
    'واحد سنجش (KG / PCS)',
    'واحد سنجش',
    'واحد اندازه‌گیری',
    'واحد اندازه گیری',
    'واحد',
  ]);
  const weightRaw = getRowFieldByAliases(row, [
    'weightPerUnitKg',
    'weightNetKg',
    'weightKg',
    'weight',
    'وزن واحد (kg)',
    'وزن واحد (کیلوگرم)',
    'وزن واحد',
    'وزن خالص',
    'وزن',
  ]);
  const gradeRaw = getRowFieldByAliases(row, [
    'materialGrade',
    'grade',
    'material',
    'گرید متریال',
    'گرید فولاد',
    'گرید ورق',
    'جنس',
    'گرید',
  ]);
  const thicknessRaw = getRowFieldByAliases(row, [
    'thicknessMm',
    'thickness',
    'ضخامت (mm)',
    'ضخامت ورق (mm)',
    'ضخامت',
  ]);
  const carModelRaw = getRowFieldByAliases(row, [
    'carModel',
    'vehicle',
    'مدل خودرو',
    'خودرو',
  ]);
  const sapcoCodeRaw = getRowFieldByAliases(row, [
    'sapcoCode',
    'supplierPartNumber',
    'customerPartNumber',
    'کد ساپکو / ایران‌خودرو',
    'کد ساپکو',
  ]);
  const minStockRaw = getRowFieldByAliases(row, [
    'minStock',
    'minSafetyStock',
    'حداقل موجودی اطمینان',
    'حداقل موجودی',
    'نقطه سفارش',
  ]);
  const maxStockRaw = getRowFieldByAliases(row, [
    'maxStock',
    'حداکثر ظرفیت',
    'حداکثر موجودی',
  ]);
  const leadTimeRaw = getRowFieldByAliases(row, [
    'leadTimeDays',
    'leadTime',
    'زمان انتظار (روز)',
    'زمان انتظار',
    'مدت تامین',
  ]);
  const openingQtyRaw = getRowFieldByAliases(row, [
    'quantity',
    'openingBalance',
    'initialStock',
    'stock',
    'physicalQty',
    'موجودی اول دوره',
    'مقدار اول دوره',
    'موجودی',
    'مقدار',
  ]);

  const code = normalizeExcelDigits(codeRaw);
  const name = String(nameRaw ?? '').trim();
  const category = normalizePartCategory(categoryRaw, code);
  const unit = normalizePartUnit(unitRaw, category);
  const weightPerUnitKg = parseExcelNumber(weightRaw, 1) || 1;
  const materialGrade = normalizeExcelDigits(gradeRaw) || undefined;
  const thicknessParsed = parseExcelNumber(thicknessRaw, NaN);
  const thicknessMm = Number.isFinite(thicknessParsed) && thicknessParsed > 0 ? thicknessParsed : undefined;
  const carModel = carModelRaw ? String(carModelRaw).trim() : undefined;
  const sapcoCode = sapcoCodeRaw ? normalizeExcelDigits(sapcoCodeRaw) : undefined;
  const minStock = parseExcelNumber(minStockRaw, 0);
  const maxStockParsed = parseExcelNumber(maxStockRaw, NaN);
  const maxStock = Number.isFinite(maxStockParsed) && maxStockParsed > 0 ? maxStockParsed : undefined;
  const leadTimeParsed = parseExcelNumber(leadTimeRaw, NaN);
  const leadTimeDays = Number.isFinite(leadTimeParsed) && leadTimeParsed >= 1 ? Math.round(leadTimeParsed) : undefined;
  const openingQty = parseExcelNumber(openingQtyRaw, 0);

  return {
    code,
    name,
    category,
    unit,
    weightPerUnitKg,
    materialGrade,
    thicknessMm,
    carModel,
    sapcoCode,
    minStock,
    maxStock,
    leadTimeDays,
    openingQty,
  };
}

export function validateImportBatchRows(
  templateType: string,
  rows: Record<string, any>[],
  parts: Part[] = [],
  arg4?: any,
  arg5?: any
): {
  isValid: boolean;
  validRows: any[];
  errors: { rowNumber: number; fieldName: string; errorMessage: string }[];
  invalidRows: { rowNumber: number; fieldName: string; errorMessage: string }[];
} {
  const errors: { rowNumber: number; fieldName: string; errorMessage: string }[] = [];
  const validRows: any[] = [];
  const partsCodeMap = new Map<string, Part>();
  parts.forEach(p => partsCodeMap.set(p.code.toUpperCase(), p));

  const seenIds = new Set<string>();

  rows.forEach((row, idx) => {
    const rowNum = idx + 2; // Row 1 is header
    const typeUpper = (templateType || '').toUpperCase();

    if (typeUpper === 'ITEM_MASTER' || typeUpper === 'PARTS' || typeUpper === 'ITEMS') {
      const extracted = extractPartRowFields(row);
      const { code, name, openingQty, minStock } = extracted;

      let hasRowError = false;
      if (!code) {
        errors.push({ rowNumber: rowNum, fieldName: 'code', errorMessage: `کد قطعه در ردیف ${rowNum} الزامی است.` });
        hasRowError = true;
      }
      if (!name) {
        errors.push({ rowNumber: rowNum, fieldName: 'name', errorMessage: `نام قطعه در ردیف ${rowNum} الزامی است.` });
        hasRowError = true;
      }
      if (openingQty < 0 || Number.isNaN(openingQty)) {
        errors.push({ rowNumber: rowNum, fieldName: 'openingQty', errorMessage: `موجودی اول دوره در ردیف ${rowNum} نمی‌تواند منفی یا نامعتبر باشد.` });
        hasRowError = true;
      }
      if (minStock < 0 || Number.isNaN(minStock)) {
        errors.push({ rowNumber: rowNum, fieldName: 'minStock', errorMessage: `حداقل موجودی اطمینان در ردیف ${rowNum} نمی‌تواند منفی یا نامعتبر باشد.` });
        hasRowError = true;
      }
      if (code && seenIds.has(String(code).toUpperCase())) {
        errors.push({ rowNumber: rowNum, fieldName: 'code', errorMessage: `کد قطعه «${code}» در ردیف ${rowNum} تکراری است.` });
        hasRowError = true;
      }
      if (code) seenIds.add(String(code).toUpperCase());

      if (!hasRowError && code && name) {
        validRows.push({
          ...row,
          ...extracted,
        });
      }
    } else if (typeUpper === 'COILS' || typeUpper === 'PHYSICAL_COILS') {
      const coilPack = getRowFieldByAliases(row, ['coilPackNumber', 'شماره پکینگ ساپکو', 'شماره پکینگ', 'coilId', 'شناسه کویل']);
      const partCode = getRowFieldByAliases(row, ['partCode', 'کد قطعه / ورق', 'کد قطعه', 'کد کالا', 'code']);
      const weight = parseExcelNumber(getRowFieldByAliases(row, ['weightKg', 'originalWeightKg', 'وزن فیزیکی (kg)', 'وزن باسکول (kg)', 'وزن']), 0);

      let hasRowError = false;
      if (!coilPack) {
        errors.push({ rowNumber: rowNum, fieldName: 'coilPackNumber', errorMessage: `شماره پکینگ ساپکو در ردیف ${rowNum} الزامی است.` });
        hasRowError = true;
      }
      if (!partCode) {
        errors.push({ rowNumber: rowNum, fieldName: 'partCode', errorMessage: `کد قطعه / ورق در ردیف ${rowNum} الزامی است.` });
        hasRowError = true;
      }
      if (isNaN(weight) || weight <= 0) {
        errors.push({ rowNumber: rowNum, fieldName: 'weightKg', errorMessage: `وزن کلاف در ردیف ${rowNum} نامعتبر است (باید عددی مثبت باشد).` });
        hasRowError = true;
      }

      if (!hasRowError && coilPack && partCode && weight > 0) {
        validRows.push({
          ...row,
          coilPackNumber: normalizeExcelDigits(coilPack),
          partCode: normalizeExcelDigits(partCode),
          weightKg: weight,
        });
      }
    } else if (typeUpper === 'INVENTORY_RECEIPTS' || typeUpper === 'INVENTORY_ISSUES' || typeUpper === 'OPENING_BALANCES' || typeUpper === 'STOCK_COUNT') {
      const partCode = normalizeExcelDigits(getRowFieldByAliases(row, ['partCode', 'کد قطعه', 'کد کالا', 'code'])).toUpperCase();
      const qty = parseExcelNumber(getRowFieldByAliases(row, ['quantity', 'مقدار اول دوره', 'تعداد/وزن', 'مقدار']), 0);
      const warehouseCode = getRowFieldByAliases(row, ['warehouseId', 'warehouseCode', 'کد انبار']);

      let hasRowError = false;
      if (!partCode) {
        errors.push({ rowNumber: rowNum, fieldName: 'partCode', errorMessage: `کد قطعه در ردیف ${rowNum} الزامی است.` });
        hasRowError = true;
      }
      if (isNaN(qty) || qty <= 0) {
        errors.push({ rowNumber: rowNum, fieldName: 'quantity', errorMessage: `مقدار در ردیف ${rowNum} باید مثبت باشد.` });
        hasRowError = true;
      }
      if (!warehouseCode && (typeUpper === 'INVENTORY_RECEIPTS' || typeUpper === 'INVENTORY_ISSUES')) {
        errors.push({ rowNumber: rowNum, fieldName: 'warehouseCode', errorMessage: `کد انبار در ردیف ${rowNum} الزامی است.` });
        hasRowError = true;
      }

      if (!hasRowError) {
        validRows.push(row);
      }
    } else if (typeUpper === 'CONTRACTS') {
      const contractNumber = normalizeExcelDigits(getRowFieldByAliases(row, ['contractNumber', 'شماره قرارداد']));
      const title = getRowFieldByAliases(row, ['title', 'عنوان / موضوع قرارداد', 'عنوان قرارداد']);
      const allocatedWeight = parseExcelNumber(getRowFieldByAliases(row, ['allocatedWeightKg', 'سهمیه وزنی کل (کیلوگرم)', 'سهمیه وزنی']), 0);

      let hasRowError = false;
      if (!contractNumber) {
        errors.push({ rowNumber: rowNum, fieldName: 'contractNumber', errorMessage: `شماره قرارداد در ردیف ${rowNum} الزامی است.` });
        hasRowError = true;
      }
      if (!title) {
        errors.push({ rowNumber: rowNum, fieldName: 'title', errorMessage: `عنوان قرارداد در ردیف ${rowNum} الزامی است.` });
        hasRowError = true;
      }
      if (contractNumber && seenIds.has(String(contractNumber).toUpperCase())) {
        errors.push({ rowNumber: rowNum, fieldName: 'contractNumber', errorMessage: `شماره قرارداد «${contractNumber}» در ردیف ${rowNum} تکراری است.` });
        hasRowError = true;
      }
      if (contractNumber) seenIds.add(String(contractNumber).toUpperCase());
      if (isNaN(allocatedWeight) || allocatedWeight <= 0) {
        errors.push({ rowNumber: rowNum, fieldName: 'allocatedWeightKg', errorMessage: `سهمیه وزنی در ردیف ${rowNum} باید عددی مثبت باشد.` });
        hasRowError = true;
      }

      if (!hasRowError) {
        validRows.push(row);
      }
    } else if (typeUpper === 'WAREHOUSES') {
      const code = normalizeExcelDigits(getRowFieldByAliases(row, ['code', 'کد انبار', 'warehouseCode']));
      const name = String(getRowFieldByAliases(row, ['name', 'نام انبار', 'warehouseName']) || '').trim();
      let hasRowError = false;
      if (!code) {
        errors.push({ rowNumber: rowNum, fieldName: 'code', errorMessage: `کد انبار در ردیف ${rowNum} الزامی است.` });
        hasRowError = true;
      }
      if (!name) {
        errors.push({ rowNumber: rowNum, fieldName: 'name', errorMessage: `نام انبار در ردیف ${rowNum} الزامی است.` });
        hasRowError = true;
      }
      if (!hasRowError) validRows.push(row);
    } else if (typeUpper === 'CUSTOMERS') {
      const code = normalizeExcelDigits(getRowFieldByAliases(row, ['code', 'کد مشتری']));
      const name = String(getRowFieldByAliases(row, ['name', 'نام مشتری']) || '').trim();
      let hasRowError = false;
      if (!code) {
        errors.push({ rowNumber: rowNum, fieldName: 'code', errorMessage: `کد مشتری در ردیف ${rowNum} الزامی است.` });
        hasRowError = true;
      }
      if (!name) {
        errors.push({ rowNumber: rowNum, fieldName: 'name', errorMessage: `نام مشتری در ردیف ${rowNum} الزامی است.` });
        hasRowError = true;
      }
      if (!hasRowError) validRows.push(row);
    } else if (typeUpper === 'UNITS') {
      const symbol = normalizeExcelDigits(getRowFieldByAliases(row, ['symbol', 'رمز/نماد واحد'])).toUpperCase();
      const title = String(getRowFieldByAliases(row, ['title', 'عنوان واحد']) || '').trim();
      let hasRowError = false;
      if (!symbol) {
        errors.push({ rowNumber: rowNum, fieldName: 'symbol', errorMessage: `نماد واحد در ردیف ${rowNum} الزامی است.` });
        hasRowError = true;
      }
      if (!title) {
        errors.push({ rowNumber: rowNum, fieldName: 'title', errorMessage: `عنوان واحد در ردیف ${rowNum} الزامی است.` });
        hasRowError = true;
      }
      if (!hasRowError) validRows.push(row);
    } else {
      errors.push({ rowNumber: rowNum, fieldName: 'batchType', errorMessage: `نوع قالب ایمپورت «${templateType || 'نامشخص'}» پشتیبانی نمی‌شود.` });
    }
  });

  return {
    isValid: errors.length === 0,
    validRows,
    errors,
    invalidRows: errors,
  };
}

/**
 * -------------------------------------------------------------------------
 * 8. PERSISTENT POSTGRESQL PRISMA TRANSACTION EXECUTION
 * -------------------------------------------------------------------------
 * Atomically posts document in a single PostgreSQL Serializable transaction.
 * Delegates to the hardened P0-A relational ledger engine in
 * `src/server/services/inventoryLedgerService.ts`.
 */
export async function postDocumentInDbTransaction(
  document: InventoryDocument,
  user: { uid: string; displayName: string },
  options?: PostDocumentDbOptions
): Promise<PostDocumentResult> {
  if (!options?.prismaClient && !isDatabaseUrlConfigured()) {
    return {
      success: false,
      statusCode: 503,
      errorCode: 'DATABASE_NOT_CONFIGURED',
      error: 'اتصال PostgreSQL تنظیم نشده است؛ ثبت قطعی سند بدون پایگاه داده مجاز نیست.',
    };
  }

  return postInventoryDocumentInTransaction(document, user, options);
}

export async function saveDraftDocumentInDbTransaction(
  document: InventoryDocument,
  user: { uid: string; displayName: string },
  options?: PostDocumentDbOptions
): Promise<PostDocumentResult> {
  if (!options?.prismaClient && !isDatabaseUrlConfigured()) {
    return {
      success: false,
      statusCode: 503,
      errorCode: 'DATABASE_NOT_CONFIGURED',
      error: 'اتصال PostgreSQL تنظیم نشده است؛ ذخیره پیش‌نویس در پایگاه داده انجام نشد.',
    };
  }

  return saveDraftInDbTransaction(document, user, options);
}
