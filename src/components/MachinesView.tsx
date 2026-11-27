import React, { useState, useMemo, useEffect } from 'react';
import {
  Cpu,
  Plus,
  Wrench,
  Activity,
  CheckCircle2,
  AlertTriangle,
  Building,
  UserCheck,
  Zap,
  X,
  Layers,
  Users,
  Search,
  Sparkles,
  ShieldCheck,
  Clock,
  Gauge,
  SlidersHorizontal,
  Edit2,
  Trash2,
  FileText,
  Settings,
  Printer,
  Download,
} from 'lucide-react';
import {
  Machine,
  DieMold,
  Operator,
  FactoryHall,
  Part,
  ProcessType,
  MachineStatus,
  PROCESS_DEFINITIONS,
  FACTORY_HALLS,
} from '../types/inventory';
import { toPersianDigits, formatNumber } from '../utils/formatters';
import { OeeModuleView } from './reports/OeeModuleView';
import { MachineUtilizationView } from './reports/MachineUtilizationView';
import { PlantMaintenanceModuleView } from './maintenance/PlantMaintenanceModuleView';
import { MasterDataSkeleton } from './ui/Skeleton';
import { StandardTable, StandardTableHeader, StandardTableRow, StandardTableCell, StandardTableHeadCell } from './common/StandardTable';
import { SearchableSelect } from './common/SearchableSelect';
import { useEnterpriseUx } from '../context/EnterpriseUxContext';
import { useErpRouter } from '../context/RouterContext';
import { InlinePageGuideButton } from './common/PageGuideSystem';
import { FioriDialog, FioriMessageStrip, FioriObjectStatus, FioriToolbar } from './fiori/ui';
import { EmptyState } from './common/EmptyState';

interface MachinesViewProps {
  machines: Machine[];
  dies?: DieMold[];
  operators?: Operator[];
  halls?: FactoryHall[];
  parts?: Part[];
  onSaveMachine: (machine: Partial<Machine>) => Promise<{ success: boolean; message?: string; error?: string }>;
  onSaveDie?: (die: Partial<DieMold>) => Promise<{ success: boolean; message?: string; error?: string }>;
  onDeleteDie?: (id: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  onSaveOperator?: (op: Partial<Operator>) => Promise<{ success: boolean; message?: string; error?: string }>;
  onDeleteOperator?: (id: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  onSaveHall?: (hall: Partial<FactoryHall>) => Promise<{ success: boolean; message?: string; error?: string }>;
  initialSubTab?: 'machines' | 'maintenance' | 'oee' | 'utilization' | 'dies' | 'halls' | 'operators';
  onSubTabChange?: (tab: 'machines' | 'maintenance' | 'oee' | 'utilization' | 'dies' | 'halls' | 'operators') => void;
}

export const MachinesView: React.FC<MachinesViewProps> = ({
  machines,
  dies = [],
  operators = [],
  halls = FACTORY_HALLS,
  parts = [],
  onSaveMachine,
  onSaveDie,
  onDeleteDie,
  onSaveOperator,
  onDeleteOperator,
  onSaveHall,
  initialSubTab = 'machines',
  onSubTabChange,
}) => {
  const { requestConfirm, showUndoToast, recordAudit } = useEnterpriseUx();
  const { traceDocument } = useErpRouter();
  type SubTab = 'machines' | 'maintenance' | 'oee' | 'utilization' | 'dies' | 'halls' | 'operators';
  const [activeSubTab, setActiveSubTab] = useState<SubTab>(initialSubTab);

  useEffect(() => {
    if (initialSubTab) {
      setActiveSubTab(initialSubTab);
    }
  }, [initialSubTab]);

  const handleSelectSubTab = (tab: SubTab) => {
    setActiveSubTab(tab);
    if (onSubTabChange) onSubTabChange(tab);
  };

  // Search & Filter
  const [searchTerm, setSearchTerm] = useState('');

  // Modals
  const [isMachineModalOpen, setIsMachineModalOpen] = useState(false);
  const [editingMachine, setEditingMachine] = useState<Partial<Machine> | null>(null);
  const [machineFormData, setMachineFormData] = useState<Partial<Machine>>({
    code: '',
    name: '',
    capabilities: ['BLANKING', 'PUNCH_FORM'],
    processType: 'BLANKING',
    tonnage: 250,
    bolsterSize: '1800x1200 mm',
    strokeLengthMm: 250,
    strokesPerMinute: 30,
    hallId: 'HALL-HEAVY-PRESS',
    location: 'سالن پرس سنگین',
    status: 'ACTIVE',
    operatorName: '',
  });

  // Die Modal
  const [isDieModalOpen, setIsDieModalOpen] = useState(false);
  const [editingDie, setEditingDie] = useState<Partial<DieMold> | null>(null);
  const [dieFormData, setDieFormData] = useState<Partial<DieMold>>({
    code: '',
    name: '',
    partId: '',
    processType: 'BLANKING',
    requiredTonnage: 250,
    compatibleMachineCodes: ['PRS-250-01'],
    strokeLifeTarget: 250000,
    currentStrokes: 0,
    status: 'READY',
    location: 'قفسه A-01 انبار قالب',
    notes: '',
  });

  // Operator State & Modals
  const [isOpModalOpen, setIsOpModalOpen] = useState(false);
  const [editingOperator, setEditingOperator] = useState<Partial<Operator> | null>(null);
  const [opFormData, setOpFormData] = useState<Partial<Operator>>({
    personnelCode: '',
    fullName: '',
    skillProcessTypes: ['BLANKING', 'DRAWING'],
    defaultShift: 'MORNING',
    hallId: 'HALL-HEAVY-PRESS',
    phone: '',
    active: true,
  });
  const [operatorSearch, setOperatorSearch] = useState('');
  const [selectedOpForReport, setSelectedOpForReport] = useState<Operator | null>(null);
  const [opTimesheetData, setOpTimesheetData] = useState<any>(null);
  const [loadingTimesheet, setLoadingTimesheet] = useState(false);

  // Dynamic Factory Halls State
  const [hallsList, setHallsList] = useState<FactoryHall[]>(halls);
  const [isQuickHallModalOpen, setIsQuickHallModalOpen] = useState(false);
  const [quickHallCode, setQuickHallCode] = useState('');
  const [quickHallName, setQuickHallName] = useState('');
  const [quickHallType, setQuickHallType] = useState<FactoryHall['type']>('STAMPING');
  const [quickHallSupervisor, setQuickHallSupervisor] = useState('');
  const [savingQuickHall, setSavingQuickHall] = useState(false);

  useEffect(() => {
    if (halls && halls.length > 0) {
      setHallsList(halls);
    } else {
      fetch('/api/halls')
        .then(r => r.json())
        .then(data => {
          if (data.success && Array.isArray(data.data)) {
            setHallsList(data.data);
          }
        })
        .catch(() => {});
    }
  }, [halls]);

  const handleCreateQuickHall = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickHallCode.trim() || !quickHallName.trim()) return;
    setSavingQuickHall(true);
    try {
      const newHall: Partial<FactoryHall> = {
        code: quickHallCode.trim(),
        name: quickHallName.trim(),
        type: quickHallType,
        supervisorName: quickHallSupervisor.trim(),
        active: true,
      };
      if (onSaveHall) {
        await onSaveHall(newHall);
      } else {
        await fetch('/api/halls', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newHall),
        });
      }
      const createdObj: FactoryHall = {
        id: `hall-${Date.now()}`,
        code: quickHallCode.trim(),
        name: quickHallName.trim(),
        type: quickHallType,
        supervisorName: quickHallSupervisor.trim(),
        active: true,
      };
      setHallsList(prev => [...prev, createdObj]);
      setMachineFormData(prev => ({
        ...prev,
        hallId: createdObj.id,
        location: createdObj.name,
      }));
      setIsQuickHallModalOpen(false);
      setQuickHallCode('');
      setQuickHallName('');
      setQuickHallSupervisor('');
    } catch (err) {
      console.error(err);
    } finally {
      setSavingQuickHall(false);
    }
  };

  // Dynamic Machine Process Capabilities
  const [availableProcesses, setAvailableProcesses] = useState<Array<{ code: string; name: string; category?: string; description?: string }>>([
    ...PROCESS_DEFINITIONS,
  ]);
  const [isNewProcessModalOpen, setIsNewProcessModalOpen] = useState(false);
  const [newProcCode, setNewProcCode] = useState('');
  const [newProcName, setNewProcName] = useState('');

  const loadProcesses = async () => {
    try {
      const res = await fetch('/api/processes');
      const json = await res.json();
      if (json.success && json.data) {
        setAvailableProcesses(json.data);
      }
    } catch (err) {
      console.warn('Using default processes', err);
    }
  };

  useEffect(() => {
    loadProcesses();
  }, []);

  const handleCreateProcess = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProcCode.trim() || !newProcName.trim()) return;
    try {
      const res = await fetch('/api/processes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: newProcCode.trim(),
          name: newProcName.trim(),
        }),
      });
      const json = await res.json();
      if (json.success) {
        setMachineFormData(prev => ({
          ...prev,
          capabilities: [...(prev.capabilities || []), newProcCode.trim().toUpperCase() as ProcessType],
        }));
        setNewProcCode('');
        setNewProcName('');
        setIsNewProcessModalOpen(false);
        await loadProcesses();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteProcess = (code: string) => {
    const procItem = availableProcesses.find(p => p.code === code);
    requestConfirm({
      title: `حذف منطقی قابلیت فرآیندی «${code}»`,
      description: `آیا از حذف قابلیت فرآیندی «${procItem?.name || code}» از کاتالوگ قابلیت‌های پرس اطمینان دارید؟`,
      consequences: [
        'این قابلیت از لیست انتخاب فرآیندهای جدید پرس‌ها حذف می‌شود.',
        'ماشین‌آلاتی که قبلاً این قابلیت را داشته‌اند بدون تغییر باقی می‌مانند.',
        'امکان بازگردانی فوری با دکمه «لغو (Undo)» وجود دارد.',
      ],
      confirmLabel: 'تایید و حذف قابلیت',
      variant: 'danger',
      onConfirm: async () => {
        const prevList = [...availableProcesses];
        setAvailableProcesses(prev => prev.filter(p => p.code !== code));
        try {
          await fetch(`/api/processes/${code}`, { method: 'DELETE' });
        } catch (err) {
          console.error(err);
        }
        recordAudit({
          actionType: 'SOFT_DELETE',
          moduleTitle: 'مدیریت ماشین‌آلات و قابلیت‌های فرآیندی',
          entityId: code,
          entityCode: code,
          summaryFa: `حذف قابلیت فرآیندی «${procItem?.name || code}»`,
        });
        showUndoToast({
          title: `قابلیت فرآیندی «${code}» حذف شد`,
          description: 'برای بازگردانی فوری روی «لغو (Undo)» کلیک کنید.',
          onUndo: () => {
            setAvailableProcesses(prevList);
          },
        });
      },
    });
  };

  const handleOpenTimesheetReport = async (op: Operator) => {
    setSelectedOpForReport(op);
    setLoadingTimesheet(true);
    setOpTimesheetData(null);
    try {
      const res = await fetch(`/api/operators/${op.id}/timesheet`);
      const json = await res.json();
      if (json.success && json.data) {
        setOpTimesheetData(json.data);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingTimesheet(false);
    }
  };

  const handleEditOp = (op: Operator) => {
    setEditingOperator(op);
    setOpFormData({
      id: op.id,
      personnelCode: op.personnelCode,
      fullName: op.fullName,
      skillProcessTypes: op.skillProcessTypes || ['BLANKING'],
      defaultShift: op.defaultShift || 'MORNING',
      hallId: op.hallId || 'HALL-HEAVY-PRESS',
      phone: op.phone || '',
      active: op.active !== undefined ? op.active : true,
    });
    setFormError(null);
    setIsOpModalOpen(true);
  };

  const handleDeleteOp = (op: Operator) => {
    requestConfirm({
      title: `حذف منطقی اپراتور «${op.fullName}»`,
      description: `آیا از غیرفعال‌سازی و حذف منطقی اپراتور «${op.fullName}» (کد پرسنلی ${op.personnelCode}) اطمینان دارید؟`,
      consequences: [
        'اپراتور از لیست تخصیص شیفت‌های جدید خط تولید خارج می‌شود.',
        'کارنامه و سوابق تایم‌شیت قبلی اپراتور در سیستم محفوظ می‌ماند.',
        'در صورت نیاز می‌توانید با دکمه «لغو (Undo)» اپراتور را بازگردانید.',
      ],
      confirmLabel: 'تایید و حذف منطقی اپراتور',
      variant: 'danger',
      onConfirm: async () => {
        if (onDeleteOperator) {
          await onDeleteOperator(op.id);
        } else {
          await fetch(`/api/operators/${op.id}`, { method: 'DELETE' });
        }
        recordAudit({
          actionType: 'SOFT_DELETE',
          moduleTitle: 'مدیریت اپراتورها و پرسنل تولید',
          entityId: op.id,
          entityCode: op.personnelCode,
          summaryFa: `حذف منطقی اپراتور «${op.fullName}» (${op.personnelCode})`,
        });
        showUndoToast({
          title: `اپراتور «${op.fullName}» به صورت منطقی حذف شد`,
          description: `کد پرسنلی: ${op.personnelCode}`,
          onUndo: async () => {
            if (onSaveOperator) {
              await onSaveOperator(op);
            }
          },
        });
      },
    });
  };

  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (machines.length === 0 && parts.length === 0) {
    return <MasterDataSkeleton />;
  }

  // Toggle machine capability checkbox
  const toggleCapability = (proc: string) => {
    const current = (machineFormData.capabilities || []) as string[];
    if (current.includes(proc)) {
      if (current.length === 1) return; // Keep at least one
      setMachineFormData({ ...machineFormData, capabilities: current.filter(c => c !== proc) as ProcessType[] });
    } else {
      setMachineFormData({ ...machineFormData, capabilities: [...current, proc] as ProcessType[] });
    }
  };

  // MACHINE MODAL HANDLERS
  const handleOpenNewMachine = () => {
    setEditingMachine(null);
    setMachineFormData({
      code: '',
      name: '',
      capabilities: ['BLANKING', 'DRAWING', 'PUNCH_FORM'],
      processType: 'DRAWING',
      tonnage: 400,
      bolsterSize: '2200x1400 mm',
      strokeLengthMm: 350,
      strokesPerMinute: 25,
      hallId: 'HALL-HEAVY-PRESS',
      location: 'سالن پرس سنگین',
      status: 'ACTIVE',
      operatorName: '',
    });
    setFormError(null);
    setIsMachineModalOpen(true);
  };

  const handleEditMachine = (m: Machine) => {
    setEditingMachine(m);
    setMachineFormData({
      ...m,
      capabilities: m.capabilities && m.capabilities.length > 0 ? m.capabilities : [m.processType],
    });
    setFormError(null);
    setIsMachineModalOpen(true);
  };

  const handleMachineSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!machineFormData.code || !machineFormData.name) {
      setFormError('کد و نام ماشین الزامی است.');
      return;
    }

    setLoading(true);
    try {
      const selectedHall = halls.find(h => h.id === machineFormData.hallId);
      const payload: Partial<Machine> = {
        ...machineFormData,
        location: selectedHall ? selectedHall.name : machineFormData.location,
        processType: machineFormData.capabilities?.[0] || 'BLANKING',
      };

      const res = await onSaveMachine(payload);
      if (res.success) {
        setIsMachineModalOpen(false);
      } else {
        setFormError(res.error || 'خطا در ثبت مشخصات ماشین.');
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'خطای سرور');
    } finally {
      setLoading(false);
    }
  };

  // DIE MODAL HANDLERS
  const handleOpenNewDie = () => {
    setEditingDie(null);
    const initialSuitableCodes = machines
      .filter(m => (m.tonnage || 0) >= 250)
      .slice(0, 3)
      .map(m => m.code);
    setDieFormData({
      code: '',
      name: '',
      partId: parts[0]?.id || '',
      processType: 'BLANKING',
      requiredTonnage: 250,
      compatibleMachineCodes: initialSuitableCodes.length > 0 ? initialSuitableCodes : machines.slice(0, 1).map(m => m.code),
      compatibleMachineIds: machines.filter(m => initialSuitableCodes.includes(m.code)).map(m => m.id),
      strokeLifeTarget: 250000,
      currentStrokes: 0,
      status: 'READY',
      location: 'قفسه A-01 انبار قالب‌ها',
      notes: '',
    });
    setFormError(null);
    setIsDieModalOpen(true);
  };

  const handleEditDie = (die: DieMold) => {
    setEditingDie(die);
    const legacyMachineId = (die as any).machineId;
    const codes = Array.isArray(die.compatibleMachineCodes) && die.compatibleMachineCodes.length > 0
      ? die.compatibleMachineCodes
      : (legacyMachineId ? [legacyMachineId] : []);
    setDieFormData({
      ...die,
      compatibleMachineCodes: codes,
      compatibleMachineIds: die.compatibleMachineIds || machines.filter(m => codes.includes(m.code)).map(m => m.id),
    });
    setFormError(null);
    setIsDieModalOpen(true);
  };

  const handleDieSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!onSaveDie) return;

    if (!dieFormData.code || !dieFormData.name || !dieFormData.partId) {
      setFormError('کد قالب، عنوان قالب و قطعه مربوطه الزامی هستند.');
      return;
    }

    setLoading(true);
    try {
      const res = await onSaveDie(dieFormData);
      if (res.success) {
        setIsDieModalOpen(false);
      } else {
        setFormError(res.error || 'خطا در ثبت قالب');
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'خطای ارتباط');
    } finally {
      setLoading(false);
    }
  };

  // OPERATOR MODAL HANDLERS
  const handleOpenNewOp = () => {
    setOpFormData({
      personnelCode: '',
      fullName: '',
      skillProcessTypes: ['BLANKING', 'PUNCH_FORM'],
      defaultShift: 'MORNING',
      hallId: halls[0]?.id || '',
      phone: '',
      active: true,
    });
    setFormError(null);
    setIsOpModalOpen(true);
  };

  const handleOpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!onSaveOperator) return;

    if (!opFormData.personnelCode || !opFormData.fullName) {
      setFormError('کد پرسنلی و نام اپراتور الزامی است.');
      return;
    }

    setLoading(true);
    try {
      const res = await onSaveOperator(opFormData);
      if (res.success) {
        setIsOpModalOpen(false);
      } else {
        setFormError(res.error || 'خطا در ثبت اپراتور');
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'خطای سرور');
    } finally {
      setLoading(false);
    }
  };

  const handleToggleStatus = async (m: Machine) => {
    const nextStatus: MachineStatus =
      m.status === 'ACTIVE' ? 'MAINTENANCE' : m.status === 'MAINTENANCE' ? 'IDLE' : 'ACTIVE';
    await onSaveMachine({ ...m, status: nextStatus });
  };

  const subTabsList: { id: SubTab; label: string; shortLabel: string }[] = [
    {
      id: 'machines',
      label: `۱. پرس‌ها و ماشین‌آلات (${toPersianDigits(machines.length)} دستگاه)`,
      shortLabel: 'پرس‌ها و ماشین‌آلات',
    },
    {
      id: 'maintenance',
      label: '۲. نگهداری و تعمیرات، دستورکارها و TPM (استاندارد Odoo / ERPNext)',
      shortLabel: 'نگهداری و تعمیرات (TPM)',
    },
    {
      id: 'oee',
      label: '۳. ماژول OEE و ۶ ضایعه بزرگ',
      shortLabel: 'داشبورد OEE',
    },
    {
      id: 'utilization',
      label: '۴. گزارش بهره ماشین و کارکرد',
      shortLabel: 'بهره ماشین',
    },
    {
      id: 'dies',
      label: `۵. قالب‌های پرس و فیکسچرها (${toPersianDigits(dies.length)} قالب)`,
      shortLabel: 'قالب‌های پرس',
    },
    {
      id: 'halls',
      label: `۶. سالن‌ها و نواحی کارخانه (${toPersianDigits(halls.length)} سالن)`,
      shortLabel: 'سالن‌های کارخانه',
    },
    {
      id: 'operators',
      label: `۷. اپراتورها و پرسنل خطوط (${toPersianDigits(operators.length)} نفر)`,
      shortLabel: 'اپراتورها و پرسنل',
    },
  ];

  return (
    <div className="space-y-5">
      {/* SAP HANA Fiori Header & Selector Bar */}
      <div className="sap-card p-4 space-y-3.5">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-start sm:items-center gap-3">
            <div className="w-9 h-9 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-info-bg)] border border-[var(--fiori-info-border)] text-[var(--fiori-brand)] flex items-center justify-center shrink-0">
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-[var(--fiori-text-primary)]">
                مرکز تجهیزات، قالب‌های پرس، سالن‌ها و اپراتورهای کارخانه
              </h2>
              <p className="text-xs text-[var(--fiori-text-secondary)] mt-0.5">
                پرس‌های چندمنظوره (کشش، پانچ، خم)، مدیریت قالب‌های سنبه ماتریس، سالن‌های تولیدی، شاخص OEE و پرسنل خطوط
              </p>
            </div>
          </div>

          {/* Primary Action Button */}
          <div className="flex items-center gap-2 self-end md:self-auto flex-wrap">
            <InlinePageGuideButton
              routeContext={{ tab: 'machines', machineSubTab: activeSubTab }}
              label="آموزش این بخش و سناریوها"
            />
            {activeSubTab === 'machines' && (
              <button
                onClick={handleOpenNewMachine}
                className="sap-btn-emphasized flex items-center gap-1.5 px-3.5 py-1.5 text-xs cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>ثبت پرس / دستگاه جدید</span>
              </button>
            )}
            {activeSubTab === 'dies' && (
              <button
                onClick={handleOpenNewDie}
                className="sap-btn-emphasized flex items-center gap-1.5 px-3.5 py-1.5 text-xs cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>تعریف قالب پرس جدید</span>
              </button>
            )}
            {activeSubTab === 'operators' && (
              <button
                onClick={handleOpenNewOp}
                className="sap-btn-emphasized flex items-center gap-1.5 px-3.5 py-1.5 text-xs cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>افزودن اپراتور جدید</span>
              </button>
            )}
          </div>
        </div>

        {/* Unified Dropdown List Selector + Quick Chips */}
        <div className="pt-3 border-t border-[var(--fiori-border-subtle)] flex flex-wrap items-center justify-between gap-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-2 bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1">
              <SlidersHorizontal className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
              <span className="text-[var(--fiori-text-secondary)] font-medium">انتخاب بخش ماشین‌آلات و ظرفیت:</span>
              <select
                value={activeSubTab}
                onChange={e => handleSelectSubTab(e.target.value as SubTab)}
                className="bg-transparent font-bold text-[var(--fiori-text-primary)] focus:outline-none cursor-pointer"
              >
                {subTabsList.map(tab => (
                  <option key={tab.id} value={tab.id}>
                    {tab.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Quick Tag Filter Chips */}
            <div className="flex items-center gap-1.5 overflow-x-auto">
              {subTabsList.map(tab => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => handleSelectSubTab(tab.id)}
                  className={`px-2.5 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer border ${
                    activeSubTab === tab.id
                      ? 'bg-[var(--fiori-bg-selected)] text-[var(--fiori-brand)] border-[var(--fiori-brand)] font-bold'
                      : 'bg-[var(--fiori-bg-surface)] hover:bg-[var(--fiori-bg-hover)] text-[var(--fiori-text-secondary)] border-[var(--fiori-border-default)]'
                  }`}
                >
                  {tab.shortLabel}
                </button>
              ))}
            </div>
          </div>

          <div className="text-[11px] text-[var(--fiori-text-secondary)] tabular-nums">
            کل پرس‌ها: {toPersianDigits(machines.length)} • قالب‌ها: {toPersianDigits(dies.length)} • پرسنل: {toPersianDigits(operators.length)}
          </div>
        </div>
      </div>

      {/* TAB MAINTENANCE & TPM MODULE (Odoo Maintenance & ERPNext Asset Maintenance) */}
      {activeSubTab === 'maintenance' && (
        <PlantMaintenanceModuleView
          machines={machines}
          dies={dies}
          operators={operators}
        />
      )}

      {/* TAB OEE MODULE */}
      {activeSubTab === 'oee' && <OeeModuleView machines={machines} />}

      {/* TAB MACHINE UTILIZATION MODULE */}
      {activeSubTab === 'utilization' && <MachineUtilizationView machines={machines} />}

      {/* TAB 1: MACHINES & MULTI-CAPABILITY PRESSES */}
      {activeSubTab === 'machines' && (
        <div className="space-y-4">
          <FioriMessageStrip tone="info" title="پرس‌های چندمنظوره:">
            یک پرس مکانیکی یا هیدرولیک می‌تواند بسته به قالبی که روی آن بسته می‌شود، عملیات‌های گوناگونی همچون بلنکینگ، کشش، پانچ، خمکاری یا دوربری را اجرا کند.
          </FioriMessageStrip>

          {machines.length === 0 ? (
            <div className="sap-card">
              <EmptyState
                compact
                variant="NO_DATA"
                title="پرس یا دستگاهی ثبت نشده است"
                description="برای شروع می‌توانید اولین پرس یا دستگاه کارخانه را تعریف کنید."
                actionLabel="ثبت پرس / دستگاه جدید"
                onAction={handleOpenNewMachine}
              />
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {machines.map(m => {
                const isActive = m.status === 'ACTIVE';
                const isMaintenance = m.status === 'MAINTENANCE';
                const caps = m.capabilities && m.capabilities.length > 0 ? m.capabilities : [m.processType];
                const compatibleDies = dies.filter(d => d.compatibleMachineCodes?.includes(m.code));

                return (
                  <div
                    key={m.id}
                    className={`p-4 rounded-[var(--fiori-radius-md)] border transition-colors ${
                      isActive
                        ? 'bg-[var(--fiori-bg-surface)] border-[var(--fiori-border-default)] hover:border-[var(--fiori-brand)]'
                        : isMaintenance
                        ? 'bg-[var(--fiori-critical-bg)] border-[var(--fiori-critical-border)]'
                        : 'bg-[var(--fiori-bg-subtle)] border-[var(--fiori-border-default)]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="fiori-ltr-code text-xs font-bold text-[var(--fiori-brand)] bg-[var(--fiori-info-bg)] px-2.5 py-0.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-info-border)]">
                        {m.code}
                      </span>

                      {/* Status Toggle Button */}
                      <button
                        type="button"
                        onClick={() => handleToggleStatus(m)}
                        className={`text-[11px] px-2.5 py-1 rounded-[var(--fiori-radius-sm)] font-bold flex items-center gap-1.5 border transition-colors cursor-pointer ${
                          isActive
                            ? 'bg-[var(--fiori-positive-bg)] text-[var(--fiori-positive)] border-[var(--fiori-positive-border)]'
                            : isMaintenance
                            ? 'bg-[var(--fiori-critical-bg)] text-[var(--fiori-critical)] border-[var(--fiori-critical-border)]'
                            : 'bg-[var(--fiori-neutral-bg)] text-[var(--fiori-neutral)] border-[var(--fiori-neutral-border)]'
                        }`}
                        title="کلیک برای تغییر وضعیت فعالیت"
                      >
                        <span
                          className={`w-2 h-2 rounded-sm ${
                            isActive
                              ? 'bg-[var(--fiori-positive)]'
                              : isMaintenance
                              ? 'bg-[var(--fiori-critical)]'
                              : 'bg-[var(--fiori-neutral)]'
                          }`}
                        />
                        <span>
                          {isActive ? 'فعال در خط' : isMaintenance ? 'تعمیرات (PM)' : 'متوقف'}
                        </span>
                      </button>
                    </div>

                    <h3 className="text-sm font-bold text-[var(--fiori-text-primary)] mt-3 line-clamp-1">{m.name}</h3>

                    {/* Multi-Capabilities Badges */}
                    <div className="mt-3">
                      <span className="text-[10px] text-[var(--fiori-text-muted)] block mb-1">قابلیت‌های فرآیندی پرس:</span>
                      <div className="flex flex-wrap gap-1">
                        {caps.map((c, i) => (
                          <FioriObjectStatus key={i} tone="neutral" size="sm" ltrCode label={c} />
                        ))}
                      </div>
                    </div>

                    <div className="mt-4 space-y-2 text-xs text-[var(--fiori-text-primary)]">
                      <div className="flex items-center justify-between pb-1.5 border-b border-[var(--fiori-border-subtle)]">
                        <span className="text-[var(--fiori-text-secondary)]">تناژ اسمی:</span>
                        <span className="font-mono font-bold text-[var(--fiori-brand)] tabular-nums">
                          {m.tonnage ? `${toPersianDigits(m.tonnage)} تن` : 'فاقد تناژ'}
                        </span>
                      </div>
                      {m.bolsterSize && (
                        <div className="flex items-center justify-between pb-1.5 border-b border-[var(--fiori-border-subtle)]">
                          <span className="text-[var(--fiori-text-secondary)]">ابعاد میز پرس:</span>
                          <span className="fiori-ltr-code text-[var(--fiori-text-primary)] font-medium">{m.bolsterSize}</span>
                        </div>
                      )}
                      <div className="flex items-center justify-between pb-1.5 border-b border-[var(--fiori-border-subtle)]">
                        <span className="text-[var(--fiori-text-secondary)]">سالن استقرار:</span>
                        <span className="text-[var(--fiori-text-primary)] flex items-center gap-1 font-medium">
                          <Building className="w-3 h-3 text-[var(--fiori-text-muted)]" />
                          {m.location}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[var(--fiori-text-secondary)]">قالب‌های سازگار:</span>
                        <span className="text-[var(--fiori-positive)] font-bold tabular-nums">
                          {toPersianDigits(compatibleDies.length)} قالب
                        </span>
                      </div>
                    </div>

                    <div className="mt-4 pt-3 border-t border-[var(--fiori-border-subtle)] flex items-center justify-between">
                      <button
                        type="button"
                        onClick={() => handleEditMachine(m)}
                        className="text-xs text-[var(--fiori-brand)] hover:text-[var(--fiori-brand-hover)] font-bold transition-colors cursor-pointer"
                      >
                        ویرایش مشخصات
                      </button>
                      <span className="text-[11px] text-[var(--fiori-text-muted)]">
                        {m.operatorName ? `مسئول: ${m.operatorName}` : 'مشترک سالن'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: DIES & MOLDS MANAGEMENT */}
      {activeSubTab === 'dies' && (
        <div className="space-y-4">
          <FioriMessageStrip tone="info" title="شناسنامه قالب‌های پرس (Dies & Molds):">
            هر قطعه بدنه خودرو با قالب‌های تخصصی سنبه ماتریس، کشش عمیق، پانچ یا خم‌کاری شکل می‌گیرد. ردیابی عمر ضرب و نگهداری پیشگیرانه از توقف خط جلوگیری می‌کند.
          </FioriMessageStrip>

          <div className="sap-card overflow-hidden">
            <FioriToolbar
              variant="table"
              title="لیست قالب‌های پرس و فیکسچرها"
              count={dies.length}
              countLabel="قالب"
            />
            {dies.length === 0 ? (
              <EmptyState
                compact
                variant="NO_DATA"
                title="هیچ قالب پرسی ثبت نشده است"
                description="برای شروع، شناسنامه اولین قالب پرس کارخانه را تعریف کنید."
                actionLabel="تعریف قالب پرس جدید"
                onAction={handleOpenNewDie}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="sap-table-compact w-full text-right text-xs">
                  <thead>
                    <tr className="bg-[var(--fiori-bg-subtle)] border-b border-[var(--fiori-border-default)] text-[var(--fiori-text-primary)] font-semibold">
                      <th>کد قالب</th>
                      <th>عنوان قالب پرس</th>
                      <th>قطعه تولیدی مرتبط</th>
                      <th>عملیات فرآیندی</th>
                      <th>تناژ مورد نیاز</th>
                      <th>پرس‌های سازگار</th>
                      <th>کارکرد ضرب / عمر اسمی</th>
                      <th>محل در انبار</th>
                      <th>وضعیت</th>
                      <th>عملیات</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--fiori-border-subtle)] text-[var(--fiori-text-primary)]">
                    {dies.map(d => {
                      const healthPct = Math.round((d.currentStrokes / (d.strokeLifeTarget || 1)) * 100);
                      return (
                        <tr key={d.id} className="hover:bg-[var(--fiori-bg-hover)] transition-colors">
                          <td className="fiori-ltr-code font-bold text-[var(--fiori-brand)]">{d.code}</td>
                          <td className="text-[var(--fiori-text-primary)] font-bold max-w-xs">{d.name}</td>
                          <td className="text-[var(--fiori-text-primary)]">
                            <div className="font-medium">{d.partName}</div>
                            {d.partCode ? (
                              <button
                                type="button"
                                onClick={() => traceDocument(d.partCode!, 'INVENTORY_LEDGER')}
                                className="sap-doc-link text-[10px] fiori-ltr-code"
                                title="رهگیری قطعه در انبار و کاردکس"
                              >
                                {d.partCode}
                              </button>
                            ) : null}
                          </td>
                          <td>
                            <FioriObjectStatus tone="neutral" size="sm" ltrCode label={d.processType} />
                          </td>
                          <td className="font-mono font-bold text-[var(--fiori-text-primary)] tabular-nums">{d.requiredTonnage} تن</td>
                          <td className="fiori-ltr-code text-[11px] text-[var(--fiori-text-secondary)]">
                            {d.compatibleMachineCodes?.join(', ') || '-'}
                          </td>
                          <td>
                            <div className="font-mono text-xs text-[var(--fiori-text-primary)] font-semibold tabular-nums">
                              {formatNumber(d.currentStrokes)} / {formatNumber(d.strokeLifeTarget)}
                            </div>
                            <div className="w-24 bg-[var(--fiori-bg-subtle)] h-1.5 rounded-sm mt-1 overflow-hidden border border-[var(--fiori-border-default)]">
                              <div
                                className={`h-full rounded-sm ${
                                  healthPct > 80 ? 'bg-[var(--fiori-negative)]' : 'bg-[var(--fiori-positive)]'
                                }`}
                                style={{ width: `${Math.min(100, healthPct)}%` }}
                              />
                            </div>
                          </td>
                          <td className="text-[var(--fiori-text-secondary)] text-[11px]">{d.location}</td>
                          <td>
                            <FioriObjectStatus
                              tone={d.status === 'READY' ? 'positive' : 'critical'}
                              size="sm"
                              label={d.status === 'READY' ? 'آماده تولید' : 'سرویس / تیزکاری'}
                            />
                          </td>
                          <td>
                            <button
                              type="button"
                              onClick={() => handleEditDie(d)}
                              className="text-xs text-[var(--fiori-brand)] hover:text-[var(--fiori-brand-hover)] font-bold transition-colors cursor-pointer"
                            >
                              ویرایش
                            </button>
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

      {/* TAB 3: FACTORY HALLS */}
      {activeSubTab === 'halls' && (
        halls.length === 0 ? (
          <div className="sap-card">
            <EmptyState
              compact
              variant="NO_DATA"
              title="سالنی ثبت نشده است"
              description="سالن‌های استقرار خطوط تولید در این بخش نمایش داده می‌شوند."
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {halls.map(hall => {
              const machinesInHall = machines.filter(m => m.location?.includes(hall.name) || m.hallId === hall.id);
              return (
                <div key={hall.id} className="sap-card p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="fiori-ltr-code text-xs font-bold text-[var(--fiori-brand)] bg-[var(--fiori-info-bg)] px-2.5 py-0.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-info-border)]">
                      {hall.code}
                    </span>
                    <FioriObjectStatus tone="neutral" size="sm" label={hall.type} />
                  </div>

                  <h3 className="text-sm font-bold text-[var(--fiori-text-primary)]">{hall.name}</h3>

                  <div className="space-y-1.5 text-xs text-[var(--fiori-text-primary)]">
                    <div className="flex justify-between pb-1 border-b border-[var(--fiori-border-subtle)]">
                      <span className="text-[var(--fiori-text-secondary)]">سرپرست سالن:</span>
                      <span className="text-[var(--fiori-text-primary)] font-bold">{hall.supervisorName || '-'}</span>
                    </div>
                    <div className="flex justify-between pb-1 border-b border-[var(--fiori-border-subtle)]">
                      <span className="text-[var(--fiori-text-secondary)]">تجهیزات و پرس‌ها:</span>
                      <span className="text-[var(--fiori-positive)] font-bold tabular-nums">{toPersianDigits(machinesInHall.length)} دستگاه</span>
                    </div>
                    {hall.capacityDesc && (
                      <p className="text-[11px] text-[var(--fiori-text-secondary)] pt-1 leading-relaxed">
                        {hall.capacityDesc}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {/* TAB 4: OPERATORS & LINE TECHNICIANS */}
      {activeSubTab === 'operators' && (() => {
        const filteredOps = operators.filter(op => {
          if (!operatorSearch.trim()) return true;
          const q = operatorSearch.toLowerCase();
          return (
            op.fullName.toLowerCase().includes(q) ||
            op.personnelCode.toLowerCase().includes(q) ||
            op.skillProcessTypes?.some(s => s.toLowerCase().includes(q))
          );
        });

        return (
          <div className="space-y-3">
            {/* Search bar and counter */}
            <div className="sap-card flex flex-col sm:flex-row items-center justify-between gap-3 p-3">
              <div className="relative w-full sm:w-80">
                <Search className="w-3.5 h-3.5 absolute right-3 top-1/2 -translate-y-1/2 text-[var(--fiori-text-muted)]" />
                <input
                  type="text"
                  placeholder="جستجو در اپراتورها (نام، کد پرسنلی، مهارت)..."
                  value={operatorSearch}
                  onChange={e => setOperatorSearch(e.target.value)}
                  className="fiori-input w-full pr-8 pl-3 py-1.5 text-xs"
                />
              </div>
              <div className="flex items-center gap-2 text-xs text-[var(--fiori-text-secondary)] tabular-nums">
                <span>تعداد پرسنل فعال: {toPersianDigits(operators.filter(o => o.active).length)} نفر</span>
                <button
                  type="button"
                  onClick={handleOpenNewOp}
                  className="sap-btn-emphasized flex items-center gap-1 px-3 py-1.5 text-xs cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>+ اپراتور جدید</span>
                </button>
              </div>
            </div>

            <div className="sap-card overflow-hidden">
              <FioriToolbar
                variant="table"
                title="پرسنل و اپراتورهای خطوط تولید"
                count={filteredOps.length}
                countLabel="نفر"
              />
              {filteredOps.length === 0 ? (
                <EmptyState
                  compact
                  variant={operatorSearch.trim() ? 'SEARCH_NO_MATCH' : 'NO_DATA'}
                  title={operatorSearch.trim() ? 'اپراتوری با این مشخصات یافت نشد' : 'اپراتوری ثبت نشده است'}
                  description={
                    operatorSearch.trim()
                      ? 'عبارت جستجو را تغییر دهید یا فیلتر را پاک کنید.'
                      : 'برای ثبت اولین اپراتور خط تولید روی دکمه افزودن اپراتور جدید کلیک کنید.'
                  }
                  actionLabel={operatorSearch.trim() ? 'پاک کردن جستجو' : 'افزودن اپراتور جدید'}
                  onAction={() => {
                    if (operatorSearch.trim()) {
                      setOperatorSearch('');
                    } else {
                      handleOpenNewOp();
                    }
                  }}
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="sap-table-compact w-full text-right text-xs">
                    <thead>
                      <tr className="bg-[var(--fiori-bg-subtle)] border-b border-[var(--fiori-border-default)] text-[var(--fiori-text-primary)] font-semibold">
                        <th>کد پرسنلی</th>
                        <th>نام و نام خانوادگی</th>
                        <th>مهارت‌های تخصصی</th>
                        <th>شیفت پیش‌فرض</th>
                        <th>تماس</th>
                        <th className="text-center">وضعیت</th>
                        <th className="text-center">عملیات و گزارش</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--fiori-border-subtle)] text-[var(--fiori-text-primary)]">
                      {filteredOps.map(op => (
                        <tr key={op.id} className="hover:bg-[var(--fiori-bg-hover)] transition-colors">
                          <td className="fiori-ltr-code font-bold text-[var(--fiori-brand)]">{op.personnelCode}</td>
                          <td className="text-[var(--fiori-text-primary)] font-bold">{op.fullName}</td>
                          <td>
                            <div className="flex flex-wrap gap-1">
                              {op.skillProcessTypes?.map((s, i) => (
                                <FioriObjectStatus key={i} tone="neutral" size="sm" ltrCode label={s} />
                              ))}
                            </div>
                          </td>
                          <td className="text-[var(--fiori-text-primary)]">
                            {op.defaultShift === 'MORNING' ? 'شیفت صبح' : op.defaultShift === 'EVENING' ? 'شیفت عصر' : 'شیفت شب'}
                          </td>
                          <td className="fiori-ltr-code text-[var(--fiori-text-secondary)] text-[11px]">{op.phone || '-'}</td>
                          <td className="text-center">
                            <FioriObjectStatus
                              tone="positive"
                              size="sm"
                              icon={<CheckCircle2 className="w-3 h-3" />}
                              label="شاغل"
                            />
                          </td>
                          <td className="text-center">
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleOpenTimesheetReport(op)}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-info-bg)] hover:bg-[var(--fiori-bg-selected)] text-[var(--fiori-brand)] border border-[var(--fiori-info-border)] font-semibold text-[11px] transition cursor-pointer"
                                title="مشاهده کارنامه و ساعات کارکرد"
                              >
                                <FileText className="w-3 h-3" />
                                <span>گزارش کارکرد</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => handleEditOp(op)}
                                className="p-1 rounded-[var(--fiori-radius-sm)] hover:bg-[var(--fiori-info-bg)] text-[var(--fiori-brand)] transition cursor-pointer"
                                title="ویرایش مشخصات اپراتور"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteOp(op)}
                                className="p-1 rounded-[var(--fiori-radius-sm)] hover:bg-[var(--fiori-negative-bg)] text-[var(--fiori-negative)] transition cursor-pointer"
                                title="حذف اپراتور"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* SLIDE-OVER DRAWER: ADD / EDIT MACHINE */}
      {isMachineModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] flex justify-end"
          onClick={() => setIsMachineModalOpen(false)}
        >
          <div
            onClick={e => e.stopPropagation()}
            className="bg-[var(--fiori-bg-surface)] border-r border-[var(--fiori-border-default)] w-full max-w-lg h-full p-6 shadow-2xl overflow-y-auto"
          >
            <div className="sticky top-0 z-10 bg-[var(--fiori-bg-surface)] flex items-center justify-between pb-3 border-b border-[var(--fiori-border-subtle)]">
              <h3 className="text-sm font-bold text-[var(--fiori-text-primary)] flex items-center gap-2">
                <Cpu className="w-4 h-4 text-[var(--fiori-brand)]" />
                <span>{editingMachine ? 'کشوی ویرایش مشخصات ماشین / پرس' : 'کشوی ثبت پرس یا دستگاه جدید'}</span>
              </h3>
              <button
                type="button"
                onClick={() => setIsMachineModalOpen(false)}
                className="text-[var(--fiori-text-muted)] hover:text-[var(--fiori-text-primary)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {formError && (
              <FioriMessageStrip compact tone="error" className="mt-3">
                {formError}
              </FioriMessageStrip>
            )}

            <form onSubmit={handleMachineSubmit} className="mt-4 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[var(--fiori-text-primary)] font-medium">کد شناسایی ماشین *</label>
                  <input
                    type="text"
                    dir="ltr"
                    value={machineFormData.code || ''}
                    onChange={e => setMachineFormData({ ...machineFormData, code: e.target.value })}
                    placeholder="PRS-400-02"
                    className="fiori-input fiori-ltr-code w-full px-3 py-2"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[var(--fiori-text-primary)] font-medium">تناژ اسمی پرس (تن) *</label>
                  <input
                    type="number"
                    value={machineFormData.tonnage || 0}
                    onChange={e => setMachineFormData({ ...machineFormData, tonnage: parseFloat(e.target.value) || 0 })}
                    placeholder="400"
                    className="fiori-input fiori-ltr-code w-full px-3 py-2"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[var(--fiori-text-primary)] font-medium">عنوان کامل ماشین در کارخانه *</label>
                <input
                  type="text"
                  value={machineFormData.name || ''}
                  onChange={e => setMachineFormData({ ...machineFormData, name: e.target.value })}
                  placeholder="پرس مکانیکی ضربه‌ای شولر ۴۰۰ تن C-Frame"
                  className="fiori-input w-full px-3 py-2"
                  required
                />
              </div>

              {/* Multi-Capability Checkboxes */}
              <div className="space-y-1.5 p-3 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)]">
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[var(--fiori-text-primary)] font-bold">
                    قابلیت‌های فرآیندی این دستگاه (چند انتخابی بر اساس قالب‌های قابل نصب):
                  </label>
                  <button
                    type="button"
                    onClick={() => setIsNewProcessModalOpen(true)}
                    className="text-[11px] font-bold text-[var(--fiori-brand)] hover:text-[var(--fiori-brand-hover)] flex items-center gap-1 cursor-pointer bg-[var(--fiori-info-bg)] px-2 py-0.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-info-border)]"
                  >
                    <Plus className="w-3 h-3" />
                    <span>+ قابلیت جدید / ویرایش لیست</span>
                  </button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 bg-[var(--fiori-bg-surface)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-subtle)]">
                  {availableProcesses.map(p => {
                    const isChecked = (machineFormData.capabilities || []).includes(p.code as any);
                    return (
                      <label key={p.code} className="flex items-center justify-between gap-1 cursor-pointer text-[11px] text-[var(--fiori-text-primary)] hover:text-[var(--fiori-brand)] bg-[var(--fiori-bg-subtle)] px-2 py-1.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)]">
                        <div className="flex items-center gap-1.5 truncate">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleCapability(p.code)}
                            className="rounded accent-[var(--fiori-brand)] cursor-pointer"
                          />
                          <span className="truncate">{p.name}</span>
                        </div>
                        <span className="fiori-ltr-code text-[9px] text-[var(--fiori-text-muted)]">{p.code}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[var(--fiori-text-primary)] font-medium">ابعاد میز پرس (Bolster)</label>
                  <input
                    type="text"
                    dir="ltr"
                    value={machineFormData.bolsterSize || ''}
                    onChange={e => setMachineFormData({ ...machineFormData, bolsterSize: e.target.value })}
                    placeholder="2200x1400 mm"
                    className="fiori-input fiori-ltr-code w-full px-3 py-2"
                  />
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-[var(--fiori-text-primary)] font-medium">سالن استقرار</label>
                    <button
                      type="button"
                      onClick={() => setIsQuickHallModalOpen(true)}
                      className="text-[11px] text-[var(--fiori-brand)] hover:text-[var(--fiori-brand-hover)] font-bold flex items-center gap-1 cursor-pointer"
                    >
                      <Plus className="w-3 h-3" />
                      <span>+ سالن جدید / مدیریت</span>
                    </button>
                  </div>
                  <select
                    value={machineFormData.hallId || ''}
                    onChange={e => {
                      const selectedH = hallsList.find(h => h.id === e.target.value);
                      setMachineFormData({
                        ...machineFormData,
                        hallId: e.target.value,
                        location: selectedH ? selectedH.name : machineFormData.location,
                      });
                    }}
                    className="fiori-input w-full px-3 py-2 font-medium"
                  >
                    {hallsList.map(h => (
                      <option key={h.id} value={h.id}>
                        {h.name} ({h.code})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-4 border-t border-[var(--fiori-border-subtle)]">
                <button
                  type="button"
                  onClick={() => setIsMachineModalOpen(false)}
                  className="sap-btn-standard text-xs"
                >
                  انصراف
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="sap-btn-emphasized text-xs"
                >
                  {loading ? 'در حال ثبت...' : 'ذخیره مشخصات ماشین'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* SLIDE-OVER DRAWER: ADD / EDIT DIE / MOLD */}
      {isDieModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] flex justify-end"
          onClick={() => setIsDieModalOpen(false)}
        >
          <div
            onClick={e => e.stopPropagation()}
            className="bg-[var(--fiori-bg-surface)] border-r border-[var(--fiori-border-default)] w-full max-w-lg h-full p-6 shadow-2xl overflow-y-auto"
          >
            <div className="sticky top-0 z-10 bg-[var(--fiori-bg-surface)] flex items-center justify-between pb-3 border-b border-[var(--fiori-border-subtle)]">
              <h3 className="text-sm font-bold text-[var(--fiori-text-primary)] flex items-center gap-2">
                <Wrench className="w-4 h-4 text-[var(--fiori-brand)]" />
                <span>{editingDie ? 'کشوی ویرایش شناسنامه فنی قالب' : 'کشوی ثبت و تعریف قالب جدید تولیدی'}</span>
              </h3>
              <button
                type="button"
                onClick={() => setIsDieModalOpen(false)}
                className="text-[var(--fiori-text-muted)] hover:text-[var(--fiori-text-primary)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {formError && (
              <FioriMessageStrip compact tone="error" className="mt-3">
                {formError}
              </FioriMessageStrip>
            )}

            <form onSubmit={handleDieSubmit} className="mt-4 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[var(--fiori-text-primary)] font-medium">کد فنی قالب *</label>
                  <input
                    type="text"
                    dir="ltr"
                    value={dieFormData.code || ''}
                    onChange={e => setDieFormData({ ...dieFormData, code: e.target.value })}
                    placeholder="DIE-206-BRK05"
                    className="fiori-input fiori-ltr-code w-full px-3 py-2 font-bold"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-[var(--fiori-text-primary)] font-medium">عملیات فرآیندی *</label>
                    <button
                      type="button"
                      onClick={() => setIsNewProcessModalOpen(true)}
                      className="text-[10px] text-[var(--fiori-brand)] hover:text-[var(--fiori-brand-hover)] font-bold cursor-pointer"
                    >
                      + فرآیند جدید
                    </button>
                  </div>
                  <select
                    value={dieFormData.processType}
                    onChange={e => setDieFormData({ ...dieFormData, processType: e.target.value as ProcessType })}
                    className="fiori-input w-full px-3 py-2 font-medium"
                  >
                    {availableProcesses.map(p => (
                      <option key={p.code} value={p.code}>
                        {p.name} ({p.code})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[var(--fiori-text-primary)] font-medium">عنوان شناسنامه فنی قالب *</label>
                <input
                  type="text"
                  value={dieFormData.name || ''}
                  onChange={e => setDieFormData({ ...dieFormData, name: e.target.value })}
                  placeholder="مثال: قالب کشش عمیق و برش پیرسینگ دیاق سپر جلو"
                  className="fiori-input w-full px-3 py-2 font-medium"
                  required
                />
              </div>

              {/* SEARCHABLE SELECT FOR PART */}
              <div className="space-y-1">
                <label className="text-[var(--fiori-text-primary)] font-medium">قطعه تولیدی مرتبط *</label>
                <SearchableSelect
                  options={parts.map(p => ({
                    value: p.id,
                    label: p.name,
                    sublabel: `کد فنی: ${p.code} | رده خودرو: ${p.carModel || 'مشترک'}`,
                    badge: p.materialGrade || p.unit || 'قطعه',
                  }))}
                  value={dieFormData.partId || ''}
                  onChange={val => setDieFormData({ ...dieFormData, partId: val })}
                  placeholder="جستجو و انتخاب قطعه از کاتالوگ..."
                  searchPlaceholder="جستجوی کد فنی، نام یا رده خودرو..."
                  required
                />
              </div>

              {/* MACHINE-DIE COMPATIBILITY MATRIX (سازگاری قالب با پرس‌ها) */}
              <div className="p-3 bg-[var(--fiori-bg-subtle)] rounded-[var(--fiori-radius-md)] border border-[var(--fiori-border-default)] space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-[var(--fiori-text-primary)] font-bold block">
                      سازگاری قالب با پرس‌ها (Machine-Die Compatibility) *
                    </label>
                    <span className="text-[10px] text-[var(--fiori-text-muted)] block">
                      پرس‌هایی که قابلیت نصب این قالب را دارند انتخاب نمایید (تاثیر مستقیم در الگوریتم MRP و برنامه‌ریزی تولید).
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const reqTon = dieFormData.requiredTonnage || 0;
                      const suitableCodes = machines
                        .filter(m => (m.tonnage || 0) >= reqTon)
                        .map(m => m.code);
                      const allCodes = machines.map(m => m.code);
                      const current = dieFormData.compatibleMachineCodes || [];
                      if (current.length === allCodes.length) {
                        setDieFormData({ ...dieFormData, compatibleMachineCodes: [], compatibleMachineIds: [] });
                      } else if (suitableCodes.length > 0) {
                        setDieFormData({
                          ...dieFormData,
                          compatibleMachineCodes: suitableCodes,
                          compatibleMachineIds: machines.filter(m => suitableCodes.includes(m.code)).map(m => m.id),
                        });
                      } else {
                        setDieFormData({
                          ...dieFormData,
                          compatibleMachineCodes: allCodes,
                          compatibleMachineIds: machines.map(m => m.id),
                        });
                      }
                    }}
                    className="text-[10px] text-[var(--fiori-brand)] hover:text-[var(--fiori-brand-hover)] font-bold underline cursor-pointer"
                  >
                    انتخاب خودکار پرس‌های متناسب
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-44 overflow-y-auto pt-1">
                  {machines.map(m => {
                    const isSelected = (dieFormData.compatibleMachineCodes || []).includes(m.code);
                    const isTonnageEnough = (m.tonnage || 0) >= (dieFormData.requiredTonnage || 0);

                    return (
                      <div
                        key={m.id}
                        onClick={() => {
                          const current = dieFormData.compatibleMachineCodes || [];
                          const updated = isSelected
                            ? current.filter(c => c !== m.code)
                            : [...current, m.code];
                          setDieFormData({
                            ...dieFormData,
                            compatibleMachineCodes: updated,
                            compatibleMachineIds: machines.filter(mc => updated.includes(mc.code)).map(mc => mc.id),
                          });
                        }}
                        className={`flex items-start gap-2.5 p-2 rounded-[var(--fiori-radius-sm)] border transition-colors cursor-pointer select-none ${
                          isSelected
                            ? 'bg-[var(--fiori-bg-selected)] border-[var(--fiori-brand)] text-[var(--fiori-text-primary)] font-medium'
                            : 'bg-[var(--fiori-bg-surface)] border-[var(--fiori-border-default)] text-[var(--fiori-text-secondary)] hover:bg-[var(--fiori-bg-hover)]'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}}
                          className="mt-0.5 rounded accent-[var(--fiori-brand)] cursor-pointer pointer-events-none"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-1">
                            <span className="fiori-ltr-code text-[11px] font-bold text-[var(--fiori-text-primary)]">{m.code}</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] text-[var(--fiori-text-primary)] font-bold tabular-nums">
                              {toPersianDigits(m.tonnage || 0)} تن
                            </span>
                          </div>
                          <p className="text-[10px] text-[var(--fiori-text-secondary)] truncate">{m.name}</p>
                          <div className="flex items-center gap-1.5 mt-0.5 text-[9px]">
                            <span className="text-[var(--fiori-text-muted)]">میز: {m.bolsterSize || '-'}</span>
                            <span className="text-[var(--fiori-border-default)]">•</span>
                            <span className={isTonnageEnough ? 'text-[var(--fiori-positive)] font-bold' : 'text-[var(--fiori-critical)] font-bold'}>
                              {isTonnageEnough ? 'تناژ کافی' : 'تناژ ناکافی'}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {(dieFormData.compatibleMachineCodes || []).length > 0 && (
                  <div className="text-[10px] text-[var(--fiori-brand)] font-medium flex items-center gap-1 pt-1 border-t border-[var(--fiori-border-subtle)] tabular-nums">
                    <CheckCircle2 className="w-3 h-3 text-[var(--fiori-brand)] shrink-0" />
                    <span>
                      {toPersianDigits((dieFormData.compatibleMachineCodes || []).length)} پرس به عنوان ماشین‌های مجاز برای سوار کردن این قالب تخصیص یافتند.
                    </span>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[var(--fiori-text-primary)] font-medium">تناژ پرس مورد نیاز (تن) *</label>
                  <input
                    type="number"
                    value={dieFormData.requiredTonnage || 250}
                    onChange={e => setDieFormData({ ...dieFormData, requiredTonnage: parseFloat(e.target.value) || 0 })}
                    placeholder="400"
                    className="fiori-input fiori-ltr-code w-full px-3 py-2"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[var(--fiori-text-primary)] font-medium">طول عمر اسمی قالب (تعداد ضرب)</label>
                  <input
                    type="number"
                    value={dieFormData.strokeLifeTarget || 250000}
                    onChange={e => setDieFormData({ ...dieFormData, strokeLifeTarget: parseInt(e.target.value, 10) || 250000 })}
                    placeholder="250000"
                    className="fiori-input fiori-ltr-code w-full px-3 py-2"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[var(--fiori-text-primary)] font-medium">محل در انبار قالب‌ها</label>
                  <input
                    type="text"
                    value={dieFormData.location || ''}
                    onChange={e => setDieFormData({ ...dieFormData, location: e.target.value })}
                    placeholder="قفسه A-04"
                    className="fiori-input w-full px-3 py-2"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[var(--fiori-text-primary)] font-medium">وضعیت فعلی</label>
                  <select
                    value={dieFormData.status}
                    onChange={e => setDieFormData({ ...dieFormData, status: e.target.value as any })}
                    className="fiori-input w-full px-3 py-2"
                  >
                    <option value="READY">آماده به کار در خط تولید</option>
                    <option value="UNDER_MAINTENANCE">در حال تعمیرات و تیزکاری سنبه ماتریس</option>
                    <option value="CALIBRATION">کالیبراسیون و انطباق ابعادی CMM</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-4 border-t border-[var(--fiori-border-subtle)]">
                <button
                  type="button"
                  onClick={() => setIsDieModalOpen(false)}
                  className="sap-btn-standard text-xs"
                >
                  انصراف
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="sap-btn-emphasized text-xs"
                >
                  {loading ? 'در حال ثبت...' : 'ذخیره مشخصات قالب'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* SLIDE-OVER DRAWER: ADD / EDIT OPERATOR */}
      {isOpModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] flex justify-end"
          onClick={() => setIsOpModalOpen(false)}
        >
          <div
            onClick={e => e.stopPropagation()}
            className="bg-[var(--fiori-bg-surface)] border-r border-[var(--fiori-border-default)] w-full max-w-md h-full p-6 shadow-2xl overflow-y-auto"
          >
            <div className="sticky top-0 z-10 bg-[var(--fiori-bg-surface)] flex items-center justify-between pb-3 border-b border-[var(--fiori-border-subtle)]">
              <h3 className="text-sm font-bold text-[var(--fiori-text-primary)] flex items-center gap-2">
                <Users className="w-4 h-4 text-[var(--fiori-positive)]" />
                <span>کشوی ثبت و ویرایش اپراتور خط تولید</span>
              </h3>
              <button
                type="button"
                onClick={() => setIsOpModalOpen(false)}
                className="text-[var(--fiori-text-muted)] hover:text-[var(--fiori-text-primary)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {formError && (
              <FioriMessageStrip compact tone="error" className="mt-3">
                {formError}
              </FioriMessageStrip>
            )}

            <form onSubmit={handleOpSubmit} className="mt-4 space-y-4 text-xs">
              <div className="space-y-1">
                <label className="text-[var(--fiori-text-primary)] font-medium">کد پرسنلی *</label>
                <input
                  type="text"
                  dir="ltr"
                  value={opFormData.personnelCode || ''}
                  onChange={e => setOpFormData({ ...opFormData, personnelCode: e.target.value })}
                  placeholder="EMP-115"
                  className="fiori-input fiori-ltr-code w-full px-3 py-2"
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="text-[var(--fiori-text-primary)] font-medium">نام و نام خانوادگی *</label>
                <input
                  type="text"
                  value={opFormData.fullName || ''}
                  onChange={e => setOpFormData({ ...opFormData, fullName: e.target.value })}
                  placeholder="محمد حسینی"
                  className="fiori-input w-full px-3 py-2"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[var(--fiori-text-primary)] font-medium">شیفت کاری</label>
                  <select
                    value={opFormData.defaultShift}
                    onChange={e => setOpFormData({ ...opFormData, defaultShift: e.target.value as any })}
                    className="fiori-input w-full px-3 py-2"
                  >
                    <option value="MORNING">شیفت صبح</option>
                    <option value="EVENING">شیفت عصر</option>
                    <option value="NIGHT">شیفت شب</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-[var(--fiori-text-primary)] font-medium">تلفن تماس</label>
                  <input
                    type="text"
                    dir="ltr"
                    value={opFormData.phone || ''}
                    onChange={e => setOpFormData({ ...opFormData, phone: e.target.value })}
                    placeholder="0912..."
                    className="fiori-input fiori-ltr-code w-full px-3 py-2"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-4 border-t border-[var(--fiori-border-subtle)]">
                <button
                  type="button"
                  onClick={() => {
                    setIsOpModalOpen(false);
                    setEditingOperator(null);
                  }}
                  className="sap-btn-standard px-4 py-1.5 cursor-pointer"
                >
                  انصراف
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="sap-btn-emphasized px-5 py-1.5 cursor-pointer"
                >
                  {loading ? 'در حال ثبت...' : editingOperator ? 'ذخیره تغییرات اپراتور' : 'ثبت اپراتور جدید'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: OPERATOR TIMESHEET & PERFORMANCE REPORT (گزارش کارکرد هر نفر) */}
      <FioriDialog
        isOpen={Boolean(selectedOpForReport)}
        onClose={() => setSelectedOpForReport(null)}
        title={selectedOpForReport ? `گزارش کارکرد و بازدهی: ${selectedOpForReport.fullName}` : ''}
        subtitle={
          selectedOpForReport
            ? `کد پرسنلی: ${selectedOpForReport.personnelCode} • شیفت: ${selectedOpForReport.defaultShift === 'MORNING' ? 'صبح' : 'عصر'}`
            : undefined
        }
        icon={<FileText className="w-4 h-4" />}
        size="lg"
        footer={
          <>
            <button
              type="button"
              onClick={() => window.print()}
              className="sap-btn-standard flex items-center gap-1.5 px-3.5 py-1.5 text-xs cursor-pointer"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>چاپ کارنامه</span>
            </button>
            <button
              type="button"
              onClick={() => setSelectedOpForReport(null)}
              className="sap-btn-emphasized px-4 py-1.5 text-xs cursor-pointer"
            >
              بستن
            </button>
          </>
        }
      >
        {loadingTimesheet ? (
          <div className="py-12 text-center text-xs text-[var(--fiori-text-secondary)]">
            در حال فراخوانی آمار و کارکرد شیفت‌ها...
          </div>
        ) : opTimesheetData ? (
          <div className="space-y-4 text-xs">
            {/* KPI Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <div className="p-3 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] text-right">
                <span className="text-[10px] text-[var(--fiori-text-secondary)] block">ساعات کارکرد کل:</span>
                <span className="text-base font-extrabold text-[var(--fiori-text-primary)] font-mono tabular-nums">
                  {toPersianDigits(opTimesheetData.summary.totalHoursWorked)} ساعت
                </span>
              </div>
              <div className="p-3 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-positive-bg)] border border-[var(--fiori-positive-border)] text-right">
                <span className="text-[10px] text-[var(--fiori-positive)] block">تولید سالم کل:</span>
                <span className="text-base font-extrabold text-[var(--fiori-positive)] font-mono tabular-nums">
                  {formatNumber(opTimesheetData.summary.totalPiecesProduced)} عدد
                </span>
              </div>
              <div className="p-3 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-critical-bg)] border border-[var(--fiori-critical-border)] text-right">
                <span className="text-[10px] text-[var(--fiori-critical)] block">توقفات ثبت‌شده:</span>
                <span className="text-base font-extrabold text-[var(--fiori-critical)] font-mono tabular-nums">
                  {toPersianDigits(opTimesheetData.summary.downtimeReportedHours)} ساعت
                </span>
              </div>
              <div className="p-3 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-info-bg)] border border-[var(--fiori-info-border)] text-right">
                <span className="text-[10px] text-[var(--fiori-brand)] block">راندمان عملکرد:</span>
                <span className="text-base font-extrabold text-[var(--fiori-brand)] font-mono tabular-nums">
                  {toPersianDigits(opTimesheetData.summary.overallEfficiencyPercent)}%
                </span>
              </div>
            </div>

            {/* Shift Log Table */}
            <div className="sap-card overflow-hidden">
              <FioriToolbar
                variant="table"
                title="ریز عملکرد روزانه و شیفت‌های اخیر"
                count={opTimesheetData.shiftRecords.length}
                countLabel="شیفت"
              />
              <div className="overflow-x-auto">
                <table className="sap-table-compact w-full text-right text-xs">
                  <thead className="bg-[var(--fiori-bg-subtle)] border-b border-[var(--fiori-border-default)] text-[var(--fiori-text-primary)] font-semibold">
                    <tr>
                      <th>تاریخ و شیفت</th>
                      <th>دستگاه</th>
                      <th>قطعه تولیدی</th>
                      <th className="text-center">تولید سالم</th>
                      <th className="text-center">ضایعات</th>
                      <th className="text-center">توقف (دقیقه)</th>
                      <th>علت توقف</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--fiori-border-subtle)] text-[var(--fiori-text-primary)] font-mono tabular-nums">
                    {opTimesheetData.shiftRecords.map((r: any, idx: number) => (
                      <tr key={idx} className="hover:bg-[var(--fiori-bg-hover)]">
                        <td className="font-sans font-medium text-[var(--fiori-text-primary)]">
                          {r.date} <span className="text-[10px] text-[var(--fiori-text-muted)] block">{r.shift}</span>
                        </td>
                        <td className="fiori-ltr-code font-bold text-[var(--fiori-text-primary)]">{r.machineCode}</td>
                        <td className="font-sans">
                          <span className="font-semibold text-[var(--fiori-text-primary)]">{r.partName}</span>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedOpForReport(null);
                              traceDocument(r.partCode, 'INVENTORY_LEDGER');
                            }}
                            className="sap-doc-link text-[10px] block fiori-ltr-code"
                          >
                            {r.partCode}
                          </button>
                        </td>
                        <td className="text-center font-bold text-[var(--fiori-positive)]">
                          {formatNumber(r.actualProduced)}
                        </td>
                        <td className="text-center text-[var(--fiori-negative)] font-semibold">
                          {toPersianDigits(r.scrapCount)}
                        </td>
                        <td className="text-center text-[var(--fiori-critical)]">
                          {toPersianDigits(r.downtimeMin)}
                        </td>
                        <td className="font-sans text-[var(--fiori-text-secondary)] text-[11px] max-w-xs truncate">
                          {r.downtimeReason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : null}
      </FioriDialog>

      {/* MODAL: DYNAMIC PROCESS CAPABILITIES MANAGEMENT (مدیریت قابلیت‌های فرآیندی پرس) */}
      <FioriDialog
        isOpen={isNewProcessModalOpen}
        onClose={() => setIsNewProcessModalOpen(false)}
        title="مدیریت قابلیت‌های فرآیندی پرس‌ها"
        icon={<Settings className="w-4 h-4" />}
        size="md"
        footer={
          <>
            <button
              type="button"
              onClick={() => setIsNewProcessModalOpen(false)}
              className="sap-btn-standard text-xs"
            >
              بستن
            </button>
            <button
              type="submit"
              form="mch-new-proc-form"
              className="sap-btn-emphasized text-xs"
            >
              + افزودن قابلیت
            </button>
          </>
        }
      >
        <div className="space-y-4 text-xs">
          {/* Existing Processes List */}
          <div className="space-y-1 max-h-48 overflow-y-auto divide-y divide-[var(--fiori-border-subtle)]">
            <span className="text-[11px] font-bold text-[var(--fiori-text-secondary)] block mb-1">قابلیت‌های ثبت‌شده در سیستم:</span>
            {availableProcesses.map(p => (
              <div key={p.code} className="flex items-center justify-between py-1.5 px-1">
                <div>
                  <span className="fiori-ltr-code font-bold text-[var(--fiori-text-primary)]">{p.code}</span>
                  <span className="text-[var(--fiori-text-secondary)] mr-2 text-[11px]">{p.name}</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleDeleteProcess(p.code)}
                  className="text-[var(--fiori-negative)] hover:bg-[var(--fiori-negative-bg)] p-1 rounded-[var(--fiori-radius-sm)] cursor-pointer"
                  title="حذف قابلیت"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          {/* Form to add a new process */}
          <form id="mch-new-proc-form" onSubmit={handleCreateProcess} className="pt-3 border-t border-[var(--fiori-border-subtle)] space-y-2.5">
            <span className="text-[11px] font-bold text-[var(--fiori-text-primary)] block">افزودن قابلیت فرآیندی جدید:</span>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-[var(--fiori-text-secondary)] block mb-0.5">شناسه انگلیسی (Code) *</label>
                <input
                  type="text"
                  dir="ltr"
                  required
                  placeholder="مثال: COINING یا FLANGING"
                  value={newProcCode}
                  onChange={e => setNewProcCode(e.target.value)}
                  className="fiori-input fiori-ltr-code w-full px-2.5 py-1.5 text-xs uppercase"
                />
              </div>
              <div>
                <label className="text-[10px] text-[var(--fiori-text-secondary)] block mb-0.5">عنوان فارسی فرایند *</label>
                <input
                  type="text"
                  required
                  placeholder="مثال: سکه‌زنی یا فلنج‌کاری"
                  value={newProcName}
                  onChange={e => setNewProcName(e.target.value)}
                  className="fiori-input w-full px-2.5 py-1.5 text-xs"
                />
              </div>
            </div>
          </form>
        </div>
      </FioriDialog>

      {/* MODAL: QUICK ADD FACTORY HALL (تعریف سالن استقرار جدید) */}
      <FioriDialog
        isOpen={isQuickHallModalOpen}
        onClose={() => setIsQuickHallModalOpen(false)}
        title="ثبت و تعریف سالن تولید جدید"
        icon={<Building className="w-4 h-4" />}
        size="md"
        footer={
          <>
            <button
              type="button"
              onClick={() => setIsQuickHallModalOpen(false)}
              className="sap-btn-standard text-xs"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="mch-quick-hall-form"
              disabled={savingQuickHall}
              className="sap-btn-emphasized text-xs disabled:opacity-50"
            >
              {savingQuickHall ? 'در حال ثبت...' : 'ثبت و انتخاب سالن'}
            </button>
          </>
        }
      >
        <form id="mch-quick-hall-form" onSubmit={handleCreateQuickHall} className="space-y-3 text-xs">
          <div>
            <label className="text-[11px] font-bold text-[var(--fiori-text-primary)] block mb-1">کد سالن *</label>
            <input
              type="text"
              dir="ltr"
              required
              placeholder="HALL-PRESS-02"
              value={quickHallCode}
              onChange={e => setQuickHallCode(e.target.value)}
              className="fiori-input fiori-ltr-code w-full px-3 py-2 uppercase font-bold"
            />
          </div>

          <div>
            <label className="text-[11px] font-bold text-[var(--fiori-text-primary)] block mb-1">نام سالن تولید *</label>
            <input
              type="text"
              required
              placeholder="مثال: سالن پرس متوسط و فیدر خطوط تارا"
              value={quickHallName}
              onChange={e => setQuickHallName(e.target.value)}
              className="fiori-input w-full px-3 py-2 font-medium"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-bold text-[var(--fiori-text-primary)] block mb-1">نوع سالن *</label>
              <select
                value={quickHallType}
                onChange={e => setQuickHallType(e.target.value as any)}
                className="fiori-input w-full px-3 py-2"
              >
                <option value="STAMPING">پرسکاری و پرس ضربه‌ای</option>
                <option value="WELDING">مجموعه‌سازی و جوشکاری</option>
                <option value="PAINT">رنگ و پوشش‌دهی</option>
                <option value="ASSEMBLY">مونتاژ نهایی</option>
                <option value="WAREHOUSE">انبار و لجستیک داخلی</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] font-bold text-[var(--fiori-text-primary)] block mb-1">سرپرست سالن</label>
              <input
                type="text"
                placeholder="مهندس مرادی"
                value={quickHallSupervisor}
                onChange={e => setQuickHallSupervisor(e.target.value)}
                className="fiori-input w-full px-3 py-2"
              />
            </div>
          </div>
        </form>
      </FioriDialog>
    </div>
  );
};
