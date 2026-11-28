import React from 'react';
import {
  Inbox,
  Filter,
  Plus,
  RefreshCw,
  Search,
  PackageSearch,
  FileQuestion,
  CalendarX2,
  Wrench,
  AlertTriangle,
  Layers,
  LucideIcon,
} from 'lucide-react';

export type EmptyStateVariant =
  | 'NO_DATA'
  | 'FILTER_NO_MATCH'
  | 'SEARCH_NO_MATCH'
  | 'NO_SCHEDULE'
  | 'NO_DOWNTIME'
  | 'NO_WIP'
  | 'NO_CONTRACTS'
  | 'CUSTOM';

interface EmptyStateProps {
  variant?: EmptyStateVariant;
  icon?: LucideIcon;
  title?: string;
  description?: string;
  steps?: string[];
  actionLabel?: string;
  onAction?: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  className?: string;
  compact?: boolean;
}

const PRESET_CONFIGS: Record<
  EmptyStateVariant,
  {
    icon: LucideIcon;
    title: string;
    description: string;
    steps: string[];
    actionLabel?: string;
    secondaryActionLabel?: string;
  }
> = {
  NO_DATA: {
    icon: Inbox,
    title: 'هنوز هیچ داده‌ای ثبت نشده است',
    description: 'برای آغاز کار با این بخش از سیستم، اولین رکورد را در سیستم ثبت کنید.',
    steps: [
      'گام ۱: از دکمه افزودن جدید در بالای جدول استفاده کنید.',
      'گام ۲: فیلدهای الزامی فرم را تکمیل کرده و ذخیره نمایید.',
    ],
    actionLabel: 'ثبت اولین رکورد',
  },
  FILTER_NO_MATCH: {
    icon: Filter,
    title: 'هیچ ردیفی با فیلترهای انتخابی یافت نشد',
    description: 'فیلترهای اعمال‌شده (مثل سالن، شیفت یا وضعیت) باعث محدود شدن نتایج جدول شده‌اند.',
    steps: [
      'فیلترهای بالای جدول را روی «همه» یا حالت عمومی‌تر تنظیم کنید.',
      'یا با زدن دکمه زیر، تمامی فیلترهای جستجو را ریست نمایید.',
    ],
    actionLabel: 'پاک‌کردن فیلترها',
  },
  SEARCH_NO_MATCH: {
    icon: Search,
    title: 'نتیجه‌ای برای جستجوی شما یافت نشد',
    description: 'کلمه کلیدی یا کد واردشده با هیچ‌یک از ردیف‌های فعال سیستم تطابق ندارد.',
    steps: [
      'املای کد فنی یا نام قطعه را بررسی کنید.',
      'از وارد کردن عبارات کوتاه‌تر یا بخشی از کد قطعه استفاده کنید.',
    ],
    actionLabel: 'پاک‌کردن متن جستجو',
  },
  NO_SCHEDULE: {
    icon: CalendarX2,
    title: 'هیچ برنامه تولیدی برای این روز یا شیفت تعریف نشده است',
    description: 'در تقویم تولید انتخابی، هنوز دستور کار فعالی زمان‌بندی نشده است.',
    steps: [
      'گام ۱: از تب «ماتریس برنامه‌ریزی» روز و شیفت مورد نظر را برای قطعات تایید کنید.',
      'گام ۲: یا از دکمه «انتقال مانده به شیفت بعد» جهت سرریز کار شیفت قبل استفاده نمایید.',
    ],
    actionLabel: 'تنظیم برنامه جدید در ماتریس',
  },
  NO_DOWNTIME: {
    icon: Wrench,
    title: 'هیچ توقف ثبت‌شده‌ای در این بازه وجود ندارد',
    description: 'خطوط تولید در بالاترین سطح آمادگی (Availability ۱۰۰٪) کار کرده‌اند و لاگ توقفی ثبت نشده است.',
    steps: [
      'در صورت وقوع خرابی یا تعویض قالب (SMED)، از دکمه زیر جهت ثبت توقف جدید استفاده نمایید.',
    ],
    actionLabel: 'ثبت لاگ توقف دستگاه',
  },
  NO_WIP: {
    icon: Layers,
    title: 'بافر بین‌ایستگاهی (WIP) خالی است',
    description: 'در حال حاضر هیچ قطعه نیمه‌ساخته‌ای بین مراحل این عملیات انباشته نشده است.',
    steps: [
      'گام ۱: مرحله ماقبل (OP قبلی) باید تولید سالم ثبت کند تا بافر ورودی تغذیه شود.',
      'گام ۲: مواد اولیه یا ورق رول پای دستگاه تخصیص داده شود.',
    ],
    actionLabel: 'مشاهده ماتریس تغذیه خط',
  },
  NO_CONTRACTS: {
    icon: PackageSearch,
    title: 'قرارداد یا سفارش بازی برای تحویل وجود ندارد',
    description: 'تمام قراردادهای ساپکو تحویل شده یا هنوز قراردادی در سیستم وارد نشده است.',
    steps: [
      'شماره سفارش یا متمم قرارداد تیراژ خودروساز را وارد نمایید.',
    ],
    actionLabel: 'ثبت قرارداد جدید با ساپکو',
  },
  CUSTOM: {
    icon: FileQuestion,
    title: 'اطلاعاتی یافت نشد',
    description: 'برای ادامه، ورودی‌های لازم را تکمیل کنید.',
    steps: [],
  },
};

export const EmptyState: React.FC<EmptyStateProps> = ({
  variant = 'NO_DATA',
  icon,
  title,
  description,
  steps,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
  className = '',
  compact = false,
}) => {
  const config = PRESET_CONFIGS[variant] || PRESET_CONFIGS.NO_DATA;
  const FinalIcon = icon || config.icon;
  const finalTitle = title || config.title;
  const finalDescription = description || config.description;
  const finalSteps = steps || config.steps;
  const finalActionLabel = actionLabel || config.actionLabel;
  const finalSecondaryLabel = secondaryActionLabel || config.secondaryActionLabel;

  if (compact) {
    return (
      <div
        className={`flex flex-col items-center justify-center p-5 text-center text-[var(--fiori-text-secondary)] rounded-[var(--fiori-radius-md)] border border-dashed border-[var(--fiori-border-strong)] bg-[var(--fiori-bg-subtle)] ${className}`}
      >
        <div className="w-9 h-9 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-brand-bg)] border border-[var(--fiori-brand-border)] flex items-center justify-center text-[var(--fiori-brand)] mb-2">
          <FinalIcon className="w-4 h-4 stroke-[1.6]" />
        </div>
        <h4 className="font-semibold text-xs text-[var(--fiori-text-primary)]">{finalTitle}</h4>
        <p className="text-[11px] text-[var(--fiori-text-secondary)] max-w-sm mt-1 leading-relaxed">
          {finalDescription}
        </p>
        {finalActionLabel && onAction && (
          <button
            type="button"
            onClick={onAction}
            className="sap-btn-emphasized mt-3 px-3 py-1.5 text-xs cursor-pointer"
          >
            {finalActionLabel}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col items-center justify-center p-6 md:p-8 text-center rounded-[var(--fiori-radius-md)] border border-dashed border-[var(--fiori-border-strong)] bg-[var(--fiori-bg-surface)] ${className}`}
    >
      <div className="w-12 h-12 rounded-[var(--fiori-radius-md)] bg-[var(--fiori-brand-bg)] border border-[var(--fiori-brand-border)] flex items-center justify-center text-[var(--fiori-brand)] mb-3">
        <FinalIcon className="w-6 h-6 stroke-[1.6]" />
      </div>

      <h3 className="font-semibold text-sm text-[var(--fiori-text-primary)] mb-1">{finalTitle}</h3>
      <p className="text-xs text-[var(--fiori-text-secondary)] max-w-md mx-auto leading-relaxed mb-4">
        {finalDescription}
      </p>

      {finalSteps && finalSteps.length > 0 && (
        <div className="bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] p-3 max-w-md w-full text-right text-xs mb-4">
          <div className="text-[11px] font-semibold text-[var(--fiori-text-primary)] mb-1.5">
            راهنمای شروع:
          </div>
          <ul className="space-y-1 text-[var(--fiori-text-secondary)] text-[11px]">
            {finalSteps.map((step, sIdx) => (
              <li key={sIdx} className="flex items-start gap-2">
                <span className="text-[var(--fiori-brand)] shrink-0">•</span>
                <span>{step}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2">
        {finalActionLabel && onAction && (
          <button
            type="button"
            onClick={onAction}
            className="sap-btn-emphasized flex items-center gap-1.5 px-3.5 py-1.5 text-xs cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{finalActionLabel}</span>
          </button>
        )}

        {finalSecondaryLabel && onSecondaryAction && (
          <button
            type="button"
            onClick={onSecondaryAction}
            className="sap-btn-standard flex items-center gap-1.5 px-3.5 py-1.5 text-xs cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
            <span>{finalSecondaryLabel}</span>
          </button>
        )}
      </div>
    </div>
  );
};
