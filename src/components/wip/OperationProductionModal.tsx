import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { ManufacturingOperation } from '../../types/productionWip';
import { DynamicSelect } from '../common/DynamicSelect';
import { formatNumber } from '../../utils/formatters';
import { FioriDialog, FioriMessageStrip } from '../fiori/ui';

interface OperationProductionModalProps {
  isOpen: boolean;
  onClose: () => void;
  operation: ManufacturingOperation | null;
  onSubmit: (payload: any) => Promise<{ success: boolean; error?: string }>;
}

export const OperationProductionModal: React.FC<OperationProductionModalProps> = ({
  isOpen,
  onClose,
  operation,
  onSubmit,
}) => {
  const [goodQty, setGoodQty] = useState('');
  const [scrapQty, setScrapQty] = useState('0');
  const [reworkQty, setReworkQty] = useState('0');
  const [rejectedQty, setRejectedQty] = useState('0');
  const [scrapReason, setScrapReason] = useState('');
  const [operatorName, setOperatorName] = useState('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [postingContext, setPostingContext] = useState<any>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [relationalManufacturingOrderId, setRelationalManufacturingOrderId] = useState('');
  const [shiftId, setShiftId] = useState('');
  const [createdByUserId, setCreatedByUserId] = useState('');
  const [relationalMachineId, setRelationalMachineId] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');

  useEffect(() => {
    if (!isOpen || !operation) return;
    let cancelled = false;
    setContextLoading(true);
    setErrorMsg(null);
    fetch(`/api/wip/production-posting-context?wipMoId=${encodeURIComponent(operation.moId)}`)
      .then(response => response.json())
      .then(result => {
        if (cancelled) return;
        if (!result.success) throw new Error(result.error || 'خطا در دریافت اطلاعات ثبت تولید');
        setPostingContext(result.data);
        const matchedById = result.data.manufacturingOrders?.find(
          (m: any) => m.id === operation.moId
        );
        const matchedByNumber = result.data.manufacturingOrders?.find(
          (m: any) => m.moNumber === operation.moNumber
        );
        setRelationalManufacturingOrderId(
          matchedById?.id ||
            matchedByNumber?.id ||
            result.data.identityLink?.manufacturingOrderId ||
            result.data.manufacturingOrders?.[0]?.id ||
            ''
        );
        setShiftId(result.data.shifts?.[0]?.id || '');
        setCreatedByUserId(result.data.users?.[0]?.id || '');
      })
      .catch(error => {
        if (!cancelled) setErrorMsg(error.message || 'خطا در دریافت اطلاعات ثبت تولید');
      })
      .finally(() => {
        if (!cancelled) setContextLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, operation?.moId]);

  useEffect(() => {
    if (!isOpen) setIdempotencyKey('');
  }, [isOpen]);

  const selectedRelationalOrder = useMemo(
    () =>
      postingContext?.manufacturingOrders?.find(
        (row: any) => row.id === relationalManufacturingOrderId
      ),
    [postingContext, relationalManufacturingOrderId]
  );
  const selectedRelationalOperation = useMemo(
    () =>
      selectedRelationalOrder?.operations?.find(
        (row: any) =>
          row.stepNumber === operation?.stepNumber &&
          row.operation?.processType === operation?.processType
      ),
    [selectedRelationalOrder, operation?.stepNumber, operation?.processType]
  );

  if (!isOpen || !operation) return null;

  const inProgressTotal = operation.inProgressQty || 0;
  const waitingTotal = operation.waitingInputQty || 0;
  const effectiveAvailableTotal = inProgressTotal + waitingTotal;

  const good = Math.max(0, Number(goodQty) || 0);
  const scrap = Math.max(0, Number(scrapQty) || 0);
  const rework = Math.max(0, Number(reworkQty) || 0);
  const rejected = Math.max(0, Number(rejectedQty) || 0);
  const totalAccounted = good + scrap + rework + rejected;
  const remainingInProgress = effectiveAvailableTotal - totalAccounted;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (totalAccounted <= 0) {
      setErrorMsg(
        'حداقل یکی از مقادیر تولید سالم، ضایعات، دوباره‌کاری یا نامنطبق باید بزرگتر از صفر باشد.'
      );
      return;
    }

    if (totalAccounted > effectiveAvailableTotal) {
      setErrorMsg(
        `مجموع قطعات اعلام‌شده (${formatNumber(
          totalAccounted
        )}) از مجموع موجودی قابل پردازش ایستگاه (${formatNumber(
          effectiveAvailableTotal
        )}) بیشتر است.`
      );
      return;
    }

    if (scrap > 0 && !scrapReason) {
      setErrorMsg('با توجه به وجود ضایعات، انتخاب علت فنی ضایعات الزامی است.');
      return;
    }
    if (!relationalManufacturingOrderId || !shiftId || !createdByUserId) {
      setErrorMsg('انتخاب دستور ساخت دیتابیس، شیفت و کاربر ثبت‌کننده الزامی است.');
      return;
    }
    if (selectedRelationalOrder && !selectedRelationalOperation) {
      setErrorMsg(
        'برای این مرحله، عملیات متناظر با شماره مرحله و نوع فرایند در دستور ساخت انتخابی پیدا نشد.'
      );
      return;
    }
    if (
      selectedRelationalOperation &&
      !selectedRelationalOperation.plannedMachineId &&
      !relationalMachineId
    ) {
      setErrorMsg('برای عملیات بدون ماشین برنامه‌ریزی‌شده، انتخاب ماشین واقعی الزامی است.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const submissionKey =
        idempotencyKey ||
        (typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `WIP-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      setIdempotencyKey(submissionKey);
      const res = await onSubmit({
        moId: operation.moId,
        operationId: operation.id,
        goodQty: good,
        scrapQty: scrap,
        reworkQty: rework,
        rejectedQty: rejected,
        scrapReason: scrap > 0 ? scrapReason : undefined,
        operatorName:
          operatorName.trim() ||
          postingContext?.users?.find((user: any) => user.id === createdByUserId)?.fullName ||
          'اپراتور مسئول خط',
        notes: notes.trim(),
        relationalManufacturingOrderId,
        shiftId,
        createdByUserId,
        relationalMachineId: relationalMachineId || undefined,
        idempotencyKey: submissionKey,
        expectedVersion: operation.version,
      });

      if (res.success) {
        setIdempotencyKey('');
        onClose();
      } else {
        setErrorMsg(res.error || 'خطا در ثبت عملکرد تولید');
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
        <span className="flex items-center gap-1.5 flex-wrap">
          <span>ثبت خروجی تولید و کنترل کیفیت</span>
          <span className="fiori-ltr-code font-mono text-[var(--fiori-positive)]">
            ({operation.stepCode})
          </span>
        </span>
      }
      subtitle={
        <span>
          {operation.stepName} · دستور{' '}
          <span className="fiori-ltr-code font-mono font-semibold text-[var(--fiori-brand)]">
            {operation.moNumber}
          </span>
        </span>
      }
      icon={<CheckCircle2 className="w-4 h-4" />}
      tone="positive"
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
            form="op-production-form"
            disabled={
              isSubmitting ||
              contextLoading ||
              totalAccounted <= 0 ||
              totalAccounted > effectiveAvailableTotal ||
              !relationalManufacturingOrderId ||
              !shiftId ||
              !createdByUserId
            }
            className="fiori-btn-positive inline-flex items-center gap-1.5 px-4 py-1.5 text-xs cursor-pointer disabled:opacity-50"
          >
            <CheckCircle2 className={`w-3.5 h-3.5 ${isSubmitting ? 'animate-spin' : ''}`} />
            <span>{isSubmitting ? 'در حال ثبت...' : 'ثبت قطعی تولید و کاردکس'}</span>
          </button>
        </>
      }
    >
      {errorMsg && (
        <FioriMessageStrip tone="error" compact onClose={() => setErrorMsg(null)}>
          {errorMsg}
        </FioriMessageStrip>
      )}

      {/* Current Station Balance Summary */}
      <div className="p-3 bg-[var(--fiori-bg-subtle)] rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] flex flex-wrap items-center justify-between gap-2 text-xs">
        <div>
          <span className="text-[var(--fiori-text-secondary)] text-[11px] block">
            موجودی قابل پردازش ایستگاه (پای دستگاه: {formatNumber(inProgressTotal)} + صف ورودی:{' '}
            {formatNumber(waitingTotal)})
          </span>
          <span className="font-mono font-semibold text-[var(--fiori-text-primary)] text-base tabular-nums">
            {formatNumber(effectiveAvailableTotal)}{' '}
            <span className="text-xs font-normal text-[var(--fiori-text-muted)]">عدد</span>
          </span>
        </div>
        <div className="text-left">
          <span className="text-[var(--fiori-text-secondary)] text-[11px] block">
            مانده پس از ثبت این فرم
          </span>
          <span
            className={`font-mono font-semibold text-base tabular-nums ${
              remainingInProgress >= 0
                ? 'text-[var(--fiori-brand)]'
                : 'text-[var(--fiori-negative)]'
            }`}
          >
            {formatNumber(remainingInProgress)}{' '}
            <span className="text-xs font-normal text-[var(--fiori-text-muted)]">عدد</span>
          </span>
        </div>
      </div>

      <form id="op-production-form" onSubmit={handleSubmit} className="space-y-4 text-xs">
        {/* Posting Context */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)]">
          <div className="space-y-1">
            <label className="font-semibold text-[var(--fiori-text-primary)] block">
              دستور ساخت متناظر در دیتابیس <span className="text-[var(--fiori-negative)]">*</span>
            </label>
            <select
              value={relationalManufacturingOrderId}
              onChange={e => setRelationalManufacturingOrderId(e.target.value)}
              disabled={contextLoading || isSubmitting}
              className="fiori-input w-full p-2"
            >
              <option value="">انتخاب دستور ساخت...</option>
              {(postingContext?.manufacturingOrders || []).map((row: any) => (
                <option key={row.id} value={row.id}>
                  {row.moNumber} — {row.part?.partNumber} ({row.part?.name})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="font-semibold text-[var(--fiori-text-primary)] block">
              شیفت تولید <span className="text-[var(--fiori-negative)]">*</span>
            </label>
            <select
              value={shiftId}
              onChange={e => setShiftId(e.target.value)}
              disabled={contextLoading || isSubmitting}
              className="fiori-input w-full p-2"
            >
              <option value="">انتخاب شیفت...</option>
              {(postingContext?.shifts || []).map((row: any) => (
                <option key={row.id} value={row.id}>
                  {row.name} ({row.startTime} تا {row.endTime})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="font-semibold text-[var(--fiori-text-primary)] block">
              کاربر ثبت‌کننده <span className="text-[var(--fiori-negative)]">*</span>
            </label>
            <select
              value={createdByUserId}
              onChange={e => setCreatedByUserId(e.target.value)}
              disabled={contextLoading || isSubmitting}
              className="fiori-input w-full p-2"
            >
              <option value="">انتخاب کاربر...</option>
              {(postingContext?.users || []).map((row: any) => (
                <option key={row.id} value={row.id}>
                  {row.fullName}
                  {row.personnelCode ? ` — ${row.personnelCode}` : ''}
                </option>
              ))}
            </select>
          </div>
          {selectedRelationalOperation && !selectedRelationalOperation.plannedMachineId && (
            <div className="space-y-1">
              <label className="font-semibold text-[var(--fiori-text-primary)] block">
                ماشین واقعی عملیات <span className="text-[var(--fiori-negative)]">*</span>
              </label>
              <select
                value={relationalMachineId}
                onChange={e => setRelationalMachineId(e.target.value)}
                disabled={contextLoading || isSubmitting}
                className="fiori-input w-full p-2"
              >
                <option value="">انتخاب ماشین...</option>
                {(postingContext?.machines || []).map((row: any) => (
                  <option key={row.id} value={row.id}>
                    {row.code} — {row.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {contextLoading && (
            <p className="text-[11px] text-[var(--fiori-text-secondary)] sm:col-span-2">
              در حال دریافت شیفت‌ها، کاربران و دستورهای ساخت...
            </p>
          )}
          {!contextLoading && postingContext?.manufacturingOrders?.length === 0 && (
            <p className="text-[11px] text-[var(--fiori-negative)] sm:col-span-2">
              برای این کد قطعه دستور ساخت فعالی در دیتابیس یافت نشد؛ ابتدا از طریق «برنامه‌ریزی MRP ←
              پیشنهاد برنامه» یا «مدیریت دستورات ساخت (MO)» دستور ساخت صادر نمایید.
            </p>
          )}
        </div>

        {/* 4 Output Quantity Buckets */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          <div className="space-y-1 bg-[var(--fiori-positive-bg)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-positive-border)]">
            <label className="text-[11px] font-semibold text-[var(--fiori-positive)] block">
              تولید سالم <span className="text-[var(--fiori-negative)]">*</span>
            </label>
            <input
              type="number"
              min="0"
              value={goodQty}
              onChange={e => setGoodQty(e.target.value)}
              placeholder="0"
              className="fiori-input w-full p-2 font-mono font-semibold text-left"
            />
            <span className="text-[10px] text-[var(--fiori-text-secondary)] block">
              انتقال به مرحله بعدی
            </span>
          </div>

          <div className="space-y-1 bg-[var(--fiori-negative-bg)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-negative-border)]">
            <label className="text-[11px] font-semibold text-[var(--fiori-negative)] block">
              ضایعات قطعی
            </label>
            <input
              type="number"
              min="0"
              value={scrapQty}
              onChange={e => setScrapQty(e.target.value)}
              placeholder="0"
              className="fiori-input w-full p-2 font-mono font-semibold text-left"
            />
            <span className="text-[10px] text-[var(--fiori-text-secondary)] block">
              پرت غیرقابل بازیافت
            </span>
          </div>

          <div className="space-y-1 bg-[var(--fiori-critical-bg)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-critical-border)]">
            <label className="text-[11px] font-semibold text-[var(--fiori-critical)] block">
              دوباره‌کاری
            </label>
            <input
              type="number"
              min="0"
              value={reworkQty}
              onChange={e => setReworkQty(e.target.value)}
              placeholder="0"
              className="fiori-input w-full p-2 font-mono font-semibold text-left"
            />
            <span className="text-[10px] text-[var(--fiori-text-secondary)] block">
              نیاز به اصلاح
            </span>
          </div>

          <div className="space-y-1 bg-[var(--fiori-brand-bg)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-brand-border)]">
            <label className="text-[11px] font-semibold text-[var(--fiori-brand)] block">
              نامنطبق / قرنطینه
            </label>
            <input
              type="number"
              min="0"
              value={rejectedQty}
              onChange={e => setRejectedQty(e.target.value)}
              placeholder="0"
              className="fiori-input w-full p-2 font-mono font-semibold text-left"
            />
            <span className="text-[10px] text-[var(--fiori-text-secondary)] block">
              در انتظار تصمیم QC
            </span>
          </div>
        </div>

        {/* Scrap Reason (Required if scrap > 0) */}
        {scrap > 0 && (
          <div className="p-3 bg-[var(--fiori-negative-bg)] border border-[var(--fiori-negative-border)] rounded-[var(--fiori-radius-sm)]">
            <DynamicSelect
              categoryCode="SCRAP_REASON"
              label="علت فنی ضایعات (الزام مهندسی کنترل کیفیت)"
              value={scrapReason}
              valueField="value"
              onChange={(val, item) => setScrapReason(item?.value || val)}
              required
              allowAddOption={true}
              placeholder="-- انتخاب علت ضایعات از پایگاه داده --"
              selectClassName="bg-white border-[var(--fiori-negative-border)]"
            />
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="font-semibold text-[var(--fiori-text-primary)] block">
              اپراتور / سرپرست ثبت‌کننده
            </label>
            <input
              type="text"
              value={operatorName}
              onChange={e => setOperatorName(e.target.value)}
              placeholder="نام اپراتور شیفت"
              className="fiori-input w-full p-2"
            />
          </div>

          <div className="space-y-1">
            <label className="font-semibold text-[var(--fiori-text-primary)] block">
              توضیحات و بازرسی
            </label>
            <input
              type="text"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="شرح بازرسی چشمی و تلرانس..."
              className="fiori-input w-full p-2"
            />
          </div>
        </div>

        <FioriMessageStrip tone="warning" compact>
          <strong>ثبت اتمیک:</strong> گزارش تولید، کسر موجودی مرحله جاری، ورود سالم به مرحله بعد و
          ثبت ضایعات/دوباره‌کاری/مردودی همزمان ثبت می‌شوند؛ مرحله مقصد نیازی به تأیید دریافت ندارد.
        </FioriMessageStrip>
      </form>
    </FioriDialog>
  );
};
