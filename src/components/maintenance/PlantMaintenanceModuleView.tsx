import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Wrench,
  Calendar,
  CheckCircle2,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import {
  MaintenanceRequest,
  PreventiveMaintenancePlan,
  MaintenanceSparePart,
  TpmMetricsSummary,
  MaintenanceStage,
  MaintenancePriority,
  FailureCategory,
} from '../../types/maintenance';
import { Machine, DieMold, Operator } from '../../types/inventory';
import { formatNumber, toPersianDigits } from '../../utils/formatters';
import {
  FioriDynamicPage,
  FioriDataTable,
  FioriToolbar,
  FioriObjectStatus,
  FioriMessageStrip,
  FioriDialog,
  type FioriTableColumn,
  type FioriStatusTone,
} from '../fiori/ui';
import { EmptyState } from '../common/EmptyState';

interface PlantMaintenanceModuleViewProps {
  machines: Machine[];
  dies?: DieMold[];
  operators?: Operator[];
  onRefreshGlobalData?: () => Promise<void>;
}

type MaintenanceSubTab =
  | 'WORK_ORDERS'
  | 'PREVENTIVE_PLANS'
  | 'EQUIPMENT_LEDGER'
  | 'DIE_TOOLING'
  | 'SPARE_PARTS'
  | 'TPM_ANALYTICS';

const STAGE_LABELS: Record<MaintenanceStage, { label: string; tone: FioriStatusTone }> = {
  NEW: { label: 'درخواست جدید', tone: 'info' },
  IN_PROGRESS: { label: 'در دست اقدام نت', tone: 'critical' },
  WAITING_SPARES: { label: 'در انتظار قطعه یدکی', tone: 'critical' },
  REPAIRED: { label: 'تعمیر شده / تست ضرب', tone: 'positive' },
  CLOSED: { label: 'تأیید کیفی و بسته‌شده', tone: 'neutral' },
};

const PRIORITY_BADGES: Record<MaintenancePriority, { label: string; tone: FioriStatusTone }> = {
  LOW: { label: 'عادی', tone: 'neutral' },
  MEDIUM: { label: 'متوسط', tone: 'info' },
  HIGH: { label: 'فوری / توقف خط', tone: 'critical' },
  CRITICAL: { label: 'بحرانی / خطر ایمنی', tone: 'negative' },
};

const FAILURE_CATEGORY_LABELS: Record<FailureCategory, string> = {
  MECHANICAL: 'مکانیکی (شاتون، یاتاقان، لقی)',
  ELECTRICAL: 'برق و اتوماسیون (سنسور، رله، PLC)',
  HYDRAULIC: 'هیدرولیک (پمپ، پکینگ، شیر برقی)',
  PNEUMATIC: 'پنوماتیک (کلاچ، ترمز، رگلاتور)',
  DIE_MOLD: 'قالب و سنبه‌ماتریس (شکست فنر، پریدگی لبه)',
  OPERATOR_ERROR: 'خطای اپراتوری یا بارگذاری ورق',
  LUBRICATION: 'روانکاری و داغ‌کردن قطعات',
};

export const PlantMaintenanceModuleView: React.FC<PlantMaintenanceModuleViewProps> = ({
  machines,
  dies = [],
  operators = [],
  onRefreshGlobalData,
}) => {
  const [activeTab, setActiveTab] = useState<MaintenanceSubTab>('WORK_ORDERS');
  const [loading, setLoading] = useState(false);

  // Data Stores
  const [requests, setRequests] = useState<MaintenanceRequest[]>([]);
  const [pmPlans, setPmPlans] = useState<PreventiveMaintenancePlan[]>([]);
  const [spareParts, setSpareParts] = useState<MaintenanceSparePart[]>([]);
  const [tpmMetrics, setTpmMetrics] = useState<TpmMetricsSummary | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedMachineFilter, setSelectedMachineFilter] = useState('ALL');
  const [selectedPriorityFilter, setSelectedPriorityFilter] = useState('ALL');
  const [selectedStageFilter, setSelectedStageFilter] = useState('ALL');

  // Modals
  const [isNewRequestModalOpen, setIsNewRequestModalOpen] = useState(false);
  const [isNewPmModalOpen, setIsNewPmModalOpen] = useState(false);
  const [selectedRequestDetails, setSelectedRequestDetails] = useState<MaintenanceRequest | null>(null);
  const [selectedPmForExecution, setSelectedPmForExecution] = useState<PreventiveMaintenancePlan | null>(null);
  const [feedbackNotice, setFeedbackNotice] = useState<string | null>(null);

  // Form States for New Request
  const [newReqTitle, setNewReqTitle] = useState('');
  const [newReqMachineId, setNewReqMachineId] = useState(machines[0]?.id || 'MCH-01');
  const [newReqDieId, setNewReqDieId] = useState('');
  const [newReqType, setNewReqType] = useState<MaintenanceRequest['type']>('CORRECTIVE');
  const [newReqPriority, setNewReqPriority] = useState<MaintenancePriority>('HIGH');
  const [newReqCategory, setNewReqCategory] = useState<FailureCategory>('HYDRAULIC');
  const [newReqDescription, setNewReqDescription] = useState('');
  const [newReqReporter, setNewReqReporter] = useState('سرپرست سالن پرس');
  const [newReqTeam, setNewReqTeam] = useState('تیم مکانیک و هیدرولیک');

  // Load All Data from Server
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [reqRes, pmRes, sparesRes, metricsRes] = await Promise.all([
        fetch('/api/maintenance/requests').then(r => r.json()),
        fetch('/api/maintenance/pm-plans').then(r => r.json()),
        fetch('/api/maintenance/spare-parts').then(r => r.json()),
        fetch('/api/maintenance/tpm-metrics').then(r => r.json()),
      ]);

      if (reqRes.success) setRequests(reqRes.data);
      if (pmRes.success) setPmPlans(pmRes.data);
      if (sparesRes.success) setSpareParts(sparesRes.data);
      if (metricsRes.success) setTpmMetrics(metricsRes.data);
    } catch (err) {
      console.error('Failed to load maintenance data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Create New Request
  const handleCreateRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    const selMachine = machines.find(m => m.id === newReqMachineId);
    const selDie = dies.find(d => d.id === newReqDieId);

    try {
      const res = await fetch('/api/maintenance/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newReqTitle,
          machineId: newReqMachineId,
          machineCode: selMachine?.code || 'PRS-800T',
          machineName: selMachine?.name || 'پرس هیدرولیک ۸۰۰ تن',
          dieMoldId: selDie?.id,
          dieMoldName: selDie?.name,
          type: newReqType,
          priority: newReqPriority,
          failureCategory: newReqCategory,
          description: newReqDescription,
          reportedBy: newReqReporter,
          team: newReqTeam,
          requestedDate: new Date().toLocaleDateString('fa-IR'),
          downtimeMinutes: newReqPriority === 'CRITICAL' || newReqPriority === 'HIGH' ? 45 : 0,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setIsNewRequestModalOpen(false);
        setNewReqTitle('');
        setNewReqDescription('');
        setFeedbackNotice(data.message || 'درخواست با موفقیت ثبت شد.');
        await loadData();
        if (onRefreshGlobalData) await onRefreshGlobalData();
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Change Request Stage
  const handleUpdateStage = async (id: string, nextStage: MaintenanceStage) => {
    try {
      const res = await fetch(`/api/maintenance/requests/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: nextStage }),
      });
      const data = await res.json();
      if (data.success) {
        setFeedbackNotice(`وضعیت درخواست به «${STAGE_LABELS[nextStage].label}» تغییر یافت.`);
        await loadData();
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Mark PM Complete
  const handleCompletePm = async (planId: string) => {
    try {
      const res = await fetch(`/api/maintenance/pm-plans/${planId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          executionDate: new Date().toLocaleDateString('fa-IR'),
          notes: 'تمام آیتم‌های چک‌لیست بازرسی، روان‌کاری و آچارکشی با تأیید سرپرست نت انجام شد.',
          technician: 'تیم کشیک نت',
        }),
      });
      const data = await res.json();
      if (data.success) {
        setSelectedPmForExecution(null);
        setFeedbackNotice(data.message || 'سرویس نت پیشگیرانه ثبت شد.');
        await loadData();
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Filtered Requests
  const filteredRequests = useMemo(() => {
    return requests.filter(r => {
      if (selectedMachineFilter !== 'ALL' && r.machineId !== selectedMachineFilter) return false;
      if (selectedPriorityFilter !== 'ALL' && r.priority !== selectedPriorityFilter) return false;
      if (selectedStageFilter !== 'ALL' && r.stage !== selectedStageFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          r.title.toLowerCase().includes(q) ||
          r.requestCode.toLowerCase().includes(q) ||
          r.machineName.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [requests, selectedMachineFilter, selectedPriorityFilter, selectedStageFilter, searchQuery]);

  const activeWorkOrderFiltersCount =
    (searchQuery.trim() ? 1 : 0) +
    (selectedMachineFilter !== 'ALL' ? 1 : 0) +
    (selectedPriorityFilter !== 'ALL' ? 1 : 0) +
    (selectedStageFilter !== 'ALL' ? 1 : 0);

  const handleResetWorkOrderFilters = () => {
    setSearchQuery('');
    setSelectedMachineFilter('ALL');
    setSelectedPriorityFilter('ALL');
    setSelectedStageFilter('ALL');
  };

  const sparePartColumns: FioriTableColumn<MaintenanceSparePart>[] = useMemo(
    () => [
      {
        key: 'code',
        header: 'کد قطعه',
        sortable: true,
        sortValue: sp => sp.code,
        isLtrCode: true,
        cellClassName: 'font-semibold text-[var(--fiori-brand)]',
        render: sp => sp.code,
      },
      {
        key: 'name',
        header: 'نام قطعه یدکی و مشخصات فنی',
        sortable: true,
        sortValue: sp => sp.name,
        cellClassName: 'font-semibold text-[var(--fiori-text-primary)]',
        render: sp => sp.name,
      },
      {
        key: 'category',
        header: 'دسته‌بندی فنی',
        sortable: true,
        sortValue: sp => sp.category,
        render: sp => <FioriObjectStatus tone="neutral" label={sp.category} ltrCode size="sm" />,
      },
      {
        key: 'currentStock',
        header: 'موجودی فعلی',
        align: 'center',
        sortable: true,
        sortValue: sp => sp.currentStock,
        isMono: true,
        render: sp => {
          const isLowStock = sp.currentStock <= sp.minStockAlert;
          return (
            <FioriObjectStatus
              tone={isLowStock ? 'negative' : 'positive'}
              label={`${formatNumber(sp.currentStock)} ${sp.unit}`}
              size="sm"
            />
          );
        },
      },
      {
        key: 'minStockAlert',
        header: 'نقطه سفارش (حداقل)',
        align: 'center',
        sortable: true,
        sortValue: sp => sp.minStockAlert,
        isMono: true,
        cellClassName: 'text-[var(--fiori-text-secondary)]',
        render: sp => `${formatNumber(sp.minStockAlert)} ${sp.unit}`,
      },
      {
        key: 'compatibleMachines',
        header: 'دستگاه‌های سازگار',
        isMono: true,
        cellClassName: 'text-[11px] text-[var(--fiori-text-secondary)]',
        render: sp => sp.compatibleMachines.join('، ') || 'عمومی',
      },
      {
        key: 'storageLocation',
        header: 'موقعیت در انبار نت',
        cellClassName: 'text-[var(--fiori-text-secondary)]',
        render: sp => sp.storageLocation,
      },
      {
        key: 'unitPrice',
        header: 'ارزش واحد (ریال)',
        align: 'left',
        sortable: true,
        sortValue: sp => sp.unitPrice || 0,
        isMono: true,
        cellClassName: 'font-semibold text-[var(--fiori-text-primary)]',
        render: sp => (sp.unitPrice ? formatNumber(sp.unitPrice) : '—'),
      },
    ],
    []
  );

  return (
    <FioriDynamicPage
      title="مدیریت نگهداری و تعمیرات، قابلیت اطمینان و TPM تجهیزات"
      subtitle="ثبت درخواست‌های تعمیرات شکست، پایش توقفات، تقویم سرویس‌های دوره‌ای (PM)، شمارنده ضرب قالب‌ها و قطعات یدکی"
      status={<FioriObjectStatus tone="brand" label="SAP PM / TPM Reliability Workbench" ltrCode />}
      collapsibleFilters={activeTab === 'WORK_ORDERS'}
      activeFiltersCount={activeTab === 'WORK_ORDERS' ? activeWorkOrderFiltersCount : 0}
      onResetFilters={activeTab === 'WORK_ORDERS' ? handleResetWorkOrderFilters : undefined}
      headerActions={
        <>
          <button
            type="button"
            onClick={loadData}
            disabled={loading}
            className="sap-btn-standard inline-flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
            title="بروزرسانی داده‌ها"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-[var(--fiori-brand)]' : ''}`} />
            <span>بروزرسانی</span>
          </button>
          <button
            type="button"
            onClick={() => setIsNewRequestModalOpen(true)}
            className="sap-btn-emphasized inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>ثبت درخواست تعمیرات (Breakdown/CM)</span>
          </button>
        </>
      }
      filterBar={
        activeTab === 'WORK_ORDERS' ? (
          <div className="flex flex-wrap items-center justify-between gap-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-2 flex-1">
              <div className="relative min-w-[200px] flex-1 max-w-xs">
                <Search className="w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--fiori-text-muted)]" />
                <input
                  type="text"
                  placeholder="جستجو در کد، عنوان، ماشین یا شرح عیب..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="fiori-input w-full pr-8 pl-3 py-1.5"
                />
              </div>

              <select
                value={selectedMachineFilter}
                onChange={e => setSelectedMachineFilter(e.target.value)}
                className="fiori-input px-2.5 py-1.5 font-medium"
              >
                <option value="ALL">همه پرس‌ها و ماشین‌آلات</option>
                {machines.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.code})
                  </option>
                ))}
              </select>

              <select
                value={selectedPriorityFilter}
                onChange={e => setSelectedPriorityFilter(e.target.value)}
                className="fiori-input px-2.5 py-1.5 font-medium"
              >
                <option value="ALL">همه اولویت‌ها</option>
                <option value="CRITICAL">بحرانی / خطر ایمنی</option>
                <option value="HIGH">فوری / توقف خط</option>
                <option value="MEDIUM">متوسط</option>
                <option value="LOW">عادی</option>
              </select>
            </div>

            <span className="text-[11px] font-mono tabular-nums text-[var(--fiori-text-secondary)]">
              تعداد دستور کارها: {toPersianDigits(filteredRequests.length)}
            </span>
          </div>
        ) : undefined
      }
      toolbar={
        <div className="fiori-surface-card overflow-hidden">
          <div className="sap-icon-tab-bar px-2">
            {[
              { id: 'WORK_ORDERS', label: 'دستورکارهای تعمیرات (CM)', count: requests.length },
              { id: 'PREVENTIVE_PLANS', label: 'سرویس‌های دوره‌ای (PM)', count: pmPlans.length },
              { id: 'EQUIPMENT_LEDGER', label: 'شناسنامه خطوط و پرس‌ها', count: machines.length },
              { id: 'DIE_TOOLING', label: 'نت و ضرب قالب‌های سنبه‌ماتریس', count: dies.length },
              { id: 'SPARE_PARTS', label: 'انبار قطعات یدکی نت', count: spareParts.length },
              { id: 'TPM_ANALYTICS', label: 'شاخص‌های TPM و قابلیت اطمینان (MTBF/MTTR)' },
            ].map(tab => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id as MaintenanceSubTab)}
                className={`sap-icon-tab ${activeTab === tab.id ? 'sap-icon-tab-active' : ''}`}
              >
                <span>{tab.label}</span>
                {tab.count !== undefined && (
                  <span className="font-mono tabular-nums text-[10px] px-1.5 py-0.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-neutral-bg)] text-[var(--fiori-text-primary)] border border-[var(--fiori-neutral-border)]">
                    {toPersianDigits(tab.count)}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="px-3.5 py-2 bg-[var(--fiori-bg-subtle)] flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--fiori-text-secondary)] font-mono tabular-nums">
            <span>
              توقفات ثبت‌شده: <strong className="text-[var(--fiori-text-primary)]">{toPersianDigits(tpmMetrics?.totalDowntimeHours || 0)} ساعت</strong>
              <span className="mx-2 text-[var(--fiori-border-default)]">·</span>
              MTBF: <strong className="text-[var(--fiori-text-primary)]">{toPersianDigits(tpmMetrics?.mtbfHours || 0)} ساعت</strong>
            </span>
          </div>
        </div>
      }
      className="font-sans"
    >
      {/* Feedback Notice */}
      {feedbackNotice && (
        <FioriMessageStrip tone="success" onClose={() => setFeedbackNotice(null)}>
          {feedbackNotice}
        </FioriMessageStrip>
      )}

      {/* ==================================================================== */}
      {/* TAB 1: KANBAN & WORK ORDERS (MAINTENANCE WORK ORDERS)                */}
      {/* ==================================================================== */}
      {activeTab === 'WORK_ORDERS' && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3 overflow-x-auto pb-2">
            {(['NEW', 'IN_PROGRESS', 'WAITING_SPARES', 'REPAIRED', 'CLOSED'] as MaintenanceStage[]).map(stageKey => {
              const stageRequests = filteredRequests.filter(r => r.stage === stageKey);
              const meta = STAGE_LABELS[stageKey];

              return (
                <div
                  key={stageKey}
                  className="bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3 flex flex-col min-w-[240px] space-y-2.5"
                >
                  <div className="flex items-center justify-between border-b border-[var(--fiori-border-default)] pb-2">
                    <FioriObjectStatus tone={meta.tone} label={meta.label} variant="dot" size="md" />
                    <span className="font-mono tabular-nums text-[10px] font-semibold px-2 py-0.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-surface)] text-[var(--fiori-text-primary)] border border-[var(--fiori-border-default)]">
                      {toPersianDigits(stageRequests.length)}
                    </span>
                  </div>

                  <div className="space-y-2 flex-1 overflow-y-auto max-h-[600px] pr-0.5">
                    {stageRequests.length === 0 ? (
                      <div className="text-center py-8 text-[var(--fiori-text-muted)] text-[11px] border border-dashed border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-surface)]/60">
                        بدون دستور کار
                      </div>
                    ) : (
                      stageRequests.map(item => (
                        <div
                          key={item.id}
                          className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] hover:border-[var(--fiori-brand)] rounded-[var(--fiori-radius-sm)] p-3 space-y-2 transition-colors"
                        >
                          <div className="flex items-center justify-between gap-1.5">
                            <span className="fiori-ltr-code font-mono text-[10px] text-[var(--fiori-text-primary)] font-semibold bg-[var(--fiori-bg-subtle)] px-1.5 py-0.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-subtle)]">
                              {item.requestCode}
                            </span>
                            <FioriObjectStatus
                              tone={PRIORITY_BADGES[item.priority].tone}
                              label={PRIORITY_BADGES[item.priority].label}
                              size="sm"
                            />
                          </div>

                          <h4 className="font-semibold text-xs text-[var(--fiori-text-primary)] leading-snug line-clamp-2">
                            {item.title}
                          </h4>

                          <div className="space-y-1 text-[10px] text-[var(--fiori-text-secondary)] bg-[var(--fiori-bg-subtle)] p-2 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-subtle)]">
                            <div className="flex items-center justify-between gap-1">
                              <span>تجهیز:</span>
                              <strong className="text-[var(--fiori-text-primary)]">{item.machineName}</strong>
                            </div>
                            {item.dieMoldName && (
                              <div className="flex items-center justify-between gap-1">
                                <span>قالب:</span>
                                <span className="text-[var(--fiori-brand)] font-medium truncate max-w-[130px]">
                                  {item.dieMoldName}
                                </span>
                              </div>
                            )}
                            <div className="flex items-center justify-between gap-1">
                              <span>توقف خط:</span>
                              <strong className="text-[var(--fiori-negative)] font-mono tabular-nums">
                                {formatNumber(item.downtimeMinutes)} دقیقه
                              </strong>
                            </div>
                            <div className="flex items-center justify-between gap-1">
                              <span>تیم فنی:</span>
                              <span>{item.team}</span>
                            </div>
                          </div>

                          {/* Quick Stage Transitions */}
                          <div className="pt-2 border-t border-[var(--fiori-border-subtle)] flex items-center justify-between gap-1 text-[10px]">
                            {stageKey === 'NEW' && (
                              <button
                                type="button"
                                onClick={() => handleUpdateStage(item.id, 'IN_PROGRESS')}
                                className="w-full py-1 bg-[var(--fiori-critical)] hover:opacity-90 text-white rounded-[var(--fiori-radius-sm)] font-semibold cursor-pointer transition text-center"
                              >
                                شروع اقدام نت
                              </button>
                            )}
                            {stageKey === 'IN_PROGRESS' && (
                              <div className="grid grid-cols-2 gap-1 w-full">
                                <button
                                  type="button"
                                  onClick={() => handleUpdateStage(item.id, 'WAITING_SPARES')}
                                  className="py-1 bg-[var(--fiori-critical-bg)] hover:opacity-90 text-[var(--fiori-critical)] rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-critical-border)] font-semibold cursor-pointer transition"
                                >
                                  انتظار قطعه
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleUpdateStage(item.id, 'REPAIRED')}
                                  className="py-1 bg-[var(--fiori-positive)] hover:opacity-90 text-white rounded-[var(--fiori-radius-sm)] font-semibold cursor-pointer transition"
                                >
                                  تعمیر شد
                                </button>
                              </div>
                            )}
                            {stageKey === 'WAITING_SPARES' && (
                              <button
                                type="button"
                                onClick={() => handleUpdateStage(item.id, 'IN_PROGRESS')}
                                className="w-full py-1 bg-[var(--fiori-info-bg)] hover:opacity-90 text-[var(--fiori-info)] rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-info-border)] font-semibold cursor-pointer transition"
                              >
                                دریافت قطعه و ادامه
                              </button>
                            )}
                            {stageKey === 'REPAIRED' && (
                              <button
                                type="button"
                                onClick={() => handleUpdateStage(item.id, 'CLOSED')}
                                className="sap-btn-emphasized w-full py-1 font-semibold text-center cursor-pointer"
                              >
                                تأیید QC و بستن
                              </button>
                            )}
                            {stageKey === 'CLOSED' && (
                              <div className="w-full flex justify-center py-0.5">
                                <FioriObjectStatus tone="positive" label="رفع عیب و تحویل" icon size="sm" variant="text" />
                              </div>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 2: PREVENTIVE MAINTENANCE (PM) SCHEDULES & CHECKLISTS            */}
      {/* ==================================================================== */}
      {activeTab === 'PREVENTIVE_PLANS' && (
        <div className="space-y-4">
          <FioriMessageStrip
            tone="info"
            icon={<Calendar className="w-4 h-4 shrink-0" />}
            actions={
              <FioriObjectStatus
                tone="brand"
                label={`نرخ اجرای به موقع PM: ${toPersianDigits(tpmMetrics?.preventiveComplianceRate || 92)}٪`}
              />
            }
          >
            <strong>برنامه‌ریزی نت پیشگیرانه (PM):</strong> سرویس‌های برنامه‌ریزی‌شده بر اساس تقویم هفتگی/ماهانه یا تعداد ضرب قالب (Stroke Counter) جهت جلوگیری از خرابی‌های ناگهانی خطوط پرسکاری.
          </FioriMessageStrip>

          {pmPlans.length === 0 ? (
            <EmptyState
              variant="NO_DATA"
              compact
              title="هیچ برنامه سرویس دوره‌ای (PM) ثبت نشده است"
              description="برنامه‌های نت پیشگیرانه پس از تعریف در تقویم سرویس تجهیزات در این بخش نمایش داده می‌شوند."
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {pmPlans.map(plan => {
                const isDue = plan.status === 'DUE' || plan.status === 'OVERDUE';

                return (
                  <div
                    key={plan.id}
                    className={`fiori-surface-card p-4 space-y-3 transition-colors ${
                      isDue ? 'border-[var(--fiori-critical-border)]' : ''
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 border-b border-[var(--fiori-border-subtle)] pb-2.5">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="fiori-ltr-code font-mono text-xs text-[var(--fiori-text-primary)] font-semibold bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] px-2 py-0.5 rounded-[var(--fiori-radius-sm)]">
                            {plan.planCode}
                          </span>
                          <FioriObjectStatus
                            tone="info"
                            label={
                              plan.frequency === 'DAILY'
                                ? 'روزانه'
                                : plan.frequency === 'WEEKLY'
                                ? 'هفتگی'
                                : plan.frequency === 'MONTHLY'
                                ? 'ماهانه'
                                : 'بر اساس تعداد ضرب'
                            }
                            size="sm"
                          />
                        </div>
                        <h3 className="font-semibold text-sm text-[var(--fiori-text-primary)] mt-1.5">{plan.title}</h3>
                      </div>

                      <FioriObjectStatus
                        tone={plan.status === 'COMPLETED' ? 'positive' : isDue ? 'critical' : 'neutral'}
                        label={
                          plan.status === 'COMPLETED'
                            ? 'انجام‌شده'
                            : isDue
                            ? 'سررسید شده'
                            : 'زمان‌بندی‌شده'
                        }
                        icon
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs bg-[var(--fiori-bg-subtle)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-subtle)]">
                      <div>
                        <span className="text-[var(--fiori-text-muted)] text-[11px] block">تجهیز مرتبط:</span>
                        <strong className="text-[var(--fiori-text-primary)]">{plan.machineName}</strong>
                      </div>
                      <div>
                        <span className="text-[var(--fiori-text-muted)] text-[11px] block">تیم مجری:</span>
                        <span className="text-[var(--fiori-text-primary)]">{plan.assignedTeam}</span>
                      </div>
                      <div>
                        <span className="text-[var(--fiori-text-muted)] text-[11px] block">آخرین اجرا:</span>
                        <span className="fiori-ltr-code font-mono tabular-nums text-[var(--fiori-text-primary)]">
                          {plan.lastPerformedDate || '—'}
                        </span>
                      </div>
                      <div>
                        <span className="text-[var(--fiori-text-muted)] text-[11px] block">موعد بعدی:</span>
                        <strong className="fiori-ltr-code font-mono tabular-nums text-[var(--fiori-critical)]">
                          {plan.nextDueDate}
                        </strong>
                      </div>
                    </div>

                    {/* Checklist Items */}
                    <div className="space-y-1.5">
                      <span className="text-[11px] font-semibold text-[var(--fiori-text-primary)] block">
                        آیتم‌های چک‌لیست بازرسی و سرویس ({toPersianDigits(plan.checklistItems.length)} مورد):
                      </span>
                      <div className="space-y-1 max-h-36 overflow-y-auto pr-1">
                        {plan.checklistItems.map((chk, cIdx) => (
                          <div
                            key={chk.id || cIdx}
                            className="flex items-start justify-between bg-[var(--fiori-bg-subtle)] p-2 rounded-[var(--fiori-radius-sm)] text-[11px] border border-[var(--fiori-border-subtle)]"
                          >
                            <div className="flex items-start gap-1.5 flex-1">
                              <span className="font-mono tabular-nums text-[10px] text-[var(--fiori-text-muted)] shrink-0">
                                {toPersianDigits(cIdx + 1)}.
                              </span>
                              <span className="text-[var(--fiori-text-primary)] leading-snug">{chk.taskDescription}</span>
                            </div>
                            {chk.standardValue && (
                              <span className="text-[10px] font-mono tabular-nums text-[var(--fiori-text-secondary)] bg-[var(--fiori-bg-surface)] px-1.5 py-0.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] shrink-0 mr-2">
                                {chk.standardValue}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Action Button */}
                    <div className="pt-2 border-t border-[var(--fiori-border-subtle)] flex items-center justify-between">
                      <span className="text-[11px] text-[var(--fiori-text-secondary)] font-mono tabular-nums">
                        زمان تخمینی: {toPersianDigits(plan.estimatedDurationMinutes)} دقیقه
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCompletePm(plan.id)}
                        className="sap-btn-emphasized px-3.5 py-1.5 text-xs inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>ثبت انجام کامل سرویس PM</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 3: EQUIPMENT & PRESS MACHINES LEDGER                             */}
      {/* ==================================================================== */}
      {activeTab === 'EQUIPMENT_LEDGER' && (
        <div className="space-y-4">
          {machines.length === 0 ? (
            <EmptyState
              variant="NO_DATA"
              compact
              title="هیچ ماشین یا خط پرسی ثبت نشده است"
              description="تجهیزات کارخانه پس از تعریف در اطلاعات پایه ماشین‌آلات در این دفتر کل نمایش داده می‌شوند."
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
              {machines.map(m => {
                const machineRequests = requests.filter(r => r.machineId === m.id);
                const totalMchDowntime = machineRequests.reduce(
                  (sum, r) => sum + (Number(r.downtimeMinutes) || 0),
                  0
                );

                return (
                  <div key={m.id} className="fiori-surface-card p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2 border-b border-[var(--fiori-border-subtle)] pb-2.5">
                      <div>
                        <span className="fiori-ltr-code font-mono text-xs font-semibold text-[var(--fiori-text-primary)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] px-2 py-0.5 rounded-[var(--fiori-radius-sm)]">
                          {m.code}
                        </span>
                        <h3 className="font-semibold text-sm text-[var(--fiori-text-primary)] mt-1.5">{m.name}</h3>
                      </div>
                      <FioriObjectStatus
                        tone={m.status === 'ACTIVE' ? 'positive' : m.status === 'MAINTENANCE' ? 'negative' : 'critical'}
                        label={m.status === 'ACTIVE' ? 'در حال تولید' : m.status === 'MAINTENANCE' ? 'تحت تعمیرات' : 'متوقف'}
                        icon
                      />
                    </div>

                    <div className="space-y-1.5 text-xs">
                      <div className="flex justify-between py-1 border-b border-[var(--fiori-border-subtle)]">
                        <span className="text-[var(--fiori-text-secondary)]">تناژ اسمی:</span>
                        <strong className="text-[var(--fiori-text-primary)] font-mono tabular-nums">
                          {m.tonnage ? `${formatNumber(m.tonnage)} تن` : '—'}
                        </strong>
                      </div>
                      <div className="flex justify-between py-1 border-b border-[var(--fiori-border-subtle)]">
                        <span className="text-[var(--fiori-text-secondary)]">ابعاد میز و کورس:</span>
                        <span className="fiori-ltr-code font-mono tabular-nums text-[var(--fiori-text-primary)]">
                          {m.bolsterSize || '—'}
                        </span>
                      </div>
                      <div className="flex justify-between py-1 border-b border-[var(--fiori-border-subtle)]">
                        <span className="text-[var(--fiori-text-secondary)]">محل استقرار:</span>
                        <span className="text-[var(--fiori-text-primary)]">{m.location}</span>
                      </div>
                      <div className="flex justify-between py-1 border-b border-[var(--fiori-border-subtle)]">
                        <span className="text-[var(--fiori-text-secondary)]">توقفات ثبت‌شده در شیفت:</span>
                        <strong className="text-[var(--fiori-negative)] font-mono tabular-nums">
                          {toPersianDigits(totalMchDowntime)} دقیقه
                        </strong>
                      </div>
                      <div className="flex justify-between py-1">
                        <span className="text-[var(--fiori-text-secondary)]">تعداد خرابی‌های شکست:</span>
                        <strong className="text-[var(--fiori-text-primary)] font-mono tabular-nums">
                          {toPersianDigits(machineRequests.length)} مورد
                        </strong>
                      </div>
                    </div>

                    <div className="pt-2 border-t border-[var(--fiori-border-subtle)] flex items-center justify-between">
                      <span className="text-[11px] text-[var(--fiori-text-secondary)]">
                        اپراتور: {m.operatorName || 'شیفت عمومی'}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setNewReqMachineId(m.id);
                          setIsNewRequestModalOpen(true);
                        }}
                        className="sap-btn-standard px-2.5 py-1 text-xs cursor-pointer"
                      >
                        + ثبت خرابی
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 4: DIE & MOLD TOOLING LIFESPAN & STROKE COUNTERS                 */}
      {/* ==================================================================== */}
      {activeTab === 'DIE_TOOLING' && (
        <div className="space-y-4">
          {dies.length === 0 ? (
            <EmptyState
              variant="NO_DATA"
              compact
              title="هیچ قالبی در سیستم ثبت نشده است"
              description="قالب‌های سنبه‌ماتریس و ابزارهای فرم‌دهی پس از تعریف در بخش ماشین‌آلات و قالب‌ها در این قسمت نمایش داده می‌شوند."
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
              {dies.map(die => {
                const currentStrokes = die.currentStrokes || 0;
                const targetLife = die.strokeLifeTarget || 200000;
                const wearPercent = Math.min(100, Math.round((currentStrokes / targetLife) * 100));

                return (
                  <div key={die.id} className="fiori-surface-card p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2 border-b border-[var(--fiori-border-subtle)] pb-2.5">
                      <div>
                        <span className="fiori-ltr-code font-mono text-xs font-semibold text-[var(--fiori-text-primary)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] px-2 py-0.5 rounded-[var(--fiori-radius-sm)]">
                          {die.code}
                        </span>
                        <h3 className="font-semibold text-sm text-[var(--fiori-text-primary)] mt-1.5">{die.name}</h3>
                      </div>
                      <FioriObjectStatus
                        tone={die.status === 'READY' ? 'positive' : die.status === 'UNDER_MAINTENANCE' ? 'negative' : 'critical'}
                        label={
                          die.status === 'READY'
                            ? 'آماده پرسکاری'
                            : die.status === 'UNDER_MAINTENANCE'
                            ? 'در دست پولیش/تیزکاری'
                            : 'کالیبراسیون و فیلرگیری'
                        }
                        icon
                      />
                    </div>

                    <div className="space-y-2 text-xs">
                      <div>
                        <div className="flex justify-between text-[11px] mb-1">
                          <span className="text-[var(--fiori-text-secondary)]">میزان کارکرد و استهلاک سنبه‌ماتریس:</span>
                          <strong className="font-mono tabular-nums text-[var(--fiori-text-primary)]">
                            {toPersianDigits(wearPercent)}٪
                          </strong>
                        </div>
                        <div className="w-full bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-subtle)] h-2 rounded-[var(--fiori-radius-sm)] overflow-hidden">
                          <div
                            className={`h-full transition-all ${
                              wearPercent > 80
                                ? 'bg-[var(--fiori-negative)]'
                                : wearPercent > 50
                                ? 'bg-[var(--fiori-critical)]'
                                : 'bg-[var(--fiori-positive)]'
                            }`}
                            style={{ width: `${wearPercent}%` }}
                          />
                        </div>
                      </div>

                      <div className="flex justify-between py-1 border-b border-[var(--fiori-border-subtle)]">
                        <span className="text-[var(--fiori-text-secondary)]">تعداد ضرب زده‌شده:</span>
                        <strong className="font-mono tabular-nums text-[var(--fiori-text-primary)]">
                          {formatNumber(currentStrokes)} / {formatNumber(targetLife)} ضرب
                        </strong>
                      </div>
                      <div className="flex justify-between py-1 border-b border-[var(--fiori-border-subtle)]">
                        <span className="text-[var(--fiori-text-secondary)]">تناژ مورد نیاز:</span>
                        <span className="font-mono tabular-nums text-[var(--fiori-text-primary)]">
                          {formatNumber(die.requiredTonnage || 250)} تن
                        </span>
                      </div>
                      <div className="flex justify-between py-1">
                        <span className="text-[var(--fiori-text-secondary)]">محل نگهداری در انبار قالب:</span>
                        <span className="text-[var(--fiori-text-primary)] font-medium">{die.location || 'قفسه عمومی'}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 5: SPARE PARTS INVENTORY FOR MAINTENANCE                         */}
      {/* ==================================================================== */}
      {activeTab === 'SPARE_PARTS' && (
        <FioriDataTable
          columns={sparePartColumns}
          data={spareParts}
          rowKey={sp => sp.id}
          loading={loading}
          toolbar={
            <FioriToolbar
              title="انبار قطعات یدکی بحرانی و لوازم مصرفی نت"
              subtitle="پکینگ‌های هیدرولیک، شیرهای پروپورشنال، فنرهای نیتروژنی، روغن هیدرولیک و سنسورهای پرده نوری"
              count={spareParts.length}
              countLabel="قلم"
            />
          }
          emptyState={
            <div className="p-4">
              <EmptyState
                variant="NO_DATA"
                compact
                title="قطعه یدکی در انبار نت ثبت نشده است"
                description="پس از ثبت اقلام یدکی بحرانی و موجودی آن‌ها، جدول کنترل نقطه سفارش در این بخش نمایش داده می‌شود."
              />
            </div>
          }
        />
      )}

      {/* ==================================================================== */}
      {/* TAB 6: TPM ANALYTICS, MTBF, MTTR & RELIABILITY DASHBOARD             */}
      {/* ==================================================================== */}
      {activeTab === 'TPM_ANALYTICS' && (
        !tpmMetrics ? (
          <EmptyState
            variant="NO_DATA"
            compact
            title="داده‌ای برای محاسبه شاخص‌های TPM در دسترس نیست"
            description="پس از بارگذاری یا ثبت درخواست‌های تعمیرات و سرویس‌های دوره‌ای، شاخص‌های MTBF و MTTR محاسبه می‌شوند."
          />
        ) : (
          <div className="space-y-4">
            {/* Top 4 KPI Metric Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="fiori-surface-card p-3.5 space-y-1">
                <span className="text-[11px] text-[var(--fiori-text-secondary)] font-medium">
                  MTBF (میانگین زمان بین خرابی‌ها)
                </span>
                <div className="flex items-baseline gap-1.5 mt-1">
                  <span className="text-xl font-semibold font-mono text-[var(--fiori-text-primary)] tabular-nums">
                    {toPersianDigits(tpmMetrics.mtbfHours)}
                  </span>
                  <span className="text-xs text-[var(--fiori-text-secondary)]">ساعت</span>
                </div>
                <p className="text-[10px] text-[var(--fiori-positive)] font-medium">
                  شاخص پایداری و سلامت تجهیزات کارخانه
                </p>
              </div>

              <div className="fiori-surface-card p-3.5 space-y-1">
                <span className="text-[11px] text-[var(--fiori-text-secondary)] font-medium">
                  MTTR (میانگین زمان تعمیر تجهیز)
                </span>
                <div className="flex items-baseline gap-1.5 mt-1">
                  <span className="text-xl font-semibold font-mono text-[var(--fiori-critical)] tabular-nums">
                    {toPersianDigits(tpmMetrics.mttrHours)}
                  </span>
                  <span className="text-xs text-[var(--fiori-text-secondary)]">ساعت</span>
                </div>
                <p className="text-[10px] text-[var(--fiori-critical)] font-medium">
                  سرعت پاسخ‌دهی و مهارت تکنسین‌های نت
                </p>
              </div>

              <div className="fiori-surface-card p-3.5 space-y-1">
                <span className="text-[11px] text-[var(--fiori-text-secondary)] font-medium">
                  نرخ دسترسی تجهیزات (Availability)
                </span>
                <div className="flex items-baseline gap-1.5 mt-1">
                  <span className="text-xl font-semibold font-mono text-[var(--fiori-positive)] tabular-nums">
                    {toPersianDigits(tpmMetrics.availabilityRatePercent)}٪
                  </span>
                </div>
                <p className="text-[10px] text-[var(--fiori-text-secondary)] font-medium">
                  زمان آماده‌به‌کاری نسبت به برنامه شیفت
                </p>
              </div>

              <div className="fiori-surface-card p-3.5 space-y-1">
                <span className="text-[11px] text-[var(--fiori-text-secondary)] font-medium">
                  نسبت نت برنامه‌ریزی‌شده (PMP Ratio)
                </span>
                <div className="flex items-baseline gap-1.5 mt-1">
                  <span className="text-xl font-semibold font-mono text-[var(--fiori-brand)] tabular-nums">
                    {toPersianDigits(tpmMetrics.pmpRatio)}٪
                  </span>
                </div>
                <p className="text-[10px] text-[var(--fiori-brand)] font-medium">
                  غلبه نت پیشگیرانه بر توقفات اضطراری
                </p>
              </div>
            </div>

            {/* Breakdown Pareto Breakdown by Cause */}
            <div className="fiori-surface-card p-4 space-y-3.5">
              <div>
                <h3 className="font-semibold text-sm text-[var(--fiori-text-primary)]">
                  پارتوی علل ریشه‌ای توقفات خطوط پرسکاری
                </h3>
                <p className="text-xs text-[var(--fiori-text-secondary)] mt-0.5">
                  تفکیک دقایق توقف خطوط بر اساس منشأ خرابی (سیستم هیدرولیک، قالب و سنبه، مدار برق، پنوماتیک)
                </p>
              </div>

              <div className="space-y-3">
                {tpmMetrics.topFailureCauses.map(item => {
                  const label = FAILURE_CATEGORY_LABELS[item.cause as FailureCategory] || item.cause;

                  return (
                    <div key={item.cause} className="space-y-1">
                      <div className="flex items-center justify-between text-xs gap-2">
                        <span className="font-semibold text-[var(--fiori-text-primary)]">{label}</span>
                        <div className="flex items-center gap-2 font-mono tabular-nums">
                          <span className="text-[var(--fiori-text-secondary)]">
                            {toPersianDigits(item.count)} حادثه ({formatNumber(item.downtimeMinutes)} دقیقه)
                          </span>
                          <strong className="text-[var(--fiori-text-primary)]">{toPersianDigits(item.percentage)}٪</strong>
                        </div>
                      </div>
                      <div className="w-full bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-subtle)] h-2 rounded-[var(--fiori-radius-sm)] overflow-hidden">
                        <div
                          className="h-full bg-[var(--fiori-brand)] transition-all"
                          style={{ width: `${item.percentage}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )
      )}

      {/* ==================================================================== */}
      {/* MODAL: CREATE NEW MAINTENANCE REQUEST (BREAKDOWN / CORRECTIVE)       */}
      {/* ==================================================================== */}
      <FioriDialog
        isOpen={isNewRequestModalOpen}
        onClose={() => setIsNewRequestModalOpen(false)}
        title="ثبت درخواست جدید تعمیرات خط و ماشین‌آلات (Corrective Maintenance)"
        icon={<Wrench className="w-4 h-4" />}
        tone="brand"
        size="md"
        footer={
          <>
            <button
              type="button"
              onClick={() => setIsNewRequestModalOpen(false)}
              className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="pm-new-request-form"
              className="sap-btn-emphasized px-5 py-1.5 text-xs cursor-pointer"
            >
              ثبت دستور کار نت و اعزام تکنیسین
            </button>
          </>
        }
      >
        <form id="pm-new-request-form" onSubmit={handleCreateRequest} className="space-y-3 text-xs">
          <div>
            <label className="block font-semibold text-[var(--fiori-text-primary)] mb-1">عنوان خلاصه عیب یا خرابی *</label>
            <input
              type="text"
              required
              placeholder="مثال: نشت روغن هیدرولیک سیلندر بالشتک یا شکست پین پران"
              value={newReqTitle}
              onChange={e => setNewReqTitle(e.target.value)}
              className="fiori-input w-full px-3 py-1.5 font-medium"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-[var(--fiori-text-primary)] mb-1">پرس یا دستگاه دچار عیب *</label>
              <select
                value={newReqMachineId}
                onChange={e => setNewReqMachineId(e.target.value)}
                className="fiori-input w-full px-3 py-1.5 font-semibold"
              >
                {machines.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.code})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block font-semibold text-[var(--fiori-text-primary)] mb-1">قالب روی دستگاه (اختیاری)</label>
              <select
                value={newReqDieId}
                onChange={e => setNewReqDieId(e.target.value)}
                className="fiori-input w-full px-3 py-1.5"
              >
                <option value="">بدون درگیری قالب</option>
                {dies.map(d => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.code})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-[var(--fiori-text-primary)] mb-1">سطح اولویت و حساسیت *</label>
              <select
                value={newReqPriority}
                onChange={e => setNewReqPriority(e.target.value as MaintenancePriority)}
                className="fiori-input w-full px-3 py-1.5 font-semibold"
              >
                <option value="CRITICAL">بحرانی / خطر ایمنی یا خرابی فاجعه‌بار</option>
                <option value="HIGH">فوری / توقف کامل خط تولید</option>
                <option value="MEDIUM">متوسط / توقف احتمالی در ساعات آتی</option>
                <option value="LOW">عادی / سرویس در اولین فرصت توقف</option>
              </select>
            </div>

            <div>
              <label className="block font-semibold text-[var(--fiori-text-primary)] mb-1">دسته‌بندی فنی عیب *</label>
              <select
                value={newReqCategory}
                onChange={e => setNewReqCategory(e.target.value as FailureCategory)}
                className="fiori-input w-full px-3 py-1.5"
              >
                <option value="HYDRAULIC">هیدرولیک (پمپ، پکینگ، شیر)</option>
                <option value="DIE_MOLD">قالب و سنبه‌ماتریس (شکست، پریدگی)</option>
                <option value="ELECTRICAL">برق و اتوماسیون (سنسور، پرده نوری)</option>
                <option value="MECHANICAL">مکانیکی (شاتون، یاتاقان، لقی)</option>
                <option value="PNEUMATIC">پنوماتیک (کلاچ، ترمز، فیلتر)</option>
                <option value="LUBRICATION">روانکاری و داغ‌کردن قطعات</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block font-semibold text-[var(--fiori-text-primary)] mb-1">شرح دقیق عیب و نشانه‌های مشاهده‌شده</label>
            <textarea
              rows={3}
              placeholder="علائم، صدای غیرعادی، فشار سنج‌ها، وضعیت قطعه خروجی..."
              value={newReqDescription}
              onChange={e => setNewReqDescription(e.target.value)}
              className="fiori-input w-full px-3 py-1.5"
            />
          </div>
        </form>
      </FioriDialog>
    </FioriDynamicPage>
  );
};
