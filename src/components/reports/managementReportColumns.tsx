import React from 'react';
import { Eye } from 'lucide-react';
import {
  PlanVsActualItem,
  CustomerOrderFulfillmentItem,
  ProductionBacklogItem,
  WipByPartAndOperationItem,
  WipAgingItem,
  MaterialConsumptionActualItem,
  SapcoMaterialAccountItem,
  InventoryValuationQuantitiesItem,
  ScrapByPartAndOperationItem,
  MachineWorkloadCapacityItem,
  ProductionDelaysItem,
  InventoryMovementItem,
  InventoryReconciliationItem,
  CoilInventoryReportItem,
  LotConsumptionReportItem,
  SupplierMatrixReportItem,
} from '../../types/managementReports';
import { FioriTableColumn, FioriObjectStatus } from '../fiori/ui';
import { DrillDownData } from './DrillDownModal';
import { formatNumber, toPersianDigits } from '../../utils/formatters';
import { formatToJalali } from '../../utils/jalali';

export type TraceTarget = 'COILS' | 'CONTRACTS' | 'INVENTORY_LEDGER' | 'WIP_TRACEABILITY';
export type TraceFn = (docQuery: string, target?: TraceTarget) => void;

const DELAY_CAUSE_LABELS: Record<ProductionDelaysItem['primaryDelayCause'], string> = {
  RAW_MATERIAL_SHORTAGE: 'کسری کلاف ساپکو',
  MACHINE_BREAKDOWN: 'خرابی پرس و قالب',
  WIP_BOTTLENECK: 'گلوگاه کار در جریان',
  CAPACITY_OVERLOAD: 'بیش‌بار ظرفیت تناژ',
  QUALITY_HOLD: 'توقف کیفی ابعادی',
  UNASSESSED: 'علت بررسی‌نشده',
};

export function buildPlanVsActualDrillDown(r: PlanVsActualItem): DrillDownData {
  return {
    title: `سند برنامه تولید: ${r.planNumber} (${r.planVersion})`,
    subtitle: `${r.partName} - موعد تحویل: ${formatToJalali(r.targetDueDate)}`,
    badge: { text: r.status, color: 'bg-amber-100 text-amber-800' },
    fields: [
      { label: 'کد قطعه', value: r.partCode, isMono: true },
      { label: 'تیراژ مصوب برنامه', value: r.plannedQuantity, isHighlight: true },
      { label: 'تولید واقعی تایید شده', value: r.actualProducedQuantity, isHighlight: true },
      { label: 'تعداد ضایعات ثبت شده', value: r.actualScrapQuantity },
      { label: 'درصد تحقق برنامه', value: `${r.achievementRatePercent}%` },
      { label: 'انحراف از برنامه', value: r.varianceQuantity },
    ],
    detailsList: [
      {
        title: 'دستور کارهای مرتبط (Manufacturing Orders):',
        lines: r.linkedMoNumbers.map(m => ({ label: 'شماره MO', value: m })),
      },
    ],
  };
}

export function buildDelayDrillDown(r: ProductionDelaysItem): DrillDownData {
  return {
    title: `علت‌یابی تأخیر: ${r.referenceNumber}`,
    subtitle: r.partName,
    badge: {
      text: r.urgencyLevel === 'CRITICAL' ? 'بحرانی' : 'عادی',
      color:
        r.urgencyLevel === 'CRITICAL'
          ? 'bg-rose-100 text-rose-800'
          : 'bg-slate-100 text-slate-700',
    },
    fields: [
      { label: 'شماره سند', value: r.referenceNumber, isMono: true },
      { label: 'بخش', value: r.sectionLabelFa },
      { label: 'کد و نام قطعه', value: `${r.partCode} — ${r.partName}` },
      { label: 'تیراژ معوق', value: `${formatNumber(r.quantity)} عدد`, isMono: true, isHighlight: true },
      { label: 'موعد مصوب', value: formatToJalali(r.plannedDueDate) },
      { label: 'روزهای تأخیر', value: `${toPersianDigits(r.delayDays)} روز`, isHighlight: true },
      { label: 'علت ریشه‌ای', value: r.delayDescription },
      {
        label: 'ریسک تخمینی جریمه',
        value:
          r.delayPenaltyRiskRials === undefined
            ? 'ثبت نشده'
            : `${formatNumber(r.delayPenaltyRiskRials)} ریال`,
      },
      { label: 'سطح فوریت', value: r.urgencyLevel },
    ],
  };
}

export function getPlanVsActualColumns(traceDocument: TraceFn): FioriTableColumn<PlanVsActualItem>[] {
  return [
    {
      key: 'planNumber',
      header: 'شماره برنامه و نسخه',
      sortable: true,
      sortValue: r => r.planNumber,
      render: r => (
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              traceDocument(r.planNumber, 'WIP_TRACEABILITY');
            }}
            className="sap-doc-link fiori-ltr-code font-bold"
          >
            {r.planNumber}
          </button>
          <FioriObjectStatus tone="critical" label={r.planVersion} size="sm" />
        </div>
      ),
    },
    {
      key: 'part',
      header: 'کد و نام قطعه',
      sortable: true,
      sortValue: r => r.partName,
      render: r => (
        <div>
          <div className="font-semibold text-[var(--fiori-text-primary)]">{r.partName}</div>
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              traceDocument(r.partCode, 'INVENTORY_LEDGER');
            }}
            className="sap-doc-link fiori-ltr-code text-[11px]"
          >
            {r.partCode}
          </button>
        </div>
      ),
    },
    {
      key: 'plannedQuantity',
      header: 'تیراژ مصوب',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.plannedQuantity,
      cellClassName: 'font-semibold text-[var(--fiori-text-primary)]',
      render: r => formatNumber(r.plannedQuantity),
    },
    {
      key: 'actualProducedQuantity',
      header: 'تولید واقعی سالم',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.actualProducedQuantity,
      cellClassName: 'font-semibold text-[var(--fiori-positive)]',
      render: r => formatNumber(r.actualProducedQuantity),
    },
    {
      key: 'actualScrapQuantity',
      header: 'ضایعات',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.actualScrapQuantity,
      cellClassName: 'font-semibold text-[var(--fiori-negative)]',
      render: r => formatNumber(r.actualScrapQuantity),
    },
    {
      key: 'achievementRatePercent',
      header: 'درصد تحقق',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.achievementRatePercent,
      cellClassName: 'font-semibold text-[var(--fiori-text-primary)]',
      render: r => `${toPersianDigits(r.achievementRatePercent)}%`,
    },
    {
      key: 'varianceQuantity',
      header: 'انحراف',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.varianceQuantity,
      cellClassName: r =>
        `font-semibold ${
          r.varianceQuantity < 0
            ? 'text-[var(--fiori-negative)]'
            : 'text-[var(--fiori-positive)]'
        }`,
      render: r => formatNumber(r.varianceQuantity),
    },
    {
      key: 'isEstimate',
      header: 'نوع داده',
      align: 'center',
      render: r => (
        <FioriObjectStatus
          tone={r.isEstimate ? 'critical' : 'positive'}
          label={r.isEstimate ? 'برآوردی' : 'قطعی واقعی'}
          icon
        />
      ),
    },
    {
      key: 'targetDueDate',
      header: 'موعد تحویل',
      align: 'center',
      sortable: true,
      sortValue: r => r.targetDueDate,
      cellClassName: 'text-[11px] text-[var(--fiori-text-secondary)]',
      render: r => formatToJalali(r.targetDueDate),
    },
    {
      key: 'details',
      header: 'جزئیات',
      align: 'center',
      render: () => <Eye className="w-4 h-4 text-[var(--fiori-brand)] mx-auto" />,
    },
  ];
}

export function getFulfillmentColumns(traceDocument: TraceFn): FioriTableColumn<CustomerOrderFulfillmentItem>[] {
  return [
    {
      key: 'orderNumber',
      header: 'شماره سفارش و قرارداد',
      sortable: true,
      sortValue: r => r.orderNumber,
      render: r => (
        <div>
          <button
            type="button"
            onClick={() => traceDocument(r.orderNumber, 'WIP_TRACEABILITY')}
            className="sap-doc-link fiori-ltr-code font-bold"
          >
            {r.orderNumber}
          </button>
          <div>
            <button
              type="button"
              onClick={() => traceDocument(r.contractNumber, 'CONTRACTS')}
              className="sap-doc-link fiori-ltr-code text-[11px]"
            >
              {r.contractNumber}
            </button>
          </div>
        </div>
      ),
    },
    {
      key: 'customerName',
      header: 'مشتری',
      sortable: true,
      sortValue: r => r.customerName,
      cellClassName: 'font-semibold text-[var(--fiori-text-primary)]',
      render: r => r.customerName,
    },
    {
      key: 'part',
      header: 'قطعه',
      sortable: true,
      sortValue: r => r.partName,
      render: r => (
        <div>
          <div className="font-semibold text-[var(--fiori-text-primary)]">{r.partName}</div>
          <button
            type="button"
            onClick={() => traceDocument(r.partCode, 'INVENTORY_LEDGER')}
            className="sap-doc-link fiori-ltr-code text-[11px]"
          >
            {r.partCode}
          </button>
        </div>
      ),
    },
    {
      key: 'orderedQuantity',
      header: 'تعهد سفارش',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.orderedQuantity,
      cellClassName: 'font-semibold',
      render: r => formatNumber(r.orderedQuantity),
    },
    {
      key: 'deliveredQuantity',
      header: 'تحویل شده',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.deliveredQuantity,
      cellClassName: 'font-semibold text-[var(--fiori-positive)]',
      render: r => formatNumber(r.deliveredQuantity),
    },
    {
      key: 'remainingQuantity',
      header: 'باقیمانده',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.remainingQuantity,
      cellClassName: 'font-semibold text-[var(--fiori-critical)]',
      render: r => formatNumber(r.remainingQuantity),
    },
    {
      key: 'fulfillmentPercent',
      header: 'درصد تحقق',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.fulfillmentPercent,
      cellClassName: 'font-semibold',
      render: r => `${toPersianDigits(r.fulfillmentPercent)}%`,
    },
    {
      key: 'dueDate',
      header: 'موعد تحویل',
      align: 'center',
      sortable: true,
      sortValue: r => r.dueDate,
      cellClassName: 'text-[11px] text-[var(--fiori-text-secondary)]',
      render: r => formatToJalali(r.dueDate),
    },
    {
      key: 'status',
      header: 'وضعیت',
      align: 'center',
      render: r =>
        r.isDelayed ? (
          <FioriObjectStatus
            tone="negative"
            label={`${toPersianDigits(r.daysOverdue)} روز تأخیر`}
          />
        ) : (
          <FioriObjectStatus tone="positive" label="مطابق برنامه" />
        ),
    },
  ];
}

export function getBacklogColumns(traceDocument: TraceFn): FioriTableColumn<ProductionBacklogItem>[] {
  return [
    {
      key: 'orderNumber',
      header: 'شماره سفارش',
      sortable: true,
      sortValue: r => r.orderNumber,
      render: r => (
        <button
          type="button"
          onClick={() => traceDocument(r.orderNumber, 'WIP_TRACEABILITY')}
          className="sap-doc-link fiori-ltr-code font-bold"
        >
          {r.orderNumber}
        </button>
      ),
    },
    {
      key: 'customerName',
      header: 'مشتری و خودرو',
      render: r => (
        <div>
          <div className="font-semibold text-[var(--fiori-text-primary)]">{r.customerName}</div>
          <div className="text-[11px] text-[var(--fiori-text-secondary)]">{r.carModel || '-'}</div>
        </div>
      ),
    },
    {
      key: 'part',
      header: 'قطعه',
      render: r => (
        <div>
          <div className="font-semibold text-[var(--fiori-text-primary)]">{r.partName}</div>
          <button
            type="button"
            onClick={() => traceDocument(r.partCode, 'INVENTORY_LEDGER')}
            className="sap-doc-link fiori-ltr-code text-[11px]"
          >
            {r.partCode}
          </button>
        </div>
      ),
    },
    {
      key: 'backlogQuantity',
      header: 'تعداد معوق (Backlog)',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.backlogQuantity,
      cellClassName: 'font-semibold text-[var(--fiori-critical)] text-sm',
      render: r => formatNumber(r.backlogQuantity),
    },
    {
      key: 'requiredRawMaterialKg',
      header: 'ورق مورد نیاز (kg)',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.requiredRawMaterialKg,
      render: r => `${formatNumber(r.requiredRawMaterialKg)} kg`,
    },
    {
      key: 'daysOverdue',
      header: 'روزهای گذشته از موعد',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.daysOverdue,
      cellClassName: 'font-semibold text-[var(--fiori-negative)]',
      render: r => `${toPersianDigits(r.daysOverdue)} روز`,
    },
    {
      key: 'urgencyLevel',
      header: 'سطح فوریت',
      align: 'center',
      render: r => (
        <FioriObjectStatus
          tone={
            r.urgencyLevel === 'CRITICAL'
              ? 'negative'
              : r.urgencyLevel === 'HIGH'
              ? 'critical'
              : 'neutral'
          }
          label={
            r.urgencyLevel === 'CRITICAL'
              ? 'بحرانی'
              : r.urgencyLevel === 'HIGH'
              ? 'اولویت بالا'
              : 'متوسط'
          }
        />
      ),
    },
  ];
}

export function getWipOperationColumns(traceDocument: TraceFn): FioriTableColumn<WipByPartAndOperationItem>[] {
  return [
    {
      key: 'moNumber',
      header: 'شماره MO',
      sortable: true,
      sortValue: r => r.moNumber,
      render: r => (
        <button
          type="button"
          onClick={() => traceDocument(r.moNumber, 'WIP_TRACEABILITY')}
          className="sap-doc-link fiori-ltr-code font-bold"
        >
          {r.moNumber}
        </button>
      ),
    },
    {
      key: 'part',
      header: 'قطعه',
      render: r => (
        <div>
          <div className="font-semibold text-[var(--fiori-text-primary)]">{r.partName}</div>
          <button
            type="button"
            onClick={() => traceDocument(r.partCode, 'INVENTORY_LEDGER')}
            className="sap-doc-link fiori-ltr-code text-[11px]"
          >
            {r.partCode}
          </button>
        </div>
      ),
    },
    {
      key: 'step',
      header: 'مرحله و فرایند',
      render: r => (
        <div>
          <div>
            <span className="font-bold text-[var(--fiori-brand)] fiori-ltr-code font-mono">
              OP{r.stepNumber}
            </span>{' '}
            - {r.stepName}
          </div>
          <span className="block text-[10px] text-[var(--fiori-text-secondary)] font-mono">
            {r.processType}
          </span>
        </div>
      ),
    },
    {
      key: 'warehouseLocation',
      header: 'موقعیت انبارش',
      cellClassName: 'text-[var(--fiori-text-secondary)]',
      render: r => r.warehouseLocation,
    },
    {
      key: 'waitingInputQty',
      header: 'در صف ورودی',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.waitingInputQty,
      render: r => formatNumber(r.waitingInputQty),
    },
    {
      key: 'inProgressQty',
      header: 'پای دستگاه',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.inProgressQty,
      cellClassName: 'font-semibold text-[var(--fiori-critical)]',
      render: r => formatNumber(r.inProgressQty),
    },
    {
      key: 'readyForTransferQty',
      header: 'آماده انتقال',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.readyForTransferQty,
      cellClassName: 'font-semibold text-[var(--fiori-brand)]',
      render: r => formatNumber(r.readyForTransferQty),
    },
    {
      key: 'totalActiveWipQty',
      header: 'کل WIP فعال',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.totalActiveWipQty,
      cellClassName:
        'font-bold text-[var(--fiori-brand)] text-sm bg-[var(--fiori-brand-bg)]/60',
      render: r => formatNumber(r.totalActiveWipQty),
    },
  ];
}

export function getWipAgingColumns(traceDocument: TraceFn): FioriTableColumn<WipAgingItem>[] {
  return [
    {
      key: 'moNumber',
      header: 'شماره MO',
      sortable: true,
      sortValue: r => r.moNumber,
      render: r => (
        <button
          type="button"
          onClick={() => traceDocument(r.moNumber, 'WIP_TRACEABILITY')}
          className="sap-doc-link fiori-ltr-code font-bold"
        >
          {r.moNumber}
        </button>
      ),
    },
    {
      key: 'part',
      header: 'قطعه',
      render: r => (
        <div>
          <div className="font-semibold text-[var(--fiori-text-primary)]">{r.partName}</div>
          <button
            type="button"
            onClick={() => traceDocument(r.partCode, 'INVENTORY_LEDGER')}
            className="sap-doc-link fiori-ltr-code text-[11px]"
          >
            {r.partCode}
          </button>
        </div>
      ),
    },
    {
      key: 'stepName',
      header: 'مرحله کارگاهی',
      cellClassName: 'font-medium',
      render: r => r.stepName,
    },
    {
      key: 'warehouseLocation',
      header: 'موقعیت انبارش',
      cellClassName: 'text-[var(--fiori-text-secondary)]',
      render: r => r.warehouseLocation,
    },
    {
      key: 'quantityInStation',
      header: 'موجودی در ایستگاه',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.quantityInStation,
      cellClassName: 'font-semibold',
      render: r => formatNumber(r.quantityInStation),
    },
    {
      key: 'idleDays',
      header: 'مدت توقف (روز)',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.idleDays,
      cellClassName: 'font-semibold text-[var(--fiori-critical)] text-sm',
      render: r => `${toPersianDigits(r.idleDays)} روز`,
    },
    {
      key: 'ageCategory',
      header: 'رده سنی',
      align: 'center',
      cellClassName: 'text-[11px] text-[var(--fiori-text-secondary)]',
      render: r =>
        r.ageCategory === 'OVER_7_DAYS_STAGNANT'
          ? 'بیش از ۷ روز (راکد)'
          : r.ageCategory === '3_TO_7_DAYS'
          ? '۳ تا ۷ روز'
          : 'کمتر از ۳ روز',
    },
    {
      key: 'statusSeverity',
      header: 'وضعیت انباشت',
      align: 'center',
      render: r => (
        <FioriObjectStatus
          tone={
            r.statusSeverity === 'CRITICAL'
              ? 'negative'
              : r.statusSeverity === 'ATTENTION'
              ? 'critical'
              : 'positive'
          }
          label={
            r.statusSeverity === 'CRITICAL'
              ? 'ایستگاه بحرانی'
              : r.statusSeverity === 'ATTENTION'
              ? 'نیازمند تسریع'
              : 'عادی'
          }
        />
      ),
    },
  ];
}

export function getConsumptionColumns(traceDocument: TraceFn): FioriTableColumn<MaterialConsumptionActualItem>[] {
  return [
    {
      key: 'moNumber',
      header: 'دستور ساخت',
      sortable: true,
      sortValue: r => r.moNumber,
      render: r => (
        <button
          type="button"
          onClick={() => traceDocument(r.moNumber, 'WIP_TRACEABILITY')}
          className="sap-doc-link fiori-ltr-code font-bold"
        >
          {r.moNumber}
        </button>
      ),
    },
    {
      key: 'product',
      header: 'محصول',
      render: r => (
        <div>
          <div className="font-semibold text-[var(--fiori-text-primary)]">{r.productPartName}</div>
          <button
            type="button"
            onClick={() => traceDocument(r.productPartCode, 'INVENTORY_LEDGER')}
            className="sap-doc-link fiori-ltr-code text-[10px]"
          >
            {r.productPartCode}
          </button>
        </div>
      ),
    },
    {
      key: 'operationName',
      header: 'مرحله',
      render: r => (
        <div>
          <div>{r.operationName}</div>
          <div className="text-[10px] text-[var(--fiori-text-secondary)]">
            مرحله {formatNumber(r.operationStep)} · <span className="fiori-ltr-code font-mono">{r.operationCode}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'material',
      header: 'ماده مصرفی',
      render: r => (
        <div>
          <div className="font-semibold text-[var(--fiori-text-primary)]">{r.materialName}</div>
          <div className="text-[10px] text-[var(--fiori-text-secondary)]">
            <button
              type="button"
              onClick={() => traceDocument(r.materialCode, 'INVENTORY_LEDGER')}
              className="sap-doc-link fiori-ltr-code"
            >
              {r.materialCode}
            </button>{' '}
            · {r.materialGrade}
          </div>
        </div>
      ),
    },
    {
      key: 'actualIssuedMaterialKg',
      header: 'مصرف واقعی (kg)',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.actualIssuedMaterialKg,
      cellClassName: 'font-semibold text-[var(--fiori-critical)]',
      render: r => formatNumber(r.actualIssuedMaterialKg),
    },
    {
      key: 'actualProducedGoodQty',
      header: 'تولید سالم',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.actualProducedGoodQty,
      render: r => formatNumber(r.actualProducedGoodQty),
    },
    {
      key: 'actualScrapQty',
      header: 'ضایعات (عدد / kg)',
      align: 'center',
      isMono: true,
      cellClassName: 'text-[var(--fiori-negative)]',
      render: r => `${formatNumber(r.actualScrapQty)} / ${formatNumber(r.actualScrapWeightKg)} kg`,
    },
    {
      key: 'actualMachineNames',
      header: 'ماشین واقعی',
      render: r => (r.actualMachineNames.length ? r.actualMachineNames.join('، ') : 'ثبت نشده'),
    },
    {
      key: 'actualOperatorNames',
      header: 'اپراتور',
      render: r => (r.actualOperatorNames.length ? r.actualOperatorNames.join('، ') : 'ثبت نشده'),
    },
    {
      key: 'coilsContracts',
      header: 'کلاف / قرارداد',
      render: r => (
        <div className="space-y-0.5">
          <div className="flex flex-wrap gap-1">
            {r.coilNumbers.length > 0
              ? r.coilNumbers.map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => traceDocument(c, 'COILS')}
                    className="sap-doc-link fiori-ltr-code text-[11px]"
                  >
                    {c}
                  </button>
                ))
              : '—'}
          </div>
          <div className="text-[10px] text-[var(--fiori-text-secondary)] flex flex-wrap gap-1">
            {r.contractNumbers.length > 0
              ? r.contractNumbers.map(cnt => (
                  <button
                    key={cnt}
                    type="button"
                    onClick={() => traceDocument(cnt, 'CONTRACTS')}
                    className="sap-doc-link fiori-ltr-code"
                  >
                    {cnt}
                  </button>
                ))
              : 'بدون قرارداد'}
          </div>
        </div>
      ),
    },
  ];
}

export function getSapcoAccountColumns(traceDocument: TraceFn): FioriTableColumn<SapcoMaterialAccountItem>[] {
  return [
    {
      key: 'contractNumber',
      header: 'شماره و عنوان قرارداد ساپکو',
      sortable: true,
      sortValue: r => r.contractNumber,
      render: r => (
        <div>
          <button
            type="button"
            onClick={() => traceDocument(r.contractNumber, 'CONTRACTS')}
            className="sap-doc-link fiori-ltr-code font-bold"
          >
            {r.contractNumber}
          </button>
          <div className="text-[11px] text-[var(--fiori-text-secondary)]">{r.title}</div>
        </div>
      ),
    },
    {
      key: 'materialGrade',
      header: 'گرید ورق',
      isMono: true,
      cellClassName: 'font-semibold text-[var(--fiori-brand)]',
      render: r => <span className="fiori-ltr-code">{r.materialGrade}</span>,
    },
    {
      key: 'allocatedQuotaKg',
      header: 'سهمیه مصوب',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.allocatedQuotaKg,
      render: r => formatNumber(r.allocatedQuotaKg),
    },
    {
      key: 'openingBalanceKg',
      header: 'اول دوره (kg)',
      align: 'center',
      isMono: true,
      render: r => formatNumber(r.openingBalanceKg),
    },
    {
      key: 'totalReceivedKg',
      header: 'رسید (kg)',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.totalReceivedKg,
      cellClassName: 'font-semibold text-[var(--fiori-positive)]',
      render: r => formatNumber(r.totalReceivedKg),
    },
    {
      key: 'totalIssuedKg',
      header: 'مصرف خطوط (kg)',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.totalIssuedKg,
      cellClassName: 'font-semibold text-[var(--fiori-critical)]',
      render: r => formatNumber(r.totalIssuedKg),
    },
    {
      key: 'closingBookBalanceKg',
      header: 'مانده دفتری (kg)',
      align: 'center',
      isMono: true,
      cellClassName: 'font-semibold bg-[var(--fiori-bg-subtle)]',
      render: r => formatNumber(r.closingBookBalanceKg),
    },
    {
      key: 'physicalStockInPlantKg',
      header: 'موجودی فیزیکی کارخانه',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.physicalStockInPlantKg,
      cellClassName: 'font-semibold text-[var(--fiori-brand)]',
      render: r => formatNumber(r.physicalStockInPlantKg),
    },
    {
      key: 'discrepancyKg',
      header: 'مغایرت انبار',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.discrepancyKg,
      cellClassName: r =>
        `font-semibold ${
          r.discrepancyKg === 0 ? 'text-[var(--fiori-positive)]' : 'text-[var(--fiori-negative)]'
        }`,
      render: r => `${formatNumber(r.discrepancyKg)} kg`,
    },
  ];
}

export function getValuationQtyColumns(
  traceDocument: TraceFn
): FioriTableColumn<InventoryValuationQuantitiesItem>[] {
  return [
    {
      key: 'category',
      header: 'طبقه‌بندی',
      render: r => (
        <FioriObjectStatus
          tone="neutral"
          label={
            r.category === 'FINISHED_GOODS'
              ? 'محصول نهایی'
              : r.category === 'WIP_PARTS'
              ? 'کار در جریان'
              : r.category === 'QUALITY_BLOCKED'
              ? 'مسدود کیفی'
              : 'ورق خام'
          }
        />
      ),
    },
    {
      key: 'partOrMaterialCode',
      header: 'کد و شرح قلم',
      sortable: true,
      sortValue: r => r.description,
      render: r => (
        <div>
          <div className="font-semibold text-[var(--fiori-text-primary)]">{r.description}</div>
          <button
            type="button"
            onClick={() => traceDocument(r.partOrMaterialCode, 'INVENTORY_LEDGER')}
            className="sap-doc-link fiori-ltr-code text-[11px]"
          >
            {r.partOrMaterialCode}
          </button>
        </div>
      ),
    },
    {
      key: 'physicalQuantity',
      header: 'موجودی فیزیکی کل',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.physicalQuantity,
      cellClassName: 'font-semibold',
      render: r => `${formatNumber(r.physicalQuantity)} ${r.unit}`,
    },
    {
      key: 'companyOwnedQuantity',
      header: 'ملکی شرکت',
      align: 'center',
      isMono: true,
      cellClassName: 'font-semibold text-[var(--fiori-positive)]',
      render: r => formatNumber(r.companyOwnedQuantity),
    },
    {
      key: 'sapcoConsignmentQuantity',
      header: 'امانی ساپکو',
      align: 'center',
      isMono: true,
      cellClassName: 'font-semibold text-[var(--fiori-brand)]',
      render: r => formatNumber(r.sapcoConsignmentQuantity),
    },
    {
      key: 'qualityBlockedQuantity',
      header: 'مسدود کیفی',
      align: 'center',
      isMono: true,
      cellClassName: 'text-[var(--fiori-negative)]',
      render: r => formatNumber(r.qualityBlockedQuantity),
    },
    {
      key: 'reservedQuantity',
      header: 'رزرو سفارش',
      align: 'center',
      isMono: true,
      cellClassName: 'text-[var(--fiori-critical)]',
      render: r => formatNumber(r.reservedQuantity),
    },
    {
      key: 'availableFreeQuantity',
      header: 'موجودی آزاد قابل تخصیص',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.availableFreeQuantity,
      cellClassName:
        'font-bold text-[var(--fiori-brand)] text-sm bg-[var(--fiori-brand-bg)]/60',
      render: r => formatNumber(r.availableFreeQuantity),
    },
    {
      key: 'totalPhysicalWeightKg',
      header: 'وزن فیزیکی کل (kg)',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.totalPhysicalWeightKg,
      cellClassName: 'text-[var(--fiori-text-secondary)]',
      render: r => `${formatNumber(r.totalPhysicalWeightKg)} kg`,
    },
  ];
}

export function getScrapAnalysisColumns(traceDocument: TraceFn): FioriTableColumn<ScrapByPartAndOperationItem>[] {
  return [
    {
      key: 'partCode',
      header: 'قطعه',
      sortable: true,
      sortValue: r => r.partName,
      render: r => (
        <div>
          <div className="font-semibold text-[var(--fiori-text-primary)]">{r.partName}</div>
          <button
            type="button"
            onClick={() => traceDocument(r.partCode, 'INVENTORY_LEDGER')}
            className="sap-doc-link fiori-ltr-code text-[11px]"
          >
            {r.partCode}
          </button>
        </div>
      ),
    },
    {
      key: 'step',
      header: 'مرحله و فرایند',
      render: r => (
        <div>
          <div>
            <span className="font-bold text-[var(--fiori-brand)] fiori-ltr-code font-mono">
              OP{r.stepNumber}
            </span>{' '}
            - {r.stepName}
          </div>
          <span className="block text-[10px] text-[var(--fiori-text-secondary)] font-mono">
            {r.processType}
          </span>
        </div>
      ),
    },
    {
      key: 'machineName',
      header: 'دستگاه پرس',
      cellClassName: 'text-[var(--fiori-text-secondary)]',
      render: r => r.machineName || r.machineCode || '-',
    },
    {
      key: 'totalInputQty',
      header: 'کل قطعات ورودی',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.totalInputQty,
      render: r => formatNumber(r.totalInputQty),
    },
    {
      key: 'scrapPieces',
      header: 'ضایعات (عدد)',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.scrapPieces,
      cellClassName: 'font-semibold text-[var(--fiori-negative)]',
      render: r => formatNumber(r.scrapPieces),
    },
    {
      key: 'scrapWeightKg',
      header: 'وزن ضایعات (kg)',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.scrapWeightKg,
      cellClassName: 'text-[var(--fiori-negative)]',
      render: r => `${formatNumber(r.scrapWeightKg)} kg`,
    },
    {
      key: 'scrapNormPercent',
      header: 'نرم مجاز',
      align: 'center',
      isMono: true,
      cellClassName: 'text-[var(--fiori-text-secondary)]',
      render: r => `${toPersianDigits(r.scrapNormPercent)}%`,
    },
    {
      key: 'actualScrapPercent',
      header: 'درصد واقعی ضایعات',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.actualScrapPercent,
      render: r => (
        <FioriObjectStatus
          tone={r.isAboveNorm ? 'negative' : 'positive'}
          label={`${toPersianDigits(r.actualScrapPercent)}%`}
        />
      ),
    },
    {
      key: 'commonScrapDefectType',
      header: 'نقص شایع و علت ریشه‌ای',
      cellClassName: 'text-[11px] text-[var(--fiori-text-secondary)]',
      render: r => r.commonScrapDefectType || '-',
    },
  ];
}

export function getMachineWorkloadColumns(): FioriTableColumn<MachineWorkloadCapacityItem>[] {
  return [
    {
      key: 'machineName',
      header: 'کد و نام ماشین',
      sortable: true,
      sortValue: r => r.machineName,
      render: r => (
        <div>
          <div className="font-semibold text-[var(--fiori-text-primary)]">{r.machineName}</div>
          <div className="text-[11px] text-[var(--fiori-text-secondary)] fiori-ltr-code font-mono">
            {r.machineCode}
          </div>
        </div>
      ),
    },
    {
      key: 'hall',
      header: 'سالن و فرایند',
      cellClassName: 'text-[var(--fiori-text-secondary)]',
      render: r => (
        <span>
          {r.hall} • <span className="font-mono fiori-ltr-code">{r.processType}</span>
        </span>
      ),
    },
    {
      key: 'tonnage',
      header: 'تناژ اسمی',
      align: 'center',
      isMono: true,
      render: r => (r.tonnage ? `${formatNumber(r.tonnage)} T` : '-'),
    },
    {
      key: 'nominalDailyCapacityHours',
      header: 'ظرفیت شیفت (ساعت)',
      align: 'center',
      isMono: true,
      render: r => `${toPersianDigits(r.nominalDailyCapacityHours)}h`,
    },
    {
      key: 'scheduledWorkloadHours',
      header: 'ساعت کار برنامه‌ریزی‌شده',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.scheduledWorkloadHours,
      cellClassName: 'font-semibold text-[var(--fiori-critical)]',
      render: r => `${toPersianDigits(r.scheduledWorkloadHours)}h`,
    },
    {
      key: 'availableCapacityHours',
      header: 'ظرفیت آزاد',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.availableCapacityHours,
      cellClassName: 'font-semibold text-[var(--fiori-positive)]',
      render: r => `${toPersianDigits(r.availableCapacityHours)}h`,
    },
    {
      key: 'utilizationRatePercent',
      header: 'درصد بهره‌وری',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.utilizationRatePercent,
      cellClassName: 'font-semibold text-sm',
      render: r => `${toPersianDigits(r.utilizationRatePercent)}%`,
    },
    {
      key: 'machineStatus',
      header: 'وضعیت دستگاه',
      align: 'center',
      render: r => (
        <FioriObjectStatus
          tone={r.machineStatus === 'MAINTENANCE' || r.machineStatus === 'BREAKDOWN' ? 'negative' : 'positive'}
          label={
            r.machineStatus === 'MAINTENANCE' || r.machineStatus === 'BREAKDOWN'
              ? 'تعمیرات اضطراری'
              : 'آماده‌به‌کار'
          }
        />
      ),
    },
  ];
}

export function getDelaysColumns(
  traceDocument: TraceFn,
  onInspect: (item: DrillDownData) => void
): FioriTableColumn<ProductionDelaysItem>[] {
  return [
    {
      key: 'referenceNumber',
      header: 'بخش و شماره مرجع',
      sortable: true,
      sortValue: r => r.referenceNumber,
      render: r => (
        <div className="space-y-1">
          <FioriObjectStatus
            tone={
              r.section === 'CUSTOMER_ORDER'
                ? 'brand'
                : r.section === 'OPEN_MO'
                ? 'critical'
                : r.section === 'COMPLETED_LATE_MO'
                ? 'neutral'
                : 'positive'
            }
            label={r.sectionLabelFa}
          />
          <div>
            <button
              type="button"
              onClick={() => traceDocument(r.referenceNumber, 'WIP_TRACEABILITY')}
              className="sap-doc-link fiori-ltr-code font-bold"
            >
              {r.referenceNumber}
            </button>
          </div>
        </div>
      ),
    },
    {
      key: 'customerOrPlan',
      header: 'طرف حساب / ایستگاه',
      render: r => (
        <div>
          <div className="font-semibold text-[var(--fiori-text-primary)]">{r.customerOrPlan}</div>
          {r.operationName && (
            <div className="text-[10px] text-[var(--fiori-text-secondary)]">{r.operationName}</div>
          )}
        </div>
      ),
    },
    {
      key: 'partCode',
      header: 'کد و نام قطعه خودرویی',
      render: r => (
        <div>
          <div className="font-semibold text-[var(--fiori-text-primary)]">{r.partName}</div>
          <button
            type="button"
            onClick={() => traceDocument(r.partCode, 'INVENTORY_LEDGER')}
            className="sap-doc-link fiori-ltr-code text-[11px]"
          >
            {r.partCode}
          </button>
        </div>
      ),
    },
    {
      key: 'quantity',
      header: 'تیراژ معوق',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.quantity,
      cellClassName: 'font-semibold text-sm',
      render: r => formatNumber(r.quantity),
    },
    {
      key: 'plannedDueDate',
      header: 'موعد مصوب',
      align: 'center',
      cellClassName: 'text-[11px] text-[var(--fiori-text-secondary)]',
      render: r => formatToJalali(r.plannedDueDate),
    },
    {
      key: 'estimatedCompletionDate',
      header: 'تکمیل (تخمینی / واقعی)',
      align: 'center',
      cellClassName: 'text-[11px] text-[var(--fiori-critical)] font-semibold',
      render: r => (r.estimatedCompletionDate ? formatToJalali(r.estimatedCompletionDate) : 'ثبت نشده'),
    },
    {
      key: 'delayDays',
      header: 'روزهای تأخیر',
      align: 'center',
      sortable: true,
      sortValue: r => r.delayDays,
      render: r => (
        <FioriObjectStatus tone="negative" label={`${toPersianDigits(r.delayDays)} روز`} />
      ),
    },
    {
      key: 'primaryDelayCause',
      header: 'علت ریشه‌ای تأخیر',
      render: r => (
        <div>
          <span className="font-semibold text-[var(--fiori-text-primary)] block text-[11px]">
            {DELAY_CAUSE_LABELS[r.primaryDelayCause]}
          </span>
          <span
            className="text-[10px] text-[var(--fiori-text-secondary)] block mt-0.5 line-clamp-1"
            title={r.delayDescription}
          >
            {r.delayDescription}
          </span>
        </div>
      ),
    },
    {
      key: 'urgencyLevel',
      header: 'سطح فوریت',
      align: 'center',
      render: r => (
        <FioriObjectStatus
          tone={
            r.urgencyLevel === 'CRITICAL'
              ? 'negative'
              : r.urgencyLevel === 'HIGH'
              ? 'critical'
              : 'neutral'
          }
          label={
            r.urgencyLevel === 'CRITICAL'
              ? 'بحرانی'
              : r.urgencyLevel === 'HIGH'
              ? 'بالا'
              : 'متوسط'
          }
        />
      ),
    },
    {
      key: 'inspect',
      header: 'بررسی',
      align: 'center',
      render: r => (
        <button
          type="button"
          onClick={() => onInspect(buildDelayDrillDown(r))}
          className="sap-btn-standard px-2.5 py-1 text-[10px] cursor-pointer"
        >
          جزئیات
        </button>
      ),
    },
  ];
}

export function getMovementsColumns(traceDocument: TraceFn): FioriTableColumn<InventoryMovementItem>[] {
  return [
    {
      key: 'documentNumber',
      header: 'شماره سند',
      sortable: true,
      sortValue: r => r.documentNumber,
      render: r => (
        <button
          type="button"
          onClick={() => traceDocument(r.documentNumber, 'INVENTORY_LEDGER')}
          className="sap-doc-link fiori-ltr-code font-bold"
        >
          {r.documentNumber}
        </button>
      ),
    },
    {
      key: 'transactionDate',
      header: 'تاریخ سند',
      sortable: true,
      sortValue: r => r.transactionDate,
      cellClassName: 'text-[11px] text-[var(--fiori-text-secondary)]',
      render: r => formatToJalali(r.transactionDate),
    },
    {
      key: 'documentType',
      header: 'نوع سند',
      render: r => <FioriObjectStatus tone="neutral" label={r.documentType} />,
    },
    {
      key: 'part',
      header: 'قطعه / متریال',
      render: r => (
        <div>
          <div className="font-semibold text-[var(--fiori-text-primary)]">{r.partName}</div>
          <button
            type="button"
            onClick={() => traceDocument(r.partCode, 'INVENTORY_LEDGER')}
            className="sap-doc-link fiori-ltr-code text-[11px]"
          >
            {r.partCode}
          </button>
        </div>
      ),
    },
    {
      key: 'quantity',
      header: 'مقدار',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.quantity,
      cellClassName: 'font-semibold',
      render: r => `${formatNumber(r.quantity)} ${r.unit}`,
    },
    {
      key: 'locations',
      header: 'مبدأ → مقصد',
      align: 'center',
      cellClassName: 'text-[11px] text-[var(--fiori-text-secondary)]',
      render: r => `${r.sourceLocation} → ${r.targetLocation}`,
    },
    {
      key: 'ownership',
      header: 'مالکیت',
      align: 'center',
      cellClassName: 'text-[11px]',
      render: r => r.ownership,
    },
    {
      key: 'operatorOrUser',
      header: 'کاربر ثبت‌کننده',
      align: 'center',
      cellClassName: 'text-[11px] text-[var(--fiori-text-secondary)]',
      render: r => r.operatorOrUser,
    },
  ];
}

export function getReconciliationColumns(traceDocument: TraceFn): FioriTableColumn<InventoryReconciliationItem>[] {
  return [
    {
      key: 'warehouseName',
      header: 'کد و انبار',
      render: r => (
        <div>
          <div className="font-semibold text-[var(--fiori-text-primary)]">{r.warehouseName}</div>
          <div className="text-[11px] text-[var(--fiori-text-secondary)] fiori-ltr-code font-mono">
            {r.locationCode}
          </div>
        </div>
      ),
    },
    {
      key: 'part',
      header: 'قلم کالایی',
      render: r => (
        <div>
          <div className="font-semibold text-[var(--fiori-text-primary)]">{r.partName}</div>
          <button
            type="button"
            onClick={() => traceDocument(r.partCode, 'INVENTORY_LEDGER')}
            className="sap-doc-link fiori-ltr-code text-[11px]"
          >
            {r.partCode}
          </button>
        </div>
      ),
    },
    {
      key: 'bookQuantity',
      header: 'موجودی دفتری سیستم',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.bookQuantity,
      cellClassName: 'font-semibold',
      render: r => formatNumber(r.bookQuantity),
    },
    {
      key: 'physicalCountQuantity',
      header: 'شمارش عینی انبارگردانی',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.physicalCountQuantity,
      cellClassName: 'font-semibold text-[var(--fiori-positive)]',
      render: r => formatNumber(r.physicalCountQuantity),
    },
    {
      key: 'varianceQuantity',
      header: 'مغایرت',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.varianceQuantity,
      cellClassName: r =>
        `font-semibold ${
          r.reconciliationStatus === 'BALANCED' && r.varianceQuantity === 0
            ? 'text-[var(--fiori-positive)]'
            : r.reconciliationStatus === 'DEFICIT' || r.varianceQuantity < 0
            ? 'text-[var(--fiori-negative)]'
            : 'text-[var(--fiori-critical)]'
        }`,
      render: r => formatNumber(r.varianceQuantity),
    },
    {
      key: 'reconciliationStatus',
      header: 'وضعیت موازنه',
      align: 'center',
      render: r => (
        <FioriObjectStatus
          tone={
            r.reconciliationStatus === 'BALANCED'
              ? 'positive'
              : r.reconciliationStatus === 'DEFICIT'
              ? 'negative'
              : 'critical'
          }
          label={
            r.reconciliationStatus === 'BALANCED'
              ? 'موازنه کامل (بدون مغایرت)'
              : r.reconciliationStatus === 'DEFICIT'
              ? 'کسری انبار'
              : 'اضافی انبار'
          }
        />
      ),
    },
    {
      key: 'lastReconciledAt',
      header: 'تاریخ ممیزی',
      align: 'center',
      cellClassName: 'text-[11px] text-[var(--fiori-text-secondary)]',
      render: r => formatToJalali(r.lastReconciledAt),
    },
  ];
}

export function getCoilInventoryColumns(traceDocument: TraceFn): FioriTableColumn<CoilInventoryReportItem>[] {
  return [
    {
      key: 'coilNumber',
      header: 'شماره کویل',
      sortable: true,
      sortValue: r => r.coilNumber,
      render: r => (
        <div>
          <div>
            <button
              type="button"
              onClick={() => traceDocument(r.coilNumber, 'COILS')}
              className="sap-doc-link fiori-ltr-code font-bold"
            >
              {r.coilNumber}
            </button>
          </div>
          <div className="text-[10px] text-[var(--fiori-text-secondary)]">
            ذوب:{' '}
            <button
              type="button"
              onClick={() => traceDocument(r.heatNumber, 'WIP_TRACEABILITY')}
              className="sap-doc-link fiori-ltr-code"
            >
              {r.heatNumber}
            </button>
          </div>
        </div>
      ),
    },
    {
      key: 'materialGrade',
      header: 'مشخصات متریال (گرید و ضخامت)',
      render: r => (
        <div>
          <div className="font-semibold text-[var(--fiori-text-primary)]">{r.materialGrade}</div>
          <div className="text-[10px] text-[var(--fiori-text-secondary)]">
            قرارداد:{' '}
            <button
              type="button"
              onClick={() => traceDocument(r.contractNumber, 'CONTRACTS')}
              className="sap-doc-link fiori-ltr-code"
            >
              {r.contractNumber}
            </button>
          </div>
        </div>
      ),
    },
    {
      key: 'dimensions',
      header: 'ابعاد (mm)',
      align: 'center',
      isMono: true,
      render: r => <span className="fiori-ltr-code">{r.thicknessMm} × {r.widthMm}</span>,
    },
    {
      key: 'receivedWeightKg',
      header: 'وزن دریافتی (kg)',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.receivedWeightKg,
      render: r => formatNumber(r.receivedWeightKg),
    },
    {
      key: 'consumedWeightKg',
      header: 'مصرف شده (kg)',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.consumedWeightKg,
      cellClassName: 'font-semibold text-[var(--fiori-critical)]',
      render: r => formatNumber(r.consumedWeightKg),
    },
    {
      key: 'remainingWeightKg',
      header: 'مانده موجودی (kg)',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.remainingWeightKg,
      cellClassName: 'font-bold text-[var(--fiori-positive)]',
      render: r => formatNumber(r.remainingWeightKg),
    },
    {
      key: 'ownership',
      header: 'مالکیت',
      align: 'center',
      render: r => (
        <FioriObjectStatus
          tone={r.ownership === 'SAPCO_CONSIGNMENT' ? 'brand' : 'neutral'}
          label={r.ownership === 'SAPCO_CONSIGNMENT' ? 'امانی ساپکو' : 'ملکی'}
        />
      ),
    },
    {
      key: 'status',
      header: 'وضعیت رول',
      align: 'center',
      render: r => (
        <FioriObjectStatus
          tone={
            r.status === 'FULL'
              ? 'positive'
              : r.status === 'PARTIAL'
              ? 'critical'
              : r.status === 'BLOCKED'
              ? 'negative'
              : 'neutral'
          }
          label={
            r.status === 'FULL'
              ? 'سالم (کامل)'
              : r.status === 'PARTIAL'
              ? 'بازشده (ناقص)'
              : r.status === 'BLOCKED'
              ? 'مسدود کیفی'
              : 'مصرف‌شده'
          }
        />
      ),
    },
    {
      key: 'warehouseLocation',
      header: 'موقعیت انبار',
      align: 'center',
      cellClassName: 'text-[11px] text-[var(--fiori-text-secondary)]',
      render: r => r.warehouseLocation,
    },
  ];
}

export function getLotConsumptionColumns(traceDocument: TraceFn): FioriTableColumn<LotConsumptionReportItem>[] {
  return [
    {
      key: 'issueDocumentNumber',
      header: 'سند و تاریخ حواله',
      sortable: true,
      sortValue: r => r.issueDocumentNumber,
      render: r => (
        <div>
          <button
            type="button"
            onClick={() => traceDocument(r.issueDocumentNumber, 'INVENTORY_LEDGER')}
            className="sap-doc-link fiori-ltr-code font-bold"
          >
            {r.issueDocumentNumber}
          </button>
          <div className="text-[10px] text-[var(--fiori-text-secondary)]">
            {formatToJalali(r.issueDate)}
          </div>
        </div>
      ),
    },
    {
      key: 'coilNumber',
      header: 'شناسه کویل / ذوب',
      render: r => (
        <div>
          <div>
            <button
              type="button"
              onClick={() => traceDocument(r.coilNumber, 'COILS')}
              className="sap-doc-link fiori-ltr-code font-bold"
            >
              {r.coilNumber}
            </button>
          </div>
          <div>
            <button
              type="button"
              onClick={() => traceDocument(r.heatNumber, 'WIP_TRACEABILITY')}
              className="sap-doc-link fiori-ltr-code text-[10px]"
            >
              {r.heatNumber}
            </button>
          </div>
        </div>
      ),
    },
    {
      key: 'materialGrade',
      header: 'جنس و ضخامت',
      render: r => (
        <span>
          <span className="font-semibold text-[var(--fiori-text-primary)]">{r.materialGrade}</span>{' '}
          <span className="text-[var(--fiori-text-secondary)] font-mono fiori-ltr-code">
            ({r.thicknessMm}mm)
          </span>
        </span>
      ),
    },
    {
      key: 'consumedKg',
      header: 'مصرف (kg)',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.consumedKg,
      cellClassName: 'font-semibold',
      render: r => formatNumber(r.consumedKg),
    },
    {
      key: 'targetMoNumber',
      header: 'دستور کار (MO)',
      align: 'center',
      render: r => (
        <button
          type="button"
          onClick={() => traceDocument(r.targetMoNumber, 'WIP_TRACEABILITY')}
          className="sap-doc-link fiori-ltr-code font-semibold"
        >
          {r.targetMoNumber}
        </button>
      ),
    },
    {
      key: 'targetPartCode',
      header: 'قطعه خروجی',
      render: r => (
        <div>
          <div className="font-semibold text-[var(--fiori-text-primary)]">{r.targetPartName}</div>
          <button
            type="button"
            onClick={() => traceDocument(r.targetPartCode, 'INVENTORY_LEDGER')}
            className="sap-doc-link fiori-ltr-code text-[10px]"
          >
            {r.targetPartCode}
          </button>
        </div>
      ),
    },
    {
      key: 'piecesProduced',
      header: 'تیراژ تولیدی',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.piecesProduced,
      cellClassName: 'font-semibold text-[var(--fiori-positive)]',
      render: r => `${formatNumber(r.piecesProduced)} عدد`,
    },
    {
      key: 'scrapKg',
      header: 'ضایعات پرسی',
      align: 'center',
      isMono: true,
      cellClassName: 'text-[var(--fiori-negative)]',
      render: r => (
        <div>
          <div>{formatNumber(r.scrapKg)} kg</div>
          <div className="text-[10px] text-[var(--fiori-text-secondary)]">({r.scrapPercent}%)</div>
        </div>
      ),
    },
    {
      key: 'operatorName',
      header: 'اپراتور',
      align: 'center',
      cellClassName: 'text-[11px] text-[var(--fiori-text-secondary)]',
      render: r => r.operatorName,
    },
  ];
}

export function getSupplierMatrixColumns(): FioriTableColumn<SupplierMatrixReportItem>[] {
  return [
    {
      key: 'grade',
      header: 'گرید فولاد',
      sortable: true,
      sortValue: r => r.grade,
      cellClassName: 'font-semibold text-[var(--fiori-text-primary)]',
      render: r => r.grade,
    },
    {
      key: 'thicknessMm',
      header: 'ضخامت ورق (mm)',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.thicknessMm,
      cellClassName: 'font-semibold',
      render: r => <span className="fiori-ltr-code">{r.thicknessMm} mm</span>,
    },
    {
      key: 'openingBalanceKg',
      header: 'اول دوره (kg)',
      align: 'center',
      isMono: true,
      cellClassName: 'text-[var(--fiori-text-secondary)]',
      render: r => formatNumber(r.openingBalanceKg),
    },
    {
      key: 'consignmentReceivedKg',
      header: 'رسید امانی ساپکو (kg)',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.consignmentReceivedKg,
      cellClassName: 'font-semibold text-[var(--fiori-brand)]',
      render: r => formatNumber(r.consignmentReceivedKg),
    },
    {
      key: 'financialReceivedKg',
      header: 'رسید خرید آزاد / ملکی (kg)',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.financialReceivedKg,
      cellClassName: 'font-semibold',
      render: r => formatNumber(r.financialReceivedKg),
    },
    {
      key: 'totalConsumptionKg',
      header: 'جمع مصرف مستقیم (kg)',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.totalConsumptionKg,
      cellClassName: 'font-semibold text-[var(--fiori-critical)]',
      render: r => formatNumber(r.totalConsumptionKg),
    },
    {
      key: 'otherMovementKg',
      header: 'سایر گردش‌ها (kg)',
      align: 'center',
      isMono: true,
      cellClassName: 'text-[var(--fiori-text-secondary)]',
      render: r => formatNumber(r.otherMovementKg),
    },
    {
      key: 'closingBalanceKg',
      header: 'مانده پایان دوره (kg)',
      align: 'center',
      isMono: true,
      sortable: true,
      sortValue: r => r.closingBalanceKg,
      cellClassName: 'font-bold text-[var(--fiori-positive)]',
      render: r => formatNumber(r.closingBalanceKg),
    },
    {
      key: 'totalCoilsCount',
      header: 'تعداد کویل',
      align: 'center',
      sortable: true,
      sortValue: r => r.totalCoilsCount,
      render: r => (
        <FioriObjectStatus tone="neutral" label={`${toPersianDigits(r.totalCoilsCount)} کلاف`} />
      ),
    },
  ];
}
