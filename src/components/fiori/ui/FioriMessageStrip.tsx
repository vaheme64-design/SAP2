import React from 'react';
import {
  Info,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  X,
} from 'lucide-react';

export type FioriMessageStripTone = 'info' | 'success' | 'warning' | 'error';

export interface FioriMessageStripProps {
  tone?: FioriMessageStripTone;
  title?: string;
  children: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  onClose?: () => void;
  compact?: boolean;
  className?: string;
}

const STRIP_STYLES: Record<
  FioriMessageStripTone,
  {
    container: string;
    accentBorder: string;
    iconColor: string;
    titleColor: string;
  }
> = {
  info: {
    container:
      'bg-[var(--fiori-info-bg)] border-[var(--fiori-info-border)] text-[var(--fiori-text-primary)]',
    accentBorder: 'border-r-[3px] border-r-[var(--fiori-info)]',
    iconColor: 'text-[var(--fiori-info)]',
    titleColor: 'text-[var(--fiori-text-primary)]',
  },
  success: {
    container:
      'bg-[var(--fiori-positive-bg)] border-[var(--fiori-positive-border)] text-[var(--fiori-text-primary)]',
    accentBorder: 'border-r-[3px] border-r-[var(--fiori-positive)]',
    iconColor: 'text-[var(--fiori-positive)]',
    titleColor: 'text-[var(--fiori-positive)]',
  },
  warning: {
    container:
      'bg-[var(--fiori-critical-bg)] border-[var(--fiori-critical-border)] text-[var(--fiori-text-primary)]',
    accentBorder: 'border-r-[3px] border-r-[var(--fiori-critical)]',
    iconColor: 'text-[var(--fiori-critical)]',
    titleColor: 'text-[var(--fiori-critical)]',
  },
  error: {
    container:
      'bg-[var(--fiori-negative-bg)] border-[var(--fiori-negative-border)] text-[var(--fiori-text-primary)]',
    accentBorder: 'border-r-[3px] border-r-[var(--fiori-negative)]',
    iconColor: 'text-[var(--fiori-negative)]',
    titleColor: 'text-[var(--fiori-negative)]',
  },
};

function defaultIcon(tone: FioriMessageStripTone) {
  const cls = 'w-4 h-4 shrink-0';
  switch (tone) {
    case 'success':
      return <CheckCircle2 className={cls} />;
    case 'warning':
      return <AlertTriangle className={cls} />;
    case 'error':
      return <XCircle className={cls} />;
    case 'info':
    default:
      return <Info className={cls} />;
  }
}

export const FioriMessageStrip: React.FC<FioriMessageStripProps> = ({
  tone = 'info',
  title,
  children,
  icon,
  actions,
  onClose,
  compact = false,
  className = '',
}) => {
  const style = STRIP_STYLES[tone];

  return (
    <div
      role={tone === 'error' || tone === 'warning' ? 'alert' : 'status'}
      dir="rtl"
      className={`border rounded-[var(--fiori-radius-md)] ${style.container} ${style.accentBorder} ${
        compact ? 'px-2.5 py-2 text-[11px]' : 'px-3 py-2.5 text-xs'
      } flex items-start justify-between gap-2.5 ${className}`}
    >
      <div className="flex items-start gap-2 min-w-0 flex-1">
        <span className={`mt-0.5 ${style.iconColor}`}>
          {icon ?? defaultIcon(tone)}
        </span>
        <div className="min-w-0 flex-1 space-y-0.5 leading-relaxed">
          {title && (
            <div className={`font-semibold ${style.titleColor}`}>{title}</div>
          )}
          <div className="text-[var(--fiori-text-primary)]">{children}</div>
        </div>
      </div>

      {(actions || onClose) && (
        <div className="flex items-center gap-1.5 shrink-0">
          {actions}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="بستن پیام"
              className="p-1 rounded-[var(--fiori-radius-sm)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] hover:bg-black/5 transition cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
};
