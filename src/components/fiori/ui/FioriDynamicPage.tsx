import React, { useState } from 'react';
import { ChevronDown, ChevronUp, FilterX, SlidersHorizontal } from 'lucide-react';
import { toPersianDigits } from '../../../utils/formatters';

export interface FioriBreadcrumbItem {
  label: string;
  onClick?: () => void;
}

export interface FioriDynamicPageProps {
  title: string;
  subtitle?: string;
  breadcrumbs?: FioriBreadcrumbItem[];
  status?: React.ReactNode;
  headerActions?: React.ReactNode;
  kpiStrip?: React.ReactNode;
  filterBar?: React.ReactNode;
  collapsibleFilters?: boolean;
  filterCollapsedDefault?: boolean;
  activeFiltersCount?: number;
  onResetFilters?: () => void;
  toolbar?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export const FioriDynamicPage: React.FC<FioriDynamicPageProps> = ({
  title,
  subtitle,
  breadcrumbs,
  status,
  headerActions,
  kpiStrip,
  filterBar,
  collapsibleFilters = true,
  filterCollapsedDefault = false,
  activeFiltersCount = 0,
  onResetFilters,
  toolbar,
  footer,
  children,
  className = '',
}) => {
  const [filtersCollapsed, setFiltersCollapsed] = useState(filterCollapsedDefault);
  const hasHeaderContent = Boolean(kpiStrip || filterBar);

  return (
    <div dir="rtl" className={`space-y-3 ${className}`}>
      {/* Dynamic Page Header + Snapping/Collapsible Header Content */}
      <section className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)] overflow-visible">
        {/* Title Bar */}
        <div className="px-4 py-3 flex flex-col md:flex-row md:items-center justify-between gap-2.5 border-b border-[var(--fiori-border-subtle)]">
          <div className="min-w-0 space-y-1">
            {breadcrumbs && breadcrumbs.length > 0 && (
              <nav
                aria-label="مسیر صفحه"
                className="flex flex-wrap items-center gap-1 text-[11px] text-[var(--fiori-text-secondary)]"
              >
                {breadcrumbs.map((bc, idx) => (
                  <React.Fragment key={`${bc.label}-${idx}`}>
                    {idx > 0 && <span className="text-[var(--fiori-text-muted)]">/</span>}
                    {bc.onClick ? (
                      <button
                        type="button"
                        onClick={bc.onClick}
                        className="hover:text-[var(--fiori-brand)] hover:underline cursor-pointer transition"
                      >
                        {bc.label}
                      </button>
                    ) : (
                      <span className="font-medium text-[var(--fiori-text-primary)]">
                        {bc.label}
                      </span>
                    )}
                  </React.Fragment>
                ))}
              </nav>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm sm:text-[15px] font-semibold text-[var(--fiori-text-primary)] truncate">
                {title}
              </h2>
              {status}
            </div>

            {subtitle && (
              <p className="text-[11px] text-[var(--fiori-text-secondary)] leading-relaxed">
                {subtitle}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {collapsibleFilters && hasHeaderContent && (
              <button
                type="button"
                onClick={() => setFiltersCollapsed(prev => !prev)}
                aria-expanded={!filtersCollapsed}
                className="sap-btn-standard px-2.5 py-1.5 text-xs inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span>{filtersCollapsed ? 'نمایش فیلترها' : 'بستن فیلترها'}</span>
                {activeFiltersCount > 0 && (
                  <span className="px-1.5 py-0.2 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] font-mono text-[10px]">
                    {toPersianDigits(activeFiltersCount)}
                  </span>
                )}
                {filtersCollapsed ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronUp className="w-3.5 h-3.5" />
                )}
              </button>
            )}

            {activeFiltersCount > 0 && onResetFilters && (
              <button
                type="button"
                onClick={onResetFilters}
                className="sap-btn-standard px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer whitespace-nowrap"
              >
                <FilterX className="w-3.5 h-3.5" />
                <span>پاکسازی فیلترها</span>
              </button>
            )}

            {headerActions}
          </div>
        </div>

        {/* Expandable Dynamic Header Content (KPIs + FilterBar) */}
        {hasHeaderContent && !filtersCollapsed && (
          <div className="px-4 py-3 space-y-3 bg-[var(--fiori-bg-subtle)]/60">
            {kpiStrip}
            {filterBar}
          </div>
        )}
      </section>

      {/* Optional Mid-Page Toolbar */}
      {toolbar}

      {/* Main Content Area */}
      <div className="space-y-3">{children}</div>

      {/* Optional Anchored Page Footer */}
      {footer && (
        <div className="px-4 py-2.5 bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)] flex flex-wrap items-center justify-between gap-2">
          {footer}
        </div>
      )}
    </div>
  );
};
