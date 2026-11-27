import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Layers,
  Plus,
  Search,
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
  FileCheck,
  GitBranch,
  X,
  PackagePlus,
  ListTree,
  Warehouse,
} from 'lucide-react';
import { Part, Routing } from '../../types/inventory';
import { ManufacturingOrder, ManufacturingOperation, ManufacturingOrderStatus } from '../../types/productionWip';
import { formatNumber, toPersianDigits } from '../../utils/formatters';
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
}

const STATUS_LABELS: Record<string, { label: string; tone: FioriStatusTone }> = {
  PLANNED: { label: 'برنامه‌ریزی‌شده (PLANNED)', tone: 'neutral' },
  RELEASED: { label: 'آزادشده / آماده تولید (RELEASED)', tone: 'brand' },
  IN_PROGRESS: { label: 'در حال تولید (IN_PROGRESS)', tone: 'critical' },
  COMPLETED: { label: 'تکمیل‌شده (COMPLETED)', tone: 'positive' },
  CLOSED: { label: 'بسته‌شده (CLOSED)', tone: 'neutral' },
  ON_HOLD: { label: 'متوقف / هولد (ON_HOLD)', tone: 'negative' },
};

export const ManufacturingOrdersManagementView: React.FC<ManufacturingOrdersManagementViewProps> = ({
  parts,
  routings,
  onRefreshData,
}) => {
  const router = useErpRouter();
  const [orders, setOrders] = useState<ManufacturingOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'ALL' | ManufacturingOrderStatus>('ALL');
  const [searchQuery, setSearchQuery] = useState(() => router.route.docQuery || '');
  const [showGuide, , toggleGuide] = usePersistedOpen('mo_mgmt_guide_open', false);
  const {
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
  const [notice, setNotice] = useState<{ type: 'success' | 'warning' | 'error'; title: string; detail: string } | null>(null);

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
  const [deleteReason, setDeleteReason] = useState('حذف دستور ساخت غیرضروری و بازگشت مواد مصرفی به انبار');
  const [cascadeSubMos, setCascadeSubMos] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/wip/manufacturing-orders');
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        setOrders(json.data);
      }
    } catch (err) {
      console.error('Failed to fetch manufacturing orders:', err);
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
        const matchMo = order.moNumber.toLowerCase().includes(q) || order.id.toLowerCase().includes(q);
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
    const activeOrders = orders.filter(o => o.status === 'IN_PROGRESS' || o.status === 'RELEASED').length;
    const completedOrders = orders.filter(o => o.status === 'COMPLETED').length;
    const totalTarget = orders.reduce((acc, o) => acc + (o.targetQuantity || 0), 0);
    const totalCompleted = orders.reduce((acc, o) => acc + (o.completedQuantity || 0), 0);
    const overallProgressPct = totalTarget > 0 ? Math.min(100, Math.round((totalCompleted / totalTarget) * 100)) : 0;
    return { totalOrders, activeOrders, completedOrders, totalTarget, totalCompleted, overallProgressPct };
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
  const handleRegisterOpProduction = async (payload: any): Promise<{ success: boolean; error?: string }> => {
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
        detail: json.message || 'آمار تولید سالم، کسر خودکار مواد (Backflush) و انتقال به مرحله بعد ثبت شد.',
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
      const firstOp = [...loadMaterialOrder.operations].sort((a, b) => a.stepNumber - b.stepNumber)[0];
      const activeUser = getActiveFactoryUser();
      const res = await fetch(`/api/wip/manufacturing-orders/${encodeURIComponent(loadMaterialOrder.id)}/load-material`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: firstOp?.id,
          quantity: qty,
          sourceStockBalanceId: loadMaterialSourceId,
          expectedVersion: loadMaterialOrder.version,
          operatorName: activeUser.displayName,
          notes: loadMaterialNotes.trim() || `تغذیه سرکلاف / شیت ورودی به ${firstOp?.stepCode || 'OP10'}`,
        }),
      });
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
          detail: `تعداد ${formatNumber(qty)} قطعه در صف ورودی ایستگاه ${firstOp?.stepCode || 'OP10'} قرار گرفت و آماده ثبت خروجی است.`,
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
        `/api/wip/manufacturing-orders/${encodeURIComponent(order.id)}/rollback-preview?cascadeSubMos=true`
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
      const res = await fetch(`/api/wip/manufacturing-orders/${encodeURIComponent(deleteTargetOrder.id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cascadeSubMos,
          reason: deleteReason.trim(),
          userId: activeUser.uid,
          userName: activeUser.displayName,
        }),
      });
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
          detail: json.message || 'کلیه حواله‌های مصرف مرتبط ابطال و موجودی رول/قطعات به انبار بازگشت.',
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

  return (
    <FioriDynamicPage
      title="مدیریت دستورات ساخت (MO)، شارژ سرکلاف OP10 و کنترل مراحل تولید"
      subtitle="صدور دستور ساخت، پیگیری موجودی صف و پای دستگاه در ایستگاه‌های مسیر، ثبت خروجی/ضایعات و ابطال معکوس انبار"
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
          <button
            type="button"
            onClick={() => setIsVisualGuideOpen(true)}
            className="sap-btn-standard px-2.5 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer text-[var(--fiori-brand)]"
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>راهنمای تصویری گام‌به‌گام</span>
          </button>
          <button
            type="button"
            onClick={fetchOrders}
            disabled={loading}
            className="sap-btn-standard px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>بروزرسانی</span>
          </button>
          <button
            type="button"
            onClick={() => setIsCreateMoOpen(true)}
            className="sap-btn-emphasized px-3 py-1.5 text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>صدور دستور ساخت جدید (MO)</span>
          </button>
        </div>
      }
      kpiStrip={
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
          <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3">
            <span className="text-[11px] text-[var(--fiori-text-secondary)] block">کل دستورات ساخت (MO)</span>
            <span className="text-lg font-bold font-mono tabular-nums text-[var(--fiori-text-primary)] mt-0.5 block">
              {toPersianDigits(kpis.totalOrders)} <span className="text-xs font-normal text-[var(--fiori-text-secondary)]">دستور</span>
            </span>
          </div>
          <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3">
            <span className="text-[11px] text-[var(--fiori-text-secondary)] block">دستورات فعال و در جریان</span>
            <span className="text-lg font-bold font-mono tabular-nums text-[var(--fiori-brand)] mt-0.5 block">
              {toPersianDigits(kpis.activeOrders)} <span className="text-xs font-normal text-[var(--fiori-text-secondary)]">در خط</span>
            </span>
          </div>
          <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3">
            <span className="text-[11px] text-[var(--fiori-text-secondary)] block">دستورات تکمیل‌شده</span>
            <span className="text-lg font-bold font-mono tabular-nums text-[var(--fiori-positive)] mt-0.5 block">
              {toPersianDigits(kpis.completedOrders)} <span className="text-xs font-normal text-[var(--fiori-text-secondary)]">تکمیل</span>
            </span>
          </div>
          <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3">
            <span className="text-[11px] text-[var(--fiori-text-secondary)] block">مجموع تیراژ هدف / تکمیل‌شده</span>
            <span className="text-sm font-bold font-mono tabular-nums text-[var(--fiori-text-primary)] mt-1 block">
              {formatNumber(kpis.totalCompleted)} / {formatNumber(kpis.totalTarget)}{' '}
              <span className="text-[11px] font-normal text-[var(--fiori-text-secondary)]">PCS</span>
            </span>
          </div>
          <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3 col-span-2 sm:col-span-1">
            <div className="flex items-center justify-between text-[11px] text-[var(--fiori-text-secondary)]">
              <span>پیشرفت کل دستورات</span>
              <span className="font-mono font-bold tabular-nums text-[var(--fiori-positive)]">
                {toPersianDigits(kpis.overallProgressPct)}٪
              </span>
            </div>
            <div className="w-full h-2 bg-[var(--fiori-border-subtle)] rounded-[var(--fiori-radius-sm)] overflow-hidden mt-2">
              <div
                className="h-full bg-[var(--fiori-positive)] transition-all"
                style={{ width: `${kpis.overallProgressPct}%` }}
              />
            </div>
          </div>
        </div>
      }
      filterBar={
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          {/* Status Filter Buttons */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {[
              { id: 'ALL' as const, label: 'همه دستورات' },
              { id: 'RELEASED' as const, label: 'آماده تولید (RELEASED)' },
              { id: 'IN_PROGRESS' as const, label: 'در حال تولید (IN_PROGRESS)' },
              { id: 'COMPLETED' as const, label: 'تکمیل‌شده (COMPLETED)' },
              { id: 'PLANNED' as const, label: 'برنامه‌ریزی‌شده (PLANNED)' },
            ].map(st => {
              const active = statusFilter === st.id;
              const count = statusCounts[st.id] || 0;
              return (
                <button
                  key={st.id}
                  type="button"
                  onClick={() => setStatusFilter(st.id)}
                  className={`px-3 py-1.5 rounded-[var(--fiori-radius-sm)] text-xs font-semibold border transition cursor-pointer flex items-center gap-1.5 ${
                    active
                      ? 'bg-[var(--fiori-brand)] text-white border-[var(--fiori-brand)]'
                      : 'bg-white text-[var(--fiori-text-primary)] border-[var(--fiori-border-input)] hover:bg-[var(--fiori-bg-hover)]'
                  }`}
                >
                  <span>{st.label}</span>
                  <span
                    className={`px-1.5 py-0.2 rounded-[var(--fiori-radius-sm)] text-[10px] font-mono ${
                      active ? 'bg-white/20 text-white' : 'bg-[var(--fiori-bg-subtle)] text-[var(--fiori-text-secondary)]'
                    }`}
                  >
                    {toPersianDigits(count)}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Search */}
          <div className="relative min-w-[240px] flex-1 sm:flex-initial">
            <Search className="w-3.5 h-3.5 text-[var(--fiori-text-secondary)] absolute right-2.5 top-2" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="جستجوی شماره MO، کد یا نام قطعه..."
              className="w-full bg-white border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] pr-8 pl-7 py-1.5 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-border-focus)]"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  if (router.route.docQuery) router.clearDocQuery();
                }}
                title="پاک‌کردن فیلتر جستجو"
                className="absolute left-2 top-1.5 text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-negative)] cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      }
    >
      {/* STEP-BY-STEP INTERACTIVE USER GUIDE FOR COIL ISSUE, MO & OP10 FIX */}
      <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-brand-border)] rounded-[var(--fiori-radius-md)] overflow-hidden">
        <div className="px-3.5 py-2 bg-[var(--fiori-brand-bg)]/60 border-b border-[var(--fiori-brand-border)]/60 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <BookOpen className="w-4 h-4 text-[var(--fiori-brand)] shrink-0" />
            <span className="text-xs font-bold text-[var(--fiori-text-primary)] truncate">
              راهنمای گام‌به‌گام صدور سرکلاف، تعریف دستور ساخت (MO) معتبر و رفع خطای OP10
            </span>
          </div>
          <button
            type="button"
            onClick={toggleGuide}
            className="text-[11px] font-semibold text-[var(--fiori-brand)] flex items-center gap-1 bg-white px-2.5 py-1 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-brand-border)] hover:bg-[var(--fiori-brand-bg)] cursor-pointer shrink-0"
          >
            <span>{showGuide ? 'بستن خلاصه متنی' : 'خلاصه ۴ گام'}</span>
            {showGuide ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>

        {showGuide && (
          <div className="p-3.5 space-y-3 text-xs">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              {/* STEP 1 */}
              <div className="p-3 bg-white border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] space-y-2 flex flex-col justify-between">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <FioriObjectStatus tone="brand" label="گام ۱: صدور سرکلاف تولید (رول ورق)" size="sm" />
                    <Disc className="w-4 h-4 text-[var(--fiori-brand)]" />
                  </div>
                  <h4 className="font-bold text-[var(--fiori-text-primary)]">سر کلاف تولید از کجا صادر می‌شود؟</h4>
                  <p className="text-[11px] text-[var(--fiori-text-secondary)] leading-5">
                    ۱. از <strong>«انبار و کیفیت (MM/QM) ← رول‌های ورق و کویل‌پک»</strong>، رول ورق با شماره ذوب (Heat Number) ثبت و آزاد می‌شود.
                    <br />
                    ۲. برای ارسال سرکلاف پای دستگاه برش (<code>OP10_SLIT</code>)، در جدول رول‌ها دکمه <strong>«ثبت مصرف/برش کلاف»</strong> را بزنید <strong>یا</strong> در همین صفحه روی کارت دستور ساخت، دکمه <strong>«بارگذاری سرکلاف / مواد به OP10»</strong> را کلیک کنید.
                    <br />
                    ۳. همچنین هنگام ثبت خروجی سالم در <code>OP10_SLIT</code>، سیستم به صورت خودکار وزن ورق مصرفی را از سرکلاف فعال کسر می‌کند (سند <code>ISS-WIP-*</code>).
                  </p>
                </div>
                <div className="pt-2 border-t border-[var(--fiori-border-subtle)] flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => router.navigate({ tab: 'inventory', inventorySubTab: 'COILS' })}
                    className="sap-btn-standard px-2.5 py-1 text-[11px] font-semibold flex items-center gap-1 cursor-pointer text-[var(--fiori-brand)]"
                  >
                    <Disc className="w-3.5 h-3.5" />
                    <span>مدیریت رول‌های ورق و صدور سرکلاف</span>
                    <ArrowUpRight className="w-3 h-3" />
                  </button>
                </div>
              </div>

              {/* STEP 2 */}
              <div className="p-3 bg-white border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] space-y-2 flex flex-col justify-between">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <FioriObjectStatus tone="positive" label="گام ۲: تعریف دستور ساخت (MO) معتبر" size="sm" />
                    <Cpu className="w-4 h-4 text-[var(--fiori-positive)]" />
                  </div>
                  <h4 className="font-bold text-[var(--fiori-text-primary)]">چگونه از MRP یا میز کار دستور ساخت بسازیم؟</h4>
                  <p className="text-[11px] text-[var(--fiori-text-secondary)] leading-5">
                    <strong>مسیر اول (اتوماتیک از MRP):</strong> به <strong>«برنامه‌ریزی و MRP ← پیشنهاد برنامه و پرس‌ها»</strong> بروید، پیشنهاد تولید قطعه را انتخاب کرده و روی <strong>«تأیید پیشنهاد و صدور فوری دستور کار (MO)»</strong> کلیک کنید.
                    <br />
                    <strong>مسیر دوم (مستقیم از میز کار تولید):</strong> روی دکمه <strong>«+ صدور دستور ساخت جدید (MO)»</strong> کلیک کنید، قطعه و تیراژ هدف را انتخاب و ثبت نمایید.
                  </p>
                </div>
                <div className="pt-2 border-t border-[var(--fiori-border-subtle)] flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => router.navigate({ tab: 'planning', planningSubTab: 'recommendations' })}
                    className="sap-btn-standard px-2 py-1 text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                  >
                    <Cpu className="w-3.5 h-3.5 text-[var(--fiori-positive)]" />
                    <span>صدور MO از پیشنهاد MRP</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsCreateMoOpen(true)}
                    className="sap-btn-emphasized px-2.5 py-1 text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>صدور فوری MO جدید</span>
                  </button>
                </div>
              </div>

              {/* STEP 3 */}
              <div className="p-3 bg-white border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] space-y-2 flex flex-col justify-between">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <FioriObjectStatus tone="critical" label="گام ۳: ثبت خروجی تولید و QC (OP10_SLIT)" size="sm" />
                    <FileCheck className="w-4 h-4 text-[var(--fiori-critical)]" />
                  </div>
                  <h4 className="font-bold text-[var(--fiori-text-primary)]">چرا خطای دستور ساخت در OP10 رخ می‌داد و چگونه رفع شد؟</h4>
                  <p className="text-[11px] text-[var(--fiori-text-secondary)] leading-5">
                    خطای <em>«برای این کد قطعه دستور ساخت relational متناظر پیدا نشد»</em> زمانی رخ می‌داد که جدول ارتباطی دیتابیس با دستور ساخت جاری همگام نبود.
                    <br />
                    اکنون با کلیک روی <strong>«ثبت خروجی و QC»</strong> در هر مرحله (<code>OP10_SLIT</code> تا مرحله نهایی)، دستور ساخت متناظر، شیفت و اپراتور به صورت <strong>خودکار</strong> انتخاب می‌شوند.
                  </p>
                </div>
                <div className="pt-2 border-t border-[var(--fiori-border-subtle)] text-[11px] text-[var(--fiori-positive)] font-semibold flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>همگام‌سازی خودکار دستور ساخت، شیفت و کسر کلاف فعال است</span>
                </div>
              </div>

              {/* STEP 4 */}
              <div className="p-3 bg-white border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] space-y-2 flex flex-col justify-between">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <FioriObjectStatus tone="negative" label="گام ۴: رهگیری پیشرفت و حذف دستورات ساخت" size="sm" />
                    <Trash2 className="w-4 h-4 text-[var(--fiori-negative)]" />
                  </div>
                  <h4 className="font-bold text-[var(--fiori-text-primary)]">کجا دستورات تولید را ببینم، رهگیری و حذف کنم؟</h4>
                  <p className="text-[11px] text-[var(--fiori-text-secondary)] leading-5">
                    در جدول زیر تمام دستورات ساخت (<code>MO</code>) به همراه <strong>فیلتر وضعیت</strong>، <strong>درصد پیشرفت</strong> و وضعیت لحظه‌ای هر ایستگاه نمایش داده می‌شوند.
                    <br />
                    برای حذف هر دستور ساخت غیرضروری، روی دکمه <strong>«حذف و بازگشت موجودی»</strong> کلیک کنید تا تمام حواله‌های مصرف و دستورات فرعی معکوس شوند.
                  </p>
                </div>
                <div className="pt-2 border-t border-[var(--fiori-border-subtle)] flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => router.navigate({ tab: 'wip', wipSubTab: 'UNIFIED_DIRECTORY' })}
                    className="sap-btn-standard px-2.5 py-1 text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                  >
                    <GitBranch className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
                    <span>مشاهده نمای درختی کارتابل WIP</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* FEEDBACK BANNER */}
      {notice && (
        <FioriMessageStrip
          tone={notice.type === 'error' ? 'error' : notice.type === 'warning' ? 'warning' : 'success'}
          title={notice.title}
          onClose={() => setNotice(null)}
        >
          {notice.detail}
        </FioriMessageStrip>
      )}

      {/* MANUFACTURING ORDERS LIST & PER-OPERATION PROGRESS */}
      {filteredOrders.length === 0 ? (
        <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-6">
          <EmptyState
            variant={activeFiltersCount > 0 ? 'FILTER_NO_MATCH' : 'NO_DATA'}
            title="هیچ دستور ساختی با فیلتر انتخابی یافت نشد"
            description="می‌توانید فیلتر وضعیت را پاکسازی کنید یا یک دستور ساخت جدید صادر نمایید."
            actionLabel={statusFilter !== 'ALL' ? `نمایش همه دستورات (${toPersianDigits(orders.length)})` : 'صدور دستور ساخت جدید (MO)'}
            onAction={statusFilter !== 'ALL' ? handleResetFilters : () => setIsCreateMoOpen(true)}
            compact
          />
        </div>
      ) : (
        <div className="space-y-3">
          <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] overflow-hidden">
            <FioriToolbar
              variant="table"
              title={`کل دستورات: ${toPersianDigits(filteredOrders.length)} · بازشده: ${toPersianDigits(
                expandedMoCardsCount(filteredOrders.map(o => o.id))
              )}`}
              startContent={<Layers className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />}
              endContent={
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
              }
            />
          </div>

          {filteredOrders.map(mo => {
            const isCardExpanded = isMoCardExpanded(mo.id);
            const stMeta = STATUS_LABELS[mo.status] || {
              label: mo.status,
              tone: 'neutral' as FioriStatusTone,
            };
            const sortedOps = [...(mo.operations || [])].sort((a, b) => a.stepNumber - b.stepNumber);
            const totalOps = sortedOps.length;
            const completedOps = sortedOps.filter(o => o.status === 'COMPLETED').length;
            const activeOp =
              sortedOps.find(o => o.inProgressQty > 0) ||
              sortedOps.find(o => o.waitingInputQty > 0) ||
              sortedOps.find(o => o.readyForTransferQty > 0) ||
              sortedOps.find(o => o.status !== 'COMPLETED');
            const totalWaiting = sortedOps.reduce((s, o) => s + (o.waitingInputQty || 0), 0);
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

            const opColumns: FioriTableColumn<ManufacturingOperation>[] = [
              {
                key: 'stepCode',
                header: 'کد ایستگاه (OP)',
                width: '7rem',
                nowrap: true,
                render: (op, idx) => (
                  <div className="flex items-center gap-1">
                    <span className="font-mono font-bold text-[var(--fiori-text-primary)] fiori-ltr-code">
                      {op.stepCode}
                    </span>
                    {idx === 0 && <FioriObjectStatus tone="brand" label="ورودی سرکلاف" size="sm" />}
                    {idx === sortedOps.length - 1 && (
                      <FioriObjectStatus tone="positive" label="نهایی" size="sm" />
                    )}
                  </div>
                ),
              },
              {
                key: 'stepName',
                header: 'شرح عملیات تولید',
                render: op => (
                  <span className="font-medium text-[var(--fiori-text-primary)]">{op.stepName}</span>
                ),
              },
              {
                key: 'machineName',
                header: 'دستگاه / ایستگاه کاری',
                nowrap: true,
                render: op => (
                  <span className="text-[var(--fiori-text-secondary)]">
                    {op.machineName || 'ایستگاه استاندارد'}
                  </span>
                ),
              },
              {
                key: 'status',
                header: 'وضعیت ایستگاه',
                width: '8rem',
                render: op => (
                  <FioriObjectStatus
                    tone={
                      op.status === 'COMPLETED'
                        ? 'positive'
                        : op.status === 'IN_PROGRESS' || op.status === 'READY'
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
                        : 'در انتظار مرحله قبل'
                    }
                    size="sm"
                  />
                ),
              },
              {
                key: 'waitingInputQty',
                header: 'صف ورودی (PCS)',
                isMono: true,
                width: '7rem',
                render: op => (
                  <span className="font-semibold text-[var(--fiori-brand)]">
                    {formatNumber(op.waitingInputQty || 0)}
                  </span>
                ),
              },
              {
                key: 'inProgressQty',
                header: 'پای دستگاه (PCS)',
                isMono: true,
                width: '7rem',
                render: op => (
                  <span className="font-semibold text-[var(--fiori-critical)]">
                    {formatNumber(op.inProgressQty || 0)}
                  </span>
                ),
              },
              {
                key: 'output',
                header: 'خروجی سالم / هدف',
                isMono: true,
                width: '8rem',
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
                isMono: true,
                width: '6rem',
                render: op => (
                  <span className="text-[var(--fiori-negative)]">
                    {formatNumber(op.scrapQty || 0)}
                  </span>
                ),
              },
              {
                key: 'actions',
                header: 'عملیات ثبت خروجی و QC',
                align: 'left',
                width: '11rem',
                nowrap: true,
                render: op => {
                  const availableToProduce = (op.inProgressQty || 0) + (op.waitingInputQty || 0);
                  return (
                    <button
                      type="button"
                      onClick={() => setActiveProdOp(op)}
                      className={`px-2.5 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-bold cursor-pointer inline-flex items-center gap-1 transition ${
                        availableToProduce > 0
                          ? 'bg-[var(--fiori-positive)] hover:bg-[#0d6832] text-white'
                          : 'bg-white hover:bg-[var(--fiori-bg-hover)] text-[var(--fiori-text-primary)] border border-[var(--fiori-border-input)]'
                      }`}
                    >
                      <Play className="w-3 h-3" />
                      <span>ثبت خروجی و QC ({op.stepCode})</span>
                    </button>
                  );
                },
              },
            ];

            return (
              <div
                key={mo.id}
                className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)] overflow-hidden"
              >
                {/* MO Header */}
                <div
                  onClick={() => toggleMoCard(mo.id)}
                  className={`px-4 py-3 bg-[var(--fiori-bg-subtle)] flex flex-col xl:flex-row xl:items-center justify-between gap-3 text-xs cursor-pointer hover:bg-[var(--fiori-bg-hover)] transition-colors ${
                    isCardExpanded ? 'border-b border-[var(--fiori-border-default)]' : ''
                  }`}
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      {isCardExpanded ? (
                        <ChevronUp className="w-4 h-4 text-[var(--fiori-brand)] shrink-0" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-[var(--fiori-text-secondary)] shrink-0" />
                      )}
                      <span className="font-mono font-bold text-sm text-[var(--fiori-brand)] bg-[var(--fiori-brand-bg)] border border-[var(--fiori-brand-border)] px-2.5 py-0.5 rounded-[var(--fiori-radius-sm)] fiori-ltr-code">
                        {mo.moNumber}
                      </span>
                      <span className="font-bold text-sm text-[var(--fiori-text-primary)]">{mo.partName}</span>
                      <span className="font-mono text-xs text-[var(--fiori-text-secondary)] bg-white border border-[var(--fiori-border-default)] px-2 py-0.5 rounded-[var(--fiori-radius-sm)]">
                        کد قطعه: <span className="fiori-ltr-code">{mo.partCode}</span>
                      </span>
                      <FioriObjectStatus tone={stMeta.tone} label={stMeta.label} size="sm" />
                      {mo.parentMoNumber && (
                        <FioriObjectStatus
                          tone="critical"
                          label={`فرعیِ دستور: ${mo.parentMoNumber}`}
                          size="sm"
                        />
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-[var(--fiori-text-secondary)] flex-wrap">
                      <span>مسیر فرآیند: نسخه {mo.routingVersion || '1.0'}</span>
                      <span>·</span>
                      <span>
                        مراحل تکمیل‌شده: {toPersianDigits(completedOps)} از {toPersianDigits(totalOps)} ایستگاه
                      </span>
                      {activeOp && (
                        <>
                          <span>·</span>
                          <span className="text-[var(--fiori-brand)] font-semibold">
                            ایستگاه فعال: <span className="font-mono fiori-ltr-code">{activeOp.stepCode}</span> ({activeOp.stepName})
                          </span>
                        </>
                      )}
                      {totalWaiting > 0 && (
                        <>
                          <span>·</span>
                          <span className="text-[var(--fiori-critical)] font-semibold font-mono tabular-nums">
                            صف ورودی: {formatNumber(totalWaiting)}
                          </span>
                        </>
                      )}
                      {mo.startDate && (
                        <>
                          <span>·</span>
                          <span>تاریخ شروع: {mo.startDate}</span>
                        </>
                      )}
                      {mo.notes && (
                        <>
                          <span>·</span>
                          <span className="text-[var(--fiori-text-primary)]">{mo.notes}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Progress & Primary MO Actions */}
                  <div
                    className="flex flex-col sm:flex-row sm:items-center gap-3"
                    onClick={e => e.stopPropagation()}
                  >
                    {/* Quantities & Progress Bar */}
                    <div className="min-w-[230px] bg-white border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] px-3 py-1.5 space-y-1">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-[var(--fiori-text-secondary)]">
                          تحقق: <strong className="text-[var(--fiori-positive)] font-mono">{formatNumber(mo.completedQuantity)}</strong> از{' '}
                          <strong className="text-[var(--fiori-text-primary)] font-mono">{formatNumber(mo.targetQuantity)}</strong> عدد
                        </span>
                        <span className="font-mono font-bold text-[var(--fiori-brand)]">
                          {toPersianDigits(displayProgressPct)}٪
                        </span>
                      </div>
                      <div className="w-full h-2 bg-[var(--fiori-border-subtle)] rounded-[var(--fiori-radius-sm)] overflow-hidden">
                        <div
                          className={`h-full transition-all ${
                            displayProgressPct >= 100 ? 'bg-[var(--fiori-positive)]' : 'bg-[var(--fiori-brand)]'
                          }`}
                          style={{ width: `${displayProgressPct}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-[var(--fiori-text-secondary)] font-mono">
                        <span>ورودی خط: {formatNumber(mo.initialInputQuantity)}</span>
                        <span className="text-[var(--fiori-negative)]">ضایعات کل: {formatNumber(mo.totalScrapQuantity)}</span>
                      </div>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <button
                        type="button"
                        onClick={() => toggleMoCard(mo.id)}
                        className="sap-btn-standard px-2.5 py-1.5 text-[11px] font-semibold flex items-center gap-1 cursor-pointer whitespace-nowrap"
                      >
                        <span>{isCardExpanded ? 'بستن مراحل' : 'مشاهده مراحل'}</span>
                        {isCardExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setLoadMaterialOrder(mo);
                          setLoadMaterialQty(String(mo.targetQuantity || 500));
                          setLoadMaterialNotes('');
                        }}
                        className="sap-btn-standard px-2.5 py-1.5 text-[11px] font-semibold flex items-center gap-1 cursor-pointer text-[var(--fiori-brand)]"
                        title="تغذیه سرکلاف یا شیت ورودی به ایستگاه اول (OP10)"
                      >
                        <PackagePlus className="w-3.5 h-3.5" />
                        <span>بارگذاری سرکلاف / مواد (OP10)</span>
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          router.navigate({
                            tab: 'wip',
                            wipSubTab: 'UNIFIED_DIRECTORY',
                            moId: mo.id,
                          })
                        }
                        className="sap-btn-standard px-2.5 py-1.5 text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                        title="مشاهده پرونده کامل و درخت رهگیری در کارتابل WIP"
                      >
                        <GitBranch className="w-3.5 h-3.5" />
                        <span>رهگیری در WIP</span>
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
                        className="sap-btn-standard px-2.5 py-1.5 text-[11px] font-semibold flex items-center gap-1 cursor-pointer text-[var(--fiori-brand)]"
                        title="مشاهده درخت محصول (BOM) مرتبط با این قطعه"
                      >
                        <ListTree className="w-3.5 h-3.5" />
                        <span>درخت محصول (BOM)</span>
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
                        className="sap-btn-standard px-2.5 py-1.5 text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                        title="مشاهده موجودی انبار و کاردکس مرتبط با این قطعه"
                      >
                        <Warehouse className="w-3.5 h-3.5 text-[var(--fiori-positive)]" />
                        <span>کاردکس انبار</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleOpenDeleteModal(mo)}
                        className="px-2.5 py-1.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-negative-border)] bg-[var(--fiori-negative-bg)] hover:bg-[#fbd0d0] text-[var(--fiori-negative)] text-[11px] font-bold flex items-center gap-1 cursor-pointer transition"
                        title="حذف کامل دستور ساخت و بازگشت مواد مصرفی به انبار"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>حذف و بازگشت موجودی</span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Operations Table for this MO */}
                {isCardExpanded && (
                  <FioriDataTable
                    columns={opColumns}
                    data={sortedOps}
                    rowKey={op => op.id}
                    bordered={false}
                    emptyState={<EmptyState variant="NO_DATA" title="مرحله عملیاتی یافت نشد" compact />}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

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
        title={loadMaterialOrder ? `بارگذاری سرکلاف / شیت ورودی به خط (${loadMaterialOrder.moNumber})` : ''}
        subtitle={loadMaterialOrder ? `${loadMaterialOrder.partName} (${loadMaterialOrder.partCode})` : undefined}
        icon={<PackagePlus className="w-4 h-4" />}
        tone="brand"
        size="sm"
        disableClose={isLoadingMaterial}
        footer={
          <div className="w-full flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                setLoadMaterialOrder(null);
                router.navigate({ tab: 'inventory', inventorySubTab: 'COILS' });
              }}
              className="text-[11px] font-semibold text-[var(--fiori-brand)] hover:underline cursor-pointer"
            >
              رفتن به جدول رول‌های ورق و کویل‌پک ←
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
                className="sap-btn-emphasized px-4 py-1.5 text-xs font-bold cursor-pointer disabled:opacity-50"
              >
                {isLoadingMaterial ? 'در حال ثبت...' : 'تایید و شارژ ورودی OP10'}
              </button>
            </div>
          </div>
        }
      >
        {loadMaterialOrder && (
          <form id="mo-load-material-form" onSubmit={handleLoadMaterialSubmit} className="space-y-3.5 text-xs">
            <FioriMessageStrip tone="info" title="تغذیه ورودی ایستگاه اول (OP10)" compact>
              با ثبت این فرم، تعداد شیت/بلنک معادل سرکلاف در صف ورودی ایستگاه اول قرار می‌گیرد تا اپراتور بتواند بدون خطای کمبود موجودی، خروجی <code>OP10</code> را ثبت نماید.
            </FioriMessageStrip>

            <div className="space-y-1">
              <label className="font-bold text-[var(--fiori-text-primary)] block">
                منبع موجودی انبار / کلاف (حواله اتمیک انبار) *
              </label>
              <select
                required
                value={loadMaterialSourceId}
                onChange={e => setLoadMaterialSourceId(e.target.value)}
                disabled={materialSourcesLoading}
                className="w-full bg-white border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-border-focus)]"
              >
                <option value="">
                  {materialSourcesLoading ? 'در حال بارگذاری منابع موجودی انبار...' : '-- انتخاب منبع موجودی آزاد از انبار --'}
                </option>
                {materialSources.map((src: any) => (
                  <option key={src.id} value={src.id}>
                    {src.partCode} — {src.partName} | {src.warehouseName} ({src.locationCode || '-'})
                    {src.coilId ? ` | کلاف ${src.coilId}` : src.lotNumber ? ` | لات ${src.lotNumber}` : ''}
                    {` | آزاد: ${formatNumber(src.quantityAvailable)} ${src.unitSymbol} (${formatNumber(src.weightKgAvailable)} kg)`}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="font-bold text-[var(--fiori-text-primary)] block">
                تعداد ورودی قابل تولید از سرکلاف / پالت ورق (PCS) *
              </label>
              <input
                type="number"
                min="1"
                required
                value={loadMaterialQty}
                onChange={e => setLoadMaterialQty(e.target.value)}
                className="w-full bg-white border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 font-mono font-bold text-sm text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-border-focus)]"
              />
            </div>

            <div className="space-y-1">
              <label className="font-bold text-[var(--fiori-text-primary)] block">شماره کلاف / ذوب یا توضیحات حواله</label>
              <input
                type="text"
                value={loadMaterialNotes}
                onChange={e => setLoadMaterialNotes(e.target.value)}
                placeholder="مثال: سرکلاف MOB-DC01A-2.0-1140-A - ذوب HT-DC01A-9921"
                className="w-full bg-white border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-border-focus)]"
              />
            </div>
          </form>
        )}
      </FioriDialog>

      {/* MODAL 4: DELETE MO & CASCADING INVENTORY ROLLBACK */}
      <FioriDialog
        isOpen={Boolean(deleteTargetOrder)}
        onClose={() => setDeleteTargetOrder(null)}
        title={deleteTargetOrder ? `حذف کامل دستور ساخت و بازگشت موجودی به انبار (${deleteTargetOrder.moNumber})` : ''}
        subtitle={deleteTargetOrder ? `${deleteTargetOrder.partName} (${deleteTargetOrder.partCode})` : undefined}
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
              disabled={isDeleting}
              className="px-4 py-1.5 bg-[var(--fiori-negative)] hover:bg-[#990000] text-white rounded-[var(--fiori-radius-sm)] text-xs font-bold cursor-pointer inline-flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{isDeleting ? 'در حال حذف و بازگشت موجودی...' : 'تایید حذف کامل و بازگشت موجودی'}</span>
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
                      {(rollbackPreview.mosToDelete || []).map((m: any) => m.moNumber).join(' ، ') ||
                        deleteTargetOrder.moNumber}
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

            <form id="mo-delete-rollback-form" onSubmit={handleConfirmDeleteMo} className="space-y-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={cascadeSubMos}
                  onChange={e => setCascadeSubMos(e.target.checked)}
                />
                <span className="font-semibold text-[var(--fiori-text-primary)]">
                  حذف همزمان دستورات ساخت فرعی وابسته (Sub-MOs) و بازگشت مواد آن‌ها
                </span>
              </label>

              <div className="space-y-1">
                <label className="font-bold text-[var(--fiori-text-primary)] block">
                  علت حذف دستور ساخت (ثبت در لاگ ممیزی) *
                </label>
                <input
                  type="text"
                  required
                  minLength={5}
                  value={deleteReason}
                  onChange={e => setDeleteReason(e.target.value)}
                  className="w-full bg-white border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-negative)]"
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
