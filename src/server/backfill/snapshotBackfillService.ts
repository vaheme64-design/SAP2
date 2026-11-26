import {
  ContractStatus,
  DieStatus,
  DieType,
  DocReferenceType,
  DocumentStatus,
  InventoryDocType,
  LotStatus,
  MOStatus,
  MachineStatus,
  MachineType,
  OrderLineStatus,
  PartCategory,
  PlanLineStatus,
  PlanProposalStatus,
  PlanStatus,
  PostingStatus,
  Prisma,
  PrismaClient,
  ProcessType,
  ProductionOpStatus,
  ReservationStatus,
  RouteStatus,
  TransactionType,
  TransferStatus,
  WarehouseType,
} from '@prisma/client';
import {
  DECIMAL_EPSILON,
  DECIMAL_ZERO,
  decimalAbs,
  decimalAdd,
  decimalEq,
  decimalSub,
  formatDecimal,
  normalizeFloatArtifact,
  toDecimal,
} from './decimalUtils';

export type BackfillMode = 'dry-run' | 'apply';

export type ConflictSeverity = 'INFO' | 'WARNING' | 'CONFLICT';

export interface BackfillConflict {
  code: string;
  severity: ConflictSeverity;
  entity: string;
  reference: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface EntityReconciliationCount {
  entity: string;
  targetTable: string;
  sourceCount: number;
  existingCount: number;
  plannedInserts: number;
  plannedUpdates: number;
  plannedSkips: number;
  notes?: string;
}

export interface UnsupportedSnapshotEntity {
  snapshotKey: string;
  sourceCount: number;
  reason: string;
}

export interface DerivedBalanceSummary {
  partNumber: string;
  warehouseCode: string;
  locationCode: string | null;
  lotNumber: string | null;
  coilId: string | null;
  ownership: string;
  contractNumber: string | null;
  qualityStatus: string;
  quantityOnHand: string;
  quantityReserved: string;
  quantityAvailable: string;
  weightKgOnHand: string;
  weightKgReserved: string;
  weightKgAvailable: string;
}

export interface CoilReconciliationSummary {
  coilId: string;
  coilPackNumber: string;
  originalWeightKg: string;
  existingRelationalRemainingKg: string | null;
  snapshotRemainingKg: string;
  derivedLedgerRemainingKg: string | null;
  reconciledTargetRemainingKg: string;
  hadFloatArtifact: boolean;
  driftKg: string;
  contractAllocatedKg: string;
}

export interface ContractAllocationSummary {
  contractNumber: string;
  totalAllocatedWeightKg: string;
  plannedCoilAllocationsKg: string;
  withinContractLimit: boolean;
  allocations: Array<{
    coilId: string;
    allocatedWeightKg: string;
    source: 'physicalCoil.allocations' | 'contract.coils';
  }>;
}

export interface WipReconciliationSummary {
  moNumber: string;
  partNumber: string;
  routeId: string;
  operationCount: number;
  transferCount: number;
  targetQty: string;
  completedQty: string;
  scrapQty: string;
  wipLinkPlanned: boolean;
}

export interface BackfillReconciliationReport {
  mode: BackfillMode;
  applied: boolean;
  executedAt: string;
  snapshotMeta: {
    inventorySnapshotId: string;
    inventoryUpdatedAt: string | null;
    wipSnapshotId: string;
    wipVersion: number | null;
    wipUpdatedAt: string | null;
  };
  entities: EntityReconciliationCount[];
  unsupportedEntities: UnsupportedSnapshotEntity[];
  derivedStockBalances: DerivedBalanceSummary[];
  coilReconciliation: CoilReconciliationSummary[];
  contractAllocationChecks: ContractAllocationSummary[];
  wipReconciliation: WipReconciliationSummary[];
  conflicts: BackfillConflict[];
  preservedRelationalOnlyParts: Array<{ id: string; partNumber: string; name: string }>;
  summary: {
    totalPlannedInserts: number;
    totalPlannedUpdates: number;
    totalPlannedSkips: number;
    conflictCount: number;
    warningCount: number;
  };
}

export interface SnapshotDataBundle {
  inventorySnapshotId?: string;
  inventoryUpdatedAt?: Date | string | null;
  inventoryPayload: Record<string, any>;
  wipSnapshotId?: string;
  wipVersion?: number | null;
  wipUpdatedAt?: Date | string | null;
  wipPayload: Record<string, any>;
}

export interface BackfillOptions {
  mode: BackfillMode;
  /**
   * When true (default), PhysicalCoil.remainingWeightKg is normalized to clean
   * Prisma.Decimal and reconciled to the posted inventory ledger for that coil.
   * Existing coil rows are never deleted.
   */
  reconcileCoilWeights?: boolean;
}

export const SUPPORTED_ENTITY_MAPPINGS: ReadonlyArray<{
  source: string;
  targetModel: string;
  targetTable: string;
  naturalKey: string;
}> = [
  { source: 'audit/document actor UIDs', targetModel: 'Role + User (inactive attribution stubs)', targetTable: 'roles, users', naturalKey: 'Role.name / User.username' },
  { source: 'inventory.units', targetModel: 'UnitOfMeasure', targetTable: 'units_of_measure', naturalKey: 'code' },
  { source: 'inventory.materialGrades', targetModel: 'Material', targetTable: 'materials', naturalKey: 'code / grade' },
  { source: 'inventory.warehouses + locations', targetModel: 'Warehouse + WarehouseLocation', targetTable: 'warehouses, warehouse_locations', naturalKey: 'Warehouse.code / (warehouseId, code)' },
  { source: 'inventory.customers', targetModel: 'Customer', targetTable: 'customers', naturalKey: 'code' },
  { source: 'inventory.shifts', targetModel: 'Shift', targetTable: 'shifts', naturalKey: 'code' },
  { source: 'inventory.parts', targetModel: 'Part', targetTable: 'parts', naturalKey: 'partNumber (preserving relational-only rows)' },
  { source: 'inventory.operations + routing steps', targetModel: 'Operation', targetTable: 'operations', naturalKey: 'code' },
  { source: 'inventory.machines', targetModel: 'Machine + MachineCapability', targetTable: 'machines, machine_capabilities', naturalKey: 'Machine.code / (machineId, operationId)' },
  { source: 'inventory.dies', targetModel: 'Die + MachineDieCompatibility', targetTable: 'dies, machine_die_compatibilities', naturalKey: 'Die.code / (machineId, dieId)' },
  { source: 'inventory.routings', targetModel: 'PartRoute + RouteOperation', targetTable: 'part_routes, route_operations', naturalKey: '(partId, version) / (routeId, stepNumber)' },
  { source: 'inventory.contracts + commercialLines', targetModel: 'MaterialContract + ContractCommercialLine', targetTable: 'material_contracts, contract_commercial_lines', naturalKey: 'contractNumber / line.id' },
  { source: 'lot references (coils, docs, reservations)', targetModel: 'MaterialLot', targetTable: 'material_lots', naturalKey: 'lotNumber' },
  { source: 'inventory.physicalCoils', targetModel: 'PhysicalCoil', targetTable: 'physical_coils', naturalKey: 'coilId' },
  { source: 'coil.allocations / contract.coils', targetModel: 'ContractCoilAllocation', targetTable: 'contract_coil_allocations', naturalKey: '(contractId, coilId)' },
  { source: 'inventory.customerOrders', targetModel: 'CustomerOrder + CustomerOrderLine', targetTable: 'customer_orders, customer_order_lines', naturalKey: 'orderNumber / (orderId, lineNumber)' },
  { source: 'inventory.fallbackPlanProposals', targetModel: 'ProductionPlanProposal + ProductionPlanProposalLine', targetTable: 'production_plan_proposals, production_plan_proposal_lines', naturalKey: 'proposalNumber / (proposalId, customerOrderLineId)' },
  { source: 'inventory.plans', targetModel: 'ProductionPlan + ProductionPlanLine', targetTable: 'production_plans, production_plan_lines', naturalKey: 'planNumber / line.id' },
  { source: 'wip.manufacturingOrders', targetModel: 'ManufacturingOrder + ProductionOperation + WipManufacturingOrderLink + WipOperationLink', targetTable: 'manufacturing_orders, production_operations, wip_manufacturing_order_links, wip_operation_links', naturalKey: 'moNumber / (manufacturingOrderId, stepNumber)' },
  { source: 'wip.wipTransfers', targetModel: 'ProductionTransfer', targetTable: 'production_transfers', naturalKey: 'transferNumber' },
  { source: 'inventory.inventoryDocuments', targetModel: 'InventoryDocument + InventoryDocumentLine + InventoryTransaction + StockBalance', targetTable: 'inventory_documents, inventory_document_lines, inventory_transactions, stock_balances', naturalKey: 'documentNumber / (documentId, lineNumber) / transactionNumber / composite balance tuple' },
  { source: 'inventory.reservations', targetModel: 'InventoryReservation (+ StockBalance reserved delta)', targetTable: 'inventory_reservations, stock_balances', naturalKey: 'reservationNumber' },
  { source: 'inventory.auditLogs', targetModel: 'AuditLog', targetTable: 'audit_logs', naturalKey: 'id' },
];

export const UNSUPPORTED_SNAPSHOT_REASONS: Record<string, string> = {
  coils: 'Legacy simplified coil summary mirror; authoritative coil entity is PhysicalCoil + MaterialLot (avoids duplicate coil records).',
  transactions: 'Legacy pre-document transaction feed (contains repeated IDs already covered by posted InventoryDocuments); skipped to prevent stock double-counting.',
  advancedBoms: 'References Part catalog (parts), whereas Prisma BomComponent references the separate SAP-PP Item table (items); requires explicit schema decision before backfill.',
  productStructures: 'No normalized multi-level product structure table targeting Part exists in current Prisma schema.',
  parallelFlows: 'No normalized parallel manufacturing flow graph table exists in current Prisma schema.',
  traceabilityTags: 'No normalized shop-floor QR/barcode traceability tag table exists in current Prisma schema.',
  planSuggestions: 'Transitional UI planning suggestion heuristic without a dedicated Prisma model (distinct from ProductionPlanProposal).',
  halls: 'No FactoryHall table exists in Prisma schema (stored as string Machine.hallLocation).',
  operators: 'No standalone Operator table exists in Prisma schema (shop-floor operators belong in User once RBAC/HR directory is provisioned).',
  processes: 'Static process lookup mirrored by Prisma ProcessType enum.',
  carModels: 'No CarModel lookup table exists in Prisma schema (stored as string Part.carModel).',
  pmPlans: 'No preventive maintenance (PM) plan table exists in current Prisma schema.',
  maintenanceRequests: 'No maintenance work-request table exists in current Prisma schema.',
  spareParts: 'No spare-parts catalog table exists in current Prisma schema.',
  purchaseRequisitions: 'No purchase requisition table exists in current Prisma schema.',
  vipParts: 'UI-specific bookmark map with no relational table.',
  qcHolds: 'Empty UI map (0 keys); QM holds are represented relationally via StockBalance.qualityStatus and posted InventoryDocuments.',
  oeeConsumablesState: 'Dashboard OEE consumables widget state with no relational table.',
  machineWorkloadHours: 'Derived scheduling UI map with no relational table.',
  coilIssueRecords: 'Empty array (0 records) in snapshot; target table coil_issue_return_records exists and will be mapped if non-empty.',
};

const VALID_PROCESS_TYPES = new Set<string>(Object.values(ProcessType));

function mapProcessType(raw: unknown): ProcessType {
  const s = String(raw || '').trim().toUpperCase();
  if (VALID_PROCESS_TYPES.has(s)) return s as ProcessType;
  if (s.includes('SHEAR') || s.includes('SLIT')) return ProcessType.SHEARING;
  if (s.includes('BLANK')) return ProcessType.BLANKING;
  if (s.includes('DRAW')) return ProcessType.DRAWING;
  if (s.includes('PUNCH') || s.includes('FORM') || s.includes('PIERC')) return ProcessType.PUNCH_FORM;
  if (s.includes('BEND')) return ProcessType.BENDING;
  if (s.includes('TRIM')) return ProcessType.TRIMMING;
  if (s.includes('SPOT')) return ProcessType.SPOT_WELD;
  if (s.includes('CO2') || s.includes('WELD')) return ProcessType.CO2_WELD;
  if (s.includes('PAINT') || s.includes('COAT')) return ProcessType.PAINT;
  return ProcessType.ASSEMBLY;
}

function mapMachineType(machine: Record<string, any>): MachineType {
  const explicit = String(machine.machineType || machine.type || '').trim().toUpperCase();
  if (Object.values(MachineType).includes(explicit as MachineType)) {
    return explicit as MachineType;
  }
  const code = String(machine.code || '').toUpperCase();
  const proc = String(machine.processType || '').toUpperCase();
  const name = String(machine.name || '');
  if (code.startsWith('BRK') || proc === 'BENDING') return MachineType.PRESS_BRAKE;
  if (code.startsWith('SHT') || code.startsWith('SLT') || proc === 'SHEARING') return MachineType.SHEARING_MACHINE;
  if (code.startsWith('WLD-SPT') || proc === 'SPOT_WELD') return MachineType.SPOT_WELDER;
  if (code.startsWith('WLD-ROB') || proc === 'CO2_WELD') return MachineType.CO2_WELDING_CELL;
  if (code.startsWith('PNT') || proc === 'PAINT') return MachineType.PAINT_LINE;
  if (code.startsWith('ASM') || proc === 'ASSEMBLY') return MachineType.ASSEMBLY_BENCH;
  if (name.includes('هیدرولیک') || proc === 'DRAWING') return MachineType.HYDRAULIC_PRESS;
  return MachineType.MECHANICAL_PRESS;
}

function mapMachineStatus(raw: unknown): MachineStatus {
  const s = String(raw || '').trim().toUpperCase();
  if (Object.values(MachineStatus).includes(s as MachineStatus)) return s as MachineStatus;
  return MachineStatus.ACTIVE;
}

function mapDieType(die: Record<string, any>): DieType {
  const explicit = String(die.dieType || die.type || '').trim().toUpperCase();
  if (Object.values(DieType).includes(explicit as DieType)) return explicit as DieType;
  const proc = String(die.processType || '').toUpperCase();
  const code = String(die.code || '').toUpperCase();
  if (proc === 'BLANKING' || code.includes('BLK')) return DieType.BLANKING_DIE;
  if (proc === 'DRAWING' || code.includes('DRW')) return DieType.DRAWING_DIE;
  if (proc === 'TRIMMING' || code.includes('TRM')) return DieType.TRIMMING_DIE;
  if (proc === 'PUNCH_FORM' || code.includes('PNC')) return DieType.PIERCING_DIE;
  return DieType.FORMING_DIE;
}

function mapDieStatus(raw: unknown): DieStatus {
  const s = String(raw || '').trim().toUpperCase();
  if (Object.values(DieStatus).includes(s as DieStatus)) return s as DieStatus;
  return DieStatus.READY;
}

function mapWarehouseType(raw: unknown, code: string): WarehouseType {
  const s = String(raw || '').trim().toUpperCase();
  if (Object.values(WarehouseType).includes(s as WarehouseType)) return s as WarehouseType;
  const c = code.toUpperCase();
  if (c.includes('FINISHED')) return WarehouseType.FINISHED_GOODS;
  if (c.includes('SCRAP')) return WarehouseType.SCRAP;
  if (c.includes('DIE') || c.includes('TOOL')) return WarehouseType.TOOLING_DIES;
  if (c.includes('WIP')) return WarehouseType.WIP;
  return WarehouseType.RAW_MATERIALS;
}

function mapPartCategory(raw: unknown): PartCategory {
  const s = String(raw || '').trim().toUpperCase();
  if (Object.values(PartCategory).includes(s as PartCategory)) return s as PartCategory;
  if (s === 'SEMI_FINISHED' || s === 'WIP') return PartCategory.WIP_PART;
  if (s === 'FINISHED' || s === 'PRODUCT') return PartCategory.FINISHED_GOOD;
  if (s === 'FASTENER' || s === 'CONSUMABLE') return PartCategory.CONSUMABLE;
  return PartCategory.RAW_MATERIAL;
}

function mapDocumentType(raw: unknown): InventoryDocType {
  const s = String(raw || '').trim().toUpperCase();
  switch (s) {
    case 'OPENING_BALANCE':
    case 'INITIAL_BALANCE':
      return InventoryDocType.INITIAL_BALANCE;
    case 'RECEIPT_RAW_MATERIAL':
    case 'RECEIPT_FINISHED_GOODS':
    case 'RECEIPT_WIP':
    case 'RECEIPT':
      return InventoryDocType.RECEIPT;
    case 'ISSUE_RAW_MATERIAL':
    case 'ISSUE_FINISHED_GOODS':
    case 'ISSUE_TO_PRODUCTION':
    case 'ISSUE_TO_WIP':
    case 'DELIVERY_CUSTOMER':
    case 'SHIPMENT_CUSTOMER':
    case 'ISSUE':
      return InventoryDocType.ISSUE;
    case 'TRANSFER':
    case 'WIP_TRANSFER':
      return InventoryDocType.WIP_TRANSFER;
    case 'RETURN':
    case 'RETURN_FROM_PRODUCTION':
      return InventoryDocType.RETURN;
    case 'SCRAP':
    case 'SCRAP_WRITE_OFF':
      return InventoryDocType.SCRAP;
    case 'STOCK_STATUS_TRANSFER':
    case 'ADJUSTMENT':
    case 'REVERSAL':
    case 'COUNT_ADJUSTMENT':
      return InventoryDocType.COUNT_ADJUSTMENT;
    default:
      return InventoryDocType.COUNT_ADJUSTMENT;
  }
}

function mapDocumentStatus(raw: unknown): DocumentStatus {
  const s = String(raw || '').trim().toUpperCase();
  if (Object.values(DocumentStatus).includes(s as DocumentStatus)) return s as DocumentStatus;
  if (s === 'OPEN' || s === 'APPROVED') return DocumentStatus.CONFIRMED;
  return DocumentStatus.DRAFT;
}

function mapPostingStatus(raw: unknown): PostingStatus {
  const s = String(raw || '').trim().toUpperCase();
  if (Object.values(PostingStatus).includes(s as PostingStatus)) return s as PostingStatus;
  return PostingStatus.UNPOSTED;
}

function mapReferenceType(raw: unknown): DocReferenceType | null {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return null;
  if (Object.values(DocReferenceType).includes(s as DocReferenceType)) return s as DocReferenceType;
  if (s.includes('COIL') || s.includes('SAPCO')) return DocReferenceType.SAPCO_COIL;
  if (s.includes('CUSTOMER') || s.includes('ORDER')) return DocReferenceType.CUSTOMER_ORDER;
  if (s.includes('MANUFACTURING') || s.includes('PRODUCTION') || s.includes('MO')) return DocReferenceType.MANUFACTURING_ORDER;
  if (s.includes('SCRAP')) return DocReferenceType.SCRAP_REPORT;
  if (s.includes('AUDIT') || s.includes('COUNT') || s.includes('INITIAL')) return DocReferenceType.PHYSICAL_COUNT;
  return DocReferenceType.MANUAL;
}

function mapMoStatus(raw: unknown): MOStatus {
  const s = String(raw || '').trim().toUpperCase();
  if (Object.values(MOStatus).includes(s as MOStatus)) return s as MOStatus;
  return MOStatus.PLANNED;
}

function mapOpStatus(raw: unknown): ProductionOpStatus {
  const s = String(raw || '').trim().toUpperCase();
  if (Object.values(ProductionOpStatus).includes(s as ProductionOpStatus)) return s as ProductionOpStatus;
  return ProductionOpStatus.PENDING;
}

function mapTransferStatus(raw: unknown): TransferStatus {
  const s = String(raw || '').trim().toUpperCase();
  if (s === 'APPROVED' || s === 'RECEIVED') return TransferStatus.RECEIVED;
  if (s === 'REJECTED') return TransferStatus.REJECTED;
  if (s === 'CANCELLED') return TransferStatus.CANCELLED;
  return TransferStatus.DISPATCHED;
}

function mapPlanStatus(raw: unknown): PlanStatus {
  const s = String(raw || '').trim().toUpperCase();
  if (Object.values(PlanStatus).includes(s as PlanStatus)) return s as PlanStatus;
  return PlanStatus.DRAFT;
}

function mapPlanLineStatus(raw: unknown): PlanLineStatus {
  const s = String(raw || '').trim().toUpperCase();
  if (Object.values(PlanLineStatus).includes(s as PlanLineStatus)) return s as PlanLineStatus;
  if (s === 'IN_PROGRESS') return PlanLineStatus.IN_PROGRESS;
  if (s === 'COMPLETED') return PlanLineStatus.COMPLETED;
  return PlanLineStatus.PLANNED;
}

function mapProposalStatus(raw: unknown): PlanProposalStatus {
  const s = String(raw || '').trim().toUpperCase();
  if (Object.values(PlanProposalStatus).includes(s as PlanProposalStatus)) return s as PlanProposalStatus;
  return PlanProposalStatus.DRAFT;
}

function mapReservationStatus(raw: unknown): ReservationStatus {
  const s = String(raw || '').trim().toUpperCase();
  if (Object.values(ReservationStatus).includes(s as ReservationStatus)) return s as ReservationStatus;
  return ReservationStatus.ACTIVE;
}

function mapContractStatus(raw: unknown): ContractStatus {
  const s = String(raw || '').trim().toUpperCase();
  if (Object.values(ContractStatus).includes(s as ContractStatus)) return s as ContractStatus;
  return ContractStatus.ACTIVE;
}

function mapRouteStatus(raw: unknown): RouteStatus {
  const s = String(raw || '').trim().toUpperCase();
  if (Object.values(RouteStatus).includes(s as RouteStatus)) return s as RouteStatus;
  return RouteStatus.ACTIVE;
}

function parseDate(raw: unknown, fallback: Date = new Date()): Date {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const d = new Date(raw.trim());
    if (!Number.isNaN(d.getTime())) return d;
  }
  return fallback;
}

function parseBolsterSize(raw: unknown): { lengthMm: Prisma.Decimal | null; widthMm: Prisma.Decimal | null } {
  if (typeof raw !== 'string') return { lengthMm: null, widthMm: null };
  const m = raw.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i);
  if (!m) return { lengthMm: null, widthMm: null };
  return { lengthMm: toDecimal(m[1]), widthMm: toDecimal(m[2]) };
}

function inferWarehouseForLocationCode(locationCode: string): string {
  const c = locationCode.toUpperCase();
  if (c.startsWith('LOC-RAW')) return 'WH-RAW';
  if (c.startsWith('LOC-WIP-WELD') || c.startsWith('LOC-WELD') || c.startsWith('LOC-PAINT')) return 'WH-WIP-WELD';
  if (c.startsWith('LOC-WIP')) return 'WH-WIP-STAMP';
  if (c.startsWith('LOC-FIN')) return 'WH-FINISHED';
  if (c.startsWith('LOC-SCRAP')) return 'WH-SCRAP';
  return 'WH-WIP-STAMP';
}

function normalizeOwnership(raw: unknown, docOwnership?: unknown): { value: string; wasNonCanonical: boolean } {
  const candidate = String(raw || docOwnership || 'COMPANY_OWNED').trim().toUpperCase();
  if (candidate === 'OWNED') {
    return { value: 'COMPANY_OWNED', wasNonCanonical: true };
  }
  if (
    candidate === 'COMPANY_OWNED' ||
    candidate === 'SAPCO_SUPPLIER_OWNED' ||
    candidate === 'CUSTOMER_SUPPLIED' ||
    candidate === 'THIRD_PARTY_OWNED'
  ) {
    return { value: candidate, wasNonCanonical: false };
  }
  return { value: 'COMPANY_OWNED', wasNonCanonical: true };
}

interface BalanceBucket {
  key: string;
  partId: string;
  partNumber: string;
  warehouseId: string;
  warehouseCode: string;
  locationId: string | null;
  locationCode: string | null;
  materialLotId: string | null;
  lotNumber: string | null;
  physicalCoilId: string | null;
  coilId: string | null;
  ownership: string;
  contractId: string | null;
  contractNumber: string | null;
  qualityStatus: string;
  quantityOnHand: Prisma.Decimal;
  quantityReserved: Prisma.Decimal;
  quantityAvailable: Prisma.Decimal;
  weightKgOnHand: Prisma.Decimal;
  weightKgReserved: Prisma.Decimal;
  weightKgAvailable: Prisma.Decimal;
  lastTransactionAt: Date | null;
}

function makeBalanceKey(parts: {
  partId: string;
  warehouseId: string;
  locationId: string | null;
  materialLotId: string | null;
  physicalCoilId: string | null;
  ownership: string;
  contractId: string | null;
  qualityStatus: string;
}): string {
  return [
    parts.partId,
    parts.warehouseId,
    parts.locationId ?? '',
    parts.materialLotId ?? '',
    parts.physicalCoilId ?? '',
    parts.ownership,
    parts.contractId ?? '',
    parts.qualityStatus,
  ].join('|');
}

function recomputeAvailable(bucket: BalanceBucket): void {
  if (bucket.qualityStatus === 'AVAILABLE') {
    bucket.quantityAvailable = decimalSub(bucket.quantityOnHand, bucket.quantityReserved);
    bucket.weightKgAvailable = decimalSub(bucket.weightKgOnHand, bucket.weightKgReserved);
  } else {
    bucket.quantityAvailable = DECIMAL_ZERO;
    bucket.weightKgAvailable = DECIMAL_ZERO;
  }
}

/**
 * Loads live snapshots directly from PostgreSQL (zero fallback to JSON files or in-memory stores).
 */
export async function loadSnapshotsFromPostgres(prisma: PrismaClient): Promise<SnapshotDataBundle> {
  const [invSnap, wipSnap] = await Promise.all([
    prisma.inventoryAppStateSnapshot.findUnique({ where: { id: 'inventory-app-state' } }),
    prisma.wipStateSnapshot.findUnique({ where: { id: 'production-wip-state' } }),
  ]);

  if (!invSnap) {
    throw new Error('Authoritative snapshot "inventory-app-state" was not found in inventory_app_state_snapshots.');
  }
  if (!wipSnap) {
    throw new Error('Authoritative snapshot "production-wip-state" was not found in wip_state_snapshots.');
  }

  return {
    inventorySnapshotId: invSnap.id,
    inventoryUpdatedAt: invSnap.updatedAt,
    inventoryPayload: (invSnap.payload as Record<string, any>) || {},
    wipSnapshotId: wipSnap.id,
    wipVersion: wipSnap.version,
    wipUpdatedAt: wipSnap.updatedAt,
    wipPayload: (wipSnap.payload as Record<string, any>) || {},
  };
}

/**
 * Deterministic, idempotent Snapshot-to-Relational PostgreSQL backfill engine.
 * - `mode: 'dry-run'`: strictly READ ONLY against PostgreSQL (0 writes).
 * - `mode: 'apply'`: executes inside one `Serializable` Prisma transaction with
 *   automatic rollback on any validation, FK, contract-limit, or balance error.
 */
export async function runSnapshotToRelationalBackfill(
  prisma: PrismaClient,
  bundle: SnapshotDataBundle,
  options: BackfillOptions,
): Promise<BackfillReconciliationReport> {
  const mode: BackfillMode = options.mode;
  if (mode !== 'dry-run' && mode !== 'apply') {
    throw new Error(`Invalid BackfillMode "${String(mode)}". Expected 'dry-run' or 'apply'.`);
  }
  const reconcileCoilWeights = options.reconcileCoilWeights !== false;

  const inv = bundle.inventoryPayload || {};
  const wip = bundle.wipPayload || {};

  if (mode === 'apply') {
    return prisma.$transaction(
      async (tx) => executeBackfillCore(tx as unknown as PrismaClient, bundle, inv, wip, mode, reconcileCoilWeights),
      { isolationLevel: 'Serializable', maxWait: 30000, timeout: 300000 },
    );
  }

  return executeBackfillCore(prisma, bundle, inv, wip, mode, reconcileCoilWeights);
}

async function executeBackfillCore(
  db: PrismaClient,
  bundle: SnapshotDataBundle,
  inv: Record<string, any>,
  wip: Record<string, any>,
  mode: BackfillMode,
  reconcileCoilWeights: boolean,
): Promise<BackfillReconciliationReport> {
  const isApply = mode === 'apply';
  const conflicts: BackfillConflict[] = [];
  const entityStats: EntityReconciliationCount[] = [];

  const recordStat = (stat: EntityReconciliationCount) => {
    entityStats.push(stat);
  };

  // =========================================================================
  // 0. LOAD EXISTING RELATIONAL STATE (READ-ONLY BASELINE)
  // =========================================================================
  const [
    existingRoles,
    existingUsers,
    existingUnits,
    existingMaterials,
    existingWarehouses,
    existingLocations,
    existingCustomers,
    existingShifts,
    existingParts,
    existingOperations,
    existingMachines,
    existingMachineCaps,
    existingDies,
    existingMachineDies,
    existingRoutes,
    existingRouteOps,
    existingContracts,
    existingCommercialLines,
    existingLots,
    existingCoils,
    existingCoilAllocations,
    existingCustomerOrders,
    existingCustomerOrderLines,
    existingProposals,
    existingProposalLines,
    existingPlans,
    existingPlanLines,
    existingMos,
    existingProdOps,
    existingWipMoLinks,
    existingWipOpLinks,
    existingTransfers,
    existingDocs,
    existingDocLines,
    existingTransactions,
    existingBalances,
    existingReservations,
    existingAuditLogs,
  ] = await Promise.all([
    db.role.findMany(),
    db.user.findMany(),
    db.unitOfMeasure.findMany(),
    db.material.findMany(),
    db.warehouse.findMany(),
    db.warehouseLocation.findMany(),
    db.customer.findMany(),
    db.shift.findMany(),
    db.part.findMany(),
    db.operation.findMany(),
    db.machine.findMany(),
    db.machineCapability.findMany(),
    db.die.findMany(),
    db.machineDieCompatibility.findMany(),
    db.partRoute.findMany(),
    db.routeOperation.findMany(),
    db.materialContract.findMany(),
    db.contractCommercialLine.findMany(),
    db.materialLot.findMany(),
    db.physicalCoil.findMany(),
    db.contractCoilAllocation.findMany(),
    db.customerOrder.findMany(),
    db.customerOrderLine.findMany(),
    db.productionPlanProposal.findMany(),
    db.productionPlanProposalLine.findMany(),
    db.productionPlan.findMany(),
    db.productionPlanLine.findMany(),
    db.manufacturingOrder.findMany(),
    db.productionOperation.findMany(),
    db.wipManufacturingOrderLink.findMany(),
    db.wipOperationLink.findMany(),
    db.productionTransfer.findMany(),
    db.inventoryDocument.findMany(),
    db.inventoryDocumentLine.findMany(),
    db.inventoryTransaction.findMany(),
    db.stockBalance.findMany(),
    db.inventoryReservation.findMany(),
    db.auditLog.findMany(),
  ]);

  // Fast lookup indexes (updated as we simulate or apply writes)
  const roleByName = new Map(existingRoles.map((r) => [r.name, r]));
  const userByUsername = new Map(existingUsers.map((u) => [u.username, u]));
  const userById = new Map(existingUsers.map((u) => [u.id, u]));
  const unitByCode = new Map(existingUnits.map((u) => [u.code.toUpperCase(), u]));
  const unitById = new Map(existingUnits.map((u) => [u.id, u]));
  const materialByCode = new Map(existingMaterials.map((m) => [m.code.toUpperCase(), m]));
  const materialByGrade = new Map(existingMaterials.map((m) => [m.grade.toUpperCase(), m]));
  const warehouseByCode = new Map(existingWarehouses.map((w) => [w.code.toUpperCase(), w]));
  const warehouseById = new Map(existingWarehouses.map((w) => [w.id, w]));
  const locationByWhAndCode = new Map(existingLocations.map((l) => [`${l.warehouseId}::${l.code.toUpperCase()}`, l]));
  const locationByCode = new Map(existingLocations.map((l) => [l.code.toUpperCase(), l]));
  const customerByCode = new Map(existingCustomers.map((c) => [c.code.toUpperCase(), c]));
  const customerById = new Map(existingCustomers.map((c) => [c.id, c]));
  const shiftByCode = new Map(existingShifts.map((s) => [s.code.toUpperCase(), s]));
  const partByNumber = new Map(existingParts.map((p) => [p.partNumber, p]));
  const partById = new Map(existingParts.map((p) => [p.id, p]));
  const operationByCode = new Map(existingOperations.map((o) => [o.code.toUpperCase(), o]));
  const operationById = new Map(existingOperations.map((o) => [o.id, o]));
  const machineByCode = new Map(existingMachines.map((m) => [m.code.toUpperCase(), m]));
  const machineById = new Map(existingMachines.map((m) => [m.id, m]));
  const machineCapKeys = new Set(existingMachineCaps.map((c) => `${c.machineId}::${c.operationId}`));
  const dieByCode = new Map(existingDies.map((d) => [d.code.toUpperCase(), d]));
  const dieById = new Map(existingDies.map((d) => [d.id, d]));
  const machineDieKeys = new Set(existingMachineDies.map((d) => `${d.machineId}::${d.dieId}`));
  const routeByPartVersion = new Map(existingRoutes.map((r) => [`${r.partId}::${r.version}`, r]));
  const routeById = new Map(existingRoutes.map((r) => [r.id, r]));
  const routeOpByRouteStep = new Map(existingRouteOps.map((o) => [`${o.routeId}::${o.stepNumber}`, o]));
  const contractByNumber = new Map(existingContracts.map((c) => [c.contractNumber, c]));
  const contractById = new Map(existingContracts.map((c) => [c.id, c]));
  const commercialLineById = new Map(existingCommercialLines.map((l) => [l.id, l]));
  const lotByNumber = new Map(existingLots.map((l) => [l.lotNumber, l]));
  const preExistingLotIds = new Set(existingLots.map((l) => l.id));
  const coilByCoilId = new Map(existingCoils.map((c) => [c.coilId, c]));
  const coilByPackNumber = new Map(existingCoils.map((c) => [c.coilPackNumber, c]));
  const coilById = new Map(existingCoils.map((c) => [c.id, c]));
  const coilAllocKeys = new Map(existingCoilAllocations.map((a) => [`${a.contractId}::${a.coilId}`, a]));
  const orderByNumber = new Map(existingCustomerOrders.map((o) => [o.orderNumber, o]));
  const orderById = new Map(existingCustomerOrders.map((o) => [o.id, o]));
  const orderLineById = new Map(existingCustomerOrderLines.map((l) => [l.id, l]));
  const orderLineByOrderLn = new Map(existingCustomerOrderLines.map((l) => [`${l.orderId}::${l.lineNumber}`, l]));
  const proposalByNumber = new Map(existingProposals.map((p) => [p.proposalNumber, p]));
  const proposalLineKeys = new Set(existingProposalLines.map((l) => `${l.proposalId}::${l.customerOrderLineId}`));
  const planByNumber = new Map(existingPlans.map((p) => [p.planNumber, p]));
  const planLineById = new Map(existingPlanLines.map((l) => [l.id, l]));
  const moByNumber = new Map(existingMos.map((m) => [m.moNumber, m]));
  const moById = new Map(existingMos.map((m) => [m.id, m]));
  const prodOpByMoStep = new Map(existingProdOps.map((o) => [`${o.manufacturingOrderId}::${o.stepNumber}`, o]));
  const prodOpById = new Map(existingProdOps.map((o) => [o.id, o]));
  const wipMoLinkByWipId = new Map(existingWipMoLinks.map((l) => [l.wipManufacturingOrderId, l]));
  const wipOpLinkByWipId = new Map(existingWipOpLinks.map((l) => [l.wipOperationId, l]));
  const transferByNumber = new Map(existingTransfers.map((t) => [t.transferNumber, t]));
  const docByNumber = new Map(existingDocs.map((d) => [d.documentNumber, d]));
  const docById = new Map(existingDocs.map((d) => [d.id, d]));
  const docLineKeys = new Set(existingDocLines.map((l) => `${l.documentId}::${l.lineNumber}`));
  const docLineById = new Map(existingDocLines.map((l) => [l.id, l]));
  const txByNumber = new Map(existingTransactions.map((t) => [t.transactionNumber, t]));
  const reservationByNumber = new Map(existingReservations.map((r) => [r.reservationNumber, r]));
  const auditLogById = new Map(existingAuditLogs.map((a) => [a.id, a]));

  // Track relational-only parts so we prove 100% preservation
  const snapshotParts: any[] = Array.isArray(inv.parts) ? inv.parts : [];
  const snapshotPartCodes = new Set(snapshotParts.map((p) => String(p.code || p.partNumber || '').trim()).filter(Boolean));
  const preservedRelationalOnlyParts = existingParts
    .filter((p) => !snapshotPartCodes.has(p.partNumber))
    .map((p) => ({ id: p.id, partNumber: p.partNumber, name: p.name }));

  // Deterministic part resolver: partCode -> Part.partNumber FIRST, then partId -> Part.id.
  // Records PART_ID_CODE_DIVERGENCE once per distinct (snapshotPartId, partCode) pair.
  const loggedDivergences = new Set<string>();
  const resolvePart = (
    partCodeRaw: unknown,
    partIdRaw: unknown,
    contextEntity: string,
    contextRef: string,
  ) => {
    const partCode = typeof partCodeRaw === 'string' ? partCodeRaw.trim() : '';
    const partId = typeof partIdRaw === 'string' ? partIdRaw.trim() : '';
    const byCode = partCode ? partByNumber.get(partCode) : undefined;
    const byId = partId ? partById.get(partId) : undefined;
    if (byCode) {
      if (partId && byCode.id !== partId) {
        const divKey = `${partId}::${partCode}`;
        if (!loggedDivergences.has(divKey)) {
          loggedDivergences.add(divKey);
          conflicts.push({
            code: 'PART_ID_CODE_DIVERGENCE',
            severity: 'WARNING',
            entity: contextEntity,
            reference: contextRef,
            message: `Snapshot references partId "${partId}" with partCode "${partCode}", whereas relational Part "${partCode}" has id "${byCode.id}" and id "${partId}" belongs to relational-only part "${byId?.partNumber ?? 'N/A'}". Resolved deterministically by partNumber "${partCode}" while preserving both relational Part rows.`,
            details: {
              snapshotPartId: partId,
              snapshotPartCode: partCode,
              resolvedPartId: byCode.id,
              legacyPartNumberAtSnapshotId: byId?.partNumber ?? null,
            },
          });
        }
      }
      return byCode;
    }
    if (byId) return byId;
    throw new Error(`Unresolvable Part reference in ${contextEntity} (${contextRef}): partCode="${partCode}", partId="${partId}"`);
  };

  // =========================================================================
  // 1. INACTIVE ATTRIBUTION ROLE + USERS (for non-null createdByUserId FKs)
  // =========================================================================
  const snapshotDocs: any[] = Array.isArray(inv.inventoryDocuments) ? inv.inventoryDocuments : [];
  const snapshotReservations: any[] = Array.isArray(inv.reservations) ? inv.reservations : [];
  const snapshotAuditLogs: any[] = Array.isArray(inv.auditLogs) ? inv.auditLogs : [];

  const requiredActors = new Map<string, string>();
  for (const doc of snapshotDocs) {
    const cUid = String(doc.createdByUid || 'MIGRATION_SYSTEM').trim();
    if (!requiredActors.has(cUid)) requiredActors.set(cUid, String(doc.createdByName || cUid));
    if (doc.postedByUid) {
      const pUid = String(doc.postedByUid).trim();
      if (!requiredActors.has(pUid)) requiredActors.set(pUid, String(doc.postedByName || pUid));
    }
  }
  for (const res of snapshotReservations) {
    const uid = String(res.createdByUid || 'MIGRATION_SYSTEM').trim();
    if (!requiredActors.has(uid)) requiredActors.set(uid, String(res.createdByName || 'Historical Migration Attribution'));
  }
  for (const log of snapshotAuditLogs) {
    const uid = String(log.user?.uid || '').trim();
    if (uid && !requiredActors.has(uid)) {
      requiredActors.set(uid, String(log.user?.displayName || uid));
    }
  }

  let roleInserts = 0;
  let roleSkips = 0;
  let legacyRole = roleByName.get('LEGACY_MIGRATION');
  const needsAnyNewUser = [...requiredActors.keys()].some((uid) => !userByUsername.has(uid) && !userById.has(uid));

  if (needsAnyNewUser) {
    if (!legacyRole) {
      roleInserts = 1;
      conflicts.push({
        code: 'INACTIVE_ATTRIBUTION_STUBS_REQUIRED',
        severity: 'WARNING',
        entity: 'Role/User',
        reference: 'LEGACY_MIGRATION',
        message: 'Relational roles/users tables have 0 rows, while InventoryDocument/InventoryTransaction/InventoryReservation require non-null createdByUserId FKs. Planning inactive (active=false, passwordHash=null) historical attribution stubs so auth remains locked until Phase 3.',
        details: { actorUids: [...requiredActors.keys()] },
      });
      if (isApply) {
        legacyRole = await db.role.create({
          data: {
            name: 'LEGACY_MIGRATION',
            displayName: 'نقش ممیزی انتقال داده (غیرفعال)',
            description: 'Non-loginable role used exclusively to preserve historical snapshot audit attribution.',
            active: false,
          },
        });
      } else {
        legacyRole = {
          id: 'SIM-ROLE-LEGACY-MIGRATION',
          name: 'LEGACY_MIGRATION',
          displayName: 'نقش ممیزی انتقال داده (غیرفعال)',
          description: null,
          active: false,
          createdAt: new Date(),
        };
      }
      roleByName.set(legacyRole.name, legacyRole);
    } else {
      roleSkips = 1;
    }
  }
  recordStat({
    entity: 'AttributionRole',
    targetTable: 'roles',
    sourceCount: needsAnyNewUser || legacyRole ? 1 : 0,
    existingCount: existingRoles.length,
    plannedInserts: roleInserts,
    plannedUpdates: 0,
    plannedSkips: roleSkips,
    notes: 'Inactive LEGACY_MIGRATION role for non-loginable historical audit attribution.',
  });

  let userInserts = 0;
  let userSkips = 0;
  for (const [uid, displayName] of requiredActors.entries()) {
    const existing = userByUsername.get(uid) || userById.get(uid);
    if (existing) {
      userSkips += 1;
      continue;
    }
    userInserts += 1;
    const emailSlug = uid.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
    const created = isApply
      ? await db.user.create({
          data: {
            id: uid,
            username: uid,
            email: `${emailSlug}@legacy-migration.kpims.invalid`,
            fullName: displayName,
            passwordHash: null,
            roleId: legacyRole!.id,
            active: false,
          },
        })
      : {
          id: uid,
          username: uid,
          email: `${emailSlug}@legacy-migration.kpims.invalid`,
          fullName: displayName,
          personnelCode: null,
          passwordHash: null,
          roleId: legacyRole!.id,
          active: false,
          lastLoginAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
    userByUsername.set(created.username, created);
    userById.set(created.id, created);
  }
  recordStat({
    entity: 'AttributionUser',
    targetTable: 'users',
    sourceCount: requiredActors.size,
    existingCount: existingUsers.length,
    plannedInserts: userInserts,
    plannedUpdates: 0,
    plannedSkips: userSkips,
    notes: 'Inactive (active=false, passwordHash=null) historical attribution stubs preserving exact snapshot actor UIDs.',
  });

  const resolveActorUserId = (uidRaw: unknown): string => {
    const uid = String(uidRaw || 'MIGRATION_SYSTEM').trim();
    const u = userByUsername.get(uid) || userById.get(uid);
    if (!u) throw new Error(`Missing attribution user for actor UID "${uid}".`);
    return u.id;
  };

  // =========================================================================
  // 2. UNITS OF MEASURE
  // =========================================================================
  const snapshotUnits: any[] = Array.isArray(inv.units) ? inv.units : [];
  let unitInserts = 0;
  let unitSkips = 0;
  for (const u of snapshotUnits) {
    const code = String(u.symbol || u.code || '').trim().toUpperCase();
    if (!code) continue;
    if (unitByCode.has(code) || (u.id && unitById.has(u.id))) {
      unitSkips += 1;
      continue;
    }
    unitInserts += 1;
    const created = isApply
      ? await db.unitOfMeasure.create({
          data: {
            id: u.id || `UNIT-${code}`,
            code,
            name: String(u.title || u.name || code),
            symbol: code.toLowerCase(),
            isBase: Boolean(u.isBaseUnit),
            active: true,
          },
        })
      : {
          id: u.id || `UNIT-${code}`,
          code,
          name: String(u.title || u.name || code),
          symbol: code.toLowerCase(),
          isBase: Boolean(u.isBaseUnit),
          active: true,
          createdAt: new Date(),
        };
    unitByCode.set(code, created);
    unitById.set(created.id, created);
  }
  recordStat({
    entity: 'UnitOfMeasure',
    targetTable: 'units_of_measure',
    sourceCount: snapshotUnits.length,
    existingCount: existingUnits.length,
    plannedInserts: unitInserts,
    plannedUpdates: 0,
    plannedSkips: unitSkips,
  });

  // =========================================================================
  // 3. MATERIALS (Reconcile 7 materialGrades without touching/merging MAT-DC01A)
  // =========================================================================
  const snapshotMaterials: any[] = Array.isArray(inv.materialGrades) ? inv.materialGrades : [];
  let matInserts = 0;
  let matSkips = 0;
  for (const m of snapshotMaterials) {
    const grade = String(m.code || m.grade || '').trim();
    if (!grade) continue;
    const code = grade.toUpperCase().startsWith('MAT-') ? grade.toUpperCase() : `MAT-${grade.toUpperCase()}`;
    if (materialByCode.has(code) || materialByGrade.has(grade.toUpperCase())) {
      matSkips += 1;
      continue;
    }
    matInserts += 1;
    const created = isApply
      ? await db.material.create({
          data: {
            code,
            name: String(m.name || `ورق فولادی گرید ${grade}`),
            grade,
            standard: m.standard ? String(m.standard) : null,
            densityKgM3: toDecimal(m.densityKgM3 ?? 7850),
            yieldStrengthMpa: m.yieldStrengthMpa !== undefined && m.yieldStrengthMpa !== null ? toDecimal(m.yieldStrengthMpa) : null,
            tensileStrengthMpa: m.tensileStrengthMpa !== undefined && m.tensileStrengthMpa !== null ? toDecimal(m.tensileStrengthMpa) : null,
            active: true,
          },
        })
      : {
          id: `SIM-MAT-${grade}`,
          code,
          name: String(m.name || grade),
          grade,
          standard: m.standard ? String(m.standard) : null,
          densityKgM3: toDecimal(m.densityKgM3 ?? 7850),
          tensileStrengthMpa: null,
          yieldStrengthMpa: m.yieldStrengthMpa != null ? toDecimal(m.yieldStrengthMpa) : null,
          elongationPercent: null,
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
    materialByCode.set(code, created);
    materialByGrade.set(grade.toUpperCase(), created);
  }
  if (materialByGrade.has('DC01A') && materialByGrade.has('DC01')) {
    conflicts.push({
      code: 'MATERIAL_GRADE_VARIANT_PRESERVED',
      severity: 'INFO',
      entity: 'Material',
      reference: 'MAT-DC01A / MAT-DC01',
      message: 'Preserved existing relational Material "MAT-DC01A" (grade DC01A) separately from snapshot grade "MAT-DC01" (grade DC01); neither merged nor deleted.',
    });
  }
  recordStat({
    entity: 'Material',
    targetTable: 'materials',
    sourceCount: snapshotMaterials.length,
    existingCount: existingMaterials.length,
    plannedInserts: matInserts,
    plannedUpdates: 0,
    plannedSkips: matSkips,
    notes: 'Existing MAT-DC01A preserved intact alongside 7 snapshot materialGrades.',
  });

  // =========================================================================
  // 4. WAREHOUSES & WAREHOUSE LOCATIONS (including missing doc/WIP locations)
  // =========================================================================
  const snapshotWarehouses: any[] = Array.isArray(inv.warehouses) ? inv.warehouses : [];
  let whInserts = 0;
  let whSkips = 0;
  for (const w of snapshotWarehouses) {
    const code = String(w.code || w.id || '').trim().toUpperCase();
    if (!code) continue;
    if (warehouseByCode.has(code) || (w.id && warehouseById.has(w.id))) {
      whSkips += 1;
      continue;
    }
    whInserts += 1;
    const created = isApply
      ? await db.warehouse.create({
          data: {
            id: w.id || code,
            code,
            name: String(w.name || code),
            type: mapWarehouseType(w.type, code),
            managerName: w.managerName ? String(w.managerName) : null,
            active: true,
          },
        })
      : {
          id: w.id || code,
          code,
          name: String(w.name || code),
          type: mapWarehouseType(w.type, code),
          address: null,
          managerName: w.managerName ? String(w.managerName) : null,
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
    warehouseByCode.set(code, created);
    warehouseById.set(created.id, created);
  }
  recordStat({
    entity: 'Warehouse',
    targetTable: 'warehouses',
    sourceCount: snapshotWarehouses.length,
    existingCount: existingWarehouses.length,
    plannedInserts: whInserts,
    plannedUpdates: 0,
    plannedSkips: whSkips,
  });

  // Collect all warehouse-location pairs from warehouses, docs, WIP operations, and WIP transfers
  const requiredLocations = new Map<string, { warehouseId: string; code: string }>();
  const registerLocation = (whIdRaw: string | null | undefined, locCodeRaw: unknown) => {
    const locCode = typeof locCodeRaw === 'string' ? locCodeRaw.trim() : '';
    if (!locCode) return;
    const wh = (whIdRaw && (warehouseById.get(whIdRaw) || warehouseByCode.get(whIdRaw.toUpperCase())))
      || warehouseByCode.get(inferWarehouseForLocationCode(locCode));
    if (!wh) return;
    const key = `${wh.id}::${locCode.toUpperCase()}`;
    if (!requiredLocations.has(key)) {
      requiredLocations.set(key, { warehouseId: wh.id, code: locCode });
    }
  };
  for (const w of snapshotWarehouses) {
    for (const loc of w.locations || []) registerLocation(w.id || w.code, loc);
  }
  for (const doc of snapshotDocs) {
    for (const line of doc.lines || []) {
      registerLocation(doc.warehouseId, line.locationCode);
      if (doc.targetWarehouseId && line.targetLocationCode) {
        registerLocation(doc.targetWarehouseId, line.targetLocationCode);
      }
    }
  }
  const wipMos: any[] = Array.isArray(wip.manufacturingOrders) ? wip.manufacturingOrders : [];
  const wipTransfers: any[] = Array.isArray(wip.wipTransfers) ? wip.wipTransfers : [];
  for (const mo of wipMos) {
    for (const op of mo.operations || []) registerLocation(null, op.warehouseLocation);
  }
  for (const tr of wipTransfers) {
    registerLocation(null, tr.fromLocation);
    registerLocation(null, tr.toLocation);
  }

  let locInserts = 0;
  let locSkips = 0;
  for (const [key, loc] of requiredLocations.entries()) {
    if (locationByWhAndCode.has(key)) {
      locSkips += 1;
      continue;
    }
    locInserts += 1;
    const created = isApply
      ? await db.warehouseLocation.create({
          data: {
            warehouseId: loc.warehouseId,
            code: loc.code,
            active: true,
          },
        })
      : {
          id: `SIM-LOC-${loc.warehouseId}-${loc.code}`,
          warehouseId: loc.warehouseId,
          code: loc.code,
          aisle: null,
          rack: null,
          shelf: null,
          bin: null,
          maxCapacityKg: null,
          active: true,
          createdAt: new Date(),
        };
    locationByWhAndCode.set(key, created);
    if (!locationByCode.has(loc.code.toUpperCase())) {
      locationByCode.set(loc.code.toUpperCase(), created);
    }
  }
  recordStat({
    entity: 'WarehouseLocation',
    targetTable: 'warehouse_locations',
    sourceCount: requiredLocations.size,
    existingCount: existingLocations.length,
    plannedInserts: locInserts,
    plannedUpdates: 0,
    plannedSkips: locSkips,
    notes: 'Includes locations referenced by snapshot inventory documents and WIP stages.',
  });

  // =========================================================================
  // 5. CUSTOMERS & SHIFTS
  // =========================================================================
  const snapshotCustomers: any[] = Array.isArray(inv.customers) ? inv.customers : [];
  let custInserts = 0;
  let custSkips = 0;
  for (const c of snapshotCustomers) {
    const code = String(c.code || c.id || '').trim().toUpperCase();
    if (!code) continue;
    if (customerByCode.has(code) || (c.id && customerById.has(c.id))) {
      custSkips += 1;
      continue;
    }
    custInserts += 1;
    const created = isApply
      ? await db.customer.create({
          data: {
            id: c.id || code,
            code,
            name: String(c.name || code),
            phone: c.phone ? String(c.phone) : null,
            active: true,
          },
        })
      : {
          id: c.id || code,
          code,
          name: String(c.name || code),
          commercialCode: null,
          nationalId: null,
          economicCode: null,
          phone: c.phone ? String(c.phone) : null,
          contactPerson: null,
          address: null,
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
    customerByCode.set(code, created);
    customerById.set(created.id, created);
  }
  recordStat({
    entity: 'Customer',
    targetTable: 'customers',
    sourceCount: snapshotCustomers.length,
    existingCount: existingCustomers.length,
    plannedInserts: custInserts,
    plannedUpdates: 0,
    plannedSkips: custSkips,
  });

  const snapshotShifts: any[] = Array.isArray(inv.shifts) ? inv.shifts : [];
  let shiftInserts = 0;
  let shiftSkips = 0;
  for (const s of snapshotShifts) {
    const code = String(s.code || s.id || '').trim().toUpperCase();
    if (!code) continue;
    if (shiftByCode.has(code)) {
      shiftSkips += 1;
      continue;
    }
    shiftInserts += 1;
    const productiveHours = s.netWorkMinutes
      ? toDecimal(s.netWorkMinutes).div(60).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
      : toDecimal('7.5');
    const created = isApply
      ? await db.shift.create({
          data: {
            id: s.id || code,
            code,
            name: String(s.name || code),
            startTime: String(s.startTime || '07:00'),
            endTime: String(s.endTime || '15:30'),
            breakDurationMin: Number.isFinite(Number(s.breakDurationMin)) ? Number(s.breakDurationMin) : 30,
            productiveHours,
            active: String(s.status || 'ACTIVE').toUpperCase() === 'ACTIVE',
          },
        })
      : {
          id: s.id || code,
          code,
          name: String(s.name || code),
          startTime: String(s.startTime || '07:00'),
          endTime: String(s.endTime || '15:30'),
          breakDurationMin: 30,
          productiveHours,
          active: true,
          createdAt: new Date(),
        };
    shiftByCode.set(code, created);
  }
  recordStat({
    entity: 'Shift',
    targetTable: 'shifts',
    sourceCount: snapshotShifts.length,
    existingCount: existingShifts.length,
    plannedInserts: shiftInserts,
    plannedUpdates: 0,
    plannedSkips: shiftSkips,
  });

  // =========================================================================
  // 6. PARTS (Preserve all 1,468 existing parts including 3 relational-only parts)
  // =========================================================================
  let partInserts = 0;
  let partSkips = 0;
  for (const p of snapshotParts) {
    const partNumber = String(p.code || p.partNumber || '').trim();
    if (!partNumber) continue;
    if (partByNumber.has(partNumber)) {
      partSkips += 1;
      continue;
    }
    const unitCode = String(p.unit || 'PCS').trim().toUpperCase();
    const unit = unitByCode.get(unitCode) || unitByCode.get('PCS');
    if (!unit) throw new Error(`Unit "${unitCode}" missing for snapshot part "${partNumber}".`);
    const mat = p.materialGrade ? materialByGrade.get(String(p.materialGrade).trim().toUpperCase()) : undefined;
    const candidateId = p.id && !partById.has(p.id) ? String(p.id) : undefined;
    partInserts += 1;
    const created = isApply
      ? await db.part.create({
          data: {
            ...(candidateId ? { id: candidateId } : {}),
            partNumber,
            name: String(p.name || partNumber),
            category: mapPartCategory(p.category),
            unitId: unit.id,
            materialId: mat?.id ?? null,
            thicknessMm: p.thicknessMm != null ? toDecimal(p.thicknessMm) : null,
            weightNetKg: toDecimal(p.weightNetKg ?? p.unitWeightKg ?? 0),
            weightGrossKg: toDecimal(p.weightGrossKg ?? p.weightNetKg ?? p.unitWeightKg ?? 0),
            scrapNormPercent: p.scrapNormPercent != null ? toDecimal(p.scrapNormPercent) : null,
            carModel: p.carModel ? String(p.carModel) : null,
            minSafetyStock: toDecimal(p.minSafetyStock ?? 0),
            active: p.active !== false,
          },
        })
      : {
          id: candidateId || `SIM-PART-${partNumber}`,
          partNumber,
          name: String(p.name || partNumber),
          category: mapPartCategory(p.category),
          unitId: unit.id,
          materialId: mat?.id ?? null,
          thicknessMm: null,
          weightNetKg: toDecimal(p.weightNetKg ?? 0),
          weightGrossKg: toDecimal(p.weightGrossKg ?? 0),
          scrapNormPercent: null,
          customerPartNumber: null,
          supplierPartNumber: null,
          carModel: null,
          minSafetyStock: DECIMAL_ZERO,
          maxStock: null,
          leadTimeDays: 1,
          targetWarehouseId: null,
          targetLocationId: null,
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
    partByNumber.set(created.partNumber, created);
    partById.set(created.id, created);
  }
  recordStat({
    entity: 'Part',
    targetTable: 'parts',
    sourceCount: snapshotParts.length,
    existingCount: existingParts.length,
    plannedInserts: partInserts,
    plannedUpdates: 0,
    plannedSkips: partSkips,
    notes: `Preserved all ${preservedRelationalOnlyParts.length} relational-only parts untouched.`,
  });

  // =========================================================================
  // 7. OPERATIONS (16 catalog operations + routing step codes if absent)
  // =========================================================================
  const snapshotOperations: any[] = Array.isArray(inv.operations) ? inv.operations : [];
  const snapshotRoutings: any[] = Array.isArray(inv.routings) ? inv.routings : [];

  const desiredOperations: Array<{ id?: string; code: string; name: string; processType: ProcessType; active: boolean }> = [];
  const seenOpCodes = new Set<string>();
  for (const op of snapshotOperations) {
    const code = String(op.code || op.id || '').trim().toUpperCase();
    if (!code || seenOpCodes.has(code)) continue;
    seenOpCodes.add(code);
    desiredOperations.push({
      id: op.id ? String(op.id) : undefined,
      code,
      name: String(op.name || code),
      processType: mapProcessType(op.processType || op.category),
      active: op.active !== false,
    });
  }
  for (const rtg of snapshotRoutings) {
    for (const step of rtg.operations || []) {
      const code = String(step.stepCode || '').trim().toUpperCase();
      if (!code || seenOpCodes.has(code)) continue;
      seenOpCodes.add(code);
      desiredOperations.push({
        code,
        name: String(step.stepName || code),
        processType: mapProcessType(step.processType),
        active: true,
      });
    }
  }

  let opInserts = 0;
  let opSkips = 0;
  for (const op of desiredOperations) {
    if (operationByCode.has(op.code)) {
      opSkips += 1;
      continue;
    }
    opInserts += 1;
    const candidateId = op.id && !operationById.has(op.id) ? op.id : undefined;
    const created = isApply
      ? await db.operation.create({
          data: {
            ...(candidateId ? { id: candidateId } : {}),
            code: op.code,
            name: op.name,
            processType: op.processType,
            active: op.active,
          },
        })
      : {
          id: candidateId || `SIM-OP-${op.code}`,
          code: op.code,
          name: op.name,
          processType: op.processType,
          standardLaborCostPerHour: null,
          standardMachineCostPerHour: null,
          active: op.active,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
    operationByCode.set(op.code, created);
    operationById.set(created.id, created);
  }
  recordStat({
    entity: 'Operation',
    targetTable: 'operations',
    sourceCount: desiredOperations.length,
    existingCount: existingOperations.length,
    plannedInserts: opInserts,
    plannedUpdates: 0,
    plannedSkips: opSkips,
    notes: `${snapshotOperations.length} catalog operations + ${desiredOperations.length - snapshotOperations.length} distinct routing step operations.`,
  });

  // =========================================================================
  // 8. MACHINES & MACHINE CAPABILITIES
  // =========================================================================
  const snapshotMachines: any[] = Array.isArray(inv.machines) ? inv.machines : [];
  let machineInserts = 0;
  let machineSkips = 0;
  let capInserts = 0;
  let capSkips = 0;

  for (const m of snapshotMachines) {
    const code = String(m.code || m.id || '').trim().toUpperCase();
    if (!code) continue;
    let dbMachine = machineByCode.get(code) || (m.id ? machineById.get(m.id) : undefined);
    if (!dbMachine) {
      machineInserts += 1;
      const bolster = parseBolsterSize(m.bolsterSize);
      const tonnage = m.tonnage ?? m.tonnageCapacity;
      dbMachine = isApply
        ? await db.machine.create({
            data: {
              id: m.id ? String(m.id) : undefined,
              code,
              name: String(m.name || code),
              machineType: mapMachineType(m),
              tonnageCapacity: tonnage != null ? toDecimal(tonnage) : null,
              bolsterLengthMm: bolster.lengthMm,
              bolsterWidthMm: bolster.widthMm,
              strokeLengthMm: m.strokeLengthMm != null ? toDecimal(m.strokeLengthMm) : null,
              maxStrokesPerMinute: m.strokesPerMinute != null ? Math.round(Number(m.strokesPerMinute)) : null,
              hallLocation: String(m.location || m.hallLocation || 'سالن پرس'),
              status: mapMachineStatus(m.status),
              active: true,
            },
          })
        : {
            id: m.id ? String(m.id) : `SIM-MCH-${code}`,
            code,
            name: String(m.name || code),
            machineType: mapMachineType(m),
            tonnageCapacity: tonnage != null ? toDecimal(tonnage) : null,
            bolsterLengthMm: bolster.lengthMm,
            bolsterWidthMm: bolster.widthMm,
            strokeLengthMm: m.strokeLengthMm != null ? toDecimal(m.strokeLengthMm) : null,
            maxStrokesPerMinute: m.strokesPerMinute != null ? Math.round(Number(m.strokesPerMinute)) : null,
            shutHeightMm: null,
            hallLocation: String(m.location || 'سالن پرس'),
            status: mapMachineStatus(m.status),
            active: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
      machineByCode.set(code, dbMachine);
      machineById.set(dbMachine.id, dbMachine);
    } else {
      machineSkips += 1;
    }

    const capProcs = new Set<ProcessType>(
      [...(Array.isArray(m.capabilities) ? m.capabilities : []), m.processType]
        .filter(Boolean)
        .map((p) => mapProcessType(p)),
    );
    for (const op of operationByCode.values()) {
      if (!capProcs.has(op.processType)) continue;
      const capKey = `${dbMachine.id}::${op.id}`;
      if (machineCapKeys.has(capKey)) {
        capSkips += 1;
        continue;
      }
      capInserts += 1;
      machineCapKeys.add(capKey);
      if (isApply) {
        await db.machineCapability.create({
          data: {
            machineId: dbMachine.id,
            operationId: op.id,
            maxTonnage: dbMachine.tonnageCapacity,
            efficiencyFactor: toDecimal('1.0'),
            isPreferred: mapProcessType(m.processType) === op.processType,
          },
        });
      }
    }
  }
  recordStat({
    entity: 'Machine',
    targetTable: 'machines',
    sourceCount: snapshotMachines.length,
    existingCount: existingMachines.length,
    plannedInserts: machineInserts,
    plannedUpdates: 0,
    plannedSkips: machineSkips,
  });
  recordStat({
    entity: 'MachineCapability',
    targetTable: 'machine_capabilities',
    sourceCount: capInserts + capSkips,
    existingCount: existingMachineCaps.length,
    plannedInserts: capInserts,
    plannedUpdates: 0,
    plannedSkips: capSkips,
  });

  // =========================================================================
  // 9. DIES & MACHINE-DIE COMPATIBILITIES
  // =========================================================================
  const snapshotDies: any[] = Array.isArray(inv.dies) ? inv.dies : [];
  let dieInserts = 0;
  let dieSkips = 0;
  let compatInserts = 0;
  let compatSkips = 0;

  for (const d of snapshotDies) {
    const code = String(d.code || d.id || '').trim().toUpperCase();
    if (!code) continue;
    let dbDie = dieByCode.get(code) || (d.id ? dieById.get(d.id) : undefined);
    if (!dbDie) {
      const part = resolvePart(d.partCode, d.partId, 'Die', code);
      dieInserts += 1;
      dbDie = isApply
        ? await db.die.create({
            data: {
              id: d.id ? String(d.id) : undefined,
              code,
              name: String(d.name || code),
              partId: part.id,
              dieType: mapDieType(d),
              tonnageRequired: toDecimal(d.requiredTonnage ?? d.tonnageRequired ?? 0),
              totalStrokeTarget: Number.isFinite(Number(d.strokeLifeTarget)) ? Math.round(Number(d.strokeLifeTarget)) : 200000,
              currentStrokes: Number.isFinite(Number(d.currentStrokes)) ? Math.round(Number(d.currentStrokes)) : 0,
              status: mapDieStatus(d.status),
              storageLocation: d.location ? String(d.location) : null,
              active: true,
            },
          })
        : {
            id: d.id ? String(d.id) : `SIM-DIE-${code}`,
            code,
            name: String(d.name || code),
            partId: part.id,
            dieType: mapDieType(d),
            tonnageRequired: toDecimal(d.requiredTonnage ?? 0),
            shutHeightMm: null,
            upperWeightKg: null,
            lowerWeightKg: null,
            totalWeightKg: null,
            totalStrokeTarget: Number(d.strokeLifeTarget ?? 200000),
            currentStrokes: Number(d.currentStrokes ?? 0),
            lastMaintenanceStrokes: 0,
            strokesBetweenSharpening: 25000,
            status: mapDieStatus(d.status),
            storageLocation: d.location ? String(d.location) : null,
            active: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
      dieByCode.set(code, dbDie);
      dieById.set(dbDie.id, dbDie);
    } else {
      dieSkips += 1;
    }

    const compatCodes: string[] = Array.isArray(d.compatibleMachineCodes) ? d.compatibleMachineCodes : [];
    const compatIds: string[] = Array.isArray(d.compatibleMachineIds) ? d.compatibleMachineIds : [];
    const matchedMachines = new Set<string>();
    for (const mc of compatCodes) {
      const m = machineByCode.get(String(mc).trim().toUpperCase());
      if (m) matchedMachines.add(m.id);
    }
    for (const mid of compatIds) {
      const m = machineById.get(String(mid).trim());
      if (m) matchedMachines.add(m.id);
    }
    for (const machineId of matchedMachines) {
      const key = `${machineId}::${dbDie.id}`;
      if (machineDieKeys.has(key)) {
        compatSkips += 1;
        continue;
      }
      compatInserts += 1;
      machineDieKeys.add(key);
      if (isApply) {
        await db.machineDieCompatibility.create({
          data: { machineId, dieId: dbDie.id, isOptimal: true },
        });
      }
    }
  }
  recordStat({
    entity: 'Die',
    targetTable: 'dies',
    sourceCount: snapshotDies.length,
    existingCount: existingDies.length,
    plannedInserts: dieInserts,
    plannedUpdates: 0,
    plannedSkips: dieSkips,
  });
  recordStat({
    entity: 'MachineDieCompatibility',
    targetTable: 'machine_die_compatibilities',
    sourceCount: compatInserts + compatSkips,
    existingCount: existingMachineDies.length,
    plannedInserts: compatInserts,
    plannedUpdates: 0,
    plannedSkips: compatSkips,
  });

  // =========================================================================
  // 10. PART ROUTES & ROUTE OPERATIONS
  // =========================================================================
  let routeInserts = 0;
  let routeSkips = 0;
  let routeOpInserts = 0;
  let routeOpSkips = 0;
  let sourceRouteOpCount = 0;

  for (const rtg of snapshotRoutings) {
    const part = resolvePart(rtg.partCode, rtg.partId, 'PartRoute', String(rtg.id || rtg.partCode));
    const version = String(rtg.version || 'V1.0');
    const pvKey = `${part.id}::${version}`;
    let dbRoute = (rtg.id ? routeById.get(rtg.id) : undefined) || routeByPartVersion.get(pvKey);
    if (!dbRoute) {
      const routeStatus = mapRouteStatus(rtg.status);
      routeInserts += 1;
      dbRoute = isApply
        ? await db.partRoute.create({
            data: {
              id: rtg.id ? String(rtg.id) : undefined,
              partId: part.id,
              version,
              status: routeStatus,
              isDefault: true,
              notes: rtg.notes ? String(rtg.notes) : null,
            },
          })
        : {
            id: rtg.id ? String(rtg.id) : `SIM-RTG-${part.partNumber}-${version}`,
            partId: part.id,
            version,
            status: routeStatus,
            effectiveFrom: new Date(),
            effectiveTo: null,
            isDefault: true,
            notes: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
      routeById.set(dbRoute.id, dbRoute);
      routeByPartVersion.set(pvKey, dbRoute);
    } else {
      routeSkips += 1;
    }

    for (const step of rtg.operations || []) {
      sourceRouteOpCount += 1;
      const stepNumber = Math.round(Number(step.stepNumber));
      const rsKey = `${dbRoute.id}::${stepNumber}`;
      if (routeOpByRouteStep.has(rsKey)) {
        routeOpSkips += 1;
        continue;
      }
      const stepCode = String(step.stepCode || `OP${stepNumber}`).trim().toUpperCase();
      const op = operationByCode.get(stepCode);
      if (!op) throw new Error(`Operation "${stepCode}" missing for RouteOperation ${dbRoute.id}:${stepNumber}`);
      const machine = step.machineId ? machineById.get(String(step.machineId)) : undefined;
      const dieRef = step.dieMoldId ?? step.dieId;
      const die = dieRef ? (dieById.get(String(dieRef)) || dieByCode.get(String(dieRef).toUpperCase())) : undefined;
      routeOpInserts += 1;
      const createdOp = isApply
        ? await db.routeOperation.create({
            data: {
              routeId: dbRoute.id,
              operationId: op.id,
              stepNumber,
              stepCode,
              stepName: String(step.stepName || stepCode),
              machineId: machine?.id ?? null,
              dieId: die?.id ?? null,
              setupTimeMin: Number.isFinite(Number(step.setupTimeMin)) ? Math.round(Number(step.setupTimeMin)) : 30,
              standardCycleTimeSec: Number.isFinite(Number(step.standardCycleTimeSec)) ? Math.round(Number(step.standardCycleTimeSec)) : 45,
              scrapNormPercent: toDecimal(step.scrapNormPercent ?? 0),
              transferBatchQty: toDecimal(step.transferBatchQty ?? 100),
            },
          })
        : {
            id: `SIM-ROP-${dbRoute.id}-${stepNumber}`,
            routeId: dbRoute.id,
            operationId: op.id,
            stepNumber,
            stepCode,
            stepName: String(step.stepName || stepCode),
            machineId: machine?.id ?? null,
            dieId: die?.id ?? null,
            setupTimeMin: 30,
            standardCycleTimeSec: Number(step.standardCycleTimeSec ?? 45),
            scrapNormPercent: toDecimal(step.scrapNormPercent ?? 0),
            transferBatchQty: toDecimal(100),
          };
      routeOpByRouteStep.set(rsKey, createdOp);
    }
  }
  recordStat({
    entity: 'PartRoute',
    targetTable: 'part_routes',
    sourceCount: snapshotRoutings.length,
    existingCount: existingRoutes.length,
    plannedInserts: routeInserts,
    plannedUpdates: 0,
    plannedSkips: routeSkips,
  });
  recordStat({
    entity: 'RouteOperation',
    targetTable: 'route_operations',
    sourceCount: sourceRouteOpCount,
    existingCount: existingRouteOps.length,
    plannedInserts: routeOpInserts,
    plannedUpdates: 0,
    plannedSkips: routeOpSkips,
  });

  // =========================================================================
  // 11. MATERIAL CONTRACTS & COMMERCIAL LINES
  // =========================================================================
  const snapshotContracts: any[] = Array.isArray(inv.contracts) ? inv.contracts : [];
  let contractInserts = 0;
  let contractSkips = 0;
  let commercialLineInserts = 0;
  let commercialLineSkips = 0;
  let sourceCommercialLineCount = 0;

  for (const c of snapshotContracts) {
    const contractNumber = String(c.contractNumber || c.id || '').trim();
    if (!contractNumber) continue;
    let dbContract = contractByNumber.get(contractNumber) || (c.id ? contractById.get(c.id) : undefined);
    if (!dbContract) {
      const cust =
        (c.customerId ? customerById.get(String(c.customerId)) : undefined) ||
        (c.customerCode ? customerByCode.get(String(c.customerCode).trim().toUpperCase()) : undefined) ||
        customerByCode.get('CUST-SAPCO') ||
        [...customerById.values()][0];
      if (!cust) throw new Error(`No Customer available to link MaterialContract "${contractNumber}".`);
      const mat = materialByGrade.get(String(c.materialGrade || '').trim().toUpperCase()) || [...materialByCode.values()][0];
      if (!mat) throw new Error(`No Material available to link MaterialContract "${contractNumber}".`);
      contractInserts += 1;
      dbContract = isApply
        ? await db.materialContract.create({
            data: {
              id: c.id ? String(c.id) : undefined,
              contractNumber,
              supplierCustomerId: cust.id,
              title: String(c.title || contractNumber),
              materialId: mat.id,
              totalAllocatedWeightKg: toDecimal(c.allocatedWeightKg ?? c.totalAllocatedWeightKg ?? 0),
              receivedWeightKg: toDecimal(c.totalReceivedKg ?? c.receivedWeightKg ?? 0),
              startDate: parseDate(c.startDate),
              endDate: parseDate(c.endDate),
              status: mapContractStatus(c.status),
              notes: c.notes ? String(c.notes) : null,
            },
          })
        : {
            id: c.id ? String(c.id) : `SIM-CNT-${contractNumber}`,
            contractNumber,
            supplierCustomerId: cust.id,
            title: String(c.title || contractNumber),
            materialId: mat.id,
            thicknessMm: c.thicknessMm != null ? toDecimal(c.thicknessMm) : null,
            totalAllocatedWeightKg: toDecimal(c.allocatedWeightKg ?? c.totalAllocatedWeightKg ?? 0),
            receivedWeightKg: toDecimal(c.totalReceivedKg ?? c.receivedWeightKg ?? 0),
            startDate: parseDate(c.startDate),
            endDate: parseDate(c.endDate),
            status: mapContractStatus(c.status),
            notes: c.notes ? String(c.notes) : null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
      contractByNumber.set(contractNumber, dbContract);
      contractById.set(dbContract.id, dbContract);
    } else {
      contractSkips += 1;
    }

    const commercialLines: any[] = Array.isArray(c.commercialLines) ? c.commercialLines : [];
    for (let clIdx = 0; clIdx < commercialLines.length; clIdx++) {
      const cl = commercialLines[clIdx];
      sourceCommercialLineCount += 1;
      const clId = String(cl.id || `${dbContract.id}-${cl.partCode || cl.partId || clIdx}`);
      if (commercialLineById.has(clId)) {
        commercialLineSkips += 1;
        continue;
      }
      const part = resolvePart(cl.partCode, cl.partId, 'ContractCommercialLine', clId);
      commercialLineInserts += 1;
      const createdCl = isApply
        ? await db.contractCommercialLine.create({
            data: {
              id: clId,
              contractId: dbContract.id,
              lineType: String(cl.lineType || 'CUSTOMER_SUPPLIED_MATERIAL'),
              partId: part.id,
              partCode: part.partNumber,
              partName: String(cl.partName || part.name),
              contractQty: toDecimal(cl.contractQty ?? 0),
              contractWeightKg: toDecimal(cl.contractWeightKg ?? 0),
              deliveredOrReceivedQty: toDecimal(cl.deliveredOrReceivedQty ?? 0),
              deliveredOrReceivedKg: toDecimal(cl.deliveredOrReceivedKg ?? 0),
              remainingQty: toDecimal(cl.remainingQty ?? 0),
              remainingKg: toDecimal(cl.remainingKg ?? 0),
              unit: String(cl.unit || 'KG'),
              notes: cl.notes ? String(cl.notes) : null,
            },
          })
        : {
            id: clId,
            contractId: dbContract.id,
            lineType: String(cl.lineType || 'CUSTOMER_SUPPLIED_MATERIAL'),
            partId: part.id,
            partCode: part.partNumber,
            partName: String(cl.partName || part.name),
            contractQty: toDecimal(cl.contractQty ?? 0),
            contractWeightKg: toDecimal(cl.contractWeightKg ?? 0),
            deliveredOrReceivedQty: toDecimal(cl.deliveredOrReceivedQty ?? 0),
            deliveredOrReceivedKg: toDecimal(cl.deliveredOrReceivedKg ?? 0),
            remainingQty: toDecimal(cl.remainingQty ?? 0),
            remainingKg: toDecimal(cl.remainingKg ?? 0),
            unit: String(cl.unit || 'KG'),
            notes: null,
            createdAt: new Date(),
          };
      commercialLineById.set(clId, createdCl);
    }
  }
  recordStat({
    entity: 'MaterialContract',
    targetTable: 'material_contracts',
    sourceCount: snapshotContracts.length,
    existingCount: existingContracts.length,
    plannedInserts: contractInserts,
    plannedUpdates: 0,
    plannedSkips: contractSkips,
  });
  recordStat({
    entity: 'ContractCommercialLine',
    targetTable: 'contract_commercial_lines',
    sourceCount: sourceCommercialLineCount,
    existingCount: existingCommercialLines.length,
    plannedInserts: commercialLineInserts,
    plannedUpdates: 0,
    plannedSkips: commercialLineSkips,
  });

  // =========================================================================
  // 12. MATERIAL LOTS, PHYSICAL COILS (initial link), & CONTRACT COIL ALLOCATIONS
  // =========================================================================
  const snapshotCoils: any[] = Array.isArray(inv.physicalCoils) ? inv.physicalCoils : [];

  // Collect all lots referenced by physical coils, documents, and reservations
  const desiredLots = new Map<
    string,
    {
      lotNumber: string;
      partId: string;
      materialId: string;
      contractId: string | null;
      heatNumber: string | null;
      coilSerialNumber: string | null;
      thicknessMm: Prisma.Decimal;
      widthMm: Prisma.Decimal;
      initialWeightKg: Prisma.Decimal;
      remainingWeightKg: Prisma.Decimal;
      warehouseLocationId: string | null;
      receivedDate: Date;
    }
  >();

  for (const c of snapshotCoils) {
    const lotNo = String(c.coilPackNumber || c.coilId || '').trim();
    if (!lotNo) continue;
    const part = resolvePart(c.partCode, c.partId, 'PhysicalCoil/MaterialLot', c.coilId);
    const mat =
      (c.materialGrade && materialByGrade.get(String(c.materialGrade).trim().toUpperCase())) ||
      (part.materialId ? [...materialByCode.values()].find((m) => m.id === part.materialId) : undefined);
    if (!mat) throw new Error(`Material missing for PhysicalCoil lot "${lotNo}".`);
    const normRem = normalizeFloatArtifact(c.remainingWeightKg ?? c.originalWeightKg ?? 0);
    const loc = c.warehouseLocationCode
      ? locationByWhAndCode.get(`${c.warehouseId}::${String(c.warehouseLocationCode).toUpperCase()}`)
      : undefined;
    desiredLots.set(lotNo, {
      lotNumber: lotNo,
      partId: part.id,
      materialId: mat.id,
      contractId: null,
      heatNumber: c.heatNumber ? String(c.heatNumber) : null,
      coilSerialNumber: c.coilId ? String(c.coilId) : null,
      thicknessMm: toDecimal(c.thicknessMm ?? 0),
      widthMm: toDecimal(c.widthMm ?? 0),
      initialWeightKg: toDecimal(c.originalWeightKg ?? 0),
      remainingWeightKg: normRem.normalized,
      warehouseLocationId: loc?.id ?? null,
      receivedDate: parseDate(c.receiptDate),
    });
  }

  for (const doc of snapshotDocs) {
    for (const line of doc.lines || []) {
      const lotNo = typeof line.lotNumber === 'string' ? line.lotNumber.trim() : '';
      if (!lotNo) continue;
      if (desiredLots.has(lotNo)) {
        // Enrich location / contractId if missing
        const entry = desiredLots.get(lotNo)!;
        const loc = line.locationCode
          ? locationByWhAndCode.get(`${doc.warehouseId}::${String(line.locationCode).toUpperCase()}`)
          : undefined;
        if (!entry.warehouseLocationId && loc) entry.warehouseLocationId = loc.id;
        const cId = line.contractId || doc.contractId;
        if (!entry.contractId && cId && contractById.has(cId)) entry.contractId = cId;
        continue;
      }
      const part = resolvePart(line.partCode, line.partId, 'InventoryDocument/MaterialLot', `${doc.documentNumber}:${lotNo}`);
      const cRef = line.contractId || doc.contractId;
      const contract = cRef ? (contractById.get(cRef) || contractByNumber.get(cRef)) : undefined;
      const matId = part.materialId || contract?.materialId || [...materialByCode.values()][0]?.id;
      if (!matId) throw new Error(`No Material available to satisfy MaterialLot.materialId FK for lot "${lotNo}".`);
      if (!part.materialId) {
        conflicts.push({
          code: 'NON_SHEET_LOT_MATERIAL_INHERITED',
          severity: 'INFO',
          entity: 'MaterialLot',
          reference: lotNo,
          message: `Part "${part.partNumber}" has materialId=null; MaterialLot "${lotNo}" inherited materialId from ${contract ? `contract "${contract.contractNumber}"` : 'default material'} to satisfy non-null MaterialLot.materialId FK.`,
        });
      }
      const loc = line.locationCode
        ? locationByWhAndCode.get(`${doc.warehouseId}::${String(line.locationCode).toUpperCase()}`)
        : undefined;
      desiredLots.set(lotNo, {
        lotNumber: lotNo,
        partId: part.id,
        materialId: matId,
        contractId: contract?.id ?? null,
        heatNumber: line.heatNumber ? String(line.heatNumber) : null,
        coilSerialNumber: null,
        thicknessMm: part.thicknessMm ?? DECIMAL_ZERO,
        widthMm: DECIMAL_ZERO,
        initialWeightKg: decimalAbs(toDecimal(line.quantityKg ?? 0)),
        remainingWeightKg: DECIMAL_ZERO,
        warehouseLocationId: loc?.id ?? null,
        receivedDate: parseDate(doc.postedAt || doc.documentDate),
      });
    }
  }

  let lotInserts = 0;
  let lotSkips = 0;
  for (const lot of desiredLots.values()) {
    if (lotByNumber.has(lot.lotNumber)) {
      lotSkips += 1;
      continue;
    }
    lotInserts += 1;
    const created = isApply
      ? await db.materialLot.create({
          data: {
            lotNumber: lot.lotNumber,
            materialId: lot.materialId,
            partId: lot.partId,
            supplierContractId: lot.contractId,
            heatNumber: lot.heatNumber,
            coilSerialNumber: lot.coilSerialNumber,
            thicknessMm: lot.thicknessMm,
            widthMm: lot.widthMm,
            initialWeightKg: lot.initialWeightKg,
            remainingWeightKg: lot.remainingWeightKg,
            warehouseLocationId: lot.warehouseLocationId,
            status: LotStatus.AVAILABLE,
            receivedDate: lot.receivedDate,
          },
        })
      : {
          id: `SIM-LOT-${lot.lotNumber}`,
          lotNumber: lot.lotNumber,
          materialId: lot.materialId,
          partId: lot.partId,
          supplierContractId: lot.contractId,
          heatNumber: lot.heatNumber,
          coilSerialNumber: lot.coilSerialNumber,
          thicknessMm: lot.thicknessMm,
          widthMm: lot.widthMm,
          lengthMm: null,
          initialWeightKg: lot.initialWeightKg,
          remainingWeightKg: lot.remainingWeightKg,
          warehouseLocationId: lot.warehouseLocationId,
          status: LotStatus.AVAILABLE,
          receivedDate: lot.receivedDate,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
    lotByNumber.set(created.lotNumber, created);
  }
  const lotStat: EntityReconciliationCount = {
    entity: 'MaterialLot',
    targetTable: 'material_lots',
    sourceCount: desiredLots.size,
    existingCount: existingLots.length,
    plannedInserts: lotInserts,
    plannedUpdates: 0,
    plannedSkips: lotSkips,
  };
  recordStat(lotStat);

  // Ensure PhysicalCoil rows exist (reconciliation updates happen after ledger replay!)
  let coilInserts = 0;
  let coilUpdates = 0;
  let coilSkips = 0;
  const coilFloatArtifacts = new Map<string, { raw: Prisma.Decimal; normalized: Prisma.Decimal; hadFloatArtifact: boolean }>();

  for (const c of snapshotCoils) {
    const coilId = String(c.coilId || c.id).trim();
    const normRem = normalizeFloatArtifact(c.remainingWeightKg ?? c.originalWeightKg ?? 0);
    coilFloatArtifacts.set(coilId, normRem);
    if (normRem.hadFloatArtifact) {
      conflicts.push({
        code: 'COIL_FLOATING_POINT_ARTIFACT',
        severity: 'WARNING',
        entity: 'PhysicalCoil',
        reference: coilId,
        message: `PhysicalCoil "${coilId}" contains IEEE-754 floating-point artifact remainingWeightKg=${normRem.raw.toString()} (clean Decimal=${normRem.normalized.toString()}). Will be normalized via Prisma.Decimal.`,
        details: { raw: normRem.raw.toString(), normalized: normRem.normalized.toString() },
      });
    }

    const existing = coilByCoilId.get(coilId) || (c.id ? coilById.get(c.id) : undefined);
    const lot = lotByNumber.get(String(c.coilPackNumber || coilId));
    if (!existing) {
      const part = resolvePart(c.partCode, c.partId, 'PhysicalCoil', coilId);
      const mat = (c.materialGrade && materialByGrade.get(String(c.materialGrade).trim().toUpperCase())) || undefined;
      const wh = warehouseById.get(String(c.warehouseId)) || warehouseByCode.get(String(c.warehouseId || 'WH-RAW').toUpperCase());
      if (!wh) throw new Error(`Warehouse "${c.warehouseId}" missing for PhysicalCoil "${coilId}".`);
      coilInserts += 1;
      const created = isApply
        ? await db.physicalCoil.create({
            data: {
              id: c.id ? String(c.id) : undefined,
              coilId,
              coilPackNumber: String(c.coilPackNumber || coilId),
              partId: part.id,
              materialId: mat?.id ?? part.materialId ?? null,
              materialLotId: lot?.id ?? null,
              heatNumber: c.heatNumber ? String(c.heatNumber) : null,
              thicknessMm: toDecimal(c.thicknessMm ?? 0),
              widthMm: toDecimal(c.widthMm ?? 0),
              originalWeightKg: toDecimal(c.originalWeightKg ?? 0),
              remainingWeightKg: normRem.normalized,
              warehouseId: wh.id,
              warehouseLocationId: lot?.warehouseLocationId ?? null,
              ownership: normalizeOwnership(c.ownership).value,
              qualityStatus: String(c.qualityStatus || 'AVAILABLE'),
              physicalStatus: String(c.physicalStatus || 'AVAILABLE'),
              supplierName: c.supplierName ? String(c.supplierName) : null,
              receiptDate: parseDate(c.receiptDate),
            },
          })
        : {
            id: c.id ? String(c.id) : `SIM-COIL-${coilId}`,
            coilId,
            coilPackNumber: String(c.coilPackNumber || coilId),
            partId: part.id,
            materialId: mat?.id ?? null,
            materialLotId: lot?.id ?? null,
            heatNumber: c.heatNumber ? String(c.heatNumber) : null,
            thicknessMm: toDecimal(c.thicknessMm ?? 0),
            widthMm: toDecimal(c.widthMm ?? 0),
            originalWeightKg: toDecimal(c.originalWeightKg ?? 0),
            remainingWeightKg: normRem.normalized,
            warehouseId: wh.id,
            warehouseLocationId: lot?.warehouseLocationId ?? null,
            ownership: normalizeOwnership(c.ownership).value,
            qualityStatus: String(c.qualityStatus || 'AVAILABLE'),
            physicalStatus: String(c.physicalStatus || 'AVAILABLE'),
            parentCoilId: null,
            supplierName: c.supplierName ? String(c.supplierName) : null,
            receiptDate: parseDate(c.receiptDate),
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
      coilByCoilId.set(coilId, created);
      coilByPackNumber.set(created.coilPackNumber, created);
      coilById.set(created.id, created);
    }
  }

  // Contract-to-Coil Allocations (validate per-coil & per-contract Decimal limits!)
  const plannedAllocations: Array<{
    contractId: string;
    contractNumber: string;
    coilDbId: string;
    coilId: string;
    allocatedWeightKg: Prisma.Decimal;
    ownership: string;
    source: 'physicalCoil.allocations' | 'contract.coils';
  }> = [];

  const seenAllocPair = new Set<string>();
  for (const c of snapshotCoils) {
    const dbCoil = coilByCoilId.get(String(c.coilId));
    if (!dbCoil) continue;
    for (const a of Array.isArray(c.allocations) ? c.allocations : []) {
      const contract = contractById.get(String(a.contractId || '')) || contractByNumber.get(String(a.contractNumber || ''));
      if (!contract) throw new Error(`Contract missing for coil allocation on "${dbCoil.coilId}".`);
      const pairKey = `${contract.id}::${dbCoil.id}`;
      if (seenAllocPair.has(pairKey)) continue;
      seenAllocPair.add(pairKey);
      plannedAllocations.push({
        contractId: contract.id,
        contractNumber: contract.contractNumber,
        coilDbId: dbCoil.id,
        coilId: dbCoil.coilId,
        allocatedWeightKg: toDecimal(a.allocatedWeightKg),
        ownership: normalizeOwnership(a.ownership, dbCoil.ownership).value,
        source: 'physicalCoil.allocations',
      });
    }
  }

  for (const sc of snapshotContracts) {
    const contract = contractByNumber.get(String(sc.contractNumber || sc.id || ''));
    if (!contract) continue;
    for (const cc of Array.isArray(sc.coils) ? sc.coils : []) {
      const dbCoil = coilByCoilId.get(String(cc.coilId || '')) || coilByPackNumber.get(String(cc.coilPackNumber || ''));
      if (!dbCoil) continue;
      const pairKey = `${contract.id}::${dbCoil.id}`;
      if (seenAllocPair.has(pairKey)) continue;
      seenAllocPair.add(pairKey);
      plannedAllocations.push({
        contractId: contract.id,
        contractNumber: contract.contractNumber,
        coilDbId: dbCoil.id,
        coilId: dbCoil.coilId,
        allocatedWeightKg: toDecimal(cc.allocatedWeightKg ?? 0),
        ownership: dbCoil.ownership,
        source: 'contract.coils',
      });
      conflicts.push({
        code: 'COIL_ALLOCATION_SNAPSHOT_MISMATCH',
        severity: 'WARNING',
        entity: 'ContractCoilAllocation',
        reference: `${contract.contractNumber} -> ${dbCoil.coilId}`,
        message: `Snapshot physicalCoils["${dbCoil.coilId}"].allocations is empty, whereas contracts["${contract.contractNumber}"].coils declares allocatedWeightKg=${toDecimal(cc.allocatedWeightKg ?? 0).toString()} kg. Derived allocation from contract.coils after validating coil and contract limits.`,
      });
    }
  }

  // Validate per-coil and per-contract weight limits in exact Decimal
  const totalByCoil = new Map<string, Prisma.Decimal>();
  const totalByContract = new Map<string, Prisma.Decimal>();
  for (const alloc of plannedAllocations) {
    if (alloc.allocatedWeightKg.lte(DECIMAL_ZERO)) {
      throw new Error(`Invalid non-positive contract coil allocation (${alloc.allocatedWeightKg.toString()} kg) for ${alloc.contractNumber} -> ${alloc.coilId}`);
    }
    const prevCoil = totalByCoil.get(alloc.coilDbId) ?? DECIMAL_ZERO;
    const nextCoil = decimalAdd(prevCoil, alloc.allocatedWeightKg);
    const dbCoil = coilById.get(alloc.coilDbId)!;
    if (nextCoil.gt(toDecimal(dbCoil.originalWeightKg))) {
      throw new Error(
        `Contract allocation overflow on PhysicalCoil "${dbCoil.coilId}": allocated ${nextCoil.toString()} kg exceeds originalWeightKg ${toDecimal(dbCoil.originalWeightKg).toString()} kg.`,
      );
    }
    totalByCoil.set(alloc.coilDbId, nextCoil);

    const prevContract = totalByContract.get(alloc.contractId) ?? DECIMAL_ZERO;
    const nextContract = decimalAdd(prevContract, alloc.allocatedWeightKg);
    const dbContract = contractById.get(alloc.contractId)!;
    if (nextContract.gt(toDecimal(dbContract.totalAllocatedWeightKg))) {
      throw new Error(
        `Contract limit overflow on MaterialContract "${dbContract.contractNumber}": allocated ${nextContract.toString()} kg exceeds totalAllocatedWeightKg ${toDecimal(dbContract.totalAllocatedWeightKg).toString()} kg.`,
      );
    }
    totalByContract.set(alloc.contractId, nextContract);
  }

  let allocInserts = 0;
  let allocSkips = 0;
  for (const alloc of plannedAllocations) {
    const key = `${alloc.contractId}::${alloc.coilDbId}`;
    if (coilAllocKeys.has(key)) {
      allocSkips += 1;
      continue;
    }
    allocInserts += 1;
    const created = isApply
      ? await db.contractCoilAllocation.create({
          data: {
            contractId: alloc.contractId,
            coilId: alloc.coilDbId,
            allocatedWeightKg: alloc.allocatedWeightKg,
            ownership: alloc.ownership,
            notes: `Backfilled from snapshot (${alloc.source})`,
          },
        })
      : {
          id: `SIM-ALLOC-${alloc.contractNumber}-${alloc.coilId}`,
          contractId: alloc.contractId,
          coilId: alloc.coilDbId,
          allocatedWeightKg: alloc.allocatedWeightKg,
          ownership: alloc.ownership,
          sourceDocumentId: null,
          notes: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
    coilAllocKeys.set(key, created);
  }
  recordStat({
    entity: 'ContractCoilAllocation',
    targetTable: 'contract_coil_allocations',
    sourceCount: plannedAllocations.length,
    existingCount: existingCoilAllocations.length,
    plannedInserts: allocInserts,
    plannedUpdates: 0,
    plannedSkips: allocSkips,
  });

  const contractAllocationChecks: ContractAllocationSummary[] = [...contractById.values()].map((c) => {
    const contractAllocs = plannedAllocations.filter((a) => a.contractId === c.id);
    const sum = contractAllocs.reduce((acc, item) => decimalAdd(acc, item.allocatedWeightKg), DECIMAL_ZERO);
    return {
      contractNumber: c.contractNumber,
      totalAllocatedWeightKg: formatDecimal(toDecimal(c.totalAllocatedWeightKg)),
      plannedCoilAllocationsKg: formatDecimal(sum),
      withinContractLimit: sum.lte(toDecimal(c.totalAllocatedWeightKg)),
      allocations: contractAllocs.map((a) => ({
        coilId: a.coilId,
        allocatedWeightKg: formatDecimal(a.allocatedWeightKg),
        source: a.source,
      })),
    };
  });

  // =========================================================================
  // 13. CUSTOMER ORDERS & LINES
  // =========================================================================
  const snapshotCustomerOrders: any[] = Array.isArray(inv.customerOrders) ? inv.customerOrders : [];
  let coInserts = 0;
  let coSkips = 0;
  let coLineInserts = 0;
  let coLineSkips = 0;
  let sourceCoLineCount = 0;

  for (const ord of snapshotCustomerOrders) {
    const orderNumber = String(ord.orderNumber || ord.id).trim();
    let dbOrder = orderByNumber.get(orderNumber) || (ord.id ? orderById.get(ord.id) : undefined);
    if (!dbOrder) {
      const cust =
        (ord.customerId ? customerById.get(String(ord.customerId)) : undefined) ||
        (ord.customerCode ? customerByCode.get(String(ord.customerCode).trim().toUpperCase()) : undefined) ||
        customerByCode.get('CUST-SAPCO') ||
        [...customerById.values()][0];
      if (!cust) throw new Error(`No Customer found for CustomerOrder "${orderNumber}".`);
      const resolvedContractNumber = ord.contractNumber
        ? String(ord.contractNumber)
        : ord.contractId
          ? (contractById.get(String(ord.contractId))?.contractNumber ?? null)
          : null;
      coInserts += 1;
      dbOrder = isApply
        ? await db.customerOrder.create({
            data: {
              id: ord.id ? String(ord.id) : undefined,
              orderNumber,
              customerId: cust.id,
              orderDate: parseDate(ord.orderDate || ord.createdAt),
              requestedDeliveryDate: parseDate(ord.dueDate || ord.requestedDeliveryDate),
              customerContractNumber: resolvedContractNumber,
              priority: Number.isFinite(Number(ord.priority)) ? Math.round(Number(ord.priority)) : 2,
              documentStatus: mapDocumentStatus(ord.status),
              notes: ord.notes ? String(ord.notes) : null,
            },
          })
        : {
            id: ord.id ? String(ord.id) : `SIM-ORD-${orderNumber}`,
            orderNumber,
            customerId: cust.id,
            orderDate: parseDate(ord.orderDate),
            requestedDeliveryDate: parseDate(ord.dueDate),
            customerContractNumber: resolvedContractNumber,
            priority: Number(ord.priority ?? 2),
            documentStatus: mapDocumentStatus(ord.status),
            notes: ord.notes ? String(ord.notes) : null,
            totalAmount: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
      orderByNumber.set(orderNumber, dbOrder);
      orderById.set(dbOrder.id, dbOrder);
    } else {
      coSkips += 1;
    }

    const lines: any[] = Array.isArray(ord.lines) ? ord.lines : [];
    for (let idx = 0; idx < lines.length; idx++) {
      sourceCoLineCount += 1;
      const ln = lines[idx];
      const lineNumber = Number.isFinite(Number(ln.lineNumber)) ? Math.round(Number(ln.lineNumber)) : idx + 1;
      const olKey = `${dbOrder.id}::${lineNumber}`;
      if ((ln.id && orderLineById.has(ln.id)) || orderLineByOrderLn.has(olKey)) {
        coLineSkips += 1;
        continue;
      }
      const part = resolvePart(ln.partCode, ln.partId, 'CustomerOrderLine', `${orderNumber}#${lineNumber}`);
      coLineInserts += 1;
      const createdLine = isApply
        ? await db.customerOrderLine.create({
            data: {
              id: ln.id ? String(ln.id) : undefined,
              orderId: dbOrder.id,
              partId: part.id,
              lineNumber,
              orderedQty: toDecimal(ln.orderedQuantity ?? ln.orderedQty ?? 0),
              deliveredQty: toDecimal(ln.deliveredQuantity ?? ln.deliveredQty ?? 0),
              unitPrice: ln.unitPriceRials != null ? toDecimal(ln.unitPriceRials) : null,
              requestedDate: parseDate(ln.dueDate || ord.dueDate),
              status: OrderLineStatus.PENDING,
            },
          })
        : {
            id: ln.id ? String(ln.id) : `SIM-OL-${dbOrder.id}-${lineNumber}`,
            orderId: dbOrder.id,
            partId: part.id,
            lineNumber,
            orderedQty: toDecimal(ln.orderedQuantity ?? 0),
            deliveredQty: toDecimal(ln.deliveredQuantity ?? 0),
            unitPrice: ln.unitPriceRials != null ? toDecimal(ln.unitPriceRials) : null,
            requestedDate: parseDate(ln.dueDate || ord.dueDate),
            status: OrderLineStatus.PENDING,
          };
      orderLineById.set(createdLine.id, createdLine);
      orderLineByOrderLn.set(olKey, createdLine);
    }
  }
  recordStat({
    entity: 'CustomerOrder',
    targetTable: 'customer_orders',
    sourceCount: snapshotCustomerOrders.length,
    existingCount: existingCustomerOrders.length,
    plannedInserts: coInserts,
    plannedUpdates: 0,
    plannedSkips: coSkips,
  });
  recordStat({
    entity: 'CustomerOrderLine',
    targetTable: 'customer_order_lines',
    sourceCount: sourceCoLineCount,
    existingCount: existingCustomerOrderLines.length,
    plannedInserts: coLineInserts,
    plannedUpdates: 0,
    plannedSkips: coLineSkips,
  });

  // =========================================================================
  // 14. PRODUCTION PLAN PROPOSALS & LINES (from fallbackPlanProposals)
  // =========================================================================
  const snapshotProposals: any[] = Array.isArray(inv.fallbackPlanProposals) ? inv.fallbackPlanProposals : [];
  let propInserts = 0;
  let propSkips = 0;
  let propLineInserts = 0;
  let propLineSkips = 0;
  let sourcePropLineCount = 0;

  for (const prop of snapshotProposals) {
    const proposalNumber = String(prop.proposalNumber || prop.id).trim();
    let dbProp = proposalByNumber.get(proposalNumber);
    if (!dbProp) {
      propInserts += 1;
      dbProp = isApply
        ? await db.productionPlanProposal.create({
            data: {
              id: prop.id ? String(prop.id) : undefined,
              proposalNumber,
              revisionGroupId: String(prop.revisionGroupId || prop.id || proposalNumber),
              version: Number.isFinite(Number(prop.version)) ? Math.round(Number(prop.version)) : 1,
              status: mapProposalStatus(prop.status),
              generatedAt: parseDate(prop.generatedAt),
              inputSnapshot: (prop.inputSnapshot ?? {}) as Prisma.InputJsonValue,
              notes: prop.notes ? String(prop.notes) : null,
              approvedByUserId: prop.approvedByUserId ? String(prop.approvedByUserId) : null,
              approvedAt: prop.approvedAt ? parseDate(prop.approvedAt) : null,
              releasedAt: prop.releasedAt ? parseDate(prop.releasedAt) : null,
            },
          })
        : {
            id: prop.id ? String(prop.id) : `SIM-PRP-${proposalNumber}`,
            proposalNumber,
            revisionGroupId: String(prop.revisionGroupId || proposalNumber),
            version: Number(prop.version ?? 1),
            status: mapProposalStatus(prop.status),
            generatedAt: parseDate(prop.generatedAt),
            inputSnapshot: {},
            notes: null,
            approvedByUserId: null,
            approvedAt: null,
            releasedAt: null,
          };
      proposalByNumber.set(proposalNumber, dbProp);
    } else {
      propSkips += 1;
    }

    for (const pl of prop.lines || []) {
      sourcePropLineCount += 1;
      const coLine = orderLineById.get(String(pl.customerOrderLineId || ''));
      if (!coLine) {
        conflicts.push({
          code: 'PROPOSAL_LINE_MISSING_ORDER_LINE',
          severity: 'CONFLICT',
          entity: 'ProductionPlanProposalLine',
          reference: String(pl.id || proposalNumber),
          message: `Cannot link proposal line "${pl.id}" because customerOrderLineId "${pl.customerOrderLineId}" was not found.`,
        });
        continue;
      }
      const plKey = `${dbProp.id}::${coLine.id}`;
      if (proposalLineKeys.has(plKey)) {
        propLineSkips += 1;
        continue;
      }
      const part = resolvePart(pl.partCode || pl.part?.partNumber, pl.partId, 'ProductionPlanProposalLine', String(pl.id || proposalNumber));
      const route = routeById.get(String(pl.routeId || '')) || routeByPartVersion.get(`${part.id}::V1.0`);
      if (!route) throw new Error(`Route "${pl.routeId}" missing for ProductionPlanProposalLine "${pl.id}".`);
      propLineInserts += 1;
      proposalLineKeys.add(plKey);
      if (isApply) {
        await db.productionPlanProposalLine.create({
          data: {
            id: pl.id ? String(pl.id) : undefined,
            proposalId: dbProp.id,
            customerOrderLineId: coLine.id,
            partId: part.id,
            routeId: route.id,
            requestedQty: toDecimal(pl.requestedQty ?? 0),
            plannedQty: toDecimal(pl.plannedQty ?? 0),
            plannedStartDate: parseDate(pl.plannedStartDate),
            plannedEndDate: parseDate(pl.plannedEndDate),
            priority: Number.isFinite(Number(pl.priority)) ? Math.round(Number(pl.priority)) : 2,
            operationAssignments: (pl.operationAssignments ?? []) as Prisma.InputJsonValue,
            warnings: (pl.warnings ?? []) as Prisma.InputJsonValue,
          },
        });
      }
    }
  }
  recordStat({
    entity: 'ProductionPlanProposal',
    targetTable: 'production_plan_proposals',
    sourceCount: snapshotProposals.length,
    existingCount: existingProposals.length,
    plannedInserts: propInserts,
    plannedUpdates: 0,
    plannedSkips: propSkips,
  });
  recordStat({
    entity: 'ProductionPlanProposalLine',
    targetTable: 'production_plan_proposal_lines',
    sourceCount: sourcePropLineCount,
    existingCount: existingProposalLines.length,
    plannedInserts: propLineInserts,
    plannedUpdates: 0,
    plannedSkips: propLineSkips,
  });

  // =========================================================================
  // 15. PRODUCTION PLANS & PLAN LINES
  // =========================================================================
  const snapshotPlans: any[] = Array.isArray(inv.plans) ? inv.plans : [];
  let planInserts = 0;
  let planSkips = 0;
  let planLineInserts = 0;
  let planLineSkips = 0;

  for (const pln of snapshotPlans) {
    const planNumber = String(pln.planNumber || pln.id).trim();
    let dbPlan = planByNumber.get(planNumber);
    if (!dbPlan) {
      planInserts += 1;
      dbPlan = isApply
        ? await db.productionPlan.create({
            data: {
              id: pln.id ? String(pln.id) : undefined,
              planNumber,
              title: String(pln.title || planNumber),
              startDate: parseDate(pln.startDate),
              endDate: parseDate(pln.endDate),
              status: mapPlanStatus(pln.status),
              notes: pln.notes ? String(pln.notes) : null,
            },
          })
        : {
            id: pln.id ? String(pln.id) : `SIM-PLN-${planNumber}`,
            planNumber,
            title: String(pln.title || planNumber),
            startDate: parseDate(pln.startDate),
            endDate: parseDate(pln.endDate),
            status: mapPlanStatus(pln.status),
            approvedByUserId: null,
            approvedAt: null,
            notes: pln.notes ? String(pln.notes) : null,
            proposalId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
      planByNumber.set(planNumber, dbPlan);
    } else {
      planSkips += 1;
    }

    const lineId = `${dbPlan.id}-L1`;
    if (planLineById.has(lineId)) {
      planLineSkips += 1;
    } else if (pln.partCode || pln.partId) {
      const part = resolvePart(pln.partCode, pln.partId, 'ProductionPlanLine', planNumber);
      planLineInserts += 1;
      const createdLine = isApply
        ? await db.productionPlanLine.create({
            data: {
              id: lineId,
              planId: dbPlan.id,
              partId: part.id,
              plannedQty: toDecimal(pln.plannedQty ?? 0),
              producedQty: toDecimal(pln.producedQty ?? 0),
              plannedStartDate: parseDate(pln.startDate),
              plannedEndDate: parseDate(pln.endDate),
              priority: Number.isFinite(Number(pln.priority)) ? Math.round(Number(pln.priority)) : 1,
              status: mapPlanLineStatus(pln.status),
            },
          })
        : {
            id: lineId,
            planId: dbPlan.id,
            partId: part.id,
            customerOrderId: null,
            customerOrderLineId: null,
            plannedQty: toDecimal(pln.plannedQty ?? 0),
            producedQty: toDecimal(pln.producedQty ?? 0),
            plannedStartDate: parseDate(pln.startDate),
            plannedEndDate: parseDate(pln.endDate),
            priority: Number(pln.priority ?? 1),
            status: mapPlanLineStatus(pln.status),
          };
      planLineById.set(lineId, createdLine);
    }
  }
  recordStat({
    entity: 'ProductionPlan',
    targetTable: 'production_plans',
    sourceCount: snapshotPlans.length,
    existingCount: existingPlans.length,
    plannedInserts: planInserts,
    plannedUpdates: 0,
    plannedSkips: planSkips,
  });
  recordStat({
    entity: 'ProductionPlanLine',
    targetTable: 'production_plan_lines',
    sourceCount: snapshotPlans.length,
    existingCount: existingPlanLines.length,
    plannedInserts: planLineInserts,
    plannedUpdates: 0,
    plannedSkips: planLineSkips,
  });

  // =========================================================================
  // 16. WIP MANUFACTURING ORDERS, OPERATIONS, LINKS, & TRANSFERS
  // =========================================================================
  let moInserts = 0;
  let moSkips = 0;
  let prodOpInserts = 0;
  let prodOpSkips = 0;
  let wipMoLinkInserts = 0;
  let wipMoLinkSkips = 0;
  let wipOpLinkInserts = 0;
  let wipOpLinkSkips = 0;
  let sourceProdOpCount = 0;
  const wipReconciliation: WipReconciliationSummary[] = [];

  for (const mo of wipMos) {
    const moNumber = String(mo.moNumber || mo.id).trim();
    const part = resolvePart(mo.partCode, mo.partId, 'ManufacturingOrder', moNumber);
    const route =
      (mo.routingId ? routeById.get(String(mo.routingId)) : undefined) ||
      routeByPartVersion.get(`${part.id}::${String(mo.routingVersion || 'V1.0')}`);
    if (!route) {
      throw new Error(`PartRoute "${mo.routingId}" not found for ManufacturingOrder "${moNumber}".`);
    }

    let dbMo = moByNumber.get(moNumber) || (mo.id ? moById.get(mo.id) : undefined);
    if (!dbMo) {
      moInserts += 1;
      dbMo = isApply
        ? await db.manufacturingOrder.create({
            data: {
              id: mo.id ? String(mo.id) : undefined,
              moNumber,
              partId: part.id,
              routeId: route.id,
              targetQty: toDecimal(mo.targetQuantity ?? 0),
              completedQty: toDecimal(mo.completedQuantity ?? 0),
              scrapQty: toDecimal(mo.totalScrapQuantity ?? 0),
              scheduledStartDate: parseDate(mo.startDate || mo.createdAt),
              scheduledEndDate: parseDate(mo.dueDate || mo.startDate),
              priority: 1,
              status: mapMoStatus(mo.status),
              notes: mo.notes ? String(mo.notes) : null,
            },
          })
        : {
            id: mo.id ? String(mo.id) : `SIM-MO-${moNumber}`,
            moNumber,
            partId: part.id,
            routeId: route.id,
            planId: null,
            planLineId: null,
            targetQty: toDecimal(mo.targetQuantity ?? 0),
            initialInputQty: toDecimal(mo.initialInputQuantity ?? 0),
            completedQty: toDecimal(mo.completedQuantity ?? 0),
            scrapQty: toDecimal(mo.totalScrapQuantity ?? 0),
            totalReworkQty: toDecimal(mo.totalReworkQuantity ?? 0),
            totalRejectedQty: toDecimal(mo.totalRejectedQuantity ?? 0),
            parentMoId: null,
            bomId: null,
            outputWarehouseId: null,
            outputLocationId: null,
            scheduledStartDate: parseDate(mo.startDate),
            scheduledEndDate: parseDate(mo.dueDate),
            actualStartDate: null,
            actualEndDate: null,
            closedAt: null,
            priority: 1,
            status: mapMoStatus(mo.status),
            notes: mo.notes ? String(mo.notes) : null,
            createdByName: null,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
      moByNumber.set(moNumber, dbMo!);
      moById.set(dbMo!.id, dbMo!);
    } else {
      moSkips += 1;
    }

    let moLink = wipMoLinkByWipId.get(String(mo.id));
    if (!moLink) {
      wipMoLinkInserts += 1;
      moLink = isApply
        ? await db.wipManufacturingOrderLink.create({
            data: {
              wipManufacturingOrderId: String(mo.id),
              manufacturingOrderId: dbMo!.id,
              createdBy: 'SNAPSHOT_BACKFILL',
              notes: 'Backfilled deterministic identity link between WIP snapshot MO and relational ManufacturingOrder.',
            },
          })
        : {
            id: `SIM-WIPLINK-${mo.id}`,
            wipManufacturingOrderId: String(mo.id),
            manufacturingOrderId: dbMo!.id,
            createdAt: new Date(),
            createdBy: 'SNAPSHOT_BACKFILL',
            notes: null,
          };
      wipMoLinkByWipId.set(String(mo.id), moLink);
    } else {
      wipMoLinkSkips += 1;
    }

    const ops: any[] = Array.isArray(mo.operations) ? mo.operations : [];
    for (const op of ops) {
      sourceProdOpCount += 1;
      const stepNumber = Math.round(Number(op.stepNumber));
      const msKey = `${dbMo!.id}::${stepNumber}`;
      let dbProdOp = prodOpByMoStep.get(msKey) || (op.id ? prodOpById.get(String(op.id)) : undefined);
      if (!dbProdOp) {
        const routeOp = routeOpByRouteStep.get(`${route.id}::${stepNumber}`);
        const stepCode = String(op.stepCode || routeOp?.stepCode || `OP${stepNumber}`).trim().toUpperCase();
        const opDef = (routeOp ? operationById.get(routeOp.operationId) : undefined) || operationByCode.get(stepCode);
        if (!opDef) throw new Error(`Operation definition "${stepCode}" missing for MO "${moNumber}" step ${stepNumber}.`);
        const plannedMachine = op.machineId ? machineById.get(String(op.machineId)) : undefined;
        const opDieRef = op.dieMoldId ?? op.dieId;
        const plannedDie = opDieRef
          ? dieById.get(String(opDieRef)) || dieByCode.get(String(opDieRef).toUpperCase())
          : routeOp?.dieId
            ? dieById.get(routeOp.dieId)
            : undefined;
        const waiting = toDecimal(op.waitingInputQty ?? 0);
        const inProg = toDecimal(op.inProgressQty ?? 0);
        const good = toDecimal(op.goodOutputQty ?? 0);
        const scrap = toDecimal(op.scrapQty ?? 0);
        const rework = toDecimal(op.reworkQty ?? 0);
        const rejected = toDecimal(op.rejectedQty ?? 0);
        const derivedInput = waiting.plus(inProg).plus(good).plus(scrap).plus(rework).plus(rejected);
        prodOpInserts += 1;
        dbProdOp = isApply
          ? await db.productionOperation.create({
              data: {
                id: op.id ? String(op.id) : undefined,
                manufacturingOrderId: dbMo!.id,
                operationId: opDef.id,
                routeOperationId: routeOp?.id ?? null,
                stepNumber,
                plannedMachineId: plannedMachine?.id ?? routeOp?.machineId ?? null,
                plannedDieId: plannedDie?.id ?? null,
                plannedQty: toDecimal(mo.targetQuantity ?? 0),
                inputQty: derivedInput,
                outputGoodQty: good,
                outputScrapQty: scrap,
                outputReworkQty: rework,
                outputRejectedQty: rejected,
                status: mapOpStatus(op.status),
              },
            })
          : {
              id: op.id ? String(op.id) : `SIM-POP-${dbMo!.id}-${stepNumber}`,
              manufacturingOrderId: dbMo!.id,
              operationId: opDef.id,
              routeOperationId: routeOp?.id ?? null,
              stepNumber,
              sequence: stepNumber,
              stepCode,
              stepName: op.stepName ? String(op.stepName) : null,
              plannedMachineId: plannedMachine?.id ?? null,
              plannedDieId: plannedDie?.id ?? null,
              plannedQty: toDecimal(mo.targetQuantity ?? 0),
              inputQty: derivedInput,
              waitingInputQty: waiting,
              inProgressQty: inProg,
              outputGoodQty: good,
              outputScrapQty: scrap,
              outputReworkQty: rework,
              outputRejectedQty: rejected,
              readyForTransferQty: toDecimal(op.readyForTransferQty ?? 0),
              transferredQty: toDecimal(op.transferredQty ?? 0),
              warehouseLocationCode: null,
              warehouseId: null,
              locationId: null,
              standardCycleTimeSec: Number(op.standardCycleTimeSec ?? 0),
              scrapNormPercent: toDecimal(op.scrapNormPercent ?? 0),
              status: mapOpStatus(op.status),
              startDate: null,
              endDate: null,
              lastActivityAt: null,
              version: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
        prodOpByMoStep.set(msKey, dbProdOp!);
        prodOpById.set(dbProdOp!.id, dbProdOp!);
      } else {
        prodOpSkips += 1;
      }

      if (!wipOpLinkByWipId.has(String(op.id))) {
        wipOpLinkInserts += 1;
        const createdLink = isApply
          ? await db.wipOperationLink.create({
              data: {
                wipOperationId: String(op.id),
                manufacturingOrderLinkId: moLink.id,
                productionOperationId: dbProdOp!.id,
              },
            })
          : {
              id: `SIM-WIPLINKOP-${op.id}`,
              wipOperationId: String(op.id),
              manufacturingOrderLinkId: moLink.id,
              productionOperationId: dbProdOp!.id,
              createdAt: new Date(),
            };
        wipOpLinkByWipId.set(String(op.id), createdLink);
      } else {
        wipOpLinkSkips += 1;
      }
    }

    wipReconciliation.push({
      moNumber,
      partNumber: part.partNumber,
      routeId: route.id,
      operationCount: ops.length,
      transferCount: wipTransfers.filter((t) => t.moId === mo.id || t.moNumber === moNumber).length,
      targetQty: formatDecimal(toDecimal(mo.targetQuantity ?? 0)),
      completedQty: formatDecimal(toDecimal(mo.completedQuantity ?? 0)),
      scrapQty: formatDecimal(toDecimal(mo.totalScrapQuantity ?? 0)),
      wipLinkPlanned: true,
    });
  }

  recordStat({
    entity: 'ManufacturingOrder',
    targetTable: 'manufacturing_orders',
    sourceCount: wipMos.length,
    existingCount: existingMos.length,
    plannedInserts: moInserts,
    plannedUpdates: 0,
    plannedSkips: moSkips,
  });
  recordStat({
    entity: 'ProductionOperation',
    targetTable: 'production_operations',
    sourceCount: sourceProdOpCount,
    existingCount: existingProdOps.length,
    plannedInserts: prodOpInserts,
    plannedUpdates: 0,
    plannedSkips: prodOpSkips,
  });
  recordStat({
    entity: 'WipManufacturingOrderLink',
    targetTable: 'wip_manufacturing_order_links',
    sourceCount: wipMos.length,
    existingCount: existingWipMoLinks.length,
    plannedInserts: wipMoLinkInserts,
    plannedUpdates: 0,
    plannedSkips: wipMoLinkSkips,
  });
  recordStat({
    entity: 'WipOperationLink',
    targetTable: 'wip_operation_links',
    sourceCount: sourceProdOpCount,
    existingCount: existingWipOpLinks.length,
    plannedInserts: wipOpLinkInserts,
    plannedUpdates: 0,
    plannedSkips: wipOpLinkSkips,
  });

  // WIP Transfers -> ProductionTransfer
  let transferInserts = 0;
  let transferSkips = 0;
  const pcsUnit = unitByCode.get('PCS');
  if (!pcsUnit && wipTransfers.length > 0) {
    throw new Error('UnitOfMeasure "PCS" is required to backfill ProductionTransfer rows.');
  }
  for (const tr of wipTransfers) {
    const transferNumber = String(tr.transferNumber || tr.id).trim();
    if (transferByNumber.has(transferNumber)) {
      transferSkips += 1;
      continue;
    }
    const dbMo = moByNumber.get(String(tr.moNumber || '')) || moById.get(String(tr.moId || ''));
    if (!dbMo) throw new Error(`ManufacturingOrder "${tr.moNumber || tr.moId}" missing for ProductionTransfer "${transferNumber}".`);
    const part = resolvePart(tr.partCode, tr.partId, 'ProductionTransfer', transferNumber);
    const fromLoc = tr.fromLocation ? locationByCode.get(String(tr.fromLocation).toUpperCase()) : undefined;
    const toLoc = tr.toLocation ? locationByCode.get(String(tr.toLocation).toUpperCase()) : undefined;
    const fromWh = (fromLoc ? warehouseById.get(fromLoc.warehouseId) : undefined) || warehouseByCode.get(inferWarehouseForLocationCode(String(tr.fromLocation || '')));
    const toWh = (toLoc ? warehouseById.get(toLoc.warehouseId) : undefined) || warehouseByCode.get(inferWarehouseForLocationCode(String(tr.toLocation || '')));
    if (!fromWh || !toWh) {
      throw new Error(`Could not resolve fromWarehouse/toWarehouse for ProductionTransfer "${transferNumber}".`);
    }
    const fromOp = tr.fromOperationId ? prodOpById.get(String(tr.fromOperationId)) : undefined;
    const toOp = tr.toOperationId ? prodOpById.get(String(tr.toOperationId)) : undefined;
    const notesParts = [tr.notes, tr.dispatchedBy ? `ارسال: ${tr.dispatchedBy}` : null, tr.receivedBy ? `تحویل: ${tr.receivedBy}` : null].filter(Boolean);
    transferInserts += 1;
    const createdTr = isApply
      ? await db.productionTransfer.create({
          data: {
            id: tr.id ? String(tr.id) : undefined,
            transferNumber,
            manufacturingOrderId: dbMo.id,
            partId: part.id,
            fromStageOperationId: fromOp?.id ?? null,
            toStageOperationId: toOp?.id ?? null,
            fromWarehouseId: fromWh.id,
            toWarehouseId: toWh.id,
            quantity: toDecimal(tr.quantity ?? 0),
            unitId: pcsUnit!.id,
            dispatchedAt: parseDate(tr.dispatchedAt),
            receivedAt: tr.receivedAt ? parseDate(tr.receivedAt) : null,
            status: mapTransferStatus(tr.status),
            notes: notesParts.length ? notesParts.join(' | ') : null,
          },
        })
      : {
          id: tr.id ? String(tr.id) : `SIM-TRF-${transferNumber}`,
          transferNumber,
          manufacturingOrderId: dbMo.id,
          partId: part.id,
          fromStageOperationId: fromOp?.id ?? null,
          toStageOperationId: toOp?.id ?? null,
          fromWarehouseId: fromWh.id,
          toWarehouseId: toWh.id,
          fromLocationId: fromLoc?.id ?? null,
          toLocationId: toLoc?.id ?? null,
          fromLocationCode: fromLoc?.code ?? null,
          toLocationCode: toLoc?.code ?? null,
          fromStepNumber: fromOp?.stepNumber ?? null,
          toStepNumber: toOp?.stepNumber ?? null,
          fromStepName: null,
          toStepName: null,
          quantity: toDecimal(tr.quantity ?? 0),
          unitId: pcsUnit!.id,
          dispatchedByUserId: null,
          dispatchedByName: tr.dispatchedBy ? String(tr.dispatchedBy) : null,
          dispatchedAt: parseDate(tr.dispatchedAt),
          receivedByUserId: null,
          receivedByName: tr.receivedBy ? String(tr.receivedBy) : null,
          receivedAt: tr.receivedAt ? parseDate(tr.receivedAt) : null,
          rejectedByUserId: null,
          rejectedByName: null,
          rejectedAt: null,
          rejectionReason: null,
          status: mapTransferStatus(tr.status),
          inventoryDocId: null,
          notes: notesParts.join(' | '),
          version: 1,
        };
    transferByNumber.set(transferNumber, createdTr);
  }
  recordStat({
    entity: 'ProductionTransfer',
    targetTable: 'production_transfers',
    sourceCount: wipTransfers.length,
    existingCount: existingTransfers.length,
    plannedInserts: transferInserts,
    plannedUpdates: 0,
    plannedSkips: transferSkips,
  });

  // =========================================================================
  // 17. INVENTORY DOCUMENTS, LINES, TRANSACTIONS, & STOCK BALANCE DERIVATION
  // =========================================================================
  // Initialize in-memory balance ledger from any existing relational StockBalance rows
  const balanceBuckets = new Map<string, BalanceBucket>();
  const existingBalanceDbIds = new Map<string, string>();
  for (const b of existingBalances) {
    const part = partById.get(b.partId);
    const wh = warehouseById.get(b.warehouseId);
    const loc = b.locationId ? existingLocations.find((l) => l.id === b.locationId) : undefined;
    const lot = b.materialLotId ? existingLots.find((l) => l.id === b.materialLotId) : undefined;
    const coil = b.physicalCoilId ? coilById.get(b.physicalCoilId) : undefined;
    const key = makeBalanceKey({
      partId: b.partId,
      warehouseId: b.warehouseId,
      locationId: b.locationId,
      materialLotId: b.materialLotId,
      physicalCoilId: b.physicalCoilId,
      ownership: b.ownership,
      contractId: b.contractId,
      qualityStatus: b.qualityStatus,
    });
    balanceBuckets.set(key, {
      key,
      partId: b.partId,
      partNumber: part?.partNumber || b.partId,
      warehouseId: b.warehouseId,
      warehouseCode: wh?.code || b.warehouseId,
      locationId: b.locationId,
      locationCode: loc?.code ?? null,
      materialLotId: b.materialLotId,
      lotNumber: lot?.lotNumber ?? null,
      physicalCoilId: b.physicalCoilId,
      coilId: coil?.coilId ?? null,
      ownership: b.ownership,
      contractId: b.contractId,
      contractNumber: b.contractNumber,
      qualityStatus: b.qualityStatus,
      quantityOnHand: toDecimal(b.quantityOnHand),
      quantityReserved: toDecimal(b.quantityReserved),
      quantityAvailable: toDecimal(b.quantityAvailable),
      weightKgOnHand: toDecimal(b.weightKgOnHand),
      weightKgReserved: toDecimal(b.weightKgReserved),
      weightKgAvailable: toDecimal(b.weightKgAvailable),
      lastTransactionAt: b.lastTransactionAt,
    });
    existingBalanceDbIds.set(key, b.id);
  }

  // Chronological deterministic replay order: earliest postedAt/documentDate first,
  // ensuring non-REVERSAL documents precede REVERSAL documents at identical timestamps.
  const orderedDocs = [...snapshotDocs].sort((a, b) => {
    const ta = parseDate(a.postedAt || a.documentDate || a.createdAt).getTime();
    const tb = parseDate(b.postedAt || b.documentDate || b.createdAt).getTime();
    if (ta !== tb) return ta - tb;
    const ra = String(a.documentType).toUpperCase() === 'REVERSAL' ? 1 : 0;
    const rb = String(b.documentType).toUpperCase() === 'REVERSAL' ? 1 : 0;
    if (ra !== rb) return ra - rb;
    return String(a.documentNumber || a.id).localeCompare(String(b.documentNumber || b.id));
  });

  // Pre-populate original transaction IDs per (documentNumber, lineNumber) and movement signatures
  // from existingTransactions so incremental REVERSAL backfills link reversalOfTrxId accurately
  // and multi-line documents never skip lines on partial pre-existing state.
  const firstTxIdByDocLine = new Map<string, string>();
  const existingTxMovementKeys = new Set<string>();
  const sortedExistingTxs = [...existingTransactions].sort((a, b) => {
    const dt = parseDate(a.transactionDate).getTime() - parseDate(b.transactionDate).getTime();
    return dt !== 0 ? dt : String(a.transactionNumber).localeCompare(String(b.transactionNumber));
  });
  for (const tx of sortedExistingTxs) {
    if (tx.documentId && tx.documentLineId) {
      const parentDoc = docById.get(tx.documentId);
      const parentLine = docLineById.get(tx.documentLineId);
      if (parentDoc && parentLine) {
        const dlKey = `${parentDoc.documentNumber}::${parentLine.lineNumber}`;
        if (!firstTxIdByDocLine.has(dlKey)) {
          firstTxIdByDocLine.set(dlKey, tx.id);
        }
      }
      existingTxMovementKeys.add(
        `${tx.documentLineId}::${tx.warehouseId}::${tx.qualityStatus}::${tx.transactionType}`,
      );
    }
  }
  const modifiedBalanceKeys = new Set<string>();

  let docInserts = 0;
  let docSkips = 0;
  let docLineInserts = 0;
  let docLineSkips = 0;
  let sourceDocLineCount = 0;
  let txInserts = 0;
  let txSkips = 0;
  let plannedTxTotal = 0;

  const getOrCreateBucket = (args: {
    partId: string;
    partNumber: string;
    warehouseId: string;
    warehouseCode: string;
    locationId: string | null;
    locationCode: string | null;
    materialLotId: string | null;
    lotNumber: string | null;
    physicalCoilId: string | null;
    coilId: string | null;
    ownership: string;
    contractId: string | null;
    contractNumber: string | null;
    qualityStatus: string;
  }): BalanceBucket => {
    const key = makeBalanceKey(args);
    let bucket = balanceBuckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        ...args,
        quantityOnHand: DECIMAL_ZERO,
        quantityReserved: DECIMAL_ZERO,
        quantityAvailable: DECIMAL_ZERO,
        weightKgOnHand: DECIMAL_ZERO,
        weightKgReserved: DECIMAL_ZERO,
        weightKgAvailable: DECIMAL_ZERO,
        lastTransactionAt: null,
      };
      balanceBuckets.set(key, bucket);
    }
    return bucket;
  };

  // When an outbound/QM/reversal line omits contractId on a lot/coil that already has
  // a single unique balance bucket for (part, wh, loc, lot, coil, ownership, qualityStatus),
  // inherit its contractId so outbound/QM deductions reconcile cleanly against the opening bucket.
  const resolveContractForMovement = (args: {
    explicitContractId: string | null;
    explicitContractNumber: string | null;
    partId: string;
    warehouseId: string;
    locationId: string | null;
    materialLotId: string | null;
    physicalCoilId: string | null;
    ownership: string;
    qualityStatus: string;
    docNumber: string;
  }): { contractId: string | null; contractNumber: string | null } => {
    if (args.explicitContractId) {
      const c = contractById.get(args.explicitContractId) || contractByNumber.get(args.explicitContractId);
      return {
        contractId: c?.id ?? args.explicitContractId,
        contractNumber: args.explicitContractNumber || c?.contractNumber || null,
      };
    }
    const candidates = [...balanceBuckets.values()].filter(
      (b) =>
        b.partId === args.partId &&
        b.warehouseId === args.warehouseId &&
        b.locationId === args.locationId &&
        b.materialLotId === args.materialLotId &&
        b.physicalCoilId === args.physicalCoilId &&
        b.ownership === args.ownership &&
        b.qualityStatus === args.qualityStatus &&
        b.contractId !== null,
    );
    if (candidates.length === 1) {
      conflicts.push({
        code: 'LINE_CONTRACT_INHERITED_FROM_LOT_BUCKET',
        severity: 'INFO',
        entity: 'InventoryDocumentLine',
        reference: args.docNumber,
        message: `Document "${args.docNumber}" omitted contractId on lot/coil movement; inherited contract "${candidates[0].contractNumber}" from the unique matching stock bucket to preserve balance conservation.`,
      });
      return {
        contractId: candidates[0].contractId,
        contractNumber: candidates[0].contractNumber,
      };
    }
    return { contractId: null, contractNumber: null };
  };

  for (const doc of orderedDocs) {
    const docNumber = String(doc.documentNumber || doc.id).trim();
    const rawDocType = String(doc.documentType || '').trim().toUpperCase();
    const postingStatus = mapPostingStatus(doc.postingStatus);
    const documentStatus = mapDocumentStatus(doc.documentStatus);
    const warehouse = warehouseById.get(String(doc.warehouseId || '')) || warehouseByCode.get(String(doc.warehouseId || '').toUpperCase());
    if (!warehouse) throw new Error(`Warehouse "${doc.warehouseId}" missing for InventoryDocument "${docNumber}".`);
    const targetWarehouse = doc.targetWarehouseId
      ? warehouseById.get(String(doc.targetWarehouseId)) || warehouseByCode.get(String(doc.targetWarehouseId).toUpperCase())
      : null;

    const createdByUserId = resolveActorUserId(doc.createdByUid);
    const postedByUserId = doc.postedByUid ? resolveActorUserId(doc.postedByUid) : null;
    const docDate = parseDate(doc.documentDate || doc.createdAt);
    const postedAt = doc.postedAt ? parseDate(doc.postedAt) : null;

    // Resolve reversal link if this is a REVERSAL document
    let reversalOfId: string | null = null;
    if (rawDocType === 'REVERSAL') {
      const targetDoc =
        (doc.reversalOfDocId && docById.get(String(doc.reversalOfDocId))) ||
        (doc.reversalOfId && docById.get(String(doc.reversalOfId))) ||
        (doc.referenceNumber && docByNumber.get(String(doc.referenceNumber)));
      reversalOfId = targetDoc?.id ?? null;
    }

    let dbDoc = docByNumber.get(docNumber) || (doc.id ? docById.get(String(doc.id)) : undefined);
    if (!dbDoc) {
      docInserts += 1;
      const notes = [doc.auditNote, doc.adjustmentReason, doc.movementLabel].filter(Boolean).join(' | ') || null;
      dbDoc = isApply
        ? await db.inventoryDocument.create({
            data: {
              id: doc.id ? String(doc.id) : undefined,
              documentNumber: docNumber,
              documentType: mapDocumentType(rawDocType),
              documentDate: docDate,
              documentStatus,
              postingStatus,
              warehouseId: warehouse.id,
              targetWarehouseId: targetWarehouse?.id ?? null,
              referenceType: mapReferenceType(doc.referenceType),
              referenceNumber: doc.referenceNumber ? String(doc.referenceNumber) : null,
              createdByUserId,
              postedByUserId,
              postedAt,
              isReversed: postingStatus === PostingStatus.REVERSED,
              reversalOfId,
              notes,
            },
          })
        : {
            id: doc.id ? String(doc.id) : `SIM-DOC-${docNumber}`,
            documentNumber: docNumber,
            documentType: mapDocumentType(rawDocType),
            documentDate: docDate,
            documentStatus,
            postingStatus,
            warehouseId: warehouse.id,
            targetWarehouseId: targetWarehouse?.id ?? null,
            referenceType: mapReferenceType(doc.referenceType),
            referenceNumber: doc.referenceNumber ? String(doc.referenceNumber) : null,
            createdByUserId,
            postedByUserId,
            postedAt,
            isReversed: postingStatus === PostingStatus.REVERSED,
            reversalOfId,
            issueRequestKey: null,
            issueRequestFingerprint: null,
            idempotencyKey: null,
            requestFingerprint: null,
            notes,
            createdAt: docDate,
            updatedAt: docDate,
          };
      docByNumber.set(docNumber, dbDoc);
      docById.set(dbDoc.id, dbDoc);
    } else {
      docSkips += 1;
    }

    const lines: any[] = Array.isArray(doc.lines) ? doc.lines : [];
    // Both POSTED and REVERSED documents originally posted movements to the ledger;
    // UNPOSTED (DRAFT / CANCELLED) documents emit 0 transactions and 0 balance changes!
    const shouldEmitLedgerMovements =
      postingStatus === PostingStatus.POSTED || postingStatus === PostingStatus.REVERSED;

    for (let i = 0; i < lines.length; i++) {
      sourceDocLineCount += 1;
      const ln = lines[i];
      const lineNumber = Number.isFinite(Number(ln.lineNumber)) ? Math.round(Number(ln.lineNumber)) : i + 1;
      const part = resolvePart(ln.partCode, ln.partId, 'InventoryDocumentLine', `${docNumber}#${lineNumber}`);
      const unitCode = String(ln.unit || 'PCS').trim().toUpperCase();
      const unit = unitByCode.get(unitCode) || unitById.get(part.unitId);
      if (!unit) throw new Error(`Unit "${unitCode}" missing for ${docNumber}#${lineNumber}.`);

      const location = ln.locationCode
        ? locationByWhAndCode.get(`${warehouse.id}::${String(ln.locationCode).toUpperCase()}`)
        : null;
      const targetLocation =
        targetWarehouse && ln.targetLocationCode
          ? locationByWhAndCode.get(`${targetWarehouse.id}::${String(ln.targetLocationCode).toUpperCase()}`)
          : null;
      const lot = ln.lotNumber ? lotByNumber.get(String(ln.lotNumber).trim()) : null;
      const coil =
        (ln.physicalCoilId ? coilById.get(String(ln.physicalCoilId)) || coilByCoilId.get(String(ln.physicalCoilId)) : undefined) ||
        (ln.lotNumber ? coilByPackNumber.get(String(ln.lotNumber).trim()) : undefined) ||
        null;

      const ownershipNorm = normalizeOwnership(ln.ownership, doc.ownership);
      if (ownershipNorm.wasNonCanonical) {
        conflicts.push({
          code: 'NON_CANONICAL_OWNERSHIP',
          severity: 'WARNING',
          entity: 'InventoryDocumentLine',
          reference: `${docNumber}#${lineNumber}`,
          message: `Normalized non-canonical ownership "${String(ln.ownership || doc.ownership)}" to "${ownershipNorm.value}".`,
        });
      }

      const rawQty = toDecimal(ln.quantity ?? 0);
      const rawKg = toDecimal(ln.quantityKg ?? ln.weightKg ?? 0);
      if (!shouldEmitLedgerMovements && (rawQty.lt(DECIMAL_ZERO) || rawKg.lt(DECIMAL_ZERO))) {
        conflicts.push({
          code: 'UNPOSTED_DRAFT_NEGATIVE_QUANTITY',
          severity: 'WARNING',
          entity: 'InventoryDocumentLine',
          reference: `${docNumber}#${lineNumber}`,
          message: `Unposted ${documentStatus} document "${docNumber}" line ${lineNumber} has negative quantity (${rawQty.toString()}). Preserved as UNPOSTED document line with 0 InventoryTransaction and 0 StockBalance impact.`,
        });
      }

      const lineKey = `${dbDoc.id}::${lineNumber}`;
      let dbLineId = `SIM-LINE-${dbDoc.id}-${lineNumber}`;
      if (!docLineKeys.has(lineKey)) {
        docLineInserts += 1;
        docLineKeys.add(lineKey);
        if (isApply) {
          const createdLine = await db.inventoryDocumentLine.create({
            data: {
              documentId: dbDoc.id,
              lineNumber,
              partId: part.id,
              materialLotId: lot?.id ?? null,
              physicalCoilId: coil?.id ?? null,
              locationId: location?.id ?? null,
              targetLocationId: targetLocation?.id ?? null,
              quantity: decimalAbs(rawQty),
              unitId: unit.id,
              weightKg: decimalAbs(rawKg),
              ownership: ownershipNorm.value,
              contractId: ln.contractId || doc.contractId || null,
              contractNumber: ln.contractNumber || doc.contractNumber || null,
              qualityStatus: String(ln.qualityStatus || 'AVAILABLE'),
              unitCost: ln.unitCost != null ? toDecimal(ln.unitCost) : null,
              notes: ln.notes ? String(ln.notes) : null,
            },
          });
          dbLineId = createdLine.id;
        }
      } else {
        docLineSkips += 1;
      }

      if (!shouldEmitLedgerMovements) continue;

      const movementTime = postedAt || docDate;
      const emitMovement = async (m: {
        suffix: string;
        warehouseId: string;
        warehouseCode: string;
        locationId: string | null;
        locationCode: string | null;
        qualityStatus: string;
        transactionType: TransactionType;
        signedQty: Prisma.Decimal;
        signedKg: Prisma.Decimal;
        isReversal: boolean;
        reversalOfTrxId: string | null;
      }) => {
        plannedTxTotal += 1;
        const trxNumber = `${docNumber}-L${String(lineNumber).padStart(3, '0')}-${m.suffix}`;
        const movementSig = `${dbLineId}::${m.warehouseId}::${m.qualityStatus}::${m.transactionType}`;
        if (txByNumber.has(trxNumber) || existingTxMovementKeys.has(movementSig)) {
          txSkips += 1;
          return;
        }
        const resolvedContract = resolveContractForMovement({
          explicitContractId: ln.contractId || doc.contractId || null,
          explicitContractNumber: ln.contractNumber || doc.contractNumber || null,
          partId: part.id,
          warehouseId: m.warehouseId,
          locationId: m.locationId,
          materialLotId: lot?.id ?? null,
          physicalCoilId: coil?.id ?? null,
          ownership: ownershipNorm.value,
          qualityStatus: m.qualityStatus,
          docNumber,
        });

        const bucket = getOrCreateBucket({
          partId: part.id,
          partNumber: part.partNumber,
          warehouseId: m.warehouseId,
          warehouseCode: m.warehouseCode,
          locationId: m.locationId,
          locationCode: m.locationCode,
          materialLotId: lot?.id ?? null,
          lotNumber: lot?.lotNumber ?? null,
          physicalCoilId: coil?.id ?? null,
          coilId: coil?.coilId ?? null,
          ownership: ownershipNorm.value,
          contractId: resolvedContract.contractId,
          contractNumber: resolvedContract.contractNumber,
          qualityStatus: m.qualityStatus,
        });

        const nextQty = decimalAdd(bucket.quantityOnHand, m.signedQty);
        const nextKg = decimalAdd(bucket.weightKgOnHand, m.signedKg);
        if (nextQty.lt(DECIMAL_EPSILON.neg()) || nextKg.lt(DECIMAL_EPSILON.neg())) {
          throw new Error(
            `Negative StockBalance violation while replaying "${trxNumber}" for part "${part.partNumber}" in "${m.warehouseCode}" (${m.qualityStatus}): resulting qty=${nextQty.toString()}, kg=${nextKg.toString()}.`,
          );
        }

        bucket.quantityOnHand = nextQty.abs().lt(DECIMAL_EPSILON) ? DECIMAL_ZERO : nextQty;
        bucket.weightKgOnHand = nextKg.abs().lt(DECIMAL_EPSILON) ? DECIMAL_ZERO : nextKg;
        if (!bucket.lastTransactionAt || movementTime.getTime() >= bucket.lastTransactionAt.getTime()) {
          bucket.lastTransactionAt = movementTime;
        }
        recomputeAvailable(bucket);
        modifiedBalanceKeys.add(bucket.key);

        txInserts += 1;
        const createdTx = isApply
          ? await db.inventoryTransaction.create({
              data: {
                transactionNumber: trxNumber,
                documentId: dbDoc.id,
                documentLineId: dbLineId,
                partId: part.id,
                materialLotId: lot?.id ?? null,
                physicalCoilId: coil?.id ?? null,
                warehouseId: m.warehouseId,
                locationId: m.locationId,
                transactionType: m.transactionType,
                quantity: decimalAbs(m.signedQty),
                quantitySigned: m.signedQty,
                unitId: unit.id,
                weightKg: decimalAbs(m.signedKg),
                weightKgSigned: m.signedKg,
                ownership: ownershipNorm.value,
                contractId: resolvedContract.contractId,
                contractNumber: resolvedContract.contractNumber,
                qualityStatus: m.qualityStatus,
                balanceAfter: bucket.quantityOnHand,
                balanceKgAfter: bucket.weightKgOnHand,
                transactionDate: movementTime,
                postingStatus: PostingStatus.POSTED,
                isReversal: m.isReversal,
                reversalOfTrxId: m.reversalOfTrxId,
                createdByUserId: postedByUserId || createdByUserId,
              },
            })
          : { id: `SIM-TRX-${trxNumber}`, transactionNumber: trxNumber };

        txByNumber.set(trxNumber, createdTx as any);
        if (!firstTxIdByDocLine.has(`${docNumber}::${lineNumber}`)) {
          firstTxIdByDocLine.set(`${docNumber}::${lineNumber}`, createdTx.id);
        }
      };

      const absQty = decimalAbs(rawQty);
      const absKg = decimalAbs(rawKg);

      if (rawDocType === 'TRANSFER') {
        if (!targetWarehouse) throw new Error(`Target warehouse missing on TRANSFER document "${docNumber}".`);
        const qs = String(ln.qualityStatus || 'AVAILABLE');
        await emitMovement({
          suffix: 'OUT',
          warehouseId: warehouse.id,
          warehouseCode: warehouse.code,
          locationId: location?.id ?? null,
          locationCode: location?.code ?? null,
          qualityStatus: qs,
          transactionType: TransactionType.TRANSFER_OUT,
          signedQty: absQty.neg(),
          signedKg: absKg.neg(),
          isReversal: false,
          reversalOfTrxId: null,
        });
        await emitMovement({
          suffix: 'IN',
          warehouseId: targetWarehouse.id,
          warehouseCode: targetWarehouse.code,
          locationId: targetLocation?.id ?? null,
          locationCode: targetLocation?.code ?? null,
          qualityStatus: qs,
          transactionType: TransactionType.TRANSFER_IN,
          signedQty: absQty,
          signedKg: absKg,
          isReversal: false,
          reversalOfTrxId: null,
        });
      } else if (rawDocType === 'STOCK_STATUS_TRANSFER') {
        // SAP QM status reclassification: strictly conserves physical stock (OUT from source status, IN to target status)
        const mvt = String(ln.movementType || doc.movementType || '321').trim();
        const fromStatus = mvt === '322' || mvt === '344' ? 'AVAILABLE' : 'QUARANTINE';
        const toStatus = mvt === '322' ? 'QUARANTINE' : mvt === '344' ? 'QUALITY_BLOCKED' : 'AVAILABLE';
        await emitMovement({
          suffix: `QM${mvt}-OUT`,
          warehouseId: warehouse.id,
          warehouseCode: warehouse.code,
          locationId: location?.id ?? null,
          locationCode: location?.code ?? null,
          qualityStatus: fromStatus,
          transactionType: TransactionType.ADJUSTMENT_NEG,
          signedQty: absQty.neg(),
          signedKg: absKg.neg(),
          isReversal: false,
          reversalOfTrxId: null,
        });
        await emitMovement({
          suffix: `QM${mvt}-IN`,
          warehouseId: warehouse.id,
          warehouseCode: warehouse.code,
          locationId: location?.id ?? null,
          locationCode: location?.code ?? null,
          qualityStatus: toStatus,
          transactionType: TransactionType.ADJUSTMENT_POS,
          signedQty: absQty,
          signedKg: absKg,
          isReversal: false,
          reversalOfTrxId: null,
        });
      } else if (
        rawDocType === 'OPENING_BALANCE' ||
        rawDocType === 'INITIAL_BALANCE' ||
        rawDocType === 'RECEIPT_RAW_MATERIAL' ||
        rawDocType === 'RECEIPT_FINISHED_GOODS' ||
        rawDocType === 'RECEIPT_WIP' ||
        rawDocType === 'RECEIPT' ||
        rawDocType === 'RETURN' ||
        rawDocType === 'RETURN_FROM_PRODUCTION'
      ) {
        await emitMovement({
          suffix: 'POST',
          warehouseId: warehouse.id,
          warehouseCode: warehouse.code,
          locationId: location?.id ?? null,
          locationCode: location?.code ?? null,
          qualityStatus: String(ln.qualityStatus || 'AVAILABLE'),
          transactionType: TransactionType.INBOUND,
          signedQty: absQty,
          signedKg: absKg,
          isReversal: false,
          reversalOfTrxId: null,
        });
      } else if (
        rawDocType === 'ISSUE_RAW_MATERIAL' ||
        rawDocType === 'ISSUE_FINISHED_GOODS' ||
        rawDocType === 'ISSUE_TO_PRODUCTION' ||
        rawDocType === 'ISSUE_TO_WIP' ||
        rawDocType === 'ISSUE' ||
        rawDocType === 'SCRAP' ||
        rawDocType === 'SCRAP_WRITE_OFF' ||
        rawDocType === 'DELIVERY_CUSTOMER' ||
        rawDocType === 'SHIPMENT_CUSTOMER'
      ) {
        await emitMovement({
          suffix: 'POST',
          warehouseId: warehouse.id,
          warehouseCode: warehouse.code,
          locationId: location?.id ?? null,
          locationCode: location?.code ?? null,
          qualityStatus: String(ln.qualityStatus || 'AVAILABLE'),
          transactionType: TransactionType.OUTBOUND,
          signedQty: absQty.neg(),
          signedKg: absKg.neg(),
          isReversal: false,
          reversalOfTrxId: null,
        });
      } else if (rawDocType === 'REVERSAL') {
        const origDocNo = doc.referenceNumber ? String(doc.referenceNumber) : '';
        const origTrxId = origDocNo ? (firstTxIdByDocLine.get(`${origDocNo}::${lineNumber}`) ?? null) : null;
        const isPos = rawQty.gte(DECIMAL_ZERO) && rawKg.gte(DECIMAL_ZERO);
        await emitMovement({
          suffix: 'REV',
          warehouseId: warehouse.id,
          warehouseCode: warehouse.code,
          locationId: location?.id ?? null,
          locationCode: location?.code ?? null,
          qualityStatus: String(ln.qualityStatus || 'AVAILABLE'),
          transactionType: isPos ? TransactionType.ADJUSTMENT_POS : TransactionType.ADJUSTMENT_NEG,
          signedQty: isPos ? absQty : absQty.neg(),
          signedKg: isPos ? absKg : absKg.neg(),
          isReversal: true,
          reversalOfTrxId: origTrxId,
        });
      } else {
        const isPos = rawQty.gte(DECIMAL_ZERO) && rawKg.gte(DECIMAL_ZERO);
        await emitMovement({
          suffix: 'ADJ',
          warehouseId: warehouse.id,
          warehouseCode: warehouse.code,
          locationId: location?.id ?? null,
          locationCode: location?.code ?? null,
          qualityStatus: String(ln.qualityStatus || 'AVAILABLE'),
          transactionType: isPos ? TransactionType.ADJUSTMENT_POS : TransactionType.ADJUSTMENT_NEG,
          signedQty: isPos ? absQty : absQty.neg(),
          signedKg: isPos ? absKg : absKg.neg(),
          isReversal: false,
          reversalOfTrxId: null,
        });
      }
    }
  }

  // Record legacy snapshot `transactions` anti-double-counting audit
  const legacyTxs: any[] = Array.isArray(inv.transactions) ? inv.transactions : [];
  if (legacyTxs.length > 0) {
    const uniqueLegacyIds = new Set(legacyTxs.map((t) => String(t.id || '')));
    conflicts.push({
      code: 'LEGACY_TRANSACTIONS_DEDUPLICATED_AND_SKIPPED',
      severity: 'INFO',
      entity: 'InventoryTransaction',
      reference: 'inventory.transactions',
      message: `Skipped ${legacyTxs.length} legacy snapshot transactions (${uniqueLegacyIds.size} unique IDs repeated ${Math.round(legacyTxs.length / Math.max(1, uniqueLegacyIds.size))}x) because their opening/receipt stock is already posted via official InventoryDocuments; prevents multi-counting.`,
      details: { totalEntries: legacyTxs.length, uniqueIds: uniqueLegacyIds.size },
    });
  }

  recordStat({
    entity: 'InventoryDocument',
    targetTable: 'inventory_documents',
    sourceCount: snapshotDocs.length,
    existingCount: existingDocs.length,
    plannedInserts: docInserts,
    plannedUpdates: 0,
    plannedSkips: docSkips,
  });
  recordStat({
    entity: 'InventoryDocumentLine',
    targetTable: 'inventory_document_lines',
    sourceCount: sourceDocLineCount,
    existingCount: existingDocLines.length,
    plannedInserts: docLineInserts,
    plannedUpdates: 0,
    plannedSkips: docLineSkips,
  });
  recordStat({
    entity: 'InventoryTransaction',
    targetTable: 'inventory_transactions',
    sourceCount: plannedTxTotal,
    existingCount: existingTransactions.length,
    plannedInserts: txInserts,
    plannedUpdates: 0,
    plannedSkips: txSkips,
    notes: 'Derived strictly from POSTED/REVERSED InventoryDocuments (legacy duplicated transactions[] excluded).',
  });

  // =========================================================================
  // 18. INVENTORY RESERVATIONS (and reserved qty/weight on StockBalance)
  // =========================================================================
  let resInserts = 0;
  let resSkips = 0;
  for (const res of snapshotReservations) {
    const resNum = String(res.reservationNumber || res.id).trim();
    if (reservationByNumber.has(resNum)) {
      resSkips += 1;
      continue;
    }
    const part = resolvePart(res.partCode, res.partId, 'InventoryReservation', resNum);
    const wh = warehouseById.get(String(res.warehouseId || '')) || warehouseByCode.get(String(res.warehouseId || '').toUpperCase());
    if (!wh) throw new Error(`Warehouse "${res.warehouseId}" missing for InventoryReservation "${resNum}".`);
    const lot = res.lotNumber ? lotByNumber.get(String(res.lotNumber).trim()) : null;
    const status = mapReservationStatus(res.status);
    const qty = toDecimal(res.quantity ?? 0);
    const kg = toDecimal(res.quantityKg ?? res.weightKg ?? 0);
    const validUntil = res.validUntil ? parseDate(res.validUntil) : null;
    if (status === ReservationStatus.ACTIVE && validUntil && validUntil.getTime() < Date.now()) {
      conflicts.push({
        code: 'ACTIVE_RESERVATION_PAST_VALID_UNTIL',
        severity: 'WARNING',
        entity: 'InventoryReservation',
        reference: resNum,
        message: `Reservation "${resNum}" has status=ACTIVE with validUntil=${validUntil.toISOString()} in the past. Preserved exact status ACTIVE without silently expiring it.`,
      });
    }

    resInserts += 1;
    if (isApply) {
      await db.inventoryReservation.create({
        data: {
          id: res.id ? String(res.id) : undefined,
          reservationNumber: resNum,
          partId: part.id,
          warehouseId: wh.id,
          materialLotId: lot?.id ?? null,
          quantity: qty,
          weightKg: kg,
          status,
          validUntil,
          createdByUserId: resolveActorUserId(res.createdByUid),
        },
      });
    }

    if (status === ReservationStatus.ACTIVE) {
      let remQty = qty;
      let remKg = kg;
      const resOwnership = res.ownership ? normalizeOwnership(res.ownership).value : null;
      const resCoil = res.physicalCoilId
        ? coilById.get(String(res.physicalCoilId)) || coilByCoilId.get(String(res.physicalCoilId))
        : null;
      const matchingBuckets = [...balanceBuckets.values()]
        .filter(
          (b) =>
            b.partId === part.id &&
            b.warehouseId === wh.id &&
            b.qualityStatus === 'AVAILABLE' &&
            (!lot || b.materialLotId === lot.id) &&
            (!resOwnership || b.ownership === resOwnership) &&
            (!resCoil || b.physicalCoilId === resCoil.id),
        )
        .sort((a, b) => a.key.localeCompare(b.key));
      for (const b of matchingBuckets) {
        if (remQty.lte(DECIMAL_ZERO) && remKg.lte(DECIMAL_ZERO)) break;
        const allocQty = Prisma.Decimal.min(remQty, b.quantityAvailable);
        const allocKg = Prisma.Decimal.min(remKg, b.weightKgAvailable);
        if (allocQty.gt(DECIMAL_ZERO) || allocKg.gt(DECIMAL_ZERO)) {
          b.quantityReserved = decimalAdd(b.quantityReserved, allocQty);
          b.weightKgReserved = decimalAdd(b.weightKgReserved, allocKg);
          recomputeAvailable(b);
          modifiedBalanceKeys.add(b.key);
          remQty = decimalSub(remQty, allocQty);
          remKg = decimalSub(remKg, allocKg);
        }
      }
      if (remQty.gt(DECIMAL_EPSILON) || remKg.gt(DECIMAL_EPSILON)) {
        conflicts.push({
          code: 'RESERVATION_EXCEEDS_AVAILABLE_STOCK',
          severity: 'CONFLICT',
          entity: 'InventoryReservation',
          reference: resNum,
          message: `Active reservation "${resNum}" could not be fully covered by available stock (uncovered qty=${remQty.toString()}, kg=${remKg.toString()}).`,
        });
      }
    }
  }
  recordStat({
    entity: 'InventoryReservation',
    targetTable: 'inventory_reservations',
    sourceCount: snapshotReservations.length,
    existingCount: existingReservations.length,
    plannedInserts: resInserts,
    plannedUpdates: 0,
    plannedSkips: resSkips,
  });

  // Persist / count StockBalance rows (using findFirst matching nullable composite columns!)
  let balanceInserts = 0;
  let balanceUpdates = 0;
  let balanceSkips = 0;
  for (const bucket of balanceBuckets.values()) {
    const isModified = modifiedBalanceKeys.has(bucket.key);
    const existingId = existingBalanceDbIds.get(bucket.key);
    if (!isModified) {
      balanceSkips += 1;
      continue;
    }
    if (existingId) {
      balanceUpdates += 1;
      if (isApply) {
        await db.stockBalance.update({
          where: { id: existingId },
          data: {
            quantityOnHand: bucket.quantityOnHand,
            quantityReserved: bucket.quantityReserved,
            quantityAvailable: bucket.quantityAvailable,
            weightKgOnHand: bucket.weightKgOnHand,
            weightKgReserved: bucket.weightKgReserved,
            weightKgAvailable: bucket.weightKgAvailable,
            lastTransactionAt: bucket.lastTransactionAt,
          },
        });
      }
    } else {
      balanceInserts += 1;
      if (isApply) {
        const created = await db.stockBalance.create({
          data: {
            partId: bucket.partId,
            warehouseId: bucket.warehouseId,
            locationId: bucket.locationId,
            materialLotId: bucket.materialLotId,
            physicalCoilId: bucket.physicalCoilId,
            quantityOnHand: bucket.quantityOnHand,
            quantityReserved: bucket.quantityReserved,
            quantityAvailable: bucket.quantityAvailable,
            weightKgOnHand: bucket.weightKgOnHand,
            weightKgReserved: bucket.weightKgReserved,
            weightKgAvailable: bucket.weightKgAvailable,
            ownership: bucket.ownership,
            contractId: bucket.contractId,
            contractNumber: bucket.contractNumber,
            qualityStatus: bucket.qualityStatus,
            lastTransactionAt: bucket.lastTransactionAt,
          },
        });
        existingBalanceDbIds.set(bucket.key, created.id);
      }
    }
  }
  recordStat({
    entity: 'StockBalance',
    targetTable: 'stock_balances',
    sourceCount: balanceBuckets.size,
    existingCount: existingBalances.length,
    plannedInserts: balanceInserts,
    plannedUpdates: balanceUpdates,
    plannedSkips: balanceSkips,
    notes: 'Derived deterministically from posted/reversed InventoryDocuments and active InventoryReservations.',
  });

  // =========================================================================
  // 19. PHYSICAL COIL RECONCILIATION (zero double-counting + Decimal cleanup)
  // =========================================================================
  const coilReconciliation: CoilReconciliationSummary[] = [];
  for (const c of snapshotCoils) {
    const coilId = String(c.coilId || c.id).trim();
    const dbCoil = coilByCoilId.get(coilId);
    if (!dbCoil) continue;

    const existingRel = existingCoils.find((ec) => ec.coilId === coilId);
    const normInfo = coilFloatArtifacts.get(coilId) || normalizeFloatArtifact(c.remainingWeightKg ?? 0);

    // Sum derived StockBalance weightKgOnHand linked to this physicalCoilId
    const coilBuckets = [...balanceBuckets.values()].filter((b) => b.physicalCoilId === dbCoil.id);
    const derivedLedgerKg =
      coilBuckets.length > 0
        ? coilBuckets.reduce((acc, b) => decimalAdd(acc, b.weightKgOnHand), DECIMAL_ZERO)
        : null;

    const existingRelKg = existingRel ? toDecimal(existingRel.remainingWeightKg) : null;
    const targetRemainingKg =
      reconcileCoilWeights && derivedLedgerKg !== null ? derivedLedgerKg : normInfo.normalized;
    const driftKg = existingRelKg !== null ? decimalSub(targetRemainingKg, existingRelKg) : DECIMAL_ZERO;

    if (derivedLedgerKg !== null && !decimalEq(normInfo.normalized, derivedLedgerKg)) {
      conflicts.push({
        code: 'COIL_WEIGHT_LEDGER_DRIFT',
        severity: 'CONFLICT',
        entity: 'PhysicalCoil',
        reference: coilId,
        message: `PhysicalCoil "${coilId}" snapshot remainingWeightKg=${normInfo.raw.toString()} kg disagrees with posted InventoryDocument ledger balance=${derivedLedgerKg.toString()} kg (delta=${decimalSub(derivedLedgerKg, normInfo.normalized).toString()} kg). ${reconcileCoilWeights ? 'Planned to reconcile PhysicalCoil.remainingWeightKg and MaterialLot.remainingWeightKg to exact Decimal ledger balance.' : 'Left unchanged (reconcileCoilWeights=false).'}`,
        details: {
          snapshotRawKg: normInfo.raw.toString(),
          snapshotCleanKg: normInfo.normalized.toString(),
          derivedLedgerKg: derivedLedgerKg.toString(),
          deltaKg: decimalSub(derivedLedgerKg, normInfo.normalized).toString(),
        },
      });
    }

    const lot = lotByNumber.get(dbCoil.coilPackNumber);
    const needsRelUpdate =
      Boolean(existingRel) &&
      (!decimalEq(toDecimal(existingRel!.remainingWeightKg), targetRemainingKg) ||
        (lot && !existingRel!.materialLotId) ||
        (lot?.warehouseLocationId && !existingRel!.warehouseLocationId));

    if (existingRel) {
      if (needsRelUpdate) {
        coilUpdates += 1;
        if (isApply) {
          await db.physicalCoil.update({
            where: { id: existingRel.id },
            data: {
              remainingWeightKg: targetRemainingKg,
              ...(lot && !existingRel.materialLotId ? { materialLotId: lot.id } : {}),
              ...(lot?.warehouseLocationId && !existingRel.warehouseLocationId
                ? { warehouseLocationId: lot.warehouseLocationId }
                : {}),
            },
          });
          dbCoil.remainingWeightKg = targetRemainingKg;
          if (lot && !dbCoil.materialLotId) dbCoil.materialLotId = lot.id;
          if (lot?.warehouseLocationId && !dbCoil.warehouseLocationId) {
            dbCoil.warehouseLocationId = lot.warehouseLocationId;
          }
        }
      } else {
        coilSkips += 1;
      }
    }

    coilReconciliation.push({
      coilId,
      coilPackNumber: dbCoil.coilPackNumber,
      originalWeightKg: formatDecimal(toDecimal(dbCoil.originalWeightKg)),
      existingRelationalRemainingKg: existingRelKg ? existingRelKg.toString() : null,
      snapshotRemainingKg: normInfo.raw.toString(),
      derivedLedgerRemainingKg: derivedLedgerKg ? formatDecimal(derivedLedgerKg) : null,
      reconciledTargetRemainingKg: formatDecimal(targetRemainingKg),
      hadFloatArtifact: normInfo.hadFloatArtifact,
      driftKg: formatDecimal(driftKg),
      contractAllocatedKg: formatDecimal(totalByCoil.get(dbCoil.id) ?? DECIMAL_ZERO),
    });
  }

  // Reconcile MaterialLot.remainingWeightKg once against derived StockBalance (only when changed)
  for (const lot of lotByNumber.values()) {
    const lotBuckets = [...balanceBuckets.values()].filter((b) => b.materialLotId === lot.id);
    if (lotBuckets.length === 0) continue;
    const sumKg = lotBuckets.reduce((acc, b) => decimalAdd(acc, b.weightKgOnHand), DECIMAL_ZERO);
    const currentLotKg = toDecimal(lot.remainingWeightKg);
    if (decimalEq(currentLotKg, sumKg)) continue;

    if (preExistingLotIds.has(lot.id)) {
      lotStat.plannedUpdates += 1;
      if (lotStat.plannedSkips > 0) lotStat.plannedSkips -= 1;
    }
    if (isApply) {
      await db.materialLot.update({
        where: { id: lot.id },
        data: { remainingWeightKg: sumKg },
      });
    }
    lot.remainingWeightKg = sumKg;
  }

  recordStat({
    entity: 'PhysicalCoil',
    targetTable: 'physical_coils',
    sourceCount: snapshotCoils.length,
    existingCount: existingCoils.length,
    plannedInserts: coilInserts,
    plannedUpdates: coilUpdates,
    plannedSkips: coilSkips,
    notes: 'Existing coils preserved; links materialLotId/location and normalizes Decimal weight to ledger balance.',
  });

  // =========================================================================
  // 20. AUDIT LOGS
  // =========================================================================
  let auditInserts = 0;
  let auditSkips = 0;
  for (const log of snapshotAuditLogs) {
    const id = String(log.id || '').trim();
    if (!id) continue;
    if (auditLogById.has(id)) {
      auditSkips += 1;
      continue;
    }
    const actorUid = log.user?.uid ? String(log.user.uid).trim() : null;
    const userId = actorUid ? resolveActorUserId(actorUid) : null;
    auditInserts += 1;
    if (isApply) {
      await db.auditLog.create({
        data: {
          id,
          userId,
          action: String(log.action || 'SNAPSHOT_EVENT'),
          entityName: String(log.entityName || 'System'),
          entityId: String(log.entityId || 'UNKNOWN'),
          newValues: {
            details: log.details ?? null,
            legacyActorUid: actorUid,
            legacyActorName: log.user?.displayName ?? null,
          } as Prisma.InputJsonValue,
          timestamp: parseDate(log.timestamp),
        },
      });
    }
    auditLogById.set(id, { id } as any);
  }
  recordStat({
    entity: 'AuditLog',
    targetTable: 'audit_logs',
    sourceCount: snapshotAuditLogs.length,
    existingCount: existingAuditLogs.length,
    plannedInserts: auditInserts,
    plannedUpdates: 0,
    plannedSkips: auditSkips,
  });

  // =========================================================================
  // 21. UNSUPPORTED SNAPSHOT KEYS INVENTORY (Explicit — zero silent drops)
  // =========================================================================
  const unsupportedEntities: UnsupportedSnapshotEntity[] = [];
  for (const [key, reason] of Object.entries(UNSUPPORTED_SNAPSHOT_REASONS)) {
    const val = inv[key];
    if (val === undefined) continue;
    const count = Array.isArray(val) ? val.length : val && typeof val === 'object' ? Object.keys(val).length : 1;
    unsupportedEntities.push({ snapshotKey: key, sourceCount: count, reason });
  }
  // Detect any unexpected/unmapped top-level snapshot keys so nothing is ever silently discarded
  const mappedInventoryKeys = new Set([
    'units',
    'materialGrades',
    'warehouses',
    'customers',
    'shifts',
    'parts',
    'operations',
    'machines',
    'dies',
    'routings',
    'contracts',
    'physicalCoils',
    'customerOrders',
    'fallbackPlanProposals',
    'plans',
    'inventoryDocuments',
    'reservations',
    'auditLogs',
    ...Object.keys(UNSUPPORTED_SNAPSHOT_REASONS),
  ]);
  for (const key of Object.keys(inv)) {
    if (!mappedInventoryKeys.has(key)) {
      const val = inv[key];
      const count = Array.isArray(val) ? val.length : val && typeof val === 'object' ? Object.keys(val).length : 1;
      unsupportedEntities.push({
        snapshotKey: key,
        sourceCount: count,
        reason: 'Unmapped snapshot key detected at runtime; preserved in JSONB snapshot and excluded from relational backfill.',
      });
    }
  }

  const derivedStockBalances: DerivedBalanceSummary[] = [...balanceBuckets.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((b) => ({
      partNumber: b.partNumber,
      warehouseCode: b.warehouseCode,
      locationCode: b.locationCode,
      lotNumber: b.lotNumber,
      coilId: b.coilId,
      ownership: b.ownership,
      contractNumber: b.contractNumber,
      qualityStatus: b.qualityStatus,
      quantityOnHand: formatDecimal(b.quantityOnHand),
      quantityReserved: formatDecimal(b.quantityReserved),
      quantityAvailable: formatDecimal(b.quantityAvailable),
      weightKgOnHand: formatDecimal(b.weightKgOnHand),
      weightKgReserved: formatDecimal(b.weightKgReserved),
      weightKgAvailable: formatDecimal(b.weightKgAvailable),
    }));

  const totalPlannedInserts = entityStats.reduce((s, e) => s + e.plannedInserts, 0);
  const totalPlannedUpdates = entityStats.reduce((s, e) => s + e.plannedUpdates, 0);
  const totalPlannedSkips = entityStats.reduce((s, e) => s + e.plannedSkips, 0);

  return {
    mode,
    applied: isApply,
    executedAt: new Date().toISOString(),
    snapshotMeta: {
      inventorySnapshotId: bundle.inventorySnapshotId || 'inventory-app-state',
      inventoryUpdatedAt: bundle.inventoryUpdatedAt ? new Date(bundle.inventoryUpdatedAt).toISOString() : null,
      wipSnapshotId: bundle.wipSnapshotId || 'production-wip-state',
      wipVersion: bundle.wipVersion ?? null,
      wipUpdatedAt: bundle.wipUpdatedAt ? new Date(bundle.wipUpdatedAt).toISOString() : null,
    },
    entities: entityStats,
    unsupportedEntities,
    derivedStockBalances,
    coilReconciliation,
    contractAllocationChecks,
    wipReconciliation,
    conflicts,
    preservedRelationalOnlyParts,
    summary: {
      totalPlannedInserts,
      totalPlannedUpdates,
      totalPlannedSkips,
      conflictCount: conflicts.filter((c) => c.severity === 'CONFLICT').length,
      warningCount: conflicts.filter((c) => c.severity === 'WARNING').length,
    },
  };
}
