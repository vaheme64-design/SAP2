import React, { useEffect, useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { ManufacturingOrder, ManufacturingOperation } from '../../types/productionWip';
import { formatNumber } from '../../utils/formatters';
import { useErpRouter } from '../../context/RouterContext';
import { FioriDialog, FioriMessageStrip } from '../fiori/ui';

interface OperationTransferModalProps {
  isOpen: boolean;
  onClose: () => void;
  mo: ManufacturingOrder | null;
  fromOperation: ManufacturingOperation | null;
  onSubmit: (payload: any) => Promise<{ success: boolean; error?: string }>;
}

export const OperationTransferModal: React.FC<OperationTransferModalProps> = ({
  isOpen,
  onClose,
  mo,
  fromOperation,
  onSubmit,
}) => {
  const { traceDocument } = useErpRouter();
  const [selectedToOpId, setSelectedToOpId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [dispatchedBy, setDispatchedBy] = useState('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && mo && fromOperation) {
      const nextOps = mo.operations.filter(o => o.sequence > fromOperation.sequence);
      setSelectedToOpId(nextOps.length > 0 ? nextOps[0].id : 'STORE-FINISHED');
      setQuantity(fromOperation.readyForTransferQty > 0 ? String(fromOperation.readyForTransferQty) : '');
      setDispatchedBy('');
      setNotes('');
      setErrorMsg(null);
    }
  }, [isOpen, mo?.id, fromOperation?.id]);

  if (!isOpen || !mo || !fromOperation) return null;

  const readyQty = fromOperation.readyForTransferQty;
  const subsequentOps = mo.operations.filter(o => o.sequence > fromOperation.sequence);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const qty = Number(quantity);

    if (isNaN(qty) || qty <= 0) {
      setErrorMsg('تعداد انتقال باید یک عدد مثبت باشد.');
      return;
    }

    if (qty > readyQty) {
      setErrorMsg(`تعداد نمی‌تواند از موجودی آماده انتقال (${formatNumber(readyQty)} عدد) بیشتر باشد.`);
      return;
    }

    const toOpId = selectedToOpId || (subsequentOps.length > 0 ? subsequentOps[0].id : 'STORE-FINISHED');

    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await onSubmit({
        moId: mo.id,
        fromOperationId: fromOperation.id,
        toOperationId: toOpId,
        quantity: qty,
        dispatchedBy: dispatchedBy.trim() || 'سرپرست خط تولید',
        notes: notes.trim(),
        expectedVersion: fromOperation.version,
      });

      if (res.success) {
        onClose();
      } else {
        setErrorMsg(res.error || 'خطا در صدور حواله انتقال');
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
      title="صدور حواله انتقال بین‌مراحل"
      subtitle={
        <span className="inline-flex items-center gap-1.5 flex-wrap">
          <span>دستور</span>
          <button
            type="button"
            onClick={() => {
              onClose();
              traceDocument(mo.moNumber, 'WIP_TRACEABILITY');
            }}
            className="sap-doc-link fiori-ltr-code font-mono font-bold"
          >
            {mo.moNumber}
          </button>
          <span>• مبدأ:</span>
          <span className="fiori-ltr-code font-mono font-semibold text-[var(--fiori-text-primary)]">
            {fromOperation.stepCode}
          </span>
        </span>
      }
      icon={<ArrowRightLeft className="w-4 h-4" />}
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
            form="op-transfer-form"
            disabled={isSubmitting || readyQty <= 0}
            className="sap-btn-emphasized flex items-center gap-1.5 px-4 py-1.5 text-xs disabled:opacity-50"
          >
            <ArrowRightLeft className={`w-3.5 h-3.5 ${isSubmitting ? 'animate-spin' : ''}`} />
            <span>صدور و ارسال حواله انتقال</span>
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

        {/* Source Station Card */}
        <div className="p-3 bg-[var(--fiori-bg-subtle)] rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] grid grid-cols-2 gap-3 text-xs tabular-nums">
          <div>
            <span className="text-[var(--fiori-text-secondary)] text-[11px] block">مرحله مبدأ</span>
            <span className="font-bold text-[var(--fiori-text-primary)] block mt-0.5">{fromOperation.stepName}</span>
            <span className="fiori-ltr-code font-mono text-[11px] text-[var(--fiori-brand)]">
              {fromOperation.warehouseLocation}
            </span>
          </div>
          <div>
            <span className="text-[var(--fiori-text-secondary)] text-[11px] block">موجودی آماده انتقال</span>
            <span className="font-mono font-bold text-[var(--fiori-positive)] text-sm mt-0.5 block">
              {formatNumber(readyQty)}{' '}
              <span className="text-[11px] font-normal text-[var(--fiori-text-secondary)]">عدد</span>
            </span>
            <span className="text-[10px] text-[var(--fiori-text-secondary)]">پشتیبانی از انتقال جزئی و مرحله‌ای</span>
          </div>
        </div>

        <form id="op-transfer-form" onSubmit={handleSubmit} className="space-y-3.5">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-[var(--fiori-text-primary)] block">
              ایستگاه یا انبار مقصد <span className="text-[var(--fiori-negative)]">*</span>
            </label>
            <select
              value={selectedToOpId || (subsequentOps.length > 0 ? subsequentOps[0].id : 'STORE-FINISHED')}
              onChange={e => setSelectedToOpId(e.target.value)}
              className="fiori-input"
            >
              {subsequentOps.map(op => (
                <option key={op.id} value={op.id}>
                  {op.stepCode} - {op.stepName} ({op.warehouseLocation})
                </option>
              ))}
              <option value="STORE-FINISHED">انبار محصولات نهایی (تحویل قطعی پالت آماده به ساپکو)</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-semibold text-[var(--fiori-text-primary)]">
                تعداد ارسالی (عدد) <span className="text-[var(--fiori-negative)]">*</span>
              </label>
              <button
                type="button"
                onClick={() => setQuantity(String(readyQty))}
                className="text-[11px] text-[var(--fiori-brand)] hover:underline cursor-pointer font-semibold tabular-nums"
              >
                ارسال کل موجودی ({formatNumber(readyQty)})
              </button>
            </div>
            <input
              type="number"
              min="1"
              max={readyQty}
              value={quantity}
              onChange={e => setQuantity(e.target.value)}
              placeholder={`حداکثر ${readyQty}`}
              className="fiori-input font-mono tabular-nums"
              dir="ltr"
              required
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[var(--fiori-text-primary)] block">
                مسئول ارسال / تحویل‌دهنده
              </label>
              <input
                type="text"
                value={dispatchedBy}
                onChange={e => setDispatchedBy(e.target.value)}
                placeholder="نام مسئول شیفت مبدأ"
                className="fiori-input"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[var(--fiori-text-primary)] block">
                شماره پالت / توضیحات
              </label>
              <input
                type="text"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="پالت فلزی کد A-12..."
                className="fiori-input"
              />
            </div>
          </div>

          <FioriMessageStrip tone="info" title="تضمین عدم دوبارشماری موجودی بین‌مراحل">
            با ثبت این حواله، قطعات به عنوان «در حال انتقال بین‌مراحل» ثبت شده و تا زمان تأیید فیزیکی در ایستگاه مقصد، در صف ورودی قرار نمی‌گیرند.
          </FioriMessageStrip>
        </form>
      </div>
    </FioriDialog>
  );
};
