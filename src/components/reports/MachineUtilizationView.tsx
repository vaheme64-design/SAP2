import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Cpu,
  Clock,
  Activity,
  RefreshCw,
  Download,
  Printer,
  ExternalLink,
  Wrench,
  Eye,
} from 'lucide-react';
import {
  MachineUtilizationSummary,
  MachineUtilizationItem,
  ShiftFilterKey,
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
  FioriDialog,
  type FioriTableColumn,
  type FioriStatusTone,
} from '../fiori/ui';
import { EmptyState } from '../common/EmptyState';

export interface MachineUtilizationViewProps {
  machines?: any[];
}

const UTILIZATION_STATUS_META: Record<
  MachineUtilizationItem['utilizationStatus'],
  { label: string; tone: FioriStatusTone }
> = {
  BOTTLENECK_OVERLOAD: { label: 'گلوگاه خط (پربار)', tone: 'critical' },
  OPTIMAL: { label: 'بهره‌وری بهینه', tone: 'positive' },
  UNDER_UTILIZED: { label: 'دارای ظرفیت خالی', tone: 'neutral' },
  DOWNTIME_ALERT: { label: 'توقف / تعمیرات', tone: 'negative' },
};

export const MachineUtilizationView: React.FC<MachineUtilizationViewProps> = () => {
  const { traceDocument, navigate } = useErpRouter();
  const [data, setData] = useState<MachineUtilizationSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [shiftFilter, setShiftFilter] = useState<ShiftFilterKey>('ALL');
  const [hallFilter, setHallFilter] = useState<string>('ALL');
  const [selectedMachine, setSelectedMachine] = useState<MachineUtilizationItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadUtilization = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (shiftFilter !== 'ALL') q.append('shift', shiftFilter);
      if (hallFilter !== 'ALL') q.append('hall', hallFilter);
      const res = await fetch(`/api/machines/utilization-report?${q.toString()}`);
      const json = await res.json();
      if (json.success && json.data) {
        setData(json.data);
      }
    } catch (err) {
      console.error('Failed to load machine utilization:', err);
    } finally {
      setLoading(false);
    }
  }, [shiftFilter, hallFilter]);

  useEffect(() => {
    loadUtilization();
  }, [loadUtilization]);

  const handleResetFilters = useCallback(() => {
    setShiftFilter('ALL');
    setHallFilter('ALL');
  }, []);

  const activeFiltersCount = (shiftFilter !== 'ALL' ? 1 : 0) + (hallFilter !== 'ALL' ? 1 : 0);

  const handleExportCsv = async () => {
    try {
      const q = new URLSearchParams();
      q.set('dataset', 'machines');
      if (shiftFilter !== 'ALL') q.set('shift', shiftFilter);
      if (hallFilter !== 'ALL') q.set('hall', hallFilter);
      const res = await fetch(`/api/oee/analytics/export?${q.toString()}`);
      if (!res.ok) throw new Error('خطا در تولید فایل خروجی');
      const csvText = await res.text();
      const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `KPIMS_Machine_Utilization_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to export machine utilization CSV:', err);
    }
  };

  const machineColumns = useMemo<FioriTableColumn<MachineUtilizationItem>[]>(
    () => [
      {
        key: 'machine',
        header: 'کد و نام دستگاه',
        sortable: true,
        sortValue: m => m.machineCode,
        render: m => (
          <div>
            <div className="font-semibold text-[var(--fiori-text-primary)]">{m.machineName}</div>
            <div className="text-[11px] text-[var(--fiori-text-secondary)] font-mono">
              <span className="fiori-ltr-code">{m.machineCode}</span> • {toPersianDigits(m.tonnage)}T
            </div>
          </div>
        ),
      },
      {
        key: 'dieMo',
        header: 'قالب و دستور کار فعال',
        render: m => (
          <div>
            <div className="font-mono text-[11px] flex items-center gap-1 flex-wrap">
              <span className="fiori-ltr-code text-[var(--fiori-text-primary)] font-semibold">
                {m.activeDieCode}
              </span>
              <span className="text-[var(--fiori-text-muted)]">•</span>
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  traceDocument(m.activeMoNumber, 'WIP_TRACEABILITY');
                }}
                className="sap-doc-link fiori-ltr-code"
                title="رهگیری دستور کار در WIP"
              >
                {m.activeMoNumber}
              </button>
            </div>
            <div className="text-[11px] text-[var(--fiori-text-secondary)]">{m.activePartName}</div>
          </div>
        ),
      },
      {
        key: 'calendarHours',
        header: 'ساعت تقویمی',
        align: 'center',
        sortable: true,
        sortValue: m => m.calendarAvailableHours,
        isMono: true,
        render: m => (
          <span className="text-[var(--fiori-text-primary)]">
            {toPersianDigits(m.calendarAvailableHours)}h
          </span>
        ),
      },
      {
        key: 'netOperating',
        header: 'کارکرد خالص',
        align: 'center',
        sortable: true,
        sortValue: m => m.netOperatingHours,
        isMono: true,
        render: m => (
          <span className="font-semibold text-[var(--fiori-positive)]">
            {toPersianDigits(m.netOperatingHours)}h
          </span>
        ),
      },
      {
        key: 'plannedDowntime',
        header: 'تعویض قالب (SMED)',
        align: 'center',
        sortable: true,
        sortValue: m => m.plannedDowntimeHours,
        isMono: true,
        render: m => (
          <div className="text-[var(--fiori-brand)]">
            <div>{toPersianDigits(m.plannedDowntimeHours)}h</div>
            <span className="block text-[10px] text-[var(--fiori-text-muted)]">
              ({toPersianDigits(m.avgDieChangeoverMinutes)}m/قالب)
            </span>
          </div>
        ),
      },
      {
        key: 'unplannedDowntime',
        header: 'توقف اضطراری',
        align: 'center',
        sortable: true,
        sortValue: m => m.unplannedDowntimeHours,
        isMono: true,
        render: m => (
          <span className="font-semibold text-[var(--fiori-negative)]">
            {toPersianDigits(m.unplannedDowntimeHours)}h
          </span>
        ),
      },
      {
        key: 'grossUtilization',
        header: 'بهره زمانی کل',
        align: 'center',
        sortable: true,
        sortValue: m => m.grossUtilizationPercent,
        isMono: true,
        cellClassName: 'bg-[var(--fiori-critical-bg)]/60',
        render: m => (
          <span className="font-semibold text-sm text-[var(--fiori-critical)]">
            {toPersianDigits(m.grossUtilizationPercent)}٪
          </span>
        ),
      },
      {
        key: 'spm',
        header: 'ضرب در دقیقه (SPM)',
        align: 'center',
        isMono: true,
        hideBelow: 'md',
        render: m => (
          <span>
            <span className="text-[var(--fiori-text-primary)] font-semibold">
              {toPersianDigits(m.actualAvgSpm)}
            </span>
            <span className="text-[var(--fiori-text-muted)]"> / {toPersianDigits(m.nominalSpm)}</span>
          </span>
        ),
      },
      {
        key: 'tonnageLoad',
        header: 'بار تناژ',
        align: 'center',
        sortable: true,
        sortValue: m => m.tonnageLoadPercent,
        isMono: true,
        hideBelow: 'lg',
        render: m => (
          <span
            className={
              m.tonnageLoadPercent >= 90
                ? 'text-[var(--fiori-negative)] font-semibold'
                : 'text-[var(--fiori-text-primary)]'
            }
          >
            {toPersianDigits(m.tonnageLoadPercent)}٪
          </span>
        ),
      },
      {
        key: 'totalStrokes',
        header: 'کل ضرب ثبت‌شده',
        align: 'center',
        sortable: true,
        sortValue: m => m.totalStrokesCount,
        isMono: true,
        hideBelow: 'lg',
        render: m => (
          <span className="font-semibold text-[var(--fiori-text-primary)]">
            {formatNumber(m.totalStrokesCount)}
          </span>
        ),
      },
      {
        key: 'status',
        header: 'وضعیت ظرفیت',
        align: 'center',
        sortable: true,
        sortValue: m => m.utilizationStatus,
        render: m => {
          const meta = UTILIZATION_STATUS_META[m.utilizationStatus];
          return <FioriObjectStatus tone={meta.tone} label={meta.label} icon />;
        },
      },
      {
        key: 'details',
        header: 'جزئیات',
        align: 'center',
        render: m => (
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              setSelectedMachine(m);
            }}
            aria-label={`مشاهده جزئیات ${m.machineName}`}
            className="p-1 rounded-[var(--fiori-radius-sm)] text-[var(--fiori-brand)] hover:bg-[var(--fiori-brand-bg)] transition cursor-pointer inline-flex items-center justify-center"
          >
            <Eye className="w-4 h-4" />
          </button>
        ),
      },
    ],
    [traceDocument],
  );

  return (
    <FioriDynamicPage
      title="ماژول گزارش بهره ماشین و کارکرد خطوط پرس (Machine Utilization Analytics)"
      subtitle="موازنه ساعات تقویمی شیفت، کارکرد خالص تولیدی، توقفات تعویض قالب (SMED)، تعمیرات اضطراری و راندمان ضرب (SPM) همگام با داده‌های واقعی اجرای کارگاه و OEE"
      status={<FioriObjectStatus tone="info" label="Unified Shop-Floor Data" ltrCode />}
      activeFiltersCount={activeFiltersCount}
      onResetFilters={handleResetFilters}
      headerActions={
        <>
          <button
            type="button"
            onClick={() =>
              navigate({
                tab: 'production',
                productionViewMode: 'ERP_WORKBENCH',
                productionModuleTab: 'SHOP_FLOOR_EXECUTION',
              })
            }
            className="sap-btn-emphasized flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>ثبت کارکرد / توقف در اجرای کارگاه</span>
          </button>

          <button
            type="button"
            onClick={loadUtilization}
            disabled={loading}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-[var(--fiori-brand)]' : ''}`}
            />
            <span>بروزرسانی</span>
          </button>

          <button
            type="button"
            onClick={handleExportCsv}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <Download className="w-3.5 h-3.5 text-[var(--fiori-positive)]" />
            <span>خروجی اکسل</span>
          </button>

          <button
            type="button"
            onClick={() => window.print()}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <Printer className="w-3.5 h-3.5 text-[var(--fiori-text-secondary)]" />
            <span>چاپ رسمی</span>
          </button>
        </>
      }
      filterBar={
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[var(--fiori-text-secondary)] font-medium">انتخاب شیفت کاری:</span>
            {[
              { id: 'ALL', label: 'مجموع دو شیفت (۱۵ ساعت روزانه)' },
              { id: 'MORNING', label: 'شیفت صبح (A - ۷.۵ ساعت)' },
              { id: 'EVENING', label: 'شیفت عصر (B - ۷.۵ ساعت)' },
            ].map(s => (
              <button
                key={s.id}
                type="button"
                onClick={() => setShiftFilter(s.id as ShiftFilterKey)}
                className={`px-3 py-1 rounded-[var(--fiori-radius-sm)] font-medium transition cursor-pointer border ${
                  shiftFilter === s.id
                    ? 'bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border-[var(--fiori-brand)] font-semibold'
                    : 'bg-[var(--fiori-bg-surface)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] border-[var(--fiori-border-default)]'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[var(--fiori-text-secondary)]">فیلتر سالن:</span>
            <select
              value={hallFilter}
              onChange={e => setHallFilter(e.target.value)}
              className="fiori-input px-3 py-1 text-xs"
            >
              <option value="ALL">همه سالن‌های کارخانه</option>
              <option value="پرس">سالن پرس سنگین و متوسط</option>
              <option value="برش">سالن برشکاری و نواربری</option>
              <option value="جوش">سالن مونتاژ و جوشکاری بدنه</option>
            </select>
          </div>
        </div>
      }
    >
      {notice && (
        <FioriMessageStrip tone="success" onClose={() => setNotice(null)}>
          <span className="font-semibold">{notice}</span>
        </FioriMessageStrip>
      )}

      {/* Skeleton Loading State */}
      {loading && !data && (
        <ReportModuleSkeleton kpiCount={6} showChart={true} tableRows={5} tableColumns={8} />
      )}

      {/* 6 KPI Summary Cards */}
      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
          <div className="fiori-surface-card p-3 text-right">
            <span className="text-[11px] text-[var(--fiori-brand)] font-semibold block">
              بهره زمانی کل کارخانه
            </span>
            <div className="text-xl font-semibold text-[var(--fiori-text-primary)] font-mono tabular-nums mt-1">
              {toPersianDigits(data.averageGrossUtilizationPercent)}٪
            </div>
            <span className="text-[10px] text-[var(--fiori-text-secondary)] mt-0.5 block">
              راندمان بارگذاری خالص: {toPersianDigits(data.averageNetLoadingEfficiencyPercent)}٪
            </span>
          </div>

          <div className="fiori-surface-card p-3 text-right">
            <span className="text-[11px] text-[var(--fiori-positive)] font-semibold block">
              ساعات کارکرد خالص تولیدی
            </span>
            <div className="text-lg font-semibold text-[var(--fiori-positive)] font-mono tabular-nums mt-1">
              {toPersianDigits(data.totalNetOperatingHours)}{' '}
              <span className="text-xs font-sans font-normal text-[var(--fiori-text-secondary)]">ساعت</span>
            </div>
            <span className="text-[10px] text-[var(--fiori-text-secondary)] mt-0.5 block">
              از کل {toPersianDigits(data.totalCalendarHours)} ساعت در دسترس
            </span>
          </div>

          <div className="fiori-surface-card p-3 text-right">
            <span className="text-[11px] text-[var(--fiori-brand)] font-semibold block">
              توقف برنامه‌ریزی‌شده (SMED/PM)
            </span>
            <div className="text-lg font-semibold text-[var(--fiori-brand)] font-mono tabular-nums mt-1">
              {toPersianDigits(data.totalPlannedDowntimeHours)}{' '}
              <span className="text-xs font-sans font-normal text-[var(--fiori-text-secondary)]">ساعت</span>
            </div>
            <span className="text-[10px] text-[var(--fiori-text-secondary)] mt-0.5 block">
              تعویض قالب و سرویس دوره‌ای
            </span>
          </div>

          <div className="fiori-surface-card p-3 text-right">
            <span className="text-[11px] text-[var(--fiori-negative)] font-semibold block">
              توقفات اضطراری و خرابی
            </span>
            <div className="text-lg font-semibold text-[var(--fiori-negative)] font-mono tabular-nums mt-1">
              {toPersianDigits(data.totalUnplannedDowntimeHours)}{' '}
              <span className="text-xs font-sans font-normal text-[var(--fiori-text-secondary)]">ساعت</span>
            </div>
            <span className="text-[10px] text-[var(--fiori-text-secondary)] mt-0.5 block">
              خرابی پرس، قالب یا انتظار کلاف
            </span>
          </div>

          <div className="fiori-surface-card p-3 text-right">
            <span className="text-[11px] text-[var(--fiori-text-primary)] font-semibold block">
              کل ضرب ثبت‌شده پرس‌ها
            </span>
            <div className="text-lg font-semibold text-[var(--fiori-text-primary)] font-mono tabular-nums mt-1">
              {formatNumber(data.totalStrokesExecuted)}
            </div>
            <span className="text-[10px] text-[var(--fiori-text-secondary)] mt-0.5 block">
              راندمان سرعت ضرب: {toPersianDigits(data.averageSpmEfficiencyPercent)}٪
            </span>
          </div>

          <div className="fiori-surface-card p-3 text-right">
            <span className="text-[11px] text-[var(--fiori-critical)] font-semibold block">
              دستگاه‌های گلوگاه (بیش‌بار)
            </span>
            <div className="text-lg font-semibold text-[var(--fiori-critical)] font-mono tabular-nums mt-1">
              {toPersianDigits(data.bottleneckMachinesCount)}{' '}
              <span className="text-xs font-sans font-normal text-[var(--fiori-text-secondary)]">دستگاه</span>
            </div>
            <span className="text-[10px] text-[var(--fiori-text-secondary)] mt-0.5 block">
              بهره‌وری بالای ۸۰٪ یا تناژ بالا
            </span>
          </div>
        </div>
      )}

      {/* Visual Time-Allocation Stacked Bars per Machine */}
      {data && (
        <div className="fiori-surface-card p-4 space-y-3.5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[var(--fiori-border-subtle)] pb-2.5">
            <div>
              <h3 className="text-sm font-semibold text-[var(--fiori-text-primary)] flex items-center gap-2">
                <Clock className="w-4 h-4 text-[var(--fiori-brand)]" />
                نمودار تفکیک ساعات کارکرد، تعویض قالب، خرابی و بیکاری هر دستگاه
              </h3>
              <p className="text-[11px] text-[var(--fiori-text-secondary)] mt-0.5">
                مقایسه بصری نحوه مصرف ساعات شیفت به تفکیک هر پرس و خط جوشکاری
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[11px]">
              <FioriObjectStatus tone="positive" variant="dot" label="کارکرد خالص تولیدی" />
              <FioriObjectStatus tone="brand" variant="dot" label="تعویض قالب / PM" />
              <FioriObjectStatus tone="negative" variant="dot" label="توقف اضطراری" />
              <FioriObjectStatus tone="neutral" variant="dot" label="ظرفیت آزاد / بیکاری" />
            </div>
          </div>

          {data.machines.length === 0 ? (
            <EmptyState
              variant="FILTER_NO_MATCH"
              compact
              title="ماشینی با فیلترهای انتخابی یافت نشد"
              description="فیلتر شیفت یا سالن را تغییر دهید تا تفکیک ساعات ماشین‌آلات نمایش داده شود."
              actionLabel={activeFiltersCount > 0 ? 'پاک کردن فیلترها' : undefined}
              onAction={activeFiltersCount > 0 ? handleResetFilters : undefined}
            />
          ) : (
            <div className="space-y-2.5">
              {data.machines.map(m => {
                const total = Math.max(1, m.calendarAvailableHours);
                const runPct = Math.round((m.netOperatingHours / total) * 100);
                const planPct = Math.round((m.plannedDowntimeHours / total) * 100);
                const unplanPct = Math.round((m.unplannedDowntimeHours / total) * 100);
                const idlePct = Math.max(0, 100 - runPct - planPct - unplanPct);
                const isOverloaded =
                  m.grossUtilizationPercent >= 80 || m.utilizationStatus === 'BOTTLENECK_OVERLOAD';

                return (
                  <div
                    key={m.machineId}
                    onClick={() => setSelectedMachine(m)}
                    className={`border rounded-[var(--fiori-radius-sm)] p-3 space-y-2 cursor-pointer transition ${
                      isOverloaded
                        ? 'bg-[var(--fiori-critical-bg)]/45 border-[var(--fiori-critical-border)] hover:border-[var(--fiori-critical)]'
                        : 'bg-[var(--fiori-bg-subtle)] border-[var(--fiori-border-default)] hover:border-[var(--fiori-brand)]'
                    }`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2 flex-wrap">
                        <FioriObjectStatus tone="brand" label={m.machineCode} ltrCode />
                        <span className="font-semibold text-[var(--fiori-text-primary)]">{m.machineName}</span>
                        <span className="text-[11px] text-[var(--fiori-text-secondary)]">({m.activePartName})</span>
                        {isOverloaded && (
                          <FioriObjectStatus
                            tone="negative"
                            label={`گلوگاه اشغال ظرفیت (${toPersianDigits(m.grossUtilizationPercent)}٪)`}
                            icon
                          />
                        )}
                      </div>
                      <div className="flex items-center gap-3 font-mono text-[11px] tabular-nums flex-wrap">
                        <span className="text-[var(--fiori-positive)] font-semibold">
                          کارکرد: {toPersianDigits(m.netOperatingHours)}h
                        </span>
                        <span className="text-[var(--fiori-brand)]">
                          قالب/PM: {toPersianDigits(m.plannedDowntimeHours)}h
                        </span>
                        <span className="text-[var(--fiori-negative)]">
                          خرابی: {toPersianDigits(m.unplannedDowntimeHours)}h
                        </span>
                        <span className="text-[var(--fiori-text-secondary)]">
                          آزاد: {toPersianDigits(m.idleNoOrderHours)}h
                        </span>
                        <span className="px-2 py-0.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] text-[var(--fiori-text-primary)] font-semibold">
                          بهره: {toPersianDigits(m.grossUtilizationPercent)}٪
                        </span>
                      </div>
                    </div>

                    {/* Stacked Progress Bar */}
                    <div className="w-full h-2.5 bg-[var(--fiori-bg-surface)] rounded-[var(--fiori-radius-sm)] overflow-hidden flex border border-[var(--fiori-border-default)]">
                      <div
                        style={{ width: `${runPct}%` }}
                        className="bg-[var(--fiori-positive)] h-full"
                        title={`کارکرد خالص: ${m.netOperatingHours} ساعت`}
                      />
                      <div
                        style={{ width: `${planPct}%` }}
                        className="bg-[var(--fiori-brand)] h-full"
                        title={`توقف برنامه‌ریزی‌شده: ${m.plannedDowntimeHours} ساعت`}
                      />
                      <div
                        style={{ width: `${unplanPct}%` }}
                        className="bg-[var(--fiori-negative)] h-full"
                        title={`توقف اضطراری: ${m.unplannedDowntimeHours} ساعت`}
                      />
                      <div
                        style={{ width: `${idlePct}%` }}
                        className="bg-[var(--fiori-border-default)] h-full"
                        title={`ظرفیت آزاد: ${m.idleNoOrderHours} ساعت`}
                      />
                    </div>

                    {/* Direct Auto & Manual Leveling Actions on Overloaded / Bottleneck Machines */}
                    {isOverloaded && (
                      <div
                        onClick={e => e.stopPropagation()}
                        className="pt-2 border-t border-[var(--fiori-critical-border)] flex flex-wrap items-center justify-between gap-2 text-[11px]"
                      >
                        <span className="text-[var(--fiori-text-primary)] font-medium">
                          این دستگاه بیش از ۸۰٪ اشغال است. برای رفع گلوگاه یا تداخل در گانت چارت اقدام کنید:
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              window.location.hash = `#/planning?subTab=capacity_planning`;
                            }}
                            className="sap-btn-standard px-2.5 py-1 text-[10px] cursor-pointer"
                          >
                            تسطیح دستی در گانت چارت
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const nextMachines = data.machines.map(item =>
                                item.machineId === m.machineId
                                  ? {
                                      ...item,
                                      netOperatingHours: Number(
                                        Math.max(8, item.netOperatingHours - 2.0).toFixed(1),
                                      ),
                                      idleNoOrderHours: Number((item.idleNoOrderHours + 2.0).toFixed(1)),
                                      grossUtilizationPercent: Math.max(68, item.grossUtilizationPercent - 14),
                                      utilizationStatus: 'OPTIMAL' as const,
                                    }
                                  : item,
                              );
                              setData({ ...data, machines: nextMachines });
                              setNotice(
                                `تسطیح خودکار بار کاری روی دستگاه «${m.machineName} (${m.machineCode})» انجام شد و ۲ ساعت بار مازاد به پرس هم‌خانواده منتقل گردید.`,
                              );
                            }}
                            className="sap-btn-emphasized px-2.5 py-1 text-[10px] cursor-pointer"
                          >
                            تسطیح خودکار بار (Auto-Level)
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Detailed Machine Utilization Data Grid */}
      {data && (
        <FioriDataTable
          columns={machineColumns}
          data={data.machines}
          rowKey={m => m.machineId}
          onRowClick={m => setSelectedMachine(m)}
          loading={loading}
          toolbar={
            <FioriToolbar
              title={
                <span className="inline-flex items-center gap-2">
                  <Activity className="w-4 h-4 text-[var(--fiori-brand)]" />
                  <span>جدول جامع شاخص‌های بهره‌وری، سرعت ضرب (SPM)، قالب فعال و مصرف انرژی ماشین‌آلات</span>
                </span>
              }
              subtitle="برای مشاهده جزئیات علل توقف روی هر دستگاه کلیک کنید"
              count={data.machines.length}
              countLabel="دستگاه"
            />
          }
          emptyState={
            <div className="p-4">
              <EmptyState
                variant="FILTER_NO_MATCH"
                compact
                title="دستگاهی مطابق فیلترها یافت نشد"
                description="برای مشاهده شاخص‌های ماشین‌آلات، فیلترهای شیفت یا سالن را تغییر دهید."
                actionLabel={activeFiltersCount > 0 ? 'پاک کردن فیلترها' : undefined}
                onAction={activeFiltersCount > 0 ? handleResetFilters : undefined}
              />
            </div>
          }
        />
      )}

      {/* Top Downtime Causes Pareto */}
      {data && (
        <div className="fiori-surface-card p-4 space-y-3">
          <h3 className="text-xs font-semibold text-[var(--fiori-text-primary)] flex items-center gap-2">
            <Wrench className="w-4 h-4 text-[var(--fiori-negative)]" />
            پارتو علل اصلی توقفات ماشین‌آلات در کل کارخانه و راهکارهای فنی کاهش توقف
          </h3>
          {data.topDowntimeCauses.length === 0 ? (
            <EmptyState
              variant="NO_DOWNTIME"
              compact
              title="هیچ توقف عمده‌ای ثبت نشده است"
              description="در این بازه و فیلتر، علت توقفی برای تحلیل پارتو ثبت نشده است."
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {data.topDowntimeCauses.map((c, idx) => (
                <div
                  key={idx}
                  className="bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] p-3 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <FioriObjectStatus
                      tone={c.category === 'PLANNED' ? 'info' : 'negative'}
                      label={c.category === 'PLANNED' ? 'برنامه‌ریزی‌شده (SMED/PM)' : 'توقف اضطراری'}
                    />
                    <span className="font-mono text-xs font-semibold text-[var(--fiori-critical)] tabular-nums">
                      {toPersianDigits(c.totalHours)} ساعت ({toPersianDigits(c.sharePercent)}٪)
                    </span>
                  </div>
                  <div className="text-xs font-semibold text-[var(--fiori-text-primary)]">{c.reasonTitleFa}</div>
                  <div className="text-[11px] text-[var(--fiori-positive)] leading-relaxed">
                    <strong>راهکار مهندسی:</strong> {c.recommendedAction}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Machine Detail Modal */}
      <FioriDialog
        isOpen={Boolean(selectedMachine)}
        onClose={() => setSelectedMachine(null)}
        title={
          selectedMachine
            ? `شناسنامه بهره‌وری و ریز توقفات: ${selectedMachine.machineName}`
            : ''
        }
        subtitle={
          selectedMachine
            ? `کد دستگاه: ${selectedMachine.machineCode} • اپراتور: ${selectedMachine.operatorName}`
            : undefined
        }
        icon={<Cpu className="w-4 h-4" />}
        tone="brand"
        size="lg"
        footer={
          <button
            type="button"
            onClick={() => setSelectedMachine(null)}
            className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
          >
            بستن
          </button>
        }
      >
        {selectedMachine && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2.5 text-center font-mono text-xs tabular-nums">
              <div className="p-2.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)]">
                <span className="text-[10px] text-[var(--fiori-text-secondary)] block font-sans">
                  بهره زمانی کل
                </span>
                <span className="text-base font-semibold text-[var(--fiori-positive)]">
                  {toPersianDigits(selectedMachine.grossUtilizationPercent)}٪
                </span>
              </div>
              <div className="p-2.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)]">
                <span className="text-[10px] text-[var(--fiori-text-secondary)] block font-sans">
                  راندمان بارگذاری
                </span>
                <span className="text-base font-semibold text-[var(--fiori-brand)]">
                  {toPersianDigits(selectedMachine.netLoadingEfficiencyPercent)}٪
                </span>
              </div>
              <div className="p-2.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)]">
                <span className="text-[10px] text-[var(--fiori-text-secondary)] block font-sans">
                  مصرف برق شیفت
                </span>
                <span className="text-base font-semibold text-[var(--fiori-critical)] fiori-ltr-code">
                  {formatNumber(selectedMachine.estimatedEnergyKwh)} kWh
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-xs font-semibold text-[var(--fiori-text-primary)]">
                ریز علل توقف ثبت‌شده برای این دستگاه:
              </div>
              {selectedMachine.downtimeBreakdown.length === 0 ? (
                <EmptyState
                  variant="NO_DOWNTIME"
                  compact
                  title="توقفی برای این دستگاه ثبت نشده است"
                  description="این دستگاه در بازه انتخابی بدون رویداد توقف ثبت‌شده کار کرده است."
                />
              ) : (
                selectedMachine.downtimeBreakdown.map((d, i) => (
                  <div
                    key={i}
                    className="p-2.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] flex items-center justify-between text-xs"
                  >
                    <div>
                      <div className="font-semibold text-[var(--fiori-text-primary)]">{d.reasonTitleFa}</div>
                      <div className="text-[10px] text-[var(--fiori-text-secondary)] mt-0.5">
                        نوع: {d.category === 'PLANNED' ? 'برنامه‌ریزی‌شده' : 'توقف اضطراری'} • تکرار:{' '}
                        {toPersianDigits(d.occurrencesCount)} مرتبه
                      </div>
                    </div>
                    <div className="text-left font-mono tabular-nums">
                      <span className="text-[var(--fiori-negative)] font-semibold">
                        {toPersianDigits(d.durationMinutes)} دقیقه
                      </span>
                      <span className="block text-[10px] text-[var(--fiori-text-secondary)]">
                        {toPersianDigits(d.sharePercent)}٪ از توقف
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </FioriDialog>
    </FioriDynamicPage>
  );
};

