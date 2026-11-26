import crypto from 'crypto';
import {
  DetailedStockBalance,
  InventoryDocument,
  Part,
  PhysicalCoil,
  StockOwnership,
  StockQualityStatus,
  UnitOfMeasure,
  WarehouseDefinition,
} from '../types/inventory';
import {
  DefectCodeDefinition,
  InspectionChecklistItem,
  NcrDispositionAction,
  NcrSourceType,
  NonconformanceCategory,
  NonconformanceRecord,
  NonconformanceSeverity,
  QualityDashboardAnalytics,
  QualityDecision,
  QualityDefectParetoRow,
  QualityEntityHistoryResponse,
  QualityHistoryEvent,
  QualityInspectionRecord,
  QualityInspectionType,
  QualitySupplierPerformanceRow,
  ReworkOrderRecord,
} from '../types/quality';
import {
  QualityTxAbortError,
  __setQualityPrismaForTests,
  dbFindInspectionByIdOrNumber,
  dbFindNcrByIdOrNumber,
  dbFindReworkByIdOrNumber,
  dbListNonconformances,
  dbListQualityInspections,
  dbListReworkOrders,
  dbLoadAllQualityRecords,
  isQualityPostgresPersistenceActive,
  mapDbInspectionToDto,
  mapDbNcrToDto,
  mapDbReworkToDto,
  recordQualityAuditInTx,
  resolveInventoryDocIdInTx,
  resolveQualityForeignKeysInTx,
  runQualityTransaction,
  saveDbQualityIdempotencyInTx,
  syncLinkedEntityQualityStatusInTx,
} from './relationalQualityService';

export { __setQualityPrismaForTests, isQualityPostgresPersistenceActive };

const EPS = 0.001;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const round2 = (n: number): number => Math.round(n * 100) / 100;

export const QUALITY_DEFECT_CATALOG: DefectCodeDefinition[] = [
  { code: 'DEF-CRACK', labelFa: 'ترک یا پارگی کشش (Drawing Crack)', category: 'BURR_CRACK', defaultSeverity: 'CRITICAL' },
  { code: 'DEF-WRINKLE', labelFa: 'چروکیدگی سطح ورق (Wrinkling)', category: 'SURFACE_DEFECT', defaultSeverity: 'MAJOR' },
  { code: 'DEF-BURR', labelFa: 'پلیسه لبه خارج از تلرانس (Excessive Burr)', category: 'BURR_CRACK', defaultSeverity: 'MAJOR' },
  { code: 'DEF-DIM', labelFa: 'خروج از تلرانس ابعادی CMM / فیکسچر', category: 'DIMENSIONAL', defaultSeverity: 'CRITICAL' },
  { code: 'DEF-SCRATCH', labelFa: 'خط و خش، زنگ‌زدگی یا فرورفتگی سطح', category: 'SURFACE_DEFECT', defaultSeverity: 'MINOR' },
  { code: 'DEF-THICK', labelFa: 'عدم انطباق ضخامت، عرض یا گرید ورق', category: 'MATERIAL_PROPERTY', defaultSeverity: 'CRITICAL' },
  { code: 'DEF-WELD', labelFa: 'عیب جوش نقطه‌ای / CO2 (نفوذ ناکافی یا پاشش)', category: 'WELDING', defaultSeverity: 'CRITICAL' },
  { code: 'DEF-COAT', labelFa: 'عیب پوشش رنگ کاتافورز (ED) یا شره', category: 'COATING_PAINT', defaultSeverity: 'MAJOR' },
  { code: 'DEF-RUBBER', labelFa: 'عیب قطعه لاستیکی یا اتصال پیچ و مهره', category: 'MATERIAL_PROPERTY', defaultSeverity: 'MAJOR' },
  { code: 'DEF-PACK', labelFa: 'عیب بسته‌بندی، لیبل یا ردیابی پالت ساپکو', category: 'PACKAGING_LABEL', defaultSeverity: 'MINOR' },
];

export const NCR_CATEGORY_LABELS_FA: Record<NonconformanceCategory, string> = {
  DIMENSIONAL: 'ابعادی و فیکسچر (CMM)',
  SURFACE_DEFECT: 'عیب سطحی و ظاهری',
  MATERIAL_PROPERTY: 'خواص ماده اولیه / ورق / لاستیک',
  WELDING: 'جوشکاری (نقطه‌ای / CO2)',
  COATING_PAINT: 'رنگ و پوشش کاتافورز',
  BURR_CRACK: 'ترک، پارگی و پلیسه',
  PACKAGING_LABEL: 'بسته‌بندی و برچسب ردیابی',
  OTHER: 'سایر موارد کیفی',
};

export const INSPECTION_TYPE_LABELS_FA: Record<QualityInspectionType, string> = {
  INCOMING_MATERIAL: 'بازرسی ورودی مواد و کلاف (IQC)',
  IN_PROCESS: 'بازرسی حین فرآیند تولید (IPQC)',
  FINAL_PRODUCT: 'بازرسی محصول نهایی پیش از ارسال (FQC)',
};

export function getDefaultChecklistTemplate(type: QualityInspectionType): InspectionChecklistItem[] {
  if (type === 'INCOMING_MATERIAL') {
    return [
      { id: 'CHK-IN-1', code: 'IN-CERT', labelFa: 'انطباق گواهی متالورژی (MTC)، گرید و شماره ذوب', standardSpec: 'DIN EN 10130 / SAPCO', passed: true },
      { id: 'CHK-IN-2', code: 'IN-THICK', labelFa: 'کنترل میکرومتری ضخامت و عرض ورق/قطعه', standardSpec: '±0.05 mm', passed: true },
      { id: 'CHK-IN-3', code: 'IN-SURF', labelFa: 'بازرسی چشمی سطح (عدم زنگ‌زدگی، روغن‌کاری و موج)', standardSpec: 'بدون خوردگی', passed: true },
      { id: 'CHK-IN-4', code: 'IN-TAG', labelFa: 'انطباق برچسب کویل‌پک / بچ و وزن باسکول', standardSpec: '±0.5% وزن', passed: true },
    ];
  }
  if (type === 'IN_PROCESS') {
    return [
      { id: 'CHK-IP-1', code: 'IP-FIRST', labelFa: 'تایید نمونه اول (First-Article) روی فیکسچر کنترلی', standardSpec: 'مطابق نقشه ایستگاه', passed: true },
      { id: 'CHK-IP-2', code: 'IP-CRACK', labelFa: 'کنترل عدم ترک کشش، چروکیدگی و پلیسه لبه', standardSpec: 'پلیسه ≤ 0.1 mm', passed: true },
      { id: 'CHK-IP-3', code: 'IP-WELD', labelFa: 'کنترل استحکام جوش / گشتاور پیچ و مهره (در صورت وجود)', standardSpec: 'تست کشش / تخریبی', passed: true },
    ];
  }
  return [
    { id: 'CHK-FN-1', code: 'FN-CMM', labelFa: 'اندازه‌برداری ابعادی نهایی (CMM / فیکسچر ساپکو)', standardSpec: 'Cpk ≥ 1.33', passed: true },
    { id: 'CHK-FN-2', code: 'FN-VIS', labelFa: 'بازرسی چشمی نهایی، پوشش رنگ و تمیزی سطح', standardSpec: 'بدون خط و خش', passed: true },
    { id: 'CHK-FN-3', code: 'FN-ASSY', labelFa: 'کنترل مونتاژ کامل پیچ، مهره و قطعات لاستیکی', standardSpec: '۱۰۰٪ تکمیل', passed: true },
    { id: 'CHK-FN-4', code: 'FN-PACK', labelFa: 'تایید پالت‌بندی، برچسب ردیابی و کارت سبز ترخیص', standardSpec: 'استاندارد ساپکو', passed: true },
  ];
}

// =========================================================================
// In-Memory State (Persisted via InventoryAppStateSnapshot + Local Disk)
// =========================================================================
let inspectionsStore: QualityInspectionRecord[] = [];
let ncrsStore: NonconformanceRecord[] = [];
let reworkOrdersStore: ReworkOrderRecord[] = [];
const qualityIdempotencyMap = new Map<string, { fingerprint: string; statusCode: number; response: any }>();

export function exportQualityStateSnapshot() {
  return {
    inspections: inspectionsStore,
    ncrs: ncrsStore,
    reworkOrders: reworkOrdersStore,
  };
}

export function hydrateQualityStateSnapshot(snapshot: any) {
  if (!snapshot || typeof snapshot !== 'object') return;
  if (Array.isArray(snapshot.inspections)) {
    inspectionsStore = snapshot.inspections;
  }
  if (Array.isArray(snapshot.ncrs)) {
    ncrsStore = snapshot.ncrs;
  }
  if (Array.isArray(snapshot.reworkOrders)) {
    reworkOrdersStore = snapshot.reworkOrders;
  }
}

export function resetQualityStateForTests() {
  inspectionsStore = [];
  ncrsStore = [];
  reworkOrdersStore = [];
  qualityIdempotencyMap.clear();
}

export interface QualityInspectionFilters {
  inspectionType?: string;
  status?: string;
  decision?: string;
  partId?: string;
  lotNumber?: string;
  coilId?: string;
  moNumber?: string;
  supplierName?: string;
  search?: string;
}

function filterQualityInspectionsList(
  source: QualityInspectionRecord[],
  filters?: QualityInspectionFilters
): QualityInspectionRecord[] {
  let rows = [...source];
  if (!filters) {
    return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  if (filters.inspectionType && filters.inspectionType !== 'ALL') {
    rows = rows.filter(r => r.inspectionType === filters.inspectionType);
  }
  if (filters.status && filters.status !== 'ALL') {
    rows = rows.filter(r => r.status === filters.status);
  }
  if (filters.decision && filters.decision !== 'ALL') {
    rows = rows.filter(r => r.decision === filters.decision);
  }
  if (filters.partId) {
    rows = rows.filter(r => r.partId === filters.partId || r.partCode === filters.partId);
  }
  if (filters.lotNumber) {
    const q = filters.lotNumber.toLowerCase();
    rows = rows.filter(r => (r.lotNumber || '').toLowerCase().includes(q));
  }
  if (filters.coilId) {
    const q = filters.coilId.toLowerCase();
    rows = rows.filter(
      r =>
        (r.physicalCoilId || '').toLowerCase() === q ||
        (r.coilId || '').toLowerCase().includes(q) ||
        (r.coilPackNumber || '').toLowerCase().includes(q)
    );
  }
  if (filters.moNumber) {
    const q = filters.moNumber.toLowerCase();
    rows = rows.filter(
      r =>
        (r.moNumber || '').toLowerCase().includes(q) ||
        (r.manufacturingOrderId || '').toLowerCase() === q
    );
  }
  if (filters.supplierName) {
    const q = filters.supplierName.toLowerCase();
    rows = rows.filter(r => (r.supplierName || '').toLowerCase().includes(q));
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    rows = rows.filter(
      r =>
        r.inspectionNumber.toLowerCase().includes(q) ||
        r.partCode.toLowerCase().includes(q) ||
        r.partName.toLowerCase().includes(q) ||
        (r.lotNumber || '').toLowerCase().includes(q) ||
        (r.coilId || '').toLowerCase().includes(q) ||
        (r.moNumber || '').toLowerCase().includes(q) ||
        (r.supplierName || '').toLowerCase().includes(q)
    );
  }
  return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function listQualityInspections(filters?: QualityInspectionFilters): QualityInspectionRecord[] {
  return filterQualityInspectionsList(inspectionsStore, filters);
}

export async function listQualityInspectionsAsync(
  filters?: QualityInspectionFilters
): Promise<QualityInspectionRecord[]> {
  if (isQualityPostgresPersistenceActive()) {
    const rows = await dbListQualityInspections();
    return filterQualityInspectionsList(rows, filters);
  }
  return filterQualityInspectionsList(inspectionsStore, filters);
}

export interface NonconformanceFilters {
  status?: string;
  severity?: string;
  category?: string;
  disposition?: string;
  partId?: string;
  lotNumber?: string;
  coilId?: string;
  moNumber?: string;
  supplierName?: string;
  search?: string;
}

function filterNonconformancesList(
  source: NonconformanceRecord[],
  filters?: NonconformanceFilters
): NonconformanceRecord[] {
  let rows = [...source];
  if (!filters) {
    return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  if (filters.status && filters.status !== 'ALL') {
    if (filters.status === 'ACTIVE') {
      rows = rows.filter(r => r.status !== 'CLOSED');
    } else {
      rows = rows.filter(r => r.status === filters.status);
    }
  }
  if (filters.severity && filters.severity !== 'ALL') {
    rows = rows.filter(r => r.severity === filters.severity);
  }
  if (filters.category && filters.category !== 'ALL') {
    rows = rows.filter(r => r.category === filters.category);
  }
  if (filters.disposition && filters.disposition !== 'ALL') {
    rows = rows.filter(r => r.disposition === filters.disposition);
  }
  if (filters.partId) {
    rows = rows.filter(r => r.partId === filters.partId || r.partCode === filters.partId);
  }
  if (filters.lotNumber) {
    const q = filters.lotNumber.toLowerCase();
    rows = rows.filter(r => (r.lotNumber || '').toLowerCase().includes(q));
  }
  if (filters.coilId) {
    const q = filters.coilId.toLowerCase();
    rows = rows.filter(
      r =>
        (r.physicalCoilId || '').toLowerCase() === q ||
        (r.coilId || '').toLowerCase().includes(q) ||
        (r.coilPackNumber || '').toLowerCase().includes(q)
    );
  }
  if (filters.moNumber) {
    const q = filters.moNumber.toLowerCase();
    rows = rows.filter(
      r =>
        (r.moNumber || '').toLowerCase().includes(q) ||
        (r.manufacturingOrderId || '').toLowerCase() === q
    );
  }
  if (filters.supplierName) {
    const q = filters.supplierName.toLowerCase();
    rows = rows.filter(r => (r.supplierName || '').toLowerCase().includes(q));
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    rows = rows.filter(
      r =>
        r.ncrNumber.toLowerCase().includes(q) ||
        r.title.toLowerCase().includes(q) ||
        r.partCode.toLowerCase().includes(q) ||
        r.partName.toLowerCase().includes(q) ||
        (r.lotNumber || '').toLowerCase().includes(q) ||
        (r.coilId || '').toLowerCase().includes(q) ||
        (r.moNumber || '').toLowerCase().includes(q)
    );
  }
  return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function listNonconformances(filters?: NonconformanceFilters): NonconformanceRecord[] {
  return filterNonconformancesList(ncrsStore, filters);
}

export async function listNonconformancesAsync(
  filters?: NonconformanceFilters
): Promise<NonconformanceRecord[]> {
  if (isQualityPostgresPersistenceActive()) {
    const rows = await dbListNonconformances();
    return filterNonconformancesList(rows, filters);
  }
  return filterNonconformancesList(ncrsStore, filters);
}

export interface ReworkOrderFilters {
  status?: string;
  ncrId?: string;
  moNumber?: string;
  partId?: string;
}

function filterReworkOrdersList(
  source: ReworkOrderRecord[],
  filters?: ReworkOrderFilters
): ReworkOrderRecord[] {
  let rows = [...source];
  if (!filters) {
    return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  if (filters.status && filters.status !== 'ALL') {
    rows = rows.filter(r => r.status === filters.status);
  }
  if (filters.ncrId) {
    rows = rows.filter(r => r.ncrId === filters.ncrId || r.ncrNumber === filters.ncrId);
  }
  if (filters.moNumber) {
    const q = filters.moNumber.toLowerCase();
    rows = rows.filter(
      r =>
        (r.moNumber || '').toLowerCase().includes(q) ||
        (r.manufacturingOrderId || '').toLowerCase() === q
    );
  }
  if (filters.partId) {
    rows = rows.filter(r => r.partId === filters.partId || r.partCode === filters.partId);
  }
  return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function listReworkOrders(filters?: ReworkOrderFilters): ReworkOrderRecord[] {
  return filterReworkOrdersList(reworkOrdersStore, filters);
}

export async function listReworkOrdersAsync(
  filters?: ReworkOrderFilters
): Promise<ReworkOrderRecord[]> {
  if (isQualityPostgresPersistenceActive()) {
    const rows = await dbListReworkOrders();
    return filterReworkOrdersList(rows, filters);
  }
  return filterReworkOrdersList(reworkOrdersStore, filters);
}

// =========================================================================
// Idempotency Helpers
// =========================================================================
function hashPayload(scope: string, payload: unknown): string {
  return crypto.createHash('sha256').update(`${scope}::${JSON.stringify(payload)}`).digest('hex');
}

export function checkQualityIdempotency(
  scope: string,
  idempotencyKey: string | undefined,
  fingerprintPayload: unknown
): { hit: false } | { hit: true; conflict: true; error: string } | { hit: true; conflict: false; response: any } {
  if (!idempotencyKey) return { hit: false };
  const mapKey = `${scope}:::${idempotencyKey}`;
  const prior = qualityIdempotencyMap.get(mapKey);
  if (!prior) return { hit: false };
  const fp = hashPayload(scope, fingerprintPayload);
  if (prior.fingerprint !== fp) {
    return {
      hit: true,
      conflict: true,
      error: `کلید یکتای درخواست کیفی (${idempotencyKey}) قبلاً با مقادیر متفاوتی ثبت شده است.`,
    };
  }
  return {
    hit: true,
    conflict: false,
    response: {
      ...prior.response,
      idempotentReplay: true,
    },
  };
}

export function saveQualityIdempotency(
  scope: string,
  idempotencyKey: string | undefined,
  fingerprintPayload: unknown,
  statusCode: number,
  response: any
): void {
  if (!idempotencyKey) return;
  const mapKey = `${scope}:::${idempotencyKey}`;
  qualityIdempotencyMap.set(mapKey, {
    fingerprint: hashPayload(scope, fingerprintPayload),
    statusCode,
    response,
  });
}

// =========================================================================
// Inventory / QM Integration Callbacks (Injected from apiRouter.ts)
// =========================================================================
export interface QualityInventoryBridge {
  parts: Part[];
  warehouses: WarehouseDefinition[];
  coils: PhysicalCoil[];
  balances: DetailedStockBalance[];
  manufacturingOrders: Array<{
    id: string;
    moNumber: string;
    partId: string;
    partCode: string;
    partName: string;
    status: string;
    operations?: Array<{ id?: string; operationId?: string; code?: string; operationCode?: string; name?: string; operationName?: string }>;
  }>;
  executeQmTransfer: (params: {
    key?: string;
    partId?: string;
    partCode?: string;
    warehouseId?: string;
    locationCode?: string;
    lotNumber?: string;
    physicalCoilId?: string;
    ownership?: StockOwnership;
    contractId?: string;
    isHeld: boolean;
    holdType?: 'QUALITY_INSPECTION' | 'BLOCKED';
    movementType: '321' | '322' | '344';
    heldQty?: number;
    heldWeightKg?: number;
    reasonFa: string;
    idempotencyKey?: string;
    user: { uid: string; displayName: string };
  }) => Promise<{ success: boolean; error?: string; statusCode?: number; document?: InventoryDocument }>;
  postQualityAdjustment: (params: {
    partId: string;
    warehouseId: string;
    locationCode?: string;
    lotNumber?: string;
    physicalCoilId?: string;
    ownership?: StockOwnership;
    contractId?: string;
    contractNumber?: string;
    quantityDelta: number;
    qualityStatus: StockQualityStatus;
    referenceType: 'QUALITY_SCRAP' | 'SUPPLIER_RETURN' | 'REWORK_RETURN';
    referenceNumber: string;
    reasonFa: string;
    idempotencyKey?: string;
    creditScrapWarehouse?: boolean;
    markCoilReturned?: boolean;
    user: { uid: string; displayName: string };
  }) => Promise<{ success: boolean; error?: string; statusCode?: number; document?: InventoryDocument }>;
  recordAudit: (entry: {
    action: string;
    entityName: string;
    entityId: string;
    user: { uid: string; displayName: string };
    details: string;
  }) => void;
  persist: () => Promise<void>;
}

function makeDocNumber(prefix: string): string {
  const datePart = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${datePart}-${rand}`;
}

function resolveDefectMeta(defectCode?: string, fallbackCategory?: NonconformanceCategory) {
  const found = QUALITY_DEFECT_CATALOG.find(d => d.code === defectCode);
  if (found) return found;
  return {
    code: defectCode || 'DEF-DIM',
    labelFa: defectCode || 'عدم انطباق کیفی ثبت‌شده',
    category: fallbackCategory || 'OTHER',
    defaultSeverity: 'MAJOR' as NonconformanceSeverity,
  };
}

function resolveMatchingBalance(
  bridge: QualityInventoryBridge,
  ref: {
    balanceId?: string;
    partId?: string;
    partCode?: string;
    warehouseId?: string;
    lotNumber?: string;
    coilId?: string;
  }
): DetailedStockBalance | undefined {
  if (ref.balanceId) {
    const byId = bridge.balances.find(b => b.id === ref.balanceId);
    if (byId) return byId;
  }
  return bridge.balances.find(
    b =>
      b.physicalQty > EPS &&
      (ref.partId ? b.partId === ref.partId : true) &&
      (ref.partCode ? b.partCode === ref.partCode : true) &&
      (ref.warehouseId ? b.warehouseId === ref.warehouseId : true) &&
      (ref.lotNumber
        ? b.lotNumber === ref.lotNumber
        : ref.coilId
        ? b.lotNumber === ref.coilId
        : true)
  );
}

// =========================================================================
// 1. Create Quality Inspection (Incoming / In-Process / Final)
// =========================================================================
export interface CreateInspectionInput {
  inspectionType: QualityInspectionType;
  partId?: string;
  partCode?: string;
  warehouseId?: string;
  locationCode?: string;
  balanceId?: string;
  lotNumber?: string;
  physicalCoilId?: string;
  coilId?: string;
  manufacturingOrderId?: string;
  moNumber?: string;
  operationId?: string;
  operationCode?: string;
  operationName?: string;
  supplierName?: string;
  contractId?: string;
  contractNumber?: string;
  sourceDocumentNumber?: string;
  inspectedQty: number;
  checklist?: InspectionChecklistItem[];
  notes?: string;
  quarantineOnStart?: boolean;
  // Optional immediate decision in one call
  decision?: QualityDecision;
  acceptedQty?: number;
  rejectedQty?: number;
  reworkQty?: number;
  defectCodes?: string[];
  defectCategory?: NonconformanceCategory;
  defectSummary?: string;
  severity?: NonconformanceSeverity;
  autoCreateNcr?: boolean;
  idempotencyKey?: string;
  user: { uid: string; displayName: string };
}

export async function createQualityInspection(
  input: CreateInspectionInput,
  bridge: QualityInventoryBridge
): Promise<{
  ok: boolean;
  statusCode: number;
  error?: string;
  idempotentReplay?: boolean;
  inspection?: QualityInspectionRecord;
  ncr?: NonconformanceRecord;
  qmDocument?: InventoryDocument;
}> {
  const validTypes: QualityInspectionType[] = ['INCOMING_MATERIAL', 'IN_PROCESS', 'FINAL_PRODUCT'];
  if (!validTypes.includes(input.inspectionType)) {
    return { ok: false, statusCode: 400, error: 'نوع بازرسی کیفی نامعتبر است (INCOMING_MATERIAL / IN_PROCESS / FINAL_PRODUCT).' };
  }

  const inspectedQty = Number(input.inspectedQty);
  if (!Number.isFinite(inspectedQty) || inspectedQty <= 0) {
    return { ok: false, statusCode: 400, error: 'مقدار مورد بازرسی (inspectedQty) باید عددی مثبت باشد.' };
  }

  // Idempotency check BEFORE any mutations
  const fpPayload = {
    inspectionType: input.inspectionType,
    partId: input.partId || input.partCode || null,
    warehouseId: input.warehouseId || null,
    lotNumber: input.lotNumber || null,
    coilId: input.physicalCoilId || input.coilId || null,
    moNumber: input.moNumber || input.manufacturingOrderId || null,
    operationCode: input.operationCode || input.operationId || null,
    inspectedQty,
    decision: input.decision || 'PENDING',
    acceptedQty: input.acceptedQty ?? null,
    rejectedQty: input.rejectedQty ?? null,
    reworkQty: input.reworkQty ?? null,
  };
  if (isQualityPostgresPersistenceActive()) {
    return createQualityInspectionInDb(input, bridge, fpPayload);
  }
  const idem = checkQualityIdempotency('CREATE_INSPECTION', input.idempotencyKey, fpPayload);
  if (idem.hit) {
    if (idem.conflict) return { ok: false, statusCode: 409, error: idem.error };
    return { ok: true, statusCode: 200, idempotentReplay: true, ...idem.response };
  }

  // Resolve coil / MO / balance / part
  const matchedCoil = (input.physicalCoilId || input.coilId)
    ? bridge.coils.find(
        c =>
          c.id === input.physicalCoilId ||
          c.id === input.coilId ||
          c.coilId === input.coilId ||
          c.coilPackNumber === input.coilId
      )
    : undefined;

  const matchedMo = (input.manufacturingOrderId || input.moNumber)
    ? bridge.manufacturingOrders.find(
        m => m.id === input.manufacturingOrderId || m.moNumber === input.moNumber
      )
    : undefined;

  if (input.inspectionType === 'IN_PROCESS' && !matchedMo && !input.moNumber && !input.manufacturingOrderId) {
    return {
      ok: false,
      statusCode: 400,
      error: 'برای بازرسی حین فرآیند (IPQC)، اتصال به دستور تولید (MO) الزامی است.',
    };
  }

  const resolvedPart =
    (input.partId ? bridge.parts.find(p => p.id === input.partId) : undefined) ||
    (input.partCode ? bridge.parts.find(p => p.code === input.partCode) : undefined) ||
    (matchedCoil ? bridge.parts.find(p => p.id === matchedCoil.partId || p.code === matchedCoil.partCode) : undefined) ||
    (matchedMo ? bridge.parts.find(p => p.id === matchedMo.partId || p.code === matchedMo.partCode) : undefined);
  if (!resolvedPart) {
    return { ok: false, statusCode: 404, error: 'قطعه یا ماده اولیه انتخاب‌شده در کاتالوگ قطعات یافت نشد.' };
  }

  const resolvedLot = input.lotNumber || matchedCoil?.coilId;
  const resolvedWarehouseId = input.warehouseId || matchedCoil?.warehouseId || (input.inspectionType === 'FINAL_PRODUCT' ? 'WH-FINISHED' : 'WH-RAW');
  const matchedWarehouse = bridge.warehouses.find(w => w.id === resolvedWarehouseId || w.code === resolvedWarehouseId);
  const matchedBalance = resolveMatchingBalance(bridge, {
    balanceId: input.balanceId,
    partId: resolvedPart.id,
    warehouseId: matchedWarehouse?.id || resolvedWarehouseId,
    lotNumber: resolvedLot,
    coilId: matchedCoil?.coilId,
  });

  const unit: UnitOfMeasure = resolvedPart.unit;
  const weightKg = round3(unit === 'KG' ? inspectedQty : inspectedQty * Number(resolvedPart.weightPerUnitKg || 1));
  const now = new Date().toISOString();
  const typePrefix =
    input.inspectionType === 'INCOMING_MATERIAL'
      ? 'INS-IN'
      : input.inspectionType === 'IN_PROCESS'
      ? 'INS-IP'
      : 'INS-FN';
  const inspectionNumber = makeDocNumber(typePrefix);

  const checklist: InspectionChecklistItem[] =
    Array.isArray(input.checklist) && input.checklist.length > 0
      ? input.checklist.map((item, idx) => ({
          id: item.id || `CHK-${idx + 1}`,
          code: String(item.code || `CHK-${idx + 1}`),
          labelFa: String(item.labelFa || `آیتم بازرسی ${idx + 1}`),
          standardSpec: item.standardSpec ? String(item.standardSpec) : undefined,
          measuredValue: item.measuredValue ? String(item.measuredValue) : undefined,
          passed: Boolean(item.passed),
          notes: item.notes ? String(item.notes) : undefined,
        }))
      : getDefaultChecklistTemplate(input.inspectionType);

  let qmDocument: InventoryDocument | undefined;

  // Optional quarantine-on-start when stock is currently unrestricted and no immediate acceptance decision is supplied
  if (
    input.quarantineOnStart &&
    (!input.decision || input.decision === 'PENDING' || input.decision === 'QUARANTINED') &&
    matchedBalance &&
    matchedBalance.availableQty > EPS
  ) {
    const holdQty = Math.min(inspectedQty, matchedBalance.availableQty);
    const qmRes = await bridge.executeQmTransfer({
      key: matchedBalance.id,
      partId: resolvedPart.id,
      partCode: resolvedPart.code,
      warehouseId: matchedBalance.warehouseId,
      locationCode: matchedBalance.locationCode,
      lotNumber: matchedBalance.lotNumber,
      physicalCoilId: matchedCoil?.id,
      ownership: matchedBalance.ownership,
      contractId: matchedBalance.contractId,
      isHeld: true,
      holdType: 'QUALITY_INSPECTION',
      movementType: '322',
      heldQty: holdQty,
      heldWeightKg: unit === 'KG' ? holdQty : round3(holdQty * Number(resolvedPart.weightPerUnitKg || 1)),
      reasonFa: `قرنطینه خودکار جهت بازرسی کیفی ${inspectionNumber}`,
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:QSTART` : undefined,
      user: input.user,
    });
    if (!qmRes.success) {
      return { ok: false, statusCode: qmRes.statusCode || 409, error: qmRes.error || 'خطا در قرنطینه اولیه موجودی برای بازرسی' };
    }
    qmDocument = qmRes.document;
  }

  const record: QualityInspectionRecord = {
    id: `QINS-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
    inspectionNumber,
    inspectionType: input.inspectionType,
    status: 'PENDING',
    decision: 'PENDING',
    partId: resolvedPart.id,
    partCode: resolvedPart.code,
    partName: resolvedPart.name,
    warehouseId: matchedBalance?.warehouseId || matchedWarehouse?.id || resolvedWarehouseId,
    warehouseName: matchedBalance?.warehouseName || matchedWarehouse?.name || resolvedWarehouseId,
    locationCode: input.locationCode || matchedBalance?.locationCode || matchedCoil?.warehouseLocationCode,
    balanceId: matchedBalance?.id || input.balanceId,
    lotNumber: resolvedLot || matchedBalance?.lotNumber,
    heatNumber: matchedCoil?.heatNumber || matchedBalance?.heatNumber,
    physicalCoilId: matchedCoil?.id,
    coilId: matchedCoil?.coilId,
    coilPackNumber: matchedCoil?.coilPackNumber,
    manufacturingOrderId: matchedMo?.id || input.manufacturingOrderId,
    moNumber: matchedMo?.moNumber || input.moNumber,
    operationId: input.operationId,
    operationCode: input.operationCode,
    operationName: input.operationName,
    supplierName: input.supplierName || matchedCoil?.supplierName || (matchedBalance?.ownership === 'SAPCO_SUPPLIER_OWNED' ? 'ساپکو (تأمین امانی)' : undefined),
    ownership: matchedBalance?.ownership || matchedCoil?.ownership || 'COMPANY_OWNED',
    contractId: input.contractId || matchedBalance?.contractId || matchedCoil?.allocations?.[0]?.contractId,
    contractNumber: input.contractNumber || matchedBalance?.contractNumber || matchedCoil?.allocations?.[0]?.contractNumber,
    sourceDocumentNumber: input.sourceDocumentNumber,
    inspectedQty: round3(inspectedQty),
    acceptedQty: 0,
    rejectedQty: 0,
    reworkQty: 0,
    unit,
    weightKg,
    checklist,
    defectCodes: Array.isArray(input.defectCodes) ? input.defectCodes : [],
    defectCategory: input.defectCategory,
    defectSummary: input.defectSummary,
    notes: input.notes,
    linkedQmDocumentNumber: qmDocument?.documentNumber,
    inspectorUid: input.user.uid,
    inspectorName: input.user.displayName,
    inspectedAt: now,
    idempotencyKey: input.idempotencyKey,
    createdAt: now,
    updatedAt: now,
  };

  inspectionsStore.unshift(record);
  bridge.recordAudit({
    action: 'QUALITY_INSPECTION_CREATE',
    entityName: 'QualityInspection',
    entityId: record.inspectionNumber,
    user: input.user,
    details: `ایجاد بازرسی ${INSPECTION_TYPE_LABELS_FA[record.inspectionType]} برای «${record.partCode}» به مقدار ${record.inspectedQty} ${record.unit}`,
  });

  // If immediate decision was passed, apply decision in the same workflow
  let createdNcr: NonconformanceRecord | undefined;
  if (input.decision && input.decision !== 'PENDING') {
    const decisionRes = await decideQualityInspection(
      record.id,
      {
        decision: input.decision,
        acceptedQty: input.acceptedQty,
        rejectedQty: input.rejectedQty,
        reworkQty: input.reworkQty,
        checklist: record.checklist,
        defectCodes: input.defectCodes,
        defectCategory: input.defectCategory,
        defectSummary: input.defectSummary,
        severity: input.severity,
        notes: input.notes,
        autoCreateNcr: input.autoCreateNcr,
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:DECIDE` : undefined,
        user: input.user,
      },
      bridge
    );
    if (!decisionRes.ok) {
      // Roll back uncommitted inspection on decision failure
      inspectionsStore = inspectionsStore.filter(i => i.id !== record.id);
      return { ok: false, statusCode: decisionRes.statusCode, error: decisionRes.error };
    }
    createdNcr = decisionRes.ncr;
    qmDocument = decisionRes.qmDocument || qmDocument;
  } else {
    await bridge.persist();
  }

  const responsePayload = {
    inspection: record,
    ncr: createdNcr,
    qmDocument,
  };
  saveQualityIdempotency('CREATE_INSPECTION', input.idempotencyKey, fpPayload, 201, responsePayload);
  return { ok: true, statusCode: 201, idempotentReplay: false, ...responsePayload };
}

// =========================================================================
// 2. Record Inspection Decision (Accept / Concession / Quarantine / Reject)
// =========================================================================
export interface DecideInspectionInput {
  decision: QualityDecision;
  acceptedQty?: number;
  rejectedQty?: number;
  reworkQty?: number;
  checklist?: InspectionChecklistItem[];
  defectCodes?: string[];
  defectCategory?: NonconformanceCategory;
  defectSummary?: string;
  severity?: NonconformanceSeverity;
  notes?: string;
  autoCreateNcr?: boolean;
  idempotencyKey?: string;
  user: { uid: string; displayName: string };
}

export async function decideQualityInspection(
  inspectionIdOrNumber: string,
  input: DecideInspectionInput,
  bridge: QualityInventoryBridge
): Promise<{
  ok: boolean;
  statusCode: number;
  error?: string;
  idempotentReplay?: boolean;
  inspection?: QualityInspectionRecord;
  ncr?: NonconformanceRecord;
  qmDocument?: InventoryDocument;
}> {
  const validDecisions: QualityDecision[] = ['ACCEPTED', 'ACCEPTED_WITH_CONCESSION', 'QUARANTINED', 'REJECTED'];
  if (!validDecisions.includes(input.decision)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'تصمیم بازرسی باید یکی از مقادیر ACCEPTED، ACCEPTED_WITH_CONCESSION، QUARANTINED یا REJECTED باشد.',
    };
  }

  const fpPayload = {
    id: inspectionIdOrNumber,
    decision: input.decision,
    acceptedQty: input.acceptedQty ?? null,
    rejectedQty: input.rejectedQty ?? null,
    reworkQty: input.reworkQty ?? null,
    defectCodes: input.defectCodes || [],
  };
  if (isQualityPostgresPersistenceActive()) {
    return decideQualityInspectionInDb(inspectionIdOrNumber, input, bridge, fpPayload);
  }
  const idem = checkQualityIdempotency('DECIDE_INSPECTION', input.idempotencyKey, fpPayload);
  if (idem.hit) {
    if (idem.conflict) return { ok: false, statusCode: 409, error: idem.error };
    return { ok: true, statusCode: 200, idempotentReplay: true, ...idem.response };
  }

  const record = inspectionsStore.find(
    i => i.id === inspectionIdOrNumber || i.inspectionNumber === inspectionIdOrNumber
  );
  if (!record) {
    return { ok: false, statusCode: 404, error: `برگه بازرسی «${inspectionIdOrNumber}» یافت نشد.` };
  }
  if (record.status === 'COMPLETED' && record.decision !== 'QUARANTINED') {
    return {
      ok: false,
      statusCode: 409,
      error: `بازرسی «${record.inspectionNumber}» قبلاً با تصمیم «${record.decision}» نهایی شده است.`,
    };
  }

  // Derive quantities cleanly when omitted
  let acceptedQty = input.acceptedQty !== undefined ? Number(input.acceptedQty) : 0;
  let rejectedQty = input.rejectedQty !== undefined ? Number(input.rejectedQty) : 0;
  let reworkQty = input.reworkQty !== undefined ? Number(input.reworkQty) : 0;

  if (input.acceptedQty === undefined && input.rejectedQty === undefined && input.reworkQty === undefined) {
    if (input.decision === 'ACCEPTED' || input.decision === 'ACCEPTED_WITH_CONCESSION') {
      acceptedQty = record.inspectedQty;
    } else if (input.decision === 'REJECTED') {
      rejectedQty = record.inspectedQty;
    } else if (input.decision === 'QUARANTINED') {
      acceptedQty = 0;
      rejectedQty = 0;
      reworkQty = 0;
    }
  }

  if (
    !Number.isFinite(acceptedQty) ||
    !Number.isFinite(rejectedQty) ||
    !Number.isFinite(reworkQty) ||
    acceptedQty < 0 ||
    rejectedQty < 0 ||
    reworkQty < 0
  ) {
    return { ok: false, statusCode: 400, error: 'مقادیر قبول، مردود و دوباره‌کاری باید نامنفی باشند.' };
  }

  if (acceptedQty + rejectedQty + reworkQty > record.inspectedQty + EPS) {
    return {
      ok: false,
      statusCode: 400,
      error: `مجموع مقادیر قبول (${acceptedQty})، مردود (${rejectedQty}) و دوباره‌کاری (${reworkQty}) از کل مقدار بازرسی‌شده (${record.inspectedQty}) بیشتر است.`,
    };
  }

  const part = bridge.parts.find(p => p.id === record.partId);
  const weightPerUnit = record.unit === 'KG' ? 1 : Number(part?.weightPerUnitKg || 1);
  const matchedCoil = record.physicalCoilId
    ? bridge.coils.find(c => c.id === record.physicalCoilId)
    : record.coilId
    ? bridge.coils.find(c => c.coilId === record.coilId)
    : undefined;
  const matchedBalance = resolveMatchingBalance(bridge, {
    balanceId: record.balanceId,
    partId: record.partId,
    warehouseId: record.warehouseId,
    lotNumber: record.lotNumber,
    coilId: record.coilId,
  });

  // Synchronize Inventory & Coil QM Status (321 / 322 / 344)
  let qmDocument: InventoryDocument | undefined;
  const nonConformingQty = round3(rejectedQty + reworkQty);

  if (matchedBalance) {
    // 1. Release accepted portion from QI/Blocked -> Unrestricted (321) if currently held
    const heldInBalance = round3(matchedBalance.qualityInspectionQty + matchedBalance.blockedQty);
    if (
      (input.decision === 'ACCEPTED' || input.decision === 'ACCEPTED_WITH_CONCESSION' || acceptedQty > EPS) &&
      heldInBalance > EPS
    ) {
      const releaseQty = round3(Math.min(acceptedQty || heldInBalance, heldInBalance));
      if (releaseQty > EPS) {
        const res321 = await bridge.executeQmTransfer({
          key: matchedBalance.id,
          partId: record.partId,
          partCode: record.partCode,
          warehouseId: matchedBalance.warehouseId,
          locationCode: matchedBalance.locationCode,
          lotNumber: matchedBalance.lotNumber,
          physicalCoilId: matchedCoil?.id,
          ownership: matchedBalance.ownership,
          contractId: matchedBalance.contractId,
          isHeld: false,
          movementType: '321',
          heldQty: releaseQty,
          heldWeightKg: round3(releaseQty * weightPerUnit),
          reasonFa: `تایید و ترخیص کیفی برگه بازرسی ${record.inspectionNumber}${input.notes ? ` — ${input.notes}` : ''}`,
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:321` : undefined,
          user: input.user,
        });
        if (!res321.success) {
          return { ok: false, statusCode: res321.statusCode || 409, error: res321.error };
        }
        qmDocument = res321.document;
      }
    }

    // 2. Quarantine entire inspected qty if decision === QUARANTINED and stock is currently unrestricted
    if (input.decision === 'QUARANTINED' && matchedBalance.availableQty > EPS) {
      const holdQty = round3(Math.min(record.inspectedQty, matchedBalance.availableQty));
      if (holdQty > EPS) {
        const res322 = await bridge.executeQmTransfer({
          key: matchedBalance.id,
          partId: record.partId,
          partCode: record.partCode,
          warehouseId: matchedBalance.warehouseId,
          locationCode: matchedBalance.locationCode,
          lotNumber: matchedBalance.lotNumber,
          physicalCoilId: matchedCoil?.id,
          ownership: matchedBalance.ownership,
          contractId: matchedBalance.contractId,
          isHeld: true,
          holdType: 'QUALITY_INSPECTION',
          movementType: '322',
          heldQty: holdQty,
          heldWeightKg: round3(holdQty * weightPerUnit),
          reasonFa: `قرنطینه کیفی بر اساس بازرسی ${record.inspectionNumber}${input.defectSummary ? ` — ${input.defectSummary}` : ''}`,
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:322` : undefined,
          user: input.user,
        });
        if (!res322.success) {
          return { ok: false, statusCode: res322.statusCode || 409, error: res322.error };
        }
        qmDocument = res322.document;
      }
    }

    // 3. Block rejected / rework portion (344: QI or Unrestricted -> Blocked)
    if (nonConformingQty > EPS || input.decision === 'REJECTED') {
      const targetBlockQty = round3(nonConformingQty > EPS ? nonConformingQty : record.inspectedQty);
      const blockableNow = round3(matchedBalance.availableQty + matchedBalance.qualityInspectionQty);
      const qtyToBlock = round3(Math.min(targetBlockQty, blockableNow));
      if (qtyToBlock > EPS) {
        const res344 = await bridge.executeQmTransfer({
          key: matchedBalance.id,
          partId: record.partId,
          partCode: record.partCode,
          warehouseId: matchedBalance.warehouseId,
          locationCode: matchedBalance.locationCode,
          lotNumber: matchedBalance.lotNumber,
          physicalCoilId: matchedCoil?.id,
          ownership: matchedBalance.ownership,
          contractId: matchedBalance.contractId,
          isHeld: true,
          holdType: 'BLOCKED',
          movementType: '344',
          heldQty: qtyToBlock,
          heldWeightKg: round3(qtyToBlock * weightPerUnit),
          reasonFa: `رد و مسدودسازی کیفی بازرسی ${record.inspectionNumber}${input.defectSummary ? ` — ${input.defectSummary}` : ''}`,
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:344` : undefined,
          user: input.user,
        });
        if (!res344.success) {
          return { ok: false, statusCode: res344.statusCode || 409, error: res344.error };
        }
        qmDocument = res344.document;
      }
    }
  } else if (matchedCoil) {
    // Sync physical coil status directly even if no separate stock balance was matched
    if (input.decision === 'ACCEPTED' || input.decision === 'ACCEPTED_WITH_CONCESSION') {
      matchedCoil.qualityStatus = 'AVAILABLE';
      matchedCoil.physicalStatus = matchedCoil.remainingWeightKg > EPS ? 'AVAILABLE' : 'CONSUMED';
    } else if (input.decision === 'QUARANTINED') {
      matchedCoil.qualityStatus = 'QUARANTINE';
      matchedCoil.physicalStatus = 'BLOCKED';
    } else if (input.decision === 'REJECTED') {
      matchedCoil.qualityStatus = 'REJECTED';
      matchedCoil.physicalStatus = 'BLOCKED';
    }
  }

  // Ensure coil reflects REJECTED explicitly when full rejection occurs
  if (matchedCoil && input.decision === 'REJECTED' && acceptedQty <= EPS) {
    matchedCoil.qualityStatus = 'REJECTED';
    matchedCoil.physicalStatus = 'BLOCKED';
  }

  const now = new Date().toISOString();
  record.decision = input.decision;
  record.status = input.decision === 'QUARANTINED' ? 'IN_PROGRESS' : 'COMPLETED';
  record.acceptedQty = round3(acceptedQty);
  record.rejectedQty = round3(rejectedQty);
  record.reworkQty = round3(reworkQty);
  if (Array.isArray(input.checklist) && input.checklist.length > 0) {
    record.checklist = input.checklist;
  }
  if (Array.isArray(input.defectCodes)) {
    record.defectCodes = input.defectCodes;
  }
  if (input.defectCategory) record.defectCategory = input.defectCategory;
  if (input.defectSummary !== undefined) record.defectSummary = input.defectSummary;
  if (input.notes !== undefined) record.notes = input.notes;
  if (qmDocument?.documentNumber) record.linkedQmDocumentNumber = qmDocument.documentNumber;
  record.decidedAt = now;
  record.updatedAt = now;

  // Auto-open NCR on rejection / rework defects if not already linked
  let createdNcr: NonconformanceRecord | undefined;
  const shouldAutoCreateNcr =
    input.autoCreateNcr !== false &&
    !record.linkedNcrId &&
    (nonConformingQty > EPS || input.decision === 'REJECTED');

  if (shouldAutoCreateNcr) {
    const primaryDefect = resolveDefectMeta(record.defectCodes[0], record.defectCategory);
    const ncrQty = nonConformingQty > EPS ? nonConformingQty : record.inspectedQty;
    const ncrNumber = makeDocNumber('NCR');
    const sourceType: NcrSourceType =
      record.inspectionType === 'INCOMING_MATERIAL'
        ? 'INCOMING_MATERIAL'
        : record.inspectionType === 'IN_PROCESS'
        ? 'IN_PROCESS'
        : 'FINAL_PRODUCT';

    const ncr: NonconformanceRecord = {
      id: `NCR-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
      ncrNumber,
      title: `عدم انطباق ${record.partName} (${primaryDefect.labelFa})`,
      sourceType,
      severity: input.severity || primaryDefect.defaultSeverity,
      category: record.defectCategory || primaryDefect.category,
      defectCode: primaryDefect.code,
      defectLabelFa: primaryDefect.labelFa,
      status: qmDocument ? 'CONTAINED' : 'OPEN',
      disposition: 'PENDING',
      inspectionId: record.id,
      inspectionNumber: record.inspectionNumber,
      partId: record.partId,
      partCode: record.partCode,
      partName: record.partName,
      warehouseId: record.warehouseId,
      warehouseName: record.warehouseName,
      locationCode: record.locationCode,
      balanceId: record.balanceId,
      lotNumber: record.lotNumber,
      heatNumber: record.heatNumber,
      physicalCoilId: record.physicalCoilId,
      coilId: record.coilId,
      coilPackNumber: record.coilPackNumber,
      manufacturingOrderId: record.manufacturingOrderId,
      moNumber: record.moNumber,
      operationId: record.operationId,
      operationCode: record.operationCode,
      operationName: record.operationName,
      supplierName: record.supplierName,
      ownership: record.ownership,
      contractId: record.contractId,
      contractNumber: record.contractNumber,
      affectedQty: round3(ncrQty),
      containedQty: qmDocument ? round3(ncrQty) : 0,
      reworkedGoodQty: 0,
      scrappedQty: 0,
      returnedToProductionQty: 0,
      returnedToSupplierQty: 0,
      unit: record.unit,
      weightKg: round3(ncrQty * weightPerUnit),
      description:
        record.defectSummary ||
        record.notes ||
        `ثبت خودکار عدم انطباق از برگه بازرسی ${record.inspectionNumber}`,
      containmentAction: qmDocument
        ? `مسدودسازی خودکار در انبار با سند کیفی ${qmDocument.documentNumber}`
        : undefined,
      containedAt: qmDocument ? now : undefined,
      containedByName: qmDocument ? input.user.displayName : undefined,
      containmentQmDocNumber: qmDocument?.documentNumber,
      createdByUid: input.user.uid,
      createdByName: input.user.displayName,
      createdAt: now,
      updatedAt: now,
    };
    ncrsStore.unshift(ncr);
    record.linkedNcrId = ncr.id;
    record.linkedNcrNumber = ncr.ncrNumber;
    createdNcr = ncr;
  }

  bridge.recordAudit({
    action: 'QUALITY_INSPECTION_DECIDE',
    entityName: 'QualityInspection',
    entityId: record.inspectionNumber,
    user: input.user,
    details: `تصمیم کیفی «${record.decision}» برای ${record.partCode} (قبول: ${record.acceptedQty}، مردود: ${record.rejectedQty}، دوباره‌کاری: ${record.reworkQty})${createdNcr ? ` | NCR: ${createdNcr.ncrNumber}` : ''}`,
  });

  await bridge.persist();

  const responsePayload = {
    inspection: record,
    ncr: createdNcr,
    qmDocument,
  };
  saveQualityIdempotency('DECIDE_INSPECTION', input.idempotencyKey, fpPayload, 200, responsePayload);
  return { ok: true, statusCode: 200, idempotentReplay: false, ...responsePayload };
}

// =========================================================================
// 3. Nonconformance (NCR) Recording, Containment & Disposition
// =========================================================================
export interface CreateNcrInput {
  title?: string;
  sourceType: NcrSourceType;
  severity?: NonconformanceSeverity;
  category?: NonconformanceCategory;
  defectCode?: string;
  partId?: string;
  partCode?: string;
  warehouseId?: string;
  locationCode?: string;
  balanceId?: string;
  lotNumber?: string;
  physicalCoilId?: string;
  coilId?: string;
  manufacturingOrderId?: string;
  moNumber?: string;
  operationId?: string;
  operationCode?: string;
  operationName?: string;
  supplierName?: string;
  contractId?: string;
  contractNumber?: string;
  affectedQty: number;
  description: string;
  rootCause?: string;
  correctiveAction?: string;
  containImmediately?: boolean;
  containmentAction?: string;
  idempotencyKey?: string;
  user: { uid: string; displayName: string };
}

export async function createNonconformanceRecord(
  input: CreateNcrInput,
  bridge: QualityInventoryBridge
): Promise<{
  ok: boolean;
  statusCode: number;
  error?: string;
  idempotentReplay?: boolean;
  ncr?: NonconformanceRecord;
  qmDocument?: InventoryDocument;
}> {
  const affectedQty = Number(input.affectedQty);
  if (!Number.isFinite(affectedQty) || affectedQty <= 0) {
    return { ok: false, statusCode: 400, error: 'مقدار نامنطبق (affectedQty) باید عددی مثبت باشد.' };
  }
  const trimmedDesc = String(input.description || '').trim();
  if (trimmedDesc.length < 3) {
    return { ok: false, statusCode: 400, error: 'ثبت شرح عدم انطباق (حداقل ۳ کاراکتر) الزامی است.' };
  }

  const fpPayload = {
    sourceType: input.sourceType,
    partId: input.partId || input.partCode || null,
    lotNumber: input.lotNumber || null,
    coilId: input.physicalCoilId || input.coilId || null,
    moNumber: input.moNumber || input.manufacturingOrderId || null,
    defectCode: input.defectCode || null,
    affectedQty,
    containImmediately: Boolean(input.containImmediately),
  };
  if (isQualityPostgresPersistenceActive()) {
    return createNonconformanceRecordInDb(input, bridge, fpPayload);
  }
  const idem = checkQualityIdempotency('CREATE_NCR', input.idempotencyKey, fpPayload);
  if (idem.hit) {
    if (idem.conflict) return { ok: false, statusCode: 409, error: idem.error };
    return { ok: true, statusCode: 200, idempotentReplay: true, ...idem.response };
  }

  const matchedCoil = (input.physicalCoilId || input.coilId)
    ? bridge.coils.find(
        c =>
          c.id === input.physicalCoilId ||
          c.id === input.coilId ||
          c.coilId === input.coilId ||
          c.coilPackNumber === input.coilId
      )
    : undefined;
  const matchedMo = (input.manufacturingOrderId || input.moNumber)
    ? bridge.manufacturingOrders.find(
        m => m.id === input.manufacturingOrderId || m.moNumber === input.moNumber
      )
    : undefined;
  const resolvedPart =
    (input.partId ? bridge.parts.find(p => p.id === input.partId) : undefined) ||
    (input.partCode ? bridge.parts.find(p => p.code === input.partCode) : undefined) ||
    (matchedCoil ? bridge.parts.find(p => p.id === matchedCoil.partId || p.code === matchedCoil.partCode) : undefined) ||
    (matchedMo ? bridge.parts.find(p => p.id === matchedMo.partId || p.code === matchedMo.partCode) : undefined);
  if (!resolvedPart) {
    return { ok: false, statusCode: 404, error: 'قطعه یا ماده اولیه انتخاب‌شده یافت نشد.' };
  }

  const resolvedLot = input.lotNumber || matchedCoil?.coilId;
  const resolvedWarehouseId = input.warehouseId || matchedCoil?.warehouseId || 'WH-RAW';
  const matchedWarehouse = bridge.warehouses.find(w => w.id === resolvedWarehouseId || w.code === resolvedWarehouseId);
  const matchedBalance = resolveMatchingBalance(bridge, {
    balanceId: input.balanceId,
    partId: resolvedPart.id,
    warehouseId: matchedWarehouse?.id || resolvedWarehouseId,
    lotNumber: resolvedLot,
    coilId: matchedCoil?.coilId,
  });

  const defectMeta = resolveDefectMeta(input.defectCode, input.category);
  const unit: UnitOfMeasure = resolvedPart.unit;
  const weightPerUnit = unit === 'KG' ? 1 : Number(resolvedPart.weightPerUnitKg || 1);
  const now = new Date().toISOString();
  const ncrNumber = makeDocNumber('NCR');

  const ncr: NonconformanceRecord = {
    id: `NCR-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
    ncrNumber,
    title: String(input.title || '').trim() || `عدم انطباق ${resolvedPart.name} — ${defectMeta.labelFa}`,
    sourceType: input.sourceType || 'IN_PROCESS',
    severity: input.severity || defectMeta.defaultSeverity,
    category: input.category || defectMeta.category,
    defectCode: defectMeta.code,
    defectLabelFa: defectMeta.labelFa,
    status: 'OPEN',
    disposition: 'PENDING',
    partId: resolvedPart.id,
    partCode: resolvedPart.code,
    partName: resolvedPart.name,
    warehouseId: matchedBalance?.warehouseId || matchedWarehouse?.id || resolvedWarehouseId,
    warehouseName: matchedBalance?.warehouseName || matchedWarehouse?.name || resolvedWarehouseId,
    locationCode: input.locationCode || matchedBalance?.locationCode || matchedCoil?.warehouseLocationCode,
    balanceId: matchedBalance?.id || input.balanceId,
    lotNumber: resolvedLot || matchedBalance?.lotNumber,
    heatNumber: matchedCoil?.heatNumber || matchedBalance?.heatNumber,
    physicalCoilId: matchedCoil?.id,
    coilId: matchedCoil?.coilId,
    coilPackNumber: matchedCoil?.coilPackNumber,
    manufacturingOrderId: matchedMo?.id || input.manufacturingOrderId,
    moNumber: matchedMo?.moNumber || input.moNumber,
    operationId: input.operationId,
    operationCode: input.operationCode,
    operationName: input.operationName,
    supplierName: input.supplierName || matchedCoil?.supplierName,
    ownership: matchedBalance?.ownership || matchedCoil?.ownership || 'COMPANY_OWNED',
    contractId: input.contractId || matchedBalance?.contractId || matchedCoil?.allocations?.[0]?.contractId,
    contractNumber: input.contractNumber || matchedBalance?.contractNumber || matchedCoil?.allocations?.[0]?.contractNumber,
    affectedQty: round3(affectedQty),
    containedQty: 0,
    reworkedGoodQty: 0,
    scrappedQty: 0,
    returnedToProductionQty: 0,
    returnedToSupplierQty: 0,
    unit,
    weightKg: round3(affectedQty * weightPerUnit),
    description: trimmedDesc,
    rootCause: input.rootCause,
    correctiveAction: input.correctiveAction,
    createdByUid: input.user.uid,
    createdByName: input.user.displayName,
    createdAt: now,
    updatedAt: now,
  };

  ncrsStore.unshift(ncr);

  let qmDocument: InventoryDocument | undefined;
  if (input.containImmediately) {
    const containRes = await containNonconformance(
      ncr.id,
      {
        containmentAction: input.containmentAction || 'قرنطینه و مسدودسازی فوری عدم انطباق در انبار',
        holdType: 'BLOCKED',
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:CONTAIN` : undefined,
        user: input.user,
      },
      bridge
    );
    if (!containRes.ok) {
      ncrsStore = ncrsStore.filter(n => n.id !== ncr.id);
      return { ok: false, statusCode: containRes.statusCode, error: containRes.error };
    }
    qmDocument = containRes.qmDocument;
  } else {
    bridge.recordAudit({
      action: 'NCR_CREATE',
      entityName: 'Nonconformance',
      entityId: ncr.ncrNumber,
      user: input.user,
      details: `ثبت عدم انطباق ${ncr.ncrNumber} (${ncr.severity}) برای ${ncr.partCode} به مقدار ${ncr.affectedQty} ${ncr.unit}`,
    });
    await bridge.persist();
  }

  const responsePayload = { ncr, qmDocument };
  saveQualityIdempotency('CREATE_NCR', input.idempotencyKey, fpPayload, 201, responsePayload);
  return { ok: true, statusCode: 201, idempotentReplay: false, ...responsePayload };
}

export async function containNonconformance(
  ncrIdOrNumber: string,
  input: {
    containmentAction: string;
    holdType?: 'QUALITY_INSPECTION' | 'BLOCKED';
    containQty?: number;
    idempotencyKey?: string;
    user: { uid: string; displayName: string };
  },
  bridge: QualityInventoryBridge
): Promise<{
  ok: boolean;
  statusCode: number;
  error?: string;
  idempotentReplay?: boolean;
  ncr?: NonconformanceRecord;
  qmDocument?: InventoryDocument;
}> {
  const actionText = String(input.containmentAction || '').trim();
  if (actionText.length < 3) {
    return { ok: false, statusCode: 400, error: 'شرح اقدام مهار فوری (Containment Action) الزامی است.' };
  }

  const fpPayload = {
    id: ncrIdOrNumber,
    holdType: input.holdType || 'BLOCKED',
    containQty: input.containQty ?? null,
    containmentAction: actionText,
  };
  if (isQualityPostgresPersistenceActive()) {
    return containNonconformanceInDb(ncrIdOrNumber, input, bridge, fpPayload);
  }
  const idem = checkQualityIdempotency('CONTAIN_NCR', input.idempotencyKey, fpPayload);
  if (idem.hit) {
    if (idem.conflict) return { ok: false, statusCode: 409, error: idem.error };
    return { ok: true, statusCode: 200, idempotentReplay: true, ...idem.response };
  }

  const ncr = ncrsStore.find(n => n.id === ncrIdOrNumber || n.ncrNumber === ncrIdOrNumber);
  if (!ncr) {
    return { ok: false, statusCode: 404, error: `گزارش عدم انطباق «${ncrIdOrNumber}» یافت نشد.` };
  }
  if (ncr.status === 'CLOSED') {
    return { ok: false, statusCode: 409, error: `گزارش عدم انطباق «${ncr.ncrNumber}» بسته شده است.` };
  }

  const targetHoldType = input.holdType === 'QUALITY_INSPECTION' ? 'QUALITY_INSPECTION' : 'BLOCKED';
  const movementType: '322' | '344' = targetHoldType === 'BLOCKED' ? '344' : '322';
  const containQty = round3(Number(input.containQty || ncr.affectedQty));
  const part = bridge.parts.find(p => p.id === ncr.partId);
  const weightPerUnit = ncr.unit === 'KG' ? 1 : Number(part?.weightPerUnitKg || 1);
  const matchedCoil = ncr.physicalCoilId
    ? bridge.coils.find(c => c.id === ncr.physicalCoilId)
    : ncr.coilId
    ? bridge.coils.find(c => c.coilId === ncr.coilId)
    : undefined;
  const matchedBalance = resolveMatchingBalance(bridge, {
    balanceId: ncr.balanceId,
    partId: ncr.partId,
    warehouseId: ncr.warehouseId,
    lotNumber: ncr.lotNumber,
    coilId: ncr.coilId,
  });

  let qmDocument: InventoryDocument | undefined;
  if (matchedBalance) {
    const transferable =
      movementType === '344'
        ? round3(matchedBalance.availableQty + matchedBalance.qualityInspectionQty)
        : round3(matchedBalance.availableQty);
    const qtyToHold = round3(Math.min(containQty, transferable));
    if (qtyToHold > EPS) {
      const qmRes = await bridge.executeQmTransfer({
        key: matchedBalance.id,
        partId: ncr.partId,
        partCode: ncr.partCode,
        warehouseId: matchedBalance.warehouseId,
        locationCode: matchedBalance.locationCode,
        lotNumber: matchedBalance.lotNumber,
        physicalCoilId: matchedCoil?.id,
        ownership: matchedBalance.ownership,
        contractId: matchedBalance.contractId,
        isHeld: true,
        holdType: targetHoldType,
        movementType,
        heldQty: qtyToHold,
        heldWeightKg: round3(qtyToHold * weightPerUnit),
        reasonFa: `مهار و قرنطینه عدم انطباق ${ncr.ncrNumber}: ${actionText}`,
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:QM` : undefined,
        user: input.user,
      });
      if (!qmRes.success) {
        return { ok: false, statusCode: qmRes.statusCode || 409, error: qmRes.error };
      }
      qmDocument = qmRes.document;
    }
  } else if (matchedCoil) {
    matchedCoil.qualityStatus = targetHoldType === 'BLOCKED' ? 'QUALITY_BLOCKED' : 'QUARANTINE';
    matchedCoil.physicalStatus = 'BLOCKED';
  }

  const now = new Date().toISOString();
  ncr.status = 'CONTAINED';
  ncr.containedQty = round3(containQty);
  ncr.containmentAction = actionText;
  ncr.containedAt = now;
  ncr.containedByName = input.user.displayName;
  if (qmDocument?.documentNumber) ncr.containmentQmDocNumber = qmDocument.documentNumber;
  ncr.updatedAt = now;

  bridge.recordAudit({
    action: 'NCR_CONTAIN',
    entityName: 'Nonconformance',
    entityId: ncr.ncrNumber,
    user: input.user,
    details: `اجرای مهار فوری (${movementType}) برای ${ncr.ncrNumber} به مقدار ${ncr.containedQty} ${ncr.unit}`,
  });
  await bridge.persist();

  const responsePayload = { ncr, qmDocument };
  saveQualityIdempotency('CONTAIN_NCR', input.idempotencyKey, fpPayload, 200, responsePayload);
  return { ok: true, statusCode: 200, idempotentReplay: false, ...responsePayload };
}

export async function dispositionNonconformance(
  ncrIdOrNumber: string,
  input: {
    disposition: NcrDispositionAction;
    rootCause?: string;
    correctiveAction?: string;
    dispositionNotes?: string;
    reworkInstructions?: string;
    targetOperationCode?: string;
    assignedToName?: string;
    returnToProduction?: boolean;
    // For SORT_REINSPECT split
    sortedGoodQty?: number;
    sortedDefectQty?: number;
    idempotencyKey?: string;
    user: { uid: string; displayName: string };
  },
  bridge: QualityInventoryBridge
): Promise<{
  ok: boolean;
  statusCode: number;
  error?: string;
  idempotentReplay?: boolean;
  ncr?: NonconformanceRecord;
  reworkOrder?: ReworkOrderRecord;
  document?: InventoryDocument;
}> {
  const validActions: NcrDispositionAction[] = [
    'USE_AS_IS',
    'REWORK',
    'SCRAP',
    'RETURN_TO_SUPPLIER',
    'SORT_REINSPECT',
  ];
  if (!validActions.includes(input.disposition)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'نوع تعیین تکلیف (Disposition) باید یکی از مقادیر USE_AS_IS، REWORK، SCRAP، RETURN_TO_SUPPLIER یا SORT_REINSPECT باشد.',
    };
  }

  const fpPayload = {
    id: ncrIdOrNumber,
    disposition: input.disposition,
    sortedGoodQty: input.sortedGoodQty ?? null,
    sortedDefectQty: input.sortedDefectQty ?? null,
    targetOperationCode: input.targetOperationCode || null,
  };
  if (isQualityPostgresPersistenceActive()) {
    return dispositionNonconformanceInDb(ncrIdOrNumber, input, bridge, fpPayload);
  }
  const idem = checkQualityIdempotency('DISPOSITION_NCR', input.idempotencyKey, fpPayload);
  if (idem.hit) {
    if (idem.conflict) return { ok: false, statusCode: 409, error: idem.error };
    return { ok: true, statusCode: 200, idempotentReplay: true, ...idem.response };
  }

  const ncr = ncrsStore.find(n => n.id === ncrIdOrNumber || n.ncrNumber === ncrIdOrNumber);
  if (!ncr) {
    return { ok: false, statusCode: 404, error: `گزارش عدم انطباق «${ncrIdOrNumber}» یافت نشد.` };
  }
  if (ncr.status === 'CLOSED') {
    return { ok: false, statusCode: 409, error: `گزارش عدم انطباق «${ncr.ncrNumber}» قبلاً بسته شده است.` };
  }

  const part = bridge.parts.find(p => p.id === ncr.partId);
  const weightPerUnit = ncr.unit === 'KG' ? 1 : Number(part?.weightPerUnitKg || 1);
  const matchedCoil = ncr.physicalCoilId
    ? bridge.coils.find(c => c.id === ncr.physicalCoilId)
    : ncr.coilId
    ? bridge.coils.find(c => c.coilId === ncr.coilId)
    : undefined;
  const matchedBalance = resolveMatchingBalance(bridge, {
    balanceId: ncr.balanceId,
    partId: ncr.partId,
    warehouseId: ncr.warehouseId,
    lotNumber: ncr.lotNumber,
    coilId: ncr.coilId,
  });

  const now = new Date().toISOString();
  let resultDoc: InventoryDocument | undefined;
  let reworkOrder: ReworkOrderRecord | undefined;

  if (input.disposition === 'USE_AS_IS') {
    // Release held stock to Unrestricted (321) under concession
    if (matchedBalance) {
      const heldTotal = round3(matchedBalance.qualityInspectionQty + matchedBalance.blockedQty);
      const releaseQty = round3(Math.min(ncr.affectedQty, heldTotal));
      if (releaseQty > EPS) {
        const res321 = await bridge.executeQmTransfer({
          key: matchedBalance.id,
          partId: ncr.partId,
          partCode: ncr.partCode,
          warehouseId: matchedBalance.warehouseId,
          locationCode: matchedBalance.locationCode,
          lotNumber: matchedBalance.lotNumber,
          physicalCoilId: matchedCoil?.id,
          ownership: matchedBalance.ownership,
          contractId: matchedBalance.contractId,
          isHeld: false,
          movementType: '321',
          heldQty: releaseQty,
          heldWeightKg: round3(releaseQty * weightPerUnit),
          reasonFa: `ترخیص با ارفاق (Use-As-Is) بابت ${ncr.ncrNumber}${input.dispositionNotes ? ` — ${input.dispositionNotes}` : ''}`,
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:321` : undefined,
          user: input.user,
        });
        if (!res321.success) {
          return { ok: false, statusCode: res321.statusCode || 409, error: res321.error };
        }
        resultDoc = res321.document;
      }
    } else if (matchedCoil) {
      matchedCoil.qualityStatus = 'AVAILABLE';
      matchedCoil.physicalStatus = matchedCoil.remainingWeightKg > EPS ? 'AVAILABLE' : 'CONSUMED';
    }
    ncr.status = 'CLOSED';
    ncr.closedAt = now;
    ncr.closedByName = input.user.displayName;
  } else if (input.disposition === 'REWORK') {
    // Keep affected stock contained in QI/Blocked and create a traceable ReworkOrder
    if (matchedBalance && matchedBalance.qualityInspectionQty + matchedBalance.blockedQty < ncr.affectedQty - EPS) {
      const needHold = round3(
        Math.min(
          ncr.affectedQty - (matchedBalance.qualityInspectionQty + matchedBalance.blockedQty),
          matchedBalance.availableQty
        )
      );
      if (needHold > EPS) {
        const holdRes = await bridge.executeQmTransfer({
          key: matchedBalance.id,
          partId: ncr.partId,
          partCode: ncr.partCode,
          warehouseId: matchedBalance.warehouseId,
          locationCode: matchedBalance.locationCode,
          lotNumber: matchedBalance.lotNumber,
          physicalCoilId: matchedCoil?.id,
          ownership: matchedBalance.ownership,
          contractId: matchedBalance.contractId,
          isHeld: true,
          holdType: 'BLOCKED',
          movementType: '344',
          heldQty: needHold,
          heldWeightKg: round3(needHold * weightPerUnit),
          reasonFa: `قفل موجودی برای دستور دوباره‌کاری ${ncr.ncrNumber}`,
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:344` : undefined,
          user: input.user,
        });
        if (!holdRes.success) {
          return { ok: false, statusCode: holdRes.statusCode || 409, error: holdRes.error };
        }
        resultDoc = holdRes.document;
      }
    }

    const reworkNumber = makeDocNumber('RWK');
    reworkOrder = {
      id: `RWK-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
      reworkNumber,
      ncrId: ncr.id,
      ncrNumber: ncr.ncrNumber,
      inspectionId: ncr.inspectionId,
      partId: ncr.partId,
      partCode: ncr.partCode,
      partName: ncr.partName,
      warehouseId: ncr.warehouseId,
      locationCode: ncr.locationCode,
      balanceId: ncr.balanceId,
      lotNumber: ncr.lotNumber,
      physicalCoilId: ncr.physicalCoilId,
      coilId: ncr.coilId,
      manufacturingOrderId: ncr.manufacturingOrderId,
      moNumber: ncr.moNumber,
      sourceOperationCode: ncr.operationCode,
      targetOperationCode: input.targetOperationCode || ncr.operationCode || 'OP-REWORK',
      ownership: ncr.ownership,
      contractId: ncr.contractId,
      contractNumber: ncr.contractNumber,
      plannedReworkQty: round3(ncr.affectedQty),
      completedGoodQty: 0,
      scrappedQty: 0,
      remainingQty: round3(ncr.affectedQty),
      unit: ncr.unit,
      weightKg: ncr.weightKg,
      status: 'OPEN',
      instructions:
        String(input.reworkInstructions || '').trim() ||
        `اصلاح و دوباره‌کاری بابت ${ncr.ncrNumber}: ${ncr.defectLabelFa}`,
      returnToProduction: input.returnToProduction !== false,
      assignedToName: input.assignedToName,
      createdByUid: input.user.uid,
      createdByName: input.user.displayName,
      createdAt: now,
      updatedAt: now,
    };
    reworkOrdersStore.unshift(reworkOrder);
    ncr.linkedReworkOrderId = reworkOrder.id;
    ncr.linkedReworkNumber = reworkOrder.reworkNumber;
    ncr.status = 'IN_REWORK';
  } else if (input.disposition === 'SCRAP' || input.disposition === 'RETURN_TO_SUPPLIER') {
    const isScrap = input.disposition === 'SCRAP';
    if (matchedBalance) {
      // Determine which quality bucket holds the defective stock so stock equation stays 100% exact
      const sourceBucketStatus: StockQualityStatus =
        matchedBalance.blockedQty >= ncr.affectedQty - EPS
          ? 'QUALITY_BLOCKED'
          : matchedBalance.qualityInspectionQty >= ncr.affectedQty - EPS
          ? 'QUARANTINE'
          : matchedBalance.blockedQty > EPS
          ? 'QUALITY_BLOCKED'
          : matchedBalance.qualityInspectionQty > EPS
          ? 'QUARANTINE'
          : 'AVAILABLE';

      const maxDeductibleInBucket =
        sourceBucketStatus === 'QUALITY_BLOCKED'
          ? matchedBalance.blockedQty
          : sourceBucketStatus === 'QUARANTINE'
          ? matchedBalance.qualityInspectionQty
          : matchedBalance.availableQty;

      const writeOffQty = round3(Math.min(ncr.affectedQty, maxDeductibleInBucket));
      if (writeOffQty > EPS) {
        const adjRes = await bridge.postQualityAdjustment({
          partId: ncr.partId,
          warehouseId: matchedBalance.warehouseId,
          locationCode: matchedBalance.locationCode,
          lotNumber: matchedBalance.lotNumber,
          physicalCoilId: matchedCoil?.id,
          ownership: matchedBalance.ownership,
          contractId: matchedBalance.contractId,
          contractNumber: matchedBalance.contractNumber,
          quantityDelta: -writeOffQty,
          qualityStatus: sourceBucketStatus,
          referenceType: isScrap ? 'QUALITY_SCRAP' : 'SUPPLIER_RETURN',
          referenceNumber: ncr.ncrNumber,
          reasonFa: isScrap
            ? `اسقاط و انتقال به ضایعات بابت عدم انطباق ${ncr.ncrNumber} (${ncr.defectLabelFa})`
            : `مرجوعی به تأمین‌کننده بابت عدم انطباق ${ncr.ncrNumber} (${ncr.supplierName || 'تأمین‌کننده'})`,
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:ADJ` : undefined,
          creditScrapWarehouse: isScrap,
          markCoilReturned: !isScrap,
          user: input.user,
        });
        if (!adjRes.success) {
          return { ok: false, statusCode: adjRes.statusCode || 409, error: adjRes.error };
        }
        resultDoc = adjRes.document;
      }
    } else if (matchedCoil) {
      matchedCoil.remainingWeightKg = round3(Math.max(0, matchedCoil.remainingWeightKg - ncr.weightKg));
      matchedCoil.qualityStatus = 'REJECTED';
      matchedCoil.physicalStatus = !isScrap && matchedCoil.remainingWeightKg <= EPS ? 'RETURNED' : 'CONSUMED';
    }

    if (isScrap) {
      ncr.scrappedQty = round3(ncr.scrappedQty + ncr.affectedQty);
    } else {
      ncr.returnedToSupplierQty = round3(ncr.returnedToSupplierQty + ncr.affectedQty);
    }
    ncr.status = 'CLOSED';
    ncr.closedAt = now;
    ncr.closedByName = input.user.displayName;
  } else if (input.disposition === 'SORT_REINSPECT') {
    const sortedGood = Number(input.sortedGoodQty ?? 0);
    const sortedDefect = Number(input.sortedDefectQty ?? Math.max(0, ncr.affectedQty - sortedGood));
    if (!Number.isFinite(sortedGood) || !Number.isFinite(sortedDefect) || sortedGood < 0 || sortedDefect < 0) {
      return { ok: false, statusCode: 400, error: 'مقادیر تفکیک سالم و معیوب باید نامنفی باشند.' };
    }
    if (sortedGood + sortedDefect > ncr.affectedQty + EPS) {
      return { ok: false, statusCode: 400, error: 'مجموع مقادیر تفکیک‌شده از مقدار کل عدم انطباق بیشتر است.' };
    }
    if (matchedBalance && sortedGood > EPS) {
      const heldTotal = round3(matchedBalance.qualityInspectionQty + matchedBalance.blockedQty);
      const relQty = round3(Math.min(sortedGood, heldTotal));
      if (relQty > EPS) {
        const res321 = await bridge.executeQmTransfer({
          key: matchedBalance.id,
          partId: ncr.partId,
          partCode: ncr.partCode,
          warehouseId: matchedBalance.warehouseId,
          locationCode: matchedBalance.locationCode,
          lotNumber: matchedBalance.lotNumber,
          physicalCoilId: matchedCoil?.id,
          ownership: matchedBalance.ownership,
          contractId: matchedBalance.contractId,
          isHeld: false,
          movementType: '321',
          heldQty: relQty,
          heldWeightKg: round3(relQty * weightPerUnit),
          reasonFa: `ترخیص بخش سالم پس از تفکیک (Sort & Reinspect) بابت ${ncr.ncrNumber}`,
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:SORT321` : undefined,
          user: input.user,
        });
        if (!res321.success) {
          return { ok: false, statusCode: res321.statusCode || 409, error: res321.error };
        }
        resultDoc = res321.document;
      }
    }
    ncr.reworkedGoodQty = round3(ncr.reworkedGoodQty + sortedGood);
    if (sortedDefect > EPS && matchedBalance) {
      const sourceBucket: StockQualityStatus =
        matchedBalance.blockedQty >= sortedDefect - EPS
          ? 'QUALITY_BLOCKED'
          : matchedBalance.qualityInspectionQty >= sortedDefect - EPS
          ? 'QUARANTINE'
          : 'AVAILABLE';
      const adjRes = await bridge.postQualityAdjustment({
        partId: ncr.partId,
        warehouseId: matchedBalance.warehouseId,
        locationCode: matchedBalance.locationCode,
        lotNumber: matchedBalance.lotNumber,
        physicalCoilId: matchedCoil?.id,
        ownership: matchedBalance.ownership,
        contractId: matchedBalance.contractId,
        contractNumber: matchedBalance.contractNumber,
        quantityDelta: -sortedDefect,
        qualityStatus: sourceBucket,
        referenceType: 'QUALITY_SCRAP',
        referenceNumber: ncr.ncrNumber,
        reasonFa: `اسقاط بخش معیوب پس از تفکیک (Sort) بابت ${ncr.ncrNumber}`,
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:SORTSCRAP` : undefined,
        creditScrapWarehouse: true,
        user: input.user,
      });
      if (!adjRes.success) {
        return { ok: false, statusCode: adjRes.statusCode || 409, error: adjRes.error };
      }
      resultDoc = adjRes.document || resultDoc;
      ncr.scrappedQty = round3(ncr.scrappedQty + sortedDefect);
    }
    ncr.status = 'CLOSED';
    ncr.closedAt = now;
    ncr.closedByName = input.user.displayName;
  }

  ncr.disposition = input.disposition;
  if (input.rootCause !== undefined) ncr.rootCause = input.rootCause;
  if (input.correctiveAction !== undefined) ncr.correctiveAction = input.correctiveAction;
  if (input.dispositionNotes !== undefined) ncr.dispositionNotes = input.dispositionNotes;
  ncr.dispositionedAt = now;
  ncr.dispositionedByName = input.user.displayName;
  if (resultDoc?.documentNumber) ncr.dispositionDocNumber = resultDoc.documentNumber;
  ncr.updatedAt = now;

  bridge.recordAudit({
    action: 'NCR_DISPOSITION',
    entityName: 'Nonconformance',
    entityId: ncr.ncrNumber,
    user: input.user,
    details: `تعیین تکلیف «${ncr.disposition}» برای ${ncr.ncrNumber}${reworkOrder ? ` | دستور دوباره‌کاری: ${reworkOrder.reworkNumber}` : ''}`,
  });
  await bridge.persist();

  const responsePayload = { ncr, reworkOrder, document: resultDoc };
  saveQualityIdempotency('DISPOSITION_NCR', input.idempotencyKey, fpPayload, 200, responsePayload);
  return { ok: true, statusCode: 200, idempotentReplay: false, ...responsePayload };
}

// =========================================================================
// 4. Complete Rework Order & Return to Production / Scrap Remainder
// =========================================================================
export async function completeReworkOrder(
  reworkIdOrNumber: string,
  input: {
    goodQty: number;
    scrapQty?: number;
    returnToProduction?: boolean;
    completionNotes?: string;
    idempotencyKey?: string;
    user: { uid: string; displayName: string };
  },
  bridge: QualityInventoryBridge
): Promise<{
  ok: boolean;
  statusCode: number;
  error?: string;
  idempotentReplay?: boolean;
  reworkOrder?: ReworkOrderRecord;
  ncr?: NonconformanceRecord;
  releaseDocument?: InventoryDocument;
  scrapDocument?: InventoryDocument;
}> {
  const goodQty = Number(input.goodQty || 0);
  const scrapQty = Number(input.scrapQty || 0);
  if (!Number.isFinite(goodQty) || !Number.isFinite(scrapQty) || goodQty < 0 || scrapQty < 0) {
    return { ok: false, statusCode: 400, error: 'مقادیر سالم و ضایعات دوباره‌کاری باید نامنفی باشند.' };
  }
  if (goodQty + scrapQty <= EPS) {
    return { ok: false, statusCode: 400, error: 'حداقل یکی از مقادیر سالم یا ضایعات باید بزرگتر از صفر باشد.' };
  }

  const fpPayload = {
    id: reworkIdOrNumber,
    goodQty,
    scrapQty,
    returnToProduction: Boolean(input.returnToProduction),
  };
  if (isQualityPostgresPersistenceActive()) {
    return completeReworkOrderInDb(reworkIdOrNumber, input, bridge, fpPayload);
  }
  const idem = checkQualityIdempotency('COMPLETE_REWORK', input.idempotencyKey, fpPayload);
  if (idem.hit) {
    if (idem.conflict) return { ok: false, statusCode: 409, error: idem.error };
    return { ok: true, statusCode: 200, idempotentReplay: true, ...idem.response };
  }

  const rw = reworkOrdersStore.find(r => r.id === reworkIdOrNumber || r.reworkNumber === reworkIdOrNumber);
  if (!rw) {
    return { ok: false, statusCode: 404, error: `دستور دوباره‌کاری «${reworkIdOrNumber}» یافت نشد.` };
  }
  if (rw.status === 'COMPLETED' || rw.status === 'CANCELLED') {
    return { ok: false, statusCode: 409, error: `دستور دوباره‌کاری «${rw.reworkNumber}» قبلاً بسته شده است.` };
  }
  if (goodQty + scrapQty > rw.remainingQty + EPS) {
    return {
      ok: false,
      statusCode: 409,
      error: `مجموع گزارش سالم (${goodQty}) و ضایعات (${scrapQty}) بیشتر از مانده دستور دوباره‌کاری (${rw.remainingQty}) است.`,
    };
  }

  const part = bridge.parts.find(p => p.id === rw.partId);
  const weightPerUnit = rw.unit === 'KG' ? 1 : Number(part?.weightPerUnitKg || 1);
  const matchedCoil = rw.physicalCoilId
    ? bridge.coils.find(c => c.id === rw.physicalCoilId)
    : rw.coilId
    ? bridge.coils.find(c => c.coilId === rw.coilId)
    : undefined;
  const matchedBalance = resolveMatchingBalance(bridge, {
    balanceId: rw.balanceId,
    partId: rw.partId,
    warehouseId: rw.warehouseId,
    lotNumber: rw.lotNumber,
    coilId: rw.coilId,
  });

  let releaseDocument: InventoryDocument | undefined;
  let scrapDocument: InventoryDocument | undefined;
  const shouldReturnToProduction = input.returnToProduction ?? rw.returnToProduction;

  // 1. Release reworked good quantity from Blocked/QI -> Unrestricted (321)
  if (goodQty > EPS && matchedBalance) {
    const heldTotal = round3(matchedBalance.qualityInspectionQty + matchedBalance.blockedQty);
    const releaseQty = round3(Math.min(goodQty, heldTotal));
    if (releaseQty > EPS) {
      const res321 = await bridge.executeQmTransfer({
        key: matchedBalance.id,
        partId: rw.partId,
        partCode: rw.partCode,
        warehouseId: matchedBalance.warehouseId,
        locationCode: matchedBalance.locationCode,
        lotNumber: matchedBalance.lotNumber,
        physicalCoilId: matchedCoil?.id,
        ownership: matchedBalance.ownership,
        contractId: matchedBalance.contractId,
        isHeld: false,
        movementType: '321',
        heldQty: releaseQty,
        heldWeightKg: round3(releaseQty * weightPerUnit),
        reasonFa: shouldReturnToProduction
          ? `تکمیل دوباره‌کاری ${rw.reworkNumber} و بازگشت به خط تولید${rw.moNumber ? ` (${rw.moNumber})` : ''}`
          : `تکمیل دوباره‌کاری ${rw.reworkNumber} و آزادسازی به موجودی انبار`,
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:321` : undefined,
        user: input.user,
      });
      if (!res321.success) {
        return { ok: false, statusCode: res321.statusCode || 409, error: res321.error };
      }
      releaseDocument = res321.document;
    }
  } else if (goodQty > EPS && matchedCoil) {
    matchedCoil.qualityStatus = 'AVAILABLE';
    matchedCoil.physicalStatus = matchedCoil.remainingWeightKg > EPS ? 'AVAILABLE' : 'CONSUMED';
  }

  // 2. Write off unrecoverable scrap from Blocked/QI
  if (scrapQty > EPS && matchedBalance) {
    const sourceBucket: StockQualityStatus =
      matchedBalance.blockedQty >= scrapQty - EPS
        ? 'QUALITY_BLOCKED'
        : matchedBalance.qualityInspectionQty >= scrapQty - EPS
        ? 'QUARANTINE'
        : matchedBalance.blockedQty > EPS
        ? 'QUALITY_BLOCKED'
        : matchedBalance.qualityInspectionQty > EPS
        ? 'QUARANTINE'
        : 'AVAILABLE';
    const maxDeductible =
      sourceBucket === 'QUALITY_BLOCKED'
        ? matchedBalance.blockedQty
        : sourceBucket === 'QUARANTINE'
        ? matchedBalance.qualityInspectionQty
        : matchedBalance.availableQty;
    const writeOffQty = round3(Math.min(scrapQty, maxDeductible));
    if (writeOffQty > EPS) {
      const adjRes = await bridge.postQualityAdjustment({
        partId: rw.partId,
        warehouseId: matchedBalance.warehouseId,
        locationCode: matchedBalance.locationCode,
        lotNumber: matchedBalance.lotNumber,
        physicalCoilId: matchedCoil?.id,
        ownership: matchedBalance.ownership,
        contractId: matchedBalance.contractId,
        contractNumber: matchedBalance.contractNumber,
        quantityDelta: -writeOffQty,
        qualityStatus: sourceBucket,
        referenceType: 'QUALITY_SCRAP',
        referenceNumber: rw.reworkNumber,
        reasonFa: `ضایعات غیرقابل اصلاح در دستور دوباره‌کاری ${rw.reworkNumber} (مرتبط با ${rw.ncrNumber})`,
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:SCRAP` : undefined,
        creditScrapWarehouse: true,
        user: input.user,
      });
      if (!adjRes.success) {
        return { ok: false, statusCode: adjRes.statusCode || 409, error: adjRes.error };
      }
      scrapDocument = adjRes.document;
    }
  }

  const now = new Date().toISOString();
  rw.completedGoodQty = round3(rw.completedGoodQty + goodQty);
  rw.scrappedQty = round3(rw.scrappedQty + scrapQty);
  rw.remainingQty = round3(Math.max(0, rw.plannedReworkQty - rw.completedGoodQty - rw.scrappedQty));
  rw.returnToProduction = shouldReturnToProduction;
  if (releaseDocument?.documentNumber) rw.returnDocumentNumber = releaseDocument.documentNumber;
  if (scrapDocument?.documentNumber) rw.scrapDocumentNumber = scrapDocument.documentNumber;
  if (input.completionNotes) rw.completionNotes = input.completionNotes;
  rw.status = rw.remainingQty <= EPS ? 'COMPLETED' : 'IN_PROGRESS';
  if (rw.status === 'COMPLETED') rw.completedAt = now;
  rw.updatedAt = now;

  // Update linked NCR progress and auto-close when fully resolved
  const linkedNcr = ncrsStore.find(n => n.id === rw.ncrId);
  if (linkedNcr) {
    linkedNcr.reworkedGoodQty = round3(linkedNcr.reworkedGoodQty + goodQty);
    linkedNcr.scrappedQty = round3(linkedNcr.scrappedQty + scrapQty);
    if (shouldReturnToProduction) {
      linkedNcr.returnedToProductionQty = round3(linkedNcr.returnedToProductionQty + goodQty);
    }
    const totalResolved = round3(
      linkedNcr.reworkedGoodQty + linkedNcr.scrappedQty + linkedNcr.returnedToSupplierQty
    );
    if (totalResolved + EPS >= linkedNcr.affectedQty) {
      linkedNcr.status = 'CLOSED';
      linkedNcr.closedAt = now;
      linkedNcr.closedByName = input.user.displayName;
    }
    linkedNcr.updatedAt = now;
  }

  bridge.recordAudit({
    action: 'REWORK_COMPLETE',
    entityName: 'ReworkOrder',
    entityId: rw.reworkNumber,
    user: input.user,
    details: `ثبت نتیجه دوباره‌کاری ${rw.reworkNumber}: سالم ${goodQty}، ضایعات ${scrapQty}، بازگشت به تولید: ${shouldReturnToProduction ? 'بله' : 'خیر'}`,
  });
  await bridge.persist();

  const responsePayload = {
    reworkOrder: rw,
    ncr: linkedNcr,
    releaseDocument,
    scrapDocument,
  };
  saveQualityIdempotency('COMPLETE_REWORK', input.idempotencyKey, fpPayload, 200, responsePayload);
  return { ok: true, statusCode: 200, idempotentReplay: false, ...responsePayload };
}

// =========================================================================
// 5. Quality Status & Traceability History by Lot / Coil / MO / Product
// =========================================================================
export interface QualityEntityHistoryParams {
  lotNumber?: string;
  coilId?: string;
  moNumber?: string;
  partId?: string;
  partCode?: string;
  balances: DetailedStockBalance[];
  coils: PhysicalCoil[];
  documents: InventoryDocument[];
}

export function getQualityEntityHistory(params: QualityEntityHistoryParams): QualityEntityHistoryResponse {
  return computeQualityEntityHistoryFromRecords(params, inspectionsStore, ncrsStore, reworkOrdersStore);
}

export async function getQualityEntityHistoryAsync(
  params: QualityEntityHistoryParams
): Promise<QualityEntityHistoryResponse> {
  if (isQualityPostgresPersistenceActive()) {
    const { inspections, ncrs, reworkOrders } = await dbLoadAllQualityRecords();
    return computeQualityEntityHistoryFromRecords(params, inspections, ncrs, reworkOrders);
  }
  return computeQualityEntityHistoryFromRecords(params, inspectionsStore, ncrsStore, reworkOrdersStore);
}

function computeQualityEntityHistoryFromRecords(
  params: QualityEntityHistoryParams,
  allInspections: QualityInspectionRecord[],
  allNcrs: NonconformanceRecord[],
  allReworkOrders: ReworkOrderRecord[]
): QualityEntityHistoryResponse {
  const lotQ = params.lotNumber?.trim().toLowerCase();
  const coilQ = params.coilId?.trim().toLowerCase();
  const moQ = params.moNumber?.trim().toLowerCase();
  const partIdQ = params.partId?.trim();
  const partCodeQ = params.partCode?.trim().toLowerCase();

  const hasFilter = Boolean(lotQ || coilQ || moQ || partIdQ || partCodeQ);

  const matchingCoils = params.coils.filter(c => {
    if (!hasFilter) return true;
    const matchCoil = coilQ
      ? c.id.toLowerCase() === coilQ ||
        c.coilId.toLowerCase().includes(coilQ) ||
        (c.coilPackNumber || '').toLowerCase().includes(coilQ)
      : true;
    const matchLot = lotQ
      ? c.coilId.toLowerCase().includes(lotQ) || (c.coilPackNumber || '').toLowerCase().includes(lotQ)
      : true;
    const matchPart = partIdQ ? c.partId === partIdQ : partCodeQ ? (c.partCode || '').toLowerCase() === partCodeQ : true;
    return matchCoil && matchLot && matchPart;
  });

  const matchingBalances = params.balances.filter(b => {
    if (!hasFilter) return true;
    const matchLot = lotQ ? (b.lotNumber || '').toLowerCase().includes(lotQ) : true;
    const matchCoil = coilQ ? (b.lotNumber || '').toLowerCase().includes(coilQ) : true;
    const matchPart = partIdQ ? b.partId === partIdQ : partCodeQ ? b.partCode.toLowerCase() === partCodeQ : true;
    return matchLot && matchCoil && matchPart;
  });

  const inspections = filterQualityInspectionsList(allInspections, {
    lotNumber: params.lotNumber,
    coilId: params.coilId,
    moNumber: params.moNumber,
    partId: params.partId || params.partCode,
  });

  const ncrs = filterNonconformancesList(allNcrs, {
    lotNumber: params.lotNumber,
    coilId: params.coilId,
    moNumber: params.moNumber,
    partId: params.partId || params.partCode,
  });

  const reworkOrders = allReworkOrders.filter(r => {
    if (!hasFilter) return true;
    const matchLot = lotQ ? (r.lotNumber || '').toLowerCase().includes(lotQ) : true;
    const matchCoil = coilQ
      ? (r.physicalCoilId || '').toLowerCase() === coilQ || (r.coilId || '').toLowerCase().includes(coilQ)
      : true;
    const matchMo = moQ
      ? (r.moNumber || '').toLowerCase().includes(moQ) || (r.manufacturingOrderId || '').toLowerCase() === moQ
      : true;
    const matchPart = partIdQ
      ? r.partId === partIdQ
      : partCodeQ
      ? r.partCode.toLowerCase() === partCodeQ
      : true;
    return matchLot && matchCoil && matchMo && matchPart;
  });

  const qmDocs = params.documents.filter(d => {
    if (d.documentType !== 'STOCK_STATUS_TRANSFER' && d.referenceType !== 'QUALITY_SCRAP' && d.referenceType !== 'SUPPLIER_RETURN') {
      return false;
    }
    if (!hasFilter) return true;
    return d.lines.some(l => {
      const matchLot = lotQ ? (l.lotNumber || '').toLowerCase().includes(lotQ) : true;
      const matchCoil = coilQ
        ? (l.physicalCoilId || '').toLowerCase() === coilQ ||
          (l.coilId || '').toLowerCase().includes(coilQ) ||
          (l.lotNumber || '').toLowerCase().includes(coilQ)
        : true;
      const matchMo = moQ ? (d.referenceNumber || '').toLowerCase().includes(moQ) : true;
      const matchPart = partIdQ ? l.partId === partIdQ : partCodeQ ? l.partCode.toLowerCase() === partCodeQ : true;
      return matchLot && matchCoil && matchMo && matchPart;
    });
  });

  // Determine unified current quality status
  const physicalQty = round3(matchingBalances.reduce((s, b) => s + Number(b.physicalQty || 0), 0));
  const availableQty = round3(matchingBalances.reduce((s, b) => s + Number(b.availableQty || 0), 0));
  const qualityInspectionQty = round3(matchingBalances.reduce((s, b) => s + Number(b.qualityInspectionQty || 0), 0));
  const blockedQty = round3(matchingBalances.reduce((s, b) => s + Number(b.blockedQty || 0), 0));

  let currentQualityStatus: StockQualityStatus | 'MIXED' | 'UNKNOWN' = 'UNKNOWN';
  if (matchingCoils.length === 1 && matchingBalances.length === 0) {
    currentQualityStatus = matchingCoils[0].qualityStatus;
  } else if (physicalQty > EPS) {
    const activeBuckets = [
      availableQty > EPS ? 'AVAILABLE' : null,
      qualityInspectionQty > EPS ? 'QUARANTINE' : null,
      blockedQty > EPS ? 'QUALITY_BLOCKED' : null,
    ].filter(Boolean) as StockQualityStatus[];
    if (activeBuckets.length > 1) {
      currentQualityStatus = 'MIXED';
    } else if (activeBuckets.length === 1) {
      currentQualityStatus = activeBuckets[0];
    }
  } else if (matchingCoils.length > 0) {
    const statuses = new Set(matchingCoils.map(c => c.qualityStatus));
    currentQualityStatus = statuses.size === 1 ? matchingCoils[0].qualityStatus : 'MIXED';
  }

  const timeline: QualityHistoryEvent[] = [];

  for (const ins of inspections) {
    timeline.push({
      id: `EV-INS-C-${ins.id}`,
      timestamp: ins.createdAt,
      eventType: 'INSPECTION_CREATED',
      referenceNumber: ins.inspectionNumber,
      status: ins.status,
      titleFa: `${INSPECTION_TYPE_LABELS_FA[ins.inspectionType]} — ${ins.partCode}`,
      detailFa: `بازرسی ${ins.inspectedQty} ${ins.unit}${ins.lotNumber ? ` | بچ ${ins.lotNumber}` : ''}${ins.moNumber ? ` | ${ins.moNumber}` : ''}`,
      actorName: ins.inspectorName,
      quantity: ins.inspectedQty,
      unit: ins.unit,
    });
    if (ins.decidedAt && ins.decision !== 'PENDING') {
      timeline.push({
        id: `EV-INS-D-${ins.id}`,
        timestamp: ins.decidedAt,
        eventType: 'INSPECTION_DECIDED',
        referenceNumber: ins.inspectionNumber,
        status: ins.decision,
        titleFa: `تصمیم کیفی (${ins.decision}) — ${ins.inspectionNumber}`,
        detailFa: `قبول: ${ins.acceptedQty} | مردود: ${ins.rejectedQty} | دوباره‌کاری: ${ins.reworkQty}${ins.linkedQmDocumentNumber ? ` | سند QM: ${ins.linkedQmDocumentNumber}` : ''}`,
        actorName: ins.inspectorName,
        quantity: ins.inspectedQty,
        unit: ins.unit,
      });
    }
  }

  for (const ncr of ncrs) {
    timeline.push({
      id: `EV-NCR-O-${ncr.id}`,
      timestamp: ncr.createdAt,
      eventType: 'NCR_OPENED',
      referenceNumber: ncr.ncrNumber,
      status: ncr.severity,
      titleFa: `ثبت عدم انطباق ${ncr.ncrNumber} (${ncr.defectLabelFa})`,
      detailFa: ncr.description,
      actorName: ncr.createdByName,
      quantity: ncr.affectedQty,
      unit: ncr.unit,
    });
    if (ncr.containedAt) {
      timeline.push({
        id: `EV-NCR-C-${ncr.id}`,
        timestamp: ncr.containedAt,
        eventType: 'NCR_CONTAINED',
        referenceNumber: ncr.ncrNumber,
        status: 'CONTAINED',
        titleFa: `مهار و قرنطینه ${ncr.ncrNumber}`,
        detailFa: ncr.containmentAction || 'مهار موجودی در انبار',
        actorName: ncr.containedByName || ncr.createdByName,
        quantity: ncr.containedQty,
        unit: ncr.unit,
      });
    }
    if (ncr.dispositionedAt) {
      timeline.push({
        id: `EV-NCR-D-${ncr.id}`,
        timestamp: ncr.dispositionedAt,
        eventType: 'NCR_DISPOSITIONED',
        referenceNumber: ncr.ncrNumber,
        status: ncr.disposition,
        titleFa: `تعیین تکلیف (${ncr.disposition}) — ${ncr.ncrNumber}`,
        detailFa: ncr.dispositionNotes || ncr.correctiveAction || `سند مرتبط: ${ncr.dispositionDocNumber || ncr.linkedReworkNumber || '-'}`,
        actorName: ncr.dispositionedByName || ncr.createdByName,
        quantity: ncr.affectedQty,
        unit: ncr.unit,
      });
    }
  }

  for (const rw of reworkOrders) {
    timeline.push({
      id: `EV-RWK-C-${rw.id}`,
      timestamp: rw.createdAt,
      eventType: 'REWORK_CREATED',
      referenceNumber: rw.reworkNumber,
      status: rw.status,
      titleFa: `صدور دستور دوباره‌کاری ${rw.reworkNumber} (${rw.ncrNumber})`,
      detailFa: rw.instructions,
      actorName: rw.createdByName,
      quantity: rw.plannedReworkQty,
      unit: rw.unit,
    });
    if (rw.completedAt) {
      timeline.push({
        id: `EV-RWK-F-${rw.id}`,
        timestamp: rw.completedAt,
        eventType: 'REWORK_COMPLETED',
        referenceNumber: rw.reworkNumber,
        status: 'COMPLETED',
        titleFa: `تکمیل دوباره‌کاری ${rw.reworkNumber}`,
        detailFa: `سالم برگشتی: ${rw.completedGoodQty} | ضایعات: ${rw.scrappedQty}${rw.returnDocumentNumber ? ` | سند ترخیص: ${rw.returnDocumentNumber}` : ''}`,
        actorName: rw.assignedToName || rw.createdByName,
        quantity: rw.completedGoodQty,
        unit: rw.unit,
      });
    }
  }

  for (const doc of qmDocs) {
    timeline.push({
      id: `EV-QM-${doc.id}`,
      timestamp: doc.postedAt || doc.documentDate,
      eventType: 'QM_STOCK_TRANSFER',
      referenceNumber: doc.documentNumber,
      status: doc.movementType || doc.documentType,
      titleFa: `سند انبار کیفی ${doc.documentNumber} (MvT ${doc.movementType || '-'})`,
      detailFa: doc.adjustmentReason || doc.auditNote || doc.movementLabel || doc.documentType,
      actorName: doc.postedByName || doc.createdByName,
      quantity: doc.totalQuantity,
      unit: doc.lines[0]?.unit,
    });
  }

  timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return {
    filters: {
      lotNumber: params.lotNumber,
      coilId: params.coilId,
      moNumber: params.moNumber,
      partId: params.partId,
      partCode: params.partCode,
    },
    currentQualityStatus,
    stockSummary: {
      physicalQty,
      availableQty,
      qualityInspectionQty,
      blockedQty,
      matchingBalancesCount: matchingBalances.length,
      matchingCoilsCount: matchingCoils.length,
    },
    inspections,
    ncrs,
    reworkOrders,
    timeline,
  };
}

// =========================================================================
// 6. Quality Dashboard, Recurring Issues, Supplier Performance & CSV Export
// =========================================================================
export interface QualityDashboardAnalyticsParams {
  balances: DetailedStockBalance[];
  coils: PhysicalCoil[];
  shopFloorScrapQtyTotal?: number;
  filters?: {
    startDate?: string;
    endDate?: string;
    partId?: string;
    supplierName?: string;
    inspectionType?: string;
  };
}

export function computeQualityDashboardAnalytics(
  params: QualityDashboardAnalyticsParams
): QualityDashboardAnalytics {
  return computeQualityDashboardAnalyticsFromRecords(params, inspectionsStore, ncrsStore, reworkOrdersStore);
}

export async function computeQualityDashboardAnalyticsAsync(
  params: QualityDashboardAnalyticsParams
): Promise<QualityDashboardAnalytics> {
  if (isQualityPostgresPersistenceActive()) {
    const { inspections, ncrs, reworkOrders } = await dbLoadAllQualityRecords();
    return computeQualityDashboardAnalyticsFromRecords(params, inspections, ncrs, reworkOrders);
  }
  return computeQualityDashboardAnalyticsFromRecords(params, inspectionsStore, ncrsStore, reworkOrdersStore);
}

function computeQualityDashboardAnalyticsFromRecords(
  params: QualityDashboardAnalyticsParams,
  allInspections: QualityInspectionRecord[],
  allNcrs: NonconformanceRecord[],
  allReworkOrders: ReworkOrderRecord[]
): QualityDashboardAnalytics {
  const f = params.filters || {};
  const startMs = f.startDate ? new Date(f.startDate).getTime() : null;
  const endMs = f.endDate ? new Date(f.endDate).getTime() + 86_399_999 : null;

  const inRange = (iso: string) => {
    const t = new Date(iso).getTime();
    if (startMs && Number.isFinite(startMs) && t < startMs) return false;
    if (endMs && Number.isFinite(endMs) && t > endMs) return false;
    return true;
  };

  const filteredInspections = allInspections.filter(ins => {
    if (!inRange(ins.createdAt)) return false;
    if (f.partId && ins.partId !== f.partId && ins.partCode !== f.partId) return false;
    if (f.supplierName && !(ins.supplierName || '').toLowerCase().includes(f.supplierName.toLowerCase())) return false;
    if (f.inspectionType && f.inspectionType !== 'ALL' && ins.inspectionType !== f.inspectionType) return false;
    return true;
  });

  const filteredNcrs = allNcrs.filter(ncr => {
    if (!inRange(ncr.createdAt)) return false;
    if (f.partId && ncr.partId !== f.partId && ncr.partCode !== f.partId) return false;
    if (f.supplierName && !(ncr.supplierName || '').toLowerCase().includes(f.supplierName.toLowerCase())) return false;
    return true;
  });

  const filteredReworks = allReworkOrders.filter(rw => {
    if (!inRange(rw.createdAt)) return false;
    if (f.partId && rw.partId !== f.partId && rw.partCode !== f.partId) return false;
    return true;
  });

  const completedInspections = filteredInspections.filter(i => i.status === 'COMPLETED');
  const pendingInspections = filteredInspections.filter(i => i.status !== 'COMPLETED');

  const totalInspectedQty = round3(filteredInspections.reduce((s, i) => s + i.inspectedQty, 0));
  const totalAcceptedQty = round3(filteredInspections.reduce((s, i) => s + i.acceptedQty, 0));
  const totalRejectedQty = round3(filteredInspections.reduce((s, i) => s + i.rejectedQty, 0));
  const totalReworkQty = round3(filteredInspections.reduce((s, i) => s + i.reworkQty, 0));

  const decidedQtyDenom = round3(totalAcceptedQty + totalRejectedQty + totalReworkQty);
  const overallRejectionRatePercent =
    decidedQtyDenom > EPS ? round2(((totalRejectedQty + totalReworkQty) / decidedQtyDenom) * 100) : null;

  // Stage breakdown (Incoming / In-Process / Final)
  const stageTypes: QualityInspectionType[] = ['INCOMING_MATERIAL', 'IN_PROCESS', 'FINAL_PRODUCT'];
  const byInspectionType = stageTypes.map(t => {
    const subset = filteredInspections.filter(i => i.inspectionType === t);
    const acceptedCount = subset.filter(
      i => i.decision === 'ACCEPTED' || i.decision === 'ACCEPTED_WITH_CONCESSION'
    ).length;
    const rejectedCount = subset.filter(i => i.decision === 'REJECTED').length;
    const quarantinedCount = subset.filter(i => i.decision === 'QUARANTINED').length;
    const inspectedQty = round3(subset.reduce((s, i) => s + i.inspectedQty, 0));
    const accQty = round3(subset.reduce((s, i) => s + i.acceptedQty, 0));
    const rejQty = round3(subset.reduce((s, i) => s + i.rejectedQty + i.reworkQty, 0));
    const denom = accQty + rejQty;
    const passRatePercent = denom > EPS ? round2((accQty / denom) * 100) : null;
    return {
      inspectionType: t,
      labelFa: INSPECTION_TYPE_LABELS_FA[t],
      totalCount: subset.length,
      acceptedCount,
      rejectedCount,
      quarantinedCount,
      inspectedQty,
      rejectedQty: rejQty,
      passRatePercent,
    };
  });

  // Defect Pareto & Recurring Issues
  const defectMap = new Map<string, QualityDefectParetoRow>();
  for (const ncr of filteredNcrs) {
    const existing = defectMap.get(ncr.defectCode) || {
      defectCode: ncr.defectCode,
      defectLabelFa: ncr.defectLabelFa,
      category: ncr.category,
      occurrenceCount: 0,
      affectedQty: 0,
      sharePercent: 0,
      isRecurring: false,
    };
    existing.occurrenceCount += 1;
    existing.affectedQty = round3(existing.affectedQty + ncr.affectedQty);
    defectMap.set(ncr.defectCode, existing);
  }
  const totalDefectOccurrences = Array.from(defectMap.values()).reduce((s, r) => s + r.occurrenceCount, 0);
  const defectPareto = Array.from(defectMap.values())
    .map(r => ({
      ...r,
      sharePercent: totalDefectOccurrences > 0 ? round2((r.occurrenceCount / totalDefectOccurrences) * 100) : 0,
      isRecurring: r.occurrenceCount >= 2,
    }))
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount || b.affectedQty - a.affectedQty);
  const recurringIssues = defectPareto.filter(d => d.isRecurring);

  // Category Breakdown
  const catMap = new Map<NonconformanceCategory, { ncrCount: number; affectedQty: number }>();
  for (const ncr of filteredNcrs) {
    const prev = catMap.get(ncr.category) || { ncrCount: 0, affectedQty: 0 };
    prev.ncrCount += 1;
    prev.affectedQty = round3(prev.affectedQty + ncr.affectedQty);
    catMap.set(ncr.category, prev);
  }
  const byCategory = Array.from(catMap.entries())
    .map(([category, vals]) => ({
      category,
      labelFa: NCR_CATEGORY_LABELS_FA[category] || category,
      ncrCount: vals.ncrCount,
      affectedQty: vals.affectedQty,
    }))
    .sort((a, b) => b.ncrCount - a.ncrCount);

  // Supplier Quality Performance Scorecard
  const supplierMap = new Map<string, QualitySupplierPerformanceRow>();
  const ensureSupplier = (name: string) => {
    const key = name.trim();
    if (!supplierMap.has(key)) {
      supplierMap.set(key, {
        supplierName: key,
        totalInspections: 0,
        acceptedInspections: 0,
        rejectedInspections: 0,
        quarantinedInspections: 0,
        totalInspectedQty: 0,
        totalRejectedQty: 0,
        rejectionRatePercent: null,
        openNcrCount: 0,
        totalNcrCount: 0,
        qualityScorePercent: null,
      });
    }
    return supplierMap.get(key)!;
  };

  for (const ins of filteredInspections) {
    if (!ins.supplierName) continue;
    const row = ensureSupplier(ins.supplierName);
    row.totalInspections += 1;
    if (ins.decision === 'ACCEPTED' || ins.decision === 'ACCEPTED_WITH_CONCESSION') row.acceptedInspections += 1;
    if (ins.decision === 'REJECTED') row.rejectedInspections += 1;
    if (ins.decision === 'QUARANTINED') row.quarantinedInspections += 1;
    row.totalInspectedQty = round3(row.totalInspectedQty + ins.inspectedQty);
    row.totalRejectedQty = round3(row.totalRejectedQty + ins.rejectedQty + ins.reworkQty);
  }
  for (const ncr of filteredNcrs) {
    if (!ncr.supplierName) continue;
    const row = ensureSupplier(ncr.supplierName);
    row.totalNcrCount += 1;
    if (ncr.status !== 'CLOSED') row.openNcrCount += 1;
  }
  const supplierPerformance = Array.from(supplierMap.values())
    .map(row => {
      const rejectionRatePercent =
        row.totalInspectedQty > EPS ? round2((row.totalRejectedQty / row.totalInspectedQty) * 100) : null;
      const qualityScorePercent =
        rejectionRatePercent !== null
          ? round2(Math.max(0, Math.min(100, 100 - rejectionRatePercent - row.openNcrCount * 2)))
          : null;
      return {
        ...row,
        rejectionRatePercent,
        qualityScorePercent,
      };
    })
    .sort((a, b) => (b.rejectionRatePercent ?? -1) - (a.rejectionRatePercent ?? -1));

  // Part Breakdown
  const partMap = new Map<
    string,
    {
      partId: string;
      partCode: string;
      partName: string;
      inspectionCount: number;
      ncrCount: number;
      inspectedQty: number;
      rejectedQty: number;
    }
  >();
  const ensurePart = (partId: string, partCode: string, partName: string) => {
    if (!partMap.has(partId)) {
      partMap.set(partId, {
        partId,
        partCode,
        partName,
        inspectionCount: 0,
        ncrCount: 0,
        inspectedQty: 0,
        rejectedQty: 0,
      });
    }
    return partMap.get(partId)!;
  };
  for (const ins of filteredInspections) {
    const row = ensurePart(ins.partId, ins.partCode, ins.partName);
    row.inspectionCount += 1;
    row.inspectedQty = round3(row.inspectedQty + ins.inspectedQty);
    row.rejectedQty = round3(row.rejectedQty + ins.rejectedQty + ins.reworkQty);
  }
  for (const ncr of filteredNcrs) {
    const row = ensurePart(ncr.partId, ncr.partCode, ncr.partName);
    row.ncrCount += 1;
  }
  const byPart = Array.from(partMap.values())
    .map(r => ({
      ...r,
      rejectionRatePercent: r.inspectedQty > EPS ? round2((r.rejectedQty / r.inspectedQty) * 100) : null,
    }))
    .sort((a, b) => b.ncrCount - a.ncrCount || b.rejectedQty - a.rejectedQty);

  const quarantinedStockQty = round3(
    params.balances.reduce((s, b) => s + Number(b.qualityInspectionQty || 0), 0)
  );
  const blockedStockQty = round3(
    params.balances.reduce((s, b) => s + Number(b.blockedQty || 0), 0)
  );
  const quarantinedStockKg = round3(
    params.balances.reduce((s, b) => s + Number(b.qualityInspectionKg || 0), 0)
  );
  const blockedStockKg = round3(
    params.balances.reduce((s, b) => s + Number(b.blockedKg || 0), 0)
  );

  const openNcrCount = filteredNcrs.filter(n => n.status !== 'CLOSED').length;
  const criticalOpenNcrCount = filteredNcrs.filter(
    n => n.status !== 'CLOSED' && n.severity === 'CRITICAL'
  ).length;
  const activeReworkOrdersCount = filteredReworks.filter(
    r => r.status === 'OPEN' || r.status === 'IN_PROGRESS'
  ).length;

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalInspections: filteredInspections.length,
      completedInspections: completedInspections.length,
      pendingInspections: pendingInspections.length,
      incomingAcceptanceRatePercent: byInspectionType[0].passRatePercent,
      inProcessPassRatePercent: byInspectionType[1].passRatePercent,
      finalPassRatePercent: byInspectionType[2].passRatePercent,
      overallRejectionRatePercent,
      totalInspectedQty,
      totalAcceptedQty,
      totalRejectedQty,
      totalReworkQty,
      openNcrCount,
      criticalOpenNcrCount,
      totalNcrCount: filteredNcrs.length,
      activeReworkOrdersCount,
      reworkedGoodQtyTotal: round3(filteredNcrs.reduce((s, n) => s + n.reworkedGoodQty, 0)),
      scrappedFromQcQtyTotal: round3(filteredNcrs.reduce((s, n) => s + n.scrappedQty, 0)),
      returnedToProductionQtyTotal: round3(filteredNcrs.reduce((s, n) => s + n.returnedToProductionQty, 0)),
      shopFloorScrapQtyTotal: round3(Number(params.shopFloorScrapQtyTotal || 0)),
      quarantinedStockQty,
      blockedStockQty,
      quarantinedStockKg,
      blockedStockKg,
      dataQualityNoteFa:
        decidedQtyDenom <= EPS
          ? 'هنوز برگه بازرسی تعیین‌تکلیف‌شده‌ای در این بازه ثبت نشده است؛ نرخ قبولی/رد فقط پس از ثبت بازرسی واقعی محاسبه می‌شود.'
          : undefined,
    },
    byInspectionType,
    defectPareto,
    recurringIssues,
    byCategory,
    supplierPerformance,
    byPart,
  };
}

function escapeCsvCell(val: unknown): string {
  const raw = val === null || val === undefined ? '' : String(val);
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function buildQualityReportCsv(analytics: QualityDashboardAnalytics): string {
  const lines: string[] = [];
  lines.push(['بخش گزارش', 'کد / عنوان', 'تعداد کل', 'مقدار بازرسی', 'مقدار مردود / نامنطبق', 'نرخ (٪)', 'وضعیت / توضیح'].map(escapeCsvCell).join(','));

  for (const stage of analytics.byInspectionType) {
    lines.push(
      [
        'عملکرد بازرسی',
        stage.labelFa,
        stage.totalCount,
        stage.inspectedQty,
        stage.rejectedQty,
        stage.passRatePercent ?? 'نامشخص',
        `قبول: ${stage.acceptedCount} | رد: ${stage.rejectedCount} | قرنطینه: ${stage.quarantinedCount}`,
      ]
        .map(escapeCsvCell)
        .join(',')
    );
  }

  for (const defect of analytics.defectPareto) {
    lines.push(
      [
        'پارتو عیوب (NCR)',
        `${defect.defectCode} - ${defect.defectLabelFa}`,
        defect.occurrenceCount,
        '-',
        defect.affectedQty,
        defect.sharePercent,
        defect.isRecurring ? 'عیب پرتکرار (Recurring)' : 'موردی',
      ]
        .map(escapeCsvCell)
        .join(',')
    );
  }

  for (const sup of analytics.supplierPerformance) {
    lines.push(
      [
        'عملکرد تأمین‌کننده',
        sup.supplierName,
        sup.totalInspections,
        sup.totalInspectedQty,
        sup.totalRejectedQty,
        sup.rejectionRatePercent ?? 'نامشخص',
        `امتیاز کیفی: ${sup.qualityScorePercent ?? '-'} | NCR باز: ${sup.openNcrCount}`,
      ]
        .map(escapeCsvCell)
        .join(',')
    );
  }

  return `\uFEFF${lines.join('\n')}`;
}

// =========================================================================
// 7. Authoritative PostgreSQL Transactional Persistence Executors (P6)
// =========================================================================

function deriveQualityStatusFromDecision(
  decision: QualityDecision,
  acceptedQty: number
): StockQualityStatus {
  if (decision === 'ACCEPTED' || decision === 'ACCEPTED_WITH_CONCESSION') return 'AVAILABLE';
  if (decision === 'QUARANTINED') return 'QUARANTINE';
  if (decision === 'REJECTED') return acceptedQty <= EPS ? 'REJECTED' : 'QUALITY_BLOCKED';
  return 'QUARANTINE';
}

async function applyInspectionDecisionInTx(
  tx: any,
  existingRow: any,
  input: DecideInspectionInput,
  bridge: QualityInventoryBridge
): Promise<{
  inspection: QualityInspectionRecord;
  ncr?: NonconformanceRecord;
  qmDocument?: InventoryDocument;
}> {
  if (existingRow.status === 'COMPLETED' && existingRow.decision !== 'QUARANTINED') {
    throw new QualityTxAbortError(
      409,
      `بازرسی «${existingRow.inspectionNumber}» قبلاً با تصمیم «${existingRow.decision}» نهایی شده است.`
    );
  }

  const inspectedQty = Number(existingRow.inspectedQty);
  let acceptedQty = input.acceptedQty !== undefined ? Number(input.acceptedQty) : 0;
  let rejectedQty = input.rejectedQty !== undefined ? Number(input.rejectedQty) : 0;
  let reworkQty = input.reworkQty !== undefined ? Number(input.reworkQty) : 0;

  if (input.acceptedQty === undefined && input.rejectedQty === undefined && input.reworkQty === undefined) {
    if (input.decision === 'ACCEPTED' || input.decision === 'ACCEPTED_WITH_CONCESSION') {
      acceptedQty = inspectedQty;
    } else if (input.decision === 'REJECTED') {
      rejectedQty = inspectedQty;
    } else if (input.decision === 'QUARANTINED') {
      acceptedQty = 0;
      rejectedQty = 0;
      reworkQty = 0;
    }
  }

  if (
    !Number.isFinite(acceptedQty) ||
    !Number.isFinite(rejectedQty) ||
    !Number.isFinite(reworkQty) ||
    acceptedQty < 0 ||
    rejectedQty < 0 ||
    reworkQty < 0
  ) {
    throw new QualityTxAbortError(400, 'مقادیر قبول، مردود و دوباره‌کاری باید نامنفی باشند.');
  }

  if (acceptedQty + rejectedQty + reworkQty > inspectedQty + EPS) {
    throw new QualityTxAbortError(
      400,
      `مجموع مقادیر قبول (${acceptedQty})، مردود (${rejectedQty}) و دوباره‌کاری (${reworkQty}) از کل مقدار بازرسی‌شده (${inspectedQty}) بیشتر است.`
    );
  }

  const partId = existingRow.partId || existingRow.partRefId;
  const part = bridge.parts.find(p => p.id === partId || p.code === existingRow.partCode);
  const weightPerUnit = existingRow.unit === 'KG' ? 1 : Number(part?.weightPerUnitKg || 1);
  const matchedCoil = (existingRow.physicalCoilId || existingRow.coilRefId)
    ? bridge.coils.find(c => c.id === existingRow.physicalCoilId || c.id === existingRow.coilRefId)
    : existingRow.coilId
    ? bridge.coils.find(c => c.coilId === existingRow.coilId)
    : undefined;
  const matchedBalance = resolveMatchingBalance(bridge, {
    balanceId: existingRow.balanceId || undefined,
    partId,
    warehouseId: existingRow.warehouseId || existingRow.warehouseRefId || undefined,
    lotNumber: existingRow.lotNumber || undefined,
    coilId: existingRow.coilId || undefined,
  });

  let qmDocument: InventoryDocument | undefined;
  const nonConformingQty = round3(rejectedQty + reworkQty);

  if (matchedBalance) {
    const heldInBalance = round3(matchedBalance.qualityInspectionQty + matchedBalance.blockedQty);
    if (
      (input.decision === 'ACCEPTED' || input.decision === 'ACCEPTED_WITH_CONCESSION' || acceptedQty > EPS) &&
      heldInBalance > EPS
    ) {
      const releaseQty = round3(Math.min(acceptedQty || heldInBalance, heldInBalance));
      if (releaseQty > EPS) {
        const res321 = await bridge.executeQmTransfer({
          key: matchedBalance.id,
          partId,
          partCode: existingRow.partCode,
          warehouseId: matchedBalance.warehouseId,
          locationCode: matchedBalance.locationCode,
          lotNumber: matchedBalance.lotNumber,
          physicalCoilId: matchedCoil?.id,
          ownership: matchedBalance.ownership,
          contractId: matchedBalance.contractId,
          isHeld: false,
          movementType: '321',
          heldQty: releaseQty,
          heldWeightKg: round3(releaseQty * weightPerUnit),
          reasonFa: `تایید و ترخیص کیفی برگه بازرسی ${existingRow.inspectionNumber}${input.notes ? ` — ${input.notes}` : ''}`,
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:321` : undefined,
          user: input.user,
        });
        if (!res321.success) {
          throw new QualityTxAbortError(res321.statusCode || 409, res321.error || 'خطا در ترخیص کیفی (321)');
        }
        qmDocument = res321.document;
      }
    }

    if (input.decision === 'QUARANTINED' && matchedBalance.availableQty > EPS) {
      const holdQty = round3(Math.min(inspectedQty, matchedBalance.availableQty));
      if (holdQty > EPS) {
        const res322 = await bridge.executeQmTransfer({
          key: matchedBalance.id,
          partId,
          partCode: existingRow.partCode,
          warehouseId: matchedBalance.warehouseId,
          locationCode: matchedBalance.locationCode,
          lotNumber: matchedBalance.lotNumber,
          physicalCoilId: matchedCoil?.id,
          ownership: matchedBalance.ownership,
          contractId: matchedBalance.contractId,
          isHeld: true,
          holdType: 'QUALITY_INSPECTION',
          movementType: '322',
          heldQty: holdQty,
          heldWeightKg: round3(holdQty * weightPerUnit),
          reasonFa: `قرنطینه کیفی بر اساس بازرسی ${existingRow.inspectionNumber}${input.defectSummary ? ` — ${input.defectSummary}` : ''}`,
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:322` : undefined,
          user: input.user,
        });
        if (!res322.success) {
          throw new QualityTxAbortError(res322.statusCode || 409, res322.error || 'خطا در قرنطینه کیفی (322)');
        }
        qmDocument = res322.document;
      }
    }

    if (nonConformingQty > EPS || input.decision === 'REJECTED') {
      const targetBlockQty = round3(nonConformingQty > EPS ? nonConformingQty : inspectedQty);
      const blockableNow = round3(matchedBalance.availableQty + matchedBalance.qualityInspectionQty);
      const qtyToBlock = round3(Math.min(targetBlockQty, blockableNow));
      if (qtyToBlock > EPS) {
        const res344 = await bridge.executeQmTransfer({
          key: matchedBalance.id,
          partId,
          partCode: existingRow.partCode,
          warehouseId: matchedBalance.warehouseId,
          locationCode: matchedBalance.locationCode,
          lotNumber: matchedBalance.lotNumber,
          physicalCoilId: matchedCoil?.id,
          ownership: matchedBalance.ownership,
          contractId: matchedBalance.contractId,
          isHeld: true,
          holdType: 'BLOCKED',
          movementType: '344',
          heldQty: qtyToBlock,
          heldWeightKg: round3(qtyToBlock * weightPerUnit),
          reasonFa: `رد و مسدودسازی کیفی بازرسی ${existingRow.inspectionNumber}${input.defectSummary ? ` — ${input.defectSummary}` : ''}`,
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:344` : undefined,
          user: input.user,
        });
        if (!res344.success) {
          throw new QualityTxAbortError(res344.statusCode || 409, res344.error || 'خطا در مسدودسازی کیفی (344)');
        }
        qmDocument = res344.document;
      }
    }
  } else if (matchedCoil) {
    if (input.decision === 'ACCEPTED' || input.decision === 'ACCEPTED_WITH_CONCESSION') {
      matchedCoil.qualityStatus = 'AVAILABLE';
      matchedCoil.physicalStatus = matchedCoil.remainingWeightKg > EPS ? 'AVAILABLE' : 'CONSUMED';
    } else if (input.decision === 'QUARANTINED') {
      matchedCoil.qualityStatus = 'QUARANTINE';
      matchedCoil.physicalStatus = 'BLOCKED';
    } else if (input.decision === 'REJECTED') {
      matchedCoil.qualityStatus = 'REJECTED';
      matchedCoil.physicalStatus = 'BLOCKED';
    }
  }

  if (matchedCoil && input.decision === 'REJECTED' && acceptedQty <= EPS) {
    matchedCoil.qualityStatus = 'REJECTED';
    matchedCoil.physicalStatus = 'BLOCKED';
  }

  const resultingQualityStatus = deriveQualityStatusFromDecision(input.decision, acceptedQty);
  await syncLinkedEntityQualityStatusInTx(tx, {
    physicalCoilId: existingRow.physicalCoilId,
    materialLotId: existingRow.materialLotId,
    qualityStatus: resultingQualityStatus,
    physicalStatus:
      resultingQualityStatus === 'AVAILABLE'
        ? matchedCoil && matchedCoil.remainingWeightKg <= EPS
          ? 'CONSUMED'
          : 'AVAILABLE'
        : 'BLOCKED',
  });

  const now = new Date();
  const nextChecklist =
    Array.isArray(input.checklist) && input.checklist.length > 0 ? input.checklist : existingRow.checklist;
  const nextDefectCodes = Array.isArray(input.defectCodes) ? input.defectCodes : existingRow.defectCodes;
  const nextDefectCategory = input.defectCategory || existingRow.defectCategory || null;
  const nextDefectSummary =
    input.defectSummary !== undefined ? input.defectSummary : existingRow.defectSummary ?? null;
  const nextNotes = input.notes !== undefined ? input.notes : existingRow.notes ?? null;
  const qmDocDbId = qmDocument ? await resolveInventoryDocIdInTx(tx, qmDocument) : existingRow.linkedQmDocumentId;

  let updatedInspectionRow = await tx.qualityInspection.update({
    where: { id: existingRow.id },
    data: {
      decision: input.decision,
      status: input.decision === 'QUARANTINED' ? 'IN_PROGRESS' : 'COMPLETED',
      resultingQualityStatus,
      acceptedQty: round3(acceptedQty),
      rejectedQty: round3(rejectedQty),
      reworkQty: round3(reworkQty),
      checklist: nextChecklist,
      defectCodes: nextDefectCodes,
      defectCategory: nextDefectCategory,
      defectSummary: nextDefectSummary,
      notes: nextNotes,
      linkedQmDocumentId: qmDocDbId ?? null,
      linkedQmDocumentNumber: qmDocument?.documentNumber || existingRow.linkedQmDocumentNumber || null,
      decidedAt: now,
      version: { increment: 1 },
    },
  });

  let createdNcrDto: NonconformanceRecord | undefined;
  const shouldAutoCreateNcr =
    input.autoCreateNcr !== false &&
    !updatedInspectionRow.linkedNcrId &&
    (nonConformingQty > EPS || input.decision === 'REJECTED');

  if (shouldAutoCreateNcr) {
    const defectList = Array.isArray(nextDefectCodes) ? (nextDefectCodes as string[]) : [];
    const primaryDefect = resolveDefectMeta(defectList[0], nextDefectCategory || undefined);
    const ncrQty = nonConformingQty > EPS ? nonConformingQty : inspectedQty;
    const ncrNumber = makeDocNumber('NCR');
    const sourceType: NcrSourceType =
      updatedInspectionRow.inspectionType === 'INCOMING_MATERIAL'
        ? 'INCOMING_MATERIAL'
        : updatedInspectionRow.inspectionType === 'IN_PROCESS'
        ? 'IN_PROCESS'
        : 'FINAL_PRODUCT';

    const createdNcrRow = await tx.qualityNonconformance.create({
      data: {
        ncrNumber,
        title: `عدم انطباق ${updatedInspectionRow.partName} (${primaryDefect.labelFa})`,
        sourceType,
        severity: input.severity || primaryDefect.defaultSeverity,
        category: nextDefectCategory || primaryDefect.category,
        defectCode: primaryDefect.code,
        defectLabelFa: primaryDefect.labelFa,
        status: qmDocument ? 'CONTAINED' : 'OPEN',
        disposition: 'PENDING',
        resultingQualityStatus,
        inspectionId: updatedInspectionRow.id,
        inspectionNumber: updatedInspectionRow.inspectionNumber,
        partId: updatedInspectionRow.partId,
        partRefId: updatedInspectionRow.partRefId,
        partCode: updatedInspectionRow.partCode,
        partName: updatedInspectionRow.partName,
        warehouseId: updatedInspectionRow.warehouseId,
        warehouseRefId: updatedInspectionRow.warehouseRefId,
        warehouseName: updatedInspectionRow.warehouseName,
        locationCode: updatedInspectionRow.locationCode,
        balanceId: updatedInspectionRow.balanceId,
        materialLotId: updatedInspectionRow.materialLotId,
        lotNumber: updatedInspectionRow.lotNumber,
        heatNumber: updatedInspectionRow.heatNumber,
        physicalCoilId: updatedInspectionRow.physicalCoilId,
        coilRefId: updatedInspectionRow.coilRefId,
        coilId: updatedInspectionRow.coilId,
        coilPackNumber: updatedInspectionRow.coilPackNumber,
        manufacturingOrderId: updatedInspectionRow.manufacturingOrderId,
        moRefId: updatedInspectionRow.moRefId,
        moNumber: updatedInspectionRow.moNumber,
        productionOperationId: updatedInspectionRow.productionOperationId,
        operationRefId: updatedInspectionRow.operationRefId,
        operationCode: updatedInspectionRow.operationCode,
        operationName: updatedInspectionRow.operationName,
        materialContractId: updatedInspectionRow.materialContractId,
        contractRefId: updatedInspectionRow.contractRefId,
        contractNumber: updatedInspectionRow.contractNumber,
        supplierName: updatedInspectionRow.supplierName,
        ownership: updatedInspectionRow.ownership,
        affectedQty: round3(ncrQty),
        containedQty: qmDocument ? round3(ncrQty) : 0,
        reworkedGoodQty: 0,
        scrappedQty: 0,
        returnedToProductionQty: 0,
        returnedToSupplierQty: 0,
        unit: updatedInspectionRow.unit,
        weightKg: round3(ncrQty * weightPerUnit),
        description:
          nextDefectSummary ||
          nextNotes ||
          `ثبت خودکار عدم انطباق از برگه بازرسی ${updatedInspectionRow.inspectionNumber}`,
        containmentAction: qmDocument
          ? `مسدودسازی خودکار در انبار با سند کیفی ${qmDocument.documentNumber}`
          : null,
        containedAt: qmDocument ? now : null,
        containedByName: qmDocument ? input.user.displayName : null,
        containmentQmDocId: qmDocDbId ?? null,
        containmentQmDocNumber: qmDocument?.documentNumber || null,
        createdByUid: input.user.uid,
        createdByName: input.user.displayName,
      },
    });

    updatedInspectionRow = await tx.qualityInspection.update({
      where: { id: updatedInspectionRow.id },
      data: {
        linkedNcrId: createdNcrRow.id,
        linkedNcrNumber: createdNcrRow.ncrNumber,
      },
    });
    createdNcrDto = mapDbNcrToDto(createdNcrRow);
  }

  const inspectionDto = mapDbInspectionToDto(updatedInspectionRow);
  await recordQualityAuditInTx(tx, {
    action: 'QUALITY_INSPECTION_DECIDE',
    entityName: 'QualityInspection',
    entityId: inspectionDto.inspectionNumber,
    user: input.user,
    details: `تصمیم کیفی «${inspectionDto.decision}» برای ${inspectionDto.partCode} (قبول: ${inspectionDto.acceptedQty}، مردود: ${inspectionDto.rejectedQty}، دوباره‌کاری: ${inspectionDto.reworkQty})${createdNcrDto ? ` | NCR: ${createdNcrDto.ncrNumber}` : ''}`,
    newValues: {
      decision: inspectionDto.decision,
      status: inspectionDto.status,
      acceptedQty: inspectionDto.acceptedQty,
      rejectedQty: inspectionDto.rejectedQty,
      reworkQty: inspectionDto.reworkQty,
      linkedNcrNumber: createdNcrDto?.ncrNumber,
    },
  });

  return { inspection: inspectionDto, ncr: createdNcrDto, qmDocument };
}

async function createQualityInspectionInDb(
  input: CreateInspectionInput,
  bridge: QualityInventoryBridge,
  fpPayload: unknown
): Promise<{
  ok: boolean;
  statusCode: number;
  error?: string;
  idempotentReplay?: boolean;
  inspection?: QualityInspectionRecord;
  ncr?: NonconformanceRecord;
  qmDocument?: InventoryDocument;
}> {
  const inspectedQty = Number(input.inspectedQty);
  const matchedCoil = (input.physicalCoilId || input.coilId)
    ? bridge.coils.find(
        c =>
          c.id === input.physicalCoilId ||
          c.id === input.coilId ||
          c.coilId === input.coilId ||
          c.coilPackNumber === input.coilId
      )
    : undefined;
  const matchedMo = (input.manufacturingOrderId || input.moNumber)
    ? bridge.manufacturingOrders.find(
        m => m.id === input.manufacturingOrderId || m.moNumber === input.moNumber
      )
    : undefined;

  if (input.inspectionType === 'IN_PROCESS' && !matchedMo && !input.moNumber && !input.manufacturingOrderId) {
    return {
      ok: false,
      statusCode: 400,
      error: 'برای بازرسی حین فرآیند (IPQC)، اتصال به دستور تولید (MO) الزامی است.',
    };
  }

  const resolvedPart =
    (input.partId ? bridge.parts.find(p => p.id === input.partId) : undefined) ||
    (input.partCode ? bridge.parts.find(p => p.code === input.partCode) : undefined) ||
    (matchedCoil ? bridge.parts.find(p => p.id === matchedCoil.partId || p.code === matchedCoil.partCode) : undefined) ||
    (matchedMo ? bridge.parts.find(p => p.id === matchedMo.partId || p.code === matchedMo.partCode) : undefined);
  if (!resolvedPart) {
    return { ok: false, statusCode: 404, error: 'قطعه یا ماده اولیه انتخاب‌شده در کاتالوگ قطعات یافت نشد.' };
  }

  const resolvedLot = input.lotNumber || matchedCoil?.coilId;
  const resolvedWarehouseId =
    input.warehouseId || matchedCoil?.warehouseId || (input.inspectionType === 'FINAL_PRODUCT' ? 'WH-FINISHED' : 'WH-RAW');
  const matchedWarehouse = bridge.warehouses.find(w => w.id === resolvedWarehouseId || w.code === resolvedWarehouseId);
  const matchedBalance = resolveMatchingBalance(bridge, {
    balanceId: input.balanceId,
    partId: resolvedPart.id,
    warehouseId: matchedWarehouse?.id || resolvedWarehouseId,
    lotNumber: resolvedLot,
    coilId: matchedCoil?.coilId,
  });

  const unit: UnitOfMeasure = resolvedPart.unit;
  const weightKg = round3(unit === 'KG' ? inspectedQty : inspectedQty * Number(resolvedPart.weightPerUnitKg || 1));
  const typePrefix =
    input.inspectionType === 'INCOMING_MATERIAL'
      ? 'INS-IN'
      : input.inspectionType === 'IN_PROCESS'
      ? 'INS-IP'
      : 'INS-FN';
  const inspectionNumber = makeDocNumber(typePrefix);

  const checklist: InspectionChecklistItem[] =
    Array.isArray(input.checklist) && input.checklist.length > 0
      ? input.checklist.map((item, idx) => ({
          id: item.id || `CHK-${idx + 1}`,
          code: String(item.code || `CHK-${idx + 1}`),
          labelFa: String(item.labelFa || `آیتم بازرسی ${idx + 1}`),
          standardSpec: item.standardSpec ? String(item.standardSpec) : undefined,
          measuredValue: item.measuredValue ? String(item.measuredValue) : undefined,
          passed: Boolean(item.passed),
          notes: item.notes ? String(item.notes) : undefined,
        }))
      : getDefaultChecklistTemplate(input.inspectionType);

  const result = await runQualityTransaction('CREATE_INSPECTION', input.idempotencyKey, fpPayload, async tx => {
    const fks = await resolveQualityForeignKeysInTx(tx, {
      partId: resolvedPart.id,
      partCode: resolvedPart.code,
      warehouseId: matchedBalance?.warehouseId || matchedWarehouse?.id || resolvedWarehouseId,
      lotNumber: resolvedLot || matchedBalance?.lotNumber,
      physicalCoilId: matchedCoil?.id || input.physicalCoilId,
      coilId: matchedCoil?.coilId || input.coilId,
      manufacturingOrderId: matchedMo?.id || input.manufacturingOrderId,
      moNumber: matchedMo?.moNumber || input.moNumber,
      operationId: input.operationId,
      operationCode: input.operationCode,
      contractId: input.contractId || matchedBalance?.contractId || matchedCoil?.allocations?.[0]?.contractId,
      contractNumber: input.contractNumber || matchedBalance?.contractNumber || matchedCoil?.allocations?.[0]?.contractNumber,
    });

    let qmDocument: InventoryDocument | undefined;
    if (
      input.quarantineOnStart &&
      (!input.decision || input.decision === 'PENDING' || input.decision === 'QUARANTINED') &&
      matchedBalance &&
      matchedBalance.availableQty > EPS
    ) {
      const holdQty = Math.min(inspectedQty, matchedBalance.availableQty);
      const qmRes = await bridge.executeQmTransfer({
        key: matchedBalance.id,
        partId: resolvedPart.id,
        partCode: resolvedPart.code,
        warehouseId: matchedBalance.warehouseId,
        locationCode: matchedBalance.locationCode,
        lotNumber: matchedBalance.lotNumber,
        physicalCoilId: matchedCoil?.id,
        ownership: matchedBalance.ownership,
        contractId: matchedBalance.contractId,
        isHeld: true,
        holdType: 'QUALITY_INSPECTION',
        movementType: '322',
        heldQty: holdQty,
        heldWeightKg: unit === 'KG' ? holdQty : round3(holdQty * Number(resolvedPart.weightPerUnitKg || 1)),
        reasonFa: `قرنطینه خودکار جهت بازرسی کیفی ${inspectionNumber}`,
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:QSTART` : undefined,
        user: input.user,
      });
      if (!qmRes.success) {
        throw new QualityTxAbortError(
          qmRes.statusCode || 409,
          qmRes.error || 'خطا در قرنطینه اولیه موجودی برای بازرسی'
        );
      }
      qmDocument = qmRes.document;
    }

    const now = new Date();
    const qmDocDbId = qmDocument ? await resolveInventoryDocIdInTx(tx, qmDocument) : null;
    const createdRow = await tx.qualityInspection.create({
      data: {
        inspectionNumber,
        inspectionType: input.inspectionType,
        status: 'PENDING',
        decision: 'PENDING',
        resultingQualityStatus: input.quarantineOnStart ? 'QUARANTINE' : null,
        partId: fks.partId,
        partRefId: resolvedPart.id,
        partCode: resolvedPart.code,
        partName: resolvedPart.name,
        warehouseId: fks.warehouseId,
        warehouseRefId: matchedBalance?.warehouseId || matchedWarehouse?.id || resolvedWarehouseId,
        warehouseName: matchedBalance?.warehouseName || matchedWarehouse?.name || resolvedWarehouseId,
        locationCode: input.locationCode || matchedBalance?.locationCode || matchedCoil?.warehouseLocationCode || null,
        balanceId: matchedBalance?.id || input.balanceId || null,
        materialLotId: fks.materialLotId,
        lotNumber: resolvedLot || matchedBalance?.lotNumber || null,
        heatNumber: matchedCoil?.heatNumber || matchedBalance?.heatNumber || null,
        physicalCoilId: fks.physicalCoilId,
        coilRefId: matchedCoil?.id || input.physicalCoilId || null,
        coilId: matchedCoil?.coilId || input.coilId || null,
        coilPackNumber: matchedCoil?.coilPackNumber || null,
        manufacturingOrderId: fks.manufacturingOrderId,
        moRefId: matchedMo?.id || input.manufacturingOrderId || null,
        moNumber: matchedMo?.moNumber || input.moNumber || null,
        productionOperationId: fks.productionOperationId,
        operationRefId: input.operationId || null,
        operationCode: input.operationCode || null,
        operationName: input.operationName || null,
        materialContractId: fks.materialContractId,
        contractRefId: input.contractId || matchedBalance?.contractId || matchedCoil?.allocations?.[0]?.contractId || null,
        contractNumber:
          input.contractNumber || matchedBalance?.contractNumber || matchedCoil?.allocations?.[0]?.contractNumber || null,
        supplierName:
          input.supplierName ||
          matchedCoil?.supplierName ||
          (matchedBalance?.ownership === 'SAPCO_SUPPLIER_OWNED' ? 'ساپکو (تأمین امانی)' : null),
        ownership: matchedBalance?.ownership || matchedCoil?.ownership || 'COMPANY_OWNED',
        sourceDocumentNumber: input.sourceDocumentNumber || null,
        inspectedQty: round3(inspectedQty),
        acceptedQty: 0,
        rejectedQty: 0,
        reworkQty: 0,
        unit,
        weightKg,
        checklist,
        defectCodes: Array.isArray(input.defectCodes) ? input.defectCodes : [],
        defectCategory: input.defectCategory || null,
        defectSummary: input.defectSummary || null,
        notes: input.notes || null,
        linkedQmDocumentId: qmDocDbId,
        linkedQmDocumentNumber: qmDocument?.documentNumber || null,
        inspectorUid: input.user.uid,
        inspectorName: input.user.displayName,
        inspectedAt: now,
        idempotencyKey: input.idempotencyKey || null,
      },
    });

    if (input.quarantineOnStart && (!input.decision || input.decision === 'PENDING')) {
      await syncLinkedEntityQualityStatusInTx(tx, {
        physicalCoilId: fks.physicalCoilId,
        materialLotId: fks.materialLotId,
        qualityStatus: 'QUARANTINE',
        physicalStatus: 'BLOCKED',
      });
    }

    await recordQualityAuditInTx(tx, {
      action: 'QUALITY_INSPECTION_CREATE',
      entityName: 'QualityInspection',
      entityId: createdRow.inspectionNumber,
      user: input.user,
      details: `ایجاد بازرسی ${INSPECTION_TYPE_LABELS_FA[input.inspectionType]} برای «${resolvedPart.code}» به مقدار ${round3(inspectedQty)} ${unit}`,
    });

    let finalInspection = mapDbInspectionToDto(createdRow);
    let createdNcr: NonconformanceRecord | undefined;

    if (input.decision && input.decision !== 'PENDING') {
      const decOut = await applyInspectionDecisionInTx(
        tx,
        createdRow,
        {
          decision: input.decision,
          acceptedQty: input.acceptedQty,
          rejectedQty: input.rejectedQty,
          reworkQty: input.reworkQty,
          checklist,
          defectCodes: input.defectCodes,
          defectCategory: input.defectCategory,
          defectSummary: input.defectSummary,
          severity: input.severity,
          notes: input.notes,
          autoCreateNcr: input.autoCreateNcr,
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:DECIDE` : undefined,
          user: input.user,
        },
        bridge
      );
      finalInspection = decOut.inspection;
      createdNcr = decOut.ncr;
      qmDocument = decOut.qmDocument || qmDocument;
    }

    const responsePayload = {
      inspection: finalInspection,
      ncr: createdNcr,
      qmDocument,
    };
    await saveDbQualityIdempotencyInTx(tx, 'CREATE_INSPECTION', input.idempotencyKey, fpPayload, 201, responsePayload);
    return { ok: true, statusCode: 201, idempotentReplay: false, ...responsePayload };
  });

  if (result.ok && !result.idempotentReplay && result.inspection) {
    bridge.recordAudit({
      action: 'QUALITY_INSPECTION_CREATE',
      entityName: 'QualityInspection',
      entityId: result.inspection.inspectionNumber,
      user: input.user,
      details: `ایجاد بازرسی ${INSPECTION_TYPE_LABELS_FA[result.inspection.inspectionType]} برای «${result.inspection.partCode}» به مقدار ${result.inspection.inspectedQty} ${result.inspection.unit}`,
    });
  }
  return result;
}

async function decideQualityInspectionInDb(
  inspectionIdOrNumber: string,
  input: DecideInspectionInput,
  bridge: QualityInventoryBridge,
  fpPayload: unknown
): Promise<{
  ok: boolean;
  statusCode: number;
  error?: string;
  idempotentReplay?: boolean;
  inspection?: QualityInspectionRecord;
  ncr?: NonconformanceRecord;
  qmDocument?: InventoryDocument;
}> {
  const result = await runQualityTransaction('DECIDE_INSPECTION', input.idempotencyKey, fpPayload, async tx => {
    const existingRow = await dbFindInspectionByIdOrNumber(tx, inspectionIdOrNumber);
    if (!existingRow) {
      throw new QualityTxAbortError(404, `برگه بازرسی «${inspectionIdOrNumber}» یافت نشد.`);
    }
    const decOut = await applyInspectionDecisionInTx(tx, existingRow, input, bridge);
    const responsePayload = {
      inspection: decOut.inspection,
      ncr: decOut.ncr,
      qmDocument: decOut.qmDocument,
    };
    await saveDbQualityIdempotencyInTx(tx, 'DECIDE_INSPECTION', input.idempotencyKey, fpPayload, 200, responsePayload);
    return { ok: true, statusCode: 200, idempotentReplay: false, ...responsePayload };
  });

  if (result.ok && !result.idempotentReplay && result.inspection) {
    bridge.recordAudit({
      action: 'QUALITY_INSPECTION_DECIDE',
      entityName: 'QualityInspection',
      entityId: result.inspection.inspectionNumber,
      user: input.user,
      details: `تصمیم کیفی «${result.inspection.decision}» برای ${result.inspection.partCode} (قبول: ${result.inspection.acceptedQty}، مردود: ${result.inspection.rejectedQty}، دوباره‌کاری: ${result.inspection.reworkQty})${result.ncr ? ` | NCR: ${result.ncr.ncrNumber}` : ''}`,
    });
  }
  return result;
}

async function applyNcrContainmentInTx(
  tx: any,
  existingNcrRow: any,
  input: {
    containmentAction: string;
    holdType?: 'QUALITY_INSPECTION' | 'BLOCKED';
    containQty?: number;
    idempotencyKey?: string;
    user: { uid: string; displayName: string };
  },
  bridge: QualityInventoryBridge
): Promise<{
  ncr: NonconformanceRecord;
  qmDocument?: InventoryDocument;
}> {
  const actionText = String(input.containmentAction || '').trim();
  if (actionText.length < 3) {
    throw new QualityTxAbortError(400, 'شرح اقدام مهار فوری (Containment Action) الزامی است.');
  }
  if (existingNcrRow.status === 'CLOSED') {
    throw new QualityTxAbortError(409, `گزارش عدم انطباق «${existingNcrRow.ncrNumber}» بسته شده است.`);
  }

  const targetHoldType = input.holdType === 'QUALITY_INSPECTION' ? 'QUALITY_INSPECTION' : 'BLOCKED';
  const movementType: '322' | '344' = targetHoldType === 'BLOCKED' ? '344' : '322';
  const containQty = round3(Number(input.containQty || existingNcrRow.affectedQty));
  const partId = existingNcrRow.partId || existingNcrRow.partRefId;
  const part = bridge.parts.find(p => p.id === partId || p.code === existingNcrRow.partCode);
  const weightPerUnit = existingNcrRow.unit === 'KG' ? 1 : Number(part?.weightPerUnitKg || 1);
  const matchedCoil = (existingNcrRow.physicalCoilId || existingNcrRow.coilRefId)
    ? bridge.coils.find(c => c.id === existingNcrRow.physicalCoilId || c.id === existingNcrRow.coilRefId)
    : existingNcrRow.coilId
    ? bridge.coils.find(c => c.coilId === existingNcrRow.coilId)
    : undefined;
  const matchedBalance = resolveMatchingBalance(bridge, {
    balanceId: existingNcrRow.balanceId || undefined,
    partId,
    warehouseId: existingNcrRow.warehouseId || existingNcrRow.warehouseRefId || undefined,
    lotNumber: existingNcrRow.lotNumber || undefined,
    coilId: existingNcrRow.coilId || undefined,
  });

  let qmDocument: InventoryDocument | undefined;
  if (matchedBalance) {
    const transferable =
      movementType === '344'
        ? round3(matchedBalance.availableQty + matchedBalance.qualityInspectionQty)
        : round3(matchedBalance.availableQty);
    const qtyToHold = round3(Math.min(containQty, transferable));
    if (qtyToHold > EPS) {
      const qmRes = await bridge.executeQmTransfer({
        key: matchedBalance.id,
        partId,
        partCode: existingNcrRow.partCode,
        warehouseId: matchedBalance.warehouseId,
        locationCode: matchedBalance.locationCode,
        lotNumber: matchedBalance.lotNumber,
        physicalCoilId: matchedCoil?.id,
        ownership: matchedBalance.ownership,
        contractId: matchedBalance.contractId,
        isHeld: true,
        holdType: targetHoldType,
        movementType,
        heldQty: qtyToHold,
        heldWeightKg: round3(qtyToHold * weightPerUnit),
        reasonFa: `مهار و قرنطینه عدم انطباق ${existingNcrRow.ncrNumber}: ${actionText}`,
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:QM` : undefined,
        user: input.user,
      });
      if (!qmRes.success) {
        throw new QualityTxAbortError(qmRes.statusCode || 409, qmRes.error || 'خطا در مهار فوری عدم انطباق');
      }
      qmDocument = qmRes.document;
    }
  } else if (matchedCoil) {
    matchedCoil.qualityStatus = targetHoldType === 'BLOCKED' ? 'QUALITY_BLOCKED' : 'QUARANTINE';
    matchedCoil.physicalStatus = 'BLOCKED';
  }

  const resultingQualityStatus: StockQualityStatus =
    targetHoldType === 'BLOCKED' ? 'QUALITY_BLOCKED' : 'QUARANTINE';
  await syncLinkedEntityQualityStatusInTx(tx, {
    physicalCoilId: existingNcrRow.physicalCoilId,
    materialLotId: existingNcrRow.materialLotId,
    qualityStatus: resultingQualityStatus,
    physicalStatus: 'BLOCKED',
  });

  const now = new Date();
  const qmDocDbId = qmDocument
    ? await resolveInventoryDocIdInTx(tx, qmDocument)
    : existingNcrRow.containmentQmDocId;

  const updatedRow = await tx.qualityNonconformance.update({
    where: { id: existingNcrRow.id },
    data: {
      status: 'CONTAINED',
      resultingQualityStatus,
      containedQty: round3(containQty),
      containmentAction: actionText,
      containedAt: now,
      containedByName: input.user.displayName,
      containmentQmDocId: qmDocDbId ?? null,
      containmentQmDocNumber: qmDocument?.documentNumber || existingNcrRow.containmentQmDocNumber || null,
      version: { increment: 1 },
    },
  });

  const ncrDto = mapDbNcrToDto(updatedRow);
  await recordQualityAuditInTx(tx, {
    action: 'NCR_CONTAIN',
    entityName: 'Nonconformance',
    entityId: ncrDto.ncrNumber,
    user: input.user,
    details: `اجرای مهار فوری (${movementType}) برای ${ncrDto.ncrNumber} به مقدار ${ncrDto.containedQty} ${ncrDto.unit}`,
    newValues: {
      status: ncrDto.status,
      containedQty: ncrDto.containedQty,
      containmentQmDocNumber: ncrDto.containmentQmDocNumber,
    },
  });

  return { ncr: ncrDto, qmDocument };
}

async function createNonconformanceRecordInDb(
  input: CreateNcrInput,
  bridge: QualityInventoryBridge,
  fpPayload: unknown
): Promise<{
  ok: boolean;
  statusCode: number;
  error?: string;
  idempotentReplay?: boolean;
  ncr?: NonconformanceRecord;
  qmDocument?: InventoryDocument;
}> {
  const affectedQty = Number(input.affectedQty);
  const trimmedDesc = String(input.description || '').trim();
  const matchedCoil = (input.physicalCoilId || input.coilId)
    ? bridge.coils.find(
        c =>
          c.id === input.physicalCoilId ||
          c.id === input.coilId ||
          c.coilId === input.coilId ||
          c.coilPackNumber === input.coilId
      )
    : undefined;
  const matchedMo = (input.manufacturingOrderId || input.moNumber)
    ? bridge.manufacturingOrders.find(
        m => m.id === input.manufacturingOrderId || m.moNumber === input.moNumber
      )
    : undefined;
  const resolvedPart =
    (input.partId ? bridge.parts.find(p => p.id === input.partId) : undefined) ||
    (input.partCode ? bridge.parts.find(p => p.code === input.partCode) : undefined) ||
    (matchedCoil ? bridge.parts.find(p => p.id === matchedCoil.partId || p.code === matchedCoil.partCode) : undefined) ||
    (matchedMo ? bridge.parts.find(p => p.id === matchedMo.partId || p.code === matchedMo.partCode) : undefined);
  if (!resolvedPart) {
    return { ok: false, statusCode: 404, error: 'قطعه یا ماده اولیه انتخاب‌شده یافت نشد.' };
  }

  const resolvedLot = input.lotNumber || matchedCoil?.coilId;
  const resolvedWarehouseId = input.warehouseId || matchedCoil?.warehouseId || 'WH-RAW';
  const matchedWarehouse = bridge.warehouses.find(w => w.id === resolvedWarehouseId || w.code === resolvedWarehouseId);
  const matchedBalance = resolveMatchingBalance(bridge, {
    balanceId: input.balanceId,
    partId: resolvedPart.id,
    warehouseId: matchedWarehouse?.id || resolvedWarehouseId,
    lotNumber: resolvedLot,
    coilId: matchedCoil?.coilId,
  });

  const defectMeta = resolveDefectMeta(input.defectCode, input.category);
  const unit: UnitOfMeasure = resolvedPart.unit;
  const weightPerUnit = unit === 'KG' ? 1 : Number(resolvedPart.weightPerUnitKg || 1);
  const ncrNumber = makeDocNumber('NCR');

  const result = await runQualityTransaction('CREATE_NCR', input.idempotencyKey, fpPayload, async tx => {
    const fks = await resolveQualityForeignKeysInTx(tx, {
      partId: resolvedPart.id,
      partCode: resolvedPart.code,
      warehouseId: matchedBalance?.warehouseId || matchedWarehouse?.id || resolvedWarehouseId,
      lotNumber: resolvedLot || matchedBalance?.lotNumber,
      physicalCoilId: matchedCoil?.id || input.physicalCoilId,
      coilId: matchedCoil?.coilId || input.coilId,
      manufacturingOrderId: matchedMo?.id || input.manufacturingOrderId,
      moNumber: matchedMo?.moNumber || input.moNumber,
      operationId: input.operationId,
      operationCode: input.operationCode,
      contractId: input.contractId || matchedBalance?.contractId || matchedCoil?.allocations?.[0]?.contractId,
      contractNumber: input.contractNumber || matchedBalance?.contractNumber || matchedCoil?.allocations?.[0]?.contractNumber,
    });

    const createdRow = await tx.qualityNonconformance.create({
      data: {
        ncrNumber,
        title: String(input.title || '').trim() || `عدم انطباق ${resolvedPart.name} — ${defectMeta.labelFa}`,
        sourceType: input.sourceType || 'IN_PROCESS',
        severity: input.severity || defectMeta.defaultSeverity,
        category: input.category || defectMeta.category,
        defectCode: defectMeta.code,
        defectLabelFa: defectMeta.labelFa,
        status: 'OPEN',
        disposition: 'PENDING',
        partId: fks.partId,
        partRefId: resolvedPart.id,
        partCode: resolvedPart.code,
        partName: resolvedPart.name,
        warehouseId: fks.warehouseId,
        warehouseRefId: matchedBalance?.warehouseId || matchedWarehouse?.id || resolvedWarehouseId,
        warehouseName: matchedBalance?.warehouseName || matchedWarehouse?.name || resolvedWarehouseId,
        locationCode: input.locationCode || matchedBalance?.locationCode || matchedCoil?.warehouseLocationCode || null,
        balanceId: matchedBalance?.id || input.balanceId || null,
        materialLotId: fks.materialLotId,
        lotNumber: resolvedLot || matchedBalance?.lotNumber || null,
        heatNumber: matchedCoil?.heatNumber || matchedBalance?.heatNumber || null,
        physicalCoilId: fks.physicalCoilId,
        coilRefId: matchedCoil?.id || input.physicalCoilId || null,
        coilId: matchedCoil?.coilId || input.coilId || null,
        coilPackNumber: matchedCoil?.coilPackNumber || null,
        manufacturingOrderId: fks.manufacturingOrderId,
        moRefId: matchedMo?.id || input.manufacturingOrderId || null,
        moNumber: matchedMo?.moNumber || input.moNumber || null,
        productionOperationId: fks.productionOperationId,
        operationRefId: input.operationId || null,
        operationCode: input.operationCode || null,
        operationName: input.operationName || null,
        materialContractId: fks.materialContractId,
        contractRefId: input.contractId || matchedBalance?.contractId || matchedCoil?.allocations?.[0]?.contractId || null,
        contractNumber:
          input.contractNumber || matchedBalance?.contractNumber || matchedCoil?.allocations?.[0]?.contractNumber || null,
        supplierName: input.supplierName || matchedCoil?.supplierName || null,
        ownership: matchedBalance?.ownership || matchedCoil?.ownership || 'COMPANY_OWNED',
        affectedQty: round3(affectedQty),
        containedQty: 0,
        reworkedGoodQty: 0,
        scrappedQty: 0,
        returnedToProductionQty: 0,
        returnedToSupplierQty: 0,
        unit,
        weightKg: round3(affectedQty * weightPerUnit),
        description: trimmedDesc,
        rootCause: input.rootCause || null,
        correctiveAction: input.correctiveAction || null,
        createdByUid: input.user.uid,
        createdByName: input.user.displayName,
        idempotencyKey: input.idempotencyKey || null,
      },
    });

    let finalNcr = mapDbNcrToDto(createdRow);
    let qmDocument: InventoryDocument | undefined;
    if (input.containImmediately) {
      const containOut = await applyNcrContainmentInTx(
        tx,
        createdRow,
        {
          containmentAction: input.containmentAction || 'قرنطینه و مسدودسازی فوری عدم انطباق در انبار',
          holdType: 'BLOCKED',
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:CONTAIN` : undefined,
          user: input.user,
        },
        bridge
      );
      finalNcr = containOut.ncr;
      qmDocument = containOut.qmDocument;
    } else {
      await recordQualityAuditInTx(tx, {
        action: 'NCR_CREATE',
        entityName: 'Nonconformance',
        entityId: finalNcr.ncrNumber,
        user: input.user,
        details: `ثبت عدم انطباق ${finalNcr.ncrNumber} (${finalNcr.severity}) برای ${finalNcr.partCode} به مقدار ${finalNcr.affectedQty} ${finalNcr.unit}`,
      });
    }

    const responsePayload = { ncr: finalNcr, qmDocument };
    await saveDbQualityIdempotencyInTx(tx, 'CREATE_NCR', input.idempotencyKey, fpPayload, 201, responsePayload);
    return { ok: true, statusCode: 201, idempotentReplay: false, ...responsePayload };
  });

  if (result.ok && !result.idempotentReplay && result.ncr) {
    bridge.recordAudit({
      action: 'NCR_CREATE',
      entityName: 'Nonconformance',
      entityId: result.ncr.ncrNumber,
      user: input.user,
      details: `ثبت عدم انطباق ${result.ncr.ncrNumber} (${result.ncr.severity}) برای ${result.ncr.partCode} به مقدار ${result.ncr.affectedQty} ${result.ncr.unit}`,
    });
  }
  return result;
}

async function containNonconformanceInDb(
  ncrIdOrNumber: string,
  input: {
    containmentAction: string;
    holdType?: 'QUALITY_INSPECTION' | 'BLOCKED';
    containQty?: number;
    idempotencyKey?: string;
    user: { uid: string; displayName: string };
  },
  bridge: QualityInventoryBridge,
  fpPayload: unknown
): Promise<{
  ok: boolean;
  statusCode: number;
  error?: string;
  idempotentReplay?: boolean;
  ncr?: NonconformanceRecord;
  qmDocument?: InventoryDocument;
}> {
  const result = await runQualityTransaction('CONTAIN_NCR', input.idempotencyKey, fpPayload, async tx => {
    const existingRow = await dbFindNcrByIdOrNumber(tx, ncrIdOrNumber);
    if (!existingRow) {
      throw new QualityTxAbortError(404, `گزارش عدم انطباق «${ncrIdOrNumber}» یافت نشد.`);
    }
    const containOut = await applyNcrContainmentInTx(tx, existingRow, input, bridge);
    const responsePayload = { ncr: containOut.ncr, qmDocument: containOut.qmDocument };
    await saveDbQualityIdempotencyInTx(tx, 'CONTAIN_NCR', input.idempotencyKey, fpPayload, 200, responsePayload);
    return { ok: true, statusCode: 200, idempotentReplay: false, ...responsePayload };
  });

  if (result.ok && !result.idempotentReplay && result.ncr) {
    bridge.recordAudit({
      action: 'NCR_CONTAIN',
      entityName: 'Nonconformance',
      entityId: result.ncr.ncrNumber,
      user: input.user,
      details: `اجرای مهار فوری برای ${result.ncr.ncrNumber} به مقدار ${result.ncr.containedQty} ${result.ncr.unit}`,
    });
  }
  return result;
}

async function dispositionNonconformanceInDb(
  ncrIdOrNumber: string,
  input: {
    disposition: NcrDispositionAction;
    rootCause?: string;
    correctiveAction?: string;
    dispositionNotes?: string;
    reworkInstructions?: string;
    targetOperationCode?: string;
    assignedToName?: string;
    returnToProduction?: boolean;
    sortedGoodQty?: number;
    sortedDefectQty?: number;
    idempotencyKey?: string;
    user: { uid: string; displayName: string };
  },
  bridge: QualityInventoryBridge,
  fpPayload: unknown
): Promise<{
  ok: boolean;
  statusCode: number;
  error?: string;
  idempotentReplay?: boolean;
  ncr?: NonconformanceRecord;
  reworkOrder?: ReworkOrderRecord;
  document?: InventoryDocument;
}> {
  const result = await runQualityTransaction('DISPOSITION_NCR', input.idempotencyKey, fpPayload, async tx => {
    const existingNcr = await dbFindNcrByIdOrNumber(tx, ncrIdOrNumber);
    if (!existingNcr) {
      throw new QualityTxAbortError(404, `گزارش عدم انطباق «${ncrIdOrNumber}» یافت نشد.`);
    }
    if (existingNcr.status === 'CLOSED') {
      throw new QualityTxAbortError(409, `گزارش عدم انطباق «${existingNcr.ncrNumber}» قبلاً بسته شده است.`);
    }

    const partId = existingNcr.partId || existingNcr.partRefId;
    const part = bridge.parts.find(p => p.id === partId || p.code === existingNcr.partCode);
    const weightPerUnit = existingNcr.unit === 'KG' ? 1 : Number(part?.weightPerUnitKg || 1);
    const matchedCoil = (existingNcr.physicalCoilId || existingNcr.coilRefId)
      ? bridge.coils.find(c => c.id === existingNcr.physicalCoilId || c.id === existingNcr.coilRefId)
      : existingNcr.coilId
      ? bridge.coils.find(c => c.coilId === existingNcr.coilId)
      : undefined;
    const matchedBalance = resolveMatchingBalance(bridge, {
      balanceId: existingNcr.balanceId || undefined,
      partId,
      warehouseId: existingNcr.warehouseId || existingNcr.warehouseRefId || undefined,
      lotNumber: existingNcr.lotNumber || undefined,
      coilId: existingNcr.coilId || undefined,
    });

    const affectedQty = Number(existingNcr.affectedQty);
    const now = new Date();
    let resultDoc: InventoryDocument | undefined;
    let reworkOrderDto: ReworkOrderRecord | undefined;
    let nextStatus: 'OPEN' | 'CONTAINED' | 'DISPOSITIONED' | 'IN_REWORK' | 'CLOSED' = existingNcr.status;
    let nextClosedAt: Date | null = existingNcr.closedAt || null;
    let nextClosedByName: string | null = existingNcr.closedByName || null;
    let nextReworkedGoodQty = Number(existingNcr.reworkedGoodQty || 0);
    let nextScrappedQty = Number(existingNcr.scrappedQty || 0);
    let nextReturnedToSupplierQty = Number(existingNcr.returnedToSupplierQty || 0);
    let nextLinkedReworkOrderId: string | null = existingNcr.linkedReworkOrderId || null;
    let nextLinkedReworkNumber: string | null = existingNcr.linkedReworkNumber || null;
    let resultingQualityStatus: StockQualityStatus =
      (existingNcr.resultingQualityStatus as StockQualityStatus) || 'QUALITY_BLOCKED';

    if (input.disposition === 'USE_AS_IS') {
      if (matchedBalance) {
        const heldTotal = round3(matchedBalance.qualityInspectionQty + matchedBalance.blockedQty);
        const releaseQty = round3(Math.min(affectedQty, heldTotal));
        if (releaseQty > EPS) {
          const res321 = await bridge.executeQmTransfer({
            key: matchedBalance.id,
            partId,
            partCode: existingNcr.partCode,
            warehouseId: matchedBalance.warehouseId,
            locationCode: matchedBalance.locationCode,
            lotNumber: matchedBalance.lotNumber,
            physicalCoilId: matchedCoil?.id,
            ownership: matchedBalance.ownership,
            contractId: matchedBalance.contractId,
            isHeld: false,
            movementType: '321',
            heldQty: releaseQty,
            heldWeightKg: round3(releaseQty * weightPerUnit),
            reasonFa: `ترخیص با ارفاق (Use-As-Is) بابت ${existingNcr.ncrNumber}${input.dispositionNotes ? ` — ${input.dispositionNotes}` : ''}`,
            idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:321` : undefined,
            user: input.user,
          });
          if (!res321.success) {
            throw new QualityTxAbortError(res321.statusCode || 409, res321.error || 'خطا در ترخیص Use-As-Is');
          }
          resultDoc = res321.document;
        }
      } else if (matchedCoil) {
        matchedCoil.qualityStatus = 'AVAILABLE';
        matchedCoil.physicalStatus = matchedCoil.remainingWeightKg > EPS ? 'AVAILABLE' : 'CONSUMED';
      }
      resultingQualityStatus = 'AVAILABLE';
      await syncLinkedEntityQualityStatusInTx(tx, {
        physicalCoilId: existingNcr.physicalCoilId,
        materialLotId: existingNcr.materialLotId,
        qualityStatus: 'AVAILABLE',
        physicalStatus: matchedCoil && matchedCoil.remainingWeightKg <= EPS ? 'CONSUMED' : 'AVAILABLE',
      });
      nextStatus = 'CLOSED';
      nextClosedAt = now;
      nextClosedByName = input.user.displayName;
    } else if (input.disposition === 'REWORK') {
      if (matchedBalance && matchedBalance.qualityInspectionQty + matchedBalance.blockedQty < affectedQty - EPS) {
        const needHold = round3(
          Math.min(
            affectedQty - (matchedBalance.qualityInspectionQty + matchedBalance.blockedQty),
            matchedBalance.availableQty
          )
        );
        if (needHold > EPS) {
          const holdRes = await bridge.executeQmTransfer({
            key: matchedBalance.id,
            partId,
            partCode: existingNcr.partCode,
            warehouseId: matchedBalance.warehouseId,
            locationCode: matchedBalance.locationCode,
            lotNumber: matchedBalance.lotNumber,
            physicalCoilId: matchedCoil?.id,
            ownership: matchedBalance.ownership,
            contractId: matchedBalance.contractId,
            isHeld: true,
            holdType: 'BLOCKED',
            movementType: '344',
            heldQty: needHold,
            heldWeightKg: round3(needHold * weightPerUnit),
            reasonFa: `قفل موجودی برای دستور دوباره‌کاری ${existingNcr.ncrNumber}`,
            idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:344` : undefined,
            user: input.user,
          });
          if (!holdRes.success) {
            throw new QualityTxAbortError(holdRes.statusCode || 409, holdRes.error || 'خطا در قفل موجودی دوباره‌کاری');
          }
          resultDoc = holdRes.document;
        }
      }

      resultingQualityStatus = 'QUALITY_BLOCKED';
      await syncLinkedEntityQualityStatusInTx(tx, {
        physicalCoilId: existingNcr.physicalCoilId,
        materialLotId: existingNcr.materialLotId,
        qualityStatus: 'QUALITY_BLOCKED',
        physicalStatus: 'BLOCKED',
      });

      const reworkNumber = makeDocNumber('RWK');
      const createdRwRow = await tx.qualityReworkOrder.create({
        data: {
          reworkNumber,
          ncrId: existingNcr.id,
          ncrNumber: existingNcr.ncrNumber,
          inspectionId: existingNcr.inspectionId || null,
          partId: existingNcr.partId,
          partRefId: existingNcr.partRefId,
          partCode: existingNcr.partCode,
          partName: existingNcr.partName,
          warehouseId: existingNcr.warehouseId,
          warehouseRefId: existingNcr.warehouseRefId,
          locationCode: existingNcr.locationCode,
          balanceId: existingNcr.balanceId,
          materialLotId: existingNcr.materialLotId,
          lotNumber: existingNcr.lotNumber,
          physicalCoilId: existingNcr.physicalCoilId,
          coilRefId: existingNcr.coilRefId,
          coilId: existingNcr.coilId,
          manufacturingOrderId: existingNcr.manufacturingOrderId,
          moRefId: existingNcr.moRefId,
          moNumber: existingNcr.moNumber,
          productionOperationId: existingNcr.productionOperationId,
          sourceOperationCode: existingNcr.operationCode,
          targetOperationCode: input.targetOperationCode || existingNcr.operationCode || 'OP-REWORK',
          materialContractId: existingNcr.materialContractId,
          contractRefId: existingNcr.contractRefId,
          contractNumber: existingNcr.contractNumber,
          ownership: existingNcr.ownership,
          plannedReworkQty: round3(affectedQty),
          completedGoodQty: 0,
          scrappedQty: 0,
          remainingQty: round3(affectedQty),
          unit: existingNcr.unit,
          weightKg: Number(existingNcr.weightKg || 0),
          status: 'OPEN',
          instructions:
            String(input.reworkInstructions || '').trim() ||
            `اصلاح و دوباره‌کاری بابت ${existingNcr.ncrNumber}: ${existingNcr.defectLabelFa}`,
          returnToProduction: input.returnToProduction !== false,
          assignedToName: input.assignedToName || null,
          createdByUid: input.user.uid,
          createdByName: input.user.displayName,
        },
      });
      reworkOrderDto = mapDbReworkToDto(createdRwRow);
      nextLinkedReworkOrderId = createdRwRow.id;
      nextLinkedReworkNumber = createdRwRow.reworkNumber;
      nextStatus = 'IN_REWORK';
    } else if (input.disposition === 'SCRAP' || input.disposition === 'RETURN_TO_SUPPLIER') {
      const isScrap = input.disposition === 'SCRAP';
      let writtenOffWeightKg = Number(existingNcr.weightKg || 0);
      if (matchedBalance) {
        const sourceBucketStatus: StockQualityStatus =
          matchedBalance.blockedQty >= affectedQty - EPS
            ? 'QUALITY_BLOCKED'
            : matchedBalance.qualityInspectionQty >= affectedQty - EPS
            ? 'QUARANTINE'
            : matchedBalance.blockedQty > EPS
            ? 'QUALITY_BLOCKED'
            : matchedBalance.qualityInspectionQty > EPS
            ? 'QUARANTINE'
            : 'AVAILABLE';
        const maxDeductibleInBucket =
          sourceBucketStatus === 'QUALITY_BLOCKED'
            ? matchedBalance.blockedQty
            : sourceBucketStatus === 'QUARANTINE'
            ? matchedBalance.qualityInspectionQty
            : matchedBalance.availableQty;
        const writeOffQty = round3(Math.min(affectedQty, maxDeductibleInBucket));
        if (writeOffQty > EPS) {
          writtenOffWeightKg = round3(
            existingNcr.unit === 'KG' ? writeOffQty : writeOffQty * weightPerUnit
          );
          const adjRes = await bridge.postQualityAdjustment({
            partId,
            warehouseId: matchedBalance.warehouseId,
            locationCode: matchedBalance.locationCode,
            lotNumber: matchedBalance.lotNumber,
            physicalCoilId: matchedCoil?.id,
            ownership: matchedBalance.ownership,
            contractId: matchedBalance.contractId,
            contractNumber: matchedBalance.contractNumber,
            quantityDelta: -writeOffQty,
            qualityStatus: sourceBucketStatus,
            referenceType: isScrap ? 'QUALITY_SCRAP' : 'SUPPLIER_RETURN',
            referenceNumber: existingNcr.ncrNumber,
            reasonFa: isScrap
              ? `اسقاط و انتقال به ضایعات بابت عدم انطباق ${existingNcr.ncrNumber} (${existingNcr.defectLabelFa})`
              : `مرجوعی به تأمین‌کننده بابت عدم انطباق ${existingNcr.ncrNumber} (${existingNcr.supplierName || 'تأمین‌کننده'})`,
            idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:ADJ` : undefined,
            creditScrapWarehouse: isScrap,
            markCoilReturned: !isScrap,
            user: input.user,
          });
          if (!adjRes.success) {
            throw new QualityTxAbortError(adjRes.statusCode || 409, adjRes.error || 'خطا در ثبت سند اسقاط/مرجوعی');
          }
          resultDoc = adjRes.document;
        }
      }

      const nextCoilRemainingKg = matchedCoil
        ? round3(Math.max(0, matchedCoil.remainingWeightKg - writtenOffWeightKg))
        : undefined;
      if (matchedCoil && nextCoilRemainingKg !== undefined) {
        matchedCoil.remainingWeightKg = nextCoilRemainingKg;
        matchedCoil.qualityStatus = 'REJECTED';
        matchedCoil.physicalStatus =
          !isScrap && nextCoilRemainingKg <= EPS
            ? 'RETURNED'
            : nextCoilRemainingKg <= EPS
            ? 'CONSUMED'
            : matchedCoil.physicalStatus;
      }

      resultingQualityStatus = 'REJECTED';
      await syncLinkedEntityQualityStatusInTx(tx, {
        physicalCoilId: existingNcr.physicalCoilId,
        materialLotId: existingNcr.materialLotId,
        qualityStatus: 'REJECTED',
        physicalStatus: matchedCoil?.physicalStatus || (!isScrap ? 'RETURNED' : 'CONSUMED'),
        remainingWeightKg: nextCoilRemainingKg,
      });

      if (isScrap) {
        nextScrappedQty = round3(nextScrappedQty + affectedQty);
      } else {
        nextReturnedToSupplierQty = round3(nextReturnedToSupplierQty + affectedQty);
      }
      nextStatus = 'CLOSED';
      nextClosedAt = now;
      nextClosedByName = input.user.displayName;
    } else if (input.disposition === 'SORT_REINSPECT') {
      const sortedGood = Number(input.sortedGoodQty ?? 0);
      const sortedDefect = Number(input.sortedDefectQty ?? Math.max(0, affectedQty - sortedGood));
      if (!Number.isFinite(sortedGood) || !Number.isFinite(sortedDefect) || sortedGood < 0 || sortedDefect < 0) {
        throw new QualityTxAbortError(400, 'مقادیر تفکیک سالم و معیوب باید نامنفی باشند.');
      }
      if (sortedGood + sortedDefect > affectedQty + EPS) {
        throw new QualityTxAbortError(400, 'مجموع مقادیر تفکیک‌شده از مقدار کل عدم انطباق بیشتر است.');
      }
      if (matchedBalance && sortedGood > EPS) {
        const heldTotal = round3(matchedBalance.qualityInspectionQty + matchedBalance.blockedQty);
        const relQty = round3(Math.min(sortedGood, heldTotal));
        if (relQty > EPS) {
          const res321 = await bridge.executeQmTransfer({
            key: matchedBalance.id,
            partId,
            partCode: existingNcr.partCode,
            warehouseId: matchedBalance.warehouseId,
            locationCode: matchedBalance.locationCode,
            lotNumber: matchedBalance.lotNumber,
            physicalCoilId: matchedCoil?.id,
            ownership: matchedBalance.ownership,
            contractId: matchedBalance.contractId,
            isHeld: false,
            movementType: '321',
            heldQty: relQty,
            heldWeightKg: round3(relQty * weightPerUnit),
            reasonFa: `ترخیص بخش سالم پس از تفکیک (Sort & Reinspect) بابت ${existingNcr.ncrNumber}`,
            idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:SORT321` : undefined,
            user: input.user,
          });
          if (!res321.success) {
            throw new QualityTxAbortError(res321.statusCode || 409, res321.error || 'خطا در ترخیص بخش سالم تفکیک');
          }
          resultDoc = res321.document;
        }
      }
      nextReworkedGoodQty = round3(nextReworkedGoodQty + sortedGood);
      if (sortedDefect > EPS && matchedBalance) {
        const sourceBucket: StockQualityStatus =
          matchedBalance.blockedQty >= sortedDefect - EPS
            ? 'QUALITY_BLOCKED'
            : matchedBalance.qualityInspectionQty >= sortedDefect - EPS
            ? 'QUARANTINE'
            : 'AVAILABLE';
        const adjRes = await bridge.postQualityAdjustment({
          partId,
          warehouseId: matchedBalance.warehouseId,
          locationCode: matchedBalance.locationCode,
          lotNumber: matchedBalance.lotNumber,
          physicalCoilId: matchedCoil?.id,
          ownership: matchedBalance.ownership,
          contractId: matchedBalance.contractId,
          contractNumber: matchedBalance.contractNumber,
          quantityDelta: -sortedDefect,
          qualityStatus: sourceBucket,
          referenceType: 'QUALITY_SCRAP',
          referenceNumber: existingNcr.ncrNumber,
          reasonFa: `اسقاط بخش معیوب پس از تفکیک (Sort) بابت ${existingNcr.ncrNumber}`,
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:SORTSCRAP` : undefined,
          creditScrapWarehouse: true,
          user: input.user,
        });
        if (!adjRes.success) {
          throw new QualityTxAbortError(adjRes.statusCode || 409, adjRes.error || 'خطا در اسقاط بخش معیوب تفکیک');
        }
        resultDoc = adjRes.document || resultDoc;
        nextScrappedQty = round3(nextScrappedQty + sortedDefect);
      }
      resultingQualityStatus = sortedGood > EPS ? 'AVAILABLE' : 'REJECTED';
      await syncLinkedEntityQualityStatusInTx(tx, {
        physicalCoilId: existingNcr.physicalCoilId,
        materialLotId: existingNcr.materialLotId,
        qualityStatus: resultingQualityStatus,
      });
      nextStatus = 'CLOSED';
      nextClosedAt = now;
      nextClosedByName = input.user.displayName;
    }

    const dispositionDocDbId = resultDoc
      ? await resolveInventoryDocIdInTx(tx, resultDoc)
      : existingNcr.dispositionDocId;

    const updatedNcrRow = await tx.qualityNonconformance.update({
      where: { id: existingNcr.id },
      data: {
        status: nextStatus,
        disposition: input.disposition,
        resultingQualityStatus,
        reworkedGoodQty: nextReworkedGoodQty,
        scrappedQty: nextScrappedQty,
        returnedToSupplierQty: nextReturnedToSupplierQty,
        rootCause: input.rootCause !== undefined ? input.rootCause : existingNcr.rootCause,
        correctiveAction:
          input.correctiveAction !== undefined ? input.correctiveAction : existingNcr.correctiveAction,
        dispositionNotes:
          input.dispositionNotes !== undefined ? input.dispositionNotes : existingNcr.dispositionNotes,
        dispositionedAt: now,
        dispositionedByName: input.user.displayName,
        dispositionDocId: dispositionDocDbId ?? null,
        dispositionDocNumber: resultDoc?.documentNumber || existingNcr.dispositionDocNumber || null,
        linkedReworkOrderId: nextLinkedReworkOrderId,
        linkedReworkNumber: nextLinkedReworkNumber,
        closedAt: nextClosedAt,
        closedByName: nextClosedByName,
        version: { increment: 1 },
      },
    });

    const ncrDto = mapDbNcrToDto(updatedNcrRow);
    await recordQualityAuditInTx(tx, {
      action: 'NCR_DISPOSITION',
      entityName: 'Nonconformance',
      entityId: ncrDto.ncrNumber,
      user: input.user,
      details: `تعیین تکلیف «${ncrDto.disposition}» برای ${ncrDto.ncrNumber}${reworkOrderDto ? ` | دستور دوباره‌کاری: ${reworkOrderDto.reworkNumber}` : ''}`,
      newValues: {
        disposition: ncrDto.disposition,
        status: ncrDto.status,
        linkedReworkNumber: reworkOrderDto?.reworkNumber,
        dispositionDocNumber: ncrDto.dispositionDocNumber,
      },
    });

    const responsePayload = { ncr: ncrDto, reworkOrder: reworkOrderDto, document: resultDoc };
    await saveDbQualityIdempotencyInTx(tx, 'DISPOSITION_NCR', input.idempotencyKey, fpPayload, 200, responsePayload);
    return { ok: true, statusCode: 200, idempotentReplay: false, ...responsePayload };
  });

  if (result.ok && !result.idempotentReplay && result.ncr) {
    bridge.recordAudit({
      action: 'NCR_DISPOSITION',
      entityName: 'Nonconformance',
      entityId: result.ncr.ncrNumber,
      user: input.user,
      details: `تعیین تکلیف «${result.ncr.disposition}» برای ${result.ncr.ncrNumber}${result.reworkOrder ? ` | دستور دوباره‌کاری: ${result.reworkOrder.reworkNumber}` : ''}`,
    });
  }
  return result;
}

async function completeReworkOrderInDb(
  reworkIdOrNumber: string,
  input: {
    goodQty: number;
    scrapQty?: number;
    returnToProduction?: boolean;
    completionNotes?: string;
    idempotencyKey?: string;
    user: { uid: string; displayName: string };
  },
  bridge: QualityInventoryBridge,
  fpPayload: unknown
): Promise<{
  ok: boolean;
  statusCode: number;
  error?: string;
  idempotentReplay?: boolean;
  reworkOrder?: ReworkOrderRecord;
  ncr?: NonconformanceRecord;
  releaseDocument?: InventoryDocument;
  scrapDocument?: InventoryDocument;
}> {
  const goodQty = Number(input.goodQty || 0);
  const scrapQty = Number(input.scrapQty || 0);

  const result = await runQualityTransaction('COMPLETE_REWORK', input.idempotencyKey, fpPayload, async tx => {
    const existingRw = await dbFindReworkByIdOrNumber(tx, reworkIdOrNumber);
    if (!existingRw) {
      throw new QualityTxAbortError(404, `دستور دوباره‌کاری «${reworkIdOrNumber}» یافت نشد.`);
    }
    if (existingRw.status === 'COMPLETED' || existingRw.status === 'CANCELLED') {
      throw new QualityTxAbortError(409, `دستور دوباره‌کاری «${existingRw.reworkNumber}» قبلاً بسته شده است.`);
    }
    const currentRemaining = Number(existingRw.remainingQty);
    if (goodQty + scrapQty > currentRemaining + EPS) {
      throw new QualityTxAbortError(
        409,
        `مجموع گزارش سالم (${goodQty}) و ضایعات (${scrapQty}) بیشتر از مانده دستور دوباره‌کاری (${currentRemaining}) است.`
      );
    }

    const partId = existingRw.partId || existingRw.partRefId;
    const part = bridge.parts.find(p => p.id === partId || p.code === existingRw.partCode);
    const weightPerUnit = existingRw.unit === 'KG' ? 1 : Number(part?.weightPerUnitKg || 1);
    const matchedCoil = (existingRw.physicalCoilId || existingRw.coilRefId)
      ? bridge.coils.find(c => c.id === existingRw.physicalCoilId || c.id === existingRw.coilRefId)
      : existingRw.coilId
      ? bridge.coils.find(c => c.coilId === existingRw.coilId)
      : undefined;
    const matchedBalance = resolveMatchingBalance(bridge, {
      balanceId: existingRw.balanceId || undefined,
      partId,
      warehouseId: existingRw.warehouseId || existingRw.warehouseRefId || undefined,
      lotNumber: existingRw.lotNumber || undefined,
      coilId: existingRw.coilId || undefined,
    });

    let releaseDocument: InventoryDocument | undefined;
    let scrapDocument: InventoryDocument | undefined;
    const shouldReturnToProduction = input.returnToProduction ?? Boolean(existingRw.returnToProduction);

    if (goodQty > EPS && matchedBalance) {
      const heldTotal = round3(matchedBalance.qualityInspectionQty + matchedBalance.blockedQty);
      const releaseQty = round3(Math.min(goodQty, heldTotal));
      if (releaseQty > EPS) {
        const res321 = await bridge.executeQmTransfer({
          key: matchedBalance.id,
          partId,
          partCode: existingRw.partCode,
          warehouseId: matchedBalance.warehouseId,
          locationCode: matchedBalance.locationCode,
          lotNumber: matchedBalance.lotNumber,
          physicalCoilId: matchedCoil?.id,
          ownership: matchedBalance.ownership,
          contractId: matchedBalance.contractId,
          isHeld: false,
          movementType: '321',
          heldQty: releaseQty,
          heldWeightKg: round3(releaseQty * weightPerUnit),
          reasonFa: shouldReturnToProduction
            ? `تکمیل دوباره‌کاری ${existingRw.reworkNumber} و بازگشت به خط تولید${existingRw.moNumber ? ` (${existingRw.moNumber})` : ''}`
            : `تکمیل دوباره‌کاری ${existingRw.reworkNumber} و آزادسازی به موجودی انبار`,
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:321` : undefined,
          user: input.user,
        });
        if (!res321.success) {
          throw new QualityTxAbortError(res321.statusCode || 409, res321.error || 'خطا در ترخیص دوباره‌کاری (321)');
        }
        releaseDocument = res321.document;
      }
    } else if (goodQty > EPS && matchedCoil) {
      matchedCoil.qualityStatus = 'AVAILABLE';
      matchedCoil.physicalStatus = matchedCoil.remainingWeightKg > EPS ? 'AVAILABLE' : 'CONSUMED';
    }

    if (scrapQty > EPS && matchedBalance) {
      const sourceBucket: StockQualityStatus =
        matchedBalance.blockedQty >= scrapQty - EPS
          ? 'QUALITY_BLOCKED'
          : matchedBalance.qualityInspectionQty >= scrapQty - EPS
          ? 'QUARANTINE'
          : matchedBalance.blockedQty > EPS
          ? 'QUALITY_BLOCKED'
          : matchedBalance.qualityInspectionQty > EPS
          ? 'QUARANTINE'
          : 'AVAILABLE';
      const maxDeductible =
        sourceBucket === 'QUALITY_BLOCKED'
          ? matchedBalance.blockedQty
          : sourceBucket === 'QUARANTINE'
          ? matchedBalance.qualityInspectionQty
          : matchedBalance.availableQty;
      const writeOffQty = round3(Math.min(scrapQty, maxDeductible));
      if (writeOffQty > EPS) {
        const adjRes = await bridge.postQualityAdjustment({
          partId,
          warehouseId: matchedBalance.warehouseId,
          locationCode: matchedBalance.locationCode,
          lotNumber: matchedBalance.lotNumber,
          physicalCoilId: matchedCoil?.id,
          ownership: matchedBalance.ownership,
          contractId: matchedBalance.contractId,
          contractNumber: matchedBalance.contractNumber,
          quantityDelta: -writeOffQty,
          qualityStatus: sourceBucket,
          referenceType: 'QUALITY_SCRAP',
          referenceNumber: existingRw.reworkNumber,
          reasonFa: `ضایعات غیرقابل اصلاح در دستور دوباره‌کاری ${existingRw.reworkNumber} (مرتبط با ${existingRw.ncrNumber})`,
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:SCRAP` : undefined,
          creditScrapWarehouse: true,
          user: input.user,
        });
        if (!adjRes.success) {
          throw new QualityTxAbortError(adjRes.statusCode || 409, adjRes.error || 'خطا در ثبت ضایعات دوباره‌کاری');
        }
        scrapDocument = adjRes.document;
      }
    }

    const now = new Date();
    const nextCompletedGoodQty = round3(Number(existingRw.completedGoodQty || 0) + goodQty);
    const nextScrappedQty = round3(Number(existingRw.scrappedQty || 0) + scrapQty);
    const nextRemainingQty = round3(
      Math.max(0, Number(existingRw.plannedReworkQty) - nextCompletedGoodQty - nextScrappedQty)
    );
    const nextRwStatus = nextRemainingQty <= EPS ? 'COMPLETED' : 'IN_PROGRESS';

    if (nextRwStatus === 'COMPLETED') {
      await syncLinkedEntityQualityStatusInTx(tx, {
        physicalCoilId: existingRw.physicalCoilId,
        materialLotId: existingRw.materialLotId,
        qualityStatus: nextCompletedGoodQty > EPS ? 'AVAILABLE' : 'REJECTED',
        physicalStatus: nextCompletedGoodQty > EPS ? 'AVAILABLE' : 'CONSUMED',
      });
    }

    const returnDocDbId = releaseDocument
      ? await resolveInventoryDocIdInTx(tx, releaseDocument)
      : existingRw.returnDocumentId;
    const scrapDocDbId = scrapDocument
      ? await resolveInventoryDocIdInTx(tx, scrapDocument)
      : existingRw.scrapDocumentId;

    const updatedRwRow = await tx.qualityReworkOrder.update({
      where: { id: existingRw.id },
      data: {
        completedGoodQty: nextCompletedGoodQty,
        scrappedQty: nextScrappedQty,
        remainingQty: nextRemainingQty,
        returnToProduction: shouldReturnToProduction,
        returnDocumentId: returnDocDbId ?? null,
        returnDocumentNumber: releaseDocument?.documentNumber || existingRw.returnDocumentNumber || null,
        scrapDocumentId: scrapDocDbId ?? null,
        scrapDocumentNumber: scrapDocument?.documentNumber || existingRw.scrapDocumentNumber || null,
        completionNotes: input.completionNotes || existingRw.completionNotes || null,
        status: nextRwStatus,
        completedAt: nextRwStatus === 'COMPLETED' ? now : existingRw.completedAt,
        version: { increment: 1 },
      },
    });

    let updatedNcrDto: NonconformanceRecord | undefined;
    const linkedNcrRow = await tx.qualityNonconformance.findUnique({ where: { id: existingRw.ncrId } });
    if (linkedNcrRow) {
      const ncrReworkedGood = round3(Number(linkedNcrRow.reworkedGoodQty || 0) + goodQty);
      const ncrScrapped = round3(Number(linkedNcrRow.scrappedQty || 0) + scrapQty);
      const ncrReturnedToProd = shouldReturnToProduction
        ? round3(Number(linkedNcrRow.returnedToProductionQty || 0) + goodQty)
        : Number(linkedNcrRow.returnedToProductionQty || 0);
      const totalResolved = round3(
        ncrReworkedGood + ncrScrapped + Number(linkedNcrRow.returnedToSupplierQty || 0)
      );
      const shouldClose = totalResolved + EPS >= Number(linkedNcrRow.affectedQty);

      const updatedNcrRow = await tx.qualityNonconformance.update({
        where: { id: linkedNcrRow.id },
        data: {
          reworkedGoodQty: ncrReworkedGood,
          scrappedQty: ncrScrapped,
          returnedToProductionQty: ncrReturnedToProd,
          status: shouldClose ? 'CLOSED' : linkedNcrRow.status,
          resultingQualityStatus: shouldClose
            ? ncrReworkedGood > EPS
              ? 'AVAILABLE'
              : 'REJECTED'
            : linkedNcrRow.resultingQualityStatus,
          closedAt: shouldClose ? now : linkedNcrRow.closedAt,
          closedByName: shouldClose ? input.user.displayName : linkedNcrRow.closedByName,
          version: { increment: 1 },
        },
      });
      updatedNcrDto = mapDbNcrToDto(updatedNcrRow);
    }

    const rwDto = mapDbReworkToDto(updatedRwRow);
    await recordQualityAuditInTx(tx, {
      action: 'REWORK_COMPLETE',
      entityName: 'ReworkOrder',
      entityId: rwDto.reworkNumber,
      user: input.user,
      details: `ثبت نتیجه دوباره‌کاری ${rwDto.reworkNumber}: سالم ${goodQty}، ضایعات ${scrapQty}، بازگشت به تولید: ${shouldReturnToProduction ? 'بله' : 'خیر'}`,
      newValues: {
        status: rwDto.status,
        completedGoodQty: rwDto.completedGoodQty,
        scrappedQty: rwDto.scrappedQty,
        remainingQty: rwDto.remainingQty,
        ncrStatus: updatedNcrDto?.status,
      },
    });

    const responsePayload = {
      reworkOrder: rwDto,
      ncr: updatedNcrDto,
      releaseDocument,
      scrapDocument,
    };
    await saveDbQualityIdempotencyInTx(tx, 'COMPLETE_REWORK', input.idempotencyKey, fpPayload, 200, responsePayload);
    return { ok: true, statusCode: 200, idempotentReplay: false, ...responsePayload };
  });

  if (result.ok && !result.idempotentReplay && result.reworkOrder) {
    bridge.recordAudit({
      action: 'REWORK_COMPLETE',
      entityName: 'ReworkOrder',
      entityId: result.reworkOrder.reworkNumber,
      user: input.user,
      details: `ثبت نتیجه دوباره‌کاری ${result.reworkOrder.reworkNumber}: سالم ${goodQty}، ضایعات ${scrapQty}`,
    });
  }
  return result;
}

