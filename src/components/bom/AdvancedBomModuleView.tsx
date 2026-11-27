import React, { useState, useEffect } from 'react';
import {
  ListTree,
  Boxes,
  Layers,
  Wrench,
  Disc,
  Plus,
  ArrowRight,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Scale,
  FileSpreadsheet,
  Link2,
  Trash2,
  Edit3,
  HelpCircle,
  GitFork,
  Printer,
  ChevronDown,
  ChevronRight,
  ShieldAlert,
  Search,
  Filter,
  X,
  ClipboardList,
  Warehouse,
} from 'lucide-react';
import { Part, Routing } from '../../types/inventory';
import {
  AdvancedBomDefinition,
  BomComponentItem,
  BomComponentType,
  JoiningProcessType,
} from '../../types/bomAndParallelFlow';
import { toPersianDigits, formatNumber } from '../../utils/formatters';
import { MasterDataDifferenceGuideModal } from '../common/MasterDataDifferenceGuideModal';
import { SearchableSelect } from '../common/SearchableSelect';
import { EmptyState } from '../common/EmptyState';
import {
  FioriDialog,
  FioriMessageStrip,
  FioriObjectStatus,
  FioriToolbar,
} from '../fiori/ui';
import { useErpRouter } from '../../context/RouterContext';
import { useEnterpriseUx } from '../../context/EnterpriseUxContext';

interface AdvancedBomModuleViewProps {
  parts: Part[];
  onOpenTraceabilityModal?: (partCode: string) => void;
  onNavigateToParallelFlow?: () => void;
}

export const AdvancedBomModuleView: React.FC<AdvancedBomModuleViewProps> = ({
  parts,
  onOpenTraceabilityModal,
  onNavigateToParallelFlow,
}) => {
  const { traceDocument, route, clearDocQuery, navigate, pushSelectionStep } = useErpRouter();
  const { requestConfirm, showUndoToast } = useEnterpriseUx();
  const [boms, setBoms] = useState<AdvancedBomDefinition[]>([]);
  const [routings, setRoutings] = useState<Routing[]>([]);
  const [selectedBomId, setSelectedBomId] = useState<string>('');
  const [bomSearchQuery, setBomSearchQuery] = useState<string>(route.docQuery || '');
  const [loading, setLoading] = useState(false);
  const [isGuideOpen, setIsGuideOpen] = useState(false);

  // New BOM Modal
  const [isNewBomModalOpen, setIsNewBomModalOpen] = useState(false);
  const [newBomPartId, setNewBomPartId] = useState('');
  const [newBomVersion, setNewBomVersion] = useState('V1.0');
  const [newBomCarModel, setNewBomCarModel] = useState('');
  const [newBomNotes, setNewBomNotes] = useState('');

  // Edit BOM Modal
  const [isEditBomModalOpen, setIsEditBomModalOpen] = useState(false);
  const [editBomVersion, setEditBomVersion] = useState('');
  const [editBomCarModel, setEditBomCarModel] = useState('');
  const [editBomNotes, setEditBomNotes] = useState('');

  // Sub-MO Pre-Flight Confirmation & Result Modals
  const [isGeneratingSubMos, setIsGeneratingSubMos] = useState(false);
  const [subMoPreflightOpen, setSubMoPreflightOpen] = useState(false);
  const [selectedSubCompIds, setSelectedSubCompIds] = useState<string[]>([]);
  const [subMoModalOpen, setSubMoModalOpen] = useState(false);
  const [plannedQty, setPlannedQty] = useState(500);
  const [masterMoNumber, setMasterMoNumber] = useState('MO-1403-1082');
  const [generatedSubMos, setGeneratedSubMos] = useState<any[]>([]);

  // Add / Edit Component Modal
  const [isComponentModalOpen, setIsComponentModalOpen] = useState(false);
  const [editingCompId, setEditingCompId] = useState<string | null>(null);
  const [compParentId, setCompParentId] = useState<string>('');
  const [compPartId, setCompPartId] = useState('');
  const [compPartCode, setCompPartCode] = useState('');
  const [compPartName, setCompPartName] = useState('');
  const [compType, setCompType] = useState<BomComponentType>('RAW_SHEET');
  const [compQty, setCompQty] = useState(1);
  const [compUnit, setCompUnit] = useState<'PCS' | 'KG' | 'SET'>('PCS');
  const [compGross, setCompGross] = useState(0.5);
  const [compNet, setCompNet] = useState(0.4);
  const [compScrap, setCompScrap] = useState(20);
  const [compJoining, setCompJoining] = useState<JoiningProcessType>('SPOT_WELD');
  const [compSubMo, setCompSubMo] = useState(true);
  const [compStepJoined, setCompStepJoined] = useState(30);
  const [compSupplier, setCompSupplier] = useState<'SAPCO_CONSIGNMENT' | 'INTERNAL_FABRICATED' | 'PURCHASED_MARKET'>('INTERNAL_FABRICATED');

  const loadBoms = async () => {
    try {
      setLoading(true);
      const [bomRes, rtgRes] = await Promise.all([
        fetch('/api/production/boms'),
        fetch('/api/routings'),
      ]);
      const [data, rtgData] = await Promise.all([bomRes.json(), rtgRes.json()]);
      if (rtgData.success && Array.isArray(rtgData.data)) {
        setRoutings(rtgData.data);
      }
      if (data.success && data.data) {
        const byPartId = new Map(parts.map(p => [p.id, p]));
        const list: AdvancedBomDefinition[] = (data.data as AdvancedBomDefinition[]).map(b => {
          const liveHeader = byPartId.get(b.assemblyPartId);
          return {
            ...b,
            assemblyPartCode: liveHeader?.code || b.assemblyPartCode,
            assemblyPartName: liveHeader?.name || b.assemblyPartName,
            carModel: liveHeader?.carModel || b.carModel,
            components: (b.components || []).map(cmp => {
              const liveCmp = byPartId.get(cmp.componentPartId);
              return liveCmp
                ? { ...cmp, componentPartCode: liveCmp.code, componentPartName: liveCmp.name }
                : cmp;
            }),
          };
        });
        setBoms(list);
        const query = (route.docQuery || '').trim().toLowerCase();
        if (query) {
          const matched = list.find(
            b =>
              b.assemblyPartCode.toLowerCase().includes(query) ||
              b.assemblyPartName.toLowerCase().includes(query) ||
              b.components.some(
                c =>
                  c.componentPartCode.toLowerCase().includes(query) ||
                  c.componentPartName.toLowerCase().includes(query),
              ),
          );
          if (matched) {
            setSelectedBomId(matched.id);
            return;
          }
        }
        if (!selectedBomId && list.length > 0) {
          setSelectedBomId(list[0].id);
        }
      }
    } catch (err) {
      console.error('Error loading BOMs:', err);
    } finally {
      setLoading(false);
    }
  };

  const resolveComponentRouting = (comp: BomComponentItem): Routing | undefined => {
    const codeUpper = String(comp.componentPartCode || '').trim().toUpperCase();
    return (
      (comp.subRoutingId ? routings.find(r => r.id === comp.subRoutingId) : undefined) ||
      routings.find(
        r =>
          r.partId === comp.componentPartId ||
          String(r.partCode || '').trim().toUpperCase() === codeUpper,
      )
    );
  };

  useEffect(() => {
    loadBoms();
  }, [parts]);

  useEffect(() => {
    const handler = () => {
      loadBoms();
    };
    window.addEventListener('kpims-master-data-updated', handler);
    return () => window.removeEventListener('kpims-master-data-updated', handler);
  }, []);

  useEffect(() => {
    if (!route.docQuery) return;
    setBomSearchQuery(route.docQuery);
    const q = route.docQuery.trim().toLowerCase();
    const matched = boms.find(
      b =>
        b.assemblyPartCode.toLowerCase().includes(q) ||
        b.assemblyPartName.toLowerCase().includes(q) ||
        b.components.some(
          c =>
            c.componentPartCode.toLowerCase().includes(q) ||
            c.componentPartName.toLowerCase().includes(q),
        ),
    );
    if (matched) {
      setSelectedBomId(matched.id);
    }
  }, [route.docQuery, boms]);

  const filteredBoms = bomSearchQuery.trim()
    ? boms.filter(b => {
        const q = bomSearchQuery.trim().toLowerCase();
        return (
          b.assemblyPartCode.toLowerCase().includes(q) ||
          b.assemblyPartName.toLowerCase().includes(q) ||
          b.carModel.toLowerCase().includes(q) ||
          b.components.some(
            c =>
              c.componentPartCode.toLowerCase().includes(q) ||
              c.componentPartName.toLowerCase().includes(q),
          )
        );
      })
    : boms;

  const activeBom = filteredBoms.find(b => b.id === selectedBomId) || filteredBoms[0] || (bomSearchQuery.trim() ? undefined : boms[0]);

  // Create New BOM
  const handleCreateNewBom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBomPartId) {
      showUndoToast({ title: 'لطفاً قطعه مورد نظر را انتخاب کنید.', variant: 'warning' });
      return;
    }
    const part = parts.find(p => p.id === newBomPartId);
    if (!part) return;

    const newBomPayload: Partial<AdvancedBomDefinition> = {
      assemblyPartId: part.id,
      assemblyPartCode: part.code,
      assemblyPartName: part.name,
      carModel: newBomCarModel || part.carModel || 'مشترک',
      version: newBomVersion || 'V1.0',
      isActive: true,
      effectiveDate: new Date().toISOString().split('T')[0],
      notes: newBomNotes,
      components: [],
    };

    try {
      const res = await fetch('/api/production/boms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newBomPayload),
      });
      const data = await res.json();
      if (data.success && data.data) {
        await loadBoms();
        setSelectedBomId(data.data.id);
        setIsNewBomModalOpen(false);
        setNewBomPartId('');
        setNewBomVersion('V1.0');
        setNewBomNotes('');
        showUndoToast({ title: 'درخت محصول جدید با موفقیت ایجاد شد.', variant: 'success' });
      } else {
        showUndoToast({ title: data.error || 'خطا در ثبت درخت محصول جدید', variant: 'danger' });
      }
    } catch {
      showUndoToast({ title: 'خطا در ارتباط با سرور', variant: 'danger' });
    }
  };

  // Edit Active BOM Details
  const handleOpenEditBom = () => {
    if (!activeBom) return;
    setEditBomVersion(activeBom.version || 'V1.0');
    setEditBomCarModel(activeBom.carModel || '');
    setEditBomNotes(activeBom.notes || '');
    setIsEditBomModalOpen(true);
  };

  const handleSaveEditBom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeBom) return;

    const updated = {
      ...activeBom,
      version: editBomVersion,
      carModel: editBomCarModel,
      notes: editBomNotes,
    };

    try {
      const res = await fetch('/api/production/boms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
      const data = await res.json();
      if (data.success) {
        await loadBoms();
        setIsEditBomModalOpen(false);
        showUndoToast({ title: 'مشخصات BOM بروزرسانی شد.', variant: 'success' });
      }
    } catch {
      showUndoToast({ title: 'خطا در بروزرسانی مشخصات BOM', variant: 'danger' });
    }
  };

  // Delete Entire BOM
  const handleDeleteBom = () => {
    if (!activeBom) return;
    requestConfirm({
      title: 'حذف درخت محصول',
      message: `آیا از حذف کامل درخت محصول ${activeBom.assemblyPartCode} - ${activeBom.assemblyPartName} اطمینان دارید؟`,
      confirmLabel: 'تایید و حذف',
      variant: 'danger',
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/production/boms/${activeBom.id}`, { method: 'DELETE' });
          const data = await res.json();
          if (data.success) {
            const remaining = boms.filter(b => b.id !== activeBom.id);
            setBoms(remaining);
            if (remaining.length > 0) setSelectedBomId(remaining[0].id);
            else setSelectedBomId('');
            showUndoToast({ title: 'درخت محصول حذف شد.', variant: 'info' });
          } else {
            showUndoToast({ title: data.error || 'خطا در حذف BOM', variant: 'danger' });
          }
        } catch {
          showUndoToast({ title: 'خطا در حذف BOM', variant: 'danger' });
        }
      },
    });
  };

  // Open Add Component Modal
  // Open Add Component Modal
  const handleOpenAddComponent = (parentId?: string) => {
    setEditingCompId(null);
    setCompParentId(parentId || '');
    setCompPartId('');
    setCompPartCode('');
    setCompPartName('');
    setCompType('RAW_SHEET');
    setCompQty(1);
    setCompUnit('PCS');
    setCompGross(1.0);
    setCompNet(0.85);
    setCompScrap(15);
    setCompJoining('SPOT_WELD');
    setCompSubMo(true);
    setCompStepJoined(30);
    setCompSupplier('INTERNAL_FABRICATED');
    setIsComponentModalOpen(true);
  };

  // Open Edit Component Modal
  const handleOpenEditComponent = (comp: BomComponentItem) => {
    setEditingCompId(comp.id);
    setCompParentId(comp.parentId || '');
    setCompPartId(comp.componentPartId || comp.componentPartCode);
    setCompPartCode(comp.componentPartCode);
    setCompPartName(comp.componentPartName);
    setCompType(comp.componentType);
    setCompQty(comp.quantityPerAssembly);
    setCompUnit((comp.unit as any) || 'PCS');
    setCompGross(comp.grossWeightKg);
    setCompNet(comp.netWeightKg);
    setCompScrap(comp.scrapAllowancePercent);
    setCompJoining(comp.joiningProcess || 'SPOT_WELD');
    setCompSubMo(comp.subMoRequired ?? true);
    setCompStepJoined(comp.stageJoinedStepNumber || 30);
    setCompSupplier(comp.supplierSource || 'INTERNAL_FABRICATED');
    setIsComponentModalOpen(true);
  };

  // Delete Component from BOM
  const handleDeleteComponent = (compId: string) => {
    if (!activeBom) return;
    requestConfirm({
      title: 'حذف جزء از درخت محصول',
      message: 'آیا از حذف این جزء از درخت محصول مطمئن هستید؟',
      confirmLabel: 'حذف جزء',
      variant: 'danger',
      onConfirm: async () => {
        const updatedComponents = activeBom.components.filter(c => c.id !== compId && c.parentId !== compId);
        const totalGross = updatedComponents.reduce((s, c) => s + (c.grossWeightKg || 0), 0);
        const totalNet = updatedComponents.reduce((s, c) => s + (c.netWeightKg || 0), 0);

        const updatedBom: AdvancedBomDefinition = {
          ...activeBom,
          components: updatedComponents,
          totalGrossWeightKg: Math.round(totalGross * 1000) / 1000,
          totalNetWeightKg: Math.round(totalNet * 1000) / 1000,
          yieldEfficiencyPercent: totalGross > 0 ? Math.round((totalNet / totalGross) * 1000) / 10 : 85,
        };

        try {
          const res = await fetch('/api/production/boms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updatedBom),
          });
          const data = await res.json();
          if (data.success) {
            await loadBoms();
            showUndoToast({ title: 'جزء از درخت محصول حذف شد.', variant: 'info' });
          }
        } catch {
          showUndoToast({ title: 'خطا در حذف جزء', variant: 'danger' });
        }
      },
    });
  };

  // Save Component (Add or Edit)
  const handleSaveComponent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeBom) return;

    const parentItem = compParentId
      ? activeBom.components.find(c => c.id === compParentId || c.componentPartCode === compParentId)
      : undefined;

    const compData: BomComponentItem = {
      id: editingCompId || `CMP-${Date.now()}`,
      bomId: activeBom.id,
      parentId: parentItem?.id,
      parentCode: parentItem?.componentPartCode,
      parentName: parentItem?.componentPartName,
      level: parentItem ? (parentItem.level || 1) + 1 : 1,
      isSubAssembly: false,
      componentPartId: compPartId || compPartCode,
      componentPartCode: compPartCode,
      componentPartName: compPartName || 'جزء مجموعه',
      componentType: compType,
      quantityPerAssembly: Number(compQty),
      unit: compUnit,
      grossWeightKg: Number(compGross),
      netWeightKg: Number(compNet),
      scrapAllowancePercent: Number(compScrap),
      joiningProcess: compJoining,
      subMoRequired: compSubMo,
      stageJoinedStepNumber: Number(compStepJoined),
      supplierSource: compSupplier,
    };

    let updatedComponents: BomComponentItem[] = activeBom.components.map(c => {
      if (c.id === editingCompId) return compData;
      if (parentItem && (c.id === parentItem.id || c.componentPartCode === parentItem.componentPartCode)) {
        return { ...c, isSubAssembly: true };
      }
      return c;
    });

    if (!editingCompId) {
      updatedComponents.push(compData);
      if (parentItem) {
        updatedComponents = updatedComponents.map(c => {
          if (c.id === parentItem.id) return { ...c, isSubAssembly: true };
          return c;
        });
      }
    }

    const totalGross = updatedComponents.reduce((s, c) => s + (c.grossWeightKg || 0), 0);
    const totalNet = updatedComponents.reduce((s, c) => s + (c.netWeightKg || 0), 0);

    const updatedBom: AdvancedBomDefinition = {
      ...activeBom,
      components: updatedComponents,
      totalGrossWeightKg: Math.round(totalGross * 1000) / 1000,
      totalNetWeightKg: Math.round(totalNet * 1000) / 1000,
      yieldEfficiencyPercent: totalGross > 0 ? Math.round((totalNet / totalGross) * 1000) / 10 : 85,
    };

    try {
      const res = await fetch('/api/production/boms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedBom),
      });
      const data = await res.json();
      if (data.success) {
        await loadBoms();
        setIsComponentModalOpen(false);
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Open Pre-Flight Sub-MO Configuration & Confirmation Modal (never fire silently without operator sign-off)
  const handleOpenSubMoPreflight = () => {
    if (!activeBom) return;
    const subComps = activeBom.components.filter(c => c.subMoRequired);
    if (subComps.length === 0) {
      showUndoToast({
        title: 'هیچ جزئی با وضعیت «نیاز به دستور ساخت فرعی (Sub-MO)» در این BOM علامت نخورده است.',
        variant: 'warning',
      });
      return;
    }
    setSelectedSubCompIds(subComps.map(c => c.id));
    setSubMoPreflightOpen(true);
  };

  // Execute Sub-MOs ONLY after operator reviews quantities, parent MO, and Routings in Pre-Flight modal
  const handleConfirmGenerateSubMos = async () => {
    if (!activeBom) return;
    setIsGeneratingSubMos(true);
    try {
      const res = await fetch('/api/production/boms/generate-sub-mos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bomId: activeBom.id,
          plannedQty: Number(plannedQty) || 1,
          masterMoNumber: masterMoNumber.trim() || `MO-${Date.now()}`,
          componentIds: selectedSubCompIds,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'خطا در صدور دستورهای ساخت فرعی');
      }
      setSubMoPreflightOpen(false);
      setGeneratedSubMos(data.data || []);
      setSubMoModalOpen(true);
      showUndoToast({
        title: data.message || 'دستورات ساخت فرعی واقعی در کارگاه ایجاد شدند.',
        variant: 'success',
      });
      window.dispatchEvent(new CustomEvent('kpims-master-data-updated'));
    } catch (err: any) {
      showUndoToast({ title: err.message || 'خطای سرور در صدور Sub-MO', variant: 'danger' });
    } finally {
      setIsGeneratingSubMos(false);
    }
  };

  return (
    <div className="space-y-4 font-sans text-right">
      {/* SAP Fiori Header Banner */}
      <div className="sap-card p-4 text-[var(--fiori-text-primary)] space-y-3">
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-3">
          <div className="flex items-start sm:items-center gap-3">
            <div className="w-10 h-10 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-brand-bg)] border border-[var(--fiori-brand-border)] text-[var(--fiori-brand)] flex items-center justify-center shrink-0">
              <ListTree className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-bold text-[var(--fiori-text-primary)]">
                  مدیریت درخت محصول چندسطحی (Multi-Level BOM &amp; Assemblies)
                </h2>
                <FioriObjectStatus tone="positive" label="مهندسی پرسکاری و مونتاژ" />
              </div>
              <p className="text-xs text-[var(--fiori-text-secondary)] mt-0.5">
                تعریف ساختار قطعات ترکیبی خودرویی، ورق‌های مختلف، مهره‌های جوشی و صدور دستورات ساخت فرعی کارگاهی
              </p>
            </div>
          </div>

          {/* Action Controls */}
          <div className="flex flex-wrap items-center gap-2 self-end lg:self-auto">
            <button
              type="button"
              onClick={() => setIsNewBomModalOpen(true)}
              className="sap-btn-emphasized flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>تعریف BOM جدید برای محصول</span>
            </button>

            {onNavigateToParallelFlow && (
              <button
                type="button"
                onClick={onNavigateToParallelFlow}
                className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
              >
                <GitFork className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
                <span>منطق قالب‌های مشترک و قرینه چپ/راست</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setIsGuideOpen(true)}
              className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
            >
              <HelpCircle className="w-3.5 h-3.5 text-[var(--fiori-text-secondary)]" />
              <span>راهنمای تفاوت کاتالوگ و BOM</span>
            </button>
          </div>
        </div>

        {/* BOM Selector Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-[var(--fiori-border-subtle)] text-xs">
          <div className="flex items-center gap-2 flex-wrap flex-1">
            <div className="relative min-w-[200px]">
              <Search className="w-3.5 h-3.5 text-[var(--fiori-text-secondary)] absolute right-2.5 top-2" />
              <input
                type="text"
                value={bomSearchQuery}
                onChange={e => setBomSearchQuery(e.target.value)}
                placeholder="جستجوی کد یا نام قطعه در BOM..."
                className="fiori-input pr-8 pl-2.5 py-1 text-xs w-full"
              />
            </div>
            <span className="text-[var(--fiori-text-secondary)] font-medium">انتخاب درخت محصول جاری:</span>
            <select
              value={activeBom?.id || ''}
              onChange={e => {
                const nextId = e.target.value;
                const prevId = activeBom?.id || '';
                if (prevId && nextId !== prevId) {
                  const nextBom = boms.find(b => b.id === nextId);
                  pushSelectionStep(
                    `BOM: ${nextBom?.assemblyPartCode || nextId}`,
                    () => setSelectedBomId(prevId),
                    `bom:${nextId}`,
                  );
                }
                setSelectedBomId(nextId);
              }}
              className="fiori-input px-3 py-1.5 text-xs font-bold cursor-pointer"
            >
              {filteredBoms.map(b => (
                <option key={b.id} value={b.id}>
                  [{b.assemblyPartCode}] {b.assemblyPartName} — نسخه {b.version} ({b.carModel})
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2 text-[11px] text-[var(--fiori-text-secondary)]">
            {route.docQuery && (
              <button
                type="button"
                onClick={() => {
                  clearDocQuery();
                  setBomSearchQuery('');
                }}
                className="px-2 py-0.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border border-[var(--fiori-brand-border)] flex items-center gap-1 cursor-pointer"
              >
                <span>فیلتر لینک: <span className="fiori-ltr-code font-mono">{route.docQuery}</span></span>
                <X className="w-3 h-3" />
              </button>
            )}
            <FioriObjectStatus
              tone="neutral"
              label={
                <span className="tabular-nums">
                  {toPersianDigits(filteredBoms.length)} BOM فعال
                </span>
              }
            />
          </div>
        </div>
      </div>

      {/* Missing BOM CTA for queried part */}
      {bomSearchQuery.trim() && filteredBoms.length === 0 && (
        <FioriMessageStrip
          tone="warning"
          title={`درخت ساختار محصول (BOM) برای «${bomSearchQuery.trim()}» ثبت نشده است`}
          actions={
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  const q = bomSearchQuery.trim().toLowerCase();
                  const matchedPart = parts.find(
                    p =>
                      p.code.toLowerCase() === q ||
                      p.name.toLowerCase() === q ||
                      p.code.toLowerCase().includes(q) ||
                      p.name.toLowerCase().includes(q),
                  );
                  if (matchedPart) {
                    setNewBomPartId(matchedPart.id);
                    setNewBomCarModel(matchedPart.carModel || '');
                  }
                  setIsNewBomModalOpen(true);
                }}
                className="sap-btn-emphasized flex items-center gap-1.5 px-3 py-1 text-xs cursor-pointer whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>ایجاد درخت BOM برای قطعه مرتبط</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  clearDocQuery();
                  setBomSearchQuery('');
                }}
                className="sap-btn-standard px-3 py-1 text-xs cursor-pointer"
              >
                نمایش همه BOMها
              </button>
            </div>
          }
        >
          می‌توانید بلافاصله ساختار ورق، زیرقطعات و پیچ/مهره جوشی این محصول را ایجاد کنید.
        </FioriMessageStrip>
      )}

      {activeBom && (
        <div className="sap-card p-4 space-y-4">
          {/* Active BOM Summary Header */}
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 pb-3 border-b border-[var(--fiori-border-subtle)]">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => traceDocument(activeBom.assemblyPartCode, 'INVENTORY_LEDGER')}
                  className="text-xs px-2 py-0.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border border-[var(--fiori-brand-border)] font-mono font-bold hover:underline cursor-pointer fiori-ltr-code"
                  title="رهگیری در کاردکس انبار"
                >
                  {activeBom.assemblyPartCode}
                </button>
                <FioriObjectStatus tone="critical" label={`نسخه ${activeBom.version}`} />
                <FioriObjectStatus tone="neutral" label={`مدل خودرو: ${activeBom.carModel}`} />
                <span className="text-xs text-[var(--fiori-text-secondary)]">
                  تاریخ اعتبار: <span className="font-mono tabular-nums">{toPersianDigits(activeBom.effectiveDate || '۱۴۰۳/۰۸')}</span>
                </span>
              </div>
              <h3 className="text-base font-bold text-[var(--fiori-text-primary)] mt-2">
                {activeBom.assemblyPartName}
              </h3>
              {activeBom.notes && (
                <p className="text-xs text-[var(--fiori-text-secondary)] mt-1 leading-relaxed">
                  توضیحات مهندسی: {activeBom.notes}
                </p>
              )}
              {/* Direct SAP Fiori Cross-Links scoped to this BOM Part */}
              <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                <button
                  type="button"
                  onClick={() =>
                    navigate({
                      tab: 'production',
                      productionViewMode: 'ERP_WORKBENCH',
                      productionModuleTab: 'MANUFACTURING_ORDERS_LIST',
                      docQuery: activeBom.assemblyPartCode,
                    })
                  }
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-semibold bg-[var(--fiori-brand-bg)] hover:bg-[var(--fiori-bg-selected)] text-[var(--fiori-brand)] border border-[var(--fiori-brand-border)] transition-colors cursor-pointer"
                  title="مشاهده دستورات ساخت مرتبط با این قطعه در ماژول تولید (PP)"
                >
                  <ClipboardList className="w-3.5 h-3.5" />
                  <span>مشاهده دستور ساخت مرتبط (MO)</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    navigate({
                      tab: 'master_data',
                      masterSubSection: 'ROUTINGS',
                      docQuery: activeBom.assemblyPartCode,
                    })
                  }
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-medium bg-[var(--fiori-bg-surface)] hover:bg-[var(--fiori-bg-hover)] text-[var(--fiori-text-primary)] border border-[var(--fiori-border-default)] hover:border-[var(--fiori-brand)] transition-colors cursor-pointer"
                  title="مشاهده مسیر تولید و ایستگاه‌های ساخت این قطعه"
                >
                  <GitFork className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
                  <span>مسیر تولید (Routing)</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    navigate({
                      tab: 'inventory',
                      inventorySubTab: 'INQUIRY',
                      docQuery: activeBom.assemblyPartCode,
                    })
                  }
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-medium bg-[var(--fiori-bg-surface)] hover:bg-[var(--fiori-positive-bg)] text-[var(--fiori-text-primary)] border border-[var(--fiori-border-default)] hover:border-[var(--fiori-positive)] transition-colors cursor-pointer"
                  title="استعلام موجودی انبار و کاردکس این قطعه"
                >
                  <Warehouse className="w-3.5 h-3.5 text-[var(--fiori-positive)]" />
                  <span>موجودی انبار مرتبط</span>
                </button>
              </div>
            </div>

            {/* Action Buttons for Active BOM */}
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => handleOpenAddComponent()}
                className="sap-btn-emphasized px-3 py-1.5 text-xs flex items-center gap-1 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>افزودن جزء / ورق / اتصال به BOM</span>
              </button>

              <button
                type="button"
                onClick={handleOpenEditBom}
                className="sap-btn-standard px-3 py-1.5 text-xs flex items-center gap-1 cursor-pointer"
                title="ویرایش نسخه و توضیحات BOM"
              >
                <Edit3 className="w-3.5 h-3.5" />
                <span>ویرایش سند</span>
              </button>

              <button
                type="button"
                onClick={handleDeleteBom}
                className="p-1.5 text-[var(--fiori-negative)] hover:bg-[var(--fiori-negative-bg)] rounded-[var(--fiori-radius-sm)] transition cursor-pointer border border-[var(--fiori-negative-border)]"
                title="حذف کامل این BOM"
              >
                <Trash2 className="w-4 h-4" />
              </button>

              <button
                type="button"
                onClick={handleOpenSubMoPreflight}
                disabled={isGeneratingSubMos}
                className="sap-btn-standard px-3 py-1.5 text-xs flex items-center gap-1 text-[var(--fiori-brand)] border-[var(--fiori-brand-border)] disabled:opacity-50 cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
                <span>بررسی و صدور دستورات ساخت فرعی (Sub-MO)</span>
              </button>
            </div>
          </div>

          {/* Key Engineering Metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3 bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)]">
              <span className="text-[11px] text-[var(--fiori-text-secondary)] block">وزن ناخالص ورق مصرفی:</span>
              <span className="text-base font-bold text-[var(--fiori-text-primary)] font-mono tabular-nums">
                {toPersianDigits(activeBom.totalGrossWeightKg)} <span className="text-xs font-normal">کیلوگرم</span>
              </span>
              <span className="text-[10px] text-[var(--fiori-text-muted)] block mt-0.5">شامل پرت بلنکینگ</span>
            </div>

            <div className="p-3 bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)]">
              <span className="text-[11px] text-[var(--fiori-text-secondary)] block">وزن خالص مجموعه نهایی:</span>
              <span className="text-base font-bold text-[var(--fiori-positive)] font-mono tabular-nums">
                {toPersianDigits(activeBom.totalNetWeightKg)} <span className="text-xs font-normal">کیلوگرم</span>
              </span>
              <span className="text-[10px] text-[var(--fiori-text-muted)] block mt-0.5">وزن تحویلی به خودروساز</span>
            </div>

            <div className="p-3 bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)]">
              <span className="text-[11px] text-[var(--fiori-text-secondary)] block">راندمان مصرف ورق (Yield):</span>
              <span className="text-base font-bold text-[var(--fiori-critical)] font-mono tabular-nums">
                {toPersianDigits(activeBom.yieldEfficiencyPercent)}%
              </span>
              <span className="text-[10px] text-[var(--fiori-text-muted)] block mt-0.5 tabular-nums">
                نرخ پرت استاندارد: {toPersianDigits(Math.round((100 - activeBom.yieldEfficiencyPercent) * 10) / 10)}%
              </span>
            </div>

            <div className="p-3 bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)]">
              <span className="text-[11px] text-[var(--fiori-text-secondary)] block">دستورهای ساخت فرعی وابسته:</span>
              <span className="text-base font-bold text-[var(--fiori-brand)] font-mono tabular-nums">
                {toPersianDigits(activeBom.components.filter(c => c.subMoRequired).length)} <span className="text-xs font-normal">کارت کارگاهی</span>
              </span>
              <span className="text-[10px] text-[var(--fiori-text-muted)] block mt-0.5">تولید موازی در سالن‌ها</span>
            </div>
          </div>

          {/* Components Breakdown Table */}
          <div className="border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] overflow-hidden bg-[var(--fiori-bg-surface)]">
            <FioriToolbar
              variant="table"
              title={
                <span className="inline-flex items-center gap-1.5">
                  <Layers className="w-4 h-4 text-[var(--fiori-brand)]" />
                  <span>اجزای متشکله درخت محصول و ضرایب مصرف تفکیکی (Component Breakdown)</span>
                </span>
              }
              count={activeBom.components.length}
              countLabel="جزء و قطعه متصل"
            />

            <div className="overflow-x-auto">
              <table className="sap-table-compact w-full text-right text-xs">
                <thead>
                  <tr>
                    <th>نوع جزء</th>
                    <th>کد و شرح قطعه / ورق / اتصال</th>
                    <th className="text-center">ضریب مصرف</th>
                    <th>وزن خالص / ناخالص</th>
                    <th className="text-center">درصد ضایعات</th>
                    <th>مرحله و روش اتصال</th>
                    <th>دستور ساخت فرعی؟</th>
                    <th>تأمین‌کننده</th>
                    <th className="text-center">عملیات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--fiori-border-subtle)] text-[var(--fiori-text-primary)]">
                  {activeBom.components.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="p-4">
                        <EmptyState
                          compact
                          variant="NO_DATA"
                          title="هنوز جزئی به این درخت محصول اضافه نشده است"
                          description="برای اضافه کردن ورق، پیچ یا قطعات نیمه‌ساخته روی دکمه افزودن جزء کلیک کنید."
                          actionLabel="افزودن جزء جدید به BOM"
                          onAction={() => handleOpenAddComponent()}
                        />
                      </td>
                    </tr>
                  ) : (
                    activeBom.components.map((comp, idx) => (
                      <tr key={comp.id || idx} className="hover:bg-[var(--fiori-bg-hover)] transition-colors">
                        {/* Type Badge */}
                        <td className="whitespace-nowrap">
                          {comp.componentType === 'RAW_SHEET' && (
                            <FioriObjectStatus
                              tone="critical"
                              icon={<Disc className="w-3 h-3" />}
                              label="ورق خام اولیه"
                            />
                          )}
                          {comp.componentType === 'FASTENER_HARDWARE' && (
                            <FioriObjectStatus
                              tone="info"
                              icon={<Wrench className="w-3 h-3" />}
                              label="پیچ / مهره جوشی"
                            />
                          )}
                          {comp.componentType === 'RUBBER_SEAL' && (
                            <FioriObjectStatus
                              tone="neutral"
                              icon={<Boxes className="w-3 h-3" />}
                              label="لاستیک / دمپر"
                            />
                          )}
                          {comp.componentType === 'WIP_SUB_PART' && (
                            <FioriObjectStatus
                              tone="positive"
                              icon={<Layers className="w-3 h-3" />}
                              label="نیمه‌ساخته پرسی"
                            />
                          )}
                        </td>

                        {/* Code & Name with Hierarchy Level Indentation */}
                        <td>
                          <div className={`flex items-center gap-1.5 ${comp.level && comp.level > 1 ? 'pr-4' : ''}`}>
                            {comp.level && comp.level > 1 && (
                              <FioriObjectStatus
                                tone="brand"
                                label={`↳ سطح ${toPersianDigits(comp.level)}`}
                                className="shrink-0"
                              />
                            )}
                            <div>
                              <button
                                type="button"
                                onClick={() => traceDocument(comp.componentPartCode, 'INVENTORY_LEDGER')}
                                className="sap-doc-link font-mono font-bold block text-xs fiori-ltr-code"
                                title="رهگیری این قطعه در کاردکس انبار"
                              >
                                {comp.componentPartCode}
                              </button>
                              <span className="text-[11px] text-[var(--fiori-text-primary)] block mt-0.5">
                                {comp.componentPartName}
                              </span>
                              {comp.parentCode && (
                                <span className="text-[10px] font-semibold text-[var(--fiori-critical)] block mt-0.5">
                                  متصل به زیرمجموعه: <span className="fiori-ltr-code font-mono">{comp.parentCode}</span> ({comp.parentName})
                                </span>
                              )}
                              {comp.notes && (
                                <span className="text-[10px] text-[var(--fiori-text-secondary)] block mt-0.5">
                                  {comp.notes}
                                </span>
                              )}
                            </div>
                          </div>
                        </td>

                        {/* Quantity */}
                        <td className="whitespace-nowrap text-center tabular-nums">
                          <span className="font-bold text-[var(--fiori-text-primary)] font-mono text-xs">
                            {toPersianDigits(comp.quantityPerAssembly)}
                          </span>{' '}
                          <span className="text-[11px] text-[var(--fiori-text-secondary)]">
                            {comp.unit === 'PCS' ? 'عدد' : comp.unit === 'KG' ? 'کیلوگرم' : 'ست'}
                          </span>
                        </td>

                        {/* Weights */}
                        <td className="whitespace-nowrap text-[11px] tabular-nums">
                          <div>خالص: <strong className="font-mono text-[var(--fiori-text-primary)]">{toPersianDigits(comp.netWeightKg)} kg</strong></div>
                          <div className="text-[var(--fiori-text-secondary)]">ناخالص: <span className="font-mono">{toPersianDigits(comp.grossWeightKg)} kg</span></div>
                        </td>

                        {/* Scrap % */}
                        <td className="whitespace-nowrap text-center tabular-nums">
                          {comp.scrapAllowancePercent > 0 ? (
                            <FioriObjectStatus
                              tone="critical"
                              label={<span className="font-mono tabular-nums">{toPersianDigits(comp.scrapAllowancePercent)}%</span>}
                            />
                          ) : (
                            <span className="text-[11px] text-[var(--fiori-text-secondary)] font-mono">۰%</span>
                          )}
                        </td>

                        {/* Joining Operation */}
                        <td className="whitespace-nowrap text-[11px]">
                          <span className="font-bold text-[var(--fiori-text-primary)] block tabular-nums">
                            مرحله {toPersianDigits(comp.stageJoinedStepNumber || 30)}
                          </span>
                          <span className="text-[10px] text-[var(--fiori-text-secondary)] block">
                            {comp.joiningProcess === 'SPOT_WELD' && 'پرس‌جوش مقاومتی'}
                            {comp.joiningProcess === 'CO2_WELD' && 'جوش تحت گاز CO2'}
                            {comp.joiningProcess === 'FASTENING' && 'بستن پیچ با ترک‌رنچ'}
                            {comp.joiningProcess === 'HEMMING' && 'همبربندی هیدرولیک'}
                            {comp.joiningProcess === 'PRESS_FIT' && 'جا زدن فشاری بوش'}
                          </span>
                        </td>

                        {/* Sub-MO Required & Live Routing Readiness */}
                        <td className="whitespace-nowrap">
                          {comp.subMoRequired ? (
                            (() => {
                              const compRouting = resolveComponentRouting(comp);
                              return (
                                <div className="space-y-1">
                                  <FioriObjectStatus
                                    tone="info"
                                    icon={<CheckCircle2 className="w-3 h-3" />}
                                    label="دستور ساخت مجزا"
                                  />
                                  {compRouting && compRouting.operations.length > 0 ? (
                                    <div className="text-[10px] text-[var(--fiori-positive)] flex items-center gap-1 tabular-nums">
                                      <span>
                                        مسیر تعریف‌شده: {toPersianDigits(compRouting.operations.length)} ایستگاه
                                      </span>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          navigate({
                                            tab: 'master_data',
                                            masterSubSection: 'ROUTINGS',
                                            docQuery: comp.componentPartCode,
                                          })
                                        }
                                        className="text-[var(--fiori-brand)] hover:underline font-bold cursor-pointer"
                                        title="مشاهده و سفارشی‌سازی ایستگاه‌ها در مسیر تولید"
                                      >
                                        (شخصی‌سازی)
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="text-[10px] text-[var(--fiori-negative)] flex items-center gap-1">
                                      <span>فاقد مسیر تولید (Routing)</span>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          navigate({
                                            tab: 'master_data',
                                            masterSubSection: 'ROUTINGS',
                                            docQuery: comp.componentPartCode,
                                          })
                                        }
                                        className="text-[var(--fiori-brand)] underline font-bold cursor-pointer"
                                      >
                                        تعریف مسیر
                                      </button>
                                    </div>
                                  )}
                                </div>
                              );
                            })()
                          ) : (
                            <span className="text-[11px] text-[var(--fiori-text-secondary)]">تغذیه مستقیم خط</span>
                          )}
                        </td>

                        {/* Supplier */}
                        <td className="whitespace-nowrap text-[11px] text-[var(--fiori-text-secondary)]">
                          {comp.supplierSource === 'SAPCO_CONSIGNMENT' && 'امانی ساپکو'}
                          {comp.supplierSource === 'INTERNAL_FABRICATED' && 'تولید داخل کارخانه'}
                          {comp.supplierSource === 'PURCHASED_MARKET' && 'خرید بازار'}
                        </td>

                        {/* Actions: Edit, Sub-Component & Delete */}
                        <td className="text-center whitespace-nowrap">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              type="button"
                              onClick={() => handleOpenAddComponent(comp.id)}
                              className="px-2 py-0.5 bg-[var(--fiori-critical-bg)] hover:opacity-90 text-[var(--fiori-critical)] border border-[var(--fiori-critical-border)] rounded-[var(--fiori-radius-sm)] text-[10px] font-bold transition cursor-pointer flex items-center gap-0.5"
                              title="افزودن جزء متشکله فرعی زیر این قطعه"
                            >
                              <Plus className="w-3 h-3" />
                              <span>زیر‌جزء</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => handleOpenEditComponent(comp)}
                              className="p-1 text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] hover:bg-[var(--fiori-bg-hover)] rounded-[var(--fiori-radius-sm)] transition cursor-pointer"
                              title="ویرایش مشخصات این جزء"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteComponent(comp.id)}
                              className="p-1 text-[var(--fiori-negative)] hover:bg-[var(--fiori-negative-bg)] rounded-[var(--fiori-radius-sm)] transition cursor-pointer"
                              title="حذف این جزء از درخت محصول"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                            {onOpenTraceabilityModal && (
                              <button
                                type="button"
                                onClick={() => onOpenTraceabilityModal(comp.componentPartCode)}
                                title="صدور کارت رهگیری و بچ برای این جزء"
                                className="p-1 text-[var(--fiori-brand)] hover:bg-[var(--fiori-brand-bg)] rounded-[var(--fiori-radius-sm)] transition cursor-pointer"
                              >
                                <Printer className="w-3.5 h-3.5" />
                              </button>
                            )}
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
      )}

      {/* Modal 1: Create New BOM */}
      <FioriDialog
        isOpen={isNewBomModalOpen}
        onClose={() => setIsNewBomModalOpen(false)}
        title="تعریف درخت محصول جدید (New BOM)"
        icon={<ListTree className="w-4 h-4" />}
        tone="brand"
        size="md"
        footer={
          <>
            <button
              type="button"
              onClick={() => setIsNewBomModalOpen(false)}
              className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="adv-bom-new-form"
              className="sap-btn-emphasized px-5 py-1.5 text-xs cursor-pointer"
            >
              ایجاد درخت محصول
            </button>
          </>
        }
      >
        <form id="adv-bom-new-form" onSubmit={handleCreateNewBom} className="space-y-3 text-xs">
          <div>
            <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">
              انتخاب محصول نهایی یا مجموعه از کاتالوگ قطعات *
            </label>
            <SearchableSelect
              value={newBomPartId}
              onChange={val => {
                setNewBomPartId(val);
                const p = parts.find(item => item.id === val);
                if (p && p.carModel) setNewBomCarModel(p.carModel);
              }}
              placeholder="انتخاب قطعه برای ایجاد درخت محصول..."
              searchPlaceholder="جستجوی کد یا نام قطعه..."
              options={parts.map(p => ({
                value: p.id,
                label: p.name,
                sublabel: `${p.code} • ${p.carModel || 'مشترک'}`,
                badge: p.category === 'FINISHED_GOOD' ? 'محصول نهایی' : p.category === 'WIP_PART' ? 'نیمه‌ساخته' : 'ماده اولیه',
              }))}
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">نسخه مهندسی BOM *</label>
              <input
                type="text"
                required
                value={newBomVersion}
                onChange={e => setNewBomVersion(e.target.value)}
                placeholder="V1.0 یا V2.0"
                className="fiori-input w-full px-3 py-2 font-mono fiori-ltr-code"
              />
            </div>
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">مدل خودرو / خانواده محصول</label>
              <input
                type="text"
                value={newBomCarModel}
                onChange={e => setNewBomCarModel(e.target.value)}
                placeholder="مثال: تارا، پژو ۲۰۶، دنا پلاس"
                className="fiori-input w-full px-3 py-2"
              />
            </div>
          </div>

          <div>
            <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">توضیحات و الزامات فنی مونتاژ</label>
            <textarea
              rows={2}
              value={newBomNotes}
              onChange={e => setNewBomNotes(e.target.value)}
              placeholder="نکات جوشکاری مقاومتی، تست‌های گشتاور و استانداردهای ساپکو..."
              className="fiori-input w-full p-2.5"
            />
          </div>
        </form>
      </FioriDialog>

      {/* Modal 2: Edit Active BOM */}
      <FioriDialog
        isOpen={isEditBomModalOpen}
        onClose={() => setIsEditBomModalOpen(false)}
        title="ویرایش مشخصات سند درخت محصول"
        icon={<Edit3 className="w-4 h-4" />}
        tone="default"
        size="sm"
        footer={
          <>
            <button
              type="button"
              onClick={() => setIsEditBomModalOpen(false)}
              className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="adv-bom-edit-form"
              className="sap-btn-emphasized px-5 py-1.5 text-xs cursor-pointer"
            >
              ثبت تغییرات
            </button>
          </>
        }
      >
        <form id="adv-bom-edit-form" onSubmit={handleSaveEditBom} className="space-y-3 text-xs">
          <div>
            <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">نسخه مهندسی BOM</label>
            <input
              type="text"
              required
              value={editBomVersion}
              onChange={e => setEditBomVersion(e.target.value)}
              className="fiori-input w-full px-3 py-1.5 font-mono fiori-ltr-code"
            />
          </div>

          <div>
            <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">مدل خودرو</label>
            <input
              type="text"
              value={editBomCarModel}
              onChange={e => setEditBomCarModel(e.target.value)}
              className="fiori-input w-full px-3 py-1.5"
            />
          </div>

          <div>
            <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">توضیحات مهندسی</label>
            <textarea
              rows={3}
              value={editBomNotes}
              onChange={e => setEditBomNotes(e.target.value)}
              className="fiori-input w-full p-2"
            />
          </div>
        </form>
      </FioriDialog>

      {/* Modal 3: Add / Edit Component Modal */}
      <FioriDialog
        isOpen={isComponentModalOpen}
        onClose={() => setIsComponentModalOpen(false)}
        title={editingCompId ? 'ویرایش جزء متشکله درخت محصول' : `افزودن جزء جدید به BOM [${activeBom?.assemblyPartCode || ''}]`}
        icon={<Layers className="w-4 h-4" />}
        tone="brand"
        size="lg"
        footer={
          <>
            <button
              type="button"
              onClick={() => setIsComponentModalOpen(false)}
              className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="adv-bom-comp-form"
              className="sap-btn-emphasized px-5 py-1.5 text-xs cursor-pointer"
            >
              {editingCompId ? 'ثبت تغییرات جزء' : 'افزودن به درخت محصول'}
            </button>
          </>
        }
      >
        <form id="adv-bom-comp-form" onSubmit={handleSaveComponent} className="space-y-3 text-xs">
          {/* Parent Component Selection for Multi-Level Tree */}
          <div className="p-3 bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] space-y-1">
            <label className="block font-bold text-[var(--fiori-text-primary)] mb-1">
              موقعیت اتکا در درخت محصول (قطعه والد):
            </label>
            <select
              value={compParentId}
              onChange={e => setCompParentId(e.target.value)}
              className="fiori-input w-full px-3 py-1.5 font-semibold cursor-pointer"
            >
              <option value="">
                مستقیماً متصل به مجموعه اصلی [{activeBom?.assemblyPartCode}] (سطح ۱)
              </option>
              {activeBom?.components
                .filter(c => c.id !== editingCompId)
                .map(c => (
                  <option key={c.id} value={c.id}>
                    ↳ زیرمجموعه: [{c.componentPartCode}] {c.componentPartName} (سطح {(c.level || 1) + 1})
                  </option>
                ))}
            </select>
            <span className="text-[10px] text-[var(--fiori-text-secondary)] block pt-0.5">
              برای ایجاد ساختار چندسطحی (مانند متصل کردن صفحه اصلی یا مکمل به مجموعه و سپس اتصال پیچ/مهره به آن) قطعه والد را انتخاب کنید.
            </span>
          </div>

          <div>
            <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">
              انتخاب جزء از کاتالوگ قطعات یا مواد اولیه *
            </label>
            <SearchableSelect
              value={compPartId}
              onChange={val => {
                setCompPartId(val);
                const found = parts.find(p => p.id === val || p.code === val);
                if (found) {
                  setCompPartCode(found.code);
                  setCompPartName(found.name);
                  if (found.category === 'RAW_MATERIAL') setCompType('RAW_SHEET');
                  else if (found.category === 'WIP_PART') setCompType('WIP_SUB_PART');
                  setCompNet(found.weightPerUnitKg || 0.5);
                  setCompGross(Math.round((found.weightPerUnitKg || 0.5) * 1.15 * 100) / 100);
                }
              }}
              placeholder="جستجو و انتخاب کالا / ورق / اتصال..."
              searchPlaceholder="جستجوی کد یا نام جزء..."
              options={parts.map(p => ({
                value: p.code,
                label: p.name,
                sublabel: `${p.code} • ${p.weightPerUnitKg || 0}kg`,
                badge: p.category === 'RAW_MATERIAL' ? 'ماده اولیه' : p.category === 'WIP_PART' ? 'نیمه‌ساخته' : 'محصول',
              }))}
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">کد جزء *</label>
              <input
                type="text"
                required
                value={compPartCode}
                onChange={e => setCompPartCode(e.target.value)}
                placeholder="مثال: SHT-ST14-1.2 یا NUT-M8"
                className="fiori-input w-full px-3 py-1.5 font-mono fiori-ltr-code"
              />
            </div>
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">دسته‌بندی نوع جزء *</label>
              <select
                value={compType}
                onChange={e => setCompType(e.target.value as any)}
                className="fiori-input w-full px-3 py-1.5"
              >
                <option value="RAW_SHEET">ورق خام اولیه (کویل/شیت)</option>
                <option value="WIP_SUB_PART">قطعه نیمه‌ساخته پرسی</option>
                <option value="FASTENER_HARDWARE">پیچ / مهره جوشی / خار</option>
                <option value="RUBBER_SEAL">بوش / دمپر لاستیکی</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">نام کامل مهندسی جزء *</label>
            <input
              type="text"
              required
              value={compPartName}
              onChange={e => setCompPartName(e.target.value)}
              placeholder="شرح دقیق جزء متشکله"
              className="fiori-input w-full px-3 py-1.5"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">ضریب مصرف (تعداد) *</label>
              <input
                type="number"
                step="any"
                min={0.001}
                required
                value={compQty}
                onChange={e => setCompQty(Number(e.target.value))}
                className="fiori-input w-full px-3 py-1.5 font-mono font-bold tabular-nums"
              />
            </div>
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">واحد سنجش</label>
              <select
                value={compUnit}
                onChange={e => setCompUnit(e.target.value as any)}
                className="fiori-input w-full px-3 py-1.5"
              >
                <option value="PCS">عدد (PCS)</option>
                <option value="KG">کیلوگرم (KG)</option>
                <option value="SET">ست (SET)</option>
              </select>
            </div>
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">روش اتصال در خط</label>
              <select
                value={compJoining}
                onChange={e => setCompJoining(e.target.value as any)}
                className="fiori-input w-full px-3 py-1.5"
              >
                <option value="SPOT_WELD">پرس‌جوش مقاومتی</option>
                <option value="CO2_WELD">جوش تحت گاز CO2</option>
                <option value="FASTENING">پیچ و مهره‌کاری</option>
                <option value="HEMMING">همبربندی هیدرولیک</option>
                <option value="PRESS_FIT">جا زدن فشاری بوش</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">وزن خالص (kg)</label>
              <input
                type="number"
                step="any"
                value={compNet}
                onChange={e => setCompNet(Number(e.target.value))}
                className="fiori-input w-full px-3 py-1.5 font-mono tabular-nums"
              />
            </div>
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">وزن ناخالص (kg)</label>
              <input
                type="number"
                step="any"
                value={compGross}
                onChange={e => setCompGross(Number(e.target.value))}
                className="fiori-input w-full px-3 py-1.5 font-mono tabular-nums"
              />
            </div>
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">درصد ضایعات (%)</label>
              <input
                type="number"
                step="any"
                value={compScrap}
                onChange={e => setCompScrap(Number(e.target.value))}
                className="fiori-input w-full px-3 py-1.5 font-mono tabular-nums"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">مرحله اتصال (شماره گام)</label>
              <input
                type="number"
                step={10}
                value={compStepJoined}
                onChange={e => setCompStepJoined(Number(e.target.value))}
                className="fiori-input w-full px-3 py-1.5 font-mono tabular-nums"
              />
            </div>
            <div>
              <label className="block font-medium text-[var(--fiori-text-primary)] mb-1">منبع تأمین</label>
              <select
                value={compSupplier}
                onChange={e => setCompSupplier(e.target.value as any)}
                className="fiori-input w-full px-3 py-1.5"
              >
                <option value="INTERNAL_FABRICATED">تولید داخل کارخانه</option>
                <option value="SAPCO_CONSIGNMENT">امانی ساپکو</option>
                <option value="PURCHASED_MARKET">خرید از بازار</option>
              </select>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-2">
            <input
              type="checkbox"
              id="subMoCheck"
              checked={compSubMo}
              onChange={e => setCompSubMo(e.target.checked)}
              className="rounded-sm accent-[var(--fiori-brand)] w-4 h-4 cursor-pointer"
            />
            <label htmlFor="subMoCheck" className="text-xs text-[var(--fiori-text-primary)] cursor-pointer font-medium">
              نیاز به صدور دستور ساخت فرعی مجزا (Sub-MO) در سالن پرس دارد
            </label>
          </div>
        </form>
      </FioriDialog>

      {/* Pre-Flight Sub-MO Configuration & Confirmation Modal */}
      {(() => {
        if (!subMoPreflightOpen || !activeBom) return null;
        const subComps = activeBom.components.filter(c => c.subMoRequired);
        const evaluated = subComps.map(c => {
          const matchedPart = parts.find(
            p =>
              p.id === c.componentPartId ||
              p.code.trim().toUpperCase() === String(c.componentPartCode || '').trim().toUpperCase(),
          );
          const compRouting = resolveComponentRouting(c);
          const reqQty = Math.ceil(
            (Number(plannedQty) || 0) * Number(c.quantityPerAssembly || 1) * (1 + (Number(c.scrapAllowancePercent) || 0) / 100),
          );
          const isReady = Boolean(matchedPart && compRouting && compRouting.operations.length > 0);
          return { comp: c, matchedPart, compRouting, reqQty, isReady };
        });
        const selectedEvaluated = evaluated.filter(e => selectedSubCompIds.includes(e.comp.id));
        const hasBlocking = selectedEvaluated.length === 0 || selectedEvaluated.some(e => !e.isReady);

        return (
          <FioriDialog
            isOpen={subMoPreflightOpen}
            onClose={() => setSubMoPreflightOpen(false)}
            title="پیش‌بازبینی و تایید صدور دستورات ساخت فرعی (Sub-MO Confirmation)"
            subtitle="پس از تایید، دستورات واقعی کارگاهی در ماژول WIP ایجاد و با دستور مادر و انبار متصل می‌شوند."
            icon={<Sparkles className="w-4 h-4" />}
            tone="brand"
            size="xl"
            footer={
              <>
                <button
                  type="button"
                  onClick={() => setSubMoPreflightOpen(false)}
                  className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
                >
                  انصراف
                </button>
                <button
                  type="button"
                  disabled={hasBlocking || isGeneratingSubMos}
                  onClick={handleConfirmGenerateSubMos}
                  className="sap-btn-emphasized px-5 py-1.5 text-xs disabled:opacity-50 cursor-pointer"
                >
                  {isGeneratingSubMos ? 'در حال صدور دستورات...' : 'تایید قطعی و صدور دستورات ساخت فرعی'}
                </button>
              </>
            }
          >
            <div className="bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] p-3 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block font-bold text-[var(--fiori-text-primary)] mb-1">
                  تیراژ برنامه‌ریزی‌شده محصول اصلی (<span className="fiori-ltr-code font-mono">{activeBom.assemblyPartCode}</span>):
                </label>
                <input
                  type="number"
                  min={1}
                  value={plannedQty}
                  onChange={e => setPlannedQty(Math.max(1, Number(e.target.value) || 1))}
                  className="fiori-input w-full px-3 py-1.5 font-mono font-bold tabular-nums"
                />
              </div>
              <div>
                <label className="block font-bold text-[var(--fiori-text-primary)] mb-1">
                  شماره دستور کار مادر (Master MO Reference):
                </label>
                <input
                  type="text"
                  value={masterMoNumber}
                  onChange={e => setMasterMoNumber(e.target.value)}
                  placeholder="مثلاً MO-ECU-ASY-01"
                  className="fiori-input w-full px-3 py-1.5 font-mono fiori-ltr-code"
                />
              </div>
            </div>

            <div className="space-y-2 max-h-72 overflow-y-auto">
              {evaluated.map(({ comp, compRouting, reqQty, isReady, matchedPart }) => {
                const checked = selectedSubCompIds.includes(comp.id);
                return (
                  <div
                    key={comp.id}
                    className={`p-3 rounded-[var(--fiori-radius-sm)] border text-xs flex flex-col gap-2 ${
                      isReady
                        ? 'bg-[var(--fiori-bg-surface)] border-[var(--fiori-border-default)]'
                        : 'bg-[var(--fiori-critical-bg)] border-[var(--fiori-critical-border)]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={e => {
                            if (e.target.checked) {
                              setSelectedSubCompIds(prev => [...prev, comp.id]);
                            } else {
                              setSelectedSubCompIds(prev => prev.filter(id => id !== comp.id));
                            }
                          }}
                          className="mt-0.5 w-4 h-4 rounded-sm accent-[var(--fiori-brand)]"
                        />
                        <span>
                          <span className="font-bold text-[var(--fiori-text-primary)] block">{comp.componentPartName}</span>
                          <span className="font-mono text-[11px] text-[var(--fiori-text-secondary)] fiori-ltr-code">{comp.componentPartCode}</span>
                        </span>
                      </label>
                      <FioriObjectStatus
                        tone="info"
                        label={
                          <span className="font-mono tabular-nums">
                            تیراژ محاسبه‌شده: {toPersianDigits(reqQty)} {comp.unit === 'PCS' ? 'عدد' : comp.unit}
                          </span>
                        }
                      />
                    </div>

                    {isReady && compRouting ? (
                      <FioriMessageStrip
                        compact
                        tone="success"
                        actions={
                          <button
                            type="button"
                            onClick={() => {
                              setSubMoPreflightOpen(false);
                              navigate({
                                tab: 'master_data',
                                masterSubSection: 'ROUTINGS',
                                docQuery: comp.componentPartCode,
                              });
                            }}
                            className="text-[var(--fiori-brand)] hover:underline font-bold cursor-pointer shrink-0"
                          >
                            ویرایش ایستگاه‌ها
                          </button>
                        }
                      >
                        مسیر تولید مصوب ({compRouting.version}): {toPersianDigits(compRouting.operations.length)} ایستگاه —{' '}
                        {compRouting.operations.map(op => `${op.stepCode} (${op.stepName})`).join(' ← ')}
                      </FioriMessageStrip>
                    ) : (
                      <FioriMessageStrip
                        compact
                        tone="error"
                        actions={
                          <button
                            type="button"
                            onClick={() => {
                              setSubMoPreflightOpen(false);
                              navigate({
                                tab: 'master_data',
                                masterSubSection: matchedPart ? 'ROUTINGS' : 'PARTS',
                                docQuery: comp.componentPartCode,
                              });
                            }}
                            className="sap-btn-standard px-2 py-0.5 text-[11px] text-[var(--fiori-negative)] border-[var(--fiori-negative-border)] cursor-pointer shrink-0"
                          >
                            {matchedPart ? 'تعریف مسیر تولید در Routings' : 'تعریف در کاتالوگ قطعات'}
                          </button>
                        }
                      >
                        {!matchedPart
                          ? 'قطعه در کاتالوگ قطعات یافت نشد؛ امکان صدور دستور بدون تعریف قطعه وجود ندارد.'
                          : 'این زیرقطعه فاقد مسیر تولید تعریف‌شده (Routing) است؛ عملیات کارگاهی بدون مسیر واقعی تولید نخواهد شد.'}
                      </FioriMessageStrip>
                    )}
                  </div>
                );
              })}
            </div>
          </FioriDialog>
        );
      })()}

      {/* Generated Sub-MOs Modal */}
      <FioriDialog
        isOpen={subMoModalOpen}
        onClose={() => setSubMoModalOpen(false)}
        title="دستورات ساخت فرعی با موفقیت در سیستم تولید صادر گردیدند"
        icon={<CheckCircle2 className="w-4 h-4" />}
        tone="brand"
        size="lg"
        footer={
          <>
            <button
              type="button"
              onClick={() => {
                setSubMoModalOpen(false);
                navigate({ tab: 'wip', wipSubTab: 'UNIFIED_DIRECTORY' });
              }}
              className="sap-btn-standard px-4 py-1.5 text-xs text-[var(--fiori-brand)] border-[var(--fiori-brand-border)] cursor-pointer"
            >
              مشاهده و پیگیری در میز کار WIP
            </button>
            <button
              type="button"
              onClick={() => setSubMoModalOpen(false)}
              className="sap-btn-emphasized px-5 py-1.5 text-xs cursor-pointer"
            >
              تایید و بستن
            </button>
          </>
        }
      >
        <p className="text-xs text-[var(--fiori-text-secondary)] leading-relaxed">
          بر اساس تیراژ مصوب <strong className="tabular-nums">{toPersianDigits(plannedQty)} عدد</strong> از مجموعه {activeBom?.assemblyPartName}، دستورهای ساخت واقعی زیر در ماژول کارگاهی (WIP) ثبت و قابل پیگیری/ابطال هستند:
        </p>

        <div className="space-y-2 max-h-60 overflow-y-auto divide-y divide-[var(--fiori-border-subtle)]">
          {generatedSubMos.map((sub, i) => (
            <div key={i} className="flex items-center justify-between py-2 text-xs gap-2">
              <div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button
                    type="button"
                    onClick={() => {
                      setSubMoModalOpen(false);
                      traceDocument(sub.subMoNumber, 'WIP_TRACEABILITY');
                    }}
                    className="sap-doc-link font-bold font-mono fiori-ltr-code"
                  >
                    {sub.subMoNumber}
                  </button>
                  <span className="text-[var(--fiori-text-primary)] font-medium">{sub.componentPartName}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setSubMoModalOpen(false);
                      traceDocument(sub.componentPartCode, 'INVENTORY_LEDGER');
                    }}
                    className="sap-doc-link text-[11px] font-mono fiori-ltr-code"
                  >
                    ({sub.componentPartCode})
                  </button>
                </div>
                {Array.isArray(sub.operations) && sub.operations.length > 0 && (
                  <div className="text-[10px] text-[var(--fiori-text-secondary)] mt-1">
                    مراحل ایستگاه: {sub.operations.map((o: any) => `${o.stepCode} (${o.stepName})`).join(' ← ')}
                  </div>
                )}
              </div>
              <div className="font-mono font-bold text-[var(--fiori-text-primary)] tabular-nums shrink-0">
                {toPersianDigits(sub.requiredQty)} {sub.unit === 'PCS' ? 'عدد' : 'kg'}
              </div>
            </div>
          ))}
        </div>
      </FioriDialog>

      {/* Guide Modal */}
      <MasterDataDifferenceGuideModal
        isOpen={isGuideOpen}
        onClose={() => setIsGuideOpen(false)}
      />
    </div>
  );
};
