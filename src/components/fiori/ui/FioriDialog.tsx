import React, { useEffect, useId } from 'react';
import { X } from 'lucide-react';

export type FioriDialogSize = 'sm' | 'md' | 'lg' | 'xl';
export type FioriDialogTone = 'default' | 'brand' | 'positive' | 'warning' | 'danger';

export interface FioriDialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: FioriDialogTone;
  size?: FioriDialogSize;
  headerActions?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  closeOnBackdrop?: boolean;
  disableClose?: boolean;
  className?: string;
}

const SIZE_MAP: Record<FioriDialogSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

const ICON_TONE_MAP: Record<FioriDialogTone, string> = {
  default:
    'bg-[var(--fiori-neutral-bg)] text-[var(--fiori-neutral)] border-[var(--fiori-neutral-border)]',
  brand:
    'bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border-[var(--fiori-brand-border)]',
  positive:
    'bg-[var(--fiori-positive-bg)] text-[var(--fiori-positive)] border-[var(--fiori-positive-border)]',
  warning:
    'bg-[var(--fiori-critical-bg)] text-[var(--fiori-critical)] border-[var(--fiori-critical-border)]',
  danger:
    'bg-[var(--fiori-negative-bg)] text-[var(--fiori-negative)] border-[var(--fiori-negative-border)]',
};

export const FioriDialog: React.FC<FioriDialogProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  icon,
  tone = 'default',
  size = 'md',
  headerActions,
  footer,
  children,
  closeOnBackdrop = true,
  disableClose = false,
  className = '',
}) => {
  const titleId = useId();

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !disableClose) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, disableClose, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[60] bg-[#1d2d3e]/45 backdrop-blur-[1px] flex items-center justify-center p-3 sm:p-4 no-print"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      dir="rtl"
      onClick={() => {
        if (closeOnBackdrop && !disableClose) onClose();
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className={`w-full ${SIZE_MAP[size]} max-h-[90vh] flex flex-col bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-lg)] shadow-[var(--fiori-shadow-dialog)] overflow-hidden ${className}`}
      >
        {/* Dialog Header */}
        <div className="px-4 py-3 bg-[var(--fiori-bg-surface)] border-b border-[var(--fiori-border-subtle)] flex items-start justify-between gap-3 shrink-0">
          <div className="flex items-start gap-2.5 min-w-0">
            {icon && (
              <div
                className={`p-2 rounded-[var(--fiori-radius-md)] border shrink-0 ${ICON_TONE_MAP[tone]}`}
              >
                {icon}
              </div>
            )}
            <div className="min-w-0">
              <h3
                id={titleId}
                className="text-sm sm:text-[15px] font-semibold text-[var(--fiori-text-primary)] leading-snug"
              >
                {title}
              </h3>
              {subtitle && (
                <div className="text-xs text-[var(--fiori-text-secondary)] mt-0.5">
                  {subtitle}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {headerActions}
            <button
              type="button"
              onClick={() => {
                if (!disableClose) onClose();
              }}
              disabled={disableClose}
              aria-label="بستن پنجره"
              className="p-1.5 rounded-[var(--fiori-radius-sm)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] hover:bg-[var(--fiori-bg-hover)] transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed fiori-focus-ring"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Dialog Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3.5 space-y-3">
          {children}
        </div>

        {/* Dialog Footer */}
        {footer && (
          <div className="px-4 py-2.5 bg-[var(--fiori-bg-subtle)] border-t border-[var(--fiori-border-subtle)] flex flex-wrap items-center justify-end gap-2 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};
