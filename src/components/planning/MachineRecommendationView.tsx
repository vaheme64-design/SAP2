import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
  Layers,
  Cpu,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  ShieldAlert,
  ChevronDown,
  ChevronUp,
  FileCheck,
  Send,
  GitBranch,
  Info,
  HelpCircle,
  RotateCcw,
  ExternalLink,
  Check,
  Sliders,
} from 'lucide-react';
import {
  ProductionPlanSuggestion,
  ProposedOperationPlan,
  MachineEligibilityCheck,
} from '../../types/productionPlanning';
import { formatNumber, toPersianDigits } from '../../utils/formatters';
import { formatToJalali } from '../../utils/jalali';
import { useErpRouter } from '../../context/RouterContext';
import { useEnterpriseUx } from '../../context/EnterpriseUxContext';
import {
  buildInitial20PartsSchedule,
  MultiPartScheduleItem,
  ScheduledOpStep,
} from '../production/ErpProductionWorkbenchView';
import {
  FioriDialog,
  FioriMessageStrip,
  FioriObjectStatus,
} from '../fiori/ui';
import { EmptyState } from '../common/EmptyState';

const SCHEDULE_STORAGE_KEY = 'kpims_aps_multi_part_op_schedule_v2';

interface MachineRecommendationViewProps {
  suggestions: ProductionPlanSuggestion[];
  selectedSuggestionId: string | null;
  onSelectSuggestion: (id: string) => void;
  onApprovePlan: (id: string, approvedBy: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  onReleaseMo: (id: string, releasedBy: string) => Promise<{ success: boolean; message?: string; moId?: string; error?: string }>;
  onRevisePlan: (id: string, changeReason: string) => Promise<{ success: boolean; message?: string; newPlanId?: string; error?: string }>;
  onRefresh: () => Promise<void>;
  loading?: boolean;
}

export const MachineRecommendationView: React.FC<MachineRecommendationViewProps> = ({
  suggestions,
  selectedSuggestionId,
  onSelectSuggestion,
  onApprovePlan,
  onReleaseMo,
  onRevisePlan,
  onRefresh,
}) => {
  const router = useErpRouter();
  const { requestConfirm, recordAudit, showUndoToast } = useEnterpriseUx();

  const [expandedOperationIndex, setExpandedOperationIndex] = useState<number | null>(0);
  const [showAllCandidates, setShowAllCandidates] = useState<Record<number, boolean>>({});
  const [actionInProgress, setActionInProgress] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showWorkflowGuide, setShowWorkflowGuide] = useState<boolean>(true);

  // Manual override of machine per operation: key = `${planId}_${opIndex}`, value = MachineEligibilityCheck
  const [manualMachineOverrides, setManualMachineOverrides] = useState<Record<string, MachineEligibilityCheck>>({});

  // Track current shop-floor schedule from localStorage so we know if activePlan is already dispatched
  const [shopFloorSchedule, setShopFloorSchedule] = useState<MultiPartScheduleItem[]>([]);

  const loadShopFloorSchedule = useCallback((): MultiPartScheduleItem[] => {
    try {
      const saved = window.localStorage.getItem(SCHEDULE_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setShopFloorSchedule(parsed);
          return parsed;
        }
      }
      const initial = buildInitial20PartsSchedule();
      window.localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(initial));
      setShopFloorSchedule(initial);
      return initial;
    } catch {
      const fallback = buildInitial20PartsSchedule();
      setShopFloorSchedule(fallback);
      return fallback;
    }
  }, []);

  useEffect(() => {
    loadShopFloorSchedule();
  }, [loadShopFloorSchedule]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent)?.detail;
      if (detail?.part) {
        const updatedPart = detail.part;
        const oldUpper = detail.oldCode ? String(detail.oldCode).trim().toUpperCase() : '';
        const newUpper = String(updatedPart.code || '').trim().toUpperCase();
        setShopFloorSchedule(prev => {
          let changed = false;
          const next = prev.map(item => {
            const codeUpper = String(item.partCode || '').trim().toUpperCase();
            if (
              item.partId === updatedPart.id ||
              (oldUpper && codeUpper === oldUpper) ||
              codeUpper === newUpper
            ) {
              changed = true;
              return { ...item, partId: updatedPart.id, partCode: updatedPart.code, partName: updatedPart.name };
            }
            return item;
          });
          if (changed) {
            try {
              window.localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(next));
            } catch {
              // ignore
            }
          }
          return changed ? next : prev;
        });
      }
      onRefresh().catch(() => {});
    };
    window.addEventListener('kpims-master-data-updated', handler);
    return () => window.removeEventListener('kpims-master-data-updated', handler);
  }, [onRefresh]);

  // Revision Modal State
  const [showRevisionModal, setShowRevisionModal] = useState(false);
  const [revisionReason, setRevisionReason] = useState('');

  // Current selected suggestion
  const activePlan = suggestions.find(s => s.id === selectedSuggestionId) || suggestions[0] || null;

  // Check if activePlan is already dispatched to shop-floor schedule
  const dispatchedScheduleItem = useMemo(() => {
    if (!activePlan) return null;
    return (
      shopFloorSchedule.find(
        item =>
          item.id === `SCH-${activePlan.id}` ||
          (activePlan.createdMoId && item.orderCode === activePlan.createdMoId)
      ) || null
    );
  }, [activePlan, shopFloorSchedule]);

  const toggleAllCandidates = (idx: number) => {
    setShowAllCandidates(prev => ({ ...prev, [idx]: !prev[idx] }));
  };

  const getEffectiveMachineForOp = (
    planId: string,
    opIdx: number,
    op: ProposedOperationPlan
  ): MachineEligibilityCheck | null => {
    const key = `${planId}_${opIdx}`;
    return manualMachineOverrides[key] || op.recommendedMachine || null;
  };

  const handleSelectCandidateMachine = (
    planId: string,
    opIdx: number,
    candidate: MachineEligibilityCheck,
    stepName: string
  ) => {
    if (!candidate.isEligible) return;
    const key = `${planId}_${opIdx}`;
    setManualMachineOverrides(prev => ({ ...prev, [key]: candidate }));
    setFeedbackMsg({
      type: 'success',
      text: `دستگاه «${candidate.machineName} (${candidate.machineCode})» به صورت دستی برای مرحله «${stepName}» انتخاب شد.`,
    });
  };

  // Recall / Remove a dispatched plan from shop-floor schedule
  const handleRecallFromShopFloor = () => {
    if (!activePlan || !dispatchedScheduleItem) return;

    requestConfirm({
      title: `ابطال ارسال دستور کار ${dispatchedScheduleItem.orderCode} از برنامه سالن (Reversal)`,
      description: `آیا مطمئن هستید که می‌خواهید وضعیت اعزام برنامه تولید قطعه «${activePlan.partName}» (${dispatchedScheduleItem.orderCode}) را در ماتریس OP سالن ابطال کنید؟`,
      consequences: [
        `تمامی ایستگاه‌های کاری (${toPersianDigits(dispatchedScheduleItem.ops.length)} مرحله OP) مربوط به دستور ${dispatchedScheduleItem.orderCode} در برنامه سالن ابطال و ظرفیت پرس‌ها آزاد می‌گردد.`,
        `تاریخچه عملیات در لاگ ممیزی ثبت شده و پیشنهاد برنامه در همین صفحه حفظ می‌شود.`,
      ],
      confirmLabel: 'تایید ابطال اعزام (Reversal)',
      cancelLabel: 'انصراف',
      variant: 'danger',
      onConfirm: () => {
        const current = loadShopFloorSchedule();
        const previousSnapshot = [...current];
        const filtered = current.map(item =>
          item.id === dispatchedScheduleItem.id ? { ...item, status: 'CANCELLED' as const, cancelReason: 'ابطال اعزام از برنامه سالن (APS Reversal)' } : item
        );
        try {
          window.localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(filtered));
        } catch {
          // ignore
        }
        setShopFloorSchedule(filtered);

        recordAudit({
          moduleName: 'موتور تطبیق ماشین‌آلات (APS)',
          actionType: 'REVERSAL',
          title: `ابطال اعزام دستور کار: ${activePlan.partName}`,
          details: `دستور کار ${dispatchedScheduleItem.orderCode} در برنامه روزانه و ماتریس OP سالن ابطال (CANCELLED) شد.`,
        });

        setFeedbackMsg({
          type: 'success',
          text: `اعزام دستور کار ${dispatchedScheduleItem.orderCode} (${activePlan.partName}) با موفقیت ابطال و ثبت ممیزی شد.`,
        });

        showUndoToast({
          title: `اعزام دستور کار ${dispatchedScheduleItem.orderCode} ابطال شد`,
          detail: 'برای بازگردانی فوری به برنامه سالن روی Undo کلیک کنید.',
          variant: 'warning',
          onUndo: () => {
            try {
              window.localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(previousSnapshot));
            } catch {
              // ignore
            }
            setShopFloorSchedule(previousSnapshot);
          },
        });
      },
    });
  };

  // Confirm & Dispatch to Shop Floor
  const handleApproveAndDispatchToShopFloor = () => {
    if (!activePlan) return;

    const opsPreview = activePlan.proposedOperations.map((op, idx) => {
      const chosenMachine = getEffectiveMachineForOp(activePlan.id, idx, op);
      return `${op.stepCode} (${op.stepName}) ← ${chosenMachine?.machineName || 'پرس پیش‌فرض'} [${chosenMachine?.machineCode || '—'}]`;
    });

    const requiredGrade = activePlan.materialStatus?.requiredGrade || 'ST37 / DC01';
    const requiredKg = activePlan.materialStatus?.requiredWeightKg || 0;

    requestConfirm({
      title: dispatchedScheduleItem
        ? `بروزرسانی دستور کار ارسالی (${dispatchedScheduleItem.orderCode}) در برنامه سالن`
        : `تأیید نهایی پیشنهاد و ارسال به برنامه روزانه سالن تولید`,
      description: `با تایید این عملیات، برنامه تولید قطعه «${activePlan.partName} (${activePlan.partCode})» به تیراژ خالص ${formatNumber(activePlan.proposedQuantity)} عدد مستقیماً به «ماتریس برنامه‌ریزی OP» و «شیت برنامه روزانه شیفت (امروز)» ارسال می‌شود.`,
      consequences: [
        `قطعه و تیراژ هدف: ${activePlan.partName} — ${formatNumber(activePlan.proposedQuantity)} عدد`,
        `ورق و متریال اختصاصی قطعه: ورق ${requiredGrade} به وزن خالص ${formatNumber(requiredKg)} کیلوگرم`,
        ...opsPreview,
        `پس از تایید، به صفحه «برنامه روزانه شیفت» هدایت می‌شوید و در هر زمان می‌توانید ارسال را لغو یا حذف نمایید.`,
      ],
      confirmLabel: dispatchedScheduleItem
        ? 'بروزرسانی و مشاهده در برنامه سالن'
        : 'تایید و ارسال به سالن تولید',
      cancelLabel: 'انصراف و بررسی بیشتر',
      variant: 'indigo',
      onConfirm: async () => {
        setActionInProgress(true);
        setFeedbackMsg(null);
        try {
          // 1. Approve plan via backend if in draft
          if (activePlan.approvalStatus === 'DRAFT_SUGGESTION') {
            await onApprovePlan(activePlan.id, 'مدیر برنامه‌ریزی تولید').catch(() => null);
          }

          // 2. Load existing 20-part schedule safely (never overwrite with empty array)
          const currentSchedule = loadShopFloorSchedule();

          const newMoNumber =
            dispatchedScheduleItem?.orderCode ||
            activePlan.createdMoId ||
            `MO-1404-${String(Math.floor(2100 + Math.random() * 7800))}`;

          const unitWeight =
            Number(
              (
                (activePlan.materialStatus?.requiredWeightKg || activePlan.proposedQuantity * 1.5) /
                Math.max(1, activePlan.proposedQuantity)
              ).toFixed(2)
            ) || 1.5;

          const totalOpsCount = activePlan.proposedOperations.length;

          const opsList: ScheduledOpStep[] = activePlan.proposedOperations.map(
            (op: ProposedOperationPlan, idx: number) => {
              const chosenMachine = getEffectiveMachineForOp(activePlan.id, idx, op);
              const cycleSec = Math.max(4, op.standardCycleTimeSec || 12);
              const standardRatePerHour = Math.max(50, Math.round(3600 / cycleSec));

              return {
                opId: `OP-${activePlan.id}-${idx + 1}`,
                opNo: (idx + 1) * 10,
                opCode: op.stepCode || `OP${(idx + 1) * 10}`,
                opTitle: op.stepName,
                stationHall: 'سالن پرس و فرم‌دهی',
                machineCode: chosenMachine?.machineCode || 'PRS-250-01',
                machineName: chosenMachine?.machineName || 'پرس ضربه‌ای ۲۵۰ تن ۱',
                dieCode: op.dieMoldCode || `DIE-${activePlan.partCode}-${(idx + 1) * 10}`,
                standardRatePerHour,
                // Schedule OP10 on Day 1 (Today) so the user immediately sees it in Today's Daily Dispatch Sheet!
                scheduledDayIndex: Math.min(6, idx + 1),
                shiftName: idx % 2 === 0 ? 'شیفت صبح' : 'شیفت عصر',
                basePlannedQty: op.plannedQuantity || activePlan.proposedQuantity,
                carriedOverQty: 0,
                effectiveTargetQty: op.plannedQuantity || activePlan.proposedQuantity,
                completedGoodQty: 0,
                scrapQty: 0,
                wipBufferBeforeOp: idx === 0 ? activePlan.proposedQuantity : 0,
                wipBufferAfterOp: 0,
                isFinalOp: idx === totalOpsCount - 1,
                status: idx === 0 ? 'IN_PROGRESS' : 'PLANNED',
              };
            }
          );

          const newItem: MultiPartScheduleItem = {
            id: `SCH-${activePlan.id}`,
            orderCode: newMoNumber,
            partId: activePlan.partId,
            partCode: activePlan.partCode,
            partName: activePlan.partName,
            carModel: 'ساپکو / ایران‌خودرو',
            partType: 'SUB_ASSEMBLY',
            rawMaterialCode: `RM-SHEET-${requiredGrade.replace(/\s+/g, '-')}`,
            rawMaterialName: `ورق فولادی ${requiredGrade} (مخصوص ${activePlan.partName})`,
            unitWeightKg: unitWeight,
            weeklyTargetQty: activePlan.proposedQuantity,
            rawMaterialIssuedKg:
              activePlan.materialStatus?.availableWeightKg ||
              activePlan.materialStatus?.requiredWeightKg ||
              Math.round(activePlan.proposedQuantity * unitWeight),
            warehouseReceivedQty: 0,
            ops: opsList,
          };

          const existingIdx = currentSchedule.findIndex(
            s => s.id === newItem.id || s.orderCode === newMoNumber
          );

          const nextSchedule = [...currentSchedule];
          if (existingIdx >= 0) {
            nextSchedule[existingIdx] = newItem;
          } else {
            nextSchedule.unshift(newItem);
          }

          try {
            window.localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(nextSchedule));
          } catch {
            // ignore
          }
          setShopFloorSchedule(nextSchedule);

          // 3. Record audit trail & toast
          recordAudit({
            moduleName: 'موتور تطبیق ماشین‌آلات (APS)',
            actionType: 'COMPLETE_MO',
            title: `تایید پیشنهاد و ارسال به سالن: ${activePlan.partName}`,
            details: `دستور ${newMoNumber} با تیراژ ${activePlan.proposedQuantity} قطعه و ورق ${requiredGrade} به برنامه روزانه کارگاه ارسال شد.`,
          });

          showUndoToast({
            title: `دستور تولید «${activePlan.partName}» (${newMoNumber}) به سالن ارسال شد`,
            detail: 'در حال نمایش در شیت برنامه روزانه شیفت (امروز)...',
            variant: 'success',
          });

          await onRefresh();

          // 4. Navigate explicitly to ERP_WORKBENCH -> DAILY_DISPATCH_SHEET
          router.navigate({
            tab: 'production',
            productionViewMode: 'ERP_WORKBENCH',
            productionModuleTab: 'DAILY_DISPATCH_SHEET',
          });
        } catch (err: any) {
          setFeedbackMsg({
            type: 'error',
            text: err.message || 'خطا در تایید و ارسال به برنامه سالن',
          });
        } finally {
          setActionInProgress(false);
        }
      },
    });
  };

  const handleApprove = () => {
    if (!activePlan) return;
    requestConfirm({
      title: `تأیید و تصویب برنامه تولید ${activePlan.planNumber}`,
      message: `آیا تصویب برنامه قطعه «${activePlan.partName} (${activePlan.partCode})» به تیراژ ${formatNumber(activePlan.proposedQuantity)} عدد و رزرو ظرفیت ماشین‌آلات و ورق را تأیید می‌کنید؟`,
      confirmLabel: 'تأیید و تصویب برنامه',
      variant: 'emerald',
      onConfirm: async () => {
        setActionInProgress(true);
        setFeedbackMsg(null);
        try {
          const res = await onApprovePlan(activePlan.id, 'مدیر برنامه‌ریزی تولید');
          if (res.success) {
            setFeedbackMsg({
              type: 'success',
              text:
                res.message ||
                'برنامه تولید با موفقیت تصویب شد و ظرفیت ماشین/ورق در سطح برنامه‌ریزی رزرو گردید (هنوز به کف سالن دیسپچ نشده است).',
            });
            await onRefresh();
          } else {
            setFeedbackMsg({ type: 'error', text: res.error || 'خطا در تصویب برنامه' });
          }
        } catch (err) {
          setFeedbackMsg({ type: 'error', text: err instanceof Error ? err.message : 'خطای ارتباط' });
        } finally {
          setActionInProgress(false);
        }
      },
    });
  };

  const handleRelease = () => {
    if (!activePlan) return;
    requestConfirm({
      title: `صدور کد رسمی MO برای برنامه ${activePlan.planNumber}`,
      message: `آیا صدور دستور کار ساخت (MO) در کارگاه WIP برای قطعه «${activePlan.partName}» به تیراژ ${formatNumber(activePlan.proposedQuantity)} عدد را تأیید می‌کنید؟`,
      confirmLabel: 'تأیید و صدور MO',
      variant: 'indigo',
      onConfirm: async () => {
        setActionInProgress(true);
        setFeedbackMsg(null);
        try {
          const res = await onReleaseMo(activePlan.id, 'سرپرست برنامه‌ریزی');
          if (res.success) {
            setFeedbackMsg({
              type: 'success',
              text: `دستور کار کارگاهی با شناسه ${res.moId || ''} ایجاد و به خط تولید صادر گردید.`,
            });
            await onRefresh();
          } else {
            setFeedbackMsg({ type: 'error', text: res.error || 'خطا در صدور دستور کار' });
          }
        } catch (err) {
          setFeedbackMsg({ type: 'error', text: err instanceof Error ? err.message : 'خطای ارتباط' });
        } finally {
          setActionInProgress(false);
        }
      },
    });
  };

  const handleCreateRevision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activePlan || !revisionReason.trim()) return;
    setActionInProgress(true);
    setFeedbackMsg(null);
    try {
      const res = await onRevisePlan(activePlan.id, revisionReason.trim());
      if (res.success) {
        setFeedbackMsg({ type: 'success', text: res.message || 'نسخه جدید برنامه ایجاد شد.' });
        setShowRevisionModal(false);
        setRevisionReason('');
        await onRefresh();
        if (res.newPlanId) {
          onSelectSuggestion(res.newPlanId);
        }
      } else {
        setFeedbackMsg({ type: 'error', text: res.error || 'خطا در ایجاد بازنگری' });
      }
    } catch (err) {
      setFeedbackMsg({ type: 'error', text: err instanceof Error ? err.message : 'خطای ارتباط' });
    } finally {
      setActionInProgress(false);
    }
  };

  if (!activePlan && suggestions.length === 0) {
    return (
      <div className="sap-card p-6 border border-[var(--fiori-border)]">
        <EmptyState
          variant="NO_DATA"
          title="هیچ برنامه تولید پیشنهادی یافت نشد"
          description="برای ایجاد برنامه‌های پیشنهادی، سفارشات مشتریان را ثبت کرده یا دکمه «محاسبه مجدد تقاضا و برنامه‌ریزی هوشمند» را بزنید."
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Engineering Role & Action Buttons Guide Banner */}
      <div className="bg-[var(--fiori-info-bg)] border border-[var(--fiori-info-border)] rounded-[var(--fiori-radius-sm)] p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-brand)] text-white shrink-0">
              <HelpCircle className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-xs sm:text-sm font-bold text-[var(--fiori-text-primary)]">
                راهنمای مهندسی: این صفحه در فرآیند برنامه‌ریزی چه کاری انجام می‌دهد و تفاوت دکمه‌ها چیست؟
              </h3>
              <p className="text-[11px] text-[var(--fiori-text-secondary)] mt-0.5">
                شفاف‌سازی وظیفه موتور تطبیق پرس (APS) و تفاوت «تصویب برنامه» با «ارسال مستقیم به سالن تولید»
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowWorkflowGuide(prev => !prev)}
            className="sap-btn-standard text-xs font-bold px-2.5 py-1 cursor-pointer shrink-0"
          >
            {showWorkflowGuide ? 'بستن راهنما' : 'نمایش راهنما'}
          </button>
        </div>

        {showWorkflowGuide && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3 pt-3 border-t border-[var(--fiori-info-border)] text-xs">
            <div className="bg-[var(--fiori-surface)] p-3 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border)] space-y-1">
              <div className="font-bold text-[var(--fiori-text-primary)] flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-[var(--fiori-critical)]" />
                <span>۱. وظیفه این صفحه (تطبیق و انتخاب پرس)</span>
              </div>
              <p className="text-[11px] text-[var(--fiori-text-secondary)] leading-relaxed">
                سیستم برای هر مرحله عملیات قطعه (OP10، OP20 و ...) تمام پرس‌های کارخانه را از نظر <strong>تناژ الزامی قالب</strong>، <strong>سازگاری ابعاد میز</strong> و <strong>ساعت آزاد شیفت</strong> بررسی کرده و بهترین پرس را پیشنهاد می‌دهد. شما می‌توانید در هر مرحله، پرس پیشنهادی را <strong>به صورت دستی تغییر دهید</strong>.
              </p>
            </div>

            <div className="bg-[var(--fiori-surface)] p-3 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-positive-border)] space-y-1">
              <div className="font-bold text-[var(--fiori-positive)] flex items-center gap-1.5">
                <FileCheck className="w-3.5 h-3.5 text-[var(--fiori-positive)]" />
                <span>۲. دکمه «تأیید و تصویب برنامه»</span>
              </div>
              <p className="text-[11px] text-[var(--fiori-text-secondary)] leading-relaxed">
                فقط وضعیت برنامه را در واحد برنامه‌ریزی از «پیش‌نویس» به <strong>«مصوب مدیر تولید»</strong> تغییر می‌دهد و ظرفیت پرس و کلاف ورق را رزرو می‌کند، اما <strong>هنوز کاری به شیت روزانه سرپرست سالن ارسال نمی‌کند</strong>.
              </p>
            </div>

            <div className="bg-[var(--fiori-surface)] p-3 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-info-border)] space-y-1">
              <div className="font-bold text-[var(--fiori-brand)] flex items-center gap-1.5">
                <Send className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
                <span>۳. دکمه «تایید پیشنهاد و ارسال به سالن»</span>
              </div>
              <p className="text-[11px] text-[var(--fiori-text-secondary)] leading-relaxed">
                پس از نمایش <strong>پنجره تایید مشخصات</strong>، دستور کار را با ورق اختصاصی همان قطعه و پرس‌های انتخابی مستقیماً وارد <strong>«ماتریس برنامه‌ریزی OP»</strong> و <strong>«برنامه روزانه شیفت (امروز)»</strong> می‌کند و در هر زمان از همین صفحه <strong>قابل لغو و حذف</strong> است.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Feedback Alert */}
      {feedbackMsg && (
        <FioriMessageStrip
          tone={feedbackMsg.type === 'success' ? 'success' : 'error'}
          onClose={() => setFeedbackMsg(null)}
          compact
        >
          {feedbackMsg.text}
        </FioriMessageStrip>
      )}

      {/* Dispatched Status & Recall Banner if already sent to shop floor */}
      {dispatchedScheduleItem && (
        <FioriMessageStrip
          tone="success"
          title="این برنامه قبلاً به سالن تولید ارسال شده است"
          actions={
            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              <button
                type="button"
                onClick={() =>
                  router.navigate({
                    tab: 'production',
                    productionViewMode: 'ERP_WORKBENCH',
                    productionModuleTab: 'DAILY_DISPATCH_SHEET',
                  })
                }
                className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold cursor-pointer"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>مشاهده در برنامه روزانه سالن</span>
              </button>
              <button
                type="button"
                onClick={handleRecallFromShopFloor}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--fiori-negative)] hover:opacity-90 text-white rounded-[var(--fiori-radius-sm)] text-xs font-bold transition cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>ابطال ارسال به سالن (Reversal)</span>
              </button>
            </div>
          }
        >
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <span>شماره دستور کار:</span>
            <button
              type="button"
              onClick={() => router.traceDocument(dispatchedScheduleItem.orderCode, 'WIP_TRACEABILITY')}
              className="sap-doc-link fiori-ltr-code font-bold cursor-pointer"
            >
              {dispatchedScheduleItem.orderCode}
            </button>
            <span>• ورق اختصاص‌یافته: <strong>{dispatchedScheduleItem.rawMaterialName}</strong></span>
            <span>• تیراژ هدف: <strong className="tabular-nums">{formatNumber(dispatchedScheduleItem.weeklyTargetQty)} عدد</strong></span>
            <span>• تعداد ایستگاه: <strong className="tabular-nums">{toPersianDigits(dispatchedScheduleItem.ops.length)} مرحله OP</strong></span>
          </div>
        </FioriMessageStrip>
      )}

      {/* Plan Selector & Quick Actions Top Bar */}
      <div className="sap-card p-4 border border-[var(--fiori-border)]">
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-[var(--fiori-brand-subtle)] border border-[var(--fiori-info-border)] rounded-[var(--fiori-radius-sm)] text-[var(--fiori-brand)]">
              <Cpu className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-sm sm:text-base font-bold text-[var(--fiori-text-primary)]">
                  موتور تطبیق و اولویت‌بندی ماشین‌آلات پرس و تجهیزات
                </h2>
                <FioriObjectStatus tone="neutral" size="sm" label={`${toPersianDigits(suggestions.length)} پیشنهاد فعال`} />
              </div>
              <p className="text-xs text-[var(--fiori-text-secondary)] mt-0.5">
                تخصیص هوشمند مراحل مسیر تولید براساس تناژ، سازگاری قالب، وضعیت سلامت دستگاه و سقف ظرفیت شیفت
              </p>
            </div>
          </div>

          {/* Plan Selector Dropdown */}
          <div className="w-full lg:w-auto flex flex-wrap items-center gap-2.5">
            <label className="text-xs font-bold text-[var(--fiori-text-secondary)]">انتخاب برنامه قطعه:</label>
            <select
              value={activePlan?.id || ''}
              onChange={e => onSelectSuggestion(e.target.value)}
              className="bg-[var(--fiori-surface)] border border-[var(--fiori-border-strong)] text-[var(--fiori-text-primary)] text-xs font-bold rounded-[var(--fiori-radius-sm)] px-3 py-1.5 focus:outline-none focus:border-[var(--fiori-brand)] cursor-pointer"
            >
              {suggestions.map(s => (
                <option key={s.id} value={s.id}>
                  {s.planNumber} (نسخه {toPersianDigits(s.planVersion)}) - {s.partName} ({formatNumber(s.proposedQuantity)} عدد)
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {activePlan && (
        <>
          {/* Active Plan Summary Card */}
          <div className="sap-card p-4 space-y-4 border border-[var(--fiori-border)]">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[var(--fiori-border)] pb-3.5">
              <div>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <button
                    type="button"
                    onClick={() => router.traceDocument(activePlan.planNumber, 'WIP_TRACEABILITY')}
                    className="sap-doc-link text-base font-bold fiori-ltr-code tracking-tight cursor-pointer"
                  >
                    {activePlan.planNumber}
                  </button>
                  <FioriObjectStatus tone="critical" size="sm" label={`نسخه ${toPersianDigits(activePlan.planVersion)}`} />
                  {activePlan.approvalStatus === 'DRAFT_SUGGESTION' && (
                    <FioriObjectStatus tone="info" size="sm" icon label="پیش‌نویس موتور برنامه‌ریزی" />
                  )}
                  {activePlan.approvalStatus === 'APPROVED' && (
                    <FioriObjectStatus tone="positive" size="sm" icon label="مصوب مدیر تولید (رزرو ظرفیت)" />
                  )}
                  {activePlan.approvalStatus === 'CONVERTED_TO_MO' && (
                    <FioriObjectStatus tone="brand" size="sm" icon label="صادر شده به دستور کار کارگاهی" />
                  )}
                </div>
                <div className="text-sm text-[var(--fiori-text-primary)] font-medium mt-1.5 flex flex-wrap items-center gap-3">
                  <span>
                    قطعه: <strong className="text-[var(--fiori-text-primary)] font-bold">{activePlan.partName}</strong>
                  </span>
                  <button
                    type="button"
                    onClick={() => router.traceDocument(activePlan.partCode, 'INVENTORY_LEDGER')}
                    className="sap-doc-link fiori-ltr-code text-xs cursor-pointer"
                  >
                    {activePlan.partCode}
                  </button>
                  <span className="text-xs text-[var(--fiori-text-secondary)] bg-[var(--fiori-surface-subtle)] border border-[var(--fiori-border)] px-2 py-0.5 rounded-[var(--fiori-radius-sm)]">
                    موعد تحویل سفارشات: <strong className="tabular-nums">{formatToJalali(activePlan.targetDueDate)}</strong>
                  </span>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2 shrink-0 flex-wrap">
                {activePlan.approvalStatus === 'DRAFT_SUGGESTION' && (
                  <button
                    type="button"
                    onClick={handleApprove}
                    disabled={actionInProgress || !activePlan.overallFeasible}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 bg-[#107e3e] hover:bg-[#0c6631] text-white rounded text-xs font-bold transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    title="تصویب برنامه در واحد برنامه‌ریزی و رزرو ظرفیت بدون ارسال فوری به شیت روزانه کف سالن"
                  >
                    <FileCheck className="w-4 h-4" />
                    <span>تأیید و تصویب برنامه (رزرو ظرفیت)</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleApproveAndDispatchToShopFloor}
                  disabled={actionInProgress || !activePlan.overallFeasible}
                  className="sap-btn-emphasized flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold disabled:opacity-50 cursor-pointer"
                  title="مشاهده خلاصه تایید و ارسال عملیات‌ها به ماتریس OP و شیت برنامه روزانه سالن تولید"
                >
                  <Send className="w-4 h-4" />
                  <span>
                    {dispatchedScheduleItem
                      ? 'بروزرسانی برنامه در سالن تولید'
                      : 'تایید پیشنهاد و ارسال به سالن'}
                  </span>
                </button>

                {activePlan.approvalStatus === 'APPROVED' && (
                  <button
                    type="button"
                    onClick={handleRelease}
                    disabled={actionInProgress}
                    className="sap-btn-emphasized flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold disabled:opacity-50 cursor-pointer"
                  >
                    <Send className="w-4 h-4" />
                    صدور کد رسمی MO
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setShowRevisionModal(true)}
                  disabled={actionInProgress}
                  className="sap-btn-standard flex items-center gap-1 px-3 py-1.5 text-xs font-bold cursor-pointer"
                >
                  <GitBranch className="w-3.5 h-3.5 text-[#e9730c]" />
                  ایجاد بازنگری (Revision)
                </button>
              </div>
            </div>

            {/* Infeasibility Warnings Banner if any */}
            {!activePlan.overallFeasible && (
              <FioriMessageStrip
                tone="error"
                title="برنامه با محدودیت‌های خط تولید مواجه بوده و قابل اجرای مستقیم نیست:"
              >
                <ul className="list-disc list-inside space-y-0.5 pr-2 mt-1">
                  {activePlan.infeasibilityWarnings.map((w, idx) => (
                    <li key={idx}>{w}</li>
                  ))}
                </ul>
              </FioriMessageStrip>
            )}

            {/* Calculations Breakdown Grid */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <div className="bg-[var(--fiori-surface-subtle)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border)]">
                <div className="text-[11px] text-[var(--fiori-text-secondary)]">تقاضای ناخالص سفارشات</div>
                <div className="text-sm font-bold text-[var(--fiori-text-primary)] mt-0.5 tabular-nums">
                  {formatNumber(activePlan.grossDemand)} <span className="text-[10px] text-[var(--fiori-text-secondary)]">عدد</span>
                </div>
              </div>
              <div className="bg-[var(--fiori-surface-subtle)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border)]">
                <div className="text-[11px] text-[var(--fiori-text-secondary)]">موجودی آزاد انبار محصول</div>
                <div className="text-sm font-bold text-[var(--fiori-positive)] mt-0.5 tabular-nums">
                  {formatNumber(activePlan.availableFg)} <span className="text-[10px] text-[var(--fiori-text-secondary)]">عدد</span>
                </div>
              </div>
              <div className="bg-[var(--fiori-surface-subtle)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border)]">
                <div className="text-[11px] text-[var(--fiori-text-secondary)]">موجودی نیمه‌ساخته (WIP)</div>
                <div className="text-sm font-bold text-[var(--fiori-brand)] mt-0.5 tabular-nums">
                  {formatNumber(activePlan.wipCredit)} <span className="text-[10px] text-[var(--fiori-text-secondary)]">عدد</span>
                </div>
              </div>
              <div className="bg-[var(--fiori-critical-bg)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-critical-border)]">
                <div className="text-[11px] text-[var(--fiori-critical)] font-bold">الزام خالص تولید (تیراژ برنامه)</div>
                <div className="text-sm font-black text-[var(--fiori-critical)] mt-0.5 tabular-nums">
                  {formatNumber(activePlan.proposedQuantity)} <span className="text-[10px]">عدد</span>
                </div>
              </div>
              <div className="bg-[var(--fiori-surface-subtle)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border)]">
                <div className="text-[11px] text-[var(--fiori-text-secondary)]">
                  ورق مصرفی ({activePlan.materialStatus.requiredGrade})
                </div>
                <div className="text-sm font-bold text-[var(--fiori-text-primary)] mt-0.5 tabular-nums">
                  {formatNumber(activePlan.materialStatus.requiredWeightKg)} <span className="text-[10px] text-[var(--fiori-text-secondary)]">kg</span>
                </div>
              </div>
              <div className="bg-[var(--fiori-surface-subtle)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border)]">
                <div className="text-[11px] text-[var(--fiori-text-secondary)]">وضعیت موجودی ورق در انبار</div>
                <div
                  className={`text-sm font-bold mt-0.5 tabular-nums ${
                    activePlan.materialStatus.hasShortage ? 'text-[var(--fiori-negative)]' : 'text-[var(--fiori-positive)]'
                  }`}
                >
                  {activePlan.materialStatus.hasShortage
                    ? `کسری ${formatNumber(activePlan.materialStatus.shortageKg)} kg`
                    : `تأمین کامل (${formatNumber(activePlan.materialStatus.availableWeightKg)} kg آزاد)`}
                </div>
              </div>
            </div>
          </div>

          {/* Proposed Operations List with Ranked Machine Cards */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-[var(--fiori-text-primary)] flex items-center gap-2">
                <Layers className="w-4 h-4 text-[var(--fiori-critical)]" />
                توالی عملیات مسیر تولید و انتخاب پرس هر ایستگاه (قابل تغییر دستی توسط برنامه‌ریز)
              </h3>
              <span className="text-xs text-[var(--fiori-text-secondary)] font-bold">
                {toPersianDigits(activePlan.proposedOperations.length)} مرحله عملیاتی (OP)
              </span>
            </div>

            <div className="space-y-4">
              {activePlan.proposedOperations.map((op, idx) => {
                const isExpanded = expandedOperationIndex === idx;
                const recMachine = getEffectiveMachineForOp(activePlan.id, idx, op);
                const isManuallyOverridden = Boolean(manualMachineOverrides[`${activePlan.id}_${idx}`]);
                const showCandidates = showAllCandidates[idx];

                return (
                  <div
                    key={idx}
                    className={`bg-[var(--fiori-surface)] border rounded-[var(--fiori-radius-md)] overflow-hidden transition ${
                      op.isInfeasible
                        ? 'border-[var(--fiori-negative-border)] bg-[var(--fiori-negative-bg)]'
                        : 'border-[var(--fiori-border)]'
                    }`}
                  >
                    {/* Operation Step Header Bar */}
                    <div
                      onClick={() => setExpandedOperationIndex(isExpanded ? null : idx)}
                      className="p-4 cursor-pointer hover:bg-[var(--fiori-surface-hover)] flex flex-col md:flex-row md:items-center justify-between gap-3 select-none"
                    >
                      <div className="flex items-center gap-3">
                        <span className="w-8 h-8 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-critical-bg)] text-[var(--fiori-critical)] font-mono text-xs font-black flex items-center justify-center border border-[var(--fiori-critical-border)] fiori-ltr-code">
                          {op.stepCode || `OP${toPersianDigits(op.stepNumber)}`}
                        </span>
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-bold text-[var(--fiori-text-primary)]">{op.stepName}</span>
                            <FioriObjectStatus tone="neutral" size="sm" ltrCode label={op.processType} />
                            {op.requiredTonnage > 0 && (
                              <FioriObjectStatus tone="critical" size="sm" label={`تناژ الزامی قالب: ${formatNumber(op.requiredTonnage)} تن`} />
                            )}
                          </div>
                          <div className="text-xs text-[var(--fiori-text-secondary)] mt-1 flex flex-wrap items-center gap-3">
                            <span>
                              تیراژ عملیات: <strong className="text-[var(--fiori-text-primary)] tabular-nums">{formatNumber(op.plannedQuantity)}</strong> عدد
                            </span>
                            <span>
                              سایکل استاندارد: <strong className="text-[var(--fiori-text-primary)] tabular-nums">{toPersianDigits(op.standardCycleTimeSec)}</strong> ثانیه
                            </span>
                            <span>
                              زمان خالص ضرب: <strong className="text-[var(--fiori-text-primary)] tabular-nums">{toPersianDigits(op.estimatedRunHours)}</strong> ساعت
                            </span>
                            {op.dieMoldName && (
                              <span className="text-[var(--fiori-brand)] font-medium">
                                قالب اختصاصی: {op.dieMoldName} ({op.dieMoldCode})
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 shrink-0">
                        {recMachine ? (
                          <div className="flex items-center gap-2">
                            <div className="text-left">
                              <div className="text-xs font-bold text-[var(--fiori-positive)] flex items-center gap-1 justify-end">
                                <CheckCircle2 className="w-3.5 h-3.5 text-[var(--fiori-positive)]" />
                                <span>
                                  {isManuallyOverridden ? 'انتخاب دستی برنامه‌ریز:' : 'پیشنهاد اول سیستم:'}{' '}
                                  {recMachine.machineName}
                                </span>
                              </div>
                              <div className="text-[10px] text-[var(--fiori-text-secondary)] tabular-nums">
                                امتیاز تناسب: {toPersianDigits(recMachine.suitabilityScore)}% | بار کاری فعلی: {toPersianDigits(recMachine.currentWorkloadPercent)}%
                              </div>
                            </div>
                            <FioriObjectStatus tone="positive" size="md" ltrCode label={recMachine.machineCode} />
                          </div>
                        ) : (
                          <FioriObjectStatus tone="negative" size="md" icon label="فاقد دستگاه مجاز و سازگار" />
                        )}
                        <button type="button" className="text-[var(--fiori-text-muted)] hover:text-[var(--fiori-text-primary)] p-1">
                          {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                        </button>
                      </div>
                    </div>

                    {/* Expanded Detail Panel */}
                    {isExpanded && (
                      <div className="p-4 border-t border-[var(--fiori-border)] bg-[var(--fiori-surface-subtle)] space-y-4">
                        {/* Top Selected/Recommended Machine Card Details */}
                        {recMachine ? (
                          <div className="bg-[var(--fiori-surface)] border border-[var(--fiori-positive-border)] rounded-[var(--fiori-radius-md)] p-4">
                            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                              <div>
                                <div className="flex items-center gap-2 flex-wrap">
                                  <FioriObjectStatus
                                    tone="positive"
                                    size="sm"
                                    label={
                                      isManuallyOverridden
                                        ? '✓ دستگاه انتخاب‌شده توسط برنامه‌ریز'
                                        : '★ اولویت اول پیشنهادی سیستم'
                                    }
                                  />
                                  <h4 className="text-sm font-bold text-[var(--fiori-text-primary)]">
                                    {recMachine.machineName} ({recMachine.machineCode})
                                  </h4>
                                </div>
                                <p className="text-xs text-[var(--fiori-text-secondary)] mt-1.5 leading-relaxed">
                                  {recMachine.recommendationReason}
                                </p>
                              </div>

                              <div className="grid grid-cols-3 gap-3 text-center shrink-0">
                                <div className="bg-[var(--fiori-surface-subtle)] p-2 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border)]">
                                  <div className="text-[10px] text-[var(--fiori-text-secondary)]">امتیاز شایستگی</div>
                                  <div className="text-sm font-black text-[var(--fiori-positive)] mt-0.5 tabular-nums">
                                    {toPersianDigits(recMachine.suitabilityScore)}/۱۰۰
                                  </div>
                                </div>
                                <div className="bg-[var(--fiori-surface-subtle)] p-2 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border)]">
                                  <div className="text-[10px] text-[var(--fiori-text-secondary)]">ظرفیت آزاد شیفت</div>
                                  <div className="text-sm font-bold text-[var(--fiori-brand)] mt-0.5 tabular-nums">
                                    {toPersianDigits(recMachine.availableHoursRemaining)} ساعت
                                  </div>
                                </div>
                                <div className="bg-[var(--fiori-surface-subtle)] p-2 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border)]">
                                  <div className="text-[10px] text-[var(--fiori-text-secondary)]">لود ظرفیت جاری</div>
                                  <div className="text-sm font-bold text-[var(--fiori-critical)] mt-0.5 tabular-nums">
                                    {toPersianDigits(recMachine.currentWorkloadPercent)}%
                                  </div>
                                </div>
                              </div>
                            </div>

                            {/* Workload Progress Bar */}
                            <div className="mt-3 pt-3 border-t border-[var(--fiori-border)] flex items-center gap-3">
                              <span className="text-[11px] text-[var(--fiori-text-secondary)] shrink-0">
                                اشغال ظرفیت دو شیفت کاری (سقف ۱۵ ساعت روزانه):
                              </span>
                              <div className="flex-1 bg-[var(--fiori-surface-subtle)] rounded-full h-2 overflow-hidden border border-[var(--fiori-border)]">
                                <div
                                  className={`h-full rounded-full transition-all ${
                                    recMachine.currentWorkloadPercent > 80
                                      ? 'bg-[var(--fiori-negative)]'
                                      : recMachine.currentWorkloadPercent > 60
                                      ? 'bg-[var(--fiori-critical)]'
                                      : 'bg-[var(--fiori-positive)]'
                                  }`}
                                  style={{ width: `${Math.min(100, recMachine.currentWorkloadPercent)}%` }}
                                />
                              </div>
                              <span className="text-[11px] font-mono font-bold text-[var(--fiori-text-primary)] shrink-0 tabular-nums">
                                {toPersianDigits(recMachine.currentWorkloadHours)} از {toPersianDigits(recMachine.dailyCapacityHours)} ساعت
                              </span>
                            </div>
                          </div>
                        ) : (
                          <FioriMessageStrip tone="error" title="توقف در برنامه‌ریزی این مرحله:">
                            هیچ ماشینی با مشخصات فنی مورد نیاز سازگار نیست.
                            <ul className="list-disc list-inside mt-1 space-y-0.5">
                              {op.infeasibilityReasons.map((r, i) => (
                                <li key={i}>{r}</li>
                              ))}
                            </ul>
                          </FioriMessageStrip>
                        )}

                        {/* Candidate Machines Audit Drawer Toggle */}
                        <div className="pt-1">
                          <button
                            type="button"
                            onClick={() => toggleAllCandidates(idx)}
                            className="text-xs text-[var(--fiori-brand)] hover:underline font-bold flex items-center gap-1.5 transition cursor-pointer"
                          >
                            <Info className="w-4 h-4" />
                            {showCandidates
                              ? 'بستن جدول مقایسه و تغییر دستی ماشین‌آلات'
                              : `مشاهده سایر پرس‌های ارزیابی‌شده و تغییر دستی ماشین (${toPersianDigits(op.allCandidateMachines.length)} دستگاه)`}
                          </button>

                          {showCandidates && (
                            <div className="mt-3 space-y-2 border-t border-[var(--fiori-border)] pt-3">
                              <div className="text-[11px] text-[var(--fiori-text-secondary)] mb-2">
                                برای تغییر پرس این مرحله، روی دکمه <strong>«انتخاب این پرس برای مرحله»</strong> در کارت دستگاه‌های مجاز کلیک کنید:
                              </div>

                              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                                {op.allCandidateMachines.map(cand => {
                                  const isCurrentlySelected =
                                    recMachine?.machineCode === cand.machineCode;
                                  return (
                                    <div
                                      key={cand.machineId}
                                      className={`p-3 rounded-[var(--fiori-radius-sm)] border text-xs space-y-2 transition ${
                                        isCurrentlySelected
                                          ? 'bg-[var(--fiori-positive-bg)] border-[var(--fiori-positive)] ring-1 ring-[var(--fiori-positive)]'
                                          : cand.isEligible
                                          ? 'bg-[var(--fiori-surface)] border-[var(--fiori-border)] text-[var(--fiori-text-primary)] hover:border-[var(--fiori-brand)]'
                                          : 'bg-[var(--fiori-negative-bg)] border-[var(--fiori-negative-border)] text-[var(--fiori-text-secondary)]'
                                      }`}
                                    >
                                      <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2">
                                          <span className="font-bold text-[var(--fiori-text-primary)]">{cand.machineName}</span>
                                          <span className="fiori-ltr-code text-[10px] text-[var(--fiori-text-secondary)]">({cand.machineCode})</span>
                                        </div>
                                        {cand.isEligible ? (
                                          <FioriObjectStatus tone="positive" size="sm" label={`رتبه ${toPersianDigits(cand.recommendationRank)} (مجاز)`} />
                                        ) : (
                                          <FioriObjectStatus tone="negative" size="sm" label="رد صلاحیت فنی" />
                                        )}
                                      </div>

                                      {/* Evaluation Criteria Checklist */}
                                      <div className="grid grid-cols-2 gap-1 text-[11px] text-[var(--fiori-text-secondary)] pt-1">
                                        <div className="flex items-center gap-1">
                                          {cand.supportsProcess ? (
                                            <CheckCircle2 className="w-3 h-3 text-[var(--fiori-positive)] shrink-0" />
                                          ) : (
                                            <XCircle className="w-3 h-3 text-[var(--fiori-negative)] shrink-0" />
                                          )}
                                          <span>پوشش فرایند: {cand.supportsProcess ? 'تأیید' : 'عدم تطابق'}</span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                          {cand.tonnageSufficient ? (
                                            <CheckCircle2 className="w-3 h-3 text-[var(--fiori-positive)] shrink-0" />
                                          ) : (
                                            <XCircle className="w-3 h-3 text-[var(--fiori-negative)] shrink-0" />
                                          )}
                                          <span>تناژ مجاز: {cand.tonnageSufficient ? 'کافی' : 'ناکافی'}</span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                          {cand.dieCompatible ? (
                                            <CheckCircle2 className="w-3 h-3 text-[var(--fiori-positive)] shrink-0" />
                                          ) : (
                                            <XCircle className="w-3 h-3 text-[var(--fiori-negative)] shrink-0" />
                                          )}
                                          <span>انطباق قالب: {cand.dieCompatible ? 'سازگار' : 'ناسازگار'}</span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                          {cand.isMachineActive ? (
                                            <CheckCircle2 className="w-3 h-3 text-[var(--fiori-positive)] shrink-0" />
                                          ) : (
                                            <XCircle className="w-3 h-3 text-[var(--fiori-negative)] shrink-0" />
                                          )}
                                          <span>وضعیت: {cand.isMachineActive ? 'آماده‌به‌کار' : 'متوقف / تعمیرات'}</span>
                                        </div>
                                      </div>

                                      {/* Ineligibility Reasons */}
                                      {!cand.isEligible && cand.ineligibilityReasons.length > 0 && (
                                        <div className="text-[11px] text-[var(--fiori-negative)] bg-[var(--fiori-negative-bg)] p-2 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-negative-border)] space-y-0.5 mt-1">
                                          {cand.ineligibilityReasons.map((r, ri) => (
                                            <div key={ri} className="flex items-center gap-1">
                                              <span>•</span>
                                              <span>{r}</span>
                                            </div>
                                          ))}
                                        </div>
                                      )}

                                      {cand.isEligible && (
                                        <div className="text-[11px] text-[var(--fiori-text-primary)] pt-2 border-t border-[var(--fiori-border)] flex items-center justify-between gap-2">
                                          <div className="flex items-center gap-3 tabular-nums">
                                            <span>
                                              ساعت آزاد: <strong>{toPersianDigits(cand.availableHoursRemaining)}h</strong>
                                            </span>
                                            <span>
                                              امتیاز: <strong className="text-[var(--fiori-positive)]">{toPersianDigits(cand.suitabilityScore)}</strong>
                                            </span>
                                          </div>
                                          {isCurrentlySelected ? (
                                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-positive)] text-white text-[10px] font-bold">
                                              <Check className="w-3 h-3" />
                                              ماشین انتخاب‌شده فعلی
                                            </span>
                                          ) : (
                                            <button
                                              type="button"
                                              onClick={() =>
                                                handleSelectCandidateMachine(
                                                  activePlan.id,
                                                  idx,
                                                  cand,
                                                  op.stepName
                                                )
                                              }
                                              className="sap-btn-standard px-2.5 py-1 text-[10px] font-bold cursor-pointer"
                                            >
                                              انتخاب این پرس برای مرحله
                                            </button>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Operational Workflow Chain Footer */}
          <div className="bg-[var(--fiori-info-bg)] border border-[var(--fiori-info-border)] rounded-[var(--fiori-radius-md)] p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs font-bold text-[var(--fiori-brand)]">
                <Cpu className="w-4 h-4 text-[var(--fiori-brand)]" />
                <span>زنجیره عملیاتی تجمیع برنامه و دیسپچ کارگاهی (APS → Daily Shop-Floor Dispatch)</span>
              </div>
              <p className="text-[11px] text-[var(--fiori-text-primary)] leading-relaxed">
                با کلیک روی دکمه روبرو، ابتدا پنجره تایید نهایی با جزئیات ورق مصرفی ({activePlan.materialStatus.requiredGrade}) و ایستگاه‌های OP نمایش داده می‌شود و پس از تایید شما، به شیت برنامه روزانه سالن تولید اضافه می‌گردد.
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              {dispatchedScheduleItem && (
                <button
                  type="button"
                  onClick={handleRecallFromShopFloor}
                  className="flex items-center gap-1.5 px-3.5 py-2 bg-[var(--fiori-surface)] hover:bg-[var(--fiori-negative-bg)] text-[var(--fiori-negative)] border border-[var(--fiori-negative-border)] rounded-[var(--fiori-radius-sm)] text-xs font-bold transition cursor-pointer"
                >
                  <RotateCcw className="w-4 h-4" />
                  <span>ابطال ارسال به سالن</span>
                </button>
              )}
              <button
                type="button"
                onClick={handleApproveAndDispatchToShopFloor}
                disabled={actionInProgress || !activePlan.overallFeasible}
                className="sap-btn-emphasized flex items-center gap-2 px-4 py-2 text-xs font-bold disabled:opacity-50 cursor-pointer"
              >
                <Send className="w-4 h-4" />
                <span>
                  {dispatchedScheduleItem
                    ? 'بروزرسانی برنامه در سالن تولید'
                    : 'تایید پیشنهاد و ارسال به سالن'}
                </span>
              </button>
            </div>
          </div>
        </>
      )}

      {/* Revision Modal */}
      <FioriDialog
        isOpen={showRevisionModal}
        onClose={() => setShowRevisionModal(false)}
        title="ایجاد نسخه بازنگری شده برنامه (Revision)"
        subtitle={`نسخه فعلی (${activePlan?.planVersion || ''}) بایگانی شده و نسخه جدیدی برای اعمال اصلاحات ایجاد می‌گردد.`}
        icon={<GitBranch className="w-4 h-4" />}
        tone="warning"
        size="md"
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowRevisionModal(false)}
              className="sap-btn-standard px-4 py-1.5 text-xs font-bold cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="machine-rec-revision-form"
              disabled={actionInProgress || !revisionReason.trim()}
              className="sap-btn-emphasized px-4 py-1.5 font-bold text-xs disabled:opacity-50 cursor-pointer"
            >
              {actionInProgress ? 'در حال ثبت...' : 'ایجاد نسخه جدید'}
            </button>
          </div>
        }
      >
        <form id="machine-rec-revision-form" onSubmit={handleCreateRevision} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-[var(--fiori-text-primary)] mb-1">
              علت بازنگری یا تغییر برنامه:
            </label>
            <textarea
              value={revisionReason}
              onChange={e => setRevisionReason(e.target.value)}
              placeholder="مثال: تغییر اولویت تحویل توسط ساپکو، خرابی پرس اصلی، کسری کلاف ورق..."
              required
              rows={3}
              className="w-full bg-[var(--fiori-surface)] border border-[var(--fiori-border-strong)] rounded-[var(--fiori-radius-sm)] p-2.5 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)]"
            />
          </div>
        </form>
      </FioriDialog>
    </div>
  );
};
