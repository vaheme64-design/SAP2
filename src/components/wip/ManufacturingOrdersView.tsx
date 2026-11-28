import React, { useState } from 'react';
import {
  Layers,
  Plus,
  Play,
  CheckCircle2,
  ArrowRightLeft,
  Scale,
  ChevronDown,
  ChevronUp,
  Trash2,
  MapPin,
  Cpu,
} from 'lucide-react';
import {
  ManufacturingOrder,
  ManufacturingOperation,
} from '../../types/productionWip';
import { formatNumber, toPersianDigits } from '../../utils/formatters';
import { TableSkeleton } from '../ui/Skeleton';
import { useErpRouter } from '../../context/RouterContext';
import { usePersistedExpandMap } from '../../hooks/usePersistedCollapse';
import {
  FioriDynamicPage,
  FioriFilterBar,
  FioriObjectStatus,
  FioriToolbar,
} from '../fiori/ui';
import { EmptyState } from '../common/EmptyState';

interface ManufacturingOrdersViewProps {
  orders: ManufacturingOrder[];
  loading: boolean;
  onRefresh: () => Promise<void>;
  onOpenCreateMo: () => void;
  onOpenInput: (operation: ManufacturingOperation) => void;
  onOpenProduction: (operation: ManufacturingOperation) => void;
  onOpenTransfer: (mo: ManufacturingOrder, operation: ManufacturingOperation) => void;
  onOpenReconciliation: (moId: string) => void;
  onRequestDeleteRollback?: (mo: ManufacturingOrder) => void;
  embeddedInParent?: boolean;
}

export const ManufacturingOrdersView: React.FC<ManufacturingOrdersViewProps> = ({
  orders,
  loading,
  onOpenCreateMo,
  onOpenInput,
  onOpenProduction,
  onOpenTransfer,
  onOpenReconciliation,
  onRequestDeleteRollback,
  embeddedInParent = false,
}) => {
  const { traceDocument } = useErpRouter();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const {
    isExpanded: isMoExpanded,
    toggle: toggleMoExpanded,
    expandAll: expandAllMos,
    collapseAll: collapseAllMos,
    expandedCount: expandedMosCount,
  } = usePersistedExpandMap('wip_orders_expanded', {});

  if (loading && orders.length === 0) {
    return <TableSkeleton rows={6} columns={6} theme="light" />;
  }

  const filteredOrders = orders.filter(mo => {
    if (statusFilter !== 'ALL' && mo.status !== statusFilter) return false;
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      const matchesMo = mo.moNumber.toLowerCase().includes(q);
      const matchesPartName = mo.partName.toLowerCase().includes(q);
      const matchesPartCode = mo.partCode.toLowerCase().includes(q);
      const matchesNotes = mo.notes ? mo.notes.toLowerCase().includes(q) : false;
      if (!matchesMo && !matchesPartName && !matchesPartCode && !matchesNotes) {
        return false;
      }
    }
    return true;
  });

  const statusMeta: Record<string, { label: string; tone: 'positive' | 'critical' | 'negative' | 'info' | 'brand' | 'neutral' }> = {
    PLANNED: { label: 'برنامه‌ریزی‌شده', tone: 'neutral' },
    RELEASED: { label: 'صادرشده به سالن', tone: 'info' },
    IN_PROGRESS: { label: 'در جریان ساخت', tone: 'critical' },
    COMPLETED: { label: 'تکمیل‌شده', tone: 'positive' },
    CANCELLED: { label: 'لغوشده', tone: 'negative' },
  };

  const ordersListContent = (
    <div className="space-y-3">
      {filteredOrders.length > 0 && (
        <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] overflow-hidden">
          <FioriToolbar
            variant="table"
            title="فهرست دستورات ساخت و مراحل عملیات"
            count={filteredOrders.length}
            countLabel="دستور کار"
            subtitle={`باز: ${toPersianDigits(expandedMosCount(filteredOrders.map(o => o.id)))}`}
            endContent={
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => expandAllMos(filteredOrders.map(o => o.id))}
                  className="sap-btn-standard px-2.5 py-1 text-[11px] whitespace-nowrap"
                >
                  باز کردن همه
                </button>
                <button
                  type="button"
                  onClick={collapseAllMos}
                  className="sap-btn-standard px-2.5 py-1 text-[11px] whitespace-nowrap"
                >
                  بستن همه
                </button>
              </div>
            }
          />
        </div>
      )}

      {filteredOrders.length === 0 ? (
        <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-6">
          <EmptyState
            title="دستور کاری با فیلترهای انتخابی یافت نشد"
            description="فیلتر وضعیت یا عبارت جستجو را تغییر دهید."
          />
        </div>
      ) : (
        filteredOrders.map(mo => {
          const isExpanded = isMoExpanded(mo.id);
          const completedOpsCount = mo.operations.filter(o => o.status === 'COMPLETED').length;
          const activeOp =
            mo.operations.find(o => o.inProgressQty > 0) ||
            mo.operations.find(o => o.readyForTransferQty > 0) ||
            mo.operations.find(o => o.waitingInputQty > 0) ||
            mo.operations.find(o => o.status !== 'COMPLETED');
          const totalWaiting = mo.operations.reduce((s, o) => s + (o.waitingInputQty || 0), 0);
          const totalInProgress = mo.operations.reduce((s, o) => s + (o.inProgressQty || 0), 0);
          const totalReady = mo.operations.reduce((s, o) => s + (o.readyForTransferQty || 0), 0);
          const statusInfo = statusMeta[mo.status] || { label: mo.status, tone: 'neutral' as const };

          const finalPct =
            mo.targetQuantity > 0
              ? Math.min(100, Math.round(((mo.completedQuantity || 0) / mo.targetQuantity) * 100))
              : 0;
          const opPct =
            mo.operations.length > 0 && mo.targetQuantity > 0
              ? Math.min(
                  100,
                  Math.round(
                    (mo.operations.reduce(
                      (s, o) => s + Math.min(1, (o.goodOutputQty || 0) / mo.targetQuantity),
                      0
                    ) /
                      mo.operations.length) *
                      100
                  )
                )
              : finalPct;
          const progressPct = Math.max(finalPct, opPct);

          // Determine single clearest next action for this MO header
          const shortOpCode = activeOp ? activeOp.stepCode.split('_')[0] : '';
          const nextActionBtn = activeOp ? (
            activeOp.inProgressQty > 0 ? (
              <button
                type="button"
                onClick={() => onOpenProduction(activeOp)}
                className="fiori-btn-positive inline-flex items-center gap-1 px-2.5 py-1 text-xs whitespace-nowrap"
                title={`ثبت تولید مرحله ${activeOp.stepCode} (${activeOp.stepName})`}
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>ثبت تولید ({shortOpCode})</span>
              </button>
            ) : activeOp.readyForTransferQty > 0 ? (
              <button
                type="button"
                onClick={() => onOpenTransfer(mo, activeOp)}
                className="sap-btn-emphasized inline-flex items-center gap-1 px-2.5 py-1 text-xs whitespace-nowrap"
                title={`انتقال از مرحله ${activeOp.stepCode} (${activeOp.stepName})`}
              >
                <ArrowRightLeft className="w-3.5 h-3.5" />
                <span>انتقال ({shortOpCode})</span>
              </button>
            ) : activeOp.waitingInputQty > 0 ? (
              <button
                type="button"
                onClick={() => onOpenInput(activeOp)}
                className="sap-btn-emphasized inline-flex items-center gap-1 px-2.5 py-1 text-xs whitespace-nowrap"
                title={`شروع کار مرحله ${activeOp.stepCode} (${activeOp.stepName})`}
              >
                <Play className="w-3.5 h-3.5" />
                <span>شروع کار ({shortOpCode})</span>
              </button>
            ) : null
          ) : null;

          return (
            <div
              key={mo.id}
              className={`bg-[var(--fiori-bg-surface)] border rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)] transition-colors ${
                isExpanded
                  ? 'border-[var(--fiori-brand)]'
                  : 'border-[var(--fiori-border-default)] hover:border-[var(--fiori-border-strong)]'
              }`}
            >
              {/* Header Row */}
              <div className="p-3 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-3">
                <div className="flex items-start gap-2.5 min-w-0 flex-1">
                  <div className="p-2 bg-[var(--fiori-info-bg)] text-[var(--fiori-brand)] border border-[var(--fiori-info-border)] rounded-[var(--fiori-radius-sm)] shrink-0 mt-0.5">
                    <Layers className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => traceDocument(mo.moNumber, 'WIP_TRACEABILITY')}
                        className="sap-doc-link fiori-ltr-code font-mono font-bold text-sm"
                        title="رهگیری دستور ساخت"
                      >
                        {mo.moNumber}
                      </button>
                      <FioriObjectStatus tone={statusInfo.tone} label={statusInfo.label} size="sm" />
                      <span className="text-xs font-bold text-[var(--fiori-text-primary)]">{mo.partName}</span>
                      <button
                        type="button"
                        onClick={() => traceDocument(mo.partCode, 'INVENTORY_LEDGER')}
                        className="sap-doc-link fiori-ltr-code font-mono text-[11px]"
                      >
                        ({mo.partCode})
                      </button>
                    </div>

                    {/* Current Operation & Location + Quantitative Summary */}
                    <div className="text-xs text-[var(--fiori-text-secondary)] flex items-center gap-x-3 gap-y-1.5 flex-wrap tabular-nums">
                      {activeOp && (
                        <span className="inline-flex items-center gap-1 text-[var(--fiori-text-primary)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] px-1.5 py-0.5 text-[11px] flex-wrap">
                          <MapPin className="w-3 h-3 text-[var(--fiori-brand)] shrink-0" />
                          <span>ایستگاه جاری:</span>
                          <strong className="fiori-ltr-code font-mono text-[var(--fiori-brand)]">{activeOp.stepCode}</strong>
                          <span>({activeOp.stepName})</span>
                          {activeOp.warehouseLocation && (
                            <span className="fiori-ltr-code font-mono text-[10px] text-[var(--fiori-text-secondary)]">
                              • {activeOp.warehouseLocation}
                            </span>
                          )}
                        </span>
                      )}
                      <span className="whitespace-nowrap">
                        هدف: <strong className="font-mono text-[var(--fiori-text-primary)]">{formatNumber(mo.targetQuantity)}</strong>
                      </span>
                      <span className="whitespace-nowrap">
                        صف: <strong className="font-mono text-[var(--fiori-critical)]">{formatNumber(totalWaiting)}</strong>
                      </span>
                      <span className="whitespace-nowrap">
                        پای دستگاه: <strong className="font-mono text-[var(--fiori-brand)]">{formatNumber(totalInProgress)}</strong>
                      </span>
                      <span className="whitespace-nowrap">
                        آماده انتقال: <strong className="font-mono text-[var(--fiori-positive)]">{formatNumber(totalReady)}</strong>
                      </span>
                      <span className="whitespace-nowrap">
                        تکمیل: <strong className="font-mono text-[var(--fiori-positive)]">{formatNumber(mo.completedQuantity)}</strong>
                      </span>
                      {mo.totalScrapQuantity > 0 && (
                        <span className="whitespace-nowrap">
                          ضایعات: <strong className="font-mono text-[var(--fiori-negative)]">{formatNumber(mo.totalScrapQuantity)}</strong>
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <span className="w-16 h-1.5 bg-[var(--fiori-border-subtle)] rounded-full overflow-hidden inline-block">
                          <span
                            className={`block h-full ${progressPct >= 100 ? 'bg-[var(--fiori-positive)]' : 'bg-[var(--fiori-brand)]'}`}
                            style={{ width: `${progressPct}%` }}
                          />
                        </span>
                        <strong className="font-mono text-[11px] text-[var(--fiori-brand)]">
                          {toPersianDigits(progressPct)}٪
                        </strong>
                      </span>
                    </div>
                  </div>
                </div>

                {/* Primary + Secondary Actions */}
                <div className="flex items-center gap-1.5 flex-wrap self-end lg:self-center shrink-0">
                  {nextActionBtn}

                  <button
                    type="button"
                    onClick={() => onOpenReconciliation(mo.id)}
                    className="sap-btn-standard inline-flex items-center gap-1 px-2.5 py-1 text-xs"
                    title="مشاهده گواهی موازنه پایستگی قطعات"
                  >
                    <Scale className="w-3.5 h-3.5 text-[var(--fiori-positive)]" />
                    <span>موازنه تراز</span>
                  </button>

                  {onRequestDeleteRollback && (
                    <button
                      type="button"
                      onClick={() => onRequestDeleteRollback(mo)}
                      className="fiori-btn-danger-outline inline-flex items-center gap-1 px-2 py-1 text-xs"
                      title="حذف دستور تولید به همراه زیرمجموعه‌ها و بازگشت کامل موجودی مصرفی به انبار"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">حذف و بازگشت</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => toggleMoExpanded(mo.id)}
                    className="sap-btn-standard inline-flex items-center gap-1 px-2.5 py-1 text-xs"
                  >
                    <span>{isExpanded ? 'بستن مراحل' : `مراحل (${toPersianDigits(mo.operations.length)})`}</span>
                    {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              {/* Expanded Operations Sequence & Cards */}
              {isExpanded && (
                <div className="border-t border-[var(--fiori-border-default)] p-3.5 bg-[var(--fiori-bg-subtle)] space-y-3">
                  <div className="flex items-center justify-between text-xs text-[var(--fiori-text-secondary)] flex-wrap gap-2">
                    <div className="font-semibold text-[var(--fiori-text-primary)]">
                      زنجیره عملیات ساخت ({toPersianDigits(completedOpsCount)} از {toPersianDigits(mo.operations.length)} تکمیل‌شده • نسخه مسیر{' '}
                      <span className="fiori-ltr-code font-mono">{mo.routingVersion}</span>)
                    </div>
                    <div className="text-[11px]">
                      قانون پایستگی: قطعات سالم تا پیش از ثبت حواله انتقال، در صف ورودی مرحله بعد منظور نمی‌شوند.
                    </div>
                  </div>

                  {/* Operations Cards Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                    {mo.operations.map((op, idx) => {
                      const hasWaiting = op.waitingInputQty > 0;
                      const hasInProgress = op.inProgressQty > 0;
                      const hasReadyToTransfer = op.readyForTransferQty > 0;

                      return (
                        <div
                          key={op.id}
                          className={`p-3 rounded-[var(--fiori-radius-sm)] border bg-[var(--fiori-bg-surface)] flex flex-col justify-between space-y-2.5 transition-colors ${
                            hasInProgress
                              ? 'border-[var(--fiori-brand)]'
                              : hasReadyToTransfer
                              ? 'border-[var(--fiori-positive-border)]'
                              : hasWaiting
                              ? 'border-[var(--fiori-critical-border)]'
                              : 'border-[var(--fiori-border-default)] opacity-90'
                          }`}
                        >
                          <div>
                            <div className="flex items-start justify-between gap-1.5">
                              <div className="min-w-0">
                                <span className="fiori-ltr-code font-mono text-xs font-bold text-[var(--fiori-brand)]">
                                  {op.stepCode}
                                </span>
                                <h4 className="text-xs font-bold text-[var(--fiori-text-primary)] mt-0.5 line-clamp-1" title={op.stepName}>
                                  {op.stepName}
                                </h4>
                              </div>
                              <FioriObjectStatus
                                tone={hasInProgress ? 'info' : hasReadyToTransfer ? 'positive' : hasWaiting ? 'critical' : 'neutral'}
                                label={`گام ${toPersianDigits(idx + 1)}`}
                                size="sm"
                              />
                            </div>

                            <div className="mt-1.5 text-[10px] text-[var(--fiori-text-secondary)] flex items-center justify-between gap-2">
                              <span className="inline-flex items-center gap-1 fiori-ltr-code font-mono text-[var(--fiori-brand)] truncate">
                                <MapPin className="w-3 h-3 shrink-0" />
                                {op.warehouseLocation}
                              </span>
                              {op.machineName && (
                                <span className="inline-flex items-center gap-1 truncate max-w-[130px]" title={op.machineName}>
                                  <Cpu className="w-3 h-3 shrink-0" />
                                  {op.machineName}
                                </span>
                              )}
                            </div>

                            {/* Quantitative Breakdown */}
                            <div className="mt-2.5 pt-2 border-t border-[var(--fiori-border-subtle)] grid grid-cols-2 gap-2 text-[11px] tabular-nums">
                              <div>
                                <span className="text-[var(--fiori-text-secondary)] block text-[10px]">در صف ورودی</span>
                                <span className={`font-mono font-bold ${op.waitingInputQty > 0 ? 'text-[var(--fiori-critical)]' : 'text-[var(--fiori-text-muted)]'}`}>
                                  {formatNumber(op.waitingInputQty)}
                                </span>
                              </div>
                              <div>
                                <span className="text-[var(--fiori-text-secondary)] block text-[10px]">پای دستگاه</span>
                                <span className={`font-mono font-bold ${op.inProgressQty > 0 ? 'text-[var(--fiori-brand)]' : 'text-[var(--fiori-text-muted)]'}`}>
                                  {formatNumber(op.inProgressQty)}
                                </span>
                              </div>
                              <div>
                                <span className="text-[var(--fiori-text-secondary)] block text-[10px]">آماده انتقال</span>
                                <span className={`font-mono font-bold ${op.readyForTransferQty > 0 ? 'text-[var(--fiori-positive)]' : 'text-[var(--fiori-text-muted)]'}`}>
                                  {formatNumber(op.readyForTransferQty)}
                                </span>
                              </div>
                              <div>
                                <span className="text-[var(--fiori-text-secondary)] block text-[10px]">ضایعات ثبتی</span>
                                <span className={`font-mono font-bold ${op.scrapQty > 0 ? 'text-[var(--fiori-negative)]' : 'text-[var(--fiori-text-muted)]'}`}>
                                  {formatNumber(op.scrapQty)}
                                </span>
                              </div>
                            </div>
                          </div>

                          {/* Card Action Buttons */}
                          <div className="pt-2 border-t border-[var(--fiori-border-subtle)] flex items-center gap-1.5 flex-wrap">
                            {hasWaiting && (
                              <button
                                type="button"
                                onClick={() => onOpenInput(op)}
                                className="sap-btn-emphasized flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 text-[11px]"
                                title="شروع پردازش و انتقال به پای دستگاه"
                              >
                                <Play className="w-3 h-3" />
                                <span>شروع کار</span>
                              </button>
                            )}

                            {hasInProgress && (
                              <button
                                type="button"
                                onClick={() => onOpenProduction(op)}
                                className="fiori-btn-positive flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 text-[11px]"
                                title="ثبت قطعات سالم و ضایعات"
                              >
                                <CheckCircle2 className="w-3 h-3" />
                                <span>ثبت خروجی</span>
                              </button>
                            )}

                            {hasReadyToTransfer && (
                              <button
                                type="button"
                                onClick={() => onOpenTransfer(mo, op)}
                                className="sap-btn-standard flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 text-[11px] text-[var(--fiori-brand)] border-[var(--fiori-brand)]"
                                title="ارسال قطعات به مرحله بعد یا انبار"
                              >
                                <ArrowRightLeft className="w-3 h-3" />
                                <span>انتقال ({formatNumber(op.readyForTransferQty)})</span>
                              </button>
                            )}

                            {!hasWaiting && !hasInProgress && !hasReadyToTransfer && op.transferredQty > 0 && (
                              <span className="w-full text-center text-[10px] text-[var(--fiori-positive)] font-semibold py-1">
                                کلیه قطعات به مرحله بعد ارسال شده‌اند
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );

  if (embeddedInParent) {
    return ordersListContent;
  }

  return (
    <FioriDynamicPage
      title="دستورهای کار تولید و فرآیندهای ساخت"
      subtitle="پیگیری چندمرحله‌ای عملیات، ثبت ورودی/خروجی هر ایستگاه، پایش ضایعات و صدور حواله انتقال بین‌مراحل"
      headerActions={
        <button
          type="button"
          onClick={onOpenCreateMo}
          className="sap-btn-emphasized inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>صدور دستور کار جدید (MO)</span>
        </button>
      }
      filterBar={
        <FioriFilterBar
          searchValue={searchTerm}
          onSearchChange={setSearchTerm}
          searchPlaceholder="جستجوی شماره دستور (MO)، کد یا عنوان قطعه..."
          segments={[
            { id: 'ALL', label: 'همه', count: orders.length },
            { id: 'IN_PROGRESS', label: 'در جریان ساخت', count: orders.filter(o => o.status === 'IN_PROGRESS').length },
            { id: 'RELEASED', label: 'صادرشده', count: orders.filter(o => o.status === 'RELEASED').length },
            { id: 'COMPLETED', label: 'تکمیل‌شده', count: orders.filter(o => o.status === 'COMPLETED').length },
          ]}
          activeSegment={statusFilter}
          onSegmentChange={setStatusFilter}
          hasActiveFilters={(statusFilter !== 'ALL' ? 1 : 0) + (searchTerm.trim() ? 1 : 0) > 0}
          onReset={() => {
            setSearchTerm('');
            setStatusFilter('ALL');
          }}
        />
      }
      activeFiltersCount={(statusFilter !== 'ALL' ? 1 : 0) + (searchTerm.trim() ? 1 : 0)}
      onResetFilters={() => {
        setSearchTerm('');
        setStatusFilter('ALL');
      }}
    >
      {ordersListContent}
    </FioriDynamicPage>
  );
};
