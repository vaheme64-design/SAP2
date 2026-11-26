import { StockOwnership, StockQualityStatus, UnitOfMeasure } from './inventory';

export type QualityInspectionType = 'INCOMING_MATERIAL' | 'IN_PROCESS' | 'FINAL_PRODUCT';

export type QualityInspectionStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED';

export type QualityDecision =
  | 'PENDING'
  | 'ACCEPTED'
  | 'ACCEPTED_WITH_CONCESSION'
  | 'QUARANTINED'
  | 'REJECTED';

export type NonconformanceSeverity = 'MINOR' | 'MAJOR' | 'CRITICAL';

export type NonconformanceCategory =
  | 'DIMENSIONAL'
  | 'SURFACE_DEFECT'
  | 'MATERIAL_PROPERTY'
  | 'WELDING'
  | 'COATING_PAINT'
  | 'BURR_CRACK'
  | 'PACKAGING_LABEL'
  | 'OTHER';

export type NcrSourceType =
  | 'INCOMING_MATERIAL'
  | 'IN_PROCESS'
  | 'FINAL_PRODUCT'
  | 'WAREHOUSE_AUDIT'
  | 'CUSTOMER_COMPLAINT';

export type NcrStatus = 'OPEN' | 'CONTAINED' | 'DISPOSITIONED' | 'IN_REWORK' | 'CLOSED';

export type NcrDispositionAction =
  | 'PENDING'
  | 'USE_AS_IS'
  | 'REWORK'
  | 'SCRAP'
  | 'RETURN_TO_SUPPLIER'
  | 'SORT_REINSPECT';

export type ReworkOrderStatus = 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export interface DefectCodeDefinition {
  code: string;
  labelFa: string;
  category: NonconformanceCategory;
  defaultSeverity: NonconformanceSeverity;
}

export interface InspectionChecklistItem {
  id: string;
  code: string;
  labelFa: string;
  standardSpec?: string;
  measuredValue?: string;
  passed: boolean;
  notes?: string;
}

export interface QualityInspectionRecord {
  id: string;
  inspectionNumber: string;
  inspectionType: QualityInspectionType;
  status: QualityInspectionStatus;
  decision: QualityDecision;

  // Traceability links
  partId: string;
  partCode: string;
  partName: string;
  warehouseId?: string;
  warehouseName?: string;
  locationCode?: string;
  balanceId?: string;
  lotNumber?: string;
  heatNumber?: string;
  physicalCoilId?: string;
  coilId?: string;
  coilPackNumber?: string;
  manufacturingOrderId?: string;
  moNumber?: string;
  operationId?: string;
  operationCode?: string;
  operationName?: string;
  supplierName?: string;
  ownership?: StockOwnership;
  contractId?: string;
  contractNumber?: string;
  sourceDocumentNumber?: string;

  // Quantities
  inspectedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  reworkQty: number;
  unit: UnitOfMeasure;
  weightKg: number;

  // Checklist & Findings
  checklist: InspectionChecklistItem[];
  defectCodes: string[];
  defectCategory?: NonconformanceCategory;
  defectSummary?: string;
  notes?: string;

  // Linked outcomes
  linkedQmDocumentNumber?: string;
  linkedNcrId?: string;
  linkedNcrNumber?: string;

  // Audit
  inspectorUid: string;
  inspectorName: string;
  inspectedAt: string;
  decidedAt?: string;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NonconformanceRecord {
  id: string;
  ncrNumber: string;
  title: string;
  sourceType: NcrSourceType;
  severity: NonconformanceSeverity;
  category: NonconformanceCategory;
  defectCode: string;
  defectLabelFa: string;
  status: NcrStatus;
  disposition: NcrDispositionAction;

  // Traceability links
  inspectionId?: string;
  inspectionNumber?: string;
  partId: string;
  partCode: string;
  partName: string;
  warehouseId?: string;
  warehouseName?: string;
  locationCode?: string;
  balanceId?: string;
  lotNumber?: string;
  heatNumber?: string;
  physicalCoilId?: string;
  coilId?: string;
  coilPackNumber?: string;
  manufacturingOrderId?: string;
  moNumber?: string;
  operationId?: string;
  operationCode?: string;
  operationName?: string;
  supplierName?: string;
  ownership?: StockOwnership;
  contractId?: string;
  contractNumber?: string;

  // Quantities
  affectedQty: number;
  containedQty: number;
  reworkedGoodQty: number;
  scrappedQty: number;
  returnedToProductionQty: number;
  returnedToSupplierQty: number;
  unit: UnitOfMeasure;
  weightKg: number;

  // Containment, Root Cause & Disposition
  description: string;
  containmentAction?: string;
  containedAt?: string;
  containedByName?: string;
  containmentQmDocNumber?: string;
  rootCause?: string;
  correctiveAction?: string;
  dispositionNotes?: string;
  dispositionedAt?: string;
  dispositionedByName?: string;
  dispositionDocNumber?: string;
  linkedReworkOrderId?: string;
  linkedReworkNumber?: string;
  closedAt?: string;
  closedByName?: string;

  // Audit
  createdByUid: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReworkOrderRecord {
  id: string;
  reworkNumber: string;
  ncrId: string;
  ncrNumber: string;
  inspectionId?: string;
  partId: string;
  partCode: string;
  partName: string;
  warehouseId?: string;
  locationCode?: string;
  balanceId?: string;
  lotNumber?: string;
  physicalCoilId?: string;
  coilId?: string;
  manufacturingOrderId?: string;
  moNumber?: string;
  sourceOperationCode?: string;
  targetOperationCode?: string;
  ownership?: StockOwnership;
  contractId?: string;
  contractNumber?: string;

  plannedReworkQty: number;
  completedGoodQty: number;
  scrappedQty: number;
  remainingQty: number;
  unit: UnitOfMeasure;
  weightKg: number;

  status: ReworkOrderStatus;
  instructions: string;
  returnToProduction: boolean;
  returnDocumentNumber?: string;
  scrapDocumentNumber?: string;
  assignedToName?: string;
  completionNotes?: string;

  createdByUid: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface QualityHistoryEvent {
  id: string;
  timestamp: string;
  eventType:
    | 'INSPECTION_CREATED'
    | 'INSPECTION_DECIDED'
    | 'NCR_OPENED'
    | 'NCR_CONTAINED'
    | 'NCR_DISPOSITIONED'
    | 'REWORK_CREATED'
    | 'REWORK_COMPLETED'
    | 'QM_STOCK_TRANSFER';
  referenceNumber: string;
  status: string;
  titleFa: string;
  detailFa: string;
  actorName: string;
  quantity?: number;
  unit?: string;
}

export interface QualityEntityHistoryResponse {
  filters: {
    lotNumber?: string;
    coilId?: string;
    moNumber?: string;
    partId?: string;
    partCode?: string;
  };
  currentQualityStatus: StockQualityStatus | 'MIXED' | 'UNKNOWN';
  stockSummary: {
    physicalQty: number;
    availableQty: number;
    qualityInspectionQty: number;
    blockedQty: number;
    matchingBalancesCount: number;
    matchingCoilsCount: number;
  };
  inspections: QualityInspectionRecord[];
  ncrs: NonconformanceRecord[];
  reworkOrders: ReworkOrderRecord[];
  timeline: QualityHistoryEvent[];
}

export interface QualitySupplierPerformanceRow {
  supplierName: string;
  totalInspections: number;
  acceptedInspections: number;
  rejectedInspections: number;
  quarantinedInspections: number;
  totalInspectedQty: number;
  totalRejectedQty: number;
  rejectionRatePercent: number | null;
  openNcrCount: number;
  totalNcrCount: number;
  qualityScorePercent: number | null;
}

export interface QualityDefectParetoRow {
  defectCode: string;
  defectLabelFa: string;
  category: NonconformanceCategory;
  occurrenceCount: number;
  affectedQty: number;
  sharePercent: number;
  isRecurring: boolean;
}

export interface QualityDashboardAnalytics {
  generatedAt: string;
  summary: {
    totalInspections: number;
    completedInspections: number;
    pendingInspections: number;
    incomingAcceptanceRatePercent: number | null;
    inProcessPassRatePercent: number | null;
    finalPassRatePercent: number | null;
    overallRejectionRatePercent: number | null;
    totalInspectedQty: number;
    totalAcceptedQty: number;
    totalRejectedQty: number;
    totalReworkQty: number;
    openNcrCount: number;
    criticalOpenNcrCount: number;
    totalNcrCount: number;
    activeReworkOrdersCount: number;
    reworkedGoodQtyTotal: number;
    scrappedFromQcQtyTotal: number;
    returnedToProductionQtyTotal: number;
    shopFloorScrapQtyTotal: number;
    quarantinedStockQty: number;
    blockedStockQty: number;
    quarantinedStockKg: number;
    blockedStockKg: number;
    dataQualityNoteFa?: string;
  };
  byInspectionType: Array<{
    inspectionType: QualityInspectionType;
    labelFa: string;
    totalCount: number;
    acceptedCount: number;
    rejectedCount: number;
    quarantinedCount: number;
    inspectedQty: number;
    rejectedQty: number;
    passRatePercent: number | null;
  }>;
  defectPareto: QualityDefectParetoRow[];
  recurringIssues: QualityDefectParetoRow[];
  byCategory: Array<{
    category: NonconformanceCategory;
    labelFa: string;
    ncrCount: number;
    affectedQty: number;
  }>;
  supplierPerformance: QualitySupplierPerformanceRow[];
  byPart: Array<{
    partId: string;
    partCode: string;
    partName: string;
    inspectionCount: number;
    ncrCount: number;
    inspectedQty: number;
    rejectedQty: number;
    rejectionRatePercent: number | null;
  }>;
}
