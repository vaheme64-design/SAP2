import React, { useState, useEffect } from 'react';
import { X, Printer } from 'lucide-react';
import { FioriDocumentFlowPanel } from './FioriDocumentFlowPanel';
import { FioriObjectStatus } from './ui/FioriObjectStatus';

export interface ObjectPageKpi {
  label: string;
  value: string;
  tone?: 'default' | 'positive' | 'critical' | 'negative' | 'brand';
}

export interface ObjectPageTab {
  id: string;
  label: string;
  content: React.ReactNode;
}

interface FioriObjectPageProps {
  isOpen: boolean;
  onClose: () => void;
  objectTypeLabel: string;
  objectId: string;
  title: string;
  subtitle?: string;
  statusText?: string;
  statusTone?: 'positive' | 'critical' | 'negative' | 'brand';
  kpis?: ObjectPageKpi[];
  headerActions?: React.ReactNode;
  tabs: ObjectPageTab[];
  documentFlowQuery?: string;
  onSelectDocumentFlowDoc?: (docNumber: string) => void;
  enablePrint?: boolean;
}

export const FioriObjectPage: React.FC<FioriObjectPageProps> = ({
  isOpen,
  onClose,
  objectTypeLabel,
  objectId,
  title,
  subtitle,
  statusText,
  statusTone = 'brand',
  kpis = [],
  headerActions,
  tabs,
  documentFlowQuery,
  onSelectDocumentFlowDoc,
  enablePrint = true,
}) => {
  const [activeTabId, setActiveTabId] = useState<string>(tabs[0]?.id || 'overview');

  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const kpiColor = (tone?: ObjectPageKpi['tone']) => {
    if (tone === 'positive') return 'text-[var(--fiori-positive)]';
    if (tone === 'negative') return 'text-[var(--fiori-negative)]';
    if (tone === 'critical') return 'text-[var(--fiori-critical)]';
    if (tone === 'brand') return 'text-[var(--fiori-brand)]';
    return 'text-[var(--fiori-text-primary)]';
  };

  const effectiveTabs: ObjectPageTab[] = [
    ...tabs,
    ...(documentFlowQuery
      ? [
          {
            id: '__document_flow__',
            label: 'جریان اسناد و ممیزی (Document Flow)',
            content: (
              <FioriDocumentFlowPanel
                docNumber={documentFlowQuery}
                onSelectDoc={onSelectDocumentFlowDoc}
              />
            ),
          },
        ]
      : []),
  ];

  const currentTab = effectiveTabs.find(t => t.id === activeTabId) || effectiveTabs[0];

  return (
    <div
      className="fixed inset-0 z-50 bg-[#1d2d3e]/45 backdrop-blur-[1px] flex items-center justify-center p-2 sm:p-4"
      role="dialog"
      aria-modal="true"
      dir="rtl"
      onClick={onClose}
    >
      <div
        className="bg-[var(--fiori-bg-canvas)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-lg)] shadow-[var(--fiori-shadow-dialog)] w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* SAP Object Page Sticky Header */}
        <div className="fiori-object-header shrink-0 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--fiori-text-secondary)]">
                <span>{objectTypeLabel}</span>
                <span>·</span>
                <span className="fiori-ltr-code font-mono font-semibold text-[var(--fiori-brand)]">
                  {objectId}
                </span>
                {statusText && (
                  <FioriObjectStatus
                    tone={statusTone}
                    label={statusText}
                    variant="badge"
                    size="sm"
                    icon
                  />
                )}
              </div>
              <h3 className="text-base font-semibold text-[var(--fiori-text-primary)] mt-1 truncate">
                {title}
              </h3>
              {subtitle && (
                <p className="text-xs text-[var(--fiori-text-secondary)] mt-0.5">{subtitle}</p>
              )}
            </div>

            {/* Header Actions (Never includes Delete on transactional records) */}
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {headerActions}
              {enablePrint && (
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="sap-btn-standard px-2.5 py-1.5 text-xs flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>چاپ</span>
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="p-1.5 rounded bg-[#f5f5f5] hover:bg-[#e8e8e8] border border-[#cccccc] text-[#333333] cursor-pointer"
                title="بستن صفحه شیء"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Object Header KPIs */}
          {kpis.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-[#e8e8e8]">
              {kpis.map((kpi, idx) => (
                <div key={idx}>
                  <div className="text-[11px] text-[#666666]">{kpi.label}</div>
                  <div className={`text-sm font-semibold font-mono tabular-nums mt-0.5 ${kpiColor(kpi.tone)}`}>
                    {kpi.value}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* SAP Icon Tab Bar Navigation */}
        <div className="sap-icon-tab-bar px-3 shrink-0">
          {effectiveTabs.map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTabId(tab.id)}
              className={`sap-icon-tab whitespace-nowrap shrink-0 ${
                currentTab?.id === tab.id ? 'sap-icon-tab-active' : ''
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Scrollable Section Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="sap-card p-4">{currentTab?.content}</div>
        </div>
      </div>
    </div>
  );
};
