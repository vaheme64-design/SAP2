import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Boxes,
  Search,
  FileText,
  ScrollText,
  Layers,
  ArrowRightLeft,
  ArrowUpRight,
  ArrowDownLeft,
  RotateCcw,
  Scale,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  BellRing,
  ArrowLeft,
  FileSpreadsheet,
  Upload,
  FileSignature,
  CalendarDays,
  MoreHorizontal,
  Truck,
  ShieldCheck,
} from 'lucide-react';
import {
  Part,
  PartCategory,
  WarehouseDefinition,
  DetailedStockBalance,
  InventoryDocument,
  SapcoContract,
  SapcoContractLedgerEntry,
  InventoryDashboardMetrics,
  StageInventorySummary,
  PhysicalCoil,
  CustomerDefinition,
  WAREHOUSES_LIST,
} from '../../types/inventory';
import { formatNumber, formatWeightKg, toPersianDigits } from '../../utils/formatters';
import { InventoryDashboard } from './InventoryDashboard';
import { StockInquiryView } from './StockInquiryView';
import { MovementHistoryView } from './MovementHistoryView';
import { SapcoAccountReportView } from './SapcoAccountReportView';
import { InventoryReportView } from '../InventoryReportView';
import { PhysicalCoilsView } from './PhysicalCoilsView';
import { CustomReportsView } from './CustomReportsView';
import { DataImportExportView } from './DataImportExportView';
import { ContractsManagementView } from './ContractsManagementView';
import { ReceiptFormModal } from './ReceiptFormModal';
import { IssueFormModal } from './IssueFormModal';
import { TransferFormModal } from './TransferFormModal';
import { AdjustmentFormModal } from './AdjustmentFormModal';
import { ReturnFromProductionModal } from './ReturnFromProductionModal';
import { MaterialIssueModal } from './MaterialIssueModal';
import { InventoryModuleSkeleton } from '../ui/Skeleton';
import { FioriAnalyticalListPage, AlpVisualKpiItem } from '../fiori/FioriAnalyticalListPage';
import {
  FioriMessageStrip,
  FioriDataTable,
  FioriTableColumn,
  FioriObjectStatus,
} from '../fiori/ui';
import { EmptyState } from '../common/EmptyState';
import { QualityUsageDecisionView } from '../quality/QualityUsageDecisionView';
import { InventoryReconciliationView } from './InventoryReconciliationView';
import { useErpRouter } from '../../context/RouterContext';

export type InventorySubTab =
  | 'DASHBOARD'
  | 'INQUIRY'
  | 'COILS'
  | 'CONTRACTS'
  | 'ALERTS'
  | 'MOVEMENT'
  | 'CUSTOM_REPORTS'
  | 'IMPORT_EXPORT'
  | 'SAPCO'
  | 'STAGES'
  | 'QUALITY_QM'
  | 'RECONCILIATION';

interface InventoryModuleViewProps {
  parts: Part[];
  stageBalances: StageInventorySummary[];
  currentUser: {
    uid: string;
    displayName: string;
    role: string;
  };
  initialSubTab?: InventorySubTab;
  initialSearchQuery?: string;
  initialActionModal?: 'RECEIPT' | 'ISSUE' | 'RETURN' | 'TRANSFER' | null;
  initialReceiptDraft?: any;
  initialIssueDraft?: any;
  onClearInitialAction?: () => void;
  onGlobalRefresh?: () => Promise<void>;
  onNavigateToPlanning?: () => void;
  onSubTabChange?: (tab: InventorySubTab) => void;
}

export interface ReorderAlertItem {
  part: Part;
  currentStock: number;
  reorderPoint: number;
  shortageAmount: number;
  coveragePercent: number;
  severity: 'CRITICAL' | 'WARNING';
  locationsSummary: string[];
}

export const InventoryModuleView: React.FC<InventoryModuleViewProps> = ({
  parts,
  stageBalances,
  currentUser,
  initialSubTab,
  initialSearchQuery,
  initialActionModal,
  initialReceiptDraft,
  initialIssueDraft,
  onClearInitialAction,
  onGlobalRefresh,
  onNavigateToPlanning,
  onSubTabChange,
}) => {
  const { route, clearDocQuery } = useErpRouter();
  const [activeSubTab, setActiveSubTab] = useState<InventorySubTab>(initialSubTab || 'DASHBOARD');

  const handleSelectSubTab = (tab: InventorySubTab) => {
    setActiveSubTab(tab);
    if (onSubTabChange) onSubTabChange(tab);
  };
  const [loading, setLoading] = useState(false);
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [showSecondaryTabs, setShowSecondaryTabs] = useState(false);
  const [showMoreActions, setShowMoreActions] = useState(false);

  // Dedicated Reorder Alerts Page Filters
  const [alertCategoryFilter, setAlertCategoryFilter] = useState<'ALL' | PartCategory>('ALL');
  const [alertSeverityFilter, setAlertSeverityFilter] = useState<'ALL' | 'CRITICAL' | 'WARNING'>('ALL');
  const [alertSearchQuery, setAlertSearchQuery] = useState(initialSearchQuery || route.docQuery || '');

  // Sync when parent deep-links to a specific inventory sub-tab
  useEffect(() => {
    if (initialSubTab) {
      setActiveSubTab(initialSubTab);
    }
  }, [initialSubTab]);

  useEffect(() => {
    const q = initialSearchQuery || route.docQuery;
    if (q) {
      setAlertSearchQuery(q);
    }
  }, [initialSearchQuery, route.docQuery]);

  // Core Inventory Data
  const [metrics, setMetrics] = useState<InventoryDashboardMetrics | null>(null);
  const [warehouses, setWarehouses] = useState<WarehouseDefinition[]>(WAREHOUSES_LIST);
  const [balances, setBalances] = useState<DetailedStockBalance[]>([]);
  const [documents, setDocuments] = useState<InventoryDocument[]>([]);
  const [contracts, setContracts] = useState<SapcoContract[]>([]);
  const [customers, setCustomers] = useState<CustomerDefinition[]>([]);
  const [coils, setCoils] = useState<PhysicalCoil[]>([]);
  const [sapcoLedger, setSapcoLedger] = useState<SapcoContractLedgerEntry[]>([]);

  // Modal States
  const [isReceiptOpen, setIsReceiptOpen] = useState(false);
  const [isIssueOpen, setIsIssueOpen] = useState(false);
  const [isMaterialIssueOpen, setIsMaterialIssueOpen] = useState(false);
  const [issueModalPreset, setIssueModalPreset] = useState<any>(null);
  const [isReturnOpen, setIsReturnOpen] = useState(false);
  const [isTransferOpen, setIsTransferOpen] = useState(false);
  const [isAdjustmentOpen, setIsAdjustmentOpen] = useState(false);
  const reverseIdempotencyKeysRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (initialActionModal === 'RECEIPT') setIsReceiptOpen(true);
    else if (initialActionModal === 'ISSUE') {
      setIssueModalPreset(initialIssueDraft || null);
      setIsIssueOpen(true);
    }
    else if (initialActionModal === 'RETURN') setIsReturnOpen(true);
    else if (initialActionModal === 'TRANSFER') setIsTransferOpen(true);
    if (initialActionModal && onClearInitialAction) {
      onClearInitialAction();
    }
  }, [initialActionModal, initialIssueDraft, onClearInitialAction]);

  // Auto-clear notifications after 4 seconds
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  const activeFetchControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      activeFetchControllerRef.current?.abort();
    };
  }, []);

  // Load Inventory Data (resilient against transient disconnects, retries automatically, isolates per-endpoint errors)
  const loadInventoryData = useCallback(async (silent = false) => {
    activeFetchControllerRef.current?.abort();
    const controller = new AbortController();
    activeFetchControllerRef.current = controller;

    const fetchJsonWithRetry = async (url: string, retries = 2): Promise<any> => {
      let lastError: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (controller.signal.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        try {
          const response = await fetch(url, {
            signal: controller.signal,
            headers: { Accept: 'application/json' },
          });
          if (!response.ok) {
            if (response.status >= 500 && attempt < retries) {
              await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
              continue;
            }
            throw new Error(`HTTP ${response.status} for ${url}`);
          }
          const contentType = response.headers.get('content-type') || '';
          if (!contentType.includes('application/json')) {
            if (attempt < retries) {
              await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
              continue;
            }
            throw new Error(`Unexpected non-JSON response for ${url}`);
          }
          return await response.json();
        } catch (err: any) {
          if (err?.name === 'AbortError' || controller.signal.aborted) {
            throw err;
          }
          lastError = err;
          if (attempt < retries) {
            await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
          }
        }
      }
      throw lastError;
    };

    if (!silent && isMountedRef.current) setLoading(true);
    try {
      const results = await Promise.allSettled([
        fetchJsonWithRetry('/api/inventory/dashboard-metrics'),
        fetchJsonWithRetry('/api/inventory/warehouses'),
        fetchJsonWithRetry('/api/inventory/stock-inquiry'),
        fetchJsonWithRetry('/api/inventory/documents'),
        fetchJsonWithRetry('/api/inventory/sapco-account'),
        fetchJsonWithRetry('/api/inventory/coils'),
        fetchJsonWithRetry('/api/inventory/contracts'),
        fetchJsonWithRetry('/api/customers'),
      ]);

      if (controller.signal.aborted || !isMountedRef.current) return;

      const unwrap = (r: PromiseSettledResult<any>) => (r.status === 'fulfilled' ? r.value : null);
      const [metricsRes, whRes, inquiryRes, docsRes, sapcoRes, coilsRes, contractsRes, custRes] =
        results.map(unwrap);

      const fulfilledCount = results.filter(r => r.status === 'fulfilled').length;

      if (metricsRes?.success && metricsRes.data) setMetrics(metricsRes.data);
      if (whRes?.success && Array.isArray(whRes.data) && whRes.data.length > 0) setWarehouses(whRes.data);
      if (inquiryRes?.success && Array.isArray(inquiryRes.data)) setBalances(inquiryRes.data);
      if (docsRes?.success && Array.isArray(docsRes.data)) setDocuments(docsRes.data);
      if (coilsRes?.success && Array.isArray(coilsRes.data)) setCoils(coilsRes.data);
      if (custRes?.success && Array.isArray(custRes.data)) setCustomers(custRes.data);

      if (contractsRes?.success && Array.isArray(contractsRes.data) && contractsRes.data.length > 0) {
        setContracts(contractsRes.data);
      } else if (sapcoRes?.success) {
        const contractsList = sapcoRes.data?.contracts || sapcoRes.contracts || [];
        setContracts(contractsList);
      }

      if (sapcoRes?.success) {
        const ledgerList = sapcoRes.data?.ledger || sapcoRes.ledger || [];
        setSapcoLedger(ledgerList);
      }

      if (fulfilledCount === 0 && !silent) {
        setNotification({
          type: 'error',
          message: 'ارتباط با سرور انبارداری موقتاً برقرار نشد؛ لطفاً دکمه به‌روزرسانی را بزنید.',
        });
      }
    } catch (err: any) {
      if (err?.name === 'AbortError' || controller.signal.aborted || !isMountedRef.current) {
        return;
      }
      if (!silent) {
        setNotification({ type: 'error', message: 'خطا در بارگذاری اطلاعات انبارداری' });
      }
    } finally {
      if (!silent && isMountedRef.current && activeFetchControllerRef.current === controller) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadInventoryData(false);
  }, [loadInventoryData]);

  const handleOptimisticQmApplied = useCallback(
    (payload: { balances?: DetailedStockBalance[]; metrics?: InventoryDashboardMetrics; message?: string }) => {
      if (Array.isArray(payload.balances)) {
        setBalances(payload.balances);
      }
      if (payload.metrics) {
        setMetrics(payload.metrics);
      }
      if (payload.message) {
        setNotification({ type: 'success', message: payload.message });
      }
      // Background sync without flashing loading skeletons
      void loadInventoryData(true);
    },
    [loadInventoryData]
  );

  // Programmatically identify materials where current stock is below the defined reorder point (minStock)
  const reorderAlerts = useMemo<ReorderAlertItem[]>(() => {
    if (!parts || parts.length === 0) return [];

    return parts
      .filter(part => typeof part.minStock === 'number' && part.minStock > 0)
      .map(part => {
        const reorderPoint = part.minStock!;

        // 1. Check stageBalances passed to the module (excluding scrap yard)
        const matchingStageBalances = (stageBalances || []).filter(
          sb => (sb.partId === part.id || sb.partCode === part.code) && sb.stageId !== 'STAGE_SCRAP_YARD'
        );
        const stageStock = matchingStageBalances.reduce(
          (sum, sb) => sum + (part.unit === 'KG' ? sb.totalKg || sb.usableQty : sb.usableQty),
          0
        );

        // 2. Check detailed warehouse balances if loaded (excluding scrap warehouse)
        const matchingDetailedBalances = (balances || []).filter(
          b => (b.partId === part.id || b.partCode === part.code) && b.warehouseId !== 'WH-SCRAP'
        );
        const warehouseStock = matchingDetailedBalances.reduce(
          (sum, b) => sum + (part.unit === 'KG' ? b.availableKg : b.availableQty),
          0
        );

        // Use detailed warehouse stock if tracked there, otherwise stage stock
        const currentStock = matchingDetailedBalances.length > 0 ? warehouseStock : stageStock;

        const locationsSet = new Set<string>();
        matchingDetailedBalances.forEach(b => {
          if (b.availableQty > 0 || b.availableKg > 0) locationsSet.add(b.warehouseName);
        });
        matchingStageBalances.forEach(sb => {
          if (sb.usableQty > 0) locationsSet.add(sb.stageName);
        });

        const shortageAmount = Math.max(0, reorderPoint - currentStock);
        const coveragePercent = reorderPoint > 0 ? Math.min(100, Math.round((currentStock / reorderPoint) * 100)) : 100;
        const severity: 'CRITICAL' | 'WARNING' =
          currentStock <= 0 || coveragePercent <= 25 ? 'CRITICAL' : 'WARNING';

        return {
          part,
          currentStock,
          reorderPoint,
          shortageAmount,
          coveragePercent,
          severity,
          locationsSummary: Array.from(locationsSet),
        };
      })
      .filter(item => item.currentStock < item.reorderPoint)
      .sort((a, b) => a.coveragePercent - b.coveragePercent || b.shortageAmount - a.shortageAmount);
  }, [parts, stageBalances, balances]);

  const filteredReorderAlerts = useMemo(() => {
    return reorderAlerts.filter(item => {
      if (alertCategoryFilter !== 'ALL' && item.part.category !== alertCategoryFilter) return false;
      if (alertSeverityFilter !== 'ALL' && item.severity !== alertSeverityFilter) return false;
      if (alertSearchQuery.trim()) {
        const q = alertSearchQuery.trim().toLowerCase();
        const matchName = item.part.name.toLowerCase().includes(q);
        const matchCode = item.part.code.toLowerCase().includes(q);
        const matchGrade = item.part.materialGrade?.toLowerCase().includes(q);
        const matchSapco = item.part.sapcoCode?.toLowerCase().includes(q);
        if (!matchName && !matchCode && !matchGrade && !matchSapco) return false;
      }
      return true;
    });
  }, [reorderAlerts, alertCategoryFilter, alertSeverityFilter, alertSearchQuery]);

  const criticalAlertsCount = useMemo(
    () => reorderAlerts.filter(a => a.severity === 'CRITICAL').length,
    [reorderAlerts]
  );

  const rawMaterialAlertsCount = useMemo(
    () => reorderAlerts.filter(a => a.part.category === 'RAW_MATERIAL').length,
    [reorderAlerts]
  );

  // Handle Document Creation from Modals with Optimistic Table Update
  const handleCreateDocument = async (payload: any) => {
    try {
      const enrichedPayload = {
        ...payload,
        createdByUid: currentUser.uid,
        createdByName: currentUser.displayName,
      };

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (payload?.idempotencyKey) {
        headers['Idempotency-Key'] = String(payload.idempotencyKey);
      }

      const res = await fetch('/api/inventory/documents', {
        method: 'POST',
        headers,
        body: JSON.stringify(enrichedPayload),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        return { success: false, error: data.error || 'خطا در ثبت سند انبار' };
      }

      if (data.data) {
        setDocuments(prev => [data.data, ...prev.filter(d => d.id !== data.data.id)]);
      }

      setNotification({
        type: 'success',
        message: data.message || `سند شماره ${data.data?.documentNumber || ''} با موفقیت ثبت و موجودی انبار به‌روزرسانی شد.`,
      });

      // Quiet table-level sync without blocking full-page refresh
      await loadInventoryData(true);

      return { success: true, message: data.message };
    } catch (err: any) {
      return { success: false, error: err.message || 'خطا در ارتباط با سرور' };
    }
  };

  // Handle Reversal of Document with Optimistic Table Update & Stable Idempotency Key
  const handleReverseDocument = async (documentId: string, reason: string) => {
    const previousDocs = documents;
    const trimmedReason = reason.trim();
    const keyMapEntry = `${documentId}::${trimmedReason}`;
    let idempotencyKey = reverseIdempotencyKeysRef.current.get(keyMapEntry);
    if (!idempotencyKey) {
      const randomToken =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      idempotencyKey = `REV-${documentId}-${randomToken}`;
      reverseIdempotencyKeysRef.current.set(keyMapEntry, idempotencyKey);
    }

    // Optimistically mark target document as REVERSED
    setDocuments(prev =>
      prev.map(doc => (doc.id === documentId ? { ...doc, postingStatus: 'REVERSED' } : doc))
    );

    try {
      const res = await fetch(`/api/inventory/documents/${documentId}/reverse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          reason: trimmedReason,
          idempotencyKey,
          reversedByUid: currentUser.uid,
          reversedByName: currentUser.displayName,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        setDocuments(previousDocs);
        return { success: false, message: data.error || 'خطا در ابطال سند' };
      }

      reverseIdempotencyKeysRef.current.delete(keyMapEntry);

      const reversalDoc = data.reversalDoc || data.reversalDocument || data.data;
      if (reversalDoc) {
        setDocuments(prev => [reversalDoc, ...prev.filter(d => d.id !== reversalDoc.id)]);
      }

      setNotification({
        type: 'success',
        message: data.message || 'سند معکوس صادر شد و وضعیت سند اصلی به ابطال‌شده تغییر یافت.',
      });

      await loadInventoryData(true);

      return { success: true, message: data.message };
    } catch (err: any) {
      setDocuments(previousDocs);
      return { success: false, message: err.message || 'خطا در ارتباط با سرور' };
    }
  };

  // Primary daily sub-tabs vs secondary specialized tabs (so the user never feels drowned in tabs)
  const primaryTabs: { id: InventorySubTab; label: string; icon: any; badge?: number; badgeColor?: string }[] = [
    { id: 'DASHBOARD', label: 'پیشخوان انبار', icon: Boxes },
    { id: 'INQUIRY', label: 'موجودی و استعلام', icon: Search },
    { id: 'COILS', label: 'رول‌های ورق و کویل‌پک', icon: Layers, badge: coils.length },
    { id: 'MOVEMENT', label: 'اسناد و کاردکس رهگیری', icon: FileText, badge: documents.length },
    { id: 'CUSTOM_REPORTS', label: 'گزارش‌ساز پویا و سفارشی', icon: FileSpreadsheet },
    {
      id: 'ALERTS',
      label: 'نقطه سفارش و کسری‌ها',
      icon: BellRing,
      badge: reorderAlerts.length,
      badgeColor: criticalAlertsCount > 0 ? 'bg-rose-500 text-white' : 'bg-amber-500 text-slate-950',
    },
  ];

  const secondaryTabs: { id: InventorySubTab; label: string; icon: any; badge?: number }[] = [
    { id: 'RECONCILIATION', label: 'تطبیق، انبارگردانی و ردیابی', icon: Scale },
    { id: 'QUALITY_QM', label: 'کنترل کیفیت و تصمیم‌گیری (QM-UD)', icon: ShieldCheck },
    { id: 'CONTRACTS', label: 'قراردادها و سهمیه مواد', icon: FileSignature },
    { id: 'IMPORT_EXPORT', label: 'ورود و خروج اکسل (CSV)', icon: Upload },
    { id: 'SAPCO', label: 'صورتحساب امانی ساپکو', icon: ScrollText },
  ];

  const isSecondaryActive = secondaryTabs.some(t => t.id === activeSubTab);

  const categoryLabels: Record<PartCategory, string> = {
    RAW_MATERIAL: 'ماده اولیه / ورق',
    WIP_PART: 'نیمه‌ساخته (WIP)',
    FINISHED_GOOD: 'محصول نهایی',
  };

  if (loading && !metrics && balances.length === 0 && coils.length === 0) {
    return <InventoryModuleSkeleton />;
  }

  return (
    <div className="space-y-4">
      {/* Top Compact SAP Critical Alert Banner */}
      {reorderAlerts.length > 0 && activeSubTab !== 'ALERTS' && (
        <FioriMessageStrip
          tone="warning"
          icon={<BellRing className="w-4 h-4 shrink-0" />}
          title="هشدار کسری و نقطه سفارش"
          actions={
            <button
              type="button"
              onClick={() => handleSelectSubTab('ALERTS')}
              className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer whitespace-nowrap"
            >
              <span>مشاهده و مدیریت کسری‌ها</span>
              <ArrowLeft className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
            </button>
          }
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span>
              هم‌اکنون{' '}
              <strong className="font-semibold text-[var(--fiori-critical)] underline underline-offset-4">
                {toPersianDigits(reorderAlerts.length)} قلم کالا و ورق
              </strong>{' '}
              پایین‌تر از حداقل موجودی اطمینان قرار دارند.
            </span>
            {criticalAlertsCount > 0 && (
              <FioriObjectStatus
                tone="negative"
                label={`${toPersianDigits(criticalAlertsCount)} مورد بحرانی`}
              />
            )}
          </div>
        </FioriMessageStrip>
      )}

      {/* Clean SAP HANA Fiori IconTabBar & Primary Operations Bar */}
      <div className="sap-card overflow-hidden">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-2 px-3 border-b border-[#d9d9d9] bg-white">
          <div className="sap-icon-tab-bar border-b-0 flex-1">
            {[...primaryTabs, ...secondaryTabs].map(tab => {
              const isActive = activeSubTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => handleSelectSubTab(tab.id)}
                  className={`sap-icon-tab whitespace-nowrap shrink-0 ${isActive ? 'sap-icon-tab-active' : ''}`}
                >
                  <span>{tab.label}</span>
                  {typeof tab.badge === 'number' && tab.badge > 0 && (
                    <span className="font-mono text-[11px] text-[#007cc0] tabular-nums">
                      ({toPersianDigits(tab.badge)})
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Primary Task-Oriented Operations + Progressive Disclosure Menu */}
          <div className="flex items-center gap-2 flex-wrap shrink-0 py-2 xl:py-0">
            <button
              type="button"
              onClick={() => setIsReceiptOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#107e3e] hover:bg-[#0d6832] text-white rounded text-xs font-medium transition-colors cursor-pointer whitespace-nowrap"
            >
              <ArrowDownLeft className="w-3.5 h-3.5" />
              <span>ثبت رسید</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setIssueModalPreset({ subType: 'PRODUCTION_LINE', warehouseId: 'WH-RAW' });
                setIsIssueOpen(true);
              }}
              className="sap-btn-emphasized flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer whitespace-nowrap"
            >
              <ArrowUpRight className="w-3.5 h-3.5" />
              <span>حواله به خط</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setIssueModalPreset({ subType: 'CUSTOMER_DELIVERY', warehouseId: 'WH-FINISHED' });
                setIsIssueOpen(true);
              }}
              className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer whitespace-nowrap"
            >
              <Truck className="w-3.5 h-3.5 text-[#007cc0]" />
              <span>تحویل مشتری</span>
            </button>

            <div className="relative">
              <button
                type="button"
                onClick={() => setShowMoreActions(prev => !prev)}
                className={`sap-btn-standard flex items-center gap-1.5 px-2.5 py-1.5 text-xs cursor-pointer whitespace-nowrap ${
                  showMoreActions ? 'bg-[#e5f3fa] border-[#007cc0]' : ''
                }`}
              >
                <MoreHorizontal className="w-3.5 h-3.5" />
                <span>سایر عملیات</span>
              </button>
              {showMoreActions && (
                <div className="absolute left-0 mt-1.5 w-52 bg-white border border-[#d9d9d9] rounded-md shadow-lg p-1.5 z-30 space-y-1">
                  <button
                    type="button"
                    onClick={() => {
                      setShowMoreActions(false);
                      setIsMaterialIssueOpen(true);
                    }}
                    className="w-full text-right px-3 py-1.5 rounded text-xs font-medium text-[#333333] hover:bg-[#e5f3fa] hover:text-[#007cc0] flex items-center gap-2 cursor-pointer"
                  >
                    <ArrowRightLeft className="w-3.5 h-3.5 text-[#007cc0]" />
                    <span>حواله مواد به عملیات (OP)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowMoreActions(false);
                      setIsReturnOpen(true);
                    }}
                    className="w-full text-right px-3 py-1.5 rounded text-xs font-medium text-[#333333] hover:bg-[#e5f3fa] hover:text-[#007cc0] flex items-center gap-2 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5 text-[#007cc0]" />
                    <span>برگشت از خط به انبار</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowMoreActions(false);
                      setIsTransferOpen(true);
                    }}
                    className="w-full text-right px-3 py-1.5 rounded text-xs font-medium text-[#333333] hover:bg-[#e5f3fa] hover:text-[#007cc0] flex items-center gap-2 cursor-pointer"
                  >
                    <ArrowRightLeft className="w-3.5 h-3.5 text-[#007cc0]" />
                    <span>انتقال بین انبارها</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowMoreActions(false);
                      setIsAdjustmentOpen(true);
                    }}
                    className="w-full text-right px-3 py-2 rounded text-xs font-medium text-[#1D2D3E] hover:bg-[#EBF5FF] hover:text-[#0064D9] flex items-center gap-2 cursor-pointer"
                  >
                    <Scale className="w-3.5 h-3.5 text-[#0070F2]" />
                    <span>تعدیل و انبارگردانی</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Toast Notification */}
      {notification && (
        <FioriMessageStrip
          tone={notification.type === 'success' ? 'success' : 'error'}
          onClose={() => setNotification(null)}
        >
          <span className="font-medium">{notification.message}</span>
        </FioriMessageStrip>
      )}

      {/* DEDICATED ALP PAGE: Reorder Point Alerts & Material Shortages (ALERTS Sub-Tab) */}
      {activeSubTab === 'ALERTS' && (
        <FioriAnalyticalListPage
          title="پایش نقطه سفارش و کسری موجودی آزاد (SAP MM Reorder Point ALP)"
          subtitle="مقایسه موجودی آزاد (Unrestricted ATP) با حداقل موجودی اطمینان بدون احتساب اقلام قرنطینه/مسدود"
          searchValue={alertSearchQuery}
          onSearchChange={setAlertSearchQuery}
          searchPlaceholder="جستجوی نام، کد کالا، گرید ورق یا کد ساپکو..."
          totalRowsCount={filteredReorderAlerts.length}
          hasActiveFilters={alertCategoryFilter !== 'ALL' || alertSeverityFilter !== 'ALL' || Boolean(alertSearchQuery.trim())}
          onResetFilters={() => {
            setAlertCategoryFilter('ALL');
            setAlertSeverityFilter('ALL');
            setAlertSearchQuery('');
            if (route.docQuery) clearDocQuery();
          }}
          headerActions={
            onNavigateToPlanning ? (
              <button
                type="button"
                onClick={onNavigateToPlanning}
                className="sap-btn-emphasized flex items-center gap-1.5 py-1.5 px-3 text-xs cursor-pointer whitespace-nowrap"
              >
                <CalendarDays className="w-3.5 h-3.5" />
                <span>برنامه‌ریزی تولید و MRP</span>
              </button>
            ) : undefined
          }
          kpiFilters={[
            {
              id: 'ALL_ALERTS',
              label: 'کل اقلام زیر نقطه سفارش',
              value: reorderAlerts.length,
              unit: 'قلم',
              tone: 'brand',
              active: alertSeverityFilter === 'ALL' && alertCategoryFilter === 'ALL',
              onClick: () => {
                setAlertSeverityFilter('ALL');
                setAlertCategoryFilter('ALL');
              },
            },
            {
              id: 'CRITICAL_ALERTS',
              label: 'بحرانی (۰ تا ۲۵٪ پوشش)',
              value: criticalAlertsCount,
              unit: 'مورد فوری',
              tone: 'negative',
              active: alertSeverityFilter === 'CRITICAL',
              onClick: () => setAlertSeverityFilter(prev => (prev === 'CRITICAL' ? 'ALL' : 'CRITICAL')),
            },
            {
              id: 'RAW_ALERTS',
              label: 'کسری ورق و مواد اولیه',
              value: rawMaterialAlertsCount,
              unit: 'ردیف',
              tone: 'critical',
              active: alertCategoryFilter === 'RAW_MATERIAL',
              onClick: () => setAlertCategoryFilter(prev => (prev === 'RAW_MATERIAL' ? 'ALL' : 'RAW_MATERIAL')),
            },
            {
              id: 'WARNING_ALERTS',
              label: 'نیاز به شارژ عادی',
              value: Math.max(0, reorderAlerts.length - criticalAlertsCount),
              unit: 'مورد',
              tone: 'default',
              active: alertSeverityFilter === 'WARNING',
              onClick: () => setAlertSeverityFilter(prev => (prev === 'WARNING' ? 'ALL' : 'WARNING')),
            },
          ] as AlpVisualKpiItem[]}
          filterControls={
            <>
              <select
                value={alertSeverityFilter}
                onChange={e => setAlertSeverityFilter(e.target.value as any)}
                className="bg-white border border-[#bfbfbf] rounded px-2.5 py-1.5 text-xs text-[#333333] focus:outline-none focus:border-[#007cc0]"
              >
                <option value="ALL">همه سطوح هشدار</option>
                <option value="CRITICAL">فقط وضعیت بحرانی</option>
                <option value="WARNING">نیاز به شارژ عادی</option>
              </select>
              <select
                value={alertCategoryFilter}
                onChange={e => setAlertCategoryFilter(e.target.value as any)}
                className="bg-white border border-[#bfbfbf] rounded px-2.5 py-1.5 text-xs text-[#333333] focus:outline-none focus:border-[#007cc0]"
              >
                <option value="ALL">همه گروه‌های کالا</option>
                <option value="RAW_MATERIAL">ورق و مواد اولیه</option>
                <option value="WIP_PART">نیمه‌ساخته (WIP)</option>
                <option value="FINISHED_GOOD">محصول نهایی</option>
              </select>
            </>
          }
        >
          <FioriDataTable<ReorderAlertItem>
            data={filteredReorderAlerts}
            rowKey={item => item.part.id}
            compact
            emptyState={
              <EmptyState
                variant="CUSTOM"
                compact
                icon={CheckCircle2}
                title="هیچ کالایی با فیلترهای انتخابی پایین‌تر از نقطه سفارش قرار ندارد"
                description="تمام اقلام مطابق فیلترهای فعال دارای پوشش موجودی آزاد مناسب هستند."
              />
            }
            columns={[
              {
                key: 'severity',
                header: 'وضعیت',
                sortValue: item => (item.severity === 'CRITICAL' ? 0 : 1),
                render: item => (
                  <FioriObjectStatus
                    tone={item.severity === 'CRITICAL' ? 'negative' : 'critical'}
                    label={item.severity === 'CRITICAL' ? 'بحرانی' : 'نیاز به شارژ'}
                  />
                ),
              },
              {
                key: 'part',
                header: 'کد و نام کالا / ورق',
                sortValue: item => item.part.name,
                render: item => (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-semibold text-[var(--fiori-text-primary)]">{item.part.name}</span>
                    <span className="text-[11px] text-[var(--fiori-text-secondary)] font-mono fiori-ltr-code">
                      {item.part.code}
                      {item.part.sapcoCode ? ` · ${item.part.sapcoCode}` : ''}
                    </span>
                  </div>
                ),
              },
              {
                key: 'specs',
                header: 'گروه و مشخصات فنی',
                render: item => (
                  <span className="text-[var(--fiori-text-secondary)] whitespace-nowrap">
                    <span>{categoryLabels[item.part.category]}</span>
                    {(item.part.materialGrade || item.part.thicknessMm) && (
                      <span className="text-[11px] mr-1.5 font-mono fiori-ltr-code">
                        {item.part.materialGrade || ''}
                        {item.part.thicknessMm ? ` · ${toPersianDigits(item.part.thicknessMm)}mm` : ''}
                      </span>
                    )}
                  </span>
                ),
              },
              {
                key: 'currentStock',
                header: 'موجودی آزاد فعلی',
                sortValue: item => item.currentStock,
                render: item => {
                  const isKg = item.part.unit === 'KG';
                  return (
                    <span className="font-mono font-semibold text-[var(--fiori-text-primary)] tabular-nums whitespace-nowrap">
                      {isKg ? formatWeightKg(item.currentStock) : `${formatNumber(item.currentStock)} عدد`}
                    </span>
                  );
                },
              },
              {
                key: 'reorderPoint',
                header: 'نقطه سفارش',
                sortValue: item => item.reorderPoint,
                render: item => {
                  const isKg = item.part.unit === 'KG';
                  return (
                    <span className="font-mono text-[var(--fiori-text-secondary)] tabular-nums whitespace-nowrap">
                      {isKg ? formatWeightKg(item.reorderPoint) : `${formatNumber(item.reorderPoint)} عدد`}
                    </span>
                  );
                },
              },
              {
                key: 'shortageAmount',
                header: 'مقدار کسری',
                sortValue: item => item.shortageAmount,
                render: item => {
                  const isKg = item.part.unit === 'KG';
                  return (
                    <span className="font-mono font-semibold text-[var(--fiori-negative)] tabular-nums whitespace-nowrap">
                      {isKg ? formatWeightKg(item.shortageAmount) : `${formatNumber(item.shortageAmount)} عدد`}
                    </span>
                  );
                },
              },
              {
                key: 'coveragePercent',
                header: 'پوشش اطمینان',
                width: 'w-40',
                sortValue: item => item.coveragePercent,
                render: item => (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-[var(--fiori-border-subtle)] rounded-[var(--fiori-radius-sm)] overflow-hidden">
                      <div
                        className={
                          item.severity === 'CRITICAL'
                            ? 'h-full bg-[var(--fiori-negative)] rounded-[var(--fiori-radius-sm)]'
                            : 'h-full bg-[var(--fiori-critical)] rounded-[var(--fiori-radius-sm)]'
                        }
                        style={{ width: `${Math.max(4, item.coveragePercent)}%` }}
                      />
                    </div>
                    <span className="font-mono text-[11px] text-[var(--fiori-text-primary)] w-8 text-left tabular-nums">
                      {toPersianDigits(item.coveragePercent)}٪
                    </span>
                  </div>
                ),
              },
              {
                key: 'actions',
                header: 'عملیات ۱۰۱',
                align: 'left',
                render: () => (
                  <button
                    type="button"
                    onClick={() => setIsReceiptOpen(true)}
                    className="sap-btn-standard px-2.5 py-1 text-[11px] text-[var(--fiori-positive)] border-[var(--fiori-positive-border)] hover:bg-[var(--fiori-positive-bg)] cursor-pointer whitespace-nowrap"
                  >
                    ثبت رسید جبرانی (۱۰۱)
                  </button>
                ),
              },
            ] as FioriTableColumn<ReorderAlertItem>[]}
          />
        </FioriAnalyticalListPage>
      )}

      {/* Sub-Tab 1: Dashboard */}
      {activeSubTab === 'DASHBOARD' && (
        <InventoryDashboard
          metrics={metrics}
          contracts={contracts}
          warehouses={warehouses}
          balances={balances}
          loading={loading}
          onRefresh={() => loadInventoryData(true)}
          onOpenReceipt={() => setIsReceiptOpen(true)}
          onOpenIssue={() => {
            setIssueModalPreset({ subType: 'PRODUCTION_LINE', warehouseId: 'WH-RAW' });
            setIsIssueOpen(true);
          }}
          onOpenCustomerDelivery={() => {
            setIssueModalPreset({ subType: 'CUSTOMER_DELIVERY', warehouseId: 'WH-FINISHED' });
            setIsIssueOpen(true);
          }}
          onOpenTransfer={() => setIsTransferOpen(true)}
          onOpenAdjustment={() => setIsAdjustmentOpen(true)}
          onNavigateToInquiry={() => setActiveSubTab('INQUIRY')}
          onNavigateToSapco={() => setActiveSubTab('CONTRACTS')}
          onNavigateToLedger={() => setActiveSubTab('MOVEMENT')}
        />
      )}

      {/* Sub-Tab: Contracts Management & Product/Material Commitments */}
      {activeSubTab === 'CONTRACTS' && (
        <ContractsManagementView
          contracts={contracts}
          parts={parts}
          coils={coils}
          loading={loading}
          onRefresh={() => loadInventoryData(true)}
          onViewContractLedger={() => {
            setActiveSubTab('SAPCO');
          }}
          currentUser={currentUser}
        />
      )}

      {/* Sub-Tab 2: Stock Inquiry */}
      {activeSubTab === 'INQUIRY' && (
        <StockInquiryView
          balances={balances}
          parts={parts}
          warehouses={warehouses}
          loading={loading}
          onRefresh={() => loadInventoryData(true)}
          onQmTransferApplied={handleOptimisticQmApplied}
        />
      )}

      {/* Sub-Tab: Physical Coils & Multi-Contract Tracking */}
      {activeSubTab === 'COILS' && (
        <PhysicalCoilsView
          currentUser={currentUser}
          initialSearchQuery={initialSearchQuery}
          onRefresh={() => loadInventoryData(true)}
        />
      )}

      {/* Sub-Tab: Customizable Reports */}
      {activeSubTab === 'CUSTOM_REPORTS' && (
        <CustomReportsView />
      )}

      {/* Sub-Tab: Data Import & Export */}
      {activeSubTab === 'IMPORT_EXPORT' && (
        <DataImportExportView
          currentUser={currentUser}
          onSuccess={async () => {
            await loadInventoryData(true);
          }}
        />
      )}

      {/* Sub-Tab 3: Movement Ledger */}
      {activeSubTab === 'MOVEMENT' && (
        <MovementHistoryView
          documents={documents}
          warehouses={warehouses}
          loading={loading}
          initialSearchTerm={initialSearchQuery}
          userRole={currentUser.role}
          onRefresh={() => loadInventoryData(true)}
          onReverseDocument={handleReverseDocument}
        />
      )}

      {/* Sub-Tab 4: SAPCO Quota Account */}
      {activeSubTab === 'SAPCO' && (
        <SapcoAccountReportView
          contracts={contracts}
          ledger={sapcoLedger}
          loading={loading}
          onRefresh={() => loadInventoryData(true)}
        />
      )}

      {/* Sub-Tab 5: Multi-Stage WIP Balances */}
      {activeSubTab === 'STAGES' && (
        <InventoryReportView
          balances={stageBalances}
          onRefresh={onGlobalRefresh || (() => loadInventoryData(true))}
          loading={loading}
        />
      )}

      {/* Quality Management & Product Quality Control (P6 QM Workbench) */}
      {activeSubTab === 'QUALITY_QM' && (
        <QualityUsageDecisionView
          parts={parts}
          balances={balances}
          stageBalances={stageBalances}
          coils={coils}
          warehouses={warehouses}
          currentUser={currentUser}
          onGlobalRefresh={async () => {
            await loadInventoryData(true);
            if (onGlobalRefresh) await onGlobalRefresh();
          }}
        />
      )}

      {/* Sub-Tab: 4-Way Reconciliation, Cycle-Count & Material Traceability */}
      {activeSubTab === 'RECONCILIATION' && (
        <InventoryReconciliationView
          parts={parts}
          warehouses={warehouses}
          balances={balances}
          coils={coils}
          currentUser={currentUser}
          onRefresh={async () => {
            await loadInventoryData(true);
            if (onGlobalRefresh) await onGlobalRefresh();
          }}
        />
      )}

      {/* Modals */}
      <ReceiptFormModal
        isOpen={isReceiptOpen}
        onClose={() => setIsReceiptOpen(false)}
        parts={parts}
        warehouses={warehouses}
        contracts={contracts}
        initialDraft={initialReceiptDraft}
        onSubmit={handleCreateDocument}
        onItemCreated={() => loadInventoryData(true)}
      />

      <IssueFormModal
        isOpen={isIssueOpen}
        onClose={() => {
          setIsIssueOpen(false);
          setIssueModalPreset(null);
        }}
        parts={parts}
        warehouses={warehouses}
        customers={customers}
        contracts={contracts}
        balances={balances}
        initialDraft={issueModalPreset || initialIssueDraft}
        onSubmit={handleCreateDocument}
        onItemCreated={() => loadInventoryData(true)}
      />

      <ReturnFromProductionModal
        isOpen={isReturnOpen}
        onClose={() => setIsReturnOpen(false)}
        coils={coils}
        warehouses={warehouses}
        parts={parts}
        balances={balances}
        currentUser={currentUser}
        onSubmitDocument={handleCreateDocument}
        onSuccess={async () => {
          setNotification({
            type: 'success',
            message: 'برگشت مواد / ته‌کلاف از خط تولید (کد حرکت ۲۶۲) ثبت و به موجودی انبار اضافه شد.',
          });
          await loadInventoryData(true);
        }}
      />

      <TransferFormModal
        isOpen={isTransferOpen}
        onClose={() => setIsTransferOpen(false)}
        parts={parts}
        warehouses={warehouses}
        balances={balances}
        onSubmit={handleCreateDocument}
        onItemCreated={() => loadInventoryData(true)}
      />

      <MaterialIssueModal
        isOpen={isMaterialIssueOpen}
        onClose={() => setIsMaterialIssueOpen(false)}
        onSuccess={async () => {
          setNotification({ type: 'success', message: 'حواله مواد (کد حرکت ۲۶۱) با موفقیت به محل پای‌کار عملیات منتقل شد.' });
          await loadInventoryData(true);
        }}
      />

      <AdjustmentFormModal
        isOpen={isAdjustmentOpen}
        onClose={() => setIsAdjustmentOpen(false)}
        parts={parts}
        warehouses={warehouses}
        balances={balances}
        onSubmit={handleCreateDocument}
        onItemCreated={loadInventoryData}
      />
    </div>
  );
};
