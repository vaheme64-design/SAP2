import React from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Info,
  CircleDot,
} from 'lucide-react';

export type FioriStatusTone =
  | 'positive'
  | 'critical'
  | 'negative'
  | 'info'
  | 'brand'
  | 'neutral';

export interface FioriObjectStatusProps {
  tone?: FioriStatusTone;
  label: React.ReactNode;
  variant?: 'badge' | 'text' | 'dot';
  size?: 'sm' | 'md';
  icon?: React.ReactNode | boolean;
  ltrCode?: boolean;
  className?: string;
  title?: string;
}

const TONE_CLASSES: Record<
  FioriStatusTone,
  {
    text: string;
    badge: string;
    dot: string;
  }
> = {
  positive: {
    text: 'text-[var(--fiori-positive)]',
    badge:
      'bg-[var(--fiori-positive-bg)] text-[var(--fiori-positive)] border-[var(--fiori-positive-border)]',
    dot: 'bg-[var(--fiori-positive)]',
  },
  critical: {
    text: 'text-[var(--fiori-critical)]',
    badge:
      'bg-[var(--fiori-critical-bg)] text-[var(--fiori-critical)] border-[var(--fiori-critical-border)]',
    dot: 'bg-[var(--fiori-critical)]',
  },
  negative: {
    text: 'text-[var(--fiori-negative)]',
    badge:
      'bg-[var(--fiori-negative-bg)] text-[var(--fiori-negative)] border-[var(--fiori-negative-border)]',
    dot: 'bg-[var(--fiori-negative)]',
  },
  info: {
    text: 'text-[var(--fiori-info)]',
    badge:
      'bg-[var(--fiori-info-bg)] text-[var(--fiori-info)] border-[var(--fiori-info-border)]',
    dot: 'bg-[var(--fiori-info)]',
  },
  brand: {
    text: 'text-[var(--fiori-brand)]',
    badge:
      'bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border-[var(--fiori-brand-border)]',
    dot: 'bg-[var(--fiori-brand)]',
  },
  neutral: {
    text: 'text-[var(--fiori-neutral)]',
    badge:
      'bg-[var(--fiori-neutral-bg)] text-[var(--fiori-neutral)] border-[var(--fiori-neutral-border)]',
    dot: 'bg-[var(--fiori-neutral)]',
  },
};

function renderDefaultIcon(tone: FioriStatusTone, size: 'sm' | 'md') {
  const iconCls = size === 'sm' ? 'w-3 h-3 shrink-0' : 'w-3.5 h-3.5 shrink-0';
  switch (tone) {
    case 'positive':
      return <CheckCircle2 className={iconCls} />;
    case 'critical':
      return <AlertTriangle className={iconCls} />;
    case 'negative':
      return <XCircle className={iconCls} />;
    case 'info':
    case 'brand':
      return <Info className={iconCls} />;
    case 'neutral':
    default:
      return <CircleDot className={iconCls} />;
  }
}

export const FioriObjectStatus: React.FC<FioriObjectStatusProps> = ({
  tone = 'neutral',
  label,
  variant = 'badge',
  size = 'sm',
  icon = false,
  ltrCode = false,
  className = '',
  title,
}) => {
  const styles = TONE_CLASSES[tone];
  const sizeCls =
    size === 'sm'
      ? 'text-[11px] leading-tight'
      : 'text-xs leading-snug';

  const badgePadding =
    size === 'sm' ? 'px-2 py-0.5' : 'px-2.5 py-1';

  const renderedIcon =
    icon === true
      ? renderDefaultIcon(tone, size)
      : icon === false || icon === undefined
      ? null
      : icon;

  const content = ltrCode ? (
    <span className="fiori-ltr-code font-mono">{label}</span>
  ) : (
    <span>{label}</span>
  );

  if (variant === 'text') {
    return (
      <span
        title={title}
        className={`inline-flex items-center gap-1 font-semibold whitespace-nowrap ${sizeCls} ${styles.text} ${className}`}
      >
        {renderedIcon}
        {content}
      </span>
    );
  }

  if (variant === 'dot') {
    return (
      <span
        title={title}
        className={`inline-flex items-center gap-1.5 font-semibold whitespace-nowrap ${sizeCls} ${styles.text} ${className}`}
      >
        <span className={`w-2 h-2 rounded-sm shrink-0 ${styles.dot}`} />
        {content}
      </span>
    );
  }

  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 font-semibold border rounded-[var(--fiori-radius-sm)] whitespace-nowrap ${badgePadding} ${sizeCls} ${styles.badge} ${className}`}
    >
      {renderedIcon}
      {content}
    </span>
  );
};
