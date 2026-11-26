import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck,
  Check,
  X,
  FileText,
  Lock,
  Unlock,
  AlertTriangle,
  ClipboardCheck,
  RefreshCw,
  Wrench,
  Search,
  Download,
  BarChart3,
  Plus,
  History,
  CheckCircle2,
} from 'lucide-react';
import {
  DetailedStockBalance,
  Part,
  PhysicalCoil,
  StageInventorySummary,
  WarehouseDefinition,
} from '../../types/inventory';
import {
  DefectCodeDefinition,
  InspectionChecklistItem,
  NcrDispositionAction,
  NcrSourceType,
  NonconformanceCategory,
  NonconformanceRecord,
  NonconformanceSeverity,
  QualityDashboardAnalytics,
  QualityDecision,
  QualityEntityHistoryResponse,
  QualityInspectionRecord,
  QualityInspectionType,
  ReworkOrderRecord,
} from '../../types/quality';
import { formatDateTime, formatNumber, toPersianDigits } from '../../utils/formatters';
import { useEnterpriseUx } from '../../context/EnterpriseUxContext';

interface QualityUsageDecisionViewProps {
  parts: Part[];
  balances?: DetailedStockBalance[];
  stageBalances?: StageInventorySummary[];
  coils?: PhysicalCoil[];
  warehouses?: WarehouseDefinition[];
  currentUser?: { uid: string; displayName: string; role: string };
  onGlobalRefresh?: () => Promise<void>;
}

interface CatalogData {
  defectCodes: DefectCodeDefinition[];
  categoryLabels: Record<NonconformanceCategory, string>;
  inspectionTypeLabels: Record<QualityInspectionType, string>;
  checklists: Record<QualityInspectionType, InspectionChecklistItem[]>;
}

interface MoOption {
  id: string;
  moNumber: string;
  partId: string;
  partCode: string;
  partName: string;
  status: string;
  operations?: Array<{
    id?: string;
    operationId?: string;
    code?: string;
    operationCode?: string;
    name?: string;
    operationName?: string;
  }>;
}

type QualityTab = 'DASHBOARD' | 'INSPECTIONS' | 'NCR' | 'REWORK' | 'UD_AND_HISTORY';

const DECISION_LABELS_FA: Record<QualityDecision, string> = {
  PENDING: 'در انتظار تصمیم',
  ACCEPTED: 'تایید و ترخیص',
  ACCEPTED_WITH_CONCESSION: 'تایید ارفاقی',
  QUARANTINED: 'قرنطینه (QI)',
  REJECTED: 'رد کیفی / مسدود',
};

const NCR_STATUS_LABELS_FA: Record<string, string> = {
  OPEN: 'باز',
  CONTAINED: 'مهار شده (قرنطینه)',
  DISPOSITIONED: 'تعیین تکلیف شده',
  IN_REWORK: 'در حال دوباره‌کاری',
  CLOSED: 'بسته شده',
};

const SEVERITY_LABELS_FA: Record<NonconformanceSeverity, string> = {
  MINOR: 'جزئی',
  MAJOR: 'عمده',
  CRITICAL: 'بحرانی',
};

const DISPOSITION_LABELS_FA: Record<NcrDispositionAction, string> = {
  PENDING: 'در انتظار تعیین تکلیف',
  USE_AS_IS: 'مصرف ارفاقی (ترخیص ۳۲۱)',
  REWORK: 'دوباره‌کاری و بازگشت به خط',
  SCRAP: 'ضایعات و خروج از موجودی',
  RETURN_TO_SUPPLIER: 'مرجوع به تامین‌کننده',
  SORT_REINSPECT: 'جداسازی و بازرسی مجدد',
};

const QUALITY_STATUS_LABELS_FA: Record<string, string> = {
  AVAILABLE: 'آزاد و قابل مصرف',
  QUARANTINE: 'قرنطینه بازرسی (QI)',
  QUALITY_BLOCKED: 'مسدود / رد کیفی',
  BLOCKED: 'مسدود کیفی',
  REJECTED: 'رد شده',
  SCRAP: 'ضایعات',
  MIXED: 'ترکیبی (دارای بخش قرنطینه/مسدود)',
  UNKNOWN: 'ثبت نشده',
};

const REWORK_STATUS_LABELS_FA: Record<string, string> = {
  OPEN: 'باز',
  IN_PROGRESS: 'در حال انجام',
  COMPLETED: 'تکمیل شده',
  CANCELLED: 'لغو شده',
};

function buildSafeHeaders(
  currentUser?: { uid: string; displayName: string; role: string },
  idempotencyKey?: string
): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const role = currentUser?.role && /^[A-Z0-9_]+$/.test(currentUser.role) ? currentUser.role : 'QC_INSPECTOR';
  const uid = currentUser?.uid && /^[\x20-\x7E]+$/.test(currentUser.uid) ? currentUser.uid : 'USR-QC-01';
  headers['x-kpims-role'] = role;
  headers['x-user-id'] = uid;
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }
  return headers;
}

function decisionBadgeClass(decision: QualityDecision): string {
  switch (decision) {
    case 'ACCEPTED':
      return 'bg-[#ebf5ec] text-[#107e3e] border border-[#b7dfbf]';
    case 'ACCEPTED_WITH_CONCESSION':
      return 'bg-[#e5f3fa] text-[#007cc0] border border-[#b3ddf2]';
    case 'QUARANTINED':
      return 'bg-[#fff4e5] text-[#e9730c] border border-[#f5cba7]';
    case 'REJECTED':
      return 'bg-[#ffecec] text-[#bb0000] border border-[#f5b7b1]';
    default:
      return 'bg-[#f5f5f5] text-[#555555] border border-[#d9d9d9]';
  }
}

function severityBadgeClass(severity: NonconformanceSeverity): string {
  switch (severity) {
    case 'CRITICAL':
      return 'bg-[#ffecec] text-[#bb0000] border border-[#f5b7b1]';
    case 'MAJOR':
      return 'bg-[#fff4e5] text-[#e9730c] border border-[#f5cba7]';
    default:
      return 'bg-[#f5f5f5] text-[#555555] border border-[#d9d9d9]';
  }
}

function formatRate(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return '—';
  return `${toPersianDigits(val.toFixed(1))}٪`;
}

export const QualityUsageDecisionView: React.FC<QualityUsageDecisionViewProps> = ({
  parts,
  balances = [],
  stageBalances = [],
  coils = [],
  warehouses = [],
  currentUser,
  onGlobalRefresh,
}) => {
  const { recordAudit } = useEnterpriseUx();

  const [activeTab, setActiveTab] = useState<QualityTab>('DASHBOARD');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Catalog & Manufacturing Orders
  const [catalog, setCatalog] = useState<CatalogData | null>(null);
  const [manufacturingOrders, setManufacturingOrders] = useState<MoOption[]>([]);

  // Live P6 Data
  const [dashboard, setDashboard] = useState<QualityDashboardAnalytics | null>(null);
  const [inspections, setInspections] = useState<QualityInspectionRecord[]>([]);
  const [ncrs, setNcrs] = useState<NonconformanceRecord[]>([]);
  const [reworkOrders, setReworkOrders] = useState<ReworkOrderRecord[]>([]);

  // Dashboard filters
  const [dashTypeFilter, setDashTypeFilter] = useState<string>('ALL');
  const [dashSupplierFilter, setDashSupplierFilter] = useState<string>('');

  // Inspections Tab State
  const [showNewInspectionForm, setShowNewInspectionForm] = useState(false);
  const [inspTypeFilter, setInspTypeFilter] = useState<string>('ALL');
  const [inspDecisionFilter, setInspDecisionFilter] = useState<string>('ALL');
  const [inspSearch, setInspSearch] = useState<string>('');

  const [newInspType, setNewInspType] = useState<QualityInspectionType>('INCOMING_MATERIAL');
  const [newInspPartId, setNewInspPartId] = useState<string>('');
  const [newInspBalanceId, setNewInspBalanceId] = useState<string>('');
  const [newInspCoilId, setNewInspCoilId] = useState<string>('');
  const [newInspMoId, setNewInspMoId] = useState<string>('');
  const [newInspOpCode, setNewInspOpCode] = useState<string>('');
  const [newInspLotNumber, setNewInspLotNumber] = useState<string>('');
  const [newInspSupplier, setNewInspSupplier] = useState<string>('');
  const [newInspQty, setNewInspQty] = useState<string>('100');
  const [newInspChecklist, setNewInspChecklist] = useState<InspectionChecklistItem[]>([]);
  const [newInspQuarantineOnStart, setNewInspQuarantineOnStart] = useState<boolean>(false);
  const [newInspImmediateDecision, setNewInspImmediateDecision] = useState<QualityDecision | ''>('');
  const [newInspDefectCode, setNewInspDefectCode] = useState<string>('DEF-DIM');
  const [newInspNotes, setNewInspNotes] = useState<string>('');

  // Decide Inspection Drawer
  const [decidingInspection, setDecidingInspection] = useState<QualityInspectionRecord | null>(null);
  const [decideChoice, setDecideChoice] = useState<QualityDecision>('ACCEPTED');
  const [decideAcceptedQty, setDecideAcceptedQty] = useState<string>('0');
  const [decideReworkQty, setDecideReworkQty] = useState<string>('0');
  const [decideRejectedQty, setDecideRejectedQty] = useState<string>('0');
  const [decideDefectCode, setDecideDefectCode] = useState<string>('DEF-DIM');
  const [decideSeverity, setDecideSeverity] = useState<NonconformanceSeverity>('MAJOR');
  const [decideNotes, setDecideNotes] = useState<string>('');

  // NCR Tab State
  const [showNewNcrForm, setShowNewNcrForm] = useState(false);
  const [ncrStatusFilter, setNcrStatusFilter] = useState<string>('ALL');
  const [ncrSeverityFilter, setNcrSeverityFilter] = useState<string>('ALL');

  const [newNcrSource, setNewNcrSource] = useState<NcrSourceType>('IN_PROCESS');
  const [newNcrPartId, setNewNcrPartId] = useState<string>('');
  const [newNcrBalanceId, setNewNcrBalanceId] = useState<string>('');
  const [newNcrLotNumber, setNewNcrLotNumber] = useState<string>('');
  const [newNcrMoNumber, setNewNcrMoNumber] = useState<string>('');
  const [newNcrDefectCode, setNewNcrDefectCode] = useState<string>('DEF-CRACK');
  const [newNcrSeverity, setNewNcrSeverity] = useState<NonconformanceSeverity>('MAJOR');
  const [newNcrQty, setNewNcrQty] = useState<string>('10');
  const [newNcrDescription, setNewNcrDescription] = useState<string>('');
  const [newNcrContainNow, setNewNcrContainNow] = useState<boolean>(true);
  const [newNcrContainmentAction, setNewNcrContainmentAction] = useState<string>('جداسازی و انتقال به قرنطینه کیفی');

  // Contain / Disposition NCR inline panels
  const [containingNcr, setContainingNcr] = useState<NonconformanceRecord | null>(null);
  const [containActionText, setContainActionText] = useState<string>('قرنطینه فیزیکی در قفسه قرمز و برچسب‌گذاری عدم انطباق');
  const [containHoldType, setContainHoldType] = useState<'BLOCKED' | 'QUALITY_INSPECTION'>('BLOCKED');

  const [disposingNcr, setDisposingNcr] = useState<NonconformanceRecord | null>(null);
  const [dispAction, setDispAction] = useState<NcrDispositionAction>('REWORK');
  const [dispRootCause, setDispRootCause] = useState<string>('');
  const [dispCorrective, setDispCorrective] = useState<string>('');
  const [dispNotes, setDispNotes] = useState<string>('');
  const [dispReworkInstructions, setDispReworkInstructions] = useState<string>('');
  const [dispSortedGoodQty, setDispSortedGoodQty] = useState<string>('0');
  const [dispSortedDefectQty, setDispSortedDefectQty] = useState<string>('0');

  // Rework Tab State
  const [completingRework, setCompletingRework] = useState<ReworkOrderRecord | null>(null);
  const [reworkGoodQty, setReworkGoodQty] = useState<string>('0');
  const [reworkScrapQty, setReworkScrapQty] = useState<string>('0');
  const [reworkReturnToProd, setReworkReturnToProd] = useState<boolean>(true);
  const [reworkNotes, setReworkNotes] = useState<string>('');

  // History & Traceability Tab State
  const [historyLot, setHistoryLot] = useState<string>('');
  const [historyCoil, setHistoryCoil] = useState<string>('');
  const [historyMo, setHistoryMo] = useState<string>('');
  const [historyPartCode, setHistoryPartCode] = useState<string>('');
  const [historyData, setHistoryData] = useState<QualityEntityHistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Preserved QM-UD Quick Workbench State
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [inspectionNotes, setInspectionNotes] = useState('');
  const [cmmPassed, setCmmPassed] = useState(true);
  const [visualPassed, setVisualPassed] = useState(true);
  const [burrPassed, setBurrPassed] = useState(true);

  const actorPayload = useMemo(
    () => ({
      uid: currentUser?.uid || 'USR-QC-01',
      displayName: currentUser?.displayName || 'بازرس کنترل کیفیت (QM)',
    }),
    [currentUser]
  );

  const loadQualityData = useCallback(async () => {
    setLoading(true);
    try {
      const dashParams = new URLSearchParams();
      if (dashTypeFilter && dashTypeFilter !== 'ALL') dashParams.set('inspectionType', dashTypeFilter);
      if (dashSupplierFilter.trim()) dashParams.set('supplierName', dashSupplierFilter.trim());

      const [catRes, dashRes, inspRes, ncrRes, rewRes, moRes] = await Promise.all([
        fetch('/api/quality/catalog'),
        fetch(`/api/quality/dashboard?${dashParams.toString()}`),
        fetch('/api/quality/inspections'),
        fetch('/api/quality/ncrs'),
        fetch('/api/quality/rework-orders'),
        fetch('/api/wip/manufacturing-orders'),
      ]);

      const [catJson, dashJson, inspJson, ncrJson, rewJson, moJson] = await Promise.all([
        catRes.json().catch(() => null),
        dashRes.json().catch(() => null),
        inspRes.json().catch(() => null),
        ncrRes.json().catch(() => null),
        rewRes.json().catch(() => null),
        moRes.json().catch(() => null),
      ]);

      if (catJson?.success && catJson.data) {
        setCatalog(catJson.data);
      }
      if (dashJson?.success && dashJson.data) {
        setDashboard(dashJson.data);
      }
      if (inspJson?.success && Array.isArray(inspJson.data)) {
        setInspections(inspJson.data);
      }
      if (ncrJson?.success && Array.isArray(ncrJson.data)) {
        setNcrs(ncrJson.data);
      }
      if (rewJson?.success && Array.isArray(rewJson.data)) {
        setReworkOrders(rewJson.data);
      }
      if (moJson?.success && Array.isArray(moJson.data)) {
        setManufacturingOrders(moJson.data);
      }
    } catch (err) {
      setToast({
        type: 'error',
        text: err instanceof Error ? err.message : 'خطا در بارگذاری اطلاعات کنترل کیفیت',
      });
    } finally {
      setLoading(false);
    }
  }, [dashTypeFilter, dashSupplierFilter]);

  useEffect(() => {
    loadQualityData();
  }, [loadQualityData]);

  // Keep checklist synced when inspection type or catalog changes
  useEffect(() => {
    if (catalog?.checklists?.[newInspType]) {
      setNewInspChecklist(catalog.checklists[newInspType].map(item => ({ ...item })));
    }
  }, [catalog, newInspType]);

  // Default first part when available
  useEffect(() => {
    if (!newInspPartId && parts.length > 0) setNewInspPartId(parts[0].id);
    if (!newNcrPartId && parts.length > 0) setNewNcrPartId(parts[0].id);
  }, [parts, newInspPartId, newNcrPartId]);

  const loadHistory = useCallback(
    async (overrides?: { lotNumber?: string; coilId?: string; moNumber?: string; partCode?: string }) => {
      const lot = overrides?.lotNumber ?? historyLot;
      const coil = overrides?.coilId ?? historyCoil;
      const mo = overrides?.moNumber ?? historyMo;
      const partCode = overrides?.partCode ?? historyPartCode;
      if (!lot.trim() && !coil.trim() && !mo.trim() && !partCode.trim()) {
        setToast({ type: 'error', text: 'حداقل یکی از فیلدهای شماره بچ، کلاف، دستور کار یا کد قطعه را وارد کنید.' });
        return;
      }
      setHistoryLoading(true);
      try {
        const params = new URLSearchParams();
        if (lot.trim()) params.set('lotNumber', lot.trim());
        if (coil.trim()) params.set('coilId', coil.trim());
        if (mo.trim()) params.set('moNumber', mo.trim());
        if (partCode.trim()) params.set('partCode', partCode.trim());
        const res = await fetch(`/api/quality/history?${params.toString()}`);
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.success) {
          throw new Error(json?.error || 'خطا در بازیابی تاریخچه کیفی');
        }
        setHistoryData(json.data);
      } catch (err) {
        setToast({ type: 'error', text: err instanceof Error ? err.message : 'خطا در دریافت تاریخچه کیفی' });
      } finally {
        setHistoryLoading(false);
      }
    },
    [historyLot, historyCoil, historyMo, historyPartCode]
  );

  const jumpToHistory = (filters: { lotNumber?: string; coilId?: string; moNumber?: string; partCode?: string }) => {
    setHistoryLot(filters.lotNumber || '');
    setHistoryCoil(filters.coilId || '');
    setHistoryMo(filters.moNumber || '');
    setHistoryPartCode(filters.partCode || '');
    setActiveTab('UD_AND_HISTORY');
    void loadHistory(filters);
  };

  const handleExportCsv = async () => {
    try {
      const params = new URLSearchParams({ format: 'csv' });
      if (dashTypeFilter && dashTypeFilter !== 'ALL') params.set('inspectionType', dashTypeFilter);
      if (dashSupplierFilter.trim()) params.set('supplierName', dashSupplierFilter.trim());
      const res = await fetch(`/api/quality/dashboard?${params.toString()}`);
      if (!res.ok) throw new Error('خطا در تولید فایل CSV گزارش کیفیت');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `kpims-quality-report-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      setToast({ type: 'error', text: err instanceof Error ? err.message : 'خطا در خروجی CSV' });
    }
  };

  // Create Quality Inspection
  const handleCreateInspection = async (e: React.FormEvent) => {
    e.preventDefault();
    const qtyNum = Number(newInspQty);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      setToast({ type: 'error', text: 'مقدار مورد بازرسی باید بزرگتر از صفر باشد.' });
      return;
    }
    if (newInspType === 'IN_PROCESS' && !newInspMoId) {
      setToast({ type: 'error', text: 'برای بازرسی حین فرآیند (IPQC)، انتخاب دستور ساخت (MO) الزامی است.' });
      return;
    }

    setLoading(true);
    setToast(null);
    try {
      const selectedMo = manufacturingOrders.find(m => m.id === newInspMoId);
      const selectedBal = balances.find(b => b.id === newInspBalanceId);
      const selectedCoil = coils.find(c => c.id === newInspCoilId);
      const selectedOp = selectedMo?.operations?.find(
        op => (op.operationCode || op.code) === newInspOpCode
      );
      const idemKey = `QC-INSP-${newInspType}-${newInspPartId}-${qtyNum}-${Date.now()}`;

      const payload: Record<string, unknown> = {
        inspectionType: newInspType,
        partId: selectedMo?.partId || selectedCoil?.partId || selectedBal?.partId || newInspPartId,
        balanceId: selectedBal?.id || undefined,
        warehouseId: selectedBal?.warehouseId || selectedCoil?.warehouseId || warehouses[0]?.id,
        locationCode: selectedBal?.locationCode || selectedCoil?.warehouseLocationCode,
        physicalCoilId: selectedCoil?.id || undefined,
        coilId: selectedCoil?.coilId || undefined,
        lotNumber: newInspLotNumber.trim() || selectedBal?.lotNumber || selectedCoil?.coilPackNumber || undefined,
        manufacturingOrderId: selectedMo?.id || undefined,
        moNumber: selectedMo?.moNumber || undefined,
        operationId: selectedOp?.operationId || selectedOp?.id || undefined,
        operationCode: newInspOpCode || undefined,
        operationName: selectedOp?.operationName || selectedOp?.name || undefined,
        supplierName: newInspSupplier.trim() || selectedCoil?.supplierName || undefined,
        inspectedQty: qtyNum,
        checklist: newInspChecklist,
        quarantineOnStart: newInspQuarantineOnStart,
        notes: newInspNotes.trim() || undefined,
        user: actorPayload,
      };

      if (newInspImmediateDecision) {
        payload.decision = newInspImmediateDecision;
        if (newInspImmediateDecision === 'REJECTED' || newInspImmediateDecision === 'QUARANTINED') {
          payload.defectCodes = [newInspDefectCode];
        }
      }

      const res = await fetch('/api/quality/inspections', {
        method: 'POST',
        headers: buildSafeHeaders(currentUser, idemKey),
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || 'خطا در ثبت برگه بازرسی کیفی');
      }

      recordAudit({
        moduleName: 'کنترل کیفیت (KPIMS QM)',
        actionType: 'CREATE',
        entityId: json.data?.id || '',
        entityCode: json.data?.inspectionNumber || '',
        title: `ثبت برگه بازرسی ${json.data?.inspectionNumber || ''}`,
        details: json.message || 'برگه بازرسی کیفی ثبت شد.',
      });

      setToast({ type: 'success', text: json.message || 'برگه بازرسی کیفی با موفقیت ثبت شد.' });
      setShowNewInspectionForm(false);
      setNewInspNotes('');
      setNewInspImmediateDecision('');
      setNewInspQuarantineOnStart(false);
      await loadQualityData();
      if (onGlobalRefresh) await onGlobalRefresh();
    } catch (err) {
      setToast({ type: 'error', text: err instanceof Error ? err.message : 'خطا در ثبت بازرسی' });
    } finally {
      setLoading(false);
    }
  };

  // Decide Inspection
  const openDecidePanel = (insp: QualityInspectionRecord) => {
    setDecidingInspection(insp);
    setDecideChoice('ACCEPTED');
    setDecideAcceptedQty(String(insp.inspectedQty));
    setDecideReworkQty('0');
    setDecideRejectedQty('0');
    setDecideDefectCode(insp.defectCodes?.[0] || 'DEF-DIM');
    setDecideSeverity('MAJOR');
    setDecideNotes('');
  };

  const handleDecideInspection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!decidingInspection) return;
    setLoading(true);
    setToast(null);
    try {
      const idemKey = `QC-DEC-${decidingInspection.id}-${decideChoice}-${Date.now()}`;
      const acc = Number(decideAcceptedQty || 0);
      const rew = Number(decideReworkQty || 0);
      const rej = Number(decideRejectedQty || 0);
      const hasDefects = decideChoice === 'REJECTED' || decideChoice === 'QUARANTINED' || rej > 0 || rew > 0;

      const res = await fetch(`/api/quality/inspections/${encodeURIComponent(decidingInspection.id)}/decide`, {
        method: 'POST',
        headers: buildSafeHeaders(currentUser, idemKey),
        body: JSON.stringify({
          decision: decideChoice,
          acceptedQty: acc,
          reworkQty: rew,
          rejectedQty: rej,
          defectCodes: hasDefects ? [decideDefectCode] : [],
          severity: decideSeverity,
          notes: decideNotes.trim() || undefined,
          autoCreateNcr: hasDefects,
          user: actorPayload,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || 'خطا در ثبت تصمیم بازرسی');
      }

      setToast({
        type: 'success',
        text: json.ncr
          ? `${json.message} — گزارش عدم انطباق «${json.ncr.ncrNumber}» به صورت خودکار ایجاد شد.`
          : json.message || 'تصمیم بازرسی با موفقیت ثبت شد.',
      });
      setDecidingInspection(null);
      await loadQualityData();
      if (onGlobalRefresh) await onGlobalRefresh();
    } catch (err) {
      setToast({ type: 'error', text: err instanceof Error ? err.message : 'خطا در ثبت تصمیم کیفی' });
    } finally {
      setLoading(false);
    }
  };

  // Create Manual NCR
  const handleCreateNcr = async (e: React.FormEvent) => {
    e.preventDefault();
    const qtyNum = Number(newNcrQty);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      setToast({ type: 'error', text: 'مقدار نامنطبق باید بزرگتر از صفر باشد.' });
      return;
    }
    if (newNcrDescription.trim().length < 5) {
      setToast({ type: 'error', text: 'شرح عدم انطباق باید حداقل ۵ کاراکتر باشد.' });
      return;
    }
    setLoading(true);
    setToast(null);
    try {
      const selectedBal = balances.find(b => b.id === newNcrBalanceId);
      const idemKey = `QC-NCR-${newNcrPartId}-${qtyNum}-${Date.now()}`;
      const res = await fetch('/api/quality/ncrs', {
        method: 'POST',
        headers: buildSafeHeaders(currentUser, idemKey),
        body: JSON.stringify({
          sourceType: newNcrSource,
          partId: selectedBal?.partId || newNcrPartId,
          balanceId: selectedBal?.id || undefined,
          warehouseId: selectedBal?.warehouseId || warehouses[0]?.id,
          lotNumber: newNcrLotNumber.trim() || selectedBal?.lotNumber || undefined,
          moNumber: newNcrMoNumber.trim() || undefined,
          defectCode: newNcrDefectCode,
          severity: newNcrSeverity,
          affectedQty: qtyNum,
          description: newNcrDescription.trim(),
          containImmediately: newNcrContainNow,
          containmentAction: newNcrContainNow ? newNcrContainmentAction.trim() : undefined,
          user: actorPayload,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || 'خطا در ثبت گزارش عدم انطباق (NCR)');
      }

      setToast({ type: 'success', text: json.message || 'گزارش عدم انطباق با موفقیت ثبت شد.' });
      setShowNewNcrForm(false);
      setNewNcrDescription('');
      await loadQualityData();
      if (onGlobalRefresh) await onGlobalRefresh();
    } catch (err) {
      setToast({ type: 'error', text: err instanceof Error ? err.message : 'خطا در ثبت NCR' });
    } finally {
      setLoading(false);
    }
  };

  // Contain NCR
  const handleContainNcr = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!containingNcr) return;
    setLoading(true);
    setToast(null);
    try {
      const idemKey = `QC-CONTAIN-${containingNcr.id}-${Date.now()}`;
      const res = await fetch(`/api/quality/ncrs/${encodeURIComponent(containingNcr.id)}/contain`, {
        method: 'POST',
        headers: buildSafeHeaders(currentUser, idemKey),
        body: JSON.stringify({
          containmentAction: containActionText.trim(),
          holdType: containHoldType,
          user: actorPayload,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || 'خطا در اجرای مهار فوری عدم انطباق');
      }
      setToast({ type: 'success', text: json.message || 'مهار فوری انجام و موجودی قفل شد.' });
      setContainingNcr(null);
      await loadQualityData();
      if (onGlobalRefresh) await onGlobalRefresh();
    } catch (err) {
      setToast({ type: 'error', text: err instanceof Error ? err.message : 'خطا در مهار NCR' });
    } finally {
      setLoading(false);
    }
  };

  // Disposition NCR
  const openDispositionPanel = (ncr: NonconformanceRecord) => {
    setDisposingNcr(ncr);
    setDispAction('REWORK');
    setDispRootCause(ncr.rootCause || '');
    setDispCorrective(ncr.correctiveAction || '');
    setDispNotes('');
    setDispReworkInstructions(`بازکاری و رفع عیب «${ncr.defectLabelFa}» و بازرسی مجدد`);
    setDispSortedGoodQty(String(Math.floor(ncr.affectedQty / 2)));
    setDispSortedDefectQty(String(ncr.affectedQty - Math.floor(ncr.affectedQty / 2)));
  };

  const handleDispositionNcr = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!disposingNcr) return;
    setLoading(true);
    setToast(null);
    try {
      const idemKey = `QC-DISP-${disposingNcr.id}-${dispAction}-${Date.now()}`;
      const res = await fetch(`/api/quality/ncrs/${encodeURIComponent(disposingNcr.id)}/disposition`, {
        method: 'POST',
        headers: buildSafeHeaders(currentUser, idemKey),
        body: JSON.stringify({
          disposition: dispAction,
          rootCause: dispRootCause.trim() || undefined,
          correctiveAction: dispCorrective.trim() || undefined,
          dispositionNotes: dispNotes.trim() || undefined,
          reworkInstructions: dispAction === 'REWORK' ? dispReworkInstructions.trim() : undefined,
          sortedGoodQty: dispAction === 'SORT_REINSPECT' ? Number(dispSortedGoodQty || 0) : undefined,
          sortedDefectQty: dispAction === 'SORT_REINSPECT' ? Number(dispSortedDefectQty || 0) : undefined,
          returnToProduction: true,
          user: actorPayload,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || 'خطا در ثبت تعیین تکلیف عدم انطباق');
      }
      setToast({
        type: 'success',
        text: json.reworkOrder
          ? `${json.message} — دستور دوباره‌کاری «${json.reworkOrder.reworkNumber}» ایجاد شد.`
          : json.message || 'تعیین تکلیف عدم انطباق ثبت شد.',
      });
      setDisposingNcr(null);
      await loadQualityData();
      if (onGlobalRefresh) await onGlobalRefresh();
    } catch (err) {
      setToast({ type: 'error', text: err instanceof Error ? err.message : 'خطا در تعیین تکلیف NCR' });
    } finally {
      setLoading(false);
    }
  };

  // Complete Rework Order
  const openCompleteRework = (rew: ReworkOrderRecord) => {
    setCompletingRework(rew);
    setReworkGoodQty(String(rew.remainingQty));
    setReworkScrapQty('0');
    setReworkReturnToProd(rew.returnToProduction);
    setReworkNotes('');
  };

  const handleCompleteRework = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!completingRework) return;
    setLoading(true);
    setToast(null);
    try {
      const idemKey = `QC-REW-${completingRework.id}-${reworkGoodQty}-${reworkScrapQty}-${Date.now()}`;
      const res = await fetch(`/api/quality/rework-orders/${encodeURIComponent(completingRework.id)}/complete`, {
        method: 'POST',
        headers: buildSafeHeaders(currentUser, idemKey),
        body: JSON.stringify({
          goodQty: Number(reworkGoodQty || 0),
          scrapQty: Number(reworkScrapQty || 0),
          returnToProduction: reworkReturnToProd,
          completionNotes: reworkNotes.trim() || undefined,
          user: actorPayload,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || 'خطا در ثبت نتیجه دوباره‌کاری');
      }
      setToast({ type: 'success', text: json.message || 'نتیجه دوباره‌کاری ثبت و موجودی به‌روزرسانی شد.' });
      setCompletingRework(null);
      await loadQualityData();
      if (onGlobalRefresh) await onGlobalRefresh();
    } catch (err) {
      setToast({ type: 'error', text: err instanceof Error ? err.message : 'خطا در تکمیل دوباره‌کاری' });
    } finally {
      setLoading(false);
    }
  };

  // Preserved QM-UD Quick Workbench logic
  const quarantineItems = useMemo(() => {
    return parts
      .map(p => {
        const detailedMatch =
          balances.find(
            b =>
              (b.partId === p.id || b.partCode === p.code) &&
              Number(b.qualityInspectionQty || 0) + Number(b.blockedQty || 0) > 0
          ) ||
          balances.find(
            b => (b.partId === p.id || b.partCode === p.code) && Number(b.availableQty || 0) > 0
          );
        const matchingStage = stageBalances.find(
          sb => sb.partId === p.id || (sb as { partCode?: string }).partCode === p.code
        ) as { qualityInspectionQty?: number; qualityInspectionKg?: number; lotNumber?: string } | undefined;
        const qiHeldQty = Number(
          (detailedMatch ? detailedMatch.qualityInspectionQty + detailedMatch.blockedQty : 0) ||
            matchingStage?.qualityInspectionQty ||
            matchingStage?.qualityInspectionKg ||
            0
        );
        const availableForHoldQty = Number(detailedMatch?.availableQty || 0);
        const qiQty = qiHeldQty > 0 ? qiHeldQty : availableForHoldQty;
        return {
          ...p,
          qiQty,
          hasHeldStock: qiHeldQty > 0,
          balanceId: detailedMatch?.id,
          warehouseId: detailedMatch?.warehouseId,
          locationCode: detailedMatch?.locationCode,
          ownership: detailedMatch?.ownership,
          contractId: detailedMatch?.contractId,
          lotNumber: detailedMatch?.lotNumber || matchingStage?.lotNumber || `LOT-QI-${p.code}`,
        };
      })
      .filter(p => p.qiQty > 0);
  }, [parts, balances, stageBalances]);

  const selectedPart = quarantineItems.find(p => p.id === selectedPartId) || quarantineItems[0];

  const handleUsageDecision = async (decision: 'RELEASE_AVAILABLE' | 'BLOCK_SCRAP') => {
    if (!selectedPart) return;
    setLoading(true);
    setToast(null);
    try {
      const movementCode =
        decision === 'RELEASE_AVAILABLE' ? '321' : selectedPart.hasHeldStock ? '344' : '322';
      const idempotencyKey = `QM-UD-${selectedPart.balanceId || selectedPart.id}-${movementCode}-${selectedPart.qiQty}-${Date.now()}`;
      const reasonFa = `تصمیم کیفی سریع (QM-UD) - ${
        decision === 'RELEASE_AVAILABLE'
          ? 'ترخیص به آزاد (کد ۳۲۱)'
          : `انتقال به مسدود/قرنطینه (کد ${movementCode})`
      }. CMM: ${cmmPassed ? 'قبول' : 'رد'}، چشمی: ${visualPassed ? 'قبول' : 'رد'}، پلیسه: ${
        burrPassed ? 'قبول' : 'رد'
      }. ${inspectionNotes ? `توضیحات: ${inspectionNotes}` : ''}`.trim();

      const res = await fetch('/api/inventory/qm-transfer', {
        method: 'POST',
        headers: buildSafeHeaders(currentUser, idempotencyKey),
        body: JSON.stringify({
          key: selectedPart.balanceId,
          balanceId: selectedPart.balanceId,
          partId: selectedPart.id,
          partCode: selectedPart.code,
          warehouseId: selectedPart.warehouseId,
          locationCode: selectedPart.locationCode,
          lotNumber: selectedPart.balanceId ? selectedPart.lotNumber : undefined,
          ownership: selectedPart.ownership,
          contractId: selectedPart.contractId,
          movementType: movementCode,
          quantity: selectedPart.qiQty,
          reasonFa,
          idempotencyKey,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || 'خطا در ثبت تصمیم کیفی در سرور');
      }

      recordAudit({
        moduleName: 'کنترل کیفیت (SAP QM - UD)',
        actionType: 'UPDATE',
        entityId: selectedPart.id,
        entityCode: selectedPart.code,
        title: `صدور تصمیم کیفی (UD) برای قطعه ${selectedPart.code}`,
        details: `قطعه «${selectedPart.name}» به تعداد ${selectedPart.qiQty} ${selectedPart.unit} با سند حرکت ${movementCode} تعیین تکلیف شد.`,
      });

      setToast({
        type: 'success',
        text:
          decision === 'RELEASE_AVAILABLE'
            ? `قطعه «${selectedPart.name}» با موفقیت ترخیص و به موجودی آزاد منتقل شد (کد ۳۲۱).`
            : `قطعه «${selectedPart.name}» به قرنطینه/مسدود کیفی منتقل شد (کد ${movementCode}).`,
      });
      await loadQualityData();
      if (onGlobalRefresh) await onGlobalRefresh();
    } catch (err) {
      setToast({ type: 'error', text: err instanceof Error ? err.message : 'خطای ارتباط با سرور کنترل کیفیت' });
    } finally {
      setLoading(false);
    }
  };

  // Filtered lists
  const filteredInspections = useMemo(() => {
    return inspections.filter(i => {
      if (inspTypeFilter !== 'ALL' && i.inspectionType !== inspTypeFilter) return false;
      if (inspDecisionFilter !== 'ALL' && i.decision !== inspDecisionFilter) return false;
      if (inspSearch.trim()) {
        const q = inspSearch.trim().toLowerCase();
        return (
          i.inspectionNumber.toLowerCase().includes(q) ||
          i.partCode.toLowerCase().includes(q) ||
          i.partName.toLowerCase().includes(q) ||
          (i.lotNumber || '').toLowerCase().includes(q) ||
          (i.coilId || '').toLowerCase().includes(q) ||
          (i.moNumber || '').toLowerCase().includes(q) ||
          (i.supplierName || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [inspections, inspTypeFilter, inspDecisionFilter, inspSearch]);

  const filteredNcrs = useMemo(() => {
    return ncrs.filter(n => {
      if (ncrStatusFilter === 'ACTIVE' && n.status === 'CLOSED') return false;
      if (ncrStatusFilter !== 'ALL' && ncrStatusFilter !== 'ACTIVE' && n.status !== ncrStatusFilter) return false;
      if (ncrSeverityFilter !== 'ALL' && n.severity !== ncrSeverityFilter) return false;
      return true;
    });
  }, [ncrs, ncrStatusFilter, ncrSeverityFilter]);

  const selectedMoForNewInsp = manufacturingOrders.find(m => m.id === newInspMoId);
  const defectOptions = catalog?.defectCodes || [];

  return (
    <div className="space-y-4">
      {/* Header Bar & P6 Quality Sub-Navigation */}
      <div className="sap-card p-4 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-[#007cc0]" />
            <h2 className="text-base font-bold text-[#333333]">
              مدیریت کیفیت و کنترل محصول (KPIMS QM — بازرسی، NCR، دوباره‌کاری و ردیابی)
            </h2>
          </div>
          <p className="text-xs text-[#666666] mt-1">
            بازرسی ورودی (IQC)، حین فرآیند (IPQC) و نهایی (FQC)، ثبت و مهار عدم انطباق، دوباره‌کاری، مسدودسازی خودکار مصرف و گزارش تامین‌کنندگان
          </p>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {(
            [
              { id: 'DASHBOARD', label: '۱. پیشخوان و گزارش کیفیت', icon: BarChart3 },
              { id: 'INSPECTIONS', label: `۲. بازرسی‌ها (${toPersianDigits(inspections.length)})`, icon: ClipboardCheck },
              {
                id: 'NCR',
                label: `۳. عدم انطباق NCR (${toPersianDigits(ncrs.filter(n => n.status !== 'CLOSED').length)})`,
                icon: AlertTriangle,
              },
              {
                id: 'REWORK',
                label: `۴. دوباره‌کاری (${toPersianDigits(reworkOrders.filter(r => r.status !== 'COMPLETED' && r.status !== 'CANCELLED').length)})`,
                icon: Wrench,
              },
              { id: 'UD_AND_HISTORY', label: '۵. ترخیص سریع و ردیابی کیفی', icon: History },
            ] as const
          ).map(tab => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-1.5 rounded text-xs font-semibold cursor-pointer transition flex items-center gap-1.5 ${
                  active
                    ? 'bg-[#007cc0] text-white'
                    : 'bg-[#f5f5f5] text-[#333333] hover:bg-[#e5f3fa]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => loadQualityData()}
            disabled={loading}
            className="px-2.5 py-1.5 rounded text-xs font-semibold bg-white border border-[#cccccc] text-[#333333] hover:bg-[#f5f5f5] cursor-pointer flex items-center gap-1"
            title="به‌روزرسانی داده‌های کنترل کیفیت"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>به‌روزرسانی</span>
          </button>
        </div>
      </div>

      {/* Toast Notification */}
      {toast && (
        <div
          className={`p-3 rounded border flex items-center justify-between text-xs ${
            toast.type === 'success'
              ? 'bg-[#ebf5ec] border-[#b7dfbf] text-[#107e3e]'
              : 'bg-[#ffecec] border-[#f5b7b1] text-[#bb0000]'
          }`}
        >
          <span className="font-medium">{toast.text}</span>
          <button type="button" onClick={() => setToast(null)} className="cursor-pointer px-2 font-bold">
            ×
          </button>
        </div>
      )}

      {/* ================================================================= */}
      {/* TAB 1: QUALITY DASHBOARD, DEFECT PARETO & SUPPLIER PERFORMANCE    */}
      {/* ================================================================= */}
      {activeTab === 'DASHBOARD' && (
        <div className="space-y-4">
          {/* Filters & Export Bar */}
          <div className="sap-card p-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <label className="text-[#666666] font-medium">مرحله بازرسی:</label>
              <select
                value={dashTypeFilter}
                onChange={e => setDashTypeFilter(e.target.value)}
                className="border border-[#cccccc] rounded px-2 py-1 text-xs bg-white text-[#333333]"
              >
                <option value="ALL">همه مراحل (ورودی، حین فرآیند، نهایی)</option>
                <option value="INCOMING_MATERIAL">بازرسی ورودی مواد و کلاف (IQC)</option>
                <option value="IN_PROCESS">بازرسی حین فرآیند (IPQC)</option>
                <option value="FINAL_PRODUCT">بازرسی محصول نهایی (FQC)</option>
              </select>

              <label className="text-[#666666] font-medium mr-2">تامین‌کننده:</label>
              <input
                type="text"
                value={dashSupplierFilter}
                onChange={e => setDashSupplierFilter(e.target.value)}
                placeholder="فیلتر نام تامین‌کننده..."
                className="border border-[#cccccc] rounded px-2.5 py-1 text-xs bg-white text-[#333333] w-44"
              />
            </div>

            <button
              type="button"
              onClick={handleExportCsv}
              className="px-3 py-1.5 rounded text-xs font-semibold bg-[#107e3e] text-white hover:bg-[#0d6933] cursor-pointer flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5" />
              <span>خروجی گزارش کیفیت (CSV)</span>
            </button>
          </div>

          {dashboard?.summary.dataQualityNoteFa && (
            <div className="p-3 rounded bg-[#fff4e5] border border-[#f5cba7] text-xs text-[#9c4c00]">
              {dashboard.summary.dataQualityNoteFa}
            </div>
          )}

          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="sap-card p-3.5 space-y-1">
              <div className="text-xs text-[#666666]">کل بازرسی‌های ثبت‌شده</div>
              <div className="text-xl font-bold text-[#007cc0] font-mono">
                {toPersianDigits(dashboard?.summary.totalInspections ?? 0)}
              </div>
              <div className="text-[11px] text-[#666666]">
                تکمیل‌شده: {toPersianDigits(dashboard?.summary.completedInspections ?? 0)} | در انتظار:{' '}
                {toPersianDigits(dashboard?.summary.pendingInspections ?? 0)}
              </div>
            </div>

            <div className="sap-card p-3.5 space-y-1">
              <div className="text-xs text-[#666666]">نرخ رد کیفی کل</div>
              <div className="text-xl font-bold text-[#bb0000] font-mono">
                {formatRate(dashboard?.summary.overallRejectionRatePercent)}
              </div>
              <div className="text-[11px] text-[#666666]">
                قبولی ورودی: {formatRate(dashboard?.summary.incomingAcceptanceRatePercent)} | نهایی:{' '}
                {formatRate(dashboard?.summary.finalPassRatePercent)}
              </div>
            </div>

            <div className="sap-card p-3.5 space-y-1">
              <div className="text-xs text-[#666666]">عدم انطباق‌های باز (NCR)</div>
              <div className="text-xl font-bold text-[#e9730c] font-mono">
                {toPersianDigits(dashboard?.summary.openNcrCount ?? 0)}
              </div>
              <div className="text-[11px] text-[#bb0000]">
                بحرانی باز: {toPersianDigits(dashboard?.summary.criticalOpenNcrCount ?? 0)} از کل{' '}
                {toPersianDigits(dashboard?.summary.totalNcrCount ?? 0)}
              </div>
            </div>

            <div className="sap-card p-3.5 space-y-1">
              <div className="text-xs text-[#666666]">موجودی قفل‌شده در انبار (غیرقابل مصرف)</div>
              <div className="text-xl font-bold text-[#333333] font-mono">
                {formatNumber((dashboard?.summary.quarantinedStockQty ?? 0) + (dashboard?.summary.blockedStockQty ?? 0))}
              </div>
              <div className="text-[11px] text-[#666666]">
                قرنطینه QI: {formatNumber(dashboard?.summary.quarantinedStockQty ?? 0)} | مسدود:{' '}
                {formatNumber(dashboard?.summary.blockedStockQty ?? 0)} | دوباره‌کاری فعال:{' '}
                {toPersianDigits(dashboard?.summary.activeReworkOrdersCount ?? 0)}
              </div>
            </div>
          </div>

          {/* Stage Performance & Defect Pareto */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="sap-card p-4 space-y-3">
              <h3 className="text-sm font-bold text-[#333333]">عملکرد کیفیت به تفکیک مرحله بازرسی</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-[#f5f5f5] border-b border-[#d9d9d9] text-[#555555]">
                      <th className="p-2 text-right">مرحله بازرسی</th>
                      <th className="p-2 text-center">تعداد</th>
                      <th className="p-2 text-center">تایید</th>
                      <th className="p-2 text-center">رد</th>
                      <th className="p-2 text-center">مقدار ردشده</th>
                      <th className="p-2 text-center">نرخ قبولی</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(dashboard?.byInspectionType || []).map(row => (
                      <tr key={row.inspectionType} className="border-b border-[#eeeeee]">
                        <td className="p-2 font-medium text-[#333333]">{row.labelFa}</td>
                        <td className="p-2 text-center font-mono">{toPersianDigits(row.totalCount)}</td>
                        <td className="p-2 text-center font-mono text-[#107e3e]">{toPersianDigits(row.acceptedCount)}</td>
                        <td className="p-2 text-center font-mono text-[#bb0000]">{toPersianDigits(row.rejectedCount)}</td>
                        <td className="p-2 text-center font-mono">{formatNumber(row.rejectedQty)}</td>
                        <td className="p-2 text-center font-mono font-bold">{formatRate(row.passRatePercent)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="sap-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-[#333333]">پارتوی عیوب و ایرادات تکرارشونده (Defect Pareto)</h3>
                <span className="text-[11px] text-[#bb0000] font-semibold">
                  تکرارشونده: {toPersianDigits(dashboard?.recurringIssues.length ?? 0)} مورد
                </span>
              </div>
              {!dashboard || dashboard.defectPareto.length === 0 ? (
                <div className="py-8 text-center text-xs text-[#666666]">
                  هنوز عیب یا عدم انطباقی ثبت نشده است.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="bg-[#f5f5f5] border-b border-[#d9d9d9] text-[#555555]">
                        <th className="p-2 text-right">کد و شرح عیب</th>
                        <th className="p-2 text-center">تکرار</th>
                        <th className="p-2 text-center">مقدار</th>
                        <th className="p-2 text-center">سهم</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dashboard.defectPareto.map(row => (
                        <tr key={row.defectCode} className="border-b border-[#eeeeee]">
                          <td className="p-2">
                            <div className="font-medium text-[#333333] flex items-center gap-1.5">
                              <span className="font-mono text-[#007cc0]">{row.defectCode}</span>
                              <span>{row.defectLabelFa}</span>
                              {row.isRecurring && (
                                <span className="px-1.5 py-0.5 text-[10px] rounded bg-[#ffecec] text-[#bb0000] border border-[#f5b7b1]">
                                  تکرارشونده
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="p-2 text-center font-mono">{toPersianDigits(row.occurrenceCount)}</td>
                          <td className="p-2 text-center font-mono">{formatNumber(row.affectedQty)}</td>
                          <td className="p-2 text-center font-mono">{formatRate(row.sharePercent)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Supplier Performance & Part Quality */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="sap-card p-4 space-y-3">
              <h3 className="text-sm font-bold text-[#333333]">کارنامه کیفی تامین‌کنندگان (Supplier Quality Performance)</h3>
              {!dashboard || dashboard.supplierPerformance.length === 0 ? (
                <div className="py-8 text-center text-xs text-[#666666]">
                  بازرسی ورودی یا عدم انطباق متصل به تامین‌کننده ثبت نشده است.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="bg-[#f5f5f5] border-b border-[#d9d9d9] text-[#555555]">
                        <th className="p-2 text-right">تامین‌کننده</th>
                        <th className="p-2 text-center">بازرسی</th>
                        <th className="p-2 text-center">ردشده</th>
                        <th className="p-2 text-center">NCR باز</th>
                        <th className="p-2 text-center">نرخ رد</th>
                        <th className="p-2 text-center">امتیاز کیفیت</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dashboard.supplierPerformance.map(sup => (
                        <tr key={sup.supplierName} className="border-b border-[#eeeeee]">
                          <td className="p-2 font-semibold text-[#333333]">{sup.supplierName}</td>
                          <td className="p-2 text-center font-mono">{toPersianDigits(sup.totalInspections)}</td>
                          <td className="p-2 text-center font-mono text-[#bb0000]">{toPersianDigits(sup.rejectedInspections)}</td>
                          <td className="p-2 text-center font-mono text-[#e9730c]">{toPersianDigits(sup.openNcrCount)}</td>
                          <td className="p-2 text-center font-mono">{formatRate(sup.rejectionRatePercent)}</td>
                          <td className="p-2 text-center font-mono font-bold text-[#107e3e]">
                            {formatRate(sup.qualityScorePercent)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="sap-card p-4 space-y-3">
              <h3 className="text-sm font-bold text-[#333333]">کیفیت به تفکیک قطعه / ماده اولیه</h3>
              {!dashboard || dashboard.byPart.length === 0 ? (
                <div className="py-8 text-center text-xs text-[#666666]">
                  رکورد کیفی برای قطعات ثبت نشده است.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="bg-[#f5f5f5] border-b border-[#d9d9d9] text-[#555555]">
                        <th className="p-2 text-right">قطعه</th>
                        <th className="p-2 text-center">بازرسی</th>
                        <th className="p-2 text-center">NCR</th>
                        <th className="p-2 text-center">ردشده</th>
                        <th className="p-2 text-center">نرخ رد</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dashboard.byPart.slice(0, 10).map(p => (
                        <tr key={p.partId} className="border-b border-[#eeeeee]">
                          <td className="p-2">
                            <button
                              type="button"
                              onClick={() => jumpToHistory({ partCode: p.partCode })}
                              className="text-right hover:underline text-[#007cc0] cursor-pointer"
                            >
                              <span className="font-mono font-bold">{p.partCode}</span> — {p.partName}
                            </button>
                          </td>
                          <td className="p-2 text-center font-mono">{toPersianDigits(p.inspectionCount)}</td>
                          <td className="p-2 text-center font-mono">{toPersianDigits(p.ncrCount)}</td>
                          <td className="p-2 text-center font-mono text-[#bb0000]">{formatNumber(p.rejectedQty)}</td>
                          <td className="p-2 text-center font-mono">{formatRate(p.rejectionRatePercent)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* TAB 2: INCOMING, IN-PROCESS & FINAL PRODUCT INSPECTIONS           */}
      {/* ================================================================= */}
      {activeTab === 'INSPECTIONS' && (
        <div className="space-y-4">
          <div className="sap-card p-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <select
                value={inspTypeFilter}
                onChange={e => setInspTypeFilter(e.target.value)}
                className="border border-[#cccccc] rounded px-2 py-1.5 text-xs bg-white"
              >
                <option value="ALL">همه انواع بازرسی</option>
                <option value="INCOMING_MATERIAL">بازرسی ورودی (IQC)</option>
                <option value="IN_PROCESS">بازرسی حین فرآیند (IPQC)</option>
                <option value="FINAL_PRODUCT">بازرسی محصول نهایی (FQC)</option>
              </select>

              <select
                value={inspDecisionFilter}
                onChange={e => setInspDecisionFilter(e.target.value)}
                className="border border-[#cccccc] rounded px-2 py-1.5 text-xs bg-white"
              >
                <option value="ALL">همه تصمیم‌ها</option>
                <option value="PENDING">در انتظار تصمیم</option>
                <option value="ACCEPTED">تایید و ترخیص</option>
                <option value="ACCEPTED_WITH_CONCESSION">تایید ارفاقی</option>
                <option value="QUARANTINED">قرنطینه</option>
                <option value="REJECTED">رد کیفی</option>
              </select>

              <input
                type="text"
                value={inspSearch}
                onChange={e => setInspSearch(e.target.value)}
                placeholder="جستجو شماره بازرسی، بچ، کلاف، MO..."
                className="border border-[#cccccc] rounded px-2.5 py-1.5 text-xs bg-white w-56"
              />
            </div>

            <button
              type="button"
              onClick={() => setShowNewInspectionForm(!showNewInspectionForm)}
              className="sap-btn-emphasized px-3.5 py-1.5 text-xs font-semibold cursor-pointer flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{showNewInspectionForm ? 'بستن فرم بازرسی جدید' : 'ثبت برگه بازرسی جدید'}</span>
            </button>
          </div>

          {/* New Inspection Form */}
          {showNewInspectionForm && (
            <form onSubmit={handleCreateInspection} className="sap-card p-4 space-y-4 border-r-4 border-r-[#007cc0]">
              <h3 className="text-sm font-bold text-[#333333]">ثبت برگه بازرسی کیفی جدید (ورودی / حین فرآیند / محصول نهایی)</h3>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                <div className="space-y-1">
                  <label className="font-semibold text-[#333333]">نوع بازرسی *</label>
                  <select
                    value={newInspType}
                    onChange={e => setNewInspType(e.target.value as QualityInspectionType)}
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                  >
                    <option value="INCOMING_MATERIAL">بازرسی ورودی مواد و کلاف (IQC)</option>
                    <option value="IN_PROCESS">بازرسی حین فرآیند تولید (IPQC)</option>
                    <option value="FINAL_PRODUCT">بازرسی محصول نهایی (FQC)</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-semibold text-[#333333]">قطعه / ماده اولیه *</label>
                  <select
                    value={newInspPartId}
                    onChange={e => setNewInspPartId(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                  >
                    {parts.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.code} — {p.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-semibold text-[#333333]">مقدار مورد بازرسی *</label>
                  <input
                    type="number"
                    min="0.001"
                    step="any"
                    value={newInspQty}
                    onChange={e => setNewInspQty(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white font-mono"
                    required
                  />
                </div>

                {newInspType === 'INCOMING_MATERIAL' && (
                  <>
                    <div className="space-y-1">
                      <label className="font-semibold text-[#333333]">کلاف فیزیکی (اختیاری)</label>
                      <select
                        value={newInspCoilId}
                        onChange={e => {
                          setNewInspCoilId(e.target.value);
                          const c = coils.find(item => item.id === e.target.value);
                          if (c) {
                            if (c.partId) setNewInspPartId(c.partId);
                            setNewInspLotNumber(c.coilPackNumber || c.coilId);
                            setNewInspSupplier(c.supplierName || '');
                            setNewInspQty(String(c.remainingWeightKg));
                          }
                        }}
                        className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                      >
                        <option value="">-- انتخاب کلاف --</option>
                        {coils.map(c => (
                          <option key={c.id} value={c.id}>
                            {c.coilId} ({c.partCode} — {formatNumber(c.remainingWeightKg)} کیلو — {QUALITY_STATUS_LABELS_FA[c.qualityStatus] || c.qualityStatus})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="font-semibold text-[#333333]">تامین‌کننده</label>
                      <input
                        type="text"
                        value={newInspSupplier}
                        onChange={e => setNewInspSupplier(e.target.value)}
                        placeholder="مثلاً: ساپکو / فولاد مبارکه"
                        className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                      />
                    </div>
                  </>
                )}

                {(newInspType === 'IN_PROCESS' || newInspType === 'FINAL_PRODUCT') && (
                  <>
                    <div className="space-y-1">
                      <label className="font-semibold text-[#333333]">
                        دستور ساخت (MO) {newInspType === 'IN_PROCESS' ? '*' : '(اختیاری)'}
                      </label>
                      <select
                        value={newInspMoId}
                        onChange={e => {
                          setNewInspMoId(e.target.value);
                          setNewInspOpCode('');
                          const mo = manufacturingOrders.find(m => m.id === e.target.value);
                          if (mo?.partId) setNewInspPartId(mo.partId);
                        }}
                        className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                      >
                        <option value="">-- انتخاب دستور ساخت --</option>
                        {manufacturingOrders.map(mo => (
                          <option key={mo.id} value={mo.id}>
                            {mo.moNumber} — {mo.partCode} ({mo.partName})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="font-semibold text-[#333333]">عملیات / ایستگاه (Operation)</label>
                      <select
                        value={newInspOpCode}
                        onChange={e => setNewInspOpCode(e.target.value)}
                        className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                      >
                        <option value="">-- کل دستور کار / انتخاب عملیات --</option>
                        {(selectedMoForNewInsp?.operations || []).map((op, idx) => {
                          const code = op.operationCode || op.code || `OP${(idx + 1) * 10}`;
                          const name = op.operationName || op.name || code;
                          return (
                            <option key={`${code}-${idx}`} value={code}>
                              {code} — {name}
                            </option>
                          );
                        })}
                      </select>
                    </div>
                  </>
                )}

                <div className="space-y-1">
                  <label className="font-semibold text-[#333333]">ردیف موجودی انبار (Balance)</label>
                  <select
                    value={newInspBalanceId}
                    onChange={e => {
                      setNewInspBalanceId(e.target.value);
                      const bal = balances.find(b => b.id === e.target.value);
                      if (bal) {
                        setNewInspPartId(bal.partId);
                        if (bal.lotNumber) setNewInspLotNumber(bal.lotNumber);
                      }
                    }}
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                  >
                    <option value="">-- تطبیق خودکار با انبار --</option>
                    {balances
                      .filter(b => !newInspPartId || b.partId === newInspPartId)
                      .slice(0, 40)
                      .map(b => (
                        <option key={b.id} value={b.id}>
                          {b.warehouseName} | بچ: {b.lotNumber || '-'} | آزاد: {formatNumber(b.availableQty)} | QI:{' '}
                          {formatNumber(b.qualityInspectionQty)}
                        </option>
                      ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-semibold text-[#333333]">شماره بچ / لات (Lot)</label>
                  <input
                    type="text"
                    value={newInspLotNumber}
                    onChange={e => setNewInspLotNumber(e.target.value)}
                    placeholder="LOT-..."
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white font-mono"
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-semibold text-[#333333]">تصمیم فوری (اختیاری)</label>
                  <select
                    value={newInspImmediateDecision}
                    onChange={e => setNewInspImmediateDecision(e.target.value as QualityDecision | '')}
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                  >
                    <option value="">ثبت در وضعیت «در انتظار تصمیم»</option>
                    <option value="ACCEPTED">تایید و ترخیص فوری (۳۲۱)</option>
                    <option value="ACCEPTED_WITH_CONCESSION">تایید ارفاقی (۳۲۱)</option>
                    <option value="QUARANTINED">انتقال به قرنطینه (۳۲۲)</option>
                    <option value="REJECTED">رد کیفی و مسدودسازی (۳۴۴ + NCR)</option>
                  </select>
                </div>

                {(newInspImmediateDecision === 'REJECTED' || newInspImmediateDecision === 'QUARANTINED') && (
                  <div className="space-y-1">
                    <label className="font-semibold text-[#333333]">کد عیب اصلی</label>
                    <select
                      value={newInspDefectCode}
                      onChange={e => setNewInspDefectCode(e.target.value)}
                      className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                    >
                      {defectOptions.map(d => (
                        <option key={d.code} value={d.code}>
                          {d.code} — {d.labelFa}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {/* Dynamic Checklist */}
              {newInspChecklist.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs font-bold text-[#333333]">چک‌لیست استاندارد مرحله بازرسی:</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {newInspChecklist.map((item, idx) => (
                      <div
                        key={item.id}
                        className={`p-2.5 rounded border flex items-center justify-between gap-2 text-xs ${
                          item.passed
                            ? 'bg-[#ebf5ec] border-[#b7dfbf] text-[#107e3e]'
                            : 'bg-[#ffecec] border-[#f5b7b1] text-[#bb0000]'
                        }`}
                      >
                        <div>
                          <div className="font-semibold">{item.labelFa}</div>
                          {item.standardSpec && <div className="text-[10px] opacity-80">معیار: {item.standardSpec}</div>}
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setNewInspChecklist(prev =>
                              prev.map((c, i) => (i === idx ? { ...c, passed: !c.passed } : c))
                            )
                          }
                          className="px-2.5 py-1 rounded bg-white border border-current text-[11px] font-bold cursor-pointer"
                        >
                          {item.passed ? 'قبول ✓' : 'رد ✗'}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[#e8e8e8] text-xs">
                <label className="flex items-center gap-2 cursor-pointer text-[#333333]">
                  <input
                    type="checkbox"
                    checked={newInspQuarantineOnStart}
                    onChange={e => setNewInspQuarantineOnStart(e.target.checked)}
                    disabled={Boolean(newInspImmediateDecision)}
                  />
                  <span>قفل خودکار موجودی در قرنطینه (کد ۳۲۲) تا زمان صدور تصمیم نهایی</span>
                </label>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newInspNotes}
                    onChange={e => setNewInspNotes(e.target.value)}
                    placeholder="یادداشت بازرس..."
                    className="border border-[#bfbfbf] rounded px-2.5 py-1.5 text-xs w-56"
                  />
                  <button
                    type="submit"
                    disabled={loading}
                    className="sap-btn-emphasized px-4 py-1.5 text-xs font-semibold cursor-pointer"
                  >
                    ثبت برگه بازرسی
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* Inline Decide Inspection Panel */}
          {decidingInspection && (
            <form onSubmit={handleDecideInspection} className="sap-card p-4 space-y-3 border-r-4 border-r-[#e9730c] bg-[#fffdf9]">
              <div className="flex items-center justify-between border-b border-[#e8e8e8] pb-2">
                <div className="text-xs font-bold text-[#333333]">
                  ثبت تصمیم نهایی بازرسی <span className="font-mono text-[#007cc0]">{decidingInspection.inspectionNumber}</span> —{' '}
                  {decidingInspection.partCode} ({formatNumber(decidingInspection.inspectedQty)} {decidingInspection.unit})
                </div>
                <button
                  type="button"
                  onClick={() => setDecidingInspection(null)}
                  className="text-xs text-[#666666] hover:text-[#bb0000] cursor-pointer"
                >
                  بستن ✕
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
                <div className="space-y-1">
                  <label className="font-semibold">تصمیم کیفی *</label>
                  <select
                    value={decideChoice}
                    onChange={e => {
                      const d = e.target.value as QualityDecision;
                      setDecideChoice(d);
                      if (d === 'ACCEPTED' || d === 'ACCEPTED_WITH_CONCESSION') {
                        setDecideAcceptedQty(String(decidingInspection.inspectedQty));
                        setDecideReworkQty('0');
                        setDecideRejectedQty('0');
                      } else if (d === 'REJECTED') {
                        setDecideAcceptedQty('0');
                        setDecideReworkQty('0');
                        setDecideRejectedQty(String(decidingInspection.inspectedQty));
                      }
                    }}
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                  >
                    <option value="ACCEPTED">تایید و ترخیص (۳۲۱)</option>
                    <option value="ACCEPTED_WITH_CONCESSION">تایید ارفاقی (۳۲۱)</option>
                    <option value="QUARANTINED">قرنطینه (۳۲۲)</option>
                    <option value="REJECTED">رد کیفی / مسدود (۳۴۴ + NCR)</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-semibold">تعداد سالم (Accepted)</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={decideAcceptedQty}
                    onChange={e => setDecideAcceptedQty(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white font-mono"
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-semibold">تعداد دوباره‌کاری (Rework)</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={decideReworkQty}
                    onChange={e => setDecideReworkQty(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white font-mono"
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-semibold">تعداد ردشده (Rejected)</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={decideRejectedQty}
                    onChange={e => setDecideRejectedQty(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white font-mono"
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-semibold">کد عیب (در صورت وجود عیب)</label>
                  <select
                    value={decideDefectCode}
                    onChange={e => setDecideDefectCode(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                  >
                    {defectOptions.map(d => (
                      <option key={d.code} value={d.code}>
                        {d.code} — {d.labelFa}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-semibold">شدت عدم انطباق</label>
                  <select
                    value={decideSeverity}
                    onChange={e => setDecideSeverity(e.target.value as NonconformanceSeverity)}
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                  >
                    <option value="MINOR">جزئی</option>
                    <option value="MAJOR">عمده</option>
                    <option value="CRITICAL">بحرانی</option>
                  </select>
                </div>

                <div className="md:col-span-2 space-y-1">
                  <label className="font-semibold">توضیحات تصمیم بازرس</label>
                  <input
                    type="text"
                    value={decideNotes}
                    onChange={e => setDecideNotes(e.target.value)}
                    placeholder="علت تایید، قرنطینه یا رد کیفی..."
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDecidingInspection(null)}
                  className="px-3 py-1.5 rounded border border-[#cccccc] text-xs cursor-pointer"
                >
                  انصراف
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="sap-btn-emphasized px-4 py-1.5 text-xs font-semibold cursor-pointer"
                >
                  ثبت تصمیم و به‌روزرسانی انبار
                </button>
              </div>
            </form>
          )}

          {/* Inspections Table */}
          <div className="sap-card overflow-x-auto">
            {filteredInspections.length === 0 ? (
              <div className="py-12 text-center text-xs text-[#666666]">
                هیچ برگه بازرسی با این فیلترها یافت نشد. از دکمه «ثبت برگه بازرسی جدید» استفاده کنید.
              </div>
            ) : (
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-[#f5f5f5] border-b border-[#d9d9d9] text-[#555555]">
                    <th className="p-2.5 text-right">شماره بازرسی</th>
                    <th className="p-2.5 text-right">نوع</th>
                    <th className="p-2.5 text-right">قطعه / ردیابی (بچ / کلاف / MO)</th>
                    <th className="p-2.5 text-center">مقدار (قبول/دوباره/رد)</th>
                    <th className="p-2.5 text-center">تصمیم</th>
                    <th className="p-2.5 text-right">اسناد متصل</th>
                    <th className="p-2.5 text-center">عملیات</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredInspections.map(insp => (
                    <tr key={insp.id} className="border-b border-[#eeeeee] hover:bg-[#fafafa]">
                      <td className="p-2.5">
                        <div className="font-mono font-bold text-[#007cc0]">{insp.inspectionNumber}</div>
                        <div className="text-[10px] text-[#666666]">{formatDateTime(insp.createdAt)}</div>
                      </td>
                      <td className="p-2.5">
                        <span className="text-[11px] font-medium text-[#333333]">
                          {catalog?.inspectionTypeLabels?.[insp.inspectionType] || insp.inspectionType}
                        </span>
                      </td>
                      <td className="p-2.5">
                        <div className="font-semibold text-[#333333]">
                          <span className="font-mono">{insp.partCode}</span> — {insp.partName}
                        </div>
                        <div className="text-[11px] text-[#666666] flex flex-wrap gap-2 mt-0.5 font-mono">
                          {insp.lotNumber && <span>بچ: {insp.lotNumber}</span>}
                          {insp.coilId && <span>کلاف: {insp.coilId}</span>}
                          {insp.moNumber && (
                            <span>
                              MO: {insp.moNumber}
                              {insp.operationCode ? ` / ${insp.operationCode}` : ''}
                            </span>
                          )}
                          {insp.supplierName && <span className="font-sans">تامین‌کننده: {insp.supplierName}</span>}
                        </div>
                      </td>
                      <td className="p-2.5 text-center font-mono">
                        <div className="font-bold text-[#333333]">
                          {formatNumber(insp.inspectedQty)} {insp.unit}
                        </div>
                        <div className="text-[10px] text-[#666666]">
                          <span className="text-[#107e3e]">{formatNumber(insp.acceptedQty)}</span> /{' '}
                          <span className="text-[#e9730c]">{formatNumber(insp.reworkQty)}</span> /{' '}
                          <span className="text-[#bb0000]">{formatNumber(insp.rejectedQty)}</span>
                        </div>
                      </td>
                      <td className="p-2.5 text-center">
                        <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${decisionBadgeClass(insp.decision)}`}>
                          {DECISION_LABELS_FA[insp.decision]}
                        </span>
                      </td>
                      <td className="p-2.5 text-[11px] font-mono text-[#555555]">
                        {insp.linkedQmDocumentNumber && <div>QM: {insp.linkedQmDocumentNumber}</div>}
                        {insp.linkedNcrNumber && <div className="text-[#bb0000]">NCR: {insp.linkedNcrNumber}</div>}
                      </td>
                      <td className="p-2.5 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          {(insp.status !== 'COMPLETED' || insp.decision === 'QUARANTINED' || insp.decision === 'PENDING') && (
                            <button
                              type="button"
                              onClick={() => openDecidePanel(insp)}
                              className="px-2.5 py-1 rounded bg-[#007cc0] text-white text-[11px] font-semibold hover:bg-[#006399] cursor-pointer"
                            >
                              تصمیم‌گیری
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              jumpToHistory({
                                lotNumber: insp.lotNumber,
                                coilId: insp.coilId,
                                moNumber: insp.moNumber,
                                partCode: !insp.lotNumber && !insp.coilId && !insp.moNumber ? insp.partCode : undefined,
                              })
                            }
                            className="px-2 py-1 rounded border border-[#cccccc] text-[11px] text-[#333333] hover:bg-[#f0f0f0] cursor-pointer"
                          >
                            ردیابی
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* TAB 3: NONCONFORMANCE (NCR), CONTAINMENT & DISPOSITION            */}
      {/* ================================================================= */}
      {activeTab === 'NCR' && (
        <div className="space-y-4">
          <div className="sap-card p-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <select
                value={ncrStatusFilter}
                onChange={e => setNcrStatusFilter(e.target.value)}
                className="border border-[#cccccc] rounded px-2 py-1.5 text-xs bg-white"
              >
                <option value="ALL">همه وضعیت‌های NCR</option>
                <option value="ACTIVE">فقط NCRهای باز / فعال</option>
                <option value="OPEN">باز (بدون مهار)</option>
                <option value="CONTAINED">مهار شده</option>
                <option value="IN_REWORK">در حال دوباره‌کاری</option>
                <option value="CLOSED">بسته شده</option>
              </select>

              <select
                value={ncrSeverityFilter}
                onChange={e => setNcrSeverityFilter(e.target.value)}
                className="border border-[#cccccc] rounded px-2 py-1.5 text-xs bg-white"
              >
                <option value="ALL">همه سطوح شدت</option>
                <option value="CRITICAL">بحرانی (Critical)</option>
                <option value="MAJOR">عمده (Major)</option>
                <option value="MINOR">جزئی (Minor)</option>
              </select>
            </div>

            <button
              type="button"
              onClick={() => setShowNewNcrForm(!showNewNcrForm)}
              className="px-3.5 py-1.5 rounded text-xs font-semibold bg-[#bb0000] text-white hover:bg-[#990000] cursor-pointer flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{showNewNcrForm ? 'بستن فرم عدم انطباق' : 'ثبت عدم انطباق جدید (NCR)'}</span>
            </button>
          </div>

          {/* Create Manual NCR Form */}
          {showNewNcrForm && (
            <form onSubmit={handleCreateNcr} className="sap-card p-4 space-y-3 border-r-4 border-r-[#bb0000]">
              <h3 className="text-sm font-bold text-[#333333]">ثبت گزارش عدم انطباق کیفی جدید (NCR)</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                <div className="space-y-1">
                  <label className="font-semibold">منبع کشف عیب</label>
                  <select
                    value={newNcrSource}
                    onChange={e => setNewNcrSource(e.target.value as NcrSourceType)}
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                  >
                    <option value="INCOMING_MATERIAL">ورودی انبار / کلاف</option>
                    <option value="IN_PROCESS">حین فرآیند تولید</option>
                    <option value="FINAL_PRODUCT">محصول نهایی</option>
                    <option value="WAREHOUSE_AUDIT">ممیزی انبار</option>
                    <option value="CUSTOMER_COMPLAINT">شکایت مشتری / ساپکو</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-semibold">قطعه / ماده اولیه *</label>
                  <select
                    value={newNcrPartId}
                    onChange={e => setNewNcrPartId(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                  >
                    {parts.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.code} — {p.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-semibold">کد عیب و طبقه‌بندی *</label>
                  <select
                    value={newNcrDefectCode}
                    onChange={e => setNewNcrDefectCode(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                  >
                    {defectOptions.map(d => (
                      <option key={d.code} value={d.code}>
                        {d.code} — {d.labelFa}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-semibold">شدت عیب</label>
                  <select
                    value={newNcrSeverity}
                    onChange={e => setNewNcrSeverity(e.target.value as NonconformanceSeverity)}
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                  >
                    <option value="MINOR">جزئی (Minor)</option>
                    <option value="MAJOR">عمده (Major)</option>
                    <option value="CRITICAL">بحرانی (Critical)</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-semibold">مقدار نامنطبق *</label>
                  <input
                    type="number"
                    min="0.001"
                    step="any"
                    value={newNcrQty}
                    onChange={e => setNewNcrQty(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white font-mono"
                    required
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-semibold">ردیف موجودی انبار (برای قفل خودکار)</label>
                  <select
                    value={newNcrBalanceId}
                    onChange={e => {
                      setNewNcrBalanceId(e.target.value);
                      const bal = balances.find(b => b.id === e.target.value);
                      if (bal?.lotNumber) setNewNcrLotNumber(bal.lotNumber);
                    }}
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                  >
                    <option value="">-- تطبیق خودکار --</option>
                    {balances
                      .filter(b => !newNcrPartId || b.partId === newNcrPartId)
                      .slice(0, 40)
                      .map(b => (
                        <option key={b.id} value={b.id}>
                          {b.warehouseName} | بچ: {b.lotNumber || '-'} | آزاد: {formatNumber(b.availableQty)}
                        </option>
                      ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-semibold">شماره بچ / کلاف</label>
                  <input
                    type="text"
                    value={newNcrLotNumber}
                    onChange={e => setNewNcrLotNumber(e.target.value)}
                    placeholder="LOT-... یا COIL-..."
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white font-mono"
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-semibold">شماره دستور کار (MO)</label>
                  <input
                    type="text"
                    value={newNcrMoNumber}
                    onChange={e => setNewNcrMoNumber(e.target.value)}
                    placeholder="MO-..."
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white font-mono"
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-semibold">شرح عدم انطباق *</label>
                  <input
                    type="text"
                    value={newNcrDescription}
                    onChange={e => setNewNcrDescription(e.target.value)}
                    placeholder="توضیح دقیق عیب مشاهده‌شده..."
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                    required
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[#e8e8e8] text-xs">
                <div className="flex items-center gap-3 flex-wrap">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newNcrContainNow}
                      onChange={e => setNewNcrContainNow(e.target.checked)}
                    />
                    <span className="font-semibold text-[#bb0000]">مهار فوری و قفل موجودی در انبار (کد ۳۴۴)</span>
                  </label>
                  {newNcrContainNow && (
                    <input
                      type="text"
                      value={newNcrContainmentAction}
                      onChange={e => setNewNcrContainmentAction(e.target.value)}
                      className="border border-[#bfbfbf] rounded px-2.5 py-1 text-xs w-64"
                      placeholder="شرح اقدام مهار فوری..."
                    />
                  )}
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="px-4 py-1.5 rounded bg-[#bb0000] text-white text-xs font-semibold hover:bg-[#990000] cursor-pointer"
                >
                  ثبت گزارش عدم انطباق
                </button>
              </div>
            </form>
          )}

          {/* Contain NCR Panel */}
          {containingNcr && (
            <form onSubmit={handleContainNcr} className="sap-card p-4 space-y-3 border-r-4 border-r-[#e9730c] bg-[#fffaf2]">
              <div className="flex items-center justify-between">
                <div className="text-xs font-bold text-[#333333]">
                  اجرای مهار فوری و قرنطینه برای <span className="font-mono text-[#bb0000]">{containingNcr.ncrNumber}</span> (
                  {formatNumber(containingNcr.affectedQty)} {containingNcr.unit})
                </div>
                <button type="button" onClick={() => setContainingNcr(null)} className="text-xs cursor-pointer">
                  بستن ✕
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                <div className="space-y-1">
                  <label className="font-semibold">نوع قفل موجودی</label>
                  <select
                    value={containHoldType}
                    onChange={e => setContainHoldType(e.target.value as 'BLOCKED' | 'QUALITY_INSPECTION')}
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                  >
                    <option value="BLOCKED">مسدود کامل (کد ۳۴۴ — غیرقابل مصرف)</option>
                    <option value="QUALITY_INSPECTION">قرنطینه بازرسی (کد ۳۲۲)</option>
                  </select>
                </div>
                <div className="md:col-span-2 space-y-1">
                  <label className="font-semibold">شرح اقدام مهار فوری *</label>
                  <input
                    type="text"
                    value={containActionText}
                    onChange={e => setContainActionText(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                    required
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setContainingNcr(null)}
                  className="px-3 py-1.5 rounded border border-[#cccccc] text-xs cursor-pointer"
                >
                  انصراف
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-4 py-1.5 rounded bg-[#e9730c] text-white text-xs font-semibold cursor-pointer"
                >
                  قفل موجودی و ثبت مهار
                </button>
              </div>
            </form>
          )}

          {/* Disposition NCR Panel */}
          {disposingNcr && (
            <form onSubmit={handleDispositionNcr} className="sap-card p-4 space-y-3 border-r-4 border-r-[#007cc0] bg-[#f7fbfe]">
              <div className="flex items-center justify-between">
                <div className="text-xs font-bold text-[#333333]">
                  تعیین تکلیف عدم انطباق <span className="font-mono text-[#007cc0]">{disposingNcr.ncrNumber}</span> —{' '}
                  {disposingNcr.partCode} ({formatNumber(disposingNcr.affectedQty)} {disposingNcr.unit})
                </div>
                <button type="button" onClick={() => setDisposingNcr(null)} className="text-xs cursor-pointer">
                  بستن ✕
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                <div className="space-y-1">
                  <label className="font-semibold">اقدام تعیین تکلیف (Disposition) *</label>
                  <select
                    value={dispAction}
                    onChange={e => setDispAction(e.target.value as NcrDispositionAction)}
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                  >
                    <option value="REWORK">دوباره‌کاری (ایجاد دستور Rework)</option>
                    <option value="SCRAP">ضایعات و کسر از موجودی (انبار ضایعات)</option>
                    <option value="USE_AS_IS">مصرف ارفاقی و ترخیص آزاد (کد ۳۲۱)</option>
                    <option value="RETURN_TO_SUPPLIER">مرجوع به تامین‌کننده</option>
                    <option value="SORT_REINSPECT">جداسازی و بازرسی مجدد (سالم + ضایعات)</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-semibold">علت ریشه‌ای (Root Cause)</label>
                  <input
                    type="text"
                    value={dispRootCause}
                    onChange={e => setDispRootCause(e.target.value)}
                    placeholder="تحلیل علت بروز عیب..."
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-semibold">اقدام اصلاحی (Corrective Action)</label>
                  <input
                    type="text"
                    value={dispCorrective}
                    onChange={e => setDispCorrective(e.target.value)}
                    placeholder="اقدام پیشگیرانه برای جلوگیری از تکرار..."
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                  />
                </div>

                {dispAction === 'REWORK' && (
                  <div className="md:col-span-3 space-y-1">
                    <label className="font-semibold">دستورالعمل دوباره‌کاری *</label>
                    <input
                      type="text"
                      value={dispReworkInstructions}
                      onChange={e => setDispReworkInstructions(e.target.value)}
                      className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                      required
                    />
                  </div>
                )}

                {dispAction === 'SORT_REINSPECT' && (
                  <>
                    <div className="space-y-1">
                      <label className="font-semibold">مقدار سالمِ جداشده (ترخیص ۳۲۱)</label>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={dispSortedGoodQty}
                        onChange={e => setDispSortedGoodQty(e.target.value)}
                        className="w-full border border-[#bfbfbf] rounded p-2 bg-white font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="font-semibold">مقدار معیوبِ جداشده (ضایعات)</label>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={dispSortedDefectQty}
                        onChange={e => setDispSortedDefectQty(e.target.value)}
                        className="w-full border border-[#bfbfbf] rounded p-2 bg-white font-mono"
                      />
                    </div>
                  </>
                )}

                <div className="md:col-span-3 space-y-1">
                  <label className="font-semibold">یادداشت کمیته MRB / تعیین تکلیف</label>
                  <input
                    type="text"
                    value={dispNotes}
                    onChange={e => setDispNotes(e.target.value)}
                    placeholder="توضیحات تکمیلی..."
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDisposingNcr(null)}
                  className="px-3 py-1.5 rounded border border-[#cccccc] text-xs cursor-pointer"
                >
                  انصراف
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="sap-btn-emphasized px-4 py-1.5 text-xs font-semibold cursor-pointer"
                >
                  اجرای تعیین تکلیف و سند انبار
                </button>
              </div>
            </form>
          )}

          {/* NCR Table */}
          <div className="sap-card overflow-x-auto">
            {filteredNcrs.length === 0 ? (
              <div className="py-12 text-center text-xs text-[#666666]">
                هیچ گزارش عدم انطباقی با این فیلترها وجود ندارد.
              </div>
            ) : (
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-[#f5f5f5] border-b border-[#d9d9d9] text-[#555555]">
                    <th className="p-2.5 text-right">شماره NCR</th>
                    <th className="p-2.5 text-right">قطعه و ردیابی</th>
                    <th className="p-2.5 text-right">عیب و شدت</th>
                    <th className="p-2.5 text-center">مقدار</th>
                    <th className="p-2.5 text-center">وضعیت / تعیین تکلیف</th>
                    <th className="p-2.5 text-center">عملیات</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredNcrs.map(ncr => (
                    <tr key={ncr.id} className="border-b border-[#eeeeee] hover:bg-[#fafafa]">
                      <td className="p-2.5">
                        <div className="font-mono font-bold text-[#bb0000]">{ncr.ncrNumber}</div>
                        <div className="text-[10px] text-[#666666]">{formatDateTime(ncr.createdAt)}</div>
                        {ncr.inspectionNumber && (
                          <div className="text-[10px] font-mono text-[#007cc0]">از: {ncr.inspectionNumber}</div>
                        )}
                      </td>
                      <td className="p-2.5">
                        <div className="font-semibold text-[#333333]">
                          <span className="font-mono">{ncr.partCode}</span> — {ncr.partName}
                        </div>
                        <div className="text-[11px] text-[#666666] font-mono flex flex-wrap gap-2 mt-0.5">
                          {ncr.lotNumber && <span>بچ: {ncr.lotNumber}</span>}
                          {ncr.coilId && <span>کلاف: {ncr.coilId}</span>}
                          {ncr.moNumber && <span>MO: {ncr.moNumber}</span>}
                          {ncr.linkedReworkNumber && <span className="text-[#007cc0]">Rework: {ncr.linkedReworkNumber}</span>}
                        </div>
                      </td>
                      <td className="p-2.5">
                        <div className="flex items-center gap-1.5">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${severityBadgeClass(ncr.severity)}`}>
                            {SEVERITY_LABELS_FA[ncr.severity]}
                          </span>
                          <span className="font-mono text-[#333333] font-semibold">{ncr.defectCode}</span>
                        </div>
                        <div className="text-[11px] text-[#555555] mt-0.5">{ncr.defectLabelFa}</div>
                      </td>
                      <td className="p-2.5 text-center font-mono">
                        <div className="font-bold">
                          {formatNumber(ncr.affectedQty)} {ncr.unit}
                        </div>
                        {ncr.containedQty > 0 && (
                          <div className="text-[10px] text-[#e9730c]">مهارشده: {formatNumber(ncr.containedQty)}</div>
                        )}
                      </td>
                      <td className="p-2.5 text-center">
                        <div className="font-semibold text-[#333333]">{NCR_STATUS_LABELS_FA[ncr.status] || ncr.status}</div>
                        <div className="text-[10px] text-[#666666] mt-0.5">
                          {DISPOSITION_LABELS_FA[ncr.disposition] || ncr.disposition}
                        </div>
                      </td>
                      <td className="p-2.5 text-center">
                        <div className="flex items-center justify-center gap-1.5 flex-wrap">
                          {ncr.status === 'OPEN' && (
                            <button
                              type="button"
                              onClick={() => setContainingNcr(ncr)}
                              className="px-2 py-1 rounded bg-[#e9730c] text-white text-[11px] font-semibold cursor-pointer"
                            >
                              مهار فوری
                            </button>
                          )}
                          {ncr.status !== 'CLOSED' && ncr.status !== 'IN_REWORK' && (
                            <button
                              type="button"
                              onClick={() => openDispositionPanel(ncr)}
                              className="px-2 py-1 rounded bg-[#007cc0] text-white text-[11px] font-semibold cursor-pointer"
                            >
                              تعیین تکلیف
                            </button>
                          )}
                          {ncr.status === 'IN_REWORK' && (
                            <button
                              type="button"
                              onClick={() => setActiveTab('REWORK')}
                              className="px-2 py-1 rounded bg-[#e5f3fa] text-[#007cc0] border border-[#b3ddf2] text-[11px] font-semibold cursor-pointer"
                            >
                              مشاهده دوباره‌کاری
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* TAB 4: REWORK, SCRAP & RETURN-TO-PRODUCTION WORKFLOWS             */}
      {/* ================================================================= */}
      {activeTab === 'REWORK' && (
        <div className="space-y-4">
          {completingRework && (
            <form onSubmit={handleCompleteRework} className="sap-card p-4 space-y-3 border-r-4 border-r-[#107e3e] bg-[#f7fcf8]">
              <div className="flex items-center justify-between">
                <div className="text-xs font-bold text-[#333333]">
                  ثبت نتیجه دوباره‌کاری <span className="font-mono text-[#007cc0]">{completingRework.reworkNumber}</span> —
                  باقیمانده: {formatNumber(completingRework.remainingQty)} {completingRework.unit}
                </div>
                <button type="button" onClick={() => setCompletingRework(null)} className="text-xs cursor-pointer">
                  بستن ✕
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
                <div className="space-y-1">
                  <label className="font-semibold text-[#107e3e]">مقدار سالمِ اصلاح‌شده (ترخیص ۳۲۱)</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={reworkGoodQty}
                    onChange={e => setReworkGoodQty(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-[#bb0000]">مقدار ضایعاتِ غیرقابل اصلاح</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={reworkScrapQty}
                    onChange={e => setReworkScrapQty(e.target.value)}
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white font-mono"
                  />
                </div>
                <div className="md:col-span-2 space-y-1">
                  <label className="font-semibold">یادداشت تکمیل دوباره‌کاری</label>
                  <input
                    type="text"
                    value={reworkNotes}
                    onChange={e => setReworkNotes(e.target.value)}
                    placeholder="گزارش بازرسی مجدد پس از اصلاح..."
                    className="w-full border border-[#bfbfbf] rounded p-2 bg-white"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between text-xs pt-2 border-t border-[#e8e8e8]">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={reworkReturnToProd}
                    onChange={e => setReworkReturnToProd(e.target.checked)}
                  />
                  <span>بازگشت قطعات سالم به خط تولید (Return to Production)</span>
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setCompletingRework(null)}
                    className="px-3 py-1.5 rounded border border-[#cccccc] cursor-pointer"
                  >
                    انصراف
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="px-4 py-1.5 rounded bg-[#107e3e] text-white font-semibold cursor-pointer"
                  >
                    ثبت نتیجه و ترخیص/ضایعات
                  </button>
                </div>
              </div>
            </form>
          )}

          <div className="sap-card overflow-x-auto">
            {reworkOrders.length === 0 ? (
              <div className="py-12 text-center text-xs text-[#666666]">
                هنوز دستور دوباره‌کاری ایجاد نشده است. برای ایجاد، از تب «عدم انطباق NCR» گزینه «تعیین تکلیف ← دوباره‌کاری» را اجرا کنید.
              </div>
            ) : (
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-[#f5f5f5] border-b border-[#d9d9d9] text-[#555555]">
                    <th className="p-2.5 text-right">شماره دوباره‌کاری / NCR</th>
                    <th className="p-2.5 text-right">قطعه و دستورالعمل</th>
                    <th className="p-2.5 text-center">برنامه‌ای / سالم / ضایعات / باقیمانده</th>
                    <th className="p-2.5 text-center">وضعیت</th>
                    <th className="p-2.5 text-right">اسناد انبار</th>
                    <th className="p-2.5 text-center">عملیات</th>
                  </tr>
                </thead>
                <tbody>
                  {reworkOrders.map(rew => (
                    <tr key={rew.id} className="border-b border-[#eeeeee] hover:bg-[#fafafa]">
                      <td className="p-2.5">
                        <div className="font-mono font-bold text-[#007cc0]">{rew.reworkNumber}</div>
                        <div className="text-[11px] font-mono text-[#bb0000]">NCR: {rew.ncrNumber}</div>
                        {rew.moNumber && <div className="text-[10px] font-mono text-[#666666]">MO: {rew.moNumber}</div>}
                      </td>
                      <td className="p-2.5">
                        <div className="font-semibold text-[#333333]">
                          <span className="font-mono">{rew.partCode}</span> — {rew.partName}
                        </div>
                        <div className="text-[11px] text-[#666666] mt-0.5">{rew.instructions}</div>
                      </td>
                      <td className="p-2.5 text-center font-mono">
                        <span>{formatNumber(rew.plannedReworkQty)}</span> /{' '}
                        <span className="text-[#107e3e] font-bold">{formatNumber(rew.completedGoodQty)}</span> /{' '}
                        <span className="text-[#bb0000]">{formatNumber(rew.scrappedQty)}</span> /{' '}
                        <span className="text-[#e9730c] font-bold">{formatNumber(rew.remainingQty)}</span>
                      </td>
                      <td className="p-2.5 text-center">
                        <span
                          className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                            rew.status === 'COMPLETED'
                              ? 'bg-[#ebf5ec] text-[#107e3e] border border-[#b7dfbf]'
                              : 'bg-[#fff4e5] text-[#e9730c] border border-[#f5cba7]'
                          }`}
                        >
                          {REWORK_STATUS_LABELS_FA[rew.status] || rew.status}
                        </span>
                      </td>
                      <td className="p-2.5 text-[11px] font-mono text-[#555555]">
                        {rew.returnDocumentNumber && <div className="text-[#107e3e]">ترخیص: {rew.returnDocumentNumber}</div>}
                        {rew.scrapDocumentNumber && <div className="text-[#bb0000]">ضایعات: {rew.scrapDocumentNumber}</div>}
                      </td>
                      <td className="p-2.5 text-center">
                        {rew.status !== 'COMPLETED' && rew.status !== 'CANCELLED' ? (
                          <button
                            type="button"
                            onClick={() => openCompleteRework(rew)}
                            className="px-2.5 py-1 rounded bg-[#107e3e] text-white text-[11px] font-semibold cursor-pointer"
                          >
                            ثبت نتیجه
                          </button>
                        ) : (
                          <span className="text-[#107e3e] inline-flex items-center gap-1 text-[11px]">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            تکمیل
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* TAB 5: QUALITY TRACEABILITY HISTORY & PRESERVED QM-UD WORKBENCH   */}
      {/* ================================================================= */}
      {activeTab === 'UD_AND_HISTORY' && (
        <div className="space-y-4">
          {/* Traceability Lookup Card */}
          <div className="sap-card p-4 space-y-4">
            <div className="flex items-center justify-between border-b border-[#e8e8e8] pb-2">
              <div className="flex items-center gap-2">
                <Search className="w-4 h-4 text-[#007cc0]" />
                <h3 className="text-sm font-bold text-[#333333]">
                  وضعیت کیفی و تاریخچه ردیابی (بر اساس بچ، کلاف فیزیکی، دستور ساخت یا کد قطعه)
                </h3>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-5 gap-2 text-xs">
              <input
                type="text"
                value={historyLot}
                onChange={e => setHistoryLot(e.target.value)}
                placeholder="شماره بچ / لات (Lot)"
                className="border border-[#bfbfbf] rounded p-2 font-mono"
              />
              <input
                type="text"
                value={historyCoil}
                onChange={e => setHistoryCoil(e.target.value)}
                placeholder="شماره کلاف (Coil ID)"
                className="border border-[#bfbfbf] rounded p-2 font-mono"
              />
              <input
                type="text"
                value={historyMo}
                onChange={e => setHistoryMo(e.target.value)}
                placeholder="شماره دستور کار (MO)"
                className="border border-[#bfbfbf] rounded p-2 font-mono"
              />
              <input
                type="text"
                value={historyPartCode}
                onChange={e => setHistoryPartCode(e.target.value)}
                placeholder="کد قطعه (Part Code)"
                className="border border-[#bfbfbf] rounded p-2 font-mono"
              />
              <button
                type="button"
                disabled={historyLoading}
                onClick={() => loadHistory()}
                className="sap-btn-emphasized px-4 py-2 text-xs font-semibold cursor-pointer"
              >
                {historyLoading ? 'در حال جستجو...' : 'جستجوی تاریخچه کیفی'}
              </button>
            </div>

            {historyData && (
              <div className="space-y-3 pt-2 border-t border-[#e8e8e8]">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
                  <div className="p-2.5 rounded bg-[#f5f5f5] border border-[#d9d9d9]">
                    <div className="text-[11px] text-[#666666]">وضعیت کیفی فعلی</div>
                    <div className="font-bold text-[#007cc0] mt-0.5">
                      {QUALITY_STATUS_LABELS_FA[historyData.currentQualityStatus] || historyData.currentQualityStatus}
                    </div>
                  </div>
                  <div className="p-2.5 rounded bg-[#f5f5f5] border border-[#d9d9d9]">
                    <div className="text-[11px] text-[#666666]">موجودی فیزیکی</div>
                    <div className="font-bold font-mono mt-0.5">{formatNumber(historyData.stockSummary.physicalQty)}</div>
                  </div>
                  <div className="p-2.5 rounded bg-[#ebf5ec] border border-[#b7dfbf]">
                    <div className="text-[11px] text-[#107e3e]">آزاد قابل مصرف</div>
                    <div className="font-bold font-mono text-[#107e3e] mt-0.5">
                      {formatNumber(historyData.stockSummary.availableQty)}
                    </div>
                  </div>
                  <div className="p-2.5 rounded bg-[#fff4e5] border border-[#f5cba7]">
                    <div className="text-[11px] text-[#e9730c]">قرنطینه (QI)</div>
                    <div className="font-bold font-mono text-[#e9730c] mt-0.5">
                      {formatNumber(historyData.stockSummary.qualityInspectionQty)}
                    </div>
                  </div>
                  <div className="p-2.5 rounded bg-[#ffecec] border border-[#f5b7b1]">
                    <div className="text-[11px] text-[#bb0000]">مسدود / رد کیفی</div>
                    <div className="font-bold font-mono text-[#bb0000] mt-0.5">
                      {formatNumber(historyData.stockSummary.blockedQty)}
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="text-xs font-bold text-[#333333]">
                    خط زمانی رویدادهای کیفی ({toPersianDigits(historyData.timeline.length)} رویداد):
                  </div>
                  {historyData.timeline.length === 0 ? (
                    <div className="text-xs text-[#666666] py-4 text-center">
                      رویداد کیفی برای این شناسه ثبت نشده است.
                    </div>
                  ) : (
                    <div className="space-y-1.5 max-h-64 overflow-y-auto">
                      {historyData.timeline.map(ev => (
                        <div
                          key={ev.id}
                          className="p-2.5 rounded border border-[#e0e0e0] bg-white flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                        >
                          <div>
                            <div className="font-semibold text-[#333333]">
                              <span className="font-mono text-[#007cc0] ml-1.5">{ev.referenceNumber}</span>
                              {ev.titleFa}
                            </div>
                            <div className="text-[11px] text-[#666666] mt-0.5">{ev.detailFa}</div>
                          </div>
                          <div className="text-[11px] text-[#666666] text-left shrink-0">
                            <div>{ev.actorName}</div>
                            <div className="font-mono">{formatDateTime(ev.timestamp)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Preserved Quick QM-UD Master-Detail Workbench */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            <div className="lg:col-span-4 sap-card p-3 space-y-2 max-h-[60vh] overflow-y-auto">
              <div className="text-xs font-bold text-[#333333] border-b border-[#e8e8e8] pb-2 flex items-center justify-between">
                <span>ترخیص / قرنطینه سریع (QM-UD: {toPersianDigits(quarantineItems.length)})</span>
                <span className="text-[10px] text-[#e9730c] font-semibold bg-[#fff4e5] px-1.5 py-0.5 rounded">سند ۳۲۱ / ۳۲۲ / ۳۴۴</span>
              </div>

              {quarantineItems.length === 0 ? (
                <div className="text-center py-10 text-xs text-[#666666]">
                  هیچ موجودی فعالی برای عملیات سریع QM-UD یافت نشد.
                </div>
              ) : (
                quarantineItems.map(item => {
                  const isSelected = selectedPartId === item.id || (!selectedPartId && quarantineItems[0]?.id === item.id);
                  return (
                    <div
                      key={item.id}
                      onClick={() => setSelectedPartId(item.id)}
                      className={`p-3 rounded border cursor-pointer transition ${
                        isSelected
                          ? 'bg-[#e5f3fa] border-[#007cc0] shadow-sm'
                          : 'bg-white border-[#d9d9d9] hover:bg-[#f5f5f5]'
                      }`}
                    >
                      <div className="flex items-center justify-between text-xs font-mono font-bold text-[#333333]">
                        <span>{item.code}</span>
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] ${
                            item.hasHeldStock
                              ? 'bg-[#fff4e5] text-[#e9730c] border border-[#f5cba7]'
                              : 'bg-[#ebf5ec] text-[#107e3e] border border-[#b7dfbf]'
                          }`}
                        >
                          {formatNumber(item.qiQty)} {item.unit}
                        </span>
                      </div>
                      <div className="text-xs text-[#333333] font-medium mt-1 truncate">{item.name}</div>
                      <div className="text-[11px] text-[#666666] mt-1 flex items-center justify-between font-mono">
                        <span>{item.lotNumber}</span>
                        <span>{item.hasHeldStock ? 'در قرنطینه/مسدود' : 'آزاد'}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="lg:col-span-8 sap-card p-4 space-y-4">
              {!selectedPart ? (
                <div className="text-center py-14 text-xs text-[#666666]">
                  یک قلم را از لیست سمت راست انتخاب کنید.
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between border-b border-[#e8e8e8] pb-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-base font-bold text-[#333333] font-mono">{selectedPart.code}</h3>
                        <span
                          className={`px-2 py-0.5 rounded text-xs font-semibold ${
                            selectedPart.hasHeldStock
                              ? 'bg-[#fff4e5] text-[#e9730c] border border-[#f5cba7]'
                              : 'bg-[#ebf5ec] text-[#107e3e] border border-[#b7dfbf]'
                          }`}
                        >
                          {selectedPart.hasHeldStock ? 'قرنطینه / مسدود کیفی' : 'موجودی آزاد'}
                        </span>
                      </div>
                      <p className="text-xs text-[#666666] mt-1 font-medium">{selectedPart.name}</p>
                    </div>
                    <div className="text-left font-mono">
                      <div className="text-xs text-[#666666]">مقدار قابل تصمیم‌گیری:</div>
                      <div className="text-sm font-bold text-[#333333]">
                        {formatNumber(selectedPart.qiQty)} {selectedPart.unit}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="text-xs font-bold text-[#333333] flex items-center gap-1.5">
                      <FileText className="w-4 h-4 text-[#007cc0]" />
                      <span>چک‌لیست ترخیص سریع کیفی و اندازه‌برداری CMM:</span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div
                        onClick={() => setCmmPassed(!cmmPassed)}
                        className={`p-3 rounded border cursor-pointer flex items-center justify-between transition ${
                          cmmPassed
                            ? 'bg-[#ebf5ec] border-[#b7dfbf] text-[#107e3e]'
                            : 'bg-[#ffecec] border-[#f5b7b1] text-[#bb0000]'
                        }`}
                      >
                        <span className="text-xs font-semibold">تست ابعادی CMM / فیکسچر</span>
                        {cmmPassed ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}
                      </div>

                      <div
                        onClick={() => setVisualPassed(!visualPassed)}
                        className={`p-3 rounded border cursor-pointer flex items-center justify-between transition ${
                          visualPassed
                            ? 'bg-[#ebf5ec] border-[#b7dfbf] text-[#107e3e]'
                            : 'bg-[#ffecec] border-[#f5b7b1] text-[#bb0000]'
                        }`}
                      >
                        <span className="text-xs font-semibold">بازرسی چشمی و خط و خش سطح</span>
                        {visualPassed ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}
                      </div>

                      <div
                        onClick={() => setBurrPassed(!burrPassed)}
                        className={`p-3 rounded border cursor-pointer flex items-center justify-between transition ${
                          burrPassed
                            ? 'bg-[#ebf5ec] border-[#b7dfbf] text-[#107e3e]'
                            : 'bg-[#ffecec] border-[#f5b7b1] text-[#bb0000]'
                        }`}
                      >
                        <span className="text-xs font-semibold">کنترل پلیسه لبه و ضخامت</span>
                        {burrPassed ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}
                      </div>
                    </div>

                    <textarea
                      value={inspectionNotes}
                      onChange={e => setInspectionNotes(e.target.value)}
                      rows={2}
                      placeholder="یادداشت و نظریه بازرس کنترل کیفیت..."
                      className="w-full bg-white border border-[#bfbfbf] rounded p-2 text-xs text-[#333333] focus:outline-none focus:border-[#007cc0]"
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-[#e8e8e8]">
                    <div className="text-xs text-[#666666]">
                      صدور سند UD به صورت تراکنشی و یکتا سند حرکت انبار (۳۲۱ / ۳۲۲ / ۳۴۴) را ثبت می‌کند.
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => handleUsageDecision('BLOCK_SCRAP')}
                        className="px-3.5 py-1.5 text-xs font-semibold text-[#bb0000] bg-[#ffecec] hover:bg-[#f5b7b1] border border-[#f5b7b1] rounded cursor-pointer flex items-center gap-1.5"
                      >
                        <Lock className="w-3.5 h-3.5" />
                        <span>{selectedPart.hasHeldStock ? 'مسدودسازی قطعی (کد ۳۴۴)' : 'انتقال به قرنطینه (کد ۳۲۲)'}</span>
                      </button>

                      <button
                        type="button"
                        disabled={loading || !selectedPart.hasHeldStock || !cmmPassed || !visualPassed}
                        onClick={() => handleUsageDecision('RELEASE_AVAILABLE')}
                        className="sap-btn-emphasized px-4 py-1.5 text-xs font-semibold cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
                      >
                        <Unlock className="w-3.5 h-3.5" />
                        <span>تایید و ترخیص به آزاد (کد ۳۲۱)</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
