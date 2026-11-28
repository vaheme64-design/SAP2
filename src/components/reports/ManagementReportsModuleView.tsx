import React, { useState, useEffect, useMemo } from 'react';
import {
  FileSpreadsheet,
  RefreshCw,
  Search,
  Printer,
  Filter,
} from 'lucide-react';
import {
  ReportFilterParams,
  ReportMeta,
  PlanVsActualItem,
  CustomerOrderFulfillmentItem,
  ProductionBacklogItem,
  WipByPartAndOperationItem,
  WipAgingItem,
  MaterialConsumptionActualItem,
  SapcoMaterialAccountItem,
  InventoryValuationQuantitiesItem,
  ScrapByPartAndOperationItem,
  MachineWorkloadCapacityItem,
  ProductionDelaysItem,
  ProductionDelaySection,
  ProductionDelayAnalyticsSummary,
  InventoryMovementItem,
  InventoryReconciliationItem,
  CoilInventoryReportItem,
  LotConsumptionReportItem,
  SupplierMatrixReportItem,
} from '../../types/managementReports';
import { Part, Machine } from '../../types/inventory';
import { ReportFiltersBar } from './ReportFiltersBar';
import { DrillDownModal, DrillDownData } from './DrillDownModal';
import { exportToCsv } from '../../utils/csvExport';
import { formatNumber, toPersianDigits } from '../../utils/formatters';
import { formatToJalali } from '../../utils/jalali';
import { OeeModuleView } from './OeeModuleView';
import { MachineUtilizationView } from './MachineUtilizationView';
import { ConsumablesForecastView } from '../planning/ConsumablesForecastView';
import { MrpModuleView } from '../planning/MrpModuleView';
import { ComprehensiveProductionReportView } from './ComprehensiveProductionReportView';
import { ProductionWorkflowDocumentationView } from '../planning/ProductionWorkflowDocumentationView';
import { PlantMaintenanceModuleView } from '../maintenance/PlantMaintenanceModuleView';
import { CustomReportsView } from '../inventory/CustomReportsView';
import { TableSkeleton, KpiCardsSkeleton, ChartSkeleton } from '../ui/Skeleton';
import { useErpRouter } from '../../context/RouterContext';
import { InlinePageGuideButton } from '../common/PageGuideSystem';
import { EmptyState } from '../common/EmptyState';
import {
  FioriDataTable,
  FioriToolbar,
  FioriMessageStrip,
  FioriObjectStatus,
} from '../fiori/ui';
import {
  buildPlanVsActualDrillDown,
  getPlanVsActualColumns,
  getFulfillmentColumns,
  getBacklogColumns,
  getWipOperationColumns,
  getWipAgingColumns,
  getConsumptionColumns,
  getSapcoAccountColumns,
  getValuationQtyColumns,
  getScrapAnalysisColumns,
  getMachineWorkloadColumns,
  getDelaysColumns,
  getMovementsColumns,
  getReconciliationColumns,
  getCoilInventoryColumns,
  getLotConsumptionColumns,
  getSupplierMatrixColumns,
} from './managementReportColumns';

export type ReportTypeKey =
  | 'plan_vs_actual'
  | 'fulfillment'
  | 'backlog'
  | 'wip_operation'
  | 'wip_aging'
  | 'consumption'
  | 'sapco_account'
  | 'valuation_qty'
  | 'scrap_analysis'
  | 'machine_workload'
  | 'delays'
  | 'movements'
  | 'reconciliation'
  | 'coil_inventory'
  | 'lot_consumption'
  | 'supplier_matrix'
  | 'oee_module'
  | 'machine_utilization'
  | 'consumables_forecast'
  | 'mrp_forecast'
  | 'comprehensive_production'
  | 'production_workflow'
  | 'tpm_maintenance'
  | 'custom_builder';

interface ManagementReportsModuleViewProps {
  parts: Part[];
  machines: Machine[];
  initialReportType?: ReportTypeKey;
  onReportTypeChange?: (report: ReportTypeKey) => void;
}

export const ManagementReportsModuleView: React.FC<ManagementReportsModuleViewProps> = ({
  parts,
  machines,
  initialReportType = 'plan_vs_actual',
  onReportTypeChange,
}) => {
  const { traceDocument, route } = useErpRouter();
  const [activeReport, setActiveReport] = useState<ReportTypeKey>(initialReportType);
  const [filters, setFilters] = useState<ReportFilterParams>({});
  const [loading, setLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportMeta, setReportMeta] = useState<ReportMeta | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [tableSearchQuery, setTableSearchQuery] = useState<string>(route.docQuery || '');

  useEffect(() => {
    if (initialReportType && initialReportType !== activeReport) {
      setActiveReport(initialReportType);
    }
  }, [initialReportType]);

  useEffect(() => {
    if (route.docQuery !== undefined && route.docQuery !== null) {
      setTableSearchQuery(route.docQuery);
    }
  }, [route.docQuery]);

  const handleSelectReport = (rep: ReportTypeKey) => {
    setActiveReport(rep);
    onReportTypeChange?.(rep);
  };

  // Report Data Stores
  const [planVsActualData, setPlanVsActualData] = useState<PlanVsActualItem[]>([]);
  const [fulfillmentData, setFulfillmentData] = useState<CustomerOrderFulfillmentItem[]>([]);
  const [backlogData, setBacklogData] = useState<ProductionBacklogItem[]>([]);
  const [wipOpData, setWipOpData] = useState<WipByPartAndOperationItem[]>([]);
  const [wipAgingData, setWipAgingData] = useState<WipAgingItem[]>([]);
  const [consumptionData, setConsumptionData] = useState<MaterialConsumptionActualItem[]>([]);
  const [sapcoAccountData, setSapcoAccountData] = useState<SapcoMaterialAccountItem[]>([]);
  const [valuationData, setValuationData] = useState<InventoryValuationQuantitiesItem[]>([]);
  const [scrapData, setScrapData] = useState<ScrapByPartAndOperationItem[]>([]);
  const [machineData, setMachineData] = useState<MachineWorkloadCapacityItem[]>([]);
  const [delaysData, setDelaysData] = useState<ProductionDelaysItem[]>([]);
  const [delayAnalytics, setDelayAnalytics] = useState<ProductionDelayAnalyticsSummary | null>(null);
  const [delaySectionFilter, setDelaySectionFilter] = useState<'ALL' | ProductionDelaySection>('ALL');
  const [delayCauseFilter, setDelayCauseFilter] = useState<string>('ALL');
  const [movementsData, setMovementsData] = useState<InventoryMovementItem[]>([]);
  const [reconciliationData, setReconciliationData] = useState<InventoryReconciliationItem[]>([]);
  const [coilInventoryData, setCoilInventoryData] = useState<CoilInventoryReportItem[]>([]);
  const [lotConsumptionData, setLotConsumptionData] = useState<LotConsumptionReportItem[]>([]);
  const [supplierMatrixData, setSupplierMatrixData] = useState<SupplierMatrixReportItem[]>([]);

  // Drill-down Modal State
  const [drillDownItem, setDrillDownItem] = useState<DrillDownData | null>(null);

  const reportDefinitions: { id: ReportTypeKey; title: string; category: string; description: string }[] = [
    { id: 'custom_builder', title: '★ گزارش‌ساز پویا و سفارشی (موجودی ۳ سطحی پس از مصرف، انحراف BOM و زنجیره رهگیری اسناد)', category: 'انبار', description: 'ساخت گزارش سفارشی با انتخاب ستون‌ها، ذخیره قالب، خروجی اکسل و رهگیری از شماره ذوب تا محصول نهایی' },
    { id: 'plan_vs_actual', title: '۱. تطبیق برنامه در برابر تولید واقعی (Plan vs Actual)', category: 'تولید', description: 'مقایسه تناژ و تیراژ مصوب ماهانه با آمار تولید واقعی پرس‌ها و محاسبه درصد تحقق' },
    { id: 'fulfillment', title: '۲. وضعیت تحقق سفارشات مشتریان (ساپکو/سایپا)', category: 'فروش', description: 'تعهدات تحویل قطعات بدنه به خطوط خودروساز و پایش کسری‌های خطوط مشتری' },
    { id: 'backlog', title: '۳. تعهدات معوق و عقب‌افتاده تولید (Backlog)', category: 'فروش', description: 'سفارشات باز و دارای تأخیر نسبت به موعد تحویل و پوشش با موجودی محصول و WIP' },
    { id: 'wip_operation', title: '۴. کار در جریان ساخت به تفکیک قطعه و مرحله (WIP)', category: 'تولید', description: 'ردیابی قطعات در صف برش، پرس ضربه‌ای، پرس هیدرولیک و جوشکاری' },
    { id: 'wip_aging', title: '۵. سن‌یابی و ماندگاری اقلام در خطوط (WIP Aging)', category: 'تولید', description: 'شناسایی پالت‌های راکد و خوابیده بین اوپراسیون‌ها بالای ۴۸ ساعت' },
    { id: 'consumption', title: '۶. مصرف واقعی مواد در عملیات تولید', category: 'مواد', description: 'مصرف ثبت‌شده در کاردکس به تفکیک دستور ساخت و عملیات، همراه با ماشین و اپراتور ثبت‌شده در گزارش تولید' },
    { id: 'sapco_account', title: '۷. حساب و بیلان امانی کلاف‌های ساپکو', category: 'مواد', description: 'کاردکس کیلوگرمی کلاف‌های امانی با تفکیک دریافتی، مصرفی و باقیمانده' },
    { id: 'valuation_qty', title: '۸. تفکیک مقداری موجودی انبارها و قرنطینه', category: 'انبار', description: 'موجودی رسمی فیزیکی، ملکی کارخانه، امانی ساپکو و توقیف کیفی' },
    { id: 'scrap_analysis', title: '۹. ضایعات به تفکیک قطعه و مرحله عملیات', category: 'تولید', description: 'سهم ضایعات سنبه‌ماتریس، اشکالات اپراتوری و نقص ورق ورودی' },
    { id: 'machine_workload', title: '۱۰. لود کاری و ظرفیت آزاد ماشین‌آلات پرس', category: 'ماشین‌آلات', description: 'ساعات تخصیص‌یافته به پرس‌ها، راندمان OEE و گلوگاه‌های سالن پرس' },
    { id: 'delays', title: '۱۱. گزارش تأخیرات تولید و علل انحرافات', category: 'تولید', description: 'علت‌یابی توقفات ناشی از کمبود رول ورق، شکستگی قالب یا قطعی برق' },
    { id: 'movements', title: '۱۲. کاردکس و گردش تحلیلی اسناد انبار', category: 'انبار', description: 'دفتر کل ورود، خروج، انتقال بین‌انباری و اسناد تعدیل و ابطال' },
    { id: 'reconciliation', title: '۱۳. انبارگردانی و موازنه مغایرت فیزیکی', category: 'انبار', description: 'تطبیق موجودی شمارش‌شده با موجودی دفتری و کسری/اضافی انبار' },
    { id: 'coil_inventory', title: '۱۴. موجودی تفکیکی کویل‌ها و رول‌های ورق', category: 'مواد', description: 'وضعیت هر رول (سالم، بازشده، مصرف‌شده) با وزن اولیه، باقیمانده و شماره ذوب' },
    { id: 'lot_consumption', title: '۱۵. ردیابی مصرف رول و لوت پای خطوط پرس', category: 'تولید', description: 'حواله‌های مصرف لوت پای پرس با شماره MO، قطعه تولیدی و پرت کیلوگرمی' },
    { id: 'supplier_matrix', title: '۱۶. ماتریس حساب مواد تأمین‌کننده (گرید × ضخامت)', category: 'مواد', description: 'جدول ماتریسی دریافتی، مصرفی و مانده ورق‌ها به تفکیک گرید و ضخامت' },
    { id: 'oee_module', title: '۱۷. ماژول OEE (اثربخشی کلی تجهیزات و ۶ ضایعه بزرگ)', category: 'ماشین‌آلات', description: 'محاسبه دسترس‌پذیری × کارایی × کیفیت، TEEP، MTBF/MTTR و پارتو ۶ ضایعه بزرگ TPM' },
    { id: 'machine_utilization', title: '۱۸. ماژول گزارش بهره ماشین و کارکرد پرس‌ها', category: 'ماشین‌آلات', description: 'تحلیل ساعات کارکرد مفید، تعویض قالب SMED، توقفات اضطراری و راندمان ضرب در دقیقه (SPM)' },
    { id: 'consumables_forecast', title: '۱۹. ماژول پیش‌بینی مواد مصرفی کارگاه (Consumables)', category: 'مواد', description: 'پیش‌بینی نرخ مصرف سیم جوش، گاز CO2، روغن کشش و قطعات یدکی قالب با نقطه سفارش ROP' },
    { id: 'mrp_forecast', title: '۲۰. پیش‌بینی نیازمندی مواد و موازنه کلاف (MRP)', category: 'مواد', description: 'انفجار چندسطحی BOM، کسری خالص ورق و پیش‌بینی نیازمندی کلاف بر اساس سفارشات ساپکو' },
    { id: 'comprehensive_production', title: '۲۱. گزارش جامع تولید: شاخص‌های بهره‌وری (OEE)، توقفات و انحراف برنامه', category: 'تولید', description: 'نمودار درختی شکست OEE، خط زمان (Timeline) توقفات شیفت و ماتریس انحراف از برنامه (Schedule Adherence)' },
    { id: 'production_workflow', title: '۲۲. مستند فنی و جریان فرآیند تولید (Workflow استاندارد SAP PP)', category: 'تولید', description: 'دیاگرام تعاملی فرآیند دریافت سفارش، انفجار مواد BOM، زمان‌بندی پله‌ای، رهگیری WIP و صدور خودکار رسید انبار' },
    { id: 'tpm_maintenance', title: '۲۳. مدیریت نگهداری و تعمیرات (TPM)، دستورکارها، MTBF و توقفات تجهیزات', category: 'ماشین‌آلات', description: 'کانبان دستورکارهای تعمیرات شکست CM، برنامه‌ریزی سرویس‌های دوره‌ای PM، پارتو علل خرابی و شاخص‌های قابلیت اطمینان MTBF/MTTR (استاندارد Odoo/ERPNext)' },
  ];

  const isStandaloneModule =
    activeReport === 'custom_builder' ||
    activeReport === 'oee_module' ||
    activeReport === 'machine_utilization' ||
    activeReport === 'consumables_forecast' ||
    activeReport === 'mrp_forecast' ||
    activeReport === 'comprehensive_production' ||
    activeReport === 'production_workflow' ||
    activeReport === 'tpm_maintenance';

  const fetchActiveReport = async () => {
    if (isStandaloneModule) return;
    setLoading(true);
    setReportError(null);
    try {
      const queryParams = new URLSearchParams();
      if (filters.startDate) queryParams.append('startDate', filters.startDate);
      if (filters.endDate) queryParams.append('endDate', filters.endDate);
      if (filters.partId) queryParams.append('partId', filters.partId);
      if (filters.customerName) queryParams.append('customerName', filters.customerName);
      if (filters.machineId) queryParams.append('machineId', filters.machineId);
      if (filters.processType) queryParams.append('processType', filters.processType);
      if (filters.status) queryParams.append('status', filters.status);

      let endpoint = '';
      switch (activeReport) {
        case 'plan_vs_actual':
          endpoint = `/api/reports/plan-vs-actual?${queryParams}`;
          break;
        case 'fulfillment':
          endpoint = `/api/reports/customer-order-fulfillment?${queryParams}`;
          break;
        case 'backlog':
          endpoint = `/api/reports/production-backlog?${queryParams}`;
          break;
        case 'wip_operation':
          endpoint = `/api/reports/wip-by-part-operation?${queryParams}`;
          break;
        case 'wip_aging':
          endpoint = `/api/reports/wip-aging?${queryParams}`;
          break;
        case 'consumption':
          endpoint = `/api/reports/material-consumption-actual?${queryParams}`;
          break;
        case 'sapco_account':
          endpoint = `/api/reports/sapco-material-account?${queryParams}`;
          break;
        case 'valuation_qty':
          endpoint = `/api/reports/inventory-valuation-quantities?${queryParams}`;
          break;
        case 'scrap_analysis':
          endpoint = `/api/reports/scrap-by-part-operation?${queryParams}`;
          break;
        case 'machine_workload':
          endpoint = `/api/reports/machine-workload-capacity?${queryParams}`;
          break;
        case 'delays':
          endpoint = `/api/reports/production-delays?${queryParams}`;
          break;
        case 'movements':
          endpoint = `/api/reports/inventory-movements?${queryParams}`;
          break;
        case 'reconciliation':
          endpoint = `/api/reports/inventory-reconciliation?${queryParams}`;
          break;
        case 'coil_inventory':
          endpoint = `/api/reports/coil-inventory?${queryParams}`;
          break;
        case 'lot_consumption':
          endpoint = `/api/reports/lot-consumption?${queryParams}`;
          break;
        case 'supplier_matrix':
          endpoint = `/api/reports/supplier-matrix?${queryParams}`;
          break;
      }

      const res = await fetch(endpoint);
      const data = await res.json();
      if (res.ok && data.success) {
        setReportMeta(data.meta);
        if (activeReport === 'plan_vs_actual') setPlanVsActualData(data.data);
        else if (activeReport === 'fulfillment') setFulfillmentData(data.data);
        else if (activeReport === 'backlog') setBacklogData(data.data);
        else if (activeReport === 'wip_operation') setWipOpData(data.data);
        else if (activeReport === 'wip_aging') setWipAgingData(data.data);
        else if (activeReport === 'consumption') setConsumptionData(data.data);
        else if (activeReport === 'sapco_account') setSapcoAccountData(data.data);
        else if (activeReport === 'valuation_qty') setValuationData(data.data);
        else if (activeReport === 'scrap_analysis') setScrapData(data.data);
        else if (activeReport === 'machine_workload') setMachineData(data.data);
        else if (activeReport === 'delays') {
          setDelaysData(data.data);
          fetch(`/api/reports/production-delays/analytics?${queryParams}`)
            .then(r => r.json())
            .then(d => {
              if (d.success) setDelayAnalytics(d.data);
            })
            .catch(() => {});
        } else if (activeReport === 'movements') setMovementsData(data.data);
        else if (activeReport === 'reconciliation') setReconciliationData(data.data);
        else if (activeReport === 'coil_inventory') setCoilInventoryData(data.data);
        else if (activeReport === 'lot_consumption') setLotConsumptionData(data.data);
        else if (activeReport === 'supplier_matrix') setSupplierMatrixData(data.data);
      } else {
        setReportError(data.error || 'خطا در دریافت داده‌های گزارش از سرور');
      }
    } catch (err) {
      console.error('Failed to fetch report data:', err);
      setReportError('خطا در برقراری ارتباط با سرویس گزارش‌گیری');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchActiveReport();
  }, [activeReport, filters]);

  // Export Table to Excel CSV
  const handleExportCsv = () => {
    const filename = `KPIMS_${activeReport}_${new Date().toISOString().slice(0, 10)}`;

    switch (activeReport) {
      case 'plan_vs_actual': {
        const headers = ['شماره برنامه', 'نسخه', 'کد قطعه', 'نام قطعه', 'تیراژ مصوب', 'تولید واقعی', 'ضایعات', 'درصد تحقق', 'انحراف', 'موعد تحویل'];
        const rows = planVsActualData.map(r => [
          r.planNumber,
          r.planVersion,
          r.partCode,
          r.partName,
          r.plannedQuantity,
          r.actualProducedQuantity,
          r.actualScrapQuantity,
          `${r.achievementRatePercent}%`,
          r.varianceQuantity,
          r.targetDueDate,
        ]);
        exportToCsv(filename, headers, rows);
        break;
      }
      case 'fulfillment': {
        const headers = ['شماره سفارش', 'قرارداد', 'مشتری', 'کد قطعه', 'نام قطعه', 'سفارش داده شده', 'تحویل شده', 'باقیمانده', 'درصد تحقق', 'موعد تحویل', 'تأخیر (روز)'];
        const rows = fulfillmentData.map(r => [
          r.orderNumber,
          r.contractNumber,
          r.customerName,
          r.partCode,
          r.partName,
          r.orderedQuantity,
          r.deliveredQuantity,
          r.remainingQuantity,
          `${r.fulfillmentPercent}%`,
          r.dueDate,
          r.daysOverdue,
        ]);
        exportToCsv(filename, headers, rows);
        break;
      }
      case 'backlog': {
        const headers = ['شماره سفارش', 'مشتری', 'قرارداد', 'کد قطعه', 'نام قطعه', 'تعداد معوق', 'موعد تحویل', 'روزهای تأخیر', 'ورق مورد نیاز (kg)', 'سطح فوریت'];
        const rows = backlogData.map(r => [
          r.orderNumber,
          r.customerName,
          r.contractNumber,
          r.partCode,
          r.partName,
          r.backlogQuantity,
          r.dueDate,
          r.daysOverdue,
          r.requiredRawMaterialKg,
          r.urgencyLevel,
        ]);
        exportToCsv(filename, headers, rows);
        break;
      }
      case 'wip_operation': {
        const headers = ['شماره MO', 'کد قطعه', 'نام قطعه', 'مرحله', 'فرایند', 'موقعیت انبارش', 'در صف ورودی', 'پای دستگاه', 'آماده انتقال', 'منتقل شده', 'کل WIP فعال'];
        const rows = wipOpData.map(r => [
          r.moNumber,
          r.partCode,
          r.partName,
          `OP${r.stepNumber} - ${r.stepName}`,
          r.processType,
          r.warehouseLocation,
          r.waitingInputQty,
          r.inProgressQty,
          r.readyForTransferQty,
          r.transferredQty,
          r.totalActiveWipQty,
        ]);
        exportToCsv(filename, headers, rows);
        break;
      }
      case 'wip_aging': {
        const headers = ['شماره MO', 'کد قطعه', 'نام قطعه', 'مرحله', 'موقعیت', 'موجودی در ایستگاه', 'ساعت توقف', 'روز توقف', 'رده سنی', 'سطح هشدار'];
        const rows = wipAgingData.map(r => [
          r.moNumber,
          r.partCode,
          r.partName,
          r.stepName,
          r.warehouseLocation,
          r.quantityInStation,
          r.idleHours,
          r.idleDays,
          r.ageCategory,
          r.statusSeverity,
        ]);
        exportToCsv(filename, headers, rows);
        break;
      }
      case 'consumption': {
        const headers = ['شماره MO', 'کد محصول', 'نام محصول', 'مرحله عملیات', 'کد ماده', 'نام ماده', 'گرید', 'مصرف واقعی ثبت‌شده (kg)', 'تولید سالم ثبت‌شده', 'ضایعات ثبت‌شده (عدد)', 'وزن ضایعات (kg)', 'ماشین واقعی', 'اپراتور', 'شماره کلاف', 'قرارداد'];
        const rows = consumptionData.map(r => [
          r.moNumber,
          r.productPartCode,
          r.productPartName,
          `${r.operationStep} - ${r.operationName}`,
          r.materialCode,
          r.materialName,
          r.materialGrade,
          r.actualIssuedMaterialKg,
          r.actualProducedGoodQty,
          r.actualScrapQty,
          r.actualScrapWeightKg,
          r.actualMachineNames.join(' | '),
          r.actualOperatorNames.join(' | '),
          r.coilNumbers.join(' | '),
          r.contractNumbers.join(' | '),
        ]);
        exportToCsv(filename, headers, rows);
        break;
      }
      case 'sapco_account': {
        const headers = ['شماره قرارداد', 'عنوان تخصیص', 'گرید فولاد', 'سهمیه مصوب (kg)', 'اول دوره (kg)', 'رسید (kg)', 'مصرف (kg)', 'مانده دفتری (kg)', 'موجودی فیزیکی کارخانه (kg)', 'مغایرت (kg)'];
        const rows = sapcoAccountData.map(r => [
          r.contractNumber,
          r.title,
          r.materialGrade,
          r.allocatedQuotaKg,
          r.openingBalanceKg,
          r.totalReceivedKg,
          r.totalIssuedKg,
          r.closingBookBalanceKg,
          r.physicalStockInPlantKg,
          r.discrepancyKg,
        ]);
        exportToCsv(filename, headers, rows);
        break;
      }
      case 'valuation_qty': {
        const headers = ['طبقه‌بندی', 'کد قلم', 'شرح قلم', 'واحد', 'موجودی فیزیکی', 'ملکی کارخانه', 'امانی ساپکو', 'مسدود کیفی', 'رزرو سفارشات', 'موجودی آزاد قابل تخصیص', 'وزن کل (kg)'];
        const rows = valuationData.map(r => [
          r.category,
          r.partOrMaterialCode,
          r.description,
          r.unit,
          r.physicalQuantity,
          r.companyOwnedQuantity,
          r.sapcoConsignmentQuantity,
          r.qualityBlockedQuantity,
          r.reservedQuantity,
          r.availableFreeQuantity,
          r.totalPhysicalWeightKg,
        ]);
        exportToCsv(filename, headers, rows);
        break;
      }
      case 'scrap_analysis': {
        const headers = ['کد قطعه', 'نام قطعه', 'مرحله', 'فرایند', 'ماشین', 'کل ورودی', 'تعداد ضایعات', 'وزن ضایعات (kg)', 'نرم مجاز %', 'درصد واقعی ضایعات', 'علت شایع نقص'];
        const rows = scrapData.map(r => [
          r.partCode,
          r.partName,
          `OP${r.stepNumber} - ${r.stepName}`,
          r.processType,
          r.machineName || r.machineCode || '-',
          r.totalInputQty,
          r.scrapPieces,
          r.scrapWeightKg,
          `${r.scrapNormPercent}%`,
          `${r.actualScrapPercent}%`,
          r.commonScrapDefectType || '-',
        ]);
        exportToCsv(filename, headers, rows);
        break;
      }
      case 'machine_workload': {
        const headers = ['کد دستگاه', 'نام دستگاه پرس', 'سالن', 'فرایند', 'تناژ (تن)', 'ظرفیت اسمی روزانه (h)', 'ساعت کار برنامه‌ریزی‌شده', 'ظرفیت آزاد (h)', 'درصد بهره‌وری', 'وضعیت دستگاه'];
        const rows = machineData.map(r => [
          r.machineCode,
          r.machineName,
          r.hall,
          r.processType,
          r.tonnage || '-',
          r.nominalDailyCapacityHours,
          r.scheduledWorkloadHours,
          r.availableCapacityHours,
          `${r.utilizationRatePercent}%`,
          r.machineStatus,
        ]);
        exportToCsv(filename, headers, rows);
        break;
      }
      case 'delays': {
        const headers = ['بخش', 'شماره مرجع', 'طرف حساب / ایستگاه', 'کد قطعه', 'نام قطعه', 'تیراژ معوق', 'موعد مصوب', 'تکمیل (تخمینی/واقعی)', 'روزهای تأخیر', 'علت ریشه‌ای تأخیر', 'سطح فوریت', 'ریسک جریمه (ریال)', 'شرح علت'];
        const rows = delaysData.map(r => [
          r.sectionLabelFa,
          r.referenceNumber,
          r.customerOrPlan,
          r.partCode,
          `"${r.partName.replace(/"/g, '""')}"`,
          r.quantity,
          r.plannedDueDate,
          r.estimatedCompletionDate,
          r.delayDays,
          r.primaryDelayCause,
          r.urgencyLevel,
          r.delayPenaltyRiskRials ?? 'ثبت نشده',
          `"${(r.delayDescription || '').replace(/"/g, '""')}"`,
        ]);
        exportToCsv(filename, headers, rows);
        break;
      }
      case 'movements': {
        const headers = ['شناسه تراکنش', 'شماره سند', 'تاریخ تراکنش', 'نوع سند', 'کد قلم', 'نام قلم', 'مقدار', 'واحد', 'مبدأ', 'مقصد', 'مالکیت', 'کاربر ثبت‌کننده'];
        const rows = movementsData.map(r => [
          r.transactionId,
          r.documentNumber,
          r.transactionDate,
          r.documentType,
          r.partCode,
          r.partName,
          r.quantity,
          r.unit,
          r.sourceLocation,
          r.targetLocation,
          r.ownership,
          r.operatorOrUser,
        ]);
        exportToCsv(filename, headers, rows);
        break;
      }
      case 'reconciliation': {
        const headers = ['کد انبار/موقعیت', 'نام انبار', 'کد قطعه', 'نام قطعه', 'موجودی دفتری', 'شمارش فیزیکی', 'مغایرت', 'وضعیت موازنه', 'تاریخ انبارگردانی', 'مسئول ممیزی'];
        const rows = reconciliationData.map(r => [
          r.locationCode,
          r.warehouseName,
          r.partCode,
          r.partName,
          r.bookQuantity,
          r.physicalCountQuantity,
          r.varianceQuantity,
          r.reconciliationStatus,
          r.lastReconciledAt,
          r.reconciledBy,
        ]);
        exportToCsv(filename, headers, rows);
        break;
      }
      case 'coil_inventory': {
        const headers = ['شماره کویل', 'کد ماده', 'گرید', 'ضخامت (mm)', 'عرض (mm)', 'وزن اولیه (kg)', 'مصرف شده (kg)', 'مانده فعلی (kg)', 'مالکیت', 'قرارداد', 'شماره ذوب', 'پکینگ لیست', 'موقعیت', 'وضعیت'];
        const rows = coilInventoryData.map(r => [
          r.coilNumber,
          r.materialCode,
          r.materialGrade,
          r.thicknessMm,
          r.widthMm,
          r.receivedWeightKg,
          r.consumedWeightKg,
          r.remainingWeightKg,
          r.ownership === 'SAPCO_CONSIGNMENT' ? 'امانی ساپکو' : 'ملکی کارخانه',
          r.contractNumber,
          r.heatNumber,
          r.packingNumber,
          r.warehouseLocation,
          r.status,
        ]);
        exportToCsv(filename, headers, rows);
        break;
      }
      case 'lot_consumption': {
        const headers = ['شماره سند حواله', 'تاریخ', 'شماره کویل', 'شماره ذوب', 'گرید ورق', 'ضخامت', 'مصرف (kg)', 'دستگاه مقصد', 'شماره MO', 'کد قطعه', 'نام قطعه', 'قطعات تولیدی', 'ضایعات (kg)', 'درصد ضایعات', 'اپراتور'];
        const rows = lotConsumptionData.map(r => [
          r.issueDocumentNumber,
          r.issueDate,
          r.coilNumber,
          r.heatNumber,
          r.materialGrade,
          r.thicknessMm,
          r.consumedKg,
          r.destinationMachine,
          r.targetMoNumber,
          r.targetPartCode,
          r.targetPartName,
          r.piecesProduced,
          r.scrapKg,
          `${r.scrapPercent}%`,
          r.operatorName,
        ]);
        exportToCsv(filename, headers, rows);
        break;
      }
      case 'supplier_matrix': {
        const headers = ['گرید فولاد', 'ضخامت (mm)', 'اول دوره (kg)', 'رسید ملکی/خرید (kg)', 'رسید امانی ساپکو (kg)', 'جمع مصرف (kg)', 'سایر گردش‌ها (kg)', 'مانده پایانی دوره (kg)', 'تعداد کویل'];
        const rows = supplierMatrixData.map(r => [
          r.grade,
          r.thicknessMm,
          r.openingBalanceKg,
          r.financialReceivedKg,
          r.consignmentReceivedKg,
          r.totalConsumptionKg,
          r.otherMovementKg,
          r.closingBalanceKg,
          r.totalCoilsCount,
        ]);
        exportToCsv(filename, headers, rows);
        break;
      }
    }
  };

  const filterRows = <T extends object>(items: T[]): T[] => {
    const q = tableSearchQuery.trim().toLowerCase();
    if (!q) return items;
    return items.filter(item =>
      Object.values(item as Record<string, unknown>).some(
        val =>
          val !== null &&
          val !== undefined &&
          String(Array.isArray(val) ? val.join(' ') : val)
            .toLowerCase()
            .includes(q)
      )
    );
  };

  const categories = [
    { id: 'ALL', label: `همه گزارش‌ها و ماژول‌ها (${toPersianDigits(reportDefinitions.length)})` },
    { id: 'تولید', label: 'تولید و خطوط پرس' },
    { id: 'مواد', label: 'مواد اولیه، مصرفی و ساپکو' },
    { id: 'انبار', label: 'انبار و کاردکس' },
    { id: 'فروش', label: 'فروش و تعهدات' },
    { id: 'ماشین‌آلات', label: 'ماشین‌آلات، بهره و OEE' },
  ];

  const filteredReports = reportDefinitions.filter(
    r => selectedCategory === 'ALL' || r.category === selectedCategory
  );

  const applyQuickPeriod = (period: 'TODAY' | 'WEEK' | 'MONTH' | '3MONTH' | 'ALL') => {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    if (period === 'ALL') {
      setFilters(prev => ({ ...prev, startDate: undefined, endDate: undefined }));
      return;
    }
    let startStr = todayStr;
    if (period === 'WEEK') {
      const d = new Date(now.getTime() - 7 * 86400000);
      startStr = d.toISOString().slice(0, 10);
    } else if (period === 'MONTH') {
      const d = new Date(now.getTime() - 30 * 86400000);
      startStr = d.toISOString().slice(0, 10);
    } else if (period === '3MONTH') {
      const d = new Date(now.getTime() - 90 * 86400000);
      startStr = d.toISOString().slice(0, 10);
    }
    setFilters(prev => ({ ...prev, startDate: startStr, endDate: todayStr }));
  };

  const currentDef = reportDefinitions.find(r => r.id === activeReport);

  // Memoized Fiori column configurations
  const planVsActualCols = useMemo(() => getPlanVsActualColumns(traceDocument), [traceDocument]);
  const fulfillmentCols = useMemo(() => getFulfillmentColumns(traceDocument), [traceDocument]);
  const backlogCols = useMemo(() => getBacklogColumns(traceDocument), [traceDocument]);
  const wipOpCols = useMemo(() => getWipOperationColumns(traceDocument), [traceDocument]);
  const wipAgingCols = useMemo(() => getWipAgingColumns(traceDocument), [traceDocument]);
  const consumptionCols = useMemo(() => getConsumptionColumns(traceDocument), [traceDocument]);
  const sapcoCols = useMemo(() => getSapcoAccountColumns(traceDocument), [traceDocument]);
  const valuationCols = useMemo(() => getValuationQtyColumns(traceDocument), [traceDocument]);
  const scrapCols = useMemo(() => getScrapAnalysisColumns(traceDocument), [traceDocument]);
  const machineCols = useMemo(() => getMachineWorkloadColumns(), []);
  const delaysCols = useMemo(
    () => getDelaysColumns(traceDocument, setDrillDownItem),
    [traceDocument]
  );
  const movementsCols = useMemo(() => getMovementsColumns(traceDocument), [traceDocument]);
  const reconciliationCols = useMemo(() => getReconciliationColumns(traceDocument), [traceDocument]);
  const coilCols = useMemo(() => getCoilInventoryColumns(traceDocument), [traceDocument]);
  const lotCols = useMemo(() => getLotConsumptionColumns(traceDocument), [traceDocument]);
  const supplierCols = useMemo(() => getSupplierMatrixColumns(), []);

  const filteredDelaysRows = useMemo(() => {
    const sectionFiltered = delaysData.filter(r => {
      if (delaySectionFilter !== 'ALL' && r.section !== delaySectionFilter) return false;
      if (delayCauseFilter !== 'ALL' && r.primaryDelayCause !== delayCauseFilter) return false;
      return true;
    });
    return filterRows(sectionFiltered);
  }, [delaysData, delaySectionFilter, delayCauseFilter, tableSearchQuery]);

  const handleClearTableSearchOrFilters = () => {
    if (tableSearchQuery) {
      setTableSearchQuery('');
    }
    if (delaySectionFilter !== 'ALL') setDelaySectionFilter('ALL');
    if (delayCauseFilter !== 'ALL') setDelayCauseFilter('ALL');
  };

  const renderStandardEmptyState = (customDesc?: string) => {
    const hasSearchOrFilter =
      Boolean(tableSearchQuery.trim()) ||
      (activeReport === 'delays' && (delaySectionFilter !== 'ALL' || delayCauseFilter !== 'ALL'));

    return (
      <EmptyState
        compact
        variant={tableSearchQuery.trim() ? 'SEARCH_NO_MATCH' : hasSearchOrFilter ? 'FILTER_NO_MATCH' : 'NO_DATA'}
        description={customDesc}
        actionLabel={hasSearchOrFilter ? 'پاک‌کردن فیلتر جستجو' : 'بروزرسانی داده‌ها'}
        onAction={hasSearchOrFilter ? handleClearTableSearchOrFilters : fetchActiveReport}
      />
    );
  };

  const tableToolbar = (
    <FioriToolbar
      variant="table"
      title={currentDef?.title}
      count={reportMeta?.totalRecordsCount}
      countLabel="سطر"
      endContent={
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--fiori-text-secondary)]">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-[var(--fiori-text-secondary)] absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={tableSearchQuery}
              onChange={e => setTableSearchQuery(e.target.value)}
              placeholder="فیلتر سریع در سطرهای جدول..."
              className="fiori-input pr-8 pl-2.5 py-1 text-[11px] w-48 sm:w-56"
            />
          </div>
          <FioriObjectStatus tone="positive" variant="dot" label="مقادیر قطعی" />
          <FioriObjectStatus tone="critical" variant="dot" label="مقادیر تخمینی" />
          {reportMeta && (
            <span className="font-mono text-[10px] text-[var(--fiori-text-secondary)] border-r border-[var(--fiori-border-subtle)] pr-2">
              {formatToJalali(reportMeta.generatedAt)}
            </span>
          )}
        </div>
      }
    />
  );

  return (
    <div className="space-y-4" dir="rtl">
      {/* SAP Horizon Module Switcher & Report Center Header */}
      <div className="fiori-surface-card p-4 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex items-start sm:items-center gap-3">
            <div className="w-9 h-9 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-brand-bg)] border border-[var(--fiori-brand-border)] text-[var(--fiori-brand)] flex items-center justify-center shrink-0">
              <FileSpreadsheet className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm lg:text-base font-semibold text-[var(--fiori-text-primary)] tracking-tight">
                مرکز گزارش‌های مدیریتی، بهره‌وری ماشین، پیش‌بینی مواد و OEE
              </h2>
              <p className="text-xs text-[var(--fiori-text-secondary)] mt-0.5">
                {currentDef
                  ? currentDef.description
                  : `${toPersianDigits(reportDefinitions.length)} گزارش و ماژول تحلیلی: تأخیرات تولید، OEE، بهره ماشین، پیش‌بینی مواد مصرفی و MRP`}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 self-end lg:self-auto no-print">
            <InlinePageGuideButton
              routeContext={{ tab: 'reports', reportSubTab: activeReport }}
              label="آموزش این گزارش و سناریوها"
            />
            <button
              type="button"
              onClick={() => window.print()}
              className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>چاپ رسمی</span>
            </button>

            {!isStandaloneModule && (
              <button
                type="button"
                onClick={fetchActiveReport}
                disabled={loading}
                className="sap-btn-emphasized flex items-center gap-1.5 px-3 py-1.5 text-xs disabled:opacity-50 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                <span>بروزرسانی</span>
              </button>
            )}
          </div>
        </div>

        {/* Unified Report & Module Selector Bar */}
        <div className="pt-2.5 border-t border-[var(--fiori-border-subtle)] flex flex-wrap items-center justify-between gap-2 text-xs no-print">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-2 fiori-input px-2.5 py-1 bg-[var(--fiori-bg-subtle)]">
              <Filter className="w-3.5 h-3.5 text-[var(--fiori-brand)] shrink-0" />
              <span className="text-[var(--fiori-text-secondary)] font-medium whitespace-nowrap">
                انتخاب گزارش / ماژول:
              </span>
              <select
                value={activeReport}
                onChange={e => handleSelectReport(e.target.value as ReportTypeKey)}
                className="bg-transparent font-semibold text-[var(--fiori-text-primary)] focus:outline-none cursor-pointer max-w-xs sm:max-w-md truncate"
              >
                {filteredReports.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
            </div>

            <select
              value={selectedCategory}
              onChange={e => {
                const catId = e.target.value;
                setSelectedCategory(catId);
                const firstInCat = reportDefinitions.find(
                  r => catId === 'ALL' || r.category === catId
                );
                if (firstInCat && activeReport !== firstInCat.id) {
                  handleSelectReport(firstInCat.id);
                }
              }}
              className="fiori-input px-2.5 py-1 text-xs font-medium cursor-pointer"
            >
              {categories.map(cat => (
                <option key={cat.id} value={cat.id}>
                  دسته: {cat.label}
                </option>
              ))}
            </select>

            <div className="flex items-center gap-1 overflow-x-auto">
              {[
                { id: 'custom_builder', label: '★ گزارش‌ساز پویا و سفارشی' },
                { id: 'comprehensive_production', label: 'گزارش جامع OEE و توقفات' },
                { id: 'production_workflow', label: 'جریان فرآیند SAP PP' },
                { id: 'oee_module', label: 'داشبورد OEE' },
                { id: 'machine_utilization', label: 'بهره ماشین' },
                { id: 'consumables_forecast', label: 'پیش‌بینی مصرفی' },
                { id: 'mrp_forecast', label: 'پیش‌بینی MRP' },
                { id: 'delays', label: 'تأخیرات تولید' },
              ].map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSelectedCategory('ALL');
                    handleSelectReport(item.id as ReportTypeKey);
                  }}
                  className={`px-2 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer border ${
                    activeReport === item.id
                      ? 'bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border-[var(--fiori-brand)] font-semibold'
                      : 'bg-[var(--fiori-bg-surface)] hover:bg-[var(--fiori-bg-hover)] text-[var(--fiori-text-secondary)] border-[var(--fiori-border-default)]'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {!isStandaloneModule && (
            <div className="flex items-center gap-1">
              {[
                { id: 'TODAY', label: 'امروز' },
                { id: 'WEEK', label: '۷ روز' },
                { id: 'MONTH', label: 'این ماه' },
                { id: 'ALL', label: 'کل دوره' },
              ].map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyQuickPeriod(p.id as 'TODAY' | 'WEEK' | 'MONTH' | 'ALL')}
                  className="px-2 py-1 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] bg-[var(--fiori-bg-subtle)] hover:bg-[var(--fiori-brand-bg)] hover:text-[var(--fiori-brand)] text-[var(--fiori-text-primary)] text-[11px] transition-colors cursor-pointer"
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Standalone Analytical & Forecasting Modules (already Fiori-standardized) */}
      {activeReport === 'custom_builder' && <CustomReportsView />}
      {activeReport === 'comprehensive_production' && <ComprehensiveProductionReportView />}
      {activeReport === 'production_workflow' && <ProductionWorkflowDocumentationView />}
      {activeReport === 'tpm_maintenance' && <PlantMaintenanceModuleView machines={machines} />}
      {activeReport === 'oee_module' && <OeeModuleView machines={machines} />}
      {activeReport === 'machine_utilization' && <MachineUtilizationView machines={machines} />}
      {activeReport === 'consumables_forecast' && <ConsumablesForecastView />}
      {activeReport === 'mrp_forecast' && <MrpModuleView />}

      {/* Filters Bar (for standard tabular reports) */}
      {!isStandaloneModule && (
        <ReportFiltersBar
          parts={parts}
          machines={machines}
          filters={filters}
          onFilterChange={setFilters}
          onExportCsv={handleExportCsv}
          isExporting={loading}
        />
      )}

      {/* Explicit Error Strip when Report Fetch Fails */}
      {!isStandaloneModule && reportError && (
        <FioriMessageStrip
          tone="error"
          title="خطا در دریافت گزارش"
          onClose={() => setReportError(null)}
          actions={
            <button
              type="button"
              onClick={fetchActiveReport}
              className="sap-btn-standard px-2.5 py-1 text-[11px] cursor-pointer"
            >
              تلاش مجدد
            </button>
          }
        >
          {reportError}
        </FioriMessageStrip>
      )}

      {/* Loading Skeleton for Standard Tabular & Delay Reports */}
      {!isStandaloneModule && loading && (
        <div className="space-y-4">
          {activeReport === 'delays' && (
            <>
              <KpiCardsSkeleton count={4} columns={4} theme="light" />
              <ChartSkeleton rows={4} theme="light" />
            </>
          )}
          <TableSkeleton rows={7} columns={8} theme="light" />
        </div>
      )}

      {/* Main Report Container */}
      {!isStandaloneModule && !loading && (
        <div className="space-y-3">
          {/* Consumption disclaimer strip */}
          {activeReport === 'consumption' && (
            <FioriMessageStrip tone="warning" compact>
              این گزارش فقط مقادیر ثبت‌شده در کاردکس و گزارش عملکرد واقعی تولید را نمایش می‌دهد. مقایسه با BOM تا اتصال نسخه تأییدشده BOM به مصرف واقعی غیرفعال است؛ ماشین و اپراتور نیز فقط از گزارش عملکرد ثبت‌شده خوانده می‌شوند.
            </FioriMessageStrip>
          )}

          {/* Production Delays Analytical KPIs & Root-Cause Breakdown */}
          {activeReport === 'delays' && delayAnalytics && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
                <div className="fiori-surface-card p-3 text-right">
                  <span className="text-[11px] text-[var(--fiori-text-secondary)] block">
                    میانگین روزهای تأخیر
                  </span>
                  <div className="text-xl font-bold text-[var(--fiori-negative)] font-mono tabular-nums mt-1">
                    {toPersianDigits(delayAnalytics.averageDelayDays)}{' '}
                    <span className="text-xs font-sans font-normal text-[var(--fiori-text-secondary)]">
                      روز
                    </span>
                  </div>
                  <span className="text-[10px] text-[var(--fiori-text-secondary)] mt-1 block">
                    از سررسید تعهدات
                  </span>
                </div>

                <div className="fiori-surface-card p-3 text-right">
                  <span className="text-[11px] text-[var(--fiori-positive)] block">
                    نرخ تحویل به‌موقع (OTIF)
                  </span>
                  <div className="text-xl font-bold text-[var(--fiori-positive)] font-mono tabular-nums mt-1">
                    {delayAnalytics.onTimeDeliveryRatePercent === null
                      ? 'ثبت نشده'
                      : `${toPersianDigits(delayAnalytics.onTimeDeliveryRatePercent)}٪`}
                  </div>
                  <span className="text-[10px] text-[var(--fiori-text-secondary)] mt-1 block">
                    شاخص کیفی ساپکو
                  </span>
                </div>

                <div className="fiori-surface-card p-3 text-right">
                  <span className="text-[11px] text-[var(--fiori-text-secondary)] block">
                    کل موارد دارای تأخیر
                  </span>
                  <div className="text-xl font-bold text-[var(--fiori-text-primary)] font-mono tabular-nums mt-1">
                    {toPersianDigits(delayAnalytics.totalDelayedItemsCount)}
                  </div>
                  <span className="text-[10px] text-[var(--fiori-text-secondary)] mt-1 block">
                    سفارش، MO و عملیات
                  </span>
                </div>

                <div className="fiori-surface-card p-3 text-right">
                  <span className="text-[11px] text-[var(--fiori-negative)] block">
                    بیشترین روز تأخیر
                  </span>
                  <div className="text-xl font-bold text-[var(--fiori-negative)] font-mono tabular-nums mt-1">
                    {toPersianDigits(delayAnalytics.maxDelayDays)}{' '}
                    <span className="text-xs font-sans font-normal text-[var(--fiori-text-secondary)]">
                      روز
                    </span>
                  </div>
                  <span className="text-[10px] text-[var(--fiori-negative)] mt-1 block">
                    اقلام با دیرکرد بالا
                  </span>
                </div>

                <div className="fiori-surface-card p-3 text-right">
                  <span className="text-[11px] text-[var(--fiori-critical)] block">
                    فوریت بحرانی
                  </span>
                  <div className="text-xl font-bold text-[var(--fiori-critical)] font-mono tabular-nums mt-1">
                    {toPersianDigits(delayAnalytics.criticalUrgencyCount)}{' '}
                    <span className="text-xs font-sans font-normal text-[var(--fiori-text-secondary)]">
                      مورد
                    </span>
                  </div>
                  <span className="text-[10px] text-[var(--fiori-text-secondary)] mt-1 block">
                    ریسک توقف خط مشتری
                  </span>
                </div>

                <div className="fiori-surface-card p-3 text-right">
                  <span className="text-[11px] text-[var(--fiori-text-secondary)] block">
                    برآورد ریسک جریمه ساپکو
                  </span>
                  <div className="text-lg font-bold text-[var(--fiori-negative)] font-mono tabular-nums mt-1">
                    {delayAnalytics.estimatedPenaltyRiskRials === null
                      ? 'ثبت نشده'
                      : formatNumber(
                          Math.round(Number(delayAnalytics.estimatedPenaltyRiskRials) / 1000000)
                        )}{' '}
                    <span className="text-[11px] font-sans font-normal text-[var(--fiori-text-secondary)]">
                      م.ریال
                    </span>
                  </div>
                  <span className="text-[10px] text-[var(--fiori-negative)] mt-1 block">
                    جریمه تأخیر قرارداد
                  </span>
                </div>
              </div>

              <div className="fiori-surface-card p-3.5 space-y-2.5">
                <FioriToolbar
                  variant="section"
                  title="تفکیک سهم علل ریشه‌ای تأخیرات (Root Cause Breakdown) — روی هر علت جهت فیلتر جدول کلیک کنید"
                  endContent={
                    delayCauseFilter !== 'ALL' ? (
                      <button
                        type="button"
                        onClick={() => setDelayCauseFilter('ALL')}
                        className="text-[11px] text-[var(--fiori-brand)] hover:underline cursor-pointer"
                      >
                        حذف فیلتر علت
                      </button>
                    ) : undefined
                  }
                />

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
                  {delayAnalytics.causesBreakdown.map(cause => {
                    const isSelected = delayCauseFilter === cause.causeKey;
                    return (
                      <button
                        type="button"
                        key={cause.causeKey}
                        onClick={() => setDelayCauseFilter(isSelected ? 'ALL' : cause.causeKey)}
                        className={`p-2.5 rounded-[var(--fiori-radius-sm)] border text-right transition cursor-pointer flex flex-col justify-between ${
                          isSelected
                            ? 'bg-[var(--fiori-brand-bg)] border-[var(--fiori-brand)]'
                            : 'bg-[var(--fiori-bg-surface)] border-[var(--fiori-border-default)] hover:bg-[var(--fiori-bg-hover)]'
                        }`}
                      >
                        <div className="flex items-center justify-between w-full">
                          <span className="text-[11px] font-semibold text-[var(--fiori-text-primary)]">
                            {cause.causeLabelFa}
                          </span>
                          <span className="text-xs font-mono font-bold tabular-nums text-[var(--fiori-negative)]">
                            {toPersianDigits(cause.percentage)}٪
                          </span>
                        </div>
                        <div className="mt-2 flex items-center justify-between text-[10px] text-[var(--fiori-text-secondary)] font-mono tabular-nums">
                          <span>{toPersianDigits(cause.itemsCount)} ردیف</span>
                          <span>{formatNumber(cause.totalDelayedPieces)} عدد</span>
                        </div>
                        <div className="w-full bg-[var(--fiori-border-subtle)] h-1 rounded-sm mt-1.5 overflow-hidden">
                          <div
                            className="bg-[var(--fiori-brand)] h-full transition-all"
                            style={{ width: `${cause.percentage}%` }}
                          />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs">
                <span className="text-[var(--fiori-text-secondary)] ml-1 text-[11px]">
                  فیلتر بخش:
                </span>
                {[
                  { id: 'ALL', label: 'همه بخش‌ها' },
                  { id: 'CUSTOMER_ORDER', label: 'ردیف سفارشات باز معوق' },
                  { id: 'OPEN_MO', label: 'دستور کارهای باز عقب‌افتاده' },
                  { id: 'COMPLETED_LATE_MO', label: 'تکمیل‌شده با تأخیر (سوابق)' },
                  { id: 'LATE_OPERATION', label: 'عملیات و ایستگاه‌های اجرایی' },
                ].map(sec => (
                  <button
                    type="button"
                    key={sec.id}
                    onClick={() => setDelaySectionFilter(sec.id as 'ALL' | ProductionDelaySection)}
                    className={`px-3 py-1 rounded-[var(--fiori-radius-sm)] font-medium transition cursor-pointer border whitespace-nowrap ${
                      delaySectionFilter === sec.id
                        ? 'bg-[var(--fiori-brand)] text-white border-[var(--fiori-brand)] font-semibold'
                        : 'bg-[var(--fiori-bg-surface)] text-[var(--fiori-text-primary)] hover:bg-[var(--fiori-bg-hover)] border-[var(--fiori-border-default)]'
                    }`}
                  >
                    {sec.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Unified FioriDataTable for All 16 Standard Reports */}
          {activeReport === 'plan_vs_actual' && (
            <FioriDataTable
              toolbar={tableToolbar}
              columns={planVsActualCols}
              data={filterRows(planVsActualData)}
              rowKey={r => r.planId}
              onRowClick={r => setDrillDownItem(buildPlanVsActualDrillDown(r))}
              emptyState={renderStandardEmptyState()}
            />
          )}

          {activeReport === 'fulfillment' && (
            <FioriDataTable
              toolbar={tableToolbar}
              columns={fulfillmentCols}
              data={filterRows(fulfillmentData)}
              rowKey={r => r.orderLineId}
              emptyState={renderStandardEmptyState()}
            />
          )}

          {activeReport === 'backlog' && (
            <FioriDataTable
              toolbar={tableToolbar}
              columns={backlogCols}
              data={filterRows(backlogData)}
              rowKey={(r, i) => `${r.orderNumber}-${r.partCode}-${i}`}
              emptyState={renderStandardEmptyState()}
            />
          )}

          {activeReport === 'wip_operation' && (
            <FioriDataTable
              toolbar={tableToolbar}
              columns={wipOpCols}
              data={filterRows(wipOpData)}
              rowKey={(r, i) => `${r.moId}-${r.stepNumber}-${i}`}
              emptyState={renderStandardEmptyState()}
            />
          )}

          {activeReport === 'wip_aging' && (
            <FioriDataTable
              toolbar={tableToolbar}
              columns={wipAgingCols}
              data={filterRows(wipAgingData)}
              rowKey={(r, i) => `${r.moNumber}-${r.stepNumber}-${i}`}
              emptyState={renderStandardEmptyState()}
            />
          )}

          {activeReport === 'consumption' && (
            <FioriDataTable
              toolbar={tableToolbar}
              columns={consumptionCols}
              data={filterRows(consumptionData)}
              rowKey={(r, i) => `${r.moId}-${r.operationId}-${r.materialCode}-${i}`}
              emptyState={renderStandardEmptyState(
                consumptionData.length === 0
                  ? 'برای فیلترهای انتخاب‌شده، حواله مصرف قطعی متصل به دستور ساخت و عملیات تولید یافت نشد.'
                  : undefined
              )}
            />
          )}

          {activeReport === 'sapco_account' && (
            <FioriDataTable
              toolbar={tableToolbar}
              columns={sapcoCols}
              data={filterRows(sapcoAccountData)}
              rowKey={r => r.contractId}
              emptyState={renderStandardEmptyState()}
            />
          )}

          {activeReport === 'valuation_qty' && (
            <FioriDataTable
              toolbar={tableToolbar}
              columns={valuationCols}
              data={filterRows(valuationData)}
              rowKey={(r, i) => `${r.partOrMaterialCode}-${r.category}-${i}`}
              emptyState={renderStandardEmptyState()}
            />
          )}

          {activeReport === 'scrap_analysis' && (
            <FioriDataTable
              toolbar={tableToolbar}
              columns={scrapCols}
              data={filterRows(scrapData)}
              rowKey={(r, i) => `${r.partCode}-${r.stepNumber}-${i}`}
              emptyState={renderStandardEmptyState()}
            />
          )}

          {activeReport === 'machine_workload' && (
            <FioriDataTable
              toolbar={tableToolbar}
              columns={machineCols}
              data={filterRows(machineData)}
              rowKey={r => r.machineId}
              emptyState={renderStandardEmptyState()}
            />
          )}

          {activeReport === 'delays' && (
            <FioriDataTable
              toolbar={tableToolbar}
              columns={delaysCols}
              data={filteredDelaysRows}
              rowKey={(r, i) => `${r.referenceNumber}-${r.section}-${i}`}
              emptyState={renderStandardEmptyState()}
            />
          )}

          {activeReport === 'movements' && (
            <FioriDataTable
              toolbar={tableToolbar}
              columns={movementsCols}
              data={filterRows(movementsData)}
              rowKey={r => r.transactionId}
              emptyState={renderStandardEmptyState()}
            />
          )}

          {activeReport === 'reconciliation' && (
            <FioriDataTable
              toolbar={tableToolbar}
              columns={reconciliationCols}
              data={filterRows(reconciliationData)}
              rowKey={(r, i) => `${r.locationCode}-${r.partCode}-${i}`}
              emptyState={renderStandardEmptyState()}
            />
          )}

          {activeReport === 'coil_inventory' && (
            <FioriDataTable
              toolbar={tableToolbar}
              columns={coilCols}
              data={filterRows(coilInventoryData)}
              rowKey={r => r.coilId}
              emptyState={renderStandardEmptyState()}
            />
          )}

          {activeReport === 'lot_consumption' && (
            <FioriDataTable
              toolbar={tableToolbar}
              columns={lotCols}
              data={filterRows(lotConsumptionData)}
              rowKey={(r, i) => `${r.issueDocumentNumber}-${r.coilNumber}-${i}`}
              emptyState={renderStandardEmptyState()}
            />
          )}

          {activeReport === 'supplier_matrix' && (
            <FioriDataTable
              toolbar={tableToolbar}
              columns={supplierCols}
              data={filterRows(supplierMatrixData)}
              rowKey={(r, i) => `${r.grade}-${r.thicknessMm}-${i}`}
              emptyState={renderStandardEmptyState()}
            />
          )}
        </div>
      )}

      {/* Drill-down modal */}
      <DrillDownModal
        isOpen={Boolean(drillDownItem)}
        onClose={() => setDrillDownItem(null)}
        data={drillDownItem}
      />
    </div>
  );
};
