import React, { useState, useEffect } from 'react';
import {
  FilePlus,
  X,
  Layers,
  Calendar,
  AlertCircle,
  CheckCircle2,
  Boxes,
  Plus,
} from 'lucide-react';
import { Part, Routing } from '../../types/inventory';
import { formatNumber, toPersianDigits } from '../../utils/formatters';
import { QuickEntryModals, QuickCreateEntityType } from '../common/QuickEntryModals';

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
        const capped = Math.min(targetNum || Math.floor(src.quantityAvailable), Math.floor(src.quantityAvailable));
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
    if (selectedSource && selectedSource.unitCode !== 'KG' && inputQty > selectedSource.quantityAvailable + 1e-6) {
      setErrorMsg(
        `موجودی آزاد در منبع انتخابی (${formatNumber(selectedSource.quantityAvailable)} ${selectedSource.unitSymbol}) کمتر از مقدار درخواستی است.`
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#333333]/40 backdrop-blur-xs">
      <div className="bg-white border border-[#d9d9d9] rounded-md max-w-xl w-full p-5 space-y-4 shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#d9d9d9] pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-[#e5f3fa] text-[#007cc0] border border-[#b3d7ff] rounded">
              <FilePlus className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-[#333333]">صدور دستور کار ساخت جدید (Manufacturing Order)</h3>
              <p className="text-xs text-[#666666]">تولید خودکار مراحل عملیاتی از روی مسیر فرآیند مصوب قطعه</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-[#666666] hover:text-[#333333] p-1 rounded hover:bg-[#f5f5f5] cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {errorMsg && (
          <div className="p-3 bg-[#fde8e8] border border-[#f5b8b8] rounded text-xs text-[#bb0000] flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-[#333333]">
                انتخاب قطعه خودرویی <span className="text-[#bb0000]">*</span>
              </label>
              <button
                type="button"
                onClick={() => setActiveQuickModal('PART')}
                className="text-[11px] font-semibold text-[#107e3e] hover:underline flex items-center gap-0.5 cursor-pointer"
              >
                <Plus className="w-3 h-3" />
                <span>+ تعریف سریع قطعه جدید</span>
              </button>
            </div>
            <select
              value={selectedPartId}
              onChange={e => setSelectedPartId(e.target.value)}
              className="w-full bg-white border border-[#bfbfbf] rounded p-2 text-xs text-[#333333] focus:outline-none focus:border-[#007cc0]"
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
            <div className="p-3 bg-[#fafafa] rounded border border-[#d9d9d9] text-xs space-y-1.5">
              <div className="flex items-center justify-between text-[#333333]">
                <span>مسیر فرآیند مصوب:</span>
                <span className="font-bold text-[#e9730c] font-mono">
                  {matchingRouting ? `نسخه ${matchingRouting.version} (${matchingRouting.operations.length} مرحله عملیاتی)` : 'مسیر استاندارد پیش‌فرض'}
                </span>
              </div>
              <div className="flex items-center justify-between text-[#666666] text-[11px]">
                <span>گرید فولاد / ضخامت:</span>
                <span className="font-mono text-[#333333]">{selectedPart.materialGrade || 'ST14'} / {selectedPart.thicknessMm || 1.2}mm</span>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-[#333333]">
              منبع موجودی انبار / کلاف برای بارگذاری اولیه (حواله اتمیک انبار)
            </label>
            <select
              value={sourceStockBalanceId}
              onChange={e => handleSourceChange(e.target.value)}
              disabled={sourcesLoading}
              className="w-full bg-white border border-[#bfbfbf] rounded p-2 text-xs text-[#333333] focus:outline-none focus:border-[#007cc0]"
            >
              <option value="">
                {sourcesLoading
                  ? 'در حال بارگذاری موجودی انبارها...'
                  : 'بدون بارگذاری اولیه — ۰ ورودی (بارگذاری بعدی با حواله انبار)'}
              </option>
              {materialSources.map(src => (
                <option key={src.id} value={src.id}>
                  {src.partCode} — {src.partName} | {src.warehouseName} ({src.locationCode || '-'})
                  {src.coilId ? ` | کلاف ${src.coilId}` : src.lotNumber ? ` | لات ${src.lotNumber}` : ''}
                  {` | آزاد: ${formatNumber(src.quantityAvailable)} ${src.unitSymbol} (${formatNumber(src.weightKgAvailable)} kg)`}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[#333333]">
                تعداد هدف محصول نهایی (PCS) <span className="text-[#bb0000]">*</span>
              </label>
              <input
                type="number"
                min="1"
                value={targetQuantity}
                onChange={e => setTargetQuantity(e.target.value)}
                className="w-full bg-white border border-[#bfbfbf] rounded p-2 text-xs text-[#333333] font-mono focus:outline-none focus:border-[#007cc0]"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[#333333]">
                ورودی شیت/بلنک مرحله ۱ (PCS)
              </label>
              <input
                type="number"
                min="0"
                disabled={!sourceStockBalanceId}
                value={initialInputQuantity}
                onChange={e => setInitialInputQuantity(e.target.value)}
                className="w-full bg-white border border-[#bfbfbf] rounded p-2 text-xs text-[#333333] font-mono focus:outline-none focus:border-[#007cc0] disabled:bg-[#f5f5f5] disabled:text-[#767676]"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[#333333]">تاریخ شروع ساخت</label>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                className="w-full bg-white border border-[#bfbfbf] rounded p-2 text-xs text-[#333333] font-mono focus:outline-none focus:border-[#007cc0]"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[#333333]">موعد تحویل به انبار</label>
              <input
                type="date"
                value={dueDate}
                onChange={e => setDueDate(e.target.value)}
                className="w-full bg-white border border-[#bfbfbf] rounded p-2 text-xs text-[#333333] font-mono focus:outline-none focus:border-[#007cc0]"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-[#333333]">توضیحات و الزامات کیفی ساپکو</label>
            <input
              type="text"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="مثال: اولویت تحویل خط رنگ، کلاف امانی ساپکو..."
              className="w-full bg-white border border-[#bfbfbf] rounded p-2 text-xs text-[#333333] focus:outline-none focus:border-[#007cc0]"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-[#d9d9d9]">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="sap-btn-standard px-4 py-1.5 text-xs font-medium cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="sap-btn-emphasized flex items-center gap-1.5 px-4 py-1.5 text-xs font-bold cursor-pointer disabled:opacity-50"
            >
              <FilePlus className={`w-4 h-4 ${isSubmitting ? 'animate-spin' : ''}`} />
              <span>ایجاد دستور ساخت و تولید عملیات</span>
            </button>
          </div>
        </form>
      </div>

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
    </div>
  );
};
