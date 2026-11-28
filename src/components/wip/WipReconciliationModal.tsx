import React, { useState, useEffect } from 'react';
import { Scale, RefreshCw } from 'lucide-react';
import { MoReconciliationReport } from '../../types/productionWip';
import { formatNumber, formatDateTime, toPersianDigits } from '../../utils/formatters';
import { useErpRouter } from '../../context/RouterContext';
import {
  FioriDataTable,
  FioriDialog,
  FioriKpiStrip,
  FioriMessageStrip,
  FioriObjectStatus,
  FioriTableColumn,
  FioriToolbar,
} from '../fiori/ui';

interface WipReconciliationModalProps {
  isOpen: boolean;
  onClose: () => void;
  moId: string | null;
}

type BreakdownRow = MoReconciliationReport['operationsBreakdown'][number];

export const WipReconciliationModal: React.FC<WipReconciliationModalProps> = ({
  isOpen,
  onClose,
  moId,
}) => {
  const { traceDocument } = useErpRouter();
  const [report, setReport] = useState<MoReconciliationReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fetchReconciliation = async () => {
    if (!moId) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/wip/reconciliation/${moId}`);
      const data = await res.json();
      if (data.success) {
        setReport(data.data);
      } else {
        setErrorMsg(data.error || 'خطا در محاسبه تراز پایستگی');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'خطا در ارتباط با سرور');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && moId) {
      fetchReconciliation();
    }
  }, [isOpen, moId]);

  if (!isOpen || !moId) return null;

  const columns: FioriTableColumn<BreakdownRow>[] = [
    {
      key: 'stepCode',
      header: 'کد مرحله',
      isMono: true,
      isLtrCode: true,
      render: op => (
        <span className="fiori-ltr-code font-mono font-bold text-[var(--fiori-brand)]">{op.stepCode}</span>
      ),
    },
    {
      key: 'stepName',
      header: 'عنوان عملیات',
      render: op => <span className="font-medium text-[var(--fiori-text-primary)]">{op.stepName}</span>,
    },
    {
      key: 'waitingInput',
      header: 'در صف ورودی',
      align: 'left',
      isMono: true,
      render: op => (
        <span className={`font-mono font-bold tabular-nums ${op.waitingInput > 0 ? 'text-[var(--fiori-critical)]' : 'text-[var(--fiori-text-muted)]'}`}>
          {op.waitingInput > 0 ? formatNumber(op.waitingInput) : '-'}
        </span>
      ),
    },
    {
      key: 'inProgress',
      header: 'پای دستگاه',
      align: 'left',
      isMono: true,
      render: op => (
        <span className={`font-mono font-bold tabular-nums ${op.inProgress > 0 ? 'text-[var(--fiori-brand)]' : 'text-[var(--fiori-text-muted)]'}`}>
          {op.inProgress > 0 ? formatNumber(op.inProgress) : '-'}
        </span>
      ),
    },
    {
      key: 'readyForTransfer',
      header: 'آماده انتقال',
      align: 'left',
      isMono: true,
      render: op => (
        <span className={`font-mono font-bold tabular-nums ${op.readyForTransfer > 0 ? 'text-[var(--fiori-positive)]' : 'text-[var(--fiori-text-muted)]'}`}>
          {op.readyForTransfer > 0 ? formatNumber(op.readyForTransfer) : '-'}
        </span>
      ),
    },
    {
      key: 'transferredOut',
      header: 'منتقله خروجی',
      align: 'left',
      isMono: true,
      render: op => (
        <span className="font-mono text-[var(--fiori-text-primary)] tabular-nums">
          {op.transferredOut > 0 ? formatNumber(op.transferredOut) : '-'}
        </span>
      ),
    },
    {
      key: 'scrap',
      header: 'ضایعات',
      align: 'left',
      isMono: true,
      render: op => (
        <span className={`font-mono tabular-nums ${op.scrap > 0 ? 'text-[var(--fiori-negative)] font-bold' : 'text-[var(--fiori-text-muted)]'}`}>
          {op.scrap > 0 ? formatNumber(op.scrap) : '-'}
        </span>
      ),
    },
    {
      key: 'rework',
      header: 'دوباره‌کاری',
      align: 'left',
      isMono: true,
      render: op => (
        <span className={`font-mono tabular-nums ${op.rework > 0 ? 'text-[var(--fiori-critical)] font-bold' : 'text-[var(--fiori-text-muted)]'}`}>
          {op.rework > 0 ? formatNumber(op.rework) : '-'}
        </span>
      ),
    },
    {
      key: 'rejected',
      header: 'نامنطبق',
      align: 'left',
      isMono: true,
      render: op => (
        <span className={`font-mono tabular-nums ${op.rejected > 0 ? 'text-[var(--fiori-negative)] font-bold' : 'text-[var(--fiori-text-muted)]'}`}>
          {op.rejected > 0 ? formatNumber(op.rejected) : '-'}
        </span>
      ),
    },
  ];

  const nonConformingTotal = report
    ? report.totalScrap + report.totalRework + report.totalRejected
    : 0;

  return (
    <FioriDialog
      isOpen={isOpen}
      onClose={onClose}
      size="xl"
      tone={report && !report.isConserved ? 'danger' : 'positive'}
      icon={<Scale className="w-4 h-4" />}
      title={
        <span className="inline-flex items-center gap-2 flex-wrap">
          <span>شناسنامه و گواهی موازنه پایستگی قطعات (WIP)</span>
          {report && (
            <FioriObjectStatus
              tone={report.isConserved ? 'positive' : 'negative'}
              label={report.isConserved ? 'تراز کامل (مغایرت = ۰)' : `مغایرت: ${formatNumber(report.discrepancy)}`}
              size="sm"
            />
          )}
        </span>
      }
      subtitle={
        <span className="inline-flex items-center gap-1.5 flex-wrap">
          <span>دستور ساخت:</span>
          {report?.moNumber ? (
            <button
              type="button"
              onClick={() => {
                onClose();
                traceDocument(report.moNumber, 'WIP_TRACEABILITY');
              }}
              className="sap-doc-link fiori-ltr-code font-mono font-bold"
            >
              {report.moNumber}
            </button>
          ) : (
            <strong className="fiori-ltr-code font-mono text-[var(--fiori-critical)]">{moId}</strong>
          )}
          {report?.partName && (
            <>
              <span>• قطعه:</span>
              <span className="text-[var(--fiori-text-primary)] font-medium">{report.partName}</span>
            </>
          )}
          {report?.partCode && (
            <button
              type="button"
              onClick={() => {
                onClose();
                traceDocument(report.partCode, 'INVENTORY_LEDGER');
              }}
              className="sap-doc-link fiori-ltr-code font-mono"
            >
              ({report.partCode})
            </button>
          )}
        </span>
      }
      headerActions={
        <button
          type="button"
          onClick={fetchReconciliation}
          disabled={loading}
          className="sap-btn-standard p-1.5"
          title="محاسبه مجدد"
          aria-label="محاسبه مجدد تراز"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-[var(--fiori-brand)]' : ''}`} />
        </button>
      }
      footer={
        <div className="flex items-center justify-between gap-3">
          {report?.auditTimestamp ? (
            <span className="text-[11px] text-[var(--fiori-text-secondary)] font-mono tabular-nums">
              زمان موازنه: <span className="fiori-ltr-code">{formatDateTime(report.auditTimestamp)}</span>
            </span>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={onClose}
            className="sap-btn-standard px-4 py-1.5 text-xs"
          >
            بستن پنجره
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {loading ? (
          <div className="space-y-3">
            <FioriKpiStrip
              loading
              columns={5}
              items={Array.from({ length: 5 }, (_, idx) => ({
                id: `sk-${idx}`,
                label: '',
                value: '',
              }))}
            />
            <div className="py-8 text-center text-xs text-[var(--fiori-text-secondary)]">
              در حال محاسبه دفاتر پایستگی و موازنه فیزیکی قطعات...
            </div>
          </div>
        ) : errorMsg ? (
          <FioriMessageStrip
            tone="error"
            title="خطا در محاسبه تراز پایستگی"
            actions={
              <button type="button" onClick={fetchReconciliation} className="sap-btn-standard px-2.5 py-1 text-[11px]">
                تلاش مجدد
              </button>
            }
          >
            {errorMsg}
          </FioriMessageStrip>
        ) : report ? (
          <>
            <FioriMessageStrip
              tone={report.isConserved ? 'success' : 'error'}
              title={
                report.isConserved
                  ? 'موازنه فیزیکی قطعات کاملاً منطبق است (قانون پایستگی ۱۰۰٪ محقق است)'
                  : 'مغایرت در شمارش دفاتر کار در جریان ساخت کشف شد'
              }
            >
              <span className="tabular-nums">
                ورودی اولیه: <strong className="font-mono">{formatNumber(report.initialInputQuantity)} عدد</strong>
                {' • '}
                مجموع فیزیکی شناسایی‌شده: <strong className="font-mono">{formatNumber(report.accountedTotal)} عدد</strong>
                {' • '}
                مغایرت:{' '}
                <strong className={`font-mono ${report.discrepancy === 0 ? 'text-[var(--fiori-positive)]' : 'text-[var(--fiori-negative)]'}`}>
                  {formatNumber(report.discrepancy)} عدد
                </strong>
              </span>
            </FioriMessageStrip>

            <FioriKpiStrip
              columns={5}
              items={[
                {
                  id: 'initial-input',
                  label: 'ورودی اولیه',
                  value: formatNumber(report.initialInputQuantity),
                  subtext: 'پایه محاسبه تراز',
                  tone: 'neutral',
                },
                {
                  id: 'current-wip',
                  label: 'کار در جریان (WIP)',
                  value: formatNumber(report.totalCurrentWip),
                  subtext: 'صف + پای‌کار + آماده',
                  tone: 'brand',
                },
                {
                  id: 'in-transit',
                  label: 'در حال انتقال',
                  value: formatNumber(report.totalInTransit),
                  subtext: 'در راه بین‌مراحل',
                  tone: report.totalInTransit > 0 ? 'critical' : 'neutral',
                },
                {
                  id: 'completed',
                  label: 'محصول تکمیل‌شده',
                  value: formatNumber(report.totalCompleted),
                  subtext: 'خروجی آخرین مرحله',
                  tone: 'positive',
                },
                {
                  id: 'non-conforming',
                  label: 'ضایعات و نامنطبق',
                  value: formatNumber(nonConformingTotal),
                  subtext: `${toPersianDigits(report.totalScrap)} ضایعات | ${toPersianDigits(report.totalRework)} دوباره‌کاری`,
                  tone: nonConformingTotal > 0 ? 'negative' : 'neutral',
                },
              ]}
            />

            <FioriDataTable
              columns={columns}
              data={report.operationsBreakdown}
              rowKey={op => `${op.stepNumber}-${op.stepCode}`}
              compact
              toolbar={
                <FioriToolbar
                  variant="table"
                  title="جزئیات پایستگی و توزیع قطعات در مراحل عملیاتی"
                  count={report.operationsBreakdown.length}
                  countLabel="مرحله عملیاتی"
                />
              }
            />
          </>
        ) : null}
      </div>
    </FioriDialog>
  );
};
