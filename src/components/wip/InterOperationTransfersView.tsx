import React, { useState } from 'react';
import { ArrowRightLeft, XCircle } from 'lucide-react';
import { WipTransfer } from '../../types/productionWip';
import { formatNumber, toPersianDigits, formatDateTime } from '../../utils/formatters';
import { useErpRouter } from '../../context/RouterContext';
import { useEnterpriseUx } from '../../context/EnterpriseUxContext';
import {
  FioriDataTable,
  FioriDialog,
  FioriDynamicPage,
  FioriFilterBar,
  FioriMessageStrip,
  FioriObjectStatus,
  FioriTableColumn,
  FioriToolbar,
} from '../fiori/ui';
import { EmptyState } from '../common/EmptyState';

interface InterOperationTransfersViewProps {
  transfers: WipTransfer[];
  loading: boolean;
  onRefresh: () => Promise<void>;
  onApproveTransfer: (transferId: string, notes?: string) => Promise<{ success: boolean; error?: string }>;
  onRejectTransfer: (transferId: string, reason: string) => Promise<{ success: boolean; error?: string }>;
  embeddedInParent?: boolean;
}

export const InterOperationTransfersView: React.FC<InterOperationTransfersViewProps> = ({
  transfers,
  loading,
  onApproveTransfer,
  onRejectTransfer,
  embeddedInParent = false,
}) => {
  const { traceDocument } = useErpRouter();
  const { requestConfirm } = useEnterpriseUx();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [rejectingTransferId, setRejectingTransferId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const filteredTransfers = transfers.filter(trf => {
    if (statusFilter !== 'ALL' && trf.status !== statusFilter) return false;
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      const matchesNum = trf.transferNumber.toLowerCase().includes(q);
      const matchesMo = trf.moNumber.toLowerCase().includes(q);
      const matchesPart = trf.partName.toLowerCase().includes(q) || trf.partCode.toLowerCase().includes(q);
      const matchesFrom = trf.fromStepName.toLowerCase().includes(q);
      const matchesTo = trf.toStepName.toLowerCase().includes(q);
      if (!matchesNum && !matchesMo && !matchesPart && !matchesFrom && !matchesTo) {
        return false;
      }
    }
    return true;
  });

  const handleApprove = (trf: WipTransfer) => {
    requestConfirm({
      title: `تأیید دریافت حواله انتقال ${trf.transferNumber}`,
      message: `آیا دریافت قطعی ${formatNumber(trf.quantity)} عدد «${trf.partName}» از ایستگاه «${trf.fromStepName}» به «${trf.toStepName}» را تأیید می‌کنید؟`,
      confirmLabel: 'تأیید دریافت و انتقال موجودی',
      variant: 'emerald',
      onConfirm: async () => {
        setActionLoading(true);
        setErrorMsg(null);
        try {
          const res = await onApproveTransfer(trf.id);
          if (!res.success) setErrorMsg(res.error || 'خطا در تأیید حواله');
        } catch (err: any) {
          setErrorMsg(err.message || 'خطا در ارتباط با سرور');
        } finally {
          setActionLoading(false);
        }
      },
    });
  };

  const handleConfirmReject = async () => {
    if (!rejectingTransferId) return;
    if (!rejectReason.trim()) {
      setErrorMsg('لطفاً دلیل رد محموله را مشخص کنید.');
      return;
    }
    setActionLoading(true);
    setErrorMsg(null);
    try {
      const res = await onRejectTransfer(rejectingTransferId, rejectReason.trim());
      if (res.success) {
        setRejectingTransferId(null);
        setRejectReason('');
      } else {
        setErrorMsg(res.error || 'خطا در رد حواله');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'خطا در ارتباط با سرور');
    } finally {
      setActionLoading(false);
    }
  };

  const pendingCount = transfers.filter(t => t.status === 'PENDING_APPROVAL').length;
  const approvedCount = transfers.filter(t => t.status === 'APPROVED').length;
  const rejectedCount = transfers.filter(t => t.status === 'REJECTED').length;
  const activeFiltersCount = (statusFilter !== 'ALL' ? 1 : 0) + (searchTerm.trim() ? 1 : 0);

  const resetFilters = () => {
    setSearchTerm('');
    setStatusFilter('ALL');
  };

  const columns: FioriTableColumn<WipTransfer>[] = [
    {
      key: 'transferNumber',
      header: 'شماره حواله',
      isMono: true,
      isLtrCode: true,
      render: trf => (
        <button
          type="button"
          onClick={() => traceDocument(trf.transferNumber, 'WIP_TRACEABILITY')}
          className="sap-doc-link fiori-ltr-code font-mono font-bold"
        >
          {trf.transferNumber}
        </button>
      ),
    },
    {
      key: 'moNumber',
      header: 'دستور ساخت (MO)',
      isMono: true,
      isLtrCode: true,
      render: trf => (
        <button
          type="button"
          onClick={() => traceDocument(trf.moNumber, 'WIP_TRACEABILITY')}
          className="sap-doc-link fiori-ltr-code font-mono"
        >
          {trf.moNumber}
        </button>
      ),
    },
    {
      key: 'partName',
      header: 'قطعه',
      render: trf => (
        <div>
          <div className="font-medium text-[var(--fiori-text-primary)]">{trf.partName}</div>
          <button
            type="button"
            onClick={() => traceDocument(trf.partCode, 'INVENTORY_LEDGER')}
            className="sap-doc-link fiori-ltr-code font-mono text-[11px]"
          >
            {trf.partCode}
          </button>
        </div>
      ),
    },
    {
      key: 'fromStepName',
      header: 'ایستگاه مبدأ',
      render: trf => (
        <div>
          <div className="text-[var(--fiori-text-primary)] font-medium">{trf.fromStepName}</div>
          <div className="fiori-ltr-code font-mono text-[10px] text-[var(--fiori-text-secondary)]">
            {trf.fromLocation}
          </div>
        </div>
      ),
    },
    {
      key: 'toStepName',
      header: 'ایستگاه / انبار مقصد',
      render: trf => (
        <div>
          <div className="text-[var(--fiori-text-primary)] font-medium">{trf.toStepName}</div>
          <div className="fiori-ltr-code font-mono text-[10px] text-[var(--fiori-text-secondary)]">
            {trf.toLocation}
          </div>
        </div>
      ),
    },
    {
      key: 'quantity',
      header: 'تعداد (عدد)',
      align: 'left',
      isMono: true,
      render: trf => (
        <span className="font-mono font-bold text-[var(--fiori-text-primary)] text-sm tabular-nums">
          {formatNumber(trf.quantity)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'وضعیت',
      render: trf => (
        <FioriObjectStatus
          tone={
            trf.status === 'APPROVED'
              ? 'positive'
              : trf.status === 'REJECTED'
              ? 'negative'
              : 'critical'
          }
          label={
            trf.status === 'APPROVED'
              ? 'تحویل‌گرفته‌شده'
              : trf.status === 'REJECTED'
              ? 'ردشده و عودت به مبدأ'
              : 'در انتظار تأیید مقصد'
          }
          size="sm"
        />
      ),
    },
    {
      key: 'dispatchedAt',
      header: 'زمان ارسال',
      isMono: true,
      render: trf => (
        <span className="fiori-ltr-code text-[var(--fiori-text-secondary)] font-mono text-[11px] tabular-nums">
          {formatDateTime(trf.dispatchedAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'عملیات تحویل',
      align: 'center',
      render: trf =>
        trf.status === 'PENDING_APPROVAL' ? (
          <div className="flex items-center justify-center gap-1.5">
            <button
              type="button"
              onClick={() => handleApprove(trf)}
              disabled={actionLoading}
              className="fiori-btn-positive px-2.5 py-1 text-[11px]"
              title="تأیید رسید و افزودن به صف ورودی مقصد"
            >
              تأیید تحویل
            </button>
            <button
              type="button"
              onClick={() => {
                setRejectingTransferId(trf.id);
                setRejectReason('');
              }}
              disabled={actionLoading}
              className="fiori-btn-danger-outline px-2 py-1 text-[11px]"
              title="رد محموله و بازگشت به مبدأ"
            >
              رد
            </button>
          </div>
        ) : trf.status === 'APPROVED' ? (
          <div className="text-[11px] text-[var(--fiori-positive)] font-medium">
            تحویل توسط {trf.receivedBy || 'سرپرست ایستگاه'}
          </div>
        ) : (
          <div className="text-[11px] text-[var(--fiori-negative)] font-medium" title={trf.rejectionReason}>
            علت رد: {trf.rejectionReason || 'عدم انطباق'}
          </div>
        ),
    },
  ];

  const filterBarNode = (
    <FioriFilterBar
      searchValue={searchTerm}
      onSearchChange={setSearchTerm}
      searchPlaceholder="جستجوی شماره حواله، دستور کار، نام یا کد قطعه، ایستگاه..."
      segments={[
        { id: 'ALL', label: 'همه', count: transfers.length },
        { id: 'PENDING_APPROVAL', label: 'در انتظار تأیید', count: pendingCount },
        { id: 'APPROVED', label: 'تحویل قطعی', count: approvedCount },
        { id: 'REJECTED', label: 'ردشده', count: rejectedCount },
      ]}
      activeSegment={statusFilter}
      onSegmentChange={setStatusFilter}
      hasActiveFilters={activeFiltersCount > 0}
      onReset={resetFilters}
    />
  );

  const mainBody = (
    <div className="space-y-3">
      {embeddedInParent && (
        <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-3">
          {filterBarNode}
        </div>
      )}

      {errorMsg && (
        <FioriMessageStrip tone="error" title="خطای عملیات انتقال" onClose={() => setErrorMsg(null)}>
          {errorMsg}
        </FioriMessageStrip>
      )}

      <FioriDataTable
        columns={columns}
        data={filteredTransfers}
        rowKey={trf => trf.id}
        loading={loading && transfers.length === 0}
        loadingRows={5}
        compact
        toolbar={
          <FioriToolbar
            variant="table"
            title="فهرست حواله‌های انتقال بین مراحل"
            startContent={<ArrowRightLeft className="w-4 h-4 text-[var(--fiori-brand)]" />}
            count={filteredTransfers.length}
            countLabel="حواله"
            endContent={
              pendingCount > 0 ? (
                <FioriObjectStatus
                  tone="critical"
                  label={`${toPersianDigits(pendingCount)} حواله در انتظار تأیید`}
                  size="sm"
                />
              ) : (
                <FioriObjectStatus tone="positive" label="بدون حواله معلق" size="sm" />
              )
            }
          />
        }
        emptyState={
          <EmptyState
            title="حواله‌ای یافت نشد"
            description="فیلترهای جستجو را تغییر دهید یا از لیست عملیات دستور کار حواله انتقال جدیدی صادر کنید."
            actionLabel={activeFiltersCount > 0 ? 'بازنشانی فیلترها' : undefined}
            onAction={activeFiltersCount > 0 ? resetFilters : undefined}
          />
        }
      />

      {/* Reject Confirmation Dialog */}
      <FioriDialog
        isOpen={Boolean(rejectingTransferId)}
        onClose={() => setRejectingTransferId(null)}
        title="رد محموله و عودت به مرحله مبدأ"
        tone="danger"
        size="sm"
        icon={<XCircle className="w-4 h-4" />}
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setRejectingTransferId(null)}
              className="sap-btn-standard px-3.5 py-1.5 text-xs"
            >
              انصراف
            </button>
            <button
              type="button"
              onClick={handleConfirmReject}
              disabled={actionLoading || !rejectReason.trim()}
              className="fiori-btn-danger px-3.5 py-1.5 text-xs"
            >
              تأیید رد و عودت
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-xs text-[var(--fiori-text-secondary)] leading-relaxed">
            با رد این حواله، قطعات مجدداً در وضعیت «آماده انتقال» مرحله مبدأ قرار گرفته و به موجودی ایستگاه قبل بازگردانده می‌شوند.
          </p>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-[var(--fiori-text-primary)] block">
              علت رد محموله <span className="text-[var(--fiori-negative)]">*</span>
            </label>
            <textarea
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              placeholder="مثال: مغایرت در تعداد شمارش، پلیسه روی لبه، عدم تطابق پالت..."
              rows={3}
              className="fiori-input"
            />
          </div>
        </div>
      </FioriDialog>
    </div>
  );

  if (embeddedInParent) {
    return mainBody;
  }

  return (
    <FioriDynamicPage
      title="حواله‌های انتقال و ردیابی بین‌مراحل"
      subtitle="ردیابی دقیق محموله‌های در حال جابجایی بین سالن‌ها و ایستگاه‌های پرس، جوشکاری، رنگ و مونتاژ"
      status={
        pendingCount > 0 ? (
          <FioriObjectStatus
            tone="critical"
            label={`${toPersianDigits(pendingCount)} حواله در انتظار تأیید`}
            size="sm"
          />
        ) : (
          <FioriObjectStatus tone="positive" label="بدون حواله معلق" size="sm" />
        )
      }
      headerActions={
        <div className="text-xs text-[var(--fiori-text-secondary)] tabular-nums">
          کل حواله‌ها:{' '}
          <strong className="text-[var(--fiori-text-primary)] font-mono">
            {toPersianDigits(transfers.length)}
          </strong>
        </div>
      }
      filterBar={filterBarNode}
      activeFiltersCount={activeFiltersCount}
      onResetFilters={resetFilters}
    >
      {mainBody}
    </FioriDynamicPage>
  );
};
