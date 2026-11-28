import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Search,
  Download,
  Bookmark,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Printer,
  GitBranch,
  Trash2,
} from 'lucide-react';
import { formatNumber, toPersianDigits } from '../../utils/formatters';
import { formatToJalali } from '../../utils/jalali';
import { exportToCsv } from '../../utils/csvExport';
import { useErpRouter } from '../../context/RouterContext';
import { TableSkeleton } from '../common/Skeleton';
import { EmptyState } from '../common/EmptyState';
import {
  FioriDynamicPage,
  FioriDataTable,
  FioriTableColumn,
  FioriToolbar,
  FioriObjectStatus,
  FioriMessageStrip,
} from '../fiori/ui';

type CustomReportRow = Record<string, unknown>;

interface SavedReportConfig {
  id: string;
  name: string;
  reportType: string;
  selectedColumns?: string[];
  filters?: {
    materialGrade?: string;
    coilPackNumber?: string;
    warehouseId?: string;
    ownership?: string;
    contractId?: string;
    searchTerm?: string;
  };
  sortBy?: string;
  sortOrder?: string;
}

const REPORT_TYPES = [
  {
    id: 'THREE_TIER_STOCK',
    title: '۱. کنترل موجودی ۳ سطحی پس از مصرف (مواد اولیه، نیمه‌ساخته WIP، محصول نهایی)',
    badge: 'کنترل موجودی پس از مصرف',
    desc: 'نمایش دقیق کل ورود به سازمان، کل مصرف ثبت‌شده در تولید و مانده فعلی هر قطعه در هر ۳ سطح',
  },
  {
    id: 'END_TO_END_TRACEABILITY',
    title: '۲. زنجیره رهگیری سرتاسری اسناد و مواد (از ورود کلاف/ذوب تا مصرف و محصول)',
    badge: 'رهگیری از ابتدا تا مصرف',
    desc: 'ردیابی کامل شماره سند، نوع عملیات، شماره کلاف، شماره ذوب (Heat No) و دستور کار تولید',
  },
  {
    id: 'BOM_BACKFLUSH_VARIANCE',
    title: '۳. تطبیق مصرف واقعی مواد و اتصالات با ضرایب مهندسی BOM (Backflush)',
    badge: 'انحراف مصرف BOM',
    desc: 'مقایسه مصرف ورق DC01A، مهره جوشی M6 (۱۵ عدد) و پیچ ۶×۲۰ (۲ عدد) در برابر استاندارد BOM',
  },
  {
    id: 'COILS_SUMMARY',
    title: '۴. خلاصه وضعیت کلاف‌ها و رول‌های ورق (وزن اولیه، مصرف‌شده و مانده)',
    badge: 'رول و کلاف ورق',
    desc: 'گزارش تفکیکی رول‌های DC01A به همراه وزن اولیه، وزن مصرف‌شده در برش و مانده قابل مصرف',
  },
  {
    id: 'WAREHOUSE_STOCK',
    title: '۵. موجودی تفکیکی انبارها و ایستگاه‌های کاری (کاردکس انبار)',
    badge: 'تفکیک انبار',
    desc: 'موجودی فیزیکی، آزاد (ATP) و رزرو به تفکیک انبار مواد، پای کار جوش (WIP) و محصول نهایی',
  },
];

const PERSIAN_TO_ROW_KEY: Record<string, string> = {
  // Coils & Warehouse Stock
  'گرید متریال': 'materialGrade',
  'ضخامت (mm)': 'thicknessMm',
  'عرض (mm)': 'widthMm',
  'شماره پکینگ ساپکو': 'coilPackNumber',
  'تعداد کلاف': 'totalCoilsCount',
  'مجموع وزن اولیه (kg)': 'totalPhysicalWeightKg',
  'موجودی باقیمانده (kg)': 'totalRemainingWeightKg',
  'وضعیت': 'status',
  'کد قطعه': 'partCode',
  'نام کالا': 'partName',
  'انبار': 'warehouseName',
  'موقعیت (LOC)': 'locationCode',
  'موجودی فیزیکی': 'physicalQty',
  'رزرو': 'reservedQty',
  'مسدود کیفی': 'qualityBlockedQty',
  'موجودی آزاد': 'availableQty',
  'واحد': 'unit',
  // PostgreSQL Three-Tier Stock & End-to-End Traceability mappings
  'سطح کالا (Tier)': 'tier',
  'کد قطعه / کالا': 'partCode',
  'نام قطعه / ماده اولیه': 'partName',
  'کل ورود به سازمان': 'totalReceived',
  'کل مصرف / خروج ثبت‌شده': 'totalIssued',
  'موجودی فعلی پس از مصرف': 'onHand',
  'موجودی آزاد (ATP)': 'available',
  'نقطه سفارش (حداقل)': 'minStock',
  'وضعیت کنترلی': 'controlStatus',
  'اسناد مرتبط (کاردکس)': 'documents',
  'شماره سند رسمی': 'documentNumber',
  'نوع سند در زنجیره': 'documentType',
  'تاریخ سند': 'date',
  'مقدار': 'quantity',
  'وزن (KG)': 'weightKg',
  'شماره کلاف / لوت (Lot)': 'coilNumber',
  'شماره ذوب (Heat No)': 'heatNumber',
  'شماره دستور کار / مرجع': 'manufacturingOrder',
  'انبار / ایستگاه': 'warehouse',
};

const COLUMN_DISPLAY_LABEL: Record<string, string> = {
  tier: 'سطح کالا (Tier)',
  partCode: 'کد قطعه',
  partName: 'نام کالا / قطعه',
  unit: 'واحد',
  totalReceived: 'کل ورود به سازمان',
  totalIssued: 'کل مصرف / خروج ثبت‌شده',
  onHand: 'موجودی فعلی پس از مصرف',
  available: 'موجودی آزاد (ATP)',
  minStock: 'نقطه سفارش (حداقل)',
  controlStatus: 'وضعیت کنترلی',
  documents: 'اسناد مرتبط',
  sourceType: 'منبع رکورد',
  documentNumber: 'شماره سند رسمی',
  documentType: 'نوع سند',
  quantity: 'مقدار',
  weightKg: 'وزن (KG)',
  coilNumber: 'شماره کلاف / لوت',
  coilPackNumber: 'شماره کویل‌پک',
  heatNumber: 'شماره ذوب',
  manufacturingOrder: 'دستور کار / مرجع',
  operationStep: 'شماره ایستگاه',
  operationName: 'نام عملیات',
  plannedMachine: 'دستگاه برنامه‌ریزی‌شده',
  warehouse: 'انبار / ایستگاه',
  contractNumber: 'شماره قرارداد',
  date: 'تاریخ سند',
};

const getColumnLabel = (col: string): string => COLUMN_DISPLAY_LABEL[col] || col;

const resolveCellValue = (row: CustomReportRow, col: string): unknown => {
  if (row[col] !== undefined) return row[col];
  const mappedKey = PERSIAN_TO_ROW_KEY[col];
  if (mappedKey && row[mappedKey] !== undefined) return row[mappedKey];
  return undefined;
};

export const CustomReportsView: React.FC = () => {
  const { traceDocument } = useErpRouter();
  const [reportType, setReportType] = useState<string>('THREE_TIER_STOCK');
  const [materialGrade, setMaterialGrade] = useState('');
  const [coilPackNumber, setCoilPackNumber] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [ownership, setOwnership] = useState('');
  const [contractId, setContractId] = useState('');
  const [searchTerm, setSearchTerm] = useState('');

  const [loading, setLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportData, setReportData] = useState<{
    columns: string[];
    rows: CustomReportRow[];
    summary: Record<string, unknown>;
  }>({ columns: [], rows: [], summary: {} });

  // Dynamic Column Selection & Sorting for Custom Report Building
  const [selectedColumns, setSelectedColumns] = useState<string[]>([]);
  const [showColumnSelector, setShowColumnSelector] = useState<boolean>(false);
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // Preserve custom columns when loading a saved report config across async fetches
  const pendingColumnsRef = useRef<string[] | null>(null);

  const [savedConfigs, setSavedConfigs] = useState<SavedReportConfig[]>([]);
  const [configName, setConfigName] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [deletingConfigId, setDeletingConfigId] = useState<string | null>(null);

  const fetchReport = async () => {
    setLoading(true);
    setReportError(null);
    try {
      const params = new URLSearchParams();
      params.append('reportType', reportType);
      if (materialGrade) params.append('materialGrade', materialGrade);
      if (coilPackNumber) params.append('coilPackNumber', coilPackNumber);
      if (warehouseId) params.append('warehouseId', warehouseId);
      if (ownership) params.append('ownership', ownership);
      if (contractId) params.append('contractId', contractId);
      if (searchTerm) params.append('search', searchTerm);

      const res = await fetch(`/api/inventory/custom-reports?${params.toString()}`);
      const data = await res.json();
      if (data.success) {
        const cols: string[] = data.columns || [];
        setReportData({
          columns: cols,
          rows: data.data || [],
          summary: data.summary || {},
        });
        if (pendingColumnsRef.current && pendingColumnsRef.current.length > 0) {
          const restored = cols.filter(c => pendingColumnsRef.current!.includes(c));
          setSelectedColumns(restored.length > 0 ? restored : cols);
          pendingColumnsRef.current = null;
        } else {
          setSelectedColumns(cols);
        }
      } else {
        setReportData({ columns: [], rows: [], summary: {} });
        setReportError(data.error || 'خطا در تولید گزارش سفارشی');
      }
    } catch (err) {
      console.error('Error fetching custom report:', err);
      setReportError('خطا در برقراری ارتباط با سرور گزارش‌ساز');
    } finally {
      setLoading(false);
    }
  };

  const fetchSavedConfigs = async () => {
    try {
      const res = await fetch('/api/inventory/report-configs');
      const data = await res.json();
      if (data.success) {
        setSavedConfigs(data.data || []);
      }
    } catch (err) {
      console.error('Error fetching report configs:', err);
    }
  };

  useEffect(() => {
    setSortCol(null);
    fetchReport();
  }, [reportType, materialGrade, coilPackNumber, warehouseId, ownership, contractId, searchTerm]);

  useEffect(() => {
    fetchSavedConfigs();
  }, []);

  const visibleColumns = useMemo(() => {
    if (selectedColumns.length === 0) return reportData.columns;
    return reportData.columns.filter(c => selectedColumns.includes(c));
  }, [reportData.columns, selectedColumns]);

  const sortedRows = useMemo(() => {
    if (!sortCol) return reportData.rows;
    return [...reportData.rows].sort((a, b) => {
      const va = resolveCellValue(a, sortCol);
      const vb = resolveCellValue(b, sortCol);
      if (typeof va === 'number' && typeof vb === 'number') {
        return sortDir === 'asc' ? va - vb : vb - va;
      }
      const sa = String(va ?? '');
      const sb = String(vb ?? '');
      return sortDir === 'asc' ? sa.localeCompare(sb, 'fa') : sb.localeCompare(sa, 'fa');
    });
  }, [reportData.rows, sortCol, sortDir]);

  const numericTotals = useMemo(() => {
    const totals: Record<string, number | null> = {};
    visibleColumns.forEach(col => {
      if (
        col.includes('ضخامت') ||
        col.includes('عرض') ||
        col.includes('ضریب') ||
        col === 'thicknessMm' ||
        col === 'widthMm' ||
        col === 'operationStep'
      ) {
        totals[col] = null;
        return;
      }
      let sum = 0;
      let hasNumber = false;
      reportData.rows.forEach(row => {
        const v = resolveCellValue(row, col);
        if (typeof v === 'number' && !Number.isNaN(v)) {
          sum += v;
          hasNumber = true;
        }
      });
      totals[col] = hasNumber ? Number(sum.toFixed(2)) : null;
    });
    return totals;
  }, [visibleColumns, reportData.rows]);

  const toggleColumn = (col: string) => {
    setSelectedColumns(prev => {
      if (prev.includes(col)) {
        if (prev.length <= 1) return prev;
        return prev.filter(c => c !== col);
      }
      return [...prev, col];
    });
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!configName.trim()) return;

    try {
      const res = await fetch('/api/inventory/report-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: configName,
          reportType,
          selectedColumns: visibleColumns,
          filters: { materialGrade, coilPackNumber, warehouseId, ownership, contractId, searchTerm },
          sortBy: sortCol || undefined,
          sortOrder: sortDir,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setConfigName('');
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 3000);
        fetchSavedConfigs();
      }
    } catch (err) {
      console.error('Error saving config:', err);
    }
  };

  const handleDeleteConfig = async (id: string) => {
    setDeletingConfigId(id);
    try {
      const res = await fetch(`/api/inventory/report-configs/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setSavedConfigs(prev => prev.filter(c => c.id !== id));
      }
    } catch (err) {
      console.error('Error deleting report config:', err);
    } finally {
      setDeletingConfigId(null);
    }
  };

  const formatDisplayCell = (col: string, val: unknown): string => {
    if (val === undefined || val === null || val === '') return '-';
    if (typeof val === 'number') return formatNumber(val);
    if (Array.isArray(val)) return val.length ? val.join('، ') : '-';
    if (col === 'date' || col === 'تاریخ سند') {
      const s = String(val);
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return formatToJalali(s);
    }
    return String(val);
  };

  const handleExportCustomCsv = () => {
    if (sortedRows.length === 0) return;
    const headers = visibleColumns.map(getColumnLabel);
    const rows = sortedRows.map(row =>
      visibleColumns.map(col => {
        const val = resolveCellValue(row, col);
        if (val === undefined || val === null) return '';
        if (Array.isArray(val)) return val.join(' | ');
        if ((col === 'date' || col === 'تاریخ سند') && /^\d{4}-\d{2}-\d{2}/.test(String(val))) {
          return formatToJalali(String(val));
        }
        return String(val);
      })
    );
    exportToCsv(`KPIMS_CUSTOM_${reportType}_${new Date().toISOString().slice(0, 10)}`, headers, rows);
  };

  const activeReportMeta = REPORT_TYPES.find(r => r.id === reportType) || REPORT_TYPES[0];
  const hasAnyNumericTotals = Object.values(numericTotals).some(v => v !== null);
  const activeFiltersCount =
    (searchTerm.trim() ? 1 : 0) +
    (warehouseId ? 1 : 0) +
    (materialGrade ? 1 : 0) +
    (coilPackNumber ? 1 : 0) +
    (ownership ? 1 : 0) +
    (contractId ? 1 : 0);

  const handleResetFilters = () => {
    setMaterialGrade('');
    setCoilPackNumber('');
    setWarehouseId('');
    setOwnership('');
    setContractId('');
    setSearchTerm('');
  };

  const tableColumns = useMemo<FioriTableColumn<CustomReportRow>[]>(() => {
    const indexCol: FioriTableColumn<CustomReportRow> = {
      key: '__row_index__',
      header: '#',
      align: 'center',
      width: '2.5rem',
      isMono: true,
      cellClassName: 'text-[var(--fiori-text-secondary)]',
      render: (_row, rIdx) => toPersianDigits(rIdx + 1),
    };

    const dynamicCols: FioriTableColumn<CustomReportRow>[] = visibleColumns.map(col => ({
      key: col,
      header: getColumnLabel(col),
      sortable: true,
      nowrap: true,
      cellClassName: (row: CustomReportRow) => {
        const val = resolveCellValue(row, col);
        const isNumeric = typeof val === 'number';
        const isHighlightCol =
          col.includes('موجودی فعلی پس از مصرف') ||
          col.includes('مصرف واقعی') ||
          col.includes('شماره سند') ||
          col === 'onHand' ||
          col === 'documentNumber';
        return `${isNumeric ? 'font-mono font-semibold tabular-nums' : ''} ${
          isHighlightCol
            ? 'text-[var(--fiori-positive)] font-bold bg-[var(--fiori-positive-bg)]/40'
            : ''
        }`;
      },
      render: (row: CustomReportRow) => {
        const val = resolveCellValue(row, col);
        const strVal = formatDisplayCell(col, val);

        const isTraceableDoc =
          strVal !== '-' &&
          (col === 'partCode' ||
            col === 'documentNumber' ||
            col === 'coilNumber' ||
            col === 'coilPackNumber' ||
            col === 'manufacturingOrder' ||
            col === 'contractNumber' ||
            col.includes('کد قطعه') ||
            col.includes('شماره سند') ||
            col.includes('دستور کار') ||
            col.includes('کلاف'));

        const traceTarget =
          col === 'manufacturingOrder' || col.includes('دستور کار')
            ? 'WIP_TRACEABILITY'
            : col === 'coilNumber' || col === 'coilPackNumber' || col.includes('کلاف')
            ? 'COILS'
            : col === 'contractNumber'
            ? 'CONTRACTS'
            : 'INVENTORY_LEDGER';

        if (isTraceableDoc) {
          return (
            <button
              type="button"
              onClick={() => traceDocument(strVal, traceTarget)}
              className="sap-doc-link fiori-ltr-code font-semibold"
            >
              {strVal}
            </button>
          );
        }

        return strVal;
      },
    }));

    return [indexCol, ...dynamicCols];
  }, [visibleColumns, traceDocument]);

  return (
    <FioriDynamicPage
      title="گزارش‌ساز پویا و سفارشی (کنترل موجودی پس از مصرف و رهگیری سرتاسری اسناد)"
      subtitle="انتخاب منبع داده، شخصی‌سازی ستون‌های گزارش، مرتب‌سازی، فیلتر زنده، ذخیره قالب گزارش و خروجی اکسل/چاپ"
      status={<FioriObjectStatus tone="brand" label={activeReportMeta.badge} />}
      collapsibleFilters={false}
      activeFiltersCount={activeFiltersCount}
      onResetFilters={handleResetFilters}
      headerActions={
        <>
          <button
            type="button"
            onClick={() => setShowColumnSelector(prev => !prev)}
            className={`px-3 py-1.5 rounded-[var(--fiori-radius-sm)] text-xs font-semibold border flex items-center gap-1.5 transition cursor-pointer ${
              showColumnSelector
                ? 'bg-[var(--fiori-brand)] text-white border-[var(--fiori-brand)]'
                : 'sap-btn-standard'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>
              انتخاب ستون‌ها ({toPersianDigits(visibleColumns.length)} از{' '}
              {toPersianDigits(reportData.columns.length)})
            </span>
          </button>

          <button
            type="button"
            onClick={fetchReport}
            className="sap-btn-standard px-3 py-1.5 text-xs flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>بروزرسانی</span>
          </button>

          <button
            type="button"
            onClick={() => window.print()}
            className="sap-btn-standard px-3 py-1.5 text-xs flex items-center gap-1.5 cursor-pointer"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>چاپ رسمی</span>
          </button>

          <button
            type="button"
            onClick={handleExportCustomCsv}
            className="sap-btn-emphasized px-3.5 py-1.5 text-xs flex items-center gap-1.5 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>خروجی اکسل (CSV)</span>
          </button>
        </>
      }
      filterBar={
        <div className="space-y-3">
          {/* 5 Core Report Type Buttons */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-2">
            {REPORT_TYPES.map(rt => {
              const isSelected = reportType === rt.id;
              return (
                <button
                  key={rt.id}
                  type="button"
                  onClick={() => {
                    pendingColumnsRef.current = null;
                    setReportType(rt.id);
                  }}
                  className={`p-2.5 rounded-[var(--fiori-radius-sm)] border text-right transition-all cursor-pointer flex flex-col justify-between ${
                    isSelected
                      ? 'bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border-[var(--fiori-brand)] ring-1 ring-[var(--fiori-brand)]'
                      : 'bg-[var(--fiori-bg-surface)] hover:bg-[var(--fiori-bg-hover)] text-[var(--fiori-text-primary)] border-[var(--fiori-border-default)]'
                  }`}
                >
                  <div>
                    <span
                      className={`text-[10px] font-semibold block mb-1 ${
                        isSelected ? 'text-[var(--fiori-brand)]' : 'text-[var(--fiori-positive)]'
                      }`}
                    >
                      {rt.badge}
                    </span>
                    <div className="text-xs font-semibold leading-snug">{rt.title}</div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Column Picker Drawer */}
          {showColumnSelector && reportData.columns.length > 0 && (
            <div className="p-3.5 bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[var(--fiori-text-primary)]">
                  ستون‌های دلخواه خود را برای ساخت گزارش انتخاب کنید:
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedColumns(reportData.columns)}
                  className="text-[11px] text-[var(--fiori-brand)] hover:underline font-semibold cursor-pointer"
                >
                  انتخاب همه ستون‌ها
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {reportData.columns.map(col => {
                  const checked = visibleColumns.includes(col);
                  return (
                    <label
                      key={col}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--fiori-radius-sm)] border text-xs font-medium cursor-pointer transition ${
                        checked
                          ? 'bg-[var(--fiori-brand-bg)] border-[var(--fiori-brand)] text-[var(--fiori-brand)]'
                          : 'bg-[var(--fiori-bg-subtle)] border-[var(--fiori-border-default)] text-[var(--fiori-text-secondary)]'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleColumn(col)}
                        className="rounded-sm border-[var(--fiori-border-input)] text-[var(--fiori-brand)] focus:ring-0"
                      />
                      <span>{getColumnLabel(col)}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* Search & Save Template Bar */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-2.5">
            <div className="lg:col-span-5 relative">
              <Search className="w-4 h-4 text-[var(--fiori-text-secondary)] absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                placeholder="جستجو در مقادیر گزارش (کد قطعه، شماره سند، شماره ذوب، کلاف...)"
                className="fiori-input w-full pr-9 pl-3 py-1.5"
              />
            </div>

            <div className="lg:col-span-3">
              <select
                value={warehouseId}
                onChange={e => setWarehouseId(e.target.value)}
                className="fiori-input w-full px-3 py-1.5 font-medium cursor-pointer"
              >
                <option value="">همه انبارها و ایستگاه‌ها</option>
                <option value="WH-RAW">انبار مرکزی مواد اولیه و رول (WH-RAW)</option>
                <option value="WH-WIP-WELD">انبار پای کار جوش و مونتاژ (WH-WIP-WELD)</option>
                <option value="WH-FINISHED">انبار محصولات نهایی (WH-FINISHED)</option>
              </select>
            </div>

            <form onSubmit={handleSaveConfig} className="lg:col-span-4 flex items-center gap-2">
              <input
                type="text"
                value={configName}
                onChange={e => setConfigName(e.target.value)}
                placeholder="نام قالب گزارش جهت ذخیره..."
                className="fiori-input flex-1 px-3 py-1.5"
              />
              <button
                type="submit"
                className="sap-btn-emphasized px-3.5 py-1.5 text-xs flex items-center gap-1 shrink-0 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>ذخیره گزارش</span>
              </button>
            </form>
          </div>

          {saveSuccess && (
            <FioriMessageStrip
              tone="success"
              compact
              onClose={() => setSaveSuccess(false)}
            >
              قالب گزارش سفارشی شما با موفقیت ذخیره شد.
            </FioriMessageStrip>
          )}

          {/* Saved Report Templates */}
          {savedConfigs.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-[var(--fiori-border-subtle)]">
              <span className="text-[11px] font-semibold text-[var(--fiori-text-secondary)] flex items-center gap-1">
                <Bookmark className="w-3.5 h-3.5 text-[var(--fiori-critical)]" />
                گزارش‌های ذخیره‌شده شما:
              </span>
              {savedConfigs.map(cfg => (
                <div
                  key={cfg.id}
                  className="inline-flex items-center rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-surface)] hover:bg-[var(--fiori-brand-bg)] text-[var(--fiori-text-primary)] text-xs font-medium transition border border-[var(--fiori-border-default)] overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => {
                      const savedCols =
                        Array.isArray(cfg.selectedColumns) && cfg.selectedColumns.length > 0
                          ? cfg.selectedColumns
                          : null;
                      pendingColumnsRef.current = savedCols;
                      if (cfg.reportType === reportType && savedCols) {
                        setSelectedColumns(savedCols);
                      } else {
                        setReportType(cfg.reportType);
                      }
                      if (cfg.filters) {
                        setMaterialGrade(cfg.filters.materialGrade || '');
                        setCoilPackNumber(cfg.filters.coilPackNumber || '');
                        setWarehouseId(cfg.filters.warehouseId || '');
                        setOwnership(cfg.filters.ownership || '');
                        setContractId(cfg.filters.contractId || '');
                        setSearchTerm(cfg.filters.searchTerm || '');
                      }
                      if (cfg.sortBy) {
                        setSortCol(cfg.sortBy);
                        setSortDir(cfg.sortOrder === 'desc' ? 'desc' : 'asc');
                      }
                    }}
                    className="px-2.5 py-1 cursor-pointer hover:text-[var(--fiori-brand)]"
                  >
                    {cfg.name}
                  </button>
                  <button
                    type="button"
                    disabled={deletingConfigId === cfg.id}
                    onClick={() => handleDeleteConfig(cfg.id)}
                    title="حذف قالب ذخیره‌شده"
                    className="px-1.5 py-1 text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-negative)] hover:bg-[var(--fiori-negative-bg)] border-r border-[var(--fiori-border-default)] cursor-pointer disabled:opacity-40"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      }
    >
      {reportError && (
        <FioriMessageStrip
          tone="error"
          title="خطا در تولید گزارش"
          actions={
            <button
              type="button"
              onClick={fetchReport}
              className="sap-btn-standard px-2.5 py-1 text-[11px] cursor-pointer"
            >
              تلاش مجدد
            </button>
          }
        >
          {reportError}
        </FioriMessageStrip>
      )}

      {loading ? (
        <TableSkeleton rows={7} columns={Math.max(5, visibleColumns.length)} theme="light" />
      ) : (
        <FioriDataTable
          toolbar={
            <FioriToolbar
              variant="table"
              title={activeReportMeta.title}
              subtitle={activeReportMeta.desc}
              count={sortedRows.length}
              countLabel="ردیف"
              startContent={<GitBranch className="w-4 h-4 text-[var(--fiori-brand)] shrink-0" />}
            />
          }
          columns={tableColumns}
          data={sortedRows}
          rowKey={(_row, rIdx) => `${reportType}-${rIdx}`}
          sortKey={sortCol || undefined}
          sortDirection={sortDir}
          onSortChange={(key, dir) => {
            if (key === '__row_index__') return;
            setSortCol(key);
            setSortDir(dir);
          }}
          tableFooter={
            hasAnyNumericTotals ? (
              <tr className="bg-[var(--fiori-bg-subtle)] border-t-2 border-[var(--fiori-border-default)] font-bold text-[var(--fiori-text-primary)]">
                <td className="text-center text-[11px] text-[var(--fiori-text-secondary)]">جمع</td>
                {visibleColumns.map((col, cIdx) => {
                  const totalVal = numericTotals[col];
                  return (
                    <td key={cIdx} className="whitespace-nowrap font-mono tabular-nums">
                      {totalVal !== null && totalVal !== undefined ? formatNumber(totalVal) : ''}
                    </td>
                  );
                })}
              </tr>
            ) : undefined
          }
          emptyState={
            <EmptyState
              compact
              variant={activeFiltersCount > 0 ? 'FILTER_NO_MATCH' : 'NO_DATA'}
              description="هیچ رکوردی مطابق با فیلترهای انتخابی یافت نشد."
              actionLabel={activeFiltersCount > 0 ? 'پاک‌کردن فیلترها' : 'بروزرسانی'}
              onAction={activeFiltersCount > 0 ? handleResetFilters : fetchReport}
            />
          }
        />
      )}
    </FioriDynamicPage>
  );
};
