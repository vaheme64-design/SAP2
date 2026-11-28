import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Gauge,
  Activity,
  ShieldCheck,
  Zap,
  RefreshCw,
  Download,
  Printer,
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
  Database,
} from 'lucide-react';
import type {
  OeeAnalyticsResponse,
  OeeAnalyticsMachineRow,
  OeeAnalyticsShiftRow,
  OeeAnalyticsOperationRow,
  OeeAnalyticsDailyRow,
  OeeSourceReportRecord,
  OeeSourceDowntimeEvent,
  OeeSourceAssignmentRecord,
  OeeDataQualityStatus,
  OeeDowntimeCategory,
} from '../../types/oeeAndConsumables';
import { formatNumber, toPersianDigits } from '../../utils/formatters';
import { ReportModuleSkeleton } from '../common/Skeleton';
import { useErpRouter } from '../../context/RouterContext';
import {
  FioriDynamicPage,
  FioriDataTable,
  FioriToolbar,
  FioriObjectStatus,
  FioriMessageStrip,
  type FioriTableColumn,
  type FioriStatusTone,
} from '../fiori/ui';
import { EmptyState } from '../common/EmptyState';

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
  { labelFa: string; tone: FioriStatusTone }
> = {
  RELIABLE: {
    labelFa: 'معتبر (داده کامل)',
    tone: 'positive',
  },
  PARTIAL: {
    labelFa: 'ناقص جزئی (نیاز به بررسی)',
    tone: 'critical',
  },
  UNRELIABLE: {
    labelFa: 'نامعتبر / ناسازگار',
    tone: 'negative',
  },
  INSUFFICIENT_DATA: {
    labelFa: 'داده ناکافی (عدم محاسبه)',
    tone: 'neutral',
  },
};

const DOWNTIME_CATEGORY_META: Record<
  OeeDowntimeCategory,
  { labelFa: string; tone: FioriStatusTone; barClass: string }
> = {
  UNPLANNED: {
    labelFa: 'توقف اضطراری / خرابی',
    tone: 'negative',
    barClass: 'bg-[var(--fiori-negative)]',
  },
  SETUP: {
    labelFa: 'ستاپ و تعویض قالب',
    tone: 'critical',
    barClass: 'bg-[var(--fiori-critical)]',
  },
  PLANNED: {
    labelFa: 'توقف برنامه‌ریزی‌شده (PM)',
    tone: 'info',
    barClass: 'bg-[var(--fiori-brand)]',
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
  if (value === null) return 'text-[var(--fiori-text-muted)]';
  if (value >= 85) return 'text-[var(--fiori-positive)]';
  if (value >= 70) return 'text-[var(--fiori-brand)]';
  if (value >= 55) return 'text-[var(--fiori-critical)]';
  return 'text-[var(--fiori-negative)]';
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

  const activeFiltersCount = useMemo(() => {
    let count = 0;
    if (startDate) count += 1;
    if (endDate) count += 1;
    if (machineFilter !== 'ALL') count += 1;
    if (shiftFilter !== 'ALL') count += 1;
    if (hallFilter !== 'ALL') count += 1;
    return count;
  }, [startDate, endDate, machineFilter, shiftFilter, hallFilter]);

  const machineColumns = useMemo<FioriTableColumn<OeeAnalyticsMachineRow>[]>(
    () => [
      {
        key: 'machine',
        header: 'ماشین / سالن',
        sortable: true,
        sortValue: m => m.machineCode,
        render: m => (
          <div>
            <div className="fiori-ltr-code font-semibold text-[var(--fiori-text-primary)] font-mono">
              {m.machineCode}
            </div>
            <div className="text-[11px] text-[var(--fiori-text-secondary)]">{m.machineName}</div>
            <div className="text-[10px] text-[var(--fiori-text-muted)]">{m.hallLocation}</div>
          </div>
        ),
      },
      {
        key: 'status',
        header: 'وضعیت داده',
        sortable: true,
        sortValue: m => m.dataQualityStatus,
        render: m => {
          const rowDq = DATA_QUALITY_META[m.dataQualityStatus];
          return (
            <div>
              <FioriObjectStatus tone={rowDq.tone} label={rowDq.labelFa} icon />
              {m.missingInputs.length > 0 && (
                <div className="text-[10px] text-[var(--fiori-critical)] mt-1">
                  مفقود: {m.missingInputs.join('، ')}
                </div>
              )}
            </div>
          );
        },
      },
      {
        key: 'availability',
        header: 'دسترس‌پذیری (A)',
        align: 'center',
        sortable: true,
        sortValue: m => m.availabilityPercent ?? -1,
        isMono: true,
        render: m => (
          <span className={`font-semibold ${getOeeValueColor(m.availabilityPercent)}`}>
            {formatPercentOrNull(m.availabilityPercent)}
          </span>
        ),
      },
      {
        key: 'performance',
        header: 'عملکرد (P)',
        align: 'center',
        sortable: true,
        sortValue: m => m.performancePercent ?? -1,
        isMono: true,
        render: m => (
          <div className={`font-semibold ${getOeeValueColor(m.performancePercent)}`}>
            <div>{formatPercentOrNull(m.performancePercent)}</div>
            {m.rawPerformancePercent !== null && m.rawPerformancePercent > 100.5 && (
              <div className="text-[10px] text-[var(--fiori-negative)]">
                خام: {formatPercentOrNull(m.rawPerformancePercent)}
              </div>
            )}
          </div>
        ),
      },
      {
        key: 'quality',
        header: 'کیفیت (Q)',
        align: 'center',
        sortable: true,
        sortValue: m => m.qualityPercent ?? -1,
        isMono: true,
        render: m => (
          <span className={`font-semibold ${getOeeValueColor(m.qualityPercent)}`}>
            {formatPercentOrNull(m.qualityPercent)}
          </span>
        ),
      },
      {
        key: 'oee',
        header: 'OEE',
        align: 'center',
        sortable: true,
        sortValue: m => m.oeePercent ?? -1,
        isMono: true,
        render: m => (
          <span className={`font-semibold text-sm ${getOeeValueColor(m.oeePercent)}`}>
            {formatPercentOrNull(m.oeePercent)}
          </span>
        ),
      },
      {
        key: 'planVsActual',
        header: 'واقعی / برنامه',
        align: 'center',
        sortable: true,
        sortValue: m => m.goodQty,
        isMono: true,
        render: m => (
          <div>
            <div>
              <strong className="text-[var(--fiori-text-primary)]">{formatNumber(m.goodQty)}</strong> /{' '}
              {formatNumber(m.plannedQty)}
            </div>
            <div className="text-[10px] text-[var(--fiori-text-muted)]">
              تحقق: {formatPercentOrNull(m.planAdherencePercent)}
            </div>
          </div>
        ),
      },
      {
        key: 'goodScrap',
        header: 'سالم / ضایعات',
        align: 'center',
        isMono: true,
        render: m => (
          <span>
            <span className="text-[var(--fiori-positive)] font-semibold">{formatNumber(m.goodQty)}</span>
            <span className="mx-1 text-[var(--fiori-text-muted)]">/</span>
            <span className="text-[var(--fiori-negative)] font-semibold">
              {formatNumber(m.scrapQty + m.rejectedQty)}
            </span>
          </span>
        ),
      },
      {
        key: 'timeBreakdown',
        header: 'زمان (تولید/ستاپ/PM/خرابی)',
        align: 'center',
        isMono: true,
        hideBelow: 'lg',
        render: m => (
          <span className="text-[11px]">
            <span className="text-[var(--fiori-positive)]" title="کارکرد">
              {toPersianDigits(m.time.operatingTimeMinutes)}
            </span>
            {' / '}
            <span className="text-[var(--fiori-critical)]" title="ستاپ">
              {toPersianDigits(m.time.setupTimeMinutes)}
            </span>
            {' / '}
            <span className="text-[var(--fiori-brand)]" title="توقف برنامه‌ریزی">
              {toPersianDigits(m.time.plannedDowntimeMinutes)}
            </span>
            {' / '}
            <span className="text-[var(--fiori-negative)]" title="خرابی اضطراری">
              {toPersianDigits(m.time.unplannedDowntimeMinutes)}
            </span>
          </span>
        ),
      },
      {
        key: 'cycle',
        header: 'سیکل (استاندارد / واقعی)',
        align: 'center',
        isMono: true,
        hideBelow: 'md',
        render: m => (
          <div className="text-[11px]">
            <div>
              {m.idealCycleTimeSec != null ? `${toPersianDigits(m.idealCycleTimeSec.toFixed(1))}s` : 'ناموجود'}
            </div>
            <div className="text-[var(--fiori-text-muted)]">
              {m.actualCycleTimeSec != null ? `${toPersianDigits(m.actualCycleTimeSec.toFixed(1))}s` : '—'}
            </div>
          </div>
        ),
      },
      {
        key: 'records',
        header: 'سوابق',
        align: 'center',
        render: m => (
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              setDrilldown({ kind: 'MACHINE', row: m });
            }}
            className="sap-btn-standard inline-flex items-center gap-1 px-2 py-1 text-[11px] text-[var(--fiori-brand)] font-semibold cursor-pointer"
          >
            <Eye className="w-3.5 h-3.5" />
            <span>{toPersianDigits(m.reportsCount + m.downtimeEventsCount)}</span>
          </button>
        ),
      },
    ],
    [],
  );

  const shiftColumns = useMemo<FioriTableColumn<OeeAnalyticsShiftRow>[]>(
    () => [
      {
        key: 'shift',
        header: 'شیفت کاری',
        sortable: true,
        sortValue: s => s.shiftName,
        render: s => (
          <div>
            <div className="font-semibold text-[var(--fiori-text-primary)]">{s.shiftName}</div>
            <div className="text-[10px] font-mono text-[var(--fiori-text-muted)]">
              <span className="fiori-ltr-code">{s.shiftCode}</span> • {toPersianDigits(s.productiveHoursPerShift)} ساعت/شیفت
            </div>
          </div>
        ),
      },
      {
        key: 'status',
        header: 'وضعیت داده',
        render: s => {
          const rowDq = DATA_QUALITY_META[s.dataQualityStatus];
          return <FioriObjectStatus tone={rowDq.tone} label={rowDq.labelFa} icon />;
        },
      },
      {
        key: 'availability',
        header: 'دسترس‌پذیری (A)',
        align: 'center',
        sortable: true,
        sortValue: s => s.availabilityPercent ?? -1,
        isMono: true,
        render: s => (
          <span className={`font-semibold ${getOeeValueColor(s.availabilityPercent)}`}>
            {formatPercentOrNull(s.availabilityPercent)}
          </span>
        ),
      },
      {
        key: 'performance',
        header: 'عملکرد (P)',
        align: 'center',
        sortable: true,
        sortValue: s => s.performancePercent ?? -1,
        isMono: true,
        render: s => (
          <span className={`font-semibold ${getOeeValueColor(s.performancePercent)}`}>
            {formatPercentOrNull(s.performancePercent)}
          </span>
        ),
      },
      {
        key: 'quality',
        header: 'کیفیت (Q)',
        align: 'center',
        sortable: true,
        sortValue: s => s.qualityPercent ?? -1,
        isMono: true,
        render: s => (
          <span className={`font-semibold ${getOeeValueColor(s.qualityPercent)}`}>
            {formatPercentOrNull(s.qualityPercent)}
          </span>
        ),
      },
      {
        key: 'oee',
        header: 'OEE',
        align: 'center',
        sortable: true,
        sortValue: s => s.oeePercent ?? -1,
        isMono: true,
        render: s => (
          <span className={`font-semibold text-sm ${getOeeValueColor(s.oeePercent)}`}>
            {formatPercentOrNull(s.oeePercent)}
          </span>
        ),
      },
      {
        key: 'planVsActual',
        header: 'واقعی / برنامه',
        align: 'center',
        isMono: true,
        render: s => (
          <span>
            {formatNumber(s.goodQty)} / {formatNumber(s.plannedQty)}
          </span>
        ),
      },
      {
        key: 'goodScrap',
        header: 'سالم / ضایعات',
        align: 'center',
        isMono: true,
        render: s => (
          <span>
            <span className="text-[var(--fiori-positive)] font-semibold">{formatNumber(s.goodQty)}</span>
            {' / '}
            <span className="text-[var(--fiori-negative)] font-semibold">
              {formatNumber(s.scrapQty + s.rejectedQty)}
            </span>
          </span>
        ),
      },
      {
        key: 'opTime',
        header: 'کارکرد (دقیقه)',
        align: 'center',
        sortable: true,
        sortValue: s => s.time.operatingTimeMinutes,
        isMono: true,
        render: s => toPersianDigits(s.time.operatingTimeMinutes),
      },
      {
        key: 'losses',
        header: 'ستاپ / PM / خرابی',
        align: 'center',
        isMono: true,
        hideBelow: 'md',
        render: s => (
          <span className="text-[11px]">
            <span className="text-[var(--fiori-critical)]">{toPersianDigits(s.time.setupTimeMinutes)}</span>
            {' / '}
            <span className="text-[var(--fiori-brand)]">{toPersianDigits(s.time.plannedDowntimeMinutes)}</span>
            {' / '}
            <span className="text-[var(--fiori-negative)]">{toPersianDigits(s.time.unplannedDowntimeMinutes)}</span>
          </span>
        ),
      },
      {
        key: 'reportsCount',
        header: 'تعداد گزارش',
        align: 'center',
        sortable: true,
        sortValue: s => s.reportsCount,
        isMono: true,
        render: s => toPersianDigits(s.reportsCount),
      },
    ],
    [],
  );

  const operationColumns = useMemo<FioriTableColumn<OeeAnalyticsOperationRow>[]>(
    () => [
      {
        key: 'moPart',
        header: 'دستور کار / قطعه',
        sortable: true,
        sortValue: op => op.moNumber,
        render: op => (
          <div>
            <div className="fiori-ltr-code font-semibold font-mono text-[var(--fiori-brand)]">
              {op.moNumber}
            </div>
            <div className="text-[11px] text-[var(--fiori-text-primary)]">{op.partName}</div>
            <div className="fiori-ltr-code text-[10px] font-mono text-[var(--fiori-text-muted)]">
              {op.partCode}
            </div>
          </div>
        ),
      },
      {
        key: 'opMachine',
        header: 'عملیات / ماشین',
        sortable: true,
        sortValue: op => op.stepCode,
        render: op => (
          <div>
            <div className="font-semibold text-[var(--fiori-text-primary)]">
              <span className="fiori-ltr-code font-mono">{op.stepCode}</span> — {op.stepName}
            </div>
            <div className="text-[10px] text-[var(--fiori-text-muted)]">
              {op.machineCode ? `${op.machineCode} (${op.machineName})` : 'بدون ماشین تخصیص‌یافته'}
            </div>
          </div>
        ),
      },
      {
        key: 'status',
        header: 'کیفیت داده',
        render: op => {
          const rowDq = DATA_QUALITY_META[op.dataQualityStatus];
          return <FioriObjectStatus tone={rowDq.tone} label={rowDq.labelFa} icon />;
        },
      },
      {
        key: 'quantities',
        header: 'برنامه / سالم / ضایعات',
        align: 'center',
        isMono: true,
        render: op => (
          <span>
            <span>{formatNumber(op.plannedQty)}</span>
            {' / '}
            <strong className="text-[var(--fiori-positive)]">{formatNumber(op.goodQty)}</strong>
            {' / '}
            <strong className="text-[var(--fiori-negative)]">{formatNumber(op.scrapQty + op.rejectedQty)}</strong>
          </span>
        ),
      },
      {
        key: 'adherence',
        header: 'تحقق',
        align: 'center',
        sortable: true,
        sortValue: op => op.planAdherencePercent ?? -1,
        isMono: true,
        render: op => (
          <span className="font-semibold">{formatPercentOrNull(op.planAdherencePercent)}</span>
        ),
      },
      {
        key: 'apq',
        header: 'A / P / Q',
        align: 'center',
        isMono: true,
        hideBelow: 'md',
        render: op => (
          <span className="text-[11px]">
            <span>{formatPercentOrNull(op.availabilityPercent)}</span>
            {' • '}
            <span>{formatPercentOrNull(op.performancePercent)}</span>
            {' • '}
            <span>{formatPercentOrNull(op.qualityPercent)}</span>
          </span>
        ),
      },
      {
        key: 'oee',
        header: 'OEE',
        align: 'center',
        sortable: true,
        sortValue: op => op.oeePercent ?? -1,
        isMono: true,
        render: op => (
          <span className={`font-semibold ${getOeeValueColor(op.oeePercent)}`}>
            {formatPercentOrNull(op.oeePercent)}
          </span>
        ),
      },
      {
        key: 'cycle',
        header: 'سیکل (استاندارد/واقعی)',
        align: 'center',
        isMono: true,
        hideBelow: 'lg',
        render: op => (
          <span className="text-[11px]">
            {op.idealCycleTimeSec != null ? `${toPersianDigits(op.idealCycleTimeSec.toFixed(1))}s` : 'ناموجود'}
            {' / '}
            {op.actualCycleTimeSec != null ? `${toPersianDigits(op.actualCycleTimeSec.toFixed(1))}s` : '—'}
          </span>
        ),
      },
      {
        key: 'records',
        header: 'سوابق',
        align: 'center',
        render: op => (
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              setDrilldown({ kind: 'OPERATION', row: op });
            }}
            className="sap-btn-standard inline-flex items-center gap-1 px-2 py-1 text-[11px] text-[var(--fiori-brand)] font-semibold cursor-pointer"
          >
            <Eye className="w-3.5 h-3.5" />
            <span>{toPersianDigits(op.reportsCount)}</span>
          </button>
        ),
      },
    ],
    [],
  );

  const dailyColumns = useMemo<FioriTableColumn<OeeAnalyticsDailyRow>[]>(
    () => [
      {
        key: 'date',
        header: 'تاریخ (میلادی)',
        sortable: true,
        sortValue: d => d.date,
        isLtrCode: true,
        render: d => <span className="font-semibold text-[var(--fiori-text-primary)]">{d.date}</span>,
      },
      {
        key: 'activeMachines',
        header: 'ماشین فعال',
        align: 'center',
        sortable: true,
        sortValue: d => d.activeMachinesCount,
        isMono: true,
        render: d => toPersianDigits(d.activeMachinesCount),
      },
      {
        key: 'status',
        header: 'وضعیت داده',
        align: 'center',
        render: d => {
          const rowDq = DATA_QUALITY_META[d.dataQualityStatus];
          return <FioriObjectStatus tone={rowDq.tone} label={rowDq.labelFa} icon />;
        },
      },
      {
        key: 'availability',
        header: 'دسترس‌پذیری (A)',
        align: 'center',
        sortable: true,
        sortValue: d => d.availabilityPercent ?? -1,
        isMono: true,
        render: d => (
          <span className={`font-semibold ${getOeeValueColor(d.availabilityPercent)}`}>
            {formatPercentOrNull(d.availabilityPercent)}
          </span>
        ),
      },
      {
        key: 'performance',
        header: 'عملکرد (P)',
        align: 'center',
        sortable: true,
        sortValue: d => d.performancePercent ?? -1,
        isMono: true,
        render: d => (
          <span className={`font-semibold ${getOeeValueColor(d.performancePercent)}`}>
            {formatPercentOrNull(d.performancePercent)}
          </span>
        ),
      },
      {
        key: 'quality',
        header: 'کیفیت (Q)',
        align: 'center',
        sortable: true,
        sortValue: d => d.qualityPercent ?? -1,
        isMono: true,
        render: d => (
          <span className={`font-semibold ${getOeeValueColor(d.qualityPercent)}`}>
            {formatPercentOrNull(d.qualityPercent)}
          </span>
        ),
      },
      {
        key: 'oee',
        header: 'OEE',
        align: 'center',
        sortable: true,
        sortValue: d => d.oeePercent ?? -1,
        isMono: true,
        render: d => (
          <span className={`font-semibold ${getOeeValueColor(d.oeePercent)}`}>
            {formatPercentOrNull(d.oeePercent)}
          </span>
        ),
      },
      {
        key: 'goodScrap',
        header: 'سالم / ضایعات',
        align: 'center',
        isMono: true,
        render: d => (
          <span>
            <span className="text-[var(--fiori-positive)] font-semibold">{formatNumber(d.goodQty)}</span>
            {' / '}
            <span className="text-[var(--fiori-negative)] font-semibold">
              {formatNumber(d.scrapQty + d.rejectedQty)}
            </span>
          </span>
        ),
      },
      {
        key: 'timeBreakdown',
        header: 'کارکرد / ستاپ / PM / خرابی (دقیقه)',
        align: 'center',
        isMono: true,
        hideBelow: 'md',
        render: d => (
          <span className="text-[11px]">
            <span className="text-[var(--fiori-positive)]">{toPersianDigits(d.time.operatingTimeMinutes)}</span>
            {' / '}
            <span className="text-[var(--fiori-critical)]">{toPersianDigits(d.time.setupTimeMinutes)}</span>
            {' / '}
            <span className="text-[var(--fiori-brand)]">{toPersianDigits(d.time.plannedDowntimeMinutes)}</span>
            {' / '}
            <span className="text-[var(--fiori-negative)]">{toPersianDigits(d.time.unplannedDowntimeMinutes)}</span>
          </span>
        ),
      },
    ],
    [],
  );

  const sourceReportColumns = useMemo<FioriTableColumn<OeeSourceReportRecord>[]>(
    () => [
      {
        key: 'reportNumber',
        header: 'شماره گزارش / تاریخ',
        sortable: true,
        sortValue: r => r.dateKey,
        isMono: true,
        render: r => (
          <div>
            <div className="fiori-ltr-code font-semibold text-[var(--fiori-text-primary)]">{r.reportNumber}</div>
            <div className="fiori-ltr-code text-[10px] text-[var(--fiori-text-muted)]">{r.dateKey}</div>
          </div>
        ),
      },
      {
        key: 'mo',
        header: 'دستور کار / عملیات',
        sortable: true,
        sortValue: r => r.moNumber,
        render: r => (
          <div>
            <div className="fiori-ltr-code font-mono font-semibold text-[var(--fiori-brand)]">{r.moNumber}</div>
            <div className="text-[11px] text-[var(--fiori-text-primary)]">
              <span className="fiori-ltr-code font-mono">{r.stepCode}</span> — {r.partName}
            </div>
          </div>
        ),
      },
      {
        key: 'machineShift',
        header: 'ماشین / شیفت',
        render: r => (
          <div>
            <div className="fiori-ltr-code font-mono font-semibold text-[var(--fiori-text-primary)]">
              {r.machineCode}
            </div>
            <div className="text-[10px] text-[var(--fiori-text-muted)]">
              {r.shiftName} • {r.operatorName}
            </div>
          </div>
        ),
      },
      {
        key: 'goodScrap',
        header: 'سالم / ضایعات',
        align: 'center',
        isMono: true,
        render: r => (
          <span>
            <span className="text-[var(--fiori-positive)] font-semibold">{formatNumber(r.goodQty)}</span>
            {' / '}
            <span className="text-[var(--fiori-negative)]">{formatNumber(r.scrapQty + r.rejectedQty)}</span>
          </span>
        ),
      },
      {
        key: 'runDowntime',
        header: 'کارکرد / توقف (دقیقه)',
        align: 'center',
        isMono: true,
        render: r => `${toPersianDigits(r.runTimeMinutes)} / ${toPersianDigits(r.downtimeMinutes)}`,
      },
      {
        key: 'idealCycle',
        header: 'سیکل استاندارد و منبع',
        align: 'center',
        hideBelow: 'md',
        render: r => (
          <div className="text-[11px]">
            <div className="font-mono">{formatSecondsFa(r.idealCycleTimeSec)}</div>
            <div className="text-[10px] text-[var(--fiori-text-muted)]">
              {CYCLE_SOURCE_LABELS[r.idealCycleSource] || r.idealCycleSource}
            </div>
          </div>
        ),
      },
      {
        key: 'perf',
        header: 'عملکرد گزارش',
        align: 'center',
        sortable: true,
        sortValue: r => r.reportPerformancePercent ?? -1,
        isMono: true,
        render: r => (
          <span className={`font-semibold ${getOeeValueColor(r.reportPerformancePercent)}`}>
            {formatPercentOrNull(r.reportPerformancePercent)}
          </span>
        ),
      },
      {
        key: 'flags',
        header: 'هشدارهای داده',
        render: r =>
          r.dataFlags.length === 0 ? (
            <FioriObjectStatus tone="positive" variant="text" label="سالم" icon />
          ) : (
            <div className="flex flex-wrap gap-1">
              {r.dataFlags.map(f => (
                <FioriObjectStatus key={f} tone="critical" label={f} ltrCode />
              ))}
            </div>
          ),
      },
    ],
    [],
  );

  const sourceDowntimeColumns = useMemo<FioriTableColumn<OeeSourceDowntimeEvent>[]>(
    () => [
      {
        key: 'dateKey',
        header: 'تاریخ',
        sortable: true,
        sortValue: d => d.dateKey,
        isLtrCode: true,
        render: d => d.dateKey,
      },
      {
        key: 'category',
        header: 'دسته‌بندی',
        sortable: true,
        sortValue: d => d.category,
        render: d => {
          const cat = DOWNTIME_CATEGORY_META[d.category];
          return <FioriObjectStatus tone={cat.tone} label={cat.labelFa} />;
        },
      },
      {
        key: 'machineShift',
        header: 'ماشین / شیفت',
        render: d => (
          <div>
            <span className="fiori-ltr-code font-mono font-semibold text-[var(--fiori-text-primary)]">
              {d.machineCode}
            </span>
            <span className="text-[10px] text-[var(--fiori-text-muted)] block">{d.shiftName || '—'}</span>
          </div>
        ),
      },
      {
        key: 'moOp',
        header: 'دستور کار / عملیات',
        isLtrCode: true,
        render: d => `${d.moNumber || '—'}${d.stepCode ? ` / ${d.stepCode}` : ''}`,
      },
      {
        key: 'reason',
        header: 'علت توقف',
        render: d => <span className="text-[var(--fiori-text-primary)]">{d.reason}</span>,
      },
      {
        key: 'duration',
        header: 'مدت (دقیقه)',
        align: 'center',
        sortable: true,
        sortValue: d => d.durationMinutes,
        isMono: true,
        render: d => (
          <span className="font-semibold text-[var(--fiori-negative)]">
            {toPersianDigits(d.durationMinutes)}
          </span>
        ),
      },
      {
        key: 'source',
        header: 'منبع ثبت',
        hideBelow: 'md',
        render: d => (
          <span className="text-[10px] font-mono text-[var(--fiori-text-muted)]">
            <span className="fiori-ltr-code">{d.source}</span> ({d.recordedBy})
          </span>
        ),
      },
    ],
    [],
  );

  const sourceAssignmentColumns = useMemo<FioriTableColumn<OeeSourceAssignmentRecord>[]>(
    () => [
      {
        key: 'assignedDate',
        header: 'تاریخ تخصیص',
        sortable: true,
        sortValue: a => a.assignedDate,
        isLtrCode: true,
        render: a => a.assignedDate,
      },
      {
        key: 'machine',
        header: 'ماشین',
        sortable: true,
        sortValue: a => a.machineCode,
        render: a => (
          <span className="font-semibold text-[var(--fiori-text-primary)]">
            <span className="fiori-ltr-code font-mono">{a.machineCode}</span> — {a.machineName}
          </span>
        ),
      },
      {
        key: 'shift',
        header: 'شیفت',
        render: a => a.shiftName,
      },
      {
        key: 'moOp',
        header: 'دستور کار / مرحله',
        isLtrCode: true,
        render: a => `${a.moNumber} / ${a.stepCode}`,
      },
      {
        key: 'minutes',
        header: 'ظرفیت شیفت (دقیقه)',
        align: 'center',
        sortable: true,
        sortValue: a => a.productiveMinutes,
        isMono: true,
        render: a => toPersianDigits(a.productiveMinutes),
      },
      {
        key: 'status',
        header: 'وضعیت',
        align: 'center',
        render: a => <FioriObjectStatus tone="neutral" label={a.status} ltrCode />,
      },
    ],
    [],
  );

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
    <FioriDynamicPage
      title="تحلیل OEE، عملکرد ماشین‌آلات و بهره‌وری تولید (KPIMS P4 Analytics)"
      subtitle="محاسبه یکپارچه دسترس‌پذیری (Availability)، عملکرد (Performance)، کیفیت (Quality) و OEE مستقیماً از سوابق واقعی کارگاه، تخصیص ماشین‌آلات و توقفات ثبت‌شده (بدون مقادیر ساختگی)"
      status={
        <div className="flex flex-wrap items-center gap-1.5">
          {summary && <FioriObjectStatus tone={dqMeta.tone} label={`کیفیت داده: ${dqMeta.labelFa}`} icon />}
          {data && (
            <FioriObjectStatus
              tone="neutral"
              label={`${toPersianDigits(data.summary.totalReportsCount)} گزارش تولید • ${toPersianDigits(
                data.summary.totalDowntimeEventsCount,
              )} رویداد توقف`}
            />
          )}
        </div>
      }
      activeFiltersCount={activeFiltersCount}
      onResetFilters={handleResetFilters}
      headerActions={
        <>
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
            <Info className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
            <span>فرمول‌ها و مبنای محاسبه</span>
          </button>

          <button
            type="button"
            onClick={loadAnalytics}
            disabled={loading}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-[var(--fiori-brand)]' : ''}`} />
            <span>بروزرسانی</span>
          </button>

          <button
            type="button"
            onClick={() => handleExportCsv()}
            disabled={exporting || !data}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <Download className="w-3.5 h-3.5 text-[var(--fiori-positive)]" />
            <span>{exporting ? 'در حال خروجی...' : 'خروجی CSV (همگام)'}</span>
          </button>

          <button
            type="button"
            onClick={() => window.print()}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <Printer className="w-3.5 h-3.5 text-[var(--fiori-text-secondary)]" />
            <span>چاپ</span>
          </button>
        </>
      }
      filterBar={
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex items-center gap-1.5">
              <label className="text-[var(--fiori-text-secondary)]">از تاریخ:</label>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                className="fiori-input fiori-ltr-code px-2 py-1 text-xs font-mono"
              />
            </div>

            <div className="flex items-center gap-1.5">
              <label className="text-[var(--fiori-text-secondary)]">تا تاریخ:</label>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                className="fiori-input fiori-ltr-code px-2 py-1 text-xs font-mono"
              />
            </div>

            <select
              value={machineFilter}
              onChange={e => setMachineFilter(e.target.value)}
              className="fiori-input px-2.5 py-1 text-xs"
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
              className="fiori-input px-2.5 py-1 text-xs"
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
              className="fiori-input px-2.5 py-1 text-xs"
            >
              <option value="ALL">همه سالن‌ها</option>
              {data?.masterData.halls.map(h => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </div>

          {data && (
            <div className="flex items-center gap-2.5 text-[11px] text-[var(--fiori-text-secondary)]">
              <FioriObjectStatus
                tone="positive"
                variant="text"
                label={`معتبر: ${toPersianDigits(data.dataQualityOverview.reliableCount)}`}
              />
              <span className="text-[var(--fiori-border-default)]">|</span>
              <FioriObjectStatus
                tone="critical"
                variant="text"
                label={`ناقص/هشدار: ${toPersianDigits(
                  data.dataQualityOverview.partialCount + data.dataQualityOverview.unreliableCount,
                )}`}
              />
              <span className="text-[var(--fiori-border-default)]">|</span>
              <FioriObjectStatus
                tone="neutral"
                variant="text"
                label={`داده ناکافی: ${toPersianDigits(data.dataQualityOverview.insufficientCount)}`}
              />
            </div>
          )}
        </div>
      }
    >
      {/* Formula Reference Box */}
      {showFormulas && data?.formulas && (
        <div className="fiori-surface-card p-4 bg-[var(--fiori-info-bg)]/50 border-[var(--fiori-info-border)] text-xs space-y-2.5">
          <div className="flex items-center justify-between border-b border-[var(--fiori-info-border)] pb-2">
            <span className="font-semibold text-[var(--fiori-info)] flex items-center gap-1.5">
              <Info className="w-4 h-4" />
              فرمول‌های استاندارد ISO 22400 / TPM مورد استفاده در داشبورد، گزارش‌ها و خروجی CSV
            </span>
            <button
              type="button"
              onClick={() => setShowFormulas(false)}
              className="p-1 rounded-[var(--fiori-radius-sm)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] hover:bg-[var(--fiori-bg-hover)] cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 font-mono text-[11px] text-[var(--fiori-text-primary)] fiori-ltr-code">
            <div className="bg-[var(--fiori-bg-surface)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)]">
              <strong className="text-[var(--fiori-brand)] block">Planned Production Time:</strong>
              {data.formulas.plannedProductionTime}
            </div>
            <div className="bg-[var(--fiori-bg-surface)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)]">
              <strong className="text-[var(--fiori-brand)] block">Availability (A):</strong>
              {data.formulas.availability}
            </div>
            <div className="bg-[var(--fiori-bg-surface)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)]">
              <strong className="text-[var(--fiori-brand)] block">Performance (P):</strong>
              {data.formulas.performance}
            </div>
            <div className="bg-[var(--fiori-bg-surface)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)]">
              <strong className="text-[var(--fiori-brand)] block">Quality (Q):</strong>
              {data.formulas.quality}
            </div>
            <div className="bg-[var(--fiori-bg-surface)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)]">
              <strong className="text-[var(--fiori-positive)] block">OEE:</strong>
              {data.formulas.oee}
            </div>
            <div className="bg-[var(--fiori-bg-surface)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)]">
              <strong className="text-[var(--fiori-text-primary)] block">TEEP & Downtime Deduplication:</strong>
              {data.formulas.teep} | {data.formulas.downtimeDeduplication}
            </div>
          </div>
        </div>
      )}

      {/* Error State */}
      {error && (
        <FioriMessageStrip
          tone="error"
          actions={
            <button
              type="button"
              onClick={loadAnalytics}
              className="sap-btn-standard px-2.5 py-1 text-xs cursor-pointer"
            >
              تلاش مجدد
            </button>
          }
        >
          <span className="font-semibold">{error}</span>
        </FioriMessageStrip>
      )}

      {/* Loading Skeleton */}
      {loading && !data && <ReportModuleSkeleton kpiCount={5} showChart={true} tableRows={6} tableColumns={9} />}

      {/* Explicit Data Quality & Missing Inputs Banner */}
      {data && summary && (summary.dataQualityStatus !== 'RELIABLE' || data.dataQualityOverview.issues.length > 0) && (
        <FioriMessageStrip
          tone={
            summary.dataQualityStatus === 'UNRELIABLE'
              ? 'error'
              : summary.dataQualityStatus === 'INSUFFICIENT_DATA'
              ? 'info'
              : 'warning'
          }
          title="شفافیت کیفیت داده‌ها و ورودی‌های ناموجود (عدم ساخت عدد جعلی OEE)"
          actions={<FioriObjectStatus tone={dqMeta.tone} label={dqMeta.labelFa} icon />}
        >
          <div className="space-y-2 mt-1">
            {summary.missingInputs.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[var(--fiori-text-secondary)] font-medium">
                  ورودی‌های مفقود در سطح کل کارخانه:
                </span>
                {summary.missingInputs.map(mi => (
                  <span
                    key={mi}
                    className="fiori-ltr-code px-2 py-0.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] font-mono text-[10px] text-[var(--fiori-text-primary)]"
                  >
                    {mi}
                  </span>
                ))}
              </div>
            )}
            {data.dataQualityOverview.issues.length > 0 && (
              <ul className="space-y-1 text-[11px] text-[var(--fiori-text-secondary)] list-disc pr-5">
                {data.dataQualityOverview.issues.map((issue, idx) => (
                  <li
                    key={`${issue.code}-${idx}`}
                    className={issue.severity === 'ERROR' ? 'text-[var(--fiori-negative)] font-medium' : ''}
                  >
                    {issue.messageFa}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </FioriMessageStrip>
      )}

      {/* Top Production-Level KPI Cards */}
      {data && summary && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {/* OEE */}
          <div className="fiori-surface-card p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[var(--fiori-text-primary)]">OEE کل تولید (وزنی)</span>
              <Gauge className="w-4 h-4 text-[var(--fiori-brand)]" />
            </div>
            <div className={`text-2xl font-semibold font-mono tabular-nums mt-1.5 ${getOeeValueColor(summary.oeePercent)}`}>
              {formatPercentOrNull(summary.oeePercent)}
            </div>
            <div className="text-[11px] text-[var(--fiori-text-secondary)] mt-1 flex items-center justify-between">
              <span>TEEP: {formatPercentOrNull(summary.teepPercent)}</span>
              <span>هدف جهانی: {toPersianDigits(summary.worldClassBenchmarkOee)}٪</span>
            </div>
            {!summary.oeeCalculable && (
              <div className="mt-1.5">
                <FioriObjectStatus tone="critical" label="محاسبه نشد — ورودی‌های A/P/Q ناقص است" />
              </div>
            )}
          </div>

          {/* Availability */}
          <div className="fiori-surface-card p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[var(--fiori-brand)]">دسترس‌پذیری (Availability)</span>
              <Clock className="w-4 h-4 text-[var(--fiori-brand)]" />
            </div>
            <div className={`text-2xl font-semibold font-mono tabular-nums mt-1.5 ${getOeeValueColor(summary.availabilityPercent)}`}>
              {formatPercentOrNull(summary.availabilityPercent)}
            </div>
            <div className="text-[11px] text-[var(--fiori-text-secondary)] mt-1 space-y-0.5">
              <div>کارکرد خالص: <strong>{formatMinutesFa(summary.time.operatingTimeMinutes)}</strong></div>
              <div>زمان برنامه‌ریزی‌شده: <strong>{formatMinutesFa(summary.time.effectivePlannedProductionTimeMinutes)}</strong></div>
            </div>
          </div>

          {/* Performance */}
          <div className="fiori-surface-card p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[var(--fiori-critical)]">عملکرد سرعت (Performance)</span>
              <Zap className="w-4 h-4 text-[var(--fiori-critical)]" />
            </div>
            <div className={`text-2xl font-semibold font-mono tabular-nums mt-1.5 ${getOeeValueColor(summary.performancePercent)}`}>
              {formatPercentOrNull(summary.performancePercent)}
            </div>
            <div className="text-[11px] text-[var(--fiori-text-secondary)] mt-1 space-y-0.5">
              <div>سیکل استاندارد: <strong>{formatSecondsFa(summary.idealCycleTimeSec)}</strong></div>
              <div>سیکل واقعی: <strong>{formatSecondsFa(summary.actualCycleTimeSec)}</strong></div>
              {summary.rawPerformancePercent !== null && summary.rawPerformancePercent > 100.5 && (
                <div className="text-[var(--fiori-negative)] font-semibold">
                  خام: {formatPercentOrNull(summary.rawPerformancePercent)} (بررسی سیکل!)
                </div>
              )}
            </div>
          </div>

          {/* Quality */}
          <div className="fiori-surface-card p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[var(--fiori-positive)]">کیفیت (Quality)</span>
              <ShieldCheck className="w-4 h-4 text-[var(--fiori-positive)]" />
            </div>
            <div className={`text-2xl font-semibold font-mono tabular-nums mt-1.5 ${getOeeValueColor(summary.qualityPercent)}`}>
              {formatPercentOrNull(summary.qualityPercent)}
            </div>
            <div className="text-[11px] text-[var(--fiori-text-secondary)] mt-1 space-y-0.5">
              <div>
                سالم: <strong className="text-[var(--fiori-positive)]">{formatNumber(summary.goodQty)}</strong> • ضایعات:{' '}
                <strong className="text-[var(--fiori-negative)]">{formatNumber(summary.scrapQty + summary.rejectedQty)}</strong>
              </div>
              <div>نرخ ضایعات: <strong>{formatPercentOrNull(summary.scrapRatePercent)}</strong></div>
            </div>
          </div>

          {/* Plan vs Actual */}
          <div className="fiori-surface-card p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[var(--fiori-text-primary)]">تولید واقعی در برابر برنامه</span>
              <Activity className="w-4 h-4 text-[var(--fiori-text-secondary)]" />
            </div>
            <div className="text-2xl font-semibold font-mono tabular-nums mt-1.5 text-[var(--fiori-text-primary)]">
              {formatPercentOrNull(summary.planAdherencePercent)}
            </div>
            <div className="text-[11px] text-[var(--fiori-text-secondary)] mt-1 space-y-0.5">
              <div>تولید سالم: <strong>{formatNumber(summary.goodQty)}</strong> / برنامه: <strong>{formatNumber(summary.plannedQty)}</strong></div>
              <div className={summary.planVarianceQty < 0 ? 'text-[var(--fiori-negative)]' : 'text-[var(--fiori-positive)]'}>
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
          <div className="fiori-surface-card p-4 lg:col-span-2 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--fiori-border-subtle)] pb-2">
              <h3 className="text-xs font-semibold text-[var(--fiori-text-primary)] flex items-center gap-1.5">
                <Clock className="w-4 h-4 text-[var(--fiori-brand)]" />
                تفکیک زمان تولیدی، ستاپ، توقفات برنامه‌ریزی‌شده و اضطراری (بر حسب دقیقه)
              </h3>
              <span className="text-[11px] text-[var(--fiori-text-secondary)]">
                زمان شیفت برنامه‌ریزی: <strong>{formatMinutesFa(summary.time.scheduledTimeMinutes)}</strong>
              </span>
            </div>

            <div className="w-full h-5 rounded-[var(--fiori-radius-sm)] overflow-hidden flex bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)]">
              {[
                { key: 'op', val: summary.time.operatingTimeMinutes, color: 'bg-[var(--fiori-positive)]', label: 'کارکرد تولیدی' },
                { key: 'setup', val: summary.time.setupTimeMinutes, color: 'bg-[var(--fiori-critical)]', label: 'ستاپ/تعویض قالب' },
                { key: 'planned', val: summary.time.plannedDowntimeMinutes, color: 'bg-[var(--fiori-brand)]', label: 'توقف برنامه‌ریزی‌شده' },
                { key: 'unplanned', val: summary.time.unplannedDowntimeMinutes, color: 'bg-[var(--fiori-negative)]', label: 'توقف اضطراری' },
                { key: 'idle', val: summary.time.idleUnassignedMinutes, color: 'bg-[var(--fiori-border-default)]', label: 'بیکاری/ظرفیت آزاد' },
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
              <div className="p-2 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-subtle)]">
                <FioriObjectStatus tone="positive" variant="dot" label="کارکرد تولیدی" className="mb-0.5" />
                <span className="font-mono font-semibold text-[var(--fiori-text-primary)] block tabular-nums">
                  {formatMinutesFa(summary.time.operatingTimeMinutes)}
                </span>
              </div>
              <div className="p-2 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-subtle)]">
                <FioriObjectStatus tone="critical" variant="dot" label="زمان ستاپ (Setup)" className="mb-0.5" />
                <span className="font-mono font-semibold text-[var(--fiori-text-primary)] block tabular-nums">
                  {formatMinutesFa(summary.time.setupTimeMinutes)}
                </span>
              </div>
              <div className="p-2 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-subtle)]">
                <FioriObjectStatus tone="brand" variant="dot" label="توقف برنامه‌ریزی (PM)" className="mb-0.5" />
                <span className="font-mono font-semibold text-[var(--fiori-text-primary)] block tabular-nums">
                  {formatMinutesFa(summary.time.plannedDowntimeMinutes)}
                </span>
              </div>
              <div className="p-2 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-subtle)]">
                <FioriObjectStatus tone="negative" variant="dot" label="توقف اضطراری" className="mb-0.5" />
                <span className="font-mono font-semibold text-[var(--fiori-text-primary)] block tabular-nums">
                  {formatMinutesFa(summary.time.unplannedDowntimeMinutes)}
                </span>
              </div>
              <div className="p-2 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-subtle)]">
                <FioriObjectStatus tone="neutral" variant="dot" label="ظرفیت آزاد / بیکار" className="mb-0.5" />
                <span className="font-mono font-semibold text-[var(--fiori-text-primary)] block tabular-nums">
                  {formatMinutesFa(summary.time.idleUnassignedMinutes)}
                </span>
              </div>
            </div>
          </div>

          {/* Top Downtime Reasons */}
          <div className="fiori-surface-card p-4 space-y-2.5">
            <div className="flex items-center justify-between border-b border-[var(--fiori-border-subtle)] pb-2">
              <h3 className="text-xs font-semibold text-[var(--fiori-text-primary)] flex items-center gap-1.5">
                <Wrench className="w-4 h-4 text-[var(--fiori-negative)]" />
                علل اصلی توقفات (تفکیک‌شده بدون شمارش مضاعف)
              </h3>
              <span className="text-[11px] font-mono font-semibold text-[var(--fiori-negative)] tabular-nums">
                {formatMinutesFa(data.downtimeSummary.totalDowntimeMinutes)}
              </span>
            </div>
            {data.downtimeSummary.byReason.length === 0 ? (
              <EmptyState
                variant="NO_DOWNTIME"
                compact
                title="توقفی در این بازه ثبت نشده است"
                description="هیچ رویداد توقفی در بازه فیلترشده ثبت نشده است."
              />
            ) : (
              <div className="space-y-2">
                {data.downtimeSummary.byReason.slice(0, 5).map((item, idx) => {
                  const catMeta = DOWNTIME_CATEGORY_META[item.category];
                  return (
                    <div key={`${item.reason}-${idx}`} className="text-[11px] space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <FioriObjectStatus tone={catMeta.tone} label={catMeta.labelFa} className="shrink-0" />
                          <span className="truncate text-[var(--fiori-text-primary)] font-medium" title={item.reason}>
                            {item.reason}
                          </span>
                        </div>
                        <span className="font-mono font-semibold text-[var(--fiori-text-primary)] shrink-0 tabular-nums">
                          {toPersianDigits(item.minutes)} د ({toPersianDigits(item.sharePercent)}٪)
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-[var(--fiori-bg-subtle)] rounded-[var(--fiori-radius-sm)] overflow-hidden border border-[var(--fiori-border-subtle)]">
                        <div
                          className={`h-full ${catMeta.barClass}`}
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
        <div className="fiori-surface-card overflow-hidden">
          <div className="px-3 pt-2 bg-[var(--fiori-bg-subtle)] border-b border-[var(--fiori-border-default)] flex flex-wrap items-center justify-between gap-2">
            <div className="sap-icon-tab-bar border-b-0 flex-wrap">
              {[
                { id: 'machines' as const, label: `به تفکیک ماشین (${toPersianDigits(data.machines.length)})`, icon: Gauge },
                { id: 'shifts' as const, label: `به تفکیک شیفت (${toPersianDigits(data.byShift.length)})`, icon: Clock },
                { id: 'operations' as const, label: `به تفکیک عملیات و دستور کار (${toPersianDigits(data.byOperation.length)})`, icon: Layers },
                { id: 'daily' as const, label: `روند روزانه (${toPersianDigits(data.byDate.length)})`, icon: Calendar },
                { id: 'sources' as const, label: 'سوابق منبع (Drill-down)', icon: Database },
              ].map(t => {
                const Icon = t.icon;
                const active = activeTab === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setActiveTab(t.id)}
                    className={`sap-icon-tab ${active ? 'sap-icon-tab-active' : ''}`}
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
              className="sap-btn-standard mb-1.5 px-2.5 py-1 text-[11px] text-[var(--fiori-positive)] flex items-center gap-1 cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              <span>دانلود CSV همین تب</span>
            </button>
          </div>

          {/* TAB 1: BY MACHINE */}
          {activeTab === 'machines' && (
            <FioriDataTable
              columns={machineColumns}
              data={data.machines}
              rowKey={m => m.machineId}
              onRowClick={m => setDrilldown({ kind: 'MACHINE', row: m })}
              bordered={false}
              emptyState={
                <div className="p-4">
                  <EmptyState
                    variant="FILTER_NO_MATCH"
                    compact
                    title="ماشینی مطابق فیلترهای انتخاب‌شده یافت نشد"
                    description="فیلترهای تاریخ، سالن یا شیفت را تغییر دهید یا بازنشانی کنید."
                    actionLabel={activeFiltersCount > 0 ? 'پاک کردن فیلترها' : undefined}
                    onAction={activeFiltersCount > 0 ? handleResetFilters : undefined}
                  />
                </div>
              }
            />
          )}

          {/* TAB 2: BY SHIFT */}
          {activeTab === 'shifts' && (
            <FioriDataTable
              columns={shiftColumns}
              data={data.byShift}
              rowKey={s => s.shiftId}
              bordered={false}
              emptyState={
                <div className="p-4">
                  <EmptyState
                    variant="NO_DATA"
                    compact
                    title="داده‌ای برای مقایسه شیفت‌ها ثبت نشده است"
                    description="پس از ثبت گزارش‌های تولید در شیفت‌های کاری، آمار هر شیفت در این جدول نمایش داده می‌شود."
                  />
                </div>
              }
            />
          )}

          {/* TAB 3: BY OPERATION */}
          {activeTab === 'operations' && (
            <FioriDataTable
              columns={operationColumns}
              data={data.byOperation}
              rowKey={op => op.operationId}
              onRowClick={op => setDrilldown({ kind: 'OPERATION', row: op })}
              bordered={false}
              emptyState={
                <div className="p-4">
                  <EmptyState
                    variant="FILTER_NO_MATCH"
                    compact
                    title="عملیاتی در محدوده فیلترشده یافت نشد"
                    description="هیچ عملیات یا دستور کاری با فیلترهای انتخاب‌شده تطابق ندارد."
                    actionLabel={activeFiltersCount > 0 ? 'پاک کردن فیلترها' : undefined}
                    onAction={activeFiltersCount > 0 ? handleResetFilters : undefined}
                  />
                </div>
              }
            />
          )}

          {/* TAB 4: BY DATE */}
          {activeTab === 'daily' && (
            <FioriDataTable
              columns={dailyColumns}
              data={data.byDate}
              rowKey={d => d.date}
              bordered={false}
              emptyState={
                <div className="p-4">
                  <EmptyState
                    variant="NO_DATA"
                    compact
                    title="هیچ رکورد روزانه‌ای ثبت نشده است"
                    description="هیچ رکورد روزانه‌ای در بازه انتخاب‌شده ثبت نشده است."
                  />
                </div>
              }
            />
          )}

          {/* TAB 5: SOURCE RECORDS */}
          {activeTab === 'sources' && (
            <div className="p-3 space-y-3">
              <FioriToolbar
                variant="section"
                startContent={
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {[
                      { id: 'reports' as const, label: `گزارش‌های تولید (${toPersianDigits(data.sourceRecords.productionReports.length)})` },
                      { id: 'downtimes' as const, label: `رویدادهای توقف یکتا (${toPersianDigits(data.sourceRecords.downtimeEvents.length)})` },
                      { id: 'assignments' as const, label: `تخصیص‌های ماشین (${toPersianDigits(data.sourceRecords.machineAssignments.length)})` },
                    ].map(st => (
                      <button
                        key={st.id}
                        type="button"
                        onClick={() => setSourceSubTab(st.id)}
                        className={`px-3 py-1.5 rounded-[var(--fiori-radius-sm)] text-xs font-semibold border cursor-pointer transition ${
                          sourceSubTab === st.id
                            ? 'bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border-[var(--fiori-brand)]'
                            : 'bg-[var(--fiori-bg-surface)] text-[var(--fiori-text-secondary)] border-[var(--fiori-border-default)] hover:text-[var(--fiori-text-primary)]'
                        }`}
                      >
                        {st.label}
                      </button>
                    ))}
                  </div>
                }
                endContent={
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleExportCsv('reports')}
                      className="sap-btn-standard px-2.5 py-1 text-[11px] cursor-pointer"
                    >
                      CSV گزارش‌های تولید
                    </button>
                    <button
                      type="button"
                      onClick={() => handleExportCsv('downtimes')}
                      className="sap-btn-standard px-2.5 py-1 text-[11px] cursor-pointer"
                    >
                      CSV توقفات
                    </button>
                  </div>
                }
              />

              {sourceSubTab === 'reports' && (
                <FioriDataTable
                  columns={sourceReportColumns}
                  data={data.sourceRecords.productionReports}
                  rowKey={r => r.id}
                  emptyState={
                    <div className="p-4">
                      <EmptyState
                        variant="NO_DATA"
                        compact
                        title="هیچ گزارش تولیدی ثبت نشده است"
                        description="گزارش‌های تولید ثبت‌شده در بخش اجرای کارگاه در اینجا قابل بررسی هستند."
                      />
                    </div>
                  }
                />
              )}

              {sourceSubTab === 'downtimes' && (
                <FioriDataTable
                  columns={sourceDowntimeColumns}
                  data={data.sourceRecords.downtimeEvents}
                  rowKey={d => d.id}
                  emptyState={
                    <div className="p-4">
                      <EmptyState
                        variant="NO_DOWNTIME"
                        compact
                        title="هیچ رویداد توقفی ثبت نشده است"
                        description="در بازه فیلترشده هیچ رویداد توقفی ثبت نشده است."
                      />
                    </div>
                  }
                />
              )}

              {sourceSubTab === 'assignments' && (
                <FioriDataTable
                  columns={sourceAssignmentColumns}
                  data={data.sourceRecords.machineAssignments}
                  rowKey={a => a.id}
                  emptyState={
                    <div className="p-4">
                      <EmptyState
                        variant="FILTER_NO_MATCH"
                        compact
                        title="هیچ تخصیص ماشینی یافت نشد"
                        description="هیچ تخصیص ماشینی در بازه انتخاب‌شده یافت نشد."
                      />
                    </div>
                  }
                />
              )}
            </div>
          )}
        </div>
      )}

      {/* Drill-Down Drawer for Machine or Operation */}
      {drilldown && (
        <div
          className="fixed inset-0 z-50 bg-[#1d2d3e]/45 backdrop-blur-[1px] flex justify-end no-print"
          onClick={() => setDrilldown(null)}
        >
          <div
            className="w-full max-w-2xl bg-[var(--fiori-bg-surface)] border-r border-[var(--fiori-border-default)] h-full shadow-[var(--fiori-shadow-dialog)] overflow-y-auto p-5 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-[var(--fiori-border-subtle)] pb-3">
              <div>
                <div className="flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-[var(--fiori-brand)]" />
                  <h3 className="text-sm font-semibold text-[var(--fiori-text-primary)]">
                    {drilldown.kind === 'MACHINE'
                      ? `ریز سوابق عملکرد ماشین ${drilldown.row.machineCode} — ${drilldown.row.machineName}`
                      : `ریز سوابق عملیات ${drilldown.row.moNumber} / ${drilldown.row.stepCode}`}
                  </h3>
                </div>
                <p className="text-xs text-[var(--fiori-text-secondary)] mt-0.5">
                  {drilldown.kind === 'MACHINE'
                    ? `${drilldown.row.hallLocation} • وضعیت: ${drilldown.row.status}`
                    : `${drilldown.row.partName} (${drilldown.row.partCode})`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDrilldown(null)}
                aria-label="بستن جزئیات"
                className="p-1.5 rounded-[var(--fiori-radius-sm)] hover:bg-[var(--fiori-bg-hover)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Drilldown KPIs */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
              <div className="p-2.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-subtle)]">
                <span className="text-[var(--fiori-text-secondary)] block">Availability</span>
                <strong className={`font-mono text-base tabular-nums ${getOeeValueColor(drilldown.row.availabilityPercent)}`}>
                  {formatPercentOrNull(drilldown.row.availabilityPercent)}
                </strong>
              </div>
              <div className="p-2.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-subtle)]">
                <span className="text-[var(--fiori-text-secondary)] block">Performance</span>
                <strong className={`font-mono text-base tabular-nums ${getOeeValueColor(drilldown.row.performancePercent)}`}>
                  {formatPercentOrNull(drilldown.row.performancePercent)}
                </strong>
              </div>
              <div className="p-2.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-subtle)]">
                <span className="text-[var(--fiori-text-secondary)] block">Quality</span>
                <strong className={`font-mono text-base tabular-nums ${getOeeValueColor(drilldown.row.qualityPercent)}`}>
                  {formatPercentOrNull(drilldown.row.qualityPercent)}
                </strong>
              </div>
              <div className="p-2.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-subtle)]">
                <span className="text-[var(--fiori-text-secondary)] block">OEE</span>
                <strong className={`font-mono text-base tabular-nums ${getOeeValueColor(drilldown.row.oeePercent)}`}>
                  {formatPercentOrNull(drilldown.row.oeePercent)}
                </strong>
              </div>
            </div>

            {/* Data Quality Warnings for this entity */}
            {drilldown.row.dataQualityIssues.length > 0 && (
              <FioriMessageStrip
                tone="warning"
                compact
                title="هشدارها و ورودی‌های ناقص این رکورد"
              >
                <ul className="list-disc pr-5 text-[11px] text-[var(--fiori-text-secondary)] space-y-0.5 mt-1">
                  {drilldown.row.dataQualityIssues.map((iss, i) => (
                    <li key={`${iss.code}-${i}`}>{iss.messageFa}</li>
                  ))}
                </ul>
              </FioriMessageStrip>
            )}

            {/* Source Production Reports */}
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-[var(--fiori-text-primary)]">
                گزارش‌های تولید منبع ({toPersianDigits(drilldownRecords.reports.length)})
              </h4>
              {drilldownRecords.reports.length === 0 ? (
                <EmptyState
                  variant="NO_DATA"
                  compact
                  title="گزارش تولیدی ثبت نشده است"
                  description="گزارش تولیدی برای این ردیف ثبت نشده است."
                />
              ) : (
                <div className="space-y-1.5">
                  {drilldownRecords.reports.map(r => (
                    <div
                      key={r.id}
                      className="p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-subtle)] bg-[var(--fiori-bg-subtle)] text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between font-mono">
                        <strong className="fiori-ltr-code text-[var(--fiori-brand)]">{r.reportNumber}</strong>
                        <span className="text-[var(--fiori-text-secondary)]">
                          <span className="fiori-ltr-code">{r.dateKey}</span> • {r.shiftName}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                        <span>
                          <span className="fiori-ltr-code font-mono">{r.moNumber} / {r.stepCode}</span> ({r.partName})
                        </span>
                        <span className="font-mono tabular-nums">
                          سالم: <strong className="text-[var(--fiori-positive)]">{formatNumber(r.goodQty)}</strong> | ضایعات:{' '}
                          <strong className="text-[var(--fiori-negative)]">{formatNumber(r.scrapQty + r.rejectedQty)}</strong> | کارکرد:{' '}
                          <strong>{toPersianDigits(r.runTimeMinutes)} د</strong>
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Source Downtime Events */}
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-[var(--fiori-text-primary)]">
                رویدادهای توقف منبع ({toPersianDigits(drilldownRecords.downtimes.length)})
              </h4>
              {drilldownRecords.downtimes.length === 0 ? (
                <EmptyState
                  variant="NO_DOWNTIME"
                  compact
                  title="رویداد توقفی ثبت نشده است"
                  description="رویداد توقفی برای این ردیف ثبت نشده است."
                />
              ) : (
                <div className="space-y-1.5">
                  {drilldownRecords.downtimes.map(d => {
                    const cat = DOWNTIME_CATEGORY_META[d.category];
                    return (
                      <div
                        key={d.id}
                        className="p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-subtle)] bg-[var(--fiori-bg-subtle)] text-xs flex items-center justify-between gap-2"
                      >
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <FioriObjectStatus tone={cat.tone} label={cat.labelFa} />
                            <span className="font-medium text-[var(--fiori-text-primary)]">{d.reason}</span>
                          </div>
                          <div className="text-[10px] text-[var(--fiori-text-muted)] font-mono">
                            <span className="fiori-ltr-code">{d.dateKey}</span> •{' '}
                            <span className="fiori-ltr-code">{d.source}</span> • {d.recordedBy}
                          </div>
                        </div>
                        <span className="font-mono font-semibold text-[var(--fiori-negative)] shrink-0 tabular-nums">
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
    </FioriDynamicPage>
  );
};
