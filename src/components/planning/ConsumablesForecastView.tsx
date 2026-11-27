import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Flame,
  RefreshCw,
  Download,
  Printer,
  ShoppingCart,
  Search,
  Calendar,
  SlidersHorizontal,
  Edit3,
  FileText,
  ShieldAlert,
} from 'lucide-react';
import {
  ConsumablesForecastSummary,
  ConsumableForecastItem,
  PurchaseRequisitionRecord,
} from '../../types/oeeAndConsumables';
import { exportToCsv } from '../../utils/csvExport';
import { formatNumber, toPersianDigits } from '../../utils/formatters';
import { ReportModuleSkeleton } from '../common/Skeleton';
import { useErpRouter } from '../../context/RouterContext';
import {
  FioriDataTable,
  FioriDialog,
  FioriDynamicPage,
  FioriMessageStrip,
  FioriObjectStatus,
  FioriTableColumn,
  FioriToolbar,
} from '../fiori/ui';
import { EmptyState } from '../common/EmptyState';

export const ConsumablesForecastView: React.FC = () => {
  const { traceDocument } = useErpRouter();
  const [data, setData] = useState<ConsumablesForecastSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [horizonDays, setHorizonDays] = useState<number>(30);
  const [growthPercent, setGrowthPercent] = useState<number>(0);
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [activeSubView, setActiveSubView] = useState<'forecast_table' | 'requisitions'>('forecast_table');
  const [notice, setNotice] = useState<string | null>(null);
  const [creatingPr, setCreatingPr] = useState(false);

  // Edit Stock / Rate Modal
  const [editingItem, setEditingItem] = useState<ConsumableForecastItem | null>(null);
  const [editStockVal, setEditStockVal] = useState<number>(0);
  const [editRateVal, setEditRateVal] = useState<number>(0);
  const [editSafetyVal, setEditSafetyVal] = useState<number>(0);
  const [savingEdit, setSavingEdit] = useState(false);

  const loadForecast = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams();
      q.append('horizonDays', String(horizonDays));
      q.append('growth', String(growthPercent));
      if (categoryFilter !== 'ALL') q.append('category', categoryFilter);

      const res = await fetch(`/api/consumables/forecast?${q.toString()}`);
      const json = await res.json();
      if (json.success && json.data) {
        setData(json.data);
      }
    } catch (err) {
      console.error('Failed to load consumables forecast:', err);
    } finally {
      setLoading(false);
    }
  }, [horizonDays, growthPercent, categoryFilter]);

  useEffect(() => {
    loadForecast();
  }, [loadForecast]);

  const handleIssueRequisition = useCallback(
    async (specificCodes?: string[]) => {
      setCreatingPr(true);
      try {
        const res = await fetch('/api/consumables/requisition', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            itemCodes: specificCodes,
            urgency: 'IMMEDIATE',
            notes: specificCodes
              ? `درخواست خرید اختصاصی برای قلم ${specificCodes.join(', ')} بر اساس هشدار نقطه سفارش`
              : `درخواست خرید تجمیعی برای کلیه اقلام زیر نقطه سفارش (افق ${horizonDays} روزه)`,
          }),
        });
        const json = await res.json();
        if (json.success) {
          setNotice(json.message);
          await loadForecast();
          setActiveSubView('requisitions');
        }
      } catch (err) {
        console.error(err);
      } finally {
        setCreatingPr(false);
      }
    },
    [horizonDays, loadForecast]
  );

  const handleOpenEdit = useCallback((item: ConsumableForecastItem) => {
    setEditingItem(item);
    setEditStockVal(item.currentStock);
    setEditRateVal(item.standardRatePerDriverUnit);
    setEditSafetyVal(item.minSafetyStock);
  }, []);

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingItem) return;
    setSavingEdit(true);
    try {
      const res = await fetch('/api/consumables/update-stock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: editingItem.code,
          newStock: editStockVal,
          newStandardRate: editRateVal,
          newMinSafetyStock: editSafetyVal,
        }),
      });
      const json = await res.json();
      if (json.success) {
        setNotice(json.message);
        setEditingItem(null);
        await loadForecast();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSavingEdit(false);
    }
  };

  const handleExportCsv = () => {
    if (!data) return;
    const headers = [
      'کد کالای مصرفی',
      'شرح کالا',
      'گروه مصرفی',
      'واحد',
      'مبنای مصرف مهندسی',
      'نرخ مصرف روزانه',
      `نیاز پیش‌بینی (${horizonDays} روز)`,
      'موجودی فعلی انبار',
      'حداقل موجودی اطمینان',
      'نقطه سفارش مجدد (ROP)',
      'پوشش موجودی (روز)',
      'تاریخ تخمینی اتمام',
      'پیشنهاد خرید',
      'برآورد هزینه (ریال)',
      'تأمین‌کننده منتخب',
    ];
    const rows = data.items.map(i => [
      i.code,
      `"${i.name.replace(/"/g, '""')}"`,
      i.categoryLabelFa,
      i.unit,
      i.consumptionDriverLabelFa,
      i.dailyBurnRate,
      i.forecastedGrossRequirement,
      i.currentStock,
      i.minSafetyStock,
      i.reorderPoint,
      i.daysOfSupplyRemaining,
      i.estimatedRunOutDateFa,
      i.suggestedOrderQty,
      i.estimatedTotalOrderCostRials,
      i.preferredSupplierName,
    ]);
    exportToCsv(`KPIMS_Consumables_Forecast_${horizonDays}Days`, headers, rows);
  };

  const filteredItems = useMemo(
    () =>
      (data?.items || []).filter(item => {
        if (!searchQuery.trim()) return true;
        const q = searchQuery.toLowerCase();
        return (
          item.code.toLowerCase().includes(q) ||
          item.name.toLowerCase().includes(q) ||
          item.categoryLabelFa.toLowerCase().includes(q) ||
          item.preferredSupplierName.toLowerCase().includes(q)
        );
      }),
    [data?.items, searchQuery]
  );

  const categories: { id: string; label: string }[] = [
    { id: 'ALL', label: 'همه مواد مصرفی (۱۰)' },
    { id: 'WELDING_CONSUMABLES', label: 'سیم جوش، الکترود و گاز' },
    { id: 'PRESS_LUBRICANTS', label: 'روغن کشش ورق و هیدرولیک' },
    { id: 'DIE_SPAREPARTS', label: 'قطعات مصرفی قالب (سنبه/فنر)' },
    { id: 'COATING_CHEMICALS', label: 'مواد شیمیایی و پوشش ED' },
    { id: 'PACKAGING_SAFETY', label: 'تسمه پالت و نایلون VCI' },
  ];

  const activeFiltersCount = (categoryFilter !== 'ALL' ? 1 : 0) + (searchQuery.trim() ? 1 : 0);

  const forecastColumns: FioriTableColumn<ConsumableForecastItem>[] = useMemo(
    () => [
      {
        key: 'name',
        header: 'کد و شرح کالای مصرفی',
        render: item => (
          <div>
            <div className="font-semibold text-[var(--fiori-text-primary)]">{item.name}</div>
            <div className="text-[11px] text-[var(--fiori-text-secondary)] font-mono flex items-center gap-1">
              <button
                type="button"
                onClick={() => traceDocument(item.code, 'INVENTORY_LEDGER')}
                className="sap-doc-link font-mono fiori-ltr-code cursor-pointer"
                title="رهگیری در کاردکس انبار"
              >
                {item.code}
              </button>
              <span>•</span>
              <span className="font-sans text-[var(--fiori-brand)]">{item.categoryLabelFa}</span>
            </div>
          </div>
        ),
      },
      {
        key: 'driver',
        header: 'مبنای مهندسی مصرف',
        render: item => (
          <div>
            <div className="text-[11px] text-[var(--fiori-text-primary)]">{item.consumptionDriverLabelFa}</div>
            <div className="text-[10px] text-[var(--fiori-text-secondary)] font-mono tabular-nums">
              ضریب: {toPersianDigits(item.standardRatePerDriverUnit)} {item.unit} (پرت: {toPersianDigits(item.wasteAllowancePercent)}٪)
            </div>
          </div>
        ),
      },
      {
        key: 'dailyBurnRate',
        header: 'مصرف روزانه',
        align: 'center',
        isMono: true,
        render: item => (
          <span className="text-[var(--fiori-text-primary)] tabular-nums">
            {toPersianDigits(item.dailyBurnRate)}{' '}
            <span className="text-[10px] text-[var(--fiori-text-secondary)]">{item.unit}</span>
          </span>
        ),
      },
      {
        key: 'forecastedGrossRequirement',
        header: `نیاز ${toPersianDigits(horizonDays)} روزه`,
        align: 'center',
        isMono: true,
        render: item => (
          <span className="font-semibold text-[var(--fiori-brand)] text-xs tabular-nums">
            {formatNumber(item.forecastedGrossRequirement)}{' '}
            <span className="text-[10px] font-normal">{item.unit}</span>
          </span>
        ),
      },
      {
        key: 'currentStock',
        header: 'موجودی فعلی',
        align: 'center',
        isMono: true,
        render: item => (
          <span className="font-semibold text-[var(--fiori-text-primary)] tabular-nums">
            {formatNumber(item.currentStock)}{' '}
            <span className="text-[10px] font-normal text-[var(--fiori-text-secondary)]">{item.unit}</span>
          </span>
        ),
      },
      {
        key: 'reorderPoint',
        header: 'نقطه سفارش (ROP)',
        align: 'center',
        isMono: true,
        render: item => (
          <div className="tabular-nums">
            <span>{formatNumber(item.reorderPoint)}</span>
            <span className="block text-[10px] text-[var(--fiori-text-secondary)]">
              اطمینان: {formatNumber(item.minSafetyStock)}
            </span>
          </div>
        ),
      },
      {
        key: 'daysOfSupplyRemaining',
        header: 'پوشش موجودی (روز)',
        align: 'center',
        isMono: true,
        sortable: true,
        sortValue: item => item.daysOfSupplyRemaining,
        render: item => (
          <FioriObjectStatus
            tone={
              item.daysOfSupplyRemaining <= item.supplierLeadTimeDays
                ? 'negative'
                : item.daysOfSupplyRemaining <= 20
                ? 'critical'
                : 'positive'
            }
            label={`${toPersianDigits(item.daysOfSupplyRemaining)} روز`}
            size="sm"
          />
        ),
      },
      {
        key: 'estimatedRunOutDateFa',
        header: 'تاریخ اتمام',
        align: 'center',
        isMono: true,
        render: item => (
          <span className="text-[11px] text-[var(--fiori-text-primary)] tabular-nums">
            {item.estimatedRunOutDateFa}
          </span>
        ),
      },
      {
        key: 'suggestedOrderQty',
        header: 'پیشنهاد خرید',
        align: 'center',
        isMono: true,
        render: item =>
          item.suggestedOrderQty > 0 ? (
            <div className="font-semibold text-[var(--fiori-critical)] text-xs tabular-nums">
              <span>
                {formatNumber(item.suggestedOrderQty)} {item.unit}
              </span>
              <span className="block text-[10px] text-[var(--fiori-text-secondary)] font-normal">
                {formatNumber(Math.round(item.estimatedTotalOrderCostRials / 1000000))} م.ریال
              </span>
            </div>
          ) : (
            <span className="text-[var(--fiori-text-muted)]">-</span>
          ),
      },
      {
        key: 'status',
        header: 'وضعیت',
        align: 'center',
        render: item => {
          if (item.status === 'CRITICAL_SHORTAGE') {
            return <FioriObjectStatus tone="negative" label="کسری فوری" size="sm" />;
          }
          if (item.status === 'BELOW_ROP') {
            return <FioriObjectStatus tone="critical" label="نقطه سفارش" size="sm" />;
          }
          return <FioriObjectStatus tone="positive" label="موجودی کافی" size="sm" />;
        },
      },
      {
        key: 'actions',
        header: 'عملیات',
        align: 'center',
        headerClassName: 'no-print',
        cellClassName: 'no-print',
        render: item => (
          <div className="flex items-center justify-center gap-1">
            <button
              type="button"
              onClick={() => handleOpenEdit(item)}
              title="تنظیم موجودی یا ضریب مصرف"
              className="sap-btn-standard p-1 cursor-pointer"
            >
              <Edit3 className="w-3.5 h-3.5" />
            </button>
            {item.suggestedOrderQty > 0 && (
              <button
                type="button"
                onClick={() => handleIssueRequisition([item.code])}
                title="صدور درخواست خرید برای این قلم"
                className="px-2 py-0.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-positive-bg)] hover:bg-[var(--fiori-positive)] text-[var(--fiori-positive)] hover:text-white border border-[var(--fiori-positive-border)] text-[10px] font-semibold cursor-pointer transition"
              >
                خرید
              </button>
            )}
          </div>
        ),
      },
    ],
    [handleIssueRequisition, handleOpenEdit, horizonDays, traceDocument]
  );

  const prLineColumns: FioriTableColumn<PurchaseRequisitionRecord['lines'][number]>[] = useMemo(
    () => [
      {
        key: 'consumableCode',
        header: 'کد کالا',
        isMono: true,
        render: line => (
          <button
            type="button"
            onClick={() => traceDocument(line.consumableCode, 'INVENTORY_LEDGER')}
            className="sap-doc-link font-mono font-semibold fiori-ltr-code cursor-pointer"
          >
            {line.consumableCode}
          </button>
        ),
      },
      {
        key: 'consumableName',
        header: 'شرح کالای مصرفی',
        render: line => <span className="text-[var(--fiori-text-primary)]">{line.consumableName}</span>,
      },
      {
        key: 'currentStock',
        header: 'موجودی فعلی',
        align: 'center',
        isMono: true,
        render: line => (
          <span className="text-[var(--fiori-text-secondary)] tabular-nums">
            {formatNumber(line.currentStock)} {line.unit}
          </span>
        ),
      },
      {
        key: 'orderQuantity',
        header: 'مقدار سفارش',
        align: 'center',
        isMono: true,
        render: line => (
          <span className="font-semibold text-[var(--fiori-positive)] tabular-nums">
            {formatNumber(line.orderQuantity)} {line.unit}
          </span>
        ),
      },
      {
        key: 'supplierName',
        header: 'تأمین‌کننده منتخب',
        render: line => <span className="text-[var(--fiori-text-primary)]">{line.supplierName}</span>,
      },
      {
        key: 'estimatedCostRials',
        header: 'برآورد مبلغ (ریال)',
        align: 'left',
        isMono: true,
        render: line => (
          <span className="text-[var(--fiori-text-primary)] font-semibold tabular-nums">
            {formatNumber(line.estimatedCostRials)}
          </span>
        ),
      },
    ],
    [traceDocument]
  );

  return (
    <>
      <FioriDynamicPage
        title="ماژول پیش‌بینی مواد مصرفی و ملزومات کارگاهی (Consumables & Supplies Forecasting)"
        subtitle="پیش‌بینی هوشمند مصرف سیم جوش CO2، الکترود نقطه‌جوش، روغن کشش ورق، سنبه‌های قالب، رنگ ED و ملزومات بسته‌بندی بر اساس ضرب پرس و تیراژ دستور کارها"
        status={<FioriObjectStatus tone="info" label="ROP & Burn-Rate Engine" ltrCode size="sm" />}
        activeFiltersCount={activeFiltersCount}
        onResetFilters={() => {
          setCategoryFilter('ALL');
          setSearchQuery('');
        }}
        headerActions={
          <div className="flex items-center flex-wrap gap-2 no-print">
            <button
              type="button"
              onClick={() => handleIssueRequisition()}
              disabled={creatingPr}
              className="sap-btn-emphasized flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
            >
              <ShoppingCart className="w-3.5 h-3.5" />
              <span>صدور خودکار درخواست خرید کسری‌ها (PR)</span>
            </button>

            <button
              type="button"
              onClick={loadForecast}
              disabled={loading}
              className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${
                  loading ? 'animate-spin text-[var(--fiori-brand)]' : 'text-[var(--fiori-text-secondary)]'
                }`}
              />
              <span>محاسبه مجدد</span>
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
              <span>چاپ</span>
            </button>
          </div>
        }
        kpiStrip={
          data ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3 text-right shadow-[var(--fiori-shadow-card)]">
                <span className="text-[11px] text-[var(--fiori-negative)] font-semibold flex items-center gap-1">
                  <ShieldAlert className="w-3.5 h-3.5" />
                  اقلام بحرانی (نیاز به خرید فوری)
                </span>
                <div className="text-xl font-semibold text-[var(--fiori-negative)] font-mono tabular-nums mt-1">
                  {toPersianDigits(data.criticalShortageCount)}{' '}
                  <span className="text-xs font-sans font-normal text-[var(--fiori-text-secondary)]">قلم</span>
                </div>
                <span className="text-[10px] text-[var(--fiori-text-secondary)] mt-0.5 block">
                  پوشش کمتر از Lead-Time تامین‌کننده
                </span>
              </div>

              <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3 text-right shadow-[var(--fiori-shadow-card)]">
                <span className="text-[11px] text-[var(--fiori-critical)] font-semibold block">
                  رسیده به نقطه سفارش (ROP)
                </span>
                <div className="text-xl font-semibold text-[var(--fiori-critical)] font-mono tabular-nums mt-1">
                  {toPersianDigits(data.belowReorderPointCount)}{' '}
                  <span className="text-xs font-sans font-normal text-[var(--fiori-text-secondary)]">قلم</span>
                </div>
                <span className="text-[10px] text-[var(--fiori-text-secondary)] mt-0.5 block">
                  نیازمند ثبت سفارش شارژ مجدد
                </span>
              </div>

              <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3 text-right shadow-[var(--fiori-shadow-card)]">
                <span className="text-[11px] text-[var(--fiori-positive)] font-semibold block">
                  موجودی کافی و ایمن
                </span>
                <div className="text-xl font-semibold text-[var(--fiori-positive)] font-mono tabular-nums mt-1">
                  {toPersianDigits(data.adequateStockCount)}{' '}
                  <span className="text-xs font-sans font-normal text-[var(--fiori-text-secondary)]">قلم</span>
                </div>
                <span className="text-[10px] text-[var(--fiori-text-secondary)] mt-0.5 block">
                  پوشش کامل افق {toPersianDigits(data.horizonDays)} روزه
                </span>
              </div>

              <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3 text-right shadow-[var(--fiori-shadow-card)]">
                <span className="text-[11px] text-[var(--fiori-brand)] font-semibold block">
                  کمترین روز پوشش موجودی
                </span>
                <div className="text-xl font-semibold text-[var(--fiori-text-primary)] font-mono tabular-nums mt-1">
                  {data.lowestDaysOfSupplyItem ? `${toPersianDigits(data.lowestDaysOfSupplyItem.daysRemaining)} روز` : '-'}
                </div>
                <span
                  className="text-[10px] text-[var(--fiori-text-secondary)] mt-0.5 block truncate"
                  title={data.lowestDaysOfSupplyItem?.name}
                >
                  {data.lowestDaysOfSupplyItem?.name || '-'}
                </span>
              </div>

              <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3 text-right shadow-[var(--fiori-shadow-card)]">
                <span className="text-[11px] text-[var(--fiori-brand)] font-semibold block">
                  برآورد بودجه خرید پیشنهادی
                </span>
                <div className="text-lg font-semibold text-[var(--fiori-text-primary)] font-mono tabular-nums mt-1">
                  {formatNumber(Math.round(data.totalSuggestedProcurementBudgetRials / 1000000))}{' '}
                  <span className="text-[10px] font-sans font-normal text-[var(--fiori-text-secondary)]">
                    میلیون ریال
                  </span>
                </div>
                <span className="text-[10px] text-[var(--fiori-text-secondary)] mt-0.5 block">
                  برای پوشش کسری و نقطه سفارش
                </span>
              </div>
            </div>
          ) : undefined
        }
        filterBar={
          <div className="space-y-3 text-xs no-print">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[var(--fiori-text-secondary)] font-medium flex items-center gap-1">
                  <Calendar className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
                  افق زمانی پیش‌بینی:
                </span>
                {[
                  { days: 15, label: '۱۵ روز آینده (دو هفته)' },
                  { days: 30, label: '۳۰ روز آینده (یک ماه)' },
                  { days: 60, label: '۶۰ روز آینده (دو ماه)' },
                  { days: 90, label: '۹۰ روز آینده (فصلی)' },
                ].map(h => (
                  <button
                    key={h.days}
                    type="button"
                    onClick={() => setHorizonDays(h.days)}
                    className={`px-2.5 py-1 rounded-[var(--fiori-radius-sm)] font-medium transition cursor-pointer ${
                      horizonDays === h.days
                        ? 'bg-[var(--fiori-brand)] text-white font-semibold border border-[var(--fiori-brand)]'
                        : 'bg-[var(--fiori-bg-subtle)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] border border-[var(--fiori-border-default)]'
                    }`}
                  >
                    {h.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2.5">
                <span className="text-[var(--fiori-text-secondary)] flex items-center gap-1">
                  <SlidersHorizontal className="w-3.5 h-3.5 text-[var(--fiori-critical)]" />
                  ضریب تغییر تیراژ برنامه تولید:
                </span>
                <div className="flex items-center gap-1">
                  {[-10, 0, 15, 30, 50].map(g => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => setGrowthPercent(g)}
                      className={`px-2 py-1 rounded-[var(--fiori-radius-sm)] font-mono text-[11px] cursor-pointer transition tabular-nums ${
                        growthPercent === g
                          ? 'bg-[var(--fiori-critical)] text-white font-semibold border border-[var(--fiori-critical)]'
                          : 'bg-[var(--fiori-bg-subtle)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] border border-[var(--fiori-border-default)]'
                      }`}
                    >
                      {g > 0 ? `+${toPersianDigits(g)}٪` : `${toPersianDigits(g)}٪`}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {activeSubView === 'forecast_table' && (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pt-2 border-t border-[var(--fiori-border-subtle)]">
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
                  {categories.map(cat => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setCategoryFilter(cat.id)}
                      className={`px-2.5 py-1 rounded-[var(--fiori-radius-sm)] font-medium whitespace-nowrap transition cursor-pointer border ${
                        categoryFilter === cat.id
                          ? 'bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border-[var(--fiori-brand)] font-semibold'
                          : 'bg-[var(--fiori-bg-surface)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] border-[var(--fiori-border-default)]'
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>

                <div className="relative w-full sm:w-64 shrink-0">
                  <Search className="w-3.5 h-3.5 text-[var(--fiori-text-muted)] absolute right-2.5 top-2" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="جستجو در نام یا کد کالای مصرفی..."
                    className="w-full bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] pr-8 pl-3 py-1 text-xs text-[var(--fiori-text-primary)] placeholder:text-[var(--fiori-text-muted)] focus:outline-none focus:border-[var(--fiori-border-focus)]"
                  />
                </div>
              </div>
            )}
          </div>
        }
      >
        <div className="space-y-4">
          {notice && (
            <FioriMessageStrip tone="success" onClose={() => setNotice(null)}>
              {notice}
            </FioriMessageStrip>
          )}

          {/* Skeleton Loading State */}
          {loading && !data && <ReportModuleSkeleton kpiCount={5} showChart={false} tableRows={6} tableColumns={9} />}

          {/* Sub-navigation: Forecast Table vs Purchase Requisitions */}
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--fiori-border-default)] pb-2 no-print">
            <button
              type="button"
              onClick={() => setActiveSubView('forecast_table')}
              className={`px-3.5 py-1.5 rounded-[var(--fiori-radius-sm)] text-xs font-semibold transition cursor-pointer flex items-center gap-1.5 border ${
                activeSubView === 'forecast_table'
                  ? 'bg-[var(--fiori-brand)] text-white border-[var(--fiori-brand)]'
                  : 'bg-[var(--fiori-bg-surface)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] border-[var(--fiori-border-default)]'
              }`}
            >
              <Flame className="w-3.5 h-3.5" />
              <span>ماتریس پیش‌بینی مصرف و نقطه سفارش (ROP)</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSubView('requisitions')}
              className={`px-3.5 py-1.5 rounded-[var(--fiori-radius-sm)] text-xs font-semibold transition cursor-pointer flex items-center gap-1.5 border ${
                activeSubView === 'requisitions'
                  ? 'bg-[var(--fiori-positive)] text-white border-[var(--fiori-positive)]'
                  : 'bg-[var(--fiori-bg-surface)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] border-[var(--fiori-border-default)]'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              <span>درخواست‌های خرید تدارکات صادره (PR)</span>
              {data && (
                <span
                  className={`px-1.5 py-0.2 rounded-[var(--fiori-radius-sm)] text-[10px] font-mono tabular-nums ${
                    activeSubView === 'requisitions'
                      ? 'bg-white/20 text-white'
                      : 'bg-[var(--fiori-neutral-bg)] text-[var(--fiori-text-primary)]'
                  }`}
                >
                  {toPersianDigits(data.activeRequisitions.length)}
                </span>
              )}
            </button>
          </div>

          {activeSubView === 'forecast_table' ? (
            <div className="printable-area space-y-3">
              {/* Print Header shown only during print */}
              <div className="hidden print:block p-4 border-b border-[var(--fiori-border-default)] text-center bg-white">
                <span className="text-xs text-[var(--fiori-text-secondary)] block">
                  شرکت تولیدی قطعات خودرو (زنجیره تامین ساپکو)
                </span>
                <h2 className="text-base font-semibold text-[var(--fiori-text-primary)] mt-1">
                  گزارش رسمی پیش‌بینی مواد مصرفی و ملزومات کارگاهی (Consumables ROP)
                </h2>
                <span className="text-[10px] text-[var(--fiori-text-secondary)] font-mono">
                  افق پیش‌بینی: {toPersianDigits(horizonDays)} روز کاری
                </span>
              </div>

              <FioriDataTable
                columns={forecastColumns}
                data={filteredItems}
                rowKey={item => item.id}
                compact
                bordered
                toolbar={
                  <FioriToolbar
                    variant="table"
                    title="ماتریس پیش‌بینی مصرف و نقطه سفارش اقلام کارگاهی"
                    count={filteredItems.length}
                    countLabel="قلم"
                  />
                }
                emptyState={
                  <EmptyState
                    variant={activeFiltersCount > 0 ? 'FILTER_NO_MATCH' : 'NO_DATA'}
                    compact
                    actionLabel={activeFiltersCount > 0 ? 'پاک‌کردن فیلترها' : undefined}
                    onAction={
                      activeFiltersCount > 0
                        ? () => {
                            setCategoryFilter('ALL');
                            setSearchQuery('');
                          }
                        : undefined
                    }
                  />
                }
              />
            </div>
          ) : (
            <div className="space-y-4">
              {!data?.activeRequisitions?.length ? (
                <EmptyState
                  variant="NO_DATA"
                  compact
                  title="درخواست خرید فعالی ثبت نشده است"
                  description="از دکمه «صدور خودکار درخواست خرید کسری‌ها (PR)» در نوار بالا استفاده کنید."
                />
              ) : (
                data.activeRequisitions.map(pr => (
                  <div
                    key={pr.id}
                    className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)] p-4 space-y-3"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[var(--fiori-border-subtle)] pb-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-semibold text-[var(--fiori-brand)] fiori-ltr-code">
                            {pr.prNumber}
                          </span>
                          <FioriObjectStatus
                            tone={pr.status === 'APPROVED_BY_PLANT_MGR' ? 'positive' : 'critical'}
                            label={
                              pr.status === 'APPROVED_BY_PLANT_MGR'
                                ? 'تأیید مدیریت کارخانه'
                                : 'در انتظار تأیید تدارکات'
                            }
                            size="sm"
                          />
                        </div>
                        <div className="text-xs text-[var(--fiori-text-secondary)] mt-1">
                          درخواست‌کننده: {pr.requestedBy} • تاریخ صدور:{' '}
                          <span className="font-mono">{pr.createdAtFa}</span>
                        </div>
                      </div>
                      <div className="text-left font-mono tabular-nums">
                        <span className="text-[11px] text-[var(--fiori-text-secondary)] block font-sans">
                          جمع برآورد مالی سفارش:
                        </span>
                        <span className="text-base font-semibold text-[var(--fiori-critical)]">
                          {formatNumber(pr.totalEstimatedCostRials)} ریال
                        </span>
                      </div>
                    </div>

                    <FioriDataTable
                      columns={prLineColumns}
                      data={pr.lines}
                      rowKey={(line, idx) => `${pr.id}-${line.consumableCode}-${idx}`}
                      compact
                      bordered
                    />

                    {pr.notes && (
                      <div className="text-[11px] text-[var(--fiori-text-secondary)] bg-[var(--fiori-bg-subtle)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-subtle)]">
                        توضیحات: {pr.notes}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </FioriDynamicPage>

      {/* Edit Consumable Stock / Rate Dialog */}
      <FioriDialog
        isOpen={Boolean(editingItem)}
        onClose={() => {
          if (!savingEdit) setEditingItem(null);
        }}
        title="تنظیم موجودی و ضریب مصرف مهندسی"
        subtitle={editingItem?.name}
        icon={<Edit3 className="w-4 h-4" />}
        tone="brand"
        size="sm"
        disableClose={savingEdit}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <button
              type="button"
              onClick={() => setEditingItem(null)}
              disabled={savingEdit}
              className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="consumable-edit-form"
              disabled={savingEdit}
              className="sap-btn-emphasized px-5 py-1.5 text-xs cursor-pointer"
            >
              {savingEdit ? 'در حال ذخیره...' : 'ذخیره و بازمحاسبه پیش‌بینی'}
            </button>
          </div>
        }
      >
        {editingItem && (
          <form id="consumable-edit-form" onSubmit={handleSaveEdit} className="space-y-3 text-xs">
            <div>
              <label className="block text-[var(--fiori-text-primary)] font-medium mb-1">
                موجودی آزاد فعلی در انبار ({editingItem.unit}):
              </label>
              <input
                type="number"
                step="0.1"
                value={editStockVal}
                onChange={e => setEditStockVal(Number(e.target.value))}
                className="w-full bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-3 py-1.5 text-[var(--fiori-text-primary)] font-mono focus:outline-none focus:border-[var(--fiori-border-focus)]"
              />
            </div>

            <div>
              <label className="block text-[var(--fiori-text-primary)] font-medium mb-1">
                ضریب مصرف استاندارد ({editingItem.consumptionDriverLabelFa}):
              </label>
              <input
                type="number"
                step="0.01"
                value={editRateVal}
                onChange={e => setEditRateVal(Number(e.target.value))}
                className="w-full bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-3 py-1.5 text-[var(--fiori-text-primary)] font-mono focus:outline-none focus:border-[var(--fiori-border-focus)]"
              />
            </div>

            <div>
              <label className="block text-[var(--fiori-text-primary)] font-medium mb-1">
                حداقل موجودی اطمینان (Safety Stock - {editingItem.unit}):
              </label>
              <input
                type="number"
                step="1"
                value={editSafetyVal}
                onChange={e => setEditSafetyVal(Number(e.target.value))}
                className="w-full bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-3 py-1.5 text-[var(--fiori-text-primary)] font-mono focus:outline-none focus:border-[var(--fiori-border-focus)]"
              />
            </div>
          </form>
        )}
      </FioriDialog>
    </>
  );
};
