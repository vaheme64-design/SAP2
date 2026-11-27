import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  RefreshCw,
  Scale,
  Search,
  Download,
  Layers,
  FileText,
  ShieldCheck,
  GitBranch,
  ArrowLeftRight,
} from 'lucide-react';
import {
  DetailedStockBalance,
  Part,
  PhysicalCoil,
  WarehouseDefinition,
} from '../../types/inventory';
import { formatNumber, formatWeightKg, toPersianDigits, formatDateTime } from '../../utils/formatters';
import { MATERIAL_FAMILY_LABELS_FA, MaterialFamily } from '../../utils/materialClassification';
import {
  FioriDynamicPage,
  FioriToolbar,
  FioriDataTable,
  FioriTableColumn,
  FioriObjectStatus,
  FioriMessageStrip,
} from '../fiori/ui';
import { EmptyState } from '../common/EmptyState';

interface ReconciliationDiscrepancy {
  id: string;
  category: string;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  entityCode: string;
  entityName: string;
  warehouseId?: string;
  expectedValue: number;
  actualValue: number;
  variance: number;
  unit: string;
  messageFa: string;
}

interface ReconciliationCheckResult {
  key: string;
  titleFa: string;
  status: 'PASS' | 'WARNING' | 'FAIL';
  checkedCount: number;
  issueCount: number;
  detailFa: string;
}

interface ContractStockSummaryRow {
  contractId: string;
  contractNumber: string;
  title: string;
  customerName: string;
  ownership: string;
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

interface ReconciliationReport {
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

interface DocumentFlowNode {
  stage: string;
  stageLabel: string;
  movementType?: string;
  docNumber: string;
  referenceNumber?: string;
  reversalOfDocNumber?: string;
  title: string;
  status: string;
  date: string;
  dateFa: string;
}

interface CoilGenealogyResult {
  coil: PhysicalCoil;
  lifecycleStatus: string;
  metrics: {
    originalWeightKg: number;
    remainingWeightKg: number;
    totalIssuedKg: number;
    totalReturnedKg: number;
    totalConsumedKg: number;
    totalVarianceKg: number;
    outstandingAtProductionKg: number;
    utilizationPercent: number;
  };
  records: any[];
  allocations: any[];
  relatedDocuments: Array<{
    id: string;
    documentNumber: string;
    documentType: string;
    documentDate: string;
    referenceNumber?: string;
  }>;
}

interface InventoryReconciliationViewProps {
  parts: Part[];
  warehouses: WarehouseDefinition[];
  balances: DetailedStockBalance[];
  coils: PhysicalCoil[];
  currentUser: {
    uid: string;
    displayName: string;
    role: string;
  };
  onRefresh: () => Promise<void>;
}

const MATERIAL_FAMILIES_ORDER: MaterialFamily[] = [
  'SHEET_METAL',
  'FASTENER',
  'RUBBER',
  'WIP',
  'FINISHED_GOOD',
];

export const InventoryReconciliationView: React.FC<InventoryReconciliationViewProps> = ({
  parts,
  warehouses,
  balances,
  coils,
  currentUser,
  onRefresh,
}) => {
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Cycle-count form state
  const [countWarehouseId, setCountWarehouseId] = useState<string>(warehouses[0]?.id || 'WH-RAW');
  const [selectedBalanceId, setSelectedBalanceId] = useState<string>('');
  const [countedQty, setCountedQty] = useState<string>('');
  const [countReason, setCountReason] = useState<string>('');
  const [countReference, setCountReference] = useState<string>('');
  const [countIdempotencyKey, setCountIdempotencyKey] = useState<string>(
    () => `CYCLE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  const [submittingCount, setSubmittingCount] = useState<boolean>(false);
  const [countFeedback, setCountFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // Traceability lookup state
  const [traceQuery, setTraceQuery] = useState<string>('');
  const [traceLoading, setTraceLoading] = useState<boolean>(false);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [traceNodes, setTraceNodes] = useState<DocumentFlowNode[] | null>(null);
  const [selectedCoilForGenealogy, setSelectedCoilForGenealogy] = useState<string>('');
  const [coilGenealogy, setCoilGenealogy] = useState<CoilGenealogyResult | null>(null);

  const loadReconciliation = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/inventory/reconciliation');
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'خطا در دریافت گزارش تطبیق انبار');
      }
      setReport(json.data);
    } catch (err: any) {
      setLoadError(err.message || 'خطا در ارتباط با سرور');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadReconciliation();
  }, [loadReconciliation]);

  const warehouseBalances = useMemo(() => {
    return balances.filter(b => b.warehouseId === countWarehouseId);
  }, [balances, countWarehouseId]);

  useEffect(() => {
    if (warehouseBalances.length > 0) {
      const stillExists = warehouseBalances.some(b => b.id === selectedBalanceId);
      if (!stillExists) {
        const first = warehouseBalances[0];
        setSelectedBalanceId(first.id);
        setCountedQty(String(first.physicalQty));
      }
    } else {
      setSelectedBalanceId('');
      setCountedQty('');
    }
  }, [warehouseBalances, selectedBalanceId]);

  const selectedBalance = useMemo(
    () => warehouseBalances.find(b => b.id === selectedBalanceId) || null,
    [warehouseBalances, selectedBalanceId]
  );

  const selectedPart = useMemo(
    () => (selectedBalance ? parts.find(p => p.id === selectedBalance.partId) : undefined),
    [parts, selectedBalance]
  );

  const bookPhysicalQty = Number(selectedBalance?.physicalQty || 0);
  const reservedQty = Number(selectedBalance?.reservedQty || 0);
  const qualityHoldQty =
    Number(selectedBalance?.qualityInspectionQty || 0) + Number(selectedBalance?.blockedQty || 0);
  const protectedFloor = Math.round((reservedQty + qualityHoldQty) * 1000) / 1000;
  const parsedCountedQty = countedQty.trim() === '' ? NaN : Number(countedQty);
  const computedVariance =
    Number.isFinite(parsedCountedQty)
      ? Math.round((parsedCountedQty - bookPhysicalQty) * 1000) / 1000
      : 0;
  const violatesFloor =
    Number.isFinite(parsedCountedQty) && parsedCountedQty + 0.01 < protectedFloor;

  const handleSelectBalance = (balanceId: string) => {
    setSelectedBalanceId(balanceId);
    const match = warehouseBalances.find(b => b.id === balanceId);
    if (match) {
      setCountedQty(String(match.physicalQty));
    }
    setCountFeedback(null);
    setCountIdempotencyKey(`CYCLE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  };

  const handleSubmitCycleCount = async (e: React.FormEvent) => {
    e.preventDefault();
    setCountFeedback(null);

    if (!selectedBalance) {
      setCountFeedback({ type: 'error', message: 'لطفاً یک ردیف موجودی از انبار انتخاب کنید.' });
      return;
    }
    if (!Number.isFinite(parsedCountedQty) || parsedCountedQty < 0) {
      setCountFeedback({ type: 'error', message: 'مقدار شمارش فیزیکی باید عددی نامنفی باشد.' });
      return;
    }
    if (violatesFloor) {
      setCountFeedback({
        type: 'error',
        message: `مقدار شمارش‌شده (${formatNumber(parsedCountedQty)}) کمتر از مجموع رزرو و قرنطینه کیفی (${formatNumber(protectedFloor)}) است.`,
      });
      return;
    }
    if (countReason.trim().length < 3) {
      setCountFeedback({
        type: 'error',
        message: 'وارد کردن علت یا شماره صورتجلسه انبارگردانی (حداقل ۳ کاراکتر) الزامی است.',
      });
      return;
    }

    setSubmittingCount(true);
    try {
      const res = await fetch('/api/inventory/reconciliation/count', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': countIdempotencyKey,
        },
        body: JSON.stringify({
          partId: selectedBalance.partId,
          warehouseId: selectedBalance.warehouseId,
          locationCode: selectedBalance.locationCode,
          lotNumber: selectedBalance.lotNumber,
          ownership: selectedBalance.ownership,
          contractId: selectedBalance.contractId,
          contractNumber: selectedBalance.contractNumber,
          countedQty: parsedCountedQty,
          reason: countReason.trim(),
          referenceNumber: countReference.trim() || undefined,
          idempotencyKey: countIdempotencyKey,
          user: {
            uid: currentUser.uid,
            displayName: currentUser.displayName,
          },
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setCountFeedback({
          type: 'error',
          message: json.error || 'خطا در ثبت صورتجلسه انبارگردانی',
        });
        return;
      }

      setCountFeedback({
        type: 'success',
        message:
          json.message ||
          (json.noVariance
            ? 'مقدار شمارش‌شده با مانده دفتری برابر است؛ نیازی به صدور سند تعدیل نبود.'
            : 'سند تعدیل انبارگردانی با موفقیت در دفتر کل ثبت شد.'),
      });
      setCountReason('');
      setCountReference('');
      setCountIdempotencyKey(`CYCLE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      await Promise.all([onRefresh(), loadReconciliation()]);
    } catch (err: any) {
      setCountFeedback({ type: 'error', message: err.message || 'خطا در ارتباط با سرور' });
    } finally {
      setSubmittingCount(false);
    }
  };

  const handleRunDocumentTrace = async (e: React.FormEvent) => {
    e.preventDefault();
    setTraceLoading(true);
    setTraceError(null);
    setCoilGenealogy(null);
    try {
      const qs = traceQuery.trim() ? `?q=${encodeURIComponent(traceQuery.trim())}` : '';
      const res = await fetch(`/api/traceability/document-flow${qs}`);
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'خطا در بازیابی جریان اسناد');
      }
      setTraceNodes(json.nodes || []);
    } catch (err: any) {
      setTraceError(err.message || 'خطا در بازیابی ردیابی اسناد');
    } finally {
      setTraceLoading(false);
    }
  };

  const handleLoadCoilGenealogy = async (coilId: string) => {
    setSelectedCoilForGenealogy(coilId);
    if (!coilId) {
      setCoilGenealogy(null);
      return;
    }
    setTraceLoading(true);
    setTraceError(null);
    try {
      const res = await fetch(`/api/inventory/coils/${encodeURIComponent(coilId)}/genealogy`);
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'خطا در دریافت شجره‌نامه کلاف');
      }
      setCoilGenealogy(json.data);
    } catch (err: any) {
      setTraceError(err.message || 'خطا در دریافت شجره‌نامه کلاف');
    } finally {
      setTraceLoading(false);
    }
  };

  const handleDownloadLedgerCsv = () => {
    const link = document.createElement('a');
    link.href = '/api/inventory/ledger?format=csv';
    link.download = `kpims-inventory-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const statusMeta = useMemo(() => {
    if (!report) {
      return {
        label: 'در حال بررسی...',
        tone: 'neutral' as const,
        Icon: RefreshCw,
      };
    }
    if (report.overallStatus === 'BALANCED') {
      return {
        label: 'متوازن و بدون مغایرت',
        tone: 'positive' as const,
        Icon: CheckCircle2,
      };
    }
    if (report.overallStatus === 'WARNINGS') {
      return {
        label: `نیازمند بررسی (${toPersianDigits(report.summary.warningCount)} هشدار)`,
        tone: 'critical' as const,
        Icon: AlertTriangle,
      };
    }
    return {
      label: `مغایرت شناسایی شد (${toPersianDigits(report.summary.errorCount)} خطا)`,
      tone: 'negative' as const,
      Icon: AlertCircle,
    };
  }, [report]);

  const StatusIcon = statusMeta.Icon;

  type FamilyRow = {
    family: MaterialFamily;
    rowCount: number;
    physicalQty: number;
    availableQty: number;
    reservedQty: number;
    qualityHoldQty: number;
  };

  const materialFamilyRows: FamilyRow[] = useMemo(() => {
    if (!report) return [];
    return MATERIAL_FAMILIES_ORDER.map(fam => {
      const row = report.summary.byMaterialFamily[fam];
      if (!row) return null;
      return {
        family: fam,
        rowCount: row.rowCount,
        physicalQty: row.physicalQty,
        availableQty: row.availableQty,
        reservedQty: row.reservedQty,
        qualityHoldQty: row.qualityHoldQty,
      };
    }).filter((r): r is FamilyRow => Boolean(r));
  }, [report]);

  const familyColumns: FioriTableColumn<FamilyRow>[] = [
    {
      key: 'family',
      header: 'گروه کالا',
      render: row => (
        <span className="font-semibold text-[var(--fiori-text-primary)]">
          {MATERIAL_FAMILY_LABELS_FA[row.family]}
        </span>
      ),
    },
    {
      key: 'rowCount',
      header: 'تعداد ردیف',
      sortValue: row => row.rowCount,
      render: row => (
        <span className="font-mono text-[var(--fiori-text-secondary)] tabular-nums">
          {toPersianDigits(row.rowCount)}
        </span>
      ),
    },
    {
      key: 'physicalQty',
      header: 'فیزیکی',
      sortValue: row => row.physicalQty,
      render: row => (
        <span className="font-mono font-semibold text-[var(--fiori-text-primary)] tabular-nums">
          {formatNumber(row.physicalQty)}
        </span>
      ),
    },
    {
      key: 'availableQty',
      header: 'قابل استفاده',
      sortValue: row => row.availableQty,
      render: row => (
        <span className="font-mono text-[var(--fiori-positive)] font-semibold tabular-nums">
          {formatNumber(row.availableQty)}
        </span>
      ),
    },
    {
      key: 'reservedQty',
      header: 'رزرو',
      sortValue: row => row.reservedQty,
      render: row => (
        <span className="font-mono text-[var(--fiori-brand)] tabular-nums">
          {formatNumber(row.reservedQty)}
        </span>
      ),
    },
    {
      key: 'qualityHoldQty',
      header: 'قرنطینه/مسدود',
      sortValue: row => row.qualityHoldQty,
      render: row => (
        <span className="font-mono text-[var(--fiori-critical)] tabular-nums">
          {formatNumber(row.qualityHoldQty)}
        </span>
      ),
    },
  ];

  const discrepancyColumns: FioriTableColumn<ReconciliationDiscrepancy>[] = [
    {
      key: 'severity',
      header: 'سطح',
      sortValue: d => (d.severity === 'ERROR' ? 0 : 1),
      render: d => (
        <FioriObjectStatus
          tone={d.severity === 'ERROR' ? 'negative' : d.severity === 'WARNING' ? 'critical' : 'info'}
          label={d.severity === 'ERROR' ? 'خطا' : d.severity === 'WARNING' ? 'هشدار' : 'اطلاع'}
        />
      ),
    },
    {
      key: 'entityCode',
      header: 'کد / شناسه',
      sortValue: d => d.entityCode,
      render: d => (
        <span className="font-mono font-semibold text-[var(--fiori-text-primary)] fiori-ltr-code">
          {d.entityCode}
        </span>
      ),
    },
    {
      key: 'expectedValue',
      header: 'مقدار مورد انتظار',
      sortValue: d => d.expectedValue,
      render: d => (
        <span className="font-mono tabular-nums">
          {formatNumber(d.expectedValue)} {d.unit}
        </span>
      ),
    },
    {
      key: 'actualValue',
      header: 'مقدار ثبت‌شده',
      sortValue: d => d.actualValue,
      render: d => (
        <span className="font-mono tabular-nums">
          {formatNumber(d.actualValue)} {d.unit}
        </span>
      ),
    },
    {
      key: 'variance',
      header: 'اختلاف',
      sortValue: d => d.variance,
      render: d => (
        <span className="font-mono font-semibold text-[var(--fiori-negative)] tabular-nums">
          {d.variance >= 0 ? '+' : ''}
          {formatNumber(d.variance)} {d.unit}
        </span>
      ),
    },
    {
      key: 'messageFa',
      header: 'توضیح',
      render: d => <span className="text-[var(--fiori-text-primary)]">{d.messageFa}</span>,
    },
  ];

  const contractColumns: FioriTableColumn<ContractStockSummaryRow>[] = [
    {
      key: 'contractNumber',
      header: 'شماره قرارداد',
      sortValue: row => row.contractNumber,
      render: row => (
        <div>
          <div className="font-mono font-semibold text-[var(--fiori-text-primary)] fiori-ltr-code">
            {row.contractNumber}
          </div>
          <div className="text-[10px] text-[var(--fiori-text-secondary)]">{row.title}</div>
        </div>
      ),
    },
    {
      key: 'ownership',
      header: 'مشتری / مالکیت',
      sortValue: row => row.customerName,
      render: row => (
        <div>
          <div className="text-[var(--fiori-text-primary)]">{row.customerName}</div>
          <div className="text-[10px] text-[var(--fiori-text-secondary)]">
            {row.ownership === 'SAPCO_SUPPLIER_OWNED' ? 'امانی ساپکو' : 'ملکی شرکت'}
          </div>
        </div>
      ),
    },
    {
      key: 'totalReceivedKg',
      header: 'دریافتی (kg)',
      sortValue: row => row.totalReceivedKg,
      render: row => <span className="font-mono tabular-nums">{formatWeightKg(row.totalReceivedKg)}</span>,
    },
    {
      key: 'totalConsumedKg',
      header: 'مصرفی (kg)',
      sortValue: row => row.totalConsumedKg,
      render: row => <span className="font-mono tabular-nums">{formatWeightKg(row.totalConsumedKg)}</span>,
    },
    {
      key: 'ledgerClosingBalanceKg',
      header: 'مانده دفتر امانی',
      sortValue: row => row.ledgerClosingBalanceKg,
      render: row => (
        <span className="font-mono font-semibold text-[var(--fiori-text-primary)] tabular-nums">
          {formatWeightKg(row.ledgerClosingBalanceKg)}
        </span>
      ),
    },
    {
      key: 'warehouseStockKg',
      header: 'موجودی انبار',
      sortValue: row => row.warehouseStockKg,
      render: row => (
        <span className="font-mono font-semibold text-[var(--fiori-brand)] tabular-nums">
          {formatWeightKg(row.warehouseStockKg)}
        </span>
      ),
    },
    {
      key: 'split',
      header: 'آزاد / رزرو / قرنطینه',
      render: row => (
        <span className="font-mono text-[11px] tabular-nums whitespace-nowrap">
          <span className="text-[var(--fiori-positive)]">{formatNumber(row.availableStockKg)}</span> /{' '}
          <span className="text-[var(--fiori-brand)]">{formatNumber(row.reservedStockKg)}</span> /{' '}
          <span className="text-[var(--fiori-critical)]">{formatNumber(row.qualityHoldStockKg)}</span>
        </span>
      ),
    },
    {
      key: 'activeCoilsCount',
      header: 'کلاف فعال',
      sortValue: row => row.activeCoilsCount,
      render: row => (
        <span className="font-mono text-[11px] tabular-nums whitespace-nowrap">
          {toPersianDigits(row.activeCoilsCount)} رول ({formatWeightKg(row.activeCoilsRemainingKg)})
        </span>
      ),
    },
    {
      key: 'status',
      header: 'وضعیت',
      sortValue: row => row.status,
      render: row => (
        <FioriObjectStatus
          tone={row.status === 'BALANCED' ? 'positive' : 'critical'}
          label={
            row.status === 'BALANCED'
              ? 'متوازن'
              : `اختلاف ${row.varianceKg >= 0 ? '+' : ''}${formatNumber(row.varianceKg)} kg`
          }
        />
      ),
    },
  ];

  const kpiStrip = report ? (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3 shadow-[var(--fiori-shadow-card)]">
        <div className="text-[11px] text-[var(--fiori-text-secondary)]">موجودی فیزیکی کل</div>
        <div className="text-sm font-bold text-[var(--fiori-text-primary)] mt-1 font-mono tabular-nums">
          {formatWeightKg(report.summary.totalPhysicalKg)}
        </div>
        <div className="text-[10px] text-[var(--fiori-text-muted)] mt-0.5 tabular-nums">
          {toPersianDigits(report.summary.totalStockRows)} ردیف موجودی
        </div>
      </div>

      <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3 shadow-[var(--fiori-shadow-card)]">
        <div className="text-[11px] text-[var(--fiori-text-secondary)]">قابل استفاده (Available ATP)</div>
        <div className="text-sm font-bold text-[var(--fiori-positive)] mt-1 font-mono tabular-nums">
          {formatWeightKg(report.summary.totalAvailableKg)}
        </div>
        <div className="text-[10px] text-[var(--fiori-text-muted)] mt-0.5">آزاد منهای رزرو فعال</div>
      </div>

      <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3 shadow-[var(--fiori-shadow-card)]">
        <div className="text-[11px] text-[var(--fiori-text-secondary)]">رزرو خطوط تولید</div>
        <div className="text-sm font-bold text-[var(--fiori-brand)] mt-1 font-mono tabular-nums">
          {formatWeightKg(report.summary.totalReservedKg)}
        </div>
        <div className="text-[10px] text-[var(--fiori-text-muted)] mt-0.5 tabular-nums">
          {toPersianDigits(report.summary.activeReservationsCount)} رزرو فعال
        </div>
      </div>

      <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3 shadow-[var(--fiori-shadow-card)]">
        <div className="text-[11px] text-[var(--fiori-text-secondary)]">قرنطینه و مسدود کیفی</div>
        <div className="text-sm font-bold text-[var(--fiori-critical)] mt-1 font-mono tabular-nums">
          {formatWeightKg(report.summary.totalQualityHoldKg)}
        </div>
        <div className="text-[10px] text-[var(--fiori-text-muted)] mt-0.5 tabular-nums">
          QI: {formatWeightKg(report.summary.totalQualityInspectionKg)} · مسدود:{' '}
          {formatWeightKg(report.summary.totalBlockedKg)}
        </div>
      </div>

      <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3 shadow-[var(--fiori-shadow-card)]">
        <div className="text-[11px] text-[var(--fiori-text-secondary)]">مانده کلاف‌های ورق فعال</div>
        <div className="text-sm font-bold text-[var(--fiori-text-primary)] mt-1 font-mono tabular-nums">
          {formatWeightKg(report.summary.activeCoilsRemainingKg)}
        </div>
        <div className="text-[10px] text-[var(--fiori-text-muted)] mt-0.5 tabular-nums">
          از مجموع {toPersianDigits(report.summary.totalPhysicalCoils)} کلاف
        </div>
      </div>

      <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3 shadow-[var(--fiori-shadow-card)]">
        <div className="text-[11px] text-[var(--fiori-text-secondary)]">مغایرت‌ها و هشدارها</div>
        <div
          className={`text-sm font-bold mt-1 font-mono tabular-nums ${
            report.summary.errorCount > 0
              ? 'text-[var(--fiori-negative)]'
              : report.summary.warningCount > 0
              ? 'text-[var(--fiori-critical)]'
              : 'text-[var(--fiori-positive)]'
          }`}
        >
          {toPersianDigits(report.summary.errorCount)} خطا / {toPersianDigits(report.summary.warningCount)} هشدار
        </div>
        <div className="text-[10px] text-[var(--fiori-text-muted)] mt-0.5 tabular-nums">
          {toPersianDigits(report.summary.activeContractsCount)} قرارداد فعال
        </div>
      </div>
    </div>
  ) : undefined;

  return (
    <FioriDynamicPage
      title="تطبیق چهارطرفه موجودی، انبارگردانی دوره‌ای و ردیابی مواد"
      subtitle={`کنترل هم‌زمان دفتر کل اسناد (Ledger)، تفکیک موجودی آزاد/رزرو/قرنطینه، تراز جرمی کلاف‌های ورق و حساب امانی قراردادهای ساپکو${
        report?.generatedAt ? ` · آخرین بررسی: ${formatDateTime(report.generatedAt)}` : ''
      }`}
      status={
        <FioriObjectStatus
          tone={statusMeta.tone}
          icon={<StatusIcon className="w-3.5 h-3.5" />}
          label={statusMeta.label}
        />
      }
      collapsibleFilters={false}
      kpiStrip={kpiStrip}
      headerActions={
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <button
            type="button"
            onClick={handleDownloadLedgerCsv}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <Download className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
            <span>خروجی اکسل کاردکس (CSV)</span>
          </button>
          <button
            type="button"
            onClick={async () => {
              await Promise.all([onRefresh(), loadReconciliation()]);
            }}
            disabled={loading}
            className="sap-btn-emphasized flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer disabled:opacity-60"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>بروزرسانی تطبیق</span>
          </button>
        </div>
      }
    >
      {loadError && (
        <FioriMessageStrip tone="error">
          {loadError}
        </FioriMessageStrip>
      )}

      {/* Material Family Breakdown & Automated 5-Check Audit */}
      {report && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* 5 Automated Integrity Checks */}
          <div className="sap-card overflow-hidden">
            <FioriToolbar
              variant="section"
              title="کنترل‌های خودکار یکپارچگی انبار"
              subtitle="۵ کنترل اصلی دفتر کل"
              startContent={<ShieldCheck className="w-4 h-4 text-[var(--fiori-brand)] shrink-0" />}
            />
            <div className="p-3.5 space-y-2">
              {report.checks.map(check => (
                <div
                  key={check.key}
                  className="p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-subtle)] bg-[var(--fiori-bg-subtle)] flex items-start justify-between gap-2.5"
                >
                  <div className="space-y-0.5">
                    <div className="text-xs font-semibold text-[var(--fiori-text-primary)]">{check.titleFa}</div>
                    <div className="text-[11px] text-[var(--fiori-text-secondary)]">{check.detailFa}</div>
                  </div>
                  <FioriObjectStatus
                    tone={
                      check.status === 'PASS'
                        ? 'positive'
                        : check.status === 'WARNING'
                        ? 'critical'
                        : 'negative'
                    }
                    label={
                      check.status === 'PASS'
                        ? 'متوازن'
                        : check.status === 'WARNING'
                        ? `هشدار (${toPersianDigits(check.issueCount)})`
                        : `مغایرت (${toPersianDigits(check.issueCount)})`
                    }
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Material Family Breakdown */}
          <FioriDataTable<FamilyRow>
            data={materialFamilyRows}
            columns={familyColumns}
            rowKey={row => row.family}
            compact
            toolbar={
              <FioriToolbar
                variant="table"
                title="تفکیک موجودی به تفکیک گروه کالا"
                subtitle="ورق، پیچ‌ومهره، لاستیک، WIP، محصول"
                startContent={<Layers className="w-4 h-4 text-[var(--fiori-brand)] shrink-0" />}
              />
            }
            emptyState={<EmptyState variant="NO_DATA" compact />}
          />
        </div>
      )}

      {/* Discrepancy Table (when any discrepancy exists) */}
      {report && report.discrepancies.length > 0 && (
        <FioriDataTable<ReconciliationDiscrepancy>
          data={report.discrepancies}
          columns={discrepancyColumns}
          rowKey={d => d.id}
          compact
          toolbar={
            <FioriToolbar
              variant="table"
              title="فهرست مغایرت‌ها و هشدارهای نیازمند اقدام"
              count={report.discrepancies.length}
              countLabel="مورد"
              startContent={<AlertTriangle className="w-4 h-4 text-[var(--fiori-critical)] shrink-0" />}
            />
          }
        />
      )}

      {/* Contract-Level SAPCO Consignment Reconciliation Table */}
      {report && report.contractSummaries.length > 0 && (
        <FioriDataTable<ContractStockSummaryRow>
          data={report.contractSummaries}
          columns={contractColumns}
          rowKey={row => row.contractId}
          compact
          toolbar={
            <FioriToolbar
              variant="table"
              title="تطبیق موجودی به تفکیک قرارداد و حساب امانی ساپکو"
              count={report.contractSummaries.length}
              countLabel="قرارداد"
              startContent={<FileText className="w-4 h-4 text-[var(--fiori-brand)] shrink-0" />}
            />
          }
        />
      )}

      {/* Physical Cycle-Count Reconciliation Form + Traceability Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Section 2: Physical Cycle-Count Form */}
        <form onSubmit={handleSubmitCycleCount} className="sap-card overflow-hidden">
          <FioriToolbar
            variant="section"
            title="ثبت شمارش فیزیکی و تعدیل انبارگردانی (کد حرکت ۷۰۱ / ۷۰۲)"
            subtitle="تراکنشی و دارای Idempotency"
            startContent={<Scale className="w-4 h-4 text-[var(--fiori-brand)] shrink-0" />}
          />

          <div className="p-4 space-y-3">
            {countFeedback && (
              <FioriMessageStrip
                tone={countFeedback.type === 'success' ? 'success' : 'error'}
                onClose={() => setCountFeedback(null)}
                compact
              >
                {countFeedback.message}
              </FioriMessageStrip>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-[var(--fiori-text-primary)] mb-1">
                  انتخاب انبار
                </label>
                <select
                  value={countWarehouseId}
                  onChange={e => setCountWarehouseId(e.target.value)}
                  className="w-full bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1.5 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)]"
                >
                  {warehouses.map(w => (
                    <option key={w.id} value={w.id}>
                      {w.name} ({w.id})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-[var(--fiori-text-primary)] mb-1">
                  کالا / بچ / کلاف در انبار
                </label>
                <select
                  value={selectedBalanceId}
                  onChange={e => handleSelectBalance(e.target.value)}
                  className="w-full bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1.5 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)]"
                >
                  {warehouseBalances.length === 0 ? (
                    <option value="">ردیفی در این انبار ثبت نشده است</option>
                  ) : (
                    warehouseBalances.map(b => (
                      <option key={b.id} value={b.id}>
                        {b.partCode} — {b.partName}
                        {b.lotNumber ? ` · بچ ${b.lotNumber}` : ''}
                        {b.contractNumber ? ` · قرارداد ${b.contractNumber}` : ''}
                      </option>
                    ))
                  )}
                </select>
              </div>
            </div>

            {selectedBalance && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-2.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-info-bg)] border border-[var(--fiori-info-border)] text-[11px]">
                <div>
                  <div className="text-[var(--fiori-text-secondary)]">مانده دفتری (فیزیکی)</div>
                  <div className="font-mono font-bold text-[var(--fiori-text-primary)] mt-0.5 tabular-nums">
                    {formatNumber(bookPhysicalQty)} {selectedBalance.unit}
                  </div>
                </div>
                <div>
                  <div className="text-[var(--fiori-text-secondary)]">رزرو فعال</div>
                  <div className="font-mono font-semibold text-[var(--fiori-brand)] mt-0.5 tabular-nums">
                    {formatNumber(reservedQty)} {selectedBalance.unit}
                  </div>
                </div>
                <div>
                  <div className="text-[var(--fiori-text-secondary)]">قرنطینه / مسدود</div>
                  <div className="font-mono font-semibold text-[var(--fiori-critical)] mt-0.5 tabular-nums">
                    {formatNumber(qualityHoldQty)} {selectedBalance.unit}
                  </div>
                </div>
                <div>
                  <div className="text-[var(--fiori-text-secondary)]">حداقل مجاز شمارش</div>
                  <div className="font-mono font-bold text-[var(--fiori-text-primary)] mt-0.5 tabular-nums">
                    {formatNumber(protectedFloor)} {selectedBalance.unit}
                  </div>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-[var(--fiori-text-primary)] mb-1">
                  مقدار شمارش فیزیکی ({selectedPart?.unit || selectedBalance?.unit || 'واحد'})
                </label>
                <input
                  type="number"
                  step="any"
                  min={0}
                  value={countedQty}
                  onChange={e => setCountedQty(e.target.value)}
                  placeholder="مقدار واقعی شمارش‌شده..."
                  className="w-full bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1.5 text-xs font-mono text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)]"
                  required
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-[var(--fiori-text-primary)] mb-1">
                  شماره صورتجلسه / مرجع (اختیاری)
                </label>
                <input
                  type="text"
                  value={countReference}
                  onChange={e => setCountReference(e.target.value)}
                  placeholder="مثلاً CC-1404-08-01"
                  className="w-full bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1.5 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)]"
                />
              </div>
            </div>

            {selectedBalance && Number.isFinite(parsedCountedQty) && (
              <FioriMessageStrip
                tone={
                  violatesFloor
                    ? 'error'
                    : computedVariance === 0
                    ? 'info'
                    : computedVariance > 0
                    ? 'success'
                    : 'warning'
                }
                compact
              >
                <div className="flex items-center justify-between gap-2 w-full">
                  <span>
                    {violatesFloor
                      ? 'خطای سقف رزرو/قرنطینه: شمارش کمتر از حداقل محافظت‌شده است.'
                      : computedVariance === 0
                      ? 'اختلاف صفر است (بدون صدور سند تعدیل).'
                      : computedVariance > 0
                      ? 'سند مازاد انبارگردانی (MvT 701) صادر خواهد شد:'
                      : 'سند کسری انبارگردانی (MvT 702) صادر خواهد شد:'}
                  </span>
                  <span className="font-mono font-bold tabular-nums shrink-0">
                    {computedVariance >= 0 ? '+' : ''}
                    {formatNumber(computedVariance)} {selectedBalance.unit}
                  </span>
                </div>
              </FioriMessageStrip>
            )}

            <div>
              <label className="block text-[11px] font-semibold text-[var(--fiori-text-primary)] mb-1">
                شرح و علت تعدیل شمارش فیزیکی (الزامی)
              </label>
              <input
                type="text"
                value={countReason}
                onChange={e => setCountReason(e.target.value)}
                placeholder="شرح دقیق شمارش انبارگردانی، باسکول یا صورتجلسه کنترل..."
                className="w-full bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1.5 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)]"
                required
              />
            </div>

            <div className="flex items-center justify-end pt-1">
              <button
                type="submit"
                disabled={submittingCount || !selectedBalance || violatesFloor}
                className="sap-btn-emphasized px-4 py-1.5 text-xs cursor-pointer disabled:opacity-50"
              >
                {submittingCount ? 'در حال ثبت در دفتر کل...' : 'ثبت نتیجه شمارش و تعدیل دفتر کل'}
              </button>
            </div>
          </div>
        </form>

        {/* Section 3: Material Traceability & Coil Genealogy */}
        <div className="sap-card overflow-hidden">
          <FioriToolbar
            variant="section"
            title="ردیابی زنجیره اسناد و شجره‌نامه کلاف (Traceability)"
            startContent={<GitBranch className="w-4 h-4 text-[var(--fiori-brand)] shrink-0" />}
          />

          <div className="p-4 space-y-3">
            {/* Search by document / MO / part / order */}
            <form onSubmit={handleRunDocumentTrace} className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 text-[var(--fiori-text-secondary)] absolute right-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={traceQuery}
                  onChange={e => setTraceQuery(e.target.value)}
                  placeholder="شماره سند، دستور ساخت (MO)، سفارش مشتری یا کد کالا..."
                  className="w-full pr-8 pl-2.5 py-1.5 bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)]"
                />
              </div>
              <button
                type="submit"
                disabled={traceLoading}
                className="sap-btn-standard px-3 py-1.5 text-xs cursor-pointer whitespace-nowrap"
              >
                جستجوی زنجیره اسناد
              </button>
            </form>

            {/* Direct coil genealogy picker */}
            <div className="flex items-center gap-2">
              <ArrowLeftRight className="w-3.5 h-3.5 text-[var(--fiori-text-secondary)] shrink-0" />
              <select
                value={selectedCoilForGenealogy}
                onChange={e => handleLoadCoilGenealogy(e.target.value)}
                className="flex-1 bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1.5 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)]"
              >
                <option value="">مشاهده شجره‌نامه کامل یک کلاف فیزیکی ورق...</option>
                {coils.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.coilId} · {c.materialGrade} ({toPersianDigits(c.thicknessMm)}mm) · مانده{' '}
                    {formatWeightKg(c.remainingWeightKg)}
                  </option>
                ))}
              </select>
            </div>

            {traceError && (
              <FioriMessageStrip tone="error" compact>
                {traceError}
              </FioriMessageStrip>
            )}

            {/* Coil Genealogy View */}
            {coilGenealogy && (
              <div className="p-3 rounded-[var(--fiori-radius-md)] border border-[var(--fiori-info-border)] bg-[var(--fiori-info-bg)]/50 space-y-2.5">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="text-xs font-bold text-[var(--fiori-text-primary)]">
                    شجره‌نامه کلاف <span className="fiori-ltr-code">{coilGenealogy.coil.coilId}</span> (
                    {coilGenealogy.coil.materialGrade})
                  </div>
                  <FioriObjectStatus
                    tone="info"
                    label={`وضعیت چرخه: ${coilGenealogy.lifecycleStatus}`}
                  />
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] tabular-nums">
                  <div className="bg-[var(--fiori-bg-surface)] p-2 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)]">
                    <div className="text-[var(--fiori-text-secondary)]">وزن اولیه</div>
                    <div className="font-mono font-semibold">
                      {formatWeightKg(coilGenealogy.metrics.originalWeightKg)}
                    </div>
                  </div>
                  <div className="bg-[var(--fiori-bg-surface)] p-2 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)]">
                    <div className="text-[var(--fiori-text-secondary)]">جمع حواله</div>
                    <div className="font-mono font-semibold text-[var(--fiori-brand)]">
                      {formatWeightKg(coilGenealogy.metrics.totalIssuedKg)}
                    </div>
                  </div>
                  <div className="bg-[var(--fiori-bg-surface)] p-2 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)]">
                    <div className="text-[var(--fiori-text-secondary)]">ته‌کلاف برگشتی</div>
                    <div className="font-mono font-semibold text-[var(--fiori-positive)]">
                      {formatWeightKg(coilGenealogy.metrics.totalReturnedKg)}
                    </div>
                  </div>
                  <div className="bg-[var(--fiori-bg-surface)] p-2 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)]">
                    <div className="text-[var(--fiori-text-secondary)]">مانده فعلی</div>
                    <div className="font-mono font-bold text-[var(--fiori-text-primary)]">
                      {formatWeightKg(coilGenealogy.metrics.remainingWeightKg)}
                    </div>
                  </div>
                </div>
                <div className="text-[11px] text-[var(--fiori-text-secondary)]">
                  اسناد مرتبط ثبت‌شده ({toPersianDigits(coilGenealogy.relatedDocuments.length)} سند):
                </div>
                <div className="max-h-40 overflow-y-auto space-y-1">
                  {coilGenealogy.relatedDocuments.map(doc => (
                    <div
                      key={doc.id}
                      className="flex items-center justify-between bg-[var(--fiori-bg-surface)] px-2.5 py-1.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] text-[11px]"
                    >
                      <span className="font-mono font-semibold text-[var(--fiori-text-primary)] fiori-ltr-code">
                        {doc.documentNumber}
                      </span>
                      <span className="text-[var(--fiori-text-secondary)]">{doc.documentType}</span>
                      <span className="font-mono text-[10px] text-[var(--fiori-text-muted)]">
                        {formatDateTime(doc.documentDate)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Document Flow Timeline */}
            {traceNodes && !coilGenealogy && (
              <div className="space-y-1.5 max-h-64 overflow-y-auto">
                {traceNodes.length === 0 ? (
                  <EmptyState
                    variant="SEARCH_NO_MATCH"
                    compact
                    title="سندی با این عبارت در زنجیره ردیابی یافت نشد"
                    description="شماره سند، کد کالا یا دستور ساخت دیگری را جستجو کنید."
                  />
                ) : (
                  traceNodes.map((node, idx) => (
                    <div
                      key={`${node.docNumber}-${idx}`}
                      className="p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-subtle)] bg-[var(--fiori-bg-subtle)] flex items-start justify-between gap-2 text-xs"
                    >
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-mono font-semibold text-[var(--fiori-brand)] fiori-ltr-code">
                            {node.docNumber}
                          </span>
                          <FioriObjectStatus tone="neutral" label={node.stageLabel} size="sm" />
                          {node.movementType && (
                            <span className="font-mono text-[10px] text-[var(--fiori-text-secondary)]">
                              MvT {node.movementType}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-[var(--fiori-text-primary)]">{node.title}</div>
                      </div>
                      <span className="font-mono text-[10px] text-[var(--fiori-text-muted)] whitespace-nowrap">
                        {node.dateFa}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </FioriDynamicPage>
  );
};
