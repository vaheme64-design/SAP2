import {
  CoilIssueReturnRecord,
  DetailedStockBalance,
  InventoryDocument,
  InventoryReservation,
  Part,
  PhysicalCoil,
  SapcoContract,
  StockOwnership,
  WarehouseDefinition,
} from '../types/inventory';
import {
  calculateDetailedStockBalances,
  calculateSapcoContractLedger,
} from './inventoryEngine';
import {
  queryContractsAndSapcoAccountFromDb,
  queryDetailedStockBalancesFromDb,
  queryReservationsFromDb,
} from './services/inventoryLedgerService';
import { classifyMaterialFamily, MaterialFamily } from '../utils/materialClassification';

const EPS = 0.01;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export type ReconciliationSeverity = 'ERROR' | 'WARNING' | 'INFO';

export type ReconciliationCategory =
  | 'LEDGER_VS_BALANCE'
  | 'STOCK_EQUATION'
  | 'COIL_LIFECYCLE'
  | 'CONTRACT_SAPCO'
  | 'RESERVATION_INTEGRITY';

export interface ReconciliationDiscrepancy {
  id: string;
  category: ReconciliationCategory;
  severity: ReconciliationSeverity;
  entityCode: string;
  entityName: string;
  warehouseId?: string;
  expectedValue: number;
  actualValue: number;
  variance: number;
  unit: string;
  messageFa: string;
}

export interface ReconciliationCheckResult {
  key: ReconciliationCategory;
  titleFa: string;
  status: 'PASS' | 'WARNING' | 'FAIL';
  checkedCount: number;
  issueCount: number;
  detailFa: string;
}

export interface ContractStockSummaryRow {
  contractId: string;
  contractNumber: string;
  title: string;
  customerName: string;
  ownership: StockOwnership;
  openingBalanceKg: number;
  totalReceivedKg: number;
  totalConsumedKg: number;
  ledgerClosingBalanceKg: number;
  warehouseStockKg: number;
  availableStockKg: number;
  reservedStockKg: number;
  qualityHoldStockKg: number;
  activeCoilsCount: number;
  activeCoilsRemainingKg: number;
  varianceKg: number;
  status: 'BALANCED' | 'VARIANCE';
}

export interface InventoryReconciliationReport {
  generatedAt: string;
  source: 'POSTGRESQL' | 'IN_MEMORY_LEDGER';
  overallStatus: 'BALANCED' | 'WARNINGS' | 'DISCREPANCY';
  summary: {
    totalStockRows: number;
    totalPhysicalKg: number;
    totalUnrestrictedKg: number;
    totalAvailableKg: number;
    totalReservedKg: number;
    totalQualityInspectionKg: number;
    totalBlockedKg: number;
    totalQualityHoldKg: number;
    totalPhysicalCoils: number;
    activeCoilsRemainingKg: number;
    activeContractsCount: number;
    activeReservationsCount: number;
    errorCount: number;
    warningCount: number;
    byMaterialFamily: Record<
      MaterialFamily,
      {
        rowCount: number;
        physicalQty: number;
        availableQty: number;
        reservedQty: number;
        qualityHoldQty: number;
        physicalKg: number;
        availableKg: number;
      }
    >;
  };
  checks: ReconciliationCheckResult[];
  discrepancies: ReconciliationDiscrepancy[];
  contractSummaries: ContractStockSummaryRow[];
}

export interface ComputeReconciliationInput {
  source: 'POSTGRESQL' | 'IN_MEMORY_LEDGER';
  balances: DetailedStockBalance[];
  coils: PhysicalCoil[];
  coilIssueRecords: CoilIssueReturnRecord[];
  contracts: SapcoContract[];
  reservations: InventoryReservation[];
  /** Optional DB-level signed transaction comparison rows (populated in PostgreSQL mode). */
  dbLedgerVarianceRows?: Array<{
    key: string;
    partCode: string;
    partName: string;
    warehouseId: string;
    unit: string;
    balanceQty: number;
    ledgerSignedQty: number;
  }>;
}

/**
 * Pure 4-way reconciliation engine over existing stock balances, physical coils,
 * SAPCO contracts, and reservations. Never fabricates or creates parallel stock formulas.
 */
export function computeInventoryReconciliationReport(
  input: ComputeReconciliationInput
): InventoryReconciliationReport {
  const discrepancies: ReconciliationDiscrepancy[] = [];
  const generatedAt = new Date().toISOString();

  // 1. Stock Balance Equation & Non-Negativity Check
  let stockEqIssues = 0;
  for (const b of input.balances) {
    const physical = Number(b.physicalQty || 0);
    const unrestricted = Number(b.unrestrictedQty || 0);
    const qi = Number(b.qualityInspectionQty || 0);
    const blocked = Number(b.blockedQty || 0);
    const reserved = Number(b.reservedQty || 0);
    const available = Number(b.availableQty || 0);
    const expectedPhysical = round3(unrestricted + qi + blocked);
    const expectedAvailable = round3(Math.max(0, unrestricted - reserved));

    if (
      physical < -EPS ||
      unrestricted < -EPS ||
      qi < -EPS ||
      blocked < -EPS ||
      reserved < -EPS ||
      available < -EPS
    ) {
      stockEqIssues += 1;
      discrepancies.push({
        id: `DISC-NEG-${b.id}`,
        category: 'STOCK_EQUATION',
        severity: 'ERROR',
        entityCode: b.partCode,
        entityName: b.partName,
        warehouseId: b.warehouseId,
        expectedValue: 0,
        actualValue: Math.min(physical, unrestricted, qi, blocked, reserved, available),
        variance: Math.min(physical, unrestricted, qi, blocked, reserved, available),
        unit: b.unit,
        messageFa: `موجودی منفی در ردیف «${b.partCode}» انبار «${b.warehouseName}» شناسایی شد.`,
      });
    }

    if (Math.abs(physical - expectedPhysical) > EPS) {
      stockEqIssues += 1;
      discrepancies.push({
        id: `DISC-EQ-${b.id}`,
        category: 'STOCK_EQUATION',
        severity: 'ERROR',
        entityCode: b.partCode,
        entityName: b.partName,
        warehouseId: b.warehouseId,
        expectedValue: expectedPhysical,
        actualValue: round3(physical),
        variance: round3(physical - expectedPhysical),
        unit: b.unit,
        messageFa: `عدم توازن تفکیک کیفی برای «${b.partCode}» (فیزیکی ${round3(physical)} ≠ آزاد + قرنطینه + مسدود ${expectedPhysical}).`,
      });
    }

    if (Math.abs(available - expectedAvailable) > EPS) {
      stockEqIssues += 1;
      discrepancies.push({
        id: `DISC-ATP-${b.id}`,
        category: 'STOCK_EQUATION',
        severity: 'ERROR',
        entityCode: b.partCode,
        entityName: b.partName,
        warehouseId: b.warehouseId,
        expectedValue: expectedAvailable,
        actualValue: round3(available),
        variance: round3(available - expectedAvailable),
        unit: b.unit,
        messageFa: `عدم تطابق موجودی قابل استفاده (ATP) برای «${b.partCode}» (${round3(available)} ≠ ${expectedAvailable}).`,
      });
    }
  }

  // 2. DB Ledger Signed Sum vs StockBalance Check (when DB rows are supplied)
  let ledgerIssues = 0;
  if (input.dbLedgerVarianceRows && input.dbLedgerVarianceRows.length > 0) {
    for (const row of input.dbLedgerVarianceRows) {
      const variance = round3(row.balanceQty - row.ledgerSignedQty);
      if (Math.abs(variance) > EPS) {
        ledgerIssues += 1;
        discrepancies.push({
          id: `DISC-LEDGER-${row.key}`,
          category: 'LEDGER_VS_BALANCE',
          severity: 'ERROR',
          entityCode: row.partCode,
          entityName: row.partName,
          warehouseId: row.warehouseId,
          expectedValue: round3(row.ledgerSignedQty),
          actualValue: round3(row.balanceQty),
          variance,
          unit: row.unit,
          messageFa: `مغایرت کاردکس (InventoryTransaction) با مانده فعلی (StockBalance) برای «${row.partCode}»: مانده ${round3(row.balanceQty)} در برابر جمع دفتر ${round3(row.ledgerSignedQty)}.`,
        });
      }
    }
  }

  // 3. Physical Coil Lifecycle & Mass Balance Check
  let coilIssues = 0;
  for (const coil of input.coils) {
    const orig = Number(coil.originalWeightKg || 0);
    const rem = Number(coil.remainingWeightKg || 0);

    if (rem < -EPS) {
      coilIssues += 1;
      discrepancies.push({
        id: `DISC-COIL-NEG-${coil.id}`,
        category: 'COIL_LIFECYCLE',
        severity: 'ERROR',
        entityCode: coil.coilId,
        entityName: coil.partName || coil.materialGrade,
        warehouseId: coil.warehouseId,
        expectedValue: 0,
        actualValue: round3(rem),
        variance: round3(rem),
        unit: 'KG',
        messageFa: `وزن باقیمانده کلاف «${coil.coilId}» منفی است (${round3(rem)} kg).`,
      });
    } else if (rem > orig + EPS) {
      coilIssues += 1;
      discrepancies.push({
        id: `DISC-COIL-OVER-${coil.id}`,
        category: 'COIL_LIFECYCLE',
        severity: 'ERROR',
        entityCode: coil.coilId,
        entityName: coil.partName || coil.materialGrade,
        warehouseId: coil.warehouseId,
        expectedValue: round3(orig),
        actualValue: round3(rem),
        variance: round3(rem - orig),
        unit: 'KG',
        messageFa: `وزن باقیمانده کلاف «${coil.coilId}» (${round3(rem)} kg) از وزن اولیه آن (${round3(orig)} kg) بیشتر است.`,
      });
    }

    const coilRecords = input.coilIssueRecords.filter(
      r => r.coilId === coil.id || r.coilId === coil.coilId
    );
    if (coilRecords.length > 0) {
      const totalIssued = coilRecords
        .filter(r => Number(r.issuedWeightKg || 0) > 0)
        .reduce((s, r) => s + Number(r.issuedWeightKg || 0), 0);
      const totalReturned = coilRecords
        .filter(r => Number(r.issuedWeightKg || 0) <= 0 && Number(r.returnedWeightKg || 0) > 0)
        .reduce((s, r) => s + Number(r.returnedWeightKg || 0), 0);
      const netOut = Math.max(0, totalIssued - totalReturned);
      const expectedRemaining = round3(Math.max(0, orig - netOut));
      if (Math.abs(rem - expectedRemaining) > 1.0 && coil.physicalStatus !== 'RETURNED') {
        coilIssues += 1;
        discrepancies.push({
          id: `DISC-COIL-MASS-${coil.id}`,
          category: 'COIL_LIFECYCLE',
          severity: 'WARNING',
          entityCode: coil.coilId,
          entityName: coil.partName || coil.materialGrade,
          warehouseId: coil.warehouseId,
          expectedValue: expectedRemaining,
          actualValue: round3(rem),
          variance: round3(rem - expectedRemaining),
          unit: 'KG',
          messageFa: `مغایرت تراز جرمی کلاف «${coil.coilId}»: مانده ثبت‌شده ${round3(rem)} kg در برابر محاسبه حواله/برگشت ${expectedRemaining} kg.`,
        });
      }
    }
  }

  // 4. Contract & SAPCO Consignment Reconciliation
  let contractIssues = 0;
  const contractSummaries: ContractStockSummaryRow[] = input.contracts.map(contract => {
    const matchingBalances = input.balances.filter(
      b =>
        (b.contractId && b.contractId === contract.id) ||
        (b.contractNumber && b.contractNumber === contract.contractNumber)
    );
    const warehouseStockKg = round3(
      matchingBalances.reduce((s, b) => s + Number(b.physicalKg || 0), 0)
    );
    const availableStockKg = round3(
      matchingBalances.reduce((s, b) => s + Number(b.availableKg || 0), 0)
    );
    const reservedStockKg = round3(
      matchingBalances.reduce((s, b) => s + Number(b.reservedKg || 0), 0)
    );
    const qualityHoldStockKg = round3(
      matchingBalances.reduce(
        (s, b) => s + Number(b.qualityInspectionKg || 0) + Number(b.blockedKg || 0),
        0
      )
    );
    const matchingCoils = input.coils.filter(
      c =>
        Number(c.remainingWeightKg || 0) > EPS &&
        (c.allocations || []).some(
          a => a.contractId === contract.id || a.contractNumber === contract.contractNumber
        )
    );
    const activeCoilsRemainingKg = round3(
      matchingCoils.reduce((s, c) => s + Number(c.remainingWeightKg || 0), 0)
    );
    const ledgerClosingBalanceKg = round3(Number(contract.closingBalanceKg || 0));
    const varianceKg = round3(warehouseStockKg - ledgerClosingBalanceKg);

    if (ledgerClosingBalanceKg < -EPS) {
      contractIssues += 1;
      discrepancies.push({
        id: `DISC-CNT-NEG-${contract.id}`,
        category: 'CONTRACT_SAPCO',
        severity: 'ERROR',
        entityCode: contract.contractNumber,
        entityName: contract.title,
        expectedValue: 0,
        actualValue: ledgerClosingBalanceKg,
        variance: ledgerClosingBalanceKg,
        unit: 'KG',
        messageFa: `مانده دفتر قرارداد امانی «${contract.contractNumber}» منفی است (${ledgerClosingBalanceKg} kg).`,
      });
    } else if (Math.abs(varianceKg) > 1 && matchingBalances.length > 0) {
      // Informational warning when contract opening/consumption differs from warehouse-tagged stock
      contractIssues += 1;
      discrepancies.push({
        id: `DISC-CNT-DIFF-${contract.id}`,
        category: 'CONTRACT_SAPCO',
        severity: 'WARNING',
        entityCode: contract.contractNumber,
        entityName: contract.title,
        expectedValue: ledgerClosingBalanceKg,
        actualValue: warehouseStockKg,
        variance: varianceKg,
        unit: 'KG',
        messageFa: `اختلاف مانده دفتر قرارداد «${contract.contractNumber}» (${ledgerClosingBalanceKg} kg) با موجودی تگ‌شده در انبار (${warehouseStockKg} kg)؛ لطفاً اسناد امانی و ردیف‌های فاقد شناسه قرارداد بررسی شود.`,
      });
    }

    return {
      contractId: contract.id,
      contractNumber: contract.contractNumber,
      title: contract.title,
      customerName: contract.customerName || 'نامشخص',
      ownership: contract.ownership || 'COMPANY_OWNED',
      openingBalanceKg: round3(Number(contract.openingBalanceKg || 0)),
      totalReceivedKg: round3(Number(contract.totalReceivedKg || 0)),
      totalConsumedKg: round3(Number(contract.totalConsumedKg || 0)),
      ledgerClosingBalanceKg,
      warehouseStockKg,
      availableStockKg,
      reservedStockKg,
      qualityHoldStockKg,
      activeCoilsCount: matchingCoils.length,
      activeCoilsRemainingKg,
      varianceKg,
      status: Math.abs(varianceKg) <= 1 || matchingBalances.length === 0 ? 'BALANCED' : 'VARIANCE',
    };
  });

  // 5. Reservation Integrity Check
  let reservationIssues = 0;
  const activeReservations = input.reservations.filter(
    r => r.status === 'ACTIVE' && Number(r.quantity || 0) > EPS
  );
  for (const res of activeReservations) {
    const matchingUnrestricted = input.balances
      .filter(
        b =>
          b.partId === res.partId &&
          b.warehouseId === res.warehouseId &&
          (!res.lotNumber || b.lotNumber === res.lotNumber)
      )
      .reduce((s, b) => s + Number(b.unrestrictedQty || 0), 0);

    const reservedQty = Number(res.quantity || 0);
    const resRef = res.reservationNumber || res.reservedFor || res.id;
    if (reservedQty > matchingUnrestricted + EPS) {
      reservationIssues += 1;
      discrepancies.push({
        id: `DISC-RES-${res.id}`,
        category: 'RESERVATION_INTEGRITY',
        severity: 'WARNING',
        entityCode: res.partCode || res.partId,
        entityName: res.partName || resRef,
        warehouseId: res.warehouseId,
        expectedValue: round3(matchingUnrestricted),
        actualValue: round3(reservedQty),
        variance: round3(reservedQty - matchingUnrestricted),
        unit: res.unit || 'PCS',
        messageFa: `رزرو فعال «${resRef}» برای قطعه «${res.partCode}» (${round3(reservedQty)}) از موجودی آزاد انبار (${round3(matchingUnrestricted)}) بیشتر است.`,
      });
    }
  }

  // Material Family Breakdown
  const emptyFamilyBucket = () => ({
    rowCount: 0,
    physicalQty: 0,
    availableQty: 0,
    reservedQty: 0,
    qualityHoldQty: 0,
    physicalKg: 0,
    availableKg: 0,
  });
  const byMaterialFamily: InventoryReconciliationReport['summary']['byMaterialFamily'] = {
    SHEET_METAL: emptyFamilyBucket(),
    FASTENER: emptyFamilyBucket(),
    RUBBER: emptyFamilyBucket(),
    WIP: emptyFamilyBucket(),
    FINISHED_GOOD: emptyFamilyBucket(),
  };

  let totalPhysicalKg = 0;
  let totalUnrestrictedKg = 0;
  let totalAvailableKg = 0;
  let totalReservedKg = 0;
  let totalQualityInspectionKg = 0;
  let totalBlockedKg = 0;

  for (const b of input.balances) {
    const fam = classifyMaterialFamily({
      category: b.category,
      partCode: b.partCode,
      partName: b.partName,
      unit: b.unit,
      materialGrade: b.materialGrade,
      thicknessMm: b.thicknessMm,
    });
    const bucket = byMaterialFamily[fam];
    bucket.rowCount += 1;
    bucket.physicalQty = round3(bucket.physicalQty + Number(b.physicalQty || 0));
    bucket.availableQty = round3(bucket.availableQty + Number(b.availableQty || 0));
    bucket.reservedQty = round3(bucket.reservedQty + Number(b.reservedQty || 0));
    bucket.qualityHoldQty = round3(
      bucket.qualityHoldQty + Number(b.qualityInspectionQty || 0) + Number(b.blockedQty || 0)
    );
    bucket.physicalKg = round3(bucket.physicalKg + Number(b.physicalKg || 0));
    bucket.availableKg = round3(bucket.availableKg + Number(b.availableKg || 0));

    totalPhysicalKg += Number(b.physicalKg || 0);
    totalUnrestrictedKg += Number(b.unrestrictedKg || 0);
    totalAvailableKg += Number(b.availableKg || 0);
    totalReservedKg += Number(b.reservedKg || 0);
    totalQualityInspectionKg += Number(b.qualityInspectionKg || 0);
    totalBlockedKg += Number(b.blockedKg || 0);
  }

  const activeCoilsRemainingKg = round3(
    input.coils
      .filter(c => Number(c.remainingWeightKg || 0) > EPS)
      .reduce((s, c) => s + Number(c.remainingWeightKg || 0), 0)
  );

  const errorCount = discrepancies.filter(d => d.severity === 'ERROR').length;
  const warningCount = discrepancies.filter(d => d.severity === 'WARNING').length;

  const checks: ReconciliationCheckResult[] = [
    {
      key: 'STOCK_EQUATION',
      titleFa: 'تطابق معادله موجودی (فیزیکی = آزاد + قرنطینه + مسدود و ATP = آزاد − رزرو)',
      status: stockEqIssues === 0 ? 'PASS' : 'FAIL',
      checkedCount: input.balances.length,
      issueCount: stockEqIssues,
      detailFa:
        stockEqIssues === 0
          ? `تمامی ${input.balances.length} ردیف موجودی بدون تراز منفی و با تفکیک دقیق کیفی و رزرو متوازن هستند.`
          : `${stockEqIssues} مورد عدم توازن در معادله موجودی شناسایی شد.`,
    },
    {
      key: 'LEDGER_VS_BALANCE',
      titleFa: 'تطابق دفتر گردش اسناد قطعی (Ledger) با مانده موجودی انبار (StockBalance)',
      status: ledgerIssues === 0 ? 'PASS' : 'FAIL',
      checkedCount: input.dbLedgerVarianceRows ? input.dbLedgerVarianceRows.length : input.balances.length,
      issueCount: ledgerIssues,
      detailFa:
        ledgerIssues === 0
          ? input.source === 'POSTGRESQL'
            ? 'جمع جبری تراکنش‌های قطعی در PostgreSQL با تمامی ردیف‌های StockBalance منطبق است.'
            : 'تمامی مانده‌ها مستقیماً از اسناد قطعی (POSTED) دفتر کل محاسبه شده‌اند و توازن ۱۰۰٪ برقرار است.'
          : `${ledgerIssues} مغایرت بین دفتر گردش و مانده جدول موجودی یافت شد.`,
    },
    {
      key: 'COIL_LIFECYCLE',
      titleFa: 'تراز جرمی و چرخه عمر کلاف‌های فیزیکی ورق (ورود، حواله جزئی/کامل، برگشت ته‌کلاف)',
      status:
        coilIssues === 0
          ? 'PASS'
          : discrepancies.some(d => d.category === 'COIL_LIFECYCLE' && d.severity === 'ERROR')
          ? 'FAIL'
          : 'WARNING',
      checkedCount: input.coils.length,
      issueCount: coilIssues,
      detailFa:
        coilIssues === 0
          ? `وزن اولیه و مانده تمامی ${input.coils.length} کلاف فیزیکی با تاریخچه حواله و برگشت ته‌کلاف منطبق است.`
          : `${coilIssues} مورد هشدار/خطای تراز جرمی در کلاف‌های فیزیکی شناسایی شد.`,
    },
    {
      key: 'CONTRACT_SAPCO',
      titleFa: 'تطابق حساب امانی ساپکو و سهمیه قراردادها',
      status:
        contractIssues === 0
          ? 'PASS'
          : discrepancies.some(d => d.category === 'CONTRACT_SAPCO' && d.severity === 'ERROR')
          ? 'FAIL'
          : 'WARNING',
      checkedCount: input.contracts.length,
      issueCount: contractIssues,
      detailFa:
        contractIssues === 0
          ? `مانده حساب امانی تمامی ${input.contracts.length} قرارداد فعال با موجودی انبار متوازن است.`
          : `${contractIssues} مورد اختلاف/هشدار بین دفتر قرارداد و موجودی تگ‌شده مشاهده شد.`,
    },
    {
      key: 'RESERVATION_INTEGRITY',
      titleFa: 'کنترل سقف رزروهای فعال خطوط تولید نسبت به موجودی آزاد',
      status: reservationIssues === 0 ? 'PASS' : 'WARNING',
      checkedCount: activeReservations.length,
      issueCount: reservationIssues,
      detailFa:
        reservationIssues === 0
          ? `تمامی ${activeReservations.length} رزرو فعال در محدوده موجودی آزاد (Unrestricted) قرار دارند.`
          : `${reservationIssues} رزرو فعال نیازمند بررسی موجودی آزاد است.`,
    },
  ];

  const overallStatus: InventoryReconciliationReport['overallStatus'] =
    errorCount > 0 ? 'DISCREPANCY' : warningCount > 0 ? 'WARNINGS' : 'BALANCED';

  return {
    generatedAt,
    source: input.source,
    overallStatus,
    summary: {
      totalStockRows: input.balances.length,
      totalPhysicalKg: round3(totalPhysicalKg),
      totalUnrestrictedKg: round3(totalUnrestrictedKg),
      totalAvailableKg: round3(totalAvailableKg),
      totalReservedKg: round3(totalReservedKg),
      totalQualityInspectionKg: round3(totalQualityInspectionKg),
      totalBlockedKg: round3(totalBlockedKg),
      totalQualityHoldKg: round3(totalQualityInspectionKg + totalBlockedKg),
      totalPhysicalCoils: input.coils.length,
      activeCoilsRemainingKg,
      activeContractsCount: input.contracts.length,
      activeReservationsCount: activeReservations.length,
      errorCount,
      warningCount,
      byMaterialFamily,
    },
    checks,
    discrepancies,
    contractSummaries,
  };
}

/**
 * Fallback (in-memory ledger) reconciliation runner — strictly uses existing ledger calculators.
 */
export function getFallbackInventoryReconciliation(params: {
  documents: InventoryDocument[];
  reservations: InventoryReservation[];
  parts: Part[];
  qcHolds: Record<string, any>;
  coils: PhysicalCoil[];
  coilIssueRecords: CoilIssueReturnRecord[];
  contracts: SapcoContract[];
}): InventoryReconciliationReport {
  const { balances } = calculateDetailedStockBalances(
    params.documents,
    params.reservations,
    params.parts,
    params.qcHolds
  );
  const { contractsWithBalances } = calculateSapcoContractLedger(
    params.contracts,
    params.documents
  );

  return computeInventoryReconciliationReport({
    source: 'IN_MEMORY_LEDGER',
    balances,
    coils: params.coils,
    coilIssueRecords: params.coilIssueRecords,
    contracts: contractsWithBalances,
    reservations: params.reservations,
  });
}

/**
 * PostgreSQL read-only reconciliation runner — strictly reads existing Prisma tables.
 */
export async function getRelationalInventoryReconciliation(
  prisma: any,
  partsStore: Part[]
): Promise<InventoryReconciliationReport> {
  const [stockData, contractData, reservations, dbCoils, dbCoilRecords, dbStockRows, dbTxGroups] =
    await Promise.all([
      queryDetailedStockBalancesFromDb(prisma, partsStore),
      queryContractsAndSapcoAccountFromDb(prisma),
      queryReservationsFromDb(prisma),
      prisma.physicalCoil.findMany({
        include: {
          part: { select: { id: true, partNumber: true, name: true } },
          material: { select: { grade: true } },
          warehouse: { select: { id: true, code: true, name: true } },
          warehouseLocation: { select: { code: true } },
          contractAllocations: {
            include: { contract: { select: { id: true, contractNumber: true } } },
          },
        },
      }),
      prisma.coilIssueReturnRecord.findMany({}),
      prisma.stockBalance.findMany({
        include: {
          part: { select: { partNumber: true, name: true, unit: { select: { code: true } } } },
          warehouse: { select: { code: true } },
        },
      }),
      prisma.inventoryTransaction.groupBy({
        by: [
          'partId',
          'warehouseId',
          'locationId',
          'materialLotId',
          'physicalCoilId',
          'ownership',
          'contractId',
          'qualityStatus',
        ],
        _sum: { quantitySigned: true },
      }),
    ]);

  const txSumMap = new Map<string, number>();
  for (const g of dbTxGroups || []) {
    const key = [
      g.partId || '',
      g.warehouseId || '',
      g.locationId || '',
      g.materialLotId || '',
      g.physicalCoilId || '',
      g.ownership || 'COMPANY_OWNED',
      g.contractId || '',
      g.qualityStatus || 'AVAILABLE',
    ].join(':::');
    txSumMap.set(key, Number(g._sum?.quantitySigned || 0));
  }

  const dbLedgerVarianceRows = (dbStockRows || []).map((row: any) => {
    const key = [
      row.partId || '',
      row.warehouseId || '',
      row.locationId || '',
      row.materialLotId || '',
      row.physicalCoilId || '',
      row.ownership || 'COMPANY_OWNED',
      row.contractId || '',
      row.qualityStatus || 'AVAILABLE',
    ].join(':::');
    return {
      key,
      partCode: row.part?.partNumber || row.partId,
      partName: row.part?.name || row.partId,
      warehouseId: row.warehouse?.code || row.warehouseId,
      unit: row.part?.unit?.code || 'PCS',
      balanceQty: Number(row.quantityOnHand || 0),
      ledgerSignedQty: txSumMap.get(key) ?? 0,
    };
  });

  const coils: PhysicalCoil[] = (dbCoils || []).map((row: any) => ({
    id: row.id,
    coilId: row.coilId,
    coilPackNumber: row.coilPackNumber,
    partId: row.partId || '',
    partCode: row.part?.partNumber || '',
    partName: row.part?.name || '',
    materialGrade: row.material?.grade || '',
    heatNumber: row.heatNumber || '',
    thicknessMm: Number(row.thicknessMm || 0),
    widthMm: Number(row.widthMm || 0),
    originalWeightKg: Number(row.originalWeightKg || 0),
    remainingWeightKg: Number(row.remainingWeightKg || 0),
    warehouseId: row.warehouse?.code || row.warehouseId,
    warehouseName: row.warehouse?.name || '',
    warehouseLocationCode: row.warehouseLocation?.code || '',
    ownership: row.ownership,
    qualityStatus: row.qualityStatus,
    physicalStatus: row.physicalStatus,
    supplierName: row.supplierName || '',
    receiptDate: row.receiptDate instanceof Date ? row.receiptDate.toISOString() : String(row.receiptDate),
    allocations: (row.contractAllocations || []).map((a: any) => ({
      contractId: a.contractId,
      contractNumber: a.contract?.contractNumber || a.contractId,
      coilId: row.id,
      allocatedWeightKg: Number(a.allocatedWeightKg || 0),
      ownership: a.ownership,
    })),
  }));

  const coilIssueRecords: CoilIssueReturnRecord[] = (dbCoilRecords || []).map((r: any) => ({
    id: r.id,
    coilId: r.coilId,
    manufacturingOrderId: r.manufacturingOrderId || '',
    documentNumber: r.documentNumber || '',
    issuedWeightKg: Number(r.issuedWeightKg || 0),
    consumedWeightKg: Number(r.consumedWeightKg || 0),
    returnedWeightKg: Number(r.returnedWeightKg || 0),
    outstandingWeightKg: Number(r.outstandingWeightKg || 0),
    varianceWeightKg: Number(r.varianceWeightKg || 0),
    status: r.status || 'ISSUED',
    issuedAt: r.issuedAt instanceof Date ? r.issuedAt.toISOString() : String(r.issuedAt || ''),
  }));

  return computeInventoryReconciliationReport({
    source: 'POSTGRESQL',
    balances: stockData.balances,
    coils,
    coilIssueRecords,
    contracts: contractData.contracts,
    reservations,
    dbLedgerVarianceRows,
  });
}

export interface CycleCountPlanInput {
  partId: string;
  warehouseId: string;
  locationCode?: string;
  lotNumber?: string;
  ownership?: StockOwnership;
  contractId?: string;
  contractNumber?: string;
  countedQty: number;
  countedWeightKg?: number;
  reason: string;
  referenceNumber?: string;
  idempotencyKey?: string;
  user: { uid: string; displayName: string };
  balances: DetailedStockBalance[];
  parts: Part[];
  warehouses: WarehouseDefinition[];
  coils?: PhysicalCoil[];
}

export type CycleCountPlanResult =
  | {
      ok: false;
      statusCode: number;
      error: string;
    }
  | {
      ok: true;
      noVariance: true;
      bookPhysicalQty: number;
      countedQty: number;
      varianceQty: number;
      message: string;
    }
  | {
      ok: true;
      noVariance: false;
      bookPhysicalQty: number;
      countedQty: number;
      varianceQty: number;
      varianceWeightKg: number;
      adjustmentDocument: InventoryDocument;
    };

/**
 * Pure planner for physical cycle-count reconciliation.
 * Calculates variance against current ledger stock balance, blocks reductions below
 * reserved + quality-hold floor, skips no-op zero variance, and emits a standard
 * ADJUSTMENT document (MvT 701/702) for the existing transactional posting pipeline.
 */
export function buildCycleCountAdjustmentPlan(input: CycleCountPlanInput): CycleCountPlanResult {
  const countedQty = Number(input.countedQty);
  if (!Number.isFinite(countedQty) || countedQty < 0) {
    return {
      ok: false,
      statusCode: 400,
      error: 'مقدار شمارش فیزیکی باید عددی نامنفی (بزرگتر یا مساوی صفر) باشد.',
    };
  }

  const trimmedReason = String(input.reason || '').trim();
  if (trimmedReason.length < 3) {
    return {
      ok: false,
      statusCode: 400,
      error: 'ثبت علت/شرح صورتجلسه انبارگردانی (حداقل ۳ کاراکتر) الزامی است.',
    };
  }

  const part = input.parts.find(p => p.id === input.partId || p.code === input.partId);
  if (!part) {
    return {
      ok: false,
      statusCode: 404,
      error: `کالا با شناسه «${input.partId}» در کاتالوگ قطعات یافت نشد.`,
    };
  }

  const warehouse = input.warehouses.find(
    w => w.id === input.warehouseId || w.code === input.warehouseId
  );
  if (!warehouse) {
    return {
      ok: false,
      statusCode: 404,
      error: `انبار با شناسه «${input.warehouseId}» یافت نشد.`,
    };
  }

  const matchingBalances = input.balances.filter(
    b =>
      (b.partId === part.id || b.partCode === part.code) &&
      (b.warehouseId === warehouse.id || b.warehouseId === warehouse.code) &&
      (!input.lotNumber || b.lotNumber === input.lotNumber) &&
      (!input.locationCode || b.locationCode === input.locationCode) &&
      (!input.ownership || b.ownership === input.ownership) &&
      (!input.contractId || b.contractId === input.contractId)
  );

  const primaryBalance = matchingBalances[0];
  const bookPhysicalQty = round3(
    matchingBalances.reduce((sum, b) => sum + Number(b.physicalQty || 0), 0)
  );
  const reservedQty = round3(
    matchingBalances.reduce((sum, b) => sum + Number(b.reservedQty || 0), 0)
  );
  const qualityHoldQty = round3(
    matchingBalances.reduce(
      (sum, b) => sum + Number(b.qualityInspectionQty || 0) + Number(b.blockedQty || 0),
      0
    )
  );
  const protectedFloor = round3(reservedQty + qualityHoldQty);

  if (countedQty + EPS < protectedFloor) {
    return {
      ok: false,
      statusCode: 409,
      error: `مقدار شمارش‌شده (${countedQty}) کمتر از مجموع موجودی رزرو (${reservedQty}) و قرنطینه/مسدود کیفی (${qualityHoldQty}) است (حداقل مجاز: ${protectedFloor}). ابتدا رزرو یا وضعیت کیفی را تعیین تکلیف کنید.`,
    };
  }

  const varianceQty = round3(countedQty - bookPhysicalQty);
  if (Math.abs(varianceQty) <= 1e-6) {
    return {
      ok: true,
      noVariance: true,
      bookPhysicalQty,
      countedQty,
      varianceQty: 0,
      message: `موجودی شمارش‌شده برای «${part.name}» با موجودی دفتری (${bookPhysicalQty} ${part.unit}) کاملاً برابر است؛ نیاز به صدور سند تعدیل نیست.`,
    };
  }

  const weightPerUnit = part.unit === 'KG' ? 1 : Number(part.weightPerUnitKg || 1);
  const bookPhysicalKg = round3(
    matchingBalances.reduce((sum, b) => sum + Number(b.physicalKg || 0), 0)
  );
  const varianceWeightKg =
    input.countedWeightKg !== undefined && Number.isFinite(Number(input.countedWeightKg))
      ? round3(Number(input.countedWeightKg) - bookPhysicalKg)
      : round3(varianceQty * weightPerUnit);

  const resolvedOwnership: StockOwnership =
    input.ownership || primaryBalance?.ownership || 'COMPANY_OWNED';
  const resolvedContractId = input.contractId || primaryBalance?.contractId;
  const resolvedContractNumber = input.contractNumber || primaryBalance?.contractNumber;
  const resolvedLocationCode =
    input.locationCode || primaryBalance?.locationCode || warehouse.locations?.[0] || 'LOC-01';
  const resolvedLotNumber = input.lotNumber || primaryBalance?.lotNumber;
  const resolvedHeatNumber = primaryBalance?.heatNumber;

  const matchedCoil =
    resolvedLotNumber && input.coils
      ? input.coils.find(
          c =>
            c.coilId === resolvedLotNumber ||
            c.coilPackNumber === resolvedLotNumber ||
            c.id === resolvedLotNumber
        )
      : undefined;

  const now = new Date().toISOString();
  const dateStr = now.slice(2, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  const docNumber = `CNT-ADJ-${dateStr}-${rand}`;
  const movementType = varianceQty >= 0 ? '701' : '702';

  const adjustmentDocument: InventoryDocument = {
    id: `DOC-${docNumber}`,
    documentNumber: docNumber,
    documentType: 'ADJUSTMENT',
    movementType,
    movementLabel:
      varianceQty >= 0
        ? '۷۰۱ - مازاد انبارگردانی (Inventory Gain)'
        : '۷۰۲ - کسری انبارگردانی (Inventory Loss)',
    idempotencyKey: input.idempotencyKey,
    documentDate: now,
    documentStatus: 'DRAFT',
    postingStatus: 'UNPOSTED',
    warehouseId: warehouse.id,
    warehouseName: warehouse.name,
    ownership: resolvedOwnership,
    contractId: resolvedContractId,
    contractNumber: resolvedContractNumber,
    referenceType: 'CYCLE_COUNT',
    referenceNumber: input.referenceNumber || docNumber,
    adjustmentReason: `تطبیق شمارش فیزیکی (دفتری: ${bookPhysicalQty} ← شمارش‌شده: ${countedQty} | اختلاف: ${varianceQty >= 0 ? '+' : ''}${varianceQty}) — ${trimmedReason}`,
    auditNote: `صورتجلسه شمارش دوره‌ای انبارگردانی توسط ${input.user.displayName}`,
    lines: [
      {
        id: `LINE-${docNumber}-1`,
        documentId: `DOC-${docNumber}`,
        lineNumber: 1,
        partId: part.id,
        partCode: part.code,
        partName: part.name,
        physicalCoilId: matchedCoil?.id,
        coilId: matchedCoil?.coilId,
        coilPackNumber: matchedCoil?.coilPackNumber,
        lotNumber: resolvedLotNumber,
        heatNumber: resolvedHeatNumber || matchedCoil?.heatNumber,
        ownership: resolvedOwnership,
        contractId: resolvedContractId,
        contractNumber: resolvedContractNumber,
        locationCode: resolvedLocationCode,
        quantity: varianceQty,
        unit: part.unit,
        quantityKg: varianceWeightKg,
        qualityStatus: 'AVAILABLE',
        movementType,
        notes: `شمارش فیزیکی: ${countedQty} ${part.unit} (دفتری: ${bookPhysicalQty}) — ${trimmedReason}`,
      },
    ],
    totalQuantity: varianceQty,
    totalWeightKg: varianceWeightKg,
    createdByUid: input.user.uid,
    createdByName: input.user.displayName,
    createdAt: now,
    updatedAt: now,
  };

  return {
    ok: true,
    noVariance: false,
    bookPhysicalQty,
    countedQty,
    varianceQty,
    varianceWeightKg,
    adjustmentDocument,
  };
}
