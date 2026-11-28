import React, { useState, useMemo, useEffect } from 'react';
import {
  BarChart3,
  ShieldAlert,
  Clock,
  CheckCircle2,
  TrendingDown,
  Edit3,
  Trash2,
  Plus,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { formatNumber, toPersianDigits } from '../../utils/formatters';
import { useEnterpriseUx } from '../../context/EnterpriseUxContext';
import { usePersistedOpen } from '../../hooks/usePersistedCollapse';
import {
  FioriMessageStrip,
  FioriObjectStatus,
  FioriToolbar,
} from '../fiori/ui';

export interface ParetoCauseItem {
  id: string;
  title: string;
  category6M: string;
  value: number;
  unitLabel: string;
  affectedStation: string;
  capaAction: string;
  isDeleted?: boolean;
}

const INITIAL_SCRAP_CAUSES: ParetoCauseItem[] = [
  {
    id: 'SCR-01',
    title: 'ایراد قالب، کندی لبه برش و پلیسه سنبه/ماتریس (Die & Tooling Wear)',
    category6M: 'قالب و ابزار (Tooling)',
    value: 54,
    unitLabel: 'قطعه',
    affectedStation: 'پرس ۲۵۰ تن و ۴۰۰ تن (OP-10 / OP-20)',
    capaAction: 'سنگ‌زنی لبه برش قالب DIE-206-DRW-02 و تنظیم لقی سنبه به ۰.۱۲ میلی‌متر',
  },
  {
    id: 'SCR-02',
    title: 'کیفیت ورق، نوسان ضخامت و ترک در کشش عمیق (Coil Material Defect)',
    category6M: 'مواد اولیه (Material)',
    value: 36,
    unitLabel: 'قطعه',
    affectedStation: 'پرس هیدرولیک ۸۰۰ تن (کشش ستون B و صندلی)',
    capaAction: 'ثبت گزارش عدم انطباق (NCR) برای ذوب HT-88412 و بهینه‌سازی روغن‌کاری ورق',
  },
  {
    id: 'SCR-03',
    title: 'خطای اپراتور در استقرار قطعه و گام‌دهی اولیه نوار (Operator Positioning)',
    category6M: 'نیروی انسانی (Man)',
    value: 19,
    unitLabel: 'قطعه',
    affectedStation: 'پرس ضربه‌ای ۱۶۰ تن (پانچ و خم کاری)',
    capaAction: 'نصب پین خطاناپذیر (Poka-Yoke) روی کفشک قالب و بازآموزی اپراتور شیفت',
  },
  {
    id: 'SCR-04',
    title: 'نوسان فشار بالشتک هیدرولیک و چروک لبه قطعه (Die Cushion Pressure)',
    category6M: 'ماشین‌آلات (Machine)',
    value: 12,
    unitLabel: 'قطعه',
    affectedStation: 'پرس هیدرولیک ۴۰۰ تن ۱',
    capaAction: 'کالیبراسیون شیر تناسبی هیدرولیک و تثبیت فشار بالشتک روی ۱۲۰ بار',
  },
  {
    id: 'SCR-05',
    title: 'پاشش جرقه جوش و انحراف جزئی مهره جوشی M6/M8 (Weld Spatter)',
    category6M: 'فرآیند جوش (Method)',
    value: 7,
    unitLabel: 'قطعه',
    affectedStation: 'ایستگاه پرس‌جوش مقاومتی و ربات CO2',
    capaAction: 'پاکسازی الکترود مسی و تنظیم جریان جوش مقاومتی به ۱۱.۵ کیلوآمپر',
  },
];

const INITIAL_DOWNTIME_CAUSES: ParetoCauseItem[] = [
  {
    id: 'DT-P01',
    title: 'خرابی اضطراری مدار هیدرولیک و بالشتک کشش پرس (Hydraulic Breakdown)',
    category6M: 'ماشین‌آلات (TPM)',
    value: 95,
    unitLabel: 'دقیقه',
    affectedStation: 'پرس ۲۵۰ تن و ۴۰۰ تن',
    capaAction: 'تعویض پیشگیرانه شیلنگ‌های فشارقوی در برنامه PM هفتگی',
  },
  {
    id: 'DT-P02',
    title: 'زمان تعویض قالب، تنظیم ارتفاع بسته و رگلاژ اولیه (SMED Setup)',
    category6M: 'تعویض قالب (Setup)',
    value: 80,
    unitLabel: 'دقیقه',
    affectedStation: 'سالن پرس سنگین و متوسط',
    capaAction: 'استانداردسازی کلمپ‌های سریع و آماده‌سازی قالب بعدی بیرون خط (External Setup)',
  },
  {
    id: 'DT-P03',
    title: 'تأخیر در تغذیه فیدر اتوماتیک و گیرکردن قطعه در پران قالب (Minor Stops)',
    category6M: 'قالب و فیدر (Tooling)',
    value: 45,
    unitLabel: 'دقیقه',
    affectedStation: 'پرس ۱۶۰ تن ۲ و فیدر مهره‌جوش',
    capaAction: 'تعویض فنرهای پین پران (Ejector Pin) و شارژ به‌موقع مخزن فیدر',
  },
  {
    id: 'DT-P04',
    title: 'انتظار تأمین شیت برش‌خورده و جابجایی لیفتراک (Material Handling)',
    category6M: 'لجستیک خط (Material)',
    value: 28,
    unitLabel: 'دقیقه',
    affectedStation: 'خط برش گیوتین به سالن پرس',
    capaAction: 'تعریف بافر کانبان ۲ ساعته پای هر پرس بر اساس تقویم ظرفیت',
  },
  {
    id: 'DT-P05',
    title: 'سرویس نازل تورچ و تعویض قرقره سیم جوش CO2 (Consumables)',
    category6M: 'ایستگاه جوش (Method)',
    value: 18,
    unitLabel: 'دقیقه',
    affectedStation: 'کابین جوش CO2 شماره ۱',
    capaAction: 'استفاده از اسپری ضدجرقه اتوماتیک در هر ۵۰ سیکل کاری',
  },
];

export const ScrapParetoChart: React.FC = () => {
  const { openQuickEditDrawer, requestConfirm, showUndoToast, recordAudit } = useEnterpriseUx();
  const [mode, setMode] = useState<'SCRAP' | 'DOWNTIME'>('SCRAP');
  const [isDetailsExpanded, , toggleDetailsExpanded] = usePersistedOpen('report_scrap_pareto_open', false);

  const [scrapCauses, setScrapCauses] = useState<ParetoCauseItem[]>(() => {
    try {
      const saved = localStorage.getItem('kpims_pareto_scrap_v1');
      if (saved) return JSON.parse(saved);
    } catch {
      // ignore
    }
    return INITIAL_SCRAP_CAUSES;
  });

  const [downtimeCauses, setDowntimeCauses] = useState<ParetoCauseItem[]>(() => {
    try {
      const saved = localStorage.getItem('kpims_pareto_downtime_v1');
      if (saved) return JSON.parse(saved);
    } catch {
      // ignore
    }
    return INITIAL_DOWNTIME_CAUSES;
  });

  useEffect(() => {
    try {
      localStorage.setItem('kpims_pareto_scrap_v1', JSON.stringify(scrapCauses));
    } catch {
      // ignore
    }
  }, [scrapCauses]);

  useEffect(() => {
    try {
      localStorage.setItem('kpims_pareto_downtime_v1', JSON.stringify(downtimeCauses));
    } catch {
      // ignore
    }
  }, [downtimeCauses]);

  const computedRows = useMemo(() => {
    const source = (mode === 'SCRAP' ? scrapCauses : downtimeCauses).filter(i => !i.isDeleted);
    const sorted = [...source].sort((a, b) => b.value - a.value);
    const total = Math.max(1, sorted.reduce((sum, item) => sum + item.value, 0));
    const maxVal = Math.max(1, sorted[0]?.value || 1);

    let cumulative = 0;
    return sorted.map((item, index) => {
      const sharePercent = Number(((item.value / total) * 100).toFixed(1));
      cumulative = Math.min(100, Number((cumulative + sharePercent).toFixed(1)));
      const widthRatioPercent = Math.round((item.value / maxVal) * 100);
      const isVitalFew = index < 2 || cumulative <= 82;

      return {
        ...item,
        rank: index + 1,
        sharePercent,
        cumulativePercent: cumulative,
        widthRatioPercent,
        isVitalFew,
        total,
      };
    });
  }, [mode, scrapCauses, downtimeCauses]);

  const totalSum = computedRows[0]?.total || 0;
  const topTwoCumulative = computedRows[1]?.cumulativePercent || computedRows[0]?.cumulativePercent || 0;

  const handleEditCause = (item: ParetoCauseItem) => {
    openQuickEditDrawer({
      title: `ویرایش علت ${mode === 'SCRAP' ? 'ضایعات' : 'توقف'}: ${item.title}`,
      subtitle: 'بروزرسانی مقادیر به صورت آنی نمودار پارتو (۸۰/۲۰) و درصد تجمعی را بازمحاسبه می‌کند.',
      entityId: item.id,
      entityCode: item.id,
      moduleName: 'گزارشات پارتو و IATF 16949',
      fields: [
        { key: 'title', label: 'عنوان علت ریشه‌ای (Root Cause)', type: 'text' },
        {
          key: 'category6M',
          label: 'دسته‌بندی ۶M ایشیکاوا',
          type: 'select',
          options: [
            { value: 'قالب و ابزار (Tooling)', label: 'قالب و ابزار (Tooling)' },
            { value: 'مواد اولیه (Material)', label: 'مواد اولیه (Material)' },
            { value: 'نیروی انسانی (Man)', label: 'نیروی انسانی (Man)' },
            { value: 'ماشین‌آلات (Machine)', label: 'ماشین‌آلات (Machine)' },
            { value: 'فرآیند و روش (Method)', label: 'فرآیند و روش (Method)' },
            { value: 'تعویض قالب (Setup)', label: 'تعویض قالب (Setup)' },
          ],
        },
        {
          key: 'value',
          label: mode === 'SCRAP' ? 'تعداد ضایعات ثبت‌شده (قطعه)' : 'مدت زمان توقف (دقیقه)',
          type: 'number',
        },
        { key: 'affectedStation', label: 'ایستگاه / پرس درگیر', type: 'text' },
        { key: 'capaAction', label: 'اقدام اصلاحی و پیشگیرانه (8D / CAPA)', type: 'text' },
      ],
      initialValues: {
        title: item.title,
        category6M: item.category6M,
        value: item.value,
        affectedStation: item.affectedStation,
        capaAction: item.capaAction,
      },
      onSave: updated => {
        const updater = (prev: ParetoCauseItem[]) =>
          prev.map(c =>
            c.id === item.id
              ? {
                  ...c,
                  title: String(updated.title || c.title),
                  category6M: String(updated.category6M || c.category6M),
                  value: Math.max(1, Number(updated.value) || 1),
                  affectedStation: String(updated.affectedStation || c.affectedStation),
                  capaAction: String(updated.capaAction || c.capaAction),
                }
              : c
          );
        if (mode === 'SCRAP') setScrapCauses(updater);
        else setDowntimeCauses(updater);
      },
    });
  };

  const handleAddNewCause = () => {
    const newId = `${mode === 'SCRAP' ? 'SCR' : 'DT-P'}-${Math.floor(10 + Math.random() * 89)}`;
    openQuickEditDrawer({
      title: mode === 'SCRAP' ? 'ثبت علت ضایعات کیفی جدید در پارتو' : 'ثبت علت توقف خط جدید در پارتو',
      entityId: newId,
      entityCode: newId,
      moduleName: 'گزارشات پارتو و IATF 16949',
      fields: [
        { key: 'title', label: 'عنوان علت ریشه‌ای (Root Cause)', type: 'text' },
        {
          key: 'category6M',
          label: 'دسته‌بندی ۶M ایشیکاوا',
          type: 'select',
          options: [
            { value: 'قالب و ابزار (Tooling)', label: 'قالب و ابزار (Tooling)' },
            { value: 'مواد اولیه (Material)', label: 'مواد اولیه (Material)' },
            { value: 'نیروی انسانی (Man)', label: 'نیروی انسانی (Man)' },
            { value: 'ماشین‌آلات (Machine)', label: 'ماشین‌آلات (Machine)' },
            { value: 'فرآیند و روش (Method)', label: 'فرآیند و روش (Method)' },
          ],
        },
        {
          key: 'value',
          label: mode === 'SCRAP' ? 'تعداد ضایعات (قطعه)' : 'مدت زمان توقف (دقیقه)',
          type: 'number',
        },
        { key: 'affectedStation', label: 'ایستگاه / پرس درگیر', type: 'text' },
        { key: 'capaAction', label: 'اقدام اصلاحی (CAPA)', type: 'text' },
      ],
      initialValues: {
        title: mode === 'SCRAP' ? 'خراشیدگی سطحی ورق در قالب کشش' : 'توقف تنظیم سنسور نوری فیدر',
        category6M: 'قالب و ابزار (Tooling)',
        value: 15,
        affectedStation: 'سالن پرس متوسط',
        capaAction: 'پولیش سطح ماتریس و بازبینی سنسور',
      },
      onSave: vals => {
        const newItem: ParetoCauseItem = {
          id: newId,
          title: String(vals.title || 'علت جدید'),
          category6M: String(vals.category6M || 'قالب و ابزار (Tooling)'),
          value: Math.max(1, Number(vals.value) || 10),
          unitLabel: mode === 'SCRAP' ? 'قطعه' : 'دقیقه',
          affectedStation: String(vals.affectedStation || 'سالن پرس'),
          capaAction: String(vals.capaAction || 'ثبت اقدام اصلاحی'),
        };
        if (mode === 'SCRAP') setScrapCauses(prev => [...prev, newItem]);
        else setDowntimeCauses(prev => [...prev, newItem]);
      },
    });
  };

  const handleDeleteCause = (item: ParetoCauseItem) => {
    requestConfirm({
      title: `حذف منطقی ردیف پارتو (${item.id})`,
      message: `آیا از حذف منطقی علت «${item.title}» از نمودار پارتو اطمینان دارید؟`,
      consequences: [
        'بازمحاسبه خودکار سهم درصدی و منحنی تجمعی ۸۰/۲۰ پارتو',
        'امکان بازگردانی فوری (Undo) تا ۸ ثانیه پس از حذف',
      ],
      confirmLabel: 'حذف منطقی (Soft Delete)',
      variant: 'danger',
      onConfirm: () => {
        if (mode === 'SCRAP') {
          const prevSnap = [...scrapCauses];
          setScrapCauses(prev => prev.map(c => (c.id === item.id ? { ...c, isDeleted: true } : c)));
          recordAudit({
            entityId: item.id,
            entityCode: item.id,
            moduleName: 'پارتو ضایعات',
            actionType: 'SOFT_DELETE',
            title: `حذف منطقی علت ضایعات: ${item.title}`,
            details: `تعداد ${item.value} قطعه از محاسبات پارتو آرشیو شد.`,
          });
          showUndoToast({
            title: `علت ضایعات «${item.id}» حذف منطقی شد`,
            detail: 'برای بازگردانی به نمودار پارتو روی لغو (Undo) کلیک کنید.',
            variant: 'danger',
            onUndo: () => setScrapCauses(prevSnap),
          });
        } else {
          const prevSnap = [...downtimeCauses];
          setDowntimeCauses(prev => prev.map(c => (c.id === item.id ? { ...c, isDeleted: true } : c)));
          recordAudit({
            entityId: item.id,
            entityCode: item.id,
            moduleName: 'پارتو توقفات',
            actionType: 'SOFT_DELETE',
            title: `حذف منطقی علت توقف: ${item.title}`,
            details: `مدت ${item.value} دقیقه از محاسبات پارتو آرشیو شد.`,
          });
          showUndoToast({
            title: `علت توقف «${item.id}» حذف منطقی شد`,
            detail: 'برای بازگردانی به نمودار پارتو روی لغو (Undo) کلیک کنید.',
            variant: 'danger',
            onUndo: () => setDowntimeCauses(prevSnap),
          });
        }
      },
    });
  };

  return (
    <div className="fiori-surface-card p-4 space-y-3 text-right" dir="rtl">
      <FioriToolbar
        variant="section"
        title="نمودار پارتو ضایعات و توقفات خط (Scrap & Downtime Pareto — تحلیل ۸۰/۲۰)"
        subtitle="رتبه‌بندی نزولی علل ضایعات و توقفات؛ برای ویرایش مقادیر یا اقدام اصلاحی هر ردیف از آیکون مداد استفاده کنید."
        count={computedRows.length}
        countLabel="علت"
        startContent={
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-[var(--fiori-negative)] shrink-0" />
            <FioriObjectStatus tone="negative" label="استاندارد IATF 16949" size="sm" />
          </div>
        }
        endContent={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 bg-[var(--fiori-bg-subtle)] p-0.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)]">
              <button
                type="button"
                onClick={() => setMode('SCRAP')}
                className={`px-2.5 py-1 rounded-[var(--fiori-radius-sm)] text-xs font-medium transition cursor-pointer flex items-center gap-1.5 ${
                  mode === 'SCRAP'
                    ? 'bg-[var(--fiori-brand)] text-white font-semibold'
                    : 'text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)]'
                }`}
              >
                <ShieldAlert className={`w-3.5 h-3.5 ${mode === 'SCRAP' ? 'text-white' : 'text-[var(--fiori-negative)]'}`} />
                <span>پارتو ضایعات (Scrap)</span>
              </button>
              <button
                type="button"
                onClick={() => setMode('DOWNTIME')}
                className={`px-2.5 py-1 rounded-[var(--fiori-radius-sm)] text-xs font-medium transition cursor-pointer flex items-center gap-1.5 ${
                  mode === 'DOWNTIME'
                    ? 'bg-[var(--fiori-brand)] text-white font-semibold'
                    : 'text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)]'
                }`}
              >
                <Clock className={`w-3.5 h-3.5 ${mode === 'DOWNTIME' ? 'text-white' : 'text-[var(--fiori-critical)]'}`} />
                <span>پارتو توقفات (Downtime)</span>
              </button>
            </div>

            <button
              type="button"
              onClick={handleAddNewCause}
              className="sap-btn-emphasized px-3 py-1.5 text-xs flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>افزودن علت جدید</span>
            </button>

            <button
              type="button"
              onClick={toggleDetailsExpanded}
              className="sap-btn-standard px-2.5 py-1.5 text-xs flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            >
              <span>{isDetailsExpanded ? 'بستن جزئیات پارتو' : `نمایش نمودار (${toPersianDigits(computedRows.length)} علت)`}</span>
              {isDetailsExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          </div>
        }
      />

      {/* 80/20 Insight Strip (Always visible at a glance) */}
      <div
        onClick={toggleDetailsExpanded}
        className="cursor-pointer"
        role="button"
        tabIndex={0}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleDetailsExpanded();
          }
        }}
      >
        <FioriMessageStrip
          tone="warning"
          compact
          icon={<TrendingDown className="w-4 h-4 shrink-0" />}
          actions={
            <div className="flex items-center gap-2 font-mono text-[11px] tabular-nums">
              <span className="text-[var(--fiori-text-secondary)]">
                مجموع کل:{' '}
                <strong className="text-[var(--fiori-text-primary)]">
                  {formatNumber(totalSum)} {mode === 'SCRAP' ? 'قطعه' : 'دقیقه'}
                </strong>
              </span>
              <FioriObjectStatus tone="negative" label="Vital 80%" size="sm" />
            </div>
          }
        >
          <span>
            تحلیل پارتو (۸۰/۲۰): <strong className="text-[var(--fiori-negative)]">۲ علت اول</strong> به تنهایی عامل{' '}
            <strong className="font-mono tabular-nums text-[var(--fiori-text-primary)]">
              {toPersianDigits(topTwoCumulative)}٪
            </strong>{' '}
            از کل {mode === 'SCRAP' ? 'ضایعات ثبت‌شده' : 'توقفات خطوط تولید'} هستند.
          </span>
        </FioriMessageStrip>
      </div>

      {/* Minimal Descending Bar Chart Rows with Pencil Edit & Soft Delete */}
      {isDetailsExpanded && (
        <div className="space-y-2.5">
          {computedRows.map(row => (
            <div
              key={row.id}
              className={`p-3 rounded-[var(--fiori-radius-sm)] border transition-colors ${
                row.isVitalFew
                  ? 'bg-[var(--fiori-negative-bg)]/45 border-[var(--fiori-negative-border)]'
                  : 'bg-[var(--fiori-bg-surface)] border-[var(--fiori-border-default)] hover:bg-[var(--fiori-bg-subtle)]'
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`w-6 h-6 rounded-[var(--fiori-radius-sm)] font-mono text-xs font-semibold flex items-center justify-center shrink-0 tabular-nums ${
                      row.rank === 1
                        ? 'bg-[var(--fiori-negative)] text-white'
                        : row.rank === 2
                        ? 'bg-[var(--fiori-critical)] text-white'
                        : 'bg-[var(--fiori-neutral-bg)] text-[var(--fiori-text-primary)] border border-[var(--fiori-border-default)]'
                    }`}
                  >
                    {toPersianDigits(row.rank)}
                  </span>
                  <span className="text-xs font-semibold text-[var(--fiori-text-primary)]">{row.title}</span>
                  <FioriObjectStatus tone="neutral" label={row.category6M} size="sm" />
                  {row.isVitalFew && <FioriObjectStatus tone="negative" label="اولویت ۸۰/۲۰" size="sm" />}
                </div>

                <div className="flex items-center gap-2 font-mono text-xs shrink-0 self-end sm:self-center tabular-nums">
                  <span className="font-semibold text-[var(--fiori-text-primary)] ml-1">
                    {formatNumber(row.value)}{' '}
                    <span className="text-[10px] font-sans font-normal text-[var(--fiori-text-secondary)]">
                      {row.unitLabel}
                    </span>
                  </span>
                  <FioriObjectStatus tone="neutral" label={`سهم: ${toPersianDigits(row.sharePercent)}٪`} size="sm" />
                  <FioriObjectStatus
                    tone={row.cumulativePercent <= 82 ? 'negative' : 'neutral'}
                    label={`تجمعی: ${toPersianDigits(row.cumulativePercent)}٪`}
                    size="sm"
                  />

                  <button
                    type="button"
                    onClick={() => handleEditCause(row)}
                    title="ویرایش در کشو (Edit)"
                    className="p-1.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-surface)] hover:bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border border-[var(--fiori-border-default)] hover:border-[var(--fiori-brand)] transition cursor-pointer"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>

                  <button
                    type="button"
                    onClick={() => handleDeleteCause(row)}
                    title="حذف منطقی (Soft Delete)"
                    className="p-1.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-surface)] hover:bg-[var(--fiori-negative)] text-[var(--fiori-text-secondary)] hover:text-white border border-[var(--fiori-border-default)] transition cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Descending Horizontal Bar */}
              <div className="w-full h-2.5 bg-[var(--fiori-neutral-bg)] rounded-[var(--fiori-radius-sm)] overflow-hidden p-0.5 border border-[var(--fiori-border-default)]">
                <div
                  className={`h-full rounded-[2px] transition-all duration-500 ${
                    row.rank === 1
                      ? 'bg-[var(--fiori-negative)]'
                      : row.rank === 2
                      ? 'bg-[var(--fiori-critical)]'
                      : row.rank === 3
                      ? 'bg-[var(--fiori-brand)]'
                      : 'bg-[var(--fiori-neutral)]'
                  }`}
                  style={{ width: `${Math.max(6, row.widthRatioPercent)}%` }}
                />
              </div>

              {/* Sub-row: Station & IATF 16949 Corrective Action */}
              <div className="mt-2 pt-1.5 border-t border-[var(--fiori-border-subtle)] flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-[11px] text-[var(--fiori-text-secondary)]">
                <span>
                  ایستگاه درگیر: <strong className="text-[var(--fiori-text-primary)]">{row.affectedStation}</strong>
                </span>
                <span className="text-[var(--fiori-positive)] font-medium flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5 text-[var(--fiori-positive)] shrink-0" />
                  اقدام اصلاحی (CAPA): {row.capaAction}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
