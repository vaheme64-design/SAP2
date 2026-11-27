import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Search,
  QrCode,
  Printer,
  CheckCircle2,
  Layers,
  Plus,
  RefreshCw,
  FileText,
  ArrowRight,
} from 'lucide-react';
import { Part, Machine, DieMold, Operator } from '../../types/inventory';
import { toPersianDigits, formatNumber } from '../../utils/formatters';
import { formatToJalali } from '../../utils/jalali';
import { TraceabilityTagModal } from './TraceabilityTagModal';
import { useErpRouter } from '../../context/RouterContext';
import {
  FioriDataTable,
  FioriDynamicPage,
  FioriObjectStatus,
  FioriTableColumn,
  FioriToolbar,
} from '../fiori/ui';
import { EmptyState } from '../common/EmptyState';

interface TraceabilityInquiryViewProps {
  parts: Part[];
  machines: Machine[];
  dies?: DieMold[];
  operators?: Operator[];
  initialQuery?: string;
}

interface TraceabilityDocumentChainRow {
  id: string;
  documentNumber: string;
  docType: string;
  documentType: string;
  docDate: string;
  partCode: string;
  partName: string;
  qty: number;
  weightKg: number;
  coilId: string;
  heatNumber: string;
  referenceNumber: string;
  warehouseName: string;
  description: string;
}

export const TraceabilityInquiryView: React.FC<TraceabilityInquiryViewProps> = ({
  parts,
  machines,
  dies = [],
  operators = [],
  initialQuery = '',
}) => {
  const router = useErpRouter();
  const [trackingQuery, setTrackingQuery] = useState(initialQuery);
  const [loading, setLoading] = useState(true);
  const [coils, setCoils] = useState<any[]>([]);
  const [documentChain, setDocumentChain] = useState<TraceabilityDocumentChainRow[]>([]);
  const [wipOrders, setWipOrders] = useState<any[]>([]);
  const [issuedTags, setIssuedTags] = useState<any[]>([]);
  const [selectedMoId, setSelectedMoId] = useState<string>('');
  const [isTagModalOpen, setIsTagModalOpen] = useState(false);

  useEffect(() => {
    if (initialQuery) {
      setTrackingQuery(initialQuery);
    }
  }, [initialQuery]);

  const loadLiveTraceability = useCallback(async () => {
    setLoading(true);
    try {
      const [chainRes, mosRes, tagsRes] = await Promise.all([
        fetch('/api/traceability/full-chain').then(r => r.json()).catch(() => ({ success: false })),
        fetch('/api/wip/manufacturing-orders').then(r => r.json()).catch(() => ({ success: false })),
        fetch('/api/production/traceability/history').then(r => r.json()).catch(() => ({ success: false })),
      ]);

      if (chainRes.success && chainRes.data) {
        setCoils(Array.isArray(chainRes.data.coils) ? chainRes.data.coils : []);
        setDocumentChain(Array.isArray(chainRes.data.documentChain) ? chainRes.data.documentChain : []);
      }
      if (mosRes.success && Array.isArray(mosRes.data)) {
        setWipOrders(mosRes.data);
        setSelectedMoId(prev => prev || mosRes.data[0]?.id || '');
      }
      if (tagsRes.success && Array.isArray(tagsRes.data)) {
        setIssuedTags(tagsRes.data);
      }
    } catch (err) {
      console.error('Error loading live traceability:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLiveTraceability();
  }, [loadLiveTraceability]);

  const normalizedQuery = trackingQuery.trim().toLowerCase();

  // Filter live document ledger & tags by query (coilId, heatNumber, documentNumber, moNumber, partCode, tagNumber)
  const matchingDocuments = useMemo(() => {
    if (!normalizedQuery) return documentChain;
    return documentChain.filter(d =>
      [
        d.documentNumber,
        d.partCode,
        d.partName,
        d.coilId,
        d.heatNumber,
        d.referenceNumber,
        d.warehouseName,
        d.description,
      ].some(val => String(val || '').toLowerCase().includes(normalizedQuery))
    );
  }, [documentChain, normalizedQuery]);

  const matchingTags = useMemo(() => {
    if (!normalizedQuery) return issuedTags;
    return issuedTags.filter(t =>
      [t.tagNumber, t.lotNumber, t.partCode, t.partName, t.moNumber, t.coilNumber, t.heatNumber].some(val =>
        String(val || '').toLowerCase().includes(normalizedQuery)
      )
    );
  }, [issuedTags, normalizedQuery]);

  const activeMo = useMemo(() => {
    if (normalizedQuery) {
      const matched = wipOrders.find(
        m =>
          m.moNumber?.toLowerCase().includes(normalizedQuery) ||
          m.partCode?.toLowerCase().includes(normalizedQuery) ||
          m.partName?.toLowerCase().includes(normalizedQuery) ||
          matchingDocuments.some(d => d.referenceNumber === m.moNumber)
      );
      if (matched) return matched;
    }
    return wipOrders.find(m => m.id === selectedMoId) || wipOrders[0] || null;
  }, [wipOrders, selectedMoId, normalizedQuery, matchingDocuments]);

  const primaryCoil = useMemo(() => {
    if (normalizedQuery) {
      const matched = coils.find(
        c =>
          c.coilId?.toLowerCase().includes(normalizedQuery) ||
          c.heatNumber?.toLowerCase().includes(normalizedQuery) ||
          c.coilPackNumber?.toLowerCase().includes(normalizedQuery)
      );
      if (matched) return matched;
    }
    return coils[0] || null;
  }, [coils, normalizedQuery]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
  };

  const operationColumns: FioriTableColumn<any>[] = useMemo(
    () => [
      {
        key: 'stepCode',
        header: 'کد مرحله',
        isMono: true,
        isLtrCode: true,
        nowrap: true,
        cellClassName: 'font-semibold text-[var(--fiori-text-primary)]',
        render: st => st.stepCode,
      },
      {
        key: 'stepName',
        header: 'عنوان عملیات',
        render: st => <span className="font-medium text-[var(--fiori-text-primary)]">{st.stepName}</span>,
      },
      {
        key: 'machineName',
        header: 'ایستگاه / دستگاه',
        render: st => <span className="text-[var(--fiori-text-secondary)]">{st.machineName || '—'}</span>,
      },
      {
        key: 'waitingInputQty',
        header: 'در صف ورودی',
        align: 'center',
        isMono: true,
        render: st => formatNumber(st.waitingInputQty || 0),
      },
      {
        key: 'activeQty',
        header: 'در جریان / آماده',
        align: 'center',
        isMono: true,
        cellClassName: 'text-[var(--fiori-brand)] font-semibold',
        render: st => formatNumber((st.inProgressQty || 0) + (st.readyForTransferQty || 0)),
      },
      {
        key: 'goodOutputQty',
        header: 'تولید سالم',
        align: 'center',
        isMono: true,
        cellClassName: 'text-[var(--fiori-positive)] font-semibold',
        render: st => formatNumber(st.goodOutputQty || 0),
      },
      {
        key: 'scrapQty',
        header: 'ضایعات',
        align: 'center',
        isMono: true,
        cellClassName: 'text-[var(--fiori-negative)]',
        render: st => formatNumber(st.scrapQty || 0),
      },
      {
        key: 'status',
        header: 'وضعیت مرحله',
        align: 'center',
        render: st =>
          st.status === 'COMPLETED' ? (
            <FioriObjectStatus tone="positive" variant="text" label="تکمیل شده" />
          ) : st.status === 'IN_PROGRESS' || st.status === 'READY' ? (
            <FioriObjectStatus tone="brand" variant="text" label="ایستگاه فعال" />
          ) : (
            <FioriObjectStatus tone="neutral" variant="text" label="در انتظار" />
          ),
      },
    ],
    [],
  );

  const documentColumns: FioriTableColumn<TraceabilityDocumentChainRow>[] = useMemo(
    () => [
      {
        key: 'documentNumber',
        header: 'شماره سند',
        isMono: true,
        nowrap: true,
        render: row => (
          <button
            type="button"
            onClick={() => router.traceDocument(row.documentNumber, 'INVENTORY_LEDGER')}
            className="sap-doc-link fiori-ltr-code font-mono cursor-pointer"
            title="مشاهده اصل سند در کاردکس انبار"
          >
            {row.documentNumber}
          </button>
        ),
      },
      {
        key: 'docDate',
        header: 'تاریخ',
        isMono: true,
        nowrap: true,
        cellClassName: 'text-[var(--fiori-text-secondary)]',
        render: row => row.docDate || formatToJalali(new Date()),
      },
      {
        key: 'docType',
        header: 'نوع تراکنش',
        render: row => row.docType,
      },
      {
        key: 'part',
        header: 'کد و نام کالا',
        render: row => (
          <div className="flex items-center gap-1 flex-wrap">
            <span className="fiori-ltr-code font-mono font-semibold text-[var(--fiori-text-primary)]">
              {row.partCode}
            </span>
            <span className="text-[var(--fiori-text-muted)]">·</span>
            <span>{row.partName}</span>
          </div>
        ),
      },
      {
        key: 'qty',
        header: 'مقدار / وزن',
        align: 'center',
        isMono: true,
        nowrap: true,
        render: row => (
          <span className="font-semibold text-[var(--fiori-positive)]">
            {formatNumber(row.qty)}{' '}
            <span className="text-[10px] text-[var(--fiori-text-secondary)]">
              ({formatNumber(row.weightKg)} kg)
            </span>
          </span>
        ),
      },
      {
        key: 'coilId',
        header: 'کلاف / لوت',
        isMono: true,
        nowrap: true,
        render: row =>
          row.coilId ? (
            <button
              type="button"
              onClick={() => router.traceDocument(row.coilId, 'COILS')}
              className="sap-doc-link fiori-ltr-code font-mono cursor-pointer"
              title="مشاهده وضعیت رول/کلاف در انبار ورق"
            >
              {row.coilId}
            </button>
          ) : (
            '—'
          ),
      },
      {
        key: 'heatNumber',
        header: 'شماره ذوب',
        isMono: true,
        isLtrCode: true,
        nowrap: true,
        render: row => row.heatNumber || '—',
      },
      {
        key: 'referenceNumber',
        header: 'مرجع / MO',
        isMono: true,
        nowrap: true,
        render: row =>
          row.referenceNumber ? (
            <button
              type="button"
              onClick={() => setTrackingQuery(row.referenceNumber)}
              className="sap-doc-link fiori-ltr-code font-mono cursor-pointer"
              title="فیلتر بر اساس مرجع / دستور کار"
            >
              {row.referenceNumber}
            </button>
          ) : (
            '—'
          ),
      },
    ],
    [router],
  );

  return (
    <FioriDynamicPage
      title="سامانه شناسایی و رهگیری سرتاسری مواد، ذوب و دستور کار (Live Traceability)"
      subtitle="ردیابی زنده شجره‌نامه قطعات از ورود رول و شماره ذوب (Heat No) تا مراحل تولید WIP، اسناد کاردکس و تحویل"
      status={
        <div className="flex items-center gap-1.5">
          <QrCode className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
          <FioriObjectStatus
            tone={activeMo ? 'info' : 'neutral'}
            label={activeMo ? activeMo.moNumber : 'بدون دستور کار فعال'}
            ltrCode={Boolean(activeMo)}
          />
        </div>
      }
      collapsibleFilters={false}
      activeFiltersCount={normalizedQuery ? 1 : 0}
      onResetFilters={() => {
        setTrackingQuery('');
        router.clearDocQuery();
      }}
      headerActions={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={loadLiveTraceability}
            disabled={loading}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>بروزرسانی</span>
          </button>
          <button
            type="button"
            onClick={() => setIsTagModalOpen(true)}
            className="sap-btn-emphasized flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>صدور کارت ردیابی پالت</span>
          </button>
        </div>
      }
      filterBar={
        <form onSubmit={handleSearchSubmit} className="space-y-2.5">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-[var(--fiori-text-secondary)] pointer-events-none" />
              <input
                type="text"
                value={trackingQuery}
                onChange={e => setTrackingQuery(e.target.value)}
                placeholder="جستجوی زنده با شماره سند، کلاف (COIL-ECU-001)، شماره ذوب (Heat No)، کد قطعه یا شماره دستور کار (MO)..."
                className="w-full pr-9 pl-4 py-1.5 text-xs bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] focus:outline-none focus:border-[var(--fiori-border-focus)] font-mono text-[var(--fiori-text-primary)]"
              />
            </div>
            {trackingQuery && (
              <button
                type="button"
                onClick={() => {
                  setTrackingQuery('');
                  router.clearDocQuery();
                }}
                className="sap-btn-standard px-3 py-1.5 text-xs cursor-pointer"
              >
                پاک کردن
              </button>
            )}
          </div>

          {wipOrders.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
              <span className="text-[var(--fiori-text-secondary)] font-medium">انتخاب سریع دستور کار:</span>
              {wipOrders.map(mo => {
                const isSelected = activeMo?.id === mo.id && !trackingQuery;
                return (
                  <button
                    key={mo.id}
                    type="button"
                    onClick={() => {
                      setSelectedMoId(mo.id);
                      setTrackingQuery('');
                    }}
                    className={`px-2.5 py-1 rounded-[var(--fiori-radius-sm)] border font-mono fiori-ltr-code transition cursor-pointer ${
                      isSelected
                        ? 'bg-[var(--fiori-brand)] text-white border-[var(--fiori-brand)] font-semibold'
                        : 'bg-[var(--fiori-bg-surface)] hover:bg-[var(--fiori-bg-selected)] text-[var(--fiori-text-primary)] border-[var(--fiori-border-default)]'
                    }`}
                  >
                    {mo.moNumber} ({mo.partCode})
                  </button>
                );
              })}
            </div>
          )}
        </form>
      }
    >
      {/* Live Source Material & MO Genealogy Summary */}
      <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] p-4 shadow-[var(--fiori-shadow-card)] space-y-4">
        <FioriToolbar
          variant="section"
          title={activeMo ? activeMo.partName : 'لطفاً یک کد کلاف، ذوب یا سند را جستجو کنید'}
          startContent={
            <FioriObjectStatus
              tone="brand"
              label={activeMo ? activeMo.moNumber : 'بدون دستور کار فعال'}
              ltrCode={Boolean(activeMo)}
              size="md"
            />
          }
          endContent={
            <div className="flex items-center gap-2">
              {activeMo?.moNumber && (
                <button
                  type="button"
                  onClick={() => router.traceDocument(activeMo.moNumber, 'INVENTORY_LEDGER')}
                  className="sap-btn-standard flex items-center gap-1.5 px-2.5 py-1 text-xs cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>اسناد کاردکس این دستور کار</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setIsTagModalOpen(true)}
                className="sap-btn-standard flex items-center gap-1.5 px-2.5 py-1 text-xs cursor-pointer"
              >
                <Printer className="w-3.5 h-3.5" />
                <span>چاپ لیبل ردیابی</span>
              </button>
            </div>
          }
        />

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div className="p-3 bg-[var(--fiori-bg-subtle)] rounded-[var(--fiori-radius-md)] border border-[var(--fiori-border-default)]">
            <span className="text-[11px] text-[var(--fiori-text-secondary)] block">کد قطعه و محصول:</span>
            <span className="font-bold text-[var(--fiori-text-primary)] font-mono fiori-ltr-code inline-block mt-0.5">
              {activeMo?.partCode || '—'}
            </span>
            <span className="text-[11px] text-[var(--fiori-text-secondary)] block mt-0.5 tabular-nums">
              هدف: {activeMo ? formatNumber(activeMo.targetQuantity) : '—'} عدد
            </span>
          </div>

          <div className="p-3 bg-[var(--fiori-bg-subtle)] rounded-[var(--fiori-radius-md)] border border-[var(--fiori-border-default)]">
            <span className="text-[11px] text-[var(--fiori-text-secondary)] block">منبع رول و ذوب (Coil / Heat):</span>
            <span className="font-bold text-[var(--fiori-text-primary)] font-mono fiori-ltr-code inline-block mt-0.5">
              {primaryCoil?.coilId || '—'}
            </span>
            <span className="text-[11px] text-[var(--fiori-text-secondary)] block mt-0.5 font-mono">
              {primaryCoil
                ? `گرید ${primaryCoil.materialGrade} · ذوب ${primaryCoil.heatNumber || '—'}`
                : 'در انتظار ثبت کلاف'}
            </span>
          </div>

          <div className="p-3 bg-[var(--fiori-bg-subtle)] rounded-[var(--fiori-radius-md)] border border-[var(--fiori-border-default)]">
            <span className="text-[11px] text-[var(--fiori-text-secondary)] block">اسناد کاردکس مرتبط:</span>
            <span className="font-bold text-[var(--fiori-text-primary)] font-mono tabular-nums inline-block mt-0.5">
              {toPersianDigits(matchingDocuments.length)} ردیف سند قطعی
            </span>
            <span className="text-[11px] text-[var(--fiori-text-secondary)] block mt-0.5 tabular-nums">
              تگ‌های صادرشده: {toPersianDigits(matchingTags.length)} مورد
            </span>
          </div>

          <div className="p-3 bg-[var(--fiori-positive-bg)] rounded-[var(--fiori-radius-md)] border border-[var(--fiori-positive-border)] text-[var(--fiori-positive)]">
            <span className="text-[11px] block">وضعیت تولید دستور کار:</span>
            <span className="font-bold text-base font-mono tabular-nums inline-block mt-0.5">
              {activeMo ? `${formatNumber(activeMo.completedQuantity || 0)} عدد تکمیل` : '—'}
            </span>
            <span className="text-[11px] font-semibold flex items-center gap-1 mt-0.5 tabular-nums">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              ضایعات ثبت‌شده: {activeMo ? formatNumber(activeMo.totalScrapQuantity || 0) : '۰'}
            </span>
          </div>
        </div>

        {/* Live Routing Operations Progress for Active MO */}
        {activeMo && Array.isArray(activeMo.operations) && (
          <FioriDataTable
            columns={operationColumns}
            data={activeMo.operations}
            rowKey={st => st.id || st.stepCode}
            loading={loading}
            compact
            rowClassName={st =>
              st.status === 'IN_PROGRESS' || st.status === 'READY'
                ? 'bg-[var(--fiori-bg-selected)]/45 font-semibold'
                : st.status === 'COMPLETED'
                ? ''
                : 'opacity-80 bg-[var(--fiori-bg-subtle)]'
            }
            toolbar={
              <FioriToolbar
                variant="table"
                title={`وضعیت زنده عبور قطعه در مراحل عملیات (${activeMo.moNumber})`}
                count={activeMo.operations.length}
                countLabel="مرحله"
                startContent={<Layers className="w-4 h-4 text-[var(--fiori-brand)]" />}
              />
            }
          />
        )}

        {/* Live Document & Lot Traceability Ledger */}
        <FioriDataTable
          columns={documentColumns}
          data={matchingDocuments.slice(0, 30)}
          rowKey={row => row.id}
          loading={loading}
          compact
          toolbar={
            <FioriToolbar
              variant="table"
              title="زنجیره زنده اسناد انبار و ردیابی لوت/ذوب (از ورود تا مصرف و محصول)"
              count={matchingDocuments.length}
              countLabel="سند"
              startContent={<FileText className="w-4 h-4 text-[var(--fiori-brand)]" />}
            />
          }
          emptyState={
            <EmptyState
              variant={normalizedQuery ? 'SEARCH_NO_MATCH' : 'NO_DATA'}
              compact
              title="سندی با این کلیدواژه یافت نشد"
              description="شماره سند، کد کلاف، شماره ذوب یا دستور کار مورد نظر در زنجیره اسناد ثبت‌شده یافت نشد."
              actionLabel={normalizedQuery ? 'پاک‌کردن جستجو' : undefined}
              onAction={
                normalizedQuery
                  ? () => {
                      setTrackingQuery('');
                      router.clearDocQuery();
                    }
                  : undefined
              }
            />
          }
        />

        {/* Issued Traceability Tags */}
        {matchingTags.length > 0 && (
          <div className="space-y-2">
            <FioriToolbar
              variant="section"
              title="کارت‌های شناسایی و پالت صادرشده"
              count={matchingTags.length}
              countLabel="تگ"
              startContent={<ArrowRight className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />}
            />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 text-xs">
              {matchingTags.slice(0, 6).map(tag => (
                <div
                  key={tag.id || tag.tagNumber}
                  className="p-3 bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] space-y-1"
                >
                  <div className="font-mono fiori-ltr-code font-bold text-[var(--fiori-text-primary)]">
                    {tag.tagNumber}
                  </div>
                  <div className="text-[var(--fiori-text-primary)] font-medium">
                    {tag.partName || tag.partCode}
                  </div>
                  <div className="text-[11px] text-[var(--fiori-text-secondary)] font-mono tabular-nums">
                    MO: {tag.moNumber || '—'} · تعداد: {formatNumber(tag.quantity || 0)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <TraceabilityTagModal
        isOpen={isTagModalOpen}
        onClose={() => {
          setIsTagModalOpen(false);
          loadLiveTraceability();
        }}
        parts={parts}
        machines={machines}
        dies={dies}
        operators={operators}
      />
    </FioriDynamicPage>
  );
};

