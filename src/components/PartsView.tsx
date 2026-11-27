import React, { useState, useMemo, useEffect } from 'react';
import {
  Layers,
  Search,
  Plus,
  Download,
  Filter,
  Car,
  Scale,
  FileCode,
  ShieldAlert,
  X,
  Check,
  Pin,
  Copy,
  Edit3,
  Upload,
  Trash2,
} from 'lucide-react';
import { Part, PartCategory, UnitOfMeasure, CarModel } from '../types/inventory';
import { formatNumber, formatWeightKg, exportToCsv, toPersianDigits } from '../utils/formatters';
import { SearchableSelect } from './common/SearchableSelect';
import { loadVipPartsMap, saveVipPartsMap, isPartVip } from '../utils/qcHoldStore';
import { useEnterpriseUx } from '../context/EnterpriseUxContext';
import { useErpRouter } from '../context/RouterContext';
import { DataImportExportView } from './inventory/DataImportExportView';
import { loadMaterialGrades, MaterialGradeItem } from '../utils/materialGradesStorage';
import { FioriDialog, FioriMessageStrip, FioriObjectStatus, FioriToolbar } from './fiori/ui';
import { EmptyState } from './common/EmptyState';

interface PartsViewProps {
  parts: Part[];
  onSavePart: (part: Partial<Part>) => Promise<{ success: boolean; message?: string; error?: string }>;
  onRefreshParts?: () => void | Promise<void>;
}

export const PartsView: React.FC<PartsViewProps> = ({ parts, onSavePart, onRefreshParts }) => {
  const { showUndoToast, recordAudit, requestConfirm } = useEnterpriseUx();
  const { traceDocument, route, clearDocQuery } = useErpRouter();
  const [vipMap, setVipMap] = useState<Record<string, boolean>>(() => loadVipPartsMap());
  const [searchTerm, setSearchTerm] = useState(route.docQuery || '');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [carModelFilter, setCarModelFilter] = useState<string>('ALL');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isExcelImportOpen, setIsExcelImportOpen] = useState(false);
  const [editingPart, setEditingPart] = useState<Partial<Part> | null>(null);
  const [materialGradesList, setMaterialGradesList] = useState<MaterialGradeItem[]>(() =>
    loadMaterialGrades()
  );

  useEffect(() => {
    const syncGrades = () => setMaterialGradesList(loadMaterialGrades());
    window.addEventListener('kpims-material-grades-updated', syncGrades);
    return () => window.removeEventListener('kpims-material-grades-updated', syncGrades);
  }, []);

  // Form states
  const [formData, setFormData] = useState<Partial<Part>>({
    code: '',
    name: '',
    category: 'WIP_PART',
    unit: 'PCS',
    weightPerUnitKg: 1,
    sapcoCode: '',
    carModel: '',
    thicknessMm: 1.2,
    materialGrade: 'ST14',
    minStock: 100,
    maxStock: 2000,
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  const [actionBanner, setActionBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [carModelsList, setCarModelsList] = useState<CarModel[]>([]);

  useEffect(() => {
    fetch('/api/car-models')
      .then(r => r.json())
      .then(d => {
        if (d.success && Array.isArray(d.data)) setCarModelsList(d.data);
      })
      .catch(() => {});
  }, []);

  // Extract unique car models for filter combining API models & parts
  const carModels = useMemo(() => {
    const set = new Set<string>();
    carModelsList.forEach(c => set.add(c.name));
    parts.forEach(p => {
      if (p.carModel) set.add(p.carModel);
    });
    return Array.from(set);
  }, [parts, carModelsList]);

  useEffect(() => {
    const handler = () => setVipMap(loadVipPartsMap());
    window.addEventListener('kpims-vip-parts-changed', handler);
    return () => window.removeEventListener('kpims-vip-parts-changed', handler);
  }, []);

  useEffect(() => {
    if (route.docQuery) {
      setSearchTerm(route.docQuery);
      setCategoryFilter('ALL');
      setCarModelFilter('ALL');
    }
  }, [route.docQuery]);

  const handleToggleVip = async (part: Part) => {
    const currentVip = isPartVip(part, vipMap);
    const nextVip = !currentVip;
    const prevMap = { ...vipMap };
    const updatedMap = {
      ...vipMap,
      [part.id]: nextVip,
      [part.code]: nextVip,
    };
    setVipMap(updatedMap);
    saveVipPartsMap(updatedMap);

    await onSavePart({
      ...part,
      isVIP: nextVip,
      isPinned: nextVip,
    });

    recordAudit({
      actionType: 'UPDATE',
      module: 'اطلاعات پایه کالاها (PartsView - VIP)',
      entityId: part.id,
      entityCode: part.code,
      summaryFa: nextVip
        ? `نشانه‌گذاری قطعه «${part.name}» به عنوان قطعه کلیدی استراتژیک (📌 VIP)`
        : `حذف نشان VIP از قطعه «${part.name}»`,
      beforeSnapshot: { isVIP: currentVip },
      afterSnapshot: { isVIP: nextVip },
    });

    showUndoToast({
      title: nextVip
        ? `📌 قطعه «${part.name}» به لیست قطعات کلیدی (VIP) اضافه شد`
        : `قطعه «${part.name}» از لیست قطعات VIP خارج شد`,
      description: nextVip
        ? 'این قطعه در صدر گزارش‌های کسری انبار، MRP و پیشخوان تولید هایلایت خواهد شد.'
        : 'اولویت نمایش قطعه به حالت عادی بازگشت.',
      onUndo: () => {
        setVipMap(prevMap);
        saveVipPartsMap(prevMap);
        onSavePart({
          ...part,
          isVIP: currentVip,
          isPinned: currentVip,
        });
      },
    });
  };

  const vipPartsCount = useMemo(
    () => parts.filter(p => isPartVip(p, vipMap)).length,
    [parts, vipMap]
  );

  const filteredParts = useMemo(() => {
    const uniqueMap = new Map<string, Part & { isVIP: boolean; isPinned: boolean }>();
    parts.forEach(p => {
      const key = (p.code || p.id || '').trim().toUpperCase();
      const vip = isPartVip(p, vipMap);
      if (key && !uniqueMap.has(key)) {
        uniqueMap.set(key, { ...p, isVIP: vip, isPinned: vip });
      }
    });

    return Array.from(uniqueMap.values())
      .filter(p => {
        if (categoryFilter === 'PINNED' && !p.isVIP) return false;
        if (categoryFilter !== 'ALL' && categoryFilter !== 'PINNED' && p.category !== categoryFilter) return false;
        if (carModelFilter !== 'ALL' && p.carModel !== carModelFilter) return false;
        if (searchTerm) {
          const q = searchTerm.toLowerCase();
          const matchesName = p.name.toLowerCase().includes(q);
          const matchesCode = p.code.toLowerCase().includes(q);
          const matchesSapco = p.sapcoCode?.toLowerCase().includes(q) || false;
          if (!matchesName && !matchesCode && !matchesSapco) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (Boolean(a.isVIP) !== Boolean(b.isVIP)) return a.isVIP ? -1 : 1;
        return 0;
      });
  }, [parts, searchTerm, categoryFilter, carModelFilter, vipMap]);

  const buildSuggestedPartCode = (rawQuery: string) => {
    const cleanAscii = rawQuery
      .replace(/[^A-Za-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .toUpperCase();
    if (cleanAscii && cleanAscii.length >= 2) {
      return cleanAscii.startsWith('PART') || cleanAscii.startsWith('SAPCO')
        ? cleanAscii
        : `PART-${cleanAscii}`;
    }
    return `PART-${Date.now().toString().slice(-4)}`;
  };

  const handleOpenNewModal = (prefillQuery?: string) => {
    setEditingPart(null);
    const trimmed = (prefillQuery || '').trim();
    setFormData({
      code: trimmed ? buildSuggestedPartCode(trimmed) : '',
      name: trimmed || '',
      category: trimmed ? 'FINISHED_GOOD' : 'WIP_PART',
      unit: 'PCS',
      weightPerUnitKg: 1,
      sapcoCode: '',
      carModel: '',
      thicknessMm: 1.2,
      materialGrade: 'ST14',
      minStock: 100,
      maxStock: 2000,
    });
    setFormError(null);
    setIsModalOpen(true);
  };

  const handleEditPart = (p: Part) => {
    setEditingPart(p);
    setFormData({ ...p });
    setFormError(null);
    setIsModalOpen(true);
  };

  const handleDuplicatePart = (p: Part) => {
    setEditingPart(null);
    const clonedCode = `${p.code}-COPY`;
    const clonedName = `${p.name} (کپی)`;
    setFormData({
      ...p,
      id: undefined,
      code: clonedCode,
      name: clonedName,
      sapcoCode: p.sapcoCode ? `${p.sapcoCode}-C` : '',
    });
    setFormError(null);
    setIsModalOpen(true);

    recordAudit({
      actionType: 'CREATE',
      module: 'اطلاعات پایه کالاها (Duplicate)',
      entityId: p.id,
      entityCode: clonedCode,
      summaryFa: `آماده‌سازی کپی‌گیری (Duplicate) از رکورد «${p.name}» با کد پیشنهادی ${clonedCode}`,
    });
  };

  const handleDeletePart = async (p: Part) => {
    setActionBanner(null);
    let deps: {
      bomsCount?: number;
      routingsCount?: number;
      structuresCount?: number;
      manufacturingOrdersCount?: number;
      manufacturingOrderNumbers?: string[];
      totalStockOnHand?: number;
    } = {};

    try {
      const depRes = await fetch(`/api/parts/${encodeURIComponent(p.id)}/dependencies`);
      const depJson = await depRes.json().catch(() => ({}));
      if (depRes.ok && depJson.success && depJson.data) {
        deps = depJson.data;
      }
    } catch {
      // Fall back cleanly if dependency pre-check fails
    }

    const moNums = deps.manufacturingOrderNumbers || [];
    const consequences: string[] = [
      `پاکسازی خودکار ارجاعات قطعه از ${toPersianDigits(deps.bomsCount || 0)} درخت محصول (BOM)، ${toPersianDigits(deps.routingsCount || 0)} مسیر تولید و ${toPersianDigits(deps.structuresCount || 0)} ساختار محصول.`,
      moNums.length > 0
        ? `ابطال و حذف آبشاری ${toPersianDigits(moNums.length)} دستور تولید وابسته (${moNums.slice(0, 4).join('، ')}) و بازگرداندن کامل مواد اولیه مصرف‌شده به موجودی انبار.`
        : 'هیچ دستور تولید بازی برای این قطعه یافت نشد.',
      `موجودی ثبتی فعلی قطعه در انبارها: ${formatNumber(deps.totalStockOnHand || 0)} ${p.unit}.`,
    ];

    requestConfirm({
      title: `حذف کامل قطعه «${p.name}» (${p.code}) و وابستگی‌ها`,
      message:
        moNums.length > 0
          ? 'این قطعه دارای دستور تولید ثبت‌شده است. با تأیید این عملیات، ابتدا دستورات تولید وابسته ابطال و موجودی مصرفی به انبار بازمی‌گردد و سپس قطعه به همراه BOM و مسیر تولید حذف می‌شود.'
          : 'آیا از حذف این قطعه و پاکسازی کلیه وابستگی‌های BOM، ساختار محصول و مسیر تولید آن اطمینان دارید؟',
      consequences,
      confirmLabel: moNums.length > 0 ? 'تأیید ابطال MOها، بازگشت موجودی و حذف قطعه' : 'تأیید حذف کامل قطعه',
      cancelLabel: 'انصراف',
      variant: 'danger',
      onConfirm: async () => {
        setActionBanner(null);
        try {
          for (const moNum of moNums) {
            const moDelRes = await fetch(
              `/api/wip/manufacturing-orders/${encodeURIComponent(moNum)}`,
              {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  reason: `حذف آبشاری و بازگشت موجودی به دلیل حذف قطعه ${p.code}`,
                  cascadeSubMos: true,
                }),
              },
            );
            const moDelJson = await moDelRes.json().catch(() => ({}));
            if (!moDelRes.ok && moDelRes.status !== 404) {
              throw new Error(
                moDelJson.error ||
                  `امکان ابطال دستور تولید وابسته ${moNum} و بازگشت موجودی آن وجود ندارد.`,
              );
            }
          }

          const res = await fetch(`/api/parts/${encodeURIComponent(p.id)}?cascade=true`, {
            method: 'DELETE',
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.error || 'خطا در حذف قطعه');
          }
          setActionBanner({
            type: 'success',
            text:
              data.message ||
              `قطعه «${p.name}» (${p.code}) و کلیه وابستگی‌های مرتبط با موفقیت حذف و موجودی‌ها موازنه شد.`,
          });
          showUndoToast({
            title: `قطعه «${p.name}» و وابستگی‌ها حذف شد`,
            description:
              moNums.length > 0
                ? 'دستورات تولید وابسته ابطال و موجودی مواد مصرفی به انبار بازگشت.'
                : 'رکورد به همراه ارجاعات BOM/Routing با موفقیت پاک گردید.',
            onUndo: () => {},
          });
          window.dispatchEvent(new CustomEvent('kpims-master-data-updated'));
          if (onRefreshParts) {
            await onRefreshParts();
          }
        } catch (err) {
          setActionBanner({
            type: 'error',
            text: err instanceof Error ? err.message : 'خطا در حذف قطعه',
          });
        }
      },
    });
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!formData.code || !formData.name) {
      setFormError('کد قطعه و عنوان قطعه الزامی هستند.');
      return;
    }

    setFormLoading(true);
    try {
      const res = await onSavePart(formData);
      if (res.success) {
        setIsModalOpen(false);
        setActionBanner({
          type: 'success',
          text: res.message || `مشخصات قطعه «${formData.name}» (${formData.code}) با موفقیت ذخیره و در کل سامانه همگام‌سازی شد.`,
        });
      } else {
        setFormError(res.error || 'خطا در ثبت مشخصات قطعه');
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'خطای سرور');
    } finally {
      setFormLoading(false);
    }
  };

  const handleExportCsv = () => {
    const headers = [
      'کد قطعه',
      'عنوان فارسی قطعه',
      'دسته‌بندی',
      'واحد اندازه‌گیری',
      'وزن واحد (کیلوگرم)',
      'کد ساپکو / ایران‌خودرو',
      'مدل خودرو',
      'ضخامت ورق (mm)',
      'گرید فولاد',
      'حداقل موجودی اطمینان',
      'حداکثر ظرفیت',
    ];

    const categoryFa: Record<PartCategory, string> = {
      RAW_MATERIAL: 'ماده اولیه (کویل/ورق)',
      WIP_PART: 'قطعه نیمه‌ساخته (WIP)',
      FINISHED_GOOD: 'محصول نهایی آماده تحویل',
    };

    const rows = filteredParts.map(p => [
      p.code,
      p.name,
      categoryFa[p.category],
      p.unit,
      p.weightPerUnitKg,
      p.sapcoCode || '',
      p.carModel || '',
      p.thicknessMm || '',
      p.materialGrade || '',
      p.minStock || 0,
      p.maxStock || 0,
    ]);

    exportToCsv(`کاتالوگ_قطعات_خودرو_${Date.now()}`, headers, rows);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="sap-card p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-base font-bold text-[var(--fiori-text-primary)] flex items-center gap-2">
              <Layers className="w-5 h-5 text-[var(--fiori-brand)]" />
              <span>کاتالوگ جامع قطعات و مواد اولیه</span>
            </h2>
            <FioriObjectStatus
              tone="brand"
              label={`${toPersianDigits(parts.length)} قطعه فعال`}
              size="sm"
            />
          </div>
          <p className="text-xs text-[var(--fiori-text-secondary)] mt-1">
            اطلاعات پایه قطعات بدنه و سازه خودرو (پژو ۲۰۶، تارا، دنا پلاس، شاهین، کوییک)، مشخصات فنی ساپکو و وزن مرجع
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => setIsExcelImportOpen(true)}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs border-[var(--fiori-positive-border)] text-[var(--fiori-positive)] hover:bg-[var(--fiori-positive-bg)] cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5 text-[var(--fiori-positive)]" />
            <span>ورود قطعات از اکسل (.xlsx / .csv)</span>
          </button>
          <button
            type="button"
            onClick={handleExportCsv}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <Download className="w-3.5 h-3.5 text-[var(--fiori-positive)]" />
            <span>خروجی اکسل (CSV)</span>
          </button>
          <button
            type="button"
            onClick={() => handleOpenNewModal()}
            className="sap-btn-emphasized flex items-center gap-1.5 px-3.5 py-1.5 text-xs cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>تعریف قطعه جدید</span>
          </button>
        </div>
      </div>

      {actionBanner && (
        <FioriMessageStrip
          tone={actionBanner.type === 'success' ? 'success' : 'error'}
          onClose={() => setActionBanner(null)}
        >
          {actionBanner.text}
        </FioriMessageStrip>
      )}

      {/* Filter and Search Bar */}
      <div className="sap-card p-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5 flex-1">
          {/* Search */}
          <div className="relative min-w-[240px] flex-1">
            <Search className="w-4 h-4 text-[var(--fiori-text-secondary)] absolute right-3 top-2 pointer-events-none" />
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="جستجوی نام قطعه، کد کاتالوگ یا کد ساپکو..."
              className="w-full bg-[var(--fiori-surface)] border border-[var(--fiori-border)] rounded-[var(--fiori-radius-sm)] pr-9 pl-3 py-1.5 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)]"
            />
          </div>

          {/* Category Filter */}
          <select
            value={categoryFilter}
            onChange={e => setCategoryFilter(e.target.value)}
            className="bg-[var(--fiori-surface)] border border-[var(--fiori-border)] rounded-[var(--fiori-radius-sm)] px-3 py-1.5 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)] font-semibold cursor-pointer"
          >
            <option value="ALL">همه دسته‌بندی‌ها</option>
            <option value="PINNED">قطعات کلیدی نشانه‌گذاری‌شده (VIP)</option>
            <option value="RAW_MATERIAL">مواد اولیه (ورق و کویل ساپکو)</option>
            <option value="WIP_PART">قطعات نیمه‌ساخته (WIP)</option>
            <option value="FINISHED_GOOD">محصولات نهایی آماده تحویل</option>
          </select>

          {/* Car Model Filter */}
          <select
            value={carModelFilter}
            onChange={e => setCarModelFilter(e.target.value)}
            className="bg-[var(--fiori-surface)] border border-[var(--fiori-border)] rounded-[var(--fiori-radius-sm)] px-3 py-1.5 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)] font-semibold cursor-pointer"
          >
            <option value="ALL">همه خودروها</option>
            {carModels.map(m => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setCategoryFilter(categoryFilter === 'PINNED' ? 'ALL' : 'PINNED')}
            className={`px-3 py-1.5 rounded-[var(--fiori-radius-sm)] text-xs font-semibold flex items-center gap-1.5 border transition-all cursor-pointer tabular-nums ${
              categoryFilter === 'PINNED'
                ? 'bg-[var(--fiori-warning)] text-white border-[var(--fiori-warning)]'
                : 'bg-[var(--fiori-warning-bg)] hover:opacity-90 text-[var(--fiori-warning)] border-[var(--fiori-warning-border)]'
            }`}
          >
            <Pin className="w-3.5 h-3.5 fill-current" />
            <span>فقط قطعات کلیدی (VIP): {toPersianDigits(vipPartsCount)}</span>
          </button>
        </div>

        <div className="flex items-center gap-2 text-xs text-[var(--fiori-text-secondary)]">
          {route.docQuery && (
            <button
              type="button"
              onClick={() => {
                clearDocQuery();
                setSearchTerm('');
              }}
              className="px-2 py-1 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-info-bg)] text-[var(--fiori-brand)] border border-[var(--fiori-info-border)] flex items-center gap-1 cursor-pointer"
            >
              <span>فیلتر لینک: {route.docQuery}</span>
              <X className="w-3 h-3" />
            </button>
          )}
          <span className="tabular-nums">
            تعداد نمایش: <span className="font-bold text-[var(--fiori-text-primary)]">{formatNumber(filteredParts.length)}</span> قطعه
          </span>
        </div>
      </div>

      {/* Missing Part Prompt + Quick Create CTA */}
      {searchTerm.trim() && filteredParts.length === 0 && (
        <FioriMessageStrip
          tone="warning"
          title={`قطعه «${searchTerm.trim()}» در کاتالوگ نرم‌افزار وجود ندارد`}
          actions={
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => handleOpenNewModal(searchTerm.trim())}
                className="sap-btn-emphasized flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>تعریف فوری قطعه «{searchTerm.trim()}»</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  clearDocQuery();
                  setSearchTerm('');
                }}
                className="sap-btn-standard px-3 py-1.5 text-xs cursor-pointer"
              >
                نمایش همه قطعات
              </button>
            </div>
          }
        >
          برای ادامه فرآیند برنامه‌ریزی تولید، مسیر عملیات (Routing) و BOM، ابتدا این قطعه را با یک کلیک در کاتالوگ تعریف کنید.
        </FioriMessageStrip>
      )}

      {/* Table */}
      <div className="sap-card overflow-hidden">
        <FioriToolbar
          variant="table"
          title="فهرست قطعات و اقلام پایه"
          count={filteredParts.length}
          countLabel="قطعه"
          endContent={
            (searchTerm || categoryFilter !== 'ALL' || carModelFilter !== 'ALL') ? (
              <button
                type="button"
                onClick={() => {
                  clearDocQuery();
                  setSearchTerm('');
                  setCategoryFilter('ALL');
                  setCarModelFilter('ALL');
                }}
                className="sap-btn-standard px-2.5 py-1 text-[11px] cursor-pointer"
              >
                پاک کردن فیلترها
              </button>
            ) : undefined
          }
        />

        {filteredParts.length === 0 ? (
          <EmptyState
            variant={searchTerm || categoryFilter !== 'ALL' || carModelFilter !== 'ALL' ? 'FILTER_NO_MATCH' : 'NO_DATA'}
            title="قطعه یا ماده اولیه‌ای یافت نشد"
            description="هیچ رکوردی با فیلتر یا عبارت جستجوی فعلی مطابقت ندارد."
            actionLabel="پاک کردن فیلترها"
            onAction={() => {
              clearDocQuery();
              setSearchTerm('');
              setCategoryFilter('ALL');
              setCarModelFilter('ALL');
            }}
            compact
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs sap-table-compact">
              <thead>
                <tr className="bg-[var(--fiori-surface-muted)] border-b border-[var(--fiori-border)] text-[var(--fiori-text-primary)] font-semibold">
                  <th className="w-24 text-center">قطعه کلیدی (VIP)</th>
                  <th>کد کاتالوگ</th>
                  <th>عنوان قطعه / ماده اولیه</th>
                  <th>دسته‌بندی</th>
                  <th>مدل خودرو</th>
                  <th>کد ساپکو</th>
                  <th>وزن واحد (kg)</th>
                  <th>ضخامت (mm)</th>
                  <th>گرید فولاد</th>
                  <th>واحد پایه</th>
                  <th className="text-center">عملیات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--fiori-border-subtle)]">
                {filteredParts.map(p => {
                  const isRaw = p.category === 'RAW_MATERIAL';
                  const isFinished = p.category === 'FINISHED_GOOD';
                  const isVip = Boolean(p.isVIP || p.isPinned);
                  return (
                    <tr
                      key={p.id}
                      className={`transition-colors ${
                        isVip
                          ? 'bg-[var(--fiori-warning-bg)]/50 hover:bg-[var(--fiori-warning-bg)]'
                          : 'hover:bg-[var(--fiori-row-hover)]'
                      }`}
                    >
                      <td className="text-center">
                        <button
                          type="button"
                          onClick={() => handleToggleVip(p)}
                          className={`px-2 py-0.5 rounded-[var(--fiori-radius-sm)] border text-[11px] font-semibold inline-flex items-center gap-1 transition-all cursor-pointer ${
                            isVip
                              ? 'bg-[var(--fiori-warning)] text-white border-[var(--fiori-warning)]'
                              : 'bg-[var(--fiori-surface-muted)] text-[var(--fiori-text-secondary)] border-[var(--fiori-border)] hover:bg-[var(--fiori-warning-bg)] hover:text-[var(--fiori-warning)] hover:border-[var(--fiori-warning-border)]'
                          }`}
                          title={isVip ? 'حذف نشان قطعه کلیدی (VIP)' : 'افزودن به قطعات کلیدی استراتژیک (VIP)'}
                        >
                          <Pin className={`w-3 h-3 ${isVip ? 'fill-white' : ''}`} />
                          <span>{isVip ? 'VIP فعال' : 'نشان VIP'}</span>
                        </button>
                      </td>
                      <td className="font-mono font-bold">
                        <button
                          type="button"
                          onClick={() => traceDocument(p.code, 'INVENTORY_LEDGER')}
                          className="sap-doc-link fiori-ltr-code cursor-pointer"
                          title="رهگیری کاردکس و سوابق موجودی این قطعه"
                        >
                          {p.code}
                        </button>
                      </td>
                      <td className="text-[var(--fiori-text-primary)] font-medium max-w-xs">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className={isVip ? 'font-bold text-[var(--fiori-text-primary)]' : ''}>{p.name}</span>
                          {isVip && <FioriObjectStatus tone="critical" label="VIP" size="sm" />}
                        </div>
                      </td>
                      <td>
                        <FioriObjectStatus
                          tone={isRaw ? 'critical' : isFinished ? 'positive' : 'brand'}
                          label={isRaw ? 'ماده اولیه' : isFinished ? 'محصول نهایی' : 'نیمه‌ساخته WIP'}
                          size="sm"
                        />
                      </td>
                      <td className="text-[var(--fiori-text-primary)]">
                        <div className="flex items-center gap-1">
                          <Car className="w-3 h-3 text-[var(--fiori-text-secondary)] shrink-0" />
                          <span>{p.carModel || 'مشترک'}</span>
                        </div>
                      </td>
                      <td className="font-mono text-[var(--fiori-text-secondary)] text-[11px] fiori-ltr-code">
                        {p.sapcoCode || '-'}
                      </td>
                      <td className="font-bold text-[var(--fiori-text-primary)] font-mono tabular-nums">
                        {toPersianDigits(p.weightPerUnitKg)}
                      </td>
                      <td className="font-mono text-[var(--fiori-text-primary)] tabular-nums">
                        {p.thicknessMm ? `${toPersianDigits(p.thicknessMm)} mm` : '-'}
                      </td>
                      <td className="font-mono text-[var(--fiori-brand)] font-semibold fiori-ltr-code">
                        {p.materialGrade || '-'}
                      </td>
                      <td className="text-[var(--fiori-text-secondary)]">{p.unit}</td>
                      <td>
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleEditPart(p)}
                            className="sap-btn-standard px-2 py-0.5 text-[11px] inline-flex items-center gap-1 cursor-pointer"
                            title="ویرایش مشخصات قطعه / کلاف"
                          >
                            <Edit3 className="w-3 h-3" />
                            <span>ویرایش</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDuplicatePart(p)}
                            className="sap-btn-standard px-2 py-0.5 text-[11px] inline-flex items-center gap-1 cursor-pointer"
                            title="کپی‌گیری سریع (Duplicate) برای ایجاد رکورد مشابه"
                          >
                            <Copy className="w-3 h-3" />
                            <span>کپی‌گیری</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeletePart(p)}
                            className="px-2 py-0.5 rounded-[var(--fiori-radius-sm)] text-[11px] font-medium text-[var(--fiori-negative)] bg-[var(--fiori-negative-bg)] hover:opacity-85 border border-[var(--fiori-negative-border)] inline-flex items-center gap-1 transition-colors cursor-pointer"
                            title="حذف قطعه از کاتالوگ مرکزی"
                          >
                            <Trash2 className="w-3 h-3 text-[var(--fiori-negative)]" />
                            <span>حذف</span>
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

      {/* Modal for Create/Edit Part */}
      <FioriDialog
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingPart ? 'ویرایش مشخصات قطعه' : 'تعریف قطعه / ماده اولیه جدید'}
        icon={<Layers className="w-4 h-4 text-[var(--fiori-brand)]" />}
        size="lg"
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsModalOpen(false)}
              className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="part-edit-form"
              disabled={formLoading}
              className="sap-btn-emphasized px-5 py-1.5 text-xs cursor-pointer disabled:opacity-50"
            >
              {formLoading ? 'در حال ذخیره...' : 'ذخیره در کاتالوگ'}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          {formError && (
            <FioriMessageStrip tone="error" compact>
              {formError}
            </FioriMessageStrip>
          )}

          <form id="part-edit-form" onSubmit={handleFormSubmit} className="space-y-4 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-[var(--fiori-text-primary)] font-medium block">کد کاتالوگ قطعه *</label>
                <input
                  type="text"
                  value={formData.code || ''}
                  onChange={e => setFormData({ ...formData, code: e.target.value })}
                  placeholder="مثال: IKCO-206-BRK05"
                  className="w-full bg-[var(--fiori-surface)] border border-[var(--fiori-border)] rounded-[var(--fiori-radius-sm)] px-3 py-1.5 text-[var(--fiori-text-primary)] font-mono fiori-ltr-code focus:outline-none focus:border-[var(--fiori-brand)]"
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="text-[var(--fiori-text-primary)] font-medium block">دسته‌بندی *</label>
                <select
                  value={formData.category}
                  onChange={e => setFormData({ ...formData, category: e.target.value as any })}
                  className="w-full bg-[var(--fiori-surface)] border border-[var(--fiori-border)] rounded-[var(--fiori-radius-sm)] px-3 py-1.5 text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)]"
                >
                  <option value="RAW_MATERIAL">ماده اولیه (کویل/ورق ساپکو)</option>
                  <option value="WIP_PART">قطعه نیمه‌ساخته (WIP)</option>
                  <option value="FINISHED_GOOD">محصول نهایی آماده تحویل</option>
                </select>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[var(--fiori-text-primary)] font-medium block">عنوان کامل قطعه در خط تولید *</label>
              <input
                type="text"
                value={formData.name || ''}
                onChange={e => setFormData({ ...formData, name: e.target.value })}
                placeholder="مثال: براکت تقویتی ستون وسط تارا با پوشش کاتافورز"
                className="w-full bg-[var(--fiori-surface)] border border-[var(--fiori-border)] rounded-[var(--fiori-radius-sm)] px-3 py-1.5 text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)]"
                required
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1">
                <label className="text-[var(--fiori-text-primary)] font-medium block">واحد اندازه‌گیری *</label>
                <select
                  value={formData.unit}
                  onChange={e => setFormData({ ...formData, unit: e.target.value as any })}
                  className="w-full bg-[var(--fiori-surface)] border border-[var(--fiori-border)] rounded-[var(--fiori-radius-sm)] px-3 py-1.5 text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)]"
                >
                  <option value="PCS">عدد (PCS)</option>
                  <option value="KG">کیلوگرم (KG)</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[var(--fiori-text-primary)] font-medium block">وزن واحد (کیلوگرم) *</label>
                <input
                  type="number"
                  step="0.001"
                  min="0.001"
                  value={formData.weightPerUnitKg || 1}
                  onChange={e => setFormData({ ...formData, weightPerUnitKg: parseFloat(e.target.value) || 1 })}
                  className="w-full bg-[var(--fiori-surface)] border border-[var(--fiori-border)] rounded-[var(--fiori-radius-sm)] px-3 py-1.5 text-[var(--fiori-text-primary)] font-mono tabular-nums focus:outline-none focus:border-[var(--fiori-brand)]"
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="text-[var(--fiori-text-primary)] font-medium block">ضخامت ورق (mm)</label>
                <input
                  type="number"
                  step="0.1"
                  value={formData.thicknessMm || ''}
                  onChange={e => setFormData({ ...formData, thicknessMm: parseFloat(e.target.value) || undefined })}
                  placeholder="مثلاً: 1.5"
                  className="w-full bg-[var(--fiori-surface)] border border-[var(--fiori-border)] rounded-[var(--fiori-radius-sm)] px-3 py-1.5 text-[var(--fiori-text-primary)] font-mono tabular-nums focus:outline-none focus:border-[var(--fiori-brand)]"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1">
                <label className="text-[var(--fiori-text-primary)] font-medium block">گرید و جنس ورق / فولاد</label>
                <input
                  type="text"
                  list="kpims-material-grades-datalist"
                  value={formData.materialGrade || ''}
                  onChange={e => setFormData({ ...formData, materialGrade: e.target.value })}
                  placeholder="انتخاب از لیست یا تایپ گرید (ST14, DC04...)"
                  className="w-full bg-[var(--fiori-surface)] border border-[var(--fiori-border)] rounded-[var(--fiori-radius-sm)] px-3 py-1.5 text-[var(--fiori-text-primary)] font-mono fiori-ltr-code focus:outline-none focus:border-[var(--fiori-brand)]"
                />
                <datalist id="kpims-material-grades-datalist">
                  {materialGradesList.map(g => (
                    <option key={g.id} value={g.code}>
                      {g.name}
                    </option>
                  ))}
                </datalist>
              </div>

              <div className="space-y-1">
                <label className="text-[var(--fiori-text-primary)] font-medium block">مدل خودرو / خانواده محصول</label>
                <SearchableSelect
                  value={formData.carModel || ''}
                  onChange={val => setFormData({ ...formData, carModel: val })}
                  placeholder="انتخاب مدل خودرو..."
                  searchPlaceholder="جستجوی مدل خودرو (۲۰۶، تارا، دنا...)"
                  options={[
                    { value: 'مشترک', label: 'مشترک بین چند خودرو' },
                    ...carModelsList.map(c => ({
                      value: c.name,
                      label: c.name,
                      sublabel: c.oem,
                      badge: c.code,
                    })),
                  ]}
                />
              </div>

              <div className="space-y-1">
                <label className="text-[var(--fiori-text-primary)] font-medium block">کد ساپکو / OEM</label>
                <input
                  type="text"
                  value={formData.sapcoCode || ''}
                  onChange={e => setFormData({ ...formData, sapcoCode: e.target.value })}
                  placeholder="SAP-88102"
                  className="w-full bg-[var(--fiori-surface)] border border-[var(--fiori-border)] rounded-[var(--fiori-radius-sm)] px-3 py-1.5 text-[var(--fiori-text-primary)] font-mono fiori-ltr-code focus:outline-none focus:border-[var(--fiori-brand)]"
                />
              </div>
            </div>
          </form>
        </div>
      </FioriDialog>

      {/* Modal for Excel Bulk Import of Parts */}
      <FioriDialog
        isOpen={isExcelImportOpen}
        onClose={() => setIsExcelImportOpen(false)}
        title="ورود گروهی قطعات و مواد اولیه از فایل اکسل (.xlsx / .csv) به دیتابیس اصلی"
        icon={<Upload className="w-4 h-4 text-[var(--fiori-positive)]" />}
        size="xl"
      >
        <DataImportExportView
          initialTemplateType="PARTS"
          currentUser={{ uid: 'USR-ADMIN', displayName: 'مدیر مهندسی' }}
          onSuccess={async () => {
            if (onRefreshParts) {
              await onRefreshParts();
            } else {
              window.dispatchEvent(new CustomEvent('kpims-parts-imported'));
            }
          }}
        />
      </FioriDialog>
    </div>
  );
};
