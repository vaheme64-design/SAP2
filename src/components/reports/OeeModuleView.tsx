import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Gauge,
  Activity,
  ShieldCheck,
  Zap,
  AlertTriangle,
  RefreshCw,
  Download,
  Printer,
  CheckCircle2,
  Clock,
  Layers,
  Wrench,
  Eye,
  X,
  BarChart3,
  Calendar,
  FileSpreadsheet,
  Info,
  ExternalLink,
  Filter,
  Database,
  AlertCircle,
} from 'lucide-react';
import type {
  OeeAnalyticsResponse,
  OeeAnalyticsMachineRow,
  OeeAnalyticsOperationRow,
  OeeDataQualityStatus,
  OeeDowntimeCategory,
} from '../../types/oeeAndConsumables';
import { formatNumber, toPersianDigits } from '../../utils/formatters';
import { ReportModuleSkeleton } from '../common/Skeleton';
import { useErpRouter } from '../../context/RouterContext';

export interface OeeModuleViewProps {
  machines?: any[];
}

type AnalyticsTabKey = 'machines' | 'shifts' | 'operations' | 'daily' | 'sources';
type SourceSubTabKey = 'reports' | 'downtimes' | 'assignments';

type DrilldownTarget =
  | { kind: 'MACHINE'; row: OeeAnalyticsMachineRow }
  | { kind: 'OPERATION'; row: OeeAnalyticsOperationRow }
  | null;

const DATA_QUALITY_META: Record<
  OeeDataQualityStatus,
  { labelFa: string; badgeClass: string; borderClass: string }
> = {
  RELIABLE: {
    labelFa: 'معتبر (داده کامل)',
    badgeClass: 'bg-[#e8f5e9] text-[#107e3e] border-[#107e3e]/30',
    borderClass: 'border-r-[#107e3e]',
  },
  PARTIAL: {
    labelFa: 'ناقص جزئی (نیاز به بررسی)',
    badgeClass: 'bg-[#fff4e5] text-[#b45309] border-[#e9730c]/30',
    borderClass: 'border-r-[#e9730c]',
  },
  UNRELIABLE: {
    labelFa: 'نامعتبر / ناسازگار',
    badgeClass: 'bg-[#fdecea] text-[#bb0000] border-[#bb0000]/30',
    borderClass: 'border-r-[#bb0000]',
  },
  INSUFFICIENT_DATA: {
    labelFa: 'داده ناکافی (عدم محاسبه)',
    badgeClass: 'bg-[#f2f4f7] text-[#475467] border-[#d0d5dd]',
    borderClass: 'border-r-[#667085]',
  },
};

const DOWNTIME_CATEGORY_META: Record<
  OeeDowntimeCategory,
  { labelFa: string; badgeClass: string; barColor: string }
> = {
  UNPLANNED: {
    labelFa: 'توقف اضطراری / خرابی',
    badgeClass: 'bg-[#fdecea] text-[#bb0000] border-[#bb0000]/25',
    barColor: 'bg-[#bb0000]',
  },
  SETUP: {
    labelFa: 'ستاپ و تعویض قالب',
    badgeClass: 'bg-[#fff4e5] text-[#b45309] border-[#e9730c]/25',
    barColor: 'bg-[#e9730c]',
  },
  PLANNED: {
    labelFa: 'توقف برنامه‌ریزی‌شده (PM)',
    badgeClass: 'bg-[#e5f3fa] text-[#007cc0] border-[#007cc0]/25',
    barColor: 'bg-[#007cc0]',
  },
};

const CYCLE_SOURCE_LABELS: Record<string, string> = {
  OPERATION: 'زمان سیکل استاندارد عملیات',
  ROUTE: 'زمان سیکل مسیر تولید (Route)',
  MACHINE_SPM: 'برآورد از حداکثر SPM ماشین',
  MISSING: 'ثبت نشده (ناموجود)',
};

function formatPercentOrNull(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return 'ناموجود';
  }
  return `${toPersianDigits(value.toFixed(1))}٪`;
}

function formatMinutesFa(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return '—';
  return `${toPersianDigits(Math.round(minutes * 10) / 10)} دقیقه`;
}

function formatSecondsFa(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return 'ناموجود';
  return `${toPersianDigits(sec.toFixed(2))} ثانیه`;
}

function getOeeValueColor(value: number | null): string {
  if (value === null) return 'text-[#667085]';
  if (value >= 85) return 'text-[#107e3e]';
  if (value >= 70) return 'text-[#007cc0]';
  if (value >= 55) return 'text-[#b45309]';
  return 'text-[#bb0000]';
}

export const OeeModuleView: React.FC<OeeModuleViewProps> = () => {
  const router = useErpRouter();
  const [data, setData] = useState<OeeAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [machineFilter, setMachineFilter] = useState<string>('ALL');
  const [shiftFilter, setShiftFilter] = useState<string>('ALL');
  const [hallFilter, setHallFilter] = useState<string>('ALL');

  // Navigation & UI state
  const [activeTab, setActiveTab] = useState<AnalyticsTabKey>('machines');
  const [sourceSubTab, setSourceSubTab] = useState<SourceSubTabKey>('reports');
  const [showFormulas, setShowFormulas] = useState(false);
  const [drilldown, setDrilldown] = useState<DrilldownTarget>(null);
  const [exporting, setExporting] = useState(false);

  const buildFilterQueryString = useCallback(() => {
    const q = new URLSearchParams();
    if (startDate) q.set('startDate', startDate);
    if (endDate) q.set('endDate', endDate);
    if (machineFilter && machineFilter !== 'ALL') q.set('machineId', machineFilter);
    if (shiftFilter && shiftFilter !== 'ALL') q.set('shiftId', shiftFilter);
    if (hallFilter && hallFilter !== 'ALL') q.set('hall', hallFilter);
    return q.toString();
  }, [startDate, endDate, machineFilter, shiftFilter, hallFilter]);

  const loadAnalytics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = buildFilterQueryString();
      const res = await fetch(`/api/oee/analytics${qs ? `?${qs}` : ''}`);
      const json = await res.json();
      if (!res.ok || !json.success || !json.data) {
        throw new Error(json.error || 'خطا در دریافت داده‌های تحلیلی OEE');
      }
      setData(json.data as OeeAnalyticsResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در بارگذاری داده‌های OEE');
    } finally {
      setLoading(false);
    }
  }, [buildFilterQueryString]);

  useEffect(() => {
    loadAnalytics();
  }, [loadAnalytics]);

  const handleResetFilters = () => {
    setStartDate('');
    setEndDate('');
    setMachineFilter('ALL');
    setShiftFilter('ALL');
    setHallFilter('ALL');
  };

  const handleExportCsv = async (
    datasetOverride?: 'machines' | 'shifts' | 'operations' | 'daily' | 'reports' | 'downtimes',
  ) => {
    const dataset: 'machines' | 'shifts' | 'operations' | 'daily' | 'reports' | 'downtimes' =
      datasetOverride ||
      (activeTab === 'sources'
        ? sourceSubTab === 'downtimes'
          ? 'downtimes'
          : 'reports'
        : activeTab);

    setExporting(true);
    try {
      const q = new URLSearchParams(buildFilterQueryString());
      q.set('dataset', dataset);
      const res = await fetch(`/api/oee/analytics/export?${q.toString()}`);
      if (!res.ok) {
        throw new Error('خطا در تولید فایل CSV');
      }
      const csvText = await res.text();
      const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `KPIMS_OEE_${dataset}_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در دانلود فایل CSV');
    } finally {
      setExporting(false);
    }
  };

  const handleGoToShopFloor = () => {
    router.navigate({
      tab: 'production',
      productionViewMode: 'ERP_WORKBENCH',
      productionModuleTab: 'SHOP_FLOOR_EXECUTION',
    });
  };

  const drilldownRecords = useMemo(() => {
    if (!drilldown || !data) {
      return { reports: [], downtimes: [], assignments: [] };
    }
    if (drilldown.kind === 'MACHINE') {
      const mId = drilldown.row.machineId;
      return {
        reports: data.sourceRecords.productionReports.filter(r => r.machineId === mId),
        downtimes: data.sourceRecords.downtimeEvents.filter(d => d.machineId === mId),
        assignments: data.sourceRecords.machineAssignments.filter(a => a.machineId === mId),
      };
    }
    const opId = drilldown.row.operationId;
    return {
      reports: data.sourceRecords.productionReports.filter(r => r.operationId === opId),
      downtimes: data.sourceRecords.downtimeEvents.filter(d => d.operationId === opId),
      assignments: data.sourceRecords.machineAssignments.filter(a => a.productionOperationId === opId),
    };
  }, [drilldown, data]);

  const summary = data?.summary;
  const dqMeta = summary ? DATA_QUALITY_META[summary.dataQualityStatus] : DATA_QUALITY_META.INSUFFICIENT_DATA;

  const timeTotalForBar = summary
    ? Math.max(
        1,
        summary.time.operatingTimeMinutes +
          summary.time.setupTimeMinutes +
          summary.time.plannedDowntimeMinutes +
          summary.time.unplannedDowntimeMinutes +
          summary.time.idleUnassignedMinutes,
      )
    : 1;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="sap-card p-4 text-[#333333] flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-sm bg-[#e5f3fa] text-[#007cc0] border border-[#007cc0]/25 shrink-0">
            <Gauge className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-bold text-[#333333]">
                تحلیل OEE، عملکرد ماشین‌آلات و بهره‌وری تولید (KPIMS P4 Analytics)
              </h2>
              {summary && (
                <span className={`px-2 py-0.5 rounded-sm text-[10px] font-bold border ${dqMeta.badgeClass}`}>
                  کیفیت داده: {dqMeta.labelFa}
                </span>
              )}
              {data && (
                <span className="px-2 py-0.5 rounded-sm text-[10px] font-mono bg-[#f7f7f7] text-[#666666] border border-[#d9d9d9]">
                  {toPersianDigits(data.summary.totalReportsCount)} گزارش تولید •{' '}
                  {toPersianDigits(data.summary.totalDowntimeEventsCount)} رویداد توقف
                </span>
              )}
            </div>
            <p className="text-xs text-[#666666] mt-0.5">
              محاسبه یکپارچه دسترس‌پذیری (Availability)، عملکرد (Performance)، کیفیت (Quality) و OEE مستقیماً از سوابق واقعی کارگاه، تخصیص ماشین‌آلات و توقفات ثبت‌شده (بدون مقادیر ساختگی)
            </p>
          </div>
        </div>

        <div className="flex items-center flex-wrap gap-2">
          <button
            type="button"
            onClick={handleGoToShopFloor}
            className="sap-btn-emphasized flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
            title="ثبت گزارش تولید و توقفات از طریق تابلوی اجرای کارگاه (بدون فرم تکراری)"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>ثبت گزارش / توقف در اجرای کارگاه</span>
          </button>

          <button
            type="button"
            onClick={() => setShowFormulas(prev => !prev)}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <Info className="w-3.5 h-3.5 text-[#007cc0]" />
            <span>فرمول‌ها و مبنای محاسبه</span>
          </button>

          <button
            type="button"
            onClick={loadAnalytics}
            disabled={loading}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-[#007cc0]' : ''}`} />
            <span>بروزرسانی</span>
          </button>

          <button
            type="button"
            onClick={() => handleExportCsv()}
            disabled={exporting || !data}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <Download className="w-3.5 h-3.5 text-[#107e3e]" />
            <span>{exporting ? 'در حال خروجی...' : 'خروجی CSV (همگام)'}</span>
          </button>

          <button
            type="button"
            onClick={() => window.print()}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <Printer className="w-3.5 h-3.5 text-[#666666]" />
            <span>چاپ</span>
          </button>
        </div>
      </div>

      {/* Formula Reference Drawer/Box */}
      {showFormulas && data?.formulas && (
        <div className="sap-card p-4 bg-[#f8fbfe] border border-[#007cc0]/30 text-xs space-y-2">
          <div className="flex items-center justify-between border-b border-[#007cc0]/20 pb-2">
            <span className="font-bold text-[#007cc0] flex items-center gap-1.5">
              <Info className="w-4 h-4" />
              فرمول‌های استاندارد ISO 22400 / TPM مورد استفاده در داشبورد، گزارش‌ها و خروجی CSV
            </span>
            <button
              type="button"
              onClick={() => setShowFormulas(false)}
              className="text-[#666666] hover:text-[#333333] cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 font-mono text-[11px] text-[#333333]" dir="ltr">
            <div className="bg-white p-2 rounded border border-[#e5e7eb]">
              <strong className="text-[#007cc0] block">Planned Production Time:</strong>
              {data.formulas.plannedProductionTime}
            </div>
            <div className="bg-white p-2 rounded border border-[#e5e7eb]">
              <strong className="text-[#007cc0] block">Availability (A):</strong>
              {data.formulas.availability}
            </div>
            <div className="bg-white p-2 rounded border border-[#e5e7eb]">
              <strong className="text-[#007cc0] block">Performance (P):</strong>
              {data.formulas.performance}
            </div>
            <div className="bg-white p-2 rounded border border-[#e5e7eb]">
              <strong className="text-[#007cc0] block">Quality (Q):</strong>
              {data.formulas.quality}
            </div>
            <div className="bg-white p-2 rounded border border-[#e5e7eb]">
              <strong className="text-[#107e3e] block">OEE:</strong>
              {data.formulas.oee}
            </div>
            <div className="bg-white p-2 rounded border border-[#e5e7eb]">
              <strong className="text-[#333333] block">TEEP & Downtime Deduplication:</strong>
              {data.formulas.teep} | {data.formulas.downtimeDeduplication}
            </div>
          </div>
        </div>
      )}

      {/* Filter Bar */}
      <div className="sap-card p-3 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="font-bold text-[#333333] flex items-center gap-1">
            <Filter className="w-3.5 h-3.5 text-[#007cc0]" />
            فیلترها:
          </span>

          <div className="flex items-center gap-1.5">
            <label className="text-[#666666]">از تاریخ:</label>
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="bg-white border border-[#bfbfbf] rounded-sm px-2 py-1 text-xs font-mono text-[#333333] focus:outline-none focus:border-[#007cc0]"
            />
          </div>

          <div className="flex items-center gap-1.5">
            <label className="text-[#666666]">تا تاریخ:</label>
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              className="bg-white border border-[#bfbfbf] rounded-sm px-2 py-1 text-xs font-mono text-[#333333] focus:outline-none focus:border-[#007cc0]"
            />
          </div>

          <select
            value={machineFilter}
            onChange={e => setMachineFilter(e.target.value)}
            className="bg-white border border-[#bfbfbf] rounded-sm px-2.5 py-1 text-xs text-[#333333] focus:outline-none focus:border-[#007cc0]"
          >
            <option value="ALL">همه ماشین‌آلات</option>
            {data?.masterData.machines.map(m => (
              <option key={m.id} value={m.id}>
                {m.code} — {m.name}
              </option>
            ))}
          </select>

          <select
            value={shiftFilter}
            onChange={e => setShiftFilter(e.target.value)}
            className="bg-white border border-[#bfbfbf] rounded-sm px-2.5 py-1 text-xs text-[#333333] focus:outline-none focus:border-[#007cc0]"
          >
            <option value="ALL">همه شیفت‌ها</option>
            {data?.masterData.shifts.map(s => (
              <option key={s.id} value={s.id}>
                {s.name} ({toPersianDigits(s.productiveHours)} ساعت)
              </option>
            ))}
          </select>

          <select
            value={hallFilter}
            onChange={e => setHallFilter(e.target.value)}
            className="bg-white border border-[#bfbfbf] rounded-sm px-2.5 py-1 text-xs text-[#333333] focus:outline-none focus:border-[#007cc0]"
          >
            <option value="ALL">همه سالن‌ها</option>
            {data?.masterData.halls.map(h => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>

          {(startDate || endDate || machineFilter !== 'ALL' || shiftFilter !== 'ALL' || hallFilter !== 'ALL') && (
            <button
              type="button"
              onClick={handleResetFilters}
              className="px-2.5 py-1 rounded-sm text-xs bg-[#f2f4f7] hover:bg-[#e5e7eb] text-[#333333] border border-[#d0d5dd] cursor-pointer"
            >
              پاک کردن فیلترها
            </button>
          )}
        </div>

        {data && (
          <div className="flex items-center gap-2 text-[11px] text-[#666666]">
            <span>معتبر: <strong className="text-[#107e3e]">{toPersianDigits(data.dataQualityOverview.reliableCount)}</strong></span>
            <span>|</span>
            <span>ناقص/هشدار: <strong className="text-[#b45309]">{toPersianDigits(data.dataQualityOverview.partialCount + data.dataQualityOverview.unreliableCount)}</strong></span>
            <span>|</span>
            <span>داده ناکافی: <strong className="text-[#475467]">{toPersianDigits(data.dataQualityOverview.insufficientCount)}</strong></span>
          </div>
        )}
      </div>

      {/* Error State */}
      {error && (
        <div className="p-3 rounded-sm bg-[#fdecea] border border-[#bb0000]/30 text-[#bb0000] text-xs flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
          <button type="button" onClick={loadAnalytics} className="underline cursor-pointer">
            تلاش مجدد
          </button>
        </div>
      )}

      {/* Loading Skeleton */}
      {loading && !data && <ReportModuleSkeleton kpiCount={5} showChart={true} tableRows={6} tableColumns={9} />}

      {/* Explicit Data Quality & Missing Inputs Banner */}
      {data && summary && (summary.dataQualityStatus !== 'RELIABLE' || data.dataQualityOverview.issues.length > 0) && (
        <div
          className={`sap-card p-3.5 border-r-4 ${dqMeta.borderClass} text-xs space-y-2 ${
            summary.dataQualityStatus === 'UNRELIABLE'
              ? 'bg-[#fff8f8]'
              : summary.dataQualityStatus === 'INSUFFICIENT_DATA'
              ? 'bg-[#f8fafc]'
              : 'bg-[#fffcf5]'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-bold text-[#333333]">
              <AlertCircle className="w-4 h-4 text-[#b45309] shrink-0" />
              <span>شفافیت کیفیت داده‌ها و ورودی‌های ناموجود (عدم ساخت عدد جعلی OEE)</span>
            </div>
            <span className={`px-2 py-0.5 rounded-sm text-[10px] font-bold border ${dqMeta.badgeClass}`}>
              {dqMeta.labelFa}
            </span>
          </div>
          {summary.missingInputs.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[#666666] font-medium">ورودی‌های مفقود در سطح کل کارخانه:</span>
              {summary.missingInputs.map(mi => (
                <span
                  key={mi}
                  className="px-2 py-0.5 rounded bg-white border border-[#d0d5dd] font-mono text-[10px] text-[#333333]"
                >
                  {mi}
                </span>
              ))}
            </div>
          )}
          {data.dataQualityOverview.issues.length > 0 && (
            <ul className="space-y-1 text-[11px] text-[#475467] list-disc pr-5">
              {data.dataQualityOverview.issues.map((issue, idx) => (
                <li key={`${issue.code}-${idx}`} className={issue.severity === 'ERROR' ? 'text-[#bb0000] font-medium' : ''}>
                  {issue.messageFa}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Top Production-Level KPI Cards */}
      {data && summary && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {/* OEE */}
          <div className={`sap-card p-3.5 border-r-4 ${dqMeta.borderClass}`}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[#333333]">OEE کل تولید (وزنی)</span>
              <Gauge className="w-4 h-4 text-[#007cc0]" />
            </div>
            <div className={`text-2xl font-bold font-mono tabular-nums mt-1.5 ${getOeeValueColor(summary.oeePercent)}`}>
              {formatPercentOrNull(summary.oeePercent)}
            </div>
            <div className="text-[11px] text-[#666666] mt-1 flex items-center justify-between">
              <span>TEEP: {formatPercentOrNull(summary.teepPercent)}</span>
              <span>هدف جهانی: {toPersianDigits(summary.worldClassBenchmarkOee)}٪</span>
            </div>
            {!summary.oeeCalculable && (
              <div className="mt-1.5 text-[10px] text-[#b45309] bg-[#fff4e5] px-1.5 py-0.5 rounded">
                محاسبه نشد — ورودی‌های A/P/Q ناقص است
              </div>
            )}
          </div>

          {/* Availability */}
          <div className="sap-card p-3.5 border-r-4 border-r-[#007cc0]">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[#007cc0]">دسترس‌پذیری (Availability)</span>
              <Clock className="w-4 h-4 text-[#007cc0]" />
            </div>
            <div className={`text-2xl font-bold font-mono tabular-nums mt-1.5 ${getOeeValueColor(summary.availabilityPercent)}`}>
              {formatPercentOrNull(summary.availabilityPercent)}
            </div>
            <div className="text-[11px] text-[#666666] mt-1 space-y-0.5">
              <div>کارکرد خالص: <strong>{formatMinutesFa(summary.time.operatingTimeMinutes)}</strong></div>
              <div>زمان برنامه‌ریزی‌شده: <strong>{formatMinutesFa(summary.time.effectivePlannedProductionTimeMinutes)}</strong></div>
            </div>
          </div>

          {/* Performance */}
          <div className="sap-card p-3.5 border-r-4 border-r-[#e9730c]">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[#b45309]">عملکرد سرعت (Performance)</span>
              <Zap className="w-4 h-4 text-[#e9730c]" />
            </div>
            <div className={`text-2xl font-bold font-mono tabular-nums mt-1.5 ${getOeeValueColor(summary.performancePercent)}`}>
              {formatPercentOrNull(summary.performancePercent)}
            </div>
            <div className="text-[11px] text-[#666666] mt-1 space-y-0.5">
              <div>سیکل استاندارد: <strong>{formatSecondsFa(summary.idealCycleTimeSec)}</strong></div>
              <div>سیکل واقعی: <strong>{formatSecondsFa(summary.actualCycleTimeSec)}</strong></div>
              {summary.rawPerformancePercent !== null && summary.rawPerformancePercent > 100.5 && (
                <div className="text-[#bb0000] font-bold">
                  خام: {formatPercentOrNull(summary.rawPerformancePercent)} (بررسی سیکل!)
                </div>
              )}
            </div>
          </div>

          {/* Quality */}
          <div className="sap-card p-3.5 border-r-4 border-r-[#107e3e]">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[#107e3e]">کیفیت (Quality)</span>
              <ShieldCheck className="w-4 h-4 text-[#107e3e]" />
            </div>
            <div className={`text-2xl font-bold font-mono tabular-nums mt-1.5 ${getOeeValueColor(summary.qualityPercent)}`}>
              {formatPercentOrNull(summary.qualityPercent)}
            </div>
            <div className="text-[11px] text-[#666666] mt-1 space-y-0.5">
              <div>سالم: <strong className="text-[#107e3e]">{formatNumber(summary.goodQty)}</strong> • ضایعات: <strong className="text-[#bb0000]">{formatNumber(summary.scrapQty + summary.rejectedQty)}</strong></div>
              <div>نرخ ضایعات: <strong>{formatPercentOrNull(summary.scrapRatePercent)}</strong></div>
            </div>
          </div>

          {/* Plan vs Actual */}
          <div className="sap-card p-3.5 border-r-4 border-r-[#333333]">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[#333333]">تولید واقعی در برابر برنامه</span>
              <Activity className="w-4 h-4 text-[#333333]" />
            </div>
            <div className="text-2xl font-bold font-mono tabular-nums mt-1.5 text-[#333333]">
              {formatPercentOrNull(summary.planAdherencePercent)}
            </div>
            <div className="text-[11px] text-[#666666] mt-1 space-y-0.5">
              <div>تولید سالم: <strong>{formatNumber(summary.goodQty)}</strong> / برنامه: <strong>{formatNumber(summary.plannedQty)}</strong></div>
              <div className={summary.planVarianceQty < 0 ? 'text-[#bb0000]' : 'text-[#107e3e]'}>
                انحراف: <strong>{summary.planVarianceQty > 0 ? '+' : ''}{formatNumber(summary.planVarianceQty)}</strong>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Time Breakdown & Downtime Analysis Strip */}
      {data && summary && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* Time Classification Visual Bar */}
          <div className="sap-card p-4 lg:col-span-2 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#e8e8e8] pb-2">
              <h3 className="text-xs font-bold text-[#333333] flex items-center gap-1.5">
                <Clock className="w-4 h-4 text-[#007cc0]" />
                تفکیک زمان تولیدی، ستاپ، توقفات برنامه‌ریزی‌شده و اضطراری (بر حسب دقیقه)
              </h3>
              <span className="text-[11px] text-[#666666]">
                زمان شیفت برنامه‌ریزی: <strong>{formatMinutesFa(summary.time.scheduledTimeMinutes)}</strong>
              </span>
            </div>

            <div className="w-full h-5 rounded-sm overflow-hidden flex bg-[#f2f4f7] border border-[#e5e7eb]">
              {[
                { key: 'op', val: summary.time.operatingTimeMinutes, color: 'bg-[#107e3e]', label: 'کارکرد تولیدی' },
                { key: 'setup', val: summary.time.setupTimeMinutes, color: 'bg-[#e9730c]', label: 'ستاپ/تعویض قالب' },
                { key: 'planned', val: summary.time.plannedDowntimeMinutes, color: 'bg-[#007cc0]', label: 'توقف برنامه‌ریزی‌شده' },
                { key: 'unplanned', val: summary.time.unplannedDowntimeMinutes, color: 'bg-[#bb0000]', label: 'توقف اضطراری' },
                { key: 'idle', val: summary.time.idleUnassignedMinutes, color: 'bg-[#d0d5dd]', label: 'بیکاری/ظرفیت آزاد' },
              ].map(seg => {
                const pct = (seg.val / timeTotalForBar) * 100;
                if (pct <= 0.2) return null;
                return (
                  <div
                    key={seg.key}
                    style={{ width: `${pct}%` }}
                    className={`${seg.color} h-full transition-all`}
                    title={`${seg.label}: ${seg.val} دقیقه (${pct.toFixed(1)}%)`}
                  />
                );
              })}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-[11px]">
              <div className="p-2 rounded bg-[#f8fafc] border border-[#e5e7eb]">
                <span className="text-[#107e3e] font-bold block">● کارکرد تولیدی</span>
                <span className="font-mono font-bold text-[#333333]">{formatMinutesFa(summary.time.operatingTimeMinutes)}</span>
              </div>
              <div className="p-2 rounded bg-[#f8fafc] border border-[#e5e7eb]">
                <span className="text-[#b45309] font-bold block">● زمان ستاپ (Setup)</span>
                <span className="font-mono font-bold text-[#333333]">{formatMinutesFa(summary.time.setupTimeMinutes)}</span>
              </div>
              <div className="p-2 rounded bg-[#f8fafc] border border-[#e5e7eb]">
                <span className="text-[#007cc0] font-bold block">● توقف برنامه‌ریزی (PM)</span>
                <span className="font-mono font-bold text-[#333333]">{formatMinutesFa(summary.time.plannedDowntimeMinutes)}</span>
              </div>
              <div className="p-2 rounded bg-[#f8fafc] border border-[#e5e7eb]">
                <span className="text-[#bb0000] font-bold block">● توقف اضطراری</span>
                <span className="font-mono font-bold text-[#333333]">{formatMinutesFa(summary.time.unplannedDowntimeMinutes)}</span>
              </div>
              <div className="p-2 rounded bg-[#f8fafc] border border-[#e5e7eb]">
                <span className="text-[#667085] font-bold block">● ظرفیت آزاد / بیکار</span>
                <span className="font-mono font-bold text-[#333333]">{formatMinutesFa(summary.time.idleUnassignedMinutes)}</span>
              </div>
            </div>
          </div>

          {/* Top Downtime Reasons */}
          <div className="sap-card p-4 space-y-2.5">
            <div className="flex items-center justify-between border-b border-[#e8e8e8] pb-2">
              <h3 className="text-xs font-bold text-[#333333] flex items-center gap-1.5">
                <Wrench className="w-4 h-4 text-[#bb0000]" />
                علل اصلی توقفات (تفکیک‌شده بدون شمارش مضاعف)
              </h3>
              <span className="text-[11px] font-mono font-bold text-[#bb0000]">
                {formatMinutesFa(data.downtimeSummary.totalDowntimeMinutes)}
              </span>
            </div>
            {data.downtimeSummary.byReason.length === 0 ? (
              <div className="text-xs text-[#666666] py-6 text-center">
                هیچ رویداد توقفی در بازه فیلترشده ثبت نشده است.
              </div>
            ) : (
              <div className="space-y-2">
                {data.downtimeSummary.byReason.slice(0, 5).map((item, idx) => {
                  const catMeta = DOWNTIME_CATEGORY_META[item.category];
                  return (
                    <div key={`${item.reason}-${idx}`} className="text-[11px] space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className={`px-1.5 py-0.5 rounded border text-[9px] font-bold shrink-0 ${catMeta.badgeClass}`}>
                            {catMeta.labelFa}
                          </span>
                          <span className="truncate text-[#333333] font-medium" title={item.reason}>
                            {item.reason}
                          </span>
                        </div>
                        <span className="font-mono font-bold text-[#333333] shrink-0">
                          {toPersianDigits(item.minutes)} د ({toPersianDigits(item.sharePercent)}٪)
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-[#f2f4f7] rounded overflow-hidden">
                        <div
                          className={`h-full ${catMeta.barColor}`}
                          style={{ width: `${Math.min(100, item.sharePercent)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Multi-Dimensional Analytical Tabs */}
      {data && (
        <div className="sap-card overflow-hidden">
          <div className="border-b border-[#e5e7eb] px-3 pt-2.5 flex flex-wrap items-center justify-between gap-2 bg-[#fafafa]">
            <div className="flex items-center gap-1 flex-wrap">
              {[
                { id: 'machines' as const, label: `به تفکیک ماشین (${toPersianDigits(data.machines.length)})`, icon: Gauge },
                { id: 'shifts' as const, label: `به تفکیک شیفت (${toPersianDigits(data.byShift.length)})`, icon: Clock },
                { id: 'operations' as const, label: `به تفکیک عملیات و دستور کار (${toPersianDigits(data.byOperation.length)})`, icon: Layers },
                { id: 'daily' as const, label: `روند روزانه (${toPersianDigits(data.byDate.length)})`, icon: Calendar },
                { id: 'sources' as const, label: `سوابق منبع (Drill-down)`, icon: Database },
              ].map(t => {
                const Icon = t.icon;
                const active = activeTab === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setActiveTab(t.id)}
                    className={`flex items-center gap-1.5 px-3 py-2 text-xs font-bold border-b-2 transition cursor-pointer ${
                      active
                        ? 'border-[#007cc0] text-[#007cc0] bg-white'
                        : 'border-transparent text-[#666666] hover:text-[#333333]'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{t.label}</span>
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => handleExportCsv()}
              className="mb-1.5 px-2.5 py-1 rounded text-[11px] font-medium bg-white border border-[#d0d5dd] hover:border-[#107e3e] text-[#107e3e] flex items-center gap-1 cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              <span>دانلود CSV همین تب</span>
            </button>
          </div>

          {/* TAB 1: BY MACHINE */}
          {activeTab === 'machines' && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-right border-collapse">
                <thead>
                  <tr className="bg-[#f5f7fa] text-[#475467] border-b border-[#e5e7eb]">
                    <th className="p-2.5 font-bold">ماشین / سالن</th>
                    <th className="p-2.5 font-bold">وضعیت داده</th>
                    <th className="p-2.5 font-bold text-center">دسترس‌پذیری (A)</th>
                    <th className="p-2.5 font-bold text-center">عملکرد (P)</th>
                    <th className="p-2.5 font-bold text-center">کیفیت (Q)</th>
                    <th className="p-2.5 font-bold text-center">OEE</th>
                    <th className="p-2.5 font-bold text-center">واقعی / برنامه</th>
                    <th className="p-2.5 font-bold text-center">سالم / ضایعات</th>
                    <th className="p-2.5 font-bold text-center">زمان (تولید/ستاپ/PM/خرابی)</th>
                    <th className="p-2.5 font-bold text-center">سیکل (استاندارد / واقعی)</th>
                    <th className="p-2.5 font-bold text-center">سوابق</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#eaecf0]">
                  {data.machines.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="p-8 text-center text-[#666666]">
                        ماشینی مطابق فیلترهای انتخاب‌شده یافت نشد.
                      </td>
                    </tr>
                  ) : (
                    data.machines.map(m => {
                      const rowDq = DATA_QUALITY_META[m.dataQualityStatus];
                      return (
                        <tr
                          key={m.machineId}
                          onClick={() => setDrilldown({ kind: 'MACHINE', row: m })}
                          className="hover:bg-[#f0f7fc] transition cursor-pointer"
                        >
                          <td className="p-2.5">
                            <div className="font-bold text-[#333333] font-mono">{m.machineCode}</div>
                            <div className="text-[11px] text-[#475467]">{m.machineName}</div>
                            <div className="text-[10px] text-[#667085]">{m.hallLocation}</div>
                          </td>
                          <td className="p-2.5">
                            <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border ${rowDq.badgeClass}`}>
                              {rowDq.labelFa}
                            </span>
                            {m.missingInputs.length > 0 && (
                              <div className="text-[10px] text-[#b45309] mt-0.5">
                                مفقود: {m.missingInputs.join('، ')}
                              </div>
                            )}
                          </td>
                          <td className={`p-2.5 text-center font-mono font-bold ${getOeeValueColor(m.availabilityPercent)}`}>
                            {formatPercentOrNull(m.availabilityPercent)}
                          </td>
                          <td className={`p-2.5 text-center font-mono font-bold ${getOeeValueColor(m.performancePercent)}`}>
                            <div>{formatPercentOrNull(m.performancePercent)}</div>
                            {m.rawPerformancePercent !== null && m.rawPerformancePercent > 100.5 && (
                              <div className="text-[10px] text-[#bb0000]">خام: {formatPercentOrNull(m.rawPerformancePercent)}</div>
                            )}
                          </td>
                          <td className={`p-2.5 text-center font-mono font-bold ${getOeeValueColor(m.qualityPercent)}`}>
                            {formatPercentOrNull(m.qualityPercent)}
                          </td>
                          <td className={`p-2.5 text-center font-mono font-bold text-sm ${getOeeValueColor(m.oeePercent)}`}>
                            {formatPercentOrNull(m.oeePercent)}
                          </td>
                          <td className="p-2.5 text-center font-mono">
                            <div>
                              <strong className="text-[#333333]">{formatNumber(m.goodQty)}</strong> / {formatNumber(m.plannedQty)}
                            </div>
                            <div className="text-[10px] text-[#667085]">
                              تحقق: {formatPercentOrNull(m.planAdherencePercent)}
                            </div>
                          </td>
                          <td className="p-2.5 text-center font-mono">
                            <span className="text-[#107e3e] font-bold">{formatNumber(m.goodQty)}</span>
                            <span className="mx-1 text-[#98a2b3]">/</span>
                            <span className="text-[#bb0000] font-bold">{formatNumber(m.scrapQty + m.rejectedQty)}</span>
                          </td>
                          <td className="p-2.5 text-center font-mono text-[11px]">
                            <span className="text-[#107e3e]" title="کارکرد">{toPersianDigits(m.time.operatingTimeMinutes)}</span>
                            {' / '}
                            <span className="text-[#b45309]" title="ستاپ">{toPersianDigits(m.time.setupTimeMinutes)}</span>
                            {' / '}
                            <span className="text-[#007cc0]" title="توقف برنامه‌ریزی">{toPersianDigits(m.time.plannedDowntimeMinutes)}</span>
                            {' / '}
                            <span className="text-[#bb0000]" title="خرابی اضطراری">{toPersianDigits(m.time.unplannedDowntimeMinutes)}</span>
                          </td>
                          <td className="p-2.5 text-center font-mono text-[11px]">
                            <div>{m.idealCycleTimeSec != null ? `${toPersianDigits(m.idealCycleTimeSec.toFixed(1))}s` : 'ناموجود'}</div>
                            <div className="text-[#667085]">
                              {m.actualCycleTimeSec != null ? `${toPersianDigits(m.actualCycleTimeSec.toFixed(1))}s` : '—'}
                            </div>
                          </td>
                          <td className="p-2.5 text-center">
                            <button
                              type="button"
                              onClick={e => {
                                e.stopPropagation();
                                setDrilldown({ kind: 'MACHINE', row: m });
                              }}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#e5f3fa] text-[#007cc0] hover:bg-[#d0ebfa] text-[11px] font-bold cursor-pointer"
                            >
                              <Eye className="w-3.5 h-3.5" />
                              <span>{toPersianDigits(m.reportsCount + m.downtimeEventsCount)}</span>
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* TAB 2: BY SHIFT */}
          {activeTab === 'shifts' && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-right border-collapse">
                <thead>
                  <tr className="bg-[#f5f7fa] text-[#475467] border-b border-[#e5e7eb]">
                    <th className="p-2.5 font-bold">شیفت کاری</th>
                    <th className="p-2.5 font-bold">وضعیت داده</th>
                    <th className="p-2.5 font-bold text-center">دسترس‌پذیری (A)</th>
                    <th className="p-2.5 font-bold text-center">عملکرد (P)</th>
                    <th className="p-2.5 font-bold text-center">کیفیت (Q)</th>
                    <th className="p-2.5 font-bold text-center">OEE</th>
                    <th className="p-2.5 font-bold text-center">واقعی / برنامه</th>
                    <th className="p-2.5 font-bold text-center">سالم / ضایعات</th>
                    <th className="p-2.5 font-bold text-center">کارکرد (دقیقه)</th>
                    <th className="p-2.5 font-bold text-center">ستاپ / PM / خرابی</th>
                    <th className="p-2.5 font-bold text-center">تعداد گزارش</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#eaecf0]">
                  {data.byShift.map(s => {
                    const rowDq = DATA_QUALITY_META[s.dataQualityStatus];
                    return (
                      <tr key={s.shiftId} className="hover:bg-[#fafafa]">
                        <td className="p-2.5">
                          <div className="font-bold text-[#333333]">{s.shiftName}</div>
                          <div className="text-[10px] font-mono text-[#667085]">
                            {s.shiftCode} • {toPersianDigits(s.productiveHoursPerShift)} ساعت/شیفت
                          </div>
                        </td>
                        <td className="p-2.5">
                          <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border ${rowDq.badgeClass}`}>
                            {rowDq.labelFa}
                          </span>
                        </td>
                        <td className={`p-2.5 text-center font-mono font-bold ${getOeeValueColor(s.availabilityPercent)}`}>
                          {formatPercentOrNull(s.availabilityPercent)}
                        </td>
                        <td className={`p-2.5 text-center font-mono font-bold ${getOeeValueColor(s.performancePercent)}`}>
                          {formatPercentOrNull(s.performancePercent)}
                        </td>
                        <td className={`p-2.5 text-center font-mono font-bold ${getOeeValueColor(s.qualityPercent)}`}>
                          {formatPercentOrNull(s.qualityPercent)}
                        </td>
                        <td className={`p-2.5 text-center font-mono font-bold text-sm ${getOeeValueColor(s.oeePercent)}`}>
                          {formatPercentOrNull(s.oeePercent)}
                        </td>
                        <td className="p-2.5 text-center font-mono">
                          {formatNumber(s.goodQty)} / {formatNumber(s.plannedQty)}
                        </td>
                        <td className="p-2.5 text-center font-mono">
                          <span className="text-[#107e3e] font-bold">{formatNumber(s.goodQty)}</span>
                          {' / '}
                          <span className="text-[#bb0000] font-bold">{formatNumber(s.scrapQty + s.rejectedQty)}</span>
                        </td>
                        <td className="p-2.5 text-center font-mono">{toPersianDigits(s.time.operatingTimeMinutes)}</td>
                        <td className="p-2.5 text-center font-mono text-[11px]">
                          <span className="text-[#b45309]">{toPersianDigits(s.time.setupTimeMinutes)}</span>
                          {' / '}
                          <span className="text-[#007cc0]">{toPersianDigits(s.time.plannedDowntimeMinutes)}</span>
                          {' / '}
                          <span className="text-[#bb0000]">{toPersianDigits(s.time.unplannedDowntimeMinutes)}</span>
                        </td>
                        <td className="p-2.5 text-center font-mono">{toPersianDigits(s.reportsCount)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* TAB 3: BY OPERATION */}
          {activeTab === 'operations' && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-right border-collapse">
                <thead>
                  <tr className="bg-[#f5f7fa] text-[#475467] border-b border-[#e5e7eb]">
                    <th className="p-2.5 font-bold">دستور کار / قطعه</th>
                    <th className="p-2.5 font-bold">عملیات / ماشین</th>
                    <th className="p-2.5 font-bold">کیفیت داده</th>
                    <th className="p-2.5 font-bold text-center">برنامه / سالم / ضایعات</th>
                    <th className="p-2.5 font-bold text-center">تحقق</th>
                    <th className="p-2.5 font-bold text-center">A / P / Q</th>
                    <th className="p-2.5 font-bold text-center">OEE</th>
                    <th className="p-2.5 font-bold text-center">سیکل (استاندارد/واقعی)</th>
                    <th className="p-2.5 font-bold text-center">سوابق</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#eaecf0]">
                  {data.byOperation.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="p-8 text-center text-[#666666]">
                        عملیاتی در محدوده فیلترشده یافت نشد.
                      </td>
                    </tr>
                  ) : (
                    data.byOperation.map(op => {
                      const rowDq = DATA_QUALITY_META[op.dataQualityStatus];
                      return (
                        <tr
                          key={op.operationId}
                          onClick={() => setDrilldown({ kind: 'OPERATION', row: op })}
                          className="hover:bg-[#f0f7fc] transition cursor-pointer"
                        >
                          <td className="p-2.5">
                            <div className="font-bold font-mono text-[#007cc0]">{op.moNumber}</div>
                            <div className="text-[11px] text-[#333333]">{op.partName}</div>
                            <div className="text-[10px] font-mono text-[#667085]">{op.partCode}</div>
                          </td>
                          <td className="p-2.5">
                            <div className="font-bold text-[#333333]">
                              {op.stepCode} — {op.stepName}
                            </div>
                            <div className="text-[10px] text-[#667085]">
                              {op.machineCode ? `${op.machineCode} (${op.machineName})` : 'بدون ماشین تخصیص‌یافته'}
                            </div>
                          </td>
                          <td className="p-2.5">
                            <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border ${rowDq.badgeClass}`}>
                              {rowDq.labelFa}
                            </span>
                          </td>
                          <td className="p-2.5 text-center font-mono">
                            <span>{formatNumber(op.plannedQty)}</span>
                            {' / '}
                            <strong className="text-[#107e3e]">{formatNumber(op.goodQty)}</strong>
                            {' / '}
                            <strong className="text-[#bb0000]">{formatNumber(op.scrapQty + op.rejectedQty)}</strong>
                          </td>
                          <td className="p-2.5 text-center font-mono font-bold">
                            {formatPercentOrNull(op.planAdherencePercent)}
                          </td>
                          <td className="p-2.5 text-center font-mono text-[11px]">
                            <span>{formatPercentOrNull(op.availabilityPercent)}</span>
                            {' • '}
                            <span>{formatPercentOrNull(op.performancePercent)}</span>
                            {' • '}
                            <span>{formatPercentOrNull(op.qualityPercent)}</span>
                          </td>
                          <td className={`p-2.5 text-center font-mono font-bold ${getOeeValueColor(op.oeePercent)}`}>
                            {formatPercentOrNull(op.oeePercent)}
                          </td>
                          <td className="p-2.5 text-center font-mono text-[11px]">
                            {op.idealCycleTimeSec != null ? `${toPersianDigits(op.idealCycleTimeSec.toFixed(1))}s` : 'ناموجود'}
                            {' / '}
                            {op.actualCycleTimeSec != null ? `${toPersianDigits(op.actualCycleTimeSec.toFixed(1))}s` : '—'}
                          </td>
                          <td className="p-2.5 text-center">
                            <button
                              type="button"
                              onClick={e => {
                                e.stopPropagation();
                                setDrilldown({ kind: 'OPERATION', row: op });
                              }}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#e5f3fa] text-[#007cc0] text-[11px] font-bold cursor-pointer"
                            >
                              <Eye className="w-3.5 h-3.5" />
                              <span>{toPersianDigits(op.reportsCount)}</span>
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* TAB 4: BY DATE */}
          {activeTab === 'daily' && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-right border-collapse">
                <thead>
                  <tr className="bg-[#f5f7fa] text-[#475467] border-b border-[#e5e7eb]">
                    <th className="p-2.5 font-bold">تاریخ (میلادی)</th>
                    <th className="p-2.5 font-bold text-center">ماشین فعال</th>
                    <th className="p-2.5 font-bold text-center">وضعیت داده</th>
                    <th className="p-2.5 font-bold text-center">دسترس‌پذیری (A)</th>
                    <th className="p-2.5 font-bold text-center">عملکرد (P)</th>
                    <th className="p-2.5 font-bold text-center">کیفیت (Q)</th>
                    <th className="p-2.5 font-bold text-center">OEE</th>
                    <th className="p-2.5 font-bold text-center">سالم / ضایعات</th>
                    <th className="p-2.5 font-bold text-center">کارکرد / ستاپ / PM / خرابی (دقیقه)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#eaecf0]">
                  {data.byDate.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="p-8 text-center text-[#666666]">
                        هیچ رکورد روزانه‌ای در بازه انتخاب‌شده ثبت نشده است.
                      </td>
                    </tr>
                  ) : (
                    data.byDate.map(d => {
                      const rowDq = DATA_QUALITY_META[d.dataQualityStatus];
                      return (
                        <tr key={d.date} className="hover:bg-[#fafafa]">
                          <td className="p-2.5 font-mono font-bold text-[#333333]">{d.date}</td>
                          <td className="p-2.5 text-center font-mono">{toPersianDigits(d.activeMachinesCount)}</td>
                          <td className="p-2.5 text-center">
                            <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border ${rowDq.badgeClass}`}>
                              {rowDq.labelFa}
                            </span>
                          </td>
                          <td className={`p-2.5 text-center font-mono font-bold ${getOeeValueColor(d.availabilityPercent)}`}>
                            {formatPercentOrNull(d.availabilityPercent)}
                          </td>
                          <td className={`p-2.5 text-center font-mono font-bold ${getOeeValueColor(d.performancePercent)}`}>
                            {formatPercentOrNull(d.performancePercent)}
                          </td>
                          <td className={`p-2.5 text-center font-mono font-bold ${getOeeValueColor(d.qualityPercent)}`}>
                            {formatPercentOrNull(d.qualityPercent)}
                          </td>
                          <td className={`p-2.5 text-center font-mono font-bold ${getOeeValueColor(d.oeePercent)}`}>
                            {formatPercentOrNull(d.oeePercent)}
                          </td>
                          <td className="p-2.5 text-center font-mono">
                            <span className="text-[#107e3e] font-bold">{formatNumber(d.goodQty)}</span>
                            {' / '}
                            <span className="text-[#bb0000] font-bold">{formatNumber(d.scrapQty + d.rejectedQty)}</span>
                          </td>
                          <td className="p-2.5 text-center font-mono text-[11px]">
                            <span className="text-[#107e3e]">{toPersianDigits(d.time.operatingTimeMinutes)}</span>
                            {' / '}
                            <span className="text-[#b45309]">{toPersianDigits(d.time.setupTimeMinutes)}</span>
                            {' / '}
                            <span className="text-[#007cc0]">{toPersianDigits(d.time.plannedDowntimeMinutes)}</span>
                            {' / '}
                            <span className="text-[#bb0000]">{toPersianDigits(d.time.unplannedDowntimeMinutes)}</span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* TAB 5: SOURCE RECORDS */}
          {activeTab === 'sources' && (
            <div className="p-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  {[
                    { id: 'reports' as const, label: `گزارش‌های تولید (${toPersianDigits(data.sourceRecords.productionReports.length)})` },
                    { id: 'downtimes' as const, label: `رویدادهای توقف یکتا (${toPersianDigits(data.sourceRecords.downtimeEvents.length)})` },
                    { id: 'assignments' as const, label: `تخصیص‌های ماشین (${toPersianDigits(data.sourceRecords.machineAssignments.length)})` },
                  ].map(st => (
                    <button
                      key={st.id}
                      type="button"
                      onClick={() => setSourceSubTab(st.id)}
                      className={`px-3 py-1.5 rounded-sm text-xs font-bold border cursor-pointer ${
                        sourceSubTab === st.id
                          ? 'bg-[#e5f3fa] text-[#007cc0] border-[#007cc0]'
                          : 'bg-white text-[#666666] border-[#d9d9d9]'
                      }`}
                    >
                      {st.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleExportCsv('reports')}
                    className="px-2.5 py-1 rounded text-[11px] bg-white border border-[#d0d5dd] text-[#333333] hover:border-[#007cc0] cursor-pointer"
                  >
                    CSV گزارش‌های تولید
                  </button>
                  <button
                    type="button"
                    onClick={() => handleExportCsv('downtimes')}
                    className="px-2.5 py-1 rounded text-[11px] bg-white border border-[#d0d5dd] text-[#333333] hover:border-[#007cc0] cursor-pointer"
                  >
                    CSV توقفات
                  </button>
                </div>
              </div>

              {sourceSubTab === 'reports' && (
                <div className="overflow-x-auto border border-[#eaecf0] rounded">
                  <table className="w-full text-xs text-right border-collapse">
                    <thead>
                      <tr className="bg-[#f5f7fa] text-[#475467] border-b border-[#e5e7eb]">
                        <th className="p-2 font-bold">شماره گزارش / تاریخ</th>
                        <th className="p-2 font-bold">دستور کار / عملیات</th>
                        <th className="p-2 font-bold">ماشین / شیفت</th>
                        <th className="p-2 font-bold text-center">سالم / ضایعات</th>
                        <th className="p-2 font-bold text-center">کارکرد / توقف (دقیقه)</th>
                        <th className="p-2 font-bold text-center">سیکل استاندارد و منبع</th>
                        <th className="p-2 font-bold text-center">عملکرد گزارش</th>
                        <th className="p-2 font-bold">هشدارهای داده</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#eaecf0]">
                      {data.sourceRecords.productionReports.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="p-6 text-center text-[#666666]">
                            هیچ گزارش تولیدی ثبت نشده است.
                          </td>
                        </tr>
                      ) : (
                        data.sourceRecords.productionReports.map(r => (
                          <tr key={r.id} className="hover:bg-[#fafafa]">
                            <td className="p-2 font-mono">
                              <div className="font-bold text-[#333333]">{r.reportNumber}</div>
                              <div className="text-[10px] text-[#667085]">{r.dateKey}</div>
                            </td>
                            <td className="p-2">
                              <div className="font-mono font-bold text-[#007cc0]">{r.moNumber}</div>
                              <div className="text-[11px] text-[#333333]">{r.stepCode} — {r.partName}</div>
                            </td>
                            <td className="p-2">
                              <div className="font-mono font-bold">{r.machineCode}</div>
                              <div className="text-[10px] text-[#667085]">{r.shiftName} • {r.operatorName}</div>
                            </td>
                            <td className="p-2 text-center font-mono">
                              <span className="text-[#107e3e] font-bold">{formatNumber(r.goodQty)}</span>
                              {' / '}
                              <span className="text-[#bb0000]">{formatNumber(r.scrapQty + r.rejectedQty)}</span>
                            </td>
                            <td className="p-2 text-center font-mono">
                              {toPersianDigits(r.runTimeMinutes)} / {toPersianDigits(r.downtimeMinutes)}
                            </td>
                            <td className="p-2 text-center text-[11px]">
                              <div className="font-mono">{formatSecondsFa(r.idealCycleTimeSec)}</div>
                              <div className="text-[10px] text-[#667085]">{CYCLE_SOURCE_LABELS[r.idealCycleSource] || r.idealCycleSource}</div>
                            </td>
                            <td className={`p-2 text-center font-mono font-bold ${getOeeValueColor(r.reportPerformancePercent)}`}>
                              {formatPercentOrNull(r.reportPerformancePercent)}
                            </td>
                            <td className="p-2 text-[10px]">
                              {r.dataFlags.length === 0 ? (
                                <span className="text-[#107e3e] flex items-center gap-1">
                                  <CheckCircle2 className="w-3 h-3" /> سالم
                                </span>
                              ) : (
                                <div className="flex flex-wrap gap-1">
                                  {r.dataFlags.map(f => (
                                    <span key={f} className="px-1.5 py-0.5 rounded bg-[#fff4e5] text-[#b45309] font-mono">
                                      {f}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {sourceSubTab === 'downtimes' && (
                <div className="overflow-x-auto border border-[#eaecf0] rounded">
                  <table className="w-full text-xs text-right border-collapse">
                    <thead>
                      <tr className="bg-[#f5f7fa] text-[#475467] border-b border-[#e5e7eb]">
                        <th className="p-2 font-bold">تاریخ</th>
                        <th className="p-2 font-bold">دسته‌بندی</th>
                        <th className="p-2 font-bold">ماشین / شیفت</th>
                        <th className="p-2 font-bold">دستور کار / عملیات</th>
                        <th className="p-2 font-bold">علت توقف</th>
                        <th className="p-2 font-bold text-center">مدت (دقیقه)</th>
                        <th className="p-2 font-bold">منبع ثبت</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#eaecf0]">
                      {data.sourceRecords.downtimeEvents.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="p-6 text-center text-[#666666]">
                            هیچ رویداد توقفی ثبت نشده است.
                          </td>
                        </tr>
                      ) : (
                        data.sourceRecords.downtimeEvents.map(d => {
                          const cat = DOWNTIME_CATEGORY_META[d.category];
                          return (
                            <tr key={d.id} className="hover:bg-[#fafafa]">
                              <td className="p-2 font-mono">{d.dateKey}</td>
                              <td className="p-2">
                                <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${cat.badgeClass}`}>
                                  {cat.labelFa}
                                </span>
                              </td>
                              <td className="p-2">
                                <span className="font-mono font-bold">{d.machineCode}</span>
                                <span className="text-[10px] text-[#667085] block">{d.shiftName || '—'}</span>
                              </td>
                              <td className="p-2 font-mono text-[11px]">
                                {d.moNumber || '—'} {d.stepCode ? `/ ${d.stepCode}` : ''}
                              </td>
                              <td className="p-2 text-[#333333]">{d.reason}</td>
                              <td className="p-2 text-center font-mono font-bold text-[#bb0000]">
                                {toPersianDigits(d.durationMinutes)}
                              </td>
                              <td className="p-2 text-[10px] font-mono text-[#667085]">
                                {d.source} ({d.recordedBy})
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {sourceSubTab === 'assignments' && (
                <div className="overflow-x-auto border border-[#eaecf0] rounded">
                  <table className="w-full text-xs text-right border-collapse">
                    <thead>
                      <tr className="bg-[#f5f7fa] text-[#475467] border-b border-[#e5e7eb]">
                        <th className="p-2 font-bold">تاریخ تخصیص</th>
                        <th className="p-2 font-bold">ماشین</th>
                        <th className="p-2 font-bold">شیفت</th>
                        <th className="p-2 font-bold">دستور کار / مرحله</th>
                        <th className="p-2 font-bold text-center">ظرفیت شیفت (دقیقه)</th>
                        <th className="p-2 font-bold text-center">وضعیت</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#eaecf0]">
                      {data.sourceRecords.machineAssignments.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="p-6 text-center text-[#666666]">
                            هیچ تخصیص ماشینی در بازه انتخاب‌شده یافت نشد.
                          </td>
                        </tr>
                      ) : (
                        data.sourceRecords.machineAssignments.map(a => (
                          <tr key={a.id} className="hover:bg-[#fafafa]">
                            <td className="p-2 font-mono">{a.assignedDate}</td>
                            <td className="p-2 font-mono font-bold">{a.machineCode} — {a.machineName}</td>
                            <td className="p-2">{a.shiftName}</td>
                            <td className="p-2 font-mono">{a.moNumber} / {a.stepCode}</td>
                            <td className="p-2 text-center font-mono">{toPersianDigits(a.productiveMinutes)}</td>
                            <td className="p-2 text-center font-mono text-[11px]">{a.status}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Drill-Down Drawer for Machine or Operation */}
      {drilldown && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex justify-end"
          onClick={() => setDrilldown(null)}
        >
          <div
            className="w-full max-w-2xl bg-white h-full shadow-2xl overflow-y-auto p-5 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-[#e5e7eb] pb-3">
              <div>
                <div className="flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-[#007cc0]" />
                  <h3 className="text-sm font-bold text-[#333333]">
                    {drilldown.kind === 'MACHINE'
                      ? `ریز سوابق عملکرد ماشین ${drilldown.row.machineCode} — ${drilldown.row.machineName}`
                      : `ریز سوابق عملیات ${drilldown.row.moNumber} / ${drilldown.row.stepCode}`}
                  </h3>
                </div>
                <p className="text-xs text-[#666666] mt-0.5">
                  {drilldown.kind === 'MACHINE'
                    ? `${drilldown.row.hallLocation} • وضعیت: ${drilldown.row.status}`
                    : `${drilldown.row.partName} (${drilldown.row.partCode})`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDrilldown(null)}
                className="p-1 rounded hover:bg-[#f2f4f7] text-[#666666] cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Drilldown KPIs */}
            <div className="grid grid-cols-4 gap-2 text-center text-xs">
              <div className="p-2.5 rounded bg-[#f8fafc] border border-[#e5e7eb]">
                <span className="text-[#667085] block">Availability</span>
                <strong className={`font-mono text-base ${getOeeValueColor(drilldown.row.availabilityPercent)}`}>
                  {formatPercentOrNull(drilldown.row.availabilityPercent)}
                </strong>
              </div>
              <div className="p-2.5 rounded bg-[#f8fafc] border border-[#e5e7eb]">
                <span className="text-[#667085] block">Performance</span>
                <strong className={`font-mono text-base ${getOeeValueColor(drilldown.row.performancePercent)}`}>
                  {formatPercentOrNull(drilldown.row.performancePercent)}
                </strong>
              </div>
              <div className="p-2.5 rounded bg-[#f8fafc] border border-[#e5e7eb]">
                <span className="text-[#667085] block">Quality</span>
                <strong className={`font-mono text-base ${getOeeValueColor(drilldown.row.qualityPercent)}`}>
                  {formatPercentOrNull(drilldown.row.qualityPercent)}
                </strong>
              </div>
              <div className="p-2.5 rounded bg-[#f8fafc] border border-[#e5e7eb]">
                <span className="text-[#667085] block">OEE</span>
                <strong className={`font-mono text-base ${getOeeValueColor(drilldown.row.oeePercent)}`}>
                  {formatPercentOrNull(drilldown.row.oeePercent)}
                </strong>
              </div>
            </div>

            {/* Data Quality Warnings for this entity */}
            {drilldown.row.dataQualityIssues.length > 0 && (
              <div className="p-3 rounded bg-[#fffcf5] border border-[#e9730c]/30 text-xs space-y-1">
                <div className="font-bold text-[#b45309] flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4" />
                  هشدارها و ورودی‌های ناقص این رکورد
                </div>
                <ul className="list-disc pr-5 text-[11px] text-[#475467] space-y-0.5">
                  {drilldown.row.dataQualityIssues.map((iss, i) => (
                    <li key={`${iss.code}-${i}`}>{iss.messageFa}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Source Production Reports */}
            <div className="space-y-2">
              <h4 className="text-xs font-bold text-[#333333]">
                گزارش‌های تولید منبع ({toPersianDigits(drilldownRecords.reports.length)})
              </h4>
              {drilldownRecords.reports.length === 0 ? (
                <p className="text-xs text-[#666666] bg-[#fafafa] p-3 rounded border border-[#eaecf0]">
                  گزارش تولیدی برای این ردیف ثبت نشده است.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {drilldownRecords.reports.map(r => (
                    <div key={r.id} className="p-2.5 rounded border border-[#eaecf0] bg-[#fafafa] text-xs space-y-1">
                      <div className="flex items-center justify-between font-mono">
                        <strong className="text-[#007cc0]">{r.reportNumber}</strong>
                        <span className="text-[#667085]">{r.dateKey} • {r.shiftName}</span>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                        <span>{r.moNumber} / {r.stepCode} ({r.partName})</span>
                        <span className="font-mono">
                          سالم: <strong className="text-[#107e3e]">{formatNumber(r.goodQty)}</strong> | ضایعات: <strong className="text-[#bb0000]">{formatNumber(r.scrapQty + r.rejectedQty)}</strong> | کارکرد: <strong>{toPersianDigits(r.runTimeMinutes)} د</strong>
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Source Downtime Events */}
            <div className="space-y-2">
              <h4 className="text-xs font-bold text-[#333333]">
                رویدادهای توقف منبع ({toPersianDigits(drilldownRecords.downtimes.length)})
              </h4>
              {drilldownRecords.downtimes.length === 0 ? (
                <p className="text-xs text-[#666666] bg-[#fafafa] p-3 rounded border border-[#eaecf0]">
                  رویداد توقفی برای این ردیف ثبت نشده است.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {drilldownRecords.downtimes.map(d => {
                    const cat = DOWNTIME_CATEGORY_META[d.category];
                    return (
                      <div key={d.id} className="p-2.5 rounded border border-[#eaecf0] bg-[#fafafa] text-xs flex items-center justify-between gap-2">
                        <div>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ml-2 ${cat.badgeClass}`}>
                            {cat.labelFa}
                          </span>
                          <span className="font-medium text-[#333333]">{d.reason}</span>
                          <div className="text-[10px] text-[#667085] mt-0.5 font-mono">
                            {d.dateKey} • {d.source} • {d.recordedBy}
                          </div>
                        </div>
                        <span className="font-mono font-bold text-[#bb0000] shrink-0">
                          {toPersianDigits(d.durationMinutes)} دقیقه
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
