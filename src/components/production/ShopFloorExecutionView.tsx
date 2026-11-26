import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Filter,
  Gauge,
  Hammer,
  Layers,
  Lock,
  PackagePlus,
  Pause,
  Play,
  RefreshCw,
  Search,
  ShieldAlert,
  Wrench,
  X,
} from 'lucide-react';
import { formatDateTime, formatNumber, toPersianDigits } from '../../utils/formatters';

interface ShopFloorOperationDto {
  id: string;
  moId: string;
  moNumber: string;
  partId: string;
  partCode: string;
  partName: string;
  partWeightGrossKg: number;
  partThicknessMm: number | null;
  planId: string | null;
  planNumber: string | null;
  planLineId: string | null;
  planLinePlannedQty: number;
  planLineProducedQty: number;
  moStatus: string;
  stepNumber: number;
  sequence: number;
  stepCode: string;
  stepName: string;
  processType: string;
  plannedQty: number;
  waitingInputQty: number;
  inProgressQty: number;
  readyForTransferQty?: number;
  availableStationQty: number;
  outputGoodQty: number;
  outputScrapQty: number;
  outputReworkQty: number;
  outputRejectedQty: number;
  remainingQty: number;
  completionPercent: number;
  status: string;
  executionState: 'PENDING' | 'READY' | 'IN_PROGRESS' | 'PAUSED' | 'COMPLETED' | 'SKIPPED';
  isPaused: boolean;
  lastPausedAt: string | null;
  lastPauseReason: string | null;
  lastPauseIsDowntime: boolean;
  actualStartedAt: string | null;
  startDate: string | null;
  endDate: string | null;
  lastActivityAt: string | null;
  version: number;
  plannedMachineId: string | null;
  machineId: string | null;
  machineCode: string | null;
  machineName: string | null;
  plannedDieId: string | null;
  dieCode: string | null;
  dieName: string | null;
  assignmentId: string | null;
  assignmentStatus: string | null;
  shiftId: string | null;
  shiftName: string | null;
  assignedDate: string | null;
  assignedOperatorId: string | null;
  assignedOperatorName: string | null;
  eligibleMachineIds: string[];
  predecessorBlocked: boolean;
  outstandingMaterialKg: number;
  totalRunTimeMinutes: number;
  totalDowntimeMinutes: number;
  canLoadMaterial?: boolean;
  canStart: boolean;
  canPause: boolean;
  canResume: boolean;
  canReport: boolean;
  canComplete: boolean;
}

interface MaterialSourceOption {
  id: string;
  partId: string;
  partCode: string;
  partName: string;
  warehouseCode: string;
  warehouseName: string;
  locationCode: string | null;
  coilNumber: string | null;
  lotNumber: string | null;
  ownership: string;
  quantityAvailable: number;
  weightKgAvailable: number;
}

interface ShopFloorWorkOrderDto {
  id: string;
  moNumber: string;
  partId: string;
  partCode: string;
  partName: string;
  planId: string | null;
  planNumber: string | null;
  planTitle: string | null;
  planStatus: string | null;
  planLineId: string | null;
  planLinePlannedQty: number;
  planLineProducedQty: number;
  planLineStatus: string | null;
  targetQty: number;
  initialInputQty: number;
  completedQty: number;
  scrapQty: number;
  totalReworkQty: number;
  totalRejectedQty: number;
  completionPercent: number;
  status: string;
  priority: number;
  scheduledStartDate: string | null;
  scheduledEndDate: string | null;
  actualStartDate: string | null;
  actualEndDate: string | null;
  totalIssuedMaterialKg: number;
  totalConsumedMaterialKg: number;
  totalOutstandingMaterialKg: number;
  version: number;
  operations: ShopFloorOperationDto[];
}

interface ShopFloorBoardData {
  source: string;
  workOrders: ShopFloorWorkOrderDto[];
  operationsQueue: ShopFloorOperationDto[];
  recentReports: Array<{
    id: string;
    reportNumber: string;
    moId: string;
    moNumber: string;
    partCode: string;
    partName: string;
    operationId: string;
    stepCode: string;
    stepName: string;
    machineId: string | null;
    machineCode: string;
    machineName: string;
    shiftId: string;
    shiftName: string;
    operatorUserId: string | null;
    operatorName: string;
    reportDate: string;
    goodQty: number;
    scrapQty: number;
    reworkQty: number;
    rejectedQty: number;
    scrapReason: string | null;
    runTimeMinutes: number;
    downtimeMinutes: number;
    downtimeReason: string | null;
    strokeCounterStart: number | null;
    strokeCounterEnd: number | null;
    actualMaterialConsumedKg: number | null;
  }>;
  downtimeEvents: Array<{
    id: string;
    source: string;
    machineId: string | null;
    machineCode: string;
    machineName: string;
    moId: string | null;
    moNumber: string | null;
    operationId: string | null;
    stepCode: string | null;
    shiftId: string | null;
    shiftName: string | null;
    reason: string;
    durationMinutes: number;
    recordedAt: string;
    recordedBy: string;
  }>;
  activityTimeline: Array<{
    id: string;
    moId: string;
    moNumber: string;
    operationId: string | null;
    stepNumber: number;
    stepName: string;
    activityType: string;
    quantity: number;
    goodQty: number | null;
    scrapQty: number | null;
    operatorName: string;
    machineId: string | null;
    notes: string | null;
    timestamp: string;
  }>;
  kpis: {
    workOrdersCount: number;
    activeWorkOrdersCount: number;
    completedWorkOrdersCount: number;
    readyOpsCount: number;
    inProgressOpsCount: number;
    pausedOpsCount: number;
    completedOpsCount: number;
    totalPlannedQty: number;
    totalActualGoodQty: number;
    totalScrapQty: number;
    totalReworkQty: number;
    totalRejectedQty: number;
    overallCompletionPercent: number;
    scrapRatePercent: number;
    machineUtilizationPercent: number;
    totalRunTimeMinutes: number;
    totalDowntimeMinutes: number;
    downtimeByReason: Array<{ reason: string; minutes: number; count: number }>;
    perMachine: Array<{
      machineId: string;
      machineCode: string;
      machineName: string;
      status: string;
      activeOpsCount: number;
      inProgressOpsCount: number;
      pausedOpsCount: number;
      runTimeMinutes: number;
      downtimeMinutes: number;
      availableMinutes: number;
      utilizationPercent: number;
      goodQty: number;
      scrapQty: number;
    }>;
  };
  masterData: {
    machines: Array<{
      id: string;
      code: string;
      name: string;
      hallLocation: string;
      machineType: string;
      tonnageCapacity: number | null;
      status: string;
      active: boolean;
    }>;
    shifts: Array<{
      id: string;
      code: string;
      name: string;
      startTime: string;
      endTime: string;
      productiveHours: number;
    }>;
    operators: Array<{
      id: string;
      username: string;
      fullName: string;
      personnelCode: string | null;
      active: boolean;
    }>;
  };
}

interface ShopFloorExecutionViewProps {
  onGlobalRefresh?: () => void;
}

const makeKey = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const STATE_META: Record<string, { label: string; dotClass: string; textClass: string }> = {
  READY: { label: 'آماده شروع', dotClass: 'bg-[#007cc0]', textClass: 'text-[#0057b8]' },
  PENDING: { label: 'در صف انتظار', dotClass: 'bg-[#8c8c8c]', textClass: 'text-[#555555]' },
  IN_PROGRESS: { label: 'در حال اجرا', dotClass: 'bg-[#107e3e]', textClass: 'text-[#107e3e]' },
  PAUSED: { label: 'متوقف موقت', dotClass: 'bg-[#e9730c]', textClass: 'text-[#b55505]' },
  COMPLETED: { label: 'تکمیل شده', dotClass: 'bg-[#2b7d2b]', textClass: 'text-[#2b7d2b]' },
  SKIPPED: { label: 'رد شده', dotClass: 'bg-[#bfbfbf]', textClass: 'text-[#666666]' },
};

const ACTIVITY_LABELS: Record<string, string> = {
  OP_START: 'شروع عملیات',
  OP_PAUSE: 'توقف موقت',
  OP_RESUME: 'ازسرگیری عملیات',
  OP_COMPLETE: 'تکمیل عملیات',
  OP_PRODUCTION_REPORT: 'گزارش تولید',
  OP_DOWNTIME: 'ثبت توقف',
  OP_INPUT: 'ورود مواد/قطعه به ایستگاه',
  WIP_TRANSFER_DISPATCH: 'ارسال بین‌مرحله‌ای',
  WIP_TRANSFER_RECEIPT: 'وصول در ایستگاه بعد',
};

const DOWNTIME_PRESETS = [
  'خرابی مکانیکی / هیدرولیک ماشین',
  'تنظیم و تعویض قالب (Setup)',
  'کمبود ورق / کلاف خام پای خط',
  'عیب کیفی و بررسی نمونه اول',
  'قطع برق یا فشار باد',
];

export const ShopFloorExecutionView: React.FC<ShopFloorExecutionViewProps> = ({
  onGlobalRefresh,
}) => {
  const [board, setBoard] = useState<ShopFloorBoardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [subView, setSubView] = useState<'OPERATOR' | 'SUPERVISOR'>('OPERATOR');

  // Filters
  const [filterMoId, setFilterMoId] = useState<string>('ALL');
  const [filterMachineId, setFilterMachineId] = useState<string>('ALL');
  const [filterShiftId, setFilterShiftId] = useState<string>('ALL');
  const [filterExecState, setFilterExecState] = useState<string>('ALL');
  const [searchTerm, setSearchTerm] = useState<string>('');

  // Feedback banner
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Start modal
  const [startTarget, setStartTarget] = useState<ShopFloorOperationDto | null>(null);
  const [startMachineId, setStartMachineId] = useState<string>('');
  const [startShiftId, setStartShiftId] = useState<string>('');
  const [startOperatorId, setStartOperatorId] = useState<string>('');
  const [startNotes, setStartNotes] = useState<string>('');
  const [startKey, setStartKey] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  // Pause / Resume modals
  const [pauseTarget, setPauseTarget] = useState<ShopFloorOperationDto | null>(null);
  const [pauseReason, setPauseReason] = useState<string>('');
  const [pauseIsDowntime, setPauseIsDowntime] = useState<boolean>(false);
  const [pauseKey, setPauseKey] = useState<string>('');

  const [resumeTarget, setResumeTarget] = useState<ShopFloorOperationDto | null>(null);
  const [resumeMachineId, setResumeMachineId] = useState<string>('');
  const [resumeShiftId, setResumeShiftId] = useState<string>('');
  const [resumeDowntimeOverride, setResumeDowntimeOverride] = useState<string>('');
  const [resumeNotes, setResumeNotes] = useState<string>('');
  const [resumeKey, setResumeKey] = useState<string>('');

  // Complete modal
  const [completeTarget, setCompleteTarget] = useState<ShopFloorOperationDto | null>(null);
  const [completeNotes, setCompleteNotes] = useState<string>('');
  const [completeKey, setCompleteKey] = useState<string>('');

  // Production Report modal
  const [reportTarget, setReportTarget] = useState<ShopFloorOperationDto | null>(null);
  const [reportGoodQty, setReportGoodQty] = useState<string>('');
  const [reportScrapQty, setReportScrapQty] = useState<string>('0');
  const [reportScrapReason, setReportScrapReason] = useState<string>('');
  const [reportReworkQty, setReportReworkQty] = useState<string>('0');
  const [reportRejectedQty, setReportRejectedQty] = useState<string>('0');
  const [reportMaterialKg, setReportMaterialKg] = useState<string>('');
  const [reportRunTimeMin, setReportRunTimeMin] = useState<string>('60');
  const [reportDowntimeMin, setReportDowntimeMin] = useState<string>('0');
  const [reportDowntimeReason, setReportDowntimeReason] = useState<string>('');
  const [reportStrokeStart, setReportStrokeStart] = useState<string>('');
  const [reportStrokeEnd, setReportStrokeEnd] = useState<string>('');
  const [reportMachineId, setReportMachineId] = useState<string>('');
  const [reportShiftId, setReportShiftId] = useState<string>('');
  const [reportOperatorId, setReportOperatorId] = useState<string>('');
  const [reportAllowOverproduction, setReportAllowOverproduction] = useState<boolean>(false);
  const [reportNotes, setReportNotes] = useState<string>('');
  const [reportKey, setReportKey] = useState<string>('');

  // Standalone Downtime modal
  const [downtimeModalOpen, setDowntimeModalOpen] = useState<boolean>(false);
  const [dtMachineId, setDtMachineId] = useState<string>('');
  const [dtShiftId, setDtShiftId] = useState<string>('');
  const [dtOpId, setDtOpId] = useState<string>('');
  const [dtDurationMin, setDtDurationMin] = useState<string>('30');
  const [dtReason, setDtReason] = useState<string>('');
  const [dtMarkBreakdown, setDtMarkBreakdown] = useState<boolean>(false);
  const [dtOperatorId, setDtOperatorId] = useState<string>('');
  const [dtNotes, setDtNotes] = useState<string>('');
  const [dtKey, setDtKey] = useState<string>('');

  // Load Material modal (for freshly released MOs or OP10 replenishment)
  const [loadMatTarget, setLoadMatTarget] = useState<ShopFloorOperationDto | null>(null);
  const [materialSources, setMaterialSources] = useState<MaterialSourceOption[]>([]);
  const [loadingSources, setLoadingSources] = useState<boolean>(false);
  const [loadMatSourceId, setLoadMatSourceId] = useState<string>('');
  const [loadMatQty, setLoadMatQty] = useState<string>('');
  const [loadMatWeightKg, setLoadMatWeightKg] = useState<string>('');
  const [loadMatOperatorId, setLoadMatOperatorId] = useState<string>('');
  const [loadMatNotes, setLoadMatNotes] = useState<string>('');
  const [loadMatKey, setLoadMatKey] = useState<string>('');

  const fetchBoard = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const params = new URLSearchParams();
      if (filterMoId !== 'ALL') params.set('moId', filterMoId);
      if (filterMachineId !== 'ALL') params.set('machineId', filterMachineId);
      if (filterShiftId !== 'ALL') params.set('shiftId', filterShiftId);
      if (filterExecState !== 'ALL') params.set('executionState', filterExecState);
      if (searchTerm.trim()) params.set('search', searchTerm.trim());

      const res = await fetch(`/api/shop-floor/execution-board?${params.toString()}`);
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'خطا در دریافت داده‌های اجرای کارگاه');
      }
      setBoard(json);
    } catch (err) {
      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'خطا در بارگذاری تابلوی کارگاه',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filterMoId, filterMachineId, filterShiftId, filterExecState, searchTerm]);

  useEffect(() => {
    fetchBoard();
  }, [fetchBoard]);

  const masterMachines = board?.masterData?.machines || [];
  const masterShifts = board?.masterData?.shifts || [];
  const masterOperators = board?.masterData?.operators || [];

  const getOperatorName = (userId: string) =>
    masterOperators.find(o => o.id === userId)?.fullName || undefined;

  // Open Modal Handlers (fresh idempotency key per new action)
  const openStartModal = (op: ShopFloorOperationDto) => {
    const defaultMachine =
      op.machineId ||
      op.eligibleMachineIds[0] ||
      masterMachines.find(m => m.active && m.status === 'ACTIVE')?.id ||
      '';
    setStartTarget(op);
    setStartMachineId(defaultMachine);
    setStartShiftId(op.shiftId || masterShifts[0]?.id || '');
    setStartOperatorId(op.assignedOperatorId || masterOperators[0]?.id || '');
    setStartNotes('');
    setStartKey(makeKey('SF-START'));
    setBanner(null);
  };

  const openPauseModal = (op: ShopFloorOperationDto) => {
    setPauseTarget(op);
    setPauseReason('');
    setPauseIsDowntime(false);
    setPauseKey(makeKey('SF-PAUSE'));
    setBanner(null);
  };

  const openResumeModal = (op: ShopFloorOperationDto) => {
    setResumeTarget(op);
    setResumeMachineId(op.machineId || op.eligibleMachineIds[0] || '');
    setResumeShiftId(op.shiftId || masterShifts[0]?.id || '');
    setResumeDowntimeOverride('');
    setResumeNotes('');
    setResumeKey(makeKey('SF-RESUME'));
    setBanner(null);
  };

  const openCompleteModal = (op: ShopFloorOperationDto) => {
    setCompleteTarget(op);
    setCompleteNotes('');
    setCompleteKey(makeKey('SF-DONE'));
    setBanner(null);
  };

  const openReportModal = (op: ShopFloorOperationDto) => {
    const suggestedQty = Math.max(0, Math.min(op.availableStationQty, op.remainingQty || op.availableStationQty));
    setReportTarget(op);
    setReportGoodQty(String(suggestedQty));
    setReportScrapQty('0');
    setReportScrapReason('');
    setReportReworkQty('0');
    setReportRejectedQty('0');
    setReportMaterialKg('');
    setReportRunTimeMin('60');
    setReportDowntimeMin('0');
    setReportDowntimeReason('');
    setReportStrokeStart('');
    setReportStrokeEnd('');
    setReportMachineId(op.machineId || op.eligibleMachineIds[0] || '');
    setReportShiftId(op.shiftId || masterShifts[0]?.id || '');
    setReportOperatorId(op.assignedOperatorId || masterOperators[0]?.id || '');
    setReportAllowOverproduction(false);
    setReportNotes('');
    setReportKey(makeKey('SF-RPT'));
    setBanner(null);
  };

  const openDowntimeModal = (op?: ShopFloorOperationDto) => {
    setDowntimeModalOpen(true);
    setDtMachineId(op?.machineId || masterMachines[0]?.id || '');
    setDtShiftId(op?.shiftId || masterShifts[0]?.id || '');
    setDtOpId(op?.id || '');
    setDtDurationMin('30');
    setDtReason('');
    setDtMarkBreakdown(false);
    setDtOperatorId(op?.assignedOperatorId || masterOperators[0]?.id || '');
    setDtNotes('');
    setDtKey(makeKey('SF-DT'));
    setBanner(null);
  };

  // Action Submitters
  const submitStart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!startTarget) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/shop-floor/operations/${encodeURIComponent(startTarget.id)}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: startKey,
          machineId: startMachineId || undefined,
          shiftId: startShiftId || undefined,
          operatorUserId: startOperatorId || undefined,
          operatorName: getOperatorName(startOperatorId),
          moveWaitingToInProgress: true,
          notes: startNotes.trim() || undefined,
          expectedVersion: startTarget.version,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'خطا در شروع عملیات');
      }
      setStartTarget(null);
      setBanner({ type: 'success', message: json.message || 'عملیات آغاز شد.' });
      await fetchBoard();
      onGlobalRefresh?.();
    } catch (err) {
      setBanner({ type: 'error', message: err instanceof Error ? err.message : 'خطا در شروع عملیات' });
    } finally {
      setSubmitting(false);
    }
  };

  const submitPause = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pauseTarget) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/shop-floor/operations/${encodeURIComponent(pauseTarget.id)}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: pauseKey,
          reason: pauseReason.trim(),
          isDowntime: pauseIsDowntime,
          expectedVersion: pauseTarget.version,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'خطا در توقف عملیات');
      }
      setPauseTarget(null);
      setBanner({ type: 'success', message: json.message || 'عملیات متوقف شد.' });
      await fetchBoard();
    } catch (err) {
      setBanner({ type: 'error', message: err instanceof Error ? err.message : 'خطا در توقف عملیات' });
    } finally {
      setSubmitting(false);
    }
  };

  const submitResume = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resumeTarget) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/shop-floor/operations/${encodeURIComponent(resumeTarget.id)}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: resumeKey,
          machineId: resumeMachineId || undefined,
          shiftId: resumeShiftId || undefined,
          downtimeMinutesOverride: resumeDowntimeOverride !== '' ? Number(resumeDowntimeOverride) : undefined,
          notes: resumeNotes.trim() || undefined,
          expectedVersion: resumeTarget.version,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'خطا در ازسرگیری عملیات');
      }
      setResumeTarget(null);
      setBanner({ type: 'success', message: json.message || 'عملیات از سر گرفته شد.' });
      await fetchBoard();
    } catch (err) {
      setBanner({ type: 'error', message: err instanceof Error ? err.message : 'خطا در ازسرگیری عملیات' });
    } finally {
      setSubmitting(false);
    }
  };

  const submitComplete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!completeTarget) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/shop-floor/operations/${encodeURIComponent(completeTarget.id)}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: completeKey,
          notes: completeNotes.trim() || undefined,
          expectedVersion: completeTarget.version,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'خطا در تکمیل عملیات');
      }
      setCompleteTarget(null);
      setBanner({ type: 'success', message: json.message || 'عملیات تکمیل شد.' });
      await fetchBoard();
      onGlobalRefresh?.();
    } catch (err) {
      setBanner({ type: 'error', message: err instanceof Error ? err.message : 'خطا در تکمیل عملیات' });
    } finally {
      setSubmitting(false);
    }
  };

  const submitReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reportTarget) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/shop-floor/operations/${encodeURIComponent(reportTarget.id)}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          moId: reportTarget.moId,
          idempotencyKey: reportKey,
          machineId: reportMachineId || undefined,
          shiftId: reportShiftId,
          operatorUserId: reportOperatorId || undefined,
          operatorName: getOperatorName(reportOperatorId),
          goodQty: Number(reportGoodQty) || 0,
          scrapQty: Number(reportScrapQty) || 0,
          reworkQty: Number(reportReworkQty) || 0,
          rejectedQty: Number(reportRejectedQty) || 0,
          scrapReason: reportScrapReason.trim() || undefined,
          actualMaterialConsumedKg:
            reportMaterialKg.trim() !== '' ? Number(reportMaterialKg) : undefined,
          runTimeMinutes: reportRunTimeMin.trim() !== '' ? Number(reportRunTimeMin) : undefined,
          downtimeMinutes: reportDowntimeMin.trim() !== '' ? Number(reportDowntimeMin) : undefined,
          downtimeReason: reportDowntimeReason.trim() || undefined,
          strokeCounterStart:
            reportStrokeStart.trim() !== '' ? Number(reportStrokeStart) : undefined,
          strokeCounterEnd:
            reportStrokeEnd.trim() !== '' ? Number(reportStrokeEnd) : undefined,
          allowOverproduction: reportAllowOverproduction,
          notes: reportNotes.trim() || undefined,
          expectedVersion: reportTarget.version,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'خطا در ثبت گزارش تولید کارگاه');
      }
      setReportTarget(null);
      setBanner({ type: 'success', message: json.message || 'گزارش تولید با موفقیت ثبت شد.' });
      await fetchBoard();
      onGlobalRefresh?.();
    } catch (err) {
      setBanner({ type: 'error', message: err instanceof Error ? err.message : 'خطا در ثبت گزارش تولید' });
    } finally {
      setSubmitting(false);
    }
  };

  const submitDowntime = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch('/api/shop-floor/downtime', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: dtKey,
          machineId: dtMachineId,
          shiftId: dtShiftId || undefined,
          productionOperationId: dtOpId || undefined,
          durationMinutes: Number(dtDurationMin),
          reason: dtReason.trim(),
          markMachineBreakdown: dtMarkBreakdown,
          operatorUserId: dtOperatorId || undefined,
          operatorName: getOperatorName(dtOperatorId),
          notes: dtNotes.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'خطا در ثبت توقف ماشین');
      }
      setDowntimeModalOpen(false);
      setBanner({ type: 'success', message: json.message || 'توقف ماشین ثبت شد.' });
      await fetchBoard();
      onGlobalRefresh?.();
    } catch (err) {
      setBanner({ type: 'error', message: err instanceof Error ? err.message : 'خطا در ثبت توقف ماشین' });
    } finally {
      setSubmitting(false);
    }
  };

  const openLoadMaterialModal = async (op: ShopFloorOperationDto) => {
    setBanner(null);
    setLoadMatTarget(op);
    const defaultQty = Math.max(1, op.remainingQty || op.plannedQty || 100);
    setLoadMatQty(String(defaultQty));
    const estKg = op.partWeightGrossKg > 0 ? Math.round(defaultQty * op.partWeightGrossKg * 100) / 100 : '';
    setLoadMatWeightKg(estKg ? String(estKg) : '');
    setLoadMatOperatorId(op.assignedOperatorId || masterOperators[0]?.id || '');
    setLoadMatNotes('');
    setLoadMatKey(makeKey(`MAT-${op.moId}`));
    setLoadMatSourceId('');
    setLoadingSources(true);
    try {
      const res = await fetch('/api/wip/material-sources');
      const json = await res.json();
      const rows: MaterialSourceOption[] = Array.isArray(json?.data) ? json.data : [];
      setMaterialSources(rows);
      if (rows.length > 0) {
        setLoadMatSourceId(rows[0].id);
      }
    } catch {
      setMaterialSources([]);
    } finally {
      setLoadingSources(false);
    }
  };

  const submitLoadMaterial = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loadMatTarget || submitting) return;
    setSubmitting(true);
    setBanner(null);
    try {
      const opUser = masterOperators.find(o => o.id === loadMatOperatorId);
      const qtyNum = Number(loadMatQty);
      if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
        throw new Error('تعداد بارگذاری مواد باید بزرگتر از صفر باشد.');
      }
      const res = await fetch(`/api/wip/manufacturing-orders/${loadMatTarget.moId}/load-material`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': loadMatKey,
        },
        body: JSON.stringify({
          operationId: loadMatTarget.id,
          quantity: qtyNum,
          sourceStockBalanceId: loadMatSourceId || undefined,
          sourceWeightKg: loadMatWeightKg !== '' ? Number(loadMatWeightKg) : undefined,
          createdByUserId: loadMatOperatorId || undefined,
          operatorName: opUser?.fullName || 'اپراتور خط',
          notes: loadMatNotes || undefined,
          expectedVersion: loadMatTarget.version,
          idempotencyKey: loadMatKey,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'خطا در بارگذاری مواد اولیه در دستور کار');
      }
      setLoadMatTarget(null);
      setBanner({ type: 'success', message: json.message || 'مواد اولیه با موفقیت در صف ایستگاه بارگذاری شد.' });
      await fetchBoard();
      onGlobalRefresh?.();
    } catch (err) {
      setBanner({ type: 'error', message: err instanceof Error ? err.message : 'خطا در بارگذاری مواد' });
    } finally {
      setSubmitting(false);
    }
  };

  const operationsQueue = board?.operationsQueue || [];
  const workOrders = board?.workOrders || [];
  const kpis = board?.kpis;

  const eligibleMachinesForTarget = useMemo(() => {
    const target = reportTarget || startTarget || resumeTarget;
    if (!target) return masterMachines;
    if (!target.eligibleMachineIds?.length) return masterMachines;
    const set = new Set(target.eligibleMachineIds);
    return masterMachines.filter(m => set.has(m.id) || m.id === target.machineId);
  }, [reportTarget, startTarget, resumeTarget, masterMachines]);

  return (
    <div className="space-y-3.5 text-right font-sans" dir="rtl">
      {/* Header & Mode Switcher */}
      <div className="sap-card p-3.5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e5e7eb] pb-3">
          <div>
            <h2 className="text-sm font-bold text-[#222222] flex items-center gap-2">
              <Hammer className="w-4 h-4 text-[#007cc0]" />
              <span>کنسول اجرای کارگاه، کنترل عملیات خط و پایش سرپرست (Shop Floor Control)</span>
            </h2>
            <p className="text-xs text-[#666666] mt-0.5">
              تبدیل برنامه‌های ابلاغ‌شده به صف اجرای اپراتور، کنترل توالی عملیات، ثبت تولید و ضایعات، مصرف کلاف و توقفات ماشین‌آلات
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap shrink-0">
            <div className="inline-flex border border-[#bfbfbf] rounded overflow-hidden bg-[#f7f7f7]">
              <button
                type="button"
                onClick={() => setSubView('OPERATOR')}
                className={`px-3 py-1.5 text-xs font-semibold cursor-pointer whitespace-nowrap transition ${
                  subView === 'OPERATOR'
                    ? 'bg-[#007cc0] text-white'
                    : 'text-[#333333] hover:bg-[#eaeaea]'
                }`}
              >
                کنسول اجرای اپراتور ({toPersianDigits(operationsQueue.filter(o => o.executionState !== 'COMPLETED').length)})
              </button>
              <button
                type="button"
                onClick={() => setSubView('SUPERVISOR')}
                className={`px-3 py-1.5 text-xs font-semibold cursor-pointer whitespace-nowrap transition ${
                  subView === 'SUPERVISOR'
                    ? 'bg-[#007cc0] text-white'
                    : 'text-[#333333] hover:bg-[#eaeaea]'
                }`}
              >
                پایش سرپرست و شاخص‌های KPI
              </button>
            </div>

            <button
              type="button"
              onClick={() => openDowntimeModal()}
              className="px-3 py-1.5 rounded border border-[#f5cba7] bg-[#fff4e5] hover:bg-[#ffe8cc] text-[#b55505] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
            >
              <ShieldAlert className="w-3.5 h-3.5" />
              <span>ثبت توقف ماشین</span>
            </button>

            <button
              type="button"
              onClick={() => fetchBoard(true)}
              disabled={refreshing}
              className="sap-btn-standard px-2.5 py-1.5 text-xs inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              <span>بروزرسانی</span>
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-2 text-xs items-center">
          <div className="lg:col-span-4 relative">
            <Search className="w-3.5 h-3.5 text-[#666666] absolute right-2.5 top-2" />
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="جستجوی شماره دستور ساخت، کد قطعه، OP یا ماشین..."
              className="w-full bg-white border border-[#bfbfbf] rounded pr-8 pl-2.5 py-1.5 text-[#333333] focus:outline-none focus:border-[#007cc0]"
            />
          </div>

          <div className="lg:col-span-2">
            <select
              value={filterMoId}
              onChange={e => setFilterMoId(e.target.value)}
              className="w-full bg-white border border-[#bfbfbf] rounded px-2 py-1.5 text-[#333333] focus:outline-none focus:border-[#007cc0]"
            >
              <option value="ALL">همه دستورات کار ({toPersianDigits(workOrders.length)})</option>
              {workOrders.map(w => (
                <option key={w.id} value={w.id}>
                  {w.moNumber} — {w.partCode}
                </option>
              ))}
            </select>
          </div>

          <div className="lg:col-span-2">
            <select
              value={filterMachineId}
              onChange={e => setFilterMachineId(e.target.value)}
              className="w-full bg-white border border-[#bfbfbf] rounded px-2 py-1.5 text-[#333333] focus:outline-none focus:border-[#007cc0]"
            >
              <option value="ALL">همه ماشین‌آلات</option>
              {masterMachines.map(m => (
                <option key={m.id} value={m.id}>
                  {m.code} — {m.name}
                </option>
              ))}
            </select>
          </div>

          <div className="lg:col-span-2">
            <select
              value={filterShiftId}
              onChange={e => setFilterShiftId(e.target.value)}
              className="w-full bg-white border border-[#bfbfbf] rounded px-2 py-1.5 text-[#333333] focus:outline-none focus:border-[#007cc0]"
            >
              <option value="ALL">همه شیفت‌ها</option>
              {masterShifts.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <div className="lg:col-span-2">
            <select
              value={filterExecState}
              onChange={e => setFilterExecState(e.target.value)}
              className="w-full bg-white border border-[#bfbfbf] rounded px-2 py-1.5 text-[#333333] focus:outline-none focus:border-[#007cc0]"
            >
              <option value="ALL">همه وضعیت‌ها</option>
              <option value="READY">آماده شروع</option>
              <option value="IN_PROGRESS">در حال اجرا</option>
              <option value="PAUSED">متوقف موقت</option>
              <option value="PENDING">در صف انتظار</option>
              <option value="COMPLETED">تکمیل شده</option>
            </select>
          </div>
        </div>
      </div>

      {/* Feedback Banner */}
      {banner && (
        <div
          className={`p-3 rounded border text-xs flex items-center justify-between gap-3 ${
            banner.type === 'error'
              ? 'bg-[#fdf2f2] border-[#f5c2c7] text-[#9f1239]'
              : 'bg-[#ebf5ec] border-[#b7dfbf] text-[#107e3e]'
          }`}
        >
          <div className="flex items-center gap-2 font-medium">
            {banner.type === 'error' ? (
              <AlertTriangle className="w-4 h-4 shrink-0" />
            ) : (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            )}
            <span>{banner.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="text-xs underline cursor-pointer shrink-0"
          >
            بستن
          </button>
        </div>
      )}

      {loading && !board ? (
        <div className="sap-card p-8 text-center text-xs text-[#666666]">
          در حال بارگذاری اطلاعات اجرای کارگاه...
        </div>
      ) : null}

      {/* ================================================================== */}
      {/* VIEW 1: OPERATOR CONSOLE                                           */}
      {/* ================================================================== */}
      {board && subView === 'OPERATOR' && (
        <div className="space-y-3.5">
          {/* Compact Live Production Progress Strip */}
          {kpis && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
              <div className="sap-card px-3 py-2">
                <div className="text-[11px] text-[#666666]">دستورات فعال</div>
                <div className="text-sm font-bold font-mono tabular-nums text-[#0057b8] mt-0.5">
                  {toPersianDigits(kpis.activeWorkOrdersCount)} / {toPersianDigits(kpis.workOrdersCount)}
                </div>
              </div>
              <div className="sap-card px-3 py-2">
                <div className="text-[11px] text-[#666666]">آماده شروع</div>
                <div className="text-sm font-bold font-mono tabular-nums text-[#007cc0] mt-0.5">
                  {toPersianDigits(kpis.readyOpsCount)}
                </div>
              </div>
              <div className="sap-card px-3 py-2">
                <div className="text-[11px] text-[#666666]">در حال اجرا</div>
                <div className="text-sm font-bold font-mono tabular-nums text-[#107e3e] mt-0.5">
                  {toPersianDigits(kpis.inProgressOpsCount)}
                </div>
              </div>
              <div className="sap-card px-3 py-2">
                <div className="text-[11px] text-[#666666]">متوقف موقت</div>
                <div className="text-sm font-bold font-mono tabular-nums text-[#b55505] mt-0.5">
                  {toPersianDigits(kpis.pausedOpsCount)}
                </div>
              </div>
              <div className="sap-card px-3 py-2">
                <div className="text-[11px] text-[#666666]">تحقق تولید کل</div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-sm font-bold font-mono tabular-nums text-[#107e3e]">
                    {toPersianDigits(kpis.overallCompletionPercent)}٪
                  </span>
                  <div className="flex-1 h-1.5 bg-[#e5e7eb] rounded overflow-hidden">
                    <div
                      className="h-full bg-[#107e3e]"
                      style={{ width: `${Math.min(100, kpis.overallCompletionPercent)}%` }}
                    />
                  </div>
                </div>
              </div>
              <div className="sap-card px-3 py-2">
                <div className="text-[11px] text-[#666666]">نرخ ضایعات</div>
                <div className="text-sm font-bold font-mono tabular-nums text-[#b91c1c] mt-0.5">
                  {toPersianDigits(kpis.scrapRatePercent)}٪
                </div>
              </div>
            </div>
          )}

          {/* Released Work Orders Summary */}
          <div className="sap-card overflow-hidden">
            <div className="px-3.5 py-2.5 border-b border-[#e5e7eb] flex items-center justify-between bg-[#fafafa]">
              <h3 className="text-xs font-bold text-[#333333] flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-[#007cc0]" />
                <span>دستورات ساخت ابلاغ‌شده و در حال اجرا ({toPersianDigits(workOrders.length)})</span>
              </h3>
              {filterMoId !== 'ALL' && (
                <button
                  type="button"
                  onClick={() => setFilterMoId('ALL')}
                  className="text-[11px] text-[#007cc0] hover:underline cursor-pointer"
                >
                  نمایش همه دستورات
                </button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-right border-collapse">
                <thead className="bg-[#f5f7f9] text-[#555555] border-b border-[#d9d9d9]">
                  <tr>
                    <th className="py-2 px-3 font-semibold">شماره دستور / برنامه</th>
                    <th className="py-2 px-3 font-semibold">قطعه</th>
                    <th className="py-2 px-3 font-semibold">برنامه‌ریزی (خواندنی)</th>
                    <th className="py-2 px-3 font-semibold">سالم واقعی</th>
                    <th className="py-2 px-3 font-semibold">ضایعات</th>
                    <th className="py-2 px-3 font-semibold">کلاف (تحویلی / مصرف / مانده kg)</th>
                    <th className="py-2 px-3 font-semibold">پیشرفت</th>
                    <th className="py-2 px-3 font-semibold">وضعیت</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#eeeeee]">
                  {workOrders.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-6 text-center text-[#666666]">
                        دستور ساخت ابلاغ‌شده یا فعالی یافت نشد.
                      </td>
                    </tr>
                  ) : (
                    workOrders.map(wo => (
                      <tr
                        key={wo.id}
                        onClick={() => setFilterMoId(filterMoId === wo.id ? 'ALL' : wo.id)}
                        className={`cursor-pointer transition ${
                          filterMoId === wo.id ? 'bg-[#eef6fc]' : 'hover:bg-[#fafafa]'
                        }`}
                      >
                        <td className="py-2 px-3">
                          <div className="font-mono font-semibold text-[#0057b8]">{wo.moNumber}</div>
                          {wo.planNumber && (
                            <div className="text-[11px] text-[#666666] font-mono">
                              برنامه: {wo.planNumber}
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          <div className="font-medium text-[#222222]">{wo.partName}</div>
                          <div className="text-[11px] font-mono text-[#666666]">{wo.partCode}</div>
                        </td>
                        <td className="py-2 px-3 font-mono tabular-nums text-[#333333]">
                          {formatNumber(wo.planLinePlannedQty)}
                        </td>
                        <td className="py-2 px-3 font-mono tabular-nums font-semibold text-[#107e3e]">
                          {formatNumber(wo.completedQty)}
                        </td>
                        <td className="py-2 px-3 font-mono tabular-nums text-[#b91c1c]">
                          {formatNumber(wo.scrapQty)}
                        </td>
                        <td className="py-2 px-3 font-mono tabular-nums text-[11px] text-[#444444]">
                          {formatNumber(wo.totalIssuedMaterialKg)} / {formatNumber(wo.totalConsumedMaterialKg)} /{' '}
                          <span className="font-semibold text-[#0057b8]">
                            {formatNumber(wo.totalOutstandingMaterialKg)}
                          </span>
                        </td>
                        <td className="py-2 px-3 font-mono tabular-nums">
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-1.5 bg-[#e5e7eb] rounded overflow-hidden">
                              <div
                                className="h-full bg-[#007cc0]"
                                style={{ width: `${Math.min(100, wo.completionPercent)}%` }}
                              />
                            </div>
                            <span>{toPersianDigits(wo.completionPercent)}٪</span>
                          </div>
                        </td>
                        <td className="py-2 px-3 text-[11px] font-medium text-[#333333]">
                          {wo.status}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Shop-Floor Operations Queue */}
          <div className="sap-card overflow-hidden">
            <div className="px-3.5 py-2.5 border-b border-[#e5e7eb] flex items-center justify-between bg-[#fafafa]">
              <h3 className="text-xs font-bold text-[#333333] flex items-center gap-1.5">
                <Filter className="w-3.5 h-3.5 text-[#007cc0]" />
                <span>صف اجرای عملیات ایستگاه‌ها ({toPersianDigits(operationsQueue.length)})</span>
              </h3>
              <span className="text-[11px] text-[#666666]">
                قفل توالی بین مراحل و سقف مصرف کلاف به‌صورت خودکار کنترل می‌شود
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs text-right border-collapse">
                <thead className="bg-[#f5f7f9] text-[#555555] border-b border-[#d9d9d9]">
                  <tr>
                    <th className="py-2 px-3 font-semibold">دستور و قطعه</th>
                    <th className="py-2 px-3 font-semibold">مرحله عملیات</th>
                    <th className="py-2 px-3 font-semibold">ماشین / شیفت / اپراتور</th>
                    <th className="py-2 px-3 font-semibold">موجودی پای دستگاه (WIP)</th>
                    <th className="py-2 px-3 font-semibold">تولید سالم / ضایعات</th>
                    <th className="py-2 px-3 font-semibold">کلاف مانده (kg)</th>
                    <th className="py-2 px-3 font-semibold">وضعیت اجرا</th>
                    <th className="py-2 px-3 font-semibold text-left">اقدامات اپراتور</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#eeeeee]">
                  {operationsQueue.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-[#666666]">
                        عملیاتی مطابق فیلتر انتخاب‌شده یافت نشد.
                      </td>
                    </tr>
                  ) : (
                    operationsQueue.map(op => {
                      const meta = STATE_META[op.executionState] || STATE_META.PENDING;
                      return (
                        <tr key={op.id} className="hover:bg-[#fafafa] align-top">
                          <td className="py-2.5 px-3">
                            <div className="font-mono font-semibold text-[#0057b8]">{op.moNumber}</div>
                            <div className="text-[#222222] font-medium mt-0.5">{op.partName}</div>
                            <div className="text-[11px] font-mono text-[#666666]">{op.partCode}</div>
                          </td>
                          <td className="py-2.5 px-3">
                            <div className="font-semibold text-[#222222]">
                              <span className="font-mono text-[#0057b8] ml-1">{op.stepCode}</span>
                              {op.stepName}
                            </div>
                            <div className="text-[11px] text-[#666666] mt-0.5">
                              برنامه: <span className="font-mono tabular-nums">{formatNumber(op.plannedQty)}</span>
                              {op.dieCode ? ` | قالب: ${op.dieCode}` : ''}
                            </div>
                          </td>
                          <td className="py-2.5 px-3">
                            <div className="font-medium text-[#222222]">
                              {op.machineCode ? `${op.machineCode} — ${op.machineName || ''}` : 'تعیین‌نشده'}
                            </div>
                            <div className="text-[11px] text-[#666666] mt-0.5">
                              {op.shiftName || 'بدون شیفت'}
                              {op.assignedOperatorName ? ` | ${op.assignedOperatorName}` : ''}
                            </div>
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums">
                            <div className="text-[#222222]">
                              در حال کار: <span className="font-semibold">{formatNumber(op.inProgressQty)}</span>
                            </div>
                            <div className="text-[11px] text-[#666666]">
                              صف انتظار: {formatNumber(op.waitingInputQty)}
                            </div>
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums">
                            <div className="text-[#107e3e] font-semibold">
                              سالم: {formatNumber(op.outputGoodQty)}
                            </div>
                            <div className="text-[11px] text-[#b91c1c]">
                              ضایعات: {formatNumber(op.outputScrapQty)} | باقیمانده: {formatNumber(op.remainingQty)}
                            </div>
                            <div className="flex items-center gap-1.5 mt-1">
                              <div className="w-16 h-1.5 bg-[#e5e7eb] rounded overflow-hidden">
                                <div
                                  className="h-full bg-[#107e3e]"
                                  style={{ width: `${Math.min(100, op.completionPercent)}%` }}
                                />
                              </div>
                              <span className="text-[10px] text-[#555555]">{toPersianDigits(op.completionPercent)}٪</span>
                            </div>
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums text-[#333333]">
                            {op.outstandingMaterialKg > 0 ? (
                              <span className="font-semibold text-[#0057b8]">
                                {formatNumber(op.outstandingMaterialKg)}
                              </span>
                            ) : (
                              <span className="text-[#999999]">—</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3">
                            <div className={`inline-flex items-center gap-1.5 font-semibold ${meta.textClass}`}>
                              <span className={`w-2 h-2 rounded-full ${meta.dotClass}`} />
                              <span>{meta.label}</span>
                            </div>
                            {op.predecessorBlocked && (
                              <div className="text-[11px] text-[#b55505] flex items-center gap-1 mt-1">
                                <Lock className="w-3 h-3 shrink-0" />
                                <span>منتظر خروجی مرحله قبل</span>
                              </div>
                            )}
                            {op.isPaused && op.lastPauseReason && (
                              <div className="text-[11px] text-[#b55505] mt-1">
                                علت: {op.lastPauseReason}
                              </div>
                            )}
                          </td>
                          <td className="py-2.5 px-3">
                            <div className="flex items-center justify-end gap-1.5 flex-wrap">
                              {op.canLoadMaterial && (
                                <button
                                  type="button"
                                  onClick={() => openLoadMaterialModal(op)}
                                  className={`px-2 py-1 rounded border text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0 ${
                                    op.availableStationQty <= 0
                                      ? 'border-[#007cc0] bg-[#eef6fc] hover:bg-[#d8ecfa] text-[#0057b8]'
                                      : 'border-[#bfbfbf] bg-[#f7f7f7] hover:bg-[#eaeaea] text-[#333333]'
                                  }`}
                                >
                                  <PackagePlus className="w-3 h-3" />
                                  <span>بارگذاری مواد</span>
                                </button>
                              )}
                              {op.canStart && (
                                <button
                                  type="button"
                                  onClick={() => openStartModal(op)}
                                  className="sap-btn-emphasized px-2.5 py-1 text-[11px] inline-flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0"
                                >
                                  <Play className="w-3 h-3" />
                                  <span>شروع</span>
                                </button>
                              )}
                              {op.canPause && (
                                <button
                                  type="button"
                                  onClick={() => openPauseModal(op)}
                                  className="px-2 py-1 rounded border border-[#f5cba7] bg-[#fff4e5] hover:bg-[#ffe8cc] text-[#b55505] text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0"
                                >
                                  <Pause className="w-3 h-3" />
                                  <span>توقف</span>
                                </button>
                              )}
                              {op.canResume && (
                                <button
                                  type="button"
                                  onClick={() => openResumeModal(op)}
                                  className="px-2.5 py-1 rounded border border-[#b7dfbf] bg-[#ebf5ec] hover:bg-[#d8eedb] text-[#107e3e] text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0"
                                >
                                  <Play className="w-3 h-3" />
                                  <span>ادامه</span>
                                </button>
                              )}
                              {op.canReport && (
                                <button
                                  type="button"
                                  onClick={() => openReportModal(op)}
                                  className="px-2.5 py-1 rounded border border-[#007cc0] bg-[#e5f3fa] hover:bg-[#d0eaf7] text-[#0057b8] text-[11px] font-semibold cursor-pointer whitespace-nowrap shrink-0"
                                >
                                  ثبت تولید و مصرف
                                </button>
                              )}
                              {op.canComplete && (
                                <button
                                  type="button"
                                  onClick={() => openCompleteModal(op)}
                                  className="px-2.5 py-1 rounded border border-[#2b7d2b] bg-[#ebf5ec] hover:bg-[#d8eedb] text-[#2b7d2b] text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0"
                                >
                                  <CheckCircle2 className="w-3 h-3" />
                                  <span>تکمیل</span>
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => openDowntimeModal(op)}
                                title="ثبت توقف ماشین برای این عملیات"
                                className="sap-btn-standard px-2 py-1 text-[11px] cursor-pointer whitespace-nowrap shrink-0"
                              >
                                <Wrench className="w-3 h-3" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================== */}
      {/* VIEW 2: SUPERVISOR PROGRESS & KPI DASHBOARD                        */}
      {/* ================================================================== */}
      {board && subView === 'SUPERVISOR' && kpis && (
        <div className="space-y-3.5">
          {/* 5 Core KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="sap-card p-3.5">
              <div className="text-[11px] text-[#666666] font-medium">برنامه‌ریزی در برابر واقعی</div>
              <div className="mt-1.5 flex items-baseline gap-1.5 font-mono tabular-nums">
                <span className="text-lg font-bold text-[#0057b8]">
                  {formatNumber(kpis.totalActualGoodQty)}
                </span>
                <span className="text-xs text-[#666666]">
                  / {formatNumber(kpis.totalPlannedQty)}
                </span>
              </div>
              <div className="text-[11px] text-[#666666] mt-1">
                دستور فعال: {toPersianDigits(kpis.activeWorkOrdersCount)} از {toPersianDigits(kpis.workOrdersCount)}
              </div>
            </div>

            <div className="sap-card p-3.5">
              <div className="text-[11px] text-[#666666] font-medium">درصد تکمیل و تحقق</div>
              <div className="mt-1.5 text-lg font-bold font-mono tabular-nums text-[#107e3e]">
                {toPersianDigits(kpis.overallCompletionPercent)}٪
              </div>
              <div className="w-full h-1.5 bg-[#e5e7eb] rounded mt-2 overflow-hidden">
                <div
                  className="h-full bg-[#107e3e]"
                  style={{ width: `${Math.min(100, kpis.overallCompletionPercent)}%` }}
                />
              </div>
            </div>

            <div className="sap-card p-3.5">
              <div className="text-[11px] text-[#666666] font-medium">نرخ ضایعات (Scrap Rate)</div>
              <div className="mt-1.5 text-lg font-bold font-mono tabular-nums text-[#b91c1c]">
                {toPersianDigits(kpis.scrapRatePercent)}٪
              </div>
              <div className="text-[11px] text-[#666666] mt-1 font-mono tabular-nums">
                ضایعات: {formatNumber(kpis.totalScrapQty)} | دوباره‌کاری: {formatNumber(kpis.totalReworkQty)}
              </div>
            </div>

            <div className="sap-card p-3.5">
              <div className="text-[11px] text-[#666666] font-medium flex items-center gap-1">
                <Gauge className="w-3.5 h-3.5 text-[#007cc0]" />
                <span>کارکرد و بهره‌وری ماشین‌ها</span>
              </div>
              <div className="mt-1.5 text-lg font-bold font-mono tabular-nums text-[#0057b8]">
                {toPersianDigits(kpis.machineUtilizationPercent)}٪
              </div>
              <div className="text-[11px] text-[#666666] mt-1 font-mono tabular-nums">
                زمان کارکرد ثبت‌شده: {formatNumber(kpis.totalRunTimeMinutes)} دقیقه
              </div>
            </div>

            <div className="sap-card p-3.5">
              <div className="text-[11px] text-[#666666] font-medium flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-[#e9730c]" />
                <span>مجموع توقفات کارگاه</span>
              </div>
              <div className="mt-1.5 text-lg font-bold font-mono tabular-nums text-[#b55505]">
                {formatNumber(kpis.totalDowntimeMinutes)} دقیقه
              </div>
              <div className="text-[11px] text-[#666666] mt-1 font-mono tabular-nums">
                ایستگاه متوقف فعلی: {toPersianDigits(kpis.pausedOpsCount)} | رویدادها: {toPersianDigits(board.downtimeEvents.length)}
              </div>
            </div>
          </div>

          {/* Machine Utilization + Downtime Breakdown */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">
            <div className="lg:col-span-7 sap-card overflow-hidden">
              <div className="px-3.5 py-2.5 border-b border-[#e5e7eb] bg-[#fafafa] text-xs font-bold text-[#333333]">
                وضعیت و بهره‌وری ماشین‌آلات خط
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-right border-collapse">
                  <thead className="bg-[#f5f7f9] text-[#555555] border-b border-[#d9d9d9]">
                    <tr>
                      <th className="py-2 px-3 font-semibold">ماشین</th>
                      <th className="py-2 px-3 font-semibold">وضعیت</th>
                      <th className="py-2 px-3 font-semibold">در اجرا / متوقف</th>
                      <th className="py-2 px-3 font-semibold">کارکرد (دقیقه)</th>
                      <th className="py-2 px-3 font-semibold">توقف (دقیقه)</th>
                      <th className="py-2 px-3 font-semibold">بهره‌وری</th>
                      <th className="py-2 px-3 font-semibold">تولید سالم / ضایعات</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#eeeeee]">
                    {kpis.perMachine.map(m => (
                      <tr key={m.machineId} className="hover:bg-[#fafafa]">
                        <td className="py-2 px-3">
                          <div className="font-mono font-semibold text-[#222222]">{m.machineCode}</div>
                          <div className="text-[11px] text-[#666666]">{m.machineName}</div>
                        </td>
                        <td className="py-2 px-3 text-[11px] font-semibold">
                          <span
                            className={
                              m.status === 'BREAKDOWN'
                                ? 'text-[#b91c1c]'
                                : m.status === 'ACTIVE'
                                ? 'text-[#107e3e]'
                                : 'text-[#b55505]'
                            }
                          >
                            {m.status}
                          </span>
                        </td>
                        <td className="py-2 px-3 font-mono tabular-nums">
                          {toPersianDigits(m.inProgressOpsCount)} / {toPersianDigits(m.pausedOpsCount)}
                        </td>
                        <td className="py-2 px-3 font-mono tabular-nums">{formatNumber(m.runTimeMinutes)}</td>
                        <td className="py-2 px-3 font-mono tabular-nums text-[#b55505]">
                          {formatNumber(m.downtimeMinutes)}
                        </td>
                        <td className="py-2 px-3 font-mono tabular-nums font-semibold text-[#0057b8]">
                          {toPersianDigits(m.utilizationPercent)}٪
                        </td>
                        <td className="py-2 px-3 font-mono tabular-nums">
                          <span className="text-[#107e3e]">{formatNumber(m.goodQty)}</span> /{' '}
                          <span className="text-[#b91c1c]">{formatNumber(m.scrapQty)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="lg:col-span-5 sap-card overflow-hidden">
              <div className="px-3.5 py-2.5 border-b border-[#e5e7eb] bg-[#fafafa] text-xs font-bold text-[#333333]">
                تحلیل توقفات بر اساس علت
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-right border-collapse">
                  <thead className="bg-[#f5f7f9] text-[#555555] border-b border-[#d9d9d9]">
                    <tr>
                      <th className="py-2 px-3 font-semibold">علت توقف</th>
                      <th className="py-2 px-3 font-semibold">تعداد</th>
                      <th className="py-2 px-3 font-semibold">مدت (دقیقه)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#eeeeee]">
                    {kpis.downtimeByReason.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="py-6 text-center text-[#666666]">
                          توقفی ثبت نشده است.
                        </td>
                      </tr>
                    ) : (
                      kpis.downtimeByReason.map(item => (
                        <tr key={item.reason} className="hover:bg-[#fafafa]">
                          <td className="py-2 px-3 text-[#222222]">{item.reason}</td>
                          <td className="py-2 px-3 font-mono tabular-nums">{toPersianDigits(item.count)}</td>
                          <td className="py-2 px-3 font-mono tabular-nums font-semibold text-[#b55505]">
                            {formatNumber(item.minutes)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Recent Production Reports & Downtime Events */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">
            <div className="lg:col-span-7 sap-card overflow-hidden">
              <div className="px-3.5 py-2.5 border-b border-[#e5e7eb] bg-[#fafafa] text-xs font-bold text-[#333333]">
                آخرین گزارش‌های تولید ثبت‌شده ({toPersianDigits(board.recentReports.length)})
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-right border-collapse">
                  <thead className="bg-[#f5f7f9] text-[#555555] border-b border-[#d9d9d9]">
                    <tr>
                      <th className="py-2 px-3 font-semibold">شماره / دستور</th>
                      <th className="py-2 px-3 font-semibold">مرحله / ماشین</th>
                      <th className="py-2 px-3 font-semibold">سالم / ضایعات</th>
                      <th className="py-2 px-3 font-semibold">مصرف کلاف (kg)</th>
                      <th className="py-2 px-3 font-semibold">اپراتور / زمان</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#eeeeee]">
                    {board.recentReports.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-6 text-center text-[#666666]">
                          هنوز گزارش تولیدی ثبت نشده است.
                        </td>
                      </tr>
                    ) : (
                      board.recentReports.slice(0, 20).map(r => (
                        <tr key={r.id} className="hover:bg-[#fafafa]">
                          <td className="py-2 px-3">
                            <div className="font-mono text-[#0057b8] font-semibold">{r.moNumber}</div>
                            <div className="text-[11px] font-mono text-[#666666]">{r.reportNumber}</div>
                          </td>
                          <td className="py-2 px-3">
                            <div className="font-medium text-[#222222]">{r.stepCode} — {r.stepName}</div>
                            <div className="text-[11px] text-[#666666]">{r.machineCode || '—'} | {r.shiftName}</div>
                          </td>
                          <td className="py-2 px-3 font-mono tabular-nums">
                            <span className="text-[#107e3e] font-semibold">{formatNumber(r.goodQty)}</span> /{' '}
                            <span className="text-[#b91c1c]">{formatNumber(r.scrapQty)}</span>
                          </td>
                          <td className="py-2 px-3 font-mono tabular-nums">
                            {r.actualMaterialConsumedKg != null ? formatNumber(r.actualMaterialConsumedKg) : '—'}
                          </td>
                          <td className="py-2 px-3">
                            <div>{r.operatorName}</div>
                            <div className="text-[11px] text-[#666666]">{formatDateTime(r.reportDate)}</div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="lg:col-span-5 sap-card overflow-hidden">
              <div className="px-3.5 py-2.5 border-b border-[#e5e7eb] bg-[#fafafa] text-xs font-bold text-[#333333] flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5 text-[#007cc0]" />
                <span>تاریخچه رخدادهای خط و توقفات</span>
              </div>
              <div className="divide-y divide-[#eeeeee] max-h-80 overflow-y-auto">
                {board.activityTimeline.length === 0 && board.downtimeEvents.length === 0 ? (
                  <div className="p-6 text-center text-xs text-[#666666]">رخدادی ثبت نشده است.</div>
                ) : (
                  board.activityTimeline.slice(0, 20).map(ev => (
                    <div key={ev.id} className="px-3.5 py-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-[#222222]">
                          {ACTIVITY_LABELS[ev.activityType] || ev.activityType}
                        </span>
                        <span className="text-[11px] font-mono text-[#0057b8]">{ev.moNumber}</span>
                      </div>
                      <div className="text-[11px] text-[#555555] mt-0.5">
                        {ev.stepName || `مرحله ${ev.stepNumber}`} — {ev.operatorName}
                        {ev.notes ? ` | ${ev.notes}` : ''}
                      </div>
                      <div className="text-[10px] text-[#888888] mt-0.5">{formatDateTime(ev.timestamp)}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================== */}
      {/* MODAL: START OPERATION                                             */}
      {/* ================================================================== */}
      {startTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <form onSubmit={submitStart} className="bg-white rounded border border-[#d9d9d9] w-full max-w-md p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-[#e5e7eb] pb-2">
              <h4 className="text-sm font-bold text-[#222222]">
                شروع عملیات {startTarget.stepCode} ({startTarget.moNumber})
              </h4>
              <button type="button" onClick={() => setStartTarget(null)} className="text-[#666666] cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-2.5 text-xs">
              <div>
                <label className="block font-semibold text-[#333333] mb-1">ماشین مجاز</label>
                <select
                  required
                  value={startMachineId}
                  onChange={e => setStartMachineId(e.target.value)}
                  className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5"
                >
                  <option value="">انتخاب ماشین...</option>
                  {eligibleMachinesForTarget.map(m => (
                    <option key={m.id} value={m.id}>
                      {m.code} — {m.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-semibold text-[#333333] mb-1">شیفت</label>
                  <select
                    value={startShiftId}
                    onChange={e => setStartShiftId(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5"
                  >
                    {masterShifts.map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-[#333333] mb-1">اپراتور</label>
                  <select
                    value={startOperatorId}
                    onChange={e => setStartOperatorId(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5"
                  >
                    {masterOperators.map(o => (
                      <option key={o.id} value={o.id}>{o.fullName}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block font-semibold text-[#333333] mb-1">یادداشت شروع (اختیاری)</label>
                <input
                  type="text"
                  value={startNotes}
                  onChange={e => setStartNotes(e.target.value)}
                  className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5"
                  placeholder="تنظیم قالب و شروع تولید..."
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-[#e5e7eb]">
              <button type="button" onClick={() => setStartTarget(null)} className="sap-btn-standard px-3 py-1.5 text-xs cursor-pointer">
                انصراف
              </button>
              <button type="submit" disabled={submitting} className="sap-btn-emphasized px-3.5 py-1.5 text-xs cursor-pointer">
                {submitting ? 'در حال ثبت...' : 'تایید شروع عملیات'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ================================================================== */}
      {/* MODAL: PAUSE OPERATION                                             */}
      {/* ================================================================== */}
      {pauseTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <form onSubmit={submitPause} className="bg-white rounded border border-[#d9d9d9] w-full max-w-md p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-[#e5e7eb] pb-2">
              <h4 className="text-sm font-bold text-[#222222]">
                توقف موقت عملیات {pauseTarget.stepCode} ({pauseTarget.moNumber})
              </h4>
              <button type="button" onClick={() => setPauseTarget(null)} className="text-[#666666] cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-2.5 text-xs">
              <div>
                <label className="block font-semibold text-[#333333] mb-1">علت توقف (الزامی)</label>
                <input
                  required
                  type="text"
                  value={pauseReason}
                  onChange={e => setPauseReason(e.target.value)}
                  className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5"
                  placeholder="علت توقف خط یا تنظیم قالب را وارد کنید..."
                />
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {DOWNTIME_PRESETS.slice(0, 3).map(preset => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setPauseReason(preset)}
                      className="text-[11px] px-2 py-0.5 border border-[#d9d9d9] rounded bg-[#f7f7f7] hover:bg-[#eeeeee] cursor-pointer"
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={pauseIsDowntime}
                  onChange={e => setPauseIsDowntime(e.target.checked)}
                />
                <span>ثبت خودکار زمان توقف ماشین هنگام ازسرگیری (Resume)</span>
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-[#e5e7eb]">
              <button type="button" onClick={() => setPauseTarget(null)} className="sap-btn-standard px-3 py-1.5 text-xs cursor-pointer">
                انصراف
              </button>
              <button type="submit" disabled={submitting} className="px-3.5 py-1.5 rounded bg-[#e9730c] text-white text-xs font-semibold cursor-pointer">
                {submitting ? 'در حال ثبت...' : 'تایید توقف موقت'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ================================================================== */}
      {/* MODAL: RESUME OPERATION                                            */}
      {/* ================================================================== */}
      {resumeTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <form onSubmit={submitResume} className="bg-white rounded border border-[#d9d9d9] w-full max-w-md p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-[#e5e7eb] pb-2">
              <h4 className="text-sm font-bold text-[#222222]">
                ازسرگیری عملیات {resumeTarget.stepCode} ({resumeTarget.moNumber})
              </h4>
              <button type="button" onClick={() => setResumeTarget(null)} className="text-[#666666] cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-2.5 text-xs">
              <div>
                <label className="block font-semibold text-[#333333] mb-1">ماشین اجرا</label>
                <select
                  value={resumeMachineId}
                  onChange={e => setResumeMachineId(e.target.value)}
                  className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5"
                >
                  {eligibleMachinesForTarget.map(m => (
                    <option key={m.id} value={m.id}>{m.code} — {m.name}</option>
                  ))}
                </select>
              </div>
              {resumeTarget.lastPauseIsDowntime && (
                <div>
                  <label className="block font-semibold text-[#333333] mb-1">
                    دقایق توقف محاسبه‌شده (اختیاری — در صورت خالی بودن از زمان توقف حساب می‌شود)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={resumeDowntimeOverride}
                    onChange={e => setResumeDowntimeOverride(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5 font-mono"
                    placeholder="مثلاً 15"
                  />
                </div>
              )}
              <div>
                <label className="block font-semibold text-[#333333] mb-1">یادداشت</label>
                <input
                  type="text"
                  value={resumeNotes}
                  onChange={e => setResumeNotes(e.target.value)}
                  className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-[#e5e7eb]">
              <button type="button" onClick={() => setResumeTarget(null)} className="sap-btn-standard px-3 py-1.5 text-xs cursor-pointer">
                انصراف
              </button>
              <button type="submit" disabled={submitting} className="px-3.5 py-1.5 rounded bg-[#107e3e] text-white text-xs font-semibold cursor-pointer">
                {submitting ? 'در حال ثبت...' : 'ازسرگیری تولید'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ================================================================== */}
      {/* MODAL: COMPLETE OPERATION                                          */}
      {/* ================================================================== */}
      {completeTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <form onSubmit={submitComplete} className="bg-white rounded border border-[#d9d9d9] w-full max-w-md p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-[#e5e7eb] pb-2">
              <h4 className="text-sm font-bold text-[#222222]">
                بستن و تکمیل عملیات {completeTarget.stepCode} ({completeTarget.moNumber})
              </h4>
              <button type="button" onClick={() => setCompleteTarget(null)} className="text-[#666666] cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-[#444444]">
              تولید سالم ثبت‌شده: <span className="font-mono font-bold text-[#107e3e]">{formatNumber(completeTarget.outputGoodQty)}</span>{' '}
              از <span className="font-mono">{formatNumber(completeTarget.plannedQty)}</span>. پس از تکمیل، این ایستگاه قفل می‌شود.
            </p>
            <div className="text-xs">
              <label className="block font-semibold text-[#333333] mb-1">توضیحات پایانی (اختیاری)</label>
              <input
                type="text"
                value={completeNotes}
                onChange={e => setCompleteNotes(e.target.value)}
                className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-[#e5e7eb]">
              <button type="button" onClick={() => setCompleteTarget(null)} className="sap-btn-standard px-3 py-1.5 text-xs cursor-pointer">
                انصراف
              </button>
              <button type="submit" disabled={submitting} className="px-3.5 py-1.5 rounded bg-[#2b7d2b] text-white text-xs font-semibold cursor-pointer">
                {submitting ? 'در حال ثبت...' : 'تایید تکمیل عملیات'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ================================================================== */}
      {/* MODAL: PRODUCTION & MATERIAL CONSUMPTION REPORT                    */}
      {/* ================================================================== */}
      {reportTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 overflow-y-auto">
          <form onSubmit={submitReport} className="bg-white rounded border border-[#d9d9d9] w-full max-w-2xl p-4 space-y-3 my-4">
            <div className="flex items-center justify-between border-b border-[#e5e7eb] pb-2">
              <div>
                <h4 className="text-sm font-bold text-[#222222]">
                  ثبت گزارش تولید، ضایعات و مصرف مواد — {reportTarget.stepCode} ({reportTarget.moNumber})
                </h4>
                <p className="text-[11px] text-[#666666]">
                  موجودی آماده در ایستگاه: <span className="font-mono font-bold">{formatNumber(reportTarget.availableStationQty)}</span> |{' '}
                  باقیمانده تا سقف برنامه: <span className="font-mono font-bold">{formatNumber(reportTarget.remainingQty)}</span>
                </p>
              </div>
              <button type="button" onClick={() => setReportTarget(null)} className="text-[#666666] cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
              <div>
                <label className="block font-semibold text-[#107e3e] mb-1">تعداد سالم (Good)</label>
                <input
                  required
                  type="number"
                  min={0}
                  step="any"
                  value={reportGoodQty}
                  onChange={e => setReportGoodQty(e.target.value)}
                  className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold text-[#b91c1c] mb-1">تعداد ضایعات (Scrap)</label>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={reportScrapQty}
                  onChange={e => setReportScrapQty(e.target.value)}
                  className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold text-[#333333] mb-1">دوباره‌کاری (Rework)</label>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={reportReworkQty}
                  onChange={e => setReportReworkQty(e.target.value)}
                  className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold text-[#333333] mb-1">مردود کیفی (Reject)</label>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={reportRejectedQty}
                  onChange={e => setReportRejectedQty(e.target.value)}
                  className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5 font-mono"
                />
              </div>
            </div>

            {Number(reportScrapQty) > 0 && (
              <div className="text-xs">
                <label className="block font-semibold text-[#b91c1c] mb-1">علت ضایعات (الزامی)</label>
                <input
                  required
                  type="text"
                  value={reportScrapReason}
                  onChange={e => setReportScrapReason(e.target.value)}
                  className="w-full border border-[#f5c2c7] rounded px-2.5 py-1.5"
                  placeholder="مثلاً پارگی ورق، خطای پانچ یا سرکلاف..."
                />
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
              <div>
                <label className="block font-semibold text-[#333333] mb-1">
                  مصرف واقعی کلاف (kg)
                  {reportTarget.outstandingMaterialKg > 0 && (
                    <span className="text-[10px] text-[#0057b8] mr-1 font-mono">
                      (مانده: {formatNumber(reportTarget.outstandingMaterialKg)})
                    </span>
                  )}
                </label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={reportMaterialKg}
                  onChange={e => setReportMaterialKg(e.target.value)}
                  className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5 font-mono"
                  placeholder="اختیاری (کیلوگرم)"
                />
              </div>
              <div>
                <label className="block font-semibold text-[#333333] mb-1">زمان کارکرد (دقیقه)</label>
                <input
                  type="number"
                  min={0}
                  value={reportRunTimeMin}
                  onChange={e => setReportRunTimeMin(e.target.value)}
                  className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold text-[#333333] mb-1">توقف حین شیفت (دقیقه)</label>
                <input
                  type="number"
                  min={0}
                  value={reportDowntimeMin}
                  onChange={e => setReportDowntimeMin(e.target.value)}
                  className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5 font-mono"
                />
              </div>
            </div>

            {Number(reportDowntimeMin) > 0 && (
              <div className="text-xs">
                <label className="block font-semibold text-[#b55505] mb-1">علت توقف حین تولید (الزامی)</label>
                <input
                  required
                  type="text"
                  value={reportDowntimeReason}
                  onChange={e => setReportDowntimeReason(e.target.value)}
                  className="w-full border border-[#f5cba7] rounded px-2.5 py-1.5"
                  placeholder="علت توقف ماشین در این شیفت..."
                />
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
              <div>
                <label className="block font-semibold text-[#333333] mb-1">ماشین</label>
                <select
                  value={reportMachineId}
                  onChange={e => setReportMachineId(e.target.value)}
                  className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5"
                >
                  {eligibleMachinesForTarget.map(m => (
                    <option key={m.id} value={m.id}>{m.code} — {m.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-semibold text-[#333333] mb-1">شیفت (الزامی)</label>
                <select
                  required
                  value={reportShiftId}
                  onChange={e => setReportShiftId(e.target.value)}
                  className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5"
                >
                  {masterShifts.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-semibold text-[#333333] mb-1">اپراتور</label>
                <select
                  value={reportOperatorId}
                  onChange={e => setReportOperatorId(e.target.value)}
                  className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5"
                >
                  {masterOperators.map(o => (
                    <option key={o.id} value={o.id}>{o.fullName}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">
              <div>
                <label className="block font-semibold text-[#333333] mb-1">شمارنده ضربه شروع (اختیاری)</label>
                <input
                  type="number"
                  min={0}
                  value={reportStrokeStart}
                  onChange={e => setReportStrokeStart(e.target.value)}
                  className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold text-[#333333] mb-1">شمارنده ضربه پایان (اختیاری)</label>
                <input
                  type="number"
                  min={0}
                  value={reportStrokeEnd}
                  onChange={e => setReportStrokeEnd(e.target.value)}
                  className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5 font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold text-[#333333] mb-1">توضیحات</label>
                <input
                  type="text"
                  value={reportNotes}
                  onChange={e => setReportNotes(e.target.value)}
                  className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs text-[#444444] cursor-pointer">
              <input
                type="checkbox"
                checked={reportAllowOverproduction}
                onChange={e => setReportAllowOverproduction(e.target.checked)}
              />
              <span>مجوز سرپرست برای تولید مازاد بر سقف برنامه عملیاتی (بدون تغییر برنامه اصلی)</span>
            </label>

            <div className="flex justify-end gap-2 pt-2 border-t border-[#e5e7eb]">
              <button type="button" onClick={() => setReportTarget(null)} className="sap-btn-standard px-3 py-1.5 text-xs cursor-pointer">
                انصراف
              </button>
              <button type="submit" disabled={submitting} className="sap-btn-emphasized px-4 py-1.5 text-xs cursor-pointer">
                {submitting ? 'در حال ثبت...' : 'ثبت قطعی گزارش تولید'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ================================================================== */}
      {/* MODAL: STANDALONE DOWNTIME EVENT                                   */}
      {/* ================================================================== */}
      {downtimeModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <form onSubmit={submitDowntime} className="bg-white rounded border border-[#d9d9d9] w-full max-w-lg p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-[#e5e7eb] pb-2">
              <h4 className="text-sm font-bold text-[#222222]">ثبت توقف ماشین / ایستگاه کارگاه</h4>
              <button type="button" onClick={() => setDowntimeModalOpen(false)} className="text-[#666666] cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-2.5 text-xs">
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block font-semibold text-[#333333] mb-1">ماشین (الزامی)</label>
                  <select
                    required
                    value={dtMachineId}
                    onChange={e => setDtMachineId(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5"
                  >
                    {masterMachines.map(m => (
                      <option key={m.id} value={m.id}>{m.code} — {m.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-[#333333] mb-1">مدت توقف (دقیقه)</label>
                  <input
                    required
                    type="number"
                    min={1}
                    value={dtDurationMin}
                    onChange={e => setDtDurationMin(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5 font-mono"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block font-semibold text-[#333333] mb-1">شیفت</label>
                  <select
                    value={dtShiftId}
                    onChange={e => setDtShiftId(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5"
                  >
                    {masterShifts.map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-[#333333] mb-1">اپراتور</label>
                  <select
                    value={dtOperatorId}
                    onChange={e => setDtOperatorId(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5"
                  >
                    {masterOperators.map(o => (
                      <option key={o.id} value={o.id}>{o.fullName}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block font-semibold text-[#333333] mb-1">عملیات مرتبط (اختیاری)</label>
                <select
                  value={dtOpId}
                  onChange={e => setDtOpId(e.target.value)}
                  className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5"
                >
                  <option value="">توقف عمومی ماشین (بدون اتصال به OP خاص)</option>
                  {operationsQueue.map(op => (
                    <option key={op.id} value={op.id}>
                      {op.moNumber} — {op.stepCode} ({op.stepName})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-semibold text-[#333333] mb-1">علت توقف (الزامی)</label>
                <input
                  required
                  type="text"
                  value={dtReason}
                  onChange={e => setDtReason(e.target.value)}
                  className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5"
                  placeholder="علت توقف را وارد یا از گزینه‌های زیر انتخاب کنید..."
                />
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {DOWNTIME_PRESETS.map(p => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setDtReason(p)}
                      className="text-[11px] px-2 py-0.5 border border-[#d9d9d9] rounded bg-[#f7f7f7] hover:bg-[#eeeeee] cursor-pointer"
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block font-semibold text-[#333333] mb-1">توضیحات تکمیلی</label>
                <input
                  type="text"
                  value={dtNotes}
                  onChange={e => setDtNotes(e.target.value)}
                  className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5"
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer text-[#b91c1c] font-medium">
                <input
                  type="checkbox"
                  checked={dtMarkBreakdown}
                  onChange={e => setDtMarkBreakdown(e.target.checked)}
                />
                <span>تغییر وضعیت ماشین به خراب (BREAKDOWN)</span>
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-[#e5e7eb]">
              <button type="button" onClick={() => setDowntimeModalOpen(false)} className="sap-btn-standard px-3 py-1.5 text-xs cursor-pointer">
                انصراف
              </button>
              <button type="submit" disabled={submitting} className="px-3.5 py-1.5 rounded bg-[#e9730c] text-white text-xs font-semibold cursor-pointer">
                {submitting ? 'در حال ثبت...' : 'ثبت توقف ماشین'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL: LOAD MATERIAL / COIL INTO OPERATION */}
      {loadMatTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <form onSubmit={submitLoadMaterial} className="bg-white rounded border border-[#d9d9d9] shadow-xl w-full max-w-lg p-4 space-y-3 text-right">
            <div className="flex items-center justify-between border-b border-[#e5e7eb] pb-2">
              <h3 className="text-sm font-bold text-[#222222] flex items-center gap-1.5">
                <PackagePlus className="w-4 h-4 text-[#007cc0]" />
                <span>بارگذاری مواد / کلاف در {loadMatTarget.moNumber} — {loadMatTarget.stepCode}</span>
              </h3>
              <button type="button" onClick={() => setLoadMatTarget(null)} className="text-[#666666] hover:text-[#222222] cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="text-xs text-[#444444] bg-[#f7f9fb] border border-[#e5e7eb] rounded p-2.5 flex flex-wrap justify-between gap-2">
              <span>قطعه: <strong>{loadMatTarget.partName}</strong> ({loadMatTarget.partCode})</span>
              <span className="font-mono">برنامه: {formatNumber(loadMatTarget.plannedQty)} | موجودی فعلی ایستگاه: {formatNumber(loadMatTarget.availableStationQty)}</span>
            </div>
            <div className="space-y-2.5 text-xs">
              <div>
                <label className="block font-semibold text-[#333333] mb-1">منبع موجودی انبار / کلاف</label>
                <select
                  value={loadMatSourceId}
                  onChange={e => setLoadMatSourceId(e.target.value)}
                  className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5"
                >
                  {loadingSources ? (
                    <option value="">در حال بارگذاری منابع موجودی...</option>
                  ) : materialSources.length === 0 ? (
                    <option value="">بارگذاری مستقیم (بدون انتخاب کلاف خاص)</option>
                  ) : (
                    materialSources.map(src => (
                      <option key={src.id} value={src.id}>
                        {src.partCode} — {src.partName} | {src.warehouseCode}
                        {src.coilNumber ? ` | کلاف ${src.coilNumber}` : src.lotNumber ? ` | لات ${src.lotNumber}` : ''}
                        {' '}(موجود: {formatNumber(src.quantityAvailable)} / {formatNumber(src.weightKgAvailable)} kg)
                      </option>
                    ))
                  )}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block font-semibold text-[#333333] mb-1">تعداد بارگذاری به صف ایستگاه (عدد)</label>
                  <input
                    required
                    type="number"
                    min={1}
                    step="any"
                    value={loadMatQty}
                    onChange={e => setLoadMatQty(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-[#333333] mb-1">وزن حواله کلاف (kg - اختیاری)</label>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={loadMatWeightKg}
                    onChange={e => setLoadMatWeightKg(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5 font-mono"
                    placeholder="محاسبه خودکار"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block font-semibold text-[#333333] mb-1">اپراتور / تحویل‌گیرنده</label>
                  <select
                    value={loadMatOperatorId}
                    onChange={e => setLoadMatOperatorId(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5"
                  >
                    {masterOperators.map(o => (
                      <option key={o.id} value={o.id}>{o.fullName}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-[#333333] mb-1">توضیحات</label>
                  <input
                    type="text"
                    value={loadMatNotes}
                    onChange={e => setLoadMatNotes(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded px-2.5 py-1.5"
                    placeholder="شماره حواله یا یادداشت خط..."
                  />
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-[#e5e7eb]">
              <button type="button" onClick={() => setLoadMatTarget(null)} className="sap-btn-standard px-3 py-1.5 text-xs cursor-pointer">
                انصراف
              </button>
              <button type="submit" disabled={submitting} className="sap-btn-emphasized px-3.5 py-1.5 text-xs cursor-pointer">
                {submitting ? 'در حال ثبت...' : 'تأیید و بارگذاری در ایستگاه'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
