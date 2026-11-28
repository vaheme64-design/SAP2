import React from 'react';
import { toPersianDigits } from '../../../utils/formatters';

export interface FioriIconTabItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  count?: number;
  badgeTone?: 'neutral' | 'brand' | 'critical' | 'negative' | 'positive';
}

export interface FioriIconTabBarProps {
  tabs: FioriIconTabItem[];
  activeTab: string;
  onChange: (tabId: string) => void;
  endContent?: React.ReactNode;
  ariaLabel?: string;
  className?: string;
}

const BADGE_CLS: Record<NonNullable<FioriIconTabItem['badgeTone']>, string> = {
  neutral:
    'bg-[var(--fiori-neutral-bg)] text-[var(--fiori-text-secondary)] border-[var(--fiori-neutral-border)]',
  brand:
    'bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border-[var(--fiori-brand-border)]',
  critical:
    'bg-[var(--fiori-critical-bg)] text-[var(--fiori-critical)] border-[var(--fiori-critical-border)]',
  negative:
    'bg-[var(--fiori-negative-bg)] text-[var(--fiori-negative)] border-[var(--fiori-negative-border)]',
  positive:
    'bg-[var(--fiori-positive-bg)] text-[var(--fiori-positive)] border-[var(--fiori-positive-border)]',
};

export const FioriIconTabBar: React.FC<FioriIconTabBarProps> = ({
  tabs,
  activeTab,
  onChange,
  endContent,
  ariaLabel = 'تب‌های صفحه',
  className = '',
}) => {
  return (
    <div
      dir="rtl"
      className={`flex flex-col sm:flex-row sm:items-center justify-between gap-1 bg-[var(--fiori-bg-surface)] border-t border-[var(--fiori-border-subtle)] px-3 ${className}`}
    >
      <div
        role="tablist"
        aria-label={ariaLabel}
        className="sap-icon-tab-bar border-b-0 flex-1 min-w-0"
      >
        {tabs.map(tab => {
          const isActive = tab.id === activeTab;
          const badgeTone = tab.badgeTone || (isActive ? 'brand' : 'neutral');

          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(tab.id)}
              className={`sap-icon-tab fiori-focus-ring ${
                isActive ? 'sap-icon-tab-active' : ''
              }`}
            >
              {tab.icon && <span className="shrink-0">{tab.icon}</span>}
              <span>{tab.label}</span>
              {typeof tab.count === 'number' && (
                <span
                  className={`px-1.5 py-0.2 rounded-[var(--fiori-radius-sm)] border text-[10px] font-mono tabular-nums ${BADGE_CLS[badgeTone]}`}
                >
                  {toPersianDigits(tab.count)}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {endContent && (
        <div className="flex items-center gap-1.5 py-1.5 sm:py-0 sm:pr-2.5 sm:border-r sm:border-[var(--fiori-border-subtle)] shrink-0">
          {endContent}
        </div>
      )}
    </div>
  );
};
