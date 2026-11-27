import React, { useState, useMemo } from 'react';
import {
  Search,
  Download,
  RefreshCw,
  Layers,
} from 'lucide-react';
import {
  SapcoContract,
  SapcoContractLedgerEntry,
} from '../../types/inventory';
import {
  formatNumber,
  formatWeightKg,
  toPersianDigits,
  exportToCsv,
} from '../../utils/formatters';
import { useErpRouter } from '../../context/RouterContext';
import {
  FioriDynamicPage,
  FioriToolbar,
  FioriDataTable,
  FioriTableColumn,
  FioriObjectStatus,
  FioriStatusTone,
} from '../fiori/ui';
import { EmptyState } from '../common/EmptyState';

interface SapcoAccountReportViewProps {
  contracts: SapcoContract[];
  ledger: SapcoContractLedgerEntry[];
  loading: boolean;
  onRefresh: () => Promise<void>;
}

export const SapcoAccountReportView: React.FC<SapcoAccountReportViewProps> = ({
  contracts,
  ledger,
  loading,
  onRefresh,
}) => {
  const { traceDocument } = useErpRouter();
  const [selectedContractId, setSelectedContractId] = useState<string>('ALL');
  const [selectedOperationFilter, setSelectedOperationFilter] = useState<string>('ALL');
  const [searchTerm, setSearchTerm] = useState('');

  // Pagination for ledger table
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 12;

  // Aggregate metrics across active contracts
  const totalAllocatedKg = contracts.reduce((sum, c) => sum + c.allocatedWeightKg, 0);
  const totalReceivedKg = contracts.reduce((sum, c) => sum + c.totalReceivedKg, 0);
  const totalConsumedKg = contracts.reduce((sum, c) => sum + c.totalConsumedKg, 0);
  const totalClosingBalanceKg = contracts.reduce((sum, c) => sum + c.closingBalanceKg, 0);

  const operationLabels: Record<string, { label: string; tone: FioriStatusTone; sign: string }> = {
    OPENING: { label: 'موجودی اول دوره', tone: 'neutral', sign: '' },
    RECEIPT: { label: 'ورود رول ساپکو', tone: 'positive', sign: '+' },
    CONSUMPTION: { label: 'مصرف در خط پرس', tone: 'critical', sign: '-' },
    RETURN: { label: 'برگشت به ساپکو', tone: 'negative', sign: '-' },
    ADJUSTMENT: { label: 'تعدیل حسابرسی', tone: 'info', sign: '±' },
  };

  const filteredLedger = useMemo(() => {
    return ledger
      .filter(item => {
        if (selectedContractId !== 'ALL' && item.contractId !== selectedContractId) {
          return false;
        }
        if (selectedOperationFilter !== 'ALL' && item.operationType !== selectedOperationFilter) {
          return false;
        }
        if (searchTerm.trim()) {
          const q = searchTerm.toLowerCase();
          const matchesDoc = item.documentNumber.toLowerCase().includes(q);
          const matchesWaybill = item.waybillNumber ? item.waybillNumber.toLowerCase().includes(q) : false;
          const matchesLot = item.lotNumber ? item.lotNumber.toLowerCase().includes(q) : false;
          const matchesHeat = item.heatNumber ? item.heatNumber.toLowerCase().includes(q) : false;
          const matchesNotes = item.notes ? item.notes.toLowerCase().includes(q) : false;
          if (!matchesDoc && !matchesWaybill && !matchesLot && !matchesHeat && !matchesNotes) {
            return false;
          }
        }
        return true;
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [ledger, selectedContractId, selectedOperationFilter, searchTerm]);

  const pagedLedger = filteredLedger.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const hasFilters =
    selectedContractId !== 'ALL' || selectedOperationFilter !== 'ALL' || Boolean(searchTerm.trim());

  const resetFilters = () => {
    setSelectedContractId('ALL');
    setSelectedOperationFilter('ALL');
    setSearchTerm('');
    setCurrentPage(1);
  };

  const handleExportCsv = () => {
    const headers = [
      'قرارداد ساپکو',
      'شماره سند کاردکس',
      'تاریخ',
      'نوع تراکنش',
      'شماره بارنامه ساپکو',
      'شماره رول / لوت',
      'شماره ذوب فولادساز',
      'وزن تراکنش (کیلوگرم)',
      'مانده جاری قرارداد (کیلوگرم)',
      'شرح و توضیحات',
    ];

    const rows = filteredLedger.map(l => [
      l.contractNumber,
      l.documentNumber,
      l.date,
      operationLabels[l.operationType]?.label || l.operationType,
      l.waybillNumber || '-',
      l.lotNumber || '-',
      l.heatNumber || '-',
      l.weightKgSigned,
      l.runningBalanceKg,
      l.notes || '-',
    ]);

    exportToCsv(`حسابداری_و_کاردکس_سهمیه_ساپکو_${Date.now()}`, headers, rows);
  };

  const ledgerColumns: FioriTableColumn<SapcoContractLedgerEntry>[] = [
    {
      key: 'rowIndex',
      header: 'ردیف',
      render: (_row, idx) => (
        <span className="text-[var(--fiori-text-secondary)] font-mono tabular-nums">
          {toPersianDigits((currentPage - 1) * pageSize + idx + 1)}
        </span>
      ),
    },
    {
      key: 'date',
      header: 'تاریخ',
      render: row => <span className="font-mono text-[var(--fiori-text-secondary)] tabular-nums">{row.date}</span>,
    },
    {
      key: 'documentNumber',
      header: 'شماره سند کاردکس',
      render: row => (
        <button
          type="button"
          onClick={() => traceDocument(row.documentNumber, 'INVENTORY_LEDGER')}
          className="sap-doc-link font-mono font-bold fiori-ltr-code cursor-pointer"
        >
          {row.documentNumber}
        </button>
      ),
    },
    {
      key: 'operationType',
      header: 'نوع عملیات',
      render: row => {
        const op = operationLabels[row.operationType] || {
          label: row.operationType,
          tone: 'neutral' as const,
          sign: '',
        };
        return <FioriObjectStatus tone={op.tone} label={op.label} />;
      },
    },
    {
      key: 'contractNumber',
      header: 'قرارداد',
      render: row => (
        <button
          type="button"
          onClick={() => traceDocument(row.contractNumber, 'CONTRACTS')}
          className="sap-doc-link font-mono font-medium fiori-ltr-code cursor-pointer"
        >
          {row.contractNumber}
        </button>
      ),
    },
    {
      key: 'waybillNumber',
      header: 'شماره بارنامه ساپکو',
      render: row => (
        <span className="font-mono text-[var(--fiori-text-primary)] fiori-ltr-code">
          {row.waybillNumber || '-'}
        </span>
      ),
    },
    {
      key: 'lotNumber',
      header: 'شماره رول / لوت',
      render: row =>
        row.lotNumber ? (
          <button
            type="button"
            onClick={() => traceDocument(row.lotNumber!, 'COILS')}
            className="sap-doc-link font-mono fiori-ltr-code cursor-pointer"
          >
            {row.lotNumber}
          </button>
        ) : (
          <span className="font-mono text-[var(--fiori-text-muted)]">-</span>
        ),
    },
    {
      key: 'heatNumber',
      header: 'شماره ذوب',
      render: row => (
        <span className="font-mono text-[var(--fiori-text-secondary)] fiori-ltr-code">
          {row.heatNumber || '-'}
        </span>
      ),
    },
    {
      key: 'weightKgSigned',
      header: 'وزن گردش (کیلوگرم)',
      align: 'left',
      render: row => {
        const isPositive = row.weightKgSigned > 0;
        return (
          <span
            className={`font-mono font-bold tabular-nums ${
              isPositive ? 'text-[var(--fiori-positive)]' : 'text-[var(--fiori-text-primary)]'
            }`}
          >
            {isPositive ? `+${formatNumber(row.weightKgSigned)}` : formatNumber(row.weightKgSigned)}
          </span>
        );
      },
    },
    {
      key: 'runningBalanceKg',
      header: 'مانده جاری (کیلوگرم)',
      align: 'left',
      render: row => (
        <span className="font-mono font-bold text-[var(--fiori-text-primary)] tabular-nums whitespace-nowrap">
          {formatWeightKg(row.runningBalanceKg)}
        </span>
      ),
    },
    {
      key: 'notes',
      header: 'توضیحات',
      render: row => (
        <span
          className="text-[var(--fiori-text-secondary)] text-[11px] max-w-[200px] block truncate"
          title={row.notes}
        >
          {row.notes || '-'}
        </span>
      ),
    },
  ];

  const kpiStrip = (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
        <span className="text-[11px] font-medium text-[var(--fiori-text-secondary)]">
          کل سهمیه تخصیصی قراردادها
        </span>
        <div className="text-lg font-bold text-[var(--fiori-text-primary)] mt-1 font-mono tabular-nums">
          {formatWeightKg(totalAllocatedKg)}
        </div>
        <span className="text-[10px] text-[var(--fiori-text-muted)] block mt-1">
          بر اساس تفاهم‌نامه‌های ساپکو
        </span>
      </div>

      <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
        <span className="text-[11px] font-medium text-[var(--fiori-text-secondary)]">
          مجموع دریافتی کلاف (تحویل کارخانه)
        </span>
        <div className="text-lg font-bold text-[var(--fiori-text-primary)] mt-1 font-mono tabular-nums">
          {formatWeightKg(totalReceivedKg)}
        </div>
        <span className="text-[10px] text-[var(--fiori-positive)] block mt-1 font-medium tabular-nums">
          {totalAllocatedKg > 0 ? toPersianDigits(Math.round((totalReceivedKg / totalAllocatedKg) * 100)) : 0}٪ کل سهمیه
        </span>
      </div>

      <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
        <span className="text-[11px] font-medium text-[var(--fiori-text-secondary)]">
          مجموع مصرف و برش خطوط پرس
        </span>
        <div className="text-lg font-bold text-[var(--fiori-text-primary)] mt-1 font-mono tabular-nums">
          {formatWeightKg(totalConsumedKg)}
        </div>
        <span className="text-[10px] text-[var(--fiori-text-muted)] block mt-1 font-medium tabular-nums">
          {totalReceivedKg > 0 ? toPersianDigits(Math.round((totalConsumedKg / totalReceivedKg) * 100)) : 0}٪ دریافتی
        </span>
      </div>

      <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
        <span className="text-[11px] font-medium text-[var(--fiori-text-secondary)]">
          موجودی کلاف در انبار (مانده پایان دوره)
        </span>
        <div className="text-lg font-bold text-[var(--fiori-brand)] mt-1 font-mono tabular-nums">
          {formatWeightKg(totalClosingBalanceKg)}
        </div>
        <span className="text-[10px] text-[var(--fiori-text-muted)] block mt-1">
          فیزیکی موجود در انبار شماره ۱
        </span>
      </div>
    </div>
  );

  return (
    <FioriDynamicPage
      title="حسابداری سهمیه ورق و کلاف‌های امانی ساپکو (SAPCO Consignment)"
      subtitle="ردیابی مستقل موجودی امانی ساپکو از موجودی ملکی کارخانه بر حسب کیلوگرم، تطبیق بارنامه‌های ورودی و موازنه مصارف خطوط پرس"
      collapsibleFilters={false}
      kpiStrip={kpiStrip}
      headerActions={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>به‌روزرسانی حساب‌ها</span>
          </button>
          <button
            type="button"
            onClick={handleExportCsv}
            className="sap-btn-emphasized flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>گزارش جامع اکسل</span>
          </button>
        </div>
      }
    >
      {/* Contracts Progress Cards */}
      <div className="space-y-3">
        <FioriToolbar
          variant="section"
          title="وضعیت تفکیکی سهمیه قراردادهای فعال ساپکو"
          count={contracts.length}
          countLabel="قرارداد"
          startContent={<Layers className="w-4 h-4 text-[var(--fiori-brand)] shrink-0" />}
        />

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
          {contracts.map(contract => {
            const consumedPercent =
              contract.allocatedWeightKg > 0
                ? Math.min(100, Math.round((contract.totalConsumedKg / contract.allocatedWeightKg) * 100))
                : 0;

            const isSelected = selectedContractId === contract.id;

            return (
              <div
                key={contract.id}
                onClick={() => {
                  setSelectedContractId(isSelected ? 'ALL' : contract.id);
                  setCurrentPage(1);
                }}
                className={`sap-card p-4 transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-[var(--fiori-brand-bg)] border-[var(--fiori-brand)] ring-1 ring-[var(--fiori-brand)]'
                    : 'hover:border-[var(--fiori-brand)]'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation();
                        traceDocument(contract.contractNumber, 'CONTRACTS');
                      }}
                      className="sap-doc-link text-xs fiori-ltr-code cursor-pointer"
                    >
                      {contract.contractNumber}
                    </button>
                    <h4 className="text-xs font-semibold text-[var(--fiori-text-primary)] mt-0.5">
                      {contract.title}
                    </h4>
                  </div>
                  <FioriObjectStatus tone="neutral" label={`گرید ${contract.materialGrade || '—'}`} />
                </div>

                {/* Progress Bar */}
                <div className="mt-3.5 space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-[var(--fiori-text-secondary)]">درصد مصرف سهمیه:</span>
                    <span className="font-mono font-bold text-[var(--fiori-brand)] tabular-nums">
                      {toPersianDigits(consumedPercent)}٪
                    </span>
                  </div>
                  <div className="h-1.5 w-full bg-[var(--fiori-border-subtle)] rounded-[var(--fiori-radius-sm)] overflow-hidden">
                    <div
                      className="h-full bg-[var(--fiori-brand)] transition-all duration-500 rounded-[var(--fiori-radius-sm)]"
                      style={{ width: `${consumedPercent}%` }}
                    />
                  </div>
                </div>

                {/* Breakdown details */}
                <div className="mt-3 pt-2.5 border-t border-[var(--fiori-border-subtle)] grid grid-cols-2 gap-2 text-[11px] tabular-nums">
                  <div>
                    <span className="text-[var(--fiori-text-secondary)] block">سهمیه کل:</span>
                    <span className="font-mono font-semibold text-[var(--fiori-text-primary)]">
                      {formatWeightKg(contract.allocatedWeightKg)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--fiori-text-secondary)] block">دریافتی کارخانه:</span>
                    <span className="font-mono font-semibold text-[var(--fiori-text-primary)]">
                      {formatWeightKg(contract.totalReceivedKg)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--fiori-text-secondary)] block">مصرف شده:</span>
                    <span className="font-mono font-semibold text-[var(--fiori-text-primary)]">
                      {formatWeightKg(contract.totalConsumedKg)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--fiori-text-secondary)] block">مانده در انبار:</span>
                    <span className="font-mono font-bold text-[var(--fiori-brand)]">
                      {formatWeightKg(contract.closingBalanceKg)}
                    </span>
                  </div>
                </div>

                <div className="mt-2 text-[10px] text-[var(--fiori-text-secondary)] flex flex-wrap items-center gap-1">
                  <span>قطعات مجاز:</span>
                  {contract.associatedPartCodes.map(pc => (
                    <button
                      key={pc}
                      type="button"
                      onClick={e => {
                        e.stopPropagation();
                        traceDocument(pc, 'INVENTORY_LEDGER');
                      }}
                      className="sap-doc-link text-[10px] fiori-ltr-code cursor-pointer"
                    >
                      {pc}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Movement Ledger Section */}
      <div className="space-y-3">
        {/* Ledger Filter Bar */}
        <div className="sap-card p-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5 flex-1">
            <div className="relative min-w-[240px] flex-1">
              <Search className="w-4 h-4 text-[var(--fiori-text-secondary)] absolute right-3 top-2" />
              <input
                type="text"
                value={searchTerm}
                onChange={e => {
                  setSearchTerm(e.target.value);
                  setCurrentPage(1);
                }}
                placeholder="جستجوی بارنامه ساپکو، شماره سند، لوت یا شماره ذوب..."
                className="w-full bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] pr-9 pl-3 py-1.5 text-xs text-[var(--fiori-text-primary)] placeholder-[var(--fiori-text-muted)] focus:outline-none focus:border-[var(--fiori-brand)] transition-colors"
              />
            </div>

            <select
              value={selectedContractId}
              onChange={e => {
                setSelectedContractId(e.target.value);
                setCurrentPage(1);
              }}
              className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-3 py-1.5 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)] transition-colors"
            >
              <option value="ALL">همه قراردادهای ساپکو</option>
              {contracts.map(c => (
                <option key={c.id} value={c.id}>
                  {c.contractNumber} - {c.title}
                </option>
              ))}
            </select>

            <select
              value={selectedOperationFilter}
              onChange={e => {
                setSelectedOperationFilter(e.target.value);
                setCurrentPage(1);
              }}
              className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-3 py-1.5 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)] transition-colors"
            >
              <option value="ALL">همه انواع تراکنش‌ها</option>
              <option value="OPENING">موجودی اول دوره</option>
              <option value="RECEIPT">ورود رول ساپکو</option>
              <option value="CONSUMPTION">مصرف در خط پرس</option>
              <option value="RETURN">برگشت به ساپکو</option>
              <option value="ADJUSTMENT">تعدیلات</option>
            </select>
          </div>

          <div className="text-xs text-[var(--fiori-text-secondary)] tabular-nums">
            ردیف‌های گردش:{' '}
            <span className="font-bold text-[var(--fiori-text-primary)] font-mono">
              {toPersianDigits(filteredLedger.length)}
            </span>
          </div>
        </div>

        {/* Ledger FioriDataTable */}
        <FioriDataTable<SapcoContractLedgerEntry>
          data={pagedLedger}
          columns={ledgerColumns}
          rowKey={(row, idx) => row.id || `${row.documentNumber}-${idx}`}
          loading={loading && ledger.length === 0}
          compact
          toolbar={
            <FioriToolbar
              variant="table"
              title="دفتر کاردکس گردش حساب امانی ساپکو"
              count={filteredLedger.length}
              countLabel="تراکنش"
            />
          }
          emptyState={
            <EmptyState
              variant={hasFilters ? 'FILTER_NO_MATCH' : 'NO_DATA'}
              compact
              title="هیچ رکوردی در کاردکس سهمیه ساپکو یافت نشد"
              description={
                hasFilters
                  ? 'فیلترهای قرارداد، نوع تراکنش یا جستجو را پاک کنید.'
                  : 'هنوز هیچ گردش کاردکس امانی ساپکو ثبت نشده است.'
              }
              actionLabel={hasFilters ? 'پاک‌کردن فیلترها' : undefined}
              onAction={hasFilters ? resetFilters : undefined}
            />
          }
          pagination={{
            currentPage,
            pageSize,
            totalItems: filteredLedger.length,
            onPageChange: setCurrentPage,
          }}
        />
      </div>
    </FioriDynamicPage>
  );
};

