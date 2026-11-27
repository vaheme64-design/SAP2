import React from 'react';
import {
  Boxes,
  Clock,
  AlertTriangle,
  Layers,
  ArrowRightLeft,
  CheckCircle2,
  FilePlus,
  Play,
  RefreshCw,
  Cpu,
  ShieldCheck,
  ChevronRight,
} from 'lucide-react';
import {
  WipDashboardMetrics,
  ManufacturingOrder,
} from '../../types/productionWip';
import {
  formatNumber,
  toPersianDigits,
} from '../../utils/formatters';
import { KpiCardsSkeleton, ChartSkeleton } from '../ui/Skeleton';
import { useErpRouter } from '../../context/RouterContext';
import {
  FioriDynamicPage,
  FioriObjectStatus,
  FioriToolbar,
} from '../fiori/ui';
import { EmptyState } from '../common/EmptyState';

interface WipDashboardViewProps {
  metrics: WipDashboardMetrics | null;
  orders: ManufacturingOrder[];
  loading: boolean;
  onRefresh: () => Promise<void>;
  onOpenCreateMo: () => void;
  onOpenTransfer: () => void;
  onSelectMo: (mo: ManufacturingOrder) => void;
  onNavigateToOrders: () => void;
  onNavigateToTransfers: () => void;
}

export const WipDashboardView: React.FC<WipDashboardViewProps> = ({
  metrics,
  orders,
  loading,
  onRefresh,
  onOpenCreateMo,
  onOpenTransfer,
  onSelectMo,
  onNavigateToOrders,
}) => {
  const { traceDocument } = useErpRouter();

  if (loading && !metrics) {
    return (
      <div className="space-y-6">
        <KpiCardsSkeleton count={6} columns={6} theme="light" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <ChartSkeleton rows={4} theme="light" />
          <ChartSkeleton rows={4} theme="light" />
        </div>
      </div>
    );
  }

  return (
    <FioriDynamicPage
      title="داشبورد کار در جریان ساخت و کنترل گلوگاه‌های خطوط"
      subtitle="رهگیری لحظه‌ای صف‌های ورودی، اقلام پای دستگاه، تولید آماده انتقال و تحلیل زمان توقف و قدمت (Aging)"
      status={
        metrics?.overallConservationIntegrity ? (
          <FioriObjectStatus
            tone="positive"
            label="پایستگی قطعات تایید شده"
            size="sm"
            icon={<ShieldCheck className="w-3 h-3" />}
          />
        ) : undefined
      }
      headerActions={
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${
                loading ? 'animate-spin text-[var(--fiori-text-secondary)]' : 'text-[var(--fiori-brand)]'
              }`}
            />
            <span>به‌روزرسانی</span>
          </button>
          <button
            type="button"
            onClick={onOpenTransfer}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <ArrowRightLeft className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
            <span>انتقال بین‌مراحل</span>
          </button>
          <button
            type="button"
            onClick={onOpenCreateMo}
            className="sap-btn-emphasized flex items-center gap-1.5 px-3.5 py-1.5 text-xs cursor-pointer"
          >
            <FilePlus className="w-3.5 h-3.5" />
            <span>دستور کار جدید (MO)</span>
          </button>
        </div>
      }
      kpiStrip={
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
            <div className="flex items-center justify-between text-[var(--fiori-text-secondary)] text-[11px] font-medium">
              <span>در انتظار صف ورودی</span>
              <Clock className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
            </div>
            <div className="text-lg font-bold text-[var(--fiori-text-primary)] font-mono tabular-nums mt-1">
              {formatNumber(metrics?.totalWaitingQty || 0)}
            </div>
            <span className="text-[10px] text-[var(--fiori-text-secondary)] block mt-0.5">آماده شروع در ماشین</span>
          </div>

          <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
            <div className="flex items-center justify-between text-[var(--fiori-text-secondary)] text-[11px] font-medium">
              <span>در حال ساخت پای دستگاه</span>
              <Play className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
            </div>
            <div className="text-lg font-bold text-[var(--fiori-text-primary)] font-mono tabular-nums mt-1">
              {formatNumber(metrics?.totalInProgressQty || 0)}
            </div>
            <span className="text-[10px] text-[var(--fiori-text-secondary)] block mt-0.5">در حال پرس/خم/جوش</span>
          </div>

          <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
            <div className="flex items-center justify-between text-[var(--fiori-text-secondary)] text-[11px] font-medium">
              <span>آماده انتقال به مرحله بعد</span>
              <CheckCircle2 className="w-3.5 h-3.5 text-[var(--fiori-positive)]" />
            </div>
            <div className="text-lg font-bold text-[var(--fiori-positive)] font-mono tabular-nums mt-1">
              {formatNumber(metrics?.totalReadyForTransferQty || 0)}
            </div>
            <span className="text-[10px] text-[var(--fiori-text-secondary)] block mt-0.5">نیازمند صدور حواله</span>
          </div>

          <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
            <div className="flex items-center justify-between text-[var(--fiori-text-secondary)] text-[11px] font-medium">
              <span>در حال انتقال (In-Transit)</span>
              <ArrowRightLeft className="w-3.5 h-3.5 text-[var(--fiori-warning)]" />
            </div>
            <div className="text-lg font-bold text-[var(--fiori-text-primary)] font-mono tabular-nums mt-1">
              {formatNumber(metrics?.totalInTransitQty || 0)}
            </div>
            <span className="text-[10px] text-[var(--fiori-text-secondary)] block mt-0.5">
              {toPersianDigits(metrics?.pendingTransfersCount || 0)} حواله در انتظار تأیید
            </span>
          </div>

          <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
            <div className="flex items-center justify-between text-[var(--fiori-text-secondary)] text-[11px] font-medium">
              <span>تکمیل‌شده نهایی</span>
              <Layers className="w-3.5 h-3.5 text-[var(--fiori-positive)]" />
            </div>
            <div className="text-lg font-bold text-[var(--fiori-positive)] font-mono tabular-nums mt-1">
              {formatNumber(metrics?.totalCompletedQty || 0)}
            </div>
            <span className="text-[10px] text-[var(--fiori-text-secondary)] block mt-0.5">تحویل انبار نهایی</span>
          </div>

          <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
            <div className="flex items-center justify-between text-[var(--fiori-text-secondary)] text-[11px] font-medium">
              <span>ضایعات و دوباره‌کاری</span>
              <AlertTriangle className="w-3.5 h-3.5 text-[var(--fiori-negative)]" />
            </div>
            <div className="text-lg font-bold text-[var(--fiori-negative)] font-mono tabular-nums mt-1">
              {formatNumber((metrics?.totalScrapQty || 0) + (metrics?.totalReworkQty || 0))}
            </div>
            <span className="text-[10px] text-[var(--fiori-text-secondary)] block mt-0.5">
              {toPersianDigits(metrics?.totalScrapQty || 0)} ضایعات | {toPersianDigits(metrics?.totalReworkQty || 0)} دوباره‌کاری
            </span>
          </div>
        </div>
      }
    >
      {/* Two Column Layout: Bottlenecks & Active MOs Progression */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Bottlenecks and Queue Depth */}
        <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)] overflow-hidden">
          <FioriToolbar
            variant="section"
            title="تحلیل تراکم و صف ایستگاه‌ها (Bottleneck & Aging)"
            subtitle="مرتب‌سازی بر اساس عمق صف"
            startContent={<Cpu className="w-4 h-4 text-[var(--fiori-brand)]" />}
            count={metrics?.bottleneckOperations?.length || 0}
            countLabel="ایستگاه"
          />

          <div className="p-4 space-y-2.5">
            {(!metrics?.bottleneckOperations || metrics.bottleneckOperations.length === 0) ? (
              <EmptyState title="اطلاعات گلوگاهی در دسترس نیست" description="در حال حاضر صف متراکمی در ایستگاه‌ها ثبت نشده است." />
            ) : (
              metrics.bottleneckOperations.slice(0, 5).map((op, idx) => {
                const isHighAging = op.agingHoursAvg > 12;

                return (
                  <div
                    key={idx}
                    className="p-3 bg-[var(--fiori-bg-subtle)] rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] flex items-center justify-between gap-3"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="fiori-ltr-code font-mono text-xs font-bold text-[var(--fiori-brand)]">{op.stepCode}</span>
                        <span className="text-xs font-semibold text-[var(--fiori-text-primary)]">{op.operationName}</span>
                      </div>
                      <div className="text-[11px] text-[var(--fiori-text-secondary)] mt-1 flex items-center gap-3 tabular-nums">
                        <span>صف انتظار: <strong className="text-[var(--fiori-text-primary)] font-mono">{formatNumber(op.waitingQty)}</strong></span>
                        <span>پای‌کار: <strong className="text-[var(--fiori-text-primary)] font-mono">{formatNumber(op.inProgressQty)}</strong></span>
                        <span>آماده انتقال: <strong className="text-[var(--fiori-positive)] font-mono">{formatNumber(op.readyQty)}</strong></span>
                      </div>
                    </div>

                    <div className="text-left shrink-0">
                      <FioriObjectStatus
                        tone={isHighAging ? 'negative' : 'neutral'}
                        label={`${toPersianDigits(op.agingHoursAvg)} ساعت توقف`}
                        size="sm"
                      />
                      <span className="text-[10px] text-[var(--fiori-text-secondary)] block mt-0.5">میانگین قدمت WIP</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Active Manufacturing Orders Quick Overview */}
        <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)] overflow-hidden">
          <FioriToolbar
            variant="section"
            title="دستورهای کار جاری و پیشرفت فرآیندها"
            startContent={<Layers className="w-4 h-4 text-[var(--fiori-brand)]" />}
            count={orders.length}
            countLabel="MO"
            endContent={
              <button
                type="button"
                onClick={onNavigateToOrders}
                className="sap-doc-link text-xs flex items-center gap-1 cursor-pointer"
              >
                <span>مشاهده همه دستورها</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            }
          />

          <div className="p-4 space-y-2.5">
            {orders.length === 0 ? (
              <EmptyState title="دستور کار فعالی وجود ندارد" description="برای شروع فرآیند ساخت، یک دستور کار جدید ایجاد کنید." />
            ) : (
              orders.slice(0, 4).map(mo => {
                const completedOps = mo.operations.filter(o => o.status === 'COMPLETED').length;
                const progressPercent = mo.operations.length > 0 ? Math.round((completedOps / mo.operations.length) * 100) : 0;

                return (
                  <div
                    key={mo.id}
                    onClick={() => onSelectMo(mo)}
                    className="p-3 bg-[var(--fiori-bg-subtle)] hover:bg-[var(--fiori-brand-subtle)]/50 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] transition-colors cursor-pointer space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={e => {
                              e.stopPropagation();
                              traceDocument(mo.moNumber, 'WIP_TRACEABILITY');
                            }}
                            className="sap-doc-link fiori-ltr-code font-mono text-xs cursor-pointer"
                            title="ردیابی دستور ساخت"
                          >
                            {mo.moNumber}
                          </button>
                          <span className="text-xs font-semibold text-[var(--fiori-text-primary)]">{mo.partName}</span>
                        </div>
                        <div className="text-[11px] text-[var(--fiori-text-secondary)] mt-0.5 flex items-center gap-1.5 flex-wrap tabular-nums">
                          <span>کد:</span>
                          <button
                            type="button"
                            onClick={e => {
                              e.stopPropagation();
                              traceDocument(mo.partCode, 'INVENTORY_LEDGER');
                            }}
                            className="sap-doc-link fiori-ltr-code font-mono cursor-pointer"
                            title="کاردکس و موجودی قطعه"
                          >
                            {mo.partCode}
                          </button>
                          <span>| هدف: <strong className="text-[var(--fiori-text-primary)] font-mono">{formatNumber(mo.targetQuantity)} PCS</strong></span>
                        </div>
                      </div>
                      <FioriObjectStatus tone="info" label={`نسخه ${mo.routingVersion}`} size="sm" />
                    </div>

                    {/* Progress bar */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[10px] text-[var(--fiori-text-secondary)]">
                        <span>پیشرفت مراحل فرآیند ({toPersianDigits(completedOps)} از {toPersianDigits(mo.operations.length)} مرحله):</span>
                        <span className="font-mono font-bold text-[var(--fiori-brand)] tabular-nums">{toPersianDigits(progressPercent)}٪</span>
                      </div>
                      <div className="h-1.5 w-full bg-[var(--fiori-border-subtle)] rounded-[var(--fiori-radius-sm)] overflow-hidden">
                        <div
                          className="h-full bg-[var(--fiori-brand)] rounded-[var(--fiori-radius-sm)] transition-all duration-500"
                          style={{ width: `${progressPercent}%` }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </FioriDynamicPage>
  );
};

