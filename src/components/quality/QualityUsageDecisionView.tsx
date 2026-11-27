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
  QualityDefectParetoRow,
  QualityEntityHistoryResponse,
  QualityInspectionRecord,
  QualityInspectionType,
  QualitySupplierPerformanceRow,
  ReworkOrderRecord,
} from '../../types/quality';
import { formatDateTime, formatNumber, toPersianDigits } from '../../utils/formatters';
import { useEnterpriseUx } from '../../context/EnterpriseUxContext';
import {
  FioriDynamicPage,
  FioriToolbar,
  FioriDataTable,
  FioriTableColumn,
  FioriObjectStatus,
  FioriMessageStrip,
  FioriDialog,
  FioriStatusTone,
} from '../fiori/ui';
import { EmptyState } from '../common/EmptyState';

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

function decisionTone(decision: QualityDecision): FioriStatusTone {
  switch (decision) {
    case 'ACCEPTED':
      return 'positive';
    case 'ACCEPTED_WITH_CONCESSION':
      return 'brand';
    case 'QUARANTINED':
      return 'critical';
    case 'REJECTED':
      return 'negative';
    default:
      return 'neutral';
  }
}

function severityTone(severity: NonconformanceSeverity): FioriStatusTone {
  switch (severity) {
    case 'CRITICAL':
      return 'negative';
    case 'MAJOR':
      return 'critical';
    default:
      return 'neutral';
  }
}

function ncrStatusTone(status: string): FioriStatusTone {
  switch (status) {
    case 'CLOSED':
      return 'positive';
    case 'IN_REWORK':
      return 'brand';
    case 'CONTAINED':
    case 'DISPOSITIONED':
      return 'critical';
    case 'OPEN':
      return 'negative';
    default:
      return 'neutral';
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

  const openNcrCount = useMemo(() => ncrs.filter(n => n.status !== 'CLOSED').length, [ncrs]);
  const activeReworkCount = useMemo(
    () => reworkOrders.filter(r => r.status !== 'COMPLETED' && r.status !== 'CANCELLED').length,
    [reworkOrders]
  );

  const stageColumns: FioriTableColumn<QualityDashboardAnalytics['byInspectionType'][number]>[] = [
    {
      key: 'labelFa',
      header: 'مرحله بازرسی',
      render: row => <span className="font-medium text-[var(--fiori-text-primary)]">{row.labelFa}</span>,
    },
    {
      key: 'totalCount',
      header: 'تعداد',
      align: 'center',
      isMono: true,
      render: row => toPersianDigits(row.totalCount),
    },
    {
      key: 'acceptedCount',
      header: 'تایید',
      align: 'center',
      isMono: true,
      cellClassName: 'text-[var(--fiori-positive)] font-semibold',
      render: row => toPersianDigits(row.acceptedCount),
    },
    {
      key: 'rejectedCount',
      header: 'رد',
      align: 'center',
      isMono: true,
      cellClassName: 'text-[var(--fiori-negative)] font-semibold',
      render: row => toPersianDigits(row.rejectedCount),
    },
    {
      key: 'rejectedQty',
      header: 'مقدار ردشده',
      align: 'center',
      isMono: true,
      render: row => formatNumber(row.rejectedQty),
    },
    {
      key: 'passRatePercent',
      header: 'نرخ قبولی',
      align: 'center',
      render: row => (
        <FioriObjectStatus
          tone={
            row.passRatePercent === null || row.passRatePercent === undefined
              ? 'neutral'
              : row.passRatePercent >= 95
              ? 'positive'
              : row.passRatePercent >= 85
              ? 'critical'
              : 'negative'
          }
          label={formatRate(row.passRatePercent)}
          variant="text"
        />
      ),
    },
  ];

  const defectParetoColumns: FioriTableColumn<QualityDefectParetoRow>[] = [
    {
      key: 'defectCode',
      header: 'کد و شرح عیب',
      render: row => (
        <div className="font-medium text-[var(--fiori-text-primary)] flex items-center gap-1.5 flex-wrap">
          <span className="fiori-ltr-code font-mono text-[var(--fiori-brand)] font-semibold">
            {row.defectCode}
          </span>
          <span>{row.defectLabelFa}</span>
          {row.isRecurring && <FioriObjectStatus tone="negative" label="تکرارشونده" />}
        </div>
      ),
    },
    {
      key: 'occurrenceCount',
      header: 'تکرار',
      align: 'center',
      isMono: true,
      render: row => toPersianDigits(row.occurrenceCount),
    },
    {
      key: 'affectedQty',
      header: 'مقدار',
      align: 'center',
      isMono: true,
      render: row => formatNumber(row.affectedQty),
    },
    {
      key: 'sharePercent',
      header: 'سهم',
      align: 'center',
      isMono: true,
      render: row => formatRate(row.sharePercent),
    },
  ];

  const supplierColumns: FioriTableColumn<QualitySupplierPerformanceRow>[] = [
    {
      key: 'supplierName',
      header: 'تامین‌کننده',
      render: sup => (
        <span className="font-semibold text-[var(--fiori-text-primary)]">{sup.supplierName}</span>
      ),
    },
    {
      key: 'totalInspections',
      header: 'بازرسی',
      align: 'center',
      isMono: true,
      render: sup => toPersianDigits(sup.totalInspections),
    },
    {
      key: 'rejectedInspections',
      header: 'ردشده',
      align: 'center',
      isMono: true,
      cellClassName: 'text-[var(--fiori-negative)] font-semibold',
      render: sup => toPersianDigits(sup.rejectedInspections),
    },
    {
      key: 'openNcrCount',
      header: 'NCR باز',
      align: 'center',
      isMono: true,
      cellClassName: 'text-[var(--fiori-critical)] font-semibold',
      render: sup => toPersianDigits(sup.openNcrCount),
    },
    {
      key: 'rejectionRatePercent',
      header: 'نرخ رد',
      align: 'center',
      isMono: true,
      render: sup => formatRate(sup.rejectionRatePercent),
    },
    {
      key: 'qualityScorePercent',
      header: 'امتیاز کیفیت',
      align: 'center',
      render: sup => (
        <FioriObjectStatus
          tone={
            sup.qualityScorePercent === null || sup.qualityScorePercent === undefined
              ? 'neutral'
              : sup.qualityScorePercent >= 95
              ? 'positive'
              : sup.qualityScorePercent >= 85
              ? 'critical'
              : 'negative'
          }
          label={formatRate(sup.qualityScorePercent)}
          variant="text"
        />
      ),
    },
  ];

  const byPartColumns: FioriTableColumn<QualityDashboardAnalytics['byPart'][number]>[] = [
    {
      key: 'partCode',
      header: 'قطعه',
      render: p => (
        <button
          type="button"
          onClick={() => jumpToHistory({ partCode: p.partCode })}
          className="text-right hover:underline text-[var(--fiori-brand)] cursor-pointer"
        >
          <span className="fiori-ltr-code font-mono font-bold">{p.partCode}</span> — {p.partName}
        </button>
      ),
    },
    {
      key: 'inspectionCount',
      header: 'بازرسی',
      align: 'center',
      isMono: true,
      render: p => toPersianDigits(p.inspectionCount),
    },
    {
      key: 'ncrCount',
      header: 'NCR',
      align: 'center',
      isMono: true,
      render: p => toPersianDigits(p.ncrCount),
    },
    {
      key: 'rejectedQty',
      header: 'ردشده',
      align: 'center',
      isMono: true,
      cellClassName: 'text-[var(--fiori-negative)] font-semibold',
      render: p => formatNumber(p.rejectedQty),
    },
    {
      key: 'rejectionRatePercent',
      header: 'نرخ رد',
      align: 'center',
      isMono: true,
      render: p => formatRate(p.rejectionRatePercent),
    },
  ];

  const inspectionColumns: FioriTableColumn<QualityInspectionRecord>[] = [
    {
      key: 'inspectionNumber',
      header: 'شماره بازرسی',
      sortable: true,
      sortValue: insp => insp.inspectionNumber,
      render: insp => (
        <div>
          <div className="fiori-ltr-code font-mono font-bold text-[var(--fiori-brand)]">
            {insp.inspectionNumber}
          </div>
          <div className="text-[10px] text-[var(--fiori-text-secondary)]">
            {formatDateTime(insp.createdAt)}
          </div>
        </div>
      ),
    },
    {
      key: 'inspectionType',
      header: 'نوع',
      sortable: true,
      sortValue: insp => catalog?.inspectionTypeLabels?.[insp.inspectionType] || insp.inspectionType,
      render: insp => (
        <span className="text-[11px] font-medium text-[var(--fiori-text-primary)]">
          {catalog?.inspectionTypeLabels?.[insp.inspectionType] || insp.inspectionType}
        </span>
      ),
    },
    {
      key: 'partCode',
      header: 'قطعه / ردیابی (بچ / کلاف / MO)',
      sortable: true,
      sortValue: insp => insp.partCode,
      render: insp => (
        <div>
          <div className="font-semibold text-[var(--fiori-text-primary)]">
            <span className="fiori-ltr-code font-mono">{insp.partCode}</span> — {insp.partName}
          </div>
          <div className="text-[11px] text-[var(--fiori-text-secondary)] flex flex-wrap gap-2 mt-0.5 font-mono">
            {insp.lotNumber && <span className="fiori-ltr-code">بچ: {insp.lotNumber}</span>}
            {insp.coilId && <span className="fiori-ltr-code">کلاف: {insp.coilId}</span>}
            {insp.moNumber && (
              <span className="fiori-ltr-code">
                MO: {insp.moNumber}
                {insp.operationCode ? ` / ${insp.operationCode}` : ''}
              </span>
            )}
            {insp.supplierName && (
              <span className="font-sans">تامین‌کننده: {insp.supplierName}</span>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'inspectedQty',
      header: 'مقدار (قبول/دوباره/رد)',
      align: 'center',
      sortable: true,
      sortValue: insp => insp.inspectedQty,
      isMono: true,
      render: insp => (
        <div>
          <div className="font-bold text-[var(--fiori-text-primary)]">
            {formatNumber(insp.inspectedQty)} {insp.unit}
          </div>
          <div className="text-[10px] text-[var(--fiori-text-secondary)]">
            <span className="text-[var(--fiori-positive)]">{formatNumber(insp.acceptedQty)}</span> /{' '}
            <span className="text-[var(--fiori-critical)]">{formatNumber(insp.reworkQty)}</span> /{' '}
            <span className="text-[var(--fiori-negative)]">{formatNumber(insp.rejectedQty)}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'decision',
      header: 'تصمیم',
      align: 'center',
      sortable: true,
      sortValue: insp => DECISION_LABELS_FA[insp.decision],
      render: insp => (
        <FioriObjectStatus tone={decisionTone(insp.decision)} label={DECISION_LABELS_FA[insp.decision]} />
      ),
    },
    {
      key: 'linkedDocs',
      header: 'اسناد متصل',
      isMono: true,
      render: insp => (
        <div className="text-[11px] text-[var(--fiori-text-secondary)] space-y-0.5">
          {insp.linkedQmDocumentNumber && (
            <div className="fiori-ltr-code">QM: {insp.linkedQmDocumentNumber}</div>
          )}
          {insp.linkedNcrNumber && (
            <div className="fiori-ltr-code text-[var(--fiori-negative)]">
              NCR: {insp.linkedNcrNumber}
            </div>
          )}
          {!insp.linkedQmDocumentNumber && !insp.linkedNcrNumber && <span>—</span>}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'عملیات',
      align: 'center',
      render: insp => (
        <div className="flex items-center justify-center gap-1.5">
          {(insp.status !== 'COMPLETED' ||
            insp.decision === 'QUARANTINED' ||
            insp.decision === 'PENDING') && (
            <button
              type="button"
              onClick={() => openDecidePanel(insp)}
              className="sap-btn-emphasized px-2.5 py-1 text-[11px] font-semibold cursor-pointer"
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
            className="sap-btn-standard px-2 py-1 text-[11px] cursor-pointer"
          >
            ردیابی
          </button>
        </div>
      ),
    },
  ];

  const ncrColumns: FioriTableColumn<NonconformanceRecord>[] = [
    {
      key: 'ncrNumber',
      header: 'شماره NCR',
      sortable: true,
      sortValue: ncr => ncr.ncrNumber,
      render: ncr => (
        <div>
          <div className="fiori-ltr-code font-mono font-bold text-[var(--fiori-negative)]">
            {ncr.ncrNumber}
          </div>
          <div className="text-[10px] text-[var(--fiori-text-secondary)]">
            {formatDateTime(ncr.createdAt)}
          </div>
          {ncr.inspectionNumber && (
            <div className="text-[10px] font-mono text-[var(--fiori-brand)] fiori-ltr-code">
              از: {ncr.inspectionNumber}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'partCode',
      header: 'قطعه و ردیابی',
      sortable: true,
      sortValue: ncr => ncr.partCode,
      render: ncr => (
        <div>
          <div className="font-semibold text-[var(--fiori-text-primary)]">
            <span className="fiori-ltr-code font-mono">{ncr.partCode}</span> — {ncr.partName}
          </div>
          <div className="text-[11px] text-[var(--fiori-text-secondary)] font-mono flex flex-wrap gap-2 mt-0.5">
            {ncr.lotNumber && <span className="fiori-ltr-code">بچ: {ncr.lotNumber}</span>}
            {ncr.coilId && <span className="fiori-ltr-code">کلاف: {ncr.coilId}</span>}
            {ncr.moNumber && <span className="fiori-ltr-code">MO: {ncr.moNumber}</span>}
            {ncr.linkedReworkNumber && (
              <span className="fiori-ltr-code text-[var(--fiori-brand)]">
                Rework: {ncr.linkedReworkNumber}
              </span>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'defectCode',
      header: 'عیب و شدت',
      sortable: true,
      sortValue: ncr => ncr.defectCode,
      render: ncr => (
        <div>
          <div className="flex items-center gap-1.5">
            <FioriObjectStatus tone={severityTone(ncr.severity)} label={SEVERITY_LABELS_FA[ncr.severity]} />
            <span className="fiori-ltr-code font-mono text-[var(--fiori-text-primary)] font-semibold">
              {ncr.defectCode}
            </span>
          </div>
          <div className="text-[11px] text-[var(--fiori-text-secondary)] mt-0.5">{ncr.defectLabelFa}</div>
        </div>
      ),
    },
    {
      key: 'affectedQty',
      header: 'مقدار',
      align: 'center',
      sortable: true,
      sortValue: ncr => ncr.affectedQty,
      isMono: true,
      render: ncr => (
        <div>
          <div className="font-bold text-[var(--fiori-text-primary)]">
            {formatNumber(ncr.affectedQty)} {ncr.unit}
          </div>
          {ncr.containedQty > 0 && (
            <div className="text-[10px] text-[var(--fiori-critical)]">
              مهارشده: {formatNumber(ncr.containedQty)}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'وضعیت / تعیین تکلیف',
      align: 'center',
      sortable: true,
      sortValue: ncr => NCR_STATUS_LABELS_FA[ncr.status] || ncr.status,
      render: ncr => (
        <div className="flex flex-col items-center gap-1">
          <FioriObjectStatus
            tone={ncrStatusTone(ncr.status)}
            label={NCR_STATUS_LABELS_FA[ncr.status] || ncr.status}
          />
          <span className="text-[10px] text-[var(--fiori-text-secondary)]">
            {DISPOSITION_LABELS_FA[ncr.disposition] || ncr.disposition}
          </span>
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'عملیات',
      align: 'center',
      render: ncr => (
        <div className="flex items-center justify-center gap-1.5 flex-wrap">
          {ncr.status === 'OPEN' && (
            <button
              type="button"
              onClick={() => setContainingNcr(ncr)}
              className="px-2 py-1 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-critical)] text-white text-[11px] font-semibold cursor-pointer hover:opacity-90"
            >
              مهار فوری
            </button>
          )}
          {ncr.status !== 'CLOSED' && ncr.status !== 'IN_REWORK' && (
            <button
              type="button"
              onClick={() => openDispositionPanel(ncr)}
              className="sap-btn-emphasized px-2 py-1 text-[11px] font-semibold cursor-pointer"
            >
              تعیین تکلیف
            </button>
          )}
          {ncr.status === 'IN_REWORK' && (
            <button
              type="button"
              onClick={() => setActiveTab('REWORK')}
              className="px-2 py-1 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border border-[var(--fiori-brand-border)] text-[11px] font-semibold cursor-pointer"
            >
              مشاهده دوباره‌کاری
            </button>
          )}
        </div>
      ),
    },
  ];

  const reworkColumns: FioriTableColumn<ReworkOrderRecord>[] = [
    {
      key: 'reworkNumber',
      header: 'شماره دوباره‌کاری / NCR',
      sortable: true,
      sortValue: rew => rew.reworkNumber,
      render: rew => (
        <div>
          <div className="fiori-ltr-code font-mono font-bold text-[var(--fiori-brand)]">
            {rew.reworkNumber}
          </div>
          <div className="fiori-ltr-code text-[11px] font-mono text-[var(--fiori-negative)]">
            NCR: {rew.ncrNumber}
          </div>
          {rew.moNumber && (
            <div className="fiori-ltr-code text-[10px] font-mono text-[var(--fiori-text-secondary)]">
              MO: {rew.moNumber}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'partCode',
      header: 'قطعه و دستورالعمل',
      sortable: true,
      sortValue: rew => rew.partCode,
      render: rew => (
        <div>
          <div className="font-semibold text-[var(--fiori-text-primary)]">
            <span className="fiori-ltr-code font-mono">{rew.partCode}</span> — {rew.partName}
          </div>
          <div className="text-[11px] text-[var(--fiori-text-secondary)] mt-0.5">{rew.instructions}</div>
        </div>
      ),
    },
    {
      key: 'plannedReworkQty',
      header: 'برنامه‌ای / سالم / ضایعات / باقیمانده',
      align: 'center',
      isMono: true,
      render: rew => (
        <div>
          <span>{formatNumber(rew.plannedReworkQty)}</span> /{' '}
          <span className="text-[var(--fiori-positive)] font-bold">
            {formatNumber(rew.completedGoodQty)}
          </span>{' '}
          /{' '}
          <span className="text-[var(--fiori-negative)]">{formatNumber(rew.scrappedQty)}</span> /{' '}
          <span className="text-[var(--fiori-critical)] font-bold">
            {formatNumber(rew.remainingQty)}
          </span>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'وضعیت',
      align: 'center',
      sortable: true,
      sortValue: rew => REWORK_STATUS_LABELS_FA[rew.status] || rew.status,
      render: rew => (
        <FioriObjectStatus
          tone={
            rew.status === 'COMPLETED'
              ? 'positive'
              : rew.status === 'CANCELLED'
              ? 'neutral'
              : 'critical'
          }
          label={REWORK_STATUS_LABELS_FA[rew.status] || rew.status}
        />
      ),
    },
    {
      key: 'docs',
      header: 'اسناد انبار',
      isMono: true,
      render: rew => (
        <div className="text-[11px] text-[var(--fiori-text-secondary)] space-y-0.5">
          {rew.returnDocumentNumber && (
            <div className="fiori-ltr-code text-[var(--fiori-positive)]">
              ترخیص: {rew.returnDocumentNumber}
            </div>
          )}
          {rew.scrapDocumentNumber && (
            <div className="fiori-ltr-code text-[var(--fiori-negative)]">
              ضایعات: {rew.scrapDocumentNumber}
            </div>
          )}
          {!rew.returnDocumentNumber && !rew.scrapDocumentNumber && <span>—</span>}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'عملیات',
      align: 'center',
      render: rew =>
        rew.status !== 'COMPLETED' && rew.status !== 'CANCELLED' ? (
          <button
            type="button"
            onClick={() => openCompleteRework(rew)}
            className="px-2.5 py-1 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-positive)] text-white text-[11px] font-semibold cursor-pointer hover:opacity-90"
          >
            ثبت نتیجه
          </button>
        ) : (
          <FioriObjectStatus
            tone="positive"
            variant="text"
            icon={<CheckCircle2 className="w-3.5 h-3.5" />}
            label="تکمیل"
          />
        ),
    },
  ];

  const hasInspFilters =
    inspTypeFilter !== 'ALL' || inspDecisionFilter !== 'ALL' || Boolean(inspSearch.trim());
  const hasNcrFilters = ncrStatusFilter !== 'ALL' || ncrSeverityFilter !== 'ALL';

  return (
    <FioriDynamicPage
      title="مدیریت کیفیت و کنترل محصول (KPIMS QM — بازرسی، NCR، دوباره‌کاری و ردیابی)"
      subtitle="بازرسی ورودی (IQC)، حین فرآیند (IPQC) و نهایی (FQC)، ثبت و مهار عدم انطباق، دوباره‌کاری، مسدودسازی خودکار مصرف و گزارش تامین‌کنندگان"
      status={
        <div className="flex items-center gap-1.5">
          <ShieldCheck className="w-4 h-4 text-[var(--fiori-brand)]" />
          <FioriObjectStatus
            tone={openNcrCount > 0 ? 'critical' : 'positive'}
            label={`${toPersianDigits(openNcrCount)} عدم انطباق باز`}
          />
        </div>
      }
      collapsibleFilters={false}
      headerActions={
        <div className="flex items-center gap-1.5 flex-wrap">
          {(
            [
              { id: 'DASHBOARD', label: '۱. پیشخوان و گزارش کیفیت', icon: BarChart3 },
              {
                id: 'INSPECTIONS',
                label: `۲. بازرسی‌ها (${toPersianDigits(inspections.length)})`,
                icon: ClipboardCheck,
              },
              {
                id: 'NCR',
                label: `۳. عدم انطباق NCR (${toPersianDigits(openNcrCount)})`,
                icon: AlertTriangle,
              },
              {
                id: 'REWORK',
                label: `۴. دوباره‌کاری (${toPersianDigits(activeReworkCount)})`,
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
                className={`px-3 py-1.5 rounded-[var(--fiori-radius-sm)] text-xs font-semibold cursor-pointer transition flex items-center gap-1.5 ${
                  active
                    ? 'bg-[var(--fiori-brand)] text-white shadow-xs'
                    : 'bg-[var(--fiori-bg-subtle)] text-[var(--fiori-text-primary)] border border-[var(--fiori-border-default)] hover:bg-[var(--fiori-brand-bg)]'
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
            className="sap-btn-standard px-2.5 py-1.5 text-xs font-semibold cursor-pointer flex items-center gap-1"
            title="به‌روزرسانی داده‌های کنترل کیفیت"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>به‌روزرسانی</span>
          </button>
        </div>
      }
    >
      {/* Toast Notification */}
      {toast && (
        <FioriMessageStrip
          tone={toast.type === 'success' ? 'success' : 'error'}
          onClose={() => setToast(null)}
        >
          {toast.text}
        </FioriMessageStrip>
      )}

      {/* ================================================================= */}
      {/* TAB 1: QUALITY DASHBOARD, DEFECT PARETO & SUPPLIER PERFORMANCE    */}
      {/* ================================================================= */}
      {activeTab === 'DASHBOARD' && (
        <div className="space-y-3">
          {/* Filters & Export Bar */}
          <FioriToolbar
            variant="page"
            startContent={
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <label className="text-[var(--fiori-text-secondary)] font-medium">مرحله بازرسی:</label>
                <select
                  value={dashTypeFilter}
                  onChange={e => setDashTypeFilter(e.target.value)}
                  className="border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2 py-1 text-xs bg-white text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-border-focus)]"
                >
                  <option value="ALL">همه مراحل (ورودی، حین فرآیند، نهایی)</option>
                  <option value="INCOMING_MATERIAL">بازرسی ورودی مواد و کلاف (IQC)</option>
                  <option value="IN_PROCESS">بازرسی حین فرآیند (IPQC)</option>
                  <option value="FINAL_PRODUCT">بازرسی محصول نهایی (FQC)</option>
                </select>

                <label className="text-[var(--fiori-text-secondary)] font-medium mr-2">
                  تامین‌کننده:
                </label>
                <input
                  type="text"
                  value={dashSupplierFilter}
                  onChange={e => setDashSupplierFilter(e.target.value)}
                  placeholder="فیلتر نام تامین‌کننده..."
                  className="border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1 text-xs bg-white text-[var(--fiori-text-primary)] w-44 focus:outline-none focus:border-[var(--fiori-border-focus)]"
                />
              </div>
            }
            endContent={
              <button
                type="button"
                onClick={handleExportCsv}
                className="px-3 py-1.5 rounded-[var(--fiori-radius-sm)] text-xs font-semibold bg-[var(--fiori-positive)] text-white hover:opacity-90 cursor-pointer flex items-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" />
                <span>خروجی گزارش کیفیت (CSV)</span>
              </button>
            }
          />

          {dashboard?.summary.dataQualityNoteFa && (
            <FioriMessageStrip tone="warning" compact>
              {dashboard.summary.dataQualityNoteFa}
            </FioriMessageStrip>
          )}

          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 tabular-nums">
            <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)] p-3.5 space-y-1">
              <div className="text-xs text-[var(--fiori-text-secondary)]">کل بازرسی‌های ثبت‌شده</div>
              <div className="text-xl font-bold text-[var(--fiori-brand)] font-mono">
                {toPersianDigits(dashboard?.summary.totalInspections ?? 0)}
              </div>
              <div className="text-[11px] text-[var(--fiori-text-secondary)]">
                تکمیل‌شده: {toPersianDigits(dashboard?.summary.completedInspections ?? 0)} | در انتظار:{' '}
                {toPersianDigits(dashboard?.summary.pendingInspections ?? 0)}
              </div>
            </div>

            <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)] p-3.5 space-y-1">
              <div className="text-xs text-[var(--fiori-text-secondary)]">نرخ رد کیفی کل</div>
              <div className="text-xl font-bold text-[var(--fiori-negative)] font-mono">
                {formatRate(dashboard?.summary.overallRejectionRatePercent)}
              </div>
              <div className="text-[11px] text-[var(--fiori-text-secondary)]">
                قبولی ورودی: {formatRate(dashboard?.summary.incomingAcceptanceRatePercent)} | نهایی:{' '}
                {formatRate(dashboard?.summary.finalPassRatePercent)}
              </div>
            </div>

            <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)] p-3.5 space-y-1">
              <div className="text-xs text-[var(--fiori-text-secondary)]">عدم انطباق‌های باز (NCR)</div>
              <div className="text-xl font-bold text-[var(--fiori-critical)] font-mono">
                {toPersianDigits(dashboard?.summary.openNcrCount ?? 0)}
              </div>
              <div className="text-[11px] text-[var(--fiori-negative)]">
                بحرانی باز: {toPersianDigits(dashboard?.summary.criticalOpenNcrCount ?? 0)} از کل{' '}
                {toPersianDigits(dashboard?.summary.totalNcrCount ?? 0)}
              </div>
            </div>

            <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)] p-3.5 space-y-1">
              <div className="text-xs text-[var(--fiori-text-secondary)]">
                موجودی قفل‌شده در انبار (غیرقابل مصرف)
              </div>
              <div className="text-xl font-bold text-[var(--fiori-text-primary)] font-mono">
                {formatNumber(
                  (dashboard?.summary.quarantinedStockQty ?? 0) +
                    (dashboard?.summary.blockedStockQty ?? 0)
                )}
              </div>
              <div className="text-[11px] text-[var(--fiori-text-secondary)]">
                قرنطینه QI: {formatNumber(dashboard?.summary.quarantinedStockQty ?? 0)} | مسدود:{' '}
                {formatNumber(dashboard?.summary.blockedStockQty ?? 0)} | دوباره‌کاری فعال:{' '}
                {toPersianDigits(dashboard?.summary.activeReworkOrdersCount ?? 0)}
              </div>
            </div>
          </div>

          {/* Stage Performance & Defect Pareto */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <FioriDataTable
              columns={stageColumns}
              data={dashboard?.byInspectionType || []}
              rowKey={row => row.inspectionType}
              loading={loading}
              toolbar={
                <FioriToolbar
                  variant="table"
                  title="عملکرد کیفیت به تفکیک مرحله بازرسی"
                  count={(dashboard?.byInspectionType || []).length}
                  countLabel="مرحله"
                />
              }
              emptyState={
                <EmptyState
                  compact
                  variant="NO_DATA"
                  title="داده‌ای برای مراحل بازرسی ثبت نشده است"
                  description="با ثبت اولین برگه بازرسی، آمار عملکرد مراحل IQC، IPQC و FQC نمایش داده می‌شود."
                />
              }
            />

            <FioriDataTable
              columns={defectParetoColumns}
              data={dashboard?.defectPareto || []}
              rowKey={row => row.defectCode}
              loading={loading}
              toolbar={
                <FioriToolbar
                  variant="table"
                  title="پارتوی عیوب و ایرادات تکرارشونده (Defect Pareto)"
                  endContent={
                    <FioriObjectStatus
                      tone={(dashboard?.recurringIssues.length ?? 0) > 0 ? 'negative' : 'positive'}
                      label={`تکرارشونده: ${toPersianDigits(dashboard?.recurringIssues.length ?? 0)} مورد`}
                    />
                  }
                />
              }
              emptyState={
                <EmptyState
                  compact
                  variant="CUSTOM"
                  icon={CheckCircle2}
                  title="عیب یا عدم انطباقی ثبت نشده است"
                  description="هنوز عیب یا عدم انطباقی در سیستم گزارش نشده است."
                />
              }
            />
          </div>

          {/* Supplier Performance & Part Quality */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <FioriDataTable
              columns={supplierColumns}
              data={dashboard?.supplierPerformance || []}
              rowKey={sup => sup.supplierName}
              loading={loading}
              toolbar={
                <FioriToolbar
                  variant="table"
                  title="کارنامه کیفی تامین‌کنندگان (Supplier Quality Performance)"
                  count={dashboard?.supplierPerformance.length ?? 0}
                  countLabel="تامین‌کننده"
                />
              }
              emptyState={
                <EmptyState
                  compact
                  variant="NO_DATA"
                  title="کارنامه تامین‌کنندگان خالی است"
                  description="بازرسی ورودی یا عدم انطباق متصل به تامین‌کننده ثبت نشده است."
                />
              }
            />

            <FioriDataTable
              columns={byPartColumns}
              data={(dashboard?.byPart || []).slice(0, 10)}
              rowKey={p => p.partId}
              loading={loading}
              toolbar={
                <FioriToolbar
                  variant="table"
                  title="کیفیت به تفکیک قطعه / ماده اولیه"
                  count={(dashboard?.byPart || []).slice(0, 10).length}
                  countLabel="قطعه"
                />
              }
              emptyState={
                <EmptyState
                  compact
                  variant="NO_DATA"
                  title="رکورد کیفی قطعات موجود نیست"
                  description="رکورد کیفی برای قطعات ثبت نشده است."
                />
              }
            />
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* TAB 2: INCOMING, IN-PROCESS & FINAL PRODUCT INSPECTIONS           */}
      {/* ================================================================= */}
      {activeTab === 'INSPECTIONS' && (
        <div className="space-y-3">
          <FioriToolbar
            variant="page"
            startContent={
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <select
                  value={inspTypeFilter}
                  onChange={e => setInspTypeFilter(e.target.value)}
                  className="border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2 py-1.5 text-xs bg-white text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-border-focus)]"
                >
                  <option value="ALL">همه انواع بازرسی</option>
                  <option value="INCOMING_MATERIAL">بازرسی ورودی (IQC)</option>
                  <option value="IN_PROCESS">بازرسی حین فرآیند (IPQC)</option>
                  <option value="FINAL_PRODUCT">بازرسی محصول نهایی (FQC)</option>
                </select>

                <select
                  value={inspDecisionFilter}
                  onChange={e => setInspDecisionFilter(e.target.value)}
                  className="border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2 py-1.5 text-xs bg-white text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-border-focus)]"
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
                  className="border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1.5 text-xs bg-white text-[var(--fiori-text-primary)] w-56 focus:outline-none focus:border-[var(--fiori-border-focus)]"
                />
              </div>
            }
            endContent={
              <button
                type="button"
                onClick={() => setShowNewInspectionForm(true)}
                className="sap-btn-emphasized px-3.5 py-1.5 text-xs font-semibold cursor-pointer flex items-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>ثبت برگه بازرسی جدید</span>
              </button>
            }
          />

          {/* Inspections Table */}
          <FioriDataTable
            columns={inspectionColumns}
            data={filteredInspections}
            rowKey={insp => insp.id}
            loading={loading}
            toolbar={
              <FioriToolbar
                variant="table"
                title="فهرست برگه‌های بازرسی کیفی (IQC / IPQC / FQC)"
                count={filteredInspections.length}
                countLabel="برگه بازرسی"
              />
            }
            emptyState={
              <EmptyState
                compact
                variant={hasInspFilters ? 'FILTER_NO_MATCH' : 'NO_DATA'}
                title="برگه بازرسی یافت نشد"
                description="هیچ برگه بازرسی با این فیلترها یافت نشد. از دکمه «ثبت برگه بازرسی جدید» استفاده کنید."
                actionLabel={hasInspFilters ? 'پاک‌کردن فیلترها' : 'ثبت برگه بازرسی جدید'}
                onAction={
                  hasInspFilters
                    ? () => {
                        setInspTypeFilter('ALL');
                        setInspDecisionFilter('ALL');
                        setInspSearch('');
                      }
                    : () => setShowNewInspectionForm(true)
                }
              />
            }
          />
        </div>
      )}

      {/* ================================================================= */}
      {/* TAB 3: NONCONFORMANCE (NCR), CONTAINMENT & DISPOSITION            */}
      {/* ================================================================= */}
      {activeTab === 'NCR' && (
        <div className="space-y-3">
          <FioriToolbar
            variant="page"
            startContent={
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <select
                  value={ncrStatusFilter}
                  onChange={e => setNcrStatusFilter(e.target.value)}
                  className="border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2 py-1.5 text-xs bg-white text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-border-focus)]"
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
                  className="border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2 py-1.5 text-xs bg-white text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-border-focus)]"
                >
                  <option value="ALL">همه سطوح شدت</option>
                  <option value="CRITICAL">بحرانی (Critical)</option>
                  <option value="MAJOR">عمده (Major)</option>
                  <option value="MINOR">جزئی (Minor)</option>
                </select>
              </div>
            }
            endContent={
              <button
                type="button"
                onClick={() => setShowNewNcrForm(true)}
                className="px-3.5 py-1.5 rounded-[var(--fiori-radius-sm)] text-xs font-semibold bg-[var(--fiori-negative)] text-white hover:opacity-90 cursor-pointer flex items-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>ثبت عدم انطباق جدید (NCR)</span>
              </button>
            }
          />

          {/* NCR Table */}
          <FioriDataTable
            columns={ncrColumns}
            data={filteredNcrs}
            rowKey={ncr => ncr.id}
            loading={loading}
            toolbar={
              <FioriToolbar
                variant="table"
                title="فهرست گزارش‌های عدم انطباق (NCR)"
                count={filteredNcrs.length}
                countLabel="گزارش NCR"
              />
            }
            emptyState={
              <EmptyState
                compact
                variant={hasNcrFilters ? 'FILTER_NO_MATCH' : 'NO_DATA'}
                title="گزارش عدم انطباقی یافت نشد"
                description="هیچ گزارش عدم انطباقی با این فیلترها وجود ندارد."
                actionLabel={hasNcrFilters ? 'پاک‌کردن فیلترها' : undefined}
                onAction={
                  hasNcrFilters
                    ? () => {
                        setNcrStatusFilter('ALL');
                        setNcrSeverityFilter('ALL');
                      }
                    : undefined
                }
              />
            }
          />
        </div>
      )}

      {/* ================================================================= */}
      {/* TAB 4: REWORK, SCRAP & RETURN-TO-PRODUCTION WORKFLOWS             */}
      {/* ================================================================= */}
      {activeTab === 'REWORK' && (
        <div className="space-y-3">
          <FioriDataTable
            columns={reworkColumns}
            data={reworkOrders}
            rowKey={rew => rew.id}
            loading={loading}
            toolbar={
              <FioriToolbar
                variant="table"
                title="دستورهای دوباره‌کاری و اصلاح محصول (Rework Orders)"
                count={reworkOrders.length}
                countLabel="دستور کار"
                endContent={
                  <FioriObjectStatus
                    tone={activeReworkCount > 0 ? 'critical' : 'positive'}
                    label={`فعال: ${toPersianDigits(activeReworkCount)}`}
                  />
                }
              />
            }
            emptyState={
              <EmptyState
                compact
                variant="NO_DATA"
                title="دستور دوباره‌کاری ثبت نشده است"
                description="هنوز دستور دوباره‌کاری ایجاد نشده است. برای ایجاد، از تب «عدم انطباق NCR» گزینه «تعیین تکلیف ← دوباره‌کاری» را اجرا کنید."
              />
            }
          />
        </div>
      )}

      {/* ================================================================= */}
      {/* TAB 5: QUALITY TRACEABILITY HISTORY & PRESERVED QM-UD WORKBENCH   */}
      {/* ================================================================= */}
      {activeTab === 'UD_AND_HISTORY' && (
        <div className="space-y-4">
          {/* Traceability Lookup Card */}
          <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)] p-4 space-y-4">
            <FioriToolbar
              variant="section"
              title="وضعیت کیفی و تاریخچه ردیابی (بر اساس بچ، کلاف فیزیکی، دستور ساخت یا کد قطعه)"
              startContent={<Search className="w-4 h-4 text-[var(--fiori-brand)]" />}
            />

            <div className="grid grid-cols-1 sm:grid-cols-5 gap-2 text-xs">
              <input
                type="text"
                value={historyLot}
                onChange={e => setHistoryLot(e.target.value)}
                placeholder="شماره بچ / لات (Lot)"
                className="border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 font-mono bg-white text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-border-focus)]"
              />
              <input
                type="text"
                value={historyCoil}
                onChange={e => setHistoryCoil(e.target.value)}
                placeholder="شماره کلاف (Coil ID)"
                className="border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 font-mono bg-white text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-border-focus)]"
              />
              <input
                type="text"
                value={historyMo}
                onChange={e => setHistoryMo(e.target.value)}
                placeholder="شماره دستور کار (MO)"
                className="border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 font-mono bg-white text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-border-focus)]"
              />
              <input
                type="text"
                value={historyPartCode}
                onChange={e => setHistoryPartCode(e.target.value)}
                placeholder="کد قطعه (Part Code)"
                className="border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 font-mono bg-white text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-border-focus)]"
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
              <div className="space-y-3 pt-2 border-t border-[var(--fiori-border-subtle)]">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs tabular-nums">
                  <div className="p-2.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)]">
                    <div className="text-[11px] text-[var(--fiori-text-secondary)]">وضعیت کیفی فعلی</div>
                    <div className="font-bold text-[var(--fiori-brand)] mt-0.5">
                      {QUALITY_STATUS_LABELS_FA[historyData.currentQualityStatus] ||
                        historyData.currentQualityStatus}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)]">
                    <div className="text-[11px] text-[var(--fiori-text-secondary)]">موجودی فیزیکی</div>
                    <div className="font-bold font-mono mt-0.5 text-[var(--fiori-text-primary)]">
                      {formatNumber(historyData.stockSummary.physicalQty)}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-positive-bg)] border border-[var(--fiori-positive-border)]">
                    <div className="text-[11px] text-[var(--fiori-positive)]">آزاد قابل مصرف</div>
                    <div className="font-bold font-mono text-[var(--fiori-positive)] mt-0.5">
                      {formatNumber(historyData.stockSummary.availableQty)}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-critical-bg)] border border-[var(--fiori-critical-border)]">
                    <div className="text-[11px] text-[var(--fiori-critical)]">قرنطینه (QI)</div>
                    <div className="font-bold font-mono text-[var(--fiori-critical)] mt-0.5">
                      {formatNumber(historyData.stockSummary.qualityInspectionQty)}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-negative-bg)] border border-[var(--fiori-negative-border)]">
                    <div className="text-[11px] text-[var(--fiori-negative)]">مسدود / رد کیفی</div>
                    <div className="font-bold font-mono text-[var(--fiori-negative)] mt-0.5">
                      {formatNumber(historyData.stockSummary.blockedQty)}
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="text-xs font-bold text-[var(--fiori-text-primary)]">
                    خط زمانی رویدادهای کیفی ({toPersianDigits(historyData.timeline.length)} رویداد):
                  </div>
                  {historyData.timeline.length === 0 ? (
                    <EmptyState
                      compact
                      variant="NO_DATA"
                      title="رویداد کیفی یافت نشد"
                      description="رویداد کیفی برای این شناسه ثبت نشده است."
                    />
                  ) : (
                    <div className="space-y-1.5 max-h-64 overflow-y-auto">
                      {historyData.timeline.map(ev => (
                        <div
                          key={ev.id}
                          className="p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] bg-[var(--fiori-bg-surface)] flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                        >
                          <div>
                            <div className="font-semibold text-[var(--fiori-text-primary)]">
                              <span className="fiori-ltr-code font-mono text-[var(--fiori-brand)] ml-1.5">
                                {ev.referenceNumber}
                              </span>
                              {ev.titleFa}
                            </div>
                            <div className="text-[11px] text-[var(--fiori-text-secondary)] mt-0.5">
                              {ev.detailFa}
                            </div>
                          </div>
                          <div className="text-[11px] text-[var(--fiori-text-secondary)] text-left shrink-0">
                            <div>{ev.actorName}</div>
                            <div className="font-mono tabular-nums">{formatDateTime(ev.timestamp)}</div>
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
            <div className="lg:col-span-4 bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)] p-3 space-y-2 max-h-[60vh] overflow-y-auto">
              <FioriToolbar
                variant="section"
                title={`ترخیص / قرنطینه سریع (QM-UD: ${toPersianDigits(quarantineItems.length)})`}
                endContent={<FioriObjectStatus tone="critical" label="سند ۳۲۱ / ۳۲۲ / ۳۴۴" />}
              />

              {quarantineItems.length === 0 ? (
                <EmptyState
                  compact
                  variant="NO_DATA"
                  title="موجودی فعالی یافت نشد"
                  description="هیچ موجودی فعالی برای عملیات سریع QM-UD یافت نشد."
                />
              ) : (
                quarantineItems.map(item => {
                  const isSelected =
                    selectedPartId === item.id ||
                    (!selectedPartId && quarantineItems[0]?.id === item.id);
                  return (
                    <div
                      key={item.id}
                      onClick={() => setSelectedPartId(item.id)}
                      className={`p-3 rounded-[var(--fiori-radius-sm)] border cursor-pointer transition ${
                        isSelected
                          ? 'bg-[var(--fiori-brand-bg)] border-[var(--fiori-brand)] shadow-xs'
                          : 'bg-[var(--fiori-bg-surface)] border-[var(--fiori-border-default)] hover:bg-[var(--fiori-bg-hover)]'
                      }`}
                    >
                      <div className="flex items-center justify-between text-xs font-mono font-bold text-[var(--fiori-text-primary)]">
                        <span className="fiori-ltr-code">{item.code}</span>
                        <FioriObjectStatus
                          tone={item.hasHeldStock ? 'critical' : 'positive'}
                          label={`${formatNumber(item.qiQty)} ${item.unit}`}
                        />
                      </div>
                      <div className="text-xs text-[var(--fiori-text-primary)] font-medium mt-1 truncate">
                        {item.name}
                      </div>
                      <div className="text-[11px] text-[var(--fiori-text-secondary)] mt-1 flex items-center justify-between font-mono">
                        <span className="fiori-ltr-code">{item.lotNumber}</span>
                        <span className="font-sans">
                          {item.hasHeldStock ? 'در قرنطینه/مسدود' : 'آزاد'}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="lg:col-span-8 bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)] p-4 space-y-4">
              {!selectedPart ? (
                <EmptyState
                  compact
                  variant="CUSTOM"
                  title="قلمی انتخاب نشده است"
                  description="یک قلم را از لیست سمت راست انتخاب کنید."
                />
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between border-b border-[var(--fiori-border-subtle)] pb-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-base font-bold text-[var(--fiori-text-primary)] font-mono fiori-ltr-code">
                          {selectedPart.code}
                        </h3>
                        <FioriObjectStatus
                          tone={selectedPart.hasHeldStock ? 'critical' : 'positive'}
                          label={selectedPart.hasHeldStock ? 'قرنطینه / مسدود کیفی' : 'موجودی آزاد'}
                          size="md"
                        />
                      </div>
                      <p className="text-xs text-[var(--fiori-text-secondary)] mt-1 font-medium">
                        {selectedPart.name}
                      </p>
                    </div>
                    <div className="text-left font-mono tabular-nums">
                      <div className="text-xs text-[var(--fiori-text-secondary)]">
                        مقدار قابل تصمیم‌گیری:
                      </div>
                      <div className="text-sm font-bold text-[var(--fiori-text-primary)]">
                        {formatNumber(selectedPart.qiQty)} {selectedPart.unit}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="text-xs font-bold text-[var(--fiori-text-primary)] flex items-center gap-1.5">
                      <FileText className="w-4 h-4 text-[var(--fiori-brand)]" />
                      <span>چک‌لیست ترخیص سریع کیفی و اندازه‌برداری CMM:</span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div
                        onClick={() => setCmmPassed(!cmmPassed)}
                        className={`p-3 rounded-[var(--fiori-radius-sm)] border cursor-pointer flex items-center justify-between transition ${
                          cmmPassed
                            ? 'bg-[var(--fiori-positive-bg)] border-[var(--fiori-positive-border)] text-[var(--fiori-positive)]'
                            : 'bg-[var(--fiori-negative-bg)] border-[var(--fiori-negative-border)] text-[var(--fiori-negative)]'
                        }`}
                      >
                        <span className="text-xs font-semibold">تست ابعادی CMM / فیکسچر</span>
                        {cmmPassed ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}
                      </div>

                      <div
                        onClick={() => setVisualPassed(!visualPassed)}
                        className={`p-3 rounded-[var(--fiori-radius-sm)] border cursor-pointer flex items-center justify-between transition ${
                          visualPassed
                            ? 'bg-[var(--fiori-positive-bg)] border-[var(--fiori-positive-border)] text-[var(--fiori-positive)]'
                            : 'bg-[var(--fiori-negative-bg)] border-[var(--fiori-negative-border)] text-[var(--fiori-negative)]'
                        }`}
                      >
                        <span className="text-xs font-semibold">بازرسی چشمی و خط و خش سطح</span>
                        {visualPassed ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}
                      </div>

                      <div
                        onClick={() => setBurrPassed(!burrPassed)}
                        className={`p-3 rounded-[var(--fiori-radius-sm)] border cursor-pointer flex items-center justify-between transition ${
                          burrPassed
                            ? 'bg-[var(--fiori-positive-bg)] border-[var(--fiori-positive-border)] text-[var(--fiori-positive)]'
                            : 'bg-[var(--fiori-negative-bg)] border-[var(--fiori-negative-border)] text-[var(--fiori-negative)]'
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
                      className="w-full bg-white border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-border-focus)]"
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-[var(--fiori-border-subtle)]">
                    <div className="text-xs text-[var(--fiori-text-secondary)]">
                      صدور سند UD به صورت تراکنشی و یکتا سند حرکت انبار (۳۲۱ / ۳۲۲ / ۳۴۴) را ثبت می‌کند.
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => handleUsageDecision('BLOCK_SCRAP')}
                        className="px-3.5 py-1.5 text-xs font-semibold text-[var(--fiori-negative)] bg-[var(--fiori-negative-bg)] hover:opacity-90 border border-[var(--fiori-negative-border)] rounded-[var(--fiori-radius-sm)] cursor-pointer flex items-center gap-1.5"
                      >
                        <Lock className="w-3.5 h-3.5" />
                        <span>
                          {selectedPart.hasHeldStock
                            ? 'مسدودسازی قطعی (کد ۳۴۴)'
                            : 'انتقال به قرنطینه (کد ۳۲۲)'}
                        </span>
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

      {/* ================================================================= */}
      {/* FIORI DIALOGS FOR QUALITY WORKFLOWS                               */}
      {/* ================================================================= */}

      {/* New Inspection Dialog */}
      <FioriDialog
        isOpen={showNewInspectionForm}
        onClose={() => setShowNewInspectionForm(false)}
        title="ثبت برگه بازرسی کیفی جدید (ورودی / حین فرآیند / محصول نهایی)"
        subtitle="ثبت فرم بازرسی IQC / IPQC / FQC همراه با چک‌لیست استاندارد و اتصال اختیاری به قرنطینه"
        icon={<ClipboardCheck className="w-4 h-4" />}
        tone="brand"
        size="xl"
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowNewInspectionForm(false)}
              className="sap-btn-standard px-3.5 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="new-inspection-form"
              disabled={loading}
              className="sap-btn-emphasized px-4 py-1.5 text-xs font-semibold cursor-pointer"
            >
              ثبت برگه بازرسی
            </button>
          </div>
        }
      >
        <form id="new-inspection-form" onSubmit={handleCreateInspection} className="space-y-4 text-xs">
          {toast?.type === 'error' && (
            <FioriMessageStrip tone="error" compact onClose={() => setToast(null)}>
              {toast.text}
            </FioriMessageStrip>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="font-semibold text-[var(--fiori-text-primary)]">نوع بازرسی *</label>
              <select
                value={newInspType}
                onChange={e => setNewInspType(e.target.value as QualityInspectionType)}
                className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
              >
                <option value="INCOMING_MATERIAL">بازرسی ورودی مواد و کلاف (IQC)</option>
                <option value="IN_PROCESS">بازرسی حین فرآیند تولید (IPQC)</option>
                <option value="FINAL_PRODUCT">بازرسی محصول نهایی (FQC)</option>
              </select>
            </div>

            <div className="space-y-1">
              <label className="font-semibold text-[var(--fiori-text-primary)]">
                قطعه / ماده اولیه *
              </label>
              <select
                value={newInspPartId}
                onChange={e => setNewInspPartId(e.target.value)}
                className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
              >
                {parts.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.code} — {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="font-semibold text-[var(--fiori-text-primary)]">
                مقدار مورد بازرسی *
              </label>
              <input
                type="number"
                min="0.001"
                step="any"
                value={newInspQty}
                onChange={e => setNewInspQty(e.target.value)}
                className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white font-mono"
                required
              />
            </div>

            {newInspType === 'INCOMING_MATERIAL' && (
              <>
                <div className="space-y-1">
                  <label className="font-semibold text-[var(--fiori-text-primary)]">
                    کلاف فیزیکی (اختیاری)
                  </label>
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
                    className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
                  >
                    <option value="">-- انتخاب کلاف --</option>
                    {coils.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.coilId} ({c.partCode} — {formatNumber(c.remainingWeightKg)} کیلو —{' '}
                        {QUALITY_STATUS_LABELS_FA[c.qualityStatus] || c.qualityStatus})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-semibold text-[var(--fiori-text-primary)]">تامین‌کننده</label>
                  <input
                    type="text"
                    value={newInspSupplier}
                    onChange={e => setNewInspSupplier(e.target.value)}
                    placeholder="مثلاً: ساپکو / فولاد مبارکه"
                    className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
                  />
                </div>
              </>
            )}

            {(newInspType === 'IN_PROCESS' || newInspType === 'FINAL_PRODUCT') && (
              <>
                <div className="space-y-1">
                  <label className="font-semibold text-[var(--fiori-text-primary)]">
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
                    className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
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
                  <label className="font-semibold text-[var(--fiori-text-primary)]">
                    عملیات / ایستگاه (Operation)
                  </label>
                  <select
                    value={newInspOpCode}
                    onChange={e => setNewInspOpCode(e.target.value)}
                    className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
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
              <label className="font-semibold text-[var(--fiori-text-primary)]">
                ردیف موجودی انبار (Balance)
              </label>
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
                className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
              >
                <option value="">-- تطبیق خودکار با انبار --</option>
                {balances
                  .filter(b => !newInspPartId || b.partId === newInspPartId)
                  .slice(0, 40)
                  .map(b => (
                    <option key={b.id} value={b.id}>
                      {b.warehouseName} | بچ: {b.lotNumber || '-'} | آزاد:{' '}
                      {formatNumber(b.availableQty)} | QI: {formatNumber(b.qualityInspectionQty)}
                    </option>
                  ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="font-semibold text-[var(--fiori-text-primary)]">
                شماره بچ / لات (Lot)
              </label>
              <input
                type="text"
                value={newInspLotNumber}
                onChange={e => setNewInspLotNumber(e.target.value)}
                placeholder="LOT-..."
                className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white font-mono"
              />
            </div>

            <div className="space-y-1">
              <label className="font-semibold text-[var(--fiori-text-primary)]">
                تصمیم فوری (اختیاری)
              </label>
              <select
                value={newInspImmediateDecision}
                onChange={e => setNewInspImmediateDecision(e.target.value as QualityDecision | '')}
                className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
              >
                <option value="">ثبت در وضعیت «در انتظار تصمیم»</option>
                <option value="ACCEPTED">تایید و ترخیص فوری (۳۲۱)</option>
                <option value="ACCEPTED_WITH_CONCESSION">تایید ارفاقی (۳۲۱)</option>
                <option value="QUARANTINED">انتقال به قرنطینه (۳۲۲)</option>
                <option value="REJECTED">رد کیفی و مسدودسازی (۳۴۴ + NCR)</option>
              </select>
            </div>

            {(newInspImmediateDecision === 'REJECTED' ||
              newInspImmediateDecision === 'QUARANTINED') && (
              <div className="space-y-1">
                <label className="font-semibold text-[var(--fiori-text-primary)]">کد عیب اصلی</label>
                <select
                  value={newInspDefectCode}
                  onChange={e => setNewInspDefectCode(e.target.value)}
                  className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
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
              <div className="text-xs font-bold text-[var(--fiori-text-primary)]">
                چک‌لیست استاندارد مرحله بازرسی:
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {newInspChecklist.map((item, idx) => (
                  <div
                    key={item.id}
                    className={`p-2.5 rounded-[var(--fiori-radius-sm)] border flex items-center justify-between gap-2 text-xs ${
                      item.passed
                        ? 'bg-[var(--fiori-positive-bg)] border-[var(--fiori-positive-border)] text-[var(--fiori-positive)]'
                        : 'bg-[var(--fiori-negative-bg)] border-[var(--fiori-negative-border)] text-[var(--fiori-negative)]'
                    }`}
                  >
                    <div>
                      <div className="font-semibold">{item.labelFa}</div>
                      {item.standardSpec && (
                        <div className="text-[10px] opacity-80">معیار: {item.standardSpec}</div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setNewInspChecklist(prev =>
                          prev.map((c, i) => (i === idx ? { ...c, passed: !c.passed } : c))
                        )
                      }
                      className="px-2.5 py-1 rounded-[var(--fiori-radius-sm)] bg-white border border-current text-[11px] font-bold cursor-pointer"
                    >
                      {item.passed ? 'قبول ✓' : 'رد ✗'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[var(--fiori-border-subtle)] text-xs">
            <label className="flex items-center gap-2 cursor-pointer text-[var(--fiori-text-primary)]">
              <input
                type="checkbox"
                checked={newInspQuarantineOnStart}
                onChange={e => setNewInspQuarantineOnStart(e.target.checked)}
                disabled={Boolean(newInspImmediateDecision)}
              />
              <span>قفل خودکار موجودی در قرنطینه (کد ۳۲۲) تا زمان صدور تصمیم نهایی</span>
            </label>

            <input
              type="text"
              value={newInspNotes}
              onChange={e => setNewInspNotes(e.target.value)}
              placeholder="یادداشت بازرس..."
              className="border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1.5 text-xs w-64 bg-white"
            />
          </div>
        </form>
      </FioriDialog>

      {/* Decide Inspection Dialog */}
      <FioriDialog
        isOpen={Boolean(decidingInspection)}
        onClose={() => setDecidingInspection(null)}
        title={
          decidingInspection
            ? `ثبت تصمیم نهایی بازرسی ${decidingInspection.inspectionNumber}`
            : 'ثبت تصمیم نهایی بازرسی'
        }
        subtitle={
          decidingInspection
            ? `${decidingInspection.partCode} (${formatNumber(decidingInspection.inspectedQty)} ${decidingInspection.unit})`
            : undefined
        }
        icon={<ShieldCheck className="w-4 h-4" />}
        tone="warning"
        size="lg"
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setDecidingInspection(null)}
              className="sap-btn-standard px-3 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="decide-inspection-form"
              disabled={loading}
              className="sap-btn-emphasized px-4 py-1.5 text-xs font-semibold cursor-pointer"
            >
              ثبت تصمیم و به‌روزرسانی انبار
            </button>
          </div>
        }
      >
        {decidingInspection && (
          <form id="decide-inspection-form" onSubmit={handleDecideInspection} className="space-y-3 text-xs">
            {toast?.type === 'error' && (
              <FioriMessageStrip tone="error" compact onClose={() => setToast(null)}>
                {toast.text}
              </FioriMessageStrip>
            )}

            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
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
                  className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
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
                  className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white font-mono"
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
                  className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white font-mono"
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
                  className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white font-mono"
                />
              </div>

              <div className="space-y-1">
                <label className="font-semibold">کد عیب (در صورت وجود عیب)</label>
                <select
                  value={decideDefectCode}
                  onChange={e => setDecideDefectCode(e.target.value)}
                  className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
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
                  className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
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
                  className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
                />
              </div>
            </div>
          </form>
        )}
      </FioriDialog>

      {/* New NCR Dialog */}
      <FioriDialog
        isOpen={showNewNcrForm}
        onClose={() => setShowNewNcrForm(false)}
        title="ثبت گزارش عدم انطباق کیفی جدید (NCR)"
        subtitle="ثبت عدم انطباق به همراه امکان مهار فوری و قفل موجودی در انبار (کد ۳۴۴)"
        icon={<AlertTriangle className="w-4 h-4" />}
        tone="danger"
        size="xl"
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowNewNcrForm(false)}
              className="sap-btn-standard px-3.5 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="new-ncr-form"
              disabled={loading}
              className="px-4 py-1.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-negative)] text-white text-xs font-semibold hover:opacity-90 cursor-pointer"
            >
              ثبت گزارش عدم انطباق
            </button>
          </div>
        }
      >
        <form id="new-ncr-form" onSubmit={handleCreateNcr} className="space-y-3 text-xs">
          {toast?.type === 'error' && (
            <FioriMessageStrip tone="error" compact onClose={() => setToast(null)}>
              {toast.text}
            </FioriMessageStrip>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="font-semibold">منبع کشف عیب</label>
              <select
                value={newNcrSource}
                onChange={e => setNewNcrSource(e.target.value as NcrSourceType)}
                className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
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
                className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
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
                className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
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
                className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
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
                className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white font-mono"
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
                className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
              >
                <option value="">-- تطبیق خودکار --</option>
                {balances
                  .filter(b => !newNcrPartId || b.partId === newNcrPartId)
                  .slice(0, 40)
                  .map(b => (
                    <option key={b.id} value={b.id}>
                      {b.warehouseName} | بچ: {b.lotNumber || '-'} | آزاد:{' '}
                      {formatNumber(b.availableQty)}
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
                className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white font-mono"
              />
            </div>

            <div className="space-y-1">
              <label className="font-semibold">شماره دستور کار (MO)</label>
              <input
                type="text"
                value={newNcrMoNumber}
                onChange={e => setNewNcrMoNumber(e.target.value)}
                placeholder="MO-..."
                className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white font-mono"
              />
            </div>

            <div className="space-y-1">
              <label className="font-semibold">شرح عدم انطباق *</label>
              <input
                type="text"
                value={newNcrDescription}
                onChange={e => setNewNcrDescription(e.target.value)}
                placeholder="توضیح دقیق عیب مشاهده‌شده..."
                className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
                required
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-[var(--fiori-border-subtle)] text-xs">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={newNcrContainNow}
                onChange={e => setNewNcrContainNow(e.target.checked)}
              />
              <span className="font-semibold text-[var(--fiori-negative)]">
                مهار فوری و قفل موجودی در انبار (کد ۳۴۴)
              </span>
            </label>
            {newNcrContainNow && (
              <input
                type="text"
                value={newNcrContainmentAction}
                onChange={e => setNewNcrContainmentAction(e.target.value)}
                className="border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1 text-xs w-64 bg-white"
                placeholder="شرح اقدام مهار فوری..."
              />
            )}
          </div>
        </form>
      </FioriDialog>

      {/* Contain NCR Dialog */}
      <FioriDialog
        isOpen={Boolean(containingNcr)}
        onClose={() => setContainingNcr(null)}
        title={
          containingNcr
            ? `اجرای مهار فوری و قرنطینه برای ${containingNcr.ncrNumber}`
            : 'اجرای مهار فوری و قرنطینه'
        }
        subtitle={
          containingNcr
            ? `مقدار مشمول مهار: ${formatNumber(containingNcr.affectedQty)} ${containingNcr.unit}`
            : undefined
        }
        icon={<Lock className="w-4 h-4" />}
        tone="warning"
        size="md"
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setContainingNcr(null)}
              className="sap-btn-standard px-3 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="contain-ncr-form"
              disabled={loading}
              className="px-4 py-1.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-critical)] text-white text-xs font-semibold cursor-pointer hover:opacity-90"
            >
              قفل موجودی و ثبت مهار
            </button>
          </div>
        }
      >
        {containingNcr && (
          <form id="contain-ncr-form" onSubmit={handleContainNcr} className="space-y-3 text-xs">
            {toast?.type === 'error' && (
              <FioriMessageStrip tone="error" compact onClose={() => setToast(null)}>
                {toast.text}
              </FioriMessageStrip>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="space-y-1">
                <label className="font-semibold">نوع قفل موجودی</label>
                <select
                  value={containHoldType}
                  onChange={e =>
                    setContainHoldType(e.target.value as 'BLOCKED' | 'QUALITY_INSPECTION')
                  }
                  className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
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
                  className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
                  required
                />
              </div>
            </div>
          </form>
        )}
      </FioriDialog>

      {/* Disposition NCR Dialog */}
      <FioriDialog
        isOpen={Boolean(disposingNcr)}
        onClose={() => setDisposingNcr(null)}
        title={
          disposingNcr
            ? `تعیین تکلیف عدم انطباق ${disposingNcr.ncrNumber}`
            : 'تعیین تکلیف عدم انطباق'
        }
        subtitle={
          disposingNcr
            ? `${disposingNcr.partCode} (${formatNumber(disposingNcr.affectedQty)} ${disposingNcr.unit})`
            : undefined
        }
        icon={<FileText className="w-4 h-4" />}
        tone="brand"
        size="lg"
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setDisposingNcr(null)}
              className="sap-btn-standard px-3 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="disposition-ncr-form"
              disabled={loading}
              className="sap-btn-emphasized px-4 py-1.5 text-xs font-semibold cursor-pointer"
            >
              اجرای تعیین تکلیف و سند انبار
            </button>
          </div>
        }
      >
        {disposingNcr && (
          <form id="disposition-ncr-form" onSubmit={handleDispositionNcr} className="space-y-3 text-xs">
            {toast?.type === 'error' && (
              <FioriMessageStrip tone="error" compact onClose={() => setToast(null)}>
                {toast.text}
              </FioriMessageStrip>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="space-y-1">
                <label className="font-semibold">اقدام تعیین تکلیف (Disposition) *</label>
                <select
                  value={dispAction}
                  onChange={e => setDispAction(e.target.value as NcrDispositionAction)}
                  className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
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
                  className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
                />
              </div>

              <div className="space-y-1">
                <label className="font-semibold">اقدام اصلاحی (Corrective Action)</label>
                <input
                  type="text"
                  value={dispCorrective}
                  onChange={e => setDispCorrective(e.target.value)}
                  placeholder="اقدام پیشگیرانه برای جلوگیری از تکرار..."
                  className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
                />
              </div>

              {dispAction === 'REWORK' && (
                <div className="md:col-span-3 space-y-1">
                  <label className="font-semibold">دستورالعمل دوباره‌کاری *</label>
                  <input
                    type="text"
                    value={dispReworkInstructions}
                    onChange={e => setDispReworkInstructions(e.target.value)}
                    className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
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
                      className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white font-mono"
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
                      className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white font-mono"
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
                  className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
                />
              </div>
            </div>
          </form>
        )}
      </FioriDialog>

      {/* Complete Rework Dialog */}
      <FioriDialog
        isOpen={Boolean(completingRework)}
        onClose={() => setCompletingRework(null)}
        title={
          completingRework
            ? `ثبت نتیجه دوباره‌کاری ${completingRework.reworkNumber}`
            : 'ثبت نتیجه دوباره‌کاری'
        }
        subtitle={
          completingRework
            ? `باقیمانده: ${formatNumber(completingRework.remainingQty)} ${completingRework.unit}`
            : undefined
        }
        icon={<Wrench className="w-4 h-4" />}
        tone="brand"
        size="lg"
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setCompletingRework(null)}
              className="sap-btn-standard px-3 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="complete-rework-form"
              disabled={loading}
              className="px-4 py-1.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-positive)] text-white text-xs font-semibold cursor-pointer hover:opacity-90"
            >
              ثبت نتیجه و ترخیص/ضایعات
            </button>
          </div>
        }
      >
        {completingRework && (
          <form id="complete-rework-form" onSubmit={handleCompleteRework} className="space-y-3 text-xs">
            {toast?.type === 'error' && (
              <FioriMessageStrip tone="error" compact onClose={() => setToast(null)}>
                {toast.text}
              </FioriMessageStrip>
            )}

            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className="space-y-1">
                <label className="font-semibold text-[var(--fiori-positive)]">
                  مقدار سالمِ اصلاح‌شده (ترخیص ۳۲۱)
                </label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={reworkGoodQty}
                  onChange={e => setReworkGoodQty(e.target.value)}
                  className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white font-mono"
                />
              </div>
              <div className="space-y-1">
                <label className="font-semibold text-[var(--fiori-negative)]">
                  مقدار ضایعاتِ غیرقابل اصلاح
                </label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={reworkScrapQty}
                  onChange={e => setReworkScrapQty(e.target.value)}
                  className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white font-mono"
                />
              </div>
              <div className="md:col-span-2 space-y-1">
                <label className="font-semibold">یادداشت تکمیل دوباره‌کاری</label>
                <input
                  type="text"
                  value={reworkNotes}
                  onChange={e => setReworkNotes(e.target.value)}
                  placeholder="گزارش بازرسی مجدد پس از اصلاح..."
                  className="w-full border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] p-2 bg-white"
                />
              </div>
            </div>

            <div className="pt-2 border-t border-[var(--fiori-border-subtle)]">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={reworkReturnToProd}
                  onChange={e => setReworkReturnToProd(e.target.checked)}
                />
                <span>بازگشت قطعات سالم به خط تولید (Return to Production)</span>
              </label>
            </div>
          </form>
        )}
      </FioriDialog>
    </FioriDynamicPage>
  );
};
