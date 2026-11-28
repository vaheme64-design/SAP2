import React, { useState, useEffect, useCallback } from 'react';
import {
  Boxes,
  Layers,
  ArrowRightLeft,
  CheckCircle2,
  AlertCircle,
  Plus,
  RefreshCw,
  Folder,
  ChevronDown,
  ChevronLeft,
  Clock,
  Play,
  ShieldCheck,
  Gauge,
  AlertTriangle,
  ExternalLink,
  Trash2,
  ShieldAlert,
  BookOpen,
  MapPin,
  Cpu,
  QrCode,
  LayoutDashboard,
  Warehouse,
  Scale,
  FileText,
  PackagePlus,
} from 'lucide-react';
import {
  Part,
  Machine,
  Operator,
  Routing,
  FactoryHall,
  StageInventorySummary,
  ProcessType,
  FACTORY_STAGES,
  resolveStageDisplayName,
} from '../../types/inventory';
import {
  ManufacturingOrder,
  ManufacturingOperation,
  WipTransfer,
  WipDashboardMetrics,
} from '../../types/productionWip';
import { formatNumber, toPersianDigits } from '../../utils/formatters';
import { WipDashboardView } from './WipDashboardView';
import { ManufacturingOrdersView } from './ManufacturingOrdersView';
import { InterOperationTransfersView } from './InterOperationTransfersView';
import { WipReconciliationModal } from './WipReconciliationModal';
import { CreateMoModal } from './CreateMoModal';
import { OperationInputModal } from './OperationInputModal';
import { OperationProductionModal } from './OperationProductionModal';
import { OperationTransferModal } from './OperationTransferModal';
import { InventoryReportView } from '../InventoryReportView';
import { WipModuleSkeleton } from '../ui/Skeleton';
import { TraceabilityInquiryView } from './TraceabilityInquiryView';
import { useErpRouter } from '../../context/RouterContext';
import { useEnterpriseUx } from '../../context/EnterpriseUxContext';
import { MoRelationalGuideModal } from '../production/MoRelationalGuideModal';
import { WipHallMoDistributionChart } from './WipHallMoDistributionChart';
import { usePersistedOpen, usePersistedExpandMap } from '../../hooks/usePersistedCollapse';
import {
  FioriDataTable,
  FioriDialog,
  FioriDynamicPage,
  FioriFilterBar,
  FioriIconTabBar,
  FioriKpiStrip,
  FioriMessageStrip,
  FioriObjectStatus,
  FioriTableColumn,
  FioriToolbar,
} from '../fiori/ui';
import { EmptyState } from '../common/EmptyState';

export type WipViewMode =
  | 'UNIFIED_DIRECTORY'
  | 'TRACEABILITY'
  | 'DASHBOARD'
  | 'BOTTLENECK'
  | 'ORDERS'
  | 'TRANSFERS'
  | 'STAGES';

interface MoRollbackPreviewData {
  rootMoId: string;
  rootMoNumber: string;
  canRollback: boolean;
  blockingErrors: string[];
  mosToDelete: Array<{
    id: string;
    moNumber: string;
    partId: string;
    partCode: string;
    partName: string;
    targetQuantity: number;
    initialInputQuantity: number;
    completedQuantity: number;
    status: string;
    isSubMo: boolean;
    operationsCount: number;
  }>;
  materialsToReturn: Array<{
    documentId: string;
    documentNumber: string;
    partId: string;
    partCode: string;
    partName: string;
    quantity: number;
    quantityKg: number;
    unit: string;
    warehouseId: string;
    warehouseName: string;
    lotNumber?: string;
  }>;
  outputsToDeduct: Array<{
    documentId: string;
    documentNumber: string;
    partId: string;
    partCode: string;
    partName: string;
    quantity: number;
    quantityKg: number;
    unit: string;
    warehouseId: string;
    warehouseName: string;
    lotNumber?: string;
    availableAfterIssueReturn: number;
    shortage: number;
  }>;
  draftDocsToCancel: Array<{ id: string; documentNumber: string; documentType: string }>;
  wipTransfersCount: number;
  productionLogsCount: number;
  reservationsCount: number;
  kardexTransactionsCount: number;
}

interface ProductionWipModuleViewProps {
  parts: Part[];
  machines: Machine[];
  operators: Operator[];
  halls?: FactoryHall[];
  stageBalances: StageInventorySummary[];
  initialView?: WipViewMode;
  initialTraceQuery?: string;
  onViewChange?: (view: WipViewMode) => void;
  onGlobalRefresh?: () => Promise<void>;
}

export const ProductionWipModuleView: React.FC<ProductionWipModuleViewProps> = ({
  parts,
  machines,
  operators,
  halls = [],
  stageBalances,
  initialView,
  initialTraceQuery,
  onViewChange,
  onGlobalRefresh,
}) => {
  const router = useErpRouter();
  const { requestConfirm } = useEnterpriseUx();
  const [activeView, setActiveView] = useState<WipViewMode>(initialView || 'UNIFIED_DIRECTORY');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notification, setNotification] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // Core WIP Data
  const [metrics, setMetrics] = useState<WipDashboardMetrics | null>(null);
  const [orders, setOrders] = useState<ManufacturingOrder[]>([]);
  const [transfers, setTransfers] = useState<WipTransfer[]>([]);
  const [routings, setRoutings] = useState<Routing[]>([]);

  // Unified Search & Filters
  const [searchQuery, setSearchQuery] = useState(initialTraceQuery || '');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [onlyActiveQueue, setOnlyActiveQueue] = useState(false);
  const {
    map: expandedGroups,
    toggle: toggleGroup,
    expandAll: expandAllGroups,
    collapseAll: collapseAllGroups,
  } = usePersistedExpandMap('wip_unified_groups', {});
  const {
    map: expandedMoIds,
    setExpanded: setMoExpanded,
    toggle: toggleMoExpand,
    expandAll: expandAllMos,
    collapseAll: collapseAllMos,
  } = usePersistedExpandMap('wip_unified_mos', {});
  const [selectedBottleneckStageId, setSelectedBottleneckStageId] = useState<string | null>(null);
  const [showBottleneckPanel, setShowBottleneckPanel] = usePersistedOpen('wip_bottleneck_panel', false);

  useEffect(() => {
    if (initialView) {
      setActiveView(initialView);
    }
  }, [initialView]);

  const handleChangeView = useCallback(
    (next: WipViewMode) => {
      setActiveView(next);
      if (onViewChange) {
        onViewChange(next);
      } else {
        router.navigate({ wipSubTab: next });
      }
    },
    [onViewChange, router],
  );

  useEffect(() => {
    if (initialTraceQuery !== undefined && initialTraceQuery !== '') {
      setSearchQuery(initialTraceQuery);
    }
  }, [initialTraceQuery]);

  // Action Modals State
  const [isCreateMoOpen, setIsCreateMoOpen] = useState(false);
  const [inputModalOp, setInputModalOp] = useState<ManufacturingOperation | null>(null);
  const [prodModalOp, setProdModalOp] = useState<ManufacturingOperation | null>(null);
  const [transferModalContext, setTransferModalContext] = useState<{
    mo: ManufacturingOrder | null;
    op: ManufacturingOperation | null;
  }>({ mo: null, op: null });
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const [reconciliationMoId, setReconciliationMoId] = useState<string | null>(null);
  const [loadMatModalMo, setLoadMatModalMo] = useState<ManufacturingOrder | null>(null);
  const [loadMatQty, setLoadMatQty] = useState<number>(0);
  const [loadMatSourceBalanceId, setLoadMatSourceBalanceId] = useState<string>('');
  const [materialSources, setMaterialSources] = useState<any[]>([]);
  const [materialSourcesLoading, setMaterialSourcesLoading] = useState<boolean>(false);
  const [loadMatNotes, setLoadMatNotes] = useState<string>('');
  const [loadMatSubmitting, setLoadMatSubmitting] = useState<boolean>(false);

  // Cascading MO Delete + Inventory Rollback Modal State
  const [rollbackModalTarget, setRollbackModalTarget] = useState<ManufacturingOrder | null>(null);
  const [rollbackPreview, setRollbackPreview] = useState<MoRollbackPreviewData | null>(null);
  const [rollbackLoading, setRollbackLoading] = useState(false);
  const [rollbackSubmitting, setRollbackSubmitting] = useState(false);
  const [rollbackReason, setRollbackReason] = useState('');
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const [isMoGuideOpen, setIsMoGuideOpen] = useState(false);

  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  const loadWipData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [metricsRes, mosRes, transfersRes, routingsRes] = await Promise.all([
        fetch('/api/wip/dashboard').then(r => r.json()).catch(() => ({ success: false })),
        fetch('/api/wip/manufacturing-orders').then(r => r.json()).catch(() => ({ success: false })),
        fetch('/api/wip/transfers').then(r => r.json()).catch(() => ({ success: false })),
        fetch('/api/routings').then(r => r.json()).catch(() => ({ success: false })),
      ]);

      if (metricsRes.success) setMetrics(metricsRes.data);
      if (mosRes.success && Array.isArray(mosRes.data)) {
        setOrders(mosRes.data);
      }
      if (transfersRes.success && Array.isArray(transfersRes.data)) {
        setTransfers(transfersRes.data);
      }
      if (routingsRes.success && Array.isArray(routingsRes.data)) {
        setRoutings(routingsRes.data);
      }

      if (!metricsRes.success && !mosRes.success) {
        setLoadError('خطا در دریافت داده‌های کار در جریان ساخت از سرور. لطفاً اتصال سرور را بررسی و دوباره تلاش کنید.');
      }
    } catch (err) {
      console.error('Error loading WIP module data:', err);
      setLoadError('خطا در ارتباط با سرور برای بارگذاری اطلاعات کار در جریان ساخت (WIP).');
      setNotification({
        type: 'error',
        message: 'خطا در بارگذاری اطلاعات کار در جریان ساخت (WIP)',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWipData();
  }, [loadWipData, parts]);

  useEffect(() => {
    const handler = () => {
      loadWipData();
    };
    window.addEventListener('kpims-master-data-updated', handler);
    return () => window.removeEventListener('kpims-master-data-updated', handler);
  }, [loadWipData]);

  useEffect(() => {
    if (!loadMatModalMo) return;
    let cancelled = false;
    setMaterialSourcesLoading(true);
    setLoadMatSourceBalanceId('');
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
  }, [loadMatModalMo]);

  const bottleneckAnalysis = React.useMemo(() => {
    const STAGE_PROCESS_MAP: Record<string, ProcessType[]> = {
      STAGE_SHEARING: ['SHEARING'],
      STAGE_BLANKING: ['BLANKING'],
      STAGE_STAMPING: ['BLANKING', 'DRAWING', 'PUNCH_FORM', 'TRIMMING'],
      STAGE_FORMING: ['DRAWING', 'PUNCH_FORM', 'TRIMMING'],
      STAGE_BENDING: ['BENDING'],
      STAGE_SPOT_WELD: ['SPOT_WELD'],
      STAGE_CO2_WELD: ['CO2_WELD'],
      STAGE_WELDING: ['SPOT_WELD', 'CO2_WELD'],
      STAGE_PAINT: ['PAINT'],
      STAGE_ED_PAINT: ['PAINT'],
      STAGE_ASSEMBLY: ['ASSEMBLY'],
    };

    const EXCLUDED_NON_WIP_STAGES = new Set([
      'STAGE_RAW_STORE',
      'STAGE_FINISHED_STORE',
      'STAGE_SCRAP_YARD',
    ]);

    const routingByPartId = new Map<string, Routing>();
    const routingByPartCode = new Map<string, Routing>();
    const cycleStatsByProcess = new Map<ProcessType, { sumSec: number; sumSetup: number; count: number }>();

    for (const r of routings) {
      if (r.partId) routingByPartId.set(r.partId, r);
      if (r.partCode) routingByPartCode.set(r.partCode.toUpperCase(), r);
      for (const op of r.operations || []) {
        const cur = cycleStatsByProcess.get(op.processType) || { sumSec: 0, sumSetup: 0, count: 0 };
        cur.sumSec += op.standardCycleTimeSec || 15;
        cur.sumSetup += op.setupTimeMin || 15;
        cur.count += 1;
        cycleStatsByProcess.set(op.processType, cur);
      }
    }

    const stageMetaMap = new Map<string, { id: string; name: string; orderIndex: number }>();
    let idxCounter = 0;
    for (const st of FACTORY_STAGES) {
      if (st.type === 'WIP') {
        stageMetaMap.set(st.id, { id: st.id, name: st.name, orderIndex: idxCounter++ });
      }
    }

    const balancesByStage = new Map<string, StageInventorySummary[]>();
    for (const sb of stageBalances) {
      if (EXCLUDED_NON_WIP_STAGES.has(sb.stageId)) continue;
      if (!stageMetaMap.has(sb.stageId)) {
        stageMetaMap.set(sb.stageId, {
          id: sb.stageId,
          name: resolveStageDisplayName(sb.stageId, sb.stageName),
          orderIndex: idxCounter++,
        });
      }
      const list = balancesByStage.get(sb.stageId) || [];
      list.push(sb);
      balancesByStage.set(sb.stageId, list);
    }

    let totalWipQtyAllStages = 0;
    let totalThroughputAllHours = 0;

    const stageRows = Array.from(stageMetaMap.values()).map(meta => {
      const stageItems = (balancesByStage.get(meta.id) || []).filter(sb => sb.totalQty > 0);
      const mappedProcs = STAGE_PROCESS_MAP[meta.id] || [];

      let stageAvgCycleSec = 15;
      let stageAvgSetupMin = 15;
      if (mappedProcs.length > 0) {
        let sSec = 0;
        let sSetup = 0;
        let sCnt = 0;
        for (const p of mappedProcs) {
          const stat = cycleStatsByProcess.get(p);
          if (stat) {
            sSec += stat.sumSec;
            sSetup += stat.sumSetup;
            sCnt += stat.count;
          }
        }
        if (sCnt > 0) {
          stageAvgCycleSec = sSec / sCnt;
          stageAvgSetupMin = sSetup / sCnt;
        }
      }

      let totalQty = 0;
      let usableQty = 0;
      let inTransitQty = 0;
      let scrapQty = 0;
      let throughputHours = 0;
      let weightedCycleSum = 0;

      const partBreakdown = stageItems
        .map(sb => {
          const routing =
            routingByPartId.get(sb.partId) ||
            routingByPartCode.get((sb.partCode || '').toUpperCase());

          let matchedOp = routing?.operations?.find(
            op =>
              mappedProcs.includes(op.processType) ||
              (sb.processType && op.processType === sb.processType),
          );
          if (!matchedOp && routing?.operations?.length) {
            // Fallback to mean of the part's routing operations when stage ID isn't explicitly mapped
            const opsCount = routing.operations.length;
            const avgCyc = routing.operations.reduce((s, o) => s + (o.standardCycleTimeSec || 15), 0) / opsCount;
            const avgSet = routing.operations.reduce((s, o) => s + (o.setupTimeMin || 15), 0) / opsCount;
            matchedOp = {
              stepNumber: 1,
              stepCode: meta.id,
              stepName: meta.name,
              processType: mappedProcs[0] || 'PUNCH_FORM',
              standardCycleTimeSec: avgCyc,
              setupTimeMin: avgSet,
              scrapNormPercent: 1.5,
            };
          }

          const cycleTimeSec = matchedOp?.standardCycleTimeSec || stageAvgCycleSec;
          const setupTimeMin = matchedOp?.setupTimeMin ?? stageAvgSetupMin;
          const partThroughputHours = Number(
            ((sb.totalQty * cycleTimeSec) / 3600 + setupTimeMin / 60).toFixed(2),
          );

          totalQty += sb.totalQty;
          usableQty += sb.usableQty;
          inTransitQty += sb.inTransitQty;
          scrapQty += sb.scrapQty;
          throughputHours += partThroughputHours;
          weightedCycleSum += sb.totalQty * cycleTimeSec;

          return {
            partId: sb.partId,
            partCode: sb.partCode,
            partName: sb.partName,
            qty: sb.totalQty,
            usableQty: sb.usableQty,
            inTransitQty: sb.inTransitQty,
            cycleTimeSec: Number(cycleTimeSec.toFixed(1)),
            setupTimeMin: Math.round(setupTimeMin),
            throughputHours: partThroughputHours,
            hasExactRouting: Boolean(routing),
          };
        })
        .sort((a, b) => b.throughputHours - a.throughputHours);

      const roundedThroughputHours = Number(throughputHours.toFixed(1));
      totalWipQtyAllStages += totalQty;
      totalThroughputAllHours += roundedThroughputHours;

      return {
        stageId: meta.id,
        stageName: meta.name,
        orderIndex: meta.orderIndex,
        totalQty,
        usableQty,
        inTransitQty,
        scrapQty,
        partsCount: partBreakdown.length,
        avgCycleTimeSec: totalQty > 0 ? Number((weightedCycleSum / totalQty).toFixed(1)) : Number(stageAvgCycleSec.toFixed(1)),
        throughputHours: roundedThroughputHours,
        shiftLoad: Number((roundedThroughputHours / 7.5).toFixed(2)),
        partBreakdown,
      };
    });

    const maxThroughputHours = Math.max(1, ...stageRows.map(s => s.throughputHours));

    const enrichedStages = stageRows.map(s => {
      const wipSharePercent =
        totalWipQtyAllStages > 0 ? Math.round((s.totalQty / totalWipQtyAllStages) * 100) : 0;
      const barWidthPercent = Math.min(100, Math.round((s.throughputHours / maxThroughputHours) * 100));

      let severity: 'CRITICAL' | 'WARNING' | 'NORMAL' | 'IDLE' = 'IDLE';
      if (
        s.throughputHours >= 15 ||
        (s.totalQty >= 2000 && s.throughputHours >= 8) ||
        (wipSharePercent >= 35 && s.throughputHours >= 6)
      ) {
        severity = 'CRITICAL';
      } else if (s.throughputHours >= 7.5 || s.totalQty >= 800 || wipSharePercent >= 25) {
        severity = 'WARNING';
      } else if (s.totalQty > 0) {
        severity = 'NORMAL';
      }

      return {
        ...s,
        wipSharePercent,
        barWidthPercent,
        severity,
      };
    });

    const peakStage =
      [...enrichedStages].sort((a, b) => b.throughputHours - a.throughputHours)[0] || null;
    const criticalCount = enrichedStages.filter(s => s.severity === 'CRITICAL').length;
    const warningCount = enrichedStages.filter(s => s.severity === 'WARNING').length;

    return {
      stages: enrichedStages,
      totalWipQtyAllStages,
      totalThroughputAllHours: Number(totalThroughputAllHours.toFixed(1)),
      maxThroughputHours,
      peakStage,
      criticalCount,
      warningCount,
    };
  }, [stageBalances, routings]);

  // Show shared Skeleton component during initial data loading phase
  if (loading && orders.length === 0 && !metrics) {
    return <WipModuleSkeleton />;
  }

  // API Handlers
  const handleCreateMo = async (payload: any) => {
    try {
      const res = await fetch('/api/wip/manufacturing-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        if (res.status === 409 || data.conflict) {
          await loadWipData();
        }
        return { success: false, error: data.error || 'خطا در ثبت دستور کار' };
      }
      setNotification({
        type: 'success',
        message: data.message || 'دستور کار ساخت (MO) با موفقیت صادر شد.',
      });
      await loadWipData();
      if (onGlobalRefresh) await onGlobalRefresh();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  };

  const handleLoadMaterial = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loadMatModalMo || loadMatQty <= 0 || !loadMatSourceBalanceId) return;
    setLoadMatSubmitting(true);
    try {
      const res = await fetch(`/api/wip/manufacturing-orders/${loadMatModalMo.id}/load-material`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quantity: loadMatQty,
          sourceStockBalanceId: loadMatSourceBalanceId,
          expectedVersion: loadMatModalMo.version,
          operatorName: 'اپراتور خط تولید',
          notes: loadMatNotes || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        if (res.status === 409 || data.conflict) {
          await loadWipData();
        }
        setNotification({
          type: 'error',
          message: data.error || 'خطا در بارگذاری مواد به دستور کار',
        });
        return;
      }
      setNotification({
        type: 'success',
        message: data.message || 'مواد اولیه / بلنک با موفقیت در دستور کار بارگذاری شد.',
      });
      setLoadMatModalMo(null);
      setLoadMatQty(0);
      setLoadMatSourceBalanceId('');
      setLoadMatNotes('');
      await loadWipData();
      if (onGlobalRefresh) await onGlobalRefresh();
    } catch (err: any) {
      setNotification({
        type: 'error',
        message: err.message || 'خطا در ارتباط با سرور',
      });
    } finally {
      setLoadMatSubmitting(false);
    }
  };

  const handleRecordInput = async (payload: any) => {
    try {
      const res = await fetch('/api/wip/operations/input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        if (res.status === 409 || data.conflict) {
          await loadWipData();
        }
        return { success: false, error: data.error || 'خطا در ثبت ورودی ایستگاه' };
      }
      setNotification({
        type: 'success',
        message: data.message || 'ورودی ایستگاه با موفقیت ثبت شد.',
      });
      await loadWipData();
      if (onGlobalRefresh) await onGlobalRefresh();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  };

  const handleRecordProduction = async (payload: any) => {
    try {
      const res = await fetch('/api/wip/operations/production', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        if (res.status === 409 || data.conflict) {
          await loadWipData();
        }
        return { success: false, error: data.error || 'خطا در ثبت گزارش تولید' };
      }
      setNotification({
        type: 'success',
        message: data.message || 'گزارش تولید و ضایعات ایستگاه با موفقیت ثبت شد.',
      });
      await loadWipData();
      if (onGlobalRefresh) await onGlobalRefresh();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  };

  const handleCreateTransfer = async (payload: any) => {
    try {
      const res = await fetch('/api/wip/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        if (res.status === 409 || data.conflict) {
          await loadWipData();
        }
        return { success: false, error: data.error || 'خطا در ثبت حواله انتقال' };
      }
      setNotification({
        type: 'success',
        message: data.message || 'حواله انتقال بین مراحل صادر شد.',
      });
      await loadWipData();
      if (onGlobalRefresh) await onGlobalRefresh();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  };

  const handleApproveTransfer = async (transferId: string, notes?: string) => {
    try {
      const currentTransfer = transfers.find(t => t.id === transferId);
      const res = await fetch(`/api/wip/transfers/${transferId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receivedBy: 'اپراتور ایستگاه مقصد',
          notes: notes || 'تأیید دریافت در ایستگاه مقصد',
          expectedVersion: currentTransfer?.version,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        if (res.status === 409 || data.conflict) {
          await loadWipData();
        }
        setNotification({
          type: 'error',
          message: data.error || 'خطا در تأیید دریافت حواله',
        });
        return { success: false, error: data.error || 'خطا در تأیید دریافت حواله' };
      }
      setNotification({
        type: 'success',
        message: data.message || 'دریافت قطعات در ایستگاه مقصد تأیید شد.',
      });
      await loadWipData();
      if (onGlobalRefresh) await onGlobalRefresh();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  };

  const handleRejectTransfer = async (transferId: string, reason: string) => {
    try {
      const currentTransfer = transfers.find(t => t.id === transferId);
      const res = await fetch(`/api/wip/transfers/${transferId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rejectionReason: reason,
          expectedVersion: currentTransfer?.version,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        if (res.status === 409 || data.conflict) {
          await loadWipData();
        }
        return { success: false, error: data.error || 'خطا در رد حواله انتقال' };
      }
      setNotification({
        type: 'success',
        message: data.message || 'حواله انتقال رد شد و موجودی به ایستگاه مبدأ بازگشت.',
      });
      await loadWipData();
      if (onGlobalRefresh) await onGlobalRefresh();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  };

  const filteredOrders = orders.filter(mo => {
    if (statusFilter !== 'ALL' && mo.status !== statusFilter) return false;
    if (onlyActiveQueue) {
      const hasActive = mo.operations.some(
        o =>
          o.waitingInputQty > 0 ||
          o.inProgressQty > 0 ||
          o.readyForTransferQty > 0
      );
      if (!hasActive) return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        mo.moNumber.toLowerCase().includes(q) ||
        mo.partName.toLowerCase().includes(q) ||
        mo.partCode.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const toggleMoRow = (moId: string, moNumber?: string) => {
    const nextOpen = !expandedMoIds[moId];
    toggleMoExpand(moId);
    if (nextOpen && moNumber) {
      router.pushSelectionStep(
        `عملیات دستور ${moNumber}`,
        () => setMoExpanded(moId, false),
        `wip-mo-${moId}`,
      );
    }
  };

  const selectBottleneckStage = (stageId: string | null, stageName?: string) => {
    setSelectedBottleneckStageId(stageId);
    if (stageId) {
      router.pushSelectionStep(
        `گلوگاه: ${stageName || stageId}`,
        () => setSelectedBottleneckStageId(null),
        `wip-stage-${stageId}`,
      );
    }
  };

  const openMoRollbackModal = async (mo: ManufacturingOrder) => {
    setRollbackModalTarget(mo);
    setRollbackPreview(null);
    setRollbackReason('');
    setRollbackError(null);
    setRollbackLoading(true);
    try {
      const res = await fetch(
        `/api/wip/manufacturing-orders/${encodeURIComponent(mo.id)}/rollback-preview?cascadeSubMos=true`,
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        setRollbackError(json.error || 'خطا در محاسبه تأثیر حذف و بازگشت موجودی');
      } else {
        setRollbackPreview(json.data);
      }
    } catch (err: any) {
      setRollbackError(err.message || 'خطا در ارتباط با سرور');
    } finally {
      setRollbackLoading(false);
    }
  };

  const handleConfirmMoDeleteRollback = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rollbackModalTarget || !rollbackPreview) return;
    if (rollbackReason.trim().length < 3) {
      setRollbackError('لطفاً دلیل حذف و ابطال را حداقل با ۳ کاراکتر وارد نمایید.');
      return;
    }
    if (!rollbackPreview.canRollback) {
      setRollbackError(rollbackPreview.blockingErrors[0] || 'امکان بازگشت موجودی به دلیل کسری موجودی خروجی وجود ندارد.');
      return;
    }
    setRollbackSubmitting(true);
    setRollbackError(null);
    try {
      const res = await fetch(
        `/api/wip/manufacturing-orders/${encodeURIComponent(rollbackModalTarget.id)}`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reason: rollbackReason.trim(),
            cascadeSubMos: true,
          }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        setRollbackError(json.error || 'خطا در حذف دستور تولید و بازگشت موجودی');
        return;
      }
      setNotification({
        type: 'success',
        message:
          json.message ||
          `دستور تولید ${rollbackModalTarget.moNumber} و زیرمجموعه‌های آن با موفقیت حذف شد و موجودی انبار به حالت قبل بازگشت.`,
      });
      setRollbackModalTarget(null);
      setRollbackPreview(null);
      await loadWipData();
      if (onGlobalRefresh) await onGlobalRefresh();
      window.dispatchEvent(new CustomEvent('kpims-master-data-updated'));
    } catch (err: any) {
      setRollbackError(err.message || 'خطا در ارتباط با سرور');
    } finally {
      setRollbackSubmitting(false);
    }
  };

  const pendingTransfersCount = transfers.filter(t => t.status === 'PENDING_APPROVAL').length;
  const activeFiltersCount =
    (searchQuery.trim() ? 1 : 0) +
    (statusFilter !== 'ALL' ? 1 : 0) +
    (onlyActiveQueue ? 1 : 0);

  const showMoFilterBar =
    activeView === 'UNIFIED_DIRECTORY' ||
    activeView === 'ORDERS' ||
    activeView === 'BOTTLENECK' ||
    activeView === 'DASHBOARD';

  const resetMoFilters = () => {
    setSearchQuery('');
    setStatusFilter('ALL');
    setOnlyActiveQueue(false);
  };

  return (
    <FioriDynamicPage
      title="قطعات در جریان ساخت و ایستگاه‌ها (WIP)"
      subtitle="ردیابی موقعیت فعلی قطعات در زنجیره عملیات، مدیریت صف ایستگاه‌های پرس و جوش، و حواله‌های انتقال بین مراحل"
      status={
        metrics?.overallConservationIntegrity ? (
          <FioriObjectStatus
            tone="positive"
            label="تراز پایستگی تایید شده"
            icon={<ShieldCheck className="w-3 h-3" />}
          />
        ) : undefined
      }
      collapsibleFilters={false}
      activeFiltersCount={showMoFilterBar ? activeFiltersCount : 0}
      onResetFilters={showMoFilterBar ? resetMoFilters : undefined}
      headerActions={
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => setIsMoGuideOpen(true)}
            className="sap-btn-standard inline-flex items-center gap-1.5 px-3 py-1.5 text-xs whitespace-nowrap text-[var(--fiori-brand)]"
            title="راهنمای تصویری ثبت MO، صدور سرکلاف و رفع خطای OP10"
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>راهنمای MO / OP10</span>
          </button>
          <button
            type="button"
            onClick={loadWipData}
            disabled={loading}
            className="sap-btn-standard inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-[var(--fiori-brand)] ${loading ? 'animate-spin' : ''}`} />
            <span>به‌روزرسانی</span>
          </button>
          <button
            type="button"
            onClick={() => setIsCreateMoOpen(true)}
            className="sap-btn-emphasized inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>دستور کار جدید (MO)</span>
          </button>
        </div>
      }
      tabs={
        <FioriIconTabBar
          activeTab={activeView}
          onChange={id => handleChangeView(id as WipViewMode)}
          tabs={[
            {
              id: 'UNIFIED_DIRECTORY',
              label: 'جریان یکپارچه عملیات',
              icon: <Boxes className="w-3.5 h-3.5" />,
              count: orders.length,
              badgeTone: 'brand',
            },
            {
              id: 'ORDERS',
              label: 'کارت‌های دستور کار',
              icon: <Layers className="w-3.5 h-3.5" />,
              count: filteredOrders.length,
              badgeTone: 'neutral',
            },
            {
              id: 'TRANSFERS',
              label: 'حواله‌های انتقال',
              icon: <ArrowRightLeft className="w-3.5 h-3.5" />,
              count: pendingTransfersCount > 0 ? pendingTransfersCount : transfers.length,
              badgeTone: pendingTransfersCount > 0 ? 'critical' : 'neutral',
            },
            {
              id: 'BOTTLENECK',
              label: 'گلوگاه ایستگاه‌ها',
              icon: <Gauge className="w-3.5 h-3.5" />,
              count: bottleneckAnalysis.criticalCount > 0 ? bottleneckAnalysis.criticalCount : undefined,
              badgeTone: 'negative',
            },
            {
              id: 'TRACEABILITY',
              label: 'رهگیری قطعه',
              icon: <QrCode className="w-3.5 h-3.5" />,
            },
            {
              id: 'STAGES',
              label: 'موجودی ایستگاه‌ها',
              icon: <Warehouse className="w-3.5 h-3.5" />,
            },
            {
              id: 'DASHBOARD',
              label: 'داشبورد تحلیلی',
              icon: <LayoutDashboard className="w-3.5 h-3.5" />,
            },
          ]}
          endContent={
            <button
              type="button"
              onClick={() =>
                handleChangeView(activeView === 'BOTTLENECK' ? 'UNIFIED_DIRECTORY' : 'BOTTLENECK')
              }
              className={`hidden 2xl:inline-flex px-2.5 py-1 rounded-[var(--fiori-radius-sm)] border text-[11px] font-semibold cursor-pointer items-center gap-1.5 transition-colors tabular-nums whitespace-nowrap ${
                activeView === 'BOTTLENECK'
                  ? 'bg-[var(--fiori-brand)] text-white border-[var(--fiori-brand)]'
                  : bottleneckAnalysis.criticalCount > 0
                  ? 'bg-[var(--fiori-negative-bg)] text-[var(--fiori-negative)] border-[var(--fiori-negative-border)]'
                  : 'bg-[var(--fiori-bg-subtle)] text-[var(--fiori-text-secondary)] border-[var(--fiori-border-default)] hover:text-[var(--fiori-text-primary)]'
              }`}
              title="نمایش تحلیلگر زنده گلوگاه ایستگاه‌ها"
            >
              <Gauge className="w-3.5 h-3.5" />
              <span>
                زمان گذر صف: <strong className="font-mono">{toPersianDigits(bottleneckAnalysis.totalThroughputAllHours)}</strong> ساعت
              </span>
            </button>
          }
        />
      }
      kpiStrip={
        <FioriKpiStrip
          columns={6}
          loading={loading && !metrics}
          items={[
            {
              id: 'waiting',
              label: 'صف ورودی ایستگاه',
              value: formatNumber(metrics?.totalWaitingQty || 0),
              unit: 'عدد',
              icon: <Clock className="w-3.5 h-3.5" />,
              tone: (metrics?.totalWaitingQty || 0) > 0 ? 'critical' : 'neutral',
            },
            {
              id: 'in-progress',
              label: 'در حال ساخت پای دستگاه',
              value: formatNumber(metrics?.totalInProgressQty || 0),
              unit: 'عدد',
              icon: <Play className="w-3.5 h-3.5" />,
              tone: 'brand',
            },
            {
              id: 'ready',
              label: 'آماده انتقال به مرحله بعد',
              value: formatNumber(metrics?.totalReadyForTransferQty || 0),
              unit: 'عدد',
              icon: <CheckCircle2 className="w-3.5 h-3.5" />,
              tone: 'positive',
            },
            {
              id: 'in-transit',
              label: 'در حال انتقال (حواله باز)',
              value: formatNumber(metrics?.totalInTransitQty || 0),
              unit: 'عدد',
              icon: <ArrowRightLeft className="w-3.5 h-3.5" />,
              tone: (metrics?.totalInTransitQty || 0) > 0 ? 'critical' : 'neutral',
              onClick: () => handleChangeView('TRANSFERS'),
            },
            {
              id: 'completed',
              label: 'محصول تکمیل‌شده',
              value: formatNumber(metrics?.totalCompletedQty || 0),
              unit: 'عدد',
              icon: <Layers className="w-3.5 h-3.5" />,
              tone: 'neutral',
            },
            {
              id: 'scrap',
              label: 'ضایعات و دوباره‌کاری',
              value: formatNumber(
                (metrics?.totalScrapQty || 0) + (metrics?.totalReworkQty || 0)
              ),
              unit: 'عدد',
              icon: <AlertCircle className="w-3.5 h-3.5" />,
              tone:
                (metrics?.totalScrapQty || 0) + (metrics?.totalReworkQty || 0) > 0
                  ? 'negative'
                  : 'neutral',
            },
          ]}
        />
      }
      filterBar={
        showMoFilterBar ? (
          <FioriFilterBar
            searchValue={searchQuery}
            onSearchChange={setSearchQuery}
            searchPlaceholder="جستجوی شماره دستور کار (MO)، کد قطعه، نام قطعه یا ایستگاه کاری..."
            segments={[
              { id: 'ALL', label: 'همه', count: orders.length },
              {
                id: 'IN_PROGRESS',
                label: 'در جریان ساخت',
                count: orders.filter(o => o.status === 'IN_PROGRESS').length,
              },
              {
                id: 'RELEASED',
                label: 'صادرشده',
                count: orders.filter(o => o.status === 'RELEASED').length,
              },
              {
                id: 'PLANNED',
                label: 'متوقف / منتظر',
                count: orders.filter(o => o.status === 'PLANNED').length,
              },
              {
                id: 'COMPLETED',
                label: 'تکمیل‌شده',
                count: orders.filter(o => o.status === 'COMPLETED').length,
              },
            ]}
            activeSegment={statusFilter}
            onSegmentChange={setStatusFilter}
            hasActiveFilters={activeFiltersCount > 0}
            onReset={resetMoFilters}
            extraControls={
              <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] bg-[var(--fiori-bg-surface)] text-xs text-[var(--fiori-text-primary)] cursor-pointer select-none hover:bg-[var(--fiori-bg-hover)] whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={onlyActiveQueue}
                  onChange={e => setOnlyActiveQueue(e.target.checked)}
                  className="rounded border-[var(--fiori-border-input)] text-[var(--fiori-brand)] focus:ring-0"
                />
                <span>فقط دارای موجودی در صف</span>
              </label>
            }
          />
        ) : undefined
      }
    >
      {/* Persistent Load Error Banner */}
      {loadError && (
        <FioriMessageStrip
          tone="error"
          title="خطا در بارگذاری اطلاعات WIP"
          actions={
            <button
              type="button"
              onClick={loadWipData}
              className="sap-btn-standard px-2.5 py-1 text-[11px]"
            >
              تلاش مجدد
            </button>
          }
        >
          {loadError}
        </FioriMessageStrip>
      )}

      {/* Toast Notification */}
      {notification && (
        <FioriMessageStrip
          tone={notification.type === 'success' ? 'success' : 'error'}
          compact
          onClose={() => setNotification(null)}
        >
          {notification.message}
        </FioriMessageStrip>
      )}

      {/* Visual MO Status Distribution Chart across Production Halls (Top position only on analytical tabs) */}
      {!loading &&
        (activeView === 'DASHBOARD' || activeView === 'BOTTLENECK') && (
          <WipHallMoDistributionChart
            orders={orders}
            machines={machines}
            halls={halls}
            activeStatusFilter={statusFilter}
            onSelectStatusFilter={setStatusFilter}
          />
        )}

      {/* Real-Time Stage Bottleneck Visualizer (Shown in dedicated BOTTLENECK tab and analytical DASHBOARD tab) */}
      {(activeView === 'BOTTLENECK' || activeView === 'DASHBOARD') && (
        <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)] overflow-hidden">
          <FioriToolbar
            variant="table"
            title="پایش لحظه‌ای گلوگاه و زمان گذر ایستگاه‌ها"
            subtitle="محاسبه‌شده از روی موجودی لحظه‌ای ایستگاه‌ها و زمان سیکل/ستاپ مسیر عملیات (Routing) — مبنای هشدار: شیفت ۷٫۵ ساعته"
            startContent={<Gauge className="w-4 h-4 text-[var(--fiori-brand)]" />}
            endContent={
              <div className="flex items-center gap-2.5 text-[11px] flex-wrap font-mono tabular-nums">
                <span className="font-sans text-[var(--fiori-text-secondary)]">
                  جمع WIP ایستگاه‌ها:{' '}
                  <strong className="font-mono text-[var(--fiori-text-primary)]">
                    {formatNumber(bottleneckAnalysis.totalWipQtyAllStages)}
                  </strong>{' '}
                  عدد
                </span>
                <span className="text-[var(--fiori-border-default)]">|</span>
                <span className="font-sans text-[var(--fiori-text-secondary)]">
                  کل زمان گذر صف:{' '}
                  <strong className="font-mono text-[var(--fiori-brand)]">
                    {toPersianDigits(bottleneckAnalysis.totalThroughputAllHours)}
                  </strong>{' '}
                  ساعت
                </span>
                {bottleneckAnalysis.criticalCount > 0 && (
                  <FioriObjectStatus
                    tone="negative"
                    label={`${toPersianDigits(bottleneckAnalysis.criticalCount)} ایستگاه با تراکم بحرانی`}
                  />
                )}
                {activeView !== 'BOTTLENECK' && (
                  <button
                    type="button"
                    onClick={() => setShowBottleneckPanel(p => !p)}
                    className="sap-btn-standard px-2.5 py-1 text-[11px] font-sans inline-flex items-center gap-1 cursor-pointer whitespace-nowrap"
                  >
                    <span>{showBottleneckPanel ? 'بستن جزئیات گلوگاه' : 'باز کردن نمودار گلوگاه'}</span>
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showBottleneckPanel ? 'rotate-180' : ''}`} />
                  </button>
                )}
              </div>
            }
          />

          {/* At-a-Glance Collapsed Bottleneck Strip */}
          {activeView !== 'BOTTLENECK' && !showBottleneckPanel && (
            <div className="px-4 py-2 bg-[var(--fiori-bg-subtle)]/70 flex flex-wrap items-center justify-between gap-2.5 text-[11px]">
              <div className="flex items-center gap-2.5 flex-wrap">
                {bottleneckAnalysis.peakStage && bottleneckAnalysis.peakStage.totalQty > 0 ? (
                  <span className="inline-flex items-center gap-1.5 text-[var(--fiori-text-primary)]">
                    <AlertTriangle
                      className={`w-3.5 h-3.5 shrink-0 ${
                        bottleneckAnalysis.peakStage.severity === 'CRITICAL'
                          ? 'text-[var(--fiori-negative)]'
                          : bottleneckAnalysis.peakStage.severity === 'WARNING'
                          ? 'text-[var(--fiori-critical)]'
                          : 'text-[var(--fiori-positive)]'
                      }`}
                    />
                    <span>گلوگاه اصلی:</span>
                    <strong className="text-[var(--fiori-text-primary)]">{bottleneckAnalysis.peakStage.stageName}</strong>
                    <span className="font-mono tabular-nums text-[var(--fiori-text-secondary)]">
                      ({formatNumber(bottleneckAnalysis.peakStage.totalQty)} عدد ·{' '}
                      <strong className="text-[var(--fiori-brand)]">
                        {toPersianDigits(bottleneckAnalysis.peakStage.throughputHours)}h
                      </strong>{' '}
                      · {toPersianDigits(bottleneckAnalysis.peakStage.shiftLoad)} شیفت)
                    </span>
                  </span>
                ) : (
                  <FioriObjectStatus tone="positive" variant="text" label="صف ایستگاه‌ها متعادل و بدون انباشت بحرانی است" />
                )}
              </div>

              <div className="flex items-center gap-3 flex-wrap font-mono tabular-nums text-[var(--fiori-text-secondary)]">
                {bottleneckAnalysis.stages
                  .filter(s => s.totalQty > 0)
                  .slice(0, 4)
                  .map(s => (
                    <FioriObjectStatus
                      key={s.stageId}
                      variant="dot"
                      tone={
                        s.severity === 'CRITICAL'
                          ? 'negative'
                          : s.severity === 'WARNING'
                          ? 'critical'
                          : 'positive'
                      }
                      label={`${s.stageName}: ${toPersianDigits(s.throughputHours)}h`}
                    />
                  ))}
              </div>
            </div>
          )}

          {(activeView === 'BOTTLENECK' || showBottleneckPanel) && (
            <div className="p-4 space-y-4">
              {/* Peak Bottleneck Alert Banner */}
              {bottleneckAnalysis.peakStage && bottleneckAnalysis.peakStage.totalQty > 0 && (
                <FioriMessageStrip
                  tone={
                    bottleneckAnalysis.peakStage.severity === 'CRITICAL'
                      ? 'error'
                      : bottleneckAnalysis.peakStage.severity === 'WARNING'
                      ? 'warning'
                      : 'success'
                  }
                  compact
                  actions={
                    <button
                      type="button"
                      onClick={() => {
                        const peak = bottleneckAnalysis.peakStage;
                        if (!peak) return;
                        const nextId = selectedBottleneckStageId === peak.stageId ? null : peak.stageId;
                        selectBottleneckStage(nextId, peak.stageName);
                      }}
                      className="sap-btn-standard px-2.5 py-1 text-[11px] font-semibold cursor-pointer whitespace-nowrap"
                    >
                      مشاهده قطعات متوقف در این گلوگاه
                    </button>
                  }
                >
                  <span>
                    <strong>گلوگاه اول خط:</strong> {bottleneckAnalysis.peakStage.stageName} با{' '}
                    <strong className="font-mono tabular-nums">
                      {formatNumber(bottleneckAnalysis.peakStage.totalQty)}
                    </strong>{' '}
                    عدد انباشت WIP و زمان گذر برآوردی{' '}
                    <strong className="font-mono tabular-nums">
                      {toPersianDigits(bottleneckAnalysis.peakStage.throughputHours)} ساعت
                    </strong>{' '}
                    (معادل{' '}
                    <strong className="font-mono tabular-nums">
                      {toPersianDigits(bottleneckAnalysis.peakStage.shiftLoad)}
                    </strong>{' '}
                    شیفت کاری)
                  </span>
                </FioriMessageStrip>
              )}

              {/* Visual Color-Coded Throughput Bars Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                {bottleneckAnalysis.stages.map(st => {
                  const isSelected = selectedBottleneckStageId === st.stageId;
                  const cardSurface =
                    st.severity === 'CRITICAL'
                      ? 'border-[var(--fiori-negative-border)] bg-[var(--fiori-negative-bg)]/35'
                      : st.severity === 'WARNING'
                      ? 'border-[var(--fiori-critical-border)] bg-[var(--fiori-critical-bg)]/45'
                      : st.severity === 'NORMAL'
                      ? 'border-[var(--fiori-border-default)] bg-[var(--fiori-bg-surface)]'
                      : 'border-[var(--fiori-border-subtle)] bg-[var(--fiori-bg-subtle)]';

                  const barColor =
                    st.severity === 'CRITICAL'
                      ? 'bg-[var(--fiori-negative)]'
                      : st.severity === 'WARNING'
                      ? 'bg-[var(--fiori-critical)]'
                      : st.severity === 'NORMAL'
                      ? 'bg-[var(--fiori-positive)]'
                      : 'bg-[var(--fiori-border-input)]';

                  const statusTone =
                    st.severity === 'CRITICAL'
                      ? 'negative'
                      : st.severity === 'WARNING'
                      ? 'critical'
                      : st.severity === 'NORMAL'
                      ? 'positive'
                      : 'neutral';

                  const statusLabel =
                    st.severity === 'CRITICAL'
                      ? 'انباشت بحرانی'
                      : st.severity === 'WARNING'
                      ? 'تراکم بالا'
                      : st.severity === 'NORMAL'
                      ? 'جریان پایدار'
                      : 'صف خالی';

                  return (
                    <button
                      key={st.stageId}
                      type="button"
                      onClick={() =>
                        selectBottleneckStage(isSelected ? null : st.stageId, st.stageName)
                      }
                      className={`p-3 rounded-[var(--fiori-radius-md)] border text-right cursor-pointer transition-all flex flex-col justify-between gap-2 ${cardSurface} ${
                        isSelected ? 'ring-2 ring-[var(--fiori-brand)]' : 'hover:shadow-sm'
                      }`}
                    >
                      <div className="space-y-1 w-full">
                        <div className="flex items-center justify-between gap-1 text-[10px]">
                          <FioriObjectStatus tone={statusTone} variant="text" label={statusLabel} />
                          <span className="font-mono tabular-nums text-[var(--fiori-text-secondary)]">
                            {toPersianDigits(st.wipSharePercent)}٪ کل WIP
                          </span>
                        </div>
                        <div className="text-xs font-bold text-[var(--fiori-text-primary)] leading-snug line-clamp-1">
                          {st.stageName}
                        </div>
                      </div>

                      <div className="space-y-1.5 w-full font-mono tabular-nums">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-sm font-bold text-[var(--fiori-text-primary)]">
                            {toPersianDigits(st.throughputHours)}{' '}
                            <span className="text-[10px] font-sans font-normal text-[var(--fiori-text-secondary)]">ساعت</span>
                          </span>
                          <span className="text-[11px] text-[var(--fiori-text-secondary)]">
                            {formatNumber(st.totalQty)} <span className="font-sans">عدد</span>
                          </span>
                        </div>

                        <div className="h-2 w-full bg-[var(--fiori-bg-hover)] rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-300 ${barColor}`}
                            style={{ width: `${st.barWidthPercent}%` }}
                          />
                        </div>

                        <div className="flex items-center justify-between text-[10px] text-[var(--fiori-text-secondary)]">
                          <span>سیکل میانگین: {toPersianDigits(st.avgCycleTimeSec)}s</span>
                          <span>{toPersianDigits(st.partsCount)} کد قطعه</span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Drill-down table for selected stage OR top accumulating stages in BOTTLENECK mode */}
              {(selectedBottleneckStageId || activeView === 'BOTTLENECK') && (
                (() => {
                  const selectedStageObj = selectedBottleneckStageId
                    ? bottleneckAnalysis.stages.find(s => s.stageId === selectedBottleneckStageId)
                    : null;

                  if (selectedBottleneckStageId) {
                    const partColumns: FioriTableColumn<any>[] = [
                      {
                        key: 'part',
                        header: 'کد و نام قطعه',
                        render: p => (
                          <div>
                            <div className="font-semibold text-[var(--fiori-text-primary)]">{p.partName}</div>
                            <div className="text-[10px] text-[var(--fiori-text-secondary)] font-mono fiori-ltr-code inline-block">
                              {p.partCode}
                              {!p.hasExactRouting ? ' (سیکل استاندارد پیش‌فرض)' : ''}
                            </div>
                          </div>
                        ),
                      },
                      {
                        key: 'qty',
                        header: 'تعداد موجود در ایستگاه',
                        isMono: true,
                        cellClassName: 'font-bold text-[var(--fiori-text-primary)]',
                        render: p => formatNumber(p.qty),
                      },
                      {
                        key: 'usableQty',
                        header: 'قابل استفاده',
                        isMono: true,
                        cellClassName: 'text-[var(--fiori-positive)]',
                        render: p => formatNumber(p.usableQty),
                      },
                      {
                        key: 'inTransitQty',
                        header: 'در حال انتقال',
                        isMono: true,
                        cellClassName: 'text-[var(--fiori-critical)]',
                        render: p => formatNumber(p.inTransitQty),
                      },
                      {
                        key: 'cycleTimeSec',
                        header: 'زمان سیکل مسیر',
                        isMono: true,
                        render: p => `${toPersianDigits(p.cycleTimeSec)} ثانیه`,
                      },
                      {
                        key: 'setupTimeMin',
                        header: 'ستاپ (دقیقه)',
                        isMono: true,
                        render: p => `${toPersianDigits(p.setupTimeMin)} دقیقه`,
                      },
                      {
                        key: 'throughputHours',
                        header: 'زمان گذر (ساعت)',
                        isMono: true,
                        cellClassName: 'font-bold text-[var(--fiori-brand)]',
                        render: p => `${toPersianDigits(p.throughputHours)} ساعت`,
                      },
                      {
                        key: 'trace',
                        header: 'پیگیری',
                        render: p => (
                          <button
                            type="button"
                            onClick={() => router.traceDocument(p.partCode, 'INVENTORY_LEDGER')}
                            className="sap-doc-link inline-flex items-center gap-1 text-[11px] cursor-pointer"
                          >
                            <span>کاردکس</span>
                            <ExternalLink className="w-3 h-3" />
                          </button>
                        ),
                      },
                    ];

                    return (
                      <FioriDataTable
                        columns={partColumns}
                        data={selectedStageObj?.partBreakdown || []}
                        rowKey={p => `${selectedStageObj?.stageId}-${p.partId}`}
                        compact
                        toolbar={
                          <FioriToolbar
                            variant="table"
                            title={`ریز قطعات و زمان گذر در: ${selectedStageObj?.stageName || selectedBottleneckStageId}`}
                            count={selectedStageObj?.partBreakdown?.length || 0}
                            countLabel="قطعه"
                            endContent={
                              <button
                                type="button"
                                onClick={() => setSelectedBottleneckStageId(null)}
                                className="sap-btn-standard px-2.5 py-1 text-[11px] cursor-pointer"
                              >
                                بستن جزئیات ایستگاه
                              </button>
                            }
                          />
                        }
                        emptyState={
                          <EmptyState
                            variant="NO_WIP"
                            compact
                            title="قطعه انباشته‌شده‌ای در این ایستگاه نیست"
                            description="در حال حاضر هیچ قطعه‌ای در صف این ایستگاه انباشته نشده است."
                          />
                        }
                      />
                    );
                  }

                  const stageColumns: FioriTableColumn<any>[] = [
                    {
                      key: 'stageName',
                      header: 'ایستگاه تولید',
                      render: st => (
                        <span className="font-semibold text-[var(--fiori-text-primary)]">{st.stageName}</span>
                      ),
                    },
                    {
                      key: 'totalQty',
                      header: 'موجودی WIP',
                      isMono: true,
                      cellClassName: 'font-bold',
                      render: st => formatNumber(st.totalQty),
                    },
                    {
                      key: 'wipSharePercent',
                      header: 'سهم انباشت',
                      isMono: true,
                      render: st => `${toPersianDigits(st.wipSharePercent)}٪`,
                    },
                    {
                      key: 'avgCycleTimeSec',
                      header: 'سیکل میانگین',
                      isMono: true,
                      render: st => `${toPersianDigits(st.avgCycleTimeSec)} ثانیه`,
                    },
                    {
                      key: 'throughputHours',
                      header: 'زمان گذر کل',
                      isMono: true,
                      cellClassName: 'font-bold text-[var(--fiori-brand)]',
                      render: st => `${toPersianDigits(st.throughputHours)} ساعت`,
                    },
                    {
                      key: 'shiftLoad',
                      header: 'بار شیفت (۷.۵h)',
                      isMono: true,
                      render: st => `${toPersianDigits(st.shiftLoad)} شیفت`,
                    },
                    {
                      key: 'severity',
                      header: 'وضعیت گلوگاه',
                      render: st => (
                        <FioriObjectStatus
                          variant="text"
                          tone={
                            st.severity === 'CRITICAL'
                              ? 'negative'
                              : st.severity === 'WARNING'
                              ? 'critical'
                              : st.severity === 'NORMAL'
                              ? 'positive'
                              : 'neutral'
                          }
                          label={
                            st.severity === 'CRITICAL'
                              ? 'گلوگاه بحرانی'
                              : st.severity === 'WARNING'
                              ? 'هشدار انباشت'
                              : st.severity === 'NORMAL'
                              ? 'عادی'
                              : 'خالی'
                          }
                        />
                      ),
                    },
                  ];

                  return (
                    <FioriDataTable
                      columns={stageColumns}
                      data={bottleneckAnalysis.stages}
                      rowKey={st => st.stageId}
                      onRowClick={st => selectBottleneckStage(st.stageId, st.stageName)}
                      compact
                      toolbar={
                        <FioriToolbar
                          variant="table"
                          title="جدول کامل زمان گذر ایستگاه‌ها و جزئیات صف قطعات (برای مشاهده قطعات روی هر ایستگاه کلیک کنید)"
                          count={bottleneckAnalysis.stages.length}
                          countLabel="ایستگاه"
                        />
                      }
                    />
                  );
                })()
              )}
            </div>
          )}
        </div>
      )}

      {/* Traceability & Part Identification Flow */}
      {activeView === 'TRACEABILITY' && (
        <TraceabilityInquiryView
          parts={parts}
          machines={machines}
          operators={operators}
          initialQuery={initialTraceQuery}
        />
      )}

      {/* UNIFIED SAP FIORI HORIZON WIP WORKSPACE */}
      {activeView === 'UNIFIED_DIRECTORY' && (
        <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] overflow-hidden shadow-[var(--fiori-shadow-card)]">
          <FioriToolbar
            variant="table"
            title="دستورهای کار تولید، زنجیره عملیات و حواله‌های انتقال"
            subtitle="برای مشاهده ایستگاه‌ها، موقعیت فیزیکی و اقدام بعدی هر مرحله روی سطر دستور کار کلیک کنید"
            count={filteredOrders.length}
            countLabel="دستور کار"
            endContent={
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  type="button"
                  onClick={() => {
                    expandAllGroups(['orders_group', 'transfers_group']);
                    expandAllMos(filteredOrders.map(m => m.id));
                  }}
                  className="sap-btn-standard px-2.5 py-1 text-[11px] whitespace-nowrap"
                >
                  باز کردن همه
                </button>
                <button
                  type="button"
                  onClick={() => {
                    collapseAllMos();
                    collapseAllGroups();
                  }}
                  className="sap-btn-standard px-2.5 py-1 text-[11px] whitespace-nowrap"
                >
                  بستن همه
                </button>
              </div>
            }
          />

          <div className="divide-y divide-[var(--fiori-border-default)] text-xs">
            {/* Folder 1: Active Manufacturing Orders (Expandable inline) */}
            <div>
              <button
                type="button"
                onClick={() => toggleGroup('orders_group')}
                className="w-full px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 bg-[var(--fiori-bg-subtle)] hover:bg-[var(--fiori-bg-hover)] transition-colors cursor-pointer text-right"
              >
                <div className="flex items-center gap-2 font-bold text-[var(--fiori-text-primary)]">
                  {expandedGroups.orders_group ? (
                    <ChevronDown className="w-4 h-4 text-[var(--fiori-brand)] shrink-0" />
                  ) : (
                    <ChevronLeft className="w-4 h-4 text-[var(--fiori-text-secondary)] shrink-0" />
                  )}
                  <Folder className="w-4 h-4 text-[var(--fiori-brand)] shrink-0" />
                  <span>دستورهای کار تولید و زنجیره مراحل ساخت (MO)</span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-[var(--fiori-text-secondary)] font-mono tabular-nums flex-wrap">
                  <span className="font-sans whitespace-nowrap">
                    تعداد: <strong className="font-mono text-[var(--fiori-text-primary)]">{toPersianDigits(filteredOrders.length)}</strong>
                  </span>
                  <span className="text-[var(--fiori-border-default)]">·</span>
                  <span className="font-sans text-[var(--fiori-brand)] whitespace-nowrap">
                    در جریان:{' '}
                    <strong className="font-mono">
                      {toPersianDigits(
                        filteredOrders.filter(o => o.status === 'IN_PROGRESS' || o.status === 'RELEASED').length
                      )}
                    </strong>
                  </span>
                  <span className="text-[var(--fiori-border-default)]">·</span>
                  <span className="font-sans text-[var(--fiori-positive)] whitespace-nowrap">
                    تکمیل‌شده:{' '}
                    <strong className="font-mono">
                      {toPersianDigits(filteredOrders.filter(o => o.status === 'COMPLETED').length)}
                    </strong>
                  </span>
                </div>
              </button>

              {expandedGroups.orders_group && (
                <div className="divide-y divide-[var(--fiori-border-subtle)]">
                  {filteredOrders.length === 0 ? (
                    <div className="p-6">
                      <EmptyState
                        variant="NO_WIP"
                        title="دستور کاری با فیلترهای انتخابی یافت نشد"
                        description="فیلترهای وضعیت، صف فعال یا عبارت جستجو را تغییر دهید."
                        actionLabel={activeFiltersCount > 0 ? 'بازنشانی فیلترها' : undefined}
                        onAction={activeFiltersCount > 0 ? resetMoFilters : undefined}
                      />
                    </div>
                  ) : (
                    filteredOrders.map(mo => {
                      const isExpanded = !!expandedMoIds[mo.id];
                      const completedOps = mo.operations.filter(
                        o => o.status === 'COMPLETED'
                      ).length;
                      const activeOp =
                        mo.operations.find(o => o.inProgressQty > 0) ||
                        mo.operations.find(o => o.readyForTransferQty > 0) ||
                        mo.operations.find(o => o.waitingInputQty > 0) ||
                        mo.operations.find(o => o.status !== 'COMPLETED');
                      const shortOpCode = activeOp ? activeOp.stepCode.split('_')[0] : '';
                      const moWaiting = mo.operations.reduce((s, o) => s + (o.waitingInputQty || 0), 0);
                      const moInProg = mo.operations.reduce((s, o) => s + (o.inProgressQty || 0), 0);
                      const moReady = mo.operations.reduce((s, o) => s + (o.readyForTransferQty || 0), 0);
                      const moProgressPct =
                        mo.targetQuantity > 0
                          ? Math.min(100, Math.round((mo.completedQuantity / mo.targetQuantity) * 100))
                          : 0;

                      // Determine the single clearest immediate next action for operators
                      const quickNextAction =
                        mo.status !== 'COMPLETED' && activeOp ? (
                          activeOp.inProgressQty > 0 ? (
                            <button
                              type="button"
                              onClick={() => setProdModalOp(activeOp)}
                              className="fiori-btn-positive inline-flex items-center gap-1 px-2.5 py-1 text-[11px] whitespace-nowrap"
                              title={`ثبت تولید و ضایعات در ایستگاه ${activeOp.stepCode} (${activeOp.stepName})`}
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>ثبت تولید ({shortOpCode})</span>
                            </button>
                          ) : activeOp.readyForTransferQty > 0 ? (
                            <button
                              type="button"
                              onClick={() => {
                                setTransferModalContext({ mo, op: activeOp });
                                setIsTransferModalOpen(true);
                              }}
                              className="sap-btn-emphasized inline-flex items-center gap-1 px-2.5 py-1 text-[11px] whitespace-nowrap"
                              title={`صدور حواله انتقال از ${activeOp.stepCode} (${activeOp.stepName})`}
                            >
                              <ArrowRightLeft className="w-3.5 h-3.5" />
                              <span>انتقال ({shortOpCode})</span>
                            </button>
                          ) : activeOp.waitingInputQty > 0 ? (
                            <button
                              type="button"
                              onClick={() => setInputModalOp(activeOp)}
                              className="sap-btn-emphasized inline-flex items-center gap-1 px-2.5 py-1 text-[11px] whitespace-nowrap"
                              title={`شروع کار در ایستگاه ${activeOp.stepCode} (${activeOp.stepName})`}
                            >
                              <Play className="w-3.5 h-3.5" />
                              <span>شروع کار ({shortOpCode})</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setLoadMatModalMo(mo);
                                setLoadMatQty(
                                  Math.max(1, mo.targetQuantity - mo.initialInputQuantity) ||
                                    mo.targetQuantity
                                );
                                setLoadMatNotes('');
                              }}
                              className="sap-btn-emphasized inline-flex items-center gap-1 px-2.5 py-1 text-[11px] whitespace-nowrap"
                              title="بارگذاری ورق یا بلنک اولیه در مرحله نخست دستور کار"
                            >
                              <PackagePlus className="w-3.5 h-3.5" />
                              <span>بارگذاری مواد</span>
                            </button>
                          )
                        ) : null;

                      return (
                        <div key={mo.id} className="bg-[var(--fiori-bg-surface)]">
                          {/* MO Row */}
                          <div
                            className={`px-3 py-2.5 sm:pr-5 sm:pl-3.5 flex flex-col lg:flex-row lg:items-center justify-between gap-2.5 transition-colors ${
                              isExpanded
                                ? 'bg-[var(--fiori-bg-selected)]/60'
                                : 'hover:bg-[var(--fiori-bg-hover)]'
                            }`}
                          >
                            <div
                              onClick={() => toggleMoRow(mo.id, mo.moNumber)}
                              className="flex items-start gap-2 cursor-pointer flex-1 min-w-0"
                            >
                              <span className="mt-0.5 shrink-0">
                                {isExpanded ? (
                                  <ChevronDown className="w-4 h-4 text-[var(--fiori-brand)]" />
                                ) : (
                                  <ChevronLeft className="w-4 h-4 text-[var(--fiori-text-secondary)]" />
                                )}
                              </span>
                              <div className="min-w-0 flex-1 space-y-1.5">
                                {/* Line 1: Identity + Status + Current Station & Location */}
                                <div className="flex items-center gap-2 flex-wrap">
                                  <button
                                    type="button"
                                    onClick={e => {
                                      e.stopPropagation();
                                      router.traceDocument(mo.moNumber, 'WIP_TRACEABILITY');
                                    }}
                                    className="sap-doc-link fiori-ltr-code font-mono font-bold text-xs cursor-pointer"
                                    title="استعلام شجره‌نامه و شماره رهگیری این دستور کار"
                                  >
                                    {mo.moNumber}
                                  </button>
                                  <span className="font-bold text-[var(--fiori-text-primary)]">
                                    {mo.partName}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={e => {
                                      e.stopPropagation();
                                      router.traceDocument(mo.partCode, 'INVENTORY_LEDGER');
                                    }}
                                    className="sap-doc-link fiori-ltr-code font-mono text-[11px] cursor-pointer"
                                    title="مشاهده کاردکس انبار این قطعه"
                                  >
                                    ({mo.partCode})
                                  </button>
                                  <FioriObjectStatus
                                    size="sm"
                                    tone={
                                      mo.status === 'COMPLETED'
                                        ? 'positive'
                                        : mo.status === 'IN_PROGRESS'
                                        ? 'brand'
                                        : mo.status === 'PLANNED'
                                        ? 'neutral'
                                        : 'info'
                                    }
                                    label={
                                      mo.status === 'IN_PROGRESS'
                                        ? 'در جریان ساخت'
                                        : mo.status === 'COMPLETED'
                                        ? 'تکمیل‌شده'
                                        : mo.status === 'PLANNED'
                                        ? 'برنامه‌ریزی‌شده'
                                        : 'صادرشده'
                                    }
                                  />
                                  {activeOp && (
                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] text-[11px] text-[var(--fiori-text-primary)] flex-wrap">
                                      <MapPin className="w-3 h-3 text-[var(--fiori-brand)] shrink-0" />
                                      <span className="text-[var(--fiori-text-secondary)]">ایستگاه فعلی:</span>
                                      <strong className="fiori-ltr-code font-mono text-[var(--fiori-brand)]">
                                        {activeOp.stepCode}
                                      </strong>
                                      <span>{activeOp.stepName}</span>
                                      {activeOp.warehouseLocation && (
                                        <span className="fiori-ltr-code font-mono text-[10px] text-[var(--fiori-text-secondary)]">
                                          [{activeOp.warehouseLocation}]
                                        </span>
                                      )}
                                    </span>
                                  )}
                                </div>

                                {/* Line 2: Compact Visual Operation Sequence Flow */}
                                {mo.operations.length > 0 && (
                                  <div className="flex items-center gap-1 flex-wrap text-[10px]">
                                    {mo.operations.map((op, opIdx) => {
                                      const isCurrent = activeOp?.id === op.id;
                                      const isDone = op.status === 'COMPLETED';
                                      const hasStock =
                                        op.waitingInputQty > 0 ||
                                        op.inProgressQty > 0 ||
                                        op.readyForTransferQty > 0;
                                      const chipCls = isDone
                                        ? 'bg-[var(--fiori-positive-bg)] text-[var(--fiori-positive)] border-[var(--fiori-positive-border)]'
                                        : isCurrent
                                        ? 'bg-[var(--fiori-info-bg)] text-[var(--fiori-brand)] border-[var(--fiori-brand)] font-bold'
                                        : hasStock
                                        ? 'bg-[var(--fiori-critical-bg)] text-[var(--fiori-critical)] border-[var(--fiori-critical-border)]'
                                        : 'bg-[var(--fiori-bg-subtle)] text-[var(--fiori-text-secondary)] border-[var(--fiori-border-default)]';

                                      const totalHere =
                                        op.waitingInputQty + op.inProgressQty + op.readyForTransferQty;

                                      return (
                                        <React.Fragment key={op.id}>
                                          <span
                                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[var(--fiori-radius-sm)] border ${chipCls}`}
                                            title={`${op.stepCode} — ${op.stepName} (${op.warehouseLocation})`}
                                          >
                                            <span className="fiori-ltr-code font-mono">{op.stepCode}</span>
                                            {totalHere > 0 && (
                                              <span className="font-mono tabular-nums">
                                                ({formatNumber(totalHere)})
                                              </span>
                                            )}
                                          </span>
                                          {opIdx < mo.operations.length - 1 && (
                                            <ChevronLeft className="w-3 h-3 text-[var(--fiori-text-muted)] shrink-0" />
                                          )}
                                        </React.Fragment>
                                      );
                                    })}
                                  </div>
                                )}

                                {/* Line 3: Quantitative Breakdown (Atomic non-breaking metric pills for mobile & desktop readability) */}
                                <div className="text-[11px] text-[var(--fiori-text-secondary)] flex items-center gap-x-2.5 gap-y-1 flex-wrap tabular-nums">
                                  <span className="whitespace-nowrap">
                                    هدف:{' '}
                                    <strong className="font-mono text-[var(--fiori-text-primary)]">
                                      {formatNumber(mo.targetQuantity)}
                                    </strong>
                                  </span>
                                  <span className="text-[var(--fiori-border-default)]">·</span>
                                  <span className="whitespace-nowrap">
                                    صف:{' '}
                                    <strong className="font-mono text-[var(--fiori-critical)]">
                                      {formatNumber(moWaiting)}
                                    </strong>
                                  </span>
                                  <span className="text-[var(--fiori-border-default)]">·</span>
                                  <span className="whitespace-nowrap">
                                    پای دستگاه:{' '}
                                    <strong className="font-mono text-[var(--fiori-brand)]">
                                      {formatNumber(moInProg)}
                                    </strong>
                                  </span>
                                  <span className="text-[var(--fiori-border-default)]">·</span>
                                  <span className="whitespace-nowrap">
                                    آماده انتقال:{' '}
                                    <strong className="font-mono text-[var(--fiori-positive)]">
                                      {formatNumber(moReady)}
                                    </strong>
                                  </span>
                                  <span className="text-[var(--fiori-border-default)]">·</span>
                                  <span className="whitespace-nowrap">
                                    تکمیل:{' '}
                                    <strong className="font-mono text-[var(--fiori-positive)]">
                                      {formatNumber(mo.completedQuantity)} ({toPersianDigits(moProgressPct)}٪)
                                    </strong>
                                  </span>
                                  <span className="text-[var(--fiori-border-default)]">·</span>
                                  <span className="whitespace-nowrap">
                                    ضایعات:{' '}
                                    <strong
                                      className={`font-mono ${
                                        mo.totalScrapQuantity > 0
                                          ? 'text-[var(--fiori-negative)]'
                                          : 'text-[var(--fiori-text-muted)]'
                                      }`}
                                    >
                                      {formatNumber(mo.totalScrapQuantity)}
                                    </strong>
                                  </span>
                                  <span className="text-[var(--fiori-border-default)]">·</span>
                                  <span className="whitespace-nowrap">
                                    مراحل:{' '}
                                    <strong className="font-mono text-[var(--fiori-text-primary)]">
                                      {toPersianDigits(completedOps)}/{toPersianDigits(mo.operations.length)}
                                    </strong>
                                  </span>
                                </div>
                              </div>
                            </div>

                            {/* Right-hand Actions: Primary Next Step + Compact Secondary Utilities */}
                            <div className="flex items-center gap-1.5 self-stretch sm:self-end lg:self-center flex-wrap shrink-0 pt-1 lg:pt-0 border-t lg:border-t-0 border-[var(--fiori-border-subtle)]">
                              {quickNextAction}

                              {mo.status !== 'COMPLETED' &&
                                activeOp &&
                                (activeOp.inProgressQty > 0 ||
                                  activeOp.readyForTransferQty > 0 ||
                                  activeOp.waitingInputQty > 0) && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setLoadMatModalMo(mo);
                                      setLoadMatQty(
                                        Math.max(1, mo.targetQuantity - mo.initialInputQuantity) ||
                                          mo.targetQuantity
                                      );
                                      setLoadMatNotes('');
                                    }}
                                    className="sap-btn-standard inline-flex items-center gap-1 text-[11px] py-1 px-2 whitespace-nowrap"
                                    title="بارگذاری ورق یا بلنک اولیه در مرحله نخست دستور کار"
                                  >
                                    <PackagePlus className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
                                    <span>بارگذاری مواد</span>
                                  </button>
                                )}

                              <button
                                type="button"
                                onClick={() => router.traceDocument(mo.moNumber, 'INVENTORY_LEDGER')}
                                className="sap-btn-standard inline-flex items-center gap-1 text-[11px] py-1 px-2 whitespace-nowrap"
                                title="مشاهده اسناد کاردکس این دستور کار"
                              >
                                <FileText className="w-3.5 h-3.5 text-[var(--fiori-text-secondary)]" />
                                <span>کاردکس</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => setReconciliationMoId(mo.id)}
                                className="sap-btn-standard inline-flex items-center gap-1 text-[11px] py-1 px-2 whitespace-nowrap shrink-0"
                                title="بررسی گواهی موازنه پایستگی قطعات"
                              >
                                <Scale className="w-3.5 h-3.5 text-[var(--fiori-positive)]" />
                                <span>تراز</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => openMoRollbackModal(mo)}
                                className="fiori-btn-danger-outline inline-flex items-center justify-center p-1.5"
                                title="حذف دستور تولید + زیرمجموعه‌ها و بازگشت کامل موجودی مصرفی به انبار"
                                aria-label={`حذف کامل دستور ${mo.moNumber}`}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>

                          {/* Expanded Operations Table (SAP Fiori Horizon) */}
                          {isExpanded && (
                            <div className="bg-[var(--fiori-bg-subtle)] border-t border-[var(--fiori-border-default)] px-3 sm:px-4 py-3">
                              <div className="overflow-x-auto bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)]">
                                <table className="sap-table-compact w-full text-right text-xs">
                                  <thead>
                                    <tr>
                                      <th>کد / مرحله عملیات</th>
                                      <th>محل استقرار و دستگاه</th>
                                      <th>وضعیت</th>
                                      <th className="text-left">صف ورودی</th>
                                      <th className="text-left">پای دستگاه</th>
                                      <th className="text-left">آماده انتقال</th>
                                      <th className="text-left">ضایعات</th>
                                      <th className="text-center">اقدامات عملیاتی ایستگاه</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-[var(--fiori-border-subtle)] tabular-nums">
                                    {mo.operations.map(op => {
                                      const hasWaiting = op.waitingInputQty > 0;
                                      const hasInProg = op.inProgressQty > 0;
                                      const hasReady = op.readyForTransferQty > 0;
                                      const opTone =
                                        op.status === 'COMPLETED'
                                          ? 'positive'
                                          : hasInProg
                                          ? 'brand'
                                          : hasReady
                                          ? 'positive'
                                          : hasWaiting
                                          ? 'critical'
                                          : 'neutral';
                                      const opStatusLabel =
                                        op.status === 'COMPLETED'
                                          ? 'تکمیل‌شده'
                                          : hasInProg
                                          ? 'در حال تولید'
                                          : hasReady
                                          ? 'آماده انتقال'
                                          : hasWaiting
                                          ? 'در صف انتظار'
                                          : 'منتظر ورود';

                                      return (
                                        <tr key={op.id} className="hover:bg-[var(--fiori-bg-hover)]">
                                          <td>
                                            <div className="flex items-center gap-2">
                                              <span className="fiori-ltr-code px-1.5 py-0.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-info-bg)] border border-[var(--fiori-info-border)] font-mono text-[10px] font-bold text-[var(--fiori-brand)]">
                                                {op.stepCode}
                                              </span>
                                              <span className="font-semibold text-[var(--fiori-text-primary)]">
                                                {op.stepName}
                                              </span>
                                            </div>
                                          </td>
                                          <td>
                                            <div className="flex flex-col gap-0.5 text-[11px]">
                                              <span className="inline-flex items-center gap-1 fiori-ltr-code font-mono text-[var(--fiori-brand)]">
                                                <MapPin className="w-3 h-3 shrink-0" />
                                                {op.warehouseLocation || '-'}
                                              </span>
                                              {op.machineName && (
                                                <span className="inline-flex items-center gap-1 text-[var(--fiori-text-secondary)]">
                                                  <Cpu className="w-3 h-3 shrink-0" />
                                                  {op.machineName}
                                                </span>
                                              )}
                                            </div>
                                          </td>
                                          <td>
                                            <FioriObjectStatus tone={opTone} label={opStatusLabel} size="sm" />
                                          </td>
                                          <td className="text-left font-mono font-bold">
                                            <span className={hasWaiting ? 'text-[var(--fiori-critical)]' : 'text-[var(--fiori-text-muted)]'}>
                                              {formatNumber(op.waitingInputQty)}
                                            </span>
                                          </td>
                                          <td className="text-left font-mono font-bold">
                                            <span className={hasInProg ? 'text-[var(--fiori-brand)]' : 'text-[var(--fiori-text-muted)]'}>
                                              {formatNumber(op.inProgressQty)}
                                            </span>
                                          </td>
                                          <td className="text-left font-mono font-bold">
                                            <span className={hasReady ? 'text-[var(--fiori-positive)]' : 'text-[var(--fiori-text-muted)]'}>
                                              {formatNumber(op.readyForTransferQty)}
                                            </span>
                                          </td>
                                          <td className="text-left font-mono">
                                            <span className={op.scrapQty > 0 ? 'text-[var(--fiori-negative)] font-bold' : 'text-[var(--fiori-text-muted)]'}>
                                              {formatNumber(op.scrapQty)}
                                            </span>
                                          </td>
                                          <td>
                                            <div className="flex items-center justify-center gap-1.5 flex-wrap">
                                              <button
                                                type="button"
                                                onClick={() => setInputModalOp(op)}
                                                className={`${
                                                  hasWaiting && !hasInProg ? 'sap-btn-emphasized' : 'sap-btn-standard'
                                                } text-[11px] py-0.5 px-2 whitespace-nowrap`}
                                              >
                                                شروع کار / ورودی
                                              </button>
                                              <button
                                                type="button"
                                                onClick={() => setProdModalOp(op)}
                                                className={`${
                                                  hasInProg ? 'fiori-btn-positive' : 'sap-btn-standard'
                                                } text-[11px] py-0.5 px-2 whitespace-nowrap`}
                                              >
                                                ثبت تولید / ضایعات
                                              </button>
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  setTransferModalContext({ mo, op });
                                                  setIsTransferModalOpen(true);
                                                }}
                                                className={`${
                                                  hasReady ? 'sap-btn-emphasized' : 'sap-btn-standard'
                                                } text-[11px] py-0.5 px-2 whitespace-nowrap`}
                                              >
                                                انتقال به بعد
                                              </button>
                                            </div>
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>

            {/* Folder 2: Pending & Recent Transfers */}
            <div>
              <button
                type="button"
                onClick={() => toggleGroup('transfers_group')}
                className="w-full px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 bg-[var(--fiori-bg-subtle)] hover:bg-[var(--fiori-bg-hover)] transition-colors cursor-pointer text-right"
              >
                <div className="flex items-center gap-2 font-bold text-[var(--fiori-text-primary)]">
                  {expandedGroups.transfers_group ? (
                    <ChevronDown className="w-4 h-4 text-[var(--fiori-brand)] shrink-0" />
                  ) : (
                    <ChevronLeft className="w-4 h-4 text-[var(--fiori-text-secondary)] shrink-0" />
                  )}
                  <Folder className="w-4 h-4 text-[var(--fiori-brand)] shrink-0" />
                  <span>حواله‌های انتقال بین مراحل (WIP)</span>
                </div>
                <div className="flex items-center gap-2.5 text-[11px] text-[var(--fiori-text-secondary)] font-mono tabular-nums">
                  <span className="font-sans">
                    کل: <strong className="font-mono text-[var(--fiori-text-primary)]">{toPersianDigits(transfers.length)}</strong> حواله
                  </span>
                  <span className="text-[var(--fiori-border-default)]">·</span>
                  <span className="font-sans text-[var(--fiori-critical)]">
                    در انتظار تایید:{' '}
                    <strong className="font-mono">{toPersianDigits(pendingTransfersCount)}</strong>
                  </span>
                </div>
              </button>

              {expandedGroups.transfers_group && (
                <div className="divide-y divide-[var(--fiori-border-subtle)]">
                  {transfers.length === 0 ? (
                    <div className="p-5">
                      <EmptyState
                        compact
                        title="حواله انتقالی ثبت نشده است"
                        description="پس از ثبت تولید سالم در هر ایستگاه، می‌توانید از دکمه «انتقال به بعد» حواله صادر کنید."
                      />
                    </div>
                  ) : (
                    <>
                      {transfers.slice(0, 6).map(tr => (
                        <div
                          key={tr.id}
                          className="pr-8 pl-3.5 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 hover:bg-[var(--fiori-bg-hover)] transition-colors"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <ArrowRightLeft className="w-4 h-4 text-[var(--fiori-brand)] shrink-0" />
                            <div className="min-w-0">
                              <div className="font-semibold text-[var(--fiori-text-primary)] flex items-center gap-1.5 flex-wrap">
                                <button
                                  type="button"
                                  onClick={() => router.traceDocument(tr.transferNumber, 'WIP_TRACEABILITY')}
                                  className="sap-doc-link fiori-ltr-code font-mono font-bold cursor-pointer"
                                >
                                  {tr.transferNumber}
                                </button>
                                <span>— {tr.partName}</span>
                                <button
                                  type="button"
                                  onClick={() => router.traceDocument(tr.moNumber, 'WIP_TRACEABILITY')}
                                  className="sap-doc-link fiori-ltr-code font-mono text-[11px] cursor-pointer"
                                >
                                  ({tr.moNumber})
                                </button>
                              </div>
                              <div className="text-[11px] text-[var(--fiori-text-secondary)] mt-0.5 flex items-center gap-1.5 flex-wrap">
                                <span>از {tr.fromStepName}</span>
                                <ChevronLeft className="w-3 h-3 text-[var(--fiori-text-muted)]" />
                                <span>به {tr.toStepName}</span>
                                <span>• تعداد:</span>
                                <strong className="font-mono text-[var(--fiori-text-primary)] tabular-nums">
                                  {formatNumber(tr.quantity)} عدد
                                </strong>
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                            <FioriObjectStatus
                              size="sm"
                              tone={
                                tr.status === 'APPROVED'
                                  ? 'positive'
                                  : tr.status === 'REJECTED'
                                  ? 'negative'
                                  : 'critical'
                              }
                              label={
                                tr.status === 'APPROVED'
                                  ? 'تحویل‌گرفته در ایستگاه مقصد'
                                  : tr.status === 'REJECTED'
                                  ? 'رد شده'
                                  : 'در انتظار تایید دریافت'
                              }
                            />
                            {tr.status === 'PENDING_APPROVAL' && (
                              <button
                                type="button"
                                onClick={() => {
                                  requestConfirm({
                                    title: `تأیید دریافت حواله انتقال ${tr.transferNumber}`,
                                    message: `آیا دریافت ${formatNumber(tr.quantity)} عدد «${tr.partName}» از «${tr.fromStepName}» به «${tr.toStepName}» را تأیید می‌کنید؟`,
                                    confirmLabel: 'تأیید دریافت',
                                    variant: 'emerald',
                                    onConfirm: async () => {
                                      await handleApproveTransfer(tr.id);
                                    },
                                  });
                                }}
                                className="fiori-btn-positive px-2.5 py-1 text-[11px]"
                              >
                                تایید دریافت
                              </button>
                            )}
                          </div>
                        </div>
                      ))}

                      {transfers.length > 6 && (
                        <div className="px-4 py-2 bg-[var(--fiori-bg-subtle)] flex items-center justify-between text-[11px] text-[var(--fiori-text-secondary)]">
                          <span>
                            نمایش ۶ حواله اخیر از مجموع {toPersianDigits(transfers.length)} حواله انتقال
                          </span>
                          <button
                            type="button"
                            onClick={() => handleChangeView('TRANSFERS')}
                            className="sap-doc-link font-semibold cursor-pointer"
                          >
                            مشاهده همه حواله‌ها
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Secondary Hall Distribution Chart placed below primary operational directory on UNIFIED_DIRECTORY */}
      {!loading && activeView === 'UNIFIED_DIRECTORY' && (
        <WipHallMoDistributionChart
          orders={orders}
          machines={machines}
          halls={halls}
          activeStatusFilter={statusFilter}
          onSelectStatusFilter={setStatusFilter}
        />
      )}

      {/* Specific Filtered Views when chosen from IconTabBar */}
      {activeView === 'DASHBOARD' && (
        <WipDashboardView
          metrics={metrics}
          orders={orders}
          loading={loading}
          onRefresh={loadWipData}
          onOpenCreateMo={() => setIsCreateMoOpen(true)}
          onOpenTransfer={() => {
            if (orders.length > 0 && orders[0].operations.length > 0) {
              setTransferModalContext({ mo: orders[0], op: orders[0].operations[0] });
              setIsTransferModalOpen(true);
            }
          }}
          onSelectMo={() => handleChangeView('ORDERS')}
          onNavigateToOrders={() => handleChangeView('ORDERS')}
          onNavigateToTransfers={() => handleChangeView('TRANSFERS')}
        />
      )}

      {activeView === 'ORDERS' && (
        <ManufacturingOrdersView
          orders={filteredOrders}
          loading={loading}
          embeddedInParent
          onRefresh={loadWipData}
          onOpenCreateMo={() => setIsCreateMoOpen(true)}
          onOpenInput={op => setInputModalOp(op)}
          onOpenProduction={op => setProdModalOp(op)}
          onOpenTransfer={(mo, op) => {
            setTransferModalContext({ mo, op });
            setIsTransferModalOpen(true);
          }}
          onOpenReconciliation={moId => setReconciliationMoId(moId)}
          onRequestDeleteRollback={openMoRollbackModal}
        />
      )}

      {activeView === 'TRANSFERS' && (
        <InterOperationTransfersView
          transfers={transfers}
          loading={loading}
          embeddedInParent
          onRefresh={loadWipData}
          onApproveTransfer={handleApproveTransfer}
          onRejectTransfer={handleRejectTransfer}
        />
      )}

      {activeView === 'STAGES' && (
        <InventoryReportView
          balances={stageBalances}
          onRefresh={onGlobalRefresh || loadWipData}
          loading={loading}
        />
      )}

      {/* Action Modals */}
      <CreateMoModal
        isOpen={isCreateMoOpen}
        onClose={() => setIsCreateMoOpen(false)}
        parts={parts}
        routings={routings}
        onSubmit={handleCreateMo}
      />

      <OperationInputModal
        isOpen={!!inputModalOp}
        onClose={() => setInputModalOp(null)}
        operation={inputModalOp}
        machines={machines}
        operators={operators}
        onSubmit={handleRecordInput}
      />

      <OperationProductionModal
        isOpen={!!prodModalOp}
        onClose={() => setProdModalOp(null)}
        operation={prodModalOp}
        onSubmit={handleRecordProduction}
      />

      <OperationTransferModal
        isOpen={isTransferModalOpen}
        onClose={() => setIsTransferModalOpen(false)}
        mo={transferModalContext.mo}
        fromOperation={transferModalContext.op}
        onSubmit={handleCreateTransfer}
      />

      <WipReconciliationModal
        isOpen={!!reconciliationMoId}
        onClose={() => setReconciliationMoId(null)}
        moId={reconciliationMoId}
      />

      <MoRelationalGuideModal
        isOpen={isMoGuideOpen}
        onClose={() => setIsMoGuideOpen(false)}
        onOpenCreateMo={() => setIsCreateMoOpen(true)}
      />

      <FioriDialog
        isOpen={Boolean(loadMatModalMo)}
        onClose={() => setLoadMatModalMo(null)}
        title={
          loadMatModalMo
            ? `بارگذاری مواد اولیه / بلنک به دستور کار ${loadMatModalMo.moNumber}`
            : 'بارگذاری مواد اولیه'
        }
        tone="brand"
        size="sm"
        footer={
          <>
            <button
              type="button"
              onClick={() => setLoadMatModalMo(null)}
              className="sap-btn-standard text-xs px-3 py-1.5 cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="wip-load-material-form"
              disabled={loadMatSubmitting || loadMatQty <= 0 || !loadMatSourceBalanceId}
              className="sap-btn-emphasized text-xs px-3.5 py-1.5 cursor-pointer disabled:opacity-50"
            >
              {loadMatSubmitting ? 'در حال ثبت...' : 'تایید بارگذاری در صف خط'}
            </button>
          </>
        }
      >
        {loadMatModalMo && (
          <form id="wip-load-material-form" onSubmit={handleLoadMaterial} className="space-y-3 text-xs">
            <div className="bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] p-2.5 text-[var(--fiori-text-primary)]">
              <div className="font-semibold">{loadMatModalMo.partName}</div>
              <div className="text-[11px] text-[var(--fiori-text-secondary)] mt-0.5 font-mono tabular-nums">
                هدف: {formatNumber(loadMatModalMo.targetQuantity)} • بارگذاری فعلی: {formatNumber(loadMatModalMo.initialInputQuantity)}
              </div>
            </div>

            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">
                منبع موجودی انبار / کلاف <span className="text-[var(--fiori-negative)]">*</span>
              </label>
                <select
                required
                value={loadMatSourceBalanceId}
                onChange={e => setLoadMatSourceBalanceId(e.target.value)}
                disabled={materialSourcesLoading}
                className="fiori-input"
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

            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">
                تعداد ورق / بلنک ورودی به مرحله نخست (عدد):
              </label>
              <input
                type="number"
                min={1}
                required
                value={loadMatQty || ''}
                onChange={e => setLoadMatQty(Math.max(0, Number(e.target.value)))}
                className="fiori-input font-mono tabular-nums"
                dir="ltr"
              />
            </div>

            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">
                توضیحات / شماره کویل مرجع (اختیاری):
              </label>
              <input
                type="text"
                value={loadMatNotes}
                onChange={e => setLoadMatNotes(e.target.value)}
                placeholder="مثال: بارگذاری بلنک برش‌خورده از کلاف COIL-ECU-001"
                className="fiori-input"
              />
            </div>
          </form>
        )}
      </FioriDialog>

      {/* Cascading MO Delete & Inventory Rollback Preview Modal */}
      <FioriDialog
        isOpen={Boolean(rollbackModalTarget)}
        onClose={() => !rollbackSubmitting && setRollbackModalTarget(null)}
        disableClose={rollbackSubmitting}
        title={
          rollbackModalTarget
            ? `تأیید حذف کامل دستور تولید (${rollbackModalTarget.moNumber}) و بازگشت موجودی انبار`
            : 'تأیید حذف دستور تولید'
        }
        subtitle="کلیه دستورات فرعی وابسته، حواله‌ها، گزارش‌های تولید و اسناد انبار مرتبط بررسی و به وضعیت قبل بازمی‌گردند"
        tone="danger"
        icon={<ShieldAlert className="w-5 h-5" />}
        size="lg"
        footer={
          <>
            <button
              type="button"
              disabled={rollbackSubmitting}
              onClick={() => setRollbackModalTarget(null)}
              className="sap-btn-standard text-xs px-3.5 py-1.5"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="mo-rollback-delete-form"
              disabled={
                rollbackLoading ||
                rollbackSubmitting ||
                !rollbackPreview?.canRollback ||
                rollbackReason.trim().length < 3
              }
              className="fiori-btn-danger inline-flex items-center gap-1.5 px-4 py-1.5 text-xs"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>
                {rollbackSubmitting
                  ? 'در حال حذف و بازگشت موجودی...'
                  : 'تأیید نهایی حذف و بازگشت کامل موجودی به قبل'}
              </span>
            </button>
          </>
        }
      >
        <div className="space-y-3.5 text-xs">
          {rollbackLoading ? (
            <div className="py-10 text-center text-[var(--fiori-text-secondary)]">
              در حال شبیه‌سازی تأثیر حذف و محاسبه تراز موجودی انبارها...
            </div>
          ) : rollbackPreview ? (
            <>
              {rollbackPreview.blockingErrors.length > 0 && (
                <FioriMessageStrip tone="error" title="موانع مسدودکننده بازگشت خودکار موجودی:">
                  <ul className="list-disc pr-5 space-y-1 text-[11px]">
                    {rollbackPreview.blockingErrors.map((errMsg, idx) => (
                      <li key={idx}>{errMsg}</li>
                    ))}
                  </ul>
                </FioriMessageStrip>
              )}

              {/* Summary metrics grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center font-mono tabular-nums">
                <div className="p-2.5 bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)]">
                  <div className="text-[10px] font-sans text-[var(--fiori-text-secondary)]">دستورات تولید (اصلی+فرعی)</div>
                  <div className="text-sm font-bold text-[var(--fiori-negative)] mt-0.5">
                    {toPersianDigits(rollbackPreview.mosToDelete.length)}
                  </div>
                </div>
                <div className="p-2.5 bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)]">
                  <div className="text-[10px] font-sans text-[var(--fiori-text-secondary)]">اسناد مواد برگشتی به انبار</div>
                  <div className="text-sm font-bold text-[var(--fiori-positive)] mt-0.5">
                    {toPersianDigits(rollbackPreview.materialsToReturn.length)}
                  </div>
                </div>
                <div className="p-2.5 bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)]">
                  <div className="text-[10px] font-sans text-[var(--fiori-text-secondary)]">رسیدهای محصول کسری</div>
                  <div className="text-sm font-bold text-[var(--fiori-critical)] mt-0.5">
                    {toPersianDigits(rollbackPreview.outputsToDeduct.length)}
                  </div>
                </div>
                <div className="p-2.5 bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)]">
                  <div className="text-[10px] font-sans text-[var(--fiori-text-secondary)]">حواله‌ها / رزرو / کاردکس</div>
                  <div className="text-sm font-bold text-[var(--fiori-text-primary)] mt-0.5">
                    {toPersianDigits(
                      rollbackPreview.wipTransfersCount +
                        rollbackPreview.productionLogsCount +
                        rollbackPreview.reservationsCount +
                        rollbackPreview.kardexTransactionsCount,
                    )}
                  </div>
                </div>
              </div>

              {/* MOs to Delete */}
              <div className="border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] overflow-hidden">
                <div className="px-3 py-1.5 bg-[var(--fiori-bg-subtle)] border-b border-[var(--fiori-border-default)] font-bold text-[var(--fiori-text-primary)]">
                  ۱. دستورات تولید قابل حذف (اصلی و زیرمجموعه‌های فرعی):
                </div>
                <div className="divide-y divide-[var(--fiori-border-subtle)] max-h-40 overflow-y-auto">
                  {rollbackPreview.mosToDelete.map(m => (
                    <div key={m.id} className="px-3 py-1.5 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono fiori-ltr-code font-bold text-[var(--fiori-brand)]">{m.moNumber}</span>
                        {m.isSubMo && (
                          <FioriObjectStatus tone="critical" label="زیرمجموعه فرعی" />
                        )}
                        <span className="truncate text-[var(--fiori-text-primary)]">
                          {m.partName} ({m.partCode})
                        </span>
                      </div>
                      <span className="font-mono tabular-nums text-[11px] text-[var(--fiori-text-secondary)] whitespace-nowrap">
                        تیراژ: {formatNumber(m.targetQuantity)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Materials returning to warehouse */}
              {rollbackPreview.materialsToReturn.length > 0 && (
                <div className="border border-[var(--fiori-positive-border)] rounded-[var(--fiori-radius-sm)] overflow-hidden">
                  <div className="px-3 py-1.5 bg-[var(--fiori-positive-bg)] border-b border-[var(--fiori-positive-border)] font-bold text-[var(--fiori-positive)]">
                    ۲. مواد اولیه و کلاف‌های برگشتی به انبار:
                  </div>
                  <div className="divide-y divide-[var(--fiori-border-subtle)] max-h-36 overflow-y-auto">
                    {rollbackPreview.materialsToReturn.map((mat, i) => (
                      <div key={`${mat.documentId}-${i}`} className="px-3 py-1.5 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <span className="font-semibold text-[var(--fiori-text-primary)]">{mat.partName}</span>{' '}
                          <span className="font-mono text-[10px] text-[var(--fiori-text-secondary)]">
                            ({mat.partCode} • سند {mat.documentNumber})
                          </span>
                          <div className="text-[10px] text-[var(--fiori-text-secondary)]">
                            بازگشت به: {mat.warehouseName}
                            {mat.lotNumber ? ` • لات: ${mat.lotNumber}` : ''}
                          </div>
                        </div>
                        <span className="font-mono tabular-nums font-bold text-[var(--fiori-positive)] whitespace-nowrap">
                          +{formatNumber(mat.quantity)} {mat.unit}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Produced outputs to deduct */}
              {rollbackPreview.outputsToDeduct.length > 0 && (
                <div className="border border-[var(--fiori-critical-border)] rounded-[var(--fiori-radius-sm)] overflow-hidden">
                  <div className="px-3 py-1.5 bg-[var(--fiori-critical-bg)] border-b border-[var(--fiori-critical-border)] font-bold text-[var(--fiori-critical)]">
                    ۳. محصولات رسیدشده قابل کسر از انبار:
                  </div>
                  <div className="divide-y divide-[var(--fiori-border-subtle)] max-h-36 overflow-y-auto">
                    {rollbackPreview.outputsToDeduct.map((out, i) => (
                      <div key={`${out.documentId}-${i}`} className="px-3 py-1.5 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <span className="font-semibold text-[var(--fiori-text-primary)]">{out.partName}</span>{' '}
                          <span className="font-mono text-[10px] text-[var(--fiori-text-secondary)]">
                            ({out.partCode} • سند {out.documentNumber})
                          </span>
                          <div className="text-[10px] text-[var(--fiori-text-secondary)]">
                            انبار: {out.warehouseName} • قابل کسر: {formatNumber(out.availableAfterIssueReturn)}
                            {out.shortage > 0 && (
                              <span className="text-[var(--fiori-negative)] font-bold">
                                {' '}
                                • کسری: {formatNumber(out.shortage)}
                              </span>
                            )}
                          </div>
                        </div>
                        <span className="font-mono tabular-nums font-bold text-[var(--fiori-negative)] whitespace-nowrap">
                          -{formatNumber(out.quantity)} {out.unit}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Audit Reason Input */}
              <form id="mo-rollback-delete-form" onSubmit={handleConfirmMoDeleteRollback} className="space-y-1.5">
                <label className="block font-bold text-[var(--fiori-text-primary)]">
                  دلیل حذف دستور تولید و ابطال اسناد انبار (ثبت در لاگ ممیزی) <span className="text-[var(--fiori-negative)]">*</span>
                </label>
                <input
                  type="text"
                  required
                  minLength={3}
                  value={rollbackReason}
                  onChange={e => setRollbackReason(e.target.value)}
                  placeholder="مثال: اشتباه در تیراژ ابلاغی یا لغو برنامه برش توسط مشتری..."
                  className="fiori-input"
                />
              </form>
            </>
          ) : null}

          {rollbackError && (
            <FioriMessageStrip tone="error" compact>
              {rollbackError}
            </FioriMessageStrip>
          )}
        </div>
      </FioriDialog>
    </FioriDynamicPage>
  );
};
