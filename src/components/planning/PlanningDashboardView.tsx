import React, { useState, useMemo } from 'react';
import {
  TrendingUp,
  Cpu,
  RefreshCw,
  Plus,
  Flame,
  Wrench,
  CalendarClock,
  Calculator,
  Eye,
  ArrowLeft,
  Layers,
} from 'lucide-react';
import {
  PlanningDashboardMetrics,
  PartNetRequirement,
  ProductionPlanSuggestion,
} from '../../types/productionPlanning';
import { Machine } from '../../types/inventory';
import { formatNumber, toPersianDigits } from '../../utils/formatters';
import { formatToJalali } from '../../utils/jalali';
import { FormulaTooltip } from '../common/FormulaTooltip';
import { MetricTooltip } from '../common/MetricTooltip';
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

interface PlanningDashboardViewProps {
  metrics: PlanningDashboardMetrics | null;
  netRequirements: PartNetRequirement[];
  machines: Machine[];
  suggestions?: ProductionPlanSuggestion[];
  onRegenerate: () => Promise<void>;
  onOpenNewOrderModal: () => void;
  onNavigateToRecommendations: (partId?: string) => void;
  onNavigateToCapacityGantt?: (machineCode?: string) => void;
  loading?: boolean;
}

interface MachineWorkloadTask {
  planNumber: string;
  partId: string;
  partCode: string;
  partName: string;
  opCode: string;
  opName: string;
  dieCode: string;
  plannedQty: number;
  cycleTimeSec: number;
  runHours: number;
  setupHours: number;
  totalHours: number;
}

interface ComputedMachineLoad {
  machine: Machine;
  tasks: MachineWorkloadTask[];
  totalRunHours: number;
  totalSetupHours: number;
  baseShiftMaintenanceHours: number;
  totalOccupiedHours: number;
  dailyCapacityHours: number;
  freeHours: number;
  workloadPct: number;
}

export const PlanningDashboardView: React.FC<PlanningDashboardViewProps> = ({
  metrics,
  netRequirements,
  machines,
  suggestions = [],
  onRegenerate,
  onOpenNewOrderModal,
  onNavigateToRecommendations,
  onNavigateToCapacityGantt,
  loading = false,
}) => {
  const { traceDocument } = useErpRouter();
  const [selectedMachineLoad, setSelectedMachineLoad] = useState<ComputedMachineLoad | null>(null);

  // Compute transparent, traceable machine load from active suggestions & routing operations
  const machineLoads = useMemo<ComputedMachineLoad[]>(() => {
    const DAILY_CAPACITY = 15; // 2 shifts * 7.5 net hours

    return machines.map(m => {
      const isActive = m.status === 'ACTIVE';
      if (!isActive) {
        return {
          machine: m,
          tasks: [],
          totalRunHours: 0,
          totalSetupHours: 0,
          baseShiftMaintenanceHours: 0,
          totalOccupiedHours: 0,
          dailyCapacityHours: DAILY_CAPACITY,
          freeHours: 0,
          workloadPct: 0,
        };
      }

      const assignedTasks: MachineWorkloadTask[] = [];

      // Collect operations explicitly assigned to this machine across active proposals
      suggestions.forEach(plan => {
        if (plan.approvalStatus === 'REJECTED') return;
        plan.proposedOperations.forEach(op => {
          const recCode = op.recommendedMachine?.machineCode;
          if (recCode === m.code) {
            const runH = Number(
              (op.estimatedRunHours || (op.plannedQuantity * (op.standardCycleTimeSec || 10)) / 3600).toFixed(1)
            );
            const setupH = Number(((op.setupTimeMin || 0) / 60).toFixed(2));
            assignedTasks.push({
              planNumber: plan.planNumber,
              partId: plan.partId,
              partCode: plan.partCode,
              partName: plan.partName,
              opCode: op.stepCode,
              opName: op.stepName,
              dieCode: op.dieMoldCode || 'بدون قالب',
              plannedQty: op.plannedQuantity,
              cycleTimeSec: op.standardCycleTimeSec || 0,
              runHours: runH,
              setupHours: setupH,
              totalHours: Number((runH + setupH).toFixed(1)),
            });
          }
        });
      });

      const dailyRunHours = Number(assignedTasks.reduce((sum, t) => sum + t.runHours, 0).toFixed(1));
      const dailySetupHours = Number(assignedTasks.reduce((sum, t) => sum + t.setupHours, 0).toFixed(1));
      const basePmHours = assignedTasks.length > 0 ? 0.5 : 0;
      const totalOccupiedHours = Number((dailyRunHours + dailySetupHours + basePmHours).toFixed(1));
      const workloadPct = Math.min(100, Math.round((totalOccupiedHours / DAILY_CAPACITY) * 100));
      const freeHours = Number(Math.max(0, DAILY_CAPACITY - totalOccupiedHours).toFixed(1));

      return {
        machine: m,
        tasks: assignedTasks,
        totalRunHours: dailyRunHours,
        totalSetupHours: dailySetupHours,
        baseShiftMaintenanceHours: basePmHours,
        totalOccupiedHours,
        dailyCapacityHours: DAILY_CAPACITY,
        freeHours,
        workloadPct,
      };
    });
  }, [machines, suggestions]);

  const bottleneckCount = useMemo(
    () => machineLoads.filter(m => m.workloadPct >= 80).length,
    [machineLoads]
  );

  const netReqColumns: FioriTableColumn<PartNetRequirement>[] = useMemo(
    () => [
      {
        key: 'part',
        header: 'کد و نام قطعه',
        render: req => (
          <div>
            <div className="font-semibold text-[var(--fiori-text-primary)]">{req.partName}</div>
            <button
              type="button"
              onClick={() => traceDocument(req.partCode, 'INVENTORY_LEDGER')}
              title="رهگیری قطعه در کاردکس انبار"
              className="sap-doc-link text-[10px] font-mono fiori-ltr-code cursor-pointer"
            >
              {req.partCode}
            </button>
          </div>
        ),
      },
      {
        key: 'grossDemandQty',
        header: 'تقاضای سفارشات',
        align: 'center',
        isMono: true,
        sortable: true,
        sortValue: req => req.grossDemandQty,
        render: req => (
          <span className="font-semibold text-[var(--fiori-brand)] tabular-nums">
            {formatNumber(req.grossDemandQty)}
          </span>
        ),
      },
      {
        key: 'physicalFinishedGoodsQty',
        header: (
          <span className="inline-flex items-center gap-1">
            <span>موجودی فیزیکی انبار</span>
            <MetricTooltip metricKey="ATP" />
          </span>
        ),
        align: 'center',
        isMono: true,
        render: req => (
          <span className="text-[var(--fiori-text-secondary)] tabular-nums">
            {formatNumber(req.physicalFinishedGoodsQty)}
          </span>
        ),
      },
      {
        key: 'availableFinishedGoodsQty',
        header: 'موجودی آزاد محصول',
        align: 'center',
        isMono: true,
        render: req => (
          <span className="text-[var(--fiori-positive)] tabular-nums">
            -{formatNumber(req.availableFinishedGoodsQty)}
          </span>
        ),
      },
      {
        key: 'totalDownstreamWip',
        header: (
          <span className="inline-flex items-center gap-1">
            <span>موجودی در جریان (WIP)</span>
            <MetricTooltip metricKey="WIP" />
          </span>
        ),
        align: 'center',
        isMono: true,
        render: req => (
          <span className="text-[var(--fiori-info)] tabular-nums">
            -{formatNumber(req.totalDownstreamWip)}
          </span>
        ),
      },
      {
        key: 'netProductionRequirement',
        header: 'الزام خالص تولید',
        align: 'center',
        isMono: true,
        sortable: true,
        sortValue: req => req.netProductionRequirement,
        headerClassName: 'bg-[var(--fiori-critical-bg)] text-[var(--fiori-critical)]',
        cellClassName: 'bg-[var(--fiori-critical-bg)]/60',
        render: req => (
          <span className="font-semibold text-sm text-[var(--fiori-critical)] tabular-nums">
            {formatNumber(req.netProductionRequirement)}
          </span>
        ),
      },
      {
        key: 'requiredMaterialKg',
        header: 'نیاز ورق خام (kg)',
        align: 'center',
        isMono: true,
        render: req => (
          <div className="tabular-nums">
            <div>{formatNumber(req.requiredMaterialKg)} kg</div>
            <div className="text-[10px] text-[var(--fiori-text-secondary)]">{req.requiredMaterialGrade}</div>
          </div>
        ),
      },
      {
        key: 'materialStatus',
        header: 'موجودی ورق آزاد',
        align: 'center',
        isMono: true,
        render: req =>
          req.materialShortageKg > 0 ? (
            <FioriObjectStatus
              tone="negative"
              label={`کسری: ${formatNumber(req.materialShortageKg)} kg`}
              size="sm"
            />
          ) : (
            <FioriObjectStatus
              tone="positive"
              label={`${formatNumber(req.availableRawMaterialKg)} kg (کافی)`}
              variant="text"
              size="sm"
            />
          ),
      },
      {
        key: 'dueDate',
        header: 'موعد تحویل',
        align: 'center',
        isMono: true,
        render: req => (
          <span className="text-[11px] text-[var(--fiori-text-secondary)] tabular-nums">
            {formatToJalali(req.dueDate)}
          </span>
        ),
      },
      {
        key: 'actions',
        header: 'عملیات',
        align: 'center',
        render: req => (
          <button
            type="button"
            onClick={() => onNavigateToRecommendations(req.partId)}
            className="sap-btn-standard px-2.5 py-1 text-[11px] cursor-pointer"
          >
            بررسی ماشین ←
          </button>
        ),
      },
    ],
    [onNavigateToRecommendations, traceDocument]
  );

  const modalTaskColumns: FioriTableColumn<MachineWorkloadTask>[] = useMemo(
    () => [
      {
        key: 'planPart',
        header: 'شماره برنامه / قطعه',
        render: t => (
          <div>
            <div className="font-semibold text-[var(--fiori-text-primary)]">{t.partName}</div>
            <div className="text-[10px] text-[var(--fiori-text-secondary)] font-mono flex items-center gap-1.5 mt-0.5">
              <button
                type="button"
                onClick={() => {
                  setSelectedMachineLoad(null);
                  traceDocument(t.planNumber, 'WIP_TRACEABILITY');
                }}
                className="sap-doc-link font-mono fiori-ltr-code cursor-pointer"
                title="رهگیری دستور در ردیابی WIP"
              >
                {t.planNumber}
              </button>
              <span>•</span>
              <button
                type="button"
                onClick={() => {
                  setSelectedMachineLoad(null);
                  traceDocument(t.partCode, 'INVENTORY_LEDGER');
                }}
                className="sap-doc-link font-mono fiori-ltr-code cursor-pointer"
                title="رهگیری قطعه در انبار"
              >
                {t.partCode}
              </button>
            </div>
          </div>
        ),
      },
      {
        key: 'op',
        header: 'مرحله و قالب',
        render: t => (
          <div>
            <div className="font-semibold text-[var(--fiori-text-primary)]">
              <span className="fiori-ltr-code">{t.opCode}</span>: {t.opName}
            </div>
            <div className="text-[10px] text-[var(--fiori-brand)] font-mono fiori-ltr-code">{t.dieCode}</div>
          </div>
        ),
      },
      {
        key: 'plannedQty',
        header: 'تیراژ',
        align: 'center',
        isMono: true,
        render: t => <span className="font-semibold tabular-nums">{formatNumber(t.plannedQty)}</span>,
      },
      {
        key: 'cycleTimeSec',
        header: 'سایکل (ثانیه)',
        align: 'center',
        isMono: true,
        render: t => <span className="tabular-nums">{toPersianDigits(t.cycleTimeSec)}s</span>,
      },
      {
        key: 'runHours',
        header: 'ساعت ضرب',
        align: 'center',
        isMono: true,
        render: t => (
          <span className="font-semibold text-[var(--fiori-positive)] tabular-nums">
            {toPersianDigits(t.runHours)}h
          </span>
        ),
      },
      {
        key: 'setupHours',
        header: 'ستاپ قالب',
        align: 'center',
        isMono: true,
        render: t => (
          <span className="text-[var(--fiori-brand)] tabular-nums">{toPersianDigits(t.setupHours)}h</span>
        ),
      },
      {
        key: 'action',
        header: 'عملیات',
        align: 'center',
        render: t => (
          <button
            type="button"
            onClick={() => {
              const partId = t.partId;
              setSelectedMachineLoad(null);
              onNavigateToRecommendations(partId);
            }}
            className="sap-btn-standard px-2 py-0.5 text-[10px] cursor-pointer"
          >
            بررسی برنامه
          </button>
        ),
      },
    ],
    [onNavigateToRecommendations, traceDocument]
  );

  return (
    <>
      <FioriDynamicPage
        title="موتور برنامه‌ریزی پیشرفته تولید و موازنه تقاضا (APS & MRP)"
        subtitle="محاسبه خودکار نیازمندی‌های خالص تولید بر اساس سفارشات ساپکو، کسر موجودی انبار محصول و WIP، بررسی کلاف ورق و پیشنهاد هوشمند خطوط پرس"
        status={
          metrics ? (
            <FioriObjectStatus
              tone={bottleneckCount > 0 ? 'critical' : 'positive'}
              label={`گلوگاه ظرفیت: ${toPersianDigits(bottleneckCount)} دستگاه`}
              size="sm"
            />
          ) : undefined
        }
        headerActions={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onOpenNewOrderModal}
              className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5 text-[var(--fiori-positive)]" />
              <span>ثبت سفارش مشتری جدید</span>
            </button>

            <button
              type="button"
              onClick={onRegenerate}
              disabled={loading}
              className="sap-btn-emphasized flex items-center gap-1.5 px-3.5 py-1.5 text-xs disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>
                {loading ? 'در حال محاسبه موتور MRP...' : 'محاسبه مجدد تقاضا و برنامه‌ریزی هوشمند'}
              </span>
            </button>
          </div>
        }
        kpiStrip={
          metrics ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
                <span className="text-[11px] text-[var(--fiori-text-secondary)] block">
                  سفارشات باز مشتریان
                </span>
                <div className="text-xl font-semibold text-[var(--fiori-text-primary)] mt-1 tabular-nums font-mono">
                  {toPersianDigits(metrics.totalOpenOrdersCount)}
                </div>
                <span className="text-[10px] text-[var(--fiori-critical)] font-semibold mt-1 flex items-center gap-1">
                  <Flame className="w-3 h-3" />
                  {toPersianDigits(metrics.criticalPartsRequiringImmediateAction?.length || 0)} قطعه در اولویت فوری
                </span>
              </div>

              <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
                <span className="text-[11px] text-[var(--fiori-text-secondary)] block">
                  تقاضای ناخالص کل
                </span>
                <div className="text-xl font-semibold text-[var(--fiori-brand)] mt-1 tabular-nums font-mono">
                  {formatNumber(metrics.totalGrossDemandPieces)}{' '}
                  <span className="text-xs font-sans font-normal text-[var(--fiori-text-secondary)]">عدد</span>
                </div>
                <span className="text-[10px] text-[var(--fiori-text-secondary)] mt-1 block">
                  تعهدات تحویل جاری
                </span>
              </div>

              <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
                <span className="text-[11px] text-[var(--fiori-text-secondary)] block">
                  نیاز خالص تولید (Net Req)
                </span>
                <div className="text-xl font-semibold text-[var(--fiori-critical)] mt-1 tabular-nums font-mono">
                  {formatNumber(metrics.totalNetProductionRequirementsPieces)}{' '}
                  <span className="text-xs font-sans font-normal text-[var(--fiori-text-secondary)]">عدد</span>
                </div>
                <span className="text-[10px] text-[var(--fiori-text-secondary)] mt-1 block">
                  پس از کسر انبار محصول و WIP
                </span>
              </div>

              <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
                <span className="text-[11px] text-[var(--fiori-text-secondary)] block">پیشنهادات فعال</span>
                <div className="text-xl font-semibold text-[var(--fiori-brand)] mt-1 tabular-nums font-mono">
                  {toPersianDigits(metrics.activeSuggestionsCount)}
                </div>
                <span className="text-[10px] text-[var(--fiori-positive)] font-semibold mt-1 block">
                  {toPersianDigits(metrics.approvedPlansCount)} برنامه مصوب آماده اجرا
                </span>
              </div>

              <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
                <span className="text-[11px] text-[var(--fiori-text-secondary)] block">
                  وضعیت تأمین کلاف ورق
                </span>
                <div
                  className={`text-xl font-semibold mt-1 tabular-nums font-mono ${
                    metrics.totalMaterialShortageKg > 0
                      ? 'text-[var(--fiori-negative)]'
                      : 'text-[var(--fiori-positive)]'
                  }`}
                >
                  {metrics.totalMaterialShortageKg > 0
                    ? `کسری ${formatNumber(metrics.totalMaterialShortageKg)} kg`
                    : 'تأمین ۱۰۰٪'}
                </div>
                <span className="text-[10px] text-[var(--fiori-text-secondary)] mt-1 block">
                  بررسی موجودی انبار مواد خام
                </span>
              </div>

              <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
                <span className="text-[11px] text-[var(--fiori-text-secondary)] block">
                  متوسط بار کاری پرس‌ها
                </span>
                <div className="text-xl font-semibold text-[var(--fiori-brand)] mt-1 tabular-nums font-mono">
                  {toPersianDigits(metrics.averageMachineCapacityUtilizationPercent)}%
                </div>
                <span className="text-[10px] text-[var(--fiori-text-secondary)] mt-1 block">
                  گلوگاه‌ها: {toPersianDigits(bottleneckCount)} دستگاه
                </span>
              </div>
            </div>
          ) : undefined
        }
      >
        <div className="space-y-5">
          {/* Net Requirements Calculation Matrix Table */}
          <FioriDataTable
            columns={netReqColumns}
            data={netRequirements}
            rowKey={req => req.partId}
            compact
            bordered
            toolbar={
              <FioriToolbar
                variant="table"
                title={
                  <span className="inline-flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-[var(--fiori-brand)]" />
                    <span>جدول محاسبه نیازمندی خالص تولید (Net Requirements & Material Balance)</span>
                    <MetricTooltip metricKey="MRP" />
                  </span>
                }
                subtitle="فرمول محاسبه: نیاز خالص = تقاضای سفارشات − (موجودی آزاد انبار محصول + موجودی نیمه‌ساخته WIP)"
                count={netRequirements.length}
                countLabel="قلم قطعه دارای تقاضا"
              />
            }
            emptyState={
              <EmptyState
                variant="NO_DATA"
                compact
                title="هیچ تقاضای بازی یافت نشد"
                description="برای محاسبه موازنه مواد، ابتدا سفارش مشتری ثبت کنید یا محاسبه مجدد را بزنید."
              />
            }
          />

          {/* Interactive Machine Workload Overview with Explicit Formula & Clickable Breakdown */}
          <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)] p-4 space-y-4">
            <FioriToolbar
              variant="section"
              title={
                <span className="inline-flex items-center gap-2 flex-wrap">
                  <Cpu className="w-4 h-4 text-[var(--fiori-brand)]" />
                  <span>لود ظرفیت خطوط پرس و ماشین‌آلات (سقف دو شیفت کاری - ۱۵ ساعت روزانه)</span>
                  <FormulaTooltip
                    title="فرمول محاسبه درصد لود ظرفیت هر دستگاه"
                    formula="Load % = ((Run Hours + SMED Setup + Daily PM) ÷ 15h) × 100"
                    variables={[
                      {
                        name: 'Run Hours',
                        description: 'ساعت ضرب خالص = (تیراژ عملیات × سایکل تایم ثانیه) ÷ ۳۶۰۰',
                      },
                      {
                        name: 'SMED Setup',
                        description: 'زمان تعویض و تنظیم قالب (به طور استاندارد ۳۰ تا ۳۶ دقیقه به ازای هر بچ)',
                      },
                      {
                        name: 'Daily PM',
                        description: 'سرویس و روانکاری اول شیفت اپراتور (۰.۵ ساعت روزانه)',
                      },
                      {
                        name: '15h Capacity',
                        description: 'ظرفیت اسمی دو شیفت کاری (هر شیفت ۷.۵ ساعت مفید)',
                      },
                    ]}
                    interpretation="روی هر کارت دستگاه کلیک کنید تا ریز قطعات، مراحل OP و فرمول دقیق تشکیل‌دهنده بار کاری همان پرس را مشاهده نمایید."
                  />
                </span>
              }
              subtitle="این بخش نشان می‌دهد هر پرس از ۱۵ ساعت ظرفیت مفید روزانه (۲ شیفت)، چند ساعت درگیر ضرب قطعات، تعویض قالب (SMED) و سرویس روزانه است. برای مشاهده ریز محاسبات، روی کارت کلیک کنید."
              endContent={
                <div className="flex items-center gap-3 flex-wrap text-xs">
                  <FioriObjectStatus tone="positive" label="بار متعادل (<65%)" variant="dot" size="sm" />
                  <FioriObjectStatus tone="critical" label="بار متوسط (65%-80%)" variant="dot" size="sm" />
                  <FioriObjectStatus tone="negative" label="گلوگاه ظرفیت (>80%)" variant="dot" size="sm" />
                </div>
              }
            />

            {/* Formula Explanation Strip */}
            <div className="bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] p-3 flex flex-col md:flex-row md:items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2 text-[var(--fiori-text-primary)]">
                <Calculator className="w-4 h-4 text-[var(--fiori-brand)] shrink-0" />
                <span>
                  <strong>منطق محاسبه اعداد زیر:</strong> ساعت اشغال هر پرس ={' '}
                  <span className="font-mono text-[var(--fiori-brand)] font-semibold">
                    ∑ (تیراژ قطعه × سایکل تایم ÷ ۳۶۰۰) + زمان ستاپ قالب (SMED) + ۰.۵ ساعت چک‌لیست شیفت
                  </span>{' '}
                  تقسیم بر <strong>۱۵ ساعت</strong> ظرفیت روزانه.
                </span>
              </div>
              {onNavigateToCapacityGantt && (
                <button
                  type="button"
                  onClick={() => onNavigateToCapacityGantt()}
                  className="text-xs font-semibold text-[var(--fiori-brand)] hover:underline flex items-center gap-1 shrink-0 cursor-pointer"
                >
                  <span>مشاهده گانت چارت کامل ظرفیت</span>
                  <ArrowLeft className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {machineLoads.map(item => {
                const { machine: m, workloadPct, totalOccupiedHours, freeHours, totalRunHours, totalSetupHours, tasks } = item;
                const isActive = m.status === 'ACTIVE';

                return (
                  <div
                    key={m.id}
                    onClick={() => setSelectedMachineLoad(item)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') setSelectedMachineLoad(item);
                    }}
                    className={`p-3 rounded-[var(--fiori-radius-sm)] border text-xs space-y-2 transition-all cursor-pointer group ${
                      isActive
                        ? 'bg-[var(--fiori-bg-surface)] border-[var(--fiori-border-default)] hover:border-[var(--fiori-brand)]'
                        : 'bg-[var(--fiori-negative-bg)] border-[var(--fiori-negative-border)] hover:border-[var(--fiori-negative)]'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-[var(--fiori-text-primary)] group-hover:text-[var(--fiori-brand)] transition-colors">
                        {m.name}
                      </span>
                      <span className="font-mono text-[10px] px-1.5 py-0.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-neutral-bg)] text-[var(--fiori-text-primary)] border border-[var(--fiori-neutral-border)] font-semibold fiori-ltr-code">
                        {m.code}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-[var(--fiori-text-secondary)]">
                      <span>تناژ اسمی: {m.tonnage ? `${toPersianDigits(m.tonnage)} تن` : 'عمومی'}</span>
                      <FioriObjectStatus
                        tone={isActive ? 'positive' : 'negative'}
                        label={isActive ? 'فعال در خط' : 'متوقف / تعمیرات'}
                        variant="text"
                        size="sm"
                      />
                    </div>

                    {isActive ? (
                      <>
                        <div className="w-full bg-[var(--fiori-border-subtle)] h-2 rounded-[var(--fiori-radius-sm)] overflow-hidden flex">
                          <div
                            className={`h-full transition-all ${
                              workloadPct > 80
                                ? 'bg-[var(--fiori-negative)]'
                                : workloadPct > 65
                                ? 'bg-[var(--fiori-critical)]'
                                : 'bg-[var(--fiori-positive)]'
                            }`}
                            style={{ width: `${workloadPct}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-[11px] font-mono tabular-nums">
                          <span className="text-[var(--fiori-text-primary)] font-semibold">
                            بار: {toPersianDigits(workloadPct)}% ({toPersianDigits(totalOccupiedHours)}h / ۱۵h)
                          </span>
                          <span className="text-[var(--fiori-positive)] font-semibold">
                            آزاد: {toPersianDigits(freeHours)}h
                          </span>
                        </div>
                        <div className="pt-2 border-t border-[var(--fiori-border-subtle)] flex items-center justify-between text-[10px] text-[var(--fiori-text-secondary)]">
                          <span>
                            ضرب: {toPersianDigits(totalRunHours)}h | ستاپ: {toPersianDigits(totalSetupHours)}h
                          </span>
                          <span className="text-[var(--fiori-brand)] font-semibold flex items-center gap-0.5">
                            <Eye className="w-3 h-3" />
                            <span>ریز محاسبه ({toPersianDigits(tasks.length)})</span>
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="text-[11px] text-[var(--fiori-negative)] flex items-center justify-between pt-1">
                        <span className="flex items-center gap-1">
                          <Wrench className="w-3.5 h-3.5" />
                          خارج از دسترس برنامه‌ریزی (PM)
                        </span>
                        <span className="text-[10px] underline font-semibold">مشاهده علت</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </FioriDynamicPage>

      {/* Dialog: Detailed Machine Load Calculation & Assigned Operations Breakdown */}
      <FioriDialog
        isOpen={Boolean(selectedMachineLoad)}
        onClose={() => setSelectedMachineLoad(null)}
        title={
          selectedMachineLoad
            ? `شناسنامه محاسباتی لود ظرفیت: ${selectedMachineLoad.machine.name} (${selectedMachineLoad.machine.code})`
            : ''
        }
        subtitle={
          selectedMachineLoad
            ? `تناژ اسمی: ${
                selectedMachineLoad.machine.tonnage ? `${toPersianDigits(selectedMachineLoad.machine.tonnage)} تن` : 'عمومی'
              } • محل استقرار: ${selectedMachineLoad.machine.location || 'سالن پرس'}`
            : undefined
        }
        icon={<Calculator className="w-5 h-5" />}
        tone={selectedMachineLoad?.machine.status !== 'ACTIVE' ? 'danger' : 'brand'}
        size="lg"
        footer={
          selectedMachineLoad && (
            <div className="flex items-center justify-between gap-3 w-full">
              <button
                type="button"
                onClick={() => setSelectedMachineLoad(null)}
                className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
              >
                بستن پنجره
              </button>

              {onNavigateToCapacityGantt && (
                <button
                  type="button"
                  onClick={() => {
                    const code = selectedMachineLoad.machine.code;
                    setSelectedMachineLoad(null);
                    onNavigateToCapacityGantt(code);
                  }}
                  className="sap-btn-emphasized flex items-center gap-1.5 px-4 py-1.5 text-xs cursor-pointer"
                >
                  <CalendarClock className="w-4 h-4" />
                  <span>مشاهده و تسطیح این دستگاه در تقویم ظرفیت (گانت چارت)</span>
                </button>
              )}
            </div>
          )
        }
      >
        {selectedMachineLoad && (
          <div className="space-y-4">
            {selectedMachineLoad.machine.status !== 'ACTIVE' ? (
              <FioriMessageStrip
                tone="error"
                title="این دستگاه در حال حاضر در وضعیت تعمیرات (PM) یا توقف است"
                icon={<Wrench className="w-4 h-4" />}
              >
                به دلیل وضعیت غیرفعال دستگاه، ظرفیت در دسترس روزانه آن در موتور برنامه‌ریزی{' '}
                <strong>۰ ساعت</strong> لحاظ شده و هیچ عملیات جدیدی تا پایان تعمیرات روی آن بارگذاری نمی‌شود.
              </FioriMessageStrip>
            ) : (
              <>
                <div className="bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] p-3.5 space-y-3">
                  <div className="flex items-center justify-between text-xs text-[var(--fiori-brand)] font-semibold border-b border-[var(--fiori-border-subtle)] pb-2">
                    <span className="flex items-center gap-1.5">
                      <Calculator className="w-4 h-4" />
                      فرمول دقیق محاسبه درصد لود ظرفیت این دستگاه:
                    </span>
                    <span className="font-mono text-[var(--fiori-critical)]">سقف ۲ شیفت = ۱۵ ساعت</span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center font-mono text-xs tabular-nums">
                    <div className="bg-[var(--fiori-bg-surface)] p-2 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)]">
                      <div className="text-[10px] text-[var(--fiori-text-secondary)] font-sans">
                        ۱. ساعات ضرب خالص
                      </div>
                      <div className="text-sm font-semibold text-[var(--fiori-positive)] mt-1">
                        {toPersianDigits(selectedMachineLoad.totalRunHours)} ساعت
                      </div>
                    </div>
                    <div className="bg-[var(--fiori-bg-surface)] p-2 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)]">
                      <div className="text-[10px] text-[var(--fiori-text-secondary)] font-sans">
                        ۲. تعویض قالب (SMED)
                      </div>
                      <div className="text-sm font-semibold text-[var(--fiori-brand)] mt-1">
                        +{toPersianDigits(selectedMachineLoad.totalSetupHours)} ساعت
                      </div>
                    </div>
                    <div className="bg-[var(--fiori-bg-surface)] p-2 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)]">
                      <div className="text-[10px] text-[var(--fiori-text-secondary)] font-sans">
                        ۳. چک‌لیست و PM شیفت
                      </div>
                      <div className="text-sm font-semibold text-[var(--fiori-text-primary)] mt-1">
                        +{toPersianDigits(selectedMachineLoad.baseShiftMaintenanceHours)} ساعت
                      </div>
                    </div>
                    <div className="bg-[var(--fiori-brand-bg)] p-2 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-brand-border)]">
                      <div className="text-[10px] text-[var(--fiori-brand)] font-sans font-semibold">
                        مجموع اشغال / ۱۵ ساعت
                      </div>
                      <div className="text-sm font-semibold text-[var(--fiori-brand)] mt-1">
                        {toPersianDigits(selectedMachineLoad.totalOccupiedHours)}h ({toPersianDigits(selectedMachineLoad.workloadPct)}%)
                      </div>
                    </div>
                  </div>

                  <div
                    className="text-[11px] text-[var(--fiori-text-primary)] bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] px-3 py-1.5 rounded-[var(--fiori-radius-sm)] font-mono text-center"
                    dir="ltr"
                  >
                    Load % = (({selectedMachineLoad.totalRunHours}h Run + {selectedMachineLoad.totalSetupHours}h Setup + {selectedMachineLoad.baseShiftMaintenanceHours}h PM) / 15h) × 100 = {selectedMachineLoad.workloadPct}%
                  </div>
                </div>

                {/* Operations Assigned to this Machine */}
                <FioriDataTable
                  columns={modalTaskColumns}
                  data={selectedMachineLoad.tasks}
                  rowKey={(t, idx) => `${t.planNumber}-${t.opCode}-${idx}`}
                  compact
                  bordered
                  toolbar={
                    <FioriToolbar
                      variant="table"
                      title={
                        <span className="inline-flex items-center gap-1.5">
                          <Layers className="w-4 h-4 text-[var(--fiori-brand)]" />
                          <span>لیست قطعات و عملیات‌های بارگذاری‌شده روی این دستگاه</span>
                        </span>
                      }
                      endContent={
                        <span className="text-[11px] text-[var(--fiori-text-secondary)]">
                          ظرفیت آزاد باقیمانده:{' '}
                          <strong className="text-[var(--fiori-positive)]">
                            {toPersianDigits(selectedMachineLoad.freeHours)} ساعت
                          </strong>
                        </span>
                      }
                    />
                  }
                  emptyState={
                    <EmptyState
                      variant="NO_DATA"
                      compact
                      title="عملیاتی روی این دستگاه بارگذاری نشده است"
                      description="ظرفیت ۱۵ ساعته این دستگاه در حال حاضر آزاد است."
                    />
                  }
                />
              </>
            )}
          </div>
        )}
      </FioriDialog>
    </>
  );
};
