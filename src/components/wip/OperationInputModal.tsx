import React, { useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import { ManufacturingOperation } from '../../types/productionWip';
import { Machine, Operator } from '../../types/inventory';
import { formatNumber } from '../../utils/formatters';
import { FioriDialog, FioriMessageStrip } from '../fiori/ui';

interface OperationInputModalProps {
  isOpen: boolean;
  onClose: () => void;
  operation: ManufacturingOperation | null;
  machines: Machine[];
  operators: Operator[];
  onSubmit: (payload: any) => Promise<{ success: boolean; error?: string }>;
}

export const OperationInputModal: React.FC<OperationInputModalProps> = ({
  isOpen,
  onClose,
  operation,
  machines,
  operators,
  onSubmit,
}) => {
  const [quantity, setQuantity] = useState('');
  const [selectedMachineId, setSelectedMachineId] = useState('');
  const [operatorName, setOperatorName] = useState('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && operation) {
      setQuantity(operation.waitingInputQty > 0 ? String(operation.waitingInputQty) : '');
      setSelectedMachineId(operation.machineId || '');
      setOperatorName('');
      setNotes('');
      setErrorMsg(null);
    }
  }, [isOpen, operation?.id]);

  if (!isOpen || !operation) return null;

  const availableWaiting = operation.waitingInputQty;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const qty = Number(quantity);

    if (isNaN(qty) || qty <= 0) {
      setErrorMsg('تعداد ورودی باید یک عدد مثبت باشد.');
      return;
    }

    if (qty > availableWaiting) {
      setErrorMsg(`تعداد نمی‌تواند از موجودی در انتظار صف (${formatNumber(availableWaiting)} عدد) بیشتر باشد.`);
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await onSubmit({
        moId: operation.moId,
        operationId: operation.id,
        quantity: qty,
        machineId: selectedMachineId || operation.machineId,
        operatorName: operatorName.trim() || 'اپراتور شیفت جاری',
        notes: notes.trim(),
        expectedVersion: operation.version,
      });

      if (res.success) {
        onClose();
      } else {
        setErrorMsg(res.error || 'خطا در بارگذاری ورودی مرحله');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'خطا در ارتباط با سرور');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <FioriDialog
      isOpen={isOpen}
      onClose={onClose}
      title={
        <span>
          شروع فرآیند و ثبت ورودی به دستگاه{' '}
          <span className="fiori-ltr-code font-mono text-[var(--fiori-brand)]">({operation.stepCode})</span>
        </span>
      }
      subtitle={`${operation.stepName} • دستور ${operation.moNumber}`}
      icon={<Play className="w-4 h-4" />}
      tone="brand"
      size="md"
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="sap-btn-standard px-4 py-1.5 text-xs"
          >
            انصراف
          </button>
          <button
            type="submit"
            form="op-input-form"
            disabled={isSubmitting || availableWaiting <= 0}
            className="sap-btn-emphasized flex items-center gap-1.5 px-4 py-1.5 text-xs disabled:opacity-50"
          >
            <Play className={`w-3.5 h-3.5 ${isSubmitting ? 'animate-spin' : ''}`} />
            <span>انتقال به در حال ساخت و شروع کار</span>
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {errorMsg && (
          <FioriMessageStrip tone="error" onClose={() => setErrorMsg(null)}>
            {errorMsg}
          </FioriMessageStrip>
        )}

        {/* Station Context Summary */}
        <div className="p-3 bg-[var(--fiori-bg-subtle)] rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] grid grid-cols-2 gap-3 text-xs tabular-nums">
          <div>
            <span className="text-[var(--fiori-text-secondary)] block text-[11px]">موجودی در انتظار پای کار</span>
            <span className="font-mono font-bold text-[var(--fiori-critical)] text-sm mt-0.5 block">
              {formatNumber(availableWaiting)}{' '}
              <span className="text-[11px] font-normal text-[var(--fiori-text-secondary)]">عدد</span>
            </span>
          </div>
          <div>
            <span className="text-[var(--fiori-text-secondary)] block text-[11px]">موقعیت انبار پای خط</span>
            <span className="fiori-ltr-code font-mono font-bold text-[var(--fiori-brand)] mt-0.5 inline-block">
              {operation.warehouseLocation}
            </span>
          </div>
        </div>

        <form id="op-input-form" onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-semibold text-[var(--fiori-text-primary)]">
                تعداد قابل بارگذاری به دستگاه (عدد) <span className="text-[var(--fiori-negative)]">*</span>
              </label>
              <button
                type="button"
                onClick={() => setQuantity(String(availableWaiting))}
                className="text-[11px] text-[var(--fiori-brand)] hover:underline cursor-pointer font-semibold tabular-nums"
              >
                کل موجودی صف ({formatNumber(availableWaiting)})
              </button>
            </div>
            <input
              type="number"
              min="1"
              max={availableWaiting}
              value={quantity}
              onChange={e => setQuantity(e.target.value)}
              placeholder={`حداکثر ${availableWaiting}`}
              className="fiori-input font-mono tabular-nums"
              dir="ltr"
              required
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[var(--fiori-text-primary)] block">
                دستگاه / خط پرس
              </label>
              <select
                value={selectedMachineId}
                onChange={e => setSelectedMachineId(e.target.value)}
                className="fiori-input"
              >
                <option value="">{operation.machineName || '-- انتخاب ماشین --'}</option>
                {machines.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.code} - {m.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[var(--fiori-text-primary)] block">
                اپراتور مسئول
              </label>
              <input
                type="text"
                list="wip-input-operators-list"
                value={operatorName}
                onChange={e => setOperatorName(e.target.value)}
                placeholder="نام اپراتور شیفت"
                className="fiori-input"
              />
              {operators.length > 0 && (
                <datalist id="wip-input-operators-list">
                  {operators.map(op => (
                    <option key={op.id} value={op.fullName} />
                  ))}
                </datalist>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-[var(--fiori-text-primary)] block">
              یادداشت فرآیند
            </label>
            <input
              type="text"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="توضیحات ستاپ قالب، شماره پالت، فشار پرس..."
              className="fiori-input"
            />
          </div>
        </form>
      </div>
    </FioriDialog>
  );
};
