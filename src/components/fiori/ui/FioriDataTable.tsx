import React, { useMemo, useState } from 'react';
import {
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  ChevronRight,
  ChevronLeft,
  Loader2,
} from 'lucide-react';
import { toPersianDigits } from '../../../utils/formatters';

export interface FioriTableColumn<T> {
  key: string;
  header: React.ReactNode;
  align?: 'right' | 'center' | 'left';
  width?: string;
  sortable?: boolean;
  sortValue?: (row: T) => string | number;
  isMono?: boolean;
  isLtrCode?: boolean;
  nowrap?: boolean;
  hideBelow?: 'sm' | 'md' | 'lg';
  headerClassName?: string;
  cellClassName?: string | ((row: T, index: number) => string);
  render: (row: T, index: number) => React.ReactNode;
}

export interface FioriTablePagination {
  currentPage: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  pageSizeOptions?: number[];
  onPageSizeChange?: (size: number) => void;
}

export interface FioriDataTableProps<T> {
  columns: FioriTableColumn<T>[];
  data: T[];
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T, index: number) => string;
  loading?: boolean;
  emptyState?: React.ReactNode;
  toolbar?: React.ReactNode;
  sortKey?: string;
  sortDirection?: 'asc' | 'desc';
  onSortChange?: (key: string, direction: 'asc' | 'desc') => void;
  defaultSortKey?: string;
  defaultSortDirection?: 'asc' | 'desc';
  pagination?: FioriTablePagination;
  stickyHeader?: boolean;
  compact?: boolean;
  bordered?: boolean;
  className?: string;
}

const ALIGN_CLS: Record<'right' | 'center' | 'left', string> = {
  right: 'text-right',
  center: 'text-center',
  left: 'text-left',
};

const HIDE_BELOW_CLS: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
};

export function FioriDataTable<T>({
  columns,
  data,
  rowKey,
  onRowClick,
  rowClassName,
  loading = false,
  emptyState,
  toolbar,
  sortKey: controlledSortKey,
  sortDirection: controlledSortDirection,
  onSortChange,
  defaultSortKey,
  defaultSortDirection = 'desc',
  pagination,
  stickyHeader = false,
  compact = true,
  bordered = true,
  className = '',
}: FioriDataTableProps<T>) {
  const [internalSortKey, setInternalSortKey] = useState<string | undefined>(defaultSortKey);
  const [internalSortDirection, setInternalSortDirection] = useState<'asc' | 'desc'>(
    defaultSortDirection
  );

  const activeSortKey = controlledSortKey !== undefined ? controlledSortKey : internalSortKey;
  const activeSortDirection =
    controlledSortDirection !== undefined ? controlledSortDirection : internalSortDirection;

  const handleSortClick = (col: FioriTableColumn<T>) => {
    if (!col.sortable) return;
    const nextDir: 'asc' | 'desc' =
      activeSortKey === col.key && activeSortDirection === 'asc' ? 'desc' : 'asc';
    if (onSortChange) {
      onSortChange(col.key, nextDir);
    } else {
      setInternalSortKey(col.key);
      setInternalSortDirection(nextDir);
    }
  };

  const sortedData = useMemo(() => {
    // Only apply client-side sorting if onSortChange is NOT controlled externally
    if (onSortChange || !activeSortKey) return data;
    const targetCol = columns.find(c => c.key === activeSortKey);
    if (!targetCol || !targetCol.sortValue) return data;

    const extract = targetCol.sortValue;
    return [...data].sort((a, b) => {
      const av = extract(a);
      const bv = extract(b);
      let cmp = 0;
      if (typeof av === 'number' && typeof bv === 'number') {
        cmp = av - bv;
      } else {
        cmp = String(av ?? '').localeCompare(String(bv ?? ''), 'fa');
      }
      return activeSortDirection === 'asc' ? cmp : -cmp;
    });
  }, [data, columns, activeSortKey, activeSortDirection, onSortChange]);

  const totalPages = pagination
    ? Math.max(1, Math.ceil(pagination.totalItems / Math.max(1, pagination.pageSize)))
    : 1;

  const startItem =
    pagination && pagination.totalItems > 0
      ? (pagination.currentPage - 1) * pagination.pageSize + 1
      : 0;
  const endItem = pagination
    ? Math.min(pagination.totalItems, pagination.currentPage * pagination.pageSize)
    : 0;

  return (
    <div
      dir="rtl"
      className={`bg-[var(--fiori-bg-surface)] overflow-hidden ${
        bordered
          ? 'border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)]'
          : ''
      } ${className}`}
    >
      {toolbar}

      <div className="relative overflow-x-auto">
        {loading && (
          <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-center bg-white/75 backdrop-blur-[1px] py-2 border-b border-[var(--fiori-border-subtle)]">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--fiori-brand)]">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>در حال بارگذاری اطلاعات...</span>
            </span>
          </div>
        )}

        <table
          className={`w-full text-right text-xs ${
            compact ? 'sap-table-compact' : ''
          }`}
        >
          <thead
            className={
              stickyHeader
                ? 'sticky top-0 z-10 bg-[var(--fiori-bg-surface)] shadow-[0_1px_0_var(--fiori-border-default)]'
                : ''
            }
          >
            <tr>
              {columns.map(col => {
                const alignCls = ALIGN_CLS[col.align || 'right'];
                const hideCls = col.hideBelow ? HIDE_BELOW_CLS[col.hideBelow] : '';
                const isSorted = activeSortKey === col.key;

                return (
                  <th
                    key={col.key}
                    style={col.width ? { width: col.width } : undefined}
                    className={`whitespace-nowrap text-[var(--fiori-text-primary)] select-none ${alignCls} ${hideCls} ${
                      col.headerClassName || ''
                    }`}
                  >
                    {col.sortable ? (
                      <button
                        type="button"
                        onClick={() => handleSortClick(col)}
                        className="inline-flex items-center gap-1 font-semibold text-inherit hover:text-[var(--fiori-brand)] transition cursor-pointer"
                      >
                        <span>{col.header}</span>
                        {isSorted ? (
                          activeSortDirection === 'asc' ? (
                            <ArrowUp className="w-3 h-3 text-[var(--fiori-brand)]" />
                          ) : (
                            <ArrowDown className="w-3 h-3 text-[var(--fiori-brand)]" />
                          )
                        ) : (
                          <ArrowUpDown className="w-3 h-3 opacity-40" />
                        )}
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody className="divide-y divide-[var(--fiori-border-subtle)] bg-[var(--fiori-bg-surface)] tabular-nums">
            {sortedData.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="!p-0">
                  {emptyState || (
                    <div className="py-10 text-center text-xs text-[var(--fiori-text-secondary)]">
                      هیچ رکوردی برای نمایش وجود ندارد.
                    </div>
                  )}
                </td>
              </tr>
            ) : (
              sortedData.map((row, rowIndex) => {
                const customRowClass = rowClassName ? rowClassName(row, rowIndex) : '';
                const isInteractive = Boolean(onRowClick);

                return (
                  <tr
                    key={rowKey(row, rowIndex)}
                    tabIndex={isInteractive ? 0 : undefined}
                    onClick={isInteractive ? () => onRowClick?.(row) : undefined}
                    onKeyDown={
                      isInteractive
                        ? e => {
                            if (
                              e.key === 'Enter' &&
                              e.target === e.currentTarget
                            ) {
                              e.preventDefault();
                              onRowClick?.(row);
                            }
                          }
                        : undefined
                    }
                    className={`${
                      isInteractive
                        ? 'cursor-pointer hover:bg-[var(--fiori-bg-selected)]/70 focus-visible:outline-2 focus-visible:outline-[var(--fiori-border-focus)]'
                        : 'hover:bg-[var(--fiori-bg-hover)]/60'
                    } transition-colors ${customRowClass}`}
                  >
                    {columns.map(col => {
                      const alignCls = ALIGN_CLS[col.align || 'right'];
                      const hideCls = col.hideBelow ? HIDE_BELOW_CLS[col.hideBelow] : '';
                      const dynamicCellCls =
                        typeof col.cellClassName === 'function'
                          ? col.cellClassName(row, rowIndex)
                          : col.cellClassName || '';

                      return (
                        <td
                          key={col.key}
                          className={`${alignCls} ${hideCls} ${
                            col.nowrap ? 'whitespace-nowrap' : ''
                          } ${col.isMono ? 'font-mono' : ''} ${dynamicCellCls}`}
                        >
                          {col.isLtrCode ? (
                            <span className="fiori-ltr-code font-mono">
                              {col.render(row, rowIndex)}
                            </span>
                          ) : (
                            col.render(row, rowIndex)
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Footer */}
      {pagination && pagination.totalItems > 0 && (
        <div className="px-3.5 py-2 bg-[var(--fiori-bg-subtle)] border-t border-[var(--fiori-border-default)] flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--fiori-text-secondary)]">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono tabular-nums">
              نمایش {toPersianDigits(startItem)} تا {toPersianDigits(endItem)} از{' '}
              {toPersianDigits(pagination.totalItems)} ردیف
            </span>
            {pagination.pageSizeOptions && pagination.onPageSizeChange && (
              <label className="inline-flex items-center gap-1.5 text-[11px]">
                <span>تعداد در صفحه:</span>
                <select
                  value={pagination.pageSize}
                  onChange={e => pagination.onPageSizeChange?.(Number(e.target.value))}
                  className="bg-white border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-1.5 py-0.5 text-[11px] font-mono text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-border-focus)]"
                >
                  {pagination.pageSizeOptions.map(opt => (
                    <option key={opt} value={opt}>
                      {toPersianDigits(opt)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-mono tabular-nums ml-1">
                صفحه {toPersianDigits(pagination.currentPage)} از{' '}
                {toPersianDigits(totalPages)}
              </span>
              <button
                type="button"
                onClick={() =>
                  pagination.onPageChange(Math.max(1, pagination.currentPage - 1))
                }
                disabled={pagination.currentPage <= 1}
                className="sap-btn-standard px-2 py-1 text-[11px] inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                <ChevronRight className="w-3.5 h-3.5" />
                <span>قبلی</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  pagination.onPageChange(
                    Math.min(totalPages, pagination.currentPage + 1)
                  )
                }
                disabled={pagination.currentPage >= totalPages}
                className="sap-btn-standard px-2 py-1 text-[11px] inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                <span>بعدی</span>
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
