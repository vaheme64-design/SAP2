import React from 'react';
import type { FioriStatusTone } from './FioriObjectStatus';

export interface FioriKpiItem {
  id: string;
  label: string;
  value: React.ReactNode;
  unit?: string;
  subtext?: React.ReactNode;
  tone?: FioriStatusTone;
  icon?: React.ReactNode;
  progressPercent?: number;
  active?: boolean;
  onClick?: () => void;
  title?: string;
}

export interface FioriKpiStripProps {
  items: FioriKpiItem[];
  loading?: boolean;
  columns?: 3 | 4 | 5 | 6;
  className?: string;
}

const VALUE_TONE_CLS: Record<FioriStatusTone, string> = {
  positive: 'text-[var(--fiori-positive)]',
  critical: 'text-[var(--fiori-critical)]',
  negative: 'text-[var(--fiori-negative)]',
  info: 'text-[var(--fiori-info)]',
  brand: 'text-[var(--fiori-brand)]',
  neutral: 'text-[var(--fiori-text-primary)]',
};

const ICON_TONE_CLS: Record<FioriStatusTone, string> = {
  positive: 'text-[var(--fiori-positive)]',
  critical: 'text-[var(--fiori-critical)]',
  negative: 'text-[var(--fiori-negative)]',
  info: 'text-[var(--fiori-info)]',
  brand: 'text-[var(--fiori-brand)]',
  neutral: 'text-[var(--fiori-text-secondary)]',
};

const PROGRESS_TONE_CLS: Record<FioriStatusTone, string> = {
  positive: 'bg-[var(--fiori-positive)]',
  critical: 'bg-[var(--fiori-critical)]',
  negative: 'bg-[var(--fiori-negative)]',
  info: 'bg-[var(--fiori-info)]',
  brand: 'bg-[var(--fiori-brand)]',
  neutral: 'bg-[var(--fiori-neutral)]',
};

const GRID_COLS: Record<3 | 4 | 5 | 6, string> = {
  3: 'grid-cols-1 sm:grid-cols-3',
  4: 'grid-cols-2 lg:grid-cols-4',
  5: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5',
  6: 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-6',
};

export const FioriKpiStrip: React.FC<FioriKpiStripProps> = ({
  items,
  loading = false,
  columns = 5,
  className = '',
}) => {
  return (
    <div dir="rtl" className={`grid ${GRID_COLS[columns]} gap-2.5 ${className}`}>
      {items.map((item, idx) => {
        const tone = item.tone || 'neutral';
        const isInteractive = Boolean(item.onClick);
        const isOddLastOnMobile =
          columns >= 4 && items.length % 2 === 1 && idx === items.length - 1;
        const baseClasses = `text-right bg-[var(--fiori-bg-surface)] border rounded-[var(--fiori-radius-sm)] px-3 py-2.5 transition-colors flex flex-col justify-between min-w-0 ${
          isOddLastOnMobile ? 'col-span-2 sm:col-span-1' : ''
        } ${
          item.active
            ? 'border-[var(--fiori-brand)] bg-[var(--fiori-brand-bg)]/45 ring-1 ring-[var(--fiori-brand)]/25'
            : 'border-[var(--fiori-border-default)]'
        } ${
          isInteractive
            ? 'cursor-pointer hover:border-[var(--fiori-brand)] hover:bg-[var(--fiori-bg-hover)]/50 fiori-focus-ring'
            : ''
        }`;

        const inner = loading ? (
          <div className="space-y-2 animate-pulse" aria-hidden="true">
            <div className="h-3 w-20 bg-[var(--fiori-bg-hover)] rounded" />
            <div className="h-6 w-14 bg-[var(--fiori-border-subtle)] rounded" />
            <div className="h-2.5 w-24 bg-[var(--fiori-bg-hover)] rounded" />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-1.5 text-[11px] font-medium text-[var(--fiori-text-secondary)]">
              <span className="truncate">{item.label}</span>
              {item.icon && (
                <span className={`shrink-0 ${ICON_TONE_CLS[tone]}`}>{item.icon}</span>
              )}
            </div>

            <div className="mt-1 flex items-baseline gap-1 min-w-0">
              <span
                className={`text-lg font-semibold font-mono tabular-nums leading-tight truncate ${VALUE_TONE_CLS[tone]}`}
              >
                {item.value}
              </span>
              {item.unit && (
                <span className="text-[10px] font-normal text-[var(--fiori-text-muted)] shrink-0">
                  {item.unit}
                </span>
              )}
            </div>

            {typeof item.progressPercent === 'number' && (
              <div className="w-full h-1.5 bg-[var(--fiori-neutral-bg)] rounded-full overflow-hidden mt-1.5">
                <div
                  className={`h-full transition-all ${PROGRESS_TONE_CLS[tone]}`}
                  style={{
                    width: `${Math.min(100, Math.max(0, item.progressPercent))}%`,
                  }}
                />
              </div>
            )}

            {item.subtext && (
              <div className="text-[10px] text-[var(--fiori-text-muted)] mt-1 truncate">
                {item.subtext}
              </div>
            )}
          </>
        );

        if (isInteractive) {
          return (
            <button
              key={item.id}
              type="button"
              onClick={item.onClick}
              title={item.title}
              aria-pressed={item.active}
              className={baseClasses}
            >
              {inner}
            </button>
          );
        }

        return (
          <div key={item.id} title={item.title} className={baseClasses}>
            {inner}
          </div>
        );
      })}
    </div>
  );
};
