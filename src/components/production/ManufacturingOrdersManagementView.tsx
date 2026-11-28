import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Layers,
  Plus,
  RefreshCw,
  Trash2,
  CheckCircle2,
  Play,
  ArrowUpRight,
  Disc,
  Cpu,
  BookOpen,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  FileCheck,
  FileText,
  GitBranch,
  PackagePlus,
  ListTree,
  Warehouse,
} from 'lucide-react';
import { Part, Routing } from '../../types/inventory';
import {
  ManufacturingOrder,
  ManufacturingOperation,
  ManufacturingOrderStatus,
} from '../../types/productionWip';
import { formatNumber, toPersianDigits } from '../../utils/formatters';
import { formatToJalali } from '../../utils/jalali';
import { getActiveFactoryUser } from '../../utils/userDirectoryStorage';
import { useErpRouter } from '../../context/RouterContext';
import { CreateMoModal } from '../wip/CreateMoModal';
import { OperationProductionModal } from '../wip/OperationProductionModal';
import { MoRelationalGuideModal } from './MoRelationalGuideModal';
import { usePersistedOpen, usePersistedExpandMap } from '../../hooks/usePersistedCollapse';
import {
  FioriDataTable,
  FioriDialog,
  FioriDynamicPage,
  FioriFilterBar,
  FioriKpiStrip,
  FioriMessageStrip,
  FioriObjectStatus,
  FioriToolbar,
  type FioriStatusTone,
  type FioriTableColumn,
} from '../fiori/ui';
import { EmptyState } from '../common/EmptyState';

interface ManufacturingOrdersManagementViewProps {
  parts: Part[];
  routings: Routing[];
  onRefreshData?: () => void;
  onOpenVouchers?: () => void;
}

const STATUS_META: Record<string, { label: string; shortLabel: string; tone: FioriStatusTone }> = {
  PLANNED: { label: 'برنامه‌ریزی‌شده', shortLabel: 'برنامه‌ریزی', tone: 'neutral' },
  RELEASED: { label: 'آماده تولید', shortLabel: 'آزادشده', tone: 'brand' },
  IN_PROGRESS: { label: 'در حال تولید', shortLabel: 'در حال ساخت', tone: 'critical' },
  COMPLETED: { label: 'تکمیل‌شده', shortLabel: 'تکمیل‌شده', tone: 'positive' },
  CLOSED: { label: 'بسته‌شده', shortLabel: 'بسته‌شده', tone: 'neutral' },
  ON_HOLD: { label: 'متوقف / هولد', shortLabel: 'متوقف', tone: 'negative' },
};

function getOrderMetrics(mo: ManufacturingOrder) {
  const sortedOps = [...(mo.operations || [])].sort((a, b) => a.stepNumber - b.stepNumber);
  const totalOps = sortedOps.length;
  const completedOps = sortedOps.filter(o => o.status === 'COMPLETED').length;
  const activeOp =
    sortedOps.find(o => o.inProgressQty > 0) ||
    sortedOps.find(o => o.waitingInputQty > 0) ||
    sortedOps.find(o => o.readyForTransferQty > 0) ||
    sortedOps.find(o => o.status !== 'COMPLETED');
  const totalWaiting = sortedOps.reduce((s, o) => s + (o.waitingInputQty || 0), 0);
  const totalInProgress = sortedOps.reduce((s, o) => s + (o.inProgressQty || 0), 0);
  const remainingQty = Math.max(0, (mo.targetQuantity || 0) - (mo.completedQuantity || 0));
  const finalCompletionPct =
    mo.targetQuantity > 0
      ? Math.min(100, Math.round(((mo.completedQuantity || 0) / mo.targetQuantity) * 100))
      : 0;
  const opWeightedPct =
    totalOps > 0 && mo.targetQuantity > 0
      ? Math.min(
          100,
          Math.round(
            (sortedOps.reduce(
              (sum, o) => sum + Math.min(1, (o.goodOutputQty || 0) / mo.targetQuantity),
              0
            ) /
              totalOps) *
              100
          )
        )
      : finalCompletionPct;
  const displayProgressPct = Math.max(finalCompletionPct, opWeightedPct);

  return {
    sortedOps,
    totalOps,
    completedOps,
    activeOp,
    totalWaiting,
    totalInProgress,
    remainingQty,
    displayProgressPct,
  };
}

export const ManufacturingOrdersManagementView: React.FC<ManufacturingOrdersManagementViewProps> = ({
  parts,
  routings,
  onRefreshData,
  onOpenVouchers,
}) => {
  const router = useErpRouter();
  const [orders, setOrders] = useState<ManufacturingOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'ALL' | ManufacturingOrderStatus>('ALL');
  const [searchQuery, setSearchQuery] = useState(() => router.route.docQuery || '');
  const [showGuide, , toggleGuide] = usePersistedOpen('mo_mgmt_guide_open', false);
  const {
    map: expandedMoCardsMap,
    isExpanded: isMoCardExpanded,
    toggle: toggleMoCard,
    expandAll: expandAllMoCards,
    collapseAll: collapseAllMoCards,
    expandedCount: expandedMoCardsCount,
  } = usePersistedExpandMap('mo_mgmt_cards_expanded', {});

  useEffect(() => {
    if (router.route.docQuery !== undefined && router.route.docQuery !== null) {
      setSearchQuery(router.route.docQuery);
    }
  }, [router.route.docQuery]);

  const [isVisualGuideOpen, setIsVisualGuideOpen] = useState(false);
  const [notice, setNotice] = useState<{
    type: 'success' | 'warning' | 'error';
    title: string;
    detail: string;
  } | null>(null);

  // Modals state
  const [isCreateMoOpen, setIsCreateMoOpen] = useState(false);
  const [activeProdOp, setActiveProdOp] = useState<ManufacturingOperation | null>(null);

  // Load Material (سرکلاف / ورق) Modal state
  const [loadMaterialOrder, setLoadMaterialOrder] = useState<ManufacturingOrder | null>(null);
  const [loadMaterialQty, setLoadMaterialQty] = useState('500');
  const [loadMaterialSourceId, setLoadMaterialSourceId] = useState('');
  const [materialSources, setMaterialSources] = useState<any[]>([]);
  const [materialSourcesLoading, setMaterialSourcesLoading] = useState(false);
  const [loadMaterialNotes, setLoadMaterialNotes] = useState('');
  const [isLoadingMaterial, setIsLoadingMaterial] = useState(false);

  // Delete & Rollback Modal state
  const [deleteTargetOrder, setDeleteTargetOrder] = useState<ManufacturingOrder | null>(null);
  const [rollbackPreview, setRollbackPreview] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [deleteReason, setDeleteReason] = useState(
    'حذف دستور ساخت غیرضروری و بازگشت مواد مصرفی به انبار'
  );
  const [cascadeSubMos, setCascadeSubMos] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch('/api/wip/manufacturing-orders');
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'دریافت فهرست دستورات ساخت با خطا مواجه شد.');
      }
      if (Array.isArray(json.data)) {
        setOrders(json.data);
      }
    } catch (err: any) {
      console.error('Failed to fetch manufacturing orders:', err);
      setFetchError(err?.message || 'خطا در برقراری ارتباط با سرور برای دریافت دستورات ساخت.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOrders();
    const handler = () => {
      fetchOrders();
    };
    window.addEventListener('kpims-master-data-updated', handler);
    return () => window.removeEventListener('kpims-master-data-updated', handler);
  }, [fetchOrders]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {
      ALL: orders.length,
      RELEASED: 0,
      IN_PROGRESS: 0,
      COMPLETED: 0,
      PLANNED: 0,
    };
    orders.forEach(o => {
      counts[o.status] = (counts[o.status] || 0) + 1;
    });
    return counts;
  }, [orders]);

  const filteredOrders = useMemo(() => {
    return orders.filter(order => {
      if (statusFilter !== 'ALL' && order.status !== statusFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchMo =
          order.moNumber.toLowerCase().includes(q) || order.id.toLowerCase().includes(q);
        const matchPart =
          order.partCode.toLowerCase().includes(q) || order.partName.toLowerCase().includes(q);
        const matchParent = (order.parentMoNumber || '').toLowerCase().includes(q);
        if (!matchMo && !matchPart && !matchParent) return false;
      }
      return true;
    });
  }, [orders, statusFilter, searchQuery]);

  const kpis = useMemo(() => {
    const totalOrders = orders.length;
    const activeOrders = orders.filter(
      o => o.status === 'IN_PROGRESS' || o.status === 'RELEASED'
    ).length;
    const completedOrders = orders.filter(o => o.status === 'COMPLETED').length;
    const totalTarget = orders.reduce((acc, o) => acc + (o.targetQuantity || 0), 0);
    const totalCompleted = orders.reduce((acc, o) => acc + (o.completedQuantity || 0), 0);
    const totalRemaining = Math.max(0, totalTarget - totalCompleted);
    const totalScrap = orders.reduce((acc, o) => acc + (o.totalScrapQuantity || 0), 0);
    const overallProgressPct =
      totalTarget > 0 ? Math.min(100, Math.round((totalCompleted / totalTarget) * 100)) : 0;
    return {
      totalOrders,
      activeOrders,
      completedOrders,
      totalTarget,
      totalCompleted,
      totalRemaining,
      totalScrap,
      overallProgressPct,
    };
  }, [orders]);

  useEffect(() => {
    if (!loadMaterialOrder) return;
    let cancelled = false;
    setMaterialSourcesLoading(true);
    setLoadMaterialSourceId('');
    fetch('/api/wip/material-sources')
      .then(r => r.json())
      .then(json => {
        if (!cancelled && json?.success && Array.isArray(json.data)) {
          setMaterialSources(json.data);
        }
      })
      .catch(() => {
        if (!cancelled) setMaterialSources([]);
      })
      .finally(() => {
        if (!cancelled) setMaterialSourcesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadMaterialOrder]);

  // Create MO handler
  const handleCreateMo = async (payload: any): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/wip/manufacturing-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        if (res.status === 409 || json.conflict) {
          await fetchOrders();
        }
        return { success: false, error: json.error || 'خطا در صدور دستور ساخت' };
      }
      await fetchOrders();
      onRefreshData?.();
      window.dispatchEvent(new CustomEvent('kpims-master-data-updated'));
      setNotice({
        type: 'success',
        title: `دستور ساخت جدید «${json.data?.moNumber || ''}» با موفقیت در دیتابیس ایجاد شد`,
        detail: `مراحل عملیاتی از روی مسیر فرآیند مصوب ساخته شد و آماده ثبت خروجی (OP10) است.`,
      });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'خطا در ارتباط با سرور' };
    }
  };

  // Register OP Production handler
  const handleRegisterOpProduction = async (
    payload: any
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/wip/operations/production', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        if (res.status === 409 || json.conflict) {
          await fetchOrders();
        }
        return { success: false, error: json.error || 'خطا در ثبت خروجی عملیات تولید' };
      }
      await fetchOrders();
      onRefreshData?.();
      window.dispatchEvent(new CustomEvent('kpims-master-data-updated'));
      setNotice({
        type: 'success',
        title: `ثبت خروجی تولید و کنترل کیفیت با موفقیت انجام شد`,
        detail:
          json.message ||
          'آمار تولید سالم، کسر خودکار مواد (Backflush) و انتقال به مرحله بعد ثبت شد.',
      });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'خطا در ارتباط با سرور' };
    }
  };

  // Load Material (سرکلاف / شیت) into OP10 handler
  const handleLoadMaterialSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loadMaterialOrder || !loadMaterialSourceId) return;
    const qty = Number(loadMaterialQty);
    if (!Number.isFinite(qty) || qty <= 0) return;

    setIsLoadingMaterial(true);
    try {
      const firstOp = [...loadMaterialOrder.operations].sort(
        (a, b) => a.stepNumber - b.stepNumber
      )[0];
      const activeUser = getActiveFactoryUser();
      const res = await fetch(
        `/api/wip/manufacturing-orders/${encodeURIComponent(loadMaterialOrder.id)}/load-material`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operationId: firstOp?.id,
            quantity: qty,
            sourceStockBalanceId: loadMaterialSourceId,
            expectedVersion: loadMaterialOrder.version,
            operatorName: activeUser.displayName,
            notes:
              loadMaterialNotes.trim() ||
              `تغذیه سرکلاف / شیت ورودی به ${firstOp?.stepCode || 'OP10'}`,
          }),
        }
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        if (res.status === 409 || json.conflict) {
          await fetchOrders();
        }
        setNotice({
          type: 'error',
          title: 'خطا در بارگذاری مواد اولیه',
          detail: json.error || 'امکان ثبت ورودی مواد وجود ندارد.',
        });
      } else {
        setNotice({
          type: 'success',
          title: `بارگذاری سرکلاف / مواد اولیه برای دستور «${loadMaterialOrder.moNumber}» ثبت شد`,
          detail: `تعداد ${formatNumber(qty)} قطعه در صف ورودی ایستگاه ${
            firstOp?.stepCode || 'OP10'
          } قرار گرفت و آماده ثبت خروجی است.`,
        });
        setLoadMaterialOrder(null);
        setLoadMaterialSourceId('');
        await fetchOrders();
        onRefreshData?.();
        window.dispatchEvent(new CustomEvent('kpims-master-data-updated'));
      }
    } catch (err: any) {
      setNotice({
        type: 'error',
        title: 'خطا در ارتباط با سرور',
        detail: err.message || 'خطای شبکه',
      });
    } finally {
      setIsLoadingMaterial(false);
    }
  };

  // Open Delete / Rollback Preview modal
  const handleOpenDeleteModal = async (order: ManufacturingOrder) => {
    setDeleteTargetOrder(order);
    setPreviewLoading(true);
    setRollbackPreview(null);
    try {
      const res = await fetch(
        `/api/wip/manufacturing-orders/${encodeURIComponent(
          order.id
        )}/rollback-preview?cascadeSubMos=true`
      );
      const json = await res.json();
      if (json.success) {
        setRollbackPreview(json.data);
      }
    } catch (err) {
      console.error('Failed to load rollback preview:', err);
    } finally {
      setPreviewLoading(false);
    }
  };

  // Confirm Delete MO & Rollback Inventory
  const handleConfirmDeleteMo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deleteTargetOrder) return;
    if (deleteReason.trim().length < 5) return;

    setIsDeleting(true);
    try {
      const activeUser = getActiveFactoryUser();
      const res = await fetch(
        `/api/wip/manufacturing-orders/${encodeURIComponent(deleteTargetOrder.id)}`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cascadeSubMos,
            reason: deleteReason.trim(),
            userId: activeUser.uid,
            userName: activeUser.displayName,
          }),
        }
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        setNotice({
          type: 'error',
          title: `خطا در حذف دستور ساخت «${deleteTargetOrder.moNumber}»`,
          detail: json.error || 'عملیات حذف و بازگشت موجودی انجام نشد.',
        });
      } else {
        setNotice({
          type: 'success',
          title: `دستور ساخت «${deleteTargetOrder.moNumber}» با موفقیت حذف و موجودی به انبار بازگردانده شد`,
          detail:
            json.message ||
            'کلیه حواله‌های مصرف مرتبط ابطال و موجودی رول/قطعات به انبار بازگشت.',
        });
        setDeleteTargetOrder(null);
        await fetchOrders();
        onRefreshData?.();
        window.dispatchEvent(new CustomEvent('kpims-master-data-updated'));
      }
    } catch (err: any) {
      setNotice({
        type: 'error',
        title: 'خطا در ارتباط با سرور هنگام حذف دستور ساخت',
        detail: err.message || 'خطای شبکه',
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const activeFiltersCount = (statusFilter !== 'ALL' ? 1 : 0) + (searchQuery.trim() ? 1 : 0);

  const handleResetFilters = () => {
    setStatusFilter('ALL');
    setSearchQuery('');
    if (router.route.docQuery) router.clearDocQuery();
  };

  const openLoadMaterialDialog = useCallback((mo: ManufacturingOrder) => {
    setLoadMaterialOrder(mo);
    setLoadMaterialQty(String(mo.targetQuantity || 500));
    setLoadMaterialNotes('');
  }, []);

  // Master Table Columns (SAP Fiori Horizon List Report — sized to fit 1440px with expanded sidebar without horizontal clipping)
  const moColumns = useMemo<FioriTableColumn<ManufacturingOrder>[]>(
    () => [
      {
        key: 'moNumber',
        header: 'شماره دستور ساخت (MO)',
        sortable: true,
        sortValue: mo => mo.moNumber,
        width: '9.5rem',
        nowrap: true,
        render: mo => {
          const expanded = isMoCardExpanded(mo.id);
          return (
            <div className="flex items-start gap-1.5">
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  toggleMoCard(mo.id);
                }}
                aria-expanded={expanded}
                aria-label={expanded ? 'بستن مراحل دستور ساخت' : 'مشاهده مراحل دستور ساخت'}
                className="p-0.5 mt-0.5 rounded-[var(--fiori-radius-sm)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-brand)] hover:bg-[var(--fiori-brand-bg)] cursor-pointer shrink-0 fiori-focus-ring"
              >
                {expanded ? (
                  <ChevronDown className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
                ) : (
                  <ChevronLeft className="w-3.5 h-3.5" />
                )}
              </button>
              <div className="min-w-0 space-y-0.5">
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation();
                    toggleMoCard(mo.id);
                  }}
                  className="font-mono font-semibold text-xs text-[var(--fiori-brand)] hover:underline fiori-ltr-code cursor-pointer block text-left"
                >
                  {mo.moNumber}
                </button>
                <div className="flex items-center gap-1.5 flex-wrap text-[10px] text-[var(--fiori-text-muted)]">
                  {mo.startDate && (
                    <span className="font-mono tabular-nums">
                      {toPersianDigits(formatToJalali(mo.startDate))}
                    </span>
                  )}
                  {mo.parentMoNumber && (
                    <span className="px-1 py-0.2 rounded bg-[var(--fiori-critical-bg)] text-[var(--fiori-critical)] border border-[var(--fiori-critical-border)]">
                      فرعیِ <span className="fiori-ltr-code font-mono">{mo.parentMoNumber}</span>
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        },
      },
      {
        key: 'partName',
        header: 'قطعه و کد فنی',
        sortable: true,
        sortValue: mo => mo.partName,
        render: mo => (
          <div className="min-w-[130px] max-w-[195px]">
            <div
              className="font-semibold text-[var(--fiori-text-primary)] truncate"
              title={mo.partName}
            >
              {mo.partName}
            </div>
            <div className="text-[10px] text-[var(--fiori-text-secondary)] mt-0.5 flex items-center gap-1.5">
              <span className="fiori-ltr-code font-mono">{mo.partCode}</span>
              {mo.routingVersion && (
                <>
                  <span>·</span>
                  <span>مسیر نسخه {mo.routingVersion}</span>
                </>
              )}
            </div>
          </div>
        ),
      },
      {
        key: 'status',
        header: 'وضعیت',
        sortable: true,
        sortValue: mo => mo.status,
        width: '6.25rem',
        nowrap: true,
        render: mo => {
          const meta = STATUS_META[mo.status] || {
            label: mo.status,
            shortLabel: mo.status,
            tone: 'neutral' as FioriStatusTone,
          };
          return <FioriObjectStatus tone={meta.tone} label={meta.label} icon size="sm" />;
        },
      },
      {
        key: 'activeOp',
        header: 'ایستگاه فعال و وضعیت خط',
        hideBelow: 'md',
        render: mo => {
          const { activeOp, completedOps, totalOps, totalWaiting, totalInProgress } =
            getOrderMetrics(mo);
          return (
            <div className="space-y-0.5 min-w-[120px] max-w-[165px]">
              {activeOp ? (
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="px-1.5 py-0.2 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border border-[var(--fiori-brand-border)] font-mono font-semibold text-[10px] fiori-ltr-code shrink-0">
                    {activeOp.stepCode}
                  </span>
                  <span
                    className="text-[var(--fiori-text-primary)] truncate max-w-[115px]"
                    title={activeOp.stepName}
                  >
                    {activeOp.stepName}
                  </span>
                </div>
              ) : (
                <span className="text-[var(--fiori-positive)] font-medium text-[11px]">
                  همه ایستگاه‌ها تکمیل شد
                </span>
              )}
              <div className="flex items-center gap-2 text-[10px] text-[var(--fiori-text-secondary)]">
                <span>
                  {toPersianDigits(completedOps)}/{toPersianDigits(totalOps)} مرحله
                </span>
                {totalWaiting > 0 && (
                  <span className="text-[var(--fiori-brand)] font-mono tabular-nums">
                    صف: {formatNumber(totalWaiting)}
                  </span>
                )}
                {totalInProgress > 0 && (
                  <span className="text-[var(--fiori-critical)] font-mono tabular-nums">
                    در خط: {formatNumber(totalInProgress)}
                  </span>
                )}
              </div>
            </div>
          );
        },
      },
      {
        key: 'quantities',
        header: 'تولید / هدف / مانده',
        sortable: true,
        sortValue: mo => mo.targetQuantity || 0,
        align: 'left',
        width: '8rem',
        nowrap: true,
        render: mo => {
          const { remainingQty } = getOrderMetrics(mo);
          return (
            <div className="space-y-0.5 font-mono tabular-nums text-left">
              <div className="text-xs">
                <strong className="text-[var(--fiori-positive)]">
                  {formatNumber(mo.completedQuantity || 0)}
                </strong>
                <span className="text-[var(--fiori-text-muted)]">
                  {' '}
                  / {formatNumber(mo.targetQuantity || 0)}
                </span>
              </div>
              <div className="flex items-center justify-end gap-2 text-[10px]">
                <span className="text-[var(--fiori-text-secondary)]">
                  مانده: {formatNumber(remainingQty)}
                </span>
                {(mo.totalScrapQuantity || 0) > 0 && (
                  <span className="text-[var(--fiori-negative)]">
                    ضایعات: {formatNumber(mo.totalScrapQuantity)}
                  </span>
                )}
              </div>
            </div>
          );
        },
      },
      {
        key: 'progress',
        header: 'پیشرفت',
        sortable: true,
        sortValue: mo => getOrderMetrics(mo).displayProgressPct,
        width: '4.5rem',
        hideBelow: 'sm',
        render: mo => {
          const { displayProgressPct } = getOrderMetrics(mo);
          return (
            <div className="space-y-1 min-w-[52px]">
              <div className="flex items-center justify-between text-[11px] font-mono tabular-nums">
                <span
                  className={
                    displayProgressPct >= 100
                      ? 'text-[var(--fiori-positive)] font-semibold'
                      : 'text-[var(--fiori-text-primary)] font-semibold'
                  }
                >
                  {toPersianDigits(displayProgressPct)}٪
                </span>
              </div>
              <div className="w-full h-1.5 bg-[var(--fiori-neutral-bg)] rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all ${
                    displayProgressPct >= 100
                      ? 'bg-[var(--fiori-positive)]'
                      : 'bg-[var(--fiori-brand)]'
                  }`}
                  style={{ width: `${displayProgressPct}%` }}
                />
              </div>
            </div>
          );
        },
      },
      {
        key: 'actions',
        header: 'اقدامات عملیاتی',
        align: 'left',
        nowrap: true,
        render: mo => {
          const { activeOp, totalWaiting, totalInProgress } = getOrderMetrics(mo);
          const canProduceActive =
            activeOp && (activeOp.inProgressQty || 0) + (activeOp.waitingInputQty || 0) > 0;
          const needsInitialMaterial =
            mo.status !== 'COMPLETED' &&
            mo.status !== 'CANCELLED' &&
            totalWaiting === 0 &&
            totalInProgress === 0 &&
            (mo.completedQuantity || 0) < (mo.targetQuantity || 0);
          const shortOpCode = activeOp ? activeOp.stepCode.split('_')[0] : '';

          return (
            <div
              className="flex items-center justify-end gap-1"
              onClick={e => e.stopPropagation()}
            >
              {canProduceActive && activeOp ? (
                <button
                  type="button"
                  onClick={() => setActiveProdOp(activeOp)}
                  className="fiori-btn-positive px-2 py-1 text-[11px] inline-flex items-center gap-1 cursor-pointer whitespace-nowrap"
                  title={`ثبت خروجی تولید و QC برای ایستگاه ${activeOp.stepCode} (${activeOp.stepName})`}
                >
                  <Play className="w-3 h-3" />
                  <span>ثبت تولید ({shortOpCode})</span>
                </button>
              ) : needsInitialMaterial ? (
                <button
                  type="button"
                  onClick={() => openLoadMaterialDialog(mo)}
                  className="sap-btn-emphasized px-2 py-1 text-[11px] inline-flex items-center gap-1 cursor-pointer whitespace-nowrap"
                  title="تغذیه سرکلاف یا شیت ورودی به ایستگاه اول (OP10)"
                >
                  <PackagePlus className="w-3 h-3" />
                  <span>شارژ OP10</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => toggleMoCard(mo.id)}
                  className="sap-btn-standard px-2 py-1 text-[11px] inline-flex items-center gap-1 cursor-pointer whitespace-nowrap"
                >
                  <span>مراحل</span>
                </button>
              )}

              {!needsInitialMaterial && mo.status !== 'COMPLETED' && mo.status !== 'CANCELLED' && (
                <button
                  type="button"
                  onClick={() => openLoadMaterialDialog(mo)}
                  className="sap-btn-standard p-1.5 text-[var(--fiori-brand)] cursor-pointer"
                  title="بارگذاری سرکلاف / مواد اولیه به OP10"
                  aria-label="بارگذاری سرکلاف / مواد اولیه به OP10"
                >
                  <PackagePlus className="w-3.5 h-3.5" />
                </button>
              )}

              <button
                type="button"
                onClick={() =>
                  router.navigate({
                    tab: 'wip',
                    wipSubTab: 'UNIFIED_DIRECTORY',
                    moId: mo.id,
                  })
                }
                className="sap-btn-standard p-1.5 text-[var(--fiori-text-secondary)] cursor-pointer"
                title="رهگیری پرونده کامل در کارتابل WIP"
                aria-label="رهگیری در کارتابل WIP"
              >
                <GitBranch className="w-3.5 h-3.5" />
              </button>

              <button
                type="button"
                onClick={() =>
                  router.navigate({
                    tab: 'master_data',
                    masterSubSection: 'BOM',
                    docQuery: mo.partCode,
                  })
                }
                className="sap-btn-standard p-1.5 text-[var(--fiori-text-secondary)] cursor-pointer hidden 2xl:inline-flex"
                title="مشاهده درخت محصول (BOM)"
                aria-label="مشاهده درخت محصول BOM"
              >
                <ListTree className="w-3.5 h-3.5" />
              </button>

              <button
                type="button"
                onClick={() =>
                  router.navigate({
                    tab: 'inventory',
                    inventorySubTab: 'INQUIRY',
                    docQuery: mo.partCode,
                  })
                }
                className="sap-btn-standard p-1.5 text-[var(--fiori-positive)] cursor-pointer hidden 2xl:inline-flex"
                title="کاردکس و موجودی انبار قطعه"
                aria-label="کاردکس انبار"
              >
                <Warehouse className="w-3.5 h-3.5" />
              </button>

              <button
                type="button"
                onClick={() => handleOpenDeleteModal(mo)}
                className="fiori-btn-danger-outline p-1.5 cursor-pointer"
                title="حذف دستور ساخت و بازگشت موجودی به انبار"
                aria-label="حذف و بازگشت موجودی"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        },
      },
    ],
    [isMoCardExpanded, toggleMoCard, openLoadMaterialDialog, router]
  );

  // Expanded Row Detail Renderer (Operation Flow Chain + Operations Table)
  const renderExpandedMoRow = useCallback(
    (mo: ManufacturingOrder) => {
      const { sortedOps } = getOrderMetrics(mo);

      const opColumns: FioriTableColumn<ManufacturingOperation>[] = [
        {
          key: 'stepCode',
          header: 'ایستگاه (OP)',
          width: '8.5rem',
          nowrap: true,
          render: (op, idx) => (
            <div className="flex items-center gap-1.5">
              <span className="font-mono font-semibold text-[var(--fiori-text-primary)] fiori-ltr-code">
                {op.stepCode}
              </span>
              {idx === 0 && <FioriObjectStatus tone="brand" label="ورودی" size="sm" />}
              {idx === sortedOps.length - 1 && (
                <FioriObjectStatus tone="positive" label="نهایی" size="sm" />
              )}
            </div>
          ),
        },
        {
          key: 'stepName',
          header: 'شرح عملیات',
          render: op => (
            <span className="font-medium text-[var(--fiori-text-primary)]">{op.stepName}</span>
          ),
        },
        {
          key: 'machineName',
          header: 'دستگاه / موقعیت فیزیکی',
          hideBelow: 'sm',
          render: op => (
            <div className="text-[11px]">
              <div className="text-[var(--fiori-text-primary)]">
                {op.machineName || 'ایستگاه استاندارد'}
              </div>
              {op.warehouseLocation && (
                <div className="text-[10px] text-[var(--fiori-text-muted)] font-mono fiori-ltr-code">
                  {op.warehouseLocation}
                </div>
              )}
            </div>
          ),
        },
        {
          key: 'status',
          header: 'وضعیت',
          width: '7.5rem',
          render: op => (
            <FioriObjectStatus
              tone={
                op.status === 'COMPLETED'
                  ? 'positive'
                  : op.status === 'IN_PROGRESS'
                  ? 'critical'
                  : op.status === 'READY'
                  ? 'brand'
                  : 'neutral'
              }
              label={
                op.status === 'COMPLETED'
                  ? 'تکمیل‌شده'
                  : op.status === 'IN_PROGRESS'
                  ? 'در حال تولید'
                  : op.status === 'READY'
                  ? 'آماده شروع'
                  : 'در انتظار'
              }
              size="sm"
            />
          ),
        },
        {
          key: 'waitingInputQty',
          header: 'صف ورودی',
          align: 'left',
          isMono: true,
          width: '5.5rem',
          render: op => (
            <span
              className={
                (op.waitingInputQty || 0) > 0
                  ? 'font-semibold text-[var(--fiori-brand)]'
                  : 'text-[var(--fiori-text-muted)]'
              }
            >
              {formatNumber(op.waitingInputQty || 0)}
            </span>
          ),
        },
        {
          key: 'inProgressQty',
          header: 'پای دستگاه',
          align: 'left',
          isMono: true,
          width: '5.5rem',
          render: op => (
            <span
              className={
                (op.inProgressQty || 0) > 0
                  ? 'font-semibold text-[var(--fiori-critical)]'
                  : 'text-[var(--fiori-text-muted)]'
              }
            >
              {formatNumber(op.inProgressQty || 0)}
            </span>
          ),
        },
        {
          key: 'output',
          header: 'سالم / هدف',
          align: 'left',
          isMono: true,
          width: '7rem',
          render: op => (
            <span>
              <strong className="text-[var(--fiori-positive)]">
                {formatNumber(op.goodOutputQty || 0)}
              </strong>
              <span className="text-[var(--fiori-text-muted)]">
                {' '}
                / {formatNumber(mo.targetQuantity)}
              </span>
            </span>
          ),
        },
        {
          key: 'scrapQty',
          header: 'ضایعات',
          align: 'left',
          isMono: true,
          width: '5rem',
          render: op => (
            <span
              className={
                (op.scrapQty || 0) > 0
                  ? 'font-semibold text-[var(--fiori-negative)]'
                  : 'text-[var(--fiori-text-muted)]'
              }
            >
              {formatNumber(op.scrapQty || 0)}
            </span>
          ),
        },
        {
          key: 'actions',
          header: 'ثبت عملیات',
          align: 'left',
          width: '9.5rem',
          nowrap: true,
          render: op => {
            const availableToProduce = (op.inProgressQty || 0) + (op.waitingInputQty || 0);
            return (
              <button
                type="button"
                onClick={() => setActiveProdOp(op)}
                className={`px-2.5 py-1 text-[11px] inline-flex items-center gap-1 cursor-pointer whitespace-nowrap ${
                  availableToProduce > 0 ? 'fiori-btn-positive' : 'sap-btn-standard'
                }`}
              >
                <Play className="w-3 h-3" />
                <span>ثبت خروجی و QC</span>
              </button>
            );
          },
        },
      ];

      return (
        <div className="p-3.5 space-y-3 border-t border-[var(--fiori-border-default)] bg-[var(--fiori-bg-subtle)]">
          {/* Context Metadata + Operation Sequence Flow */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2.5">
            {/* Visual Operation Flow Strip */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] font-semibold text-[var(--fiori-text-secondary)] ml-1">
                زنجیره مراحل:
              </span>
              {sortedOps.map((op, idx) => {
                const isDone = op.status === 'COMPLETED';
                const isActive =
                  !isDone && ((op.inProgressQty || 0) > 0 || (op.waitingInputQty || 0) > 0);
                return (
                  <React.Fragment key={op.id}>
                    {idx > 0 && (
                      <ChevronLeft className="w-3 h-3 text-[var(--fiori-text-muted)] shrink-0" />
                    )}
                    <button
                      type="button"
                      onClick={() => setActiveProdOp(op)}
                      title={`${op.stepCode} — ${op.stepName} | صف: ${formatNumber(
                        op.waitingInputQty || 0
                      )} | در حال ساخت: ${formatNumber(op.inProgressQty || 0)} | سالم: ${formatNumber(
                        op.goodOutputQty || 0
                      )}`}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--fiori-radius-sm)] border text-[10px] font-medium cursor-pointer transition-colors ${
                        isDone
                          ? 'bg-[var(--fiori-positive-bg)] border-[var(--fiori-positive-border)] text-[var(--fiori-positive)]'
                          : isActive
                          ? 'bg-[var(--fiori-brand-bg)] border-[var(--fiori-brand)] text-[var(--fiori-brand)] font-semibold'
                          : 'bg-[var(--fiori-bg-surface)] border-[var(--fiori-border-default)] text-[var(--fiori-text-secondary)] hover:border-[var(--fiori-brand-border)]'
                      }`}
                    >
                      <span className="fiori-ltr-code font-mono">{op.stepCode}</span>
                      <span className="font-mono tabular-nums opacity-85">
                        ({formatNumber(op.goodOutputQty || 0)})
                      </span>
                    </button>
                  </React.Fragment>
                );
              })}
            </div>

            {/* Quick Contextual Links & Secondary Info */}
            <div className="flex items-center gap-2 flex-wrap text-[11px] text-[var(--fiori-text-secondary)]">
              <span>
                ورودی خط:{' '}
                <strong className="font-mono text-[var(--fiori-text-primary)]">
                  {formatNumber(mo.initialInputQuantity || 0)}
                </strong>
              </span>
              {mo.dueDate && (
                <>
                  <span>·</span>
                  <span>
                    موعد تحویل:{' '}
                    <strong className="font-mono tabular-nums text-[var(--fiori-text-primary)]">
                      {toPersianDigits(formatToJalali(mo.dueDate))}
                    </strong>
                  </span>
                </>
              )}
              {mo.notes && (
                <>
                  <span>·</span>
                  <span className="text-[var(--fiori-text-primary)]">{mo.notes}</span>
                </>
              )}
              <span>·</span>
              <button
                type="button"
                onClick={() =>
                  router.navigate({
                    tab: 'master_data',
                    masterSubSection: 'BOM',
                    docQuery: mo.partCode,
                  })
                }
                className="sap-doc-link inline-flex items-center gap-1 text-[11px]"
              >
                <ListTree className="w-3 h-3" />
                <span>درخت محصول (BOM)</span>
              </button>
              <span>·</span>
              <button
                type="button"
                onClick={() =>
                  router.navigate({
                    tab: 'inventory',
                    inventorySubTab: 'INQUIRY',
                    docQuery: mo.partCode,
                  })
                }
                className="sap-doc-link inline-flex items-center gap-1 text-[11px]"
              >
                <Warehouse className="w-3 h-3" />
                <span>کاردکس انبار</span>
              </button>
            </div>
          </div>

          {/* Operations Table */}
          <FioriDataTable
            columns={opColumns}
            data={sortedOps}
            rowKey={op => op.id}
            bordered
            emptyState={<EmptyState variant="NO_DATA" title="مرحله عملیاتی یافت نشد" compact />}
          />
        </div>
      );
    },
    [router]
  );

  const kpiItems = useMemo(
    () => [
      {
        id: 'total',
        label: 'کل دستورات ساخت',
        value: toPersianDigits(kpis.totalOrders),
        unit: 'دستور',
        tone: 'neutral' as FioriStatusTone,
        active: statusFilter === 'ALL',
        onClick: () => setStatusFilter('ALL'),
        title: 'نمایش همه دستورات ساخت',
      },
      {
        id: 'active',
        label: 'فعال و در خط تولید',
        value: toPersianDigits(kpis.activeOrders),
        unit: 'دستور',
        subtext: `${toPersianDigits(statusCounts.IN_PROGRESS || 0)} در حال ساخت · ${toPersianDigits(
          statusCounts.RELEASED || 0
        )} آماده`,
        tone: 'brand' as FioriStatusTone,
        active: statusFilter === 'IN_PROGRESS',
        onClick: () =>
          setStatusFilter(prev => (prev === 'IN_PROGRESS' ? 'ALL' : 'IN_PROGRESS')),
        title: 'فیلتر دستورات در حال تولید',
      },
      {
        id: 'completed',
        label: 'دستورات تکمیل‌شده',
        value: toPersianDigits(kpis.completedOrders),
        unit: 'تکمیل',
        tone: 'positive' as FioriStatusTone,
        active: statusFilter === 'COMPLETED',
        onClick: () =>
          setStatusFilter(prev => (prev === 'COMPLETED' ? 'ALL' : 'COMPLETED')),
        title: 'فیلتر دستورات تکمیل‌شده',
      },
      {
        id: 'quantities',
        label: 'تولیدشده / هدف کل',
        value: `${formatNumber(kpis.totalCompleted)} / ${formatNumber(kpis.totalTarget)}`,
        unit: 'عدد',
        subtext: `مانده: ${formatNumber(kpis.totalRemaining)} · ضایعات: ${formatNumber(
          kpis.totalScrap
        )}`,
        tone: 'neutral' as FioriStatusTone,
      },
      {
        id: 'progress',
        label: 'تحقق کلی برنامه',
        value: `${toPersianDigits(kpis.overallProgressPct)}٪`,
        progressPercent: kpis.overallProgressPct,
        tone: 'positive' as FioriStatusTone,
      },
    ],
    [kpis, statusCounts, statusFilter]
  );

  const filterSegments = useMemo(
    () => [
      { id: 'ALL', label: 'همه', count: statusCounts.ALL || 0 },
      { id: 'RELEASED', label: 'آماده تولید', count: statusCounts.RELEASED || 0 },
      { id: 'IN_PROGRESS', label: 'در حال تولید', count: statusCounts.IN_PROGRESS || 0 },
      { id: 'COMPLETED', label: 'تکمیل‌شده', count: statusCounts.COMPLETED || 0 },
      { id: 'PLANNED', label: 'برنامه‌ریزی‌شده', count: statusCounts.PLANNED || 0 },
    ],
    [statusCounts]
  );

  return (
    <FioriDynamicPage
      title="مدیریت دستورات ساخت (MO)"
      subtitle="صدور و رهگیری دستورات ساخت، شارژ سرکلاف OP10، ثبت خروجی ایستگاه‌ها و ابطال معکوس انبار"
      status={
        <FioriObjectStatus
          tone={kpis.activeOrders > 0 ? 'positive' : 'neutral'}
          label={`${toPersianDigits(kpis.activeOrders)} دستور فعال`}
          variant="dot"
          size="sm"
        />
      }
      activeFiltersCount={activeFiltersCount}
      onResetFilters={handleResetFilters}
      headerActions={
        <div className="flex items-center gap-2 flex-wrap">
          {onOpenVouchers && (
            <button
              type="button"
              onClick={onOpenVouchers}
              className="sap-btn-standard px-2.5 py-1.5 text-xs inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              title="ثبت قبض تکی کارگاه (MIGO)"
            >
              <FileText className="w-3.5 h-3.5 text-[var(--fiori-text-secondary)]" />
              <span>قبض تکی (MIGO)</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setIsVisualGuideOpen(true)}
            className="sap-btn-standard px-2.5 py-1.5 text-xs inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
          >
            <BookOpen className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
            <span>راهنمای تصویری</span>
          </button>
          <button
            type="button"
            onClick={fetchOrders}
            disabled={loading}
            className="sap-btn-standard px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>بروزرسانی</span>
          </button>
          <button
            type="button"
            onClick={() => setIsCreateMoOpen(true)}
            className="sap-btn-emphasized px-3 py-1.5 text-xs inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>صدور دستور ساخت جدید (MO)</span>
          </button>
        </div>
      }
      kpiStrip={<FioriKpiStrip items={kpiItems} loading={loading && orders.length === 0} columns={5} />}
      filterBar={
        <FioriFilterBar
          searchValue={searchQuery}
          onSearchChange={val => {
            setSearchQuery(val);
            if (!val && router.route.docQuery) router.clearDocQuery();
          }}
          searchPlaceholder="جستجوی شماره MO، کد یا نام قطعه، دستور مادر..."
          searchAriaLabel="جستجو در دستورات ساخت"
          segments={filterSegments}
          activeSegment={statusFilter}
          onSegmentChange={id => setStatusFilter(id as 'ALL' | ManufacturingOrderStatus)}
          hasActiveFilters={activeFiltersCount > 0}
          onReset={handleResetFilters}
        />
      }
    >
      {/* FEEDBACK BANNER */}
      {notice && (
        <FioriMessageStrip
          tone={
            notice.type === 'error'
              ? 'error'
              : notice.type === 'warning'
              ? 'warning'
              : 'success'
          }
          title={notice.title}
          onClose={() => setNotice(null)}
        >
          {notice.detail}
        </FioriMessageStrip>
      )}

      {/* MASTER-DETAIL MANUFACTURING ORDERS TABLE */}
      <FioriDataTable
        columns={moColumns}
        data={filteredOrders}
        rowKey={mo => mo.id}
        onRowClick={mo => toggleMoCard(mo.id)}
        expandedRowKeys={expandedMoCardsMap}
        renderExpandedRow={renderExpandedMoRow}
        loading={loading}
        loadingRows={6}
        error={fetchError}
        onRetry={fetchOrders}
        defaultSortKey="moNumber"
        defaultSortDirection="desc"
        toolbar={
          <FioriToolbar
            variant="table"
            title="فهرست دستورات ساخت (MO)"
            count={filteredOrders.length}
            countLabel="دستور"
            startContent={<Layers className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />}
            subtitle={
              filteredOrders.length > 0
                ? `بازشده: ${toPersianDigits(
                    expandedMoCardsCount(filteredOrders.map(o => o.id))
                  )} از ${toPersianDigits(filteredOrders.length)} · برای مشاهده جزئیات ایستگاه‌ها روی هر ردیف کلیک کنید`
                : undefined
            }
            endContent={
              filteredOrders.length > 0 ? (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => expandAllMoCards(filteredOrders.map(o => o.id))}
                    className="sap-btn-standard px-2.5 py-1 text-[11px] cursor-pointer whitespace-nowrap"
                  >
                    باز کردن همه
                  </button>
                  <button
                    type="button"
                    onClick={collapseAllMoCards}
                    className="sap-btn-standard px-2.5 py-1 text-[11px] cursor-pointer whitespace-nowrap"
                  >
                    بستن همه
                  </button>
                </div>
              ) : undefined
            }
          />
        }
        emptyState={
          <div className="p-6">
            <EmptyState
              variant={activeFiltersCount > 0 ? 'FILTER_NO_MATCH' : 'NO_DATA'}
              title={
                activeFiltersCount > 0
                  ? 'هیچ دستور ساختی با فیلتر انتخابی یافت نشد'
                  : 'هنوز هیچ دستور ساختی (MO) ثبت نشده است'
              }
              description={
                activeFiltersCount > 0
                  ? 'فیلتر وضعیت یا متن جستجو را پاکسازی کنید تا کل دستورات ساخت نمایش داده شوند.'
                  : 'برای شروع خط تولید، اولین دستور ساخت را صادر کنید یا از پیشنهادات MRP ایجاد نمایید.'
              }
              actionLabel={
                activeFiltersCount > 0
                  ? `نمایش همه دستورات (${toPersianDigits(orders.length)})`
                  : 'صدور دستور ساخت جدید (MO)'
              }
              onAction={
                activeFiltersCount > 0 ? handleResetFilters : () => setIsCreateMoOpen(true)
              }
              compact
            />
          </div>
        }
      />

      {/* SECONDARY COLLAPSIBLE OPERATIONAL GUIDE (BELOW WORKBENCH, NEVER BLOCKING TABLE) */}
      <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] overflow-hidden">
        <button
          type="button"
          onClick={toggleGuide}
          aria-expanded={showGuide}
          className="w-full px-3.5 py-2 bg-[var(--fiori-bg-subtle)] hover:bg-[var(--fiori-bg-hover)] flex items-center justify-between gap-2 text-right cursor-pointer transition-colors"
        >
          <div className="flex items-center gap-2 min-w-0">
            <BookOpen className="w-3.5 h-3.5 text-[var(--fiori-brand)] shrink-0" />
            <span className="text-xs font-semibold text-[var(--fiori-text-primary)] truncate">
              راهنمای ۴ گام عملیاتی: صدور سرکلاف، تعریف دستور ساخت (MO)، ثبت OP10 و حذف معکوس
            </span>
          </div>
          <span className="text-[11px] font-medium text-[var(--fiori-brand)] inline-flex items-center gap-1 shrink-0">
            <span>{showGuide ? 'بستن راهنما' : 'مشاهده خلاصه ۴ گام'}</span>
            {showGuide ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </span>
        </button>

        {showGuide && (
          <div className="p-3.5 border-t border-[var(--fiori-border-subtle)] text-xs">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              {/* STEP 1 */}
              <div className="p-3 bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] space-y-2 flex flex-col justify-between">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <FioriObjectStatus tone="brand" label="گام ۱: سرکلاف (رول ورق)" size="sm" />
                    <Disc className="w-4 h-4 text-[var(--fiori-brand)]" />
                  </div>
                  <p className="text-[11px] text-[var(--fiori-text-secondary)] leading-5">
                    رول ورق در بخش <strong>رول‌های ورق و کویل‌پک</strong> ثبت می‌شود. برای تغذیه ایستگاه برش (
                    <code className="fiori-ltr-code">OP10_SLIT</code>) از دکمه <strong>شارژ OP10</strong> در هر ردیف استفاده کنید.
                  </p>
                </div>
                <div className="pt-2 border-t border-[var(--fiori-border-subtle)]">
                  <button
                    type="button"
                    onClick={() => router.navigate({ tab: 'inventory', inventorySubTab: 'COILS' })}
                    className="sap-btn-standard px-2.5 py-1 text-[11px] inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Disc className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
                    <span>مدیریت رول‌های ورق</span>
                    <ArrowUpRight className="w-3 h-3" />
                  </button>
                </div>
              </div>

              {/* STEP 2 */}
              <div className="p-3 bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] space-y-2 flex flex-col justify-between">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <FioriObjectStatus tone="positive" label="گام ۲: صدور دستور ساخت" size="sm" />
                    <Cpu className="w-4 h-4 text-[var(--fiori-positive)]" />
                  </div>
                  <p className="text-[11px] text-[var(--fiori-text-secondary)] leading-5">
                    صدور MO هم به‌صورت خودکار از <strong>پیشنهادات MRP</strong> و هم به‌صورت مستقیم از دکمه <strong>صدور دستور ساخت جدید</strong> در بالای صفحه ممکن است.
                  </p>
                </div>
                <div className="pt-2 border-t border-[var(--fiori-border-subtle)] flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => router.navigate({ tab: 'planning', planningSubTab: 'recommendations' })}
                    className="sap-btn-standard px-2 py-1 text-[11px] inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Cpu className="w-3.5 h-3.5 text-[var(--fiori-positive)]" />
                    <span>پیشنهاد MRP</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsCreateMoOpen(true)}
                    className="sap-btn-emphasized px-2.5 py-1 text-[11px] inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>صدور MO</span>
                  </button>
                </div>
              </div>

              {/* STEP 3 */}
              <div className="p-3 bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] space-y-2 flex flex-col justify-between">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <FioriObjectStatus tone="critical" label="گام ۳: ثبت تولید و QC" size="sm" />
                    <FileCheck className="w-4 h-4 text-[var(--fiori-critical)]" />
                  </div>
                  <p className="text-[11px] text-[var(--fiori-text-secondary)] leading-5">
                    با ثبت خروجی سالم و ضایعات در هر ایستگاه، کسر مواد، انتقال خودکار به ایستگاه بعدی و کاردکس به‌صورت اتمیک ثبت می‌شود.
                  </p>
                </div>
                <div className="pt-2 border-t border-[var(--fiori-border-subtle)] text-[11px] text-[var(--fiori-positive)] font-medium flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>همگام‌سازی خودکار شیفت و کاردکس فعال است</span>
                </div>
              </div>

              {/* STEP 4 */}
              <div className="p-3 bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] space-y-2 flex flex-col justify-between">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <FioriObjectStatus tone="negative" label="گام ۴: رهگیری و ابطال امن" size="sm" />
                    <Trash2 className="w-4 h-4 text-[var(--fiori-negative)]" />
                  </div>
                  <p className="text-[11px] text-[var(--fiori-text-secondary)] leading-5">
                    در صورت لغو دستور ساخت، با گزینه حذف معکوس تمام حواله‌های مصرف و دستورات فرعی به‌صورت ایمن به انبار بازگردانده می‌شوند.
                  </p>
                </div>
                <div className="pt-2 border-t border-[var(--fiori-border-subtle)]">
                  <button
                    type="button"
                    onClick={() => router.navigate({ tab: 'wip', wipSubTab: 'UNIFIED_DIRECTORY' })}
                    className="sap-btn-standard px-2.5 py-1 text-[11px] inline-flex items-center gap-1 cursor-pointer"
                  >
                    <GitBranch className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
                    <span>کارتابل جریان ساخت (WIP)</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* MODAL 1: CREATE NEW MANUFACTURING ORDER (MO) */}
      <CreateMoModal
        isOpen={isCreateMoOpen}
        onClose={() => setIsCreateMoOpen(false)}
        parts={parts}
        routings={routings}
        onSubmit={handleCreateMo}
      />

      {/* MODAL 2: REGISTER OPERATION PRODUCTION & QC */}
      <OperationProductionModal
        isOpen={Boolean(activeProdOp)}
        onClose={() => setActiveProdOp(null)}
        operation={activeProdOp}
        onSubmit={handleRegisterOpProduction}
      />

      {/* MODAL 3: LOAD COIL / RAW MATERIAL INTO OP10 */}
      <FioriDialog
        isOpen={Boolean(loadMaterialOrder)}
        onClose={() => setLoadMaterialOrder(null)}
        title={
          loadMaterialOrder ? (
            <span className="flex items-center gap-1.5 flex-wrap">
              <span>بارگذاری سرکلاف / شیت ورودی به خط</span>
              <span className="fiori-ltr-code font-mono text-[var(--fiori-brand)]">
                ({loadMaterialOrder.moNumber})
              </span>
            </span>
          ) : (
            ''
          )
        }
        subtitle={
          loadMaterialOrder ? (
            <span>
              {loadMaterialOrder.partName}{' '}
              <span className="fiori-ltr-code font-mono">({loadMaterialOrder.partCode})</span>
            </span>
          ) : undefined
        }
        icon={<PackagePlus className="w-4 h-4" />}
        tone="brand"
        size="md"
        disableClose={isLoadingMaterial}
        footer={
          <div className="w-full flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                setLoadMaterialOrder(null);
                router.navigate({ tab: 'inventory', inventorySubTab: 'COILS' });
              }}
              className="text-[11px] font-semibold text-[var(--fiori-brand)] hover:underline cursor-pointer"
            >
              مدیریت رول‌های ورق و کویل‌پک ←
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setLoadMaterialOrder(null)}
                disabled={isLoadingMaterial}
                className="sap-btn-standard px-3.5 py-1.5 text-xs cursor-pointer"
              >
                انصراف
              </button>
              <button
                type="submit"
                form="mo-load-material-form"
                disabled={isLoadingMaterial || !loadMaterialSourceId}
                className="sap-btn-emphasized px-4 py-1.5 text-xs cursor-pointer disabled:opacity-50"
              >
                {isLoadingMaterial ? 'در حال ثبت...' : 'تایید و شارژ ورودی OP10'}
              </button>
            </div>
          </div>
        }
      >
        {loadMaterialOrder && (
          <form
            id="mo-load-material-form"
            onSubmit={handleLoadMaterialSubmit}
            className="space-y-3.5 text-xs"
          >
            <FioriMessageStrip tone="info" title="تغذیه ورودی ایستگاه اول (OP10)" compact>
              با ثبت این فرم، تعداد شیت/بلنک معادل سرکلاف در صف ورودی ایستگاه اول قرار می‌گیرد تا
              اپراتور بتواند خروجی <code className="fiori-ltr-code font-mono">OP10</code> را ثبت
              نماید.
            </FioriMessageStrip>

            <div className="space-y-1">
              <label className="font-semibold text-[var(--fiori-text-primary)] block">
                منبع موجودی انبار / کلاف (حواله اتمیک انبار){' '}
                <span className="text-[var(--fiori-negative)]">*</span>
              </label>
              <select
                required
                value={loadMaterialSourceId}
                onChange={e => setLoadMaterialSourceId(e.target.value)}
                disabled={materialSourcesLoading}
                className="fiori-input w-full p-2"
              >
                <option value="">
                  {materialSourcesLoading
                    ? 'در حال بارگذاری منابع موجودی انبار...'
                    : '-- انتخاب منبع موجودی آزاد از انبار --'}
                </option>
                {materialSources.map((src: any) => (
                  <option key={src.id} value={src.id}>
                    {src.partCode} — {src.partName} | {src.warehouseName} ({src.locationCode || '-'})
                    {src.coilId
                      ? ` | کلاف ${src.coilId}`
                      : src.lotNumber
                      ? ` | لات ${src.lotNumber}`
                      : ''}
                    {` | آزاد: ${formatNumber(src.quantityAvailable)} ${src.unitSymbol} (${formatNumber(
                      src.weightKgAvailable
                    )} kg)`}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="font-semibold text-[var(--fiori-text-primary)] block">
                  تعداد ورودی قابل تولید (عدد){' '}
                  <span className="text-[var(--fiori-negative)]">*</span>
                </label>
                <input
                  type="number"
                  min="1"
                  required
                  value={loadMaterialQty}
                  onChange={e => setLoadMaterialQty(e.target.value)}
                  className="fiori-input w-full p-2 font-mono font-semibold text-sm text-left"
                />
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-[var(--fiori-text-primary)] block">
                  شماره کلاف / ذوب یا توضیحات حواله
                </label>
                <input
                  type="text"
                  value={loadMaterialNotes}
                  onChange={e => setLoadMaterialNotes(e.target.value)}
                  placeholder="مثال: سرکلاف MOB-DC01A - ذوب HT-9921"
                  className="fiori-input w-full p-2"
                />
              </div>
            </div>
          </form>
        )}
      </FioriDialog>

      {/* MODAL 4: DELETE MO & CASCADING INVENTORY ROLLBACK */}
      <FioriDialog
        isOpen={Boolean(deleteTargetOrder)}
        onClose={() => setDeleteTargetOrder(null)}
        title={
          deleteTargetOrder ? (
            <span className="flex items-center gap-1.5 flex-wrap">
              <span>حذف دستور ساخت و بازگشت موجودی به انبار</span>
              <span className="fiori-ltr-code font-mono text-[var(--fiori-negative)]">
                ({deleteTargetOrder.moNumber})
              </span>
            </span>
          ) : (
            ''
          )
        }
        subtitle={
          deleteTargetOrder ? (
            <span>
              {deleteTargetOrder.partName}{' '}
              <span className="fiori-ltr-code font-mono">({deleteTargetOrder.partCode})</span>
            </span>
          ) : undefined
        }
        icon={<Trash2 className="w-4 h-4" />}
        tone="danger"
        size="md"
        disableClose={isDeleting}
        footer={
          <>
            <button
              type="button"
              onClick={() => setDeleteTargetOrder(null)}
              disabled={isDeleting}
              className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="mo-delete-rollback-form"
              disabled={isDeleting || deleteReason.trim().length < 5}
              className="fiori-btn-danger px-4 py-1.5 text-xs cursor-pointer inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>
                {isDeleting ? 'در حال حذف و بازگشت موجودی...' : 'تایید حذف و بازگشت موجودی'}
              </span>
            </button>
          </>
        }
      >
        {deleteTargetOrder && (
          <div className="space-y-3.5 text-xs">
            {previewLoading ? (
              <div className="p-4 text-center text-[var(--fiori-text-secondary)]">
                در حال محاسبه اسناد انبار و دستورات فرعی وابسته...
              </div>
            ) : (
              rollbackPreview && (
                <FioriMessageStrip tone="error" title="پیش‌نمایش تاثیر حذف و بازگشت به انبار:" compact>
                  <div className="space-y-1 text-[11px]">
                    <div>
                      • <strong>دستورات ساخت حذف‌شونده:</strong>{' '}
                      <span className="fiori-ltr-code font-mono">
                        {(rollbackPreview.mosToDelete || [])
                          .map((m: any) => m.moNumber)
                          .join(' , ') || deleteTargetOrder.moNumber}
                      </span>
                    </div>
                    <div>
                      • <strong>اسناد انبار جهت ابطال معکوس:</strong>{' '}
                      {toPersianDigits(rollbackPreview.documentsToReverseCount || 0)} سند
                    </div>
                    {Array.isArray(rollbackPreview.materialsToReturn) &&
                      rollbackPreview.materialsToReturn.length > 0 && (
                        <div>
                          • <strong>مواد اولیه بازگشتی به انبار:</strong>{' '}
                          {rollbackPreview.materialsToReturn
                            .map((m: any) => `${m.partName}: ${formatNumber(m.quantity)} ${m.unit}`)
                            .join(' | ')}
                        </div>
                      )}
                  </div>
                </FioriMessageStrip>
              )
            )}

            <form
              id="mo-delete-rollback-form"
              onSubmit={handleConfirmDeleteMo}
              className="space-y-3"
            >
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={cascadeSubMos}
                  onChange={e => setCascadeSubMos(e.target.checked)}
                  className="accent-[var(--fiori-brand)]"
                />
                <span className="font-medium text-[var(--fiori-text-primary)]">
                  حذف همزمان دستورات ساخت فرعی وابسته و بازگشت مواد آن‌ها
                </span>
              </label>

              <div className="space-y-1">
                <label className="font-semibold text-[var(--fiori-text-primary)] block">
                  علت حذف دستور ساخت (ثبت در لاگ ممیزی){' '}
                  <span className="text-[var(--fiori-negative)]">*</span>
                </label>
                <input
                  type="text"
                  required
                  minLength={5}
                  value={deleteReason}
                  onChange={e => setDeleteReason(e.target.value)}
                  className="fiori-input w-full p-2"
                />
              </div>
            </form>
          </div>
        )}
      </FioriDialog>

      {/* Interactive Visual Step-by-Step Guide Modal */}
      <MoRelationalGuideModal
        isOpen={isVisualGuideOpen}
        onClose={() => setIsVisualGuideOpen(false)}
        onOpenCreateMo={() => setIsCreateMoOpen(true)}
      />
    </FioriDynamicPage>
  );
};
