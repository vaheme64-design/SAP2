import React from 'react';
import { FilterX, Search, X } from 'lucide-react';
import { toPersianDigits } from '../../../utils/formatters';

export interface FioriFilterSegment {
  id: string;
  label: string;
  count?: number;
}

export interface FioriFilterBarProps {
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  searchAriaLabel?: string;
  segments?: FioriFilterSegment[];
  activeSegment?: string;
  onSegmentChange?: (segmentId: string) => void;
  extraControls?: React.ReactNode;
  hasActiveFilters?: boolean;
  onReset?: () => void;
  className?: string;
}

export const FioriFilterBar: React.FC<FioriFilterBarProps> = ({
  searchValue,
  onSearchChange,
  searchPlaceholder = 'جستجو...',
  searchAriaLabel = 'جستجو در جدول',
  segments,
  activeSegment,
  onSegmentChange,
  extraControls,
  hasActiveFilters = false,
  onReset,
  className = '',
}) => {
  return (
    <div
      dir="rtl"
      className={`flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between ${className}`}
    >
      <div className="flex flex-1 flex-wrap items-center gap-2 min-w-0">
        {onSearchChange !== undefined && (
          <div className="relative flex-1 min-w-[210px] max-w-md">
            <Search className="w-3.5 h-3.5 text-[var(--fiori-text-muted)] absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchValue ?? ''}
              onChange={e => onSearchChange(e.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchAriaLabel}
              className="fiori-input w-full pr-8 pl-7 py-1.5"
            />
            {searchValue && (
              <button
                type="button"
                onClick={() => onSearchChange('')}
                aria-label="پاک کردن متن جستجو"
                className="absolute left-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-[var(--fiori-text-muted)] hover:text-[var(--fiori-text-primary)] cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}

        {extraControls}
      </div>

      <div className="flex flex-wrap items-center gap-2 shrink-0">
        {segments && segments.length > 0 && onSegmentChange && (
          <div
            role="group"
            aria-label="فیلتر وضعیت"
            className="inline-flex flex-wrap items-center bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] p-0.5 gap-0.5"
          >
            {segments.map(seg => {
              const isActive = activeSegment === seg.id;
              return (
                <button
                  key={seg.id}
                  type="button"
                  onClick={() => onSegmentChange(seg.id)}
                  aria-pressed={isActive}
                  className={`px-2.5 py-1 rounded-[3px] text-[11px] font-medium transition-colors cursor-pointer inline-flex items-center gap-1.5 whitespace-nowrap fiori-focus-ring ${
                    isActive
                      ? 'bg-[var(--fiori-brand)] text-white font-semibold'
                      : 'text-[var(--fiori-text-secondary)] hover:bg-[var(--fiori-bg-hover)] hover:text-[var(--fiori-text-primary)]'
                  }`}
                >
                  <span>{seg.label}</span>
                  {typeof seg.count === 'number' && (
                    <span
                      className={`px-1 py-0.2 rounded-[2px] text-[10px] font-mono tabular-nums ${
                        isActive
                          ? 'bg-white/20 text-white'
                          : 'bg-[var(--fiori-neutral-bg)] text-[var(--fiori-text-secondary)]'
                      }`}
                    >
                      {toPersianDigits(seg.count)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {hasActiveFilters && onReset && (
          <button
            type="button"
            onClick={onReset}
            className="sap-btn-standard px-2.5 py-1.5 text-[11px] inline-flex items-center gap-1 cursor-pointer whitespace-nowrap"
          >
            <FilterX className="w-3.5 h-3.5" />
            <span>حذف فیلترها</span>
          </button>
        )}
      </div>
    </div>
  );
};
