import React from 'react';
import {
  Scale,
  ShieldCheck,
  ArrowRightLeft,
  ArrowUpRight,
  ArrowDownLeft,
  FileEdit,
  AlertTriangle,
  ScrollText,
  Warehouse,
  CheckCircle2,
  RefreshCw,
  ExternalLink,
  Truck,
} from 'lucide-react';
import {
  InventoryDashboardMetrics,
  DetailedStockBalance,
  SapcoContract,
  WarehouseDefinition,
} from '../../types/inventory';
import { formatNumber, formatWeightKg, toPersianDigits } from '../../utils/formatters';
import { KpiCardsSkeleton, TableSkeleton } from '../ui/Skeleton';
import {
  FioriDynamicPage,
  FioriObjectStatus,
  FioriMessageStrip,
} from '../fiori/ui';

interface InventoryDashboardProps {
  metrics: InventoryDashboardMetrics | null;
  contracts: SapcoContract[];
  warehouses: WarehouseDefinition[];
  balances: DetailedStockBalance[];
  loading: boolean;
  onRefresh: () => Promise<void>;
  onOpenReceipt: () => void;
  onOpenIssue: () => void;
  onOpenCustomerDelivery?: () => void;
  onOpenTransfer: () => void;
  onOpenAdjustment: () => void;
  onNavigateToInquiry: () => void;
  onNavigateToSapco: () => void;
  onNavigateToLedger: () => void;
}

export const InventoryDashboard: React.FC<InventoryDashboardProps> = ({
  metrics,
  contracts,
  warehouses,
  balances,
  loading,
  onRefresh,
  onOpenReceipt,
  onOpenIssue,
  onOpenCustomerDelivery,
  onOpenTransfer,
  onOpenAdjustment,
  onNavigateToInquiry,
  onNavigateToSapco,
  onNavigateToLedger,
}) => {
  if (loading && !metrics && balances.length === 0) {
    return (
      <div className="space-y-6">
        <KpiCardsSkeleton count={4} columns={4} theme="light" />
        <TableSkeleton rows={6} columns={6} theme="light" />
      </div>
    );
  }

  const kpiStrip = (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {/* Physical Stock Card */}
      <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
        <div className="flex items-center justify-between text-xs text-[var(--fiori-text-secondary)]">
          <span className="font-medium">موجودی فیزیکی کل کارخانه</span>
          <span className="p-1.5 bg-[var(--fiori-info-bg)] text-[var(--fiori-brand)] rounded-[var(--fiori-radius-sm)]">
            <Scale className="w-4 h-4" />
          </span>
        </div>
        <div className="mt-2 text-xl font-semibold text-[var(--fiori-text-primary)] font-mono tabular-nums">
          {formatWeightKg(metrics?.totalPhysicalKg || 0)}
        </div>
        <div className="mt-2.5 text-[11px] text-[var(--fiori-text-secondary)] flex items-center justify-between pt-2 border-t border-[var(--fiori-border-subtle)]">
          <span>قطعات و مجموعه‌ها:</span>
          <span className="font-mono text-[var(--fiori-text-primary)] font-semibold tabular-nums">
            {formatNumber(metrics?.totalPhysicalPcs || 0)} عدد
          </span>
        </div>
      </div>

      {/* Available Stock Card */}
      <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
        <div className="flex items-center justify-between text-xs text-[var(--fiori-text-secondary)]">
          <span className="font-medium">موجودی آزاد و قابل تخصیص (ATP)</span>
          <span className="p-1.5 bg-[var(--fiori-positive-bg)] text-[var(--fiori-positive)] rounded-[var(--fiori-radius-sm)]">
            <CheckCircle2 className="w-4 h-4" />
          </span>
        </div>
        <div className="mt-2 text-xl font-semibold text-[var(--fiori-positive)] font-mono tabular-nums">
          {formatWeightKg(metrics?.totalAvailableKg || 0)}
        </div>
        <div className="mt-2.5 text-[11px] text-[var(--fiori-text-secondary)] flex items-center justify-between pt-2 border-t border-[var(--fiori-border-subtle)]">
          <span>آزاد جهت تولید:</span>
          <span className="font-mono text-[var(--fiori-positive)] font-semibold tabular-nums">
            {formatNumber(metrics?.totalAvailablePcs || 0)} عدد
          </span>
        </div>
      </div>

      {/* SAPCO Consignment Stock Card */}
      <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
        <div className="flex items-center justify-between text-xs text-[var(--fiori-text-secondary)]">
          <span className="font-medium">ورق امانی ساپکو (تامین‌کننده)</span>
          <span className="p-1.5 bg-[var(--fiori-critical-bg)] text-[var(--fiori-critical)] rounded-[var(--fiori-radius-sm)]">
            <ScrollText className="w-4 h-4" />
          </span>
        </div>
        <div className="mt-2 text-xl font-semibold text-[var(--fiori-critical)] font-mono tabular-nums">
          {formatWeightKg(metrics?.totalSapcoConsignmentKg || 0)}
        </div>
        <div className="mt-2.5 text-[11px] text-[var(--fiori-text-secondary)] flex items-center justify-between pt-2 border-t border-[var(--fiori-border-subtle)]">
          <span>مالکیت شرکتی کارخانه:</span>
          <span className="font-mono text-[var(--fiori-text-primary)] font-medium tabular-nums">
            {formatWeightKg(metrics?.totalCompanyOwnedKg || 0)}
          </span>
        </div>
      </div>

      {/* Reserved & Blocked Stock Card */}
      <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
        <div className="flex items-center justify-between text-xs text-[var(--fiori-text-secondary)]">
          <span className="font-medium">رزرو شده / قرنطینه کیفی</span>
          <span className="p-1.5 bg-[var(--fiori-negative-bg)] text-[var(--fiori-negative)] rounded-[var(--fiori-radius-sm)]">
            <AlertTriangle className="w-4 h-4" />
          </span>
        </div>
        <div className="mt-2 text-xl font-semibold text-[var(--fiori-text-primary)] font-mono tabular-nums">
          {formatWeightKg(metrics?.totalReservedKg || 0)}
        </div>
        <div className="mt-2.5 text-[11px] text-[var(--fiori-text-secondary)] flex items-center justify-between pt-2 border-t border-[var(--fiori-border-subtle)]">
          <span>بلوکه کیفی / قرنطینه:</span>
          <span className="font-mono text-[var(--fiori-negative)] font-semibold tabular-nums">
            {formatWeightKg(metrics?.totalQualityBlockedKg || 0)}
          </span>
        </div>
      </div>
    </div>
  );

  return (
    <FioriDynamicPage
      title="سامانه مدیریت و کاردکس انبار قطعات و ورق (SAP MM / WM)"
      subtitle="محاسبه بر مبنای اسناد قطعی‌شده، کنترل عدم منفی‌شدن موجودی، تفکیک مالکیت امانی ساپکو و رهگیری کلاف‌ها"
      collapsibleFilters={false}
      kpiStrip={kpiStrip}
      headerActions={
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>به‌روزرسانی</span>
          </button>
          <button
            type="button"
            onClick={onOpenReceipt}
            className="sap-btn-emphasized flex items-center gap-1.5 px-3.5 py-1.5 text-xs cursor-pointer"
          >
            <ArrowDownLeft className="w-4 h-4" />
            <span>رسید کالا / ورق (MIGO)</span>
          </button>
          <button
            type="button"
            onClick={onOpenIssue}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <ArrowUpRight className="w-4 h-4" />
            <span>حواله مصرف به خط</span>
          </button>
          {onOpenCustomerDelivery && (
            <button
              type="button"
              onClick={onOpenCustomerDelivery}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--fiori-positive)] hover:opacity-95 text-white rounded-[var(--fiori-radius-sm)] text-xs font-medium transition-all cursor-pointer"
            >
              <Truck className="w-4 h-4" />
              <span>تحویل محصول به مشتری</span>
            </button>
          )}
          <button
            type="button"
            onClick={onOpenTransfer}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <ArrowRightLeft className="w-4 h-4" />
            <span>انتقال بین انبارها</span>
          </button>
          <button
            type="button"
            onClick={onOpenAdjustment}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <FileEdit className="w-4 h-4" />
            <span>تعدیل انبارگردانی</span>
          </button>
        </div>
      }
    >
      {/* Warehouse Status Grid & Contracts Glance */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Warehouses Summary (2 cols) */}
        <div className="lg:col-span-2 sap-card p-4 sm:p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-[var(--fiori-border-subtle)] pb-3">
            <h3 className="text-sm font-semibold text-[var(--fiori-text-primary)] flex items-center gap-2">
              <Warehouse className="w-4 h-4 text-[var(--fiori-brand)]" />
              وضعیت انبارهای کارخانه و توزیع فیزیکی موجودی
            </h3>
            <button
              type="button"
              onClick={onNavigateToInquiry}
              className="text-xs text-[var(--fiori-brand)] hover:underline font-medium flex items-center gap-1 cursor-pointer"
            >
              <span>مشاهده کاردکس تفصیلی</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {warehouses.map(wh => {
              const whBalances = balances.filter(b => b.warehouseId === wh.id);
              const totalKg = whBalances.reduce((sum, b) => sum + b.physicalKg, 0);
              const totalPcs = whBalances.reduce((sum, b) => (b.unit === 'PCS' ? sum + b.physicalQty : sum), 0);
              const lotsCount = new Set(whBalances.map(b => b.lotNumber).filter(Boolean)).size;

              return (
                <div
                  key={wh.id}
                  className="bg-[var(--fiori-bg-subtle)] p-4 rounded-[var(--fiori-radius-md)] border border-[var(--fiori-border-default)] hover:border-[var(--fiori-brand)] transition-all flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-[var(--fiori-text-primary)]">{wh.name}</span>
                      <FioriObjectStatus tone="info" label={wh.code} ltrCode />
                    </div>
                    <div className="mt-3 flex items-baseline gap-2">
                      <span className="text-base font-semibold text-[var(--fiori-text-primary)] font-mono tabular-nums">
                        {formatWeightKg(totalKg)}
                      </span>
                      {totalPcs > 0 && (
                        <span className="text-xs text-[var(--fiori-text-secondary)] font-mono tabular-nums">
                          ({formatNumber(totalPcs)} عدد)
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 pt-3 border-t border-[var(--fiori-border-default)] text-[11px] text-[var(--fiori-text-secondary)] flex items-center justify-between">
                    <span>سرپرست: {wh.managerName || '—'}</span>
                    <span className="tabular-nums">
                      {lotsCount > 0 ? `${toPersianDigits(lotsCount)} رول/بچ فعال` : `${toPersianDigits(wh.locations.length)} موقعیت`}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* SAPCO Active Contracts Glance (1 col) */}
        <div className="sap-card p-4 sm:p-5 space-y-4 flex flex-col justify-between">
          <div className="space-y-3.5">
            <div className="flex items-center justify-between border-b border-[var(--fiori-border-subtle)] pb-3">
              <h3 className="text-sm font-semibold text-[var(--fiori-text-primary)] flex items-center gap-2">
                <ScrollText className="w-4 h-4 text-[var(--fiori-brand)]" />
                سهمیه‌های فعال ورق ساپکو
              </h3>
              <button
                type="button"
                onClick={onNavigateToSapco}
                className="text-xs text-[var(--fiori-brand)] hover:underline font-medium cursor-pointer"
              >
                دفتر سهمیه‌ها
              </button>
            </div>

            <div className="space-y-3">
              {contracts.slice(0, 3).map(c => {
                const consumedPercent = c.allocatedWeightKg > 0
                  ? Math.round((c.totalConsumedKg / c.allocatedWeightKg) * 100)
                  : 0;

                return (
                  <div
                    key={c.id}
                    className="bg-[var(--fiori-bg-subtle)] p-3.5 rounded-[var(--fiori-radius-md)] border border-[var(--fiori-border-default)]"
                  >
                    <div className="flex items-center justify-between text-xs gap-2">
                      <span className="font-semibold text-[var(--fiori-text-primary)] font-mono tabular-nums">
                        {c.contractNumber}
                      </span>
                      <FioriObjectStatus tone="info" label={c.materialGrade || '—'} ltrCode />
                    </div>
                    <div className="text-[11px] text-[var(--fiori-text-secondary)] truncate mt-1">{c.title}</div>

                    {/* Progress Bar */}
                    <div className="mt-2.5">
                      <div className="flex items-center justify-between text-[10px] text-[var(--fiori-text-secondary)] mb-1 tabular-nums">
                        <span>مانده: {formatWeightKg(c.closingBalanceKg)}</span>
                        <span>{toPersianDigits(consumedPercent)}٪ مصرف</span>
                      </div>
                      <div className="w-full bg-[var(--fiori-border-default)] h-1.5 rounded-[var(--fiori-radius-sm)] overflow-hidden">
                        <div
                          className={`h-full rounded-[var(--fiori-radius-sm)] ${
                            consumedPercent > 80 ? 'bg-[var(--fiori-negative)]' : 'bg-[var(--fiori-brand)]'
                          }`}
                          style={{ width: `${Math.min(100, consumedPercent)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="pt-3 border-t border-[var(--fiori-border-subtle)]">
            <button
              type="button"
              onClick={onNavigateToSapco}
              className="sap-btn-standard w-full py-2 text-xs flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <span>مشاهده صورتحساب کامل ساپکو</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Critical Business Rules Reminder Strip */}
      <FioriMessageStrip
        tone="info"
        icon={<ShieldCheck className="w-4 h-4 shrink-0 text-[var(--fiori-positive)]" />}
        actions={
          <button
            type="button"
            onClick={onNavigateToLedger}
            className="text-xs text-[var(--fiori-brand)] hover:underline font-semibold cursor-pointer whitespace-nowrap"
          >
            دفتر روزنامه تراکنش‌ها
          </button>
        }
      >
        <strong className="text-[var(--fiori-text-primary)]">اصول کنترل کیفیت و انبارداری KPIMS:</strong>{' '}
        عدم ثبت موجودی منفی، ثبت اتمیک تراکنش‌ها در سرور، تفکیک رول‌های امانی ساپکو و ثبت اصلاحات با صدور سند معکوس جبرانی.
      </FioriMessageStrip>
    </FioriDynamicPage>
  );
};

