import React from 'react';
import { FileText } from 'lucide-react';
import { formatNumber } from '../../utils/formatters';
import { FioriDialog, FioriObjectStatus, FioriStatusTone } from '../fiori/ui';

export interface DrillDownData {
  title: string;
  subtitle?: string;
  badge?: { text: string; color: string };
  fields: { label: string; value: string | number | React.ReactNode; isMono?: boolean; isHighlight?: boolean }[];
  detailsList?: { title: string; lines: { label: string; value: string | number }[] }[];
}

interface DrillDownModalProps {
  isOpen: boolean;
  onClose: () => void;
  data: DrillDownData | null;
}

function resolveBadgeTone(colorClass?: string): FioriStatusTone {
  if (!colorClass) return 'neutral';
  if (colorClass.includes('rose') || colorClass.includes('red') || colorClass.includes('bb0000')) return 'negative';
  if (colorClass.includes('amber') || colorClass.includes('orange') || colorClass.includes('e9730c')) return 'critical';
  if (colorClass.includes('emerald') || colorClass.includes('green') || colorClass.includes('107e3e')) return 'positive';
  if (colorClass.includes('blue') || colorClass.includes('007cc0')) return 'info';
  return 'neutral';
}

export const DrillDownModal: React.FC<DrillDownModalProps> = ({
  isOpen,
  onClose,
  data,
}) => {
  if (!isOpen || !data) return null;

  return (
    <FioriDialog
      isOpen={isOpen}
      onClose={onClose}
      title={data.title}
      subtitle={
        <div className="flex flex-wrap items-center gap-2">
          {data.subtitle && <span>{data.subtitle}</span>}
          {data.badge && (
            <FioriObjectStatus
              tone={resolveBadgeTone(data.badge.color)}
              label={data.badge.text}
              size="sm"
            />
          )}
        </div>
      }
      icon={<FileText className="w-4 h-4" />}
      tone="brand"
      size="lg"
      footer={
        <button
          type="button"
          onClick={onClose}
          className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
        >
          بستن
        </button>
      }
    >
      {/* Fields Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {data.fields.map((f, idx) => (
          <div
            key={idx}
            className={`p-2.5 rounded-[var(--fiori-radius-sm)] border text-xs ${
              f.isHighlight
                ? 'bg-[var(--fiori-brand-bg)]/70 border-[var(--fiori-brand-border)] text-[var(--fiori-text-primary)]'
                : 'bg-[var(--fiori-bg-subtle)] border-[var(--fiori-border-subtle)] text-[var(--fiori-text-primary)]'
            }`}
          >
            <div className="text-[11px] text-[var(--fiori-text-secondary)] mb-0.5">{f.label}</div>
            <div
              className={`font-semibold tabular-nums ${
                f.isMono ? 'font-mono fiori-ltr-code' : ''
              } ${f.isHighlight ? 'text-[var(--fiori-brand)] text-sm' : 'text-[var(--fiori-text-primary)]'}`}
            >
              {typeof f.value === 'number' ? formatNumber(f.value) : f.value}
            </div>
          </div>
        ))}
      </div>

      {/* Additional Details List if present */}
      {data.detailsList && data.detailsList.length > 0 && (
        <div className="space-y-2.5 pt-1">
          <h4 className="text-xs font-semibold text-[var(--fiori-text-primary)]">
            اقلام و مراحل سند مبدأ:
          </h4>
          <div className="space-y-2 max-h-48 overflow-y-auto pl-1">
            {data.detailsList.map((item, idx) => (
              <div
                key={idx}
                className="bg-[var(--fiori-bg-subtle)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-subtle)] text-xs space-y-1"
              >
                <div className="font-semibold text-[var(--fiori-text-primary)]">{item.title}</div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[var(--fiori-text-secondary)] text-[11px]">
                  {item.lines.map((l, li) => (
                    <span key={li}>
                      {l.label}:{' '}
                      <strong className="text-[var(--fiori-text-primary)] font-mono tabular-nums">
                        {typeof l.value === 'number' ? formatNumber(l.value) : l.value}
                      </strong>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </FioriDialog>
  );
};
