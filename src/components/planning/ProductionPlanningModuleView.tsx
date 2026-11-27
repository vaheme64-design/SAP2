import React, { useState, useEffect } from 'react';
import {
  TrendingUp,
  Cpu,
  FileSpreadsheet,
  CheckCircle2,
  Calendar,
  Layers,
  AlertTriangle,
  Plus,
  RefreshCw,
  Search,
  Filter,
  Package,
  Send,
  GitBranch,
  Clock,
  Building2,
  FileText,
  Calculator,
  Edit3,
  RotateCcw,
} from 'lucide-react';
import {
  CustomerOrder,
  PartNetRequirement,
  ProductionPlanSuggestion,
  PlanningDashboardMetrics,
} from '../../types/productionPlanning';
import { Part, Machine, DieMold, Routing } from '../../types/inventory';
import { PlanningDashboardView } from './PlanningDashboardView';
import { RelationalPlanProposalView } from './RelationalPlanProposalView';
import { NewCustomerOrderModal } from './NewCustomerOrderModal';
import { MrpModuleView } from './MrpModuleView';
import { ConsumablesForecastView } from './ConsumablesForecastView';
import { DailyProductionScheduleView } from './DailyProductionScheduleView';
import { ErpProductionWorkbenchView } from '../production/ErpProductionWorkbenchView';
import { ProductionWorkflowDocumentationView } from './ProductionWorkflowDocumentationView';
import { MachineCapacityTimelineView } from './MachineCapacityTimelineView';
import { formatNumber, toPersianDigits } from '../../utils/formatters';
import { formatToJalali } from '../../utils/jalali';
import { PlanningModuleSkeleton } from '../ui/Skeleton';
import { useEnterpriseUx } from '../../context/EnterpriseUxContext';
import { useErpRouter } from '../../context/RouterContext';
import { InlinePageGuideButton } from '../common/PageGuideSystem';
import {
  FioriMessageStrip,
  FioriObjectStatus,
  FioriToolbar,
} from '../fiori/ui';
import { EmptyState } from '../common/EmptyState';

export type PlanningSubTabKey =
  | 'erp_workbench'
  | 'workflow_doc'
  | 'dashboard'
  | 'daily_schedule'
  | 'capacity_planning'
  | 'mrp'
  | 'consumables'
  | 'recommendations'
  | 'orders'
  | 'approved_plans';

interface ProductionPlanningModuleViewProps {
  parts: Part[];
  routings?: Routing[];
  machines: Machine[];
  dies: DieMold[];
  initialSubTab?: PlanningSubTabKey;
  onSubTabChange?: (tab: PlanningSubTabKey) => void;
  onGlobalRefresh?: () => Promise<void>;
}

export const ProductionPlanningModuleView: React.FC<ProductionPlanningModuleViewProps> = ({
  parts,
  routings = [],
  machines,
  dies,
  initialSubTab = 'mrp',
  onSubTabChange,
  onGlobalRefresh,
}) => {
  const [activeSubTab, setActiveSubTab] = useState<PlanningSubTabKey>(
    initialSubTab === 'erp_workbench' ? 'mrp' : initialSubTab
  );

  useEffect(() => {
    if (initialSubTab) {
      setActiveSubTab(initialSubTab === 'erp_workbench' ? 'mrp' : initialSubTab);
    }
  }, [initialSubTab]);

  const router = useErpRouter();
  const { requestConfirm, showUndoToast, recordAudit } = useEnterpriseUx();

  const handleSelectSubTab = (tab: PlanningSubTabKey) => {
    setActiveSubTab(tab);
    if (onSubTabChange) onSubTabChange(tab);
    router.navigate({ planningSubTab: tab });
  };

  const [loading, setLoading] = useState(false);
  const [metrics, setMetrics] = useState<PlanningDashboardMetrics | null>(null);
  const [netRequirements, setNetRequirements] = useState<PartNetRequirement[]>([]);
  const [suggestions, setSuggestions] = useState<ProductionPlanSuggestion[]>([]);
  const [proposalCount, setProposalCount] = useState(0);
  const [customerOrders, setCustomerOrders] = useState<CustomerOrder[]>([]);
  const [selectedSuggestionId, setSelectedSuggestionId] = useState<string | null>(null);
  const [focusedMachineCode, setFocusedMachineCode] = useState<string | null>(null);
  const [isOrderModalOpen, setIsOrderModalOpen] = useState(false);
  const [editingOrder, setEditingOrder] = useState<CustomerOrder | null>(null);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  // Search & Filter in Orders
  const [orderSearchTerm, setOrderSearchTerm] = useState('');
  const [orderStatusFilter, setOrderStatusFilter] = useState('ALL');

  const loadPlanningData = async () => {
    setLoading(true);
    try {
      const [metricsRes, netRes, proposalRes, ordersRes] = await Promise.all([
        fetch('/api/planning/dashboard-metrics').then(r => r.json()),
        fetch('/api/planning/net-requirements').then(r => r.json()),
        fetch('/api/planning/proposals').then(r => r.json()),
        fetch('/api/planning/customer-orders').then(r => r.json()),
      ]);

      const nextNetReqs: PartNetRequirement[] = netRes.success && Array.isArray(netRes.data) ? netRes.data : [];
      if (metricsRes.success) setMetrics(metricsRes.data);
      if (netRes.success) setNetRequirements(nextNetReqs);
      if (proposalRes.success) {
        const rawProposals = Array.isArray(proposalRes.data) ? proposalRes.data : [];
        setProposalCount(rawProposals.length);
        const mappedSuggestions: ProductionPlanSuggestion[] = rawProposals.flatMap((prop: any) =>
          (prop.lines || []).map((line: any, lineIdx: number) => {
            const pCode = line.part?.partNumber || line.partCode || '';
            const pName = line.part?.name || line.partName || '';
            const netMatch = nextNetReqs.find(n => n.partId === line.partId || n.partCode === pCode);
            const plannedQty = Number(line.plannedQty ?? line.plannedQuantity ?? 0);
            const approvalMap: Record<string, ProductionPlanSuggestion['approvalStatus']> = {
              DRAFT: 'DRAFT_SUGGESTION',
              APPROVED: 'APPROVED',
              RELEASED: 'CONVERTED_TO_MO',
              CANCELLED: 'REJECTED',
              SUPERSEDED: 'REJECTED',
            };
            const assignments = Array.isArray(line.operationAssignments) ? line.operationAssignments : [];
            const proposedOperations = assignments.map((op: any, opIdx: number) => {
              const matchedMachine = machines.find(m => m.id === op.machineId || m.code === op.machine?.code || m.code === op.machineCode);
              const cycleTimeSec = Number(op.standardCycleTimeSec || 0);
              const setupMin = Number(op.setupTimeMin || 0);
              const estRunH = cycleTimeSec > 0 ? Number(((plannedQty * cycleTimeSec) / 3600).toFixed(2)) : 0;
              const eligibleCheck = matchedMachine
                ? {
                    machineId: matchedMachine.id,
                    machineCode: matchedMachine.code,
                    machineName: matchedMachine.name,
                    hall: matchedMachine.location || 'سالن تولید',
                    processType: matchedMachine.processType,
                    tonnage: matchedMachine.tonnage || op.requiredTonnage || 0,
                    isEligible: true,
                    ineligibleReasons: [],
                    processMatch: true,
                    tonnageSufficient: true,
                    dieCompatible: true,
                    isMachineActive: matchedMachine.status === 'ACTIVE',
                    capacityAvailable: true,
                    dailyCapacityHours: 15,
                    currentWorkloadHours: 0,
                    availableHoursRemaining: 15,
                    estimatedSetupTimeMin: setupMin,
                    estimatedRunTimeHours: estRunH,
                    currentWorkloadPercent: 0,
                    suitabilityScore: 95,
                    recommendationRank: 1,
                    recommendationReason: 'تخصیص‌یافته از پیشنهاد برنامه تولید',
                  }
                : null;
              return {
                stepNumber: op.stepNumber || (opIdx + 1) * 10,
                stepCode: op.stepCode || `OP${(opIdx + 1) * 10}`,
                stepName: op.stepName || `عملیات ${opIdx + 1}`,
                processType: matchedMachine?.processType || 'BLANKING',
                requiredTonnage: Number(op.requiredTonnage ?? matchedMachine?.tonnage ?? 0),
                plannedQuantity: plannedQty,
                standardCycleTimeSec: cycleTimeSec,
                setupTimeMin: setupMin,
                estimatedRunHours: estRunH,
                dieMoldId: op.dieId || undefined,
                dieMoldCode: op.die?.code || undefined,
                dieMoldName: op.die?.name || undefined,
                recommendedMachine: eligibleCheck,
                allCandidateMachines: eligibleCheck ? [eligibleCheck] : [],
                isInfeasible: !eligibleCheck,
                infeasibilityReasons: eligibleCheck ? [] : ['ماشین واجد شرایط تخصیص نیافته است'],
              };
            });

            return {
              id: prop.id,
              planNumber: prop.proposalNumber,
              planVersion: `V${prop.version || 1}.0`,
              partId: line.partId,
              partCode: pCode,
              partName: pName,
              customerOrderIds: line.customerOrderLineId ? [line.customerOrderLineId] : [],
              customerOrderNumbers: line.customerOrderLine?.order?.orderNumber ? [line.customerOrderLine.order.orderNumber] : [],
              targetDueDate: line.plannedEndDate || prop.generatedAt,
              grossDemand: netMatch?.grossDemandQty ?? Number(line.requestedQty || plannedQty),
              availableFg: netMatch?.availableFinishedGoodsQty ?? 0,
              wipCredit: netMatch?.totalDownstreamWip ?? 0,
              netRequiredQuantity: netMatch?.netProductionRequirement ?? plannedQty,
              proposedQuantity: plannedQty,
              materialStatus: {
                requiredGrade: line.materialGrade || netMatch?.requiredMaterialGrade || 'نامشخص',
                requiredWeightKg: netMatch?.requiredMaterialKg ?? 0,
                availableWeightKg: netMatch?.availableRawMaterialKg ?? 0,
                shortageKg: netMatch?.materialShortageKg ?? 0,
                hasShortage: (netMatch?.materialShortageKg ?? 0) > 0,
              },
              proposedOperations,
              overallFeasible: proposedOperations.every((o: any) => !o.isInfeasible),
              infeasibilityWarnings: Array.isArray(line.warnings) ? line.warnings : [],
              estimatedStartDate: line.plannedStartDate || prop.generatedAt,
              estimatedCompletionDate: line.plannedEndDate || prop.generatedAt,
              approvalStatus: approvalMap[prop.status] || 'DRAFT_SUGGESTION',
              createdAt: prop.generatedAt,
              updatedAt: prop.generatedAt,
            };
          }),
        );
        setSuggestions(mappedSuggestions);
      }
      if (ordersRes.success) {
        // PostgreSQL is the source of truth; never let an older browser cache override it.
        setCustomerOrders(Array.isArray(ordersRes.data) ? ordersRes.data : []);
      }
    } catch (err) {
      console.error('Failed to load planning data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPlanningData();
  }, [parts.length]);

  useEffect(() => {
    const handler = () => {
      loadPlanningData();
    };
    window.addEventListener('kpims-master-data-updated', handler);
    return () => window.removeEventListener('kpims-master-data-updated', handler);
  }, []);

  const executeRegenerate = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/planning/proposals/regenerate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setPlanToast(data.error || 'تولید پیشنهاد برنامه ناموفق بود.');
        return;
      }
      await loadPlanningData();
      setPlanToast(data.message || 'پیشنهاد برنامه جدید تولید با موفقیت ایجاد شد. برای بررسی و تأیید به تب پیشنهاد برنامه بروید.');
      if (onGlobalRefresh) await onGlobalRefresh();
    } catch (err) {
      setPlanToast(err instanceof Error ? err.message : 'خطا در تولید پیشنهاد برنامه');
    } finally {
      setLoading(false);
    }
  };

  const handleRegenerate = async () => {
    requestConfirm({
      title: 'بازتولید پیشنهاد برنامه تولید از داده‌های جاری',
      message:
        'آیا می‌خواهید موتور برنامه‌ریزی مجدداً با بررسی سفارشات باز، موجودی انبار، BOM، مسیرهای تولید و ظرفیت پرس‌ها پیشنهاد جدید بسازد؟',
      confirmLabel: 'تأیید و محاسبه مجدد برنامه',
      variant: 'warning',
      onConfirm: executeRegenerate,
    });
  };

  const handleCreateCustomerOrder = async (payload: any) => {
    try {
      const res = await fetch('/api/planning/customer-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        return { success: false, error: data.error || 'خطا در ثبت سفارش' };
      }

      if (!data.data?.id || !Array.isArray(data.data.lines)) {
        throw new Error('سرور ثبت سفارش را تأیید کرد، اما اطلاعات سفارش ذخیره‌شده را برنگرداند. برای جلوگیری از نمایش اطلاعات غیرواقعی، سفارش به فهرست محلی اضافه نشد.');
      }
      const newOrder: CustomerOrder = data.data;
      setCustomerOrders(prev => [newOrder, ...prev]);

      recordAudit({
        moduleName: 'برنامه‌ریزی تولید',
        actionType: 'CREATE',
        title: `ثبت سفارش جدید ${newOrder.orderNumber}`,
        details: `سفارش مشتری ${payload.customerName} با اولویت ${payload.priority === 1 ? 'فوری' : 'عادی'} ایجاد گردید.`,
      });

      await loadPlanningData();
      if (onGlobalRefresh) await onGlobalRefresh();
      setPlanToast('سفارش مشتری با موفقیت افزوده شد و الزامات MRP بروزرسانی گردید.');
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'خطای شبکه' };
    }
  };

  const handleUpdateCustomerOrder = async (orderId: string, payload: any) => {
    try {
      const response = await fetch(`/api/planning/customer-orders/${orderId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'خطا در ذخیره تغییرات سفارش');
      }

      await loadPlanningData();
      recordAudit({
        moduleName: 'برنامه‌ریزی تولید',
        actionType: 'UPDATE',
        title: `ویرایش سفارش ${orderId}`,
        details: `بروزرسانی تیراژ، موعد تحویل و اولویت (${payload.priority === 1 ? 'فوری' : 'عادی'})`,
      });
      setPlanToast(data.message || 'تغییرات سفارش با موفقیت ذخیره شد و الزامات MRP بروزرسانی گردید.');
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'خطا در ویرایش سفارش' };
    }
  };

  const handleReverseCustomerOrder = (order: CustomerOrder) => {
    requestConfirm({
      title: `ابطال سفارش تعهد تحویل (Document Reversal) ${order.orderNumber}`,
      message: `در معماری تراکنشی SAP، اسناد سفارش مشتری حذف نمی‌شوند. با ابطال سفارش ${order.orderNumber} («${order.customerName}»)، وضعیت سند به CANCELLED تغییر کرده و نیازهای خالص MRP مجدداً موازنه می‌شود.`,
      confirmLabel: 'تایید ابطال سفارش (Reversal)',
      cancelLabel: 'انصراف',
      variant: 'danger',
      onConfirm: async () => {
        const previousOrders = customerOrders;
        setCustomerOrders(prev =>
          prev.map(o => (o.id === order.id ? { ...o, status: 'CANCELLED' as any } : o))
        );
        try {
          const response = await fetch(`/api/planning/customer-orders/${order.id}/reverse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              reason: `ابطال سفارش ${order.orderNumber} توسط برنامه‌ریزی تولید (Document Reversal)`,
            }),
          });
          const data = await response.json();
          if (!response.ok || !data.success) {
            throw new Error(data.error || 'خطا در ابطال سفارش');
          }
          recordAudit({
            moduleName: 'برنامه‌ریزی تولید (SD/PP)',
            actionType: 'REVERSAL',
            entityId: order.id,
            entityCode: order.orderNumber,
            title: `ابطال سفارش مشتری ${order.orderNumber}`,
            details: `سفارش مشتری ${order.customerName} با ثبت تاریخچه ممیزی ابطال (CANCELLED) شد.`,
          });
          setPlanToast(data.message || `سفارش ${order.orderNumber} با موفقیت ابطال و در تاریخچه ممیزی ثبت شد.`);
          void loadPlanningData();
        } catch (error) {
          setCustomerOrders(previousOrders);
          setPlanToast(error instanceof Error ? error.message : 'ابطال سفارش ناموفق بود.');
        }
      },
    });
  };

  const handleQuickUpdatePriority = async (orderId: string, newPriority: 1 | 2 | 3) => {
    try {
      const response = await fetch(`/api/planning/customer-orders/${orderId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: newPriority }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'تغییر اولویت سفارش ذخیره نشد.');
      }

      await loadPlanningData();
      recordAudit({
        moduleName: 'برنامه‌ریزی تولید',
        actionType: 'UPDATE',
        title: `تغییر اولویت سفارش ${orderId}`,
        details: `اولویت به ${newPriority === 1 ? 'فوری' : newPriority === 2 ? 'عادی' : 'مازاد'} تغییر یافت.`,
      });
      setPlanToast(data.message || `اولویت سفارش به ${newPriority === 1 ? 'فوری' : newPriority === 2 ? 'عادی' : 'مازاد'} تغییر یافت.`);
    } catch (error) {
      await loadPlanningData();
      setPlanToast(error instanceof Error ? error.message : 'تغییر اولویت سفارش ناموفق بود.');
    }
  };

  const handleApprovePlan = async (id: string, approvedBy: string) => {
    try {
      const res = await fetch(`/api/planning/proposals/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvedBy }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        return { success: false, error: data.error || 'خطا در تصویب برنامه' };
      }
      await loadPlanningData();
      if (onGlobalRefresh) await onGlobalRefresh();
      return { success: true, message: data.message };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'خطای ارتباط' };
    }
  };

  const handleReleaseMo = async (id: string, releasedBy: string) => {
    try {
      const res = await fetch(`/api/planning/proposals/${id}/approve-and-release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: releasedBy }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        return { success: false, error: data.error || 'خطا در آزادسازی به MO' };
      }
      await loadPlanningData();
      if (onGlobalRefresh) await onGlobalRefresh();
      return {
        success: true,
        message: data.message,
        moId: data.data?.manufacturingOrders?.[0]?.id,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'خطای ارتباط' };
    }
  };

  const handleRevisePlan = async (id: string, changeReason: string) => {
    try {
      const res = await fetch(`/api/planning/proposals/${id}/revise`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: [], note: changeReason }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        return { success: false, error: data.error || 'خطا در ایجاد بازنگری' };
      }
      await loadPlanningData();
      if (onGlobalRefresh) await onGlobalRefresh();
      return { success: true, message: data.message, newPlanId: data.data?.id || data.data?.newPlan?.id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'خطای ارتباط' };
    }
  };

  const navigateToRecommendationsForPart = (partId?: string) => {
    if (partId) {
      const matchingSuggestion = suggestions.find(s => s.partId === partId);
      if (matchingSuggestion) {
        setSelectedSuggestionId(matchingSuggestion.id);
      }
    }
    handleSelectSubTab('recommendations');
  };

  const filteredOrders = customerOrders.filter(o => {
    if (orderStatusFilter !== 'ALL' && o.status !== orderStatusFilter) return false;
    if (orderSearchTerm) {
      const q = orderSearchTerm.toLowerCase();
      return (
        o.orderNumber.toLowerCase().includes(q) ||
        o.customerName.toLowerCase().includes(q) ||
        o.contractNumber.toLowerCase().includes(q) ||
        o.lines.some(l => l.partName.toLowerCase().includes(q) || l.partCode.toLowerCase().includes(q))
      );
    }
    return true;
  });

  const approvedPlans = suggestions.filter(
    s => s.approvalStatus === 'APPROVED' || s.approvalStatus === 'CONVERTED_TO_MO'
  );

  const [planToast, setPlanToast] = useState<string | null>(null);

  if (loading && !metrics && suggestions.length === 0 && customerOrders.length === 0) {
    return <PlanningModuleSkeleton />;
  }

  return (
    <div className="space-y-4">
      {/* SAP Fiori Dynamic Page Header & IconTabBar */}
      <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)] overflow-hidden">
        <div className="px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[var(--fiori-border-subtle)]">
          <div>
            <h1 className="text-sm sm:text-[15px] font-semibold text-[var(--fiori-text-primary)]">
              برنامه‌ریزی کلان تولید و نیازسنجی مواد (SAP MRP / PP)
            </h1>
            <p className="text-[11px] text-[var(--fiori-text-secondary)] mt-0.5">
              سفارشات ساپکو، انفجار BOM، محاسبه نیاز خالص ورق و تخصیص پرس‌ها
            </p>
          </div>

          <div className="flex items-center gap-2 self-end sm:self-auto flex-wrap">
            <InlinePageGuideButton
              routeContext={{ tab: 'planning', planningSubTab: activeSubTab }}
              label="آموزش این تب و دکمه‌ها"
            />
            <button
              type="button"
              onClick={loadPlanningData}
              disabled={loading}
              className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer whitespace-nowrap"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${
                  loading ? 'animate-spin text-[var(--fiori-brand)]' : 'text-[var(--fiori-text-secondary)]'
                }`}
              />
              <span>بروزرسانی</span>
            </button>
            <button
              type="button"
              onClick={() => setIsOrderModalOpen(true)}
              className="sap-btn-emphasized flex items-center gap-1.5 px-3.5 py-1.5 text-xs cursor-pointer whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>ثبت سفارش مشتری</span>
            </button>
          </div>
        </div>

        <div className="sap-icon-tab-bar px-2 border-b-0">
          {[
            { id: 'mrp', label: '۱. انفجار BOM و نیاز ورق (MRP)' },
            { id: 'capacity_planning', label: '۲. تقویم ظرفیت ماشین‌آلات (Capacity Planning)' },
            { id: 'orders', label: `۳. سفارشات مشتریان (${toPersianDigits(customerOrders.length)})` },
            { id: 'recommendations', label: `۴. پیشنهاد برنامه و پرس (${toPersianDigits(proposalCount)})` },
            { id: 'daily_schedule', label: '۵. تقویم روزانه سالن‌ها' },
            { id: 'dashboard', label: '۶. موازنه تقاضا و ظرفیت' },
          ].map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => handleSelectSubTab(item.id as any)}
              className={`sap-icon-tab ${activeSubTab === item.id ? 'sap-icon-tab-active' : ''}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {planToast && (
        <FioriMessageStrip tone="success" onClose={() => setPlanToast(null)}>
          {planToast}
        </FioriMessageStrip>
      )}

      {/* Sub-Tab 0: ERP 5-Stage Workbench (SAP PP / Odoo MRP / Daily Roll-Forward) */}
      {activeSubTab === 'erp_workbench' && (
        <ErpProductionWorkbenchView parts={parts} routings={routings} onRefreshData={loadPlanningData} />
      )}

      {/* Sub-Tab: SAP PP Production Workflow Documentation */}
      {activeSubTab === 'workflow_doc' && <ProductionWorkflowDocumentationView />}

      {/* 1. Dashboard Sub-Tab */}
      {activeSubTab === 'dashboard' && (
        <PlanningDashboardView
          metrics={metrics}
          netRequirements={netRequirements}
          machines={machines}
          suggestions={suggestions}
          onRegenerate={handleRegenerate}
          onOpenNewOrderModal={() => setIsOrderModalOpen(true)}
          onNavigateToRecommendations={navigateToRecommendationsForPart}
          onNavigateToCapacityGantt={(machineCode?: string) => {
            if (machineCode) setFocusedMachineCode(machineCode);
            handleSelectSubTab('capacity_planning');
          }}
          loading={loading}
        />
      )}

      {/* 1.0. Daily Production Schedule Sub-Tab (برنامه روزانه شرکت به تفکیک سالن) */}
      {activeSubTab === 'daily_schedule' && (
        <DailyProductionScheduleView />
      )}

      {/* 1.05. Machine Capacity Timeline Sub-Tab (تقویم ظرفیت ماشین‌آلات - Capacity Planning) */}
      {activeSubTab === 'capacity_planning' && (
        <MachineCapacityTimelineView
          suggestions={suggestions}
          parts={parts}
          machines={machines}
          initialMachineCode={focusedMachineCode}
        />
      )}

      {/* 1.1. MRP & Material Requirements Forecast Sub-Tab */}
      {activeSubTab === 'mrp' && (
        <MrpModuleView onRefreshGlobal={onGlobalRefresh} />
      )}

      {/* 1.2. Consumables & Shop-Floor Supplies Forecast Sub-Tab */}
      {activeSubTab === 'consumables' && (
        <ConsumablesForecastView />
      )}

      {/* 2. Machine Recommendations Sub-Tab */}
      {activeSubTab === 'recommendations' && (
        <RelationalPlanProposalView
          onReleased={async () => {
            await loadPlanningData();
            if (onGlobalRefresh) await onGlobalRefresh();
          }}
        />
      )}

      {/* 3. Customer Orders Sub-Tab (SAP Fiori Master-Detail Split Screen) */}
      {activeSubTab === 'orders' && (
        <div className="space-y-3.5">
          <FioriToolbar
            variant="page"
            startContent={
              <div className="flex items-center gap-2.5 flex-wrap">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-[var(--fiori-text-muted)] absolute right-2.5 top-2" />
                  <input
                    type="text"
                    placeholder="جستجو در سفارشات ساپکو، قطعات..."
                    value={orderSearchTerm}
                    onChange={e => setOrderSearchTerm(e.target.value)}
                    className="bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] pr-8 pl-3 py-1 text-xs text-[var(--fiori-text-primary)] w-64 focus:bg-[var(--fiori-bg-surface)] focus:outline-none focus:border-[var(--fiori-border-focus)]"
                  />
                </div>

                <select
                  value={orderStatusFilter}
                  onChange={e => setOrderStatusFilter(e.target.value)}
                  className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-border-focus)]"
                >
                  <option value="ALL">همه وضعیت‌ها</option>
                  <option value="OPEN">سفارشات باز (در حال برنامه‌ریزی)</option>
                  <option value="PARTIALLY_FULFILLED">تحویل بخشی</option>
                  <option value="FULFILLED">تکمیل شده</option>
                  <option value="CANCELLED">ابطال شده (Reversed)</option>
                </select>
              </div>
            }
            endContent={
              <button
                type="button"
                onClick={() => {
                  setEditingOrder(null);
                  setIsOrderModalOpen(true);
                }}
                className="sap-btn-emphasized flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>ثبت تعهد تحویل جدید</span>
              </button>
            }
          />

          {/* Master-Detail Split Screen (Fiori Style: 1/3 Right Master, 2/3 Left Detail) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            {/* Right Column (Master List: 1/3 -> lg:col-span-4) */}
            <div className="lg:col-span-4 bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)] p-3 space-y-2 max-h-[75vh] overflow-y-auto">
              <FioriToolbar
                variant="section"
                title="لیست سفارشات ساپکو"
                count={filteredOrders.length}
                countLabel="سفارش"
                endContent={
                  <span className="text-[10px] text-[var(--fiori-text-muted)]">انتخاب جهت جزئیات</span>
                }
              />
              {filteredOrders.length === 0 ? (
                <EmptyState
                  variant={orderSearchTerm || orderStatusFilter !== 'ALL' ? 'FILTER_NO_MATCH' : 'NO_CONTRACTS'}
                  compact
                  actionLabel={orderSearchTerm || orderStatusFilter !== 'ALL' ? 'پاک‌کردن فیلترها' : undefined}
                  onAction={
                    orderSearchTerm || orderStatusFilter !== 'ALL'
                      ? () => {
                          setOrderSearchTerm('');
                          setOrderStatusFilter('ALL');
                        }
                      : undefined
                  }
                />
              ) : (
                filteredOrders.map(order => {
                  const isSelected =
                    selectedOrderId === order.id || (!selectedOrderId && filteredOrders[0]?.id === order.id);
                  const statusTone =
                    order.status === 'CANCELLED'
                      ? 'negative'
                      : order.status === 'FULFILLED'
                      ? 'info'
                      : order.status === 'PARTIALLY_FULFILLED'
                      ? 'critical'
                      : 'positive';
                  const statusText =
                    order.status === 'CANCELLED'
                      ? 'ابطال'
                      : order.status === 'FULFILLED'
                      ? 'تکمیل'
                      : order.status === 'PARTIALLY_FULFILLED'
                      ? 'تحویل بخشی'
                      : 'فعال';
                  return (
                    <div
                      key={order.id}
                      onClick={() => {
                        if (selectedOrderId && selectedOrderId !== order.id) {
                          const prevId = selectedOrderId;
                          router.pushSelectionStep(
                            `سفارش ${order.orderNumber}`,
                            () => setSelectedOrderId(prevId),
                            `planning-order-${order.id}`,
                          );
                        }
                        setSelectedOrderId(order.id);
                      }}
                      className={`p-3 rounded-[var(--fiori-radius-sm)] border cursor-pointer transition-all ${
                        isSelected
                          ? 'bg-[var(--fiori-bg-selected)] border-[var(--fiori-brand)] shadow-[var(--fiori-shadow-card)]'
                          : 'bg-[var(--fiori-bg-surface)] border-[var(--fiori-border-default)] hover:bg-[var(--fiori-bg-hover)]'
                      }`}
                    >
                      <div className="flex items-center justify-between text-xs font-mono font-semibold text-[var(--fiori-text-primary)]">
                        <span className="fiori-ltr-code">{order.orderNumber}</span>
                        <FioriObjectStatus tone={statusTone} label={statusText} size="sm" />
                      </div>
                      <div className="text-[11px] text-[var(--fiori-text-secondary)] mt-1.5 flex items-center justify-between">
                        <span>{order.customerName}</span>
                        <span className="tabular-nums font-mono">{formatToJalali(order.dueDate)}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Left Column (Detail Panel: 2/3 -> lg:col-span-8) */}
            <div className="lg:col-span-8 bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)] p-4 space-y-4">
              {(() => {
                const currentOrder = filteredOrders.find(o => o.id === selectedOrderId) || filteredOrders[0];
                if (!currentOrder) {
                  return (
                    <EmptyState
                      variant="NO_DATA"
                      compact
                      title="سفارشی برای نمایش انتخاب نشده است"
                      description="لطفاً یک سفارش را از لیست سمت راست انتخاب کنید تا جزئیات کامل، BOM و عملیات‌های آن نمایش داده شود."
                    />
                  );
                }
                return (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between border-b border-[var(--fiori-border-subtle)] pb-3">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-base font-semibold text-[var(--fiori-text-primary)] font-mono fiori-ltr-code">
                            {currentOrder.orderNumber}
                          </h3>
                          <FioriObjectStatus
                            tone={currentOrder.priority === 1 ? 'negative' : currentOrder.priority === 3 ? 'neutral' : 'brand'}
                            label={
                              currentOrder.priority === 1
                                ? 'اولویت فوری'
                                : currentOrder.priority === 3
                                ? 'اولویت مازاد'
                                : 'اولویت عادی'
                            }
                            size="sm"
                          />
                          {currentOrder.status === 'CANCELLED' && (
                            <FioriObjectStatus tone="negative" label="ابطال شده (Reversed)" size="sm" />
                          )}
                        </div>
                        <p className="text-xs text-[var(--fiori-text-secondary)] mt-1 flex items-center gap-2">
                          <Building2 className="w-3.5 h-3.5 text-[var(--fiori-text-muted)]" />
                          <span>مشتری: {currentOrder.customerName}</span>
                          {currentOrder.contractNumber && <span>| قرارداد: {currentOrder.contractNumber}</span>}
                        </p>
                      </div>
                      <div className="text-left">
                        <div className="text-[11px] text-[var(--fiori-text-secondary)]">تاریخ تحویل:</div>
                        <div className="text-xs font-semibold text-[var(--fiori-text-primary)] font-mono tabular-nums">
                          {formatToJalali(currentOrder.dueDate)}
                        </div>
                      </div>
                    </div>

                    {/* Order Lines & BOM Requirements */}
                    <div className="space-y-2">
                      <div className="text-xs font-semibold text-[var(--fiori-text-primary)] flex items-center gap-1.5">
                        <Layers className="w-4 h-4 text-[var(--fiori-brand)]" />
                        <span>اقلام تعهد تحویل و ساختار محصول (BOM & Requirements):</span>
                      </div>
                      {currentOrder.lines.map(line => (
                        <div
                          key={line.id}
                          className="bg-[var(--fiori-bg-subtle)] p-3 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] flex items-center justify-between text-xs"
                        >
                          <div>
                            <div className="font-semibold text-[var(--fiori-text-primary)] text-sm">{line.partName}</div>
                            <div className="text-[11px] text-[var(--fiori-text-secondary)] font-mono mt-0.5">
                              کد کاتالوگ: <span className="fiori-ltr-code">{line.partCode}</span>
                            </div>
                          </div>
                          <div className="text-left tabular-nums">
                            <div className="text-sm font-semibold text-[var(--fiori-text-primary)] font-mono">
                              {formatNumber(line.orderedQuantity)} عدد
                            </div>
                            <div className="text-[10px] text-[var(--fiori-positive)]">
                              تحویل شده: {formatNumber(line.deliveredQuantity || 0)}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    {currentOrder.notes && (
                      <div className="text-xs text-[var(--fiori-text-secondary)] bg-[var(--fiori-bg-subtle)] p-3 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)]">
                        <span className="font-semibold text-[var(--fiori-text-primary)]">یادداشت‌های مهندسی فروش:</span>{' '}
                        {currentOrder.notes}
                      </div>
                    )}

                    {/* Action Bar */}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-[var(--fiori-border-subtle)] text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-[var(--fiori-text-secondary)]">تغییر فوری اولویت برنامه‌ریزی:</span>
                        <select
                          value={currentOrder.priority}
                          onChange={e => handleQuickUpdatePriority(currentOrder.id, Number(e.target.value) as 1 | 2 | 3)}
                          className="text-xs font-semibold bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1 text-[var(--fiori-text-primary)] cursor-pointer focus:outline-none focus:border-[var(--fiori-border-focus)]"
                        >
                          <option value={1}>فوری (اولویت ۱)</option>
                          <option value={2}>عادی (اولویت ۲)</option>
                          <option value={3}>مازاد (اولویت ۳)</option>
                        </select>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingOrder(currentOrder);
                            setIsOrderModalOpen(true);
                          }}
                          className="sap-btn-standard px-3 py-1.5 font-semibold cursor-pointer flex items-center gap-1.5"
                        >
                          <Edit3 className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
                          <span>ویرایش سفارش</span>
                        </button>
                        {currentOrder.status !== 'CANCELLED' && (
                          <button
                            type="button"
                            onClick={() => handleReverseCustomerOrder(currentOrder)}
                            className="px-3 py-1.5 text-[var(--fiori-negative)] bg-[var(--fiori-negative-bg)] hover:bg-[var(--fiori-negative)] hover:text-white rounded-[var(--fiori-radius-sm)] transition cursor-pointer flex items-center gap-1.5 font-semibold border border-[var(--fiori-negative-border)]"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span>ابطال سند (Reversal)</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* 4. Approved Plans Sub-Tab */}
      {activeSubTab === 'approved_plans' && (
        <div className="space-y-3.5">
          <FioriToolbar
            variant="page"
            title="سوابق برنامه‌های مصوب مدیر تولید و دستور کارهای صادر شده به کارگاه"
            subtitle="برنامه‌های تأیید شده قابلیت آزادسازی و ایجاد شناسه رسمی دستور کار (MO) در واحد WIP را دارند."
            count={approvedPlans.length}
            countLabel="برنامه"
            startContent={<CheckCircle2 className="w-4 h-4 text-[var(--fiori-positive)] shrink-0" />}
          />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {approvedPlans.length === 0 ? (
              <div className="col-span-2">
                <EmptyState
                  variant="NO_DATA"
                  title="هنوز برنامه‌ای به تصویب نرسیده است"
                  description="از تب «تخصیص ماشین‌آلات و پیشنهاد برنامه» اقدام به تأیید برنامه‌ها نمایید."
                  actionLabel="مشاهده پیشنهادهای برنامه"
                  onAction={() => handleSelectSubTab('recommendations')}
                />
              </div>
            ) : (
              approvedPlans.map(plan => (
                <div
                  key={plan.id}
                  className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)] p-3.5 space-y-3"
                >
                  <div className="flex items-center justify-between border-b border-[var(--fiori-border-subtle)] pb-2.5">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-[var(--fiori-text-primary)] text-sm font-mono fiori-ltr-code">
                          {plan.planNumber}
                        </span>
                        <FioriObjectStatus tone="critical" label={plan.planVersion} size="sm" ltrCode />
                      </div>
                      <div className="text-xs text-[var(--fiori-text-primary)] font-medium mt-1">
                        قطعه: {plan.partName}{' '}
                        <button
                          type="button"
                          onClick={() => router.traceDocument(plan.partCode, 'INVENTORY_LEDGER')}
                          className="sap-doc-link font-mono text-[11px] cursor-pointer fiori-ltr-code"
                        >
                          ({plan.partCode})
                        </button>
                      </div>
                    </div>

                    <div className="text-left">
                      {plan.approvalStatus === 'CONVERTED_TO_MO' ? (
                        <FioriObjectStatus tone="brand" label="صادر شده به دستور کار" size="sm" />
                      ) : (
                        <FioriObjectStatus tone="positive" label="مصوب مدیر تولید" size="sm" />
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <div className="bg-[var(--fiori-bg-subtle)] p-2 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)]">
                      <div className="text-[10px] text-[var(--fiori-text-secondary)]">تیراژ خالص مصوب</div>
                      <div className="font-semibold text-[var(--fiori-text-primary)] mt-0.5 tabular-nums font-mono">
                        {formatNumber(plan.proposedQuantity)}
                      </div>
                    </div>
                    <div className="bg-[var(--fiori-bg-subtle)] p-2 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)]">
                      <div className="text-[10px] text-[var(--fiori-text-secondary)]">ورق مورد نیاز</div>
                      <div className="font-semibold text-[var(--fiori-text-primary)] mt-0.5 tabular-nums font-mono">
                        {formatNumber(plan.materialStatus.requiredWeightKg)} kg
                      </div>
                    </div>
                    <div className="bg-[var(--fiori-bg-subtle)] p-2 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)]">
                      <div className="text-[10px] text-[var(--fiori-text-secondary)]">موعد تحویل</div>
                      <div className="font-semibold text-[var(--fiori-text-primary)] mt-0.5 tabular-nums font-mono">
                        {formatToJalali(plan.targetDueDate)}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedSuggestionId(plan.id);
                        handleSelectSubTab('recommendations');
                      }}
                      className="text-xs text-[var(--fiori-brand)] hover:underline font-semibold cursor-pointer"
                    >
                      مشاهده جزئیات مراحل و ماشین‌ها ←
                    </button>

                    {plan.approvalStatus === 'APPROVED' && (
                      <button
                        type="button"
                        onClick={() => {
                          requestConfirm({
                            title: `صدور رسمی دستور کار ساخت (MO) از برنامه ${plan.planNumber}`,
                            message: `آیا صدور دستور کار برای قطعه «${plan.partName} (${plan.partCode})» به تیراژ ${formatNumber(plan.proposedQuantity)} عدد را تأیید می‌کنید؟`,
                            confirmLabel: 'تأیید و صدور MO',
                            variant: 'emerald',
                            onConfirm: async () => {
                              const res = await handleReleaseMo(plan.id, 'سرپرست برنامه‌ریزی');
                              if (res.success) {
                                setPlanToast('دستور کار کارگاهی (MO) با موفقیت صادر و به واحد WIP ارسال شد.');
                              }
                            },
                          });
                        }}
                        className="sap-btn-emphasized flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer whitespace-nowrap"
                      >
                        <Send className="w-3.5 h-3.5" />
                        <span>صدور رسمی MO</span>
                      </button>
                    )}

                    {plan.approvalStatus === 'CONVERTED_TO_MO' && plan.createdMoId && (
                      <button
                        type="button"
                        onClick={() => router.traceDocument(plan.createdMoId!, 'WIP_TRACEABILITY')}
                        className="sap-doc-link text-[11px] font-semibold font-mono bg-[var(--fiori-brand-bg)] px-2.5 py-1 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-brand-border)] cursor-pointer fiori-ltr-code"
                        title="رهگیری دستور کار در WIP"
                      >
                        MO: {plan.createdMoId}
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* New / Edit Customer Order Modal */}
      <NewCustomerOrderModal
        isOpen={isOrderModalOpen}
        onClose={() => {
          setIsOrderModalOpen(false);
          setEditingOrder(null);
        }}
        parts={parts}
        onSubmit={handleCreateCustomerOrder}
        orderToEdit={editingOrder}
        onUpdate={handleUpdateCustomerOrder}
      />
    </div>
  );
};
