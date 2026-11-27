import React, { useState, useMemo, useEffect } from 'react';
import {
  Download,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Link2,
  Eye,
  Search,
  X,
} from 'lucide-react';
import {
  InventoryDocument,
  InventoryDocumentLine,
  WarehouseDefinition,
  InventoryDocType,
  PostingStatus,
  SAP_MOVEMENT_CATALOG,
  SapMovementType,
  resolveSapMovementType,
  getSapMovementReversal,
} from '../../types/inventory';
import {
  formatNumber,
  formatWeightKg,
  toPersianDigits,
  exportToCsv,
} from '../../utils/formatters';
import {
  formatToJalali,
  parseJalaliString,
  jalaliToGregorian,
  parseSafeGregorianDate,
} from '../../utils/jalali';
import { useErpRouter } from '../../context/RouterContext';
import { AlpVisualKpiItem } from '../fiori/FioriAnalyticalListPage';
import { FioriObjectPage } from '../fiori/FioriObjectPage';
import {
  FioriDynamicPage,
  FioriToolbar,
  FioriDataTable,
  FioriTableColumn,
  FioriObjectStatus,
  FioriStatusTone,
  FioriMessageStrip,
  FioriDialog,
} from '../fiori/ui';
import { JalaliDatePicker } from '../common/JalaliDatePicker';
import { EmptyState } from '../common/EmptyState';

interface MovementHistoryViewProps {
  documents: InventoryDocument[];
  warehouses: WarehouseDefinition[];
  loading: boolean;
  initialSearchTerm?: string;
  userRole?: string;
  onRefresh: () => Promise<void>;
  onReverseDocument: (
    documentId: string,
    reason: string
  ) => Promise<{ success: boolean; message: string }>;
}

type KpiFilterPreset =
  | 'ALL'
  | 'POSTED'
  | 'RECEIPT_101'
  | 'ISSUE_261'
  | 'QM_TRANSFERS'
  | 'REVERSAL';

function normalizeDocDateToIso(docDate?: string, fallbackIso?: string): string {
  const raw = docDate || fallbackIso;
  if (!raw) return '';
  const jalali = parseJalaliString(raw);
  if (jalali) {
    const { gy, gm, gd } = jalaliToGregorian(jalali.year, jalali.month, jalali.day);
    return `${gy}-${String(gm).padStart(2, '0')}-${String(gd).padStart(2, '0')}`;
  }
  const d = parseSafeGregorianDate(raw);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

export const MovementHistoryView: React.FC<MovementHistoryViewProps> = ({
  documents,
  warehouses,
  loading,
  initialSearchTerm,
  userRole,
  onRefresh,
  onReverseDocument,
}) => {
  const router = useErpRouter();
  const [searchTerm, setSearchTerm] = useState(initialSearchTerm || '');
  const [selectedTypeFilter, setSelectedTypeFilter] = useState<string>('ALL');
  const [selectedMovementFilter, setSelectedMovementFilter] = useState<string>('ALL');
  const [selectedWarehouseFilter, setSelectedWarehouseFilter] = useState('ALL');
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<string>('ALL');
  const [fromDateJalali, setFromDateJalali] = useState('');
  const [fromDateIso, setFromDateIso] = useState('');
  const [toDateJalali, setToDateJalali] = useState('');
  const [toDateIso, setToDateIso] = useState('');
  const [kpiPreset, setKpiPreset] = useState<KpiFilterPreset>('ALL');
  const [showAuditNotice, setShowAuditNotice] = useState(true);

  // Sorting & Pagination
  const [sortKey, setSortKey] = useState<string>('createdAt');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(16);

  // Object Page state
  const [selectedObjectDoc, setSelectedObjectDoc] = useState<InventoryDocument | null>(null);

  useEffect(() => {
    if (initialSearchTerm !== undefined) {
      setSearchTerm(initialSearchTerm);
      setCurrentPage(1);
    }
  }, [initialSearchTerm]);

  // Keep Object Page doc synced if optimistic update mutates documents array
  const activeObjectDoc = useMemo(() => {
    if (!selectedObjectDoc) return null;
    return documents.find(d => d.id === selectedObjectDoc.id) || selectedObjectDoc;
  }, [documents, selectedObjectDoc]);

  // Reversal dialog state (No Delete allowed on transactional records)
  const [reversalDoc, setReversalDoc] = useState<InventoryDocument | null>(null);
  const [reversalReason, setReversalReason] = useState('');
  const [isSubmittingReversal, setIsSubmittingReversal] = useState(false);
  const [reversalError, setReversalError] = useState<string | null>(null);

  const docTypeLabels: Record<
    InventoryDocType,
    { label: string; colorClass: string }
  > = {
    OPENING_BALANCE: {
      label: 'موجودی اول دوره',
      colorClass: 'text-[var(--fiori-text-primary)]',
    },
    RECEIPT_RAW_MATERIAL: {
      label: 'رسید ورود مواد اولیه',
      colorClass: 'text-[var(--fiori-positive)]',
    },
    ISSUE_RAW_MATERIAL: {
      label: 'حواله مصرف مواد/خط',
      colorClass: 'text-[var(--fiori-critical)]',
    },
    RECEIPT_FINISHED_GOODS: {
      label: 'رسید محصول نهایی',
      colorClass: 'text-[var(--fiori-positive)]',
    },
    ISSUE_FINISHED_GOODS: {
      label: 'حواله خروج محصول نهایی',
      colorClass: 'text-[var(--fiori-brand)]',
    },
    DELIVERY_CUSTOMER: {
      label: 'تحویل و خروج به مشتری',
      colorClass: 'text-[var(--fiori-brand)]',
    },
    SHIPMENT_CUSTOMER: {
      label: 'حواله بارنامه خودروساز',
      colorClass: 'text-[var(--fiori-brand)]',
    },
    TRANSFER: {
      label: 'انتقال بین‌انباری',
      colorClass: 'text-[var(--fiori-text-primary)]',
    },
    STOCK_STATUS_TRANSFER: {
      label: 'انتقال وضعیت کیفی (QM)',
      colorClass: 'text-[var(--fiori-brand)]',
    },
    ADJUSTMENT: {
      label: 'تعدیل انبارگردانی',
      colorClass: 'text-[var(--fiori-critical)]',
    },
    REVERSAL: {
      label: 'سند ابطال / برگشتی',
      colorClass: 'text-[var(--fiori-negative)]',
    },
  };

  const statusLabels: Record<
    PostingStatus,
    { label: string; tone: FioriStatusTone; objectPageTone: 'positive' | 'critical' | 'negative' | 'brand' }
  > = {
    POSTED: {
      label: 'قطعی (ثبت کاردکس)',
      tone: 'positive',
      objectPageTone: 'positive',
    },
    UNPOSTED: {
      label: 'پیش‌نویس',
      tone: 'critical',
      objectPageTone: 'critical',
    },
    REVERSED: {
      label: 'ابطال‌شده با سند معکوس',
      tone: 'negative',
      objectPageTone: 'negative',
    },
  };

  const getMovementInfo = (
    doc: InventoryDocument
  ): {
    code: SapMovementType;
    shortFa: string;
    labelFa: string;
    direction: string;
  } => {
    const code = resolveSapMovementType(doc.documentType, {
      explicitMovementType: doc.movementType,
      totalQuantity: doc.totalQuantity,
      qmTarget: doc.qmStatusTarget,
    });
    const meta = SAP_MOVEMENT_CATALOG[code];
    return {
      code,
      shortFa: meta?.shortFa || doc.movementLabel || doc.documentType,
      labelFa: meta?.labelFa || doc.movementLabel || doc.documentType,
      direction: meta?.direction || 'TRANSFER',
    };
  };

  const getMovementTone = (direction: string): FioriStatusTone => {
    if (direction === 'IN') return 'positive';
    if (direction === 'OUT') return 'negative';
    if (direction === 'QM') return 'critical';
    return 'brand';
  };

  const filteredDocs = useMemo(() => {
    const base = documents.filter(doc => {
      const mv = getMovementInfo(doc);

      if (kpiPreset === 'POSTED' && doc.postingStatus !== 'POSTED') return false;
      if (kpiPreset === 'RECEIPT_101' && mv.code !== '101' && mv.code !== '561')
        return false;
      if (kpiPreset === 'ISSUE_261' && mv.code !== '261' && mv.code !== '601')
        return false;
      if (
        kpiPreset === 'QM_TRANSFERS' &&
        mv.code !== '321' &&
        mv.code !== '322' &&
        mv.code !== '344'
      )
        return false;
      if (
        kpiPreset === 'REVERSAL' &&
        doc.documentType !== 'REVERSAL' &&
        doc.postingStatus !== 'REVERSED'
      )
        return false;

      if (selectedTypeFilter !== 'ALL' && doc.documentType !== selectedTypeFilter)
        return false;
      if (selectedMovementFilter !== 'ALL' && mv.code !== selectedMovementFilter)
        return false;
      if (
        selectedWarehouseFilter !== 'ALL' &&
        doc.warehouseId !== selectedWarehouseFilter &&
        doc.targetWarehouseId !== selectedWarehouseFilter
      ) {
        return false;
      }
      if (selectedStatusFilter !== 'ALL' && doc.postingStatus !== selectedStatusFilter)
        return false;

      if (fromDateIso || toDateIso) {
        const docIso = normalizeDocDateToIso(doc.documentDate, doc.createdAt);
        if (fromDateIso && (!docIso || docIso < fromDateIso)) return false;
        if (toDateIso && (!docIso || docIso > toDateIso)) return false;
      }

      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase();
        const matchesDocNo = doc.documentNumber.toLowerCase().includes(q);
        const matchesRef = doc.referenceNumber
          ? doc.referenceNumber.toLowerCase().includes(q)
          : false;
        const matchesNote = doc.auditNote
          ? doc.auditNote.toLowerCase().includes(q)
          : false;
        const matchesContract = doc.contractNumber
          ? doc.contractNumber.toLowerCase().includes(q)
          : false;
        const matchesMv =
          mv.code.toLowerCase().includes(q) || mv.shortFa.toLowerCase().includes(q);
        const matchesLine = doc.lines.some(
          l =>
            l.partName.toLowerCase().includes(q) ||
            l.partCode.toLowerCase().includes(q) ||
            (l.lotNumber && l.lotNumber.toLowerCase().includes(q)) ||
            (l.heatNumber && l.heatNumber.toLowerCase().includes(q))
        );
        if (
          !matchesDocNo &&
          !matchesRef &&
          !matchesNote &&
          !matchesContract &&
          !matchesMv &&
          !matchesLine
        ) {
          return false;
        }
      }
      return true;
    });

    return [...base].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'documentNumber':
          cmp = a.documentNumber.localeCompare(b.documentNumber, 'en');
          break;
        case 'movementCode':
          cmp = getMovementInfo(a).code.localeCompare(getMovementInfo(b).code, 'en');
          break;
        case 'documentDate': {
          const da = normalizeDocDateToIso(a.documentDate, a.createdAt);
          const db = normalizeDocDateToIso(b.documentDate, b.createdAt);
          cmp = da.localeCompare(db);
          break;
        }
        case 'totalWeightKg':
          cmp = a.totalWeightKg - b.totalWeightKg;
          break;
        case 'postingStatus':
          cmp = a.postingStatus.localeCompare(b.postingStatus, 'en');
          break;
        case 'createdAt':
        default:
          cmp =
            new Date(a.createdAt || a.documentDate).getTime() -
            new Date(b.createdAt || b.documentDate).getTime();
          break;
      }
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  }, [
    documents,
    kpiPreset,
    selectedTypeFilter,
    selectedMovementFilter,
    selectedWarehouseFilter,
    selectedStatusFilter,
    fromDateIso,
    toDateIso,
    searchTerm,
    sortKey,
    sortDirection,
  ]);

  const totalPages = Math.max(1, Math.ceil(filteredDocs.length / pageSize));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const pagedDocs = filteredDocs.slice(
    (safeCurrentPage - 1) * pageSize,
    safeCurrentPage * pageSize
  );

  // Statistics for ALP Visual Filter Micro-Cards
  const postedCount = documents.filter(d => d.postingStatus === 'POSTED').length;
  const reversalCount = documents.filter(
    d => d.documentType === 'REVERSAL' || d.postingStatus === 'REVERSED'
  ).length;
  const qmTransfersCount = documents.filter(d => {
    const c = getMovementInfo(d).code;
    return c === '321' || c === '322' || c === '344';
  }).length;
  const totalWeightIn = documents
    .filter(d => {
      const c = getMovementInfo(d).code;
      return (c === '101' || c === '561') && d.postingStatus === 'POSTED';
    })
    .reduce((s, d) => s + d.totalWeightKg, 0);
  const totalWeightOut = documents
    .filter(d => {
      const c = getMovementInfo(d).code;
      return (c === '261' || c === '601') && d.postingStatus === 'POSTED';
    })
    .reduce((s, d) => s + d.totalWeightKg, 0);

  const filteredWeightSum = useMemo(
    () => filteredDocs.reduce((sum, d) => sum + (d.totalWeightKg || 0), 0),
    [filteredDocs]
  );

  const handleExportCsv = () => {
    const headers = [
      'شماره سند',
      'کد حرکت SAP',
      'شرح حرکت',
      'نوع سند',
      'تاریخ سند (شمسی)',
      'وضعیت قطعی',
      'انبار مبدأ',
      'انبار مقصد',
      'مالکیت',
      'قرارداد ساپکو',
      'شماره ارجاع / دستور ساخت',
      'تعداد اقلام',
      'تعداد کل',
      'وزن کل (کیلوگرم)',
      'سند ابطال‌شده',
      'یادداشت ممیزی',
      'ثبت‌کننده',
    ];

    const rows = filteredDocs.map(d => {
      const mv = getMovementInfo(d);
      return [
        d.documentNumber,
        mv.code,
        mv.shortFa,
        docTypeLabels[d.documentType]?.label || d.documentType,
        formatToJalali(d.documentDate),
        statusLabels[d.postingStatus]?.label || d.postingStatus,
        d.warehouseName,
        d.targetWarehouseName || '-',
        d.ownership === 'SAPCO_SUPPLIER_OWNED' ? 'امانی ساپکو' : 'ملکی کارخانه',
        d.contractNumber || '-',
        d.referenceNumber || '-',
        d.lines.length,
        d.totalQuantity,
        d.totalWeightKg,
        d.reversalOfDocNumber || '-',
        d.adjustmentReason || d.auditNote || '-',
        d.createdByName,
      ];
    });

    exportToCsv(`اسناد_حرکت_انبار_SAP_${Date.now()}`, headers, rows);
  };

  const handleConfirmReversal = async () => {
    if (!reversalDoc) return;
    if (!reversalReason.trim() || reversalReason.trim().length < 5) {
      setReversalError(
        'لطفاً دلیل مستند و مشخصی برای ابطال و صدور سند معکوس درج کنید (حداقل ۵ کاراکتر).'
      );
      return;
    }

    setIsSubmittingReversal(true);
    setReversalError(null);

    try {
      const res = await onReverseDocument(reversalDoc.id, reversalReason.trim());
      if (res.success) {
        setReversalDoc(null);
        setReversalReason('');
      } else {
        setReversalError(res.message);
      }
    } catch (err: any) {
      setReversalError(err.message || 'خطا در ارتباط با سرور');
    } finally {
      setIsSubmittingReversal(false);
    }
  };

  const roleAllowedToReverse =
    !userRole ||
    ['ADMIN', 'WAREHOUSE_KEEPER', 'PRODUCTION_MANAGER'].includes(userRole);

  const activeFiltersCount = [
    kpiPreset !== 'ALL',
    selectedTypeFilter !== 'ALL',
    selectedMovementFilter !== 'ALL',
    selectedWarehouseFilter !== 'ALL',
    selectedStatusFilter !== 'ALL',
    Boolean(fromDateIso),
    Boolean(toDateIso),
    Boolean(searchTerm.trim()),
  ].filter(Boolean).length;

  const hasActiveFilters = activeFiltersCount > 0;

  const resetAllFilters = () => {
    setSearchTerm('');
    setSelectedTypeFilter('ALL');
    setSelectedMovementFilter('ALL');
    setSelectedWarehouseFilter('ALL');
    setSelectedStatusFilter('ALL');
    setFromDateJalali('');
    setFromDateIso('');
    setToDateJalali('');
    setToDateIso('');
    setKpiPreset('ALL');
    setCurrentPage(1);
    router.clearDocQuery();
  };

  const kpiFilters: AlpVisualKpiItem[] = [
    {
      id: 'ALL',
      label: 'کل اسناد قطعی (Posted)',
      value: postedCount,
      unit: 'سند',
      tone: 'brand',
      active: kpiPreset === 'ALL' || kpiPreset === 'POSTED',
      onClick: () => {
        setKpiPreset(prev => (prev === 'POSTED' ? 'ALL' : 'POSTED'));
        setCurrentPage(1);
      },
      sublabel: 'کل دفتر کل انبار (MIGO)',
    },
    {
      id: 'RECEIPT_101',
      label: 'رسید ورود به انبار (۱۰۱ / ۵۶۱)',
      value: Math.round(totalWeightIn),
      unit: 'kg',
      tone: 'positive',
      active: kpiPreset === 'RECEIPT_101',
      onClick: () => {
        setKpiPreset(prev => (prev === 'RECEIPT_101' ? 'ALL' : 'RECEIPT_101'));
        setCurrentPage(1);
      },
      sublabel: 'ورود مواد اولیه و محصول تولیدی',
    },
    {
      id: 'ISSUE_261',
      label: 'حواله مصرف و تحویل (۲۶۱ / ۶۰۱)',
      value: Math.round(totalWeightOut),
      unit: 'kg',
      tone: 'critical',
      active: kpiPreset === 'ISSUE_261',
      onClick: () => {
        setKpiPreset(prev => (prev === 'ISSUE_261' ? 'ALL' : 'ISSUE_261'));
        setCurrentPage(1);
      },
      sublabel: 'مصرف پای کار و ارسال به خودروساز',
    },
    {
      id: 'QM_TRANSFERS',
      label: 'انتقال کیفی QM (۳۲۱ / ۳۲۲ / ۳۴۴)',
      value: qmTransfersCount,
      unit: 'سند کیفی',
      tone: 'brand',
      active: kpiPreset === 'QM_TRANSFERS',
      onClick: () => {
        setKpiPreset(prev => (prev === 'QM_TRANSFERS' ? 'ALL' : 'QM_TRANSFERS'));
        setCurrentPage(1);
      },
      sublabel: 'جابجایی بین آزاد، قرنطینه و مسدود',
    },
    {
      id: 'REVERSAL',
      label: 'ابطال و سند برگشتی (۱۰۲ / ۲۶۲ / ۶۰۲)',
      value: reversalCount,
      unit: 'مورد',
      tone: 'negative',
      active: kpiPreset === 'REVERSAL',
      onClick: () => {
        setKpiPreset(prev => (prev === 'REVERSAL' ? 'ALL' : 'REVERSAL'));
        setCurrentPage(1);
      },
      sublabel: 'بدون حذف فیزیکی (Immutable)',
    },
  ];

  const getQualityStatusMeta = (
    qs: string
  ): { label: string; tone: FioriStatusTone } => {
    if (qs === 'AVAILABLE') {
      return { label: 'آزاد (Unrestricted)', tone: 'positive' };
    }
    if (qs === 'QUALITY_BLOCKED' || qs === 'REJECTED' || qs === 'BLOCKED') {
      return { label: 'مسدود (Blocked)', tone: 'negative' };
    }
    return { label: 'در حال کنترل کیفی (QI)', tone: 'critical' };
  };

  const kpiToneStyles = (
    tone?: AlpVisualKpiItem['tone'],
    active?: boolean
  ): { card: string; value: string } => {
    const valueCls =
      tone === 'positive'
        ? 'text-[var(--fiori-positive)]'
        : tone === 'critical'
        ? 'text-[var(--fiori-critical)]'
        : tone === 'negative'
        ? 'text-[var(--fiori-negative)]'
        : tone === 'brand'
        ? 'text-[var(--fiori-brand)]'
        : 'text-[var(--fiori-text-primary)]';

    if (active) {
      return {
        card: 'border-[var(--fiori-brand)] bg-[var(--fiori-brand-bg)] shadow-[0_0_0_1px_var(--fiori-brand-border)]',
        value: valueCls,
      };
    }
    return {
      card: 'border-[var(--fiori-border-default)] bg-[var(--fiori-bg-surface)] hover:border-[var(--fiori-brand)] hover:bg-[var(--fiori-bg-hover)]/40',
      value: valueCls,
    };
  };

  const ledgerColumns: FioriTableColumn<InventoryDocument>[] = [
    {
      key: 'documentNumber',
      header: 'شماره سند',
      sortable: true,
      nowrap: true,
      isMono: true,
      render: doc => (
        <span onClick={e => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => setSelectedObjectDoc(doc)}
            className="sap-doc-link fiori-ltr-code font-mono font-semibold cursor-pointer"
            title="باز کردن Object Page سند"
          >
            {doc.documentNumber}
          </button>
        </span>
      ),
    },
    {
      key: 'movementCode',
      header: 'کد حرکت SAP',
      sortable: true,
      nowrap: true,
      render: doc => {
        const mv = getMovementInfo(doc);
        return (
          <FioriObjectStatus
            tone={getMovementTone(mv.direction)}
            label={`MvT ${mv.code}`}
            variant="badge"
            size="sm"
            ltrCode
          />
        );
      },
    },
    {
      key: 'operation',
      header: 'شرح عملیات',
      nowrap: true,
      render: doc => {
        const mv = getMovementInfo(doc);
        const typeInfo = docTypeLabels[doc.documentType] || {
          label: doc.documentType,
          colorClass: 'text-[var(--fiori-text-primary)]',
        };
        return (
          <div className="flex items-center gap-1.5">
            <span className={`font-semibold ${typeInfo.colorClass}`}>
              {mv.shortFa}
            </span>
            {doc.reversalOfDocNumber && (
              <span className="text-[11px] text-[var(--fiori-negative)]">
                · برگشت از{' '}
                <span className="fiori-ltr-code font-mono">
                  {doc.reversalOfDocNumber}
                </span>
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: 'documentDate',
      header: 'تاریخ (شمسی)',
      sortable: true,
      nowrap: true,
      isMono: true,
      cellClassName: 'text-[var(--fiori-text-secondary)]',
      render: doc => (
        <span className="fiori-ltr-code font-mono">
          {formatToJalali(doc.documentDate)}
        </span>
      ),
    },
    {
      key: 'warehouse',
      header: 'انبار مبدأ / مقصد',
      nowrap: true,
      hideBelow: 'md',
      cellClassName: 'text-[var(--fiori-text-primary)]',
      render: doc => (
        <span>
          <span>{doc.warehouseName}</span>
          {doc.targetWarehouseName && (
            <span className="text-[var(--fiori-text-secondary)]">
              {' '}
              ← {doc.targetWarehouseName}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'itemsAndRef',
      header: 'اقلام و بچ / مرجع',
      nowrap: true,
      render: doc => {
        const firstLine = doc.lines[0];
        return (
          <div
            className="flex items-center gap-1.5"
            onClick={e => e.stopPropagation()}
          >
            <span>{firstLine?.partName || '—'}</span>
            {doc.lines.length > 1 && (
              <span className="text-[11px] text-[var(--fiori-text-secondary)] font-mono">
                (+{toPersianDigits(doc.lines.length - 1)})
              </span>
            )}
            {doc.referenceNumber && (
              <button
                type="button"
                onClick={() =>
                  router.traceDocument(doc.referenceNumber!, 'WIP_TRACEABILITY')
                }
                className="sap-doc-link fiori-ltr-code text-[11px] font-mono cursor-pointer mr-1"
                title="رهگیری دستور ساخت یا بارنامه"
              >
                {doc.referenceNumber}
              </button>
            )}
          </div>
        );
      },
    },
    {
      key: 'totalWeightKg',
      header: 'مقدار / وزن',
      sortable: true,
      nowrap: true,
      isMono: true,
      render: doc => {
        const firstLine = doc.lines[0];
        return (
          <div className="font-mono font-semibold text-[var(--fiori-text-primary)]">
            {formatNumber(doc.totalQuantity)}{' '}
            {firstLine?.unit === 'KG' ? 'kg' : 'عدد'} ·{' '}
            <span className="text-[var(--fiori-text-secondary)] font-normal">
              {formatWeightKg(doc.totalWeightKg)}
            </span>
          </div>
        );
      },
    },
    {
      key: 'postingStatus',
      header: 'وضعیت',
      sortable: true,
      nowrap: true,
      render: doc => {
        const statusInfo = statusLabels[doc.postingStatus] || {
          label: doc.postingStatus,
          tone: 'critical' as FioriStatusTone,
          objectPageTone: 'critical' as const,
        };
        return (
          <FioriObjectStatus
            tone={statusInfo.tone}
            label={statusInfo.label}
            variant="badge"
            size="sm"
            icon
          />
        );
      },
    },
    {
      key: 'actions',
      header: 'شیء و ابطال',
      align: 'left',
      nowrap: true,
      render: doc => {
        const mv = getMovementInfo(doc);
        const canReverse =
          roleAllowedToReverse &&
          doc.postingStatus === 'POSTED' &&
          doc.documentType !== 'REVERSAL';
        const revMvCode = getSapMovementReversal(mv.code);

        return (
          <div
            className="flex items-center justify-end gap-1.5"
            onClick={e => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setSelectedObjectDoc(doc)}
              className="sap-btn-standard px-2 py-0.5 text-[11px] inline-flex items-center gap-1 cursor-pointer"
              title="مشاهده جزئیات و جریان اسناد (Object Page)"
            >
              <Eye className="w-3 h-3 text-[var(--fiori-brand)]" />
              <span>جزئیات</span>
            </button>

            {canReverse && (
              <button
                type="button"
                onClick={() => {
                  setReversalDoc(doc);
                  setReversalReason('');
                  setReversalError(null);
                }}
                className="sap-btn-standard px-2 py-0.5 text-[11px] !text-[var(--fiori-negative)] !border-[var(--fiori-negative-border)] hover:!bg-[var(--fiori-negative-bg)] inline-flex items-center gap-1 cursor-pointer"
                title={`صدور سند معکوس با کد حرکت ${revMvCode}`}
              >
                <RotateCcw className="w-3 h-3" />
                <span>
                  ابطال (<span className="fiori-ltr-code font-mono">{revMvCode}</span>)
                </span>
              </button>
            )}
          </div>
        );
      },
    },
  ];

  const objectLineColumns: FioriTableColumn<InventoryDocumentLine>[] = [
    {
      key: 'lineNumber',
      header: 'ردیف',
      nowrap: true,
      isMono: true,
      cellClassName: 'text-[var(--fiori-text-secondary)]',
      render: (_line, idx) => toPersianDigits(idx + 1),
    },
    {
      key: 'partCode',
      header: 'کد کالا',
      nowrap: true,
      isMono: true,
      isLtrCode: true,
      cellClassName: 'font-semibold text-[var(--fiori-brand)]',
      render: line => line.partCode,
    },
    {
      key: 'partName',
      header: 'شرح کالا',
      cellClassName: 'font-medium text-[var(--fiori-text-primary)]',
      render: line => line.partName,
    },
    {
      key: 'lotNumber',
      header: 'کویل‌پک / لوت',
      nowrap: true,
      isMono: true,
      isLtrCode: true,
      render: line => line.lotNumber || '—',
    },
    {
      key: 'heatNumber',
      header: 'شماره ذوب',
      nowrap: true,
      isMono: true,
      isLtrCode: true,
      hideBelow: 'md',
      render: line => line.heatNumber || '—',
    },
    {
      key: 'locationCode',
      header: 'جایگاه',
      nowrap: true,
      isMono: true,
      isLtrCode: true,
      hideBelow: 'md',
      cellClassName: 'text-[var(--fiori-text-secondary)]',
      render: line => line.locationCode || '—',
    },
    {
      key: 'qualityStatus',
      header: 'وضعیت کیفی',
      nowrap: true,
      render: line => {
        const qsInfo = getQualityStatusMeta(line.qualityStatus);
        return (
          <FioriObjectStatus
            tone={qsInfo.tone}
            label={qsInfo.label}
            variant="dot"
            size="sm"
          />
        );
      },
    },
    {
      key: 'quantity',
      header: 'تعداد / مقدار',
      nowrap: true,
      isMono: true,
      cellClassName: 'font-semibold',
      render: line => `${formatNumber(line.quantity)} ${line.unit}`,
    },
    {
      key: 'quantityKg',
      header: 'وزن (kg)',
      nowrap: true,
      isMono: true,
      cellClassName: 'font-semibold',
      render: line => formatWeightKg(line.quantityKg),
    },
  ];

  return (
    <div className="space-y-3" dir="rtl">
      <FioriDynamicPage
        title="دفتر کل اسناد انبار و کدهای حرکت SAP MM"
        subtitle="ثبت تغییرناپذیر تراکنش‌ها (کدهای ۱۰۱، ۱۰۲، ۲۶۱، ۲۶۲، ۳۱۱، ۳۲۱، ۳۲۲، ۳۴۴، ۶۰۱)؛ کلیک روی هر سطر برای نمایش Object Page و جریان اسناد"
        breadcrumbs={[
          { label: 'انبار و لجستیک' },
          { label: 'دفتر کل و تاریخچه اسناد حرکت (MIGO)' },
        ]}
        status={
          <FioriObjectStatus
            tone="info"
            label="دفتر کل تغییرناپذیر"
            variant="badge"
            size="sm"
            icon
          />
        }
        activeFiltersCount={activeFiltersCount}
        onResetFilters={resetAllFilters}
        headerActions={
          <>
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer whitespace-nowrap disabled:opacity-60"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
              />
              <span>به‌روزرسانی</span>
            </button>
            <button
              type="button"
              onClick={handleExportCsv}
              className="sap-btn-emphasized flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              <span>خروجی اکسل (CSV)</span>
            </button>
          </>
        }
        kpiStrip={
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {kpiFilters.map(kpi => {
              const cls = kpiToneStyles(kpi.tone, kpi.active);
              return (
                <button
                  key={kpi.id}
                  type="button"
                  onClick={kpi.onClick}
                  disabled={!kpi.onClick}
                  className={`text-right p-2.5 rounded-[var(--fiori-radius-md)] border transition-colors fiori-focus-ring ${
                    kpi.onClick ? 'cursor-pointer' : 'cursor-default'
                  } ${cls.card}`}
                >
                  <div className="text-[11px] text-[var(--fiori-text-secondary)] truncate">
                    {kpi.label}
                  </div>
                  <div
                    className={`text-base font-semibold font-mono tabular-nums mt-0.5 ${cls.value}`}
                  >
                    {typeof kpi.value === 'number'
                      ? toPersianDigits(kpi.value.toLocaleString('en-US'))
                      : toPersianDigits(kpi.value)}
                    {kpi.unit && (
                      <span className="text-[10px] font-normal text-[var(--fiori-text-secondary)] mr-1">
                        {kpi.unit}
                      </span>
                    )}
                  </div>
                  {kpi.sublabel && (
                    <div className="text-[10px] text-[var(--fiori-text-muted)] mt-0.5 truncate">
                      {kpi.sublabel}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        }
        filterBar={
          <div className="space-y-2">
            {/* Row 1: Search + Primary Dropdowns */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[220px]">
                <Search className="w-3.5 h-3.5 text-[var(--fiori-brand)] absolute right-2.5 top-2 pointer-events-none" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={e => {
                    setSearchTerm(e.target.value);
                    setCurrentPage(1);
                  }}
                  placeholder="جستجوی شماره سند، کد حرکت (مثلاً 261)، دستور ساخت، کلاف، ذوب یا کالا..."
                  className="fiori-input w-full pr-8 pl-7 py-1.5"
                />
                {searchTerm && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchTerm('');
                      setCurrentPage(1);
                    }}
                    aria-label="پاک کردن جستجو"
                    className="absolute left-2 top-1.5 p-0.5 rounded text-[var(--fiori-text-muted)] hover:text-[var(--fiori-text-primary)] cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              <select
                value={selectedMovementFilter}
                onChange={e => {
                  setSelectedMovementFilter(e.target.value);
                  setCurrentPage(1);
                }}
                aria-label="فیلتر کد حرکت SAP"
                className="fiori-input px-2.5 py-1.5 font-mono cursor-pointer"
              >
                <option value="ALL">همه کدهای حرکت SAP</option>
                {(Object.keys(SAP_MOVEMENT_CATALOG) as SapMovementType[]).map(
                  code => (
                    <option key={code} value={code}>
                      {SAP_MOVEMENT_CATALOG[code].labelFa}
                    </option>
                  )
                )}
              </select>

              <select
                value={selectedTypeFilter}
                onChange={e => {
                  setSelectedTypeFilter(e.target.value);
                  setCurrentPage(1);
                }}
                aria-label="فیلتر نوع سند"
                className="fiori-input px-2.5 py-1.5 cursor-pointer"
              >
                <option value="ALL">همه انواع اسناد</option>
                <option value="RECEIPT_RAW_MATERIAL">رسید مواد اولیه</option>
                <option value="ISSUE_RAW_MATERIAL">حواله مصرف خط تولید</option>
                <option value="RECEIPT_FINISHED_GOODS">رسید محصول نهایی</option>
                <option value="DELIVERY_CUSTOMER">تحویل به مشتری</option>
                <option value="TRANSFER">انتقال بین‌انباری</option>
                <option value="STOCK_STATUS_TRANSFER">انتقال وضعیت کیفی (QM)</option>
                <option value="ADJUSTMENT">تعدیل انبارگردانی</option>
                <option value="REVERSAL">سند معکوس / ابطال</option>
                <option value="OPENING_BALANCE">موجودی اول دوره</option>
              </select>

              <select
                value={selectedWarehouseFilter}
                onChange={e => {
                  setSelectedWarehouseFilter(e.target.value);
                  setCurrentPage(1);
                }}
                aria-label="فیلتر انبار"
                className="fiori-input px-2.5 py-1.5 cursor-pointer"
              >
                <option value="ALL">همه انبارها</option>
                {warehouses.map(w => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>

              <select
                value={selectedStatusFilter}
                onChange={e => {
                  setSelectedStatusFilter(e.target.value);
                  setCurrentPage(1);
                }}
                aria-label="فیلتر وضعیت سند"
                className="fiori-input px-2.5 py-1.5 cursor-pointer"
              >
                <option value="ALL">همه وضعیت‌ها</option>
                <option value="POSTED">قطعی (Posted)</option>
                <option value="REVERSED">ابطال‌شده (Reversed)</option>
                <option value="UNPOSTED">پیش‌نویس (Unposted)</option>
              </select>
            </div>

            {/* Row 2: Jalali Date Range Filter */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 items-center">
              <JalaliDatePicker
                value={fromDateJalali}
                placeholder="از تاریخ (شمسی)..."
                onChange={(jalali, iso) => {
                  setFromDateJalali(jalali);
                  setFromDateIso(iso);
                  setCurrentPage(1);
                }}
              />
              <JalaliDatePicker
                value={toDateJalali}
                placeholder="تا تاریخ (شمسی)..."
                onChange={(jalali, iso) => {
                  setToDateJalali(jalali);
                  setToDateIso(iso);
                  setCurrentPage(1);
                }}
              />
              {(fromDateJalali || toDateJalali) && (
                <div className="sm:col-span-2 flex items-center gap-2 text-[11px] text-[var(--fiori-text-secondary)]">
                  <span>
                    بازه فعال:{' '}
                    <strong className="font-mono text-[var(--fiori-text-primary)]">
                      {fromDateJalali ? toPersianDigits(fromDateJalali) : 'ابتدا'}
                    </strong>{' '}
                    تا{' '}
                    <strong className="font-mono text-[var(--fiori-text-primary)]">
                      {toDateJalali ? toPersianDigits(toDateJalali) : 'امروز'}
                    </strong>
                  </span>
                </div>
              )}
            </div>
          </div>
        }
      >
        {showAuditNotice && (
          <FioriMessageStrip
            tone="info"
            compact
            onClose={() => setShowAuditNotice(false)}
          >
            کلیه اسناد قطعی انبار مطابق استاندارد SAP MM به صورت تغییرناپذیر ثبت می‌شوند؛ برای اصلاح، از عملیات{' '}
            <strong>صدور سند معکوس (Reversal)</strong> در ردیف سند یا Object Page استفاده کنید.
          </FioriMessageStrip>
        )}

        {initialSearchTerm && searchTerm === initialSearchTerm && (
          <FioriMessageStrip
            tone="warning"
            compact
            actions={
              <button
                type="button"
                onClick={resetAllFilters}
                className="sap-btn-standard px-2 py-0.5 text-[11px] cursor-pointer"
              >
                نمایش همه اسناد
              </button>
            }
          >
            لیست اسناد بر اساس ارجاع ردیابی‌شده{' '}
            <strong className="fiori-ltr-code font-mono">{initialSearchTerm}</strong>{' '}
            فیلتر شده است.
          </FioriMessageStrip>
        )}

        <FioriDataTable
          columns={ledgerColumns}
          data={pagedDocs}
          rowKey={doc => doc.id}
          loading={loading}
          onRowClick={doc => setSelectedObjectDoc(doc)}
          rowClassName={doc =>
            doc.postingStatus === 'REVERSED'
              ? 'bg-[var(--fiori-bg-subtle)] text-[var(--fiori-text-muted)] hover:!bg-[var(--fiori-negative-bg)]/45'
              : ''
          }
          sortKey={sortKey}
          sortDirection={sortDirection}
          onSortChange={(key, dir) => {
            setSortKey(key);
            setSortDirection(dir);
            setCurrentPage(1);
          }}
          toolbar={
            <FioriToolbar
              variant="table"
              title="فهرست اسناد حرکت کالا (Material Documents)"
              count={filteredDocs.length}
              countLabel="سند"
              endContent={
                <FioriObjectStatus
                  tone="neutral"
                  variant="badge"
                  size="sm"
                  label={`مجموع وزن فیلترشده: ${formatWeightKg(filteredWeightSum)}`}
                />
              }
            />
          }
          emptyState={
            <EmptyState
              compact
              variant={hasActiveFilters ? 'FILTER_NO_MATCH' : 'NO_DATA'}
              title={
                hasActiveFilters
                  ? 'هیچ سند انباری منطبق با فیلترهای انتخابی یافت نشد'
                  : 'هنوز هیچ سند حرکت انباری ثبت نشده است'
              }
              description={
                hasActiveFilters
                  ? 'فیلترهای کد حرکت، نوع سند، انبار، بازه تاریخ شمسی یا عبارت جستجو را تغییر دهید.'
                  : 'با ثبت اولین حواله، رسید یا انتقال بین‌انباری، اسناد در این دفتر کل نمایش داده می‌شوند.'
              }
              actionLabel={hasActiveFilters ? 'پاکسازی همه فیلترها' : undefined}
              onAction={hasActiveFilters ? resetAllFilters : undefined}
            />
          }
          pagination={{
            currentPage: safeCurrentPage,
            pageSize,
            totalItems: filteredDocs.length,
            onPageChange: setCurrentPage,
            pageSizeOptions: [16, 30, 50],
            onPageSizeChange: nextSize => {
              setPageSize(nextSize);
              setCurrentPage(1);
            },
          }}
        />
      </FioriDynamicPage>

      {/* SAP Fiori Object Page for Selected Material Document */}
      {activeObjectDoc &&
        (() => {
          const mv = getMovementInfo(activeObjectDoc);
          const statusInfo = statusLabels[activeObjectDoc.postingStatus] || {
            label: activeObjectDoc.postingStatus,
            tone: 'critical' as FioriStatusTone,
            objectPageTone: 'critical' as const,
          };
          const canReverse =
            roleAllowedToReverse &&
            activeObjectDoc.postingStatus === 'POSTED' &&
            activeObjectDoc.documentType !== 'REVERSAL';
          const revMvCode = getSapMovementReversal(mv.code);

          return (
            <FioriObjectPage
              isOpen={Boolean(activeObjectDoc)}
              onClose={() => setSelectedObjectDoc(null)}
              objectTypeLabel={`سند انبار SAP MM (MvT ${mv.code})`}
              objectId={activeObjectDoc.documentNumber}
              title={mv.labelFa}
              subtitle={`انبار مبدأ: ${activeObjectDoc.warehouseName}${
                activeObjectDoc.targetWarehouseName
                  ? ` ← مقصد: ${activeObjectDoc.targetWarehouseName}`
                  : ''
              } · ثبت‌کننده: ${activeObjectDoc.createdByName}`}
              statusText={statusInfo.label}
              statusTone={statusInfo.objectPageTone}
              documentFlowQuery={activeObjectDoc.documentNumber}
              onSelectDocumentFlowDoc={docNo => {
                const found = documents.find(d => d.documentNumber === docNo);
                if (found) {
                  setSelectedObjectDoc(found);
                } else {
                  router.traceDocument(docNo, 'WIP_TRACEABILITY');
                }
              }}
              headerActions={
                <>
                  <button
                    type="button"
                    onClick={() =>
                      router.traceDocument(
                        activeObjectDoc.documentNumber,
                        'WIP_TRACEABILITY'
                      )
                    }
                    className="sap-btn-standard px-2.5 py-1.5 text-xs flex items-center gap-1 cursor-pointer"
                  >
                    <Link2 className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
                    <span>ردیابی WIP</span>
                  </button>
                  {canReverse && (
                    <button
                      type="button"
                      onClick={() => {
                        setReversalDoc(activeObjectDoc);
                        setReversalReason('');
                        setReversalError(null);
                      }}
                      className="px-3 py-1.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-negative)] hover:opacity-90 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>
                        ابطال و صدور سند معکوس (
                        <span className="fiori-ltr-code font-mono">
                          {revMvCode}
                        </span>
                        )
                      </span>
                    </button>
                  )}
                </>
              }
              kpis={[
                {
                  label: 'کد حرکت SAP',
                  value: `MvT ${mv.code}`,
                  tone: 'brand',
                },
                {
                  label: 'تاریخ ثبت سند (شمسی)',
                  value: formatToJalali(activeObjectDoc.documentDate),
                  tone: 'default',
                },
                {
                  label: 'تعداد / مقدار کل',
                  value: formatNumber(activeObjectDoc.totalQuantity),
                  tone: 'default',
                },
                {
                  label: 'وزن خالص کل',
                  value: formatWeightKg(activeObjectDoc.totalWeightKg),
                  tone: 'positive',
                },
              ]}
              tabs={[
                {
                  id: 'lines',
                  label: `اقلام سند (${toPersianDigits(
                    activeObjectDoc.lines.length
                  )})`,
                  content: (
                    <div className="space-y-3">
                      {(activeObjectDoc.adjustmentReason ||
                        activeObjectDoc.auditNote) && (
                        <FioriMessageStrip
                          tone="warning"
                          title="یادداشت / علت سند"
                          compact
                        >
                          {activeObjectDoc.adjustmentReason ||
                            activeObjectDoc.auditNote}
                        </FioriMessageStrip>
                      )}

                      <FioriDataTable
                        columns={objectLineColumns}
                        data={activeObjectDoc.lines}
                        rowKey={(line, idx) => line.id || `${idx}`}
                        bordered
                        compact
                      />
                    </div>
                  ),
                },
                {
                  id: 'header',
                  label: 'سربرگ و اطلاعات کنترلی',
                  content: (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                      <div className="p-3 bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] space-y-1.5">
                        <div className="font-semibold text-[var(--fiori-text-primary)]">
                          اطلاعات انبار و مالکیت
                        </div>
                        <div>
                          انبار مبدأ:{' '}
                          <strong>{activeObjectDoc.warehouseName}</strong>
                        </div>
                        <div>
                          انبار مقصد:{' '}
                          <strong>
                            {activeObjectDoc.targetWarehouseName || '—'}
                          </strong>
                        </div>
                        <div>
                          مالکیت:{' '}
                          <strong>
                            {activeObjectDoc.ownership === 'SAPCO_SUPPLIER_OWNED'
                              ? 'امانی ساپکو'
                              : 'ملکی شرکت'}
                          </strong>
                        </div>
                      </div>

                      <div className="p-3 bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] space-y-1.5">
                        <div className="font-semibold text-[var(--fiori-text-primary)]">
                          مرجع و زنجیره سفارش
                        </div>
                        <div>
                          شماره قرارداد:{' '}
                          <strong className="fiori-ltr-code font-mono">
                            {activeObjectDoc.contractNumber || '—'}
                          </strong>
                        </div>
                        <div>
                          شماره ارجاع / MO:{' '}
                          <strong className="fiori-ltr-code font-mono">
                            {activeObjectDoc.referenceNumber || '—'}
                          </strong>
                        </div>
                        <div>
                          نوع مرجع:{' '}
                          <strong className="fiori-ltr-code font-mono">
                            {activeObjectDoc.referenceType || '—'}
                          </strong>
                        </div>
                      </div>

                      <div className="p-3 bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] space-y-1.5">
                        <div className="font-semibold text-[var(--fiori-text-primary)]">
                          حسابرسی و تغییرناپذیری
                        </div>
                        <div>
                          ثبت‌کننده:{' '}
                          <strong>{activeObjectDoc.createdByName}</strong>
                        </div>
                        <div>
                          تأییدکننده قطعی:{' '}
                          <strong>
                            {activeObjectDoc.postedByName || '—'}
                          </strong>
                        </div>
                        <div>
                          سند معکوس‌شده:{' '}
                          <strong className="fiori-ltr-code font-mono">
                            {activeObjectDoc.reversalOfDocNumber || '—'}
                          </strong>
                        </div>
                      </div>
                    </div>
                  ),
                },
              ]}
            />
          );
        })()}

      {/* Reversal Confirmation Dialog (SAP Horizon FioriDialog) */}
      <FioriDialog
        isOpen={Boolean(reversalDoc)}
        onClose={() => {
          if (!isSubmittingReversal) setReversalDoc(null);
        }}
        disableClose={isSubmittingReversal}
        tone="danger"
        size="md"
        icon={<RotateCcw className="w-5 h-5" />}
        title={
          reversalDoc
            ? `ابطال سند و صدور سند معکوس (کد حرکت ${getSapMovementReversal(
                getMovementInfo(reversalDoc).code
              )})`
            : 'ابطال سند'
        }
        subtitle={
          reversalDoc && (
            <span>
              سند شماره{' '}
              <span className="fiori-ltr-code font-mono text-[var(--fiori-text-primary)] font-semibold">
                {reversalDoc.documentNumber}
              </span>{' '}
              · تاریخ:{' '}
              <span className="fiori-ltr-code font-mono">
                {formatToJalali(reversalDoc.documentDate)}
              </span>
            </span>
          )
        }
        footer={
          <>
            <button
              type="button"
              onClick={() => setReversalDoc(null)}
              disabled={isSubmittingReversal}
              className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer disabled:opacity-50"
            >
              انصراف
            </button>
            <button
              type="button"
              onClick={handleConfirmReversal}
              disabled={isSubmittingReversal}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-[var(--fiori-negative)] hover:opacity-90 text-white rounded-[var(--fiori-radius-sm)] text-xs font-semibold cursor-pointer disabled:opacity-50 transition"
            >
              <RotateCcw
                className={`w-3.5 h-3.5 ${
                  isSubmittingReversal ? 'animate-spin' : ''
                }`}
              />
              <span>تأیید و صدور سند معکوس</span>
            </button>
          </>
        }
      >
        {reversalDoc && (
          <>
            <FioriMessageStrip
              tone="error"
              title="قانون تغییرناپذیری اسناد در SAP S/4HANA"
              icon={<ShieldAlert className="w-4 h-4 shrink-0" />}
            >
              هیچ سند قطعی قابلیت حذف (Delete) ندارد. با تأیید این فرم، سند معکوس
              جبرانی با کد حرکت{' '}
              <strong className="fiori-ltr-code font-mono">
                {getSapMovementReversal(getMovementInfo(reversalDoc).code)}
              </strong>{' '}
              صادر شده و تاریخچه ممیزی به صورت کامل حفظ می‌شود.
            </FioriMessageStrip>

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-[var(--fiori-text-primary)]">
                دلیل رسمی ابطال و صدور سند معکوس{' '}
                <span className="text-[var(--fiori-negative)]">*</span>
              </label>
              <textarea
                value={reversalReason}
                onChange={e => setReversalReason(e.target.value)}
                placeholder="مثال: اصلاح خطای اپراتور در ثبت باسکول، برگشت از دستور ساخت..."
                rows={3}
                className="fiori-input w-full p-2.5"
              />
            </div>

            {reversalError && (
              <FioriMessageStrip tone="error" compact>
                {reversalError}
              </FioriMessageStrip>
            )}
          </>
        )}
      </FioriDialog>
    </div>
  );
};
