import React from 'react';
import { toPersianDigits } from '../../../utils/formatters';

export interface FioriToolbarProps {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  count?: number;
  countLabel?: string;
  startContent?: React.ReactNode;
  endContent?: React.ReactNode;
  variant?: 'page' | 'table' | 'section';
  className?: string;
}

export const FioriToolbar: React.FC<FioriToolbarProps> = ({
  title,
  subtitle,
  count,
  countLabel = 'مورد',
  startContent,
  endContent,
  variant = 'table',
  className = '',
}) => {
  const variantClasses =
    variant === 'page'
      ? 'px-4 py-2.5 bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)]'
      : variant === 'section'
      ? 'py-2 border-b border-[var(--fiori-border-subtle)]'
      : 'px-3.5 py-2.5 bg-[var(--fiori-bg-surface)] border-b border-[var(--fiori-border-default)]';

  return (
    <div
      dir="rtl"
      className={`flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 ${variantClasses} ${className}`}
    >
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        {(title || subtitle || typeof count === 'number') && (
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {title && (
                <span className="text-xs sm:text-[13px] font-semibold text-[var(--fiori-text-primary)] truncate">
                  {title}
                </span>
              )}
              {typeof count === 'number' && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-neutral-bg)] border border-[var(--fiori-neutral-border)] text-[11px] font-mono tabular-nums text-[var(--fiori-text-secondary)]">
                  {toPersianDigits(count)} {countLabel}
                </span>
              )}
            </div>
            {subtitle && (
              <p className="text-[11px] text-[var(--fiori-text-secondary)] mt-0.5 truncate">
                {subtitle}
              </p>
            )}
          </div>
        )}
        {startContent}
      </div>

      {endContent && (
        <div className="flex flex-wrap items-center gap-2 shrink-0 justify-end">
          {endContent}
        </div>
      )}
    </div>
  );
};
