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
        className: 'bg-slate-100 text-slate-700 border-slate-200',
        Icon: RefreshCw,
      };
    }
    if (report.overallStatus === 'BALANCED') {
      return {
        label: 'متوازن و بدون مغایرت',
        className: 'bg-emerald-50 text-emerald-800 border-emerald-200',
        Icon: CheckCircle2,
      };
    }
    if (report.overallStatus === 'WARNINGS') {
      return {
        label: `نیازمند بررسی (${toPersianDigits(report.summary.warningCount)} هشدار)`,
        className: 'bg-amber-50 text-amber-800 border-amber-200',
        Icon: AlertTriangle,
      };
    }
    return {
      label: `مغایرت شناسایی شد (${toPersianDigits(report.summary.errorCount)} خطا)`,
      className: 'bg-rose-50 text-rose-800 border-rose-200',
      Icon: AlertCircle,
    };
  }, [report]);

  const StatusIcon = statusMeta.Icon;

  return (
    <div className="space-y-4">
      {/* Header Bar */}
      <div className="sap-card p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <ShieldCheck className="w-5 h-5 text-[#0070F2]" />
            <h2 className="text-sm font-bold text-[#1D2D3E]">
              تطبیق چهارطرفه موجودی، انبارگردانی دوره‌ای و ردیابی مواد
            </h2>
            <span
              className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded border text-[11px] font-semibold ${statusMeta.className}`}
            >
              <StatusIcon className="w-3.5 h-3.5" />
              {statusMeta.label}
            </span>
          </div>
          <p className="text-xs text-[#556B82]">
            کنترل هم‌زمان دفتر کل اسناد (Ledger)، تفکیک موجودی آزاد/رزرو/قرنطینه، تراز جرمی کلاف‌های ورق و حساب امانی قراردادهای ساپکو
            {report?.generatedAt ? ` · آخرین بررسی: ${formatDateTime(report.generatedAt)}` : ''}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleDownloadLedgerCsv}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <Download className="w-3.5 h-3.5 text-[#0070F2]" />
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
      </div>

      {loadError && (
        <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{loadError}</span>
        </div>
      )}

      {/* KPI Strip: Reliable Total / Available / Reserved / Quality-Hold / Coils / Discrepancies */}
      {report && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="sap-card p-3">
            <div className="text-[11px] text-[#556B82]">موجودی فیزیکی کل</div>
            <div className="text-sm font-bold text-[#1D2D3E] mt-1 font-mono tabular-nums">
              {formatWeightKg(report.summary.totalPhysicalKg)}
            </div>
            <div className="text-[10px] text-[#666666] mt-0.5">
              {toPersianDigits(report.summary.totalStockRows)} ردیف موجودی
            </div>
          </div>

          <div className="sap-card p-3 border-r-2 border-r-[#107e3e]">
            <div className="text-[11px] text-[#556B82]">قابل استفاده (Available ATP)</div>
            <div className="text-sm font-bold text-[#107e3e] mt-1 font-mono tabular-nums">
              {formatWeightKg(report.summary.totalAvailableKg)}
            </div>
            <div className="text-[10px] text-[#666666] mt-0.5">آزاد منهای رزرو فعال</div>
          </div>

          <div className="sap-card p-3 border-r-2 border-r-[#0070F2]">
            <div className="text-[11px] text-[#556B82]">رزرو خطوط تولید</div>
            <div className="text-sm font-bold text-[#0070F2] mt-1 font-mono tabular-nums">
              {formatWeightKg(report.summary.totalReservedKg)}
            </div>
            <div className="text-[10px] text-[#666666] mt-0.5">
              {toPersianDigits(report.summary.activeReservationsCount)} رزرو فعال
            </div>
          </div>

          <div className="sap-card p-3 border-r-2 border-r-[#E9730C]">
            <div className="text-[11px] text-[#556B82]">قرنطینه و مسدود کیفی</div>
            <div className="text-sm font-bold text-[#E9730C] mt-1 font-mono tabular-nums">
              {formatWeightKg(report.summary.totalQualityHoldKg)}
            </div>
            <div className="text-[10px] text-[#666666] mt-0.5">
              QI: {formatWeightKg(report.summary.totalQualityInspectionKg)} · مسدود:{' '}
              {formatWeightKg(report.summary.totalBlockedKg)}
            </div>
          </div>

          <div className="sap-card p-3">
            <div className="text-[11px] text-[#556B82]">مانده کلاف‌های ورق فعال</div>
            <div className="text-sm font-bold text-[#1D2D3E] mt-1 font-mono tabular-nums">
              {formatWeightKg(report.summary.activeCoilsRemainingKg)}
            </div>
            <div className="text-[10px] text-[#666666] mt-0.5">
              از مجموع {toPersianDigits(report.summary.totalPhysicalCoils)} کلاف
            </div>
          </div>

          <div
            className={`sap-card p-3 border-r-2 ${
              report.summary.errorCount > 0
                ? 'border-r-[#BB0000]'
                : report.summary.warningCount > 0
                ? 'border-r-[#E9730C]'
                : 'border-r-[#107e3e]'
            }`}
          >
            <div className="text-[11px] text-[#556B82]">مغایرت‌ها و هشدارها</div>
            <div className="text-sm font-bold text-[#1D2D3E] mt-1 font-mono tabular-nums">
              {toPersianDigits(report.summary.errorCount)} خطا / {toPersianDigits(report.summary.warningCount)} هشدار
            </div>
            <div className="text-[10px] text-[#666666] mt-0.5">
              {toPersianDigits(report.summary.activeContractsCount)} قرارداد فعال
            </div>
          </div>
        </div>
      )}

      {/* Material Family Breakdown & Automated 5-Check Audit */}
      {report && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* 5 Automated Integrity Checks */}
          <div className="sap-card p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-[#e8e8e8] pb-2">
              <h3 className="text-xs font-bold text-[#1D2D3E] flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-[#0070F2]" />
                کنترل‌های خودکار یکپارچگی انبار
              </h3>
              <span className="text-[11px] text-[#556B82]">۵ کنترل اصلی دفتر کل</span>
            </div>
            <div className="space-y-2">
              {report.checks.map(check => (
                <div
                  key={check.key}
                  className="p-2.5 rounded border border-[#e5e7eb] bg-[#fafafa] flex items-start justify-between gap-2.5"
                >
                  <div className="space-y-0.5">
                    <div className="text-xs font-semibold text-[#1D2D3E]">{check.titleFa}</div>
                    <div className="text-[11px] text-[#556B82]">{check.detailFa}</div>
                  </div>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-semibold shrink-0 border ${
                      check.status === 'PASS'
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : check.status === 'WARNING'
                        ? 'bg-amber-50 text-amber-800 border-amber-200'
                        : 'bg-rose-50 text-rose-700 border-rose-200'
                    }`}
                  >
                    {check.status === 'PASS'
                      ? 'متوازن'
                      : check.status === 'WARNING'
                      ? `هشدار (${toPersianDigits(check.issueCount)})`
                      : `مغایرت (${toPersianDigits(check.issueCount)})`}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Material Family Breakdown */}
          <div className="sap-card p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-[#e8e8e8] pb-2">
              <h3 className="text-xs font-bold text-[#1D2D3E] flex items-center gap-1.5">
                <Layers className="w-4 h-4 text-[#0070F2]" />
                تفکیک موجودی به تفکیک گروه کالا (ورق، پیچ‌ومهره، لاستیک، WIP، محصول)
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs sap-table-compact">
                <thead className="bg-[#f5f5f5] text-[#333333] border-b border-[#d9d9d9]">
                  <tr>
                    <th className="py-1.5 px-2 font-semibold">گروه کالا</th>
                    <th className="py-1.5 px-2 font-semibold">تعداد ردیف</th>
                    <th className="py-1.5 px-2 font-semibold">فیزیکی</th>
                    <th className="py-1.5 px-2 font-semibold">قابل استفاده</th>
                    <th className="py-1.5 px-2 font-semibold">رزرو</th>
                    <th className="py-1.5 px-2 font-semibold">قرنطینه/مسدود</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#e8e8e8] bg-white tabular-nums">
                  {MATERIAL_FAMILIES_ORDER.map(fam => {
                    const row = report.summary.byMaterialFamily[fam];
                    if (!row) return null;
                    return (
                      <tr key={fam} className="hover:bg-[#f8fafc]">
                        <td className="py-1.5 px-2 font-semibold text-[#1D2D3E]">
                          {MATERIAL_FAMILY_LABELS_FA[fam]}
                        </td>
                        <td className="py-1.5 px-2 font-mono text-[#556B82]">
                          {toPersianDigits(row.rowCount)}
                        </td>
                        <td className="py-1.5 px-2 font-mono font-semibold text-[#1D2D3E]">
                          {formatNumber(row.physicalQty)}
                        </td>
                        <td className="py-1.5 px-2 font-mono text-[#107e3e] font-semibold">
                          {formatNumber(row.availableQty)}
                        </td>
                        <td className="py-1.5 px-2 font-mono text-[#0070F2]">
                          {formatNumber(row.reservedQty)}
                        </td>
                        <td className="py-1.5 px-2 font-mono text-[#E9730C]">
                          {formatNumber(row.qualityHoldQty)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Discrepancy Table (when any discrepancy exists) */}
      {report && report.discrepancies.length > 0 && (
        <div className="sap-card p-4 space-y-2.5 border border-amber-200">
          <h3 className="text-xs font-bold text-[#1D2D3E] flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 text-[#E9730C]" />
            فهرست مغایرت‌ها و هشدارهای نیازمند اقدام ({toPersianDigits(report.discrepancies.length)})
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs sap-table-compact">
              <thead className="bg-[#fff8ec] text-[#333333] border-b border-amber-200">
                <tr>
                  <th className="py-1.5 px-2 font-semibold">سطح</th>
                  <th className="py-1.5 px-2 font-semibold">کد / شناسه</th>
                  <th className="py-1.5 px-2 font-semibold">مقدار مورد انتظار</th>
                  <th className="py-1.5 px-2 font-semibold">مقدار ثبت‌شده</th>
                  <th className="py-1.5 px-2 font-semibold">اختلاف</th>
                  <th className="py-1.5 px-2 font-semibold">توضیح</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e8e8e8] bg-white tabular-nums">
                {report.discrepancies.map(d => (
                  <tr key={d.id}>
                    <td className="py-1.5 px-2 whitespace-nowrap">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                          d.severity === 'ERROR'
                            ? 'bg-rose-50 text-rose-700'
                            : 'bg-amber-50 text-amber-800'
                        }`}
                      >
                        {d.severity === 'ERROR' ? 'خطا' : 'هشدار'}
                      </span>
                    </td>
                    <td className="py-1.5 px-2 font-mono font-semibold text-[#1D2D3E]">
                      {d.entityCode}
                    </td>
                    <td className="py-1.5 px-2 font-mono">
                      {formatNumber(d.expectedValue)} {d.unit}
                    </td>
                    <td className="py-1.5 px-2 font-mono">
                      {formatNumber(d.actualValue)} {d.unit}
                    </td>
                    <td className="py-1.5 px-2 font-mono font-semibold text-rose-700">
                      {d.variance >= 0 ? '+' : ''}
                      {formatNumber(d.variance)} {d.unit}
                    </td>
                    <td className="py-1.5 px-2 text-[#333333]">{d.messageFa}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Contract-Level SAPCO Consignment Reconciliation Table */}
      {report && report.contractSummaries.length > 0 && (
        <div className="sap-card p-4 space-y-3">
          <div className="flex items-center justify-between border-b border-[#e8e8e8] pb-2">
            <h3 className="text-xs font-bold text-[#1D2D3E] flex items-center gap-1.5">
              <FileText className="w-4 h-4 text-[#0070F2]" />
              تطبیق موجودی به تفکیک قرارداد و حساب امانی ساپکو
            </h3>
            <span className="text-[11px] text-[#556B82]">
              {toPersianDigits(report.contractSummaries.length)} قرارداد
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs sap-table-compact">
              <thead className="bg-[#f5f5f5] text-[#333333] border-b border-[#d9d9d9]">
                <tr>
                  <th className="py-1.5 px-2 font-semibold">شماره قرارداد</th>
                  <th className="py-1.5 px-2 font-semibold">مشتری / مالکیت</th>
                  <th className="py-1.5 px-2 font-semibold">دریافتی (kg)</th>
                  <th className="py-1.5 px-2 font-semibold">مصرفی (kg)</th>
                  <th className="py-1.5 px-2 font-semibold">مانده دفتر امانی</th>
                  <th className="py-1.5 px-2 font-semibold">موجودی انبار</th>
                  <th className="py-1.5 px-2 font-semibold">آزاد / رزرو / قرنطینه</th>
                  <th className="py-1.5 px-2 font-semibold">کلاف فعال</th>
                  <th className="py-1.5 px-2 font-semibold">وضعیت</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e8e8e8] bg-white tabular-nums">
                {report.contractSummaries.map(row => (
                  <tr key={row.contractId} className="hover:bg-[#f8fafc]">
                    <td className="py-1.5 px-2">
                      <div className="font-mono font-semibold text-[#1D2D3E]">{row.contractNumber}</div>
                      <div className="text-[10px] text-[#666666]">{row.title}</div>
                    </td>
                    <td className="py-1.5 px-2 text-[#333333]">
                      <div>{row.customerName}</div>
                      <div className="text-[10px] text-[#556B82]">
                        {row.ownership === 'SAPCO_SUPPLIER_OWNED' ? 'امانی ساپکو' : 'ملکی شرکت'}
                      </div>
                    </td>
                    <td className="py-1.5 px-2 font-mono">{formatWeightKg(row.totalReceivedKg)}</td>
                    <td className="py-1.5 px-2 font-mono">{formatWeightKg(row.totalConsumedKg)}</td>
                    <td className="py-1.5 px-2 font-mono font-semibold text-[#1D2D3E]">
                      {formatWeightKg(row.ledgerClosingBalanceKg)}
                    </td>
                    <td className="py-1.5 px-2 font-mono font-semibold text-[#0070F2]">
                      {formatWeightKg(row.warehouseStockKg)}
                    </td>
                    <td className="py-1.5 px-2 font-mono text-[11px]">
                      <span className="text-[#107e3e]">{formatNumber(row.availableStockKg)}</span> /{' '}
                      <span className="text-[#0070F2]">{formatNumber(row.reservedStockKg)}</span> /{' '}
                      <span className="text-[#E9730C]">{formatNumber(row.qualityHoldStockKg)}</span>
                    </td>
                    <td className="py-1.5 px-2 font-mono text-[11px]">
                      {toPersianDigits(row.activeCoilsCount)} رول ({formatWeightKg(row.activeCoilsRemainingKg)})
                    </td>
                    <td className="py-1.5 px-2">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                          row.status === 'BALANCED'
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-amber-50 text-amber-800'
                        }`}
                      >
                        {row.status === 'BALANCED'
                          ? 'متوازن'
                          : `اختلاف ${row.varianceKg >= 0 ? '+' : ''}${formatNumber(row.varianceKg)} kg`}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Physical Cycle-Count Reconciliation Form + Traceability Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Section 2: Physical Cycle-Count Form */}
        <form onSubmit={handleSubmitCycleCount} className="sap-card p-4 space-y-3">
          <div className="border-b border-[#e8e8e8] pb-2 flex items-center justify-between">
            <h3 className="text-xs font-bold text-[#1D2D3E] flex items-center gap-1.5">
              <Scale className="w-4 h-4 text-[#0070F2]" />
              ثبت شمارش فیزیکی و تعدیل انبارگردانی (کد حرکت ۷۰۱ / ۷۰۲)
            </h3>
            <span className="text-[10px] text-[#556B82]">تراکنشی و دارای Idempotency</span>
          </div>

          {countFeedback && (
            <div
              className={`p-2.5 rounded border text-xs flex items-center gap-2 ${
                countFeedback.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-rose-50 border-rose-200 text-rose-800'
              }`}
            >
              {countFeedback.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0" />
              )}
              <span>{countFeedback.message}</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-[#333333] mb-1">
                انتخاب انبار
              </label>
              <select
                value={countWarehouseId}
                onChange={e => setCountWarehouseId(e.target.value)}
                className="w-full bg-white border border-[#bfbfbf] rounded px-2.5 py-1.5 text-xs text-[#333333] focus:outline-none focus:border-[#007cc0]"
              >
                {warehouses.map(w => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.id})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-[#333333] mb-1">
                کالا / بچ / کلاف در انبار
              </label>
              <select
                value={selectedBalanceId}
                onChange={e => handleSelectBalance(e.target.value)}
                className="w-full bg-white border border-[#bfbfbf] rounded px-2.5 py-1.5 text-xs text-[#333333] focus:outline-none focus:border-[#007cc0]"
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
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-2.5 rounded bg-[#f5f8fb] border border-[#dce6f2] text-[11px]">
              <div>
                <div className="text-[#556B82]">مانده دفتری (فیزیکی)</div>
                <div className="font-mono font-bold text-[#1D2D3E] mt-0.5">
                  {formatNumber(bookPhysicalQty)} {selectedBalance.unit}
                </div>
              </div>
              <div>
                <div className="text-[#556B82]">رزرو فعال</div>
                <div className="font-mono font-semibold text-[#0070F2] mt-0.5">
                  {formatNumber(reservedQty)} {selectedBalance.unit}
                </div>
              </div>
              <div>
                <div className="text-[#556B82]">قرنطینه / مسدود</div>
                <div className="font-mono font-semibold text-[#E9730C] mt-0.5">
                  {formatNumber(qualityHoldQty)} {selectedBalance.unit}
                </div>
              </div>
              <div>
                <div className="text-[#556B82]">حداقل مجاز شمارش</div>
                <div className="font-mono font-bold text-[#1D2D3E] mt-0.5">
                  {formatNumber(protectedFloor)} {selectedBalance.unit}
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-[#333333] mb-1">
                مقدار شمارش فیزیکی ({selectedPart?.unit || selectedBalance?.unit || 'واحد'})
              </label>
              <input
                type="number"
                step="any"
                min={0}
                value={countedQty}
                onChange={e => setCountedQty(e.target.value)}
                placeholder="مقدار واقعی شمارش‌شده..."
                className="w-full bg-white border border-[#bfbfbf] rounded px-2.5 py-1.5 text-xs font-mono text-[#1D2D3E] focus:outline-none focus:border-[#007cc0]"
                required
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-[#333333] mb-1">
                شماره صورتجلسه / مرجع (اختیاری)
              </label>
              <input
                type="text"
                value={countReference}
                onChange={e => setCountReference(e.target.value)}
                placeholder="مثلاً CC-1404-08-01"
                className="w-full bg-white border border-[#bfbfbf] rounded px-2.5 py-1.5 text-xs text-[#1D2D3E] focus:outline-none focus:border-[#007cc0]"
              />
            </div>
          </div>

          {selectedBalance && Number.isFinite(parsedCountedQty) && (
            <div
              className={`p-2.5 rounded border text-xs flex items-center justify-between ${
                violatesFloor
                  ? 'bg-rose-50 border-rose-200 text-rose-800'
                  : computedVariance === 0
                  ? 'bg-slate-50 border-slate-200 text-slate-700'
                  : computedVariance > 0
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-amber-50 border-amber-200 text-amber-800'
              }`}
            >
              <span>
                {violatesFloor
                  ? 'خطای سقف رزرو/قرنطینه: شمارش کمتر از حداقل محافظت‌شده است.'
                  : computedVariance === 0
                  ? 'اختلاف صفر است (بدون صدور سند تعدیل).'
                  : computedVariance > 0
                  ? 'سند مازاد انبارگردانی (MvT 701) صادر خواهد شد:'
                  : 'سند کسری انبارگردانی (MvT 702) صادر خواهد شد:'}
              </span>
              <span className="font-mono font-bold">
                {computedVariance >= 0 ? '+' : ''}
                {formatNumber(computedVariance)} {selectedBalance.unit}
              </span>
            </div>
          )}

          <div>
            <label className="block text-[11px] font-semibold text-[#333333] mb-1">
              شرح و علت تعدیل شمارش فیزیکی (الزامی)
            </label>
            <input
              type="text"
              value={countReason}
              onChange={e => setCountReason(e.target.value)}
              placeholder="شرح دقیق شمارش انبارگردانی، باسکول یا صورتجلسه کنترل..."
              className="w-full bg-white border border-[#bfbfbf] rounded px-2.5 py-1.5 text-xs text-[#1D2D3E] focus:outline-none focus:border-[#007cc0]"
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
        </form>

        {/* Section 3: Material Traceability & Coil Genealogy */}
        <div className="sap-card p-4 space-y-3">
          <div className="border-b border-[#e8e8e8] pb-2 flex items-center justify-between">
            <h3 className="text-xs font-bold text-[#1D2D3E] flex items-center gap-1.5">
              <GitBranch className="w-4 h-4 text-[#0070F2]" />
              ردیابی زنجیره اسناد و شجره‌نامه کلاف (Traceability)
            </h3>
          </div>

          {/* Search by document / MO / part / order */}
          <form onSubmit={handleRunDocumentTrace} className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 text-[#666666] absolute right-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={traceQuery}
                onChange={e => setTraceQuery(e.target.value)}
                placeholder="شماره سند، دستور ساخت (MO)، سفارش مشتری یا کد کالا..."
                className="w-full pr-8 pl-2.5 py-1.5 bg-white border border-[#bfbfbf] rounded text-xs text-[#1D2D3E] focus:outline-none focus:border-[#007cc0]"
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
            <ArrowLeftRight className="w-3.5 h-3.5 text-[#556B82] shrink-0" />
            <select
              value={selectedCoilForGenealogy}
              onChange={e => handleLoadCoilGenealogy(e.target.value)}
              className="flex-1 bg-white border border-[#bfbfbf] rounded px-2.5 py-1.5 text-xs text-[#333333] focus:outline-none focus:border-[#007cc0]"
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
            <div className="p-2 rounded bg-rose-50 border border-rose-200 text-rose-800 text-xs">
              {traceError}
            </div>
          )}

          {/* Coil Genealogy View */}
          {coilGenealogy && (
            <div className="p-3 rounded border border-[#dce6f2] bg-[#f8fbff] space-y-2.5">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="text-xs font-bold text-[#1D2D3E]">
                  شجره‌نامه کلاف {coilGenealogy.coil.coilId} ({coilGenealogy.coil.materialGrade})
                </div>
                <span className="px-2 py-0.5 rounded bg-white border border-[#dce6f2] text-[10px] font-semibold text-[#0070F2]">
                  وضعیت چرخه: {coilGenealogy.lifecycleStatus}
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] tabular-nums">
                <div className="bg-white p-2 rounded border border-[#e5e7eb]">
                  <div className="text-[#556B82]">وزن اولیه</div>
                  <div className="font-mono font-semibold">
                    {formatWeightKg(coilGenealogy.metrics.originalWeightKg)}
                  </div>
                </div>
                <div className="bg-white p-2 rounded border border-[#e5e7eb]">
                  <div className="text-[#556B82]">جمع حواله</div>
                  <div className="font-mono font-semibold text-[#0070F2]">
                    {formatWeightKg(coilGenealogy.metrics.totalIssuedKg)}
                  </div>
                </div>
                <div className="bg-white p-2 rounded border border-[#e5e7eb]">
                  <div className="text-[#556B82]">ته‌کلاف برگشتی</div>
                  <div className="font-mono font-semibold text-[#107e3e]">
                    {formatWeightKg(coilGenealogy.metrics.totalReturnedKg)}
                  </div>
                </div>
                <div className="bg-white p-2 rounded border border-[#e5e7eb]">
                  <div className="text-[#556B82]">مانده فعلی</div>
                  <div className="font-mono font-bold text-[#1D2D3E]">
                    {formatWeightKg(coilGenealogy.metrics.remainingWeightKg)}
                  </div>
                </div>
              </div>
              <div className="text-[11px] text-[#556B82]">
                اسناد مرتبط ثبت‌شده ({toPersianDigits(coilGenealogy.relatedDocuments.length)} سند):
              </div>
              <div className="max-h-40 overflow-y-auto space-y-1">
                {coilGenealogy.relatedDocuments.map(doc => (
                  <div
                    key={doc.id}
                    className="flex items-center justify-between bg-white px-2.5 py-1.5 rounded border border-[#e5e7eb] text-[11px]"
                  >
                    <span className="font-mono font-semibold text-[#1D2D3E]">
                      {doc.documentNumber}
                    </span>
                    <span className="text-[#556B82]">{doc.documentType}</span>
                    <span className="font-mono text-[10px] text-[#666666]">
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
                <div className="text-center py-6 text-xs text-[#666666]">
                  سندی با این عبارت در زنجیره ردیابی یافت نشد.
                </div>
              ) : (
                traceNodes.map((node, idx) => (
                  <div
                    key={`${node.docNumber}-${idx}`}
                    className="p-2.5 rounded border border-[#e5e7eb] bg-[#fafafa] flex items-start justify-between gap-2 text-xs"
                  >
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-mono font-semibold text-[#0070F2]">
                          {node.docNumber}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-white border border-[#d9d9d9] text-[10px] text-[#333333]">
                          {node.stageLabel}
                        </span>
                        {node.movementType && (
                          <span className="font-mono text-[10px] text-[#556B82]">
                            MvT {node.movementType}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-[#333333]">{node.title}</div>
                    </div>
                    <span className="font-mono text-[10px] text-[#666666] whitespace-nowrap">
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
  );
};
