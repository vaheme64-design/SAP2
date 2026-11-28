import React, { useState, useMemo, useEffect } from 'react';
import {
  Search,
  Download,
  RefreshCw,
  ArrowRightLeft,
  Building2,
  X,
} from 'lucide-react';
import { StageInventorySummary, FACTORY_STAGES, resolveStageDisplayName } from '../types/inventory';
import {
  formatNumber,
  formatWeightKg,
  toPersianDigits,
  formatDateTime,
  exportToCsv,
} from '../utils/formatters';
import { TableSkeleton, KpiCardsSkeleton } from './common/Skeleton';
import { EmptyState } from './common/EmptyState';
import { useErpRouter } from '../context/RouterContext';
import {
  FioriDynamicPage,
  FioriDataTable,
  FioriTableColumn,
  FioriToolbar,
  FioriObjectStatus,
} from './fiori/ui';

interface InventoryReportViewProps {
  balances: StageInventorySummary[];
  onRefresh: () => Promise<void>;
  loading: boolean;
}

export const InventoryReportView: React.FC<InventoryReportViewProps> = ({
  balances,
  onRefresh,
  loading,
}) => {
  const { traceDocument, route, clearDocQuery } = useErpRouter();
  const [searchTerm, setSearchTerm] = useState(route.docQuery || '');
  const [selectedStageFilter, setSelectedStageFilter] = useState('ALL');
  const [onlyNonZero, setOnlyNonZero] = useState(!route.docQuery);
  const [sortField, setSortField] = useState<keyof StageInventorySummary>('totalQty');
  const [sortAsc, setSortAsc] = useState(false);

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 15;

  useEffect(() => {
    if (route.docQuery) {
      setSearchTerm(route.docQuery);
      setOnlyNonZero(false);
      setSelectedStageFilter('ALL');
      setCurrentPage(1);
    }
  }, [route.docQuery]);

  const filteredBalances = useMemo(() => {
    return balances
      .filter(item => {
        if (onlyNonZero && item.totalQty === 0 && item.inTransitQty === 0 && item.scrapQty === 0) {
          return false;
        }
        if (selectedStageFilter !== 'ALL' && item.stageId !== selectedStageFilter) {
          return false;
        }
        if (searchTerm) {
          const q = searchTerm.toLowerCase();
          const matchesName = item.partName.toLowerCase().includes(q);
          const matchesCode = item.partCode.toLowerCase().includes(q);
          const matchesStage = item.stageName.toLowerCase().includes(q);
          if (!matchesName && !matchesCode && !matchesStage) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const valA = a[sortField] ?? 0;
        const valB = b[sortField] ?? 0;
        if (valA < valB) return sortAsc ? -1 : 1;
        if (valA > valB) return sortAsc ? 1 : -1;
        return 0;
      });
  }, [balances, searchTerm, selectedStageFilter, onlyNonZero, sortField, sortAsc]);

  const pagedData = filteredBalances.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  // Totals of current filtered view
  const totalUsableQty = filteredBalances.reduce((sum, item) => sum + item.usableQty, 0);
  const totalInTransitQty = filteredBalances.reduce((sum, item) => sum + item.inTransitQty, 0);
  const totalScrapQty = filteredBalances.reduce((sum, item) => sum + item.scrapQty, 0);
  const totalWeightKg = filteredBalances.reduce((sum, item) => sum + item.totalKg, 0);

  const activeFiltersCount =
    (searchTerm.trim() ? 1 : 0) +
    (selectedStageFilter !== 'ALL' ? 1 : 0) +
    (!onlyNonZero ? 1 : 0);

  const handleResetFilters = () => {
    if (route.docQuery) clearDocQuery();
    setSearchTerm('');
    setSelectedStageFilter('ALL');
    setOnlyNonZero(true);
    setCurrentPage(1);
  };

  const handleExportCsv = () => {
    const headers = [
      'ایستگاه / انبار',
      'کد کاتالوگ قطعه',
      'عنوان قطعه / ماده اولیه',
      'موجودی قابل استفاده',
      'موجودی رزرو شده',
      'موجودی در راه (انتقال)',
      'موجودی کل مرحله',
      'واحد',
      'وزن کل (کیلوگرم)',
      'ضایعات ثبت شده',
      'درصد ضایعات',
      'آخرین تراکنش',
    ];

    const rows = filteredBalances.map(item => [
      resolveStageDisplayName(item.stageId, item.stageName),
      item.partCode,
      item.partName,
      item.usableQty,
      item.reservedQty,
      item.inTransitQty,
      item.totalQty,
      item.unit === 'PCS' ? 'عدد' : item.unit === 'KG' ? 'کیلوگرم' : item.unit,
      item.totalKg,
      item.scrapQty,
      `${item.scrapRatePercent}%`,
      formatDateTime(item.lastActivityDate),
    ]);

    exportToCsv(`گزارش_موجودی_انبار_و_WIP_${Date.now()}`, headers, rows);
  };

  const columns = useMemo<FioriTableColumn<StageInventorySummary>[]>(
    () => [
      {
        key: 'stageName',
        header: 'ایستگاه / مرحله',
        render: item => (
          <div className="flex items-center gap-1.5 font-medium text-[var(--fiori-text-primary)]">
            <Building2 className="w-3.5 h-3.5 text-[var(--fiori-brand)] shrink-0" />
            <span>{resolveStageDisplayName(item.stageId, item.stageName)}</span>
          </div>
        ),
      },
      {
        key: 'partCode',
        header: 'کد قطعه',
        isMono: true,
        render: item => (
          <button
            type="button"
            onClick={() => traceDocument(item.partCode, 'INVENTORY_LEDGER')}
            className="sap-doc-link fiori-ltr-code font-semibold"
            title="رهگیری کاردکس قطعه"
          >
            {item.partCode}
          </button>
        ),
      },
      {
        key: 'partName',
        header: 'عنوان قطعه / شیت',
        cellClassName: 'font-medium text-[var(--fiori-text-primary)]',
        render: item => item.partName,
      },
      {
        key: 'usableQty',
        header: 'موجودی آزاد',
        isMono: true,
        sortable: true,
        cellClassName: 'font-semibold text-[var(--fiori-positive)]',
        render: item => formatNumber(item.usableQty),
      },
      {
        key: 'inTransitQty',
        header: 'در راه (انتقال)',
        isMono: true,
        cellClassName: 'text-[var(--fiori-brand)]',
        render: item =>
          item.inTransitQty > 0 ? (
            <span className="inline-flex items-center gap-1">
              <ArrowRightLeft className="w-3 h-3 text-[var(--fiori-brand)]" />
              {formatNumber(item.inTransitQty)}
            </span>
          ) : (
            '-'
          ),
      },
      {
        key: 'totalQty',
        header: 'موجودی کل',
        isMono: true,
        sortable: true,
        cellClassName: 'font-bold text-[var(--fiori-text-primary)]',
        render: item => formatNumber(item.totalQty),
      },
      {
        key: 'unit',
        header: 'واحد',
        cellClassName: 'text-[var(--fiori-text-secondary)] font-medium',
        render: item => (item.unit === 'PCS' ? 'عدد' : item.unit === 'KG' ? 'کیلوگرم' : item.unit),
      },
      {
        key: 'totalKg',
        header: 'وزن کل',
        isMono: true,
        sortable: true,
        cellClassName: 'font-medium text-[var(--fiori-text-primary)]',
        render: item => formatWeightKg(item.totalKg),
      },
      {
        key: 'scrapQty',
        header: 'ضایعات',
        isMono: true,
        cellClassName: 'text-[var(--fiori-negative)]',
        render: item => (item.scrapQty > 0 ? formatNumber(item.scrapQty) : '-'),
      },
      {
        key: 'scrapRatePercent',
        header: 'نرخ ضایعات',
        render: item =>
          item.scrapRatePercent > 0 ? (
            <FioriObjectStatus
              tone={item.scrapRatePercent > 2.5 ? 'negative' : 'neutral'}
              label={`${toPersianDigits(item.scrapRatePercent)}٪`}
            />
          ) : (
            <span className="text-[var(--fiori-text-secondary)]">-</span>
          ),
      },
      {
        key: 'lastActivityDate',
        header: 'آخرین تراکنش',
        isMono: true,
        cellClassName: 'text-[var(--fiori-text-secondary)] text-[11px]',
        render: item => formatDateTime(item.lastActivityDate),
      },
    ],
    [traceDocument]
  );

  return (
    <FioriDynamicPage
      title="گزارش کاردکس و موجودی چندمرحله‌ای (مواد اولیه، WIP و محصول)"
      subtitle="موجودی از گردش دفاتر تراکنش‌های معتبر و با تفکیک قطعی موجودی آزاد، رزرو و در انتظار انتقال محاسبه شده است."
      status={<FioriObjectStatus tone="info" label="محاسبه از دفاتر تراکنش" />}
      collapsibleFilters={false}
      activeFiltersCount={activeFiltersCount}
      onResetFilters={handleResetFilters}
      headerActions={
        <>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
            title="به‌روزرسانی لحظه‌ای محاسبه دفاتر"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>محاسبه مجدد</span>
          </button>
          <button
            type="button"
            onClick={handleExportCsv}
            className="sap-btn-emphasized flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>خروجی اکسل (CSV)</span>
          </button>
        </>
      }
      kpiStrip={
        loading ? (
          <KpiCardsSkeleton count={4} columns={4} theme="light" />
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="fiori-surface-card p-3">
              <span className="text-[11px] text-[var(--fiori-text-secondary)]">
                موجودی آزاد و قابل استفاده
              </span>
              <div className="text-base lg:text-lg font-bold text-[var(--fiori-positive)] mt-1 tabular-nums font-mono">
                {formatNumber(totalUsableQty)}
              </div>
            </div>
            <div className="fiori-surface-card p-3">
              <span className="text-[11px] text-[var(--fiori-text-secondary)]">
                موجودی در حال انتقال (بین مراحل)
              </span>
              <div className="text-base lg:text-lg font-bold text-[var(--fiori-brand)] mt-1 tabular-nums font-mono">
                {formatNumber(totalInTransitQty)}
              </div>
            </div>
            <div className="fiori-surface-card p-3">
              <span className="text-[11px] text-[var(--fiori-text-secondary)]">
                وزن کل موجودی در این نما
              </span>
              <div className="text-base lg:text-lg font-bold text-[var(--fiori-text-primary)] mt-1 tabular-nums font-mono">
                {formatWeightKg(totalWeightKg)}
              </div>
            </div>
            <div className="fiori-surface-card p-3">
              <span className="text-[11px] text-[var(--fiori-text-secondary)]">
                مجموع ضایعات ثبتی
              </span>
              <div className="text-base lg:text-lg font-bold text-[var(--fiori-negative)] mt-1 tabular-nums font-mono">
                {formatNumber(totalScrapQty)}
              </div>
            </div>
          </div>
        )
      }
      filterBar={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3 flex-1">
            <div className="relative min-w-[220px] flex-1">
              <Search className="w-4 h-4 text-[var(--fiori-text-secondary)] absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchTerm}
                onChange={e => {
                  setSearchTerm(e.target.value);
                  setCurrentPage(1);
                }}
                placeholder="جستجوی نام قطعه، کد کاتالوگ یا ایستگاه..."
                className="fiori-input w-full pr-9 pl-3 py-1.5"
              />
            </div>

            <select
              value={selectedStageFilter}
              onChange={e => {
                setSelectedStageFilter(e.target.value);
                setCurrentPage(1);
              }}
              className="fiori-input px-3 py-1.5 cursor-pointer"
            >
              <option value="ALL">همه ایستگاه‌ها و انبارها</option>
              {FACTORY_STAGES.map(st => (
                <option key={st.id} value={st.id}>
                  {st.name}
                </option>
              ))}
            </select>

            <label className="flex items-center gap-2 text-xs text-[var(--fiori-text-primary)] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={onlyNonZero}
                onChange={e => {
                  setOnlyNonZero(e.target.checked);
                  setCurrentPage(1);
                }}
                className="rounded-sm border-[var(--fiori-border-input)] text-[var(--fiori-brand)] focus:ring-0"
              />
              <span>فقط ردیف‌های دارای موجودی یا گردش</span>
            </label>
          </div>

          <div className="flex items-center gap-2 text-xs text-[var(--fiori-text-secondary)]">
            {route.docQuery && (
              <button
                type="button"
                onClick={handleResetFilters}
                className="px-2 py-1 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border border-[var(--fiori-brand-border)] flex items-center gap-1 cursor-pointer"
              >
                <span>فیلتر قطعه: {route.docQuery}</span>
                <X className="w-3 h-3" />
              </button>
            )}
            <span>
              تعداد ردیف‌ها:{' '}
              <span className="font-bold text-[var(--fiori-text-primary)] tabular-nums">
                {formatNumber(filteredBalances.length)}
              </span>
            </span>
          </div>
        </div>
      }
    >
      {loading ? (
        <TableSkeleton rows={8} columns={8} theme="light" />
      ) : (
        <FioriDataTable
          toolbar={
            <FioriToolbar
              variant="table"
              title="موجودی ایستگاه‌ها و مراحل تولید"
              count={filteredBalances.length}
              countLabel="ردیف"
            />
          }
          columns={columns}
          data={pagedData}
          rowKey={item => `${item.stageId}_${item.partId}`}
          sortKey={sortField}
          sortDirection={sortAsc ? 'asc' : 'desc'}
          onSortChange={(key, dir) => {
            setSortField(key as keyof StageInventorySummary);
            setSortAsc(dir === 'asc');
            setCurrentPage(1);
          }}
          pagination={{
            currentPage,
            pageSize,
            totalItems: filteredBalances.length,
            onPageChange: setCurrentPage,
          }}
          emptyState={
            <EmptyState
              compact
              variant={searchTerm.trim() ? 'SEARCH_NO_MATCH' : 'FILTER_NO_MATCH'}
              description="هیچ رکوردی منطبق با فیلترهای انتخابی یافت نشد."
              actionLabel="پاک‌کردن فیلترها"
              onAction={handleResetFilters}
            />
          }
        />
      )}
    </FioriDynamicPage>
  );
};
