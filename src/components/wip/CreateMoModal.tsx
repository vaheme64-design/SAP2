import React, { useState, useEffect } from 'react';
import { FilePlus, Plus } from 'lucide-react';
import { Part, Routing } from '../../types/inventory';
import { formatNumber } from '../../utils/formatters';
import { QuickEntryModals, QuickCreateEntityType } from '../common/QuickEntryModals';
import { JalaliDatePicker } from '../common/JalaliDatePicker';
import { FioriDialog, FioriMessageStrip } from '../fiori/ui';

interface MaterialSourceOption {
  id: string;
  partId: string;
  partCode: string;
  partName: string;
  partCategory: string;
  unitCode: string;
  unitSymbol: string;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  locationCode: string;
  coilId?: string | null;
  lotNumber?: string | null;
  quantityAvailable: number;
  weightKgAvailable: number;
}

interface CreateMoModalProps {
  isOpen: boolean;
  onClose: () => void;
  parts: Part[];
  routings: Routing[];
  onSubmit: (payload: any) => Promise<{ success: boolean; error?: string }>;
}

export const CreateMoModal: React.FC<CreateMoModalProps> = ({
  isOpen,
  onClose,
  parts: initialParts,
  routings,
  onSubmit,
}) => {
  const [localParts, setLocalParts] = useState<Part[]>(initialParts);
  const [activeQuickModal, setActiveQuickModal] = useState<QuickCreateEntityType | null>(null);

  useEffect(() => {
    setLocalParts(initialParts);
  }, [initialParts]);

  const [selectedPartId, setSelectedPartId] = useState('');
  const [targetQuantity, setTargetQuantity] = useState('500');
  const [initialInputQuantity, setInitialInputQuantity] = useState('0');
  const [sourceStockBalanceId, setSourceStockBalanceId] = useState('');
  const [materialSources, setMaterialSources] = useState<MaterialSourceOption[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState(
    new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  );
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setSourcesLoading(true);
    setSourceStockBalanceId('');
    setInitialInputQuantity('0');
    setErrorMsg(null);
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
        if (!cancelled) setSourcesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const selectedPart = localParts.find(p => p.id === selectedPartId);
  const selectedSource = materialSources.find(s => s.id === sourceStockBalanceId);
  const matchingRouting = selectedPart
    ? routings.find(r => r.partId === selectedPart.id || r.partCode === selectedPart.code)
    : undefined;

  const handleSourceChange = (nextId: string) => {
    setSourceStockBalanceId(nextId);
    if (!nextId) {
      setInitialInputQuantity('0');
      return;
    }
    const src = materialSources.find(s => s.id === nextId);
    const targetNum = Math.max(0, Number(targetQuantity) || 0);
    if (src) {
      if (src.unitCode === 'KG') {
        setInitialInputQuantity(String(targetNum > 0 ? targetNum : 1));
      } else {
        const capped = Math.min(
          targetNum || Math.floor(src.quantityAvailable),
          Math.floor(src.quantityAvailable)
        );
        setInitialInputQuantity(String(Math.max(1, capped)));
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPartId) {
      setErrorMsg('لطفاً قطعه مورد نظر را انتخاب کنید.');
      return;
    }

    const targetQty = Number(targetQuantity);
    const inputQty = Number(initialInputQuantity);

    if (isNaN(targetQty) || targetQty <= 0) {
      setErrorMsg('تعداد هدف باید یک عدد مثبت باشد.');
      return;
    }
    if (isNaN(inputQty) || inputQty < 0) {
      setErrorMsg('مقدار ماده اولیه ورودی اولیه نمی‌تواند منفی باشد.');
      return;
    }
    if (inputQty > 0 && !sourceStockBalanceId) {
      setErrorMsg('برای بارگذاری ورودی اولیه بیشتر از صفر، انتخاب منبع موجودی از انبار الزامی است.');
      return;
    }
    if (
      selectedSource &&
      selectedSource.unitCode !== 'KG' &&
      inputQty > selectedSource.quantityAvailable + 1e-6
    ) {
      setErrorMsg(
        `موجودی آزاد در منبع انتخابی (${formatNumber(selectedSource.quantityAvailable)} ${
          selectedSource.unitSymbol
        }) کمتر از مقدار درخواستی است.`
      );
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await onSubmit({
        partId: selectedPartId,
        targetQuantity: targetQty,
        initialInputQuantity: inputQty,
        sourceStockBalanceId: inputQty > 0 ? sourceStockBalanceId : undefined,
        routingId: matchingRouting?.id,
        startDate,
        dueDate,
        notes: notes.trim(),
      });

      if (res.success) {
        onClose();
      } else {
        setErrorMsg(res.error || 'خطا در ثبت دستور تولید');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'خطا در ارتباط با سرور');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <FioriDialog
        isOpen={isOpen}
        onClose={onClose}
        title="صدور دستور کار ساخت جدید (MO)"
        subtitle="تولید خودکار مراحل عملیاتی از روی مسیر فرآیند مصوب قطعه"
        icon={<FilePlus className="w-4 h-4" />}
        tone="brand"
        size="lg"
        disableClose={isSubmitting}
        footer={
          <>
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="create-mo-form"
              disabled={isSubmitting}
              className="sap-btn-emphasized inline-flex items-center gap-1.5 px-4 py-1.5 text-xs cursor-pointer disabled:opacity-50"
            >
              <FilePlus className={`w-3.5 h-3.5 ${isSubmitting ? 'animate-spin' : ''}`} />
              <span>{isSubmitting ? 'در حال ثبت...' : 'ایجاد دستور ساخت و تولید عملیات'}</span>
            </button>
          </>
        }
      >
        {errorMsg && (
          <FioriMessageStrip tone="error" compact onClose={() => setErrorMsg(null)}>
            {errorMsg}
          </FioriMessageStrip>
        )}

        <form id="create-mo-form" onSubmit={handleSubmit} className="space-y-4 text-xs">
          {/* Group 1: Part & Routing */}
          <div className="space-y-2.5">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className="font-semibold text-[var(--fiori-text-primary)]">
                  انتخاب قطعه خودرویی <span className="text-[var(--fiori-negative)]">*</span>
                </label>
                <button
                  type="button"
                  onClick={() => setActiveQuickModal('PART')}
                  className="text-[11px] font-semibold text-[var(--fiori-positive)] hover:underline inline-flex items-center gap-0.5 cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  <span>تعریف سریع قطعه جدید</span>
                </button>
              </div>
              <select
                value={selectedPartId}
                onChange={e => setSelectedPartId(e.target.value)}
                className="fiori-input w-full p-2"
              >
                <option value="">-- انتخاب قطعه از فهرست قطعات فعال --</option>
                {localParts.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.code} - {p.name} ({p.carModel || 'سازه بدنه'})
                  </option>
                ))}
              </select>
            </div>

            {selectedPart && (
              <div className="p-3 bg-[var(--fiori-bg-subtle)] rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] space-y-1.5">
                <div className="flex items-center justify-between text-[var(--fiori-text-primary)]">
                  <span className="text-[var(--fiori-text-secondary)]">مسیر فرآیند مصوب:</span>
                  <span className="font-semibold text-[var(--fiori-brand)] font-mono">
                    {matchingRouting
                      ? `نسخه ${matchingRouting.version} (${matchingRouting.operations.length} مرحله عملیاتی)`
                      : 'مسیر استاندارد پیش‌فرض'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px] text-[var(--fiori-text-secondary)]">
                  <span>گرید فولاد / ضخامت:</span>
                  <span className="font-mono fiori-ltr-code text-[var(--fiori-text-primary)]">
                    {selectedPart.materialGrade || 'ST14'} / {selectedPart.thicknessMm || 1.2}mm
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Group 2: Material Source & Quantities */}
          <div className="space-y-3 pt-2 border-t border-[var(--fiori-border-subtle)]">
            <div className="space-y-1.5">
              <label className="font-semibold text-[var(--fiori-text-primary)] block">
                منبع موجودی انبار / کلاف برای بارگذاری اولیه (حواله اتمیک انبار)
              </label>
              <select
                value={sourceStockBalanceId}
                onChange={e => handleSourceChange(e.target.value)}
                disabled={sourcesLoading}
                className="fiori-input w-full p-2"
              >
                <option value="">
                  {sourcesLoading
                    ? 'در حال بارگذاری موجودی انبارها...'
                    : 'بدون بارگذاری اولیه — ۰ ورودی (بارگذاری بعدی با حواله انبار)'}
                </option>
                {materialSources.map(src => (
                  <option key={src.id} value={src.id}>
                    {src.partCode} — {src.partName} | {src.warehouseName} ({src.locationCode || '-'})
                    {src.coilId
                      ? ` | کلاف ${src.coilId}`
                      : src.lotNumber
                      ? ` | لات ${src.lotNumber}`
                      : ''}
                    {` | آزاد: ${formatNumber(src.quantityAvailable)} ${src.unitSymbol} (${formatNumber(
                      src.weightKgAvailable
                    )} kg)`}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="font-semibold text-[var(--fiori-text-primary)] block">
                  تعداد هدف محصول نهایی (عدد){' '}
                  <span className="text-[var(--fiori-negative)]">*</span>
                </label>
                <input
                  type="number"
                  min="1"
                  value={targetQuantity}
                  onChange={e => setTargetQuantity(e.target.value)}
                  className="fiori-input w-full p-2 font-mono text-left"
                />
              </div>

              <div className="space-y-1.5">
                <label className="font-semibold text-[var(--fiori-text-primary)] block">
                  ورودی شیت/بلنک مرحله ۱ (عدد)
                </label>
                <input
                  type="number"
                  min="0"
                  disabled={!sourceStockBalanceId}
                  value={initialInputQuantity}
                  onChange={e => setInitialInputQuantity(e.target.value)}
                  className="fiori-input w-full p-2 font-mono text-left"
                />
              </div>
            </div>
          </div>

          {/* Group 3: Schedule (Jalali) & Notes */}
          <div className="space-y-3 pt-2 border-t border-[var(--fiori-border-subtle)]">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="font-semibold text-[var(--fiori-text-primary)] block">
                  تاریخ شروع ساخت (شمسی)
                </label>
                <JalaliDatePicker
                  value={startDate}
                  onChange={(_jalali, gregorian) => {
                    if (gregorian) setStartDate(gregorian);
                  }}
                  placeholder="انتخاب تاریخ شروع..."
                  required
                />
              </div>

              <div className="space-y-1.5">
                <label className="font-semibold text-[var(--fiori-text-primary)] block">
                  موعد تحویل به انبار (شمسی)
                </label>
                <JalaliDatePicker
                  value={dueDate}
                  onChange={(_jalali, gregorian) => {
                    if (gregorian) setDueDate(gregorian);
                  }}
                  placeholder="انتخاب موعد تحویل..."
                  required
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="font-semibold text-[var(--fiori-text-primary)] block">
                توضیحات و الزامات کیفی ساپکو
              </label>
              <input
                type="text"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="مثال: اولویت تحویل خط رنگ، کلاف امانی ساپکو..."
                className="fiori-input w-full p-2"
              />
            </div>
          </div>
        </form>
      </FioriDialog>

      <QuickEntryModals
        activeModal={activeQuickModal}
        onClose={() => setActiveQuickModal(null)}
        defaultPartCategory="FINISHED_GOOD"
        onCreated={(type, item) => {
          if (type === 'PART') {
            setLocalParts(prev => [item, ...prev]);
            setSelectedPartId(item.id);
          }
        }}
      />
    </>
  );
};
