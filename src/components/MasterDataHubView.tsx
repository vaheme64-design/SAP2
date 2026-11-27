import React, { useState, useEffect } from 'react';
import {
  Boxes,
  Disc,
  ListTree,
  GitBranch,
  Settings2,
  Warehouse,
  Ruler,
  Clock,
  Users,
  Wrench,
  RefreshCw,
  Plus,
  Edit3,
  ArrowLeft,
  ArrowRight,
  LayoutGrid,
  Table2,
  Search,
  CheckCircle2,
  X,
  Trash2,
  Building2,
  MapPin,
  Phone,
  Mail,
  Check,
  GitFork,
  Car,
  FolderTree,
  Copy,
  Cpu,
  Sparkles,
} from 'lucide-react';
import {
  Part,
  Machine,
  Routing,
  DieMold,
  Operator,
  FactoryHall,
  SapcoCoilReceipt,
  WarehouseDefinition,
  UnitDefinition,
  CustomerDefinition,
  ShiftDefinition,
  CarModel,
  OperationDefinition,
} from '../types/inventory';
import { ErpColorTheme, ErpLayoutTemplate } from '../types/theme';
import { PartsView } from './PartsView';
import { RoutingsView } from './RoutingsView';
import { MachinesView } from './MachinesView';
import { AdvancedBomModuleView } from './bom/AdvancedBomModuleView';
import { ProductStructureView } from './bom/ProductStructureView';
import { ParallelProductionFlowView } from './wip/ParallelProductionFlowView';
import { TraceabilityTagModal } from './wip/TraceabilityTagModal';
import { toPersianDigits } from '../utils/formatters';
import { MasterDataSkeleton } from './ui/Skeleton';
import { useEnterpriseUx } from '../context/EnterpriseUxContext';
import { useErpRouter } from '../context/RouterContext';
import { FioriDialog, FioriMessageStrip, FioriObjectStatus, FioriToolbar } from './fiori/ui';
import { EmptyState } from './common/EmptyState';
import {
  MaterialGradeCategory,
  MaterialGradeItem,
  MATERIAL_GRADE_CATEGORIES,
  deleteMaterialGrade,
  loadMaterialGrades,
  resetMaterialGrades,
  upsertMaterialGrade,
} from '../utils/materialGradesStorage';

export type MasterSubSection =
  | 'HUB'
  | 'PARTS'
  | 'RAW_MATERIALS'
  | 'BOM'
  | 'PRODUCT_STRUCTURE'
  | 'PARALLEL_FLOWS'
  | 'ROUTINGS'
  | 'OPERATIONS'
  | 'FACTORY_HALLS'
  | 'WAREHOUSES'
  | 'UNITS'
  | 'SHIFTS'
  | 'CUSTOMERS'
  | 'MACHINES'
  | 'DIES'
  | 'CAR_MODELS'
  | 'ORDERS';

interface RawSheetSpec {
  id: string;
  code: string;
  name: string;
  grade: string;
  supplyForm?: 'COIL' | 'SHEET' | 'STRIP' | 'OTHER';
  thicknessMm: number;
  widthMm?: number;
  lengthMm?: number;
  dimensionsMm: string;
  densityGCm3?: number;
  sheetWeightKg: number;
  unit: string;
  ownership?: 'SAPCO_CONSIGNMENT' | 'LOCAL_PURCHASE' | 'IMPORTED';
  supplierName?: string;
  standard?: string;
  minStock?: number;
  description?: string;
  contractsCount: number;
  active: boolean;
}

const INITIAL_RAW_SHEETS: RawSheetSpec[] = [
  {
    id: 'RM-1',
    code: 'SHT-ST12-0.7',
    name: 'ورق سرد ST12 ضخامت ۰/۷',
    grade: 'ST12',
    thicknessMm: 0.7,
    dimensionsMm: '۱,۰۰۰ × ۲,۰۰۰',
    sheetWeightKg: 11.0,
    unit: 'کیلوگرم',
    contractsCount: 0,
    active: true,
  },
  {
    id: 'RM-2',
    code: 'SHT-ST12-0.8',
    name: 'ورق سرد ST12 ضخامت ۰/۸',
    grade: 'ST12',
    thicknessMm: 0.8,
    dimensionsMm: '۱,۰۰۰ × ۲,۰۰۰',
    sheetWeightKg: 12.6,
    unit: 'کیلوگرم',
    contractsCount: 1,
    active: true,
  },
  {
    id: 'RM-3',
    code: 'SHT-ST12-1.0',
    name: 'ورق سرد ST12 ضخامت ۱/۰',
    grade: 'ST12',
    thicknessMm: 1.0,
    dimensionsMm: '۱,۲۵۰ × ۲,۵۰۰',
    sheetWeightKg: 24.5,
    unit: 'کیلوگرم',
    contractsCount: 1,
    active: true,
  },
  {
    id: 'RM-4',
    code: 'SHT-ST12-1.2',
    name: 'ورق سرد ST12 ضخامت ۱/۲',
    grade: 'ST12',
    thicknessMm: 1.2,
    dimensionsMm: '۱,۲۵۰ × ۲,۵۰۰',
    sheetWeightKg: 29.4,
    unit: 'کیلوگرم',
    contractsCount: 1,
    active: true,
  },
  {
    id: 'RM-5',
    code: 'SHT-ST12-1.5',
    name: 'ورق سرد ST12 ضخامت ۱/۵',
    grade: 'ST12',
    thicknessMm: 1.5,
    dimensionsMm: '۱,۲۵۰ × ۲,۵۰۰',
    sheetWeightKg: 36.8,
    unit: 'کیلوگرم',
    contractsCount: 0,
    active: true,
  },
  {
    id: 'RM-6',
    code: 'SHT-ST12-2.0',
    name: 'ورق سرد ST12 ضخامت ۲/۰',
    grade: 'ST12',
    thicknessMm: 2.0,
    dimensionsMm: '۱,۲۵۰ × ۲,۵۰۰',
    sheetWeightKg: 49.0,
    unit: 'کیلوگرم',
    contractsCount: 0,
    active: true,
  },
  {
    id: 'RM-7',
    code: 'SHT-ST13-1.5',
    name: 'ورق سرد ST13 ضخامت ۱/۵ (کشش)',
    grade: 'ST13',
    thicknessMm: 1.5,
    dimensionsMm: '۱,۲۵۰ × ۲,۵۰۰',
    sheetWeightKg: 36.8,
    unit: 'کیلوگرم',
    contractsCount: 1,
    active: true,
  },
  {
    id: 'RM-8',
    code: 'SHT-ST14-0.8',
    name: 'ورق فوق کشش ST14 ضخامت ۰/۸',
    grade: 'ST14',
    thicknessMm: 0.8,
    dimensionsMm: '۱,۲۵۰ × ۲,۵۰۰',
    sheetWeightKg: 19.6,
    unit: 'کیلوگرم',
    contractsCount: 2,
    active: true,
  },
];

interface MasterDataHubViewProps {
  layoutTemplate: ErpLayoutTemplate;
  colorTheme: ErpColorTheme;
  parts: Part[];
  routings: Routing[];
  machines: Machine[];
  dies: DieMold[];
  operators: Operator[];
  halls: FactoryHall[];
  coils: SapcoCoilReceipt[];
  initialSection?: MasterSubSection;
  onSectionChange?: (sec: MasterSubSection) => void;
  onSavePart: (part: Partial<Part>) => Promise<{ success: boolean; message?: string; error?: string }>;
  onSaveRouting: (routing: Partial<Routing>) => Promise<{ success: boolean; message?: string; error?: string }>;
  onDeleteRouting: (id: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  onSaveMachine: (mch: Partial<Machine>) => Promise<{ success: boolean; message?: string; error?: string }>;
  onSaveDie: (die: Partial<DieMold>) => Promise<{ success: boolean; message?: string; error?: string }>;
  onDeleteDie: (id: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  onSaveOperator: (op: Partial<Operator>) => Promise<{ success: boolean; message?: string; error?: string }>;
  onSaveHall: (hall: Partial<FactoryHall>) => Promise<{ success: boolean; message?: string; error?: string }>;
  onDeleteHall?: (id: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  onDirectProduce: (partId: string) => void;
  onRefresh: () => Promise<void>;
  onNavigateToInventoryCoils?: () => void;
  onNavigateToPlanning?: () => void;
}

export const MasterDataHubView: React.FC<MasterDataHubViewProps> = ({
  layoutTemplate,
  colorTheme,
  initialSection,
  onSectionChange,
  parts,
  routings,
  machines,
  dies,
  operators,
  halls,
  coils,
  onSavePart,
  onSaveRouting,
  onDeleteRouting,
  onSaveMachine,
  onSaveDie,
  onDeleteDie,
  onSaveOperator,
  onSaveHall,
  onDeleteHall,
  onDirectProduce,
  onRefresh,
  onNavigateToInventoryCoils,
  onNavigateToPlanning,
}) => {
  // View mode: 'CARDS_HUB' (Image 1 / ERPNext) vs 'SEGMENTED_TABS' (Image 2)
  const [viewMode, setViewMode] = useState<'CARDS_HUB' | 'SEGMENTED_TABS'>(
    layoutTemplate === 'HUB_WORKSPACE' || layoutTemplate === 'ODOO_ENTERPRISE'
      ? 'CARDS_HUB'
      : 'SEGMENTED_TABS'
  );

  const [activeSection, setActiveSection] = useState<MasterSubSection>(
    initialSection || (layoutTemplate === 'TABBED_WORKBENCH' ? 'RAW_MATERIALS' : 'HUB')
  );

  // Sync section when initialSection prop changes from external navigation or URL
  useEffect(() => {
    if (initialSection) {
      setActiveSection(initialSection);
      if (initialSection !== 'HUB') {
        setViewMode('SEGMENTED_TABS');
      }
    }
  }, [initialSection]);

  const handleSelectSection = (sec: MasterSubSection) => {
    setActiveSection(sec);
    setViewMode(sec === 'HUB' ? 'CARDS_HUB' : 'SEGMENTED_TABS');
    if (onSectionChange) onSectionChange(sec);
  };

  // Sync automatically when user switches global template
  useEffect(() => {
    if (layoutTemplate === 'HUB_WORKSPACE') {
      setViewMode('CARDS_HUB');
      setActiveSection('HUB');
    } else if (layoutTemplate === 'TABBED_WORKBENCH') {
      setViewMode('SEGMENTED_TABS');
      setActiveSection(prev => (prev === 'HUB' ? 'RAW_MATERIALS' : prev));
    }
  }, [layoutTemplate]);

  useEffect(() => {
    const handleContextual = (e: Event) => {
      const custom = e as CustomEvent<{ actionType?: string }>;
      if (custom.detail?.actionType === 'OPEN_ADD_PART') {
        setActiveSection('PARTS');
      } else if (custom.detail?.actionType === 'OPEN_ADD_ROUTING') {
        setActiveSection('ROUTINGS');
      }
    };
    window.addEventListener('kpims:contextual-action', handleContextual);
    return () => window.removeEventListener('kpims:contextual-action', handleContextual);
  }, []);

  const { requestConfirm } = useEnterpriseUx();
  const { traceDocument } = useErpRouter();
  const [masterBanner, setMasterBanner] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const notifyMaster = (type: 'success' | 'error', message: string) => {
    setMasterBanner({ type, message });
    setTimeout(() => setMasterBanner(null), 5000);
  };

  const [materialGrades, setMaterialGrades] = useState<MaterialGradeItem[]>(() => loadMaterialGrades());
  const [isGradeManagerOpen, setIsGradeManagerOpen] = useState(false);
  const [editingGradeId, setEditingGradeId] = useState<string | null>(null);
  const [gradeFormCode, setGradeFormCode] = useState('');
  const [gradeFormName, setGradeFormName] = useState('');
  const [gradeFormCategory, setGradeFormCategory] = useState<MaterialGradeCategory>('COLD_ROLLED');
  const [gradeFormStandard, setGradeFormStandard] = useState('');
  const [gradeFormDensity, setGradeFormDensity] = useState('7.85');
  const [gradeFormNotes, setGradeFormNotes] = useState('');

  // Inline quick-add grade inside Raw Material modal
  const [showInlineAddGrade, setShowInlineAddGrade] = useState(false);
  const [inlineGradeCode, setInlineGradeCode] = useState('');
  const [inlineGradeName, setInlineGradeName] = useState('');
  const [inlineGradeCategory, setInlineGradeCategory] = useState<MaterialGradeCategory>('COLD_ROLLED');
  const [inlineGradeDensity, setInlineGradeDensity] = useState('7.85');

  useEffect(() => {
    const onGradesUpdated = () => setMaterialGrades(loadMaterialGrades());
    window.addEventListener('kpims-material-grades-updated', onGradesUpdated);
    return () => window.removeEventListener('kpims-material-grades-updated', onGradesUpdated);
  }, []);

  const [rawSheets, setRawSheets] = useState<RawSheetSpec[]>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('kpims_raw_sheets_v1');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const seenCodes = new Set<string>();
            const deduped: RawSheetSpec[] = [];
            for (const item of parsed) {
              const key = String(item?.code || '').trim().toUpperCase();
              if (!key || !seenCodes.has(key)) {
                if (key) seenCodes.add(key);
                deduped.push(item);
              }
            }
            return deduped;
          }
        }
      } catch {
        // fallback to defaults
      }
    }
    return INITIAL_RAW_SHEETS;
  });

  useEffect(() => {
    try {
      localStorage.setItem('kpims_raw_sheets_v1', JSON.stringify(rawSheets));
    } catch {
      // ignore storage quota errors
    }
  }, [rawSheets]);

  useEffect(() => {
    const rawParts = parts.filter(p => p.category === 'RAW_MATERIAL');
    if (rawParts.length === 0) return;
    setRawSheets(prev => {
      const existingCodes = new Set(prev.map(s => String(s.code || '').trim().toUpperCase()));
      const syncedFromCatalog: RawSheetSpec[] = rawParts
        .filter(p => !existingCodes.has(String(p.code || '').trim().toUpperCase()))
        .map(p => ({
          id: `RM-PART-${p.id}`,
          code: p.code,
          name: p.name,
          grade: p.materialGrade || 'DC01A',
          supplyForm: 'COIL',
          thicknessMm: p.thicknessMm || 2.0,
          widthMm: 1250,
          lengthMm: 2500,
          dimensionsMm: 'کويل / شیت استاندارد',
          densityGCm3: 7.85,
          sheetWeightKg: p.weightPerUnitKg || 1,
          unit: p.unit === 'KG' ? 'کیلوگرم' : 'عدد',
          ownership: 'SAPCO_CONSIGNMENT',
          minStock: p.minStock || 0,
          description: p.description || '',
          contractsCount: 1,
          active: true,
        }));
      return syncedFromCatalog.length > 0 ? [...syncedFromCatalog, ...prev] : prev;
    });
  }, [parts]);

  const [sheetSearch, setSheetSearch] = useState('');
  const [editingSheet, setEditingSheet] = useState<RawSheetSpec | null>(null);
  const [isNewSheetModalOpen, setIsNewSheetModalOpen] = useState(false);
  const [isSavingSheet, setIsSavingSheet] = useState(false);
  const [sheetForm, setSheetForm] = useState<Partial<RawSheetSpec>>({
    code: '',
    name: '',
    grade: 'ST12',
    supplyForm: 'SHEET',
    thicknessMm: 1.0,
    widthMm: 1250,
    lengthMm: 2500,
    dimensionsMm: '۱,۲۵۰ × ۲,۵۰۰',
    densityGCm3: 7.85,
    sheetWeightKg: 24.5,
    unit: 'کیلوگرم',
    ownership: 'SAPCO_CONSIGNMENT',
    supplierName: 'فولاد مبارکه اصفهان',
    standard: 'DIN 1623 / EN 10130',
    minStock: 2000,
    description: '',
    contractsCount: 1,
    active: true,
  });

  // Dynamic Master Data CRUD States
  const [warehousesList, setWarehousesList] = useState<WarehouseDefinition[]>([]);
  const [unitsList, setUnitsList] = useState<UnitDefinition[]>([]);
  const [customersList, setCustomersList] = useState<CustomerDefinition[]>([]);
  const [shiftsList, setShiftsList] = useState<ShiftDefinition[]>([]);
  const [carModelsList, setCarModelsList] = useState<CarModel[]>([]);

  // Sub-modals for Master Data CRUD
  const [isWarehouseModalOpen, setIsWarehouseModalOpen] = useState(false);
  const [editingWarehouse, setEditingWarehouse] = useState<WarehouseDefinition | null>(null);
  const [warehouseForm, setWarehouseForm] = useState<Partial<WarehouseDefinition>>({
    code: '',
    name: '',
    type: 'RAW_MATERIALS',
    managerName: '',
    locations: ['LOC-RAW-01'],
  });

  const [isUnitModalOpen, setIsUnitModalOpen] = useState(false);
  const [editingUnit, setEditingUnit] = useState<UnitDefinition | null>(null);
  const [unitForm, setUnitForm] = useState<Partial<UnitDefinition>>({
    symbol: '',
    title: '',
    description: '',
    conversionFactorToKg: 1,
    isBaseUnit: false,
  });

  const [isCustomerModalOpen, setIsCustomerModalOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<CustomerDefinition | null>(null);
  const [customerForm, setCustomerForm] = useState<Partial<CustomerDefinition>>({
    code: '',
    name: '',
    contractType: 'تامین قطعات پرسی بدنه',
    phone: '',
    email: '',
    address: '',
    isDefault: false,
  });

  const [isShiftModalOpen, setIsShiftModalOpen] = useState(false);
  const [editingShift, setEditingShift] = useState<ShiftDefinition | null>(null);
  const [shiftForm, setShiftForm] = useState<Partial<ShiftDefinition>>({
    code: '',
    name: '',
    startTime: '07:00',
    endTime: '14:30',
    netWorkMinutes: 450,
    status: 'ACTIVE',
    hasOvertime: true,
    overtimeStartTime: '15:00',
    overtimeEndTime: '17:00',
    overtimeMinutes: 120,
    overtimeDaysDescription: 'شنبه تا چهارشنبه',
    thursdayStatus: 'OVERTIME_15_17',
  });

  const [isCarModelModalOpen, setIsCarModelModalOpen] = useState(false);
  const [editingCarModel, setEditingCarModel] = useState<CarModel | null>(null);
  const [carModelForm, setCarModelForm] = useState<Partial<CarModel>>({
    code: '',
    name: '',
    oem: 'ساپکو (ایران‌خودرو)',
    description: '',
    active: true,
  });

  // Factory Halls (سالن‌های تولید و استقرار) CRUD States
  const [hallsList, setHallsList] = useState<FactoryHall[]>(halls || []);
  const [hallSearch, setHallSearch] = useState('');
  const [isHallModalOpen, setIsHallModalOpen] = useState(false);
  const [editingHall, setEditingHall] = useState<FactoryHall | null>(null);
  const [hallForm, setHallForm] = useState<Partial<FactoryHall>>({
    code: '',
    name: '',
    type: 'STAMPING',
    supervisorName: '',
    capacityDesc: '',
    description: '',
    active: true,
  });

  // Dynamic Process Categories (دسته‌های فرآیندی پویا)
  const [processCategories, setProcessCategories] = useState<Array<{ code: string; name: string; category?: string }>>([
    { code: 'SHEARING', name: 'برشکاری و نواربری (Shearing)' },
    { code: 'STAMPING', name: 'پرسکاری و کشش (Stamping / Drawing)' },
    { code: 'BENDING', name: 'خم‌کاری و لبه‌زنی (Bending / Flanging)' },
    { code: 'WELDING', name: 'جوش مقاومتی و CO2 (Welding)' },
    { code: 'SURFACE_FINISH', name: 'رنگ و پوشش کاتافورز (ED Paint)' },
    { code: 'QC_PACK', name: 'کنترل کیفی و بسته‌بندی (QC & Pack)' },
    { code: 'ASSEMBLY', name: 'مونتاژ و هِمینگ مجموعه‌ها (Assembly)' },
  ]);
  const [isProcessCategoryModalOpen, setIsProcessCategoryModalOpen] = useState(false);
  const [newCategoryCode, setNewCategoryCode] = useState('');
  const [newCategoryName, setNewCategoryName] = useState('');
  const [isWorkstationHelpOpen, setIsWorkstationHelpOpen] = useState(false);

  // Operations CRUD States
  const [operationsList, setOperationsList] = useState<OperationDefinition[]>([]);
  const [operationSearch, setOperationSearch] = useState('');
  const [operationCategoryFilter, setOperationCategoryFilter] = useState<string>('ALL');
  const [isOperationModalOpen, setIsOperationModalOpen] = useState(false);
  const [editingOperation, setEditingOperation] = useState<OperationDefinition | null>(null);
  const [operationForm, setOperationForm] = useState<Partial<OperationDefinition>>({
    code: '',
    name: '',
    stationType: '',
    cycleTimeSec: 4.5,
    setupTimeMin: 20,
    category: 'STAMPING',
    description: '',
    active: true,
  });

  // Sync hallsList with props if updated
  useEffect(() => {
    if (halls && halls.length > 0) {
      setHallsList(halls);
    }
  }, [halls]);

  const loadDynamicMasterData = async () => {
    try {
      const [wRes, uRes, cRes, sRes, cmRes, opRes, procRes, hallRes] = await Promise.all([
        fetch('/api/warehouses').then(r => r.json()).catch(() => ({ success: false })),
        fetch('/api/units').then(r => r.json()).catch(() => ({ success: false })),
        fetch('/api/customers').then(r => r.json()).catch(() => ({ success: false })),
        fetch('/api/shifts').then(r => r.json()).catch(() => ({ success: false })),
        fetch('/api/car-models').then(r => r.json()).catch(() => ({ success: false })),
        fetch('/api/operations').then(r => r.json()).catch(() => ({ success: false })),
        fetch('/api/processes').then(r => r.json()).catch(() => ({ success: false })),
        fetch('/api/halls').then(r => r.json()).catch(() => ({ success: false })),
      ]);
      if (wRes.success && wRes.data) setWarehousesList(wRes.data);
      if (uRes.success && uRes.data) setUnitsList(uRes.data);
      if (cRes.success && cRes.data) setCustomersList(cRes.data);
      if (sRes.success && sRes.data) setShiftsList(sRes.data);
      if (cmRes.success && cmRes.data) setCarModelsList(cmRes.data);
      if (opRes.success && opRes.data) setOperationsList(opRes.data);
      if (procRes.success && procRes.data && procRes.data.length > 0) {
        setProcessCategories(procRes.data);
      }
      if (hallRes.success && hallRes.data && hallRes.data.length > 0) {
        setHallsList(hallRes.data);
      }
    } catch (e) {
      console.error('Error loading dynamic master data:', e);
    }
  };

  useEffect(() => {
    loadDynamicMasterData();
  }, []);

  const handleSaveWarehouse = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/warehouses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(warehouseForm),
      });
      const data = await res.json();
      if (data.success) {
        await loadDynamicMasterData();
        setIsWarehouseModalOpen(false);
        setEditingWarehouse(null);
        notifyMaster('success', 'اطلاعات انبار با موفقیت ذخیره شد.');
      } else {
        notifyMaster('error', data.error || 'خطا در ثبت انبار');
      }
    } catch {
      notifyMaster('error', 'خطای ارتباط با سرور');
    }
  };

  const handleDeleteWarehouse = (id: string) => {
    requestConfirm({
      title: 'حذف انبار',
      message: 'آیا از حذف این انبار اطمینان دارید؟',
      confirmLabel: 'حذف شود',
      cancelLabel: 'انصراف',
      variant: 'danger',
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/warehouses/${id}`, { method: 'DELETE' });
          const data = await res.json();
          if (data.success) {
            await loadDynamicMasterData();
            notifyMaster('success', 'انبار با موفقیت حذف شد.');
          } else {
            notifyMaster('error', data.error || 'خطا در حذف انبار');
          }
        } catch {
          notifyMaster('error', 'خطا در حذف انبار');
        }
      },
    });
  };

  const handleSaveUnit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/units', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(unitForm),
      });
      const data = await res.json();
      if (data.success) {
        await loadDynamicMasterData();
        setIsUnitModalOpen(false);
        setEditingUnit(null);
        notifyMaster('success', 'واحد سنجش با موفقیت ذخیره شد.');
      } else {
        notifyMaster('error', data.error || 'خطا در ثبت واحد');
      }
    } catch {
      notifyMaster('error', 'خطای ارتباط با سرور');
    }
  };

  const handleDeleteUnit = (id: string) => {
    requestConfirm({
      title: 'حذف واحد سنجش',
      message: 'آیا از حذف این واحد سنجش اطمینان دارید؟',
      confirmLabel: 'حذف شود',
      cancelLabel: 'انصراف',
      variant: 'danger',
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/units/${id}`, { method: 'DELETE' });
          const data = await res.json();
          if (data.success) {
            await loadDynamicMasterData();
            notifyMaster('success', 'واحد سنجش با موفقیت حذف شد.');
          } else {
            notifyMaster('error', data.error || 'خطا در حذف واحد');
          }
        } catch {
          notifyMaster('error', 'خطا در حذف واحد');
        }
      },
    });
  };

  const handleSaveCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(customerForm),
      });
      const data = await res.json();
      if (data.success) {
        await loadDynamicMasterData();
        setIsCustomerModalOpen(false);
        setEditingCustomer(null);
        notifyMaster('success', 'اطلاعات مشتری با موفقیت ذخیره شد.');
      } else {
        notifyMaster('error', data.error || 'خطا در ثبت مشتری');
      }
    } catch {
      notifyMaster('error', 'خطای ارتباط با سرور');
    }
  };

  const handleDeleteCustomer = (id: string) => {
    requestConfirm({
      title: 'حذف مشتری',
      message: 'آیا از حذف این مشتری اطمینان دارید؟',
      confirmLabel: 'حذف شود',
      cancelLabel: 'انصراف',
      variant: 'danger',
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/customers/${id}`, { method: 'DELETE' });
          const data = await res.json();
          if (data.success) {
            await loadDynamicMasterData();
            notifyMaster('success', 'مشتری با موفقیت حذف شد.');
          } else {
            notifyMaster('error', data.error || 'خطا در حذف مشتری');
          }
        } catch {
          notifyMaster('error', 'خطا در حذف مشتری');
        }
      },
    });
  };

  const handleSaveShift = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/shifts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(shiftForm),
      });
      const data = await res.json();
      if (data.success) {
        await loadDynamicMasterData();
        setIsShiftModalOpen(false);
        setEditingShift(null);
        notifyMaster('success', 'شیفت کاری با موفقیت ذخیره شد.');
      } else {
        notifyMaster('error', data.error || 'خطا در ثبت شیفت');
      }
    } catch {
      notifyMaster('error', 'خطای ارتباط با سرور');
    }
  };

  const handleDeleteShift = (id: string) => {
    requestConfirm({
      title: 'حذف شیفت کاری',
      message: 'آیا از حذف این شیفت اطمینان دارید؟',
      confirmLabel: 'حذف شود',
      cancelLabel: 'انصراف',
      variant: 'danger',
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/shifts/${id}`, { method: 'DELETE' });
          const data = await res.json();
          if (data.success) {
            await loadDynamicMasterData();
            notifyMaster('success', 'شیفت کاری با موفقیت حذف شد.');
          } else {
            notifyMaster('error', data.error || 'خطا در حذف شیفت');
          }
        } catch {
          notifyMaster('error', 'خطا در حذف شیفت');
        }
      },
    });
  };

  const handleSaveCarModel = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/car-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(carModelForm),
      });
      const data = await res.json();
      if (data.success) {
        await loadDynamicMasterData();
        setIsCarModelModalOpen(false);
        setEditingCarModel(null);
        notifyMaster('success', 'مدل خودرو با موفقیت ذخیره شد.');
      } else {
        notifyMaster('error', data.error || 'خطا در ثبت مدل خودرو');
      }
    } catch {
      notifyMaster('error', 'خطای ارتباط با سرور');
    }
  };

  const handleDeleteCarModel = (id: string) => {
    requestConfirm({
      title: 'حذف مدل خودرو',
      message: 'آیا از حذف این مدل خودرو اطمینان دارید؟',
      confirmLabel: 'حذف شود',
      cancelLabel: 'انصراف',
      variant: 'danger',
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/car-models/${id}`, { method: 'DELETE' });
          const data = await res.json();
          if (data.success) {
            await loadDynamicMasterData();
            notifyMaster('success', 'مدل خودرو با موفقیت حذف شد.');
          } else {
            notifyMaster('error', data.error || 'خطا در حذف مدل خودرو');
          }
        } catch {
          notifyMaster('error', 'خطا در حذف مدل خودرو');
        }
      },
    });
  };

  const handleSaveOperation = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/operations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(operationForm),
      });
      const data = await res.json();
      if (data.success) {
        await loadDynamicMasterData();
        setIsOperationModalOpen(false);
        setEditingOperation(null);
        notifyMaster('success', 'عملیات استاندارد با موفقیت ذخیره شد.');
      } else {
        notifyMaster('error', data.error || 'خطا در ثبت عملیات');
      }
    } catch {
      notifyMaster('error', 'خطای ارتباط با سرور');
    }
  };

  const handleDeleteOperation = (id: string) => {
    requestConfirm({
      title: 'حذف عملیات استاندارد',
      message: 'آیا از حذف این عملیات استاندارد اطمینان دارید؟',
      confirmLabel: 'حذف شود',
      cancelLabel: 'انصراف',
      variant: 'danger',
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/operations/${id}`, { method: 'DELETE' });
          const data = await res.json();
          if (data.success) {
            await loadDynamicMasterData();
            notifyMaster('success', 'عملیات استاندارد حذف شد.');
          } else {
            notifyMaster('error', data.error || 'خطا در حذف عملیات');
          }
        } catch {
          notifyMaster('error', 'خطا در حذف عملیات');
        }
      },
    });
  };

  // Factory Halls Handlers (مدیریت سالن‌های استقرار کارخانه)
  const handleSaveHall = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hallForm.code || !hallForm.name) {
      notifyMaster('error', 'کد و نام سالن الزامی است.');
      return;
    }
    try {
      const res = await fetch('/api/halls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hallForm),
      });
      const data = await res.json();
      if (data.success) {
        await loadDynamicMasterData();
        await onRefresh();
        setIsHallModalOpen(false);
        setEditingHall(null);
        notifyMaster('success', 'اطلاعات سالن تولید با موفقیت ذخیره شد.');
      } else {
        notifyMaster('error', data.error || 'خطا در ثبت سالن');
      }
    } catch {
      notifyMaster('error', 'خطای ارتباط با سرور هنگام ثبت سالن');
    }
  };

  const handleDeleteHall = (id: string) => {
    requestConfirm({
      title: 'حذف سالن تولید',
      message: 'آیا از حذف این سالن تولید اطمینان دارید؟',
      confirmLabel: 'حذف شود',
      cancelLabel: 'انصراف',
      variant: 'danger',
      onConfirm: async () => {
        try {
          if (onDeleteHall) {
            const res = await onDeleteHall(id);
            if (res.success) {
              await loadDynamicMasterData();
              await onRefresh();
              notifyMaster('success', 'سالن تولید با موفقیت حذف شد.');
              return;
            }
          }
          const res = await fetch(`/api/halls/${id}`, { method: 'DELETE' });
          const data = await res.json();
          if (data.success) {
            await loadDynamicMasterData();
            await onRefresh();
            notifyMaster('success', 'سالن تولید با موفقیت حذف شد.');
          } else {
            notifyMaster('error', data.error || 'خطا در حذف سالن');
          }
        } catch {
          notifyMaster('error', 'خطای ارتباط با سرور هنگام حذف سالن');
        }
      },
    });
  };

  // Process Category Handlers (مدیریت دسته‌بندی‌های فرآیندی پویا)
  const handleAddProcessCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCategoryCode.trim() || !newCategoryName.trim()) {
      notifyMaster('error', 'کد و نام دسته فرآیندی الزامی است.');
      return;
    }
    const cleanCode = newCategoryCode.trim().toUpperCase().replace(/\s+/g, '_');
    try {
      const res = await fetch('/api/processes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: cleanCode,
          name: newCategoryName.trim(),
          category: cleanCode,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setProcessCategories(prev => {
          const exists = prev.some(p => p.code === cleanCode);
          if (exists) {
            return prev.map(p => (p.code === cleanCode ? { code: cleanCode, name: newCategoryName.trim() } : p));
          }
          return [...prev, { code: cleanCode, name: newCategoryName.trim() }];
        });
        setOperationForm(prev => ({ ...prev, category: cleanCode as any }));
        setNewCategoryCode('');
        setNewCategoryName('');
        setIsProcessCategoryModalOpen(false);
        notifyMaster('success', `دسته فرآیندی «${newCategoryName.trim()}» با موفقیت ثبت شد.`);
      } else {
        notifyMaster('error', data.error || 'خطا در ثبت دسته فرآیندی');
      }
    } catch {
      notifyMaster('error', 'خطای ارتباط با سرور');
    }
  };

  const handleDeleteProcessCategory = (code: string) => {
    requestConfirm({
      title: 'حذف دسته فرآیندی',
      message: `آیا از حذف دسته فرآیندی «${code}» اطمینان دارید؟`,
      confirmLabel: 'حذف شود',
      cancelLabel: 'انصراف',
      variant: 'danger',
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/processes/${code}`, { method: 'DELETE' });
          const data = await res.json();
          if (data.success) {
            setProcessCategories(prev => prev.filter(p => p.code !== code));
            notifyMaster('success', 'دسته فرآیندی حذف شد.');
          } else {
            notifyMaster('error', data.error || 'خطا در حذف دسته فرآیندی');
          }
        } catch {
          notifyMaster('error', 'خطا در حذف دسته فرآیندی');
        }
      },
    });
  };

  // Hub Cards exactly matching Uploaded Image 1 (1_1da4846f.jpg)
  const hubCards: {
    id: MasterSubSection;
    title: string;
    description: string;
    icon: React.ComponentType<{ className?: string }>;
    countBadge?: string;
  }[] = [
    {
      id: 'PARTS',
      title: 'قطعات (کالا)',
      description: 'تعریف قطعه، واحد پایه، وزن استاندارد، ماده اصلی و مشتری',
      icon: Boxes,
      countBadge: `${toPersianDigits(parts.length)} قطعه`,
    },
    {
      id: 'RAW_MATERIALS',
      title: 'مواد اولیه و کویل',
      description: 'ورق/کویل/رنگ با گرید، ابعاد، وزن واحد و تامین‌کننده',
      icon: Disc,
      countBadge: `${toPersianDigits(rawSheets.length)} گرید ورق`,
    },
    {
      id: 'BOM',
      title: 'درخت محصول و اجزا (BOM)',
      description: 'ساختار چندسطحی قطعات مرکب، ورق‌های مختلف، پیچ و مهره و قطعات لاستیکی',
      icon: ListTree,
      countBadge: 'درخت محصول چندسطحی',
    },
    {
      id: 'PRODUCT_STRUCTURE',
      title: 'ساختار درختی کالا (Product Structure)',
      description: 'مدل ساختار بازگشتی کالا، تخصیص زیرمجموعه‌ها و ضرایب مصرف مانند براکت ضدسرقت',
      icon: FolderTree,
      countBadge: 'ساختار درختی بازگشتی',
    },
    {
      id: 'PARALLEL_FLOWS',
      title: 'تولید موازی و انشعاب',
      description: 'منطق قالب‌های دوگانه چپ/راست، انشعاب ورق و الحاق در جوشکاری',
      icon: GitFork,
      countBadge: 'قالب‌های مشترک و ادغام',
    },
    {
      id: 'ROUTINGS',
      title: 'مسیرهای تولید',
      description: 'نسخه‌بندی مسیر و ترتیب عملیات، ماشین و قالب هر مرحله',
      icon: GitBranch,
      countBadge: `${toPersianDigits(routings.length)} مسیر`,
    },
    {
      id: 'OPERATIONS',
      title: 'عملیات تولید',
      description: 'برش، خالی‌بری، خم، پرس، جوش، رنگ و مونتاژ با زمان‌های استاندارد',
      icon: Settings2,
      countBadge: `${toPersianDigits(operationsList.length)} ایستگاه و عملیات`,
    },
    {
      id: 'WAREHOUSES',
      title: 'انبارها و موقعیت‌ها',
      description: 'انبارهای مواد/WIP/محصول/ضایعات و قفسه‌ها',
      icon: Warehouse,
      countBadge: '۵ انبار فعال',
    },
    {
      id: 'UNITS',
      title: 'واحدهای شمارش',
      description: 'عدد، کیلوگرم، متر، مترمربع و برگ',
      icon: Ruler,
      countBadge: '۵ واحد پایه',
    },
    {
      id: 'SHIFTS',
      title: 'شیفت‌های کاری',
      description: 'ساعت شروع و پایان شیفت‌ها — مبنای تقویم ظرفیت',
      icon: Clock,
      countBadge: '۳ شیفت کاری',
    },
    {
      id: 'CUSTOMERS',
      title: 'مشتریان',
      description: 'شرکت‌های خودروساز و اطلاعات تماس',
      icon: Users,
      countBadge: 'ساپکو / سازه‌گستر',
    },
    {
      id: 'MACHINES',
      title: 'ماشین‌آلات و ظرفیت',
      description: 'پرس‌ها و ایستگاه‌ها، توانمندی‌ها، قالب‌ها و ظرفیت',
      icon: Wrench,
      countBadge: `${toPersianDigits(machines.length)} دستگاه`,
    },
    {
      id: 'DIES',
      title: 'قالب‌های پرس و فیکسچرها',
      description: 'شناسنامه قالب، تناژ مورد نیاز، پرس‌های سازگار، کنترل ضرب و وضعیت PM',
      icon: Wrench,
      countBadge: `${toPersianDigits(dies.length)} قالب فعال`,
    },
    {
      id: 'FACTORY_HALLS',
      title: 'سالن‌های استقرار و خطوط',
      description: 'تعریف و مدیریت سالن‌های پرس سنگین، سبک، جوشکاری، خط رنگ و انبارها',
      icon: Building2,
      countBadge: `${toPersianDigits(hallsList.length)} سالن تولید`,
    },
    {
      id: 'CAR_MODELS',
      title: 'مدل‌های خودرو و خانواده محصول',
      description: 'پژو ۲۰۶، ۲۰۷، تارا، دنا پلاس، شاهین، کوییک و ارتباط با خودروساز',
      icon: Car,
      countBadge: `${toPersianDigits(carModelsList.length)} مدل خودرو`,
    },
  ];

  // Segmented Tabs exactly matching Uploaded Image 2 (2_5080a2ed.jpg)
  const segmentedTabs: { id: MasterSubSection; label: string }[] = [
    { id: 'PARTS', label: 'قطعات' },
    { id: 'RAW_MATERIALS', label: 'ماده اولیه' },
    { id: 'BOM', label: 'درخت محصول (BOM)' },
    { id: 'PRODUCT_STRUCTURE', label: 'ساختار درختی کالا' },
    { id: 'PARALLEL_FLOWS', label: 'تولید موازی و چپ/راست' },
    { id: 'ROUTINGS', label: 'مسیر تولید' },
    { id: 'OPERATIONS', label: 'عملیات' },
    { id: 'MACHINES', label: 'ماشین‌آلات' },
    { id: 'DIES', label: 'قالب‌ها' },
    { id: 'FACTORY_HALLS', label: 'سالن‌های تولید' },
    { id: 'CAR_MODELS', label: 'مدل خودرو' },
    { id: 'WAREHOUSES', label: 'انبارها' },
    { id: 'CUSTOMERS', label: 'مشتریان' },
    { id: 'ORDERS', label: 'سفارشات' },
  ];

  const computeTheoreticalSheetWeight = (
    thicknessMm?: number,
    widthMm?: number,
    lengthMm?: number,
    densityGCm3?: number
  ) => {
    const t = Number(thicknessMm) || 0;
    const w = Number(widthMm) || 0;
    const l = Number(lengthMm) || 0;
    const d = Number(densityGCm3) || 7.85;
    if (t <= 0 || w <= 0 || l <= 0) return 0;
    // volume in cm^3 = (t/10)*(w/10)*(l/10) = t*w*l / 1000; mass in kg = (vol * d) / 1000
    return Math.round(((t * w * l * d) / 1_000_000) * 100) / 100;
  };

  const handleSaveGradeManagerForm = (e: React.FormEvent) => {
    e.preventDefault();
    const code = gradeFormCode.trim().toUpperCase();
    const name = gradeFormName.trim();
    if (!code || !name) return;
    const updated = upsertMaterialGrade({
      id: editingGradeId || undefined,
      code,
      name,
      category: gradeFormCategory,
      standard: gradeFormStandard.trim(),
      densityGCm3: parseFloat(gradeFormDensity) || 7.85,
      notes: gradeFormNotes.trim(),
    });
    setMaterialGrades(updated);
    setEditingGradeId(null);
    setGradeFormCode('');
    setGradeFormName('');
    setGradeFormCategory('COLD_ROLLED');
    setGradeFormStandard('');
    setGradeFormDensity('7.85');
    setGradeFormNotes('');
    notifyMaster('success', `گرید و جنس ورق «${code} — ${name}» در بانک گریدهای کارخانه ذخیره شد.`);
  };

  const handleQuickInlineAddGrade = () => {
    const code = inlineGradeCode.trim().toUpperCase();
    const name = inlineGradeName.trim() || code;
    if (!code) return;
    const density = parseFloat(inlineGradeDensity) || 7.85;
    const updated = upsertMaterialGrade({
      code,
      name,
      category: inlineGradeCategory,
      densityGCm3: density,
    });
    setMaterialGrades(updated);
    setSheetForm(prev => ({
      ...prev,
      grade: code,
      densityGCm3: density,
    }));
    setInlineGradeCode('');
    setInlineGradeName('');
    setShowInlineAddGrade(false);
    notifyMaster('success', `جنس ورق جدید «${code}» اضافه و برای این ماده انتخاب شد.`);
  };

  const handleSaveSheetSpec = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSavingSheet || !sheetForm.code || !sheetForm.name) return;

    const currentEditing = editingSheet;
    const trimmedCode = sheetForm.code.trim();
    const normalizedCodeUpper = trimmedCode.toUpperCase();
    const widthNum = Number(sheetForm.widthMm) || 0;
    const lengthNum = Number(sheetForm.lengthMm) || 0;
    const computedDim =
      sheetForm.dimensionsMm?.trim() ||
      (widthNum > 0 && lengthNum > 0
        ? `${toPersianDigits(widthNum.toLocaleString('en-US'))} × ${toPersianDigits(lengthNum.toLocaleString('en-US'))}`
        : sheetForm.supplyForm === 'COIL' && widthNum > 0
        ? `کلاف عرض ${toPersianDigits(widthNum.toLocaleString('en-US'))} mm`
        : 'استاندارد');

    const normalizedSpec: Partial<RawSheetSpec> = {
      ...sheetForm,
      code: trimmedCode,
      name: sheetForm.name.trim(),
      grade: sheetForm.grade || materialGrades[0]?.code || 'ST12',
      supplyForm: sheetForm.supplyForm || 'SHEET',
      thicknessMm: Number(sheetForm.thicknessMm) || 1.0,
      widthMm: widthNum || undefined,
      lengthMm: lengthNum || undefined,
      dimensionsMm: computedDim,
      densityGCm3: Number(sheetForm.densityGCm3) || 7.85,
      sheetWeightKg: Number(sheetForm.sheetWeightKg) || 1,
      unit: sheetForm.unit || 'کیلوگرم',
      ownership: sheetForm.ownership || 'SAPCO_CONSIGNMENT',
      supplierName: sheetForm.supplierName?.trim() || '',
      standard: sheetForm.standard?.trim() || '',
      minStock: Number(sheetForm.minStock) || 0,
      description: sheetForm.description?.trim() || '',
      contractsCount: Number(sheetForm.contractsCount) || 0,
      active: sheetForm.active !== false,
    };

    // Close modal immediately to prevent lag or accidental double-submission
    setIsSavingSheet(true);
    setIsNewSheetModalOpen(false);
    setShowInlineAddGrade(false);
    setEditingSheet(null);

    if (currentEditing) {
      setRawSheets(prev => {
        const updated = prev.map(item =>
          item.id === currentEditing.id
            ? ({ ...item, ...normalizedSpec } as RawSheetSpec)
            : item
        );
        // Ensure no duplicate row shares the same code after edit
        const seen = new Set<string>();
        return updated.filter(item => {
          const k = String(item.code || '').trim().toUpperCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      });
    } else {
      setRawSheets(prev => {
        const existingIdx = prev.findIndex(
          item => String(item.code || '').trim().toUpperCase() === normalizedCodeUpper
        );
        if (existingIdx >= 0) {
          return prev.map((item, idx) =>
            idx === existingIdx ? ({ ...item, ...normalizedSpec } as RawSheetSpec) : item
          );
        }
        const newSpec: RawSheetSpec = {
          id: `RM-${Date.now()}`,
          code: normalizedSpec.code!,
          name: normalizedSpec.name!,
          grade: normalizedSpec.grade!,
          supplyForm: normalizedSpec.supplyForm,
          thicknessMm: normalizedSpec.thicknessMm!,
          widthMm: normalizedSpec.widthMm,
          lengthMm: normalizedSpec.lengthMm,
          dimensionsMm: normalizedSpec.dimensionsMm!,
          densityGCm3: normalizedSpec.densityGCm3,
          sheetWeightKg: normalizedSpec.sheetWeightKg!,
          unit: normalizedSpec.unit!,
          ownership: normalizedSpec.ownership,
          supplierName: normalizedSpec.supplierName,
          standard: normalizedSpec.standard,
          minStock: normalizedSpec.minStock,
          description: normalizedSpec.description,
          contractsCount: normalizedSpec.contractsCount!,
          active: normalizedSpec.active !== false,
        };
        return [newSpec, ...prev];
      });
    }

    // Automatically sync with global parts catalog (update existing Part by ID when editing)
    const oldCodeUpper = String(currentEditing?.code || '').trim().toUpperCase();
    const matchedCatalogPart = parts.find(p => {
      const pCodeUpper = String(p.code || '').trim().toUpperCase();
      return (oldCodeUpper && pCodeUpper === oldCodeUpper) || pCodeUpper === normalizedCodeUpper;
    });
    const resolvedUnit = normalizedSpec.unit === 'عدد' || normalizedSpec.unit === 'برگ' ? 'PCS' : 'KG';

    try {
      const syncResult = await onSavePart({
        ...(matchedCatalogPart ? { id: matchedCatalogPart.id } : {}),
        code: normalizedSpec.code,
        name: normalizedSpec.name,
        category: 'RAW_MATERIAL',
        unit: resolvedUnit,
        materialGrade: normalizedSpec.grade,
        thicknessMm: normalizedSpec.thicknessMm,
        weightPerUnitKg: normalizedSpec.sheetWeightKg,
        minStock: normalizedSpec.minStock,
        description: [
          normalizedSpec.supplyForm === 'COIL'
            ? 'شکل عرضه: رول/کلاف'
            : normalizedSpec.supplyForm === 'STRIP'
            ? 'شکل عرضه: نوار برش‌خورده'
            : normalizedSpec.supplyForm === 'SHEET'
            ? 'شکل عرضه: شیت ورق'
            : '',
          normalizedSpec.dimensionsMm ? `ابعاد: ${normalizedSpec.dimensionsMm}` : '',
          normalizedSpec.supplierName ? `تأمین‌کننده: ${normalizedSpec.supplierName}` : '',
          normalizedSpec.standard ? `استاندارد: ${normalizedSpec.standard}` : '',
          normalizedSpec.description || '',
        ]
          .filter(Boolean)
          .join(' | '),
      });
      if (syncResult && !syncResult.success) {
        notifyMaster(
          'error',
          `تغییرات در جدول مواد اولیه ذخیره شد، اما همگام‌سازی با کاتالوگ انبار خطا داد: ${syncResult.error || 'خطای ناشناخته'}`
        );
      } else {
        notifyMaster(
          'success',
          currentEditing
            ? `ویرایش ماده اولیه «${normalizedSpec.code}» ذخیره و با کاتالوگ انبار قطعات همگام‌سازی شد.`
            : `ماده اولیه «${normalizedSpec.code}» ثبت و با کاتالوگ انبار قطعات همگام‌سازی شد.`
        );
      }
    } catch (err) {
      console.warn('Could not auto-sync sheet with parts catalog:', err);
      notifyMaster('success', `ماده اولیه «${normalizedSpec.code}» در جدول مواد اولیه ذخیره شد.`);
    } finally {
      setIsSavingSheet(false);
    }
  };

  const filteredRawSheets = rawSheets.filter(
    s =>
      !sheetSearch.trim() ||
      s.code.toLowerCase().includes(sheetSearch.toLowerCase()) ||
      s.name.toLowerCase().includes(sheetSearch.toLowerCase()) ||
      s.grade.toLowerCase().includes(sheetSearch.toLowerCase()) ||
      (s.supplierName || '').toLowerCase().includes(sheetSearch.toLowerCase())
  );

  if (parts.length === 0 && machines.length === 0) {
    return <MasterDataSkeleton />;
  }

  return (
    <div className="space-y-5">
      {masterBanner && (
        <FioriMessageStrip
          tone={masterBanner.type === 'success' ? 'success' : 'error'}
          onClose={() => setMasterBanner(null)}
        >
          {masterBanner.message}
        </FioriMessageStrip>
      )}
      {/* SAP Fiori Dynamic Page Header & Launchpad Section Bar */}
      <div className="sap-card overflow-hidden">
        <div className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-[var(--fiori-border-default)]">
          <div className="flex items-start sm:items-center gap-3">
            <div className="w-9 h-9 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-info-bg)] border border-[var(--fiori-info-border)] text-[var(--fiori-brand)] flex items-center justify-center shrink-0">
              <Boxes className="w-4 h-4" />
            </div>
            <div>
              <h1 className="text-sm font-semibold text-[var(--fiori-text-primary)]">اطلاعات پایه کارخانه (SAP Master Data)</h1>
              <p className="text-xs text-[var(--fiori-text-secondary)] mt-0.5">
                مدیریت یکپارچه قطعات، ورق‌ها، درخت محصول (BOM)، مسیر تولید، ماشین‌آلات، انبارها و مشتریان
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 self-end md:self-auto">
            <div className="inline-flex items-center bg-[var(--fiori-bg-subtle)] p-1 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)]">
              <button
                type="button"
                onClick={() => handleSelectSection('HUB')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--fiori-radius-sm)] text-xs font-medium transition-colors cursor-pointer ${
                  viewMode === 'CARDS_HUB' && activeSection === 'HUB'
                    ? 'bg-[var(--fiori-brand)] text-white'
                    : 'text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)]'
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                <span>فهرست کارتی</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setViewMode('SEGMENTED_TABS');
                  if (activeSection === 'HUB') handleSelectSection('RAW_MATERIALS');
                }}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--fiori-radius-sm)] text-xs font-medium transition-colors cursor-pointer ${
                  activeSection !== 'HUB'
                    ? 'bg-[var(--fiori-brand)] text-white'
                    : 'text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)]'
                }`}
              >
                <Table2 className="w-3.5 h-3.5" />
                <span>نمای جدولی مستقیم</span>
              </button>
            </div>

            <button
              type="button"
              onClick={onRefresh}
              className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>به‌روزرسانی</span>
            </button>
          </div>
        </div>

        {/* SAP Fiori IconTabBar & Master Table Selector */}
        <div className="px-3 flex flex-wrap items-center justify-between gap-2 text-xs bg-[var(--fiori-bg-surface)]">
          <div className="flex flex-wrap items-center gap-2 flex-1">
            <div className="inline-flex items-center gap-2 bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1 my-1.5">
              <span className="text-[var(--fiori-text-secondary)] font-normal">جدول:</span>
              <select
                value={activeSection}
                onChange={e => handleSelectSection(e.target.value as MasterSubSection)}
                className="bg-transparent font-semibold text-[var(--fiori-text-primary)] focus:outline-none cursor-pointer"
              >
                <option value="HUB">پیشخوان همه جداول اطلاعات پایه (۱۳ بخش)</option>
                {segmentedTabs.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
                <option value="UNITS">واحدهای شمارش</option>
                <option value="SHIFTS">شیفت‌های کاری</option>
              </select>
            </div>

            <div className="sap-icon-tab-bar border-b-0 flex-1">
              {[
                { id: 'PARTS', label: 'قطعات' },
                { id: 'RAW_MATERIALS', label: 'ورق و کویل' },
                { id: 'BOM', label: 'درخت محصول (BOM)' },
                { id: 'ROUTINGS', label: 'مسیر تولید' },
                { id: 'MACHINES', label: 'ماشین‌آلات' },
                { id: 'DIES', label: 'قالب‌ها' },
                { id: 'CAR_MODELS', label: 'مدل‌های خودرو' },
              ].map(tab => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => handleSelectSection(tab.id as MasterSubSection)}
                  className={`sap-icon-tab ${activeSection === tab.id ? 'sap-icon-tab-active' : ''}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {activeSection !== 'HUB' && (
            <button
              type="button"
              onClick={() => handleSelectSection('HUB')}
              className="inline-flex items-center gap-1 text-xs font-medium text-[var(--fiori-brand)] hover:underline cursor-pointer py-1.5"
            >
              <ArrowRight className="w-3.5 h-3.5" />
              <span>بازگشت به فهرست کارتی</span>
            </button>
          )}
        </div>
      </div>

      {/* MODE 1: SAP FIORI LAUNCHPAD TILES HUB */}
      {activeSection === 'HUB' && (
        <div className="sap-card p-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {hubCards.map(card => {
              const Icon = card.icon;
              return (
                <div
                  key={card.id}
                  onClick={() => handleSelectSection(card.id)}
                  className="fiori-tile group bg-[var(--fiori-bg-surface)] hover:bg-[var(--fiori-bg-hover)] border border-[var(--fiori-border-default)] hover:border-[var(--fiori-brand)] rounded-[var(--fiori-radius-md)] p-4 flex flex-col justify-between transition-colors cursor-pointer"
                >
                  <div>
                    <div className="flex items-center justify-between gap-3 mb-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className="w-9 h-9 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-info-bg)] border border-[var(--fiori-info-border)] text-[var(--fiori-brand)] flex items-center justify-center shrink-0">
                          <Icon className="w-4 h-4" />
                        </div>
                        <h3 className="text-sm font-semibold text-[var(--fiori-text-primary)] group-hover:text-[var(--fiori-brand)] transition-colors">
                          {card.title}
                        </h3>
                      </div>
                    </div>

                    <p className="text-xs text-[var(--fiori-text-secondary)] leading-relaxed min-h-[38px]">
                      {card.description}
                    </p>
                  </div>

                  <div className="mt-3.5 pt-2.5 border-t border-[var(--fiori-border-subtle)] flex items-center justify-between gap-2">
                    {card.countBadge ? (
                      <FioriObjectStatus tone="neutral" size="sm" label={card.countBadge} />
                    ) : (
                      <span />
                    )}
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--fiori-brand)] group-hover:underline">
                      <span>مشاهده</span>
                      <ArrowLeft className="w-3.5 h-3.5" />
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* =====================================================================
          ACTIVE SUB-SECTION CONTENT
         ===================================================================== */}

      {/* 1. RAW MATERIALS & SHEET SPECS */}
      {activeSection === 'RAW_MATERIALS' && (
        <div className="space-y-3">
          <FioriMessageStrip
            tone="info"
            title="اتصال و یکپارچگی مواد اولیه با انبار قطعات (Master Item Catalog)"
            actions={
              <button
                type="button"
                onClick={() => setActiveSection('PARTS')}
                className="sap-btn-standard px-3 py-1 text-[11px] whitespace-nowrap cursor-pointer"
              >
                مشاهده در انبار قطعات ←
              </button>
            }
          >
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <FioriObjectStatus
                tone="positive"
                size="sm"
                label={`${toPersianDigits(parts.filter(p => p.category === 'RAW_MATERIAL').length)} قلم ماده اولیه در انبار کالا`}
              />
            </div>
            در خطوط پرسکاری بدنه خودرو، کلیه اجناس اعم از <strong>مواد اولیه (ورق و رول)</strong>، <strong>قطعات نیمه‌ساخته (WIP)</strong> و <strong>محصول نهایی</strong> دارای هویت واحد به عنوان کالا هستند. این جدول مشخصات مهندسی ابعاد شیت (ضخامت، طول/عرض برش و وزن هر برگ برای موازنه خطوط پرس) را تنظیم می‌کند و هر ردیف آن مستقیماً با کاتالوگ قطعات همگام است.
          </FioriMessageStrip>

          {/* Action Row above table */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => {
                  const defaultGrade = materialGrades[0] || { code: 'ST12', densityGCm3: 7.85, standard: 'DIN 1623' };
                  setEditingSheet(null);
                  setShowInlineAddGrade(false);
                  setSheetForm({
                    code: `SHT-${defaultGrade.code}-${((rawSheets.length + 1) * 0.2).toFixed(1)}`,
                    name: '',
                    grade: defaultGrade.code,
                    supplyForm: 'SHEET',
                    thicknessMm: 1.0,
                    widthMm: 1250,
                    lengthMm: 2500,
                    dimensionsMm: '۱,۲۵۰ × ۲,۵۰۰',
                    densityGCm3: defaultGrade.densityGCm3 || 7.85,
                    sheetWeightKg: computeTheoreticalSheetWeight(1.0, 1250, 2500, defaultGrade.densityGCm3 || 7.85),
                    unit: 'کیلوگرم',
                    ownership: 'SAPCO_CONSIGNMENT',
                    supplierName: 'فولاد مبارکه اصفهان',
                    standard: defaultGrade.standard || 'DIN 1623 / EN 10130',
                    minStock: 2000,
                    description: '',
                    contractsCount: 1,
                    active: true,
                  });
                  setIsNewSheetModalOpen(true);
                }}
                className="sap-btn-emphasized inline-flex items-center gap-1.5 px-3.5 py-2 text-xs cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>ماده اولیه جدید</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setEditingGradeId(null);
                  setGradeFormCode('');
                  setGradeFormName('');
                  setGradeFormCategory('COLD_ROLLED');
                  setGradeFormStandard('');
                  setGradeFormDensity('7.85');
                  setGradeFormNotes('');
                  setIsGradeManagerOpen(true);
                }}
                className="sap-btn-standard inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-[var(--fiori-brand)] cursor-pointer"
                title="مشاهده، افزودن، ویرایش و حذف فهرست گریدها و جنس ورق‌های مجاز در سامانه"
              >
                <Settings2 className="w-3.5 h-3.5" />
                <span>مدیریت گریدها و جنس ورق ({toPersianDigits(materialGrades.length)} جنس)</span>
              </button>

              <span className="text-xs font-medium text-[var(--fiori-text-secondary)] tabular-nums">
                {toPersianDigits(filteredRawSheets.length)} ماده
              </span>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-[var(--fiori-text-muted)] absolute right-3 top-2.5 pointer-events-none" />
                <input
                  type="text"
                  value={sheetSearch}
                  onChange={e => setSheetSearch(e.target.value)}
                  placeholder="جستجوی کد ورق، گرید (ST12/DC04) یا تأمین‌کننده..."
                  className="fiori-input pr-8 pl-3 py-1.5 text-xs w-64"
                />
              </div>
              {onNavigateToInventoryCoils && (
                <button
                  type="button"
                  onClick={onNavigateToInventoryCoils}
                  className="sap-btn-standard px-3 py-1.5 text-xs cursor-pointer"
                >
                  رهگیری کویل‌پک‌ها در انبار ({toPersianDigits(coils.length)} رول) ←
                </button>
              )}
            </div>
          </div>

          {/* SAP ALV Table */}
          <div className="sap-card overflow-hidden">
            <FioriToolbar
              variant="table"
              title="فهرست مواد اولیه، ورق‌ها و رول‌ها"
              count={filteredRawSheets.length}
              countLabel="ماده"
            />
            {filteredRawSheets.length === 0 ? (
              <EmptyState
                compact
                variant={sheetSearch.trim() ? 'SEARCH_NO_MATCH' : 'NO_DATA'}
                title={sheetSearch.trim() ? 'ماده اولیه‌ای با این مشخصات یافت نشد' : 'ماده اولیه‌ای ثبت نشده است'}
                description={
                  sheetSearch.trim()
                    ? 'عبارت جستجو را تغییر دهید یا فیلتر را پاک کنید.'
                    : 'برای شروع، اولین ماده اولیه را تعریف کنید.'
                }
                actionLabel={sheetSearch.trim() ? 'پاک کردن جستجو' : undefined}
                onAction={sheetSearch.trim() ? () => setSheetSearch('') : undefined}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="sap-table-compact w-full text-right text-xs">
                  <thead className="bg-[var(--fiori-bg-subtle)] border-b border-[var(--fiori-border-default)] text-[var(--fiori-text-primary)] font-semibold">
                    <tr>
                      <th>کد ماده</th>
                      <th>نام ماده اولیه</th>
                      <th>گرید / جنس</th>
                      <th>شکل عرضه</th>
                      <th>ضخامت (mm)</th>
                      <th>ابعاد (mm)</th>
                      <th>وزن واحد (kg)</th>
                      <th>مالکیت / تأمین‌کننده</th>
                      <th>نقطه سفارش</th>
                      <th>وضعیت</th>
                      <th className="text-center">عملیات</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--fiori-border-subtle)] text-[var(--fiori-text-primary)]">
                    {filteredRawSheets.map(sheet => {
                      const gradeMeta = materialGrades.find(
                        g => g.code.toUpperCase() === (sheet.grade || '').toUpperCase()
                      );
                      const formLabel =
                        sheet.supplyForm === 'COIL'
                          ? 'رول / کلاف'
                          : sheet.supplyForm === 'STRIP'
                          ? 'نوار برش‌خورده'
                          : sheet.supplyForm === 'OTHER'
                          ? 'سایر مواد'
                          : 'شیت ورق';
                      const ownershipLabel =
                        sheet.ownership === 'LOCAL_PURCHASE'
                          ? 'خرید بازار'
                          : sheet.ownership === 'IMPORTED'
                          ? 'وارداتی'
                          : 'امانی ساپکو';
                      return (
                        <tr
                          key={sheet.id}
                          className="hover:bg-[var(--fiori-bg-hover)] transition-colors"
                        >
                          <td className="fiori-ltr-code font-semibold tabular-nums whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => traceDocument(sheet.code, 'INVENTORY_LEDGER')}
                              className="sap-doc-link"
                              title="رهگیری موجودی و کاردکس این ورق در انبار"
                            >
                              {sheet.code}
                            </button>
                          </td>
                          <td className="font-medium text-[var(--fiori-text-primary)]">
                            <div>{sheet.name}</div>
                            {sheet.standard && (
                              <div className="text-[10px] text-[var(--fiori-text-muted)] fiori-ltr-code">{sheet.standard}</div>
                            )}
                          </td>
                          <td className="whitespace-nowrap">
                            <div className="fiori-ltr-code font-bold text-[var(--fiori-brand)]">{sheet.grade}</div>
                            {gradeMeta && (
                              <div className="text-[10px] text-[var(--fiori-text-muted)] truncate max-w-[130px]">{gradeMeta.name}</div>
                            )}
                          </td>
                          <td className="text-[var(--fiori-text-secondary)] whitespace-nowrap">{formLabel}</td>
                          <td className="tabular-nums font-medium">
                            {toPersianDigits(sheet.thicknessMm.toString().replace('.', '/'))}
                          </td>
                          <td className="tabular-nums text-[var(--fiori-text-secondary)] whitespace-nowrap">
                            {sheet.dimensionsMm}
                          </td>
                          <td className="tabular-nums font-semibold text-[var(--fiori-text-primary)] whitespace-nowrap">
                            {toPersianDigits(sheet.sheetWeightKg.toFixed(1).replace('.', '/'))}{' '}
                            <span className="text-[10px] font-normal text-[var(--fiori-text-muted)]">{sheet.unit}</span>
                          </td>
                          <td className="text-[11px] text-[var(--fiori-text-secondary)]">
                            <div className="font-medium text-[var(--fiori-text-primary)]">{ownershipLabel}</div>
                            {sheet.supplierName && (
                              <div className="text-[10px] text-[var(--fiori-text-muted)] truncate max-w-[120px]">{sheet.supplierName}</div>
                            )}
                          </td>
                          <td className="tabular-nums font-mono text-[var(--fiori-text-secondary)]">
                            {sheet.minStock ? toPersianDigits(sheet.minStock.toLocaleString('en-US')) : '—'}
                          </td>
                          <td>
                            <FioriObjectStatus
                              tone={sheet.active ? 'positive' : 'neutral'}
                              size="sm"
                              label={sheet.active ? 'فعال' : 'غیرفعال'}
                            />
                          </td>
                          <td className="text-center whitespace-nowrap">
                            <div className="inline-flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingSheet(sheet);
                                  setShowInlineAddGrade(false);
                                  setSheetForm({
                                    ...sheet,
                                    supplyForm: sheet.supplyForm || 'SHEET',
                                    densityGCm3: sheet.densityGCm3 || gradeMeta?.densityGCm3 || 7.85,
                                    ownership: sheet.ownership || 'SAPCO_CONSIGNMENT',
                                  });
                                  setIsNewSheetModalOpen(true);
                                }}
                                className="inline-flex items-center gap-1 text-[var(--fiori-brand)] hover:text-[var(--fiori-brand-hover)] font-semibold cursor-pointer"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                                <span>ویرایش</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  requestConfirm({
                                    title: `حذف ماده اولیه «${sheet.code}»`,
                                    message: `آیا از حذف مشخصات مهندسی «${sheet.name}» از جدول مواد اولیه مطمئن هستید؟`,
                                    confirmLabel: 'بله، حذف شود',
                                    cancelLabel: 'انصراف',
                                    variant: 'danger',
                                    onConfirm: () => {
                                      setRawSheets(prev => prev.filter(r => r.id !== sheet.id));
                                      notifyMaster('success', `ردیف ماده اولیه «${sheet.code}» حذف شد.`);
                                    },
                                  });
                                }}
                                className="text-[var(--fiori-negative)] hover:opacity-80 cursor-pointer"
                                title="حذف ردیف"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 2. PARTS (قطعات / کالا) */}
      {activeSection === 'PARTS' && (
        <PartsView parts={parts} onSavePart={onSavePart} onRefreshParts={onRefresh} />
      )}

      {/* 3. ROUTINGS (مسیرهای تولید) */}
      {activeSection === 'ROUTINGS' && (
        <RoutingsView
          routings={routings}
          parts={parts}
          machines={machines}
          dies={dies}
          operations={operationsList}
          onSaveRouting={onSaveRouting}
          onDeleteRouting={onDeleteRouting}
          onDirectProduce={onDirectProduce}
          onSaveMachine={onSaveMachine}
          onSaveDie={onSaveDie}
        />
      )}

      {/* 4. MACHINES & DIES (ماشین‌آلات و قالب‌ها) */}
      {(activeSection === 'MACHINES' || activeSection === 'DIES') && (
        <MachinesView
          machines={machines}
          dies={dies}
          operators={operators}
          halls={hallsList}
          parts={parts}
          initialSubTab={activeSection === 'DIES' ? 'dies' : 'machines'}
          onSaveMachine={onSaveMachine}
          onSaveDie={onSaveDie}
          onDeleteDie={onDeleteDie}
          onSaveOperator={onSaveOperator}
          onSaveHall={onSaveHall}
        />
      )}

      {/* 4.5 FACTORY HALLS (سالن‌های تولید و استقرار خطوط) */}
      {activeSection === 'FACTORY_HALLS' && (() => {
        const filteredHalls = hallsList.filter(h =>
          !hallSearch.trim() ||
          h.code.toLowerCase().includes(hallSearch.toLowerCase()) ||
          h.name.toLowerCase().includes(hallSearch.toLowerCase()) ||
          (h.supervisorName && h.supervisorName.toLowerCase().includes(hallSearch.toLowerCase())) ||
          (h.capacityDesc && h.capacityDesc.toLowerCase().includes(hallSearch.toLowerCase()))
        );

        return (
          <div className="sap-card p-5 space-y-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-3 border-b border-[var(--fiori-border-subtle)]">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-[var(--fiori-text-primary)]">
                    سالن‌های تولید و موقعیت‌های استقرار ماشین‌آلات (Factory Production Halls)
                  </h3>
                  <FioriObjectStatus tone="info" size="sm" label={`${toPersianDigits(hallsList.length)} سالن تولید`} />
                </div>
                <p className="text-xs text-[var(--fiori-text-secondary)] mt-0.5">
                  تعریف، ویرایش و مدیریت سالن‌های پرس سنگین، پرس متوسط، جوشکاری رباتیک، خط رنگ کاتافورز ED، مونتاژ و انبارها
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEditingHall(null);
                  setHallForm({
                    code: `HALL-${String(hallsList.length + 1).padStart(2, '0')}`,
                    name: '',
                    type: 'STAMPING',
                    supervisorName: '',
                    capacityDesc: '',
                    description: '',
                    active: true,
                  });
                  setIsHallModalOpen(true);
                }}
                className="sap-btn-emphasized flex items-center gap-1.5 px-3.5 py-1.5 text-xs cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>تعریف سالن تولید جدید</span>
              </button>
            </div>

            {/* Search Bar */}
            <div className="relative max-w-md">
              <Search className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-[var(--fiori-text-muted)]" />
              <input
                type="text"
                placeholder="جستجو در کد، نام سالن، سرپرست یا مشخصات..."
                value={hallSearch}
                onChange={e => setHallSearch(e.target.value)}
                className="fiori-input w-full pr-9 pl-3 py-2 text-xs"
              />
            </div>

            {/* Halls Table */}
            <div className="sap-card overflow-hidden">
              <FioriToolbar
                variant="table"
                title="فهرست سالن‌های کارخانه"
                count={filteredHalls.length}
                countLabel="سالن"
              />
              {filteredHalls.length === 0 ? (
                <EmptyState
                  compact
                  variant={hallSearch.trim() ? 'SEARCH_NO_MATCH' : 'NO_DATA'}
                  title={hallSearch.trim() ? 'سالنی با این مشخصات یافت نشد' : 'سالن تولیدی ثبت نشده است'}
                  description={hallSearch.trim() ? 'عبارت جستجو را تغییر دهید.' : 'اولین سالن تولید را تعریف کنید.'}
                  actionLabel={hallSearch.trim() ? 'پاک کردن جستجو' : undefined}
                  onAction={hallSearch.trim() ? () => setHallSearch('') : undefined}
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="sap-table-compact w-full text-right text-xs">
                    <thead className="bg-[var(--fiori-bg-subtle)] text-[var(--fiori-text-primary)] font-semibold border-b border-[var(--fiori-border-default)]">
                      <tr>
                        <th className="text-center">کد سالن</th>
                        <th>نام و عنوان سالن تولید</th>
                        <th>نوع فرآیند کارگاهی</th>
                        <th>سرپرست / مسئول سالن</th>
                        <th>ظرفیت و تجهیزات مستقر</th>
                        <th className="text-center">پرس‌ها و ماشین‌های مستقر</th>
                        <th className="text-center">وضعیت</th>
                        <th className="text-center">عملیات</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--fiori-border-subtle)] text-[var(--fiori-text-primary)]">
                      {filteredHalls.map(hall => {
                        const machinesInHall = machines.filter(
                          m => m.hallId === hall.id || m.location === hall.name || m.location?.includes(hall.name)
                        );
                        return (
                          <tr key={hall.id} className="hover:bg-[var(--fiori-bg-hover)] transition-colors">
                            <td className="text-center">
                              <span className="fiori-ltr-code font-bold px-2 py-0.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)]">
                                {hall.code}
                              </span>
                            </td>
                            <td className="font-bold text-[var(--fiori-text-primary)]">
                              <div className="flex items-center gap-1.5">
                                <Building2 className="w-4 h-4 text-[var(--fiori-brand)] shrink-0" />
                                <span>{hall.name}</span>
                              </div>
                              {hall.description && (
                                <p className="text-[11px] text-[var(--fiori-text-secondary)] font-normal mt-0.5 line-clamp-1">
                                  {hall.description}
                                </p>
                              )}
                            </td>
                            <td>
                              <FioriObjectStatus
                                tone="neutral"
                                size="sm"
                                label={
                                  hall.type === 'STAMPING' ? 'پرسکاری و کشش' :
                                  hall.type === 'WELDING' ? 'جوشکاری و مونتاژ' :
                                  hall.type === 'PAINT' ? 'خط رنگ و کاتافورز' :
                                  hall.type === 'ASSEMBLY' ? 'مونتاژ نهایی' : 'انبار و لجستیک'
                                }
                              />
                            </td>
                            <td className="text-[var(--fiori-text-primary)]">
                              {hall.supervisorName || 'تعیین‌نشده'}
                            </td>
                            <td className="text-[var(--fiori-text-secondary)] max-w-xs truncate" title={hall.capacityDesc}>
                              {hall.capacityDesc || '—'}
                            </td>
                            <td className="text-center">
                              <FioriObjectStatus
                                tone="info"
                                size="sm"
                                icon={<Cpu className="w-3 h-3" />}
                                label={`${toPersianDigits(machinesInHall.length)} ماشین`}
                              />
                            </td>
                            <td className="text-center">
                              <FioriObjectStatus
                                tone={hall.active !== false ? 'positive' : 'neutral'}
                                size="sm"
                                label={hall.active !== false ? 'فعال' : 'غیرفعال'}
                              />
                            </td>
                            <td className="text-center">
                              <div className="flex items-center justify-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingHall(hall);
                                    setHallForm({ ...hall });
                                    setIsHallModalOpen(true);
                                  }}
                                  className="px-2 py-0.5 rounded-[var(--fiori-radius-sm)] text-[11px] font-semibold text-[var(--fiori-brand)] bg-[var(--fiori-info-bg)] hover:bg-[var(--fiori-bg-selected)] transition-colors cursor-pointer"
                                >
                                  ویرایش
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteHall(hall.id)}
                                  className="px-2 py-0.5 rounded-[var(--fiori-radius-sm)] text-[11px] font-semibold text-[var(--fiori-negative)] bg-[var(--fiori-negative-bg)] hover:opacity-80 transition-colors cursor-pointer"
                                >
                                  حذف
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* 5. BOM (درخت محصول پیشرفته چندسطحی) */}
      {activeSection === 'BOM' && (
        <AdvancedBomModuleView
          parts={parts}
          onNavigateToParallelFlow={() => setActiveSection('PARALLEL_FLOWS')}
        />
      )}

      {/* 5.0. PRODUCT STRUCTURE (ساختار درختی بازگشتی کالا) */}
      {activeSection === 'PRODUCT_STRUCTURE' && (
        <ProductStructureView parts={parts} />
      )}

      {/* 5.1. PARALLEL PRODUCTION & CO-PRODUCTION FLOWS */}
      {activeSection === 'PARALLEL_FLOWS' && (
        <ParallelProductionFlowView
          onNavigateToBom={() => setActiveSection('BOM')}
        />
      )}

      {/* 6. OPERATIONS (عملیات تولید استاندارد) */}
      {activeSection === 'OPERATIONS' && (() => {
        const filteredOps = operationsList.filter(op => {
          const matchCat =
            operationCategoryFilter === 'ALL' || op.category === operationCategoryFilter;
          const q = operationSearch.trim().toLowerCase();
          const matchSearch =
            !q ||
            op.code.toLowerCase().includes(q) ||
            op.name.toLowerCase().includes(q) ||
            op.stationType.toLowerCase().includes(q) ||
            (op.description && op.description.toLowerCase().includes(q));
          return matchCat && matchSearch;
        });

        return (
          <div className="sap-card p-5 space-y-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-3 border-b border-[var(--fiori-border-subtle)]">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-[var(--fiori-text-primary)]">
                    ایستگاه‌ها و عملیات استاندارد تولید (Standard Operations)
                  </h3>
                  <FioriObjectStatus tone="info" size="sm" label={`${toPersianDigits(operationsList.length)} عملیات تعریف‌شده`} />
                </div>
                <p className="text-xs text-[var(--fiori-text-secondary)] mt-0.5">
                  بانک اطلاعاتی عملیات استاندارد برش رول، بلنکینگ، کشش، خم، پرس‌جوش مهره، جوش CO2، پوشش الکتروفورز (ED) و بازرسی نهایی
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEditingOperation(null);
                  setOperationForm({
                    code: `OP-${(operationsList.length + 1) * 10}`,
                    name: '',
                    stationType: '',
                    cycleTimeSec: 4.5,
                    setupTimeMin: 20,
                    category: 'STAMPING',
                    description: '',
                    active: true,
                  });
                  setIsOperationModalOpen(true);
                }}
                className="sap-btn-emphasized flex items-center gap-1.5 px-3.5 py-1.5 text-xs cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>تعریف عملیات جدید</span>
              </button>
            </div>

            {/* Search & Filter Bar */}
            <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
              <div className="relative flex-1 max-w-md">
                <Search className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-[var(--fiori-text-muted)]" />
                <input
                  type="text"
                  placeholder="جستجو در کد، نام عملیات، ایستگاه یا توضیحات..."
                  value={operationSearch}
                  onChange={e => setOperationSearch(e.target.value)}
                  className="fiori-input w-full pr-9 pl-3 py-1.5 text-xs"
                />
                {operationSearch && (
                  <button
                    type="button"
                    onClick={() => setOperationSearch('')}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--fiori-text-muted)] hover:text-[var(--fiori-text-primary)] cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {[
                  { id: 'ALL', label: 'همه دسته‌ها' },
                  { id: 'SHEARING', label: 'برش و نواربری' },
                  { id: 'STAMPING', label: 'پرسکاری و کشش' },
                  { id: 'BENDING', label: 'خم‌کاری' },
                  { id: 'WELDING', label: 'جوش مقاومتی و CO2' },
                  { id: 'SURFACE_FINISH', label: 'رنگ و فسفاته' },
                  { id: 'QC_PACK', label: 'کنترل کیفی و پکینگ' },
                ].map(cat => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setOperationCategoryFilter(cat.id)}
                    className={`px-2.5 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-semibold transition-colors cursor-pointer border ${
                      operationCategoryFilter === cat.id
                        ? 'bg-[var(--fiori-brand)] text-white border-[var(--fiori-brand)]'
                        : 'bg-[var(--fiori-bg-surface)] text-[var(--fiori-text-secondary)] border-[var(--fiori-border-default)] hover:bg-[var(--fiori-bg-hover)]'
                    }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Operations Table */}
            <div className="sap-card overflow-hidden">
              <FioriToolbar
                variant="table"
                title="فهرست عملیات استاندارد"
                count={filteredOps.length}
                countLabel="عملیات"
              />
              {filteredOps.length === 0 ? (
                <EmptyState
                  compact
                  variant={operationSearch.trim() || operationCategoryFilter !== 'ALL' ? 'FILTER_NO_MATCH' : 'NO_DATA'}
                  title="عملیاتی یافت نشد"
                  description="جهت تعریف مرحله جدید دکمه «تعریف عملیات جدید» را بزنید یا فیلترها را پاک کنید."
                  actionLabel={operationSearch.trim() || operationCategoryFilter !== 'ALL' ? 'پاک کردن فیلترها' : undefined}
                  onAction={
                    operationSearch.trim() || operationCategoryFilter !== 'ALL'
                      ? () => {
                          setOperationSearch('');
                          setOperationCategoryFilter('ALL');
                        }
                      : undefined
                  }
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="sap-table-compact w-full text-right text-xs">
                    <thead className="bg-[var(--fiori-bg-subtle)] border-b border-[var(--fiori-border-default)] text-[var(--fiori-text-primary)] font-bold">
                      <tr>
                        <th>کد عملیات</th>
                        <th>عنوان عملیات</th>
                        <th>نوع ایستگاه / تجهیزات</th>
                        <th>دسته فرآیندی</th>
                        <th>زمان چرخه (ثانیه)</th>
                        <th>زمان تعویض قالب (دقیقه)</th>
                        <th>وضعیت</th>
                        <th className="text-center">اقدامات</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--fiori-border-subtle)] bg-[var(--fiori-bg-surface)]">
                      {filteredOps.map(op => {
                        const categoryMeta: Record<string, { label: string; tone: 'info' | 'critical' | 'neutral' | 'positive' }> = {
                          SHEARING: { label: 'برشکاری', tone: 'critical' },
                          STAMPING: { label: 'پرسکاری', tone: 'info' },
                          BENDING: { label: 'خم‌کاری', tone: 'info' },
                          WELDING: { label: 'جوشکاری', tone: 'critical' },
                          SURFACE_FINISH: { label: 'رنگ و پوشش', tone: 'neutral' },
                          QC_PACK: { label: 'کنترل و بسته‌بندی', tone: 'positive' },
                        };
                        const catMeta = categoryMeta[op.category] || { label: op.category, tone: 'neutral' as const };

                        return (
                          <tr key={op.id || op.code} className="hover:bg-[var(--fiori-bg-hover)] transition-colors">
                            <td className="fiori-ltr-code font-bold text-[var(--fiori-text-primary)]">{op.code}</td>
                            <td>
                              <div className="font-semibold text-[var(--fiori-text-primary)]">{op.name}</div>
                              {op.description && (
                                <div className="text-[11px] text-[var(--fiori-text-secondary)] mt-0.5 line-clamp-1">{op.description}</div>
                              )}
                            </td>
                            <td className="text-[var(--fiori-text-primary)] font-medium">{op.stationType}</td>
                            <td>
                              <FioriObjectStatus tone={catMeta.tone} size="sm" label={catMeta.label} />
                            </td>
                            <td className="tabular-nums font-bold text-[var(--fiori-text-primary)]">
                              {toPersianDigits(op.cycleTimeSec)} ثانیه
                            </td>
                            <td className="tabular-nums text-[var(--fiori-text-secondary)]">
                              {toPersianDigits(op.setupTimeMin)} دقیقه
                            </td>
                            <td>
                              <FioriObjectStatus
                                tone={op.active !== false ? 'positive' : 'neutral'}
                                size="sm"
                                label={op.active !== false ? 'فعال' : 'غیرفعال'}
                              />
                            </td>
                            <td>
                              <div className="flex items-center justify-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingOperation(op);
                                    setOperationForm({ ...op });
                                    setIsOperationModalOpen(true);
                                  }}
                                  className="px-2 py-0.5 rounded-[var(--fiori-radius-sm)] text-[11px] font-semibold text-[var(--fiori-brand)] bg-[var(--fiori-info-bg)] hover:bg-[var(--fiori-bg-selected)] transition-colors cursor-pointer"
                                >
                                  ویرایش
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingOperation(null);
                                    setOperationForm({
                                      ...op,
                                      id: undefined,
                                      code: `${op.code}-COPY`,
                                      name: `${op.name} (کپی)`,
                                    });
                                    setIsOperationModalOpen(true);
                                  }}
                                  className="sap-btn-standard px-2 py-0.5 text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer"
                                  title="کپی‌گیری سریع (Duplicate) برای ایجاد عملیات مشابه"
                                >
                                  <Copy className="w-3 h-3" />
                                  <span>کپی‌گیری</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteOperation(op.id || op.code)}
                                  className="px-2 py-0.5 rounded-[var(--fiori-radius-sm)] text-[11px] font-semibold text-[var(--fiori-negative)] bg-[var(--fiori-negative-bg)] hover:opacity-80 transition-colors cursor-pointer"
                                >
                                  حذف
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* 7. WAREHOUSES, UNITS, SHIFTS, CUSTOMERS, CAR_MODELS, ORDERS */}
      {(activeSection === 'WAREHOUSES' ||
        activeSection === 'UNITS' ||
        activeSection === 'SHIFTS' ||
        activeSection === 'CUSTOMERS' ||
        activeSection === 'CAR_MODELS' ||
        activeSection === 'ORDERS') && (
        <div className="sap-card p-5 space-y-4">
          {activeSection === 'WAREHOUSES' && (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-2 border-b border-[var(--fiori-border-subtle)]">
                <div>
                  <h3 className="text-sm font-bold text-[var(--fiori-text-primary)]">انبارها و موقعیت‌های استقرار مواد و قطعات</h3>
                  <p className="text-xs text-[var(--fiori-text-secondary)] mt-0.5">مدیریت انبارهای مواد اولیه، پای خط (WIP)، محصول نهایی و ضایعات</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setEditingWarehouse(null);
                    setWarehouseForm({
                      code: `WH-${Date.now().toString().slice(-4)}`,
                      name: '',
                      type: 'RAW_MATERIALS',
                      managerName: '',
                      locations: ['LOC-01'],
                    });
                    setIsWarehouseModalOpen(true);
                  }}
                  className="sap-btn-emphasized flex items-center gap-1.5 px-3.5 py-1.5 text-xs cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>تعریف انبار جدید</span>
                </button>
              </div>

              {warehousesList.length === 0 ? (
                <EmptyState
                  compact
                  variant="NO_DATA"
                  title="هیچ انباری تعریف نشده است"
                  description="جهت ایجاد انبار دکمه «تعریف انبار جدید» را بزنید."
                />
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
                  {warehousesList.map(w => (
                    <div key={w.id || w.code} className="p-4 rounded-[var(--fiori-radius-md)] border border-[var(--fiori-border-default)] bg-[var(--fiori-bg-subtle)] space-y-2 relative group hover:border-[var(--fiori-brand)] transition-colors">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold text-[var(--fiori-text-primary)] text-sm">{w.name}</span>
                        <FioriObjectStatus
                          tone="positive"
                          size="sm"
                          label={w.type === 'RAW_MATERIALS' ? 'مواد اولیه' : w.type === 'WIP' ? 'پای کار (WIP)' : w.type === 'FINISHED_GOODS' ? 'محصول نهایی' : w.type === 'SCRAP' ? 'ضایعات' : 'ابزار/قالب'}
                        />
                      </div>
                      <div className="text-[var(--fiori-text-secondary)]">
                        کد انبار: <span className="fiori-ltr-code font-bold text-[var(--fiori-text-primary)]">{w.code}</span>
                        {w.managerName && <span> — مسوول: {w.managerName}</span>}
                      </div>
                      {w.locations && w.locations.length > 0 && (
                        <div className="text-[var(--fiori-text-secondary)] text-[11px] flex items-center gap-1">
                          <MapPin className="w-3.5 h-3.5 text-[var(--fiori-text-muted)] shrink-0" />
                          <span>موقعیت‌ها: {w.locations.join(' ، ')}</span>
                        </div>
                      )}
                      <div className="flex items-center justify-end gap-1.5 pt-2 border-t border-[var(--fiori-border-subtle)]">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingWarehouse(w);
                            setWarehouseForm({ ...w });
                            setIsWarehouseModalOpen(true);
                          }}
                          className="px-2 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-semibold text-[var(--fiori-brand)] hover:bg-[var(--fiori-info-bg)] transition-colors cursor-pointer"
                        >
                          ویرایش
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteWarehouse(w.id || w.code)}
                          className="px-2 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-semibold text-[var(--fiori-negative)] hover:bg-[var(--fiori-negative-bg)] transition-colors cursor-pointer"
                        >
                          حذف
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeSection === 'UNITS' && (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-2 border-b border-[var(--fiori-border-subtle)]">
                <div>
                  <h3 className="text-sm font-bold text-[var(--fiori-text-primary)]">واحدهای شمارش و ضرایب تبدیل مهندسی</h3>
                  <p className="text-xs text-[var(--fiori-text-secondary)] mt-0.5">واحدهای پایه شمارش قطعات، وزن کلاف و تبدیل برگه به کیلوگرم</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setEditingUnit(null);
                    setUnitForm({ symbol: '', title: '', description: '', conversionFactorToKg: 1, isBaseUnit: false });
                    setIsUnitModalOpen(true);
                  }}
                  className="sap-btn-emphasized flex items-center gap-1.5 px-3.5 py-1.5 text-xs cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>تعریف واحد جدید</span>
                </button>
              </div>

              {/* Informative helper box on conversion factors */}
              <FioriMessageStrip tone="warning" title="راهنمای مهندسی واحدها">
                <div className="space-y-1 text-[11px] leading-relaxed">
                  <p>
                    <strong>ضریب تبدیل به کیلوگرم:</strong> نشان‌دهنده وزن معادل هر یک واحد به کیلوگرم است (مثلاً برای «برگ ورق ST12» برابر با ۲۴/۵ کیلوگرم و برای «رول استاندارد» برابر با ۵,۰۰۰ کیلوگرم). این ضریب در محاسبات موازنه جرم آهن (Mass Balance) و محاسبه کسری کلاف در MRP مبنای تبدیل است.
                  </p>
                  <p>
                    <strong>واحد مبنای سیستم:</strong> واحدی است که تمامی گزارش‌های کاردکس و تراز انبار بر اساس آن همگن‌سازی می‌شوند (کیلوگرم برای مواد وزنی و عدد برای قطعات پرس).
                  </p>
                </div>
              </FioriMessageStrip>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                {unitsList.map(u => (
                  <div key={u.id || u.symbol} className="p-4 rounded-[var(--fiori-radius-md)] border border-[var(--fiori-border-default)] bg-[var(--fiori-bg-subtle)] space-y-1.5 hover:border-[var(--fiori-brand)] transition-colors">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm fiori-ltr-code font-bold text-[var(--fiori-positive)]">{u.symbol}</div>
                      {u.isBaseUnit && (
                        <FioriObjectStatus tone="positive" size="sm" label="واحد مبنا" />
                      )}
                    </div>
                    <div className="font-bold text-[var(--fiori-text-primary)]">{u.title}</div>
                    <div className="text-[var(--fiori-text-secondary)] text-[11px] leading-relaxed">{u.description}</div>
                    {u.conversionFactorToKg !== undefined && (
                      <div className="text-[11px] text-[var(--fiori-text-primary)] font-medium bg-[var(--fiori-bg-surface)] px-2 py-1 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] mt-1">
                        ضریب به کیلوگرم: <span className="font-mono font-bold tabular-nums">{u.conversionFactorToKg}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-end gap-1.5 pt-2 border-t border-[var(--fiori-border-subtle)]">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingUnit(u);
                          setUnitForm({ ...u });
                          setIsUnitModalOpen(true);
                        }}
                        className="px-2 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-semibold text-[var(--fiori-brand)] hover:bg-[var(--fiori-info-bg)] transition-colors cursor-pointer"
                      >
                        ویرایش
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteUnit(u.id || u.symbol)}
                        className="px-2 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-semibold text-[var(--fiori-negative)] hover:bg-[var(--fiori-negative-bg)] transition-colors cursor-pointer"
                      >
                        حذف
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeSection === 'SHIFTS' && (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-2 border-b border-[var(--fiori-border-subtle)]">
                <div>
                  <h3 className="text-sm font-bold text-[var(--fiori-text-primary)]">شیفت‌های کاری، اضافه‌کاری و تقویم ظرفیت تولید</h3>
                  <p className="text-xs text-[var(--fiori-text-secondary)] mt-0.5">تعریف ساعات کاری شیفت‌ها، زمان خالص کارکرد و برنامه‌ریزی MRP</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setEditingShift(null);
                    setShiftForm({
                      code: `SHIFT-${Date.now().toString().slice(-3)}`,
                      name: '',
                      startTime: '07:00',
                      endTime: '14:30',
                      netWorkMinutes: 450,
                      status: 'ACTIVE',
                      hasOvertime: true,
                      overtimeStartTime: '15:00',
                      overtimeEndTime: '17:00',
                      overtimeMinutes: 120,
                      overtimeDaysDescription: 'شنبه تا چهارشنبه',
                      thursdayStatus: 'OVERTIME_15_17',
                    });
                    setIsShiftModalOpen(true);
                  }}
                  className="sap-btn-emphasized flex items-center gap-1.5 px-3.5 py-1.5 text-xs cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>تعریف شیفت جدید</span>
                </button>
              </div>

              {/* Weekly Shift Scenario Banner */}
              <div className="p-4 bg-[var(--fiori-info-bg)] border border-[var(--fiori-info-border)] rounded-[var(--fiori-radius-md)] text-xs space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-bold text-[var(--fiori-text-primary)] text-sm">سناریوی زمان‌بندی و تقویم ظرفیت شیفت کارخانه:</span>
                  <FioriObjectStatus
                    tone="info"
                    size="sm"
                    label="مجموع ظرفیت هفتگی: ۳۷/۵ ساعت کار عادی + ۱۰ تا ۱۲ ساعت اضافه‌کاری"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-[11px] text-[var(--fiori-text-primary)]">
                  <div className="bg-[var(--fiori-bg-surface)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-info-border)] space-y-1">
                    <span className="font-bold text-[var(--fiori-brand)]">۱. شیفت عادی (شنبه تا چهارشنبه):</span>
                    <p className="text-[var(--fiori-text-secondary)]">ساعت ۰۷:۰۰ صبح تا ۱۴:۳۰ بعدازظهر (۷ ساعت کار خالص مفید + ۳۰ دقیقه ناهار = ۴۵۰ دقیقه ظرفیت مفید اسمی)</p>
                  </div>
                  <div className="bg-[var(--fiori-bg-surface)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-info-border)] space-y-1">
                    <span className="font-bold text-[var(--fiori-brand)]">۲. اضافه‌کاری عادی (شنبه تا چهارشنبه):</span>
                    <p className="text-[var(--fiori-text-secondary)]">ساعت ۱۵:۰۰ تا ۱۷:۰۰ بعدازظهر (۲ ساعت معادل ۱۲۰ دقیقه اضافه‌کاری خطوط پرس و مونتاژ)</p>
                  </div>
                  <div className="bg-[var(--fiori-bg-surface)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-info-border)] space-y-1">
                    <span className="font-bold text-[var(--fiori-brand)]">۳. مدیریت منعطف روز پنجشنبه:</span>
                    <p className="text-[var(--fiori-text-secondary)]">تنظیم پویا در تقویم: ۱. تعطیل کامل | ۲. فقط اضافه‌کاری ۱۵ الی ۱۷ | ۳. شیفت کامل عادی</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
                {shiftsList.map(sh => (
                  <div key={sh.id || sh.code} className="p-4 rounded-[var(--fiori-radius-md)] border border-[var(--fiori-border-default)] bg-[var(--fiori-bg-subtle)] space-y-2.5 hover:border-[var(--fiori-brand)] transition-colors">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-[var(--fiori-text-primary)] text-sm">{sh.name}</span>
                      <FioriObjectStatus
                        tone={sh.status === 'ACTIVE' ? 'positive' : 'neutral'}
                        size="sm"
                        label={sh.status === 'ACTIVE' ? 'فعال' : 'غیرفعال'}
                      />
                    </div>

                    <div className="bg-[var(--fiori-bg-surface)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] space-y-1 text-[11px]">
                      <div className="flex justify-between text-[var(--fiori-text-secondary)]">
                        <span>ساعات عادی:</span>
                        <span className="font-mono font-bold text-[var(--fiori-text-primary)] tabular-nums">{sh.startTime} الی {sh.endTime}</span>
                      </div>
                      <div className="flex justify-between text-[var(--fiori-text-secondary)]">
                        <span>کار مفید عادی:</span>
                        <span className="font-bold text-[var(--fiori-positive)] tabular-nums">{toPersianDigits(sh.netWorkMinutes)} دقیقه (۷ ساعت کار + ۳۰ دقیقه ناهار)</span>
                      </div>
                    </div>

                    {sh.hasOvertime && (
                      <div className="bg-[var(--fiori-critical-bg)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-critical-border)] space-y-1 text-[11px]">
                        <div className="flex justify-between text-[var(--fiori-text-primary)] font-semibold">
                          <span>اضافه‌کاری روزانه:</span>
                          <span className="font-mono font-bold tabular-nums">{sh.overtimeStartTime || '15:00'} الی {sh.overtimeEndTime || '17:00'}</span>
                        </div>
                        <div className="flex justify-between text-[var(--fiori-critical)]">
                          <span>روزها:</span>
                          <span className="tabular-nums">{sh.overtimeDaysDescription || 'شنبه تا چهارشنبه'} ({toPersianDigits(sh.overtimeMinutes || 120)} دقیقه)</span>
                        </div>
                      </div>
                    )}

                    <div className="text-[11px] flex items-center justify-between bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-subtle)] p-2 rounded-[var(--fiori-radius-sm)]">
                      <span className="text-[var(--fiori-text-secondary)]">وضعیت پنجشنبه:</span>
                      <span className="font-bold text-[var(--fiori-text-primary)]">
                        {sh.thursdayStatus === 'OFF'
                          ? 'تعطیل کامل'
                          : sh.thursdayStatus === 'OVERTIME_15_17'
                          ? 'اضافه‌کاری ۱۵ الی ۱۷'
                          : 'شیفت کامل کاری'}
                      </span>
                    </div>

                    <div className="flex items-center justify-end gap-1.5 pt-2 border-t border-[var(--fiori-border-subtle)]">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingShift(sh);
                          setShiftForm({ ...sh });
                          setIsShiftModalOpen(true);
                        }}
                        className="px-2.5 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-semibold text-[var(--fiori-brand)] hover:bg-[var(--fiori-info-bg)] transition-colors cursor-pointer"
                      >
                        ویرایش زمان‌بندی
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteShift(sh.id || sh.code)}
                        className="px-2.5 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-semibold text-[var(--fiori-negative)] hover:bg-[var(--fiori-negative-bg)] transition-colors cursor-pointer"
                      >
                        حذف
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeSection === 'CAR_MODELS' && (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-2 border-b border-[var(--fiori-border-subtle)]">
                <div>
                  <h3 className="text-sm font-bold text-[var(--fiori-text-primary)]">مدل‌های خودرو و خانواده محصول (Car Models & Platforms)</h3>
                  <p className="text-xs text-[var(--fiori-text-secondary)] mt-0.5">
                    تعریف خانواده محصولات و خودروهای طرف قرارداد (ایران‌خودرو، سایپا و...) جهت انتساب یکپارچه به قطعات، فیلترهای مسیر تولید و سفارشات
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setEditingCarModel(null);
                    setCarModelForm({
                      code: `MDL-${Date.now().toString().slice(-4)}`,
                      name: '',
                      oem: 'ساپکو (ایران‌خودرو)',
                      description: '',
                      active: true,
                    });
                    setIsCarModelModalOpen(true);
                  }}
                  className="sap-btn-emphasized flex items-center gap-1.5 px-3.5 py-1.5 text-xs cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>تعریف مدل خودرو جدید</span>
                </button>
              </div>

              {/* Car Models Table */}
              <div className="sap-card overflow-hidden">
                <FioriToolbar
                  variant="table"
                  title="فهرست مدل‌های خودرو"
                  count={carModelsList.length}
                  countLabel="مدل"
                />
                {carModelsList.length === 0 ? (
                  <EmptyState
                    compact
                    variant="NO_DATA"
                    title="مدل خودرویی تعریف نشده است"
                    description="جهت افزودن اولین مدل خودرو دکمه «تعریف مدل خودرو جدید» را بزنید."
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="sap-table-compact w-full text-right text-xs">
                      <thead className="bg-[var(--fiori-bg-subtle)] border-b border-[var(--fiori-border-default)] text-[var(--fiori-text-primary)] font-bold">
                        <tr>
                          <th>کد شناسه</th>
                          <th>نام مدل خودرو</th>
                          <th>خودروساز / OEM</th>
                          <th>توضیحات و پلتفرم</th>
                          <th className="text-center">قطعات متصل در کاتالوگ</th>
                          <th className="text-center">وضعیت</th>
                          <th className="text-center">عملیات</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--fiori-border-subtle)] text-[var(--fiori-text-primary)]">
                        {carModelsList.map(m => {
                          const connectedPartsCount = parts.filter(
                            p => p.carModel === m.name || p.carModel?.includes(m.name)
                          ).length;
                          return (
                            <tr key={m.id || m.code} className="hover:bg-[var(--fiori-bg-hover)] transition-colors">
                              <td className="fiori-ltr-code font-bold text-[var(--fiori-text-primary)]">{m.code}</td>
                              <td className="font-bold text-[var(--fiori-text-primary)]">{m.name}</td>
                              <td className="font-semibold text-[var(--fiori-text-secondary)]">{m.oem}</td>
                              <td className="text-[var(--fiori-text-secondary)]">{m.description || '—'}</td>
                              <td className="text-center">
                                <FioriObjectStatus tone="neutral" size="sm" label={`${toPersianDigits(connectedPartsCount)} قطعه`} />
                              </td>
                              <td className="text-center">
                                <FioriObjectStatus
                                  tone={m.active ? 'positive' : 'neutral'}
                                  size="sm"
                                  label={m.active ? 'فعال' : 'غیرفعال'}
                                />
                              </td>
                              <td className="text-center">
                                <div className="flex items-center justify-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingCarModel(m);
                                      setCarModelForm({ ...m });
                                      setIsCarModelModalOpen(true);
                                    }}
                                    className="text-[var(--fiori-brand)] hover:text-[var(--fiori-brand-hover)] font-semibold cursor-pointer"
                                  >
                                    ویرایش
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteCarModel(m.id || m.code)}
                                    className="text-[var(--fiori-negative)] hover:underline font-semibold cursor-pointer"
                                  >
                                    حذف
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeSection === 'CUSTOMERS' && (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-2 border-b border-[var(--fiori-border-subtle)]">
                <div>
                  <h3 className="text-sm font-bold text-[var(--fiori-text-primary)]">مشتریان و شرکت‌های خودروساز طرف قرارداد</h3>
                  <p className="text-xs text-[var(--fiori-text-secondary)] mt-0.5">فهرست مشتریان، قراردادهای ورق امانی و تحویل قطعات</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setEditingCustomer(null);
                    setCustomerForm({ code: `CUST-${Date.now().toString().slice(-4)}`, name: '', contractType: 'تامین قطعات پرسی بدنه', phone: '', email: '', isDefault: false });
                    setIsCustomerModalOpen(true);
                  }}
                  className="sap-btn-emphasized flex items-center gap-1.5 px-3.5 py-1.5 text-xs cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>تعریف مشتری جدید</span>
                </button>
              </div>

              {customersList.length === 0 ? (
                <EmptyState
                  compact
                  variant="NO_DATA"
                  title="مشتری ثبت نشده است"
                  description="برای تعریف اولین مشتری دکمه «تعریف مشتری جدید» را بزنید."
                />
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                  {customersList.map(c => (
                    <div key={c.id || c.code} className="p-4 rounded-[var(--fiori-radius-md)] border border-[var(--fiori-border-default)] bg-[var(--fiori-bg-subtle)] space-y-2 hover:border-[var(--fiori-brand)] transition-colors">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold text-[var(--fiori-text-primary)] text-sm">{c.name}</span>
                        {c.isDefault && (
                          <FioriObjectStatus tone="positive" size="sm" label="پیش‌فرض سیستم" />
                        )}
                      </div>
                      <div className="text-[var(--fiori-text-secondary)]">{c.contractType}</div>
                      {c.phone && <div className="text-[var(--fiori-text-secondary)] text-[11px] flex items-center gap-1"><Phone className="w-3.5 h-3.5 text-[var(--fiori-text-muted)]" /><span>تلفن: {c.phone}</span></div>}
                      {c.email && <div className="text-[var(--fiori-text-secondary)] text-[11px] flex items-center gap-1"><Mail className="w-3.5 h-3.5 text-[var(--fiori-text-muted)]" /><span>ایمیل: {c.email}</span></div>}
                      <div className="flex items-center justify-end gap-1.5 pt-2 border-t border-[var(--fiori-border-subtle)]">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingCustomer(c);
                            setCustomerForm({ ...c });
                            setIsCustomerModalOpen(true);
                          }}
                          className="px-2 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-semibold text-[var(--fiori-brand)] hover:bg-[var(--fiori-info-bg)] transition-colors cursor-pointer"
                        >
                          ویرایش
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteCustomer(c.id || c.code)}
                          className="px-2 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-semibold text-[var(--fiori-negative)] hover:bg-[var(--fiori-negative-bg)] transition-colors cursor-pointer"
                        >
                          حذف
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeSection === 'ORDERS' && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 py-2">
              <div>
                <h3 className="text-sm font-bold text-[var(--fiori-text-primary)]">
                  سفارشات مشتریان و برنامه‌های تحویل (Sales & Delivery Orders)
                </h3>
                <p className="text-xs text-[var(--fiori-text-secondary)] mt-1">
                  سفارشات مشتریان به صورت یکپارچه در موتور برنامه‌ریزی تولید و نیازسنجی مواد (MRP) مدیریت و به قراردادهای ورق متصل می‌شوند.
                </p>
              </div>
              {onNavigateToPlanning && (
                <button
                  type="button"
                  onClick={onNavigateToPlanning}
                  className="sap-btn-emphasized px-4 py-2 text-xs cursor-pointer shrink-0"
                >
                  باز کردن سفارشات در ماژول برنامه‌ریزی تولید (MRP) ←
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Modal for Adding / Editing Complete Raw Material & Sheet Spec */}
      <FioriDialog
        isOpen={isNewSheetModalOpen}
        onClose={() => {
          setIsNewSheetModalOpen(false);
          setEditingSheet(null);
          setShowInlineAddGrade(false);
        }}
        title={editingSheet ? 'ویرایش کامل مشخصات ماده اولیه و ورق' : 'تعریف کامل ماده اولیه و ورق جدید (Master Item Catalog)'}
        subtitle="اطلاعات این فرم همزمان در جدول مواد اولیه و کاتالوگ کل انبار قطعات ثبت می‌شود."
        size="lg"
        footer={
          <>
            <button
              type="button"
              onClick={() => {
                setIsNewSheetModalOpen(false);
                setEditingSheet(null);
                setShowInlineAddGrade(false);
              }}
              className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="mdh-sheet-form"
              disabled={isSavingSheet}
              className="sap-btn-emphasized px-5 py-1.5 text-xs font-bold cursor-pointer disabled:opacity-50"
            >
              {isSavingSheet ? 'در حال ذخیره...' : 'ذخیره مشخصات و همگام‌سازی با انبار قطعات'}
            </button>
          </>
        }
      >
        <form id="mdh-sheet-form" onSubmit={handleSaveSheetSpec} className="space-y-3.5 text-xs">
          {/* Row 1: Code, Material Grade (Editable & Manageable), Supply Form */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block font-bold text-[var(--fiori-text-primary)] mb-1">کد ماده اولیه (انگلیسی) *</label>
              <input
                type="text"
                required
                dir="ltr"
                value={sheetForm.code || ''}
                onChange={e => setSheetForm({ ...sheetForm, code: e.target.value })}
                placeholder="مثلاً SHT-DC04-1.2"
                className="fiori-input fiori-ltr-code w-full px-2.5 py-1.5"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="font-bold text-[var(--fiori-text-primary)]">گرید و جنس ورق *</label>
                <button
                  type="button"
                  onClick={() => setShowInlineAddGrade(prev => !prev)}
                  className="text-[10px] font-bold text-[var(--fiori-brand)] hover:underline cursor-pointer"
                >
                  {showInlineAddGrade ? 'بستن افزودن سریع' : '+ افزودن جنس جدید'}
                </button>
              </div>
              <select
                value={sheetForm.grade || materialGrades[0]?.code || 'ST12'}
                onChange={e => {
                  const nextCode = e.target.value;
                  const found = materialGrades.find(g => g.code === nextCode);
                  const nextDensity = found?.densityGCm3 || sheetForm.densityGCm3 || 7.85;
                  const autoWeight = computeTheoreticalSheetWeight(
                    sheetForm.thicknessMm,
                    sheetForm.widthMm,
                    sheetForm.lengthMm,
                    nextDensity
                  );
                  setSheetForm({
                    ...sheetForm,
                    grade: nextCode,
                    densityGCm3: nextDensity,
                    standard: found?.standard || sheetForm.standard,
                    ...(autoWeight > 0 ? { sheetWeightKg: autoWeight } : {}),
                  });
                }}
                className="fiori-input w-full px-2.5 py-1.5 font-semibold cursor-pointer"
              >
                {materialGrades.map(g => (
                  <option key={g.id} value={g.code}>
                    {g.code} — {g.name}
                  </option>
                ))}
                {sheetForm.grade &&
                  !materialGrades.some(g => g.code.toUpperCase() === sheetForm.grade!.toUpperCase()) && (
                    <option value={sheetForm.grade}>{sheetForm.grade} (سفارشی)</option>
                  )}
              </select>
              <div className="mt-0.5 flex items-center justify-between text-[10px] text-[var(--fiori-text-secondary)]">
                <span>منبع: بانک گریدهای کارخانه</span>
                <button
                  type="button"
                  onClick={() => setIsGradeManagerOpen(true)}
                  className="text-[var(--fiori-brand)] hover:underline cursor-pointer"
                >
                  ویرایش کل لیست ↗
                </button>
              </div>
            </div>

            <div>
              <label className="block font-bold text-[var(--fiori-text-primary)] mb-1">شکل عرضه / نوع ماده</label>
              <select
                value={sheetForm.supplyForm || 'SHEET'}
                onChange={e =>
                  setSheetForm({
                    ...sheetForm,
                    supplyForm: e.target.value as RawSheetSpec['supplyForm'],
                  })
                }
                className="fiori-input w-full px-2.5 py-1.5 cursor-pointer"
              >
                <option value="COIL">رول / کلاف ورق (Coil)</option>
                <option value="SHEET">شیت ورق برش‌خورده (Sheet)</option>
                <option value="STRIP">نوار رول‌بری شده (Strip)</option>
                <option value="OTHER">لوله / پروفیل / سایر مواد اولیه</option>
              </select>
            </div>
          </div>

          {/* Inline Quick Add New Material Grade Box */}
          {showInlineAddGrade && (
            <div className="p-3 bg-[var(--fiori-info-bg)] border border-[var(--fiori-info-border)] rounded-[var(--fiori-radius-sm)] space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-[var(--fiori-brand)]">
                  افزودن سریع گرید / جنس ورق جدید به فهرست دائمی سامانه
                </span>
                <button
                  type="button"
                  onClick={() => setShowInlineAddGrade(false)}
                  className="text-[var(--fiori-text-muted)] hover:text-[var(--fiori-text-primary)] cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                <input
                  type="text"
                  dir="ltr"
                  value={inlineGradeCode}
                  onChange={e => setInlineGradeCode(e.target.value)}
                  placeholder="کد گرید (مثلاً ST52)"
                  className="fiori-input fiori-ltr-code px-2 py-1 text-xs"
                />
                <input
                  type="text"
                  value={inlineGradeName}
                  onChange={e => setInlineGradeName(e.target.value)}
                  placeholder="شرح جنس (مثلاً ورق سیاه ST52)"
                  className="fiori-input px-2 py-1 text-xs"
                />
                <select
                  value={inlineGradeCategory}
                  onChange={e => setInlineGradeCategory(e.target.value as MaterialGradeCategory)}
                  className="fiori-input px-2 py-1 text-xs"
                >
                  {Object.entries(MATERIAL_GRADE_CATEGORIES).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    step="0.01"
                    value={inlineGradeDensity}
                    onChange={e => setInlineGradeDensity(e.target.value)}
                    placeholder="چگالی 7.85"
                    title="چگالی بر حسب گرم بر سانتی‌متر مکعب"
                    className="fiori-input fiori-ltr-code w-20 px-2 py-1 text-xs"
                  />
                  <button
                    type="button"
                    onClick={handleQuickInlineAddGrade}
                    className="flex-1 sap-btn-emphasized px-2.5 py-1 text-[11px] font-bold cursor-pointer whitespace-nowrap"
                  >
                    ثبت و انتخاب
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Row 2: Full Name */}
          <div>
            <label className="block font-bold text-[var(--fiori-text-primary)] mb-1">نام کامل ماده اولیه *</label>
            <input
              type="text"
              required
              value={sheetForm.name || ''}
              onChange={e => setSheetForm({ ...sheetForm, name: e.target.value })}
              placeholder="مثلاً: ورق روغنی فوق‌کشش DC04 ضخامت ۱/۲ میلی‌متر عرض ۱۲۵۰"
              className="fiori-input w-full px-2.5 py-1.5"
            />
          </div>

          {/* Row 3: Dimensions & Auto Weight Calculator */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className="block font-bold text-[var(--fiori-text-primary)] mb-1">ضخامت (mm)</label>
              <input
                type="number"
                step="0.05"
                value={sheetForm.thicknessMm ?? 1.0}
                onChange={e => {
                  const t = parseFloat(e.target.value) || 0;
                  const autoW = computeTheoreticalSheetWeight(t, sheetForm.widthMm, sheetForm.lengthMm, sheetForm.densityGCm3);
                  setSheetForm({
                    ...sheetForm,
                    thicknessMm: t,
                    ...(autoW > 0 ? { sheetWeightKg: autoW } : {}),
                  });
                }}
                className="fiori-input fiori-ltr-code w-full px-2.5 py-1.5"
              />
            </div>
            <div>
              <label className="block font-bold text-[var(--fiori-text-primary)] mb-1">عرض ورق/رول (mm)</label>
              <input
                type="number"
                step="1"
                value={sheetForm.widthMm ?? ''}
                onChange={e => {
                  const w = parseFloat(e.target.value) || 0;
                  const l = Number(sheetForm.lengthMm) || 0;
                  const autoWeight = computeTheoreticalSheetWeight(sheetForm.thicknessMm, w, l, sheetForm.densityGCm3);
                  setSheetForm({
                    ...sheetForm,
                    widthMm: w || undefined,
                    dimensionsMm:
                      w > 0 && l > 0
                        ? `${toPersianDigits(w.toLocaleString('en-US'))} × ${toPersianDigits(l.toLocaleString('en-US'))}`
                        : sheetForm.dimensionsMm,
                    ...(autoWeight > 0 ? { sheetWeightKg: autoWeight } : {}),
                  });
                }}
                placeholder="مثلاً 1250"
                className="fiori-input fiori-ltr-code w-full px-2.5 py-1.5"
              />
            </div>
            <div>
              <label className="block font-bold text-[var(--fiori-text-primary)] mb-1">طول شیت (mm)</label>
              <input
                type="number"
                step="1"
                value={sheetForm.lengthMm ?? ''}
                onChange={e => {
                  const l = parseFloat(e.target.value) || 0;
                  const w = Number(sheetForm.widthMm) || 0;
                  const autoWeight = computeTheoreticalSheetWeight(sheetForm.thicknessMm, w, l, sheetForm.densityGCm3);
                  setSheetForm({
                    ...sheetForm,
                    lengthMm: l || undefined,
                    dimensionsMm:
                      w > 0 && l > 0
                        ? `${toPersianDigits(w.toLocaleString('en-US'))} × ${toPersianDigits(l.toLocaleString('en-US'))}`
                        : sheetForm.dimensionsMm,
                    ...(autoWeight > 0 ? { sheetWeightKg: autoWeight } : {}),
                  });
                }}
                placeholder="مثلاً 2500"
                className="fiori-input fiori-ltr-code w-full px-2.5 py-1.5"
              />
            </div>
            <div>
              <label className="block font-bold text-[var(--fiori-text-primary)] mb-1">چگالی (g/cm³)</label>
              <input
                type="number"
                step="0.01"
                value={sheetForm.densityGCm3 ?? 7.85}
                onChange={e => {
                  const d = parseFloat(e.target.value) || 7.85;
                  const autoWeight = computeTheoreticalSheetWeight(sheetForm.thicknessMm, sheetForm.widthMm, sheetForm.lengthMm, d);
                  setSheetForm({
                    ...sheetForm,
                    densityGCm3: d,
                    ...(autoWeight > 0 ? { sheetWeightKg: autoWeight } : {}),
                  });
                }}
                className="fiori-input fiori-ltr-code w-full px-2.5 py-1.5"
              />
            </div>
          </div>

          {/* Row 4: Unit Weight, Dimensions text, Unit of Measure, Reorder Point */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className="block font-bold text-[var(--fiori-text-primary)] mb-1">وزن هر برگ / واحد (kg)</label>
              <input
                type="number"
                step="0.01"
                value={sheetForm.sheetWeightKg ?? 24.5}
                onChange={e =>
                  setSheetForm({ ...sheetForm, sheetWeightKg: parseFloat(e.target.value) || 0 })
                }
                className="fiori-input fiori-ltr-code w-full px-2.5 py-1.5"
              />
            </div>
            <div>
              <label className="block font-bold text-[var(--fiori-text-primary)] mb-1">متن ابعاد نمایشی</label>
              <input
                type="text"
                value={sheetForm.dimensionsMm || ''}
                onChange={e => setSheetForm({ ...sheetForm, dimensionsMm: e.target.value })}
                placeholder="۱,۲۵۰ × ۲,۵۰۰"
                className="fiori-input w-full px-2.5 py-1.5"
              />
            </div>
            <div>
              <label className="block font-bold text-[var(--fiori-text-primary)] mb-1">واحد سنجش انبار</label>
              <select
                value={sheetForm.unit || 'کیلوگرم'}
                onChange={e => setSheetForm({ ...sheetForm, unit: e.target.value })}
                className="fiori-input w-full px-2.5 py-1.5 cursor-pointer"
              >
                <option value="کیلوگرم">کیلوگرم (KG)</option>
                <option value="برگ">برگ / شیت (PCS)</option>
                <option value="عدد">عدد (PCS)</option>
                <option value="متر">متر (M)</option>
              </select>
            </div>
            <div>
              <label className="block font-bold text-[var(--fiori-text-primary)] mb-1">حداقل موجودی (نقطه سفارش)</label>
              <input
                type="number"
                min="0"
                value={sheetForm.minStock ?? 0}
                onChange={e => setSheetForm({ ...sheetForm, minStock: parseFloat(e.target.value) || 0 })}
                placeholder="مثلاً 2000"
                className="fiori-input fiori-ltr-code w-full px-2.5 py-1.5"
              />
            </div>
          </div>

          {/* Row 5: Ownership, Supplier, Standard, Status */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div>
              <label className="block font-bold text-[var(--fiori-text-primary)] mb-1">مالکیت / نوع تأمین</label>
              <select
                value={sheetForm.ownership || 'SAPCO_CONSIGNMENT'}
                onChange={e =>
                  setSheetForm({
                    ...sheetForm,
                    ownership: e.target.value as RawSheetSpec['ownership'],
                  })
                }
                className="fiori-input w-full px-2.5 py-1.5 cursor-pointer"
              >
                <option value="SAPCO_CONSIGNMENT">امانی ساپکو / مشتری</option>
                <option value="LOCAL_PURCHASE">خرید بازار داخلی</option>
                <option value="IMPORTED">وارداتی / اختصاصی</option>
              </select>
            </div>
            <div>
              <label className="block font-bold text-[var(--fiori-text-primary)] mb-1">تأمین‌کننده / کارخانه سازنده</label>
              <input
                type="text"
                value={sheetForm.supplierName || ''}
                onChange={e => setSheetForm({ ...sheetForm, supplierName: e.target.value })}
                placeholder="مثلاً فولاد مبارکه"
                className="fiori-input w-full px-2.5 py-1.5"
              />
            </div>
            <div>
              <label className="block font-bold text-[var(--fiori-text-primary)] mb-1">استاندارد فنی</label>
              <input
                type="text"
                dir="ltr"
                value={sheetForm.standard || ''}
                onChange={e => setSheetForm({ ...sheetForm, standard: e.target.value })}
                placeholder="EN 10130 / DIN 1623"
                className="fiori-input fiori-ltr-code w-full px-2.5 py-1.5"
              />
            </div>
            <div>
              <label className="block font-bold text-[var(--fiori-text-primary)] mb-1">وضعیت در کاتالوگ</label>
              <select
                value={sheetForm.active !== false ? 'ACTIVE' : 'INACTIVE'}
                onChange={e => setSheetForm({ ...sheetForm, active: e.target.value === 'ACTIVE' })}
                className="fiori-input w-full px-2.5 py-1.5 cursor-pointer"
              >
                <option value="ACTIVE">فعال</option>
                <option value="INACTIVE">غیرفعال</option>
              </select>
            </div>
          </div>

          {/* Row 6: Technical Notes */}
          <div>
            <label className="block font-bold text-[var(--fiori-text-primary)] mb-1">توضیحات فنی و کاربرد در خطوط تولید</label>
            <input
              type="text"
              value={sheetForm.description || ''}
              onChange={e => setSheetForm({ ...sheetForm, description: e.target.value })}
              placeholder="مثلاً: مخصوص پرس ۸۰۰ تن، کشش عمیق بدون نیاز به روغن‌کاری مجدد..."
              className="fiori-input w-full px-2.5 py-1.5"
            />
          </div>
        </form>
      </FioriDialog>

      {/* Material Grades & Sheet Types Master Manager Modal */}
      <FioriDialog
        isOpen={isGradeManagerOpen}
        onClose={() => setIsGradeManagerOpen(false)}
        title="بانک جامع گریدها و جنس ورق‌های کارخانه (Material Grades Master)"
        subtitle="منبع اصلی لیست کشویی «گرید و جنس ورق» در فرم تعریف ماده اولیه و انبار قطعات — هر جنس جدیدی که اینجا اضافه یا ویرایش کنید بلافاصله در کل سامانه در دسترس است."
        size="xl"
        footer={
          <div className="w-full flex items-center justify-between text-xs">
            <button
              type="button"
              onClick={() => {
                const reset = resetMaterialGrades();
                setMaterialGrades(reset);
                notifyMaster('success', 'فهرست گریدها به حالت استاندارد اولیه بازنشانی شد.');
              }}
              className="text-[11px] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] hover:underline cursor-pointer"
            >
              بازنشانی به لیست پیش‌فرض استاندارد
            </button>
            <button
              type="button"
              onClick={() => setIsGradeManagerOpen(false)}
              className="sap-btn-standard px-4 py-1.5 text-xs font-semibold cursor-pointer"
            >
              بستن
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          {/* Add / Edit Grade Form */}
          <form
            onSubmit={handleSaveGradeManagerForm}
            className="p-3.5 bg-[var(--fiori-info-bg)] border border-[var(--fiori-info-border)] rounded-[var(--fiori-radius-sm)] space-y-3 text-xs"
          >
            <div className="font-bold text-[var(--fiori-brand)] text-[11px]">
              {editingGradeId ? 'ویرایش گرید انتخاب‌شده' : 'افزودن گرید / جنس ورق جدید'}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <div>
                <label className="block text-[11px] font-semibold text-[var(--fiori-text-primary)] mb-1">کد گرید (انگلیسی) *</label>
                <input
                  type="text"
                  required
                  dir="ltr"
                  value={gradeFormCode}
                  onChange={e => setGradeFormCode(e.target.value)}
                  placeholder="مثلاً: ST52, DC06, SS316"
                  className="fiori-input fiori-ltr-code w-full px-2.5 py-1.5"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-[var(--fiori-text-primary)] mb-1">نام و شرح فارسی جنس ورق *</label>
                <input
                  type="text"
                  required
                  value={gradeFormName}
                  onChange={e => setGradeFormName(e.target.value)}
                  placeholder="مثلاً: ورق فولادی استحکام بالا ST52"
                  className="fiori-input w-full px-2.5 py-1.5"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-[var(--fiori-text-primary)] mb-1">گروه جنس</label>
                <select
                  value={gradeFormCategory}
                  onChange={e => setGradeFormCategory(e.target.value as MaterialGradeCategory)}
                  className="fiori-input w-full px-2.5 py-1.5"
                >
                  {Object.entries(MATERIAL_GRADE_CATEGORIES).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-[var(--fiori-text-primary)] mb-1">استاندارد مرجع</label>
                <input
                  type="text"
                  dir="ltr"
                  value={gradeFormStandard}
                  onChange={e => setGradeFormStandard(e.target.value)}
                  placeholder="EN 10130 / JIS / ASTM"
                  className="fiori-input fiori-ltr-code w-full px-2.5 py-1.5"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-[var(--fiori-text-primary)] mb-1">چگالی (g/cm³)</label>
                <input
                  type="number"
                  step="0.01"
                  value={gradeFormDensity}
                  onChange={e => setGradeFormDensity(e.target.value)}
                  className="fiori-input fiori-ltr-code w-full px-2.5 py-1.5"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-[var(--fiori-text-primary)] mb-1">توضیح کاربرد</label>
                <input
                  type="text"
                  value={gradeFormNotes}
                  onChange={e => setGradeFormNotes(e.target.value)}
                  placeholder="کاربرد در کشش، شاسی و..."
                  className="fiori-input w-full px-2.5 py-1.5"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              {editingGradeId && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingGradeId(null);
                    setGradeFormCode('');
                    setGradeFormName('');
                    setGradeFormStandard('');
                    setGradeFormDensity('7.85');
                    setGradeFormNotes('');
                  }}
                  className="sap-btn-standard px-3 py-1 text-xs cursor-pointer"
                >
                  انصراف از ویرایش
                </button>
              )}
              <button
                type="submit"
                className="sap-btn-emphasized px-4 py-1 text-xs font-bold cursor-pointer"
              >
                {editingGradeId ? 'ذخیره تغییرات گرید' : '+ افزودن به بانک گریدها'}
              </button>
            </div>
          </form>

          {/* Grades List Table */}
          <div className="max-h-72 overflow-y-auto border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)]">
            <table className="sap-table-compact w-full text-right text-xs">
              <thead className="bg-[var(--fiori-bg-subtle)] border-b border-[var(--fiori-border-default)] text-[var(--fiori-text-primary)] sticky top-0">
                <tr>
                  <th className="py-2 px-2.5">کد گرید</th>
                  <th className="py-2 px-2.5">شرح جنس ورق</th>
                  <th className="py-2 px-2.5">گروه</th>
                  <th className="py-2 px-2.5">استاندارد</th>
                  <th className="py-2 px-2.5">چگالی</th>
                  <th className="py-2 px-2.5 text-left">عملیات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--fiori-border-subtle)]">
                {materialGrades.map(g => (
                  <tr key={g.id} className="hover:bg-[var(--fiori-bg-hover)]">
                    <td className="py-1.5 px-2.5 fiori-ltr-code font-bold text-[var(--fiori-brand)]">{g.code}</td>
                    <td className="py-1.5 px-2.5 font-medium text-[var(--fiori-text-primary)]">
                      <div>{g.name}</div>
                      {g.notes && <div className="text-[10px] text-[var(--fiori-text-muted)]">{g.notes}</div>}
                    </td>
                    <td className="py-1.5 px-2.5 text-[11px] text-[var(--fiori-text-secondary)]">
                      {MATERIAL_GRADE_CATEGORIES[g.category] || g.category}
                    </td>
                    <td className="py-1.5 px-2.5 fiori-ltr-code text-[11px] text-[var(--fiori-text-secondary)]">
                      {g.standard || '—'}
                    </td>
                    <td className="py-1.5 px-2.5 font-mono tabular-nums">{g.densityGCm3}</td>
                    <td className="py-1.5 px-2.5 text-left whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingGradeId(g.id);
                            setGradeFormCode(g.code);
                            setGradeFormName(g.name);
                            setGradeFormCategory(g.category);
                            setGradeFormStandard(g.standard || '');
                            setGradeFormDensity(String(g.densityGCm3 || 7.85));
                            setGradeFormNotes(g.notes || '');
                          }}
                          className="text-[var(--fiori-brand)] hover:underline font-semibold cursor-pointer"
                        >
                          ویرایش
                        </button>
                        {materialGrades.length > 1 && (
                          <button
                            type="button"
                            onClick={() => {
                              const updated = deleteMaterialGrade(g.id);
                              setMaterialGrades(updated);
                            }}
                            className="text-[var(--fiori-negative)] hover:underline cursor-pointer"
                          >
                            حذف
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </FioriDialog>

      {/* 8. Warehouse Modal */}
      <FioriDialog
        isOpen={isWarehouseModalOpen}
        onClose={() => setIsWarehouseModalOpen(false)}
        title={editingWarehouse ? 'ویرایش مشخصات انبار' : 'تعریف انبار جدید'}
        size="md"
        footer={
          <>
            <button
              type="button"
              onClick={() => setIsWarehouseModalOpen(false)}
              className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="mdh-warehouse-form"
              className="sap-btn-emphasized px-5 py-1.5 text-xs font-bold cursor-pointer"
            >
              {editingWarehouse ? 'ثبت تغییرات انبار' : 'ایجاد انبار'}
            </button>
          </>
        }
      >
        <form id="mdh-warehouse-form" onSubmit={handleSaveWarehouse} className="space-y-3.5 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">کد انبار *</label>
              <input
                type="text"
                dir="ltr"
                required
                value={warehouseForm.code || ''}
                onChange={e => setWarehouseForm({ ...warehouseForm, code: e.target.value })}
                className="fiori-input fiori-ltr-code w-full px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">نوع انبار *</label>
              <select
                value={warehouseForm.type || 'RAW_MATERIALS'}
                onChange={e => setWarehouseForm({ ...warehouseForm, type: e.target.value as any })}
                className="fiori-input w-full px-3 py-2"
              >
                <option value="RAW_MATERIALS">انبار مواد اولیه و رول</option>
                <option value="WIP">انبار پای خط (WIP)</option>
                <option value="FINISHED_GOODS">انبار محصول نهایی</option>
                <option value="SCRAP">انبار ضایعات آهن و پرت</option>
                <option value="TOOLING">انبار قالب و ابزار</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">نام انبار *</label>
            <input
              type="text"
              required
              placeholder="مثلاً: انبار مرکزی رول و ورق مواد اولیه"
              value={warehouseForm.name || ''}
              onChange={e => setWarehouseForm({ ...warehouseForm, name: e.target.value })}
              className="fiori-input w-full px-3 py-2 font-medium"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">نام مسوول انبار</label>
              <input
                type="text"
                value={warehouseForm.managerName || ''}
                onChange={e => setWarehouseForm({ ...warehouseForm, managerName: e.target.value })}
                className="fiori-input w-full px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">موقعیت‌ها (با کاما جدا کنید)</label>
              <input
                type="text"
                dir="ltr"
                value={warehouseForm.locations?.join(', ') || ''}
                onChange={e =>
                  setWarehouseForm({
                    ...warehouseForm,
                    locations: e.target.value.split(/[,،]/).map(s => s.trim()).filter(Boolean),
                  })
                }
                placeholder="LOC-A1, LOC-A2, LOC-B1"
                className="fiori-input fiori-ltr-code w-full px-3 py-2"
              />
            </div>
          </div>
        </form>
      </FioriDialog>

      {/* 9. Unit Modal */}
      <FioriDialog
        isOpen={isUnitModalOpen}
        onClose={() => setIsUnitModalOpen(false)}
        title={editingUnit ? 'ویرایش واحد سنجش' : 'تعریف واحد سنجش جدید'}
        size="md"
        footer={
          <>
            <button
              type="button"
              onClick={() => setIsUnitModalOpen(false)}
              className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="mdh-unit-form"
              className="sap-btn-emphasized px-5 py-1.5 text-xs font-bold cursor-pointer"
            >
              {editingUnit ? 'ثبت تغییرات واحد' : 'ایجاد واحد'}
            </button>
          </>
        }
      >
        <form id="mdh-unit-form" onSubmit={handleSaveUnit} className="space-y-3.5 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">نماد واحد (لاتین) *</label>
              <input
                type="text"
                dir="ltr"
                required
                placeholder="KG, PCS, SHEET, ROLL"
                value={unitForm.symbol || ''}
                onChange={e => setUnitForm({ ...unitForm, symbol: e.target.value.toUpperCase() })}
                className="fiori-input fiori-ltr-code w-full px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">عنوان واحد (فارسی) *</label>
              <input
                type="text"
                required
                placeholder="کیلوگرم، عدد، برگ، رول"
                value={unitForm.title || ''}
                onChange={e => setUnitForm({ ...unitForm, title: e.target.value })}
                className="fiori-input w-full px-3 py-2"
              />
            </div>
          </div>

          <div>
            <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">توضیحات و کاربرد</label>
            <input
              type="text"
              placeholder="واحد پایه کلاف، شمارش قطعه و..."
              value={unitForm.description || ''}
              onChange={e => setUnitForm({ ...unitForm, description: e.target.value })}
              className="fiori-input w-full px-3 py-2"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">ضریب تبدیل به کیلوگرم</label>
              <input
                type="number"
                step="any"
                value={unitForm.conversionFactorToKg ?? 1}
                onChange={e => setUnitForm({ ...unitForm, conversionFactorToKg: parseFloat(e.target.value) || 1 })}
                className="fiori-input fiori-ltr-code w-full px-3 py-2"
              />
            </div>
            <div className="flex items-center gap-2 pt-6">
              <input
                type="checkbox"
                id="isBaseUnitCheck"
                checked={unitForm.isBaseUnit || false}
                onChange={e => setUnitForm({ ...unitForm, isBaseUnit: e.target.checked })}
                className="w-4 h-4 accent-[var(--fiori-brand)] rounded"
              />
              <label htmlFor="isBaseUnitCheck" className="text-[var(--fiori-text-primary)] font-medium">واحد مبنای سیستم</label>
            </div>
          </div>
        </form>
      </FioriDialog>

      {/* 10. Customer Modal */}
      <FioriDialog
        isOpen={isCustomerModalOpen}
        onClose={() => setIsCustomerModalOpen(false)}
        title={editingCustomer ? 'ویرایش مشتری' : 'تعریف مشتری جدید'}
        size="md"
        footer={
          <>
            <button
              type="button"
              onClick={() => setIsCustomerModalOpen(false)}
              className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="mdh-customer-form"
              className="sap-btn-emphasized px-5 py-1.5 text-xs font-bold cursor-pointer"
            >
              {editingCustomer ? 'ثبت تغییرات مشتری' : 'ایجاد مشتری'}
            </button>
          </>
        }
      >
        <form id="mdh-customer-form" onSubmit={handleSaveCustomer} className="space-y-3.5 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">کد مشتری *</label>
              <input
                type="text"
                dir="ltr"
                required
                value={customerForm.code || ''}
                onChange={e => setCustomerForm({ ...customerForm, code: e.target.value })}
                className="fiori-input fiori-ltr-code w-full px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">نوع رابطه / قرارداد</label>
              <input
                type="text"
                value={customerForm.contractType || ''}
                onChange={e => setCustomerForm({ ...customerForm, contractType: e.target.value })}
                placeholder="امانی / خرید قطعه"
                className="fiori-input w-full px-3 py-2"
              />
            </div>
          </div>

          <div>
            <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">نام مشتری / شرکت خودروساز *</label>
            <input
              type="text"
              required
              placeholder="مثلاً شرکت ساپکو، سازه‌گستر، بهمن موتور"
              value={customerForm.name || ''}
              onChange={e => setCustomerForm({ ...customerForm, name: e.target.value })}
              className="fiori-input w-full px-3 py-2 font-medium"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">تلفن تماس</label>
              <input
                type="text"
                dir="ltr"
                value={customerForm.phone || ''}
                onChange={e => setCustomerForm({ ...customerForm, phone: e.target.value })}
                className="fiori-input fiori-ltr-code w-full px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">ایمیل یا وب‌سایت</label>
              <input
                type="text"
                dir="ltr"
                value={customerForm.email || ''}
                onChange={e => setCustomerForm({ ...customerForm, email: e.target.value })}
                className="fiori-input fiori-ltr-code w-full px-3 py-2"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 pt-2">
            <input
              type="checkbox"
              id="isDefaultCustCheck"
              checked={customerForm.isDefault || false}
              onChange={e => setCustomerForm({ ...customerForm, isDefault: e.target.checked })}
              className="w-4 h-4 accent-[var(--fiori-brand)] rounded"
            />
            <label htmlFor="isDefaultCustCheck" className="text-[var(--fiori-text-primary)] font-medium">مشتری پیش‌فرض در فرم‌های ثبت رسید و قرارداد</label>
          </div>
        </form>
      </FioriDialog>

      {/* 11. Shift Modal */}
      <FioriDialog
        isOpen={isShiftModalOpen}
        onClose={() => setIsShiftModalOpen(false)}
        title={editingShift ? 'ویرایش شیفت کاری و زمان‌بندی' : 'تعریف شیفت کاری جدید'}
        size="md"
        footer={
          <>
            <button
              type="button"
              onClick={() => setIsShiftModalOpen(false)}
              className="sap-btn-standard px-4 py-1.5 cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="master-shift-form"
              className="sap-btn-emphasized px-5 py-1.5 cursor-pointer"
            >
              {editingShift ? 'ثبت تغییرات شیفت' : 'ایجاد شیفت'}
            </button>
          </>
        }
      >
        <form id="master-shift-form" onSubmit={handleSaveShift} className="space-y-3.5 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">کد شیفت *</label>
              <input
                type="text"
                required
                dir="ltr"
                value={shiftForm.code || ''}
                onChange={e => setShiftForm({ ...shiftForm, code: e.target.value })}
                className="fiori-input fiori-ltr-code w-full px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">نام شیفت *</label>
              <input
                type="text"
                required
                placeholder="شیفت صبح (A)"
                value={shiftForm.name || ''}
                onChange={e => setShiftForm({ ...shiftForm, name: e.target.value })}
                className="fiori-input w-full px-3 py-2 font-medium"
              />
            </div>
          </div>

          <div className="p-3 bg-[var(--fiori-bg-subtle)] rounded-[var(--fiori-radius-md)] border border-[var(--fiori-border-subtle)] space-y-2">
            <span className="font-bold text-[var(--fiori-text-primary)]">ساعات کاری عادی:</span>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-[var(--fiori-text-secondary)] mb-1">ساعت شروع</label>
                <input
                  type="time"
                  dir="ltr"
                  value={shiftForm.startTime || '07:00'}
                  onChange={e => setShiftForm({ ...shiftForm, startTime: e.target.value })}
                  className="fiori-input fiori-ltr-code w-full px-2 py-2 tabular-nums"
                />
              </div>
              <div>
                <label className="block text-[var(--fiori-text-secondary)] mb-1">ساعت پایان</label>
                <input
                  type="time"
                  dir="ltr"
                  value={shiftForm.endTime || '14:30'}
                  onChange={e => setShiftForm({ ...shiftForm, endTime: e.target.value })}
                  className="fiori-input fiori-ltr-code w-full px-2 py-2 tabular-nums"
                />
              </div>
              <div>
                <label className="block text-[var(--fiori-text-secondary)] mb-1">کار مفید (دقیقه)</label>
                <input
                  type="number"
                  dir="ltr"
                  value={shiftForm.netWorkMinutes ?? 450}
                  onChange={e => setShiftForm({ ...shiftForm, netWorkMinutes: parseInt(e.target.value) || 0 })}
                  className="fiori-input fiori-ltr-code w-full px-2 py-2 tabular-nums"
                />
              </div>
            </div>
            <p className="text-[11px] text-[var(--fiori-text-muted)]">
              معادل ۷ ساعت کارکرد خالص به انضمام ۳۰ دقیقه استراحت/ناهار (ساعت ۷:۰۰ صبح تا ۱۴:۳۰).
            </p>
          </div>

          <div className="p-3 bg-[var(--fiori-critical-bg)] rounded-[var(--fiori-radius-md)] border border-[var(--fiori-critical-border)] space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="hasOvertimeCheck"
                  checked={shiftForm.hasOvertime || false}
                  onChange={e => setShiftForm({ ...shiftForm, hasOvertime: e.target.checked })}
                  className="w-4 h-4 accent-[var(--fiori-critical)] rounded"
                />
                <label htmlFor="hasOvertimeCheck" className="text-[var(--fiori-text-primary)] font-bold">
                  تعریف اضافه‌کاری روزانه ثابت (شنبه تا چهارشنبه)
                </label>
              </div>
            </div>

            {shiftForm.hasOvertime && (
              <div className="grid grid-cols-3 gap-2.5 pt-1">
                <div>
                  <label className="block text-[var(--fiori-text-secondary)] text-[11px] mb-1">شروع اضافه‌کاری</label>
                  <input
                    type="time"
                    dir="ltr"
                    value={shiftForm.overtimeStartTime || '15:00'}
                    onChange={e => setShiftForm({ ...shiftForm, overtimeStartTime: e.target.value })}
                    className="fiori-input fiori-ltr-code w-full px-2 py-1.5 tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[var(--fiori-text-secondary)] text-[11px] mb-1">پایان اضافه‌کاری</label>
                  <input
                    type="time"
                    dir="ltr"
                    value={shiftForm.overtimeEndTime || '17:00'}
                    onChange={e => setShiftForm({ ...shiftForm, overtimeEndTime: e.target.value })}
                    className="fiori-input fiori-ltr-code w-full px-2 py-1.5 tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[var(--fiori-text-secondary)] text-[11px] mb-1">مدت (دقیقه)</label>
                  <input
                    type="number"
                    dir="ltr"
                    value={shiftForm.overtimeMinutes ?? 120}
                    onChange={e => setShiftForm({ ...shiftForm, overtimeMinutes: parseInt(e.target.value) || 0 })}
                    className="fiori-input fiori-ltr-code w-full px-2 py-1.5 tabular-nums"
                  />
                </div>
              </div>
            )}
          </div>

          <div>
            <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">وضعیت کاری روز پنجشنبه</label>
            <select
              value={shiftForm.thursdayStatus || 'OVERTIME_15_17'}
              onChange={e => setShiftForm({ ...shiftForm, thursdayStatus: e.target.value as any })}
              className="fiori-input w-full px-3 py-2"
            >
              <option value="OVERTIME_15_17">فقط اضافه‌کاری بعدازظهر (ساعت ۱۵:۰۰ تا ۱۷:۰۰)</option>
              <option value="OFF">کلاً تعطیل (روز استراحت)</option>
              <option value="FULL_SHIFT">شیفت کامل عادی (ساعت ۰۷:۰۰ تا ۱۴:۳۰)</option>
            </select>
          </div>
        </form>
      </FioriDialog>

      {/* 12. Car Model Modal */}
      <FioriDialog
        isOpen={isCarModelModalOpen}
        onClose={() => setIsCarModelModalOpen(false)}
        title={editingCarModel ? 'ویرایش مدل خودرو' : 'تعریف مدل خودرو جدید'}
        size="sm"
        footer={
          <>
            <button
              type="button"
              onClick={() => setIsCarModelModalOpen(false)}
              className="sap-btn-standard px-4 py-1.5 cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="master-car-model-form"
              className="sap-btn-emphasized px-5 py-1.5 cursor-pointer"
            >
              {editingCarModel ? 'ثبت تغییرات مدل' : 'ایجاد مدل خودرو'}
            </button>
          </>
        }
      >
        <form id="master-car-model-form" onSubmit={handleSaveCarModel} className="space-y-3.5 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">کد شناسه پلتفرم *</label>
              <input
                type="text"
                required
                dir="ltr"
                placeholder="مثلاً IKCO-206"
                value={carModelForm.code || ''}
                onChange={e => setCarModelForm({ ...carModelForm, code: e.target.value })}
                className="fiori-input fiori-ltr-code w-full px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">نام مدل خودرو *</label>
              <input
                type="text"
                required
                placeholder="مثلاً پژو ۲۰۶"
                value={carModelForm.name || ''}
                onChange={e => setCarModelForm({ ...carModelForm, name: e.target.value })}
                className="fiori-input w-full px-3 py-2 font-medium"
              />
            </div>
          </div>

          <div>
            <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">خودروساز / شرکت مادر (OEM) *</label>
            <input
              type="text"
              required
              placeholder="ساپکو (ایران‌خودرو)، سازه‌گستر (سایپا)، بهمن موتور"
              value={carModelForm.oem || ''}
              onChange={e => setCarModelForm({ ...carModelForm, oem: e.target.value })}
              className="fiori-input w-full px-3 py-2"
            />
          </div>

          <div>
            <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">توضیحات و تیپ‌ها</label>
            <input
              type="text"
              placeholder="مثلاً هاچ‌بک و صندوق‌دار تیپ ۲ و ۵"
              value={carModelForm.description || ''}
              onChange={e => setCarModelForm({ ...carModelForm, description: e.target.value })}
              className="fiori-input w-full px-3 py-2"
            />
          </div>

          <div className="flex items-center gap-2 pt-2">
            <input
              type="checkbox"
              id="isCarModelActiveCheck"
              checked={carModelForm.active !== false}
              onChange={e => setCarModelForm({ ...carModelForm, active: e.target.checked })}
              className="w-4 h-4 accent-[var(--fiori-positive)] rounded"
            />
            <label htmlFor="isCarModelActiveCheck" className="text-[var(--fiori-text-primary)] font-medium">مدل فعال در چرخه تولید</label>
          </div>
        </form>
      </FioriDialog>

      {/* 13. Operation Modal */}
      <FioriDialog
        isOpen={isOperationModalOpen}
        onClose={() => setIsOperationModalOpen(false)}
        title={editingOperation ? 'ویرایش عملیات استاندارد تولید' : 'تعریف عملیات استاندارد تولید جدید'}
        size="md"
        footer={
          <>
            <button
              type="button"
              onClick={() => setIsOperationModalOpen(false)}
              className="sap-btn-standard px-4 py-1.5 cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="master-operation-form"
              className="sap-btn-emphasized px-5 py-1.5 cursor-pointer"
            >
              {editingOperation ? 'ثبت تغییرات عملیات' : 'ایجاد عملیات جدید'}
            </button>
          </>
        }
      >
        <form id="master-operation-form" onSubmit={handleSaveOperation} className="space-y-3.5 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">کد عملیات *</label>
              <input
                type="text"
                required
                dir="ltr"
                placeholder="مثلاً OP-10 یا OP-WELD-NUT"
                value={operationForm.code || ''}
                onChange={e => setOperationForm({ ...operationForm, code: e.target.value })}
                className="fiori-input fiori-ltr-code w-full px-3 py-1.5"
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[var(--fiori-text-primary)] font-semibold">دسته فرآیندی *</label>
                <button
                  type="button"
                  onClick={() => setIsProcessCategoryModalOpen(true)}
                  className="text-[10px] font-bold text-[var(--fiori-brand)] hover:underline flex items-center gap-0.5 cursor-pointer bg-[var(--fiori-brand-bg)] px-1.5 py-0.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-brand-border)]"
                  title="تعریف و ویرایش دسته‌بندی‌های فرآیندی"
                >
                  <Plus className="w-3 h-3" />
                  <span>مدیریت دسته‌ها</span>
                </button>
              </div>
              <select
                value={operationForm.category || 'STAMPING'}
                onChange={e =>
                  setOperationForm({
                    ...operationForm,
                    category: e.target.value as any,
                  })
                }
                className="fiori-input w-full px-3 py-1.5 font-medium"
              >
                {processCategories.map(cat => (
                  <option key={cat.code} value={cat.code}>
                    {cat.name} ({cat.code})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">عنوان کامل عملیات *</label>
            <input
              type="text"
              required
              placeholder="مثلاً بلنک و سوراخ‌کاری ورق، پرس‌جوش مهره، خم لبه‌ها..."
              value={operationForm.name || ''}
              onChange={e => setOperationForm({ ...operationForm, name: e.target.value })}
              className="fiori-input w-full px-3 py-1.5 font-medium"
            />
          </div>

          {/* Workstation Type Field with Persian Guidance & Rationale */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[var(--fiori-text-primary)] font-semibold">نوع ایستگاه کاری / دستگاه مورد استفاده *</label>
              <button
                type="button"
                onClick={() => setIsWorkstationHelpOpen(!isWorkstationHelpOpen)}
                className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--fiori-critical)] bg-[var(--fiori-critical-bg)] hover:opacity-90 px-2 py-0.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-critical-border)] transition cursor-pointer"
                title="مشاهده راهنمای کارکرد این فیلد در MRP و ظرفیت‌سنجی"
              >
                <Sparkles className="w-3 h-3 text-[var(--fiori-critical)]" />
                <span>کارکرد این فیلد چیه؟</span>
              </button>
            </div>

            {isWorkstationHelpOpen && (
              <FioriMessageStrip
                tone="warning"
                compact
                title="کارکرد ایستگاه کاری در سیستم هوشمند برنامه‌ریزی تولید (MRP & Capacity Planning):"
              >
                <ul className="list-disc list-inside space-y-1 pr-1 mt-1 text-[11px]">
                  <li>
                    <strong>تطبیق خودکار پرس با عملیات:</strong> سیستم مشخص می‌کند این مرحله روی کدام رده از دستگاه‌ها (پرس‌های هیدرولیک، پرس ضربه‌ای شولر، خط برش، پرس‌جوش یا خط رنگ) قابل اجراست.
                  </li>
                  <li>
                    <strong>پایش تداخل ماشین‌آلات (Machine Overlaps):</strong> الگوریتم ظرفیت‌سنجی مانع برنامه‌ریزی همزمان دو دستور کار روی یک ایستگاه در شیفت یکسان می‌شود.
                  </li>
                  <li>
                    <strong>محاسبه زمان راه‌اندازی (SMED):</strong> زمان تعویض قالب و آمادگی ایستگاه مستقیماً بر مبنای این ماشین محاسبه می‌گردد.
                  </li>
                </ul>
              </FioriMessageStrip>
            )}

            <input
              type="text"
              required
              placeholder="مثلاً خط برش کویل، پرس ضربه‌ای ۲۵۰ تن، دستگاه پرس‌جوش M6، ایستگاه جوش CO2..."
              value={operationForm.stationType || ''}
              onChange={e => setOperationForm({ ...operationForm, stationType: e.target.value })}
              className="fiori-input w-full px-3 py-1.5"
            />

            {/* Quick Suggestion Chips */}
            <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
              <span className="text-[10px] text-[var(--fiori-text-muted)]">پیشنهاد سریع:</span>
              {[
                'خط برش و نواربری رول',
                'پرس مکانیکی ضربه‌ای شولر ۴۰۰ تن',
                'پرس هیدرولیک کشش ۸۰۰ تن',
                'پرس ضربه‌ای ۲۵۰ تن کلاچ‌دار',
                'دستگاه پرس‌جوش مقاومتی M6/M8',
                'سلول رباتیک جوشکاری CO2',
                'خط فسفاته و رنگ کاتافورز ED',
                'ایستگاه مونتاژ و هِمینگ',
              ].map((st, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setOperationForm({ ...operationForm, stationType: st })}
                  className="px-2 py-0.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] hover:bg-[var(--fiori-bg-selected)] text-[var(--fiori-text-primary)] border border-[var(--fiori-border-subtle)] text-[10px] font-medium transition cursor-pointer"
                >
                  {st}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">زمان چرخه استاندارد هر ضرب (ثانیه) *</label>
              <input
                type="number"
                step="0.1"
                min="0.1"
                required
                dir="ltr"
                value={operationForm.cycleTimeSec ?? 4.5}
                onChange={e =>
                  setOperationForm({
                    ...operationForm,
                    cycleTimeSec: parseFloat(e.target.value) || 0,
                  })
                }
                className="fiori-input fiori-ltr-code w-full px-3 py-1.5 tabular-nums"
              />
            </div>
            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">زمان ستاپ / تعویض قالب (دقیقه) *</label>
              <input
                type="number"
                min="0"
                required
                dir="ltr"
                value={operationForm.setupTimeMin ?? 20}
                onChange={e =>
                  setOperationForm({
                    ...operationForm,
                    setupTimeMin: parseInt(e.target.value, 10) || 0,
                  })
                }
                className="fiori-input fiori-ltr-code w-full px-3 py-1.5 tabular-nums"
              />
            </div>
          </div>

          <div>
            <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">دستورالعمل و توضیحات فرآیندی</label>
            <textarea
              rows={2}
              placeholder="شرح نکات کنترلی، تلرانس ابعادی، فیکسچر مورد استفاده و پارامترهای فنی..."
              value={operationForm.description || ''}
              onChange={e => setOperationForm({ ...operationForm, description: e.target.value })}
              className="fiori-input w-full px-3 py-1.5 resize-none"
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              id="isOperationActiveCheck"
              checked={operationForm.active !== false}
              onChange={e => setOperationForm({ ...operationForm, active: e.target.checked })}
              className="w-4 h-4 accent-[var(--fiori-brand)] rounded-sm"
            />
            <label htmlFor="isOperationActiveCheck" className="text-[var(--fiori-text-primary)] font-medium">
              عملیات فعال در تقویم ظرفیت و مسیرهای تولید
            </label>
          </div>
        </form>
      </FioriDialog>

      {/* 14. Factory Hall Modal (کشوی ثبت و ویرایش سالن تولید) */}
      <FioriDialog
        isOpen={isHallModalOpen}
        onClose={() => setIsHallModalOpen(false)}
        title={editingHall ? 'ویرایش شناسنامه سالن تولید' : 'تعریف سالن تولید و استقرار جدید'}
        icon={<Building2 className="w-4 h-4" />}
        tone="brand"
        size="md"
        footer={
          <>
            <button
              type="button"
              onClick={() => setIsHallModalOpen(false)}
              className="sap-btn-standard px-4 py-1.5 cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="master-hall-form"
              className="sap-btn-emphasized px-5 py-1.5 cursor-pointer"
            >
              {editingHall ? 'ثبت تغییرات سالن' : 'ایجاد سالن جدید'}
            </button>
          </>
        }
      >
        <form id="master-hall-form" onSubmit={handleSaveHall} className="space-y-3.5 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">کد شناسایی سالن *</label>
              <input
                type="text"
                required
                dir="ltr"
                placeholder="مثلاً HALL-01 یا HALL-HEAVY"
                value={hallForm.code || ''}
                onChange={e => setHallForm({ ...hallForm, code: e.target.value })}
                className="fiori-input fiori-ltr-code w-full px-3 py-1.5"
              />
            </div>
            <div>
              <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">نوع کاربری سالن *</label>
              <select
                value={hallForm.type || 'STAMPING'}
                onChange={e => setHallForm({ ...hallForm, type: e.target.value as any })}
                className="fiori-input w-full px-3 py-1.5 font-medium"
              >
                <option value="STAMPING">پرسکاری و فرم‌دهی (Stamping)</option>
                <option value="WELDING">جوشکاری و مونتاژ بدنه (Welding)</option>
                <option value="PAINT">رنگ و کاتافورز (Paint / ED)</option>
                <option value="ASSEMBLY">مونتاژ نهایی و هِمینگ (Assembly)</option>
                <option value="WAREHOUSE">انبار و پشتیبانی لجستیک (Warehouse)</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">نام و عنوان کامل سالن تولید *</label>
            <input
              type="text"
              required
              placeholder="مثلاً سالن پرس‌های سنگین (۸۰۰ و ۴۰۰ تن)، سالن جوشکاری رباتیک..."
              value={hallForm.name || ''}
              onChange={e => setHallForm({ ...hallForm, name: e.target.value })}
              className="fiori-input w-full px-3 py-1.5 font-medium"
            />
          </div>

          <div>
            <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">سرپرست / مسئول سالن</label>
            <input
              type="text"
              placeholder="نام و نام خانوادگی سرپرست سالن..."
              value={hallForm.supervisorName || ''}
              onChange={e => setHallForm({ ...hallForm, supervisorName: e.target.value })}
              className="fiori-input w-full px-3 py-1.5"
            />
          </div>

          <div>
            <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">ظرفیت، تجهیزات و مشخصات فنی مستقر</label>
            <input
              type="text"
              placeholder="مثلاً خطوط پرس شولر، جرثقیل سقفی ۲۰ تن، ایستگاه شستشو..."
              value={hallForm.capacityDesc || ''}
              onChange={e => setHallForm({ ...hallForm, capacityDesc: e.target.value })}
              className="fiori-input w-full px-3 py-1.5"
            />
          </div>

          <div>
            <label className="block text-[var(--fiori-text-primary)] font-semibold mb-1">توضیحات و نکات ایمنی سالن</label>
            <textarea
              rows={2}
              placeholder="ملاحظات لجستیکی، ورودی و خروجی لیفتراک، انبارک پای خط..."
              value={hallForm.description || ''}
              onChange={e => setHallForm({ ...hallForm, description: e.target.value })}
              className="fiori-input w-full px-3 py-1.5 resize-none"
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              id="isHallActiveCheck"
              checked={hallForm.active !== false}
              onChange={e => setHallForm({ ...hallForm, active: e.target.checked })}
              className="w-4 h-4 accent-[var(--fiori-brand)] rounded-sm"
            />
            <label htmlFor="isHallActiveCheck" className="text-[var(--fiori-text-primary)] font-medium">
              سالن فعال در برنامه‌ریزی تولید و تخصیص پرس‌ها
            </label>
          </div>
        </form>
      </FioriDialog>

      {/* 15. Process Category Modal (مدیریت و تعریف دسته‌های فرآیندی) */}
      <FioriDialog
        isOpen={isProcessCategoryModalOpen}
        onClose={() => setIsProcessCategoryModalOpen(false)}
        title="مدیریت دسته‌های فرآیندی کارخانه (Process Categories)"
        icon={<Settings2 className="w-4 h-4" />}
        tone="brand"
        size="sm"
        footer={
          <>
            <button
              type="button"
              onClick={() => setIsProcessCategoryModalOpen(false)}
              className="sap-btn-standard px-3 py-1.5 cursor-pointer"
            >
              بستن
            </button>
            <button
              type="submit"
              form="master-process-category-form"
              className="sap-btn-emphasized px-4 py-1.5 cursor-pointer"
            >
              افزودن دسته فرآیندی
            </button>
          </>
        }
      >
        {/* Existing Categories List */}
        <div className="space-y-1.5 max-h-52 overflow-y-auto mb-3 border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] p-2 bg-[var(--fiori-bg-subtle)]">
          {processCategories.map(cat => (
            <div
              key={cat.code}
              className="flex items-center justify-between p-2 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-subtle)] text-xs"
            >
              <div className="flex items-center gap-2">
                <FioriObjectStatus tone="brand" label={cat.code} ltrCode size="sm" />
                <span className="font-medium text-[var(--fiori-text-primary)]">{cat.name}</span>
              </div>
              <button
                type="button"
                onClick={() => handleDeleteProcessCategory(cat.code)}
                className="text-[var(--fiori-negative)] p-1 rounded-[var(--fiori-radius-sm)] hover:bg-[var(--fiori-negative-bg)] transition cursor-pointer"
                title="حذف دسته فرآیندی"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>

        {/* Add New Category Form */}
        <form id="master-process-category-form" onSubmit={handleAddProcessCategory} className="space-y-3 pt-2 border-t border-[var(--fiori-border-subtle)] text-xs">
          <h4 className="font-bold text-[var(--fiori-text-primary)] text-[11px]">+ تعریف دسته فرآیندی جدید:</h4>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[var(--fiori-text-secondary)] font-medium mb-1">کد لاتین دسته *</label>
              <input
                type="text"
                required
                dir="ltr"
                placeholder="HYDRO_FORM"
                value={newCategoryCode}
                onChange={e => setNewCategoryCode(e.target.value)}
                className="fiori-input fiori-ltr-code w-full px-2.5 py-1.5 uppercase"
              />
            </div>
            <div>
              <label className="block text-[var(--fiori-text-secondary)] font-medium mb-1">عنوان فارسی دسته *</label>
              <input
                type="text"
                required
                placeholder="هیدروفرمینگ لوله"
                value={newCategoryName}
                onChange={e => setNewCategoryName(e.target.value)}
                className="fiori-input w-full px-2.5 py-1.5"
              />
            </div>
          </div>
        </form>
      </FioriDialog>
    </div>
  );
};
