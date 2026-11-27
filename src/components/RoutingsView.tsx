import React, { useState, useMemo, useEffect } from 'react';
import {
  GitFork,
  Clock,
  AlertOctagon,
  Cpu,
  Plus,
  Layers,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Settings,
  Trash2,
  Edit3,
  Wrench,
  ArrowLeft,
  X,
  PlayCircle,
  FileCheck2,
  ShieldCheck,
  Search,
  Sparkles,
  Tag,
  HelpCircle,
  Filter,
  Check,
  AlertCircle,
  FileText,
} from 'lucide-react';
import {
  Routing,
  OperationStep,
  Part,
  Machine,
  DieMold,
  ProcessType,
  PROCESS_DEFINITIONS,
  CarModel,
  OperationDefinition,
} from '../types/inventory';
import { toPersianDigits, formatNumber } from '../utils/formatters';
import { MasterDataDifferenceGuideModal } from './common/MasterDataDifferenceGuideModal';
import { TraceabilityTagModal } from './wip/TraceabilityTagModal';
import { SearchableSelect } from './common/SearchableSelect';
import { EmptyState } from './common/EmptyState';
import {
  FioriDialog,
  FioriMessageStrip,
  FioriObjectStatus,
  FioriToolbar,
} from './fiori/ui';
import { useErpRouter } from '../context/RouterContext';
import { useEnterpriseUx } from '../context/EnterpriseUxContext';

interface RoutingsViewProps {
  routings: Routing[];
  parts: Part[];
  machines: Machine[];
  dies?: DieMold[];
  operations?: OperationDefinition[];
  onSaveRouting: (routing: Partial<Routing>) => Promise<{ success: boolean; message?: string; error?: string }>;
  onDeleteRouting?: (id: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  onDirectProduce?: (partId: string, stageId?: string, machineId?: string) => void;
  onSaveMachine?: (mch: Partial<Machine>) => Promise<{ success: boolean; message?: string; error?: string }>;
  onSaveDie?: (die: Partial<DieMold>) => Promise<{ success: boolean; message?: string; error?: string }>;
}

export const RoutingsView: React.FC<RoutingsViewProps> = ({
  routings,
  parts,
  machines,
  dies = [],
  operations = [],
  onSaveRouting,
  onDeleteRouting,
  onDirectProduce,
  onSaveMachine,
  onSaveDie,
}) => {
  const { traceDocument, route, clearDocQuery, pushSelectionStep } = useErpRouter();
  const { requestConfirm } = useEnterpriseUx();
  const [selectedRoutingId, setSelectedRoutingId] = useState<string>(routings[0]?.id || '');
  const [expandedSteps, setExpandedSteps] = useState<Record<number, boolean>>({});
  const [viewMode, setViewMode] = useState<'DIRECTORY' | 'STEPPER'>('STEPPER');

  // Dynamic Car Models from API
  const [carModelsList, setCarModelsList] = useState<CarModel[]>([]);
  const [selectedCarModel, setSelectedCarModel] = useState<string>('ALL');

  useEffect(() => {
    fetch('/api/car-models')
      .then(r => r.json())
      .then(data => {
        if (data.success && Array.isArray(data.data)) {
          setCarModelsList(data.data);
        }
      })
      .catch(() => {});
  }, []);

  // Search & Filtering State
  const [searchQuery, setSearchQuery] = useState(route.docQuery || '');

  useEffect(() => {
    if (!route.docQuery) return;
    const q = route.docQuery.trim().toLowerCase();
    setSearchQuery(route.docQuery);
    setSelectedCarModel('ALL');
    const matched = routings.find(
      r => r.partCode.toLowerCase().includes(q) || r.partName.toLowerCase().includes(q),
    );
    if (matched) {
      setSelectedRoutingId(matched.id);
      setViewMode('STEPPER');
    }
  }, [route.docQuery, routings]);

  // Modals
  const [isNewRoutingModalOpen, setIsNewRoutingModalOpen] = useState(false);
  const [isEditRoutingModalOpen, setIsEditRoutingModalOpen] = useState(false);
  const [isStepModalOpen, setIsStepModalOpen] = useState(false);
  const [editingStepIndex, setEditingStepIndex] = useState<number | null>(null);
  const [isGuideModalOpen, setIsGuideModalOpen] = useState(false);
  const [isTraceabilityModalOpen, setIsTraceabilityModalOpen] = useState(false);

  // Operations Library (from props or API)
  const [operationsLibrary, setOperationsLibrary] = useState<OperationDefinition[]>(operations);
  const [selectedMasterOpId, setSelectedMasterOpId] = useState<string>('');

  useEffect(() => {
    if (operations && operations.length > 0) {
      setOperationsLibrary(operations);
    } else {
      fetch('/api/operations')
        .then(r => r.json())
        .then(data => {
          if (data.success && Array.isArray(data.data)) {
            setOperationsLibrary(data.data);
          }
        })
        .catch(() => {});
    }
  }, [operations]);

  // Handle selecting a master operation from engineering library to auto-fill step fields
  const handleSelectMasterOperation = (opId: string) => {
    setSelectedMasterOpId(opId);
    if (!opId) return;
    const op = operationsLibrary.find(o => o.id === opId);
    if (!op) return;

    // Map Master Operation category to Routing ProcessType
    let pType: ProcessType = 'PUNCH_FORM';
    if (op.category === 'SHEARING') pType = 'BLANKING';
    else if (op.category === 'STAMPING') pType = 'DRAWING';
    else if (op.category === 'BENDING') pType = 'BENDING';
    else if (op.category === 'WELDING') pType = 'SPOT_WELD';
    else if (op.category === 'SURFACE_FINISH') pType = 'PAINT';
    else if (op.category === 'QC_PACK') pType = 'ASSEMBLY';

    // Auto-match workstation/press from machines if stationType matches
    let matchedMachineId = stepData.machineId;
    if (op.stationType && machines && machines.length > 0) {
      const foundM = machines.find(m =>
        m.name.includes(op.stationType) ||
        m.code.includes(op.stationType) ||
        (op.stationType.includes('پرس') && (m.processType === 'DRAWING' || m.processType === 'BLANKING' || m.processType === 'PUNCH_FORM')) ||
        (op.stationType.includes('برش') && (m.processType === 'BLANKING' || m.processType === 'SHEARING')) ||
        (op.stationType.includes('جوش') && (m.processType === 'SPOT_WELD' || m.processType === 'CO2_WELD'))
      );
      if (foundM) matchedMachineId = foundM.id;
    }

    setStepData(prev => ({
      ...prev,
      stepCode: op.code.startsWith('OP') ? op.code : `OP${prev.stepNumber || 10}_${op.code}`,
      stepName: op.name,
      processType: pType,
      standardCycleTimeSec: op.cycleTimeSec || prev.standardCycleTimeSec || 12,
      setupTimeMin: op.setupTimeMin || prev.setupTimeMin || 20,
      description: op.description || prev.description || '',
      machineId: matchedMachineId || prev.machineId,
    }));
  };

  // Quick Add Machine / Press Modal State
  const [isQuickMachineModalOpen, setIsQuickMachineModalOpen] = useState(false);
  const [quickMachineCode, setQuickMachineCode] = useState('');
  const [quickMachineName, setQuickMachineName] = useState('');
  const [quickMachineTonnage, setQuickMachineTonnage] = useState<number>(250);
  const [quickMachineHall, setQuickMachineHall] = useState('سالن پرس');
  const [savingQuickMachine, setSavingQuickMachine] = useState(false);

  // Quick Add Die / Mold Modal State
  const [isQuickDieModalOpen, setIsQuickDieModalOpen] = useState(false);
  const [quickDieCode, setQuickDieCode] = useState('');
  const [quickDieName, setQuickDieName] = useState('');
  const [quickDieTonnage, setQuickDieTonnage] = useState<number>(250);
  const [savingQuickDie, setSavingQuickDie] = useState(false);

  // Toggle for showing all dies vs only part-correlated dies
  const [showAllDies, setShowAllDies] = useState(false);

  // New Routing Form State
  const [newRoutingPartId, setNewRoutingPartId] = useState('');
  const [newRoutingVersion, setNewRoutingVersion] = useState('V1.0');
  const [newRoutingNotes, setNewRoutingNotes] = useState('');

  // Edit Routing Form State
  const [editVersion, setEditVersion] = useState('V1.0');
  const [editNotes, setEditNotes] = useState('');

  // Step Form State
  const [stepData, setStepData] = useState<Partial<OperationStep>>({
    stepNumber: 10,
    stepCode: 'OP10_BLNK',
    stepName: '',
    processType: 'BLANKING',
    machineId: '',
    dieMoldId: '',
    requiredTonnage: 250,
    setupTimeMin: 30,
    standardCycleTimeSec: 10,
    scrapNormPercent: 1.0,
    description: '',
    isSharedOperation: false,
    sharedPartId: '',
    sharedPartCode: '',
    sharedPartName: '',
    sharedYieldRatio: 1,
    sharedOperationNotes: '',
  });

  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Filtered Routings
  const filteredRoutings = useMemo(() => {
    return routings.filter(r => {
      const part = parts.find(p => p.id === r.partId || p.code === r.partCode);
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        r.partCode.toLowerCase().includes(q) ||
        r.partName.toLowerCase().includes(q) ||
        (part?.carModel && part.carModel.toLowerCase().includes(q)) ||
        r.operations.some(op => op.stepName.toLowerCase().includes(q));

      const matchesCar =
        selectedCarModel === 'ALL' ||
        (part?.carModel && part.carModel.includes(selectedCarModel)) ||
        r.partName.includes(selectedCarModel);

      return matchesSearch && matchesCar;
    });
  }, [routings, parts, searchQuery, selectedCarModel]);

  const activeRouting = useMemo(() => {
    if (selectedRoutingId) {
      const found = routings.find(r => r.id === selectedRoutingId);
      if (found) return found;
    }
    return filteredRoutings[0] || routings[0] || null;
  }, [routings, selectedRoutingId, filteredRoutings]);

  // ERP/MES Concept: Part-Die Correlation (همبستگی قطعه با قالب)
  // Only dies specifically tagged or correlated with this routing's part (by partId, partCode or name match)
  const correlatedDies = useMemo(() => {
    if (!activeRouting) return dies;
    const partId = activeRouting.partId;
    const partCode = (activeRouting.partCode || '').toLowerCase();
    const partName = (activeRouting.partName || '').toLowerCase();

    const matched = dies.filter(d => {
      if (d.partId && d.partId === partId) return true;
      if (d.partCode && d.partCode.toLowerCase() === partCode) return true;
      // Heuristic correlation by name/code substring
      if (partCode && d.code.toLowerCase().includes(partCode)) return true;
      if (partCode && d.name.toLowerCase().includes(partCode)) return true;
      if (partName && d.name.toLowerCase().includes(partName)) return true;
      return false;
    });

    return matched;
  }, [dies, activeRouting]);

  // Quick Add Machine / Press Handler (ERPNext / Odoo workcenter creation pattern)
  const handleCreateQuickMachine = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickMachineName.trim()) return;
    setSavingQuickMachine(true);
    try {
      const generatedCode = quickMachineCode.trim() || `PRS-${quickMachineTonnage}T-${Date.now().toString().slice(-3)}`;
      const newMch: Partial<Machine> = {
        code: generatedCode,
        name: quickMachineName.trim(),
        tonnage: quickMachineTonnage,
        processType: (stepData.processType as ProcessType) || 'BLANKING',
        capabilities: [(stepData.processType as ProcessType) || 'BLANKING'],
        location: quickMachineHall,
        status: 'ACTIVE',
      };

      if (onSaveMachine) {
        await onSaveMachine(newMch);
      } else {
        await fetch('/api/machines', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newMch),
        });
      }

      setStepData(prev => ({
        ...prev,
        machineId: generatedCode,
        machineName: quickMachineName.trim(),
        requiredTonnage: quickMachineTonnage,
      }));
      setIsQuickMachineModalOpen(false);
      setQuickMachineName('');
      setQuickMachineCode('');
    } catch (err) {
      console.error('Failed to quick add machine:', err);
    } finally {
      setSavingQuickMachine(false);
    }
  };

  // Quick Add Die / Mold Handler (Frappe/ERPNext Tool/Die creation pattern)
  const handleCreateQuickDie = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickDieName.trim()) return;
    setSavingQuickDie(true);
    try {
      const partCode = activeRouting?.partCode || 'PART';
      const generatedCode = quickDieCode.trim() || `DIE-${partCode}-${Date.now().toString().slice(-3)}`;
      const newDie: Partial<DieMold> = {
        code: generatedCode,
        name: quickDieName.trim(),
        partId: activeRouting?.partId || '',
        partCode: activeRouting?.partCode || '',
        partName: activeRouting?.partName || '',
        processType: (stepData.processType as ProcessType) || 'BLANKING',
        requiredTonnage: quickDieTonnage,
        status: 'READY',
        strokeLifeTarget: 500000,
        currentStrokes: 0,
        location: 'انبار قالب‌ها — ردیف A',
      };

      if (onSaveDie) {
        await onSaveDie(newDie);
      } else {
        await fetch('/api/dies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newDie),
        });
      }

      setStepData(prev => ({
        ...prev,
        dieMoldId: generatedCode,
        dieMoldName: quickDieName.trim(),
        requiredTonnage: quickDieTonnage,
      }));
      setIsQuickDieModalOpen(false);
      setQuickDieName('');
      setQuickDieCode('');
    } catch (err) {
      console.error('Failed to quick add die:', err);
    } finally {
      setSavingQuickDie(false);
    }
  };

  // Open Step Modal for Add or Edit
  const handleOpenAddStep = () => {
    if (!activeRouting) return;
    const nextStepNum = activeRouting.operations.length > 0
      ? Math.max(...activeRouting.operations.map(o => o.stepNumber)) + 10
      : 10;

    setEditingStepIndex(null);
    setSelectedMasterOpId('');
    setStepData({
      stepNumber: nextStepNum,
      stepCode: `OP${nextStepNum}_FORM`,
      stepName: '',
      processType: 'PUNCH_FORM',
      machineId: machines[0]?.id || '',
      dieMoldId: dies[0]?.id || '',
      requiredTonnage: 250,
      setupTimeMin: 20,
      standardCycleTimeSec: 12,
      scrapNormPercent: 1.0,
      description: '',
    });
    setFormError(null);
    setIsStepModalOpen(true);
  };

  const handleOpenEditStep = (step: OperationStep, index: number) => {
    setEditingStepIndex(index);
    setStepData({ ...step });
    const matched = operationsLibrary.find(o => o.code === step.stepCode || o.name === step.stepName);
    setSelectedMasterOpId(matched?.id || '');
    setFormError(null);
    setIsStepModalOpen(true);
  };

  const handleDeleteStep = async (index: number) => {
    if (!activeRouting) return;
    requestConfirm({
      title: 'حذف گام عملیاتی روتینگ',
      message: 'آیا از حذف این گام عملیاتی از مسیر ساخت اطمینان دارید؟',
      variant: 'danger',
      confirmLabel: 'بله، حذف شود',
      onConfirm: async () => {
        const updatedOps = activeRouting.operations.filter((_, i) => i !== index);
        await onSaveRouting({
          ...activeRouting,
          operations: updatedOps,
        });
      },
    });
  };

  const handleMoveStep = async (index: number, direction: 'UP' | 'DOWN') => {
    if (!activeRouting) return;
    const targetIndex = direction === 'UP' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= activeRouting.operations.length) return;

    const newOps = [...activeRouting.operations];
    const temp = newOps[index];
    newOps[index] = newOps[targetIndex];
    newOps[targetIndex] = temp;

    const renumberedOps = newOps.map((op, i) => {
      const newStepNum = (i + 1) * 10;
      return {
        ...op,
        stepNumber: newStepNum,
        stepCode: op.stepCode.replace(/OP\d+/i, `OP${newStepNum}`),
      };
    });

    await onSaveRouting({
      ...activeRouting,
      operations: renumberedOps,
    });
  };

  const handleSaveStep = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!activeRouting) return;

    if (!stepData.stepName || !stepData.processType) {
      setFormError('نام عملیات و نوع فرآیند الزامی هستند.');
      return;
    }

    setLoading(true);
    try {
      const machine = machines.find(m => m.id === stepData.machineId);
      const die = dies.find(d => d.id === stepData.dieMoldId);

      const normalizedStep: OperationStep = {
        stepNumber: Number(stepData.stepNumber) || 10,
        stepCode: stepData.stepCode || `OP${stepData.stepNumber}`,
        stepName: stepData.stepName,
        processType: stepData.processType as ProcessType,
        machineId: stepData.machineId,
        machineName: machine ? machine.name : undefined,
        dieMoldId: stepData.dieMoldId,
        dieMoldName: die ? die.name : undefined,
        requiredTonnage: Number(stepData.requiredTonnage) || 0,
        setupTimeMin: Number(stepData.setupTimeMin) || 0,
        standardCycleTimeSec: Number(stepData.standardCycleTimeSec) || 10,
        scrapNormPercent: Number(stepData.scrapNormPercent) || 1,
        description: stepData.description || '',
        isSharedOperation: stepData.isSharedOperation || false,
        sharedPartId: stepData.sharedPartId,
        sharedPartCode: stepData.sharedPartCode,
        sharedPartName: stepData.sharedPartName,
        sharedYieldRatio: Number(stepData.sharedYieldRatio) || 1,
        sharedOperationNotes: stepData.sharedOperationNotes || '',
      };

      let newOps = [...activeRouting.operations];
      if (editingStepIndex !== null && editingStepIndex >= 0) {
        newOps[editingStepIndex] = normalizedStep;
      } else {
        newOps.push(normalizedStep);
      }

      newOps.sort((a, b) => a.stepNumber - b.stepNumber);

      const res = await onSaveRouting({
        ...activeRouting,
        operations: newOps,
      });

      if (res.success) {
        setIsStepModalOpen(false);
      } else {
        setFormError(res.error || 'خطا در ثبت گام عملیات');
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'خطای سرور');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateNewRouting = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!newRoutingPartId) {
      setFormError('لطفاً قطعه مورد نظر را از کاتالوگ انتخاب نمایید.');
      return;
    }

    const part = parts.find(p => p.id === newRoutingPartId);
    if (!part) return;

    setLoading(true);
    try {
      const initialStep: OperationStep = {
        stepNumber: 10,
        stepCode: 'OP10_BLNK',
        stepName: `بلنکینگ و برش اولیه ${part.name}`,
        processType: 'BLANKING',
        machineId: machines[0]?.id,
        machineName: machines[0]?.name,
        standardCycleTimeSec: 15,
        scrapNormPercent: 1.2,
        description: 'برش و آماده‌سازی بلنک مطابق نقشه مهندسی ساپکو',
      };

      const res = await onSaveRouting({
        partId: part.id,
        partCode: part.code,
        partName: part.name,
        version: newRoutingVersion || 'V1.0',
        operations: [initialStep],
        notes: newRoutingNotes,
      });

      if (res.success) {
        setIsNewRoutingModalOpen(false);
        setNewRoutingPartId('');
        setViewMode('STEPPER');
      } else {
        setFormError(res.error || 'خطا در ایجاد مسیر تولید');
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'خطای ارتباط');
    } finally {
      setLoading(false);
    }
  };

  const handleOpenEditRouting = () => {
    if (!activeRouting) return;
    setEditVersion(activeRouting.version || 'V1.0');
    setEditNotes(activeRouting.notes || '');
    setIsEditRoutingModalOpen(true);
  };

  const handleSaveEditRouting = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeRouting) return;

    try {
      const res = await onSaveRouting({
        ...activeRouting,
        version: editVersion,
        notes: editNotes,
      });
      if (res.success) {
        setIsEditRoutingModalOpen(false);
      } else {
        setFormError(res.error || 'خطا در ذخیره ویرایش');
      }
    } catch {
      setFormError('خطا در ذخیره ویرایش');
    }
  };

  const handleDeleteRouting = async () => {
    if (!activeRouting) return;
    requestConfirm({
      title: 'حذف کامل مسیر تولید (Routing)',
      message: `آیا از حذف کامل مسیر تولید برای قطعه [${activeRouting.partCode}] ${activeRouting.partName} اطمینان دارید؟`,
      variant: 'danger',
      confirmLabel: 'بله، حذف مسیر',
      onConfirm: async () => {
        if (onDeleteRouting) {
          await onDeleteRouting(activeRouting.id);
        }
      },
    });
  };

  return (
    <div className="space-y-5 font-sans text-right">
      {/* SAP HANA Fiori Header Banner */}
      <div className="sap-card p-4 space-y-3.5">
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
          <div className="flex items-start sm:items-center gap-3">
            <div className="w-9 h-9 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-brand-bg)] border border-[var(--fiori-brand-border)] text-[var(--fiori-brand)] flex items-center justify-center shrink-0">
              <GitFork className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-bold text-[var(--fiori-text-primary)]">
                  مدیریت مسیرهای مهندسی تولید (Manufacturing Routings)
                </h2>
                <FioriObjectStatus
                  tone="info"
                  label={<span className="tabular-nums">{toPersianDigits(routings.length)} مسیر فعال</span>}
                />
              </div>
              <p className="text-xs text-[var(--fiori-text-secondary)] mt-0.5">
                تعیین توالی ایستگاه‌های کاری (OP10 برش، OP20 کشش، OP30 پانچ و...)، انتساب پرس، قالب و زمان‌های استاندارد
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 self-end lg:self-auto">
            <button
              type="button"
              onClick={() => {
                setNewRoutingPartId('');
                setNewRoutingVersion('V1.0');
                setNewRoutingNotes('');
                setFormError(null);
                setIsNewRoutingModalOpen(true);
              }}
              className="sap-btn-emphasized flex items-center gap-1.5 px-3.5 py-1.5 text-xs cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>تعریف مسیر تولید برای قطعه جدید</span>
            </button>

            <div className="inline-flex rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] p-0.5 bg-[var(--fiori-bg-subtle)] text-xs">
              <button
                type="button"
                onClick={() => {
                  if (viewMode !== 'STEPPER') {
                    pushSelectionStep(
                      'مراحل مسیر تولید',
                      () => setViewMode('DIRECTORY'),
                      'routings-stepper',
                    );
                  }
                  setViewMode('STEPPER');
                }}
                className={`px-3 py-1 rounded-[var(--fiori-radius-sm)] font-medium transition cursor-pointer ${
                  viewMode === 'STEPPER'
                    ? 'bg-[var(--fiori-bg-surface)] font-bold text-[var(--fiori-brand)] border border-[var(--fiori-border-default)]'
                    : 'text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)]'
                }`}
              >
                نمای مراحل عملیات
              </button>
              <button
                type="button"
                onClick={() => {
                  if (viewMode !== 'DIRECTORY') {
                    pushSelectionStep(
                      'کاتالوگ مسیرها',
                      () => setViewMode('STEPPER'),
                      'routings-directory',
                    );
                  }
                  setViewMode('DIRECTORY');
                }}
                className={`px-3 py-1 rounded-[var(--fiori-radius-sm)] font-medium transition cursor-pointer tabular-nums ${
                  viewMode === 'DIRECTORY'
                    ? 'bg-[var(--fiori-bg-surface)] font-bold text-[var(--fiori-brand)] border border-[var(--fiori-border-default)]'
                    : 'text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)]'
                }`}
              >
                کاتالوگ کلیه قطعات ({toPersianDigits(parts.length)})
              </button>
            </div>
            {viewMode === 'STEPPER' && (
              <button
                type="button"
                onClick={() => setViewMode('DIRECTORY')}
                className="sap-btn-standard px-2.5 py-1.5 text-xs font-medium cursor-pointer whitespace-nowrap"
                title="بازگشت به فهرست کلی قطعات"
              >
                بازگشت به فهرست مسیرها
              </button>
            )}
          </div>
        </div>

        {/* Filter and Search Bar */}
        <div className="pt-3 border-t border-[var(--fiori-border-subtle)] flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Instant Search Input */}
            <div className="relative">
              <Search className="w-4 h-4 text-[var(--fiori-text-secondary)] absolute right-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="جستجو در کد فنی، نام قطعه یا گام عملیات..."
                className="fiori-input pr-9 pl-3 py-1.5 text-xs w-64"
              />
            </div>

            {/* Dynamic Car Model Filter Chips */}
            <div className="flex items-center gap-1 overflow-x-auto">
              <button
                type="button"
                onClick={() => setSelectedCarModel('ALL')}
                className={`px-2.5 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-medium transition cursor-pointer border ${
                  selectedCarModel === 'ALL'
                    ? 'bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border-[var(--fiori-brand)] font-bold'
                    : 'bg-[var(--fiori-bg-surface)] text-[var(--fiori-text-secondary)] border-[var(--fiori-border-default)] hover:bg-[var(--fiori-bg-hover)]'
                }`}
              >
                همه مدل‌ها
              </button>
              {carModelsList.map(m => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSelectedCarModel(m.name)}
                  className={`px-2.5 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-medium transition cursor-pointer border whitespace-nowrap ${
                    selectedCarModel === m.name
                      ? 'bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border-[var(--fiori-brand)] font-bold'
                      : 'bg-[var(--fiori-bg-surface)] text-[var(--fiori-text-secondary)] border-[var(--fiori-border-default)] hover:bg-[var(--fiori-bg-hover)]'
                  }`}
                >
                  {m.name}
                </button>
              ))}
            </div>
          </div>

          {/* Quick Routing Selector Dropdown */}
          <div className="flex items-center gap-2 flex-wrap">
            {route.docQuery && (
              <button
                type="button"
                onClick={() => {
                  clearDocQuery();
                  setSearchQuery('');
                }}
                className="px-2 py-1 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border border-[var(--fiori-brand-border)] flex items-center gap-1 cursor-pointer text-[11px]"
              >
                <span>فیلتر لینک: <span className="fiori-ltr-code font-mono">{route.docQuery}</span></span>
                <X className="w-3 h-3" />
              </button>
            )}
            <span className="text-[var(--fiori-text-secondary)] text-[11px]">انتخاب مسیر جاری:</span>
            <select
              value={activeRouting?.id || ''}
              onChange={e => {
                const nextId = e.target.value;
                const prevId = selectedRoutingId;
                const prevMode = viewMode;
                const targetR = routings.find(item => item.id === nextId);
                if (nextId && nextId !== prevId) {
                  pushSelectionStep(
                    `مسیر ${targetR?.partCode || nextId}`,
                    () => {
                      setSelectedRoutingId(prevId);
                      setViewMode(prevMode);
                    },
                    `routing-${nextId}`,
                  );
                }
                setSelectedRoutingId(nextId);
                setViewMode('STEPPER');
              }}
              className="fiori-input px-2.5 py-1 text-xs font-bold cursor-pointer"
            >
              {filteredRoutings.map(r => (
                <option key={r.id} value={r.id}>
                  [{r.partCode}] {r.partName} ({toPersianDigits(r.operations.length)} مرحله)
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Missing Routing CTA for searched/linked part */}
      {searchQuery.trim() && filteredRoutings.length === 0 && (
        <FioriMessageStrip
          tone="warning"
          title={`مسیر عملیات تولید (Routing) برای «${searchQuery.trim()}» یافت نشد`}
          actions={
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  const q = searchQuery.trim().toLowerCase();
                  const matchedPart = parts.find(
                    p =>
                      p.code.toLowerCase() === q ||
                      p.name.toLowerCase() === q ||
                      p.code.toLowerCase().includes(q) ||
                      p.name.toLowerCase().includes(q),
                  );
                  setNewRoutingPartId(matchedPart?.id || '');
                  setNewRoutingVersion('V1.0');
                  setNewRoutingNotes('');
                  setFormError(null);
                  setIsNewRoutingModalOpen(true);
                }}
                className="sap-btn-emphasized flex items-center gap-1.5 px-3 py-1 text-xs cursor-pointer whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>تعریف مسیر عملیات برای این قطعه</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  clearDocQuery();
                  setSearchQuery('');
                }}
                className="sap-btn-standard px-3 py-1 text-xs cursor-pointer"
              >
                نمایش همه مسیرها
              </button>
            </div>
          }
        >
          برای زمان‌بندی ماشین‌آلات و صدور دستور کار (MO) ابتدا باید مسیر عملیات قطعه را تعریف کنید.
        </FioriMessageStrip>
      )}

      {/* VIEW MODE 1: ALL PARTS DIRECTORY */}
      {viewMode === 'DIRECTORY' && (
        <div className="sap-card overflow-hidden">
          <FioriToolbar
            variant="table"
            title={
              <span className="inline-flex items-center gap-2">
                <Layers className="w-4 h-4 text-[var(--fiori-brand)]" />
                <span>وضعیت تخصیص مسیر تولید به قطعات کاتالوگ کارخانه</span>
              </span>
            }
            count={parts.length}
            countLabel="قطعه در کاتالوگ"
            endContent={
              <FioriObjectStatus
                tone="positive"
                label={<span className="tabular-nums">{toPersianDigits(routings.length)} دارای مسیر ساخت</span>}
              />
            }
          />

          <div className="overflow-x-auto">
            <table className="sap-table-compact w-full text-right text-xs">
              <thead>
                <tr>
                  <th>کد قطعه</th>
                  <th>عنوان قطعه در خط</th>
                  <th>نوع کالا</th>
                  <th>مدل خودرو</th>
                  <th>وضعیت مسیر ساخت</th>
                  <th>تعداد مراحل (OP)</th>
                  <th className="text-center">عملیات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--fiori-border-subtle)] text-[var(--fiori-text-primary)]">
                {parts.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-4">
                      <EmptyState
                        compact
                        variant="NO_DATA"
                        title="هیچ قطعه‌ای در کاتالوگ ثبت نشده است"
                        description="ابتدا قطعات را در کاتالوگ ثبت کنید تا وضعیت مسیر تولید آن‌ها نمایش داده شود."
                      />
                    </td>
                  </tr>
                ) : (
                  parts.map(p => {
                    const r = routings.find(rt => rt.partId === p.id || rt.partCode === p.code);
                    return (
                      <tr key={p.id} className="hover:bg-[var(--fiori-bg-hover)] transition-colors">
                        <td className="font-mono font-bold">
                          <button
                            type="button"
                            onClick={() => traceDocument(p.code, 'INVENTORY_LEDGER')}
                            className="sap-doc-link fiori-ltr-code"
                          >
                            {p.code}
                          </button>
                        </td>
                        <td className="font-medium text-[var(--fiori-text-primary)]">{p.name}</td>
                        <td>
                          <FioriObjectStatus
                            tone={
                              p.category === 'FINISHED_GOOD'
                                ? 'positive'
                                : p.category === 'WIP_PART'
                                ? 'critical'
                                : 'neutral'
                            }
                            label={
                              p.category === 'FINISHED_GOOD'
                                ? 'محصول نهایی'
                                : p.category === 'WIP_PART'
                                ? 'نیمه‌ساخته'
                                : 'ماده اولیه'
                            }
                          />
                        </td>
                        <td className="text-[var(--fiori-text-secondary)]">{p.carModel || 'مشترک'}</td>
                        <td>
                          {r ? (
                            <FioriObjectStatus
                              tone="positive"
                              variant="text"
                              icon={<CheckCircle2 className="w-3.5 h-3.5" />}
                              label={`دارای مسیر (نسخه ${r.version})`}
                            />
                          ) : (
                            <FioriObjectStatus tone="neutral" variant="text" label="فاقد مسیر تولید" />
                          )}
                        </td>
                        <td className="font-mono tabular-nums">
                          {r ? `${toPersianDigits(r.operations.length)} ایستگاه` : '—'}
                        </td>
                        <td className="text-center">
                          {r ? (
                            <button
                              type="button"
                              onClick={() => {
                                const prevId = selectedRoutingId;
                                const prevMode = viewMode;
                                pushSelectionStep(
                                  `مسیر ${r.partCode}`,
                                  () => {
                                    setSelectedRoutingId(prevId);
                                    setViewMode(prevMode);
                                  },
                                  `routing-${r.id}`,
                                );
                                setSelectedRoutingId(r.id);
                                setViewMode('STEPPER');
                              }}
                              className="sap-btn-standard px-2.5 py-1 text-xs cursor-pointer"
                            >
                              مشاهده و ویرایش مراحل ←
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setNewRoutingPartId(p.id);
                                setNewRoutingVersion('V1.0');
                                setNewRoutingNotes('');
                                setIsNewRoutingModalOpen(true);
                              }}
                              className="sap-btn-emphasized px-2.5 py-1 text-xs cursor-pointer"
                            >
                              + ایجاد مسیر برای این قطعه
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* VIEW MODE 2: STEPPER & PROCESS DETAILS */}
      {viewMode === 'STEPPER' && activeRouting && (
        <div className="space-y-4">
          {/* Active Routing Summary Card */}
          <div className="sap-card p-4 space-y-4">
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 pb-3 border-b border-[var(--fiori-border-subtle)]">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => traceDocument(activeRouting.partCode, 'INVENTORY_LEDGER')}
                    className="sap-doc-link text-xs px-2.5 py-0.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-brand-bg)] border border-[var(--fiori-brand-border)] font-mono font-bold fiori-ltr-code"
                    title="رهگیری موجودی و کاردکس این قطعه"
                  >
                    {activeRouting.partCode}
                  </button>
                  <FioriObjectStatus tone="neutral" label={`نسخه ${activeRouting.version}`} />
                  <span className="text-xs text-[var(--fiori-text-secondary)] tabular-nums">
                    توالی: <strong>{toPersianDigits(activeRouting.operations.length)} ایستگاه عملیاتی</strong>
                  </span>
                </div>
                <h3 className="text-base font-bold text-[var(--fiori-text-primary)] mt-2">
                  {activeRouting.partName}
                </h3>
                {activeRouting.notes && (
                  <p className="text-xs text-[var(--fiori-text-secondary)] mt-1 leading-relaxed">
                    الزامات کیفی و یادداشت‌ها: {activeRouting.notes}
                  </p>
                )}
              </div>

              {/* Action Buttons for Active Routing */}
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <div className="px-3 py-1.5 bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] text-left sm:text-right">
                  <span className="text-[10px] text-[var(--fiori-text-secondary)] block">زمان چرخه کل ساخت:</span>
                  <span className="text-xs font-bold text-[var(--fiori-positive)] font-mono tabular-nums">
                    {toPersianDigits(activeRouting.operations.reduce((s, op) => s + op.standardCycleTimeSec, 0))} ثانیه
                  </span>
                </div>

                <button
                  type="button"
                  onClick={handleOpenAddStep}
                  className="sap-btn-emphasized flex items-center gap-1.5 px-3.5 py-1.5 text-xs cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>+ افزودن مرحله عملیاتی جدید (OP)</span>
                </button>

                <button
                  type="button"
                  onClick={handleOpenEditRouting}
                  className="sap-btn-standard px-3 py-1.5 text-xs cursor-pointer"
                >
                  <Edit3 className="w-3.5 h-3.5 inline ml-1" />
                  ویرایش سند
                </button>

                <button
                  type="button"
                  onClick={handleDeleteRouting}
                  className="p-1.5 text-[var(--fiori-negative)] hover:bg-[var(--fiori-negative-bg)] rounded-[var(--fiori-radius-sm)] transition cursor-pointer border border-[var(--fiori-negative-border)]"
                  title="حذف این مسیر"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Visual Process Flow Horizontal Stepper */}
            <div className="space-y-2">
              <span className="text-xs font-bold text-[var(--fiori-text-primary)] block">گردش متوالی فرآیند ساخت:</span>
              <div className="flex items-center gap-2 overflow-x-auto py-2">
                {activeRouting.operations.map((op, idx) => (
                  <React.Fragment key={op.stepNumber || idx}>
                    <div className="flex-1 min-w-[150px] p-2.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] text-right space-y-1">
                      <div className="flex items-center justify-between gap-1">
                        <FioriObjectStatus tone="brand" ltrCode label={op.stepCode} />
                        <span className="text-[10px] text-[var(--fiori-text-secondary)] font-mono tabular-nums">
                          {toPersianDigits(op.standardCycleTimeSec)}s
                        </span>
                      </div>
                      <div className="font-bold text-xs text-[var(--fiori-text-primary)] line-clamp-1 mt-1">{op.stepName}</div>
                      {op.isSharedOperation && (
                        <FioriObjectStatus
                          tone="info"
                          label={`قالب ۲ کویته (${op.sharedPartCode || 'هم‌تولید'})`}
                          className="mt-1"
                        />
                      )}
                      <div className="text-[11px] text-[var(--fiori-text-secondary)] line-clamp-1">{op.machineName || 'پرس دستی'}</div>
                    </div>
                    {idx < activeRouting.operations.length - 1 && (
                      <ArrowLeft className="w-4 h-4 text-[var(--fiori-text-secondary)] shrink-0" />
                    )}
                  </React.Fragment>
                ))}
              </div>
            </div>

            {/* Operations Breakdown Table */}
            <div className="border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] overflow-hidden bg-[var(--fiori-bg-surface)]">
              <FioriToolbar
                variant="table"
                title="جزئیات مهندسی ایستگاه‌ها، قالب‌ها و پارامترهای کنترل فرآیند"
                count={activeRouting.operations.length}
                countLabel="مرحله عملیاتی"
              />

              <div className="overflow-x-auto">
                <table className="sap-table-compact w-full text-right text-xs">
                  <thead>
                    <tr>
                      <th>شماره گام</th>
                      <th>کد و عنوان عملیات</th>
                      <th>نوع فرآیند</th>
                      <th>پرس / دستگاه انتسابی</th>
                      <th>قالب متصل</th>
                      <th className="text-center">تناژ لازم</th>
                      <th className="text-center">زمان سیکل (ثانیه)</th>
                      <th className="text-center">ستاپ (دقیقه)</th>
                      <th className="text-center">ضایعات مجاز</th>
                      <th className="text-center">عملیات</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--fiori-border-subtle)] text-[var(--fiori-text-primary)]">
                    {activeRouting.operations.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="p-4">
                          <EmptyState
                            compact
                            variant="NO_DATA"
                            title="هنوز مرحله عملیاتی برای این مسیر تعریف نشده است"
                            description="برای تعریف ایستگاه‌ها، پرس‌ها و قالب‌های مرتبط روی دکمه افزودن مرحله کلیک کنید."
                            actionLabel="افزودن مرحله عملیاتی جدید"
                            onAction={handleOpenAddStep}
                          />
                        </td>
                      </tr>
                    ) : (
                      activeRouting.operations.map((step, idx) => (
                        <tr key={step.stepNumber || idx} className="hover:bg-[var(--fiori-bg-hover)] transition-colors">
                          <td className="font-mono font-bold text-[var(--fiori-brand)]">
                            <span className="fiori-ltr-code">{step.stepCode}</span>
                          </td>
                          <td className="font-bold text-[var(--fiori-text-primary)]">
                            {step.stepName}
                            {step.isSharedOperation && (
                              <span className="mt-1 inline-flex items-center gap-1 flex-wrap text-[10px] font-bold text-[var(--fiori-brand)] bg-[var(--fiori-brand-bg)] border border-[var(--fiori-brand-border)] px-2 py-0.5 rounded-[var(--fiori-radius-sm)] w-fit tabular-nums">
                                عملیات مشترک: خروجی همزمان{' '}
                                {step.sharedPartCode ? (
                                  <button
                                    type="button"
                                    onClick={() => traceDocument(step.sharedPartCode!, 'INVENTORY_LEDGER')}
                                    className="sap-doc-link font-mono fiori-ltr-code"
                                  >
                                    [{step.sharedPartCode}]
                                  </button>
                                ) : null}{' '}
                                ({toPersianDigits(step.sharedYieldRatio || 1)} عدد در هر ضرب)
                              </span>
                            )}
                            {step.description && (
                              <span className="block text-[11px] font-normal text-[var(--fiori-text-secondary)] mt-0.5">
                                {step.description}
                              </span>
                            )}
                          </td>
                          <td>
                            <FioriObjectStatus tone="neutral" ltrCode label={step.processType} />
                          </td>
                          <td className="text-[var(--fiori-text-primary)] font-medium">
                            {step.machineName || 'پرس مشترک سالن'}
                          </td>
                          <td className="font-mono text-[var(--fiori-brand)] text-[11px]">
                            {step.dieMoldName || 'فاقد قالب'}
                          </td>
                          <td className="text-center font-mono font-bold text-[var(--fiori-text-primary)] tabular-nums">
                            {step.requiredTonnage ? `${toPersianDigits(step.requiredTonnage)}T` : '—'}
                          </td>
                          <td className="text-center font-mono font-bold text-[var(--fiori-text-primary)] tabular-nums">
                            {toPersianDigits(step.standardCycleTimeSec)}
                          </td>
                          <td className="text-center font-mono text-[var(--fiori-text-secondary)] tabular-nums">
                            {toPersianDigits(step.setupTimeMin || 0)}
                          </td>
                          <td className="text-center font-mono text-[var(--fiori-critical)] font-bold tabular-nums">
                            {toPersianDigits(step.scrapNormPercent)}%
                          </td>
                          <td className="text-center">
                            <div className="flex items-center justify-center gap-1">
                              <button
                                type="button"
                                disabled={idx === 0}
                                onClick={() => handleMoveStep(idx, 'UP')}
                                className="p-1 text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] hover:bg-[var(--fiori-brand-bg)] disabled:opacity-30 rounded-[var(--fiori-radius-sm)] transition cursor-pointer"
                                title="انتقال به گام قبلی (تغییر توالی)"
                              >
                                <ChevronUp className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                disabled={idx === activeRouting.operations.length - 1}
                                onClick={() => handleMoveStep(idx, 'DOWN')}
                                className="p-1 text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] hover:bg-[var(--fiori-brand-bg)] disabled:opacity-30 rounded-[var(--fiori-radius-sm)] transition cursor-pointer"
                                title="انتقال به گام بعدی (تغییر توالی)"
                              >
                                <ChevronDown className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleOpenEditStep(step, idx)}
                                className="p-1.5 text-[var(--fiori-brand)] hover:bg-[var(--fiori-brand-bg)] rounded-[var(--fiori-radius-sm)] transition cursor-pointer"
                                title="ویرایش گام"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteStep(idx)}
                                className="p-1.5 text-[var(--fiori-negative)] hover:bg-[var(--fiori-negative-bg)] rounded-[var(--fiori-radius-sm)] transition cursor-pointer"
                                title="حذف گام"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 1: CREATE NEW ROUTING */}
      <FioriDialog
        isOpen={isNewRoutingModalOpen}
        onClose={() => setIsNewRoutingModalOpen(false)}
        title="تعریف مسیر تولید مهندسی برای قطعه جدید"
        icon={<GitFork className="w-4 h-4" />}
        tone="brand"
        size="md"
        footer={
          <>
            <button
              type="button"
              onClick={() => setIsNewRoutingModalOpen(false)}
              className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="rtg-new-form"
              disabled={loading}
              className="sap-btn-emphasized px-5 py-1.5 text-xs cursor-pointer disabled:opacity-50"
            >
              {loading ? 'در حال ایجاد...' : 'ایجاد مسیر تولید'}
            </button>
          </>
        }
      >
        {formError && (
          <FioriMessageStrip compact tone="error">
            {formError}
          </FioriMessageStrip>
        )}

        <form id="rtg-new-form" onSubmit={handleCreateNewRouting} className="space-y-3.5 text-xs">
          <div>
            <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">
              انتخاب قطعه خودرویی از کاتالوگ *
            </label>
            <SearchableSelect
              value={newRoutingPartId}
              onChange={val => setNewRoutingPartId(val)}
              placeholder="جستجو و انتخاب قطعه برای ساخت مسیر..."
              searchPlaceholder="جستجوی کد یا نام قطعه..."
              options={parts.map(p => ({
                value: p.id,
                label: p.name,
                sublabel: `${p.code} • ${p.carModel || 'مشترک'}`,
                badge: p.category === 'FINISHED_GOOD' ? 'محصول' : p.category === 'WIP_PART' ? 'نیمه‌ساخته' : 'ماده اولیه',
              }))}
              required
            />
          </div>

          <div>
            <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">نسخه مهندسی نقشه ساخت *</label>
            <input
              type="text"
              required
              value={newRoutingVersion}
              onChange={e => setNewRoutingVersion(e.target.value)}
              placeholder="V1.0 یا V2.1"
              className="fiori-input w-full px-3 py-1.5 font-mono fiori-ltr-code"
            />
          </div>

          <div>
            <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">یادداشت‌ها و الزامات قرارداد ساپکو</label>
            <textarea
              rows={2}
              value={newRoutingNotes}
              onChange={e => setNewRoutingNotes(e.target.value)}
              placeholder="الزامات ابعادی، تلرانس‌های مجاز، نوع روانکاری ورق و کنترل پلیسه..."
              className="fiori-input w-full p-2.5"
            />
          </div>
        </form>
      </FioriDialog>

      {/* MODAL 2: EDIT ACTIVE ROUTING */}
      <FioriDialog
        isOpen={isEditRoutingModalOpen}
        onClose={() => setIsEditRoutingModalOpen(false)}
        title="ویرایش مشخصات سند مسیر تولید"
        icon={<Edit3 className="w-4 h-4" />}
        tone="default"
        size="sm"
        footer={
          <>
            <button
              type="button"
              onClick={() => setIsEditRoutingModalOpen(false)}
              className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="rtg-edit-form"
              className="sap-btn-emphasized px-5 py-1.5 text-xs cursor-pointer"
            >
              ثبت تغییرات
            </button>
          </>
        }
      >
        <form id="rtg-edit-form" onSubmit={handleSaveEditRouting} className="space-y-3.5 text-xs">
          <div>
            <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">نسخه مهندسی مسیر</label>
            <input
              type="text"
              required
              value={editVersion}
              onChange={e => setEditVersion(e.target.value)}
              className="fiori-input w-full px-3 py-1.5 font-mono fiori-ltr-code"
            />
          </div>

          <div>
            <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">یادداشت‌ها و الزامات نقشه</label>
            <textarea
              rows={3}
              value={editNotes}
              onChange={e => setEditNotes(e.target.value)}
              className="fiori-input w-full p-2.5"
            />
          </div>
        </form>
      </FioriDialog>

      {/* MODAL 3: ADD / EDIT OPERATION STEP */}
      <FioriDialog
        isOpen={isStepModalOpen}
        onClose={() => setIsStepModalOpen(false)}
        title={editingStepIndex !== null ? 'ویرایش گام عملیات' : 'افزودن گام عملیاتی OP جدید'}
        icon={<Settings className="w-4 h-4" />}
        tone="brand"
        size="lg"
        footer={
          <>
            <button
              type="button"
              onClick={() => setIsStepModalOpen(false)}
              className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="rtg-step-form"
              disabled={loading}
              className="sap-btn-emphasized px-5 py-1.5 text-xs cursor-pointer disabled:opacity-50"
            >
              {loading ? 'در حال ذخیره...' : 'ذخیره گام عملیاتی'}
            </button>
          </>
        }
      >
        {formError && (
          <FioriMessageStrip compact tone="error">
            {formError}
          </FioriMessageStrip>
        )}

        <form id="rtg-step-form" onSubmit={handleSaveStep} className="space-y-3.5 text-xs">
          {/* MASTER OPERATION LIBRARY SELECTOR */}
          <div className="p-3 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-info-bg)] border border-[var(--fiori-info-border)] space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-[var(--fiori-text-primary)] flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
                <span>اتصال به عملیات استاندارد مهندسی (Master Operations Library)</span>
              </label>
              {selectedMasterOpId && (
                <button
                  type="button"
                  onClick={() => setSelectedMasterOpId('')}
                  className="text-[10px] text-[var(--fiori-brand)] hover:underline cursor-pointer"
                >
                  قطع ارتباط
                </button>
              )}
            </div>
            <select
              value={selectedMasterOpId}
              onChange={e => handleSelectMasterOperation(e.target.value)}
              className="fiori-input w-full px-2.5 py-1.5 text-xs font-medium"
            >
              <option value="">-- انتخاب از کاتالوگ عملیات تعریف‌شده در اطلاعات پایه (تکمیل خودکار) --</option>
              {operationsLibrary.map(op => (
                <option key={op.id} value={op.id}>
                  [{op.code}] {op.name} — {op.stationType || op.category} (سیکل: {toPersianDigits(op.cycleTimeSec)}s، ستاپ: {toPersianDigits(op.setupTimeMin)}min)
                </option>
              ))}
            </select>
            {selectedMasterOpId ? (
              <p className="text-[10px] text-[var(--fiori-positive)] flex items-center gap-1 tabular-nums">
                <CheckCircle2 className="w-3 h-3 shrink-0" />
                <span>
                  عنوان، زمان چرخه ({toPersianDigits(stepData.standardCycleTimeSec || 0)} ثانیه)، زمان تعویض قالب ({toPersianDigits(stepData.setupTimeMin || 0)} دقیقه) و ایستگاه کاری خودکار از شناسنامه عملیات پایه بارگذاری شدند.
                </span>
              </p>
            ) : (
              <p className="text-[10px] text-[var(--fiori-text-secondary)]">
                با انتخاب یکی از عملیات استاندارد، فیلدهای فنی، زمان ستاپ و دستگاه منطبق به طور خودکار تکمیل می‌گردند.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">شماره گام (Step Number) *</label>
              <input
                type="number"
                step={10}
                required
                value={stepData.stepNumber || 10}
                onChange={e => setStepData({ ...stepData, stepNumber: parseInt(e.target.value, 10) || 10 })}
                className="fiori-input w-full px-3 py-1.5 font-mono tabular-nums"
              />
              <span className="text-[10px] text-[var(--fiori-text-secondary)] block mt-0.5">معمولاً به صورت مضارب ۱۰ (OP10, OP20, OP30)</span>
            </div>
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">کد فنی گام *</label>
              <input
                type="text"
                required
                value={stepData.stepCode || ''}
                onChange={e => setStepData({ ...stepData, stepCode: e.target.value })}
                placeholder="OP20_DRAW"
                className="fiori-input w-full px-3 py-1.5 font-mono fiori-ltr-code"
              />
            </div>
          </div>

          <div>
            <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">عنوان کامل عملیات *</label>
            <input
              type="text"
              required
              value={stepData.stepName || ''}
              onChange={e => setStepData({ ...stepData, stepName: e.target.value })}
              placeholder="مثال: کشش عمیق پوسته و فرم‌دهی در پرس ۸۰۰ تن"
              className="fiori-input w-full px-3 py-1.5 font-medium"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">نوع فرآیند *</label>
              <select
                value={stepData.processType}
                onChange={e => setStepData({ ...stepData, processType: e.target.value as ProcessType })}
                className="fiori-input w-full px-3 py-1.5"
              >
                {PROCESS_DEFINITIONS.map(p => (
                  <option key={p.code} value={p.code}>
                    {p.name} ({p.code})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="font-medium text-[var(--fiori-text-primary)]">پرس / دستگاه انتسابی</label>
                <button
                  type="button"
                  onClick={() => setIsQuickMachineModalOpen(true)}
                  className="text-[10px] text-[var(--fiori-brand)] hover:underline font-bold flex items-center gap-0.5 cursor-pointer"
                  title="افزودن سریع پرس جدید بدون خروج از این صفحه"
                >
                  <Plus className="w-3 h-3" />
                  <span>+ پرس جدید</span>
                </button>
              </div>
              <select
                value={stepData.machineId || ''}
                onChange={e => setStepData({ ...stepData, machineId: e.target.value })}
                className="fiori-input w-full px-3 py-1.5"
              >
                <option value="">-- بدون انتساب / دستی --</option>
                {machines.map(m => (
                  <option key={m.id} value={m.id}>
                    [{m.code}] {m.name} ({m.tonnage}T)
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="font-medium text-[var(--fiori-text-primary)]">قالب پرس متصل (همبسته با قطعه)</label>
                <button
                  type="button"
                  onClick={() => setIsQuickDieModalOpen(true)}
                  className="text-[10px] text-[var(--fiori-brand)] hover:underline font-bold flex items-center gap-0.5 cursor-pointer"
                  title="افزودن سریع قالب جدید متصل به این قطعه"
                >
                  <Plus className="w-3 h-3" />
                  <span>+ قالب جدید</span>
                </button>
              </div>
              <select
                value={stepData.dieMoldId || ''}
                onChange={e => {
                  const dId = e.target.value;
                  const selectedDie = dies.find(d => d.id === dId || d.code === dId);
                  setStepData({
                    ...stepData,
                    dieMoldId: dId,
                    requiredTonnage: selectedDie?.requiredTonnage || stepData.requiredTonnage,
                  });
                }}
                className="fiori-input w-full px-3 py-1.5"
              >
                <option value="">-- بدون قالب اختصاصی --</option>
                {(showAllDies || correlatedDies.length === 0 ? dies : correlatedDies).map(d => (
                  <option key={d.id} value={d.id}>
                    [{d.code}] {d.name} ({d.requiredTonnage}T)
                    {d.partCode ? ` • قطعه: ${d.partCode}` : ''}
                  </option>
                ))}
              </select>

              <div className="flex items-center justify-between mt-1 text-[10px]">
                <span className="text-[var(--fiori-text-secondary)] tabular-nums">
                  {correlatedDies.length > 0 && !showAllDies
                    ? `نمایش ${toPersianDigits(correlatedDies.length)} قالب اختصاصی «${activeRouting?.partName || 'این قطعه'}»`
                    : `نمایش کل ${toPersianDigits(dies.length)} قالب کارخانه`}
                </span>
                <button
                  type="button"
                  onClick={() => setShowAllDies(!showAllDies)}
                  className="text-[var(--fiori-brand)] hover:underline cursor-pointer font-medium"
                >
                  {showAllDies ? 'فقط قالب‌های مرتبط با این قطعه' : 'نمایش همه قالب‌ها'}
                </button>
              </div>
            </div>
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">تناژ اسمی مورد نیاز (تن)</label>
              <input
                type="number"
                value={stepData.requiredTonnage || 0}
                onChange={e => setStepData({ ...stepData, requiredTonnage: parseFloat(e.target.value) || 0 })}
                placeholder="400"
                className="fiori-input w-full px-3 py-1.5 font-mono tabular-nums"
              />
              <span className="text-[10px] text-[var(--fiori-text-secondary)] block mt-1">
                تنظیم خودکار بر اساس ظرفیت قالب یا پرس انتخابی
              </span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">زمان چرخه (ثانیه) *</label>
              <input
                type="number"
                step="0.5"
                required
                value={stepData.standardCycleTimeSec || 10}
                onChange={e => setStepData({ ...stepData, standardCycleTimeSec: parseFloat(e.target.value) || 10 })}
                className="fiori-input w-full px-3 py-1.5 font-mono tabular-nums"
              />
            </div>
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">زمان ستاپ قالب (دقیقه)</label>
              <input
                type="number"
                value={stepData.setupTimeMin || 0}
                onChange={e => setStepData({ ...stepData, setupTimeMin: parseFloat(e.target.value) || 0 })}
                className="fiori-input w-full px-3 py-1.5 font-mono tabular-nums"
              />
            </div>
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">نرم ضایعات مجاز (٪) *</label>
              <input
                type="number"
                step="0.1"
                required
                value={stepData.scrapNormPercent || 1}
                onChange={e => setStepData({ ...stepData, scrapNormPercent: parseFloat(e.target.value) || 1 })}
                className="fiori-input w-full px-3 py-1.5 font-mono tabular-nums"
              />
            </div>
          </div>

          <div>
            <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">دستورالعمل کنترل ابعادی و نکات قالب</label>
            <textarea
              rows={2}
              value={stepData.description || ''}
              onChange={e => setStepData({ ...stepData, description: e.target.value })}
              placeholder="نکات تنظیم لقی سنبه ماتریس، کنترل چروکیدگی کشش، روغن‌کاری ورق..."
              className="fiori-input w-full p-2.5"
            />
          </div>

          {/* Shared Operation / Dual-Output Co-Production Config */}
          <div className="p-3 bg-[var(--fiori-info-bg)] border border-[var(--fiori-info-border)] rounded-[var(--fiori-radius-sm)] space-y-2.5">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="isSharedOpCheck"
                checked={stepData.isSharedOperation || false}
                onChange={e => setStepData({ ...stepData, isSharedOperation: e.target.checked })}
                className="w-4 h-4 accent-[var(--fiori-brand)] rounded-sm cursor-pointer"
              />
              <label htmlFor="isSharedOpCheck" className="font-bold text-xs text-[var(--fiori-text-primary)] cursor-pointer">
                عملیات مشترک / خروجی همزمان دوگانه (قالب ۲ کویته متقارن مانند چپ و راست)
              </label>
            </div>

            {stepData.isSharedOperation && (
              <div className="space-y-2.5 pt-1 text-xs">
                <div>
                  <label className="block font-semibold text-[var(--fiori-text-primary)] mb-1">
                    انتخاب قطعه دوم هم‌تولید (Co-Produced Part) *
                  </label>
                  <select
                    value={stepData.sharedPartId || ''}
                    onChange={e => {
                      const pId = e.target.value;
                      const found = parts.find(p => p.id === pId || p.code === pId);
                      setStepData({
                        ...stepData,
                        sharedPartId: pId,
                        sharedPartCode: found?.code || '',
                        sharedPartName: found?.name || '',
                      });
                    }}
                    className="fiori-input w-full px-3 py-1.5 font-medium"
                  >
                    <option value="">-- انتخاب قطعه مکمل (مثلاً پشت صندلی راست) --</option>
                    {parts.map(p => (
                      <option key={p.id} value={p.id}>
                        [{p.code}] {p.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-[var(--fiori-text-primary)] mb-1">کد فنی قطعه دوم</label>
                    <input
                      type="text"
                      value={stepData.sharedPartCode || ''}
                      onChange={e => setStepData({ ...stepData, sharedPartCode: e.target.value })}
                      placeholder="SAPCO-ST-BACK-RH"
                      className="fiori-input w-full px-3 py-1.5 font-mono fiori-ltr-code"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-[var(--fiori-text-primary)] mb-1">نسبت خروجی در هر ضرب</label>
                    <input
                      type="number"
                      min={1}
                      value={stepData.sharedYieldRatio || 1}
                      onChange={e => setStepData({ ...stepData, sharedYieldRatio: parseInt(e.target.value, 10) || 1 })}
                      className="fiori-input w-full px-3 py-1.5 font-mono font-bold tabular-nums"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </form>
      </FioriDialog>

      {/* MODAL 4: QUICK ADD MACHINE / PRESS */}
      <FioriDialog
        isOpen={isQuickMachineModalOpen}
        onClose={() => setIsQuickMachineModalOpen(false)}
        title="تعریف سریع پرس / دستگاه جدید"
        icon={<Cpu className="w-4 h-4" />}
        tone="brand"
        size="sm"
        footer={
          <>
            <button
              type="button"
              onClick={() => setIsQuickMachineModalOpen(false)}
              className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="rtg-quick-machine-form"
              disabled={savingQuickMachine}
              className="sap-btn-emphasized px-5 py-1.5 text-xs cursor-pointer disabled:opacity-50"
            >
              {savingQuickMachine ? 'در حال ثبت...' : 'ثبت سریع و انتخاب پرس'}
            </button>
          </>
        }
      >
        <form id="rtg-quick-machine-form" onSubmit={handleCreateQuickMachine} className="space-y-3.5 text-xs">
          <div>
            <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">نام و مشخصات پرس / دستگاه *</label>
            <input
              type="text"
              required
              value={quickMachineName}
              onChange={e => setQuickMachineName(e.target.value)}
              placeholder="مثال: پرس ضربه‌ای ۲۵۰ تن کوماتسو شماره ۴"
              className="fiori-input w-full px-3 py-1.5 font-medium"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">کد دستگاه (اختیاری)</label>
              <input
                type="text"
                value={quickMachineCode}
                onChange={e => setQuickMachineCode(e.target.value)}
                placeholder="PRS-250T-04"
                className="fiori-input w-full px-3 py-1.5 font-mono fiori-ltr-code"
              />
            </div>
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">تناژ اسمی (تن) *</label>
              <input
                type="number"
                required
                value={quickMachineTonnage}
                onChange={e => setQuickMachineTonnage(Number(e.target.value) || 250)}
                className="fiori-input w-full px-3 py-1.5 font-mono font-bold tabular-nums"
              />
            </div>
          </div>

          <div>
            <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">سالن استقرار</label>
            <select
              value={quickMachineHall}
              onChange={e => setQuickMachineHall(e.target.value)}
              className="fiori-input w-full px-3 py-1.5"
            >
              <option value="سالن برش">سالن برش</option>
              <option value="سالن پرس">سالن پرس</option>
              <option value="سالن پرس سنگین">سالن پرس سنگین</option>
              <option value="سالن جوشکاری">سالن جوشکاری</option>
              <option value="سالن رنگ">سالن رنگ</option>
              <option value="سالن کیفیت">سالن کیفیت</option>
            </select>
          </div>
        </form>
      </FioriDialog>

      {/* MODAL 5: QUICK ADD DIE / MOLD */}
      <FioriDialog
        isOpen={isQuickDieModalOpen}
        onClose={() => setIsQuickDieModalOpen(false)}
        title="تعریف سریع قالب اختصاصی قطعه"
        subtitle={`همبسته به قطعه: ${activeRouting?.partName || 'قطعه جاری'}`}
        icon={<Wrench className="w-4 h-4" />}
        tone="brand"
        size="sm"
        footer={
          <>
            <button
              type="button"
              onClick={() => setIsQuickDieModalOpen(false)}
              className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="rtg-quick-die-form"
              disabled={savingQuickDie}
              className="sap-btn-emphasized px-5 py-1.5 text-xs cursor-pointer disabled:opacity-50"
            >
              {savingQuickDie ? 'در حال ثبت...' : 'ثبت سریع و انتخاب قالب'}
            </button>
          </>
        }
      >
        <form id="rtg-quick-die-form" onSubmit={handleCreateQuickDie} className="space-y-3.5 text-xs">
          <div>
            <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">نام قالب پرس *</label>
            <input
              type="text"
              required
              value={quickDieName}
              onChange={e => setQuickDieName(e.target.value)}
              placeholder={`قالب سنبه ماتریس مرحله ${stepData.stepCode || 'OP'} ${activeRouting?.partName || ''}`}
              className="fiori-input w-full px-3 py-1.5 font-medium"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">کد قالب (اختیاری)</label>
              <input
                type="text"
                value={quickDieCode}
                onChange={e => setQuickDieCode(e.target.value)}
                placeholder={`DIE-${activeRouting?.partCode || 'PART'}-01`}
                className="fiori-input w-full px-3 py-1.5 font-mono fiori-ltr-code"
              />
            </div>
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">تناژ مورد نیاز (تن) *</label>
              <input
                type="number"
                required
                value={quickDieTonnage}
                onChange={e => setQuickDieTonnage(Number(e.target.value) || 250)}
                className="fiori-input w-full px-3 py-1.5 font-mono font-bold tabular-nums"
              />
            </div>
          </div>

          <FioriMessageStrip compact tone="warning">
            این قالب مستقیماً به کد قطعه <strong className="fiori-ltr-code font-mono">{activeRouting?.partCode}</strong> انتساب می‌یابد تا هنگام انتخاب قالب برای این قطعه، در صدر لیست و با همبستگی فنی نمایش داده شود.
          </FioriMessageStrip>
        </form>
      </FioriDialog>

      {/* Guide Modal */}
      <MasterDataDifferenceGuideModal
        isOpen={isGuideModalOpen}
        onClose={() => setIsGuideModalOpen(false)}
      />

      {/* Traceability Modal */}
      <TraceabilityTagModal
        isOpen={isTraceabilityModalOpen}
        onClose={() => setIsTraceabilityModalOpen(false)}
        parts={parts}
        machines={machines}
        dies={dies}
        initialPartCode={activeRouting?.partCode}
      />
    </div>
  );
};
