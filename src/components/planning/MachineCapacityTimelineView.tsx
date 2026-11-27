import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarClock,
  AlertTriangle,
  Cpu,
  Layers,
  Filter,
  RefreshCw,
  Plus,
  Edit3,
  RotateCcw,
  Calendar,
  Clock,
  Eye,
} from 'lucide-react';
import { ProductionPlanSuggestion } from '../../types/productionPlanning';
import { Part, Machine } from '../../types/inventory';
import { formatNumber, toPersianDigits } from '../../utils/formatters';
import { formatToJalali } from '../../utils/jalali';
import { useEnterpriseUx } from '../../context/EnterpriseUxContext';
import { useErpRouter } from '../../context/RouterContext';
import {
  FioriDataTable,
  FioriDialog,
  FioriDynamicPage,
  FioriMessageStrip,
  FioriObjectStatus,
  FioriStatusTone,
  FioriTableColumn,
  FioriToolbar,
} from '../fiori/ui';
import { EmptyState } from '../common/EmptyState';

interface MachineCapacityTimelineViewProps {
  suggestions?: ProductionPlanSuggestion[];
  parts?: Part[];
  machines?: Machine[];
  initialMachineCode?: string | null;
}

interface ShiftItem {
  id: string;
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  productiveHours: number;
}

interface MachineItem {
  id: string;
  code: string;
  name: string;
  hallLocation: string;
  machineType: string;
  tonnageCapacity: number | null;
  status: string;
  dailyCapacityHours: number;
  scheduledHours: number;
  availableCapacityHours: number;
  utilizationPercent: number;
  conflictsCount: number;
  capabilities: Array<{ operationId: string; operationCode: string; processType: string }>;
  compatibleDieIds: string[];
}

interface AssignmentSlot {
  id: string;
  sourceType: 'MACHINE_ASSIGNMENT' | 'OPERATION_SCHEDULE';
  productionOperationId: string;
  moId: string | null;
  moNumber: string;
  partCode: string;
  partName: string;
  stepNumber: number;
  stepCode: string;
  stepName: string;
  operationId: string | null;
  processType: string | null;
  machineId: string;
  machineCode: string;
  machineName: string;
  hallLocation: string;
  tonnageCapacity: number | null;
  shiftId: string;
  shiftCode: string;
  shiftName: string;
  assignedDate: string;
  plannedQty: number;
  estimatedHours: number;
  setupTimeMin: number;
  dieId: string | null;
  dieCode: string | null;
  requiredTonnage: number;
  status: 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  notes: string | null;
  hasConflict: boolean;
  conflictReasons: string[];
}

interface UnassignedOperation {
  productionOperationId: string;
  moNumber: string;
  partCode: string;
  partName: string;
  stepNumber: number;
  stepCode: string;
  stepName: string;
  plannedMachineId: string | null;
  plannedQty: number;
  estimatedHours: number;
  dieCode: string | null;
  requiredTonnage: number;
  suggestedDate: string;
  eligibleMachineIds: string[];
}

interface CapacityConflict {
  id: string;
  conflictType: 'SHIFT_DOUBLE_BOOKING' | 'DAILY_OVER_CAPACITY';
  machineId: string;
  machineCode: string;
  machineName: string;
  assignedDate: string;
  shiftId: string | null;
  shiftName: string | null;
  totalHours: number;
  capacityHours: number;
  assignmentIds: string[];
  moNumbers: string[];
  message: string;
}

const statusLabel: Record<string, string> = {
  SCHEDULED: 'زمان‌بندی‌شده',
  ACTIVE: 'در حال اجرا',
  COMPLETED: 'تکمیل‌شده',
  CANCELLED: 'لغوشده',
};

const statusTone: Record<string, FioriStatusTone> = {
  SCHEDULED: 'info',
  ACTIVE: 'positive',
  COMPLETED: 'neutral',
  CANCELLED: 'negative',
};

export const MachineCapacityTimelineView: React.FC<MachineCapacityTimelineViewProps> = ({
  initialMachineCode,
}) => {
  const { requestConfirm, recordAudit } = useEnterpriseUx();
  const { traceDocument } = useErpRouter();

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shifts, setShifts] = useState<ShiftItem[]>([]);
  const [machines, setMachines] = useState<MachineItem[]>([]);
  const [assignments, setAssignments] = useState<AssignmentSlot[]>([]);
  const [conflicts, setConflicts] = useState<CapacityConflict[]>([]);
  const [unassignedOps, setUnassignedOps] = useState<UnassignedOperation[]>([]);
  const [draftPreview, setDraftPreview] = useState<any[]>([]);
  const [showDraftPreview, setShowDraftPreview] = useState(false);

  const [selectedHall, setSelectedHall] = useState<string>('ALL');
  const [selectedMachineId, setSelectedMachineId] = useState<string>('ALL');
  const [selectedDateFilter, setSelectedDateFilter] = useState<string>('');
  const [onlyConflicts, setOnlyConflicts] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Planner assignment modal state (Create new or Edit existing slot)
  const [assignDraft, setAssignDraft] = useState<{
    mode: 'CREATE' | 'EDIT';
    assignmentId?: string;
    productionOperationId: string;
    moNumber: string;
    partName: string;
    stepCode: string;
    stepName: string;
    eligibleMachineIds: string[];
    machineId: string;
    shiftId: string;
    assignedDate: string;
    notes: string;
    conflictWarning?: string | null;
  } | null>(null);

  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const loadCapacity = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (selectedDateFilter) qs.set('date', selectedDateFilter);
      if (selectedHall !== 'ALL') qs.set('hall', selectedHall);
      if (selectedMachineId !== 'ALL') qs.set('machineId', selectedMachineId);
      if (onlyConflicts) qs.set('onlyConflicts', 'true');
      const res = await fetch(`/api/planning/machine-capacity${qs.toString() ? `?${qs.toString()}` : ''}`);
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'خطا در دریافت ظرفیت و تخصیص ماشین‌آلات');
      }
      const data = json.data || {};
      setShifts(Array.isArray(data.shifts) ? data.shifts : []);
      setMachines(Array.isArray(data.machines) ? data.machines : []);
      setAssignments(Array.isArray(data.assignments) ? data.assignments : []);
      setConflicts(Array.isArray(data.conflicts) ? data.conflicts : []);
      setUnassignedOps(Array.isArray(data.unassignedOperations) ? data.unassignedOperations : []);
      setDraftPreview(Array.isArray(data.draftProposalPreview) ? data.draftProposalPreview : []);
    } catch (err) {
      setFeedback({ type: 'error', text: err instanceof Error ? err.message : 'خطا در بارگذاری برنامه ظرفیت' });
    } finally {
      setLoading(false);
    }
  }, [selectedDateFilter, selectedHall, selectedMachineId, onlyConflicts]);

  useEffect(() => {
    void loadCapacity();
  }, [loadCapacity]);

  useEffect(() => {
    if (initialMachineCode && machines.length > 0) {
      const match = machines.find(m => m.code === initialMachineCode || m.code.includes(initialMachineCode.slice(0, 7)));
      if (match) {
        setSelectedMachineId(match.id);
        setTimeout(() => {
          rowRefs.current[match.id]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 120);
      }
    }
  }, [initialMachineCode, machines]);

  const halls = useMemo(() => Array.from(new Set(machines.map(m => m.hallLocation))), [machines]);

  const displayedMachines = useMemo(() => {
    let list = machines;
    if (selectedHall !== 'ALL') list = list.filter(m => m.hallLocation === selectedHall);
    if (selectedMachineId !== 'ALL') list = list.filter(m => m.id === selectedMachineId);
    if (onlyConflicts) list = list.filter(m => m.conflictsCount > 0 || assignments.some(a => a.machineId === m.id && a.hasConflict));
    return list;
  }, [machines, selectedHall, selectedMachineId, onlyConflicts, assignments]);

  const avgUtilization = useMemo(() => {
    if (!machines.length) return 0;
    return Math.round((machines.reduce((s, m) => s + m.utilizationPercent, 0) / machines.length) * 10) / 10;
  }, [machines]);

  const activeFiltersCount =
    (selectedHall !== 'ALL' ? 1 : 0) +
    (selectedMachineId !== 'ALL' ? 1 : 0) +
    (selectedDateFilter ? 1 : 0) +
    (onlyConflicts ? 1 : 0);

  const resetFilters = () => {
    setSelectedHall('ALL');
    setSelectedMachineId('ALL');
    setSelectedDateFilter('');
    setOnlyConflicts(false);
  };

  const openAssignModalForUnassigned = useCallback(
    (op: UnassignedOperation) => {
      const defaultMachineId =
        (op.plannedMachineId && op.eligibleMachineIds.includes(op.plannedMachineId)
          ? op.plannedMachineId
          : op.eligibleMachineIds[0]) ||
        machines[0]?.id ||
        '';
      setAssignDraft({
        mode: 'CREATE',
        productionOperationId: op.productionOperationId,
        moNumber: op.moNumber,
        partName: op.partName,
        stepCode: op.stepCode,
        stepName: op.stepName,
        eligibleMachineIds: op.eligibleMachineIds,
        machineId: defaultMachineId,
        shiftId: shifts[0]?.id || '',
        assignedDate: op.suggestedDate || new Date().toISOString().slice(0, 10),
        notes: '',
        conflictWarning: null,
      });
    },
    [machines, shifts]
  );

  const openEditModalForSlot = (slot: AssignmentSlot) => {
    const uMatch = unassignedOps.find(u => u.productionOperationId === slot.productionOperationId);
    const eligibleIds = uMatch?.eligibleMachineIds?.length
      ? uMatch.eligibleMachineIds
      : machines
          .filter(m => !slot.processType || m.capabilities.some(c => c.processType === slot.processType || c.operationCode === slot.operationId))
          .map(m => m.id);
    setAssignDraft({
      mode: slot.sourceType === 'MACHINE_ASSIGNMENT' ? 'EDIT' : 'CREATE',
      assignmentId: slot.sourceType === 'MACHINE_ASSIGNMENT' ? slot.id : undefined,
      productionOperationId: slot.productionOperationId,
      moNumber: slot.moNumber,
      partName: slot.partName,
      stepCode: slot.stepCode,
      stepName: slot.stepName,
      eligibleMachineIds: eligibleIds.length ? eligibleIds : machines.map(m => m.id),
      machineId: slot.machineId,
      shiftId: slot.shiftId,
      assignedDate: slot.assignedDate,
      notes: slot.notes || '',
      conflictWarning: null,
    });
  };

  const submitAssignment = async (allowConflictOverride = false) => {
    if (!assignDraft) return;
    setBusy(true);
    setFeedback(null);
    try {
      const isEdit = assignDraft.mode === 'EDIT' && assignDraft.assignmentId;
      const url = isEdit ? `/api/planning/machine-assignments/${assignDraft.assignmentId}` : '/api/planning/machine-assignments';
      const method = isEdit ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productionOperationId: assignDraft.productionOperationId,
          machineId: assignDraft.machineId,
          shiftId: assignDraft.shiftId,
          assignedDate: assignDraft.assignedDate,
          notes: assignDraft.notes || undefined,
          allowConflictOverride,
          actor: 'برنامه‌ریز تولید',
        }),
      });
      const json = await res.json();
      if (res.status === 409 && !allowConflictOverride) {
        setAssignDraft(prev => (prev ? { ...prev, conflictWarning: json.error || 'تداخل ظرفیت/شیفت تشخیص داده شد.' } : null));
        return;
      }
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'ثبت تخصیص ماشین ناموفق بود');
      }

      recordAudit({
        entityId: json.data?.id || assignDraft.productionOperationId,
        entityCode: assignDraft.moNumber,
        moduleName: 'تقویم ظرفیت ماشین‌آلات',
        actionType: isEdit ? 'UPDATE' : 'CREATE',
        title: `${isEdit ? 'ویرایش' : 'ثبت'} تخصیص ماشین برای ${assignDraft.moNumber} (${assignDraft.stepCode})`,
        details: `تاریخ: ${assignDraft.assignedDate}`,
      });

      setAssignDraft(null);
      setFeedback({ type: 'success', text: json.message || 'تخصیص ماشین و شیفت با موفقیت ذخیره شد.' });
      await loadCapacity();
    } catch (err) {
      setFeedback({ type: 'error', text: err instanceof Error ? err.message : 'خطا در ذخیره تخصیص' });
    } finally {
      setBusy(false);
    }
  };

  const handleCancelAssignment = (slot: AssignmentSlot) => {
    if (slot.sourceType !== 'MACHINE_ASSIGNMENT') return;
    requestConfirm({
      title: `لغو تخصیص ماشین (${slot.moNumber} · ${slot.stepCode})`,
      message: `آیا از لغو نوبت‌دهی عملیات «${slot.stepName}» روی ماشین «${slot.machineName}» در شیفت ${slot.shiftName} اطمینان دارید؟ سابقه در گزارش ممیزی حفظ می‌شود.`,
      confirmLabel: 'تأیید لغو تخصیص',
      variant: 'danger',
      onConfirm: async () => {
        setBusy(true);
        setFeedback(null);
        try {
          const res = await fetch(`/api/planning/machine-assignments/${slot.id}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'لغو دستی از تقویم ظرفیت ماشین‌آلات', actor: 'برنامه‌ریز تولید' }),
          });
          const json = await res.json();
          if (!res.ok || !json.success) {
            throw new Error(json.error || 'لغو تخصیص ناموفق بود');
          }
          recordAudit({
            entityId: slot.id,
            entityCode: slot.moNumber,
            moduleName: 'تقویم ظرفیت ماشین‌آلات',
            actionType: 'REVERSAL',
            title: `لغو تخصیص ${slot.moNumber} (${slot.stepCode})`,
            details: `ماشین: ${slot.machineCode} | شیفت: ${slot.shiftName}`,
          });
          setFeedback({ type: 'success', text: json.message || 'تخصیص ماشین لغو شد و عملیات به فهرست آماده نوبت‌دهی بازگشت.' });
          await loadCapacity();
        } catch (err) {
          setFeedback({ type: 'error', text: err instanceof Error ? err.message : 'خطا در لغو تخصیص' });
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const unassignedColumns: FioriTableColumn<UnassignedOperation>[] = useMemo(
    () => [
      {
        key: 'moNumber',
        header: 'دستور کار (MO)',
        isMono: true,
        render: op => (
          <button
            type="button"
            onClick={() => traceDocument(op.moNumber, 'WIP_TRACEABILITY')}
            className="sap-doc-link font-semibold fiori-ltr-code cursor-pointer"
          >
            {op.moNumber}
          </button>
        ),
      },
      {
        key: 'part',
        header: 'قطعه',
        render: op => (
          <span>
            {op.partName}{' '}
            <span className="font-mono text-[var(--fiori-text-secondary)] fiori-ltr-code">({op.partCode})</span>
          </span>
        ),
      },
      {
        key: 'operation',
        header: 'عملیات',
        render: op => (
          <span>
            <span className="font-mono font-semibold fiori-ltr-code">{op.stepCode}</span> — {op.stepName}
          </span>
        ),
      },
      {
        key: 'qtyHours',
        header: 'تیراژ / برآورد ساعت',
        isMono: true,
        render: op => (
          <span className="tabular-nums">
            {formatNumber(op.plannedQty)} عدد · {toPersianDigits(op.estimatedHours)} ساعت
          </span>
        ),
      },
      {
        key: 'dieTonnage',
        header: 'قالب / تناژ',
        isMono: true,
        render: op => (
          <span className="text-[11px] text-[var(--fiori-text-secondary)] tabular-nums">
            {op.dieCode || '—'}
            {op.requiredTonnage ? ` · ${formatNumber(op.requiredTonnage)}T` : ''}
          </span>
        ),
      },
      {
        key: 'suggestedDate',
        header: 'تاریخ پیشنهادی',
        isMono: true,
        render: op => <span className="tabular-nums">{formatToJalali(op.suggestedDate)}</span>,
      },
      {
        key: 'action',
        header: 'اقدام برنامه‌ریز',
        render: op => (
          <button
            type="button"
            onClick={() => openAssignModalForUnassigned(op)}
            className="sap-btn-emphasized px-2.5 py-1 text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer"
          >
            <Plus className="w-3 h-3" />
            <span>تخصیص ماشین و شیفت</span>
          </button>
        ),
      },
    ],
    [openAssignModalForUnassigned, traceDocument]
  );

  return (
    <>
      <FioriDynamicPage
        title="تقویم ظرفیت ماشین‌آلات و نوبت‌دهی شیفت‌ها"
        subtitle="مشاهده بارگذاری واقعی دستورات کار روی پرس‌ها به تفکیک شیفت، تشخیص تداخل، و تخصیص یا جابجایی تحت کنترل برنامه‌ریز."
        status={
          conflicts.length > 0 ? (
            <FioriObjectStatus
              tone="negative"
              label={`${toPersianDigits(conflicts.length)} تداخل ظرفیت یا شیفت`}
              icon
              size="sm"
            />
          ) : (
            <FioriObjectStatus tone="positive" label="بدون تداخل شیفت" icon size="sm" />
          )
        }
        activeFiltersCount={activeFiltersCount}
        onResetFilters={resetFilters}
        headerActions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-[var(--fiori-text-primary)] cursor-pointer px-2.5 py-1.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] bg-[var(--fiori-bg-subtle)]">
              <input
                type="checkbox"
                checked={showDraftPreview}
                onChange={e => setShowDraftPreview(e.target.checked)}
                className="rounded border-[var(--fiori-border-input)] accent-[var(--fiori-brand)]"
              />
              <Eye className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
              <span>پیش‌نمایش پیش‌نویس‌ها ({toPersianDigits(draftPreview.length)})</span>
            </label>
            <button
              type="button"
              onClick={() => void loadCapacity()}
              disabled={loading || busy}
              className="sap-btn-standard px-3 py-1.5 text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${
                  loading ? 'animate-spin text-[var(--fiori-brand)]' : 'text-[var(--fiori-text-secondary)]'
                }`}
              />
              <span>بروزرسانی</span>
            </button>
          </div>
        }
        kpiStrip={
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
              <div className="flex items-center justify-between text-xs text-[var(--fiori-text-secondary)]">
                <span>تخصیص‌های فعال شیفت</span>
                <Layers className="w-4 h-4 text-[var(--fiori-text-muted)]" />
              </div>
              <div className="text-xl font-semibold text-[var(--fiori-text-primary)] font-mono tabular-nums mt-1">
                {toPersianDigits(assignments.filter(a => a.status !== 'CANCELLED').length)}
              </div>
            </div>

            <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
              <div className="flex items-center justify-between text-xs text-[var(--fiori-text-secondary)]">
                <span>عملیات در انتظار نوبت‌دهی</span>
                <Clock className="w-4 h-4 text-[var(--fiori-critical)]" />
              </div>
              <div className="text-xl font-semibold text-[var(--fiori-critical)] font-mono tabular-nums mt-1">
                {toPersianDigits(unassignedOps.length)}
              </div>
            </div>

            <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
              <div className="flex items-center justify-between text-xs text-[var(--fiori-text-secondary)]">
                <span>تداخل‌های زمانی / ظرفیتی</span>
                <AlertTriangle
                  className={`w-4 h-4 ${
                    conflicts.length > 0 ? 'text-[var(--fiori-negative)]' : 'text-[var(--fiori-positive)]'
                  }`}
                />
              </div>
              <div
                className={`text-xl font-semibold font-mono tabular-nums mt-1 ${
                  conflicts.length > 0 ? 'text-[var(--fiori-negative)]' : 'text-[var(--fiori-positive)]'
                }`}
              >
                {toPersianDigits(conflicts.length)}
              </div>
            </div>

            <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3.5 shadow-[var(--fiori-shadow-card)]">
              <div className="flex items-center justify-between text-xs text-[var(--fiori-text-secondary)]">
                <span>میانگین اشغال ماشین‌آلات</span>
                <Cpu className="w-4 h-4 text-[var(--fiori-brand)]" />
              </div>
              <div className="text-xl font-semibold text-[var(--fiori-brand)] font-mono tabular-nums mt-1">
                {toPersianDigits(avgUtilization)}٪
              </div>
            </div>
          </div>
        }
        filterBar={
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5 text-[var(--fiori-text-primary)] font-semibold">
                <Filter className="w-3.5 h-3.5 text-[var(--fiori-text-muted)]" />
                <span>فیلترها:</span>
              </div>
              <select
                value={selectedHall}
                onChange={e => setSelectedHall(e.target.value)}
                className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1 text-xs text-[var(--fiori-text-primary)]"
              >
                <option value="ALL">همه سالن‌ها</option>
                {halls.map(h => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
              <select
                value={selectedMachineId}
                onChange={e => setSelectedMachineId(e.target.value)}
                className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1 text-xs text-[var(--fiori-text-primary)]"
              >
                <option value="ALL">همه ماشین‌آلات</option>
                {machines.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.code} — {m.name}
                  </option>
                ))}
              </select>
              <input
                type="date"
                value={selectedDateFilter}
                onChange={e => setSelectedDateFilter(e.target.value)}
                aria-label="فیلتر تاریخ"
                className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1 text-xs font-mono text-[var(--fiori-text-primary)]"
              />
              {selectedDateFilter && (
                <button
                  type="button"
                  onClick={() => setSelectedDateFilter('')}
                  className="text-xs text-[var(--fiori-brand)] hover:underline cursor-pointer"
                >
                  حذف فیلتر تاریخ
                </button>
              )}
            </div>

            <label className="flex items-center gap-1.5 text-xs text-[var(--fiori-text-primary)] cursor-pointer">
              <input
                type="checkbox"
                checked={onlyConflicts}
                onChange={e => setOnlyConflicts(e.target.checked)}
                className="rounded border-[var(--fiori-border-input)] accent-[var(--fiori-brand)]"
              />
              <span>فقط ماشین‌های دارای تداخل</span>
            </label>
          </div>
        }
      >
        <div className="space-y-4">
          {feedback && (
            <FioriMessageStrip
              tone={feedback.type === 'error' ? 'error' : 'success'}
              onClose={() => setFeedback(null)}
            >
              {feedback.text}
            </FioriMessageStrip>
          )}

          {/* Conflicts Alert List */}
          {conflicts.length > 0 && (
            <div className="rounded-[var(--fiori-radius-md)] border border-[var(--fiori-negative-border)] bg-[var(--fiori-negative-bg)]/55 p-4 space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-[var(--fiori-negative)]">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>تداخل‌های شناسایی‌شده — برای جابجایی شیفت یا ماشین روی ردیف موردنظر اقدام کنید:</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {conflicts.map(conf => (
                  <div
                    key={conf.id}
                    className="rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-negative-border)] bg-[var(--fiori-bg-surface)] p-3 flex items-center justify-between gap-2 text-xs"
                  >
                    <div className="space-y-1">
                      <div className="font-semibold text-[var(--fiori-text-primary)]">
                        <span className="font-mono text-[var(--fiori-negative)] fiori-ltr-code">{conf.machineCode}</span> ·{' '}
                        {conf.machineName}
                      </div>
                      <div className="text-[11px] text-[var(--fiori-text-secondary)]">{conf.message}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const targetSlot = assignments.find(a => conf.assignmentIds.includes(a.id));
                        if (targetSlot) openEditModalForSlot(targetSlot);
                      }}
                      className="sap-btn-standard px-2.5 py-1 text-[11px] font-semibold shrink-0 cursor-pointer"
                    >
                      جابجایی شیفت
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Unassigned Operations Queue */}
          {unassignedOps.length > 0 && (
            <FioriDataTable
              columns={unassignedColumns}
              data={unassignedOps}
              rowKey={op => op.productionOperationId}
              compact
              bordered
              toolbar={
                <FioriToolbar
                  variant="table"
                  title="عملیات دستورات کار در انتظار تخصیص شیفت"
                  subtitle="انتخاب ماشین واجد شرایط (بر اساس قابلیت، تناژ، ضخامت و سازگاری قالب) و ثبت در شیفت موردنظر برنامه‌ریز."
                  count={unassignedOps.length}
                  countLabel="عملیات"
                />
              }
            />
          )}

          {/* Shift-based Machine Capacity Grid */}
          <section className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)] overflow-hidden">
            <FioriToolbar
              variant="table"
              title="ماتریس ظرفیت و تخصیص ماشین‌آلات به تفکیک شیفت"
              endContent={
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-[var(--fiori-text-secondary)]">
                  {shifts.map(sh => (
                    <span key={sh.id} className="font-mono tabular-nums">
                      {sh.name}: {sh.startTime} تا {sh.endTime} ({toPersianDigits(sh.productiveHours)} ساعت)
                    </span>
                  ))}
                </div>
              }
            />

            <div className="divide-y divide-[var(--fiori-border-subtle)]">
              {displayedMachines.length === 0 ? (
                <div className="p-4">
                  <EmptyState
                    variant="FILTER_NO_MATCH"
                    compact
                    title="ماشینی با فیلترهای انتخابی یافت نشد"
                    actionLabel={activeFiltersCount > 0 ? 'پاک‌کردن فیلترها' : undefined}
                    onAction={activeFiltersCount > 0 ? resetFilters : undefined}
                  />
                </div>
              ) : (
                displayedMachines.map(machine => {
                  const mSlots = assignments.filter(a => a.machineId === machine.id && a.status !== 'CANCELLED');
                  const mDrafts = showDraftPreview ? draftPreview.filter(d => d.machineId === machine.id) : [];

                  return (
                    <div
                      key={machine.id}
                      ref={el => {
                        rowRefs.current[machine.id] = el;
                      }}
                      className={`p-4 grid grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)] gap-4 ${
                        machine.conflictsCount > 0 ? 'bg-[var(--fiori-negative-bg)]/30' : ''
                      }`}
                    >
                      <div className="space-y-2 border-b lg:border-b-0 lg:border-l border-[var(--fiori-border-subtle)] pb-3 lg:pb-0 lg:pl-4">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-mono font-semibold text-[var(--fiori-text-primary)] fiori-ltr-code">
                            {machine.code}
                          </span>
                          <span className="font-mono text-[11px] text-[var(--fiori-brand)]">
                            {machine.tonnageCapacity ? `${formatNumber(machine.tonnageCapacity)} تن` : machine.machineType}
                          </span>
                        </div>
                        <div className="text-xs font-semibold text-[var(--fiori-text-primary)]">{machine.name}</div>
                        <div className="text-[11px] text-[var(--fiori-text-secondary)]">{machine.hallLocation}</div>

                        <div className="pt-2 space-y-1">
                          <div className="flex items-center justify-between text-[11px] font-mono tabular-nums">
                            <span className="text-[var(--fiori-text-secondary)]">
                              بارگذاری: {toPersianDigits(machine.scheduledHours)} / {toPersianDigits(machine.dailyCapacityHours)} ساعت
                            </span>
                            <span
                              className={`font-semibold ${
                                machine.utilizationPercent >= 90
                                  ? 'text-[var(--fiori-negative)]'
                                  : 'text-[var(--fiori-brand)]'
                              }`}
                            >
                              {toPersianDigits(machine.utilizationPercent)}٪
                            </span>
                          </div>
                          <div className="h-1.5 w-full rounded bg-[var(--fiori-border-subtle)] overflow-hidden">
                            <div
                              className={`h-full ${
                                machine.utilizationPercent >= 95
                                  ? 'bg-[var(--fiori-negative)]'
                                  : machine.utilizationPercent >= 75
                                  ? 'bg-[var(--fiori-critical)]'
                                  : 'bg-[var(--fiori-brand)]'
                              }`}
                              style={{ width: `${Math.min(100, machine.utilizationPercent)}%` }}
                            />
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {(shifts.length
                          ? shifts
                          : [{ id: 'ANY', code: 'ALL', name: 'همه شیفت‌ها', startTime: '07:00', endTime: '23:00', productiveHours: 15 }]
                        ).map(shift => {
                          const shiftSlots = mSlots.filter(s => s.shiftId === shift.id || shift.id === 'ANY');
                          const shiftDrafts = mDrafts.filter(d => d.shiftId === shift.id || shift.id === 'ANY');

                          return (
                            <div
                              key={shift.id}
                              className="rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] bg-[var(--fiori-bg-subtle)] p-2.5 space-y-2"
                            >
                              <div className="flex items-center justify-between text-[11px] border-b border-[var(--fiori-border-subtle)] pb-1.5">
                                <span className="font-semibold text-[var(--fiori-text-primary)]">{shift.name}</span>
                                <span className="font-mono tabular-nums text-[var(--fiori-text-secondary)]">
                                  {shift.startTime}-{shift.endTime}
                                </span>
                              </div>

                              {shiftSlots.length === 0 && shiftDrafts.length === 0 ? (
                                <div className="py-3 text-center text-[11px] text-[var(--fiori-text-muted)]">
                                  ظرفیت آزاد
                                </div>
                              ) : (
                                <div className="space-y-1.5">
                                  {shiftSlots.map(slot => (
                                    <div
                                      key={slot.id}
                                      className={`rounded-[var(--fiori-radius-sm)] border p-2 text-xs space-y-1 ${
                                        slot.hasConflict
                                          ? 'border-[var(--fiori-negative)] bg-[var(--fiori-negative-bg)]/60'
                                          : 'border-[var(--fiori-border-default)] bg-[var(--fiori-bg-surface)]'
                                      }`}
                                    >
                                      <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-1.5 font-mono font-semibold">
                                          <button
                                            type="button"
                                            onClick={() => traceDocument(slot.moNumber, 'WIP_TRACEABILITY')}
                                            className="sap-doc-link fiori-ltr-code cursor-pointer"
                                          >
                                            {slot.moNumber}
                                          </button>
                                          <span className="text-[var(--fiori-text-muted)]">·</span>
                                          <span className="text-[var(--fiori-text-primary)] fiori-ltr-code">
                                            {slot.stepCode}
                                          </span>
                                        </div>
                                        <FioriObjectStatus
                                          tone={statusTone[slot.status] || 'neutral'}
                                          label={statusLabel[slot.status] || slot.status}
                                          variant="text"
                                          size="sm"
                                        />
                                      </div>
                                      <div className="text-[11px] text-[var(--fiori-text-primary)]">
                                        {slot.partName} — {slot.stepName}
                                      </div>
                                      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-[var(--fiori-text-secondary)] font-mono tabular-nums">
                                        <span>
                                          <Calendar className="w-3 h-3 inline ml-1" />
                                          {formatToJalali(slot.assignedDate)} · {formatNumber(slot.plannedQty)} عدد ·{' '}
                                          {toPersianDigits(slot.estimatedHours)} ساعت
                                        </span>
                                        <div className="flex items-center gap-2 font-sans">
                                          {slot.status !== 'COMPLETED' && (
                                            <button
                                              type="button"
                                              onClick={() => openEditModalForSlot(slot)}
                                              className="text-[var(--fiori-brand)] hover:underline font-semibold inline-flex items-center gap-0.5 cursor-pointer"
                                            >
                                              <Edit3 className="w-3 h-3" />
                                              <span>ویرایش</span>
                                            </button>
                                          )}
                                          {slot.sourceType === 'MACHINE_ASSIGNMENT' && slot.status !== 'COMPLETED' && (
                                            <button
                                              type="button"
                                              onClick={() => handleCancelAssignment(slot)}
                                              className="text-[var(--fiori-negative)] hover:underline font-semibold inline-flex items-center gap-0.5 cursor-pointer"
                                            >
                                              <RotateCcw className="w-3 h-3" />
                                              <span>لغو</span>
                                            </button>
                                          )}
                                        </div>
                                      </div>
                                      {slot.hasConflict && slot.conflictReasons.length > 0 && (
                                        <div className="text-[10px] text-[var(--fiori-negative)] font-semibold">
                                          {slot.conflictReasons[0]}
                                        </div>
                                      )}
                                    </div>
                                  ))}

                                  {shiftDrafts.map((d, idx) => (
                                    <div
                                      key={`${d.proposalId}-${idx}`}
                                      className="rounded-[var(--fiori-radius-sm)] border border-dashed border-[var(--fiori-brand)] bg-[var(--fiori-brand-bg)]/60 p-2 text-[11px] space-y-0.5"
                                    >
                                      <div className="flex items-center justify-between">
                                        <span className="font-mono font-semibold text-[var(--fiori-brand)] fiori-ltr-code">
                                          {d.proposalNumber} · {d.stepCode}
                                        </span>
                                        <FioriObjectStatus
                                          tone="critical"
                                          label="پیش‌نمایش پیش‌نویس (غیرقطعی)"
                                          variant="text"
                                          size="sm"
                                        />
                                      </div>
                                      <div className="text-[var(--fiori-text-primary)]">
                                        {d.partName} — {d.stepName}
                                      </div>
                                      <div className="text-[10px] text-[var(--fiori-text-secondary)] font-mono tabular-nums">
                                        {formatToJalali(d.assignedDate)} · {formatNumber(d.plannedQty)} عدد ·{' '}
                                        {toPersianDigits(d.estimatedHours)} ساعت
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </div>
      </FioriDynamicPage>

      {/* Planner Assignment Dialog */}
      <FioriDialog
        isOpen={Boolean(assignDraft)}
        onClose={() => {
          if (!busy) setAssignDraft(null);
        }}
        title={assignDraft?.mode === 'EDIT' ? 'ویرایش تخصیص ماشین و شیفت' : 'ثبت تخصیص ماشین و شیفت'}
        subtitle={
          assignDraft
            ? `دستور کار ${assignDraft.moNumber} · ${assignDraft.partName} — ${assignDraft.stepCode} (${assignDraft.stepName})`
            : undefined
        }
        icon={<CalendarClock className="w-4 h-4" />}
        tone={assignDraft?.conflictWarning ? 'danger' : 'brand'}
        size="md"
        disableClose={busy}
        footer={
          assignDraft && (
            <div className="flex flex-wrap items-center justify-end gap-2 w-full">
              <button
                type="button"
                onClick={() => setAssignDraft(null)}
                disabled={busy}
                className="sap-btn-standard px-3 py-1.5 text-xs font-semibold cursor-pointer"
              >
                انصراف
              </button>
              {assignDraft.conflictWarning ? (
                <button
                  type="button"
                  onClick={() => void submitAssignment(true)}
                  disabled={busy}
                  className="rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-negative)] hover:opacity-90 px-3.5 py-1.5 text-xs font-semibold text-white cursor-pointer disabled:opacity-50"
                >
                  تأیید و ثبت با پذیرش تداخل
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void submitAssignment(false)}
                  disabled={busy || !assignDraft.machineId || !assignDraft.shiftId}
                  className="sap-btn-emphasized px-4 py-1.5 text-xs font-semibold cursor-pointer disabled:opacity-50"
                >
                  ثبت تخصیص ماشین
                </button>
              )}
            </div>
          )
        }
      >
        {assignDraft && (
          <div className="space-y-4">
            {assignDraft.conflictWarning && (
              <FioriMessageStrip tone="error" title={assignDraft.conflictWarning}>
                می‌توانید تاریخ/شیفت/ماشین دیگری انتخاب کنید یا در صورت تصمیم برنامه‌ریز، تخصیص را با پذیرش تداخل ثبت کنید.
              </FioriMessageStrip>
            )}

            <div className="space-y-3 text-xs">
              <label className="block space-y-1">
                <span className="font-semibold text-[var(--fiori-text-primary)]">ماشین واجد شرایط</span>
                <select
                  value={assignDraft.machineId}
                  onChange={e =>
                    setAssignDraft(prev => (prev ? { ...prev, machineId: e.target.value, conflictWarning: null } : null))
                  }
                  className="w-full rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-input)] bg-[var(--fiori-bg-surface)] px-2.5 py-1.5 text-xs text-[var(--fiori-text-primary)]"
                >
                  {machines
                    .filter(m => assignDraft.eligibleMachineIds.length === 0 || assignDraft.eligibleMachineIds.includes(m.id))
                    .map(m => (
                      <option key={m.id} value={m.id}>
                        {m.code} — {m.name} ({m.tonnageCapacity ? `${formatNumber(m.tonnageCapacity)} تن` : m.machineType} · اشغال {toPersianDigits(m.utilizationPercent)}٪)
                      </option>
                    ))}
                </select>
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span className="font-semibold text-[var(--fiori-text-primary)]">شیفت کاری</span>
                  <select
                    value={assignDraft.shiftId}
                    onChange={e =>
                      setAssignDraft(prev => (prev ? { ...prev, shiftId: e.target.value, conflictWarning: null } : null))
                    }
                    className="w-full rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-input)] bg-[var(--fiori-bg-surface)] px-2.5 py-1.5 text-xs text-[var(--fiori-text-primary)]"
                  >
                    {shifts.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.startTime} - {s.endTime})
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block space-y-1">
                  <span className="font-semibold text-[var(--fiori-text-primary)]">تاریخ اجرا</span>
                  <input
                    type="date"
                    value={assignDraft.assignedDate}
                    onChange={e =>
                      setAssignDraft(prev => (prev ? { ...prev, assignedDate: e.target.value, conflictWarning: null } : null))
                    }
                    className="w-full rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-input)] bg-[var(--fiori-bg-surface)] px-2.5 py-1.5 text-xs font-mono text-[var(--fiori-text-primary)]"
                  />
                </label>
              </div>

              <label className="block space-y-1">
                <span className="font-semibold text-[var(--fiori-text-primary)]">توضیح برنامه‌ریز (اختیاری)</span>
                <input
                  type="text"
                  value={assignDraft.notes}
                  onChange={e => setAssignDraft(prev => (prev ? { ...prev, notes: e.target.value } : null))}
                  className="w-full rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-input)] bg-[var(--fiori-bg-surface)] px-2.5 py-1.5 text-xs text-[var(--fiori-text-primary)]"
                />
              </label>
            </div>
          </div>
        )}
      </FioriDialog>
    </>
  );
};
