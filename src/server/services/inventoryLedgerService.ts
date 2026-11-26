import crypto from 'node:crypto';
import {
  InventoryDocType,
  InventoryDocument,
  InventoryDocumentLine,
  InventoryReservation,
  InventoryTransaction,
  StageInventorySummary,
  FACTORY_STAGES,
  DetailedStockBalance,
  InventoryDashboardMetrics,
  SapcoContract,
  SapcoContractLedgerEntry,
  PhysicalCoil,
  CoilIssueReturnRecord,
  CoilContractAllocationSegment,
  Part,
  StockOwnership,
  StockQualityStatus,
  SapMovementType,
  SAP_MOVEMENT_CATALOG,
  resolveSapMovementType,
} from '../../types/inventory';
import { getPrismaClient, isDatabaseUrlConfigured } from '../db/prisma';

const EPS = 1e-6;
const round6 = (val: number): number => Math.round(val * 1_000_000) / 1_000_000;

export type LedgerMovementType =
  | 'INBOUND'
  | 'OUTBOUND'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'ADJUSTMENT_POS'
  | 'ADJUSTMENT_NEG';

export interface PostDocumentDbOptions {
  /** Optional injectable Prisma-compatible client for isolated unit/regression tests. */
  prismaClient?: any;
  /** Optional idempotency key (e.g. from Idempotency-Key HTTP header). */
  idempotencyKey?: string;
  /** Original client/draft document ID when promoting an unposted draft to PG. */
  sourceDraftId?: string;
  /** Exclude server-generated random documentNumber from idempotency request fingerprint. */
  excludeDocumentNumberFromFingerprint?: boolean;
  /** Bounded retries for PostgreSQL serialization (P2034/40001) and deadlock (40P01) errors. Default: 3. */
  maxSerializationRetries?: number;
  /** Base delay in ms for exponential backoff with jitter. Default: 25. */
  retryBaseDelayMs?: number;
}

export interface PostDocumentDbResult {
  success: boolean;
  postedDocument?: InventoryDocument;
  idempotentReplay?: boolean;
  statusCode?: number;
  errorCode?: string;
  error?: string;
  createdCoilIds?: string[];
  dbDocumentId?: string;
  dbDocumentNumber?: string;
  attempts?: number;
}

export class InventoryPostingError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.name = 'InventoryPostingError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const DOC_TYPE_MAP: Record<InventoryDocType, string> = {
  OPENING_BALANCE: 'INITIAL_BALANCE',
  RECEIPT_RAW_MATERIAL: 'RECEIPT',
  RECEIPT_FINISHED_GOODS: 'RECEIPT',
  ISSUE_RAW_MATERIAL: 'ISSUE',
  ISSUE_FINISHED_GOODS: 'ISSUE',
  DELIVERY_CUSTOMER: 'ISSUE',
  SHIPMENT_CUSTOMER: 'ISSUE',
  TRANSFER: 'WIP_TRANSFER',
  STOCK_STATUS_TRANSFER: 'COUNT_ADJUSTMENT',
  ADJUSTMENT: 'COUNT_ADJUSTMENT',
  REVERSAL: 'COUNT_ADJUSTMENT',
};

const VALID_QUALITY_STATUSES = new Set<string>([
  'AVAILABLE',
  'QUARANTINE',
  'QUALITY_BLOCKED',
  'REJECTED',
  'IN_TRANSIT',
  'SCRAP',
]);

function invertMovementType(type: LedgerMovementType): LedgerMovementType {
  switch (type) {
    case 'INBOUND':
      return 'OUTBOUND';
    case 'OUTBOUND':
      return 'INBOUND';
    case 'TRANSFER_OUT':
      return 'TRANSFER_IN';
    case 'TRANSFER_IN':
      return 'TRANSFER_OUT';
    case 'ADJUSTMENT_POS':
      return 'ADJUSTMENT_NEG';
    case 'ADJUSTMENT_NEG':
      return 'ADJUSTMENT_POS';
  }
}

function lotStatusForQuality(qualityStatus: string, remainingWeightKg: number): 'AVAILABLE' | 'CONSUMED' | 'QUARANTINE' | 'REJECTED' {
  if (remainingWeightKg <= EPS) return 'CONSUMED';
  if (qualityStatus === 'QUARANTINE') return 'QUARANTINE';
  if (qualityStatus === 'REJECTED' || qualityStatus === 'QUALITY_BLOCKED') return 'REJECTED';
  return 'AVAILABLE';
}

function physicalStatusForCoil(
  remainingWeightKg: number,
  originalWeightKg: number,
  qualityStatus: string,
  options?: { isReversedReceipt?: boolean }
): string {
  if (remainingWeightKg <= EPS) {
    return options?.isReversedReceipt ? 'RETURNED' : 'CONSUMED';
  }
  if (qualityStatus === 'QUALITY_BLOCKED' || qualityStatus === 'REJECTED') {
    return 'BLOCKED';
  }
  if (remainingWeightKg < originalWeightKg - EPS) {
    return 'PARTIALLY_ISSUED';
  }
  return 'AVAILABLE';
}

export function buildDocumentRequestFingerprint(
  document: InventoryDocument,
  options?: { includeDocumentNumber?: boolean }
): string {
  const includeDocumentNumber = options?.includeDocumentNumber !== false;
  const canonical: Record<string, any> = {
    documentType: document.documentType,
    movementType: document.movementType || null,
    qmStatusTarget: document.qmStatusTarget || null,
    warehouseId: String(document.warehouseId || '').trim(),
    targetWarehouseId: document.targetWarehouseId ? String(document.targetWarehouseId).trim() : null,
    ownership: document.ownership || 'COMPANY_OWNED',
    contractId: document.contractId || null,
    reversalOfDocumentId: document.reversalOfDocumentId || null,
    reversalOfDocumentNumber: document.reversalOfDocumentNumber || document.reversalOfDocNumber || null,
    adjustmentReason: isReversalDocumentRequest(document) ? String(document.adjustmentReason || '').trim() || null : null,
    lines: (document.lines || []).map(l => ({
      lineNumber: Number(l.lineNumber),
      partId: l.partId || null,
      partCode: l.partCode || null,
      physicalCoilId: l.physicalCoilId || null,
      coilId: l.coilId || null,
      coilPackNumber: l.coilPackNumber || null,
      materialLotId: l.materialLotId || null,
      lotNumber: l.lotNumber || null,
      locationCode: l.locationCode || null,
      targetLocationCode: l.targetLocationCode || null,
      quantity: round6(Number(l.quantity)),
      unit: l.unit || null,
      quantityKg: round6(Number(l.quantityKg)),
      ownership: l.ownership || document.ownership || 'COMPANY_OWNED',
      contractId: l.contractId || document.contractId || null,
      qualityStatus: l.qualityStatus || 'AVAILABLE',
      sourceQualityStatus: l.sourceQualityStatus || null,
      targetQualityStatus: l.targetQualityStatus || null,
      contractAllocations: (l.contractAllocations || []).map(a => ({
        contractId: a.contractId,
        contractNumber: a.contractNumber || null,
        allocatedWeightKg: round6(Number(a.allocatedWeightKg)),
        ownership: a.ownership || null,
      })),
    })),
  };
  if (includeDocumentNumber) {
    canonical.documentNumber = String(document.documentNumber || '').trim();
  }
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function isReversalDocumentRequest(document: InventoryDocument): boolean {
  return (
    document.documentType === 'REVERSAL' ||
    Boolean(document.reversalOfDocumentId) ||
    Boolean(document.reversalOfDocumentNumber) ||
    Boolean(document.reversalOfDocNumber)
  );
}

function extractPgSqlState(err: any): string | null {
  const candidates = [
    err?.code,
    err?.meta?.code,
    err?.cause?.code,
    err?.originalError?.code,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim().toUpperCase();
  }
  const msg = String(err?.message || '');
  if (msg.includes('40001') || /could not serialize access/i.test(msg)) return '40001';
  if (msg.includes('40P01') || /deadlock detected/i.test(msg)) return '40P01';
  return null;
}

export function isRetryablePgTxError(err: any): boolean {
  if (!err || err instanceof InventoryPostingError) return false;
  const code = extractPgSqlState(err);
  return code === 'P2034' || code === '40001' || code === '40P01';
}

const isRetryableSerializationError = isRetryablePgTxError;

function deriveAggregateQualityStatus(
  balances: Array<{ qualityStatus: string; quantityOnHand: any; weightKgOnHand: any }>,
  fallbackStatus: string
): string {
  const positiveStatuses = new Set<string>();
  for (const b of balances) {
    if (Number(b.quantityOnHand || 0) > EPS || Number(b.weightKgOnHand || 0) > EPS) {
      positiveStatuses.add(String(b.qualityStatus || 'AVAILABLE'));
    }
  }
  if (positiveStatuses.size === 0) return fallbackStatus;
  if (positiveStatuses.size === 1) return [...positiveStatuses][0];
  // Partial hold: keep physical coil/lot AVAILABLE while remaining positive unrestricted stock exists
  if (positiveStatuses.has('AVAILABLE')) return 'AVAILABLE';
  // Multiple hold statuses without unrestricted stock: choose most restrictive
  if (positiveStatuses.has('REJECTED')) return 'REJECTED';
  if (positiveStatuses.has('QUALITY_BLOCKED')) return 'QUALITY_BLOCKED';
  if (positiveStatuses.has('QUARANTINE')) return 'QUARANTINE';
  return [...positiveStatuses][0];
}

function mapPrismaError(err: any): { statusCode: number; errorCode: string; message: string } | null {
  const code = extractPgSqlState(err);
  if (code === 'P2002') {
    const target = Array.isArray(err?.meta?.target) ? err.meta.target.join(', ') : String(err?.meta?.target || '');
    return {
      statusCode: 409,
      errorCode: 'UNIQUE_CONSTRAINT_CONFLICT',
      message: `تعارض یکتایی در پایگاه داده${target ? ` (${target})` : ''}؛ رکورد یا سند تکراری مجاز نیست.`,
    };
  }
  if (code === 'P2034' || code === '40001') {
    return {
      statusCode: 409,
      errorCode: 'SERIALIZATION_CONFLICT',
      message: 'تداخل تراکنش همزمان در سطح ایزوله‌سازی Serializable رخ داد؛ لطفاً درخواست را مجدداً ارسال کنید.',
    };
  }
  if (code === '40P01') {
    return {
      statusCode: 409,
      errorCode: 'DEADLOCK_CONFLICT',
      message: 'بن‌بست موقت تراکنش همزمان در پایگاه داده (Deadlock) رخ داد و پس از تلاش مجدد برطرف نشد؛ لطفاً دوباره ارسال کنید.',
    };
  }
  if (code === 'P2003') {
    return {
      statusCode: 400,
      errorCode: 'FOREIGN_KEY_VIOLATION',
      message: 'ارجاع کلید خارجی نامعتبر است؛ اطلاعات پایه مرتبط در پایگاه داده وجود ندارد.',
    };
  }
  return null;
}

const sleepMs = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function resolveOrCreateAuditUser(
  tx: any,
  user: { uid: string; displayName: string }
): Promise<{ id: string }> {
  let dbUser = await tx.user.findFirst({
    where: { OR: [{ username: user.uid }, { email: `${user.uid}@kpims.local` }] },
  });
  if (!dbUser) {
    let defaultRole = await tx.role.findFirst({ where: { active: true }, orderBy: { createdAt: 'asc' } });
    if (!defaultRole) {
      defaultRole = await tx.role.create({
        data: { name: 'ADMIN', displayName: 'مدیر ارشد سیستم', description: 'System Administrator' },
      });
    }
    dbUser = await tx.user.create({
      data: {
        username: user.uid,
        email: `${user.uid}@kpims.local`,
        fullName: user.displayName,
        roleId: defaultRole.id,
      },
    });
  }
  return dbUser;
}

/**
 * Hardened, atomic, idempotent relational document posting engine (KPIMS P0-A).
 *
 * Guarantees:
 * 1. Idempotency: explicit `idempotencyKey` replays safely with identical payload
 *    and rejects mismatched payload with 409; duplicate `documentNumber` without replay
 *    is blocked atomically.
 * 2. Strict master data validation: never auto-creates warehouses or locations.
 * 3. Full physicalCoilId + materialLotId persistence across document lines, transactions,
 *    and stock balances, with coherent single-transaction sheet-metal coil receipts.
 * 4. Paired OUT/IN ledger transactions for STOCK_STATUS_TRANSFER (QM 321/322/344).
 * 5. True reversal semantics: immutable original transactions, explicit `reversalOfId`
 *    and `reversalOfTrxId`, target document marked REVERSED, exact inverse balance +
 *    PhysicalCoil + MaterialLot + contract receipt restoration, and downstream-consumption guard.
 * 6. Atomic conditional deductions with optimistic version CAS (zero silent clamping).
 */
export async function postInventoryDocumentInTransaction(
  document: InventoryDocument,
  user: { uid: string; displayName: string },
  options?: PostDocumentDbOptions
): Promise<PostDocumentDbResult> {
  const injectedClient = options?.prismaClient;
  if (!injectedClient && !isDatabaseUrlConfigured()) {
    return {
      success: false,
      statusCode: 503,
      errorCode: 'DATABASE_NOT_CONFIGURED',
      error: 'اتصال PostgreSQL تنظیم نشده است؛ ثبت قطعی سند بدون پایگاه داده مجاز نیست.',
    };
  }

  if (!document?.documentNumber || !String(document.documentNumber).trim()) {
    return {
      success: false,
      statusCode: 400,
      errorCode: 'INVALID_DOCUMENT_NUMBER',
      error: 'شماره سند انبار الزامی است.',
    };
  }

  const isReversalReq = isReversalDocumentRequest(document);
  if (!isReversalReq && (!Array.isArray(document.lines) || document.lines.length === 0)) {
    return {
      success: false,
      statusCode: 400,
      errorCode: 'EMPTY_DOCUMENT_LINES',
      error: 'حداقل یک ردیف کالا برای ثبت قطعی سند انبار الزامی است.',
    };
  }

  const prisma = injectedClient || getPrismaClient();
  const now = new Date(document.postedAt || new Date().toISOString());
  const idempotencyKey = (options?.idempotencyKey ?? document.idempotencyKey ?? '').trim() || undefined;
  const requestFingerprintWithDocNum = buildDocumentRequestFingerprint(document, {
    includeDocumentNumber: true,
  });
  const requestFingerprintWithoutDocNum = buildDocumentRequestFingerprint(document, {
    includeDocumentNumber: false,
  });
  const requestFingerprint = options?.excludeDocumentNumberFromFingerprint
    ? requestFingerprintWithoutDocNum
    : requestFingerprintWithDocNum;
  const matchesStoredFingerprint = (storedFp?: string | null) => {
    if (!storedFp) return true;
    return storedFp === requestFingerprint || storedFp === requestFingerprintWithoutDocNum;
  };
  const maxRetries = Math.max(0, Math.min(6, options?.maxSerializationRetries ?? 3));
  const retryBaseDelayMs = Math.max(0, options?.retryBaseDelayMs ?? 25);

  let attempt = 0;
  let lastError: any = null;
  const initialRequestSnapshot: InventoryDocument = JSON.parse(JSON.stringify(document));

  while (attempt <= maxRetries) {
    attempt += 1;
    // Clone request data per attempt so rolled-back mutations never leak across retries
    const attemptDoc: InventoryDocument = structuredClone(document);
    const attemptCreatedCoilIds: string[] = [];

    try {
      const txOutcome = await prisma.$transaction(
        async (tx: any) => {
          // ------------------------------------------------------------------
          // 1. IDEMPOTENCY & DUPLICATE-POST GUARD (checked BEFORE reversal/post state checks)
          // ------------------------------------------------------------------
          if (idempotencyKey) {
            const existingByKey = await tx.inventoryDocument.findUnique({
              where: { idempotencyKey },
              include: { lines: true, transactions: true },
            });
            if (existingByKey) {
              const isSameUnpostedDraft =
                existingByKey.postingStatus === 'UNPOSTED' &&
                (existingByKey.documentNumber === attemptDoc.documentNumber ||
                  existingByKey.id === attemptDoc.id);
              if (!matchesStoredFingerprint(existingByKey.requestFingerprint)) {
                throw new InventoryPostingError(
                  'IDEMPOTENCY_PAYLOAD_MISMATCH',
                  409,
                  `کلید یکتای درخواست «${idempotencyKey}» قبلاً با محتوای متفاوتی ثبت شده است.`
                );
              }
              if (existingByKey.postingStatus === 'POSTED') {
                const replayCoilIds = Array.from(
                  new Set(
                    (existingByKey.lines || [])
                      .map((l: any) => l.physicalCoilId)
                      .filter((id: any): id is string => Boolean(id))
                  )
                );
                const replayAudit =
                  typeof tx.auditLog?.findFirst === 'function'
                    ? await tx.auditLog.findFirst({
                        where: {
                          entityName: 'InventoryDocument',
                          entityId: existingByKey.id,
                          action: { in: ['DOCUMENT_POST', 'DOCUMENT_REVERSE'] },
                        },
                        orderBy: { timestamp: 'desc' },
                      })
                    : null;
                const committedDocument = (replayAudit?.newValues as any)?.postedDocument as
                  | InventoryDocument
                  | undefined;
                return {
                  idempotentReplay: true,
                  dbDocumentId: existingByKey.id,
                  dbDocumentNumber: existingByKey.documentNumber,
                  postedAt: existingByKey.postedAt || now,
                  createdCoilIds: replayCoilIds,
                  committedDocument,
                };
              }
              if (!isSameUnpostedDraft) {
                throw new InventoryPostingError(
                  'IDEMPOTENCY_CONFLICT',
                  409,
                  `سند مرتبط با کلید «${idempotencyKey}» در وضعیت غیرقابل تکرار (${existingByKey.postingStatus}) است.`
                );
              }
            }
          }

          const existingDoc = await tx.inventoryDocument.findUnique({
            where: { documentNumber: attemptDoc.documentNumber },
            include: { transactions: true },
          });
        if (existingDoc?.postingStatus === 'POSTED' || existingDoc?.postingStatus === 'REVERSED' || existingDoc?.isReversed) {
          throw new InventoryPostingError(
            'DUPLICATE_POST',
            409,
            `سند شماره «${document.documentNumber}» قبلاً در PostgreSQL قطعی یا ابطال شده است.`
          );
        }
        if (existingDoc?.transactions?.length) {
          throw new InventoryPostingError(
            'DUPLICATE_TRANSACTIONS',
            409,
            'برای این سند گردش انبار قبلاً ایجاد شده است؛ از ثبت مجدد جلوگیری شد.'
          );
        }

        // ------------------------------------------------------------------
        // 2. STRICT MASTER DATA RESOLVERS (ZERO AUTO-CREATION)
        // ------------------------------------------------------------------
        const resolveWarehouseStrict = async (codeOrId: string, label: string) => {
          const key = String(codeOrId || '').trim();
          if (!key) {
            throw new InventoryPostingError('WAREHOUSE_REQUIRED', 400, `${label} مشخص نشده است.`);
          }
          const wh = await tx.warehouse.findFirst({
            where: { OR: [{ code: key }, { id: key }], active: true },
          });
          if (!wh) {
            throw new InventoryPostingError(
              'WAREHOUSE_NOT_FOUND',
              400,
              `${label} با شناسه/کد «${key}» در اطلاعات پایه ثبت نشده یا غیرفعال است.`
            );
          }
          return wh;
        };

        const resolveLocationStrict = async (codeOrId: string | undefined, warehouseId: string) => {
          if (!codeOrId || !String(codeOrId).trim()) return null;
          const key = String(codeOrId).trim();
          const location = await tx.warehouseLocation.findFirst({
            where: { warehouseId, active: true, OR: [{ code: key }, { id: key }] },
          });
          if (!location) {
            throw new InventoryPostingError(
              'LOCATION_NOT_FOUND',
              400,
              `موقعیت انبار «${key}» در انبار انتخاب‌شده تعریف نشده یا غیرفعال است.`
            );
          }
          return location;
        };

        const resolvePostingUser = async () => {
          let dbUser = await tx.user.findFirst({
            where: { OR: [{ username: user.uid }, { email: `${user.uid}@kpims.local` }] },
          });
          if (!dbUser) {
            let defaultRole = await tx.role.findFirst({ where: { active: true }, orderBy: { createdAt: 'asc' } });
            if (!defaultRole) {
              defaultRole = await tx.role.create({
                data: { name: 'ADMIN', displayName: 'مدیر ارشد سیستم', description: 'System Administrator' },
              });
            }
            dbUser = await tx.user.create({
              data: {
                username: user.uid,
                email: `${user.uid}@kpims.local`,
                fullName: user.displayName,
                roleId: defaultRole.id,
              },
            });
          }
          return dbUser;
        };

        // ------------------------------------------------------------------
        // 3. ATOMIC STOCK BALANCE & LEDGER MOVEMENT PRIMITIVE
        // ------------------------------------------------------------------
        const applyStockMovement = async (args: {
          documentId: string;
          documentNumber: string;
          documentLineId: string | null;
          lineNumber: number;
          partId: string;
          partCode: string;
          unitId: string;
          warehouseId: string;
          locationId: string | null;
          materialLotId: string | null;
          physicalCoilId: string | null;
          ownership: string;
          contractId: string | null;
          contractNumber: string | null;
          qualityStatus: string;
          signedQuantity: number;
          signedWeightKg: number;
          suffix: string;
          movementType: LedgerMovementType;
          createdByUserId: string;
          isReversal?: boolean;
          reversalOfTrxId?: string | null;
          allowNonAvailableDeduction?: boolean;
          manufacturingOrderId?: string | null;
          productionOperationId?: string | null;
        }) => {
          const {
            documentId,
            documentNumber,
            documentLineId,
            lineNumber,
            partId,
            partCode,
            unitId,
            warehouseId,
            locationId,
            materialLotId,
            physicalCoilId,
            ownership,
            contractId,
            contractNumber,
            qualityStatus,
            suffix,
            movementType,
            createdByUserId,
            isReversal = false,
            reversalOfTrxId = null,
            allowNonAvailableDeduction = false,
            manufacturingOrderId = null,
            productionOperationId = null,
          } = args;

          if (!VALID_QUALITY_STATUSES.has(qualityStatus)) {
            throw new InventoryPostingError(
              'INVALID_QUALITY_STATUS',
              400,
              `وضعیت کیفی «${qualityStatus}» نامعتبر است.`
            );
          }

          const signedQuantity = round6(args.signedQuantity);
          const signedWeightKg = round6(args.signedWeightKg);
          if (!Number.isFinite(signedQuantity) || !Number.isFinite(signedWeightKg) || Math.abs(signedQuantity) <= EPS) {
            throw new InventoryPostingError(
              'INVALID_QUANTITY',
              400,
              `مقدار حرکت برای قطعه «${partCode}» نامعتبر یا صفر است.`
            );
          }

          const absQty = Math.abs(signedQuantity);
          const absKg = Math.abs(signedWeightKg);

          if (signedQuantity < 0 && qualityStatus !== 'AVAILABLE' && !allowNonAvailableDeduction) {
            throw new InventoryPostingError(
              'QUALITY_STATUS_BLOCKED',
              409,
              `خروج کالای دارای وضعیت کیفی «${qualityStatus}» مجاز نیست؛ ابتدا وضعیت کنترل کیفیت را تعیین تکلیف کنید.`
            );
          }

          const balanceKey = {
            partId,
            warehouseId,
            locationId,
            materialLotId,
            physicalCoilId,
            ownership,
            contractId,
            qualityStatus,
          };

          const existingBalance = await tx.stockBalance.findFirst({ where: balanceKey });
          const currentQty = round6(Number(existingBalance?.quantityOnHand || 0));
          const currentReserved = round6(Number(existingBalance?.quantityReserved || 0));
          const currentKg = round6(Number(existingBalance?.weightKgOnHand || 0));
          const currentReservedKg = round6(Number(existingBalance?.weightKgReserved || 0));
          const nextQty = round6(currentQty + signedQuantity);
          const nextKg = round6(currentKg + signedWeightKg);

          if (signedQuantity < 0) {
            if (!existingBalance) {
              throw new InventoryPostingError(
                'INSUFFICIENT_STOCK',
                409,
                `موجودی پایگاه داده برای قطعه «${partCode}» در این انبار/موقعیت/کویل/وضعیت کیفی وجود ندارد.`
              );
            }
            if (
              nextQty < -EPS ||
              nextKg < -EPS ||
              nextQty - currentReserved < -EPS ||
              nextKg - currentReservedKg < -EPS
            ) {
              const freeQty = round6(Math.max(0, currentQty - currentReserved));
              throw new InventoryPostingError(
                'INSUFFICIENT_STOCK',
                409,
                `موجودی پایگاه داده برای قطعه «${partCode}» در این انبار/بچ کافی نیست. موجودی آزاد: ${freeQty}، مقدار درخواستی: ${absQty}.`
              );
            }

            const finalQty = Math.abs(nextQty) <= EPS ? 0 : nextQty;
            const finalKg = Math.abs(nextKg) <= EPS ? 0 : nextKg;
            const finalAvailQty = qualityStatus === 'AVAILABLE' ? round6(finalQty - currentReserved) : 0;
            const finalAvailKg = qualityStatus === 'AVAILABLE' ? round6(finalKg - currentReservedKg) : 0;
            if (finalAvailQty < -EPS || finalAvailKg < -EPS) {
              throw new InventoryPostingError(
                'RESERVED_STOCK_CONFLICT',
                409,
                `موجودی آزاد قطعه «${partCode}» به دلیل رزرو فعال کافی نیست.`
              );
            }

            const whereGuard: Record<string, any> = {
              id: existingBalance.id,
              version: existingBalance.version ?? 1,
              quantityOnHand: { gte: round6(absQty - EPS) },
              weightKgOnHand: { gte: round6(absKg - EPS) },
            };
            if (qualityStatus === 'AVAILABLE') {
              whereGuard.quantityAvailable = { gte: round6(absQty - EPS) };
              whereGuard.weightKgAvailable = { gte: round6(absKg - EPS) };
            }

            const updated = await tx.stockBalance.updateMany({
              where: whereGuard,
              data: {
                quantityOnHand: finalQty,
                quantityAvailable: Math.abs(finalAvailQty) <= EPS ? 0 : finalAvailQty,
                weightKgOnHand: finalKg,
                weightKgAvailable: Math.abs(finalAvailKg) <= EPS ? 0 : finalAvailKg,
                version: { increment: 1 },
                lastTransactionAt: now,
                updatedAt: now,
              },
            });

            if (updated.count !== 1) {
              throw new InventoryPostingError(
                'CONCURRENCY_OR_OVERDRAFT',
                409,
                `تداخل همزمان یا کمبود موجودی برای قطعه «${partCode}» هنگام کسر اتمیک موجودی رخ داد.`
              );
            }

            await tx.inventoryTransaction.create({
              data: {
                transactionNumber: `${documentNumber}-L${String(lineNumber).padStart(3, '0')}-${suffix}`,
                documentId,
                documentLineId,
                partId,
                materialLotId,
                physicalCoilId,
                warehouseId,
                locationId,
                transactionType: movementType,
                quantity: absQty,
                quantitySigned: signedQuantity,
                unitId,
                weightKg: absKg,
                weightKgSigned: signedWeightKg,
                ownership,
                contractId,
                contractNumber,
                qualityStatus,
                balanceAfter: finalQty,
                balanceKgAfter: finalKg,
                transactionDate: now,
                postingStatus: 'POSTED',
                isReversal,
                reversalOfTrxId,
                createdByUserId,
                ...(manufacturingOrderId ? { manufacturingOrderId } : {}),
                ...(productionOperationId ? { productionOperationId } : {}),
              },
            });

            return { balanceAfter: finalQty, balanceKgAfter: finalKg };
          }

          // Positive addition (signedQuantity > 0)
          const finalQty = nextQty;
          const finalKg = nextKg;
          const finalAvailQty = qualityStatus === 'AVAILABLE' ? round6(finalQty - currentReserved) : 0;
          const finalAvailKg = qualityStatus === 'AVAILABLE' ? round6(finalKg - currentReservedKg) : 0;

          if (existingBalance) {
            const updated = await tx.stockBalance.updateMany({
              where: {
                id: existingBalance.id,
                version: existingBalance.version ?? 1,
              },
              data: {
                quantityOnHand: finalQty,
                quantityAvailable: finalAvailQty,
                weightKgOnHand: finalKg,
                weightKgAvailable: finalAvailKg,
                version: { increment: 1 },
                lastTransactionAt: now,
                updatedAt: now,
              },
            });
            if (updated.count !== 1) {
              throw new InventoryPostingError(
                'CONCURRENCY_CONFLICT',
                409,
                `تداخل همزمان هنگام افزایش موجودی قطعه «${partCode}» رخ داد؛ لطفاً مجدداً تلاش کنید.`
              );
            }
          } else {
            await tx.stockBalance.create({
              data: {
                partId,
                warehouseId,
                locationId,
                materialLotId,
                physicalCoilId,
                quantityOnHand: finalQty,
                quantityReserved: 0,
                quantityAvailable: finalAvailQty,
                weightKgOnHand: finalKg,
                weightKgReserved: 0,
                weightKgAvailable: finalAvailKg,
                ownership,
                contractId,
                contractNumber,
                qualityStatus,
                version: 1,
                lastTransactionAt: now,
              },
            });
          }

          await tx.inventoryTransaction.create({
            data: {
              transactionNumber: `${documentNumber}-L${String(lineNumber).padStart(3, '0')}-${suffix}`,
              documentId,
              documentLineId,
              partId,
              materialLotId,
              physicalCoilId,
              warehouseId,
              locationId,
              transactionType: movementType,
              quantity: absQty,
              quantitySigned: signedQuantity,
              unitId,
              weightKg: absKg,
              weightKgSigned: signedWeightKg,
              ownership,
              contractId,
              contractNumber,
              qualityStatus,
              balanceAfter: finalQty,
              balanceKgAfter: finalKg,
              transactionDate: now,
              postingStatus: 'POSTED',
              isReversal,
              reversalOfTrxId,
              createdByUserId,
              ...(manufacturingOrderId ? { manufacturingOrderId } : {}),
              ...(productionOperationId ? { productionOperationId } : {}),
            },
          });

          return { balanceAfter: finalQty, balanceKgAfter: finalKg };
        };

        // ------------------------------------------------------------------
        // 4. ATOMIC PHYSICAL COIL & MATERIAL LOT WEIGHT RECONCILIATION
        // ------------------------------------------------------------------
        const reconcileLotWeightDelta = async (lotId: string, signedWeightKg: number, qualityStatus: string) => {
          const delta = round6(signedWeightKg);
          if (Math.abs(delta) <= EPS) return;
          const lot = await tx.materialLot.findUnique({ where: { id: lotId } });
          if (!lot) {
            throw new InventoryPostingError('MATERIAL_LOT_NOT_FOUND', 404, `بچ/کویل با شناسه «${lotId}» یافت نشد.`);
          }
          const currentWeight = round6(Number(lot.remainingWeightKg));
          const nextWeight = round6(currentWeight + delta);
          if (nextWeight < -EPS) {
            throw new InventoryPostingError(
              'INSUFFICIENT_LOT_WEIGHT',
              409,
              `وزن قابل مصرف بچ/کویل «${lot.lotNumber}» کافی نیست. مانده: ${currentWeight}، درخواست: ${Math.abs(delta)} کیلوگرم.`
            );
          }
          const finalWeight = Math.abs(nextWeight) <= EPS ? 0 : nextWeight;
          const lotBalances = await tx.stockBalance.findMany({ where: { materialLotId: lot.id } });
          const derivedQuality = deriveAggregateQualityStatus(lotBalances, qualityStatus);
          const nextStatus = lotStatusForQuality(derivedQuality, finalWeight);

          const whereLotGuard: Record<string, any> = {
            id: lotId,
            remainingWeightKg: lot.remainingWeightKg,
            status: lot.status,
          };
          if (delta < 0) {
            const absDelta = Math.abs(delta);
            whereLotGuard.AND = [{ remainingWeightKg: { gte: round6(absDelta - EPS) } }];
          }

          const updated = await tx.materialLot.updateMany({
            where: whereLotGuard,
            data: {
              remainingWeightKg: finalWeight,
              status: nextStatus,
              updatedAt: now,
            },
          });
          if (updated.count !== 1) {
            throw new InventoryPostingError(
              delta < 0 ? 'INSUFFICIENT_LOT_WEIGHT' : 'LOT_CONCURRENCY_CONFLICT',
              409,
              `تداخل همزمان یا کمبود وزن قابل مصرف در بچ/کویل «${lot.lotNumber}».`
            );
          }
        };

        const syncDerivedCoilAndLotQuality = async (coilId: string | null, lotId: string | null) => {
          if (coilId) {
            const coil = await tx.physicalCoil.findUnique({ where: { id: coilId } });
            if (coil) {
              const coilBalances = await tx.stockBalance.findMany({
                where: { physicalCoilId: coil.id },
              });
              const derivedQuality = deriveAggregateQualityStatus(coilBalances, coil.qualityStatus);
              const nextPhysicalStatus = physicalStatusForCoil(
                Number(coil.remainingWeightKg),
                Number(coil.originalWeightKg),
                derivedQuality
              );
              if (coil.qualityStatus !== derivedQuality || coil.physicalStatus !== nextPhysicalStatus) {
                const updatedCoil = await tx.physicalCoil.updateMany({
                  where: { id: coil.id, version: coil.version ?? 1 },
                  data: {
                    qualityStatus: derivedQuality,
                    physicalStatus: nextPhysicalStatus,
                    version: { increment: 1 },
                    updatedAt: now,
                  },
                });
                if (updatedCoil.count !== 1) {
                  throw new InventoryPostingError(
                    'COIL_CONCURRENCY_CONFLICT',
                    409,
                    `تداخل همزمان هنگام همگام‌سازی وضعیت کیفی کلاف «${coil.coilId}» رخ داد.`
                  );
                }
              }
            }
          }

          if (lotId) {
            const lot = await tx.materialLot.findUnique({ where: { id: lotId } });
            if (lot) {
              const lotBalances = await tx.stockBalance.findMany({
                where: { materialLotId: lot.id },
              });
              const derivedQuality = deriveAggregateQualityStatus(lotBalances, 'AVAILABLE');
              const nextLotStatus = lotStatusForQuality(derivedQuality, Number(lot.remainingWeightKg));
              if (lot.status !== nextLotStatus) {
                const updatedLot = await tx.materialLot.updateMany({
                  where: {
                    id: lot.id,
                    remainingWeightKg: lot.remainingWeightKg,
                    status: lot.status,
                  },
                  data: {
                    status: nextLotStatus,
                    updatedAt: now,
                  },
                });
                if (updatedLot.count !== 1) {
                  throw new InventoryPostingError(
                    'LOT_CONCURRENCY_CONFLICT',
                    409,
                    `تداخل همزمان هنگام همگام‌سازی وضعیت کیفی بچ «${lot.lotNumber}» رخ داد.`
                  );
                }
              }
            }
          }
        };

        const reconcileCoilWeightDelta = async (
          coilId: string,
          signedWeightKg: number,
          options?: { enforceUpperBound?: boolean; isReversedReceipt?: boolean }
        ) => {
          const delta = round6(signedWeightKg);
          if (Math.abs(delta) <= EPS) return;
          const coil = await tx.physicalCoil.findUnique({ where: { id: coilId } });
          if (!coil) {
            throw new InventoryPostingError('PHYSICAL_COIL_NOT_FOUND', 404, `کلاف فیزیکی «${coilId}» یافت نشد.`);
          }
          const currentWeight = round6(Number(coil.remainingWeightKg));
          const originalWeight = round6(Number(coil.originalWeightKg));
          const nextWeight = round6(currentWeight + delta);

          if (nextWeight < -EPS) {
            throw new InventoryPostingError(
              'INSUFFICIENT_COIL_WEIGHT',
              409,
              `وزن قابل مصرف کلاف فیزیکی «${coil.coilId}» کافی نیست. مانده: ${currentWeight}، درخواست: ${Math.abs(delta)} کیلوگرم.`
            );
          }
          if (options?.enforceUpperBound && nextWeight > originalWeight + EPS) {
            throw new InventoryPostingError(
              'COIL_WEIGHT_EXCEEDS_ORIGINAL',
              409,
              `بازگشت یا افزایش وزن کلاف «${coil.coilId}» (${nextWeight} کیلوگرم) از وزن اولیه (${originalWeight} کیلوگرم) بیشتر است.`
            );
          }

          const finalWeight = Math.abs(nextWeight) <= EPS ? 0 : nextWeight;
          const coilBalances = await tx.stockBalance.findMany({ where: { physicalCoilId: coil.id } });
          const derivedQuality = deriveAggregateQualityStatus(coilBalances, coil.qualityStatus);
          const nextPhysicalStatus = physicalStatusForCoil(finalWeight, originalWeight, derivedQuality, {
            isReversedReceipt: options?.isReversedReceipt,
          });

          const whereGuard: Record<string, any> = {
            id: coil.id,
            version: coil.version ?? 1,
          };
          if (delta < 0) {
            whereGuard.remainingWeightKg = { gte: round6(Math.abs(delta) - EPS) };
          }

          const updated = await tx.physicalCoil.updateMany({
            where: whereGuard,
            data: {
              remainingWeightKg: finalWeight,
              qualityStatus: derivedQuality,
              physicalStatus: nextPhysicalStatus,
              version: { increment: 1 },
              updatedAt: now,
            },
          });
          if (updated.count !== 1) {
            throw new InventoryPostingError(
              'COIL_CONCURRENCY_OR_OVERDRAFT',
              409,
              `تداخل همزمان یا کمبود وزن در به‌روزرسانی کلاف فیزیکی «${coil.coilId}» رخ داد.`
            );
          }
        };

        const dbUser = await resolvePostingUser();

        // ------------------------------------------------------------------
        // 5. TRUE REVERSAL BRANCH (IMMUTABLE ORIGINALS + EXACT INVERSE LEDGER)
        // ------------------------------------------------------------------
        if (isReversalReq) {
          const targetRef =
            document.reversalOfDocumentId ||
            document.reversalOfDocumentNumber ||
            document.reversalOfDocNumber;
          if (!targetRef) {
            throw new InventoryPostingError(
              'REVERSAL_TARGET_REQUIRED',
              400,
              'شناسه یا شماره سند اصلی برای ثبت سند ابطال الزامی است.'
            );
          }

          const targetDoc = await tx.inventoryDocument.findFirst({
            where: { OR: [{ id: targetRef }, { documentNumber: targetRef }] },
            include: {
              lines: { orderBy: { lineNumber: 'asc' } },
              transactions: { orderBy: { createdAt: 'asc' } },
            },
          });
          if (!targetDoc) {
            throw new InventoryPostingError(
              'REVERSAL_TARGET_NOT_FOUND',
              404,
              `سند اصلی «${targetRef}» در PostgreSQL یافت نشد.`
            );
          }
          if (targetDoc.postingStatus !== 'POSTED' || targetDoc.isReversed) {
            throw new InventoryPostingError(
              'ALREADY_REVERSED',
              409,
              `سند «${targetDoc.documentNumber}» در وضعیت «${targetDoc.postingStatus}» است و مجدداً قابل ابطال نیست.`
            );
          }
          if (targetDoc.reversalOfId) {
            throw new InventoryPostingError(
              'CANNOT_REVERSE_REVERSAL',
              400,
              `سند «${targetDoc.documentNumber}» خود یک سند ابطال است و قابل ابطال مجدد نیست.`
            );
          }

          const existingReversal = await tx.inventoryDocument.findFirst({
            where: { reversalOfId: targetDoc.id },
          });
          if (existingReversal) {
            throw new InventoryPostingError(
              'ALREADY_REVERSED',
              409,
              `برای سند «${targetDoc.documentNumber}» قبلاً سند ابطال «${existingReversal.documentNumber}» ثبت شده است.`
            );
          }

          const postedOriginalTrxs = (targetDoc.transactions || []).filter(
            (t: any) => t.postingStatus === 'POSTED'
          );
          if (postedOriginalTrxs.length === 0) {
            throw new InventoryPostingError(
              'NO_POSTED_TRANSACTIONS',
              400,
              `سند «${targetDoc.documentNumber}» هیچ تراکنش قطعی قابل ابطالی ندارد.`
            );
          }

          if (targetDoc.documentType === 'ISSUE' && typeof tx.coilIssueReturnRecord?.findMany === 'function') {
            const linkedIssueRecords = await tx.coilIssueReturnRecord.findMany({
              where: { inventoryDocumentId: targetDoc.id, issuedWeightKg: { gt: 0 } },
            });
            const hasDownstreamSettlement = linkedIssueRecords.some(
              (r: any) => Number(r.consumedWeightKg || 0) > EPS || Number(r.returnedWeightKg || 0) > EPS
            );
            if (hasDownstreamSettlement) {
              throw new InventoryPostingError(
                'COIL_ISSUE_ALREADY_SETTLED',
                409,
                `بخشی از ورق حواله‌شده در سند «${targetDoc.documentNumber}» قبلاً در تولید مصرف یا به انبار برگشت شده است و امکان ابطال مستقیم آن وجود ندارد.`
              );
            }
            if (linkedIssueRecords.length > 0 && typeof tx.coilIssueReturnRecord?.updateMany === 'function') {
              await tx.coilIssueReturnRecord.updateMany({
                where: { inventoryDocumentId: targetDoc.id, issuedWeightKg: { gt: 0 } },
                data: {
                  outstandingWeightKg: 0,
                  status: 'FULLY_RETURNED',
                  returnedAt: now,
                },
              });
            }
          }

          // Atomic lock/mark on original document header (originals' InventoryTransaction rows stay POSTED & immutable)
          const markTarget = await tx.inventoryDocument.updateMany({
            where: { id: targetDoc.id, postingStatus: 'POSTED', isReversed: false },
            data: { postingStatus: 'REVERSED', isReversed: true, updatedAt: now },
          });
          if (markTarget.count !== 1) {
            throw new InventoryPostingError(
              'ALREADY_REVERSED',
              409,
              `سند «${targetDoc.documentNumber}» همزمان توسط درخواست دیگری ابطال شده است.`
            );
          }

          const reversalDbType =
            targetDoc.documentType === 'WIP_TRANSFER'
              ? 'WIP_TRANSFER'
              : targetDoc.documentType === 'ISSUE'
                ? 'RETURN'
                : 'COUNT_ADJUSTMENT';

          const dbReversalDoc = await tx.inventoryDocument.create({
            data: {
              documentNumber: document.documentNumber,
              documentType: reversalDbType as any,
              documentDate: new Date(document.documentDate || now.toISOString()),
              documentStatus: 'CONFIRMED',
              postingStatus: 'POSTED',
              warehouseId:
                targetDoc.documentType === 'WIP_TRANSFER' && targetDoc.targetWarehouseId
                  ? targetDoc.targetWarehouseId
                  : targetDoc.warehouseId,
              targetWarehouseId:
                targetDoc.documentType === 'WIP_TRANSFER' ? targetDoc.warehouseId : targetDoc.targetWarehouseId,
              referenceNumber: targetDoc.documentNumber,
              createdByUserId: dbUser.id,
              postedByUserId: dbUser.id,
              postedAt: now,
              isReversed: false,
              reversalOfId: targetDoc.id,
              idempotencyKey,
              requestFingerprint,
              notes:
                document.adjustmentReason ||
                document.auditNote ||
                `ابطال سند ${targetDoc.documentNumber}`,
            },
          });

          const reversalLineByOriginalLineId = new Map<string, string>();
          for (const origLine of targetDoc.lines || []) {
            const revLine = await tx.inventoryDocumentLine.create({
              data: {
                documentId: dbReversalDoc.id,
                lineNumber: origLine.lineNumber,
                partId: origLine.partId,
                materialLotId: origLine.materialLotId,
                physicalCoilId: origLine.physicalCoilId,
                productionOperationId: origLine.productionOperationId,
                locationId:
                  targetDoc.documentType === 'WIP_TRANSFER'
                    ? origLine.targetLocationId || origLine.locationId
                    : origLine.locationId,
                targetLocationId:
                  targetDoc.documentType === 'WIP_TRANSFER' ? origLine.locationId : origLine.targetLocationId,
                quantity: Math.abs(Number(origLine.quantity)),
                unitId: origLine.unitId,
                weightKg: Math.abs(Number(origLine.weightKg)),
                ownership: origLine.ownership,
                contractId: origLine.contractId,
                contractNumber: origLine.contractNumber,
                qualityStatus: origLine.qualityStatus,
                unitCost: origLine.unitCost,
                notes: `ابطال ردیف ${origLine.lineNumber} سند ${targetDoc.documentNumber}`,
              },
            });
            reversalLineByOriginalLineId.set(origLine.id, revLine.id);
          }

          // Track net coil/lot deltas across non-transfer movements and original locations for transfers
          const coilWeightDeltas = new Map<string, number>();
          const lotWeightDeltas = new Map<string, { delta: number; qualityStatus: string }>();
          const coilLocationRestores = new Map<string, { warehouseId: string; locationId: string | null }>();
          const lotLocationRestores = new Map<string, string | null>();
          const coilQualityRestores = new Map<string, string>();

          let idx = 0;
          for (const origTrx of postedOriginalTrxs) {
            idx += 1;
            const origSignedQty = round6(Number(origTrx.quantitySigned));
            const origSignedKg = round6(Number(origTrx.weightKgSigned));
            const inverseSignedQty = round6(-origSignedQty);
            const inverseSignedKg = round6(-origSignedKg);
            const inverseType = invertMovementType(origTrx.transactionType as LedgerMovementType);

            const origLine = (targetDoc.lines || []).find((l: any) => l.id === origTrx.documentLineId);
            const partRow = await tx.part.findUnique({ where: { id: origTrx.partId } });
            const partCode = partRow?.partNumber || origTrx.partId;

            await applyStockMovement({
              documentId: dbReversalDoc.id,
              documentNumber: document.documentNumber,
              documentLineId: origTrx.documentLineId
                ? reversalLineByOriginalLineId.get(origTrx.documentLineId) || null
                : null,
              lineNumber: origLine?.lineNumber || idx,
              partId: origTrx.partId,
              partCode,
              unitId: origTrx.unitId,
              warehouseId: origTrx.warehouseId,
              locationId: origTrx.locationId || null,
              materialLotId: origTrx.materialLotId || null,
              physicalCoilId: origTrx.physicalCoilId || null,
              ownership: origTrx.ownership || 'COMPANY_OWNED',
              contractId: origTrx.contractId || null,
              contractNumber: origTrx.contractNumber || null,
              qualityStatus: origTrx.qualityStatus || 'AVAILABLE',
              signedQuantity: inverseSignedQty,
              signedWeightKg: inverseSignedKg,
              suffix: `REV${idx}`,
              movementType: inverseType,
              createdByUserId: dbUser.id,
              isReversal: true,
              reversalOfTrxId: origTrx.id,
              allowNonAvailableDeduction: true,
              manufacturingOrderId: origTrx.manufacturingOrderId || null,
              productionOperationId: origTrx.productionOperationId || null,
            });

            if (origTrx.physicalCoilId) {
              if (origTrx.transactionType === 'TRANSFER_OUT') {
                coilLocationRestores.set(origTrx.physicalCoilId, {
                  warehouseId: origTrx.warehouseId,
                  locationId: origTrx.locationId || null,
                });
              } else if (origTrx.transactionType !== 'TRANSFER_IN') {
                coilWeightDeltas.set(
                  origTrx.physicalCoilId,
                  round6((coilWeightDeltas.get(origTrx.physicalCoilId) || 0) + inverseSignedKg)
                );
                if (inverseSignedKg > EPS && origTrx.transactionType === 'ADJUSTMENT_NEG') {
                  coilQualityRestores.set(origTrx.physicalCoilId, origTrx.qualityStatus);
                }
              }
            }

            if (origTrx.materialLotId) {
              if (origTrx.transactionType === 'TRANSFER_OUT') {
                lotLocationRestores.set(origTrx.materialLotId, origTrx.locationId || null);
              } else if (origTrx.transactionType !== 'TRANSFER_IN') {
                const prev = lotWeightDeltas.get(origTrx.materialLotId) || {
                  delta: 0,
                  qualityStatus: origTrx.qualityStatus || 'AVAILABLE',
                };
                lotWeightDeltas.set(origTrx.materialLotId, {
                  delta: round6(prev.delta + inverseSignedKg),
                  qualityStatus: inverseSignedKg > EPS ? origTrx.qualityStatus || prev.qualityStatus : prev.qualityStatus,
                });
              }
            }
          }

          // Reconcile physical coils (weight, location, quality status)
          for (const [coilId, deltaKg] of coilWeightDeltas.entries()) {
            if (Math.abs(deltaKg) > EPS) {
              await reconcileCoilWeightDelta(coilId, deltaKg, {
                enforceUpperBound: deltaKg > 0,
                isReversedReceipt: targetDoc.documentType === 'RECEIPT' || targetDoc.documentType === 'INITIAL_BALANCE',
              });
            } else {
              await syncDerivedCoilAndLotQuality(coilId, null);
            }
          }

          for (const [coilId, loc] of coilLocationRestores.entries()) {
            const coil = await tx.physicalCoil.findUnique({ where: { id: coilId } });
            if (coil) {
              const updated = await tx.physicalCoil.updateMany({
                where: { id: coil.id, version: coil.version ?? 1 },
                data: {
                  warehouseId: loc.warehouseId,
                  warehouseLocationId: loc.locationId,
                  version: { increment: 1 },
                  updatedAt: now,
                },
              });
              if (updated.count !== 1) {
                throw new InventoryPostingError(
                  'COIL_CONCURRENCY_CONFLICT',
                  409,
                  `تداخل همزمان هنگام بازگردانی موقعیت کلاف «${coil.coilId}» رخ داد.`
                );
              }
            }
          }

          for (const [lotId, origLocationId] of lotLocationRestores.entries()) {
            const lot = await tx.materialLot.findUnique({ where: { id: lotId } });
            if (lot) {
              const updatedLotLoc = await tx.materialLot.updateMany({
                where: {
                  id: lot.id,
                  remainingWeightKg: lot.remainingWeightKg,
                  status: lot.status,
                },
                data: {
                  warehouseLocationId: origLocationId,
                  updatedAt: now,
                },
              });
              if (updatedLotLoc.count !== 1) {
                throw new InventoryPostingError(
                  'LOT_CONCURRENCY_CONFLICT',
                  409,
                  `تداخل همزمان هنگام بازگردانی موقعیت بچ «${lot.lotNumber}» رخ داد.`
                );
              }
            }
          }

          for (const coilId of coilQualityRestores.keys()) {
            await syncDerivedCoilAndLotQuality(coilId, null);
          }

          // Reconcile material lots
          for (const [lotId, entry] of lotWeightDeltas.entries()) {
            if (Math.abs(entry.delta) > EPS) {
              await reconcileLotWeightDelta(lotId, entry.delta, entry.qualityStatus);
            } else {
              await syncDerivedCoilAndLotQuality(null, lotId);
            }
          }

          // Reverse contract receipt accounting if reversing a receipt that created contract allocations
          if (targetDoc.documentType === 'RECEIPT' || targetDoc.documentType === 'INITIAL_BALANCE') {
            if (tx.contractCoilAllocation?.findMany) {
              const sourceAllocations = await tx.contractCoilAllocation.findMany({
                where: { sourceDocumentId: targetDoc.id },
              });
              for (const alloc of sourceAllocations) {
                const allocKg = round6(Number(alloc.allocatedWeightKg));
                const contract = await tx.materialContract.findUnique({ where: { id: alloc.contractId } });
                if (contract && allocKg > EPS) {
                  const updatedContract = await tx.materialContract.updateMany({
                    where: {
                      id: contract.id,
                      receivedWeightKg: { gte: round6(allocKg - EPS) },
                    },
                    data: {
                      receivedWeightKg: { decrement: allocKg },
                      updatedAt: now,
                    },
                  });
                  if (updatedContract.count !== 1) {
                    throw new InventoryPostingError(
                      'CONTRACT_BALANCE_NEGATIVE',
                      409,
                      `ابطال رسید باعث منفی شدن وزن دریافتی قرارداد «${contract.contractNumber}» یا تداخل همزمان می‌شود.`
                    );
                  }
                  const coil = await tx.physicalCoil.findUnique({ where: { id: alloc.coilId } });
                  await tx.materialContractTransaction.create({
                    data: {
                      contractId: contract.id,
                      lotId: coil?.materialLotId || null,
                      transactionType: 'RETURN',
                      weightKg: allocKg,
                      waybillNumber: attemptDoc.documentNumber,
                      receiptDate: now,
                      notes: `ابطال رسید ${targetDoc.documentNumber}`,
                    },
                  });
                }
                await tx.contractCoilAllocation.delete({ where: { id: alloc.id } });
              }
            }
          }

          const committedReversalSnapshot: InventoryDocument = JSON.parse(
            JSON.stringify({
              ...attemptDoc,
              id: dbReversalDoc.id,
              documentNumber: dbReversalDoc.documentNumber,
              postingStatus: 'POSTED',
              documentStatus: 'CONFIRMED',
              postedByUid: user.uid,
              postedByName: user.displayName,
              postedAt: now.toISOString(),
              updatedAt: now.toISOString(),
            })
          );

          await tx.auditLog.create({
            data: {
              userId: dbUser.id,
              action: 'DOCUMENT_REVERSE',
              entityName: 'InventoryDocument',
              entityId: dbReversalDoc.id,
              oldValues: {
                targetDocumentId: targetDoc.id,
                targetDocumentNumber: targetDoc.documentNumber,
                previousPostingStatus: 'POSTED',
              },
              newValues: {
                reversalDocumentId: dbReversalDoc.id,
                reversalDocumentNumber: dbReversalDoc.documentNumber,
                targetPostingStatus: 'REVERSED',
                reversedTransactionCount: postedOriginalTrxs.length,
                postedDocument: committedReversalSnapshot,
              },
            },
          });

          return {
            idempotentReplay: false,
            dbDocumentId: dbReversalDoc.id,
            dbDocumentNumber: dbReversalDoc.documentNumber,
            postedAt: now,
            committedDocument: committedReversalSnapshot,
          };
        }

        // ------------------------------------------------------------------
        // 6. STANDARD DOCUMENT POSTING (RECEIPT, ISSUE, TRANSFER, QM, ADJUSTMENT)
        // ------------------------------------------------------------------
        const warehouse = await resolveWarehouseStrict(document.warehouseId, 'انبار مبدا');
        const targetWarehouse =
          document.documentType === 'TRANSFER'
            ? await resolveWarehouseStrict(document.targetWarehouseId || '', 'انبار مقصد')
            : null;

        const documentData = {
          documentType: DOC_TYPE_MAP[document.documentType] as any,
          documentDate: new Date(document.documentDate || now.toISOString()),
          documentStatus: 'CONFIRMED' as const,
          postingStatus: 'POSTED' as const,
          warehouseId: warehouse.id,
          targetWarehouseId: targetWarehouse?.id ?? null,
          referenceNumber: document.referenceNumber,
          postedByUserId: dbUser.id,
          postedAt: now,
          idempotencyKey,
          requestFingerprint,
          notes: document.adjustmentReason || document.auditNote || document.referenceNumber,
        };

        let dbDocument;
        if (existingDoc) {
          dbDocument = await tx.inventoryDocument.update({
            where: { id: existingDoc.id },
            data: {
              ...documentData,
              createdByUserId: existingDoc.createdByUserId,
              idempotencyKey: idempotencyKey || existingDoc.idempotencyKey,
              requestFingerprint: existingDoc.requestFingerprint || requestFingerprint,
            },
          });
          await tx.inventoryDocumentLine.deleteMany({ where: { documentId: dbDocument.id } });
        } else {
          dbDocument = await tx.inventoryDocument.create({
            data: {
              ...documentData,
              documentNumber: document.documentNumber,
              createdByUserId: dbUser.id,
            },
          });
        }

        const isReceiptDoc =
          document.documentType === 'RECEIPT_RAW_MATERIAL' ||
          document.documentType === 'RECEIPT_FINISHED_GOODS' ||
          document.documentType === 'OPENING_BALANCE';

        const isIssueDoc =
          attemptDoc.documentType === 'ISSUE_RAW_MATERIAL' ||
          attemptDoc.documentType === 'ISSUE_FINISHED_GOODS' ||
          attemptDoc.documentType === 'DELIVERY_CUSTOMER' ||
          attemptDoc.documentType === 'SHIPMENT_CUSTOMER';

        // Track aggregated multi-contract coil transfer totals across all lines so
        // full multi-segment coil transfers succeed and each PhysicalCoil updates once.
        const deferredCoilTransfers = new Map<
          string,
          {
            coil: any;
            lotId: string | null;
            targetWarehouseId: string;
            targetLocationId: string | null;
            totalTransferKg: number;
          }
        >();

        let persistedLineSeq = 0;

        for (const line of attemptDoc.lines) {
          const part = await tx.part.findFirst({
            where: { OR: [{ partNumber: line.partCode }, { id: line.partId }], active: true },
          });
          if (!part) {
            throw new InventoryPostingError(
              'PART_NOT_FOUND',
              400,
              `کد کالا «${line.partCode}» در Master Data دیتابیس وجود ندارد یا غیرفعال است.`
            );
          }

          const unit = await tx.unitOfMeasure.findUnique({ where: { code: line.unit } });
          if (!unit) {
            throw new InventoryPostingError(
              'UNIT_NOT_FOUND',
              400,
              `واحد «${line.unit}» برای کالا «${line.partCode}» در دیتابیس تعریف نشده است.`
            );
          }

          const qty = round6(Number(line.quantity));
          const kg = round6(Number(line.quantityKg));
          if (!Number.isFinite(qty) || !Number.isFinite(kg) || Math.abs(qty) <= EPS) {
            throw new InventoryPostingError(
              'INVALID_QUANTITY',
              400,
              `مقدار ردیف ${line.lineNumber} برای قطعه «${line.partCode}» نامعتبر یا صفر است.`
            );
          }
          if ((isReceiptDoc || isIssueDoc || document.documentType === 'TRANSFER' || document.documentType === 'STOCK_STATUS_TRANSFER') && (qty <= 0 || kg < 0)) {
            throw new InventoryPostingError(
              'NEGATIVE_QUANTITY_FORBIDDEN',
              400,
              `مقدار ردیف ${line.lineNumber} برای این نوع سند باید بزرگتر از صفر باشد.`
            );
          }

          const location = await resolveLocationStrict(line.locationCode, warehouse.id);
          const lineOwnership = line.ownership || document.ownership || 'COMPANY_OWNED';
          const lineContractId = line.contractId || document.contractId || null;
          const lineContractNumber = line.contractNumber || document.contractNumber || null;
          const lineQualityStatus = line.qualityStatus || 'AVAILABLE';

          // ----------------------------------------------------------------
          // 6A. COHERENT SINGLE-TRANSACTION SHEET-METAL COIL RECEIPT
          // ----------------------------------------------------------------
          const wantsNewCoilRegistration =
            isReceiptDoc &&
            !line.physicalCoilId &&
            Boolean((line.coilId && line.coilId.trim()) || (line.coilPackNumber && line.coilPackNumber.trim()));

          if (wantsNewCoilRegistration) {
            if (unit.code !== 'KG') {
              throw new InventoryPostingError(
                'INVALID_COIL_UNIT',
                400,
                `واحد پایه کلاف ورق باید KG باشد (واحد دریافتی: ${unit.code}).`
              );
            }
            if (!location) {
              throw new InventoryPostingError(
                'COIL_LOCATION_REQUIRED',
                400,
                'برای ثبت رسید کلاف فیزیکی، تعیین موقعیت معتبر انبار الزامی است.'
              );
            }

            const coilCode = (line.coilId || line.coilPackNumber || '').trim();
            const coilPackNumber = (line.coilPackNumber || line.coilId || '').trim();
            const lotNumber = (line.lotNumber || coilCode).trim();

            const existingCoilDup = await tx.physicalCoil.findUnique({ where: { coilId: coilCode } });
            if (existingCoilDup) {
              throw new InventoryPostingError(
                'DUPLICATE_COIL',
                409,
                `کلاف فیزیکی با شناسه «${coilCode}» قبلاً در پایگاه داده ثبت شده است؛ ثبت مجدد مجاز نیست.`
              );
            }
            const existingLotDup = await tx.materialLot.findUnique({ where: { lotNumber } });
            if (existingLotDup) {
              throw new InventoryPostingError(
                'DUPLICATE_LOT',
                409,
                `بچ/شماره ردیابی «${lotNumber}» قبلاً در پایگاه داده ثبت شده است؛ ثبت مجدد مجاز نیست.`
              );
            }

            const grade = line.materialGrade || undefined;
            const dbMaterial = part.materialId
              ? await tx.material.findUnique({ where: { id: part.materialId } })
              : grade
                ? await tx.material.findFirst({ where: { OR: [{ grade }, { code: `MAT-${grade}` }] } })
                : null;
            if (!dbMaterial) {
              throw new InventoryPostingError(
                'MATERIAL_NOT_FOUND',
                400,
                `گرید متریال ورق برای قطعه «${line.partCode}» در جدول materials تعریف نشده است.`
              );
            }

            const thicknessMm = Number(line.thicknessMm ?? part.thicknessMm ?? 0);
            const widthMm = Number(line.widthMm ?? 0);
            if (!Number.isFinite(thicknessMm) || thicknessMm <= 0) {
              throw new InventoryPostingError(
                'INVALID_THICKNESS',
                400,
                `ضخامت ورق برای کلاف «${coilCode}» باید عددی مثبت باشد.`
              );
            }
            if (!Number.isFinite(widthMm) || widthMm <= 0) {
              throw new InventoryPostingError(
                'INVALID_WIDTH',
                400,
                `عرض ورق (widthMm) برای کلاف «${coilCode}» الزامی است و باید عددی مثبت باشد.`
              );
            }

            // Validate multi-contract allocations (if provided) and reject duplicate contractId per coil
            const rawAllocations = Array.isArray(line.contractAllocations) ? line.contractAllocations : [];
            const resolvedAllocations: Array<{
              contract: any;
              allocatedWeightKg: number;
              ownership: string;
              notes: string | null;
            }> = [];
            const seenContractIds = new Set<string>();
            let allocatedTotal = 0;

            for (const alloc of rawAllocations) {
              const allocWeight = round6(Number(alloc.allocatedWeightKg));
              if (!Number.isFinite(allocWeight) || allocWeight <= 0) {
                throw new InventoryPostingError(
                  'INVALID_ALLOCATION_WEIGHT',
                  400,
                  'وزن تخصیص قرارداد باید عددی مثبت باشد.'
                );
              }
              const contract = await tx.materialContract.findFirst({
                where: {
                  OR: [{ id: alloc.contractId }, { contractNumber: alloc.contractNumber || alloc.contractId }],
                },
              });
              if (!contract) {
                throw new InventoryPostingError(
                  'CONTRACT_NOT_FOUND',
                  400,
                  `قرارداد «${alloc.contractNumber || alloc.contractId}» در PostgreSQL یافت نشد.`
                );
              }
              if (seenContractIds.has(contract.id)) {
                throw new InventoryPostingError(
                  'DUPLICATE_CONTRACT_ALLOCATION',
                  400,
                  `تخصیص تکراری قرارداد «${contract.contractNumber}» روی کلاف «${coilCode}» مجاز نیست.`
                );
              }
              seenContractIds.add(contract.id);
              if (contract.materialId && contract.materialId !== dbMaterial.id) {
                throw new InventoryPostingError(
                  'CONTRACT_MATERIAL_MISMATCH',
                  400,
                  `گرید متریال کلاف «${coilCode}» با قرارداد «${contract.contractNumber}» سازگار نیست.`
                );
              }
              if (
                contract.thicknessMm !== null &&
                contract.thicknessMm !== undefined &&
                Math.abs(Number(contract.thicknessMm) - thicknessMm) > 0.001
              ) {
                throw new InventoryPostingError(
                  'CONTRACT_THICKNESS_MISMATCH',
                  400,
                  `ضخامت کلاف «${coilCode}» (${thicknessMm}mm) با ضخامت قرارداد «${contract.contractNumber}» (${Number(contract.thicknessMm)}mm) مطابقت ندارد.`
                );
              }
              const alreadyReceived = round6(Number(contract.receivedWeightKg || 0));
              const maxContractWeight = round6(Number(contract.totalAllocatedWeightKg || 0));
              if (alreadyReceived + allocWeight > maxContractWeight + EPS) {
                throw new InventoryPostingError(
                  'CONTRACT_QUOTA_EXCEEDED',
                  409,
                  `وزن دریافتی قرارداد «${contract.contractNumber}» از سقف تناژ قرارداد (${maxContractWeight} کیلوگرم) بیشتر می‌شود.`
                );
              }
              resolvedAllocations.push({
                contract,
                allocatedWeightKg: allocWeight,
                ownership: alloc.ownership || lineOwnership,
                notes: alloc.notes || null,
              });
              allocatedTotal = round6(allocatedTotal + allocWeight);
            }

            if (allocatedTotal > kg + EPS) {
              throw new InventoryPostingError(
                'OVER_ALLOCATION',
                400,
                `مجموع تخصیص قراردادها (${allocatedTotal} کیلوگرم) از وزن باسکول کلاف «${coilCode}» (${kg} کیلوگرم) بیشتر است.`
              );
            }

            const supplierContractId =
              resolvedAllocations.length === 1 ? resolvedAllocations[0].contract.id : null;

            const createdLot = await tx.materialLot.create({
              data: {
                lotNumber,
                materialId: dbMaterial.id,
                partId: part.id,
                supplierContractId,
                heatNumber: line.heatNumber || null,
                coilSerialNumber: coilCode,
                thicknessMm,
                widthMm,
                initialWeightKg: kg,
                remainingWeightKg: kg,
                warehouseLocationId: location.id,
                status: lotStatusForQuality(lineQualityStatus, kg),
                receivedDate: new Date(document.documentDate || now.toISOString()),
              },
            });

            const createdCoil = await tx.physicalCoil.create({
              data: {
                coilId: coilCode,
                coilPackNumber,
                partId: part.id,
                materialId: dbMaterial.id,
                materialLotId: createdLot.id,
                heatNumber: line.heatNumber || null,
                thicknessMm,
                widthMm,
                originalWeightKg: kg,
                remainingWeightKg: kg,
                warehouseId: warehouse.id,
                warehouseLocationId: location.id,
                ownership: lineOwnership,
                qualityStatus: lineQualityStatus,
                physicalStatus: physicalStatusForCoil(kg, kg, lineQualityStatus),
                supplierName: line.supplierName || 'ساپکو',
                receiptDate: new Date(document.documentDate || now.toISOString()),
                version: 1,
              },
            });

            attemptCreatedCoilIds.push(createdCoil.id);
            line.physicalCoilId = createdCoil.id;
            line.materialLotId = createdLot.id;
            line.lotNumber = createdLot.lotNumber;

            // Create allocations + atomic conditional quota increment + contract transactions
            for (const alloc of resolvedAllocations) {
              const maxContractWeight = round6(Number(alloc.contract.totalAllocatedWeightKg || 0));
              const maxAllowedBefore = round6(maxContractWeight - alloc.allocatedWeightKg);
              const updatedContract = await tx.materialContract.updateMany({
                where: {
                  id: alloc.contract.id,
                  receivedWeightKg: { lte: round6(maxAllowedBefore + EPS) },
                },
                data: {
                  receivedWeightKg: { increment: alloc.allocatedWeightKg },
                  updatedAt: now,
                },
              });
              if (updatedContract.count !== 1) {
                throw new InventoryPostingError(
                  'CONTRACT_QUOTA_EXCEEDED',
                  409,
                  `وزن دریافتی قرارداد «${alloc.contract.contractNumber}» از سقف تناژ قرارداد (${maxContractWeight} کیلوگرم) بیشتر می‌شود یا همزمان تغییر یافته است.`
                );
              }
              await tx.contractCoilAllocation.create({
                data: {
                  contractId: alloc.contract.id,
                  coilId: createdCoil.id,
                  allocatedWeightKg: alloc.allocatedWeightKg,
                  ownership: alloc.ownership,
                  sourceDocumentId: dbDocument.id,
                  notes: alloc.notes,
                },
              });
              await tx.materialContractTransaction.create({
                data: {
                  contractId: alloc.contract.id,
                  lotId: createdLot.id,
                  transactionType: 'RECEIPT',
                  weightKg: alloc.allocatedWeightKg,
                  waybillNumber: attemptDoc.referenceNumber || attemptDoc.documentNumber,
                  receiptDate: new Date(attemptDoc.documentDate || now.toISOString()),
                  notes: `رسید کلاف ${coilCode} با سند ${attemptDoc.documentNumber}`,
                },
              });
            }

            // Build stock-balance segments (allocated contracts + unallocated remainder if any)
            const segments: Array<{
              weightKg: number;
              ownership: string;
              contractId: string | null;
              contractNumber: string | null;
            }> = resolvedAllocations.map(a => ({
              weightKg: a.allocatedWeightKg,
              ownership: a.ownership,
              contractId: a.contract.id,
              contractNumber: a.contract.contractNumber,
            }));

            const unallocatedKg = round6(kg - allocatedTotal);
            if (unallocatedKg > EPS) {
              segments.push({
                weightKg: unallocatedKg,
                ownership: lineOwnership,
                contractId: resolvedAllocations.length === 0 ? lineContractId : null,
                contractNumber: resolvedAllocations.length === 0 ? lineContractNumber : null,
              });
            }

            for (let segIdx = 0; segIdx < segments.length; segIdx++) {
              const seg = segments[segIdx];
              persistedLineSeq += 1;
              const dbLine = await tx.inventoryDocumentLine.create({
                data: {
                  documentId: dbDocument.id,
                  lineNumber: persistedLineSeq,
                  partId: part.id,
                  materialLotId: createdLot.id,
                  physicalCoilId: createdCoil.id,
                  locationId: location.id,
                  targetLocationId: null,
                  quantity: seg.weightKg,
                  unitId: unit.id,
                  weightKg: seg.weightKg,
                  ownership: seg.ownership,
                  contractId: seg.contractId,
                  contractNumber: seg.contractNumber,
                  qualityStatus: lineQualityStatus,
                  unitCost: line.unitCost,
                  notes:
                    line.notes ||
                    `رسید کلاف ${coilCode} (پکینگ ${coilPackNumber})${seg.contractNumber ? ` — قرارداد ${seg.contractNumber}` : ''}`,
                },
              });

              await applyStockMovement({
                documentId: dbDocument.id,
                documentNumber: document.documentNumber,
                documentLineId: dbLine.id,
                lineNumber: persistedLineSeq,
                partId: part.id,
                partCode: part.partNumber,
                unitId: unit.id,
                warehouseId: warehouse.id,
                locationId: location.id,
                materialLotId: createdLot.id,
                physicalCoilId: createdCoil.id,
                ownership: seg.ownership,
                contractId: seg.contractId,
                contractNumber: seg.contractNumber,
                qualityStatus: lineQualityStatus,
                signedQuantity: seg.weightKg,
                signedWeightKg: seg.weightKg,
                suffix: segments.length > 1 ? `POST-S${segIdx + 1}` : 'POST',
                movementType: 'INBOUND',
                createdByUserId: dbUser.id,
              });
            }

            continue;
          }

          // ----------------------------------------------------------------
          // 6B. RESOLVE EXISTING PHYSICAL COIL & MATERIAL LOT (NON-COIL-CREATE)
          // ----------------------------------------------------------------
          let resolvedCoil: any = null;
          if (line.physicalCoilId || line.coilId) {
            const coilOr: any[] = [];
            if (line.physicalCoilId) coilOr.push({ id: line.physicalCoilId });
            if (line.coilId) coilOr.push({ coilId: line.coilId });
            resolvedCoil = await tx.physicalCoil.findFirst({ where: { OR: coilOr } });
            if (!resolvedCoil) {
              throw new InventoryPostingError(
                'PHYSICAL_COIL_NOT_FOUND',
                400,
                `کلاف فیزیکی «${line.coilId || line.physicalCoilId}» در پایگاه داده یافت نشد.`
              );
            }
          }

          let resolvedLot: any = null;
          if (line.materialLotId) {
            resolvedLot = await tx.materialLot.findFirst({
              where: { OR: [{ id: line.materialLotId }, { lotNumber: line.materialLotId }] },
            });
          } else if (line.lotNumber) {
            resolvedLot = await tx.materialLot.findUnique({ where: { lotNumber: line.lotNumber } });
          } else if (resolvedCoil?.materialLotId) {
            resolvedLot = await tx.materialLot.findUnique({ where: { id: resolvedCoil.materialLotId } });
          }

          // Allow creating a non-coil MaterialLot on receipt/opening if lotNumber is new
          let createdNewNonCoilLot = false;
          if (!resolvedLot && isReceiptDoc && line.lotNumber && !line.materialLotId) {
            resolvedLot = await tx.materialLot.create({
              data: {
                lotNumber: line.lotNumber.trim(),
                materialId: part.materialId || null,
                partId: part.id,
                heatNumber: line.heatNumber || null,
                thicknessMm: Number(part.thicknessMm || 0),
                widthMm: 0,
                initialWeightKg: Math.abs(kg),
                remainingWeightKg: Math.abs(kg),
                warehouseLocationId: location?.id || null,
                status: lotStatusForQuality(lineQualityStatus, Math.abs(kg)),
                receivedDate: new Date(document.documentDate || now.toISOString()),
              },
            });
            createdNewNonCoilLot = true;
          }

          if ((line.materialLotId || line.lotNumber) && !resolvedLot) {
            throw new InventoryPostingError(
              'MATERIAL_LOT_NOT_FOUND',
              400,
              `بچ/کویل «${line.lotNumber || line.materialLotId}» در پایگاه داده ثبت نشده است؛ ابتدا اطلاعات ردیابی آن را ایجاد کنید.`
            );
          }

          // Auto-link single physicalCoil from lot or lotNumber === coilId if not explicitly given
          if (!resolvedCoil && resolvedLot) {
            const lotCoils = await tx.physicalCoil.findMany({ where: { materialLotId: resolvedLot.id } });
            if (lotCoils.length === 1) {
              resolvedCoil = lotCoils[0];
            } else if (line.lotNumber) {
              resolvedCoil = await tx.physicalCoil.findUnique({ where: { coilId: line.lotNumber } });
            }
          }

          if (resolvedCoil && resolvedLot && resolvedCoil.materialLotId && resolvedCoil.materialLotId !== resolvedLot.id) {
            throw new InventoryPostingError(
              'COIL_LOT_MISMATCH',
              400,
              `کلاف فیزیکی «${resolvedCoil.coilId}» با بچ «${resolvedLot.lotNumber}» همخوانی ندارد.`
            );
          }
          if (resolvedCoil && resolvedCoil.partId && resolvedCoil.partId !== part.id) {
            throw new InventoryPostingError(
              'COIL_PART_MISMATCH',
              400,
              `کلاف فیزیکی «${resolvedCoil.coilId}» متعلق به قطعه «${line.partCode}» نیست.`
            );
          }

          const lotId: string | null = resolvedLot?.id || null;
          const coilId: string | null = resolvedCoil?.id || null;
          if (coilId) line.physicalCoilId = coilId;
          if (lotId) line.materialLotId = lotId;

          const targetLocation =
            document.documentType === 'TRANSFER' && targetWarehouse
              ? await resolveLocationStrict(line.targetLocationCode, targetWarehouse.id)
              : null;

          persistedLineSeq += 1;
          const dbLine = await tx.inventoryDocumentLine.create({
            data: {
              documentId: dbDocument.id,
              lineNumber: persistedLineSeq,
              partId: part.id,
              materialLotId: lotId,
              physicalCoilId: coilId,
              locationId: location?.id || null,
              targetLocationId: targetLocation?.id || null,
              quantity: Math.abs(qty),
              unitId: unit.id,
              weightKg: Math.abs(kg),
              ownership: lineOwnership,
              contractId: lineContractId,
              contractNumber: lineContractNumber,
              qualityStatus: lineQualityStatus,
              unitCost: line.unitCost,
              notes: line.notes,
            },
          });

          // ----------------------------------------------------------------
          // 6C. PAIRED OUT/IN FOR STOCK_STATUS_TRANSFER (QM 321 / 322 / 344)
          // ----------------------------------------------------------------
          if (document.documentType === 'STOCK_STATUS_TRANSFER') {
            const mt =
              line.movementType ||
              document.movementType ||
              resolveSapMovementType('STOCK_STATUS_TRANSFER', {
                qmTarget: line.qmStatusTarget || document.qmStatusTarget,
              });

            let sourceQualityStatus: StockQualityStatus | undefined = line.sourceQualityStatus;
            let targetQualityStatus: StockQualityStatus | undefined = line.targetQualityStatus;

            if (mt === '322') {
              sourceQualityStatus = sourceQualityStatus || 'AVAILABLE';
              targetQualityStatus = targetQualityStatus || 'QUARANTINE';
            } else if (mt === '344') {
              sourceQualityStatus = sourceQualityStatus || 'AVAILABLE';
              targetQualityStatus = targetQualityStatus || 'QUALITY_BLOCKED';
            } else if (mt === '321') {
              targetQualityStatus = targetQualityStatus || 'AVAILABLE';
              if (!sourceQualityStatus) {
                const candidateStatuses: StockQualityStatus[] = ['QUARANTINE', 'QUALITY_BLOCKED', 'REJECTED'];
                for (const candidate of candidateStatuses) {
                  const candidateBal = await tx.stockBalance.findFirst({
                    where: {
                      partId: part.id,
                      warehouseId: warehouse.id,
                      locationId: location?.id || null,
                      materialLotId: lotId,
                      physicalCoilId: coilId,
                      ownership: lineOwnership,
                      contractId: lineContractId,
                      qualityStatus: candidate,
                    },
                  });
                  const freeQty = candidateBal
                    ? round6(Number(candidateBal.quantityOnHand) - Number(candidateBal.quantityReserved))
                    : 0;
                  if (freeQty >= Math.abs(qty) - EPS) {
                    sourceQualityStatus = candidate;
                    break;
                  }
                }
                if (!sourceQualityStatus) {
                  throw new InventoryPostingError(
                    'INSUFFICIENT_QM_STOCK',
                    409,
                    `موجودی قرنطینه یا بلوکه‌شده کافی برای آزادسازی کیفی (حرکت ۳۲۱) قطعه «${line.partCode}» یافت نشد.`
                  );
                }
              }
            } else {
              throw new InventoryPostingError(
                'INVALID_QM_MOVEMENT',
                400,
                `کد حرکت انتقال کیفی «${mt}» پشتیبانی نمی‌شود (تنها ۳۲۱، ۳۲۲ و ۳۴۴ مجاز هستند).`
              );
            }

            if (sourceQualityStatus === targetQualityStatus) {
              throw new InventoryPostingError(
                'SAME_QM_STATUS',
                400,
                `وضعیت کیفی مبدا و مقصد نمی‌توانند یکسان («${sourceQualityStatus}») باشند.`
              );
            }

            const absQty = Math.abs(qty);
            const absKg = Math.abs(kg);

            await applyStockMovement({
              documentId: dbDocument.id,
              documentNumber: document.documentNumber,
              documentLineId: dbLine.id,
              lineNumber: persistedLineSeq,
              partId: part.id,
              partCode: part.partNumber,
              unitId: unit.id,
              warehouseId: warehouse.id,
              locationId: location?.id || null,
              materialLotId: lotId,
              physicalCoilId: coilId,
              ownership: lineOwnership,
              contractId: lineContractId,
              contractNumber: lineContractNumber,
              qualityStatus: sourceQualityStatus,
              signedQuantity: -absQty,
              signedWeightKg: -absKg,
              suffix: `QM${mt}-OUT`,
              movementType: 'ADJUSTMENT_NEG',
              createdByUserId: dbUser.id,
              allowNonAvailableDeduction: true,
            });

            await applyStockMovement({
              documentId: dbDocument.id,
              documentNumber: document.documentNumber,
              documentLineId: dbLine.id,
              lineNumber: persistedLineSeq,
              partId: part.id,
              partCode: part.partNumber,
              unitId: unit.id,
              warehouseId: warehouse.id,
              locationId: location?.id || null,
              materialLotId: lotId,
              physicalCoilId: coilId,
              ownership: lineOwnership,
              contractId: lineContractId,
              contractNumber: lineContractNumber,
              qualityStatus: targetQualityStatus,
              signedQuantity: absQty,
              signedWeightKg: absKg,
              suffix: `QM${mt}-IN`,
              movementType: 'ADJUSTMENT_POS',
              createdByUserId: dbUser.id,
            });

            // Derive aggregate coil & lot quality status from remaining positive stock balances
            // so partial QM transfers never falsely overwrite unrestricted stock status.
            await syncDerivedCoilAndLotQuality(coilId, lotId);

            continue;
          }

          // ----------------------------------------------------------------
          // 6D. WAREHOUSE / LOCATION TRANSFER (PAIRED TRANSFER_OUT + TRANSFER_IN)
          // ----------------------------------------------------------------
          if (document.documentType === 'TRANSFER') {
            if (!targetWarehouse) {
              throw new InventoryPostingError('TARGET_WAREHOUSE_REQUIRED', 400, 'انبار مقصد برای سند انتقال مشخص نشده است.');
            }
            if (
              warehouse.id === targetWarehouse.id &&
              (location?.id || null) === (targetLocation?.id || null)
            ) {
              throw new InventoryPostingError(
                'SAME_TRANSFER_LOCATION',
                400,
                'انبار و موقعیت مبدأ و مقصد انتقال نمی‌توانند یکسان باشند.'
              );
            }

            const absQty = Math.abs(qty);
            const absKg = Math.abs(kg);

            if (resolvedCoil) {
              const existingAgg = deferredCoilTransfers.get(resolvedCoil.id);
              const nextTargetLocId = targetLocation?.id || null;
              if (existingAgg) {
                if (
                  existingAgg.targetWarehouseId !== targetWarehouse.id ||
                  existingAgg.targetLocationId !== nextTargetLocId
                ) {
                  throw new InventoryPostingError(
                    'INCONSISTENT_COIL_TRANSFER_DESTINATION',
                    400,
                    `انبار یا موقعیت مقصد برای بخش‌های مختلف کلاف فیزیکی «${resolvedCoil.coilId}» یکسان نیست.`
                  );
                }
                existingAgg.totalTransferKg = round6(existingAgg.totalTransferKg + absKg);
              } else {
                deferredCoilTransfers.set(resolvedCoil.id, {
                  coil: resolvedCoil,
                  lotId,
                  targetWarehouseId: targetWarehouse.id,
                  targetLocationId: nextTargetLocId,
                  totalTransferKg: absKg,
                });
              }
            }

            await applyStockMovement({
              documentId: dbDocument.id,
              documentNumber: attemptDoc.documentNumber,
              documentLineId: dbLine.id,
              lineNumber: persistedLineSeq,
              partId: part.id,
              partCode: part.partNumber,
              unitId: unit.id,
              warehouseId: warehouse.id,
              locationId: location?.id || null,
              materialLotId: lotId,
              physicalCoilId: coilId,
              ownership: lineOwnership,
              contractId: lineContractId,
              contractNumber: lineContractNumber,
              qualityStatus: lineQualityStatus,
              signedQuantity: -absQty,
              signedWeightKg: -absKg,
              suffix: 'OUT',
              movementType: 'TRANSFER_OUT',
              createdByUserId: dbUser.id,
            });

            await applyStockMovement({
              documentId: dbDocument.id,
              documentNumber: attemptDoc.documentNumber,
              documentLineId: dbLine.id,
              lineNumber: persistedLineSeq,
              partId: part.id,
              partCode: part.partNumber,
              unitId: unit.id,
              warehouseId: targetWarehouse.id,
              locationId: targetLocation?.id || null,
              materialLotId: lotId,
              physicalCoilId: coilId,
              ownership: lineOwnership,
              contractId: lineContractId,
              contractNumber: lineContractNumber,
              qualityStatus: lineQualityStatus,
              signedQuantity: absQty,
              signedWeightKg: absKg,
              suffix: 'IN',
              movementType: 'TRANSFER_IN',
              createdByUserId: dbUser.id,
            });

            // Non-coil lot location update (guarded against concurrent changes)
            if (!resolvedCoil && lotId && resolvedLot) {
              const updatedLot = await tx.materialLot.updateMany({
                where: {
                  id: lotId,
                  remainingWeightKg: resolvedLot.remainingWeightKg,
                  status: resolvedLot.status,
                },
                data: {
                  warehouseLocationId: targetLocation?.id || null,
                  updatedAt: now,
                },
              });
              if (updatedLot.count !== 1) {
                throw new InventoryPostingError(
                  'LOT_CONCURRENCY_CONFLICT',
                  409,
                  `تداخل همزمان هنگام انتقال بچ «${resolvedLot.lotNumber}» رخ داد.`
                );
              }
            }

            continue;
          }

          // ----------------------------------------------------------------
          // 6E. RECEIPT / ISSUE / OPENING_BALANCE / ADJUSTMENT
          // ----------------------------------------------------------------
          let sign = Math.sign(qty || kg);
          let movementType: 'INBOUND' | 'OUTBOUND' | 'ADJUSTMENT_POS' | 'ADJUSTMENT_NEG';
          if (isReceiptDoc) {
            sign = 1;
            movementType = 'INBOUND';
          } else if (isIssueDoc) {
            sign = -1;
            movementType = 'OUTBOUND';
          } else {
            movementType = sign > 0 ? 'ADJUSTMENT_POS' : 'ADJUSTMENT_NEG';
          }

          const signedQuantity = round6(Math.abs(qty) * sign);
          const signedWeightKg = round6(Math.abs(kg) * sign);

          let linkedMo: any = null;
          let linkedOpId: string | null = (line as any).productionOperationId || null;
          if (
            attemptDoc.documentType === 'ISSUE_RAW_MATERIAL' &&
            attemptDoc.referenceNumber &&
            typeof tx.manufacturingOrder?.findFirst === 'function'
          ) {
            linkedMo = await tx.manufacturingOrder.findFirst({
              where: {
                OR: [
                  { id: attemptDoc.referenceNumber },
                  { moNumber: attemptDoc.referenceNumber },
                ],
              },
              include: {
                operations: { orderBy: [{ sequence: 'asc' }, { stepNumber: 'asc' }] },
              },
            });
            if (linkedMo) {
              if (linkedMo.status === 'CANCELLED' || linkedMo.status === 'CLOSED') {
                throw new InventoryPostingError(
                  'MO_NOT_MUTABLE',
                  409,
                  `دستور تولید «${linkedMo.moNumber}» در وضعیت «${linkedMo.status}» قرار دارد و حواله مواد برای آن مجاز نیست.`
                );
              }
              if (!linkedOpId && Array.isArray(linkedMo.operations) && linkedMo.operations.length > 0) {
                linkedOpId = linkedMo.operations[0].id;
              }
              await consumeMoReservationsInTx(tx, {
                moId: linkedMo.id,
                partId: part.id,
                warehouseId: warehouse.id,
                locationId: location?.id || null,
                materialLotId: lotId,
                physicalCoilId: coilId,
                contractId: lineContractId,
                consumeQuantity: Math.abs(qty),
                consumeWeightKg: Math.abs(kg),
                now,
              });
            }
          }

          await applyStockMovement({
            documentId: dbDocument.id,
            documentNumber: document.documentNumber,
            documentLineId: dbLine.id,
            lineNumber: persistedLineSeq,
            partId: part.id,
            partCode: part.partNumber,
            unitId: unit.id,
            warehouseId: warehouse.id,
            locationId: location?.id || null,
            materialLotId: lotId,
            physicalCoilId: coilId,
            ownership: lineOwnership,
            contractId: lineContractId,
            contractNumber: lineContractNumber,
            qualityStatus: lineQualityStatus,
            signedQuantity,
            signedWeightKg,
            suffix: 'POST',
            movementType,
            createdByUserId: dbUser.id,
          });

          if (linkedMo) {
            await tx.inventoryTransaction.updateMany({
              where: {
                documentId: dbDocument.id,
                documentLineId: dbLine.id,
                manufacturingOrderId: null,
              },
              data: {
                manufacturingOrderId: linkedMo.id,
                ...(linkedOpId ? { productionOperationId: linkedOpId } : {}),
              },
            });
          }

          if (
            attemptDoc.documentType === 'ISSUE_RAW_MATERIAL' &&
            coilId &&
            typeof tx.coilIssueReturnRecord?.create === 'function'
          ) {
            const absKgIssued = Math.abs(kg);
            await tx.coilIssueReturnRecord.create({
              data: {
                id: `CIR-${Date.now()}-${persistedLineSeq}-${Math.floor(Math.random() * 10000)}`,
                coilId,
                inventoryDocumentId: dbDocument.id,
                contractId: lineContractId,
                partId: linkedMo?.partId || part.id,
                productionOperationId: linkedOpId,
                manufacturingOrderId: linkedMo?.id || null,
                documentNumber: dbDocument.documentNumber,
                issuedWeightKg: absKgIssued,
                consumedWeightKg: 0,
                returnedWeightKg: 0,
                outstandingWeightKg: absKgIssued,
                varianceWeightKg: 0,
                status: absKgIssued <= 0.001 ? 'CONSUMED' : 'ISSUED',
                issuedAt: now,
                notes:
                  line.notes ||
                  `حواله مصرف کلاف با سند ${dbDocument.documentNumber}${linkedMo ? ` برای ${linkedMo.moNumber}` : ''}`,
              },
            });
          }

          if (coilId) {
            await reconcileCoilWeightDelta(coilId, signedWeightKg, {
              enforceUpperBound: false,
            });
          }
          if (lotId && !createdNewNonCoilLot) {
            await reconcileLotWeightDelta(lotId, signedWeightKg, lineQualityStatus);
          }
        }

        // Finalize aggregated multi-contract coil transfers: verify complete coil weight
        // across all segments and update each PhysicalCoil + MaterialLot exactly once.
        for (const agg of deferredCoilTransfers.values()) {
          const coilRemaining = round6(Number(agg.coil.remainingWeightKg));
          if (Math.abs(agg.totalTransferKg - coilRemaining) > EPS) {
            throw new InventoryPostingError(
              'PARTIAL_COIL_TRANSFER_UNSUPPORTED',
              400,
              `انتقال جزئی کلاف فیزیکی «${agg.coil.coilId}» بدون برش/تفکیک مجاز نیست (مجموع انتقال: ${agg.totalTransferKg} کیلوگرم، مانده کلاف: ${coilRemaining} کیلوگرم).`
            );
          }

          const updatedCoil = await tx.physicalCoil.updateMany({
            where: { id: agg.coil.id, version: agg.coil.version ?? 1 },
            data: {
              warehouseId: agg.targetWarehouseId,
              warehouseLocationId: agg.targetLocationId,
              version: { increment: 1 },
              updatedAt: now,
            },
          });
          if (updatedCoil.count !== 1) {
            throw new InventoryPostingError(
              'COIL_CONCURRENCY_CONFLICT',
              409,
              `تداخل همزمان هنگام انتقال کلاف فیزیکی «${agg.coil.coilId}» رخ داد.`
            );
          }

          if (agg.lotId) {
            const lot = await tx.materialLot.findUnique({ where: { id: agg.lotId } });
            if (lot) {
              const updatedLot = await tx.materialLot.updateMany({
                where: {
                  id: lot.id,
                  remainingWeightKg: lot.remainingWeightKg,
                  status: lot.status,
                },
                data: {
                  warehouseLocationId: agg.targetLocationId,
                  updatedAt: now,
                },
              });
              if (updatedLot.count !== 1) {
                throw new InventoryPostingError(
                  'LOT_CONCURRENCY_CONFLICT',
                  409,
                  `تداخل همزمان هنگام انتقال بچ «${lot.lotNumber}» رخ داد.`
                );
              }
            }
          }
        }

        const committedSnapshot: InventoryDocument = JSON.parse(
          JSON.stringify({
            ...attemptDoc,
            id: dbDocument.id,
            documentNumber: dbDocument.documentNumber,
            postingStatus: 'POSTED',
            documentStatus: 'CONFIRMED',
            postedByUid: user.uid,
            postedByName: user.displayName,
            postedAt: now.toISOString(),
            updatedAt: now.toISOString(),
          })
        );

        await tx.auditLog.create({
          data: {
            userId: dbUser.id,
            action: 'DOCUMENT_POST',
            entityName: 'InventoryDocument',
            entityId: dbDocument.id,
            newValues: {
              documentNumber: attemptDoc.documentNumber,
              documentType: attemptDoc.documentType,
              sourceDraftId:
                options?.sourceDraftId ||
                (document.id && document.id !== dbDocument.id ? document.id : undefined),
              lineCount: persistedLineSeq,
              totalQuantity: attemptDoc.totalQuantity,
              totalWeightKg: attemptDoc.totalWeightKg,
              createdCoilIds: attemptCreatedCoilIds,
              postedDocument: committedSnapshot,
              initialRequestDocument: initialRequestSnapshot,
            },
          },
        });

        return {
          idempotentReplay: false,
          dbDocumentId: dbDocument.id,
          dbDocumentNumber: dbDocument.documentNumber,
          postedAt: now,
          createdCoilIds: attemptCreatedCoilIds,
          committedDocument: committedSnapshot,
        };
      },
      { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 15_000 }
    );

      // Commit succeeded — now apply committed metadata back to caller document
      document.id = txOutcome.dbDocumentId;
      document.documentNumber = txOutcome.dbDocumentNumber;
      document.postingStatus = 'POSTED';
      document.documentStatus = 'CONFIRMED';
      document.postedByUid = user.uid;
      document.postedByName = user.displayName;
      document.postedAt = (txOutcome.postedAt instanceof Date ? txOutcome.postedAt : now).toISOString();
      document.updatedAt = now.toISOString();
      if (!txOutcome.idempotentReplay && Array.isArray(attemptDoc.lines)) {
        document.lines = attemptDoc.lines;
      } else if (txOutcome.idempotentReplay && txOutcome.committedDocument) {
        Object.assign(document, structuredClone(txOutcome.committedDocument));
      }

      return {
        success: true,
        postedDocument:
          txOutcome.idempotentReplay && txOutcome.committedDocument
            ? structuredClone(txOutcome.committedDocument)
            : document,
        idempotentReplay: txOutcome.idempotentReplay,
        dbDocumentId: txOutcome.dbDocumentId,
        dbDocumentNumber: txOutcome.dbDocumentNumber,
        createdCoilIds: txOutcome.createdCoilIds || [],
        statusCode: txOutcome.idempotentReplay ? 200 : 201,
        attempts: attempt,
      };
    } catch (err: any) {
      lastError = err;

      // Retry transient PostgreSQL serialization (P2034/40001) and deadlock (40P01) errors with jitter
      if (isRetryablePgTxError(err) && attempt <= maxRetries) {
        if (retryBaseDelayMs > 0) {
          const backoff = retryBaseDelayMs * Math.pow(2, attempt - 1);
          const jitter = Math.floor(Math.random() * retryBaseDelayMs);
          await sleepMs(backoff + jitter);
        }
        continue;
      }

      if (err instanceof InventoryPostingError) {
        return {
          success: false,
          statusCode: err.statusCode,
          errorCode: err.code,
          error: err.message,
          attempts: attempt,
        };
      }

      // Handle concurrent idempotency race on unique idempotencyKey
      if (err?.code === 'P2002' && idempotencyKey) {
        try {
          const committed = await prisma.inventoryDocument.findUnique({
            where: { idempotencyKey },
            include: { lines: true },
          });
          if (committed && committed.postingStatus === 'POSTED') {
            if (!matchesStoredFingerprint(committed.requestFingerprint)) {
              return {
                success: false,
                statusCode: 409,
                errorCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
                error: `کلید یکتای درخواست «${idempotencyKey}» قبلاً با محتوای متفاوتی ثبت شده است.`,
                attempts: attempt,
              };
            }
            const replayCoilIds: string[] = Array.from(
              new Set<string>(
                (committed.lines || [])
                  .map((l: any) => l.physicalCoilId)
                  .filter((id: any): id is string => typeof id === 'string' && id.length > 0)
              )
            );
            const replayAudit =
              typeof prisma.auditLog?.findFirst === 'function'
                ? await prisma.auditLog.findFirst({
                    where: {
                      entityName: 'InventoryDocument',
                      entityId: committed.id,
                      action: { in: ['DOCUMENT_POST', 'DOCUMENT_REVERSE'] },
                    },
                    orderBy: { timestamp: 'desc' },
                  })
                : null;
            const committedDocument = (replayAudit?.newValues as any)?.postedDocument as
              | InventoryDocument
              | undefined;
            document.id = committed.id;
            document.documentNumber = committed.documentNumber;
            document.postingStatus = 'POSTED';
            document.documentStatus = 'CONFIRMED';
            document.postedAt = (committed.postedAt instanceof Date ? committed.postedAt : now).toISOString();
            if (committedDocument) {
              Object.assign(document, structuredClone(committedDocument));
            }
            return {
              success: true,
              idempotentReplay: true,
              postedDocument: committedDocument ? structuredClone(committedDocument) : document,
              dbDocumentId: committed.id,
              dbDocumentNumber: committed.documentNumber,
              createdCoilIds: replayCoilIds,
              statusCode: 200,
              attempts: attempt,
            };
          }
        } catch {
          // Fall through to standard Prisma error mapping
        }
      }

      const mapped = mapPrismaError(err);
      if (mapped) {
        return {
          success: false,
          statusCode: mapped.statusCode,
          errorCode: mapped.errorCode,
          error: mapped.message,
          attempts: attempt,
        };
      }

      return {
        success: false,
        statusCode: 500,
        errorCode: 'POSTING_TRANSACTION_FAILED',
        error: err?.message || 'خطای تراکنش PostgreSQL هنگام ثبت قطعی سند انبار',
        attempts: attempt,
      };
    }
  }

  const finalMapped = mapPrismaError(lastError);
  return {
    success: false,
    statusCode: finalMapped?.statusCode ?? 409,
    errorCode: finalMapped?.errorCode ?? 'SERIALIZATION_CONFLICT',
    error: finalMapped?.message ?? 'تداخل تراکنش همزمان پس از چند تلاش مجدد برطرف نشد.',
    attempts: attempt,
  };
}

/**
 * Infer exact frontend InventoryDocType / QM metadata from a PostgreSQL
 * InventoryDocument (using AuditLog committed snapshot first, falling back to
 * persisted transaction pairs & reference fields).
 */
export function inferDbDocumentSemantics(
  dbDoc: any,
  auditPostedDocument?: Partial<InventoryDocument> | null
): {
  documentType: InventoryDocType;
  movementType?: SapMovementType;
  qmStatusTarget?: 'UNRESTRICTED' | 'QUALITY_INSPECTION' | 'BLOCKED';
  sourceQualityStatus?: StockQualityStatus;
  targetQualityStatus?: StockQualityStatus;
} {
  if (dbDoc?.reversalOfId) {
    return { documentType: 'REVERSAL' };
  }

  if (auditPostedDocument?.documentType) {
    const firstLine = auditPostedDocument.lines?.[0];
    return {
      documentType: auditPostedDocument.documentType,
      movementType: auditPostedDocument.movementType,
      qmStatusTarget: auditPostedDocument.qmStatusTarget,
      sourceQualityStatus: firstLine?.sourceQualityStatus,
      targetQualityStatus: firstLine?.targetQualityStatus,
    };
  }

  const trxs: any[] = Array.isArray(dbDoc?.transactions) ? dbDoc.transactions : [];
  const negTx = trxs.find((t: any) => t.transactionType === 'ADJUSTMENT_NEG');
  const posTx = trxs.find((t: any) => t.transactionType === 'ADJUSTMENT_POS');
  const isQmPair =
    dbDoc?.documentType === 'COUNT_ADJUSTMENT' &&
    ((negTx && posTx && negTx.qualityStatus !== posTx.qualityStatus) ||
      dbDoc?.referenceType === 'QM_INSPECTION' ||
      String(dbDoc?.documentNumber || '').startsWith('QM-'));

  if (isQmPair) {
    const srcQ = (negTx?.qualityStatus || 'AVAILABLE') as StockQualityStatus;
    const tgtQ = (posTx?.qualityStatus || dbDoc?.lines?.[0]?.qualityStatus || 'AVAILABLE') as StockQualityStatus;
    const movementType: SapMovementType =
      tgtQ === 'QUALITY_BLOCKED' ? '344' : tgtQ === 'QUARANTINE' ? '322' : '321';
    const qmStatusTarget =
      movementType === '344' ? 'BLOCKED' : movementType === '322' ? 'QUALITY_INSPECTION' : 'UNRESTRICTED';
    return {
      documentType: 'STOCK_STATUS_TRANSFER',
      movementType,
      qmStatusTarget,
      sourceQualityStatus: srcQ,
      targetQualityStatus: tgtQ,
    };
  }

  const docNum = String(dbDoc?.documentNumber || '');
  if (dbDoc?.documentType === 'RECEIPT') {
    return {
      documentType: docNum.startsWith('REC-FIN-') ? 'RECEIPT_FINISHED_GOODS' : 'RECEIPT_RAW_MATERIAL',
    };
  }
  if (dbDoc?.documentType === 'ISSUE') {
    if (dbDoc?.referenceType === 'SHIPPING_WAYBILL' || docNum.startsWith('SHP-CUS-')) {
      return { documentType: 'DELIVERY_CUSTOMER' };
    }
    if (docNum.startsWith('SHP-OEM-')) {
      return { documentType: 'SHIPMENT_CUSTOMER' };
    }
    if (docNum.startsWith('OUT-FIN-')) {
      return { documentType: 'ISSUE_FINISHED_GOODS' };
    }
    return { documentType: 'ISSUE_RAW_MATERIAL' };
  }
  if (dbDoc?.documentType === 'WIP_TRANSFER') return { documentType: 'TRANSFER' };
  if (dbDoc?.documentType === 'RETURN') return { documentType: 'REVERSAL' };
  if (dbDoc?.documentType === 'INITIAL_BALANCE') return { documentType: 'OPENING_BALANCE' };
  return { documentType: 'ADJUSTMENT' };
}

/**
 * Check for an existing committed QM transfer matching `idempotencyKey` BEFORE
 * querying `stock_balances` for available source quantity (which is already 0 on full
 * QM transfer retries). Validates all explicitly supplied caller parameters against the
 * original committed document and returns either a mismatch error or a faithful QM
 * document to replay through `postDocumentInDbTransaction`.
 */
export async function prepareQmTransferRetryInDb(
  prisma: any,
  params: {
    key?: string;
    partId?: string;
    partCode?: string;
    warehouseId?: string;
    locationCode?: string;
    lotNumber?: string;
    physicalCoilId?: string;
    ownership?: StockOwnership;
    contractId?: string;
    movementType: SapMovementType;
    targetQualityStatus: StockQualityStatus;
    heldQty?: number;
    heldWeightKg?: number;
    reasonFa?: string;
    idempotencyKey?: string;
    user: { uid: string; displayName: string };
  }
): Promise<
  | { matched: false }
  | {
      matched: true;
      errorResult: { success: false; statusCode: number; errorCode: string; error: string };
    }
  | {
      matched: true;
      replayDocument: InventoryDocument;
      committedDocument?: InventoryDocument;
    }
> {
  const key = (params.idempotencyKey || '').trim();
  if (!key) return { matched: false };

  const existingByKey = await prisma.inventoryDocument.findUnique({
    where: { idempotencyKey: key },
    include: {
      warehouse: true,
      targetWarehouse: true,
      lines: {
        orderBy: { lineNumber: 'asc' },
        include: {
          part: { include: { unit: true } },
          location: true,
          materialLot: true,
          physicalCoil: true,
        },
      },
      transactions: true,
    },
  });

  if (!existingByKey) return { matched: false };

  if (existingByKey.postingStatus !== 'POSTED') {
    return {
      matched: true,
      errorResult: {
        success: false,
        statusCode: 409,
        errorCode: 'IDEMPOTENCY_CONFLICT',
        error: `سند مرتبط با کلید «${key}» در وضعیت غیرقابل تکرار (${existingByKey.postingStatus}) است.`,
      },
    };
  }

  const auditEntry =
    typeof prisma.auditLog?.findFirst === 'function'
      ? await prisma.auditLog.findFirst({
          where: {
            entityName: 'InventoryDocument',
            entityId: existingByKey.id,
            action: 'DOCUMENT_POST',
          },
          orderBy: { timestamp: 'desc' },
        })
      : null;
  const auditNewValues = (auditEntry?.newValues || {}) as any;
  const auditPostedDoc = auditNewValues.postedDocument as InventoryDocument | undefined;
  const auditInitialDoc = auditNewValues.initialRequestDocument as InventoryDocument | undefined;
  const trxs: any[] = existingByKey.transactions || [];
  const negTx = trxs.find((t: any) => t.transactionType === 'ADJUSTMENT_NEG');
  const posTx = trxs.find((t: any) => t.transactionType === 'ADJUSTMENT_POS');
  const committedLine = existingByKey.lines?.[0];

  const mismatchError = (detail?: string) => ({
    matched: true as const,
    errorResult: {
      success: false as const,
      statusCode: 409,
      errorCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
      error: detail || `کلید یکتای درخواست «${key}» قبلاً با محتوای متفاوتی ثبت شده است.`,
    },
  });

  if (
    existingByKey.documentType !== 'COUNT_ADJUSTMENT' ||
    !negTx ||
    !posTx ||
    !committedLine ||
    (auditPostedDoc?.documentType && auditPostedDoc.documentType !== 'STOCK_STATUS_TRANSFER')
  ) {
    return mismatchError();
  }

  const committedTargetStatus = posTx.qualityStatus || committedLine.qualityStatus;
  if (committedTargetStatus !== params.targetQualityStatus) {
    return mismatchError();
  }
  if (
    params.movementType === '321' &&
    negTx.qualityStatus !== 'QUARANTINE' &&
    negTx.qualityStatus !== 'QUALITY_BLOCKED'
  ) {
    return mismatchError();
  }
  if (
    params.partId &&
    params.partId !== committedLine.partId &&
    params.partId !== committedLine.part?.partNumber
  ) {
    return mismatchError();
  }
  if (
    params.partCode &&
    params.partCode !== committedLine.part?.partNumber &&
    params.partCode !== committedLine.partId
  ) {
    return mismatchError();
  }
  if (
    params.warehouseId &&
    params.warehouseId !== existingByKey.warehouseId &&
    params.warehouseId !== existingByKey.warehouse?.code
  ) {
    return mismatchError();
  }
  if (
    params.locationCode &&
    params.locationCode !== committedLine.location?.code &&
    params.locationCode !== committedLine.locationId
  ) {
    return mismatchError();
  }
  if (params.ownership && params.ownership !== committedLine.ownership) {
    return mismatchError();
  }
  if (params.contractId && params.contractId !== committedLine.contractId) {
    return mismatchError();
  }
  if (
    params.physicalCoilId &&
    params.physicalCoilId !== committedLine.physicalCoilId &&
    params.physicalCoilId !== committedLine.physicalCoil?.coilId
  ) {
    return mismatchError();
  }
  if (params.lotNumber) {
    const lotCandidates = [
      committedLine.materialLot?.lotNumber,
      committedLine.physicalCoil?.coilPackNumber,
      committedLine.physicalCoil?.coilId,
    ].filter(Boolean);
    if (!lotCandidates.includes(params.lotNumber)) {
      return mismatchError();
    }
  }
  if (params.key) {
    const keyedSb = await prisma.stockBalance.findFirst({ where: { id: params.key } });
    if (keyedSb) {
      const matchesAnyLine = (existingByKey.lines || []).some(
        (ln: any) =>
          keyedSb.partId === ln.partId &&
          keyedSb.warehouseId === existingByKey.warehouseId &&
          (keyedSb.locationId || null) === (ln.locationId || null) &&
          (keyedSb.physicalCoilId || null) === (ln.physicalCoilId || null) &&
          (keyedSb.materialLotId || null) === (ln.materialLotId || null) &&
          keyedSb.ownership === ln.ownership &&
          (keyedSb.contractId || null) === (ln.contractId || null)
      );
      if (!matchesAnyLine) {
        return mismatchError();
      }
    } else {
      const keyedCoil = await prisma.physicalCoil.findFirst({
        where: { OR: [{ id: params.key }, { coilId: params.key }] },
      });
      if (keyedCoil) {
        if (keyedCoil.id !== committedLine.physicalCoilId) {
          return mismatchError();
        }
      } else if (
        params.key !== existingByKey.id &&
        params.key !== committedLine.id &&
        params.key !== committedLine.physicalCoilId
      ) {
        return mismatchError();
      }
    }
  }

  const unitCode = committedLine.unit?.code || auditPostedDoc?.lines?.[0]?.unit || 'KG';
  const explicitQty =
    params.heldQty !== undefined && Number(params.heldQty) > 0
      ? Number(params.heldQty)
      : unitCode === 'KG' && params.heldWeightKg !== undefined && Number(params.heldWeightKg) > 0
        ? Number(params.heldWeightKg)
        : undefined;
  const committedTotalQty = (existingByKey.lines || []).reduce(
    (sum: number, l: any) => sum + Number(l.quantity || 0),
    0
  );
  if (explicitQty !== undefined && Math.abs(explicitQty - committedTotalQty) > EPS) {
    return mismatchError();
  }

  const qmTarget =
    params.movementType === '344'
      ? 'BLOCKED'
      : params.movementType === '322'
        ? 'QUALITY_INSPECTION'
        : 'UNRESTRICTED';
  const qty = committedTotalQty;
  const weightKg = (existingByKey.lines || []).reduce(
    (sum: number, l: any) => sum + Number(l.weightKg || 0),
    0
  );
  const nowIso = (existingByKey.postedAt instanceof Date ? existingByKey.postedAt : new Date()).toISOString();

  const origAuditLine = (auditInitialDoc || auditPostedDoc)?.lines?.[0];

  const replayDocument: InventoryDocument = auditInitialDoc
    ? {
        ...structuredClone(auditInitialDoc),
        id: existingByKey.id,
        documentNumber: existingByKey.documentNumber,
        idempotencyKey: key,
      }
    : {
        id: existingByKey.id,
        documentNumber: existingByKey.documentNumber,
        documentType: 'STOCK_STATUS_TRANSFER',
        movementType: params.movementType,
        movementLabel: SAP_MOVEMENT_CATALOG[params.movementType]?.labelFa,
        qmStatusTarget: qmTarget,
        idempotencyKey: key,
        documentDate: (existingByKey.documentDate instanceof Date ? existingByKey.documentDate : new Date()).toISOString(),
        documentStatus: 'CONFIRMED',
        postingStatus: 'POSTED',
        warehouseId:
          auditPostedDoc?.warehouseId ||
          existingByKey.warehouse?.code ||
          existingByKey.warehouseId,
        warehouseName:
          auditPostedDoc?.warehouseName ||
          existingByKey.warehouse?.name ||
          existingByKey.warehouseId,
        ownership: (committedLine.ownership || 'COMPANY_OWNED') as StockOwnership,
        contractId: committedLine.contractId || undefined,
        contractNumber: committedLine.contractNumber || undefined,
        referenceType: 'QM_INSPECTION',
        referenceNumber: existingByKey.referenceNumber || undefined,
        adjustmentReason: params.reasonFa || SAP_MOVEMENT_CATALOG[params.movementType]?.labelFa,
        auditNote: existingByKey.notes || undefined,
        lines: (existingByKey.lines || []).map((ln: any, idx: number) => ({
          id: ln.id,
          documentId: existingByKey.id,
          lineNumber: ln.lineNumber || idx + 1,
          partId: ln.partId,
          partCode: ln.part?.partNumber || origAuditLine?.partCode || ln.partId,
          partName: ln.part?.name || ln.part?.partNumber || ln.partId,
          materialLotId: origAuditLine ? origAuditLine.materialLotId : ln.materialLotId || undefined,
          physicalCoilId: ln.physicalCoilId || origAuditLine?.physicalCoilId || undefined,
          coilId: ln.physicalCoil?.coilId || origAuditLine?.coilId || undefined,
          coilPackNumber:
            ln.physicalCoil?.coilPackNumber ||
            origAuditLine?.coilPackNumber ||
            undefined,
          lotNumber:
            ln.materialLot?.lotNumber ||
            ln.physicalCoil?.coilPackNumber ||
            origAuditLine?.lotNumber ||
            undefined,
          heatNumber:
            ln.materialLot?.heatNumber ||
            ln.physicalCoil?.heatNumber ||
            origAuditLine?.heatNumber ||
            undefined,
          ownership: (ln.ownership || 'COMPANY_OWNED') as StockOwnership,
          contractId: ln.contractId || undefined,
          contractNumber: ln.contractNumber || undefined,
          locationCode: ln.location?.code || origAuditLine?.locationCode || undefined,
          quantity: Number(ln.quantity || 0),
          unit: unitCode,
          quantityKg: Number(ln.weightKg || 0),
          qualityStatus: params.targetQualityStatus,
          sourceQualityStatus: negTx.qualityStatus as StockQualityStatus,
          targetQualityStatus: params.targetQualityStatus,
          movementType: params.movementType,
          qmStatusTarget: qmTarget,
          notes: ln.notes || undefined,
        })),
        totalQuantity: qty,
        totalWeightKg: weightKg,
        createdByUid: params.user.uid,
        createdByName: params.user.displayName,
        postedAt: nowIso,
        createdAt: (existingByKey.createdAt instanceof Date ? existingByKey.createdAt : new Date()).toISOString(),
        updatedAt: (existingByKey.updatedAt instanceof Date ? existingByKey.updatedAt : new Date()).toISOString(),
      };

  return {
    matched: true,
    replayDocument,
    committedDocument: auditPostedDoc ? structuredClone(auditPostedDoc) : undefined,
  };
}

function parseAuditNewValues(raw: any): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

/**
 * Authoritative PostgreSQL resolution for `POST /api/inventory/documents/:id/post`.
 * Prevents retries of a posted draft/document from re-hashing a lossy
 * `mapDbDocumentToInventoryDocument` projection (which caused 409 IDEMPOTENCY_PAYLOAD_MISMATCH)
 * while still catching cross-document key reuse with 409 IDEMPOTENCY_PAYLOAD_MISMATCH.
 * Also recovers full draft semantics from `AuditLog` (`action: 'DOCUMENT_CREATE'`) across restarts.
 */
export async function resolveDbDocumentPostIdempotency(
  prisma: any,
  args: {
    id: string;
    idempotencyKey?: string;
    memDoc: InventoryDocument | null;
    dbDoc: any | null;
    mapDbDocFn: (dbDoc: any, auditPostedDoc?: Partial<InventoryDocument> | null) => InventoryDocument;
    postUser: { uid: string; displayName: string };
  }
): Promise<
  | {
      status: 'REPLAY';
      idempotentReplay: true;
      dbDocumentId: string;
      dbDocumentNumber: string;
      postedDocument: InventoryDocument;
    }
  | {
      status: 'CONFLICT';
      statusCode: number;
      errorCode: string;
      error: string;
    }
  | {
      status: 'NOT_FOUND';
    }
  | {
      status: 'POST';
      docToPost: InventoryDocument;
      sourceDraftId?: string;
      excludeDocumentNumberFromFingerprint?: boolean;
    }
> {
  const { id, idempotencyKey, memDoc, dbDoc, mapDbDocFn } = args;
  const trimmedKey = (idempotencyKey || '').trim() || undefined;
  let resolvedDbDoc = dbDoc;

  if (trimmedKey) {
    const existingByKey = await prisma.inventoryDocument.findUnique({
      where: { idempotencyKey: trimmedKey },
      include: {
        warehouse: true,
        targetWarehouse: true,
        lines: {
          orderBy: { lineNumber: 'asc' },
          include: {
            part: true,
            unit: true,
            location: true,
            targetLocation: true,
            materialLot: true,
            physicalCoil: true,
          },
        },
        transactions: true,
      },
    });

    if (existingByKey) {
      const existingKeyAudit =
        typeof prisma.auditLog?.findFirst === 'function'
          ? await prisma.auditLog.findFirst({
              where: {
                entityName: 'InventoryDocument',
                entityId: existingByKey.id,
                action: { in: ['DOCUMENT_POST', 'DOCUMENT_CREATE'] },
              },
              orderBy: { timestamp: 'desc' },
            })
          : null;
      const auditNewValues = parseAuditNewValues(existingKeyAudit?.newValues);
      const auditPostedDoc = (auditNewValues.postedDocument ||
        auditNewValues.draftDocument) as InventoryDocument | undefined;
      const matchesRequestedTarget =
        existingByKey.id === id ||
        existingByKey.documentNumber === id ||
        auditNewValues.sourceDraftId === id ||
        (memDoc !== null && memDoc.documentNumber === existingByKey.documentNumber);

      if (matchesRequestedTarget) {
        if (existingByKey.postingStatus === 'POSTED') {
          const committedDoc =
            auditPostedDoc
              ? structuredClone(auditPostedDoc)
              : memDoc && memDoc.postingStatus === 'POSTED'
                ? structuredClone(memDoc)
                : mapDbDocFn(existingByKey, auditPostedDoc);
          return {
            status: 'REPLAY',
            idempotentReplay: true,
            dbDocumentId: existingByKey.id,
            dbDocumentNumber: existingByKey.documentNumber,
            postedDocument: committedDoc,
          };
        }
        if (existingByKey.postingStatus === 'UNPOSTED') {
          // The draft was created with this idempotencyKey and is now being posted for the first time
          resolvedDbDoc = resolvedDbDoc || existingByKey;
        } else {
          return {
            status: 'CONFLICT',
            statusCode: 409,
            errorCode: 'IDEMPOTENCY_CONFLICT',
            error: `سند مرتبط با کلید «${trimmedKey}» در وضعیت غیرقابل تکرار (${existingByKey.postingStatus}) است.`,
          };
        }
      }
      // Different target document attempting to reuse an already-used idempotencyKey:
      // fall through so `postDocumentInDbTransaction` detects fingerprint mismatch -> 409.
    }
  }

  if (!resolvedDbDoc && !memDoc && typeof prisma.auditLog?.findMany === 'function') {
    const audits = await prisma.auditLog.findMany({
      where: {
        entityName: 'InventoryDocument',
        action: { in: ['DOCUMENT_POST', 'DOCUMENT_CREATE'] },
      },
      orderBy: { timestamp: 'desc' },
    });
    const matchedAudit = (audits || []).find(
      (a: any) => parseAuditNewValues(a?.newValues)?.sourceDraftId === id
    );
    if (matchedAudit?.entityId) {
      resolvedDbDoc = await prisma.inventoryDocument.findFirst({
        where: { id: matchedAudit.entityId },
        include: {
          warehouse: true,
          targetWarehouse: true,
          lines: {
            orderBy: { lineNumber: 'asc' },
            include: {
              part: true,
              unit: true,
              location: true,
              targetLocation: true,
              materialLot: true,
              physicalCoil: true,
            },
          },
          transactions: true,
        },
      });
    }
  }

  let draftAuditDoc: Partial<InventoryDocument> | null = null;
  let draftSourceId: string | undefined =
    memDoc && !resolvedDbDoc ? (memDoc as any).sourceDraftId || memDoc.id : undefined;
  let excludeDocumentNumberFromFingerprint: boolean | undefined;

  if (resolvedDbDoc && typeof prisma.auditLog?.findFirst === 'function') {
    const docAudit = await prisma.auditLog.findFirst({
      where: {
        entityName: 'InventoryDocument',
        entityId: resolvedDbDoc.id,
        action: { in: ['DOCUMENT_POST', 'DOCUMENT_CREATE'] },
      },
      orderBy: { timestamp: 'desc' },
    });
    const parsedAudit = parseAuditNewValues(docAudit?.newValues);
    draftAuditDoc =
      (parsedAudit.initialRequestDocument as InventoryDocument | undefined) ||
      (parsedAudit.draftDocument as InventoryDocument | undefined) ||
      (parsedAudit.postedDocument as InventoryDocument | undefined) ||
      null;
    if (parsedAudit.sourceDraftId) {
      draftSourceId = parsedAudit.sourceDraftId;
    }
    if (typeof parsedAudit.excludeDocumentNumberFromFingerprint === 'boolean') {
      excludeDocumentNumberFromFingerprint = parsedAudit.excludeDocumentNumberFromFingerprint;
    }
  }

  let docToPost: InventoryDocument | null = null;
  if (resolvedDbDoc) {
    if (draftAuditDoc && resolvedDbDoc.postingStatus === 'UNPOSTED') {
      docToPost = {
        ...structuredClone(draftAuditDoc as InventoryDocument),
        id: resolvedDbDoc.id,
        documentNumber: resolvedDbDoc.documentNumber,
        documentStatus: resolvedDbDoc.documentStatus || 'DRAFT',
        postingStatus: resolvedDbDoc.postingStatus || 'UNPOSTED',
      };
    } else {
      docToPost = mapDbDocFn(resolvedDbDoc, draftAuditDoc);
    }
  } else if (memDoc) {
    docToPost = memDoc;
  }

  if (!docToPost) {
    return { status: 'NOT_FOUND' };
  }

  return {
    status: 'POST',
    docToPost,
    sourceDraftId: draftSourceId,
    excludeDocumentNumberFromFingerprint,
  };
}

/**
 * =========================================================================
 * P0-B.1: POSTGRESQL-AUTHORITATIVE DRAFT DOCUMENT PERSISTENCE
 * =========================================================================
 * Saves an UNPOSTED DRAFT InventoryDocument and its lines in PostgreSQL inside
 * a Serializable transaction with full idempotency and AuditLog semantic snapshot
 * so drafts survive server restarts and multi-instance deployments before posting.
 */
export async function saveDraftDocumentInDbTransaction(
  initialDocument: InventoryDocument,
  user: { uid: string; displayName: string },
  options?: PostDocumentDbOptions
): Promise<PostDocumentDbResult> {
  const prisma = options?.prismaClient || getPrismaClient();
  const maxRetries = Math.max(1, options?.maxSerializationRetries ?? 5);
  const idempotencyKey = (options?.idempotencyKey || initialDocument.idempotencyKey || '').trim() || undefined;
  const sourceDraftId = (options?.sourceDraftId || initialDocument.id || '').trim() || undefined;
  const requestFingerprint = buildDocumentRequestFingerprint(initialDocument, {
    includeDocumentNumber: !options?.excludeDocumentNumberFromFingerprint,
  });
  const initialRequestSnapshot: InventoryDocument = JSON.parse(JSON.stringify(initialDocument));

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const attemptDoc: InventoryDocument = JSON.parse(JSON.stringify(initialDocument));
    const now = new Date();

    try {
      const txOutcome = await prisma.$transaction(
        async (tx: any) => {
          if (idempotencyKey) {
            const existingByKey = await tx.inventoryDocument.findUnique({
              where: { idempotencyKey },
              include: { lines: true },
            });
            if (existingByKey) {
              if (existingByKey.requestFingerprint && existingByKey.requestFingerprint !== requestFingerprint) {
                throw new InventoryPostingError(
                  'IDEMPOTENCY_PAYLOAD_MISMATCH',
                  409,
                  `کلید یکتای درخواست «${idempotencyKey}» قبلاً با محتوای متفاوتی ثبت شده است.`
                );
              }
              if (existingByKey.postingStatus === 'UNPOSTED') {
                const replayAudit =
                  typeof tx.auditLog?.findFirst === 'function'
                    ? await tx.auditLog.findFirst({
                        where: {
                          entityName: 'InventoryDocument',
                          entityId: existingByKey.id,
                          action: 'DOCUMENT_CREATE',
                        },
                        orderBy: { timestamp: 'desc' },
                      })
                    : null;
                const parsed = parseAuditNewValues(replayAudit?.newValues);
                const committedDocument = (parsed.draftDocument || parsed.postedDocument) as
                  | InventoryDocument
                  | undefined;
                return {
                  idempotentReplay: true,
                  dbDocumentId: existingByKey.id,
                  dbDocumentNumber: existingByKey.documentNumber,
                  committedDocument,
                };
              }
              throw new InventoryPostingError(
                'IDEMPOTENCY_CONFLICT',
                409,
                `سند مرتبط با کلید «${idempotencyKey}» قبلاً ثبت قطعی یا ابطال شده است (${existingByKey.postingStatus}).`
              );
            }
          }

          const existingByNum = await tx.inventoryDocument.findUnique({
            where: { documentNumber: attemptDoc.documentNumber },
          });
          if (existingByNum) {
            throw new InventoryPostingError(
              'DUPLICATE_DOCUMENT_NUMBER',
              409,
              `شماره سند «${attemptDoc.documentNumber}» تکراری است و قبلاً در PostgreSQL ثبت شده است.`
            );
          }

          const whKey = String(attemptDoc.warehouseId || '').trim();
          const warehouse = await tx.warehouse.findFirst({
            where: { OR: [{ code: whKey }, { id: whKey }], active: true },
          });
          if (!warehouse) {
            throw new InventoryPostingError(
              'WAREHOUSE_NOT_FOUND',
              400,
              `انبار مبدا با شناسه/کد «${whKey}» در اطلاعات پایه ثبت نشده یا غیرفعال است.`
            );
          }

          let targetWarehouse: any = null;
          if (attemptDoc.documentType === 'TRANSFER' || attemptDoc.targetWarehouseId) {
            const targetKey = String(attemptDoc.targetWarehouseId || '').trim();
            if (targetKey) {
              targetWarehouse = await tx.warehouse.findFirst({
                where: { OR: [{ code: targetKey }, { id: targetKey }], active: true },
              });
              if (!targetWarehouse && attemptDoc.documentType === 'TRANSFER') {
                throw new InventoryPostingError(
                  'WAREHOUSE_NOT_FOUND',
                  400,
                  `انبار مقصد با شناسه/کد «${targetKey}» در اطلاعات پایه ثبت نشده یا غیرفعال است.`
                );
              }
            }
          }

          let dbUser = await tx.user.findFirst({
            where: {
              OR: [{ id: user.uid }, { username: user.uid }, { personnelCode: user.uid }],
            },
          });
          if (!dbUser) {
            dbUser = await tx.user.findFirst({ where: { active: true } });
          }
          if (!dbUser) {
            throw new InventoryPostingError(
              'USER_NOT_FOUND',
              400,
              'کاربر ثبت‌کننده در جدول کاربران PostgreSQL یافت نشد.'
            );
          }

          const dbDraft = await tx.inventoryDocument.create({
            data: {
              documentNumber: attemptDoc.documentNumber,
              documentType: (DOC_TYPE_MAP[attemptDoc.documentType] || 'RECEIPT') as any,
              documentDate: new Date(attemptDoc.documentDate || now.toISOString()),
              documentStatus: 'DRAFT',
              postingStatus: 'UNPOSTED',
              warehouseId: warehouse.id,
              targetWarehouseId: targetWarehouse?.id ?? null,
              referenceNumber: attemptDoc.referenceNumber || null,
              createdByUserId: dbUser.id,
              idempotencyKey,
              requestFingerprint,
              notes: attemptDoc.adjustmentReason || attemptDoc.auditNote || attemptDoc.referenceNumber || null,
            },
          });

          for (let i = 0; i < (attemptDoc.lines || []).length; i++) {
            const line = attemptDoc.lines[i];
            const partKey = String(line.partCode || line.partId || '').trim();
            const part = await tx.part.findFirst({
              where: {
                OR: [{ partNumber: partKey }, { id: String(line.partId || '').trim() }],
                active: true,
              },
              include: { unit: true },
            });
            if (!part) {
              throw new InventoryPostingError(
                'PART_NOT_FOUND',
                400,
                `کالا/قطعه ردیف ${i + 1} («${partKey}») در کاتالوگ PostgreSQL یافت نشد یا غیرفعال است.`
              );
            }

            let locationId: string | null = null;
            if (line.locationCode) {
              const loc = await tx.warehouseLocation.findFirst({
                where: {
                  warehouseId: warehouse.id,
                  OR: [{ code: line.locationCode }, { id: line.locationCode }],
                  active: true,
                },
              });
              if (loc) locationId = loc.id;
            }

            let targetLocationId: string | null = null;
            if (line.targetLocationCode && targetWarehouse) {
              const tLoc = await tx.warehouseLocation.findFirst({
                where: {
                  warehouseId: targetWarehouse.id,
                  OR: [{ code: line.targetLocationCode }, { id: line.targetLocationCode }],
                  active: true,
                },
              });
              if (tLoc) targetLocationId = tLoc.id;
            }

            const qty = Math.abs(Number(line.quantity) || 0);
            const weightKg = Math.abs(Number(line.quantityKg) || qty);

            await tx.inventoryDocumentLine.create({
              data: {
                documentId: dbDraft.id,
                lineNumber: line.lineNumber || i + 1,
                partId: part.id,
                materialLotId: line.materialLotId || null,
                physicalCoilId: line.physicalCoilId || null,
                locationId,
                targetLocationId,
                quantity: qty,
                unitId: part.unitId,
                weightKg,
                ownership: line.ownership || attemptDoc.ownership || 'COMPANY_OWNED',
                contractId: line.contractId || attemptDoc.contractId || null,
                contractNumber: line.contractNumber || attemptDoc.contractNumber || null,
                qualityStatus: line.qualityStatus || 'AVAILABLE',
                unitCost: line.unitCost ?? null,
                notes: line.notes || null,
              },
            });
          }

          const committedDraftSnapshot: InventoryDocument = JSON.parse(
            JSON.stringify({
              ...attemptDoc,
              id: dbDraft.id,
              documentNumber: dbDraft.documentNumber,
              documentStatus: 'DRAFT',
              postingStatus: 'UNPOSTED',
              updatedAt: now.toISOString(),
            })
          );

          await tx.auditLog.create({
            data: {
              userId: dbUser.id,
              action: 'DOCUMENT_CREATE',
              entityName: 'InventoryDocument',
              entityId: dbDraft.id,
              oldValues: {
                documentStatus: null,
                postingStatus: null,
              },
              newValues: {
                documentNumber: dbDraft.documentNumber,
                documentType: attemptDoc.documentType,
                documentStatus: 'DRAFT',
                postingStatus: 'UNPOSTED',
                lineCount: attemptDoc.lines.length,
                sourceDraftId,
                excludeDocumentNumberFromFingerprint: Boolean(options?.excludeDocumentNumberFromFingerprint),
                draftDocument: committedDraftSnapshot,
                postedDocument: committedDraftSnapshot,
                initialRequestDocument: initialRequestSnapshot,
              },
            },
          });

          return {
            idempotentReplay: false,
            dbDocumentId: dbDraft.id,
            dbDocumentNumber: dbDraft.documentNumber,
            committedDocument: committedDraftSnapshot,
          };
        },
        {
          isolationLevel: 'Serializable',
          maxWait: 10000,
          timeout: 30000,
        }
      );

      if (txOutcome.idempotentReplay) {
        const replayedDoc: InventoryDocument = txOutcome.committedDocument
          ? JSON.parse(JSON.stringify(txOutcome.committedDocument))
          : {
              ...initialDocument,
              id: txOutcome.dbDocumentId,
              documentNumber: txOutcome.dbDocumentNumber,
              documentStatus: 'DRAFT',
              postingStatus: 'UNPOSTED',
            };
        return {
          success: true,
          statusCode: 200,
          idempotentReplay: true,
          dbDocumentId: txOutcome.dbDocumentId,
          dbDocumentNumber: txOutcome.dbDocumentNumber,
          attempts: attempt,
          postedDocument: replayedDoc,
        };
      }

      const finalDraft: InventoryDocument = txOutcome.committedDocument
        ? JSON.parse(JSON.stringify(txOutcome.committedDocument))
        : {
            ...initialDocument,
            id: txOutcome.dbDocumentId,
            documentNumber: txOutcome.dbDocumentNumber,
            documentStatus: 'DRAFT',
            postingStatus: 'UNPOSTED',
          };
      Object.assign(initialDocument, finalDraft);

      return {
        success: true,
        statusCode: 201,
        idempotentReplay: false,
        dbDocumentId: txOutcome.dbDocumentId,
        dbDocumentNumber: txOutcome.dbDocumentNumber,
        attempts: attempt,
        postedDocument: finalDraft,
      };
    } catch (error: any) {
      if (attempt < maxRetries && isRetryableSerializationError(error)) {
        const backoffMs = Math.min(250, 20 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 25);
        await sleepMs(backoffMs);
        continue;
      }
      if (error instanceof InventoryPostingError) {
        return {
          success: false,
          statusCode: error.statusCode,
          errorCode: error.code,
          error: error.message,
          attempts: attempt,
        };
      }
      return {
        success: false,
        statusCode: 500,
        errorCode: 'DB_TRANSACTION_FAILED',
        error: error instanceof Error ? error.message : 'خطا در ثبت پیش‌نویس سند انبار در PostgreSQL',
        attempts: attempt,
      };
    }
  }

  return {
    success: false,
    statusCode: 409,
    errorCode: 'SERIALIZATION_RETRY_EXHAUSTED',
    error: 'تراکنش پیش‌نویس سند به دلیل هم‌زمانی بالا پس از چند تلاش متوالی متوقف شد.',
    attempts: maxRetries,
  };
}

/**
 * =========================================================================
 * P0-B.2: MULTI-SEGMENT QM STATUS TRANSFER BUILDER (WHOLE-COIL & PARTIAL)
 * =========================================================================
 * Resolves single or multi-contract `StockBalance` segments for QM 321/322/344
 * and QC-hold toggles so whole-coil QC hold/release on a multi-contract split coil
 * atomically transfers all active contract segments in a single document.
 */
export async function buildQmStatusTransferDocumentFromDb(
  prisma: any,
  params: {
    key?: string;
    partId?: string;
    partCode?: string;
    materialGrade?: string;
    warehouseId?: string;
    locationCode?: string;
    lotNumber?: string;
    physicalCoilId?: string;
    ownership?: StockOwnership;
    contractId?: string;
    movementType: SapMovementType;
    qmTarget: 'UNRESTRICTED' | 'QUALITY_INSPECTION' | 'BLOCKED';
    targetQualityStatus: StockQualityStatus;
    heldQty?: number;
    heldWeightKg?: number;
    reasonFa?: string;
    idempotencyKey?: string;
    qmUser?: { uid: string; displayName: string };
    user?: { uid: string; displayName: string };
    fallbackUnit?: 'KG' | 'PCS';
  }
): Promise<
  | {
      success: true;
      qmDoc: InventoryDocument;
      primaryBalance: any;
      totalQty: number;
      totalWeightKg: number;
      requestedQty: number;
      weightKg: number;
    }
  | {
      success: false;
      statusCode: number;
      errorCode?: string;
      error: string;
    }
> {
  const { movementType, qmTarget, targetQualityStatus } = params;
  const qmUser = params.qmUser || params.user || {
    uid: 'USR-QC',
    displayName: 'بازرس کنترل کیفیت (QM)',
  };
  const expectedSourceStatuses =
    movementType === '321' ? ['QUARANTINE', 'QUALITY_BLOCKED'] : ['AVAILABLE', 'UNRESTRICTED'];

  const lookupKey = (params.key || '').trim() || undefined;
  const lookupPhysicalCoilId = (params.physicalCoilId || '').trim() || undefined;
  const lookupPartCode = (params.partCode || '').trim() || undefined;
  const lookupPartId = (params.partId || '').trim() || undefined;
  const lookupWarehouseRef = (params.warehouseId || '').trim() || undefined;
  const lookupLotNumber = (params.lotNumber || '').trim() || undefined;
  const lookupLocationCode = (params.locationCode || '').trim() || undefined;
  const lookupOwnership = params.ownership;
  const lookupContractId = (params.contractId || '').trim() || undefined;

  if (!lookupKey && !lookupPhysicalCoilId && !lookupLotNumber && !lookupPartId && !lookupPartCode) {
    return {
      success: false,
      statusCode: 400,
      errorCode: 'INVALID_QM_TARGET',
      error: 'مشخصات موجودی مبدأ (کلید ردیف، شناسه کلاف، شماره بچ یا کد قطعه) برای انتقال وضعیت کیفی ارسال نشده است.',
    };
  }

  let candidateBalances: any[] = [];
  if (lookupKey) {
    const directSb = await prisma.stockBalance.findFirst({
      where: { id: lookupKey },
      include: {
        part: { include: { unit: true } },
        warehouse: true,
        location: true,
        materialLot: true,
        physicalCoil: true,
      },
    });
    if (directSb) {
      candidateBalances = [directSb];
    }
  }

  if (candidateBalances.length === 0) {
    const dbPart =
      lookupPartId || lookupPartCode
        ? await prisma.part.findFirst({
            where: {
              OR: [
                ...(lookupPartId ? [{ id: lookupPartId }] : []),
                ...(lookupPartCode ? [{ partNumber: lookupPartCode }] : []),
              ],
            },
          })
        : null;
    if ((lookupPartId || lookupPartCode) && !dbPart) {
      return {
        success: false,
        statusCode: 404,
        errorCode: 'QM_PART_NOT_FOUND',
        error: `قطعه مبدأ (${lookupPartCode || lookupPartId}) در پایگاه داده یافت نشد.`,
      };
    }

    const dbWh = lookupWarehouseRef
      ? await prisma.warehouse.findFirst({
          where: { OR: [{ id: lookupWarehouseRef }, { code: lookupWarehouseRef }] },
        })
      : null;
    if (lookupWarehouseRef && !dbWh) {
      return {
        success: false,
        statusCode: 404,
        errorCode: 'QM_WAREHOUSE_NOT_FOUND',
        error: `انبار مبدأ (${lookupWarehouseRef}) در پایگاه داده یافت نشد.`,
      };
    }

    const dbCoil =
      lookupPhysicalCoilId || lookupKey || lookupLotNumber
        ? await prisma.physicalCoil.findFirst({
            where: {
              OR: [
                ...(lookupPhysicalCoilId
                  ? [{ id: lookupPhysicalCoilId }, { coilId: lookupPhysicalCoilId }, { coilPackNumber: lookupPhysicalCoilId }]
                  : []),
                ...(lookupKey
                  ? [{ id: lookupKey }, { coilId: lookupKey }, { coilPackNumber: lookupKey }]
                  : []),
                ...(lookupLotNumber
                  ? [{ coilId: lookupLotNumber }, { coilPackNumber: lookupLotNumber }]
                  : []),
              ],
            },
          })
        : null;
    if (lookupPhysicalCoilId && !dbCoil) {
      return {
        success: false,
        statusCode: 404,
        errorCode: 'QM_COIL_NOT_FOUND',
        error: `کلاف فیزیکی (${lookupPhysicalCoilId}) در پایگاه داده یافت نشد.`,
      };
    }

    const dbLot =
      lookupLotNumber || lookupKey
        ? await prisma.materialLot.findFirst({
            where: {
              OR: [
                ...(lookupLotNumber ? [{ id: lookupLotNumber }, { lotNumber: lookupLotNumber }] : []),
                ...(lookupKey ? [{ id: lookupKey }, { lotNumber: lookupKey }] : []),
              ],
            },
          })
        : null;
    if (lookupLotNumber && !dbCoil && !dbLot) {
      return {
        success: false,
        statusCode: 404,
        errorCode: 'QM_LOT_NOT_FOUND',
        error: `شماره بچ یا کلاف (${lookupLotNumber}) در پایگاه داده یافت نشد.`,
      };
    }

    // If a key was provided and did not resolve to any StockBalance, PhysicalCoil, or MaterialLot,
    // reject with 404 if no other target selector (part, coil, lot) was resolved.
    if (lookupKey && !dbCoil && !dbLot && !dbPart) {
      return {
        success: false,
        statusCode: 404,
        errorCode: 'QM_TARGET_NOT_FOUND',
        error: `کلید موجودی مبدأ «${lookupKey}» در پایگاه داده یافت نشد.`,
      };
    }

    const dbLoc =
      dbWh && lookupLocationCode
        ? await prisma.warehouseLocation.findFirst({
            where: { warehouseId: dbWh.id, code: lookupLocationCode },
          })
        : null;

    const sbWhere: Record<string, any> = {
      qualityStatus: { in: expectedSourceStatuses },
      quantityOnHand: { gt: 0 },
    };
    if (dbPart) sbWhere.partId = dbPart.id;
    if (dbWh) sbWhere.warehouseId = dbWh.id;
    if (dbLoc) sbWhere.locationId = dbLoc.id;
    if (dbCoil) sbWhere.physicalCoilId = dbCoil.id;
    else if (dbLot) sbWhere.materialLotId = dbLot.id;
    if (lookupOwnership) sbWhere.ownership = lookupOwnership;
    if (lookupContractId) sbWhere.contractId = lookupContractId;

    candidateBalances = await prisma.stockBalance.findMany({
      where: sbWhere,
      include: {
        part: { include: { unit: true } },
        warehouse: true,
        location: true,
        materialLot: true,
        physicalCoil: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  if (candidateBalances.length === 0) {
    return {
      success: false,
      statusCode: 404,
      error: 'موجودی معتبر با وضعیت کیفی مبدأ برای انتقال کیفی در PostgreSQL یافت نشد.',
    };
  }

  const primaryBalance = candidateBalances[0];
  const sourceQualityStatus = (
    primaryBalance.qualityStatus === 'UNRESTRICTED' ? 'AVAILABLE' : primaryBalance.qualityStatus
  ) as StockQualityStatus;
  if (sourceQualityStatus === targetQualityStatus) {
    return {
      success: false,
      statusCode: 400,
      error: `موجودی انتخاب‌شده هم‌اکنون در وضعیت «${targetQualityStatus}» قرار دارد.`,
    };
  }

  const unitCode = (primaryBalance.part?.unit?.code || params.fallbackUnit || 'KG') as 'KG' | 'PCS';
  const isMultiSegmentCoil =
    candidateBalances.length > 1 &&
    Boolean(primaryBalance.physicalCoilId) &&
    candidateBalances.every((b: any) => b.physicalCoilId === primaryBalance.physicalCoilId);

  if (candidateBalances.length > 1 && !isMultiSegmentCoil) {
    const distinctBuckets = new Set(
      candidateBalances.map(
        (b: any) =>
          `${b.partId || ''}::${b.warehouseId || ''}::${b.locationId || ''}::${b.materialLotId || ''}::${b.physicalCoilId || ''}::${b.ownership || ''}::${b.contractId || ''}`
      )
    );
    if (distinctBuckets.size > 1) {
      return {
        success: false,
        statusCode: 409,
        errorCode: 'AMBIGUOUS_QM_TARGET',
        error:
          'بیش از یک ردیف موجودی مجزا با مشخصات ارسالی یافت شد. لطفاً کلید ردیف، شماره بچ/کلاف، موقعیت انبار یا قرارداد را دقیق‌تر مشخص کنید.',
      };
    }
  }

  const selectedSegments = isMultiSegmentCoil ? candidateBalances : [primaryBalance];
  const totalMovableAcrossSegments = selectedSegments.reduce(
    (sum: number, b: any) =>
      sum +
      (movementType === '321'
        ? Number(b.quantityOnHand || 0)
        : Number(b.quantityAvailable ?? b.quantityOnHand ?? 0)),
    0
  );

  const requestedQty = Number(
    params.heldQty || (unitCode === 'KG' ? params.heldWeightKg : 0) || totalMovableAcrossSegments || 0
  );

  if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
    return {
      success: false,
      statusCode: 400,
      error: 'مقدار انتقال وضعیت کیفی باید بزرگتر از صفر باشد.',
    };
  }

  const nowIso = new Date().toISOString();
  const docNumber = `QM-${movementType}-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
  const lines: InventoryDocumentLine[] = [];
  let remainingToAllocate = requestedQty;
  let totalWeightKg = 0;

  for (let i = 0; i < selectedSegments.length; i++) {
    const seg = selectedSegments[i];
    const segMaxMovable =
      movementType === '321'
        ? Number(seg.quantityOnHand || 0)
        : Number(seg.quantityAvailable ?? seg.quantityOnHand ?? 0);
    const isLast = i === selectedSegments.length - 1;
    const segQty =
      selectedSegments.length === 1
        ? requestedQty
        : isLast
          ? Number(remainingToAllocate.toFixed(6))
          : Math.min(segMaxMovable, Number(remainingToAllocate.toFixed(6)));

    if (segQty <= EPS) continue;
    remainingToAllocate = Math.max(0, Number((remainingToAllocate - segQty).toFixed(6)));

    const ratio = Number(seg.quantityOnHand || 0) > 0 ? segQty / Number(seg.quantityOnHand) : 1;
    const segWeightKg =
      unitCode === 'KG'
        ? segQty
        : Number((Number(seg.weightKgOnHand || segQty) * ratio).toFixed(3));
    totalWeightKg = Number((totalWeightKg + segWeightKg).toFixed(6));

    const segSourceQuality = (
      seg.qualityStatus === 'UNRESTRICTED' ? 'AVAILABLE' : seg.qualityStatus
    ) as StockQualityStatus;

    lines.push({
      id: `LN-QM-${Date.now()}-${i + 1}`,
      documentId: `DOC-${docNumber}`,
      lineNumber: lines.length + 1,
      partId: seg.partId,
      partCode: seg.part?.partNumber || seg.partId,
      partName: seg.part?.name || seg.part?.partNumber || seg.partId,
      materialLotId: seg.materialLotId || undefined,
      physicalCoilId: seg.physicalCoilId || undefined,
      coilId: seg.physicalCoil?.coilId || undefined,
      coilPackNumber: seg.physicalCoil?.coilPackNumber || undefined,
      lotNumber: seg.materialLot?.lotNumber || seg.physicalCoil?.coilPackNumber || undefined,
      heatNumber: seg.materialLot?.heatNumber || seg.physicalCoil?.heatNumber || undefined,
      ownership: (seg.ownership || 'COMPANY_OWNED') as StockOwnership,
      contractId: seg.contractId || undefined,
      contractNumber: seg.contractNumber || undefined,
      locationCode: seg.location?.code || undefined,
      quantity: segQty,
      unit: unitCode,
      quantityKg: segWeightKg,
      qualityStatus: targetQualityStatus,
      sourceQualityStatus: segSourceQuality,
      targetQualityStatus,
      movementType,
      qmStatusTarget: qmTarget,
      notes: params.reasonFa || SAP_MOVEMENT_CATALOG[movementType]?.labelFa,
    });
  }

  const qmDoc: InventoryDocument = {
    id: `DOC-QM-${Date.now()}`,
    documentNumber: docNumber,
    documentType: 'STOCK_STATUS_TRANSFER',
    movementType,
    movementLabel: SAP_MOVEMENT_CATALOG[movementType]?.labelFa,
    qmStatusTarget: qmTarget,
    idempotencyKey: params.idempotencyKey,
    documentDate: nowIso,
    documentStatus: 'DRAFT',
    postingStatus: 'UNPOSTED',
    warehouseId: primaryBalance.warehouse?.code || primaryBalance.warehouseId,
    warehouseName: primaryBalance.warehouse?.name || primaryBalance.warehouseId,
    ownership: (primaryBalance.ownership || 'COMPANY_OWNED') as StockOwnership,
    contractId: lines.length === 1 ? lines[0].contractId : undefined,
    contractNumber: lines.length === 1 ? lines[0].contractNumber : undefined,
    referenceType: 'QM_INSPECTION',
    referenceNumber:
      primaryBalance.materialLot?.lotNumber ||
      primaryBalance.physicalCoil?.coilPackNumber ||
      primaryBalance.part?.partNumber,
    adjustmentReason: params.reasonFa || SAP_MOVEMENT_CATALOG[movementType]?.labelFa,
    auditNote: `انتقال وضعیت کیفی [کد حرکت ${movementType}]: ${params.reasonFa || SAP_MOVEMENT_CATALOG[movementType]?.shortFa}`,
    lines,
    totalQuantity: requestedQty,
    totalWeightKg,
    createdByUid: qmUser.uid,
    createdByName: qmUser.displayName,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  return {
    success: true,
    qmDoc,
    primaryBalance,
    totalQty: requestedQty,
    totalWeightKg,
    requestedQty,
    weightKg: totalWeightKg,
  };
}

/**
 * =========================================================================
 * P0-B.3: POSTGRESQL-AUTHORITATIVE INVENTORY RESERVATIONS ENGINE
 * =========================================================================
 */
export interface ReservationMutationResult {
  success: boolean;
  statusCode: number;
  errorCode?: string;
  error?: string;
  idempotentReplay?: boolean;
  reservation?: InventoryReservation;
}

export async function createReservationInDbTransaction(
  prisma: any,
  payload: {
    id?: string;
    reservationNumber?: string;
    idempotencyKey?: string;
    partId: string;
    partCode?: string;
    warehouseId: string;
    locationCode?: string;
    lotNumber?: string;
    physicalCoilId?: string;
    ownership?: StockOwnership;
    contractId?: string;
    reservedFor?: string;
    referenceType?: string;
    referenceNumber?: string;
    reservedForMOId?: string;
    reservedForCOId?: string;
    quantity: number;
    validUntil?: string;
    notes?: string;
    user?: { uid?: string; displayName?: string };
  },
  maxRetries = 5
): Promise<ReservationMutationResult> {
  const reqQty = Number(payload.quantity);
  if (!payload.partId || !payload.warehouseId || !Number.isFinite(reqQty) || reqQty <= 0) {
    return {
      success: false,
      statusCode: 400,
      errorCode: 'INVALID_RESERVATION_INPUT',
      error: 'قطعه، انبار و مقدار رزرو معتبر (بزرگتر از صفر) الزامی هستند.',
    };
  }

  const resNumber =
    (payload.idempotencyKey || payload.reservationNumber || '').trim() ||
    `RES-1403-${Date.now().toString().slice(-5)}-${Math.floor(100 + Math.random() * 900)}`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const outcome = await prisma.$transaction(
        async (tx: any) => {
          // Idempotency check by reservationNumber
          const existing = await tx.inventoryReservation.findFirst({
            where: {
              OR: [
                { reservationNumber: resNumber },
                ...(payload.id ? [{ id: payload.id }] : []),
              ],
            },
            include: {
              part: { include: { unit: true } },
              warehouse: true,
              location: true,
              materialLot: true,
              physicalCoil: true,
              contract: true,
            },
          });

          if (existing) {
            const samePart =
              existing.partId === payload.partId || existing.part?.partNumber === payload.partId;
            const sameWh =
              existing.warehouseId === payload.warehouseId ||
              existing.warehouse?.code === payload.warehouseId;
            const sameQty = Math.abs(Number(existing.quantity) - reqQty) <= EPS;
            if (!samePart || !sameWh || !sameQty) {
              throw new InventoryPostingError(
                'IDEMPOTENCY_PAYLOAD_MISMATCH',
                409,
                `کلید رزرو «${resNumber}» قبلاً با مشخصات متفاوتی ثبت شده است.`
              );
            }
            return { idempotentReplay: true, dbReservation: existing };
          }

          const part = await tx.part.findFirst({
            where: {
              OR: [{ id: payload.partId }, { partNumber: payload.partId }],
              active: true,
            },
            include: { unit: true },
          });
          if (!part) {
            throw new InventoryPostingError('PART_NOT_FOUND', 404, 'قطعه مورد نظر در PostgreSQL یافت نشد.');
          }

          const warehouse = await tx.warehouse.findFirst({
            where: {
              OR: [{ id: payload.warehouseId }, { code: payload.warehouseId }],
              active: true,
            },
          });
          if (!warehouse) {
            throw new InventoryPostingError('WAREHOUSE_NOT_FOUND', 404, 'انبار مورد نظر در PostgreSQL یافت نشد.');
          }

          let location: any = null;
          if (payload.locationCode) {
            location = await tx.warehouseLocation.findFirst({
              where: {
                warehouseId: warehouse.id,
                OR: [{ code: payload.locationCode }, { id: payload.locationCode }],
              },
            });
          }

          let coil: any = null;
          if (payload.physicalCoilId || payload.lotNumber) {
            coil = await tx.physicalCoil.findFirst({
              where: {
                OR: [
                  ...(payload.physicalCoilId ? [{ id: payload.physicalCoilId }, { coilId: payload.physicalCoilId }] : []),
                  ...(payload.lotNumber ? [{ coilId: payload.lotNumber }, { coilPackNumber: payload.lotNumber }] : []),
                ],
              },
            });
          }

          let lot: any = null;
          if (payload.lotNumber) {
            lot = await tx.materialLot.findFirst({
              where: { OR: [{ lotNumber: payload.lotNumber }, { id: payload.lotNumber }] },
            });
          } else if (coil?.materialLotId) {
            lot = await tx.materialLot.findUnique({ where: { id: coil.materialLotId } });
          }

          let contract: any = null;
          if (payload.contractId) {
            contract = await tx.materialContract.findFirst({
              where: { OR: [{ id: payload.contractId }, { contractNumber: payload.contractId }] },
            });
          }

          let dbUser = await tx.user.findFirst({
            where: payload.user?.uid
              ? { OR: [{ id: payload.user.uid }, { username: payload.user.uid }] }
              : { active: true },
          });
          if (!dbUser) {
            dbUser = await tx.user.findFirst({ where: { active: true } });
          }
          if (!dbUser) {
            throw new InventoryPostingError('USER_NOT_FOUND', 400, 'کاربر ثبت‌کننده رزرو در PostgreSQL یافت نشد.');
          }

          const sbWhere: Record<string, any> = {
            partId: part.id,
            warehouseId: warehouse.id,
            qualityStatus: { in: ['AVAILABLE', 'UNRESTRICTED'] },
            quantityAvailable: { gt: 0 },
          };
          if (location) sbWhere.locationId = location.id;
          if (coil) sbWhere.physicalCoilId = coil.id;
          else if (lot) sbWhere.materialLotId = lot.id;
          if (payload.ownership) sbWhere.ownership = payload.ownership;
          if (contract) sbWhere.contractId = contract.id;

          const availableBalances = await tx.stockBalance.findMany({
            where: sbWhere,
            orderBy: { updatedAt: 'asc' },
          });

          const totalAvailable = availableBalances.reduce(
            (sum: number, b: any) => sum + Number(b.quantityAvailable || 0),
            0
          );
          const unitCode = part.unit?.code || 'PCS';
          if (reqQty > totalAvailable + EPS) {
            throw new InventoryPostingError(
              'INSUFFICIENT_AVAILABLE_STOCK',
              400,
              `موجودی آزاد جهت رزرو ناکافی است. موجودی آزاد: ${totalAvailable} ${unitCode}، درخواست رزرو: ${reqQty} ${unitCode}`
            );
          }

          const weightPerUnit = Number(part.weightNetKg || part.weightGrossKg || 1) || 1;
          const totalReqWeightKg =
            unitCode === 'KG' ? reqQty : Number((reqQty * weightPerUnit).toFixed(3));

          let resolvedMoId: string | null = null;
          let resolvedMoNumber: string | null = null;
          if (typeof tx.manufacturingOrder?.findFirst === 'function') {
            const explicitMoRef = payload.reservedForMOId?.trim();
            const refNumMo =
              payload.referenceType === 'MANUFACTURING_ORDER' && payload.referenceNumber
                ? String(payload.referenceNumber).trim()
                : '';
            const patternMoMatch =
              !explicitMoRef && !refNumMo && payload.reservedFor
                ? String(payload.reservedFor).match(/\b(MO-[A-Za-z0-9-]+)\b/i)?.[1] || ''
                : '';
            const moLookupRef = explicitMoRef || refNumMo || patternMoMatch;
            if (moLookupRef) {
              const dbMo = await tx.manufacturingOrder.findFirst({
                where: { OR: [{ id: moLookupRef }, { moNumber: moLookupRef }] },
              });
              if (!dbMo && explicitMoRef) {
                throw new InventoryPostingError(
                  'MO_NOT_FOUND',
                  404,
                  `دستور تولید «${moLookupRef}» در PostgreSQL یافت نشد.`
                );
              }
              if (dbMo) {
                if (dbMo.status === 'CANCELLED' || dbMo.status === 'CLOSED' || dbMo.status === 'COMPLETED') {
                  throw new InventoryPostingError(
                    'MO_NOT_RESERVABLE',
                    409,
                    `دستور تولید «${dbMo.moNumber}» در وضعیت «${dbMo.status}» قرار دارد و رزرو جدید برای آن مجاز نیست.`
                  );
                }
                resolvedMoId = dbMo.id;
                resolvedMoNumber = dbMo.moNumber;
              }
            }
          }

          let remainingToReserve = reqQty;
          const balanceAllocations: Array<{
            stockBalanceId: string;
            reservedQty: number;
            reservedWeightKg: number;
          }> = [];

          for (const sb of availableBalances) {
            if (remainingToReserve <= EPS) break;
            const sbAvail = Number(sb.quantityAvailable || 0);
            if (sbAvail <= EPS) continue;

            const allocQty = Math.min(sbAvail, Number(remainingToReserve.toFixed(6)));
            const allocKg =
              unitCode === 'KG'
                ? allocQty
                : Number((allocQty * weightPerUnit).toFixed(3));
            const sbWhereGuard: Record<string, any> = {
              id: sb.id,
              quantityAvailable: { gte: allocQty - EPS },
            };
            if (sb.version != null) {
              sbWhereGuard.version = sb.version;
            }

            const updated = await tx.stockBalance.updateMany({
              where: sbWhereGuard,
              data: {
                quantityReserved: { increment: allocQty },
                quantityAvailable: { decrement: allocQty },
                weightKgReserved: { increment: allocKg },
                weightKgAvailable: { decrement: allocKg },
                version: { increment: 1 },
              },
            });

            if (updated.count === 0) {
              throw new InventoryPostingError(
                'CONCURRENCY_CONFLICT',
                409,
                'تعارض هم‌زمانی در رزرو موجودی انبار؛ لطفاً دوباره تلاش کنید.'
              );
            }

            balanceAllocations.push({
              stockBalanceId: sb.id,
              reservedQty: allocQty,
              reservedWeightKg: allocKg,
            });
            remainingToReserve = Math.max(0, Number((remainingToReserve - allocQty).toFixed(6)));
          }

          const primarySb = availableBalances[0];
          const resolvedOwnership =
            payload.ownership || primarySb?.ownership || 'SAPCO_SUPPLIER_OWNED';

          const createdRes = await tx.inventoryReservation.create({
            data: {
              ...(payload.id ? { id: payload.id } : {}),
              reservationNumber: resNumber,
              partId: part.id,
              warehouseId: warehouse.id,
              locationId: location?.id || primarySb?.locationId || null,
              materialLotId: lot?.id || primarySb?.materialLotId || null,
              physicalCoilId: coil?.id || primarySb?.physicalCoilId || null,
              ownership: resolvedOwnership,
              contractId: contract?.id || primarySb?.contractId || null,
              reservedForMOId: resolvedMoId,
              reservedForCOId: payload.reservedForCOId || null,
              quantity: reqQty,
              weightKg: totalReqWeightKg,
              status: 'ACTIVE',
              validUntil: payload.validUntil ? new Date(payload.validUntil) : null,
              createdByUserId: dbUser.id,
            },
            include: {
              part: { include: { unit: true } },
              warehouse: true,
              location: true,
              materialLot: true,
              physicalCoil: true,
              contract: true,
              reservedForMO: true,
            },
          });

          await tx.auditLog.create({
            data: {
              userId: dbUser.id,
              action: 'RESERVATION_CREATE',
              entityName: 'InventoryReservation',
              entityId: createdRes.id,
              oldValues: { status: null },
              newValues: {
                reservationNumber: createdRes.reservationNumber,
                reservedFor: payload.reservedFor || 'تخصیص خط تولید',
                quantity: reqQty,
                weightKg: totalReqWeightKg,
                balanceAllocations,
              },
            },
          });

          return {
            idempotentReplay: false,
            dbReservation: createdRes,
            reservedFor: payload.reservedFor || resolvedMoNumber || 'تخصیص خط تولید',
          };
        },
        {
          isolationLevel: 'Serializable',
          maxWait: 10000,
          timeout: 30000,
        }
      );

      const r = outcome.dbReservation;
      const mapped: InventoryReservation = {
        id: r.id,
        reservationNumber: r.reservationNumber,
        partId: r.partId,
        partCode: r.part?.partNumber || r.partId,
        partName: r.part?.name || r.part?.partNumber || r.partId,
        warehouseId: r.warehouse?.code || r.warehouseId,
        warehouseName: r.warehouse?.name || r.warehouseId,
        lotNumber:
          r.materialLot?.lotNumber ||
          r.physicalCoil?.coilPackNumber ||
          r.physicalCoil?.coilId ||
          payload.lotNumber,
        ownership: (r.ownership || payload.ownership || 'SAPCO_SUPPLIER_OWNED') as StockOwnership,
        reservedFor: r.reservedForMO?.moNumber || (outcome as any).reservedFor || payload.reservedFor || 'تخصیص خط تولید',
        quantity: Number(r.quantity),
        quantityKg: Number(r.weightKg),
        unit: r.part?.unit?.code || 'PCS',
        status: r.status,
        validUntil: r.validUntil instanceof Date ? r.validUntil.toISOString() : undefined,
        createdAt: (r.createdAt instanceof Date ? r.createdAt : new Date()).toISOString(),
      };

      return {
        success: true,
        statusCode: outcome.idempotentReplay ? 200 : 201,
        idempotentReplay: outcome.idempotentReplay,
        reservation: mapped,
      };
    } catch (error: any) {
      if (attempt < maxRetries && isRetryableSerializationError(error)) {
        const backoffMs = Math.min(250, 20 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 25);
        await sleepMs(backoffMs);
        continue;
      }
      if (error instanceof InventoryPostingError) {
        return {
          success: false,
          statusCode: error.statusCode,
          errorCode: error.code,
          error: error.message,
        };
      }
      return {
        success: false,
        statusCode: 500,
        errorCode: 'RESERVATION_CREATE_FAILED',
        error: error instanceof Error ? error.message : 'خطا در ثبت رزرو موجودی در PostgreSQL',
      };
    }
  }

  return {
    success: false,
    statusCode: 409,
    errorCode: 'SERIALIZATION_RETRY_EXHAUSTED',
    error: 'ثبت رزرو موجودی پس از چند تلاش متوالی به دلیل ترافیک هم‌زمان متوقف شد.',
  };
}

export async function releaseReservationInDbTransaction(
  prisma: any,
  idOrNumber: string,
  options?: {
    idempotencyKey?: string;
    uid?: string;
    displayName?: string;
    user?: { uid?: string; displayName?: string };
  },
  maxRetries = 5
): Promise<ReservationMutationResult> {
  const key = String(idOrNumber || '').trim();
  if (!key) {
    return {
      success: false,
      statusCode: 400,
      errorCode: 'RESERVATION_ID_REQUIRED',
      error: 'شناسه رزرو الزامی است.',
    };
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const outcome = await prisma.$transaction(
        async (tx: any) => {
          const existing = await tx.inventoryReservation.findFirst({
            where: { OR: [{ id: key }, { reservationNumber: key }] },
            include: {
              part: { include: { unit: true } },
              warehouse: true,
              location: true,
              materialLot: true,
              physicalCoil: true,
              contract: true,
            },
          });

          if (!existing) {
            throw new InventoryPostingError('RESERVATION_NOT_FOUND', 404, 'سند رزرو در PostgreSQL یافت نشد.');
          }

          if (existing.status === 'RELEASED') {
            return { idempotentReplay: true, dbReservation: existing };
          }
          if (existing.status !== 'ACTIVE') {
            throw new InventoryPostingError(
              'INVALID_RESERVATION_STATUS',
              409,
              `سند رزرو در وضعیت «${existing.status}» قرار دارد و قابل آزادسازی نیست.`
            );
          }

          const createAudit =
            typeof tx.auditLog?.findFirst === 'function'
              ? await tx.auditLog.findFirst({
                  where: {
                    entityName: 'InventoryReservation',
                    entityId: existing.id,
                    action: 'RESERVATION_CREATE',
                  },
                  orderBy: { timestamp: 'desc' },
                })
              : null;
          const parsedAudit = parseAuditNewValues(createAudit?.newValues);
          const recordedAllocations: Array<{
            stockBalanceId: string;
            reservedQty: number;
            reservedWeightKg: number;
          }> = Array.isArray(parsedAudit.balanceAllocations) ? parsedAudit.balanceAllocations : [];

          let remQty = Number(existing.quantity || 0);
          let remKg = Number(existing.weightKg || 0);

          if (recordedAllocations.length > 0) {
            for (const alloc of recordedAllocations) {
              if (remQty <= EPS && remKg <= EPS) break;
              const sb = await tx.stockBalance.findFirst({ where: { id: alloc.stockBalanceId } });
              if (!sb) continue;
              const releaseQty = Math.min(Number(sb.quantityReserved || 0), Number(alloc.reservedQty || 0), remQty);
              const releaseKg = Math.min(Number(sb.weightKgReserved || 0), Number(alloc.reservedWeightKg || 0), remKg);
              if (releaseQty <= EPS && releaseKg <= EPS) continue;

              const sbWhere: Record<string, any> = {
                id: sb.id,
                quantityReserved: { gte: releaseQty - EPS },
              };
              if (sb.version != null) sbWhere.version = sb.version;
              const updated = await tx.stockBalance.updateMany({
                where: sbWhere,
                data: {
                  quantityReserved: { decrement: releaseQty },
                  quantityAvailable: { increment: releaseQty },
                  weightKgReserved: { decrement: releaseKg },
                  weightKgAvailable: { increment: releaseKg },
                  version: { increment: 1 },
                },
              });
              if (updated.count === 0) {
                throw new InventoryPostingError(
                  'CONCURRENCY_CONFLICT',
                  409,
                  'تعارض هم‌زمانی در آزادسازی رزرو موجودی انبار؛ لطفاً دوباره تلاش کنید.'
                );
              }
              remQty = Math.max(0, round6(remQty - releaseQty));
              remKg = Math.max(0, round6(remKg - releaseKg));
            }
          }

          if (remQty > EPS) {
            const candidateSbs = await tx.stockBalance.findMany({
              where: {
                partId: existing.partId,
                warehouseId: existing.warehouseId,
                ...(existing.locationId ? { locationId: existing.locationId } : {}),
                ...(existing.materialLotId ? { materialLotId: existing.materialLotId } : {}),
                ...(existing.physicalCoilId ? { physicalCoilId: existing.physicalCoilId } : {}),
                ...(existing.contractId ? { contractId: existing.contractId } : {}),
                quantityReserved: { gt: 0 },
              },
              orderBy: { updatedAt: 'desc' },
            });

            for (const sb of candidateSbs) {
              if (remQty <= EPS) break;
              const releaseQty = Math.min(Number(sb.quantityReserved || 0), remQty);
              const releaseKg = Math.min(Number(sb.weightKgReserved || 0), remKg);
              if (releaseQty <= EPS) continue;

              const sbWhere: Record<string, any> = {
                id: sb.id,
                quantityReserved: { gte: releaseQty - EPS },
              };
              if (sb.version != null) sbWhere.version = sb.version;
              const updated = await tx.stockBalance.updateMany({
                where: sbWhere,
                data: {
                  quantityReserved: { decrement: releaseQty },
                  quantityAvailable: { increment: releaseQty },
                  weightKgReserved: { decrement: releaseKg },
                  weightKgAvailable: { increment: releaseKg },
                  version: { increment: 1 },
                },
              });
              if (updated.count === 0) {
                throw new InventoryPostingError(
                  'CONCURRENCY_CONFLICT',
                  409,
                  'تعارض هم‌زمانی در آزادسازی رزرو موجودی انبار؛ لطفاً دوباره تلاش کنید.'
                );
              }
              remQty = Math.max(0, round6(remQty - releaseQty));
              remKg = Math.max(0, round6(remKg - releaseKg));
            }
          }

          const resUpdated = await tx.inventoryReservation.updateMany({
            where: { id: existing.id, status: 'ACTIVE' },
            data: { status: 'RELEASED' },
          });
          if (resUpdated.count === 0) {
            throw new InventoryPostingError(
              'CONCURRENCY_CONFLICT',
              409,
              'وضعیت سند رزرو به صورت هم‌زمان تغییر کرده است.'
            );
          }

          const updatedRes = { ...existing, status: 'RELEASED' };
          return {
            idempotentReplay: false,
            dbReservation: updatedRes,
            reservedFor: parsedAudit.reservedFor || 'تخصیص خط تولید',
          };
        },
        {
          isolationLevel: 'Serializable',
          maxWait: 10000,
          timeout: 30000,
        }
      );

      const r = outcome.dbReservation;
      const mapped: InventoryReservation = {
        id: r.id,
        reservationNumber: r.reservationNumber,
        partId: r.partId,
        partCode: r.part?.partNumber || r.partId,
        partName: r.part?.name || r.part?.partNumber || r.partId,
        warehouseId: r.warehouse?.code || r.warehouseId,
        warehouseName: r.warehouse?.name || r.warehouseId,
        lotNumber:
          r.materialLot?.lotNumber ||
          r.physicalCoil?.coilPackNumber ||
          r.physicalCoil?.coilId ||
          undefined,
        ownership: (r.ownership || 'SAPCO_SUPPLIER_OWNED') as StockOwnership,
        reservedFor: (outcome as any).reservedFor || 'تخصیص خط تولید',
        quantity: Number(r.quantity),
        quantityKg: Number(r.weightKg),
        unit: r.part?.unit?.code || 'PCS',
        status: 'RELEASED',
        validUntil: r.validUntil instanceof Date ? r.validUntil.toISOString() : undefined,
        createdAt: (r.createdAt instanceof Date ? r.createdAt : new Date()).toISOString(),
      };

      return {
        success: true,
        statusCode: 200,
        idempotentReplay: outcome.idempotentReplay,
        reservation: mapped,
      };
    } catch (error: any) {
      if (attempt < maxRetries && isRetryableSerializationError(error)) {
        const backoffMs = Math.min(250, 20 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 25);
        await sleepMs(backoffMs);
        continue;
      }
      if (error instanceof InventoryPostingError) {
        return {
          success: false,
          statusCode: error.statusCode,
          errorCode: error.code,
          error: error.message,
        };
      }
      return {
        success: false,
        statusCode: 500,
        errorCode: 'RESERVATION_RELEASE_FAILED',
        error: error instanceof Error ? error.message : 'خطا در آزادسازی رزرو موجودی در PostgreSQL',
      };
    }
  }

  return {
    success: false,
    statusCode: 409,
    errorCode: 'SERIALIZATION_RETRY_EXHAUSTED',
    error: 'آزادسازی رزرو پس از چند تلاش متوالی متوقف شد.',
  };
}

export async function queryReservationsFromDb(prisma: any): Promise<InventoryReservation[]> {
  const rows = await prisma.inventoryReservation.findMany({
    include: {
      part: { include: { unit: true } },
      warehouse: true,
      location: true,
      materialLot: true,
      physicalCoil: true,
      contract: true,
      reservedForMO: true,
      reservedForCO: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  return (rows || []).map((r: any) => ({
    id: r.id,
    reservationNumber: r.reservationNumber,
    partId: r.partId,
    partCode: r.part?.partNumber || r.partId,
    partName: r.part?.name || r.part?.partNumber || r.partId,
    warehouseId: r.warehouse?.code || r.warehouseId,
    warehouseName: r.warehouse?.name || r.warehouseId,
    lotNumber:
      r.materialLot?.lotNumber ||
      r.physicalCoil?.coilPackNumber ||
      r.physicalCoil?.coilId ||
      undefined,
    ownership: (r.ownership || 'SAPCO_SUPPLIER_OWNED') as StockOwnership,
    reservedFor:
      r.reservedForMO?.moNumber ||
      r.reservedForCO?.orderNumber ||
      'تخصیص خط تولید',
    quantity: Number(r.quantity || 0),
    quantityKg: Number(r.weightKg || 0),
    unit: r.part?.unit?.code || 'PCS',
    status: r.status,
    validUntil: r.validUntil instanceof Date ? r.validUntil.toISOString() : undefined,
    createdAt: (r.createdAt instanceof Date ? r.createdAt : new Date()).toISOString(),
  }));
}

/**
 * Unlock & consume active reservations bound to a specific Manufacturing Order
 * right before raw material deduction, while strictly preserving other MOs' reservations.
 */
export async function consumeMoReservationsInTx(
  tx: any,
  args: {
    moId: string;
    partId: string;
    warehouseId: string;
    locationId?: string | null;
    materialLotId?: string | null;
    physicalCoilId?: string | null;
    contractId?: string | null;
    consumeQuantity: number;
    consumeWeightKg: number;
    now?: Date;
  }
): Promise<{ unlockedQty: number; unlockedWeightKg: number; consumedReservationIds: string[] }> {
  if (typeof tx.inventoryReservation?.findMany !== 'function') {
    return { unlockedQty: 0, unlockedWeightKg: 0, consumedReservationIds: [] };
  }

  const now = args.now || new Date();
  const reqQty = round6(Math.max(0, Number(args.consumeQuantity || 0)));
  const reqKg = round6(Math.max(0, Number(args.consumeWeightKg || 0)));
  if (reqQty <= EPS && reqKg <= EPS) {
    return { unlockedQty: 0, unlockedWeightKg: 0, consumedReservationIds: [] };
  }

  const activeMoReservations = await tx.inventoryReservation.findMany({
    where: {
      reservedForMOId: args.moId,
      partId: args.partId,
      warehouseId: args.warehouseId,
      status: 'ACTIVE',
    },
    orderBy: { createdAt: 'asc' },
  });

  if (!Array.isArray(activeMoReservations) || activeMoReservations.length === 0) {
    return { unlockedQty: 0, unlockedWeightKg: 0, consumedReservationIds: [] };
  }

  // Score specificity so exact coil/lot/location/contract reservations are consumed before generic ones
  const eligible = activeMoReservations
    .filter((r: any) => {
      if (r.physicalCoilId && args.physicalCoilId && r.physicalCoilId !== args.physicalCoilId) return false;
      if (r.physicalCoilId && !args.physicalCoilId) return false;
      if (r.materialLotId && args.materialLotId && r.materialLotId !== args.materialLotId) return false;
      if (r.locationId && args.locationId && r.locationId !== args.locationId) return false;
      if (r.contractId && args.contractId && r.contractId !== args.contractId) return false;
      return Number(r.quantity || 0) > EPS || Number(r.weightKg || 0) > EPS;
    })
    .sort((a: any, b: any) => {
      const score = (r: any) =>
        (r.physicalCoilId && r.physicalCoilId === args.physicalCoilId ? 8 : 0) +
        (r.contractId && r.contractId === args.contractId ? 4 : 0) +
        (r.materialLotId && r.materialLotId === args.materialLotId ? 2 : 0) +
        (r.locationId && r.locationId === args.locationId ? 1 : 0);
      return score(b) - score(a);
    });

  let remainingNeedQty = reqQty;
  let remainingNeedKg = reqKg;
  let totalUnlockedQty = 0;
  let totalUnlockedKg = 0;
  const consumedReservationIds: string[] = [];

  for (const resRow of eligible) {
    if (remainingNeedQty <= EPS && remainingNeedKg <= EPS) break;
    const resQty = round6(Number(resRow.quantity || 0));
    const resKg = round6(Number(resRow.weightKg || 0));
    if (resQty <= EPS && resKg <= EPS) continue;

    const unlockTargetQty = Math.min(resQty, remainingNeedQty > EPS ? remainingNeedQty : resQty);
    const ratio = resQty > EPS ? Math.min(1, unlockTargetQty / resQty) : 1;
    const unlockTargetKg = Math.min(resKg, remainingNeedKg > EPS ? remainingNeedKg : round6(resKg * ratio));

    // Prioritize target StockBalance matching the issue first, then audit balanceAllocations, then warehouse fallback
    const candidateBalanceOrder: any[] = [];
    const seenSbIds = new Set<string>();
    const pushSb = (sb: any) => {
      if (sb && !seenSbIds.has(sb.id) && Number(sb.quantityReserved || 0) > EPS) {
        seenSbIds.add(sb.id);
        candidateBalanceOrder.push(sb);
      }
    };

    const exactTargetBalances = await tx.stockBalance.findMany({
      where: {
        partId: args.partId,
        warehouseId: args.warehouseId,
        qualityStatus: 'AVAILABLE',
        quantityReserved: { gt: 0 },
        ...(args.locationId ? { locationId: args.locationId } : {}),
        ...(args.physicalCoilId ? { physicalCoilId: args.physicalCoilId } : {}),
        ...(args.materialLotId ? { materialLotId: args.materialLotId } : {}),
        ...(args.contractId ? { contractId: args.contractId } : {}),
      },
      orderBy: { updatedAt: 'asc' },
    });
    for (const sb of exactTargetBalances) pushSb(sb);

    const createAudit =
      typeof tx.auditLog?.findFirst === 'function'
        ? await tx.auditLog.findFirst({
            where: {
              entityName: 'InventoryReservation',
              entityId: resRow.id,
              action: 'RESERVATION_CREATE',
            },
            orderBy: { timestamp: 'desc' },
          })
        : null;
    const parsedAudit = parseAuditNewValues(createAudit?.newValues);
    if (Array.isArray(parsedAudit?.balanceAllocations)) {
      for (const alloc of parsedAudit.balanceAllocations) {
        if (!alloc?.stockBalanceId) continue;
        const sb = await tx.stockBalance.findFirst({ where: { id: alloc.stockBalanceId } });
        pushSb(sb);
      }
    }

    const fallbackBalances = await tx.stockBalance.findMany({
      where: {
        partId: args.partId,
        warehouseId: args.warehouseId,
        qualityStatus: 'AVAILABLE',
        quantityReserved: { gt: 0 },
        ...(resRow.physicalCoilId ? { physicalCoilId: resRow.physicalCoilId } : {}),
        ...(resRow.materialLotId ? { materialLotId: resRow.materialLotId } : {}),
        ...(resRow.contractId ? { contractId: resRow.contractId } : {}),
      },
      orderBy: { updatedAt: 'asc' },
    });
    for (const sb of fallbackBalances) pushSb(sb);

    let remForResQty = unlockTargetQty;
    let remForResKg = unlockTargetKg;
    let unlockedForThisResQty = 0;
    let unlockedForThisResKg = 0;

    for (const sb of candidateBalanceOrder) {
      if (remForResQty <= EPS) break;
      const sbReservedQty = round6(Number(sb.quantityReserved || 0));
      const sbReservedKg = round6(Number(sb.weightKgReserved || 0));
      const takeQty = Math.min(sbReservedQty, remForResQty);
      if (takeQty <= EPS) continue;
      const takeKg = Math.min(sbReservedKg, remForResKg > EPS ? remForResKg : takeQty);

      const sbWhere: Record<string, any> = {
        id: sb.id,
        quantityReserved: { gte: round6(takeQty - EPS) },
      };
      if (sb.version != null) sbWhere.version = sb.version;

      const updatedSb = await tx.stockBalance.updateMany({
        where: sbWhere,
        data: {
          quantityReserved: { decrement: takeQty },
          quantityAvailable: { increment: takeQty },
          weightKgReserved: { decrement: takeKg },
          weightKgAvailable: { increment: takeKg },
          version: { increment: 1 },
          updatedAt: now,
        },
      });
      if (updatedSb.count !== 1) {
        throw new InventoryPostingError(
          'RESERVATION_CONCURRENCY_CONFLICT',
          409,
          'تداخل همزمان هنگام مصرف رزرو دستور تولید در کاردکس انبار رخ داد.'
        );
      }
      remForResQty = Math.max(0, round6(remForResQty - takeQty));
      remForResKg = Math.max(0, round6(remForResKg - takeKg));
      unlockedForThisResQty = round6(unlockedForThisResQty + takeQty);
      unlockedForThisResKg = round6(unlockedForThisResKg + takeKg);
    }

    if (unlockedForThisResQty > EPS) {
      const nextResQty = Math.max(0, round6(resQty - unlockedForThisResQty));
      const nextResKg = Math.max(0, round6(resKg - unlockedForThisResKg));
      const fullyConsumed = nextResQty <= EPS;
      const resUpdate = await tx.inventoryReservation.updateMany({
        where: { id: resRow.id, status: 'ACTIVE' },
        data: fullyConsumed
          ? { status: 'CONSUMED', updatedAt: now }
          : { quantity: nextResQty, weightKg: nextResKg, updatedAt: now },
      });
      if (resUpdate.count !== 1) {
        throw new InventoryPostingError(
          'RESERVATION_CONCURRENCY_CONFLICT',
          409,
          `وضعیت رزرو «${resRow.reservationNumber}» همزمان تغییر کرده است.`
        );
      }
      consumedReservationIds.push(resRow.id);
      totalUnlockedQty = round6(totalUnlockedQty + unlockedForThisResQty);
      totalUnlockedKg = round6(totalUnlockedKg + unlockedForThisResKg);
      remainingNeedQty = Math.max(0, round6(remainingNeedQty - unlockedForThisResQty));
      remainingNeedKg = Math.max(0, round6(remainingNeedKg - unlockedForThisResKg));
    }
  }

  return {
    unlockedQty: totalUnlockedQty,
    unlockedWeightKg: totalUnlockedKg,
    consumedReservationIds,
  };
}

/**
 * Release all remaining ACTIVE reservations for an MO (e.g. on MO completion or cancellation/rollback).
 */
export async function releaseMoReservationsInTx(
  tx: any,
  moId: string,
  options?: { reason?: string; now?: Date; prismaUserId?: string }
): Promise<{ releasedCount: number; releasedQty: number; releasedWeightKg: number }> {
  if (typeof tx.inventoryReservation?.findMany !== 'function') {
    return { releasedCount: 0, releasedQty: 0, releasedWeightKg: 0 };
  }
  const now = options?.now || new Date();
  const activeList = await tx.inventoryReservation.findMany({
    where: { reservedForMOId: moId, status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
  });

  let releasedCount = 0;
  let releasedQty = 0;
  let releasedWeightKg = 0;

  for (const resRow of activeList) {
    let remQty = round6(Number(resRow.quantity || 0));
    let remKg = round6(Number(resRow.weightKg || 0));

    const createAudit =
      typeof tx.auditLog?.findFirst === 'function'
        ? await tx.auditLog.findFirst({
            where: {
              entityName: 'InventoryReservation',
              entityId: resRow.id,
              action: 'RESERVATION_CREATE',
            },
            orderBy: { timestamp: 'desc' },
          })
        : null;
    const parsedAudit = parseAuditNewValues(createAudit?.newValues);
    const recordedAllocations: Array<{
      stockBalanceId: string;
      reservedQty: number;
      reservedWeightKg: number;
    }> = Array.isArray(parsedAudit?.balanceAllocations) ? parsedAudit.balanceAllocations : [];

    for (const alloc of recordedAllocations) {
      if (remQty <= EPS && remKg <= EPS) break;
      const sb = await tx.stockBalance.findFirst({ where: { id: alloc.stockBalanceId } });
      if (!sb) continue;
      const relQ = Math.min(Number(sb.quantityReserved || 0), Number(alloc.reservedQty || 0), remQty);
      const relK = Math.min(Number(sb.weightKgReserved || 0), Number(alloc.reservedWeightKg || 0), remKg);
      if (relQ <= EPS && relK <= EPS) continue;

      const sbWhere: Record<string, any> = {
        id: sb.id,
        quantityReserved: { gte: round6(relQ - EPS) },
      };
      if (sb.version != null) sbWhere.version = sb.version;
      const updated = await tx.stockBalance.updateMany({
        where: sbWhere,
        data: {
          quantityReserved: { decrement: relQ },
          quantityAvailable: { increment: relQ },
          weightKgReserved: { decrement: relK },
          weightKgAvailable: { increment: relK },
          version: { increment: 1 },
          updatedAt: now,
        },
      });
      if (updated.count !== 1) {
        throw new InventoryPostingError(
          'RESERVATION_RELEASE_CONFLICT',
          409,
          'تعارض همزمان هنگام آزادسازی خودکار رزروهای دستور تولید رخ داد.'
        );
      }
      remQty = Math.max(0, round6(remQty - relQ));
      remKg = Math.max(0, round6(remKg - relK));
      releasedQty = round6(releasedQty + relQ);
      releasedWeightKg = round6(releasedWeightKg + relK);
    }

    if (remQty > EPS) {
      const candidateSbs = await tx.stockBalance.findMany({
        where: {
          partId: resRow.partId,
          warehouseId: resRow.warehouseId,
          ...(resRow.locationId ? { locationId: resRow.locationId } : {}),
          ...(resRow.materialLotId ? { materialLotId: resRow.materialLotId } : {}),
          ...(resRow.physicalCoilId ? { physicalCoilId: resRow.physicalCoilId } : {}),
          ...(resRow.contractId ? { contractId: resRow.contractId } : {}),
          quantityReserved: { gt: 0 },
        },
        orderBy: { updatedAt: 'desc' },
      });
      for (const sb of candidateSbs) {
        if (remQty <= EPS) break;
        const relQ = Math.min(Number(sb.quantityReserved || 0), remQty);
        const relK = Math.min(Number(sb.weightKgReserved || 0), remKg);
        if (relQ <= EPS) continue;
        const sbWhere: Record<string, any> = {
          id: sb.id,
          quantityReserved: { gte: round6(relQ - EPS) },
        };
        if (sb.version != null) sbWhere.version = sb.version;
        const updated = await tx.stockBalance.updateMany({
          where: sbWhere,
          data: {
            quantityReserved: { decrement: relQ },
            quantityAvailable: { increment: relQ },
            weightKgReserved: { decrement: relK },
            weightKgAvailable: { increment: relK },
            version: { increment: 1 },
            updatedAt: now,
          },
        });
        if (updated.count !== 1) {
          throw new InventoryPostingError(
            'RESERVATION_RELEASE_CONFLICT',
            409,
            'تعارض همزمان هنگام آزادسازی خودکار رزروهای دستور تولید رخ داد.'
          );
        }
        remQty = Math.max(0, round6(remQty - relQ));
        remKg = Math.max(0, round6(remKg - relK));
        releasedQty = round6(releasedQty + relQ);
        releasedWeightKg = round6(releasedWeightKg + relK);
      }
    }

    const resUpdated = await tx.inventoryReservation.updateMany({
      where: { id: resRow.id, status: 'ACTIVE' },
      data: { status: 'RELEASED', updatedAt: now },
    });
    if (resUpdated.count !== 1) {
      throw new InventoryPostingError(
        'RESERVATION_RELEASE_CONFLICT',
        409,
        `وضعیت رزرو «${resRow.reservationNumber}» همزمان تغییر کرده است.`
      );
    }
    releasedCount += 1;
  }

  return { releasedCount, releasedQty, releasedWeightKg };
}

export async function autoReserveMoMaterialsInDbTransaction(
  prisma: any,
  moIdOrNumber: string,
  options?: {
    fallbackBoms?: Array<{
      assemblyPartId?: string;
      assemblyPartCode?: string;
      components: Array<{
        componentPartId?: string;
        componentPartCode?: string;
        componentPartName?: string;
        componentType?: string;
        unit?: string;
        quantityPerAssembly?: number;
        grossWeightKg?: number;
        scrapAllowancePercent?: number;
      }>;
    }>;
    user?: { uid?: string; displayName?: string };
    maxRetries?: number;
  }
): Promise<{
  success: boolean;
  statusCode: number;
  errorCode?: string;
  error?: string;
  data?: {
    moNumber: string;
    reserved: { created: boolean; materialCode: string; quantity: number; unitCode: string }[];
    shortages: { materialCode: string; shortage: number; unitCode: string }[];
  };
}> {
  const moRef = String(moIdOrNumber || '').trim();
  if (!moRef) {
    return { success: false, statusCode: 400, errorCode: 'MO_ID_REQUIRED', error: 'شناسه دستور تولید الزامی است.' };
  }
  const maxRetries = Math.max(1, options?.maxRetries ?? 5);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const outcome = await prisma.$transaction(
        async (tx: any) => {
          let mo = await tx.manufacturingOrder.findFirst({
            where: { OR: [{ id: moRef }, { moNumber: moRef }] },
            include: { part: { include: { unit: true, material: true } } },
          });
          if (!mo && typeof tx.wipManufacturingOrderLink?.findUnique === 'function') {
            const link = await tx.wipManufacturingOrderLink.findUnique({
              where: { wipManufacturingOrderId: moRef },
              select: { manufacturingOrderId: true },
            });
            if (link) {
              mo = await tx.manufacturingOrder.findUnique({
                where: { id: link.manufacturingOrderId },
                include: { part: { include: { unit: true, material: true } } },
              });
            }
          }
          if (!mo) {
            throw new InventoryPostingError('MO_NOT_FOUND', 404, 'دستور کار مورد نظر یافت نشد.');
          }
          if (mo.status === 'CANCELLED' || mo.status === 'CLOSED' || mo.status === 'COMPLETED') {
            throw new InventoryPostingError(
              'MO_NOT_RESERVABLE',
              409,
              `دستور کار «${mo.moNumber}» در وضعیت «${mo.status}» قرار دارد و قابل رزرو نیست.`
            );
          }

          let dbUser = options?.user?.uid
            ? await tx.user.findFirst({
                where: { OR: [{ id: options.user.uid }, { username: options.user.uid }] },
              })
            : null;
          if (!dbUser) {
            dbUser = await tx.user.findFirst({ where: { active: true } });
          }
          if (!dbUser) {
            dbUser = await resolveOrCreateAuditUser(tx, {
              uid: options?.user?.uid || 'USR-MRP-01',
              displayName: options?.user?.displayName || 'برنامه‌ریز تولید MRP',
            });
          }

          // Resolve BOM requirements: DB BomComponent first, then fallbackBoms, then MO part raw material fallback
          const requirements: Array<{
            part: any;
            requiredQty: number;
            unitCode: string;
          }> = [];

          if (typeof tx.item?.findFirst === 'function' && typeof tx.bomComponent?.findMany === 'function') {
            const parentItem = await tx.item.findFirst({
              where: { code: mo.part?.partNumber, isDeleted: false },
            });
            if (parentItem) {
              const dbBomCmps = await tx.bomComponent.findMany({
                where: { parentItemId: parentItem.id, isDeleted: false },
                include: { childItem: true },
              });
              for (const cmp of dbBomCmps) {
                const childCode = cmp.childItem?.code;
                if (!childCode) continue;
                const reqPart = await tx.part.findFirst({
                  where: { partNumber: childCode, active: true },
                  include: { unit: true },
                });
                if (!reqPart) continue;
                const qtyPer = Number(cmp.quantity || 1);
                const scrapFactor = 1 + Number(cmp.scrapFactor || 0) / 100;
                const pieces = Number(mo.targetQty) * qtyPer;
                const unitCode = reqPart.unit?.code || 'PCS';
                const grossPer = Number(reqPart.weightGrossKg || reqPart.weightNetKg || 0.1) || 0.1;
                const requiredQty =
                  unitCode === 'KG'
                    ? round6(pieces * grossPer * scrapFactor)
                    : round6(pieces * scrapFactor);
                requirements.push({ part: reqPart, requiredQty, unitCode });
              }
            }
          }

          if (requirements.length === 0 && Array.isArray(options?.fallbackBoms)) {
            const matchedBom = options!.fallbackBoms.find(
              b => b.assemblyPartId === mo.partId || b.assemblyPartCode === mo.part?.partNumber
            );
            if (matchedBom) {
              for (const cmp of matchedBom.components || []) {
                const partOr: any[] = [];
                if (cmp.componentPartId) partOr.push({ id: cmp.componentPartId });
                if (cmp.componentPartCode) partOr.push({ partNumber: cmp.componentPartCode });
                const reqPart =
                  partOr.length > 0
                    ? await tx.part.findFirst({
                        where: { OR: partOr, active: true },
                        include: { unit: true },
                      })
                    : null;
                if (!reqPart) continue;
                const unitCode = reqPart.unit?.code || cmp.unit || 'PCS';
                const scrapFactor = 1 + Number(cmp.scrapAllowancePercent || 0) / 100;
                const pieces = Number(mo.targetQty) * Number(cmp.quantityPerAssembly || 1);
                const grossPer = Number(cmp.grossWeightKg || reqPart.weightGrossKg || reqPart.weightNetKg || 0.1) || 0.1;
                const requiredQty =
                  unitCode === 'KG'
                    ? round6(pieces * grossPer * scrapFactor)
                    : round6(pieces * scrapFactor);
                requirements.push({ part: reqPart, requiredQty, unitCode });
              }
            }
          }

          if (requirements.length === 0 && mo.part?.materialId) {
            const matchingRawPart = await tx.part.findFirst({
              where: {
                category: 'RAW_MATERIAL',
                materialId: mo.part.materialId,
                active: true,
              },
              include: { unit: true },
            });
            if (matchingRawPart) {
              const unitCode = matchingRawPart.unit?.code || 'KG';
              const grossPer = Number(mo.part.weightGrossKg || mo.part.weightNetKg || 1) || 1;
              const scrapFactor = 1 + Number(mo.part.scrapNormPercent || 0) / 100;
              requirements.push({
                part: matchingRawPart,
                requiredQty: round6(Number(mo.targetQty) * grossPer * scrapFactor),
                unitCode,
              });
            }
          }

          const reserved: { created: boolean; materialCode: string; quantity: number; unitCode: string }[] = [];
          const shortages: { materialCode: string; shortage: number; unitCode: string }[] = [];
          const now = new Date();

          for (let idx = 0; idx < requirements.length; idx++) {
            const req = requirements[idx];
            if (req.requiredQty <= EPS) continue;

            // Subtract material already issued to this MO
            const issuedTxs =
              typeof tx.inventoryTransaction?.findMany === 'function'
                ? await tx.inventoryTransaction.findMany({
                    where: {
                      manufacturingOrderId: mo.id,
                      partId: req.part.id,
                      postingStatus: 'POSTED',
                      isReversal: false,
                    },
                  })
                : [];
            let alreadyIssued = 0;
            for (const t of issuedTxs) {
              if (t.transactionType === 'OUTBOUND') {
                alreadyIssued += req.unitCode === 'KG' ? Math.abs(Number(t.weightKg || 0)) : Math.abs(Number(t.quantity || 0));
              } else if (t.transactionType === 'INBOUND' && t.productionReportId == null) {
                alreadyIssued -= req.unitCode === 'KG' ? Math.abs(Number(t.weightKg || 0)) : Math.abs(Number(t.quantity || 0));
              }
            }
            alreadyIssued = Math.max(0, round6(alreadyIssued));

            // Subtract active reservations already bound to this MO
            const existingMoRes = await tx.inventoryReservation.findMany({
              where: {
                reservedForMOId: mo.id,
                partId: req.part.id,
                status: 'ACTIVE',
              },
            });
            const alreadyReservedForMo = existingMoRes.reduce(
              (sum: number, r: any) =>
                sum + (req.unitCode === 'KG' ? Number(r.weightKg || r.quantity || 0) : Number(r.quantity || 0)),
              0
            );

            const neededQty = Math.max(0, round6(req.requiredQty - alreadyIssued - alreadyReservedForMo));
            if (neededQty <= EPS) continue;

            const candidateBalances = await tx.stockBalance.findMany({
              where: {
                partId: req.part.id,
                qualityStatus: { in: ['AVAILABLE', 'UNRESTRICTED'] },
                quantityAvailable: { gt: 0 },
              },
              include: { warehouse: true },
              orderBy: { updatedAt: 'asc' },
            });

            // Prioritize RAW_MATERIAL and WIP warehouses
            const orderedBalances = candidateBalances
              .filter((b: any) => !b.warehouse || b.warehouse.type === 'RAW_MATERIAL' || b.warehouse.type === 'WIP')
              .sort((a: any, b: any) => {
                const wOrder = (row: any) => (row.warehouse?.type === 'RAW_MATERIAL' ? 0 : 1);
                return wOrder(a) - wOrder(b);
              });

            const weightPerUnit = Number(req.part.weightNetKg || req.part.weightGrossKg || 1) || 1;
            let remainingNeed = neededQty;
            let totalReservedNow = 0;

            for (const sb of orderedBalances) {
              if (remainingNeed <= EPS) break;
              const sbAvail = round6(Number(sb.quantityAvailable || 0));
              if (sbAvail <= EPS) continue;
              const allocQty = Math.min(sbAvail, remainingNeed);
              const allocKg =
                req.unitCode === 'KG' ? allocQty : Number((allocQty * weightPerUnit).toFixed(3));

              const sbWhere: Record<string, any> = {
                id: sb.id,
                quantityAvailable: { gte: round6(allocQty - EPS) },
              };
              if (sb.version != null) sbWhere.version = sb.version;

              const updatedSb = await tx.stockBalance.updateMany({
                where: sbWhere,
                data: {
                  quantityReserved: { increment: allocQty },
                  quantityAvailable: { decrement: allocQty },
                  weightKgReserved: { increment: allocKg },
                  weightKgAvailable: { decrement: allocKg },
                  version: { increment: 1 },
                  updatedAt: now,
                },
              });
              if (updatedSb.count !== 1) {
                throw new InventoryPostingError(
                  'CONCURRENCY_CONFLICT',
                  409,
                  'تعارض همزمانی هنگام رزرو خودکار MRP در موجودی انبار رخ داد.'
                );
              }

              const matchingExisting = existingMoRes.find(
                (r: any) =>
                  r.warehouseId === sb.warehouseId &&
                  (r.locationId || null) === (sb.locationId || null) &&
                  (r.physicalCoilId || null) === (sb.physicalCoilId || null) &&
                  (r.materialLotId || null) === (sb.materialLotId || null) &&
                  (r.contractId || null) === (sb.contractId || null)
              );

              if (matchingExisting) {
                await tx.inventoryReservation.updateMany({
                  where: { id: matchingExisting.id, status: 'ACTIVE' },
                  data: {
                    quantity: { increment: allocQty },
                    weightKg: { increment: allocKg },
                    updatedAt: now,
                  },
                });
                matchingExisting.quantity = round6(Number(matchingExisting.quantity || 0) + allocQty);
                matchingExisting.weightKg = round6(Number(matchingExisting.weightKg || 0) + allocKg);
              } else {
                const resNum = `RES-MRP-${mo.moNumber}-${idx + 1}-${Date.now().toString().slice(-4)}-${Math.floor(100 + Math.random() * 900)}`;
                const createdRes = await tx.inventoryReservation.create({
                  data: {
                    reservationNumber: resNum,
                    partId: req.part.id,
                    warehouseId: sb.warehouseId,
                    locationId: sb.locationId || null,
                    materialLotId: sb.materialLotId || null,
                    physicalCoilId: sb.physicalCoilId || null,
                    ownership: sb.ownership || 'SAPCO_SUPPLIER_OWNED',
                    contractId: sb.contractId || null,
                    reservedForMOId: mo.id,
                    quantity: allocQty,
                    weightKg: allocKg,
                    status: 'ACTIVE',
                    validUntil: new Date(Date.now() + 14 * 24 * 3600 * 1000),
                    createdByUserId: dbUser.id,
                  },
                });
                existingMoRes.push(createdRes);

                if (typeof tx.auditLog?.create === 'function') {
                  await tx.auditLog.create({
                    data: {
                      userId: dbUser.id,
                      action: 'RESERVATION_CREATE',
                      entityName: 'InventoryReservation',
                      entityId: createdRes.id,
                      oldValues: { status: null },
                      newValues: {
                        reservationNumber: createdRes.reservationNumber,
                        reservedFor: mo.moNumber,
                        quantity: allocQty,
                        weightKg: allocKg,
                        balanceAllocations: [
                          {
                            stockBalanceId: sb.id,
                            reservedQty: allocQty,
                            reservedWeightKg: allocKg,
                          },
                        ],
                      },
                    },
                  });
                }
              }

              totalReservedNow = round6(totalReservedNow + allocQty);
              remainingNeed = Math.max(0, round6(remainingNeed - allocQty));
            }

            if (totalReservedNow > EPS) {
              reserved.push({
                created: true,
                materialCode: req.part.partNumber,
                quantity: totalReservedNow,
                unitCode: req.unitCode,
              });
            }
            if (remainingNeed > EPS) {
              shortages.push({
                materialCode: req.part.partNumber,
                shortage: remainingNeed,
                unitCode: req.unitCode,
              });
            }
          }

          return {
            moNumber: mo.moNumber,
            reserved,
            shortages,
          };
        },
        { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 }
      );

      return { success: true, statusCode: 200, data: outcome };
    } catch (error: any) {
      if (attempt < maxRetries && isRetryableSerializationError(error)) {
        const backoffMs = Math.min(250, 20 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 25);
        await sleepMs(backoffMs);
        continue;
      }
      if (error instanceof InventoryPostingError) {
        return { success: false, statusCode: error.statusCode, errorCode: error.code, error: error.message };
      }
      return {
        success: false,
        statusCode: 500,
        errorCode: 'MRP_AUTO_RESERVE_FAILED',
        error: error instanceof Error ? error.message : 'خطا در رزرو خودکار مواد برای دستور کار',
      };
    }
  }

  return {
    success: false,
    statusCode: 409,
    errorCode: 'SERIALIZATION_RETRY_EXHAUSTED',
    error: 'رزرو خودکار مواد پس از چند تلاش متوالی متوقف شد.',
  };
}

/**
 * =========================================================================
 * P0-B.4: POSTGRESQL-AUTHORITATIVE READ PROJECTIONS
 * =========================================================================
 */
export async function queryDetailedStockBalancesFromDb(
  prisma: any,
  fallbackParts?: Part[]
): Promise<{
  balances: DetailedStockBalance[];
  metrics: InventoryDashboardMetrics;
  qcHolds: Record<string, any>;
}> {
  const [sbRows, activeParts, unpostedDocsCount, activeContractsCount, postedDocsCount] =
    await Promise.all([
      prisma.stockBalance.findMany({
        include: {
          part: { include: { unit: true, material: true } },
          warehouse: true,
          location: true,
          materialLot: { include: { material: true } },
          physicalCoil: { include: { material: true } },
        },
        orderBy: { updatedAt: 'desc' },
      }),
      typeof prisma.part?.findMany === 'function'
        ? prisma.part.findMany({
            where: { active: true },
            include: { unit: true, material: true },
          })
        : Promise.resolve([]),
      typeof prisma.inventoryDocument?.count === 'function'
        ? prisma.inventoryDocument.count({ where: { postingStatus: 'UNPOSTED' } })
        : Promise.resolve(0),
      typeof prisma.materialContract?.count === 'function'
        ? prisma.materialContract.count({ where: { status: 'ACTIVE' } })
        : Promise.resolve(0),
      typeof prisma.inventoryDocument?.count === 'function'
        ? prisma.inventoryDocument.count({ where: { postingStatus: 'POSTED' } })
        : typeof prisma.inventoryDocument?.findMany === 'function'
          ? prisma.inventoryDocument
              .findMany({ where: { postingStatus: 'POSTED' } })
              .then((rows: any[]) => (Array.isArray(rows) ? rows.length : 0))
          : Promise.resolve(0),
    ]);

  const qcHolds: Record<string, any> = {};
  const balances: DetailedStockBalance[] = (sbRows || []).map((sb: any) => {
    const rawQual = String(sb.qualityStatus || 'AVAILABLE');
    const qualityStatus = (rawQual === 'UNRESTRICTED' ? 'AVAILABLE' : rawQual) as StockQualityStatus;
    const isQuarantine = qualityStatus === 'QUARANTINE';
    const isBlocked =
      qualityStatus === 'QUALITY_BLOCKED' ||
      qualityStatus === 'REJECTED' ||
      rawQual === 'SCRAP';
    const isBlockedOrQuarantine = isQuarantine || isBlocked;

    const physicalQty = Number(sb.quantityOnHand || 0);
    const physicalKg = Number(sb.weightKgOnHand || 0);
    const reservedQty = Number(sb.quantityReserved || 0);
    const reservedKg = Number(sb.weightKgReserved || 0);
    const qualityInspectionQty = isQuarantine ? physicalQty : 0;
    const qualityInspectionKg = isQuarantine ? physicalKg : 0;
    const blockedQty = isBlocked ? physicalQty : 0;
    const blockedKg = isBlocked ? physicalKg : 0;
    const unrestrictedQty = isBlockedOrQuarantine ? 0 : physicalQty;
    const unrestrictedKg = isBlockedOrQuarantine ? 0 : physicalKg;
    const qualityBlockedQty = isBlockedOrQuarantine ? physicalQty : 0;
    const qualityBlockedKg = isBlockedOrQuarantine ? physicalKg : 0;
    const availableQty = isBlockedOrQuarantine
      ? 0
      : Math.max(0, Number(sb.quantityAvailable ?? physicalQty - reservedQty));
    const availableKg = isBlockedOrQuarantine
      ? 0
      : Math.max(0, Number(sb.weightKgAvailable ?? physicalKg - reservedKg));

    const ownership = (sb.ownership || 'COMPANY_OWNED') as StockOwnership;
    const isCompanyOwned = ownership === 'COMPANY_OWNED';
    const ownedQty = isCompanyOwned ? physicalQty : 0;
    const ownedKg = isCompanyOwned ? physicalKg : 0;
    const supplierOwnedQty = isCompanyOwned ? 0 : physicalQty;
    const supplierOwnedKg = isCompanyOwned ? 0 : physicalKg;

    const partCode = sb.part?.partNumber || sb.partId;
    const partName = sb.part?.name || partCode;
    const unit = (sb.part?.unit?.code || 'PCS') as 'KG' | 'PCS';
    const materialGrade =
      sb.physicalCoil?.material?.grade ||
      sb.materialLot?.material?.grade ||
      sb.part?.material?.grade ||
      undefined;
    const lotNumber =
      sb.materialLot?.lotNumber ||
      sb.physicalCoil?.coilPackNumber ||
      sb.physicalCoil?.coilId ||
      undefined;
    const heatNumber = sb.materialLot?.heatNumber || sb.physicalCoil?.heatNumber || undefined;
    const warehouseCode = sb.warehouse?.code || sb.warehouseId;
    const warehouseName = sb.warehouse?.name || warehouseCode;
    const locationCode = sb.location?.code || 'LOC-DEFAULT';
    const lastTxIso = (
      sb.lastTransactionAt instanceof Date
        ? sb.lastTransactionAt
        : sb.updatedAt instanceof Date
          ? sb.updatedAt
          : new Date()
    ).toISOString();

    if (isBlockedOrQuarantine && (physicalQty > EPS || physicalKg > EPS)) {
      qcHolds[sb.id] = {
        key: sb.id,
        partId: sb.partId,
        partCode,
        materialGrade,
        lotNumber,
        isHeld: true,
        heldQty: physicalQty,
        heldWeightKg: physicalKg,
        holdType: qualityStatus === 'QUALITY_BLOCKED' ? 'BLOCKED' : 'QUALITY_INSPECTION',
        updatedAt: lastTxIso,
      };
      if (sb.physicalCoilId) {
        qcHolds[sb.physicalCoilId] = qcHolds[sb.id];
      }
    }

    return {
      id: sb.id,
      partId: sb.partId,
      partCode,
      partName,
      category: sb.part?.category || 'RAW_MATERIAL',
      unit,
      materialGrade,
      warehouseId: warehouseCode,
      warehouseName,
      locationCode,
      ownership,
      lotNumber,
      heatNumber,
      materialLotId: sb.materialLotId || undefined,
      physicalCoilId: sb.physicalCoilId || undefined,
      contractId: sb.contractId || undefined,
      contractNumber: sb.contractNumber || undefined,
      qualityStatus,
      physicalQty: Math.round(physicalQty * 1000) / 1000,
      unrestrictedQty: Math.round(unrestrictedQty * 1000) / 1000,
      qualityInspectionQty: Math.round(qualityInspectionQty * 1000) / 1000,
      blockedQty: Math.round(blockedQty * 1000) / 1000,
      ownedQty: Math.round(ownedQty * 1000) / 1000,
      supplierOwnedQty: Math.round(supplierOwnedQty * 1000) / 1000,
      reservedQty: Math.round(reservedQty * 1000) / 1000,
      qualityBlockedQty: Math.round(qualityBlockedQty * 1000) / 1000,
      availableQty: Math.round(availableQty * 1000) / 1000,
      physicalKg: Math.round(physicalKg * 1000) / 1000,
      unrestrictedKg: Math.round(unrestrictedKg * 1000) / 1000,
      qualityInspectionKg: Math.round(qualityInspectionKg * 1000) / 1000,
      blockedKg: Math.round(blockedKg * 1000) / 1000,
      ownedKg: Math.round(ownedKg * 1000) / 1000,
      supplierOwnedKg: Math.round(supplierOwnedKg * 1000) / 1000,
      reservedKg: Math.round(reservedKg * 1000) / 1000,
      qualityBlockedKg: Math.round(qualityBlockedKg * 1000) / 1000,
      availableKg: Math.round(availableKg * 1000) / 1000,
      lastTransactionAt: lastTxIso,
      lastMovementDate: lastTxIso,
    };
  });

  // Include zero-balance catalog parts if they have no stock_balances row yet
  const partIdsWithRows = new Set(balances.map(b => b.partId));
  const partCodesWithRows = new Set(balances.map(b => b.partCode));
  const catalogList =
    activeParts && activeParts.length > 0
      ? activeParts.map((p: any) => ({
          id: p.id,
          code: p.partNumber,
          name: p.name,
          category: (p.category || 'RAW_MATERIAL') as 'RAW_MATERIAL' | 'WIP_PART' | 'FINISHED_GOOD',
          unit: (p.unit?.code || 'PCS') as 'KG' | 'PCS',
          materialGrade: p.material?.grade,
          minStock: Number(p.minStockLevel || 0),
        }))
      : (fallbackParts || []).map(p => ({
          id: p.id,
          code: p.code,
          name: p.name,
          category: p.category,
          unit: p.unit,
          materialGrade: p.materialGrade,
          minStock: p.minStock || 0,
        }));

  for (const cp of catalogList) {
    if (!partIdsWithRows.has(cp.id) && !partCodesWithRows.has(cp.code)) {
      const defaultWh = cp.category === 'FINISHED_GOOD' ? 'WH-FIN' : 'WH-RAW';
      const nowIso = new Date().toISOString();
      balances.push({
        id: `${cp.id}:::${defaultWh}:::LOC-DEFAULT:::COMPANY_OWNED:::NO_LOT:::AVAILABLE:::NO_CONTRACT`,
        partId: cp.id,
        partCode: cp.code,
        partName: cp.name,
        category: cp.category,
        unit: cp.unit,
        materialGrade: cp.materialGrade,
        warehouseId: defaultWh,
        warehouseName:
          cp.category === 'FINISHED_GOOD' ? 'انبار محصول نهایی' : 'انبار مرکزی مواد اولیه',
        locationCode: 'LOC-DEFAULT',
        ownership: 'COMPANY_OWNED',
        qualityStatus: 'AVAILABLE',
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
        lastTransactionAt: nowIso,
        lastMovementDate: nowIso,
      });
    }
  }

  let totalPhysicalKg = 0;
  let totalPhysicalPcs = 0;
  let totalAvailableKg = 0;
  let totalAvailablePcs = 0;
  let totalReservedKg = 0;
  let totalReservedPcs = 0;
  let totalQualityBlockedKg = 0;
  let totalQualityBlockedPcs = 0;
  let totalUnrestrictedKg = 0;
  let totalQualityInspectionKg = 0;
  let totalBlockedKg = 0;
  let totalSapcoConsignmentKg = 0;
  let totalCompanyOwnedKg = 0;
  const activeLots = new Set<string>();

  for (const b of balances) {
    if (b.lotNumber && b.physicalQty > 0) {
      activeLots.add(b.lotNumber);
    }
    totalUnrestrictedKg += b.unrestrictedKg;
    totalQualityInspectionKg += b.qualityInspectionKg;
    totalBlockedKg += b.blockedKg;
    if (b.unit === 'KG') {
      totalPhysicalKg += b.physicalQty;
      totalAvailableKg += b.availableQty;
      totalReservedKg += b.reservedQty;
      totalQualityBlockedKg += b.qualityBlockedQty;
    } else {
      totalPhysicalPcs += b.physicalQty;
      totalAvailablePcs += b.availableQty;
      totalReservedPcs += b.reservedQty;
      totalQualityBlockedPcs += b.qualityBlockedQty;
      totalPhysicalKg += b.physicalKg;
      totalAvailableKg += b.availableKg;
      totalReservedKg += b.reservedKg;
      totalQualityBlockedKg += b.qualityBlockedKg;
    }
    if (b.ownership === 'SAPCO_SUPPLIER_OWNED' || b.ownership === 'CUSTOMER_SUPPLIED') {
      totalSapcoConsignmentKg += b.physicalKg;
    } else {
      totalCompanyOwnedKg += b.physicalKg;
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
    draftDocumentsCount: Number(unpostedDocsCount || 0),
    postedDocumentsCount: Number(postedDocsCount || 0),
    activeContractsCount: Number(activeContractsCount || 0),
  };

  return { balances, metrics, qcHolds };
}

export async function queryStageInventorySummaryFromDb(
  prisma: any,
  fallbackParts?: Part[]
): Promise<{
  stageBalances: StageInventorySummary[];
  rawMaterialKg: number;
  totalWipPcs: number;
  totalWipKg: number;
  totalFinishedPcs: number;
  totalFinishedKg: number;
  totalScrapQty: number;
  totalScrapKg: number;
  overallScrapRate: number;
  partStockMap: Record<
    string,
    { totalQty: number; totalKg: number; unit: string; byStage: Record<string, number> }
  >;
}> {
  const { balances } = await queryDetailedStockBalancesFromDb(prisma, fallbackParts);
  const stageGroupMap = new Map<
    string,
    {
      stageId: string;
      partId: string;
      partCode: string;
      partName: string;
      unit: 'KG' | 'PCS';
      totalQty: number;
      reservedQty: number;
      usableQty: number;
      totalKg: number;
      scrapQty: number;
      lastActivityDate?: string;
    }
  >();

  const resolveStageForBalance = (b: DetailedStockBalance): string => {
    const wh = String(b.warehouseId || '').toUpperCase();
    if (wh.includes('FIN') || b.category === 'FINISHED_GOOD') return 'STAGE_FINISHED_STORE';
    if (wh.includes('QC') || b.qualityStatus === 'QUARANTINE') return 'STAGE_QC';
    if (wh.includes('WIP') || b.category === 'WIP_PART') return 'STAGE_STAMPING';
    return 'STAGE_RAW_STORE';
  };

  let rawMaterialKg = 0;
  let totalWipPcs = 0;
  let totalWipKg = 0;
  let totalFinishedPcs = 0;
  let totalFinishedKg = 0;
  let totalScrapQty = 0;
  let totalScrapKg = 0;
  const partStockMap: Record<
    string,
    { totalQty: number; totalKg: number; unit: string; byStage: Record<string, number> }
  > = {};

  for (const b of balances) {
    const stageId = resolveStageForBalance(b);
    const key = `${stageId}:::${b.partId}`;
    const existing = stageGroupMap.get(key) || {
      stageId,
      partId: b.partId,
      partCode: b.partCode,
      partName: b.partName,
      unit: b.unit,
      totalQty: 0,
      reservedQty: 0,
      usableQty: 0,
      totalKg: 0,
      scrapQty: 0,
      lastActivityDate: b.lastTransactionAt,
    };

    const isScrap =
      b.qualityStatus === 'REJECTED' ||
      String(b.qualityStatus) === 'SCRAP' ||
      String(b.warehouseId || '').toUpperCase().includes('SCRAP');

    existing.totalQty = Number((existing.totalQty + b.physicalQty).toFixed(3));
    existing.reservedQty = Number((existing.reservedQty + b.reservedQty).toFixed(3));
    existing.usableQty = Number((existing.usableQty + b.availableQty).toFixed(3));
    existing.totalKg = Number((existing.totalKg + b.physicalKg).toFixed(3));
    if (isScrap) {
      existing.scrapQty = Number((existing.scrapQty + b.physicalQty).toFixed(3));
      totalScrapQty += b.physicalQty;
      totalScrapKg += b.physicalKg;
    }
    if (b.lastTransactionAt && (!existing.lastActivityDate || b.lastTransactionAt > existing.lastActivityDate)) {
      existing.lastActivityDate = b.lastTransactionAt;
    }
    stageGroupMap.set(key, existing);

    if (stageId === 'STAGE_RAW_STORE') {
      rawMaterialKg += b.physicalKg;
    } else if (stageId === 'STAGE_FINISHED_STORE') {
      totalFinishedPcs += b.physicalQty;
      totalFinishedKg += b.physicalKg;
    } else {
      totalWipPcs += b.physicalQty;
      totalWipKg += b.physicalKg;
    }

    if (!partStockMap[b.partId]) {
      partStockMap[b.partId] = {
        totalQty: 0,
        totalKg: 0,
        unit: b.unit,
        byStage: {},
      };
    }
    partStockMap[b.partId].totalQty = Number((partStockMap[b.partId].totalQty + b.physicalQty).toFixed(3));
    partStockMap[b.partId].totalKg = Number((partStockMap[b.partId].totalKg + b.physicalKg).toFixed(3));
    partStockMap[b.partId].byStage[stageId] = Number(
      ((partStockMap[b.partId].byStage[stageId] || 0) + b.physicalQty).toFixed(3)
    );
  }

  const stageBalances: StageInventorySummary[] = Array.from(stageGroupMap.values()).map(entry => {
    const stageConfig = FACTORY_STAGES.find(s => s.id === entry.stageId);
    const stageName = stageConfig ? stageConfig.name : entry.stageId;
    const denom = entry.totalQty + entry.scrapQty;
    const scrapRate = denom > 0 ? Number(((entry.scrapQty / denom) * 100).toFixed(2)) : 0;
    return {
      stageId: entry.stageId,
      stageName,
      partId: entry.partId,
      partCode: entry.partCode,
      partName: entry.partName,
      unit: entry.unit,
      totalQty: Math.round(entry.totalQty * 100) / 100,
      reservedQty: Math.round(entry.reservedQty * 100) / 100,
      inTransitQty: 0,
      usableQty: Math.round(entry.usableQty * 100) / 100,
      totalKg: Math.round(entry.totalKg * 100) / 100,
      scrapQty: Math.round(entry.scrapQty * 100) / 100,
      scrapRatePercent: scrapRate,
      lastActivityDate: entry.lastActivityDate,
    };
  });

  const totalGoodPcs = totalFinishedPcs + totalWipPcs;
  const overallScrapRate =
    totalGoodPcs + totalScrapQty > 0
      ? Number(((totalScrapQty / (totalGoodPcs + totalScrapQty)) * 100).toFixed(2))
      : 0;

  return {
    stageBalances,
    rawMaterialKg: Math.round(rawMaterialKg * 100) / 100,
    totalWipPcs: Math.round(totalWipPcs),
    totalWipKg: Math.round(totalWipKg * 100) / 100,
    totalFinishedPcs: Math.round(totalFinishedPcs),
    totalFinishedKg: Math.round(totalFinishedKg * 100) / 100,
    totalScrapQty: Math.round(totalScrapQty),
    totalScrapKg: Math.round(totalScrapKg * 100) / 100,
    overallScrapRate,
    partStockMap,
  };
}

export async function queryInventoryTransactionsFromDb(
  prisma: any,
  filters?: {
    stageId?: string;
    partId?: string;
    voucherType?: string;
    search?: string;
  }
): Promise<InventoryTransaction[]> {
  if (typeof prisma.inventoryTransaction?.findMany !== 'function') {
    return [];
  }
  const dbTxs = await prisma.inventoryTransaction.findMany({
    include: {
      document: true,
      part: { include: { unit: true } },
      warehouse: true,
      location: true,
      materialLot: true,
      physicalCoil: true,
    },
    orderBy: { transactionDate: 'desc' },
  });

  const mapped: InventoryTransaction[] = (dbTxs || []).map((tx: any) => {
    const whCode = String(tx.warehouse?.code || tx.warehouseId || 'WH-RAW').toUpperCase();
    const partCategory = tx.part?.category || 'RAW_MATERIAL';
    const stageId =
      whCode.includes('FIN') || partCategory === 'FINISHED_GOOD'
        ? 'STAGE_FINISHED_STORE'
        : whCode.includes('QC')
          ? 'STAGE_QC'
          : whCode.includes('WIP') || partCategory === 'WIP_PART'
            ? 'STAGE_STAMPING'
            : 'STAGE_RAW_STORE';
    const stageConfig = FACTORY_STAGES.find(s => s.id === stageId);
    const stageName = stageConfig ? stageConfig.name : tx.warehouse?.name || stageId;

    let voucherType: InventoryTransaction['voucherType'] = 'ADJUSTMENT';
    const docType = String(tx.document?.documentType || '').toUpperCase();
    const txType = String(tx.transactionType || '').toUpperCase();
    if (docType === 'INITIAL_BALANCE') {
      voucherType = 'OPENING_BALANCE';
    } else if (txType === 'INBOUND') {
      voucherType = 'RECEIPT';
    } else if (txType === 'OUTBOUND') {
      voucherType = docType === 'DELIVERY' ? 'CUSTOMER_DELIVERY' : 'ISSUE';
    } else if (txType === 'TRANSFER_OUT') {
      voucherType = 'WIP_TRANSFER_DISPATCH';
    } else if (txType === 'TRANSFER_IN') {
      voucherType = 'WIP_TRANSFER_RECEIPT';
    } else {
      voucherType = 'ADJUSTMENT';
    }

    const unit = (tx.part?.unit?.code || 'KG') as 'KG' | 'PCS';
    const qty =
      voucherType === 'ADJUSTMENT'
        ? Number(tx.quantitySigned ?? tx.quantity ?? 0)
        : Math.abs(Number(tx.quantity ?? 0));
    const qtyKg =
      voucherType === 'ADJUSTMENT'
        ? Number(tx.weightKgSigned ?? tx.weightKg ?? 0)
        : Math.abs(Number(tx.weightKg ?? 0));
    const txDateIso = (
      tx.transactionDate instanceof Date
        ? tx.transactionDate
        : tx.createdAt instanceof Date
          ? tx.createdAt
          : new Date()
    ).toISOString();

    return {
      id: tx.id,
      voucherNumber: tx.transactionNumber || tx.document?.documentNumber || tx.id,
      voucherType,
      partId: tx.partId,
      partCode: tx.part?.partNumber || tx.partId,
      partName: tx.part?.name || tx.part?.partNumber || tx.partId,
      stageId,
      stageName,
      quantity: Math.round(qty * 1000) / 1000,
      unit,
      quantityKg: Math.round(qtyKg * 1000) / 1000,
      referenceDoc: tx.document?.referenceNumber || tx.document?.documentNumber || '',
      operatorName: 'اپراتور سیستم انبار',
      shift: 'MORNING',
      status: tx.postingStatus === 'POSTED' ? 'CONFIRMED' : 'CANCELLED',
      notes: tx.document?.notes || '',
      createdByUid: tx.createdByUserId || 'USR-INV',
      createdByName: 'کاربر انبار',
      isDemo: false,
      createdAt: txDateIso,
    };
  });

  let filtered = mapped;
  if (filters?.stageId && filters.stageId !== 'ALL') {
    filtered = filtered.filter(t => t.stageId === filters.stageId || t.targetStageId === filters.stageId);
  }
  if (filters?.partId && filters.partId !== 'ALL') {
    filtered = filtered.filter(t => t.partId === filters.partId || t.partCode === filters.partId);
  }
  if (filters?.voucherType && filters.voucherType !== 'ALL') {
    filtered = filtered.filter(t => t.voucherType === filters.voucherType);
  }
  if (filters?.search) {
    const q = String(filters.search).toLowerCase();
    filtered = filtered.filter(
      t =>
        t.voucherNumber.toLowerCase().includes(q) ||
        t.partName.toLowerCase().includes(q) ||
        t.partCode.toLowerCase().includes(q) ||
        (t.referenceDoc && t.referenceDoc.toLowerCase().includes(q)) ||
        (t.notes && t.notes.toLowerCase().includes(q))
    );
  }

  return filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function queryInventoryDocumentsFromDb(
  prisma: any,
  mapDbDocFn: (dbDoc: any, auditPostedDoc?: Partial<InventoryDocument> | null) => InventoryDocument
): Promise<InventoryDocument[]> {
  const dbDocs = await prisma.inventoryDocument.findMany({
    include: {
      warehouse: true,
      targetWarehouse: true,
      lines: {
        orderBy: { lineNumber: 'asc' },
        include: {
          part: true,
          unit: true,
          location: true,
          targetLocation: true,
          materialLot: true,
          physicalCoil: true,
        },
      },
      transactions: true,
    },
    orderBy: { documentDate: 'desc' },
  });

  if (!dbDocs || dbDocs.length === 0) return [];

  const audits =
    typeof prisma.auditLog?.findMany === 'function'
      ? await prisma.auditLog.findMany({
          where: {
            entityName: 'InventoryDocument',
            action: { in: ['DOCUMENT_POST', 'DOCUMENT_CREATE', 'DOCUMENT_REVERSE'] },
          },
          orderBy: { timestamp: 'desc' },
        })
      : [];

  const auditByDocId = new Map<string, Partial<InventoryDocument>>();
  for (const a of audits || []) {
    if (!a?.entityId || auditByDocId.has(a.entityId)) continue;
    const parsed = parseAuditNewValues(a.newValues);
    const snapshot = (parsed.postedDocument || parsed.draftDocument) as
      | Partial<InventoryDocument>
      | undefined;
    if (snapshot) {
      auditByDocId.set(a.entityId, snapshot);
    }
  }

  const docNumberById = new Map<string, string>();
  for (const d of dbDocs) {
    docNumberById.set(d.id, d.documentNumber);
  }

  return dbDocs.map((d: any) => {
    const auditSnapshot = auditByDocId.get(d.id) || null;
    const mapped = mapDbDocFn(d, auditSnapshot);
    if (d.reversalOfId && !mapped.reversalOfDocNumber) {
      const targetNum = docNumberById.get(d.reversalOfId) || auditSnapshot?.reversalOfDocNumber;
      if (targetNum) {
        mapped.reversalOfDocNumber = targetNum;
        mapped.reversalOfDocumentNumber = targetNum;
      }
    }
    return mapped;
  });
}

export async function querySingleInventoryDocumentFromDb(
  prisma: any,
  idOrNumber: string,
  mapDbDocFn: (dbDoc: any, auditPostedDoc?: Partial<InventoryDocument> | null) => InventoryDocument
): Promise<InventoryDocument | null> {
  const key = String(idOrNumber || '').trim();
  if (!key) return null;

  let dbDoc = await prisma.inventoryDocument.findFirst({
    where: { OR: [{ id: key }, { documentNumber: key }] },
    include: {
      warehouse: true,
      targetWarehouse: true,
      lines: {
        orderBy: { lineNumber: 'asc' },
        include: {
          part: true,
          unit: true,
          location: true,
          targetLocation: true,
          materialLot: true,
          physicalCoil: true,
        },
      },
      transactions: true,
    },
  });

  if (!dbDoc && typeof prisma.auditLog?.findMany === 'function') {
    const audits = await prisma.auditLog.findMany({
      where: {
        entityName: 'InventoryDocument',
        action: { in: ['DOCUMENT_POST', 'DOCUMENT_CREATE'] },
      },
      orderBy: { timestamp: 'desc' },
    });
    const matched = (audits || []).find(
      (a: any) => parseAuditNewValues(a?.newValues)?.sourceDraftId === key
    );
    if (matched?.entityId) {
      dbDoc = await prisma.inventoryDocument.findFirst({
        where: { id: matched.entityId },
        include: {
          warehouse: true,
          targetWarehouse: true,
          lines: {
            orderBy: { lineNumber: 'asc' },
            include: {
              part: true,
              unit: true,
              location: true,
              targetLocation: true,
              materialLot: true,
              physicalCoil: true,
            },
          },
          transactions: true,
        },
      });
    }
  }

  if (!dbDoc) return null;

  const audit =
    typeof prisma.auditLog?.findFirst === 'function'
      ? await prisma.auditLog.findFirst({
          where: {
            entityName: 'InventoryDocument',
            entityId: dbDoc.id,
            action: { in: ['DOCUMENT_POST', 'DOCUMENT_CREATE', 'DOCUMENT_REVERSE'] },
          },
          orderBy: { timestamp: 'desc' },
        })
      : null;
  const parsed = parseAuditNewValues(audit?.newValues);
  const auditSnapshot = (parsed.postedDocument || parsed.draftDocument) as
    | Partial<InventoryDocument>
    | undefined;

  return mapDbDocFn(dbDoc, auditSnapshot || null);
}

export async function queryContractsAndSapcoAccountFromDb(prisma: any): Promise<{
  contracts: SapcoContract[];
  ledgerEntries: SapcoContractLedgerEntry[];
}> {
  const [dbContracts, dbInvTransactions] = await Promise.all([
    prisma.materialContract.findMany({
      include: {
        supplierCustomer: true,
        material: true,
        contractCoilAllocations: {
          include: {
            coil: {
              include: {
                warehouse: true,
                material: true,
              },
            },
          },
        },
        transactions: {
          include: {
            lot: true,
          },
          orderBy: { receiptDate: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    typeof prisma.inventoryTransaction?.findMany === 'function'
      ? prisma.inventoryTransaction.findMany({
          where: {
            postingStatus: 'POSTED',
            contractId: { not: null },
          },
          include: {
            document: true,
            part: true,
            materialLot: true,
            physicalCoil: true,
          },
          orderBy: { transactionDate: 'asc' },
        })
      : Promise.resolve([]),
  ]);

  // Group authoritative InventoryTransaction rows by contractId
  const invTxsByContractId = new Map<string, any[]>();
  const invTxsByContractNum = new Map<string, any[]>();
  for (const tx of dbInvTransactions || []) {
    if (tx.ownership === 'COMPANY_OWNED') continue;
    // Skip internal warehouse transfer pairs (net zero on contract balance)
    if (tx.transactionType === 'TRANSFER_OUT' || tx.transactionType === 'TRANSFER_IN') continue;

    if (tx.contractId) {
      const list = invTxsByContractId.get(tx.contractId) || [];
      list.push(tx);
      invTxsByContractId.set(tx.contractId, list);
    }
    if (tx.contractNumber) {
      const list = invTxsByContractNum.get(tx.contractNumber) || [];
      list.push(tx);
      invTxsByContractNum.set(tx.contractNumber, list);
    }
  }

  const ledgerEntries: SapcoContractLedgerEntry[] = [];
  const contracts: SapcoContract[] = (dbContracts || []).map((c: any) => {
    const allocatedKg = Number(c.totalAllocatedWeightKg ?? c.totalQuotaKg ?? 0);
    const receivedFromField = Number(c.receivedWeightKg ?? c.usedQuotaKg ?? 0);
    let openingBalanceKg = 0;
    let totalReceivedKg = 0;
    let totalConsumedKg = 0;
    let netAdjustmentKg = 0;
    let runningBalance = 0;
    const associatedPartsSet = new Set<string>();

    const rawContractInvTxs =
      invTxsByContractId.get(c.id) || invTxsByContractNum.get(c.contractNumber) || [];

    // Filter out internal QM status transfer pairs (where ADJUSTMENT_NEG and ADJUSTMENT_POS
    // occur on the same documentLineId & contractId with equal weight, changing only qualityStatus)
    const lineAdjustmentSums = new Map<string, number>();
    for (const tx of rawContractInvTxs) {
      if (
        tx.documentLineId &&
        (tx.transactionType === 'ADJUSTMENT_POS' || tx.transactionType === 'ADJUSTMENT_NEG')
      ) {
        const signed = Number(
          tx.weightKgSigned ??
            (tx.transactionType === 'ADJUSTMENT_NEG' ? -Number(tx.weightKg || 0) : Number(tx.weightKg || 0))
        );
        lineAdjustmentSums.set(
          tx.documentLineId,
          round6((lineAdjustmentSums.get(tx.documentLineId) || 0) + signed)
        );
      }
    }

    const txById = new Map<string, any>();
    for (const tx of rawContractInvTxs) {
      if (tx.id) txById.set(tx.id, tx);
    }

    const isInternalOrWipTx = (tx: any): boolean => {
      const dType = String(tx.document?.documentType || '').toUpperCase();
      if (tx.productionReportId != null) return true;
      if (dType === 'WIP_TRANSFER') return true;
      if (tx.isReversal && tx.reversalOfTrxId) {
        const orig = txById.get(tx.reversalOfTrxId);
        if (orig && orig !== tx && isInternalOrWipTx(orig)) return true;
      }
      if (
        tx.transactionType === 'INBOUND' &&
        !tx.isReversal &&
        dType !== 'RETURN' &&
        dType !== 'RECEIPT' &&
        dType !== 'INITIAL_BALANCE' &&
        (dType === 'ISSUE' || tx.productionOperationId != null || tx.manufacturingOrderId != null)
      ) {
        return true;
      }
      if (
        tx.part?.category &&
        tx.part.category !== 'RAW_MATERIAL' &&
        !tx.physicalCoilId
      ) {
        return true;
      }
      if (
        tx.part?.category &&
        tx.part.category !== 'RAW_MATERIAL' &&
        (tx.productionOperationId != null || tx.manufacturingOrderId != null || tx.isReversal)
      ) {
        return true;
      }
      return false;
    };

    const contractInvTxs = rawContractInvTxs.filter((tx: any) => {
      if (isInternalOrWipTx(tx)) return false;
      if (
        tx.documentLineId &&
        (tx.transactionType === 'ADJUSTMENT_POS' || tx.transactionType === 'ADJUSTMENT_NEG')
      ) {
        const netLineDelta = Math.abs(lineAdjustmentSums.get(tx.documentLineId) || 0);
        const docNumber = String(tx.document?.documentNumber || '');
        if (netLineDelta <= EPS || docNumber.startsWith('QM-')) {
          return false;
        }
      }
      return true;
    });

    const hasInboundInvReceipt = contractInvTxs.some(
      (tx: any) =>
        tx.transactionType === 'INBOUND' &&
        !tx.isReversal &&
        String(tx.document?.documentType || '') !== 'RETURN'
    );

    // If the contract has MaterialContractTransaction rows (e.g. seeded or contract-allocated)
    // that were NOT posted as INBOUND InventoryTransactions, apply them first so receipts are never lost.
    if (!hasInboundInvReceipt && Array.isArray(c.transactions) && c.transactions.length > 0) {
      for (const mtx of c.transactions) {
        const w = Number(mtx.weightKg || 0);
        if (w <= EPS) continue;
        let operationType: SapcoContractLedgerEntry['operationType'] = 'ADJUSTMENT';
        let delta = 0;
        if (mtx.transactionType === 'RECEIPT') {
          operationType = 'RECEIPT';
          totalReceivedKg = round6(totalReceivedKg + w);
          delta = w;
        } else if (mtx.transactionType === 'CONSUMPTION') {
          operationType = 'CONSUMPTION';
          totalConsumedKg = round6(totalConsumedKg + w);
          delta = -w;
        } else if (mtx.transactionType === 'RETURN') {
          operationType = 'RETURN';
          totalReceivedKg = Math.max(0, round6(totalReceivedKg - w));
          delta = -w;
        }
        runningBalance = Number((runningBalance + delta).toFixed(3));
        ledgerEntries.push({
          id: mtx.id,
          contractId: c.id,
          contractNumber: c.contractNumber,
          documentNumber: mtx.waybillNumber || mtx.id,
          date: (mtx.receiptDate instanceof Date ? mtx.receiptDate : new Date()).toISOString(),
          waybillNumber: mtx.waybillNumber || undefined,
          lotNumber: mtx.lot?.lotNumber,
          heatNumber: mtx.lot?.heatNumber,
          operationType,
          weightKgSigned: delta,
          runningBalanceKg: runningBalance,
          notes: mtx.notes || undefined,
        });
      }
    }

    // Apply authoritative InventoryTransaction ledger rows (receipts, consumptions, reversals, remnant returns, reallocations)
    const sortedInvTxs = contractInvTxs
      .map((tx: any, idx: number) => ({ tx, idx }))
      .sort((a, b) => {
        const da = (a.tx.transactionDate instanceof Date ? a.tx.transactionDate : new Date(a.tx.transactionDate || 0)).getTime();
        const db = (b.tx.transactionDate instanceof Date ? b.tx.transactionDate : new Date(b.tx.transactionDate || 0)).getTime();
        if (da !== db) return da - db;
        return a.idx - b.idx;
      })
      .map(entry => entry.tx);

    for (const tx of sortedInvTxs) {
      const absKg = Math.abs(Number(tx.weightKg ?? tx.weightKgSigned ?? 0));
      if (absKg <= EPS) continue;
      const signedKg = Number(
        tx.weightKgSigned ??
          (tx.transactionType === 'OUTBOUND' || tx.transactionType === 'ADJUSTMENT_NEG' ? -absKg : absKg)
      );
      const docType = String(tx.document?.documentType || '').toUpperCase();
      const docNumber = String(tx.document?.documentNumber || tx.transactionNumber || tx.id);
      if (tx.part?.partNumber) {
        associatedPartsSet.add(tx.part.partNumber);
      }

      let operationType: SapcoContractLedgerEntry['operationType'] = 'ADJUSTMENT';
      let delta = signedKg;

      if (tx.transactionType === 'INBOUND') {
        if (tx.isReversal) {
          // Reversal of an OUTBOUND consumption issue -> restores contract balance and reduces totalConsumedKg
          operationType = 'ADJUSTMENT';
          delta = absKg;
          totalConsumedKg = Math.max(0, round6(totalConsumedKg - absKg));
        } else if (docType === 'INITIAL_BALANCE') {
          operationType = 'OPENING';
          delta = absKg;
          openingBalanceKg = round6(openingBalanceKg + absKg);
        } else if (docType === 'RETURN') {
          // Remnant return from production -> restores contract balance and reduces net consumption
          operationType = 'RETURN';
          delta = absKg;
          totalConsumedKg = Math.max(0, round6(totalConsumedKg - absKg));
        } else {
          operationType = 'RECEIPT';
          delta = absKg;
          totalReceivedKg = round6(totalReceivedKg + absKg);
        }
      } else if (tx.transactionType === 'OUTBOUND') {
        if (tx.isReversal) {
          // Reversal of an INBOUND receipt -> reduces totalReceivedKg and contract balance
          operationType = 'RETURN';
          delta = -absKg;
          totalReceivedKg = Math.max(0, round6(totalReceivedKg - absKg));
        } else {
          // Raw material issue / consumption against contract
          operationType = 'CONSUMPTION';
          delta = -absKg;
          totalConsumedKg = round6(totalConsumedKg + absKg);
        }
      } else if (tx.transactionType === 'ADJUSTMENT_POS' || tx.transactionType === 'ADJUSTMENT_NEG') {
        if (docNumber.startsWith('ADJ-COIL-ALLOC-')) {
          if (signedKg > 0) {
            operationType = 'RECEIPT';
            totalReceivedKg = round6(totalReceivedKg + absKg);
          } else {
            operationType = 'RETURN';
            totalReceivedKg = Math.max(0, round6(totalReceivedKg - absKg));
          }
        } else if (tx.isReversal && signedKg > 0) {
          // Reversal from MO rollback restoring raw material issued weight
          operationType = 'ADJUSTMENT';
          totalConsumedKg = Math.max(0, round6(totalConsumedKg - absKg));
        } else {
          operationType = 'ADJUSTMENT';
          netAdjustmentKg = round6(netAdjustmentKg + signedKg);
        }
        delta = signedKg;
      }

      runningBalance = Number((runningBalance + delta).toFixed(3));
      const txDateIso = (
        tx.transactionDate instanceof Date
          ? tx.transactionDate
          : tx.createdAt instanceof Date
            ? tx.createdAt
            : new Date()
      ).toISOString();

      ledgerEntries.push({
        id: tx.id,
        contractId: c.id,
        contractNumber: c.contractNumber,
        documentNumber: docNumber,
        date: txDateIso,
        waybillNumber: tx.document?.referenceNumber || undefined,
        partCode: tx.part?.partNumber || undefined,
        partName: tx.part?.name || undefined,
        lotNumber:
          tx.materialLot?.lotNumber ||
          tx.physicalCoil?.coilPackNumber ||
          tx.physicalCoil?.coilId ||
          undefined,
        heatNumber: tx.materialLot?.heatNumber || tx.physicalCoil?.heatNumber || undefined,
        operationType,
        weightKgSigned: Number(delta.toFixed(3)),
        runningBalanceKg: runningBalance,
        notes: tx.document?.notes || undefined,
      });
    }

    if (totalReceivedKg === 0 && openingBalanceKg === 0 && receivedFromField > 0) {
      totalReceivedKg = receivedFromField;
      runningBalance = Number((receivedFromField - totalConsumedKg + netAdjustmentKg).toFixed(3));
    }

    const closingBalanceKg = Number(
      (openingBalanceKg + totalReceivedKg - totalConsumedKg + netAdjustmentKg).toFixed(3)
    );

    const coils = (c.contractCoilAllocations || []).map((alloc: any) => ({
      coilId: alloc.coil?.coilId || alloc.coilId,
      coilPackNumber: alloc.coil?.coilPackNumber || alloc.coil?.coilId || alloc.coilId,
      allocatedWeightKg: Number(alloc.allocatedWeightKg || 0),
      remainingWeightKg: Number(alloc.coil?.remainingWeightKg ?? alloc.allocatedWeightKg ?? 0),
      thicknessMm: Number(alloc.coil?.thicknessMm || c.thicknessMm || 0),
      widthMm: Number(alloc.coil?.widthMm || 0),
      materialGrade: alloc.coil?.material?.grade || c.material?.grade || 'DC04',
      warehouseName: alloc.coil?.warehouse?.name || '',
    }));

    return {
      id: c.id,
      contractNumber: c.contractNumber,
      title: c.title,
      customerName: c.supplierCustomer?.name || 'شرکت ساپکو',
      contractType: 'HYBRID',
      ownership: 'SAPCO_SUPPLIER_OWNED',
      materialGrade: c.material?.grade || 'DC04',
      allocatedWeightKg: allocatedKg,
      openingBalanceKg: Number(openingBalanceKg.toFixed(3)),
      totalReceivedKg: Number(totalReceivedKg.toFixed(3)),
      totalConsumedKg: Number(totalConsumedKg.toFixed(3)),
      closingBalanceKg,
      associatedPartCodes: Array.from(associatedPartsSet),
      status: c.status || 'ACTIVE',
      startDate: (c.startDate instanceof Date ? c.startDate : new Date()).toISOString(),
      endDate: (c.endDate instanceof Date ? c.endDate : new Date()).toISOString(),
      notes: c.notes || undefined,
      coils,
    };
  });

  ledgerEntries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return { contracts, ledgerEntries };
}

/**
 * =========================================================================
 * P0-B.5: POSTGRESQL-AUTHORITATIVE COIL RETURN & CONTRACT REALLOCATION
 * =========================================================================
 */
export async function returnPhysicalCoilRemnantInDbTransaction(
  prisma: any,
  params: {
    coilIdOrCode: string;
    returnedWeightKg: number;
    varianceWeightKg?: number;
    documentNumber?: string;
    notes?: string;
    idempotencyKey?: string;
    user: { uid: string; displayName: string };
    maxSerializationRetries?: number;
  }
): Promise<{
  success: boolean;
  statusCode: number;
  errorCode?: string;
  error?: string;
  idempotentReplay?: boolean;
  dbDocumentId?: string;
  dbDocumentNumber?: string;
  coil?: any;
  returnDocument?: InventoryDocument;
}> {
  const coilRef = String(params.coilIdOrCode || '').trim();
  const retWeight = round6(Number(params.returnedWeightKg || 0));
  const varWeight = Math.max(0, round6(Number(params.varianceWeightKg || 0)));
  const idempotencyKey = (params.idempotencyKey || '').trim() || undefined;
  const maxRetries = Math.max(1, params.maxSerializationRetries ?? 5);

  if (!coilRef) {
    return {
      success: false,
      statusCode: 400,
      errorCode: 'INVALID_COIL_ID',
      error: 'شناسه کلاف برای ثبت برگشت از تولید الزامی است.',
    };
  }
  if (!Number.isFinite(retWeight) || retWeight <= 0) {
    return {
      success: false,
      statusCode: 400,
      errorCode: 'INVALID_RETURN_WEIGHT',
      error: 'وزن برگشتی کلاف از خط تولید باید بزرگتر از صفر باشد.',
    };
  }

  const requestFingerprint = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        op: 'COIL_RETURN',
        coilRef,
        retWeight,
        varWeight,
      })
    )
    .digest('hex');

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const now = new Date();
    const nowIso = now.toISOString();

    try {
      const txResult = await prisma.$transaction(
        async (tx: any) => {
          if (idempotencyKey) {
            const existingByKey = await tx.inventoryDocument.findUnique({
              where: { idempotencyKey },
              include: { lines: true },
            });
            if (existingByKey) {
              if (
                existingByKey.requestFingerprint &&
                existingByKey.requestFingerprint !== requestFingerprint
              ) {
                throw new InventoryPostingError(
                  'IDEMPOTENCY_PAYLOAD_MISMATCH',
                  409,
                  `کلید یکتای درخواست «${idempotencyKey}» قبلاً با مشخصات متفاوتی ثبت شده است.`
                );
              }
              const replayCoilId = existingByKey.lines?.[0]?.physicalCoilId;
              const replayCoil = replayCoilId
                ? await tx.physicalCoil.findFirst({
                    where: { id: replayCoilId },
                    include: {
                      material: true,
                      warehouse: true,
                      warehouseLocation: true,
                      contractAllocations: { include: { contract: true } },
                    },
                  })
                : null;
              return {
                idempotentReplay: true,
                dbDocumentId: existingByKey.id,
                dbDocumentNumber: existingByKey.documentNumber,
                dbCoil: replayCoil,
              };
            }
          }

          const dbCoil = await tx.physicalCoil.findFirst({
            where: {
              OR: [{ id: coilRef }, { coilId: coilRef }, { coilPackNumber: coilRef }],
            },
            include: {
              material: true,
              warehouse: true,
              warehouseLocation: true,
              contractAllocations: { include: { contract: true } },
            },
          });

          if (!dbCoil) {
            throw new InventoryPostingError(
              'COIL_NOT_FOUND',
              404,
              'کلاف فیزیکی مورد نظر در پایگاه داده یافت نشد.'
            );
          }

          if (round6(Number(dbCoil.remainingWeightKg) + retWeight) > round6(Number(dbCoil.originalWeightKg) + EPS)) {
            throw new InventoryPostingError(
              'RETURN_EXCEEDS_ORIGINAL_WEIGHT',
              422,
              `خطای تناقض وزنی: مجموع وزن فعلی انبار (${dbCoil.remainingWeightKg} kg) و وزن برگشتی (${retWeight} kg) نمی‌تواند از وزن اولیه کلاف (${dbCoil.originalWeightKg} kg) بیشتر باشد.`
            );
          }

          const allIssueRecords =
            typeof tx.coilIssueReturnRecord?.findMany === 'function'
              ? await tx.coilIssueReturnRecord.findMany({
                  where: { coilId: dbCoil.id, issuedWeightKg: { gt: 0 } },
                  orderBy: { issuedAt: 'asc' },
                })
              : [];

          const openIssues = allIssueRecords.filter(
            (r: any) => Number(r.outstandingWeightKg || 0) > EPS
          );
          const totalOutstandingKg = openIssues.reduce(
            (sum: number, r: any) => sum + Number(r.outstandingWeightKg || 0),
            0
          );
          const trackedNetIssuedKg = allIssueRecords.reduce(
            (sum: number, r: any) =>
              sum + Math.max(0, Number(r.issuedWeightKg || 0) - Number(r.returnedWeightKg || 0)),
            0
          );
          const implicitIssuedGapKg = Math.max(
            0,
            round6(Number(dbCoil.originalWeightKg) - Number(dbCoil.remainingWeightKg))
          );
          const untrackedGapKg = Math.max(0, round6(implicitIssuedGapKg - trackedNetIssuedKg));
          const effectiveOutstandingKg = round6(totalOutstandingKg + untrackedGapKg);

          if (retWeight + varWeight > effectiveOutstandingKg + EPS) {
            throw new InventoryPostingError(
              'RETURN_EXCEEDS_OUTSTANDING_ISSUE',
              422,
              `مجموع وزن برگشتی (${retWeight} kg) و پرت برش (${varWeight} kg) از کل وزن در جریان صدور کلاف (${Math.round(effectiveOutstandingKg * 100) / 100} kg) بیشتر است.`
            );
          }

          const dbUser = await resolveOrCreateAuditUser(tx, params.user);
          const lotOr: any[] = [
            { lotNumber: dbCoil.coilId },
            { lotNumber: dbCoil.coilPackNumber },
          ];
          if (dbCoil.materialLotId) {
            lotOr.unshift({ id: dbCoil.materialLotId });
          }
          const dbLot = await tx.materialLot.findFirst({ where: { OR: lotOr } });
          const kgUnit = await tx.unitOfMeasure.findUnique({ where: { code: 'KG' } });
          let dbPart = dbCoil.partId
            ? await tx.part.findUnique({ where: { id: dbCoil.partId } })
            : null;
          if (!dbPart) {
            dbPart = await tx.part.findFirst({
              where: { materialId: dbCoil.materialId, category: 'RAW_MATERIAL', active: true },
            });
          }
          if (!dbPart) {
            dbPart = await tx.part.findFirst({
              where: { category: 'RAW_MATERIAL', active: true },
            });
          }

          if (!dbPart || !kgUnit) {
            throw new InventoryPostingError(
              'MASTER_DATA_MISSING',
              422,
              'اطلاعات پایه قطعه ورق یا واحد اندازه‌گیری KG در دیتابیس یافت نشد.'
            );
          }

          // Reconcile open issue records with atomic outstandingWeightKg guard & collect exact contract/MO segments
          const allocContractMap = new Map<string, string>();
          for (const alloc of dbCoil.contractAllocations || []) {
            if (alloc.contractId && alloc.contract?.contractNumber) {
              allocContractMap.set(alloc.contractId, alloc.contract.contractNumber);
            }
          }

          let remToClear = round6(retWeight + varWeight);
          let remRetOnly = retWeight;
          let remVarOnly = varWeight;
          const rawReturnSegments: Array<{
            contractId: string | null;
            contractNumber: string | null;
            manufacturingOrderId: string | null;
            productionOperationId: string | null;
            weightKg: number;
          }> = [];

          for (const iss of openIssues) {
            if (remToClear <= EPS) break;
            const out = round6(Number(iss.outstandingWeightKg || 0));
            const applied = Math.min(out, remToClear);
            const appliedRet = Math.min(remRetOnly, applied);
            const appliedVar = Math.min(remVarOnly, round6(applied - appliedRet));
            const nextOut = Math.max(0, round6(out - applied));
            const nextStatus = nextOut <= EPS ? 'FULLY_RETURNED' : 'PARTIALLY_RETURNED';

            if (typeof tx.coilIssueReturnRecord?.updateMany === 'function') {
              const updatedIss = await tx.coilIssueReturnRecord.updateMany({
                where: {
                  id: iss.id,
                  outstandingWeightKg: { gte: round6(applied - EPS) },
                },
                data: {
                  returnedWeightKg: round6(Number(iss.returnedWeightKg || 0) + appliedRet),
                  varianceWeightKg: round6(Number(iss.varianceWeightKg || 0) + appliedVar),
                  outstandingWeightKg: nextOut,
                  status: nextStatus,
                  returnedAt: now,
                },
              });
              if (updatedIss.count !== 1) {
                throw new InventoryPostingError(
                  'ISSUE_RECORD_CONCURRENCY_CONFLICT',
                  409,
                  'تداخل همزمان در تسویه رکورد حواله کلاف رخ داد.'
                );
              }
            } else if (typeof tx.coilIssueReturnRecord?.update === 'function') {
              await tx.coilIssueReturnRecord.update({
                where: { id: iss.id },
                data: {
                  returnedWeightKg: round6(Number(iss.returnedWeightKg || 0) + appliedRet),
                  varianceWeightKg: round6(Number(iss.varianceWeightKg || 0) + appliedVar),
                  outstandingWeightKg: nextOut,
                  status: nextStatus,
                  returnedAt: now,
                },
              });
            }

            if (appliedRet > EPS) {
              const issContractId: string | null = iss.contractId ?? null;
              let issContractNum: string | null = issContractId ? allocContractMap.get(issContractId) ?? null : null;
              if (issContractId && !issContractNum) {
                const mc = await tx.materialContract.findUnique({ where: { id: issContractId } });
                issContractNum = mc?.contractNumber ?? null;
              }
              rawReturnSegments.push({
                contractId: issContractId,
                contractNumber: issContractNum,
                manufacturingOrderId: iss.manufacturingOrderId ?? null,
                productionOperationId: iss.productionOperationId ?? null,
                weightKg: appliedRet,
              });
            }

            remToClear = round6(remToClear - applied);
            remRetOnly = round6(remRetOnly - appliedRet);
            remVarOnly = round6(remVarOnly - appliedVar);
          }

          const docNum =
            (params.documentNumber || '').trim() ||
            `RET-${dbCoil.coilId}-${Date.now().toString().slice(-5)}-${attempt}`;

          if (typeof tx.coilIssueReturnRecord?.create === 'function') {
            await tx.coilIssueReturnRecord.create({
              data: {
                coilId: dbCoil.id,
                contractId: rawReturnSegments.length === 1 ? rawReturnSegments[0].contractId : null,
                partId: dbPart.id,
                manufacturingOrderId: openIssues[0]?.manufacturingOrderId ?? null,
                productionOperationId: openIssues[0]?.productionOperationId ?? null,
                documentNumber: docNum,
                issuedWeightKg: 0,
                consumedWeightKg: 0,
                returnedWeightKg: retWeight,
                outstandingWeightKg: 0,
                varianceWeightKg: varWeight,
                status: 'FULLY_RETURNED',
                issuedAt: now,
                returnedAt: now,
                notes: params.notes || `برگشت کلاف نیمه‌مصرف ${dbCoil.coilPackNumber} از خط تولید`,
              },
            });
          }

          const newCoilRemaining = round6(Number(dbCoil.remainingWeightKg) + retWeight);
          const remainingOpenCount =
            typeof tx.coilIssueReturnRecord?.count === 'function'
              ? await tx.coilIssueReturnRecord.count({
                  where: { coilId: dbCoil.id, outstandingWeightKg: { gt: 0 } },
                })
              : 0;
          const nextPhysicalStatus =
            remainingOpenCount === 0 && Math.abs(newCoilRemaining - Number(dbCoil.originalWeightKg)) <= EPS
              ? 'AVAILABLE'
              : 'PARTIALLY_ISSUED';

          // Atomic version-guarded update on PhysicalCoil
          const coilWhereGuard: Record<string, any> = { id: dbCoil.id };
          if (dbCoil.version != null) coilWhereGuard.version = dbCoil.version;
          const updatedCoil = await tx.physicalCoil.updateMany({
            where: coilWhereGuard,
            data: {
              remainingWeightKg: newCoilRemaining,
              physicalStatus: nextPhysicalStatus,
              version: { increment: 1 },
              updatedAt: now,
            },
          });
          if (updatedCoil.count !== 1) {
            throw new InventoryPostingError(
              'COIL_CONCURRENCY_CONFLICT',
              409,
              `تداخل همزمان در به‌روزرسانی وزن کلاف «${dbCoil.coilId}» رخ داد.`
            );
          }

          if (dbLot) {
            const nextLotWeight = round6(Number(dbLot.remainingWeightKg) + retWeight);
            const updatedLot = await tx.materialLot.updateMany({
              where: {
                id: dbLot.id,
                remainingWeightKg: dbLot.remainingWeightKg,
              },
              data: {
                remainingWeightKg: nextLotWeight,
                status: lotStatusForQuality(dbCoil.qualityStatus, nextLotWeight),
                updatedAt: now,
              },
            });
            if (updatedLot.count !== 1) {
              throw new InventoryPostingError(
                'LOT_CONCURRENCY_CONFLICT',
                409,
                `تداخل همزمان در به‌روزرسانی وزن بچ «${dbLot.lotNumber}» رخ داد.`
              );
            }
          }

          const primaryAlloc = dbCoil.contractAllocations?.[0];
          let primaryContractId: string | null = primaryAlloc?.contractId ?? dbLot?.supplierContractId ?? null;
          let primaryContractNum: string | null = primaryAlloc?.contract?.contractNumber ?? null;

          if (!primaryContractId) {
            const existingCoilSbWithContract = await tx.stockBalance.findFirst({
              where: {
                physicalCoilId: dbCoil.id,
                contractId: { not: null },
              },
            });
            if (existingCoilSbWithContract?.contractId) {
              primaryContractId = existingCoilSbWithContract.contractId;
              primaryContractNum = existingCoilSbWithContract.contractNumber ?? null;
            }
          }
          if (primaryContractId && !primaryContractNum) {
            const matchedContract = await tx.materialContract.findUnique({
              where: { id: primaryContractId },
            });
            primaryContractNum = matchedContract?.contractNumber ?? null;
          }

          if (remRetOnly > EPS || rawReturnSegments.length === 0) {
            const residualRet = rawReturnSegments.length === 0 ? retWeight : remRetOnly;
            if (residualRet > EPS) {
              rawReturnSegments.push({
                contractId: primaryContractId,
                contractNumber: primaryContractNum,
                manufacturingOrderId: openIssues[0]?.manufacturingOrderId ?? null,
                productionOperationId: openIssues[0]?.productionOperationId ?? null,
                weightKg: residualRet,
              });
            }
          }

          // Consolidate return segments by (contractId, manufacturingOrderId, productionOperationId)
          const consolidatedSegmentsMap = new Map<
            string,
            {
              contractId: string | null;
              contractNumber: string | null;
              manufacturingOrderId: string | null;
              productionOperationId: string | null;
              weightKg: number;
            }
          >();
          for (const seg of rawReturnSegments) {
            const resolvedCId = seg.contractId ?? primaryContractId;
            const resolvedCNum =
              seg.contractNumber ?? (resolvedCId === primaryContractId ? primaryContractNum : null);
            const k = `${resolvedCId || ''}|${seg.manufacturingOrderId || ''}|${seg.productionOperationId || ''}`;
            const prev = consolidatedSegmentsMap.get(k);
            if (prev) {
              prev.weightKg = round6(prev.weightKg + seg.weightKg);
            } else {
              consolidatedSegmentsMap.set(k, {
                contractId: resolvedCId,
                contractNumber: resolvedCNum,
                manufacturingOrderId: seg.manufacturingOrderId,
                productionOperationId: seg.productionOperationId,
                weightKg: seg.weightKg,
              });
            }
          }
          const returnSegments = Array.from(consolidatedSegmentsMap.values());

          const dbDoc = await tx.inventoryDocument.create({
            data: {
              documentNumber: docNum,
              documentType: 'RETURN',
              documentDate: now,
              documentStatus: 'CONFIRMED',
              postingStatus: 'POSTED',
              warehouseId: dbCoil.warehouseId,
              referenceNumber: openIssues[0]?.documentNumber || dbCoil.coilId,
              createdByUserId: dbUser.id,
              postedByUserId: dbUser.id,
              postedAt: now,
              idempotencyKey,
              requestFingerprint,
              notes: params.notes || `برگشت کلاف نیمه‌مصرف ${dbCoil.coilPackNumber} از خط تولید به انبار`,
            },
          });

          const returnedDocLines: InventoryDocumentLine[] = [];
          for (let segIdx = 0; segIdx < returnSegments.length; segIdx++) {
            const seg = returnSegments[segIdx];
            const existingBalance = await tx.stockBalance.findFirst({
              where: {
                partId: dbPart.id,
                warehouseId: dbCoil.warehouseId,
                locationId: dbCoil.warehouseLocationId ?? null,
                materialLotId: dbLot?.id ?? null,
                physicalCoilId: dbCoil.id,
                ownership: dbCoil.ownership,
                contractId: seg.contractId,
                qualityStatus: dbCoil.qualityStatus,
              },
            });

            const nextQtyOnHand = round6((existingBalance ? Number(existingBalance.quantityOnHand) : 0) + seg.weightKg);
            const nextQtyAvail = round6((existingBalance ? Number(existingBalance.quantityAvailable) : 0) + seg.weightKg);
            const nextKgOnHand = round6((existingBalance ? Number(existingBalance.weightKgOnHand) : 0) + seg.weightKg);
            const nextKgAvail = round6((existingBalance ? Number(existingBalance.weightKgAvailable) : 0) + seg.weightKg);

            if (existingBalance) {
              const sbWhere: Record<string, any> = { id: existingBalance.id };
              if (existingBalance.version != null) sbWhere.version = existingBalance.version;
              const updatedSb = await tx.stockBalance.updateMany({
                where: sbWhere,
                data: {
                  quantityOnHand: nextQtyOnHand,
                  quantityAvailable: nextQtyAvail,
                  weightKgOnHand: nextKgOnHand,
                  weightKgAvailable: nextKgAvail,
                  lastTransactionAt: now,
                  version: { increment: 1 },
                },
              });
              if (updatedSb.count !== 1) {
                throw new InventoryPostingError(
                  'STOCK_CONCURRENCY_CONFLICT',
                  409,
                  'تداخل همزمان در به‌روزرسانی موجودی انبار کلاف رخ داد.'
                );
              }
            } else {
              await tx.stockBalance.create({
                data: {
                  partId: dbPart.id,
                  warehouseId: dbCoil.warehouseId,
                  locationId: dbCoil.warehouseLocationId ?? null,
                  materialLotId: dbLot?.id ?? null,
                  physicalCoilId: dbCoil.id,
                  ownership: dbCoil.ownership,
                  contractId: seg.contractId,
                  contractNumber: seg.contractNumber,
                  qualityStatus: dbCoil.qualityStatus,
                  quantityOnHand: nextQtyOnHand,
                  quantityReserved: 0,
                  quantityAvailable: nextQtyAvail,
                  weightKgOnHand: nextKgOnHand,
                  weightKgReserved: 0,
                  weightKgAvailable: nextKgAvail,
                  lastTransactionAt: now,
                  version: 1,
                },
              });
            }

            const lineNumber = segIdx + 1;
            const dbLine = await tx.inventoryDocumentLine.create({
              data: {
                documentId: dbDoc.id,
                lineNumber,
                partId: dbPart.id,
                materialLotId: dbLot?.id ?? null,
                physicalCoilId: dbCoil.id,
                productionOperationId: seg.productionOperationId,
                locationId: dbCoil.warehouseLocationId ?? null,
                quantity: seg.weightKg,
                unitId: kgUnit.id,
                weightKg: seg.weightKg,
                ownership: dbCoil.ownership,
                contractId: seg.contractId,
                contractNumber: seg.contractNumber,
                qualityStatus: dbCoil.qualityStatus,
                notes: `برگشت ورق از خط تولید - کلاف ${dbCoil.coilPackNumber}${seg.contractNumber ? ` (قرارداد ${seg.contractNumber})` : ''}`,
              },
            });

            await tx.inventoryTransaction.create({
              data: {
                transactionNumber: `${docNum}-L${String(lineNumber).padStart(3, '0')}`,
                documentId: dbDoc.id,
                documentLineId: dbLine.id,
                partId: dbPart.id,
                materialLotId: dbLot?.id ?? null,
                physicalCoilId: dbCoil.id,
                productionOperationId: seg.productionOperationId,
                manufacturingOrderId: seg.manufacturingOrderId,
                warehouseId: dbCoil.warehouseId,
                locationId: dbCoil.warehouseLocationId ?? null,
                transactionType: 'INBOUND',
                quantity: seg.weightKg,
                quantitySigned: seg.weightKg,
                unitId: kgUnit.id,
                weightKg: seg.weightKg,
                weightKgSigned: seg.weightKg,
                ownership: dbCoil.ownership,
                contractId: seg.contractId,
                contractNumber: seg.contractNumber,
                qualityStatus: dbCoil.qualityStatus,
                balanceAfter: nextQtyOnHand,
                balanceKgAfter: nextKgOnHand,
                transactionDate: now,
                postingStatus: 'POSTED',
                isReversal: false,
                createdByUserId: dbUser.id,
              },
            });

            returnedDocLines.push({
              id: dbLine.id,
              documentId: dbDoc.id,
              lineNumber,
              partId: dbPart.id,
              partCode: dbPart.partNumber,
              partName: dbPart.name,
              lotNumber: dbCoil.coilPackNumber,
              heatNumber: dbCoil.heatNumber,
              physicalCoilId: dbCoil.id,
              coilId: dbCoil.coilId,
              coilPackNumber: dbCoil.coilPackNumber,
              ownership: dbCoil.ownership as StockOwnership,
              contractId: seg.contractId || undefined,
              contractNumber: seg.contractNumber || undefined,
              locationCode: dbCoil.warehouseLocation?.code || 'HALL-A-R01',
              quantity: seg.weightKg,
              unit: 'KG',
              quantityKg: seg.weightKg,
              qualityStatus: dbCoil.qualityStatus as StockQualityStatus,
              notes: `برگشت ورق از خط تولید - کلاف ${dbCoil.coilPackNumber}`,
            });
          }

          await tx.auditLog.create({
            data: {
              userId: dbUser.id,
              action: 'COIL_REMNANT_RETURN',
              entityName: 'PhysicalCoil',
              entityId: dbCoil.id,
              oldValues: { remainingWeightKg: Number(dbCoil.remainingWeightKg) },
              newValues: {
                remainingWeightKg: newCoilRemaining,
                returnedWeightKg: retWeight,
                varianceWeightKg: varWeight,
                documentNumber: docNum,
                segments: returnSegments,
              },
            },
          });

          const refreshedCoil = await tx.physicalCoil.findFirst({
            where: { id: dbCoil.id },
            include: {
              material: true,
              warehouse: true,
              warehouseLocation: true,
              contractAllocations: { include: { contract: true } },
            },
          });

          const returnDocument: InventoryDocument = {
            id: dbDoc.id,
            documentNumber: docNum,
            documentType: 'RECEIPT_RAW_MATERIAL',
            documentDate: nowIso,
            documentStatus: 'CONFIRMED',
            postingStatus: 'POSTED',
            warehouseId: dbCoil.warehouse?.code || 'WH-RAW',
            warehouseName: dbCoil.warehouse?.name || 'انبار مرکزی مواد اولیه',
            ownership: dbCoil.ownership as StockOwnership,
            contractId: returnSegments[0]?.contractId || primaryContractId || undefined,
            contractNumber: returnSegments[0]?.contractNumber || primaryContractNum || undefined,
            referenceType: 'MANUFACTURING_ORDER',
            referenceNumber: openIssues[0]?.documentNumber || dbCoil.coilId,
            auditNote: params.notes || `برگشت کلاف نیمه‌مصرف ${dbCoil.coilPackNumber} از خط تولید به انبار`,
            lines: returnedDocLines,
            totalQuantity: retWeight,
            totalWeightKg: retWeight,
            createdByUid: params.user.uid,
            createdByName: params.user.displayName,
            postedByUid: params.user.uid,
            postedByName: params.user.displayName,
            createdAt: nowIso,
            updatedAt: nowIso,
            postedAt: nowIso,
          };

          return {
            idempotentReplay: false,
            dbDocumentId: dbDoc.id,
            dbDocumentNumber: docNum,
            dbCoil: refreshedCoil || dbCoil,
            returnDocument,
          };
        },
        {
          isolationLevel: 'Serializable',
          maxWait: 10000,
          timeout: 30000,
        }
      );

      return {
        success: true,
        statusCode: 200,
        idempotentReplay: txResult.idempotentReplay,
        dbDocumentId: txResult.dbDocumentId,
        dbDocumentNumber: txResult.dbDocumentNumber,
        coil: txResult.dbCoil,
        returnDocument: txResult.returnDocument,
      };
    } catch (error: any) {
      if (attempt < maxRetries && isRetryableSerializationError(error)) {
        const backoffMs = Math.min(250, 20 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 25);
        await sleepMs(backoffMs);
        continue;
      }
      if (error instanceof InventoryPostingError) {
        return {
          success: false,
          statusCode: error.statusCode,
          errorCode: error.code,
          error: error.message,
        };
      }
      return {
        success: false,
        statusCode: 500,
        errorCode: 'COIL_RETURN_DB_FAILED',
        error: error instanceof Error ? error.message : 'خطا در ثبت برگشت کلاف در PostgreSQL',
      };
    }
  }

  return {
    success: false,
    statusCode: 409,
    errorCode: 'SERIALIZATION_RETRY_EXHAUSTED',
    error: 'تراکنش برگشت کلاف به دلیل تداخل همزمانی متوقف شد.',
  };
}

export async function reallocatePhysicalCoilContractsInDbTransaction(
  prisma: any,
  params: {
    coilIdOrCode: string;
    mode: 'REPLACE_ALL' | 'UPSERT_SINGLE_CONTRACT';
    allocations?: Array<{
      contractId: string;
      contractNumber?: string;
      allocatedWeightKg: number;
      notes?: string;
    }>;
    singleContractId?: string;
    singleAllocatedWeightKg?: number;
    singleNotes?: string;
    idempotencyKey?: string;
    user: { uid: string; displayName: string };
    maxSerializationRetries?: number;
  }
): Promise<{
  success: boolean;
  statusCode: number;
  errorCode?: string;
  error?: string;
  idempotentReplay?: boolean;
  dbDocumentId?: string;
  dbDocumentNumber?: string;
  coil?: any;
  normalizedAllocations?: CoilContractAllocationSegment[];
}> {
  const coilRef = String(params.coilIdOrCode || '').trim();
  const idempotencyKey = (params.idempotencyKey || '').trim() || undefined;
  const maxRetries = Math.max(1, params.maxSerializationRetries ?? 5);

  if (!coilRef) {
    return {
      success: false,
      statusCode: 400,
      errorCode: 'INVALID_COIL_ID',
      error: 'شناسه کلاف برای تخصیص قرارداد الزامی است.',
    };
  }

  const requestFingerprint = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        op: 'COIL_CONTRACT_ALLOCATE',
        coilRef,
        mode: params.mode,
        allocations: (params.allocations || []).map(a => ({
          contractId: String(a.contractId || '').trim(),
          allocatedWeightKg: round6(Number(a.allocatedWeightKg || 0)),
        })),
        singleContractId: params.singleContractId ? String(params.singleContractId).trim() : null,
        singleAllocatedWeightKg:
          params.singleAllocatedWeightKg !== undefined
            ? round6(Number(params.singleAllocatedWeightKg))
            : null,
      })
    )
    .digest('hex');

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const now = new Date();

    try {
      const txResult = await prisma.$transaction(
        async (tx: any) => {
          if (idempotencyKey) {
            const existingByKey = await tx.inventoryDocument.findUnique({
              where: { idempotencyKey },
              include: { lines: true },
            });
            if (existingByKey) {
              if (
                existingByKey.requestFingerprint &&
                existingByKey.requestFingerprint !== requestFingerprint
              ) {
                throw new InventoryPostingError(
                  'IDEMPOTENCY_PAYLOAD_MISMATCH',
                  409,
                  `کلید یکتای درخواست «${idempotencyKey}» قبلاً با مشخصات تخصیص متفاوتی ثبت شده است.`
                );
              }
              const replayCoilId = existingByKey.lines?.[0]?.physicalCoilId;
              const replayCoil = replayCoilId
                ? await tx.physicalCoil.findFirst({
                    where: { id: replayCoilId },
                    include: {
                      material: true,
                      warehouse: true,
                      warehouseLocation: true,
                      contractAllocations: { include: { contract: true } },
                    },
                  })
                : null;
              return {
                idempotentReplay: true,
                dbDocumentId: existingByKey.id,
                dbDocumentNumber: existingByKey.documentNumber,
                dbCoil: replayCoil,
                normalizedAllocations: (replayCoil?.contractAllocations || []).map((a: any) => ({
                  id: a.id,
                  coilId: replayCoil.id,
                  contractId: a.contractId,
                  contractNumber: a.contract?.contractNumber || a.contractId,
                  allocatedWeightKg: Number(a.allocatedWeightKg || 0),
                  consumedWeightKg: 0,
                  remainingAllocatedKg: Number(a.allocatedWeightKg || 0),
                  allocatedAt: (a.allocationDate instanceof Date ? a.allocationDate : now).toISOString(),
                  notes: a.notes || undefined,
                })),
              };
            }
          }

          const dbCoil = await tx.physicalCoil.findFirst({
            where: {
              OR: [{ id: coilRef }, { coilId: coilRef }, { coilPackNumber: coilRef }],
            },
            include: {
              material: true,
              warehouse: true,
              warehouseLocation: true,
              contractAllocations: { include: { contract: true } },
            },
          });

          if (!dbCoil) {
            throw new InventoryPostingError(
              'COIL_NOT_FOUND',
              404,
              'کلاف فیزیکی مورد نظر در پایگاه داده یافت نشد.'
            );
          }

          const issuedRecordsCount =
            typeof tx.coilIssueReturnRecord?.count === 'function'
              ? await tx.coilIssueReturnRecord.count({
                  where: { coilId: dbCoil.id, issuedWeightKg: { gt: 0 } },
                })
              : 0;
          if (
            Math.abs(Number(dbCoil.remainingWeightKg) - Number(dbCoil.originalWeightKg)) > EPS ||
            issuedRecordsCount > 0
          ) {
            throw new InventoryPostingError(
              'COIL_ALREADY_ISSUED',
              422,
              'تغییر تخصیص قرارداد فقط برای کلاف‌های دست‌نخورده (بدون سابقه مصرف یا صدور به تولید) مجاز است.'
            );
          }

          const existingCoilBalances = await tx.stockBalance.findMany({
            where: { physicalCoilId: dbCoil.id },
          });
          const hasReservedOrBlocked = existingCoilBalances.some(
            (sb: any) =>
              Number(sb.quantityReserved) > EPS ||
              Number(sb.weightKgReserved) > EPS ||
              (sb.qualityStatus !== 'AVAILABLE' &&
                sb.qualityStatus !== 'UNRESTRICTED' &&
                Number(sb.weightKgOnHand) > EPS)
          );
          if (hasReservedOrBlocked) {
            throw new InventoryPostingError(
              'COIL_RESERVED_OR_QC_HELD',
              422,
              'کلاف دارای موجودی رزرو شده یا در وضعیت قرنطینه/مسدود کیفی است؛ ابتدا رزرو یا قرنطینه را تعیین تکلیف کنید.'
            );
          }

          // Build target allocations list according to mode
          let rawTargetAllocations: Array<{
            contractId: string;
            contractNumber?: string;
            allocatedWeightKg: number;
            notes?: string;
          }> = [];

          if (params.mode === 'UPSERT_SINGLE_CONTRACT') {
            const targetContractRef = String(params.singleContractId || '').trim();
            const weight = round6(Number(params.singleAllocatedWeightKg || 0));
            if (!targetContractRef || !Number.isFinite(weight) || weight <= 0) {
              throw new InventoryPostingError(
                'INVALID_ALLOCATION_INPUT',
                400,
                'شناسه قرارداد و وزن تخصیصی معتبر الزامی است.'
              );
            }
            const targetContract = await tx.materialContract.findFirst({
              where: {
                OR: [{ id: targetContractRef }, { contractNumber: targetContractRef }],
              },
            });
            if (!targetContract) {
              throw new InventoryPostingError(
                'CONTRACT_NOT_FOUND',
                404,
                'قرارداد مورد نظر در پایگاه داده یافت نشد.'
              );
            }

            const existingOtherAllocs = (dbCoil.contractAllocations || [])
              .filter((a: any) => a.contractId !== targetContract.id)
              .map((a: any) => ({
                contractId: a.contractId,
                contractNumber: a.contract?.contractNumber || a.contractId,
                allocatedWeightKg: round6(Number(a.allocatedWeightKg || 0)),
                notes: a.notes || undefined,
              }));
            rawTargetAllocations = [
              ...existingOtherAllocs,
              {
                contractId: targetContract.id,
                contractNumber: targetContract.contractNumber,
                allocatedWeightKg: weight,
                notes: params.singleNotes || `تخصیص کلاف به قرارداد ${targetContract.contractNumber}`,
              },
            ];
          } else {
            rawTargetAllocations = Array.isArray(params.allocations) ? params.allocations : [];
          }

          // Validate & resolve all target contracts
          const resolvedTargets: Array<{
            contract: any;
            allocatedWeightKg: number;
            notes?: string;
          }> = [];
          let totalNewAllocatedKg = 0;

          for (const item of rawTargetAllocations) {
            const cRef = String(item?.contractId || item?.contractNumber || '').trim();
            const w = round6(Number(item?.allocatedWeightKg || 0));
            if (!cRef || !Number.isFinite(w) || w <= 0) {
              throw new InventoryPostingError(
                'INVALID_ALLOCATION_SEGMENT',
                400,
                'هر ردیف تخصیص باید دارای قرارداد معتبر و وزن بزرگتر از صفر باشد.'
              );
            }
            const dbContract = await tx.materialContract.findFirst({
              where: {
                OR: [{ id: cRef }, { contractNumber: cRef }],
              },
            });
            if (!dbContract) {
              throw new InventoryPostingError(
                'CONTRACT_NOT_FOUND',
                404,
                `قرارداد «${cRef}» در پایگاه داده یافت نشد.`
              );
            }
            if (dbContract.status && dbContract.status !== 'ACTIVE') {
              throw new InventoryPostingError(
                'CONTRACT_NOT_ACTIVE',
                409,
                `قرارداد «${dbContract.contractNumber}» در وضعیت فعال (ACTIVE) قرار ندارد.`
              );
            }
            totalNewAllocatedKg = round6(totalNewAllocatedKg + w);
            resolvedTargets.push({
              contract: dbContract,
              allocatedWeightKg: w,
              notes: item.notes,
            });
          }

          if (totalNewAllocatedKg > round6(Number(dbCoil.remainingWeightKg) + EPS)) {
            throw new InventoryPostingError(
              'ALLOCATION_EXCEEDS_COIL_WEIGHT',
              422,
              `مجموع وزن تخصیص‌یافته (${totalNewAllocatedKg} kg) نمی‌تواند از مانده وزن کلاف (${dbCoil.remainingWeightKg} kg) بیشتر باشد.`
            );
          }

          const dbUser = await resolveOrCreateAuditUser(tx, params.user);
          const dbLot = await tx.materialLot.findFirst({
            where: {
              OR: [{ lotNumber: dbCoil.coilId }, { lotNumber: dbCoil.coilPackNumber }],
            },
          });
          const kgUnit = await tx.unitOfMeasure.findUnique({ where: { code: 'KG' } });
          let dbPart = await tx.part.findFirst({
            where: { materialId: dbCoil.materialId, category: 'RAW_MATERIAL', active: true },
          });
          if (!dbPart) {
            dbPart = await tx.part.findFirst({
              where: { category: 'RAW_MATERIAL', active: true },
            });
          }
          if (!dbPart || !kgUnit) {
            throw new InventoryPostingError(
              'MASTER_DATA_MISSING',
              422,
              'اطلاعات پایه قطعه ورق یا واحد اندازه‌گیری KG در دیتابیس یافت نشد.'
            );
          }

          // 1. Atomically decrement receivedWeightKg on previous contract allocations
          const oldContractSources =
            Array.isArray(dbCoil.contractAllocations) && dbCoil.contractAllocations.length > 0
              ? dbCoil.contractAllocations.map((a: any) => ({
                  contractId: a.contractId,
                  allocatedWeightKg: round6(Number(a.allocatedWeightKg || 0)),
                }))
              : existingCoilBalances
                  .filter((sb: any) => Boolean(sb.contractId) && Number(sb.weightKgOnHand || 0) > EPS)
                  .map((sb: any) => ({
                    contractId: sb.contractId,
                    allocatedWeightKg: round6(Number(sb.weightKgOnHand || 0)),
                  }));

          for (const oldAlloc of oldContractSources) {
            const oldW = round6(Number(oldAlloc.allocatedWeightKg || 0));
            if (oldW <= EPS) continue;
            const oldContract = await tx.materialContract.findUnique({
              where: { id: oldAlloc.contractId },
            });
            if (oldContract) {
              const currentRec = round6(Number(oldContract.receivedWeightKg || 0));
              const nextRec = Math.max(0, round6(currentRec - oldW));
              const updatedOldContract = await tx.materialContract.updateMany({
                where: {
                  id: oldContract.id,
                  receivedWeightKg: oldContract.receivedWeightKg,
                },
                data: {
                  receivedWeightKg: nextRec,
                  updatedAt: now,
                },
              });
              if (updatedOldContract.count !== 1) {
                throw new InventoryPostingError(
                  'CONTRACT_QUOTA_CONCURRENCY_CONFLICT',
                  409,
                  `تداخل همزمان هنگام بازگردانی سهمیه قرارداد «${oldContract.contractNumber}» رخ داد.`
                );
              }
              if (dbLot && typeof tx.materialContractTransaction?.create === 'function') {
                await tx.materialContractTransaction.create({
                  data: {
                    contractId: oldContract.id,
                    lotId: dbLot.id,
                    transactionType: 'RETURN',
                    weightKg: oldW,
                    receiptDate: now,
                    notes: `اصلاح/حذف تخصیص کلاف ${dbCoil.coilId}`,
                  },
                });
              }
            }
          }

          // 2. Atomically increment receivedWeightKg on new contract allocations with quota guard
          for (const target of resolvedTargets) {
            const newW = target.allocatedWeightKg;
            const freshContract = await tx.materialContract.findUnique({
              where: { id: target.contract.id },
            });
            if (!freshContract) {
              throw new InventoryPostingError(
                'CONTRACT_NOT_FOUND',
                404,
                `قرارداد «${target.contract.contractNumber}» یافت نشد.`
              );
            }
            const maxQuota = round6(Number(freshContract.totalAllocatedWeightKg || 0));
            const currentRec = round6(Number(freshContract.receivedWeightKg || 0));
            if (maxQuota > 0 && round6(currentRec + newW) > round6(maxQuota + EPS)) {
              throw new InventoryPostingError(
                'CONTRACT_QUOTA_EXCEEDED',
                422,
                `تخصیص ${newW} کیلوگرم به قرارداد «${freshContract.contractNumber}» از سقف سهمیه قرارداد (${maxQuota} kg، مصرف‌شده: ${currentRec} kg) فراتر می‌رود.`
              );
            }

            const whereQuotaGuard: Record<string, any> = {
              id: freshContract.id,
              receivedWeightKg: freshContract.receivedWeightKg,
            };
            if (maxQuota > 0) {
              whereQuotaGuard.AND = [{ receivedWeightKg: { lte: round6(maxQuota - newW + EPS) } }];
            }

            const updatedNewContract = await tx.materialContract.updateMany({
              where: whereQuotaGuard,
              data: {
                receivedWeightKg: round6(currentRec + newW),
                updatedAt: now,
              },
            });
            if (updatedNewContract.count !== 1) {
              throw new InventoryPostingError(
                'CONTRACT_QUOTA_EXCEEDED',
                409,
                `سهمیه قرارداد «${freshContract.contractNumber}» کافی نیست یا تداخل همزمان رخ داده است.`
              );
            }

            if (dbLot && typeof tx.materialContractTransaction?.create === 'function') {
              await tx.materialContractTransaction.create({
                data: {
                  contractId: freshContract.id,
                  lotId: dbLot.id,
                  transactionType: 'RECEIPT',
                  weightKg: newW,
                  receiptDate: now,
                  notes: target.notes || `تخصیص کلاف ${dbCoil.coilId} به قرارداد ${freshContract.contractNumber}`,
                },
              });
            }
          }

          // 3. Atomic version guard on PhysicalCoil
          const updatedCoilGuard = await tx.physicalCoil.updateMany({
            where: {
              id: dbCoil.id,
              version: dbCoil.version ?? 1,
            },
            data: {
              version: { increment: 1 },
              updatedAt: now,
            },
          });
          if (updatedCoilGuard.count !== 1) {
            throw new InventoryPostingError(
              'COIL_CONCURRENCY_CONFLICT',
              409,
              `تداخل همزمان هنگام تغییر تخصیص کلاف «${dbCoil.coilId}» رخ داد.`
            );
          }

          // 4. Replace ContractCoilAllocation rows
          await tx.contractCoilAllocation.deleteMany({ where: { coilId: dbCoil.id } });
          const normalizedAllocations: CoilContractAllocationSegment[] = [];
          for (let idx = 0; idx < resolvedTargets.length; idx++) {
            const target = resolvedTargets[idx];
            const createdAlloc = await tx.contractCoilAllocation.create({
              data: {
                contractId: target.contract.id,
                coilId: dbCoil.id,
                allocatedWeightKg: target.allocatedWeightKg,
                allocationDate: now,
                notes: target.notes || null,
              },
            });
            normalizedAllocations.push({
              id: createdAlloc?.id || `CCA-${Date.now()}-${idx + 1}`,
              coilId: dbCoil.id,
              contractId: target.contract.id,
              contractNumber: target.contract.contractNumber,
              allocatedWeightKg: target.allocatedWeightKg,
              consumedWeightKg: 0,
              remainingAllocatedKg: target.allocatedWeightKg,
              allocatedAt: now.toISOString(),
              notes: target.notes,
            });
          }

          // 5. Re-segment StockBalance rows and write immutable COUNT_ADJUSTMENT ledger entries
          const adjDocNum = `ADJ-COIL-ALLOC-${dbCoil.coilId}-${Date.now().toString().slice(-6)}-${attempt}`;
          const adjDoc = await tx.inventoryDocument.create({
            data: {
              documentNumber: adjDocNum,
              documentType: 'COUNT_ADJUSTMENT',
              documentDate: now,
              documentStatus: 'CONFIRMED',
              postingStatus: 'POSTED',
              warehouseId: dbCoil.warehouseId,
              referenceNumber: dbCoil.coilId,
              createdByUserId: dbUser.id,
              postedByUserId: dbUser.id,
              postedAt: now,
              idempotencyKey,
              requestFingerprint,
              notes: `بازتخصیص قرارداد کلاف فیزیکی ${dbCoil.coilId}`,
            },
          });

          let txSeq = 0;
          for (const oldSb of existingCoilBalances) {
            const oldKg = round6(Number(oldSb.weightKgOnHand || 0));
            if (oldKg <= EPS) continue;
            txSeq += 1;
            const outLine = await tx.inventoryDocumentLine.create({
              data: {
                documentId: adjDoc.id,
                lineNumber: txSeq,
                partId: oldSb.partId,
                materialLotId: oldSb.materialLotId,
                physicalCoilId: dbCoil.id,
                locationId: oldSb.locationId,
                quantity: oldKg,
                unitId: kgUnit.id,
                weightKg: oldKg,
                ownership: oldSb.ownership,
                contractId: oldSb.contractId,
                contractNumber: oldSb.contractNumber,
                qualityStatus: oldSb.qualityStatus,
                notes: `خروج از تخصیص قبلی کلاف ${dbCoil.coilId}`,
              },
            });
            await tx.inventoryTransaction.create({
              data: {
                transactionNumber: `${adjDocNum}-OUT-${String(txSeq).padStart(3, '0')}`,
                documentId: adjDoc.id,
                documentLineId: outLine.id,
                partId: oldSb.partId,
                materialLotId: oldSb.materialLotId,
                physicalCoilId: dbCoil.id,
                warehouseId: oldSb.warehouseId,
                locationId: oldSb.locationId,
                transactionType: 'ADJUSTMENT_NEG',
                quantity: oldKg,
                quantitySigned: -oldKg,
                unitId: kgUnit.id,
                weightKg: oldKg,
                weightKgSigned: -oldKg,
                ownership: oldSb.ownership,
                contractId: oldSb.contractId,
                contractNumber: oldSb.contractNumber,
                qualityStatus: oldSb.qualityStatus,
                balanceAfter: 0,
                balanceKgAfter: 0,
                transactionDate: now,
                postingStatus: 'POSTED',
                isReversal: false,
                createdByUserId: dbUser.id,
              },
            });
          }

          await tx.stockBalance.deleteMany({ where: { physicalCoilId: dbCoil.id } });

          const targetSegments: Array<{
            contractId: string | null;
            contractNumber: string | null;
            weightKg: number;
          }> = [];
          for (const alloc of normalizedAllocations) {
            if (alloc.allocatedWeightKg > EPS) {
              targetSegments.push({
                contractId: alloc.contractId,
                contractNumber: alloc.contractNumber,
                weightKg: round6(alloc.allocatedWeightKg),
              });
            }
          }
          const unallocatedRemKg = round6(Number(dbCoil.remainingWeightKg) - totalNewAllocatedKg);
          if (unallocatedRemKg > EPS || targetSegments.length === 0) {
            targetSegments.push({
              contractId: null,
              contractNumber: null,
              weightKg:
                targetSegments.length === 0
                  ? round6(Number(dbCoil.remainingWeightKg))
                  : unallocatedRemKg,
            });
          }

          for (const seg of targetSegments) {
            if (seg.weightKg <= EPS) continue;
            await tx.stockBalance.create({
              data: {
                partId: dbPart.id,
                warehouseId: dbCoil.warehouseId,
                locationId: dbCoil.warehouseLocationId ?? null,
                materialLotId: dbLot?.id ?? null,
                physicalCoilId: dbCoil.id,
                ownership: dbCoil.ownership,
                contractId: seg.contractId,
                contractNumber: seg.contractNumber,
                qualityStatus: dbCoil.qualityStatus,
                quantityOnHand: seg.weightKg,
                quantityReserved: 0,
                quantityAvailable: seg.weightKg,
                weightKgOnHand: seg.weightKg,
                weightKgReserved: 0,
                weightKgAvailable: seg.weightKg,
                lastTransactionAt: now,
                version: 1,
              },
            });

            txSeq += 1;
            const inLine = await tx.inventoryDocumentLine.create({
              data: {
                documentId: adjDoc.id,
                lineNumber: txSeq,
                partId: dbPart.id,
                materialLotId: dbLot?.id ?? null,
                physicalCoilId: dbCoil.id,
                locationId: dbCoil.warehouseLocationId ?? null,
                quantity: seg.weightKg,
                unitId: kgUnit.id,
                weightKg: seg.weightKg,
                ownership: dbCoil.ownership,
                contractId: seg.contractId,
                contractNumber: seg.contractNumber,
                qualityStatus: dbCoil.qualityStatus,
                notes: `ورود به تخصیص جدید کلاف ${dbCoil.coilId}`,
              },
            });
            await tx.inventoryTransaction.create({
              data: {
                transactionNumber: `${adjDocNum}-IN-${String(txSeq).padStart(3, '0')}`,
                documentId: adjDoc.id,
                documentLineId: inLine.id,
                partId: dbPart.id,
                materialLotId: dbLot?.id ?? null,
                physicalCoilId: dbCoil.id,
                warehouseId: dbCoil.warehouseId,
                locationId: dbCoil.warehouseLocationId ?? null,
                transactionType: 'ADJUSTMENT_POS',
                quantity: seg.weightKg,
                quantitySigned: seg.weightKg,
                unitId: kgUnit.id,
                weightKg: seg.weightKg,
                weightKgSigned: seg.weightKg,
                ownership: dbCoil.ownership,
                contractId: seg.contractId,
                contractNumber: seg.contractNumber,
                qualityStatus: dbCoil.qualityStatus,
                balanceAfter: seg.weightKg,
                balanceKgAfter: seg.weightKg,
                transactionDate: now,
                postingStatus: 'POSTED',
                isReversal: false,
                createdByUserId: dbUser.id,
              },
            });
          }

          await tx.auditLog.create({
            data: {
              userId: dbUser.id,
              action: 'COIL_CONTRACT_ALLOCATION',
              entityName: 'PhysicalCoil',
              entityId: dbCoil.id,
              oldValues: {
                allocations: (dbCoil.contractAllocations || []).map((a: any) => ({
                  contractId: a.contractId,
                  allocatedWeightKg: Number(a.allocatedWeightKg || 0),
                })),
              },
              newValues: {
                allocations: normalizedAllocations,
                documentNumber: adjDocNum,
              },
            },
          });

          const refreshedCoil = await tx.physicalCoil.findFirst({
            where: { id: dbCoil.id },
            include: {
              material: true,
              warehouse: true,
              warehouseLocation: true,
              contractAllocations: { include: { contract: true } },
            },
          });

          return {
            idempotentReplay: false,
            dbDocumentId: adjDoc.id,
            dbDocumentNumber: adjDocNum,
            dbCoil: refreshedCoil || dbCoil,
            normalizedAllocations,
          };
        },
        {
          isolationLevel: 'Serializable',
          maxWait: 10000,
          timeout: 30000,
        }
      );

      return {
        success: true,
        statusCode: 200,
        idempotentReplay: txResult.idempotentReplay,
        dbDocumentId: txResult.dbDocumentId,
        dbDocumentNumber: txResult.dbDocumentNumber,
        coil: txResult.dbCoil,
        normalizedAllocations: txResult.normalizedAllocations,
      };
    } catch (error: any) {
      if (attempt < maxRetries && isRetryableSerializationError(error)) {
        const backoffMs = Math.min(250, 20 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 25);
        await sleepMs(backoffMs);
        continue;
      }
      if (error instanceof InventoryPostingError) {
        return {
          success: false,
          statusCode: error.statusCode,
          errorCode: error.code,
          error: error.message,
        };
      }
      return {
        success: false,
        statusCode: 500,
        errorCode: 'COIL_ALLOCATION_DB_FAILED',
        error: error instanceof Error ? error.message : 'خطا در تخصیص قرارداد کلاف در PostgreSQL',
      };
    }
  }

  return {
    success: false,
    statusCode: 409,
    errorCode: 'SERIALIZATION_RETRY_EXHAUSTED',
    error: 'تراکنش تخصیص قرارداد کلاف به دلیل تداخل همزمانی متوقف شد.',
  };
}

function defaultProcessLocationCode(processType?: string | null): string {
  switch (String(processType || '').toUpperCase()) {
    case 'SHEARING':
      return 'LOC-RAW-B1';
    case 'BLANKING':
      return 'LOC-WIP-BLANK';
    case 'DRAWING':
      return 'LOC-WIP-DRAWN';
    case 'PUNCH_FORM':
      return 'LOC-WIP-PUNCH';
    case 'BENDING':
      return 'LOC-WIP-BEND';
    case 'SPOT_WELD':
      return 'LOC-WELD-IN';
    case 'CO2_WELD':
      return 'LOC-WELD-OUT';
    case 'PAINT':
      return 'LOC-PAINT-IN';
    case 'ASSEMBLY':
      return 'LOC-FIN-P1';
    default:
      return 'LOC-WIP-BLANK';
  }
}

export interface IssueCoilRequestItem {
  manufacturingOrderRef: string | null;
  operationRef: string | null;
  partRef: string | null;
  issuedWeightKg: number;
  varianceWeightKg: number;
  initialInputQuantityPcs: number;
  wipManufacturingOrderId: string | null;
  notes?: string;
}

export interface IssuePhysicalCoilResult {
  success: boolean;
  statusCode: number;
  errorCode?: string;
  error?: string;
  duplicate?: boolean;
  message?: string;
  coil?: any;
  documentNumber?: string;
  issueRecords?: any[];
  issueRecord?: any;
  wipInput?: {
    manufacturingOrderId: string;
    productionOperationId: string;
    quantityPcs: number;
  } | null;
}

/**
 * Hardened PostgreSQL-authoritative Physical Coil Issue -> MO Operation / WIP Input.
 * - Enforces Serializable isolation with retry loop on P2034/40001/40P01
 * - Enforces idempotency via issueRequestKey & issueRequestFingerprint (409 on mismatch)
 * - Unlocks/consumes target MO's active reservations cleanly before StockBalance deduction
 * - Uses version CAS on StockBalance, PhysicalCoil, ProductionOperation, and ManufacturingOrder
 * - Updates MaterialLot status (IN_USE / CONSUMED) and emits POSTED ledger transactions
 */
export async function issuePhysicalCoilInDbTransaction(
  prisma: any,
  params: {
    coilIdOrCode: string;
    issueRequestKey: string;
    requested: IssueCoilRequestItem[];
    createdByUserId?: string;
    maxSerializationRetries?: number;
  }
): Promise<IssuePhysicalCoilResult> {
  const coilRef = String(params.coilIdOrCode || '').trim();
  const issueRequestKey = String(params.issueRequestKey || '').trim();
  const requested = params.requested || [];
  const maxRetries = Math.max(1, params.maxSerializationRetries ?? 5);

  if (!coilRef) {
    return { success: false, statusCode: 400, errorCode: 'INVALID_COIL_ID', error: 'شناسه کلاف الزامی است.' };
  }
  if (issueRequestKey.length < 8 || issueRequestKey.length > 160) {
    return {
      success: false,
      statusCode: 400,
      errorCode: 'INVALID_ISSUE_REQUEST_KEY',
      error: 'شناسه یکتای درخواست حواله (Idempotency-Key) معتبر نیست؛ فرم را تازه باز کنید.',
    };
  }
  if (
    requested.length === 0 ||
    requested.some(
      row =>
        !Number.isFinite(row.issuedWeightKg) ||
        row.issuedWeightKg <= 0 ||
        !Number.isFinite(row.varianceWeightKg) ||
        row.varianceWeightKg < 0 ||
        row.varianceWeightKg > row.issuedWeightKg
    )
  ) {
    return {
      success: false,
      statusCode: 400,
      errorCode: 'INVALID_ISSUE_WEIGHT',
      error: 'وزن حواله باید مثبت و وزن ضایعات باید بین صفر و وزن حواله باشد.',
    };
  }
  for (const request of requested) {
    if (request.initialInputQuantityPcs) {
      if (
        requested.length !== 1 ||
        !Number.isInteger(request.initialInputQuantityPcs) ||
        request.initialInputQuantityPcs <= 0
      ) {
        return {
          success: false,
          statusCode: 400,
          errorCode: 'INVALID_INITIAL_INPUT_PCS',
          error: 'تعداد ورودی مرحله اول باید عددی صحیح و مثبت و برای یک دستور ساخت باشد.',
        };
      }
    }
  }

  const totalIssuedKg = round6(requested.reduce((sum, row) => sum + row.issuedWeightKg, 0));
  const issueRequestFingerprint = JSON.stringify({
    coilId: coilRef,
    requested: requested.map(row => ({
      manufacturingOrderRef: row.manufacturingOrderRef,
      operationRef: row.operationRef,
      partRef: row.partRef,
      issuedWeightKg: row.issuedWeightKg,
      varianceWeightKg: row.varianceWeightKg,
      initialInputQuantityPcs: row.initialInputQuantityPcs,
      wipManufacturingOrderId: row.wipManufacturingOrderId,
    })),
  });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const issuedAt = new Date();
    try {
      const persisted = await prisma.$transaction(
        async (tx: any) => {
          const existingRequest = await tx.inventoryDocument.findUnique({
            where: { issueRequestKey },
            include: { coilIssueReturnRecords: true },
          });
          if (existingRequest) {
            if (existingRequest.issueRequestFingerprint !== issueRequestFingerprint) {
              throw new InventoryPostingError(
                'IDEMPOTENCY_PAYLOAD_MISMATCH',
                409,
                'این شناسه درخواست قبلاً برای اطلاعات متفاوتی استفاده شده است؛ فرم را ببندید و حواله جدیدی آغاز کنید.'
              );
            }
            const existingCoil = await tx.physicalCoil.findFirst({
              where: {
                OR: [
                  ...(existingRequest.coilIssueReturnRecords?.[0]?.coilId
                    ? [{ id: existingRequest.coilIssueReturnRecords[0].coilId }]
                    : []),
                  { id: coilRef },
                  { coilId: coilRef },
                ],
              },
            });
            if (!existingCoil) {
              throw new InventoryPostingError(
                'COIL_NOT_FOUND',
                409,
                'سند حواله تکراری یافت شد اما کلاف متناظر موجود نیست.'
              );
            }
            return {
              duplicate: true,
              coil: existingCoil,
              records: existingRequest.coilIssueReturnRecords || [],
              documentNumber: existingRequest.documentNumber,
              entries: [],
              wipInput: null,
            };
          }

          const dbCoil = await tx.physicalCoil.findFirst({
            where: { OR: [{ id: coilRef }, { coilId: coilRef }] },
          });
          if (!dbCoil) {
            throw new InventoryPostingError(
              'COIL_NOT_FOUND',
              404,
              'کلاف در پایگاه داده عملیاتی وجود ندارد؛ ابتدا رسید کلاف را ثبت کنید.'
            );
          }
          if (
            ['QUARANTINE', 'QUALITY_BLOCKED', 'REJECTED'].includes(dbCoil.qualityStatus) ||
            dbCoil.physicalStatus === 'BLOCKED'
          ) {
            throw new InventoryPostingError(
              'COIL_QUALITY_BLOCKED',
              409,
              'کلاف قرنطینه یا مسدود است و امکان صدور ندارد.'
            );
          }
          const availableKg = round6(Number(dbCoil.remainingWeightKg));
          if (totalIssuedKg > availableKg + EPS) {
            throw new InventoryPostingError(
              'INSUFFICIENT_COIL_WEIGHT',
              409,
              `وزن حواله (${totalIssuedKg}) از مانده کلاف (${availableKg}) بیشتر است.`
            );
          }

          const dbPart = dbCoil.partId
            ? await tx.part.findUnique({ where: { id: dbCoil.partId } })
            : await tx.part.findFirst({
                where: { materialId: dbCoil.materialId, category: 'RAW_MATERIAL', active: true },
              });
          if (!dbPart) {
            throw new InventoryPostingError('PART_NOT_FOUND', 404, 'کالای پایه کلاف در PostgreSQL یافت نشد.');
          }

          let user: any = null;
          if (params.createdByUserId) {
            user = await tx.user.findFirst({
              where: {
                OR: [
                  { id: params.createdByUserId },
                  { username: params.createdByUserId },
                  { personnelCode: params.createdByUserId },
                ],
              },
            });
          }
          if (!user) user = await tx.user.findFirst({ where: { active: true } });
          if (!user) {
            user = await resolveOrCreateAuditUser(tx, {
              uid: params.createdByUserId || 'USR-OP-01',
              displayName: 'اپراتور صدور کلاف',
            });
          }

          // Pre-resolve MOs and operations + unlock MO-bound active reservations on this coil BEFORE checking available balances
          const resolvedItems: Array<{
            request: IssueCoilRequestItem;
            mo: any;
            targetPart: any;
            operation: any;
            firstOperationId: string | null;
            wipPostingContext: any;
          }> = [];

          for (const request of requested) {
            if (!request.manufacturingOrderRef) {
              throw new InventoryPostingError(
                'MO_REQUIRED',
                400,
                'برای صدور کلاف، شماره دستور ساخت (MO) الزامی است.'
              );
            }
            let mo = await tx.manufacturingOrder.findFirst({
              where: {
                OR: [{ id: request.manufacturingOrderRef }, { moNumber: request.manufacturingOrderRef }],
              },
            });
            if (!mo && typeof tx.wipManufacturingOrderLink?.findUnique === 'function') {
              const link = await tx.wipManufacturingOrderLink.findUnique({
                where: { wipManufacturingOrderId: request.manufacturingOrderRef },
                select: { manufacturingOrderId: true },
              });
              if (link) {
                mo = await tx.manufacturingOrder.findUnique({ where: { id: link.manufacturingOrderId } });
              }
            }
            if (!mo) {
              throw new InventoryPostingError(
                'MO_NOT_FOUND',
                404,
                `دستور ساخت «${request.manufacturingOrderRef}» در PostgreSQL یافت نشد؛ حواله بدون اتصال به دستور ساخت مجاز نیست.`
              );
            }
            if (mo.status === 'CANCELLED' || mo.status === 'CLOSED' || mo.status === 'COMPLETED') {
              throw new InventoryPostingError(
                'MO_NOT_MUTABLE',
                409,
                `دستور ساخت «${mo.moNumber}» در وضعیت «${mo.status}» قرار دارد و صدور کلاف برای آن مجاز نیست.`
              );
            }

            const targetPart = request.partRef
              ? await tx.part.findFirst({
                  where: { OR: [{ id: request.partRef }, { partNumber: request.partRef }] },
                })
              : await tx.part.findUnique({ where: { id: mo.partId } });
            if (!targetPart) {
              throw new InventoryPostingError(
                'TARGET_PART_NOT_FOUND',
                404,
                `قطعه مقصد دستور ساخت ${mo.moNumber} در اطلاعات پایه یافت نشد.`
              );
            }
            if (!request.operationRef) {
              throw new InventoryPostingError(
                'OPERATION_REQUIRED',
                400,
                `برای ردیابی مرحله مصرف، انتخاب عملیات تولید دستور ${mo.moNumber} الزامی است.`
              );
            }

            const operation = await tx.productionOperation.findUnique({
              where: { id: request.operationRef },
              include: { operation: true },
            });
            if (!operation || operation.manufacturingOrderId !== mo.id) {
              throw new InventoryPostingError(
                'OPERATION_NOT_FOUND',
                404,
                `عملیات «${request.operationRef}» به دستور ساخت ${mo.moNumber} تعلق ندارد یا یافت نشد.`
              );
            }

            const firstOperationForOrder = await tx.productionOperation.findFirst({
              where: { manufacturingOrderId: mo.id },
              orderBy: [{ sequence: 'asc' }, { stepNumber: 'asc' }],
              select: { id: true },
            });
            if (
              requested.length === 1 &&
              firstOperationForOrder?.id === operation.id &&
              (!Number.isFinite(request.initialInputQuantityPcs) || request.initialInputQuantityPcs <= 0)
            ) {
              throw new InventoryPostingError(
                'INITIAL_INPUT_REQUIRED',
                400,
                'برای صدور ورق به اولین مرحله، تعداد قطعات ورودی را بررسی و تأیید کنید.'
              );
            }
            if (request.initialInputQuantityPcs > 0 && firstOperationForOrder?.id !== operation.id) {
              throw new InventoryPostingError(
                'INVALID_INITIAL_INPUT_OPERATION',
                400,
                'تعداد ورودی اولیه فقط برای اولین عملیات مجاز است.'
              );
            }
            if (operation.status === 'COMPLETED' || operation.status === 'SKIPPED') {
              throw new InventoryPostingError(
                'OPERATION_NOT_MUTABLE',
                409,
                `عملیات ${operation.stepNumber} دستور ساخت ${mo.moNumber} خاتمه یافته یا رد شده است و دریافت مواد برای آن مجاز نیست.`
              );
            }
            if (operation.status === 'PENDING' && firstOperationForOrder?.id !== operation.id) {
              throw new InventoryPostingError(
                'OPERATION_WAITING_PREDECESSOR',
                409,
                'عملیات انتخاب‌شده هنوز منتظر تکمیل مرحله قبلی است.'
              );
            }

            let wipPostingContext: any = null;
            if (request.initialInputQuantityPcs > 0) {
              let opLocation = operation.locationId
                ? await tx.warehouseLocation.findUnique({
                    where: { id: operation.locationId },
                    include: { warehouse: true },
                  })
                : null;
              if (!opLocation) {
                const locCode =
                  operation.warehouseLocationCode ||
                  defaultProcessLocationCode(operation.operation?.processType);
                opLocation = await tx.warehouseLocation.findFirst({
                  where: { OR: [{ id: locCode }, { code: locCode }], active: true },
                  include: { warehouse: true },
                });
              }
              if (!opLocation) {
                throw new InventoryPostingError(
                  'OPERATION_LOCATION_NOT_FOUND',
                  400,
                  'موقعیت انبار پای کار عملیات مرحله اول یافت نشد.'
                );
              }
              const pcsUnit = await tx.unitOfMeasure.findUnique({ where: { id: targetPart.unitId } });
              if (!pcsUnit || pcsUnit.code !== 'PCS') {
                throw new InventoryPostingError(
                  'INVALID_PART_UNIT',
                  400,
                  'واحد قطعه دستور ساخت باید PCS باشد.'
                );
              }
              const netWeightPerPiece = Number(targetPart.weightNetKg || 0);
              if (!Number.isFinite(netWeightPerPiece) || netWeightPerPiece <= 0) {
                throw new InventoryPostingError(
                  'INVALID_NET_WEIGHT',
                  400,
                  'وزن خالص مهندسی قطعه باید تعریف شود.'
                );
              }
              const totalNetMaterialKg = round6(request.issuedWeightKg - request.varianceWeightKg);
              if (totalNetMaterialKg <= 0) {
                throw new InventoryPostingError(
                  'INVALID_NET_MATERIAL_KG',
                  400,
                  'وزن خالص مواد پس از کسر افت باید مثبت باشد.'
                );
              }
              wipPostingContext = {
                location: opLocation,
                netWeightPerPiece,
                totalNetMaterialKg,
              };
            }

            // Consume target MO's own active reservations on this coil/part so reserved material is usable by this MO
            await consumeMoReservationsInTx(tx, {
              moId: mo.id,
              partId: dbPart.id,
              warehouseId: dbCoil.warehouseId,
              locationId: dbCoil.warehouseLocationId || null,
              materialLotId: dbCoil.materialLotId || null,
              physicalCoilId: dbCoil.id,
              consumeQuantity: request.issuedWeightKg,
              consumeWeightKg: request.issuedWeightKg,
              now: issuedAt,
            });

            resolvedItems.push({
              request,
              mo,
              targetPart,
              operation,
              firstOperationId: firstOperationForOrder?.id || null,
              wipPostingContext,
            });
          }

          const balances = await tx.stockBalance.findMany({
            where: {
              physicalCoilId: dbCoil.id,
              qualityStatus: 'AVAILABLE',
              weightKgAvailable: { gt: 0 },
            },
            orderBy: [{ contractNumber: 'asc' }, { updatedAt: 'asc' }],
          });
          const totalAvailable = round6(
            balances.reduce((sum: number, row: any) => sum + Number(row.weightKgAvailable || 0), 0)
          );
          if (totalAvailable + EPS < totalIssuedKg) {
            throw new InventoryPostingError(
              'INSUFFICIENT_COIL_AVAILABLE_BALANCE',
              409,
              `مانده قابل صدور در کاردکس این کلاف (${totalAvailable} kg) با وزن درخواستی (${totalIssuedKg} kg) کافی نیست؛ ابتدا موجودی کلاف را تطبیق دهید.`
            );
          }

          const docNumber = `ISS-COIL-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
          const doc = await tx.inventoryDocument.create({
            data: {
              documentNumber: docNumber,
              documentType: 'ISSUE',
              documentDate: issuedAt,
              documentStatus: 'CONFIRMED',
              postingStatus: 'POSTED',
              warehouseId: dbCoil.warehouseId,
              referenceType: 'MANUFACTURING_ORDER',
              referenceNumber:
                requested.map(row => row.manufacturingOrderRef).filter(Boolean).join(', ') ||
                dbCoil.coilId,
              createdByUserId: user.id,
              postedByUserId: user.id,
              postedAt: issuedAt,
              issueRequestKey,
              issueRequestFingerprint,
              notes: `حواله ${totalIssuedKg} کیلوگرم از کلاف ${dbCoil.coilId} به تولید`,
            },
          });

          const balanceRemainders = balances.map((balance: any) => ({
            balance,
            initialOnHand: Number(balance.weightKgOnHand),
            initialAvailable: Number(balance.weightKgAvailable),
            remaining: Number(balance.weightKgAvailable),
            version: balance.version,
          }));
          const entries: any[] = [];
          let postedWipInput: any = null;
          let lineNumber = 0;
          const createdRecords: any[] = [];

          for (const item of resolvedItems) {
            const { request, mo, targetPart, operation, wipPostingContext } = item;
            let requestRemaining = request.issuedWeightKg;
            let remainingPcsToAllocate = request.initialInputQuantityPcs;

            for (const source of balanceRemainders) {
              if (requestRemaining <= EPS) break;
              if (source.remaining <= EPS) continue;
              const weight = Math.min(source.remaining, requestRemaining);
              if (weight <= EPS) continue;
              source.remaining = Math.round((source.remaining - weight) * 1000) / 1000;
              requestRemaining = Math.round((requestRemaining - weight) * 1000) / 1000;
              lineNumber += 1;
              const balance = source.balance;
              const nextOnHand = round6(source.initialOnHand - (source.initialAvailable - source.remaining));

              const sbWhereGuard: Record<string, any> = {
                id: balance.id,
                weightKgAvailable: { gte: round6(weight - EPS) },
                weightKgOnHand: { gte: round6(weight - EPS) },
              };
              if (source.version != null) sbWhereGuard.version = source.version;
              const balanceUpdate = await tx.stockBalance.updateMany({
                where: sbWhereGuard,
                data: {
                  quantityOnHand: { decrement: weight },
                  quantityAvailable: { decrement: weight },
                  weightKgOnHand: { decrement: weight },
                  weightKgAvailable: { decrement: weight },
                  version: { increment: 1 },
                  lastTransactionAt: issuedAt,
                },
              });
              if (balanceUpdate.count !== 1) {
                throw new InventoryPostingError(
                  'STOCK_CONCURRENCY_CONFLICT',
                  409,
                  'مانده کاردکس قرارداد هم‌زمان تغییر کرده است؛ اطلاعات را تازه‌سازی کنید.'
                );
              }
              if (source.version != null) source.version += 1;

              const line = await tx.inventoryDocumentLine.create({
                data: {
                  documentId: doc.id,
                  lineNumber,
                  partId: dbPart.id,
                  physicalCoilId: dbCoil.id,
                  productionOperationId: operation.id,
                  materialLotId: dbCoil.materialLotId,
                  locationId: balance.locationId,
                  quantity: weight,
                  unitId: dbPart.unitId,
                  weightKg: weight,
                  ownership: balance.ownership,
                  contractId: balance.contractId,
                  contractNumber: balance.contractNumber,
                  qualityStatus: balance.qualityStatus,
                  notes: `مصرف کلاف ${dbCoil.coilId} برای ${mo.moNumber}`,
                },
              });

              await tx.inventoryTransaction.create({
                data: {
                  transactionNumber: `TRX-COIL-ISS-${Date.now()}-${lineNumber}-${Math.floor(Math.random() * 10000)}`,
                  documentId: doc.id,
                  documentLineId: line.id,
                  partId: dbPart.id,
                  materialLotId: dbCoil.materialLotId,
                  physicalCoilId: dbCoil.id,
                  productionOperationId: operation.id,
                  warehouseId: dbCoil.warehouseId,
                  locationId: balance.locationId,
                  transactionType: 'OUTBOUND',
                  quantity: weight,
                  quantitySigned: -weight,
                  unitId: dbPart.unitId,
                  weightKg: weight,
                  weightKgSigned: -weight,
                  ownership: balance.ownership,
                  contractId: balance.contractId,
                  contractNumber: balance.contractNumber,
                  qualityStatus: balance.qualityStatus,
                  balanceAfter: nextOnHand,
                  balanceKgAfter: nextOnHand,
                  transactionDate: issuedAt,
                  postingStatus: 'POSTED',
                  createdByUserId: user.id,
                  manufacturingOrderId: mo.id,
                },
              });

              const varianceForSegment =
                request.issuedWeightKg > 0 ? request.varianceWeightKg * (weight / request.issuedWeightKg) : 0;
              const record = await tx.coilIssueReturnRecord.create({
                data: {
                  id: `CIR-${Date.now()}-${lineNumber}-${Math.floor(Math.random() * 10000)}`,
                  coilId: dbCoil.id,
                  inventoryDocumentId: doc.id,
                  contractId: balance.contractId,
                  partId: targetPart.id,
                  productionOperationId: operation.id,
                  manufacturingOrderId: mo.id,
                  documentNumber: docNumber,
                  issuedWeightKg: weight,
                  consumedWeightKg: 0,
                  returnedWeightKg: 0,
                  outstandingWeightKg: Math.max(0, weight - varianceForSegment),
                  varianceWeightKg: varianceForSegment,
                  status: weight - varianceForSegment <= 0.001 ? 'CONSUMED' : 'ISSUED',
                  issuedAt,
                  notes:
                    request.notes ||
                    `حواله ${weight} کیلوگرم به ${mo.moNumber}؛ قرارداد ${balance.contractNumber || 'بدون تخصیص'}`,
                },
              });
              createdRecords.push(record);

              if (wipPostingContext) {
                const netMaterialKg = Math.max(0, weight - varianceForSegment);
                const proportionalPcs = Math.floor(
                  request.initialInputQuantityPcs * (netMaterialKg / wipPostingContext.totalNetMaterialKg)
                );
                const pcsShare =
                  requestRemaining <= 0.001
                    ? remainingPcsToAllocate
                    : Math.min(remainingPcsToAllocate, proportionalPcs);
                remainingPcsToAllocate -= pcsShare;
                if (pcsShare > 0) {
                  const wipWeightKg = round6(pcsShare * wipPostingContext.netWeightPerPiece);
                  const wipIdentity = {
                    partId: targetPart.id,
                    warehouseId: wipPostingContext.location.warehouseId,
                    locationId: wipPostingContext.location.id,
                    materialLotId: dbCoil.materialLotId,
                    physicalCoilId: dbCoil.id,
                    ownership: balance.ownership,
                    contractId: balance.contractId,
                    contractNumber: balance.contractNumber,
                    qualityStatus: 'AVAILABLE',
                  };
                  const existingWipBalance = await tx.stockBalance.findFirst({ where: wipIdentity });
                  const wipBalanceAfter = Number(existingWipBalance?.quantityOnHand || 0) + pcsShare;
                  if (existingWipBalance) {
                    const wipWhere: Record<string, any> = { id: existingWipBalance.id };
                    if (existingWipBalance.version != null) wipWhere.version = existingWipBalance.version;
                    const updatedWipSb = await tx.stockBalance.updateMany({
                      where: wipWhere,
                      data: {
                        quantityOnHand: { increment: pcsShare },
                        quantityAvailable: { increment: pcsShare },
                        weightKgOnHand: { increment: wipWeightKg },
                        weightKgAvailable: { increment: wipWeightKg },
                        version: { increment: 1 },
                        lastTransactionAt: issuedAt,
                      },
                    });
                    if (updatedWipSb.count !== 1) {
                      throw new InventoryPostingError(
                        'STOCK_CONCURRENCY_CONFLICT',
                        409,
                        'تداخل همزمان هنگام ثبت موجودی WIP رخ داد.'
                      );
                    }
                  } else {
                    await tx.stockBalance.create({
                      data: {
                        ...wipIdentity,
                        quantityOnHand: pcsShare,
                        quantityReserved: 0,
                        quantityAvailable: pcsShare,
                        weightKgOnHand: wipWeightKg,
                        weightKgReserved: 0,
                        weightKgAvailable: wipWeightKg,
                        version: 1,
                        lastTransactionAt: issuedAt,
                      },
                    });
                  }
                  await tx.inventoryTransaction.create({
                    data: {
                      transactionNumber: `TRX-WIP-INPUT-${Date.now()}-${lineNumber}-${Math.floor(Math.random() * 10000)}`,
                      partId: targetPart.id,
                      materialLotId: dbCoil.materialLotId,
                      physicalCoilId: dbCoil.id,
                      productionOperationId: operation.id,
                      warehouseId: wipPostingContext.location.warehouseId,
                      locationId: wipPostingContext.location.id,
                      transactionType: 'INBOUND',
                      quantity: pcsShare,
                      quantitySigned: pcsShare,
                      unitId: targetPart.unitId,
                      weightKg: wipWeightKg,
                      weightKgSigned: wipWeightKg,
                      ownership: balance.ownership,
                      contractId: balance.contractId,
                      contractNumber: balance.contractNumber,
                      qualityStatus: 'AVAILABLE',
                      balanceAfter: wipBalanceAfter,
                      balanceKgAfter: wipBalanceAfter * wipPostingContext.netWeightPerPiece,
                      transactionDate: issuedAt,
                      postingStatus: 'POSTED',
                      createdByUserId: user.id,
                      manufacturingOrderId: mo.id,
                    },
                  });
                }
              }

              entries.push({ weight, contractNumber: balance.contractNumber });
            }

            if (requestRemaining > 0.001) {
              throw new InventoryPostingError(
                'INSUFFICIENT_COIL_BALANCE',
                409,
                `موجودی قابل تخصیص برای سفارش ${mo.moNumber} کافی نیست.`
              );
            }

            if (wipPostingContext) {
              const opWhere: Record<string, any> = { id: operation.id };
              if (operation.version != null) opWhere.version = operation.version;
              const opCas = await tx.productionOperation.updateMany({
                where: opWhere,
                data: {
                  waitingInputQty: { increment: request.initialInputQuantityPcs },
                  status: operation.status === 'PENDING' ? 'READY' : operation.status,
                  lastActivityAt: issuedAt,
                  version: { increment: 1 },
                },
              });
              if (opCas.count !== 1) {
                throw new InventoryPostingError(
                  'OPERATION_CONCURRENCY_CONFLICT',
                  409,
                  'نسخه عملیات مرحله اول همزمان تغییر کرده است.'
                );
              }

              const moWhere: Record<string, any> = { id: mo.id };
              if (mo.version != null) moWhere.version = mo.version;
              const moCas = await tx.manufacturingOrder.updateMany({
                where: moWhere,
                data: {
                  initialInputQty: { increment: request.initialInputQuantityPcs },
                  status: mo.status === 'PLANNED' ? 'RELEASED' : mo.status,
                  version: { increment: 1 },
                },
              });
              if (moCas.count !== 1) {
                throw new InventoryPostingError(
                  'MO_CONCURRENCY_CONFLICT',
                  409,
                  'نسخه دستور ساخت همزمان تغییر کرده است.'
                );
              }

              await tx.productionActivityLog.create({
                data: {
                  manufacturingOrderId: mo.id,
                  moNumber: mo.moNumber,
                  partId: mo.partId,
                  productionOperationId: operation.id,
                  stepNumber: operation.stepNumber,
                  stepName: operation.stepName || operation.operation?.name || '',
                  activityType: 'INPUT_LOAD',
                  quantity: request.initialInputQuantityPcs,
                  operatorName: 'انباردار رول و ورق',
                  timestamp: issuedAt,
                  notes: `صدور کلاف ${dbCoil.coilId} به مرحله اول (${docNumber})`,
                },
              });
              postedWipInput = {
                manufacturingOrderId: mo.id,
                productionOperationId: operation.id,
                quantityPcs: request.initialInputQuantityPcs,
              };
            }
          }

          if (dbCoil.materialLotId) {
            const lot = await tx.materialLot.findUnique({ where: { id: dbCoil.materialLotId } });
            const nextLotWeight = lot ? Math.max(0, round6(Number(lot.remainingWeightKg) - totalIssuedKg)) : 0;
            const nextLotStatus = nextLotWeight <= EPS ? 'CONSUMED' : 'IN_USE';
            const lotUpdate = await tx.materialLot.updateMany({
              where: {
                id: dbCoil.materialLotId,
                remainingWeightKg: { gte: round6(totalIssuedKg - EPS) },
              },
              data: {
                remainingWeightKg: { decrement: totalIssuedKg },
                status: nextLotStatus,
                updatedAt: issuedAt,
              },
            });
            if (lotUpdate.count !== 1) {
              throw new InventoryPostingError(
                'COIL_LOT_MISMATCH',
                409,
                'مانده لوت ماده اولیه با مانده کلاف تطبیق ندارد؛ صدور لغو شد.'
              );
            }
          }

          const coilWhereGuard: Record<string, any> = {
            id: dbCoil.id,
            remainingWeightKg: { gte: round6(totalIssuedKg - EPS) },
            qualityStatus: 'AVAILABLE',
            physicalStatus: { not: 'BLOCKED' },
          };
          if (dbCoil.version != null) coilWhereGuard.version = dbCoil.version;

          const nextCoilRemaining = Math.max(0, round6(availableKg - totalIssuedKg));
          const coilUpdate = await tx.physicalCoil.updateMany({
            where: coilWhereGuard,
            data: {
              remainingWeightKg: { decrement: totalIssuedKg },
              physicalStatus: nextCoilRemaining <= EPS ? 'CONSUMED' : 'PARTIALLY_ISSUED',
              version: { increment: 1 },
              updatedAt: issuedAt,
            },
          });
          if (coilUpdate.count !== 1) {
            throw new InventoryPostingError(
              'COIL_CONCURRENCY_CONFLICT',
              409,
              'مانده کلاف هم‌زمان تغییر کرده است؛ اطلاعات را تازه‌سازی و دوباره تلاش کنید.'
            );
          }

          const updatedCoil = await tx.physicalCoil.findUnique({ where: { id: dbCoil.id } });
          return {
            duplicate: false,
            coil: updatedCoil,
            records: createdRecords,
            documentNumber: docNumber,
            entries,
            wipInput: postedWipInput,
          };
        },
        { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 }
      );

      return {
        success: true,
        statusCode: 200,
        duplicate: persisted.duplicate,
        coil: persisted.coil,
        documentNumber: persisted.documentNumber,
        issueRecords: persisted.records,
        issueRecord: persisted.records[0] || null,
        wipInput: persisted.wipInput,
        message: persisted.duplicate
          ? `این درخواست قبلاً با سند ${persisted.documentNumber} ثبت شده است؛ موجودی دوباره کسر نشد. مانده: ${Number(persisted.coil.remainingWeightKg)} کیلوگرم.`
          : `حواله ${totalIssuedKg} کیلوگرم از کلاف «${persisted.coil.coilId}» در سند ${persisted.documentNumber} ثبت شد. مانده: ${Number(persisted.coil.remainingWeightKg)} کیلوگرم.`,
      };
    } catch (error: any) {
      if (attempt < maxRetries && isRetryableSerializationError(error)) {
        const backoffMs = Math.min(250, 20 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 25);
        await sleepMs(backoffMs);
        continue;
      }
      if (error?.code === 'P2002' && issueRequestKey) {
        try {
          const prior = await prisma.inventoryDocument.findUnique({
            where: { issueRequestKey },
            include: { coilIssueReturnRecords: true },
          });
          if (prior) {
            if (prior.issueRequestFingerprint !== issueRequestFingerprint) {
              return {
                success: false,
                statusCode: 409,
                errorCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
                error: 'این شناسه درخواست قبلاً برای اطلاعات متفاوتی استفاده شده است؛ فرم را ببندید و حواله جدیدی آغاز کنید.',
              };
            }
            const priorCoil = await prisma.physicalCoil.findFirst({
              where: { OR: [{ id: coilRef }, { coilId: coilRef }] },
            });
            return {
              success: true,
              statusCode: 200,
              duplicate: true,
              coil: priorCoil,
              documentNumber: prior.documentNumber,
              issueRecords: prior.coilIssueReturnRecords || [],
              issueRecord: prior.coilIssueReturnRecords?.[0] || null,
              wipInput: null,
            };
          }
        } catch {
          // Fall through
        }
      }
      if (error instanceof InventoryPostingError) {
        return {
          success: false,
          statusCode: error.statusCode,
          errorCode: error.code,
          error: error.message,
        };
      }
      return {
        success: false,
        statusCode: 409,
        errorCode: 'COIL_ISSUE_FAILED',
        error: error instanceof Error ? error.message : 'خطا در ثبت اتمیک حواله کلاف',
      };
    }
  }

  return {
    success: false,
    statusCode: 409,
    errorCode: 'SERIALIZATION_RETRY_EXHAUSTED',
    error: 'ثبت حواله کلاف پس از چند تلاش متوالی به دلیل تداخل همزمانی متوقف شد.',
  };
}



