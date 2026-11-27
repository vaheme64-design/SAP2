import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Printer,
  Clock,
  Cpu,
  Building,
  User,
  RefreshCw,
} from 'lucide-react';
import { formatNumber, toPersianDigits } from '../../utils/formatters';
import { formatToJalali } from '../../utils/jalali';
import { JalaliDatePicker } from '../common/JalaliDatePicker';
import { useErpRouter } from '../../context/RouterContext';
import {
  FioriDataTable,
  FioriDynamicPage,
  FioriObjectStatus,
  FioriTableColumn,
  FioriToolbar,
} from '../fiori/ui';
import { EmptyState } from '../common/EmptyState';

interface DailyScheduleItem {
  id: string;
  hallId: string;
  hallName: string;
  shift: 'MORNING' | 'EVENING' | 'NIGHT';
  shiftName: string;
  machineCode: string;
  machineName: string;
  dieCode: string;
  dieName: string;
  partCode: string;
  partName: string;
  moNumber: string;
  stepCode: string;
  stepName: string;
  plannedQuantity: number;
  actualProducedQuantity: number;
  scrapQuantity: number;
  operatorName: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'SCHEDULED';
}

export const DailyProductionScheduleView: React.FC = () => {
  const { traceDocument } = useErpRouter();
  const [selectedHall, setSelectedHall] = useState<string>('ALL');
  const [selectedShift, setSelectedShift] = useState<string>('ALL');
  const [scheduleDate, setScheduleDate] = useState<string>(() => formatToJalali(new Date()));
  const [items, setItems] = useState<DailyScheduleItem[]>([]);
  const [halls, setHalls] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);

  const loadScheduleFromLiveOrders = useCallback(async () => {
    setLoading(true);
    try {
      const [mosRes, hallsRes, machinesRes, diesRes] = await Promise.all([
        fetch('/api/wip/manufacturing-orders').then(r => r.json()).catch(() => ({ success: false })),
        fetch('/api/halls').then(r => r.json()).catch(() => ({ success: false })),
        fetch('/api/machines').then(r => r.json()).catch(() => ({ success: false })),
        fetch('/api/dies').then(r => r.json()).catch(() => ({ success: false })),
      ]);

      const hallsList: any[] = hallsRes.success && Array.isArray(hallsRes.data) ? hallsRes.data : [];
      const machinesList: any[] = machinesRes.success && Array.isArray(machinesRes.data) ? machinesRes.data : [];
      const diesList: any[] = diesRes.success && Array.isArray(diesRes.data) ? diesRes.data : [];
      const mosList: any[] = mosRes.success && Array.isArray(mosRes.data) ? mosRes.data : [];

      setHalls(hallsList);

      const generated: DailyScheduleItem[] = [];
      mosList.forEach(mo => {
        (mo.operations || []).forEach((op: any, idx: number) => {
          const machine = machinesList.find(m => m.id === op.machineId || m.code === op.machineCode);
          const die = diesList.find(d => d.id === op.dieMoldId || d.partCode === mo.partCode);
          const matchedHall =
            hallsList.find(h => h.id === machine?.hallId || h.name === machine?.location) ||
            hallsList[0] || { id: 'HALL-MAIN', name: machine?.location || 'سالن تولید اصلی' };

          const shift: 'MORNING' | 'EVENING' = idx % 2 === 0 ? 'MORNING' : 'EVENING';
          const status: DailyScheduleItem['status'] =
            op.status === 'COMPLETED'
              ? 'COMPLETED'
              : op.status === 'IN_PROGRESS' || op.status === 'READY'
              ? 'IN_PROGRESS'
              : 'SCHEDULED';

          generated.push({
            id: `${mo.id}-${op.id}`,
            hallId: matchedHall.id,
            hallName: matchedHall.name,
            shift,
            shiftName: shift === 'MORNING' ? 'شیفت صبح (۰۷:۰۰ - ۱۵:۰۰)' : 'شیفت عصر (۱۵:۰۰ - ۲۳:۰۰)',
            machineCode: machine?.code || op.machineId || '—',
            machineName: op.machineName || machine?.name || 'ایستگاه کاری کارگاه',
            dieCode: die?.code || op.dieMoldId || '—',
            dieName: die?.name || 'فیکسچر / قالب استاندارد مرحله',
            partCode: mo.partCode,
            partName: mo.partName,
            moNumber: mo.moNumber,
            stepCode: op.stepCode,
            stepName: op.stepName,
            plannedQuantity: mo.targetQuantity || 0,
            actualProducedQuantity: op.goodOutputQty || 0,
            scrapQuantity: op.scrapQty || 0,
            operatorName: op.lastOperatorName || 'سرشیفت سالن',
            status,
          });
        });
      });

      setItems(generated);
    } catch (err) {
      console.error('Failed to load live daily schedule:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadScheduleFromLiveOrders();
  }, [loadScheduleFromLiveOrders]);

  const filteredItems = useMemo(
    () =>
      items.filter(item => {
        if (selectedHall !== 'ALL' && item.hallId !== selectedHall) return false;
        if (selectedShift !== 'ALL' && item.shift !== selectedShift) return false;
        return true;
      }),
    [items, selectedHall, selectedShift]
  );

  const totalPlanned = useMemo(
    () => filteredItems.reduce((acc, i) => acc + i.plannedQuantity, 0),
    [filteredItems]
  );
  const totalProduced = useMemo(
    () => filteredItems.reduce((acc, i) => acc + i.actualProducedQuantity, 0),
    [filteredItems]
  );
  const achievementRate = totalPlanned > 0 ? Math.round((totalProduced / totalPlanned) * 100) : 0;

  const activeFiltersCount = (selectedHall !== 'ALL' ? 1 : 0) + (selectedShift !== 'ALL' ? 1 : 0);

  const columns: FioriTableColumn<DailyScheduleItem>[] = useMemo(
    () => [
      {
        key: 'shift',
        header: 'تاریخ / شیفت',
        render: item => (
          <div>
            <div className="font-mono font-semibold text-[var(--fiori-text-primary)] tabular-nums">
              {scheduleDate}
            </div>
            <div className="text-[11px] text-[var(--fiori-text-secondary)]">{item.shiftName}</div>
          </div>
        ),
      },
      {
        key: 'machine',
        header: 'سالن و ماشین',
        render: item => (
          <div>
            <div className="font-semibold text-[var(--fiori-text-primary)] flex items-center gap-1">
              <Cpu className="w-3.5 h-3.5 text-[var(--fiori-brand)] shrink-0" />
              <span>{item.machineName}</span>
            </div>
            <div className="text-[11px] text-[var(--fiori-text-secondary)]">{item.hallName}</div>
          </div>
        ),
      },
      {
        key: 'mo',
        header: 'دستور کار / مرحله',
        render: item => (
          <div>
            <button
              type="button"
              onClick={() => traceDocument(item.moNumber, 'WIP_TRACEABILITY')}
              className="sap-doc-link font-mono font-semibold fiori-ltr-code cursor-pointer"
              title="رهگیری دستور کار در جریان ساخت"
            >
              {item.moNumber}
            </button>
            <div className="text-[11px] text-[var(--fiori-text-secondary)]">
              <span className="fiori-ltr-code">{item.stepCode}</span> — {item.stepName}
            </div>
          </div>
        ),
      },
      {
        key: 'part',
        header: 'قطعه',
        render: item => (
          <div>
            <div className="font-semibold text-[var(--fiori-text-primary)]">{item.partName}</div>
            <button
              type="button"
              onClick={() => traceDocument(item.partCode, 'INVENTORY_LEDGER')}
              className="sap-doc-link text-[11px] font-mono fiori-ltr-code cursor-pointer"
              title="رهگیری قطعه در انبار و کاردکس"
            >
              {item.partCode}
            </button>
          </div>
        ),
      },
      {
        key: 'plannedQuantity',
        header: 'هدف برنامه',
        align: 'center',
        isMono: true,
        sortable: true,
        sortValue: item => item.plannedQuantity,
        render: item => (
          <span className="font-semibold text-[var(--fiori-text-primary)] tabular-nums">
            {formatNumber(item.plannedQuantity)}
          </span>
        ),
      },
      {
        key: 'actualProducedQuantity',
        header: 'تولید سالم',
        align: 'center',
        isMono: true,
        sortable: true,
        sortValue: item => item.actualProducedQuantity,
        render: item => (
          <span className="font-semibold text-[var(--fiori-positive)] tabular-nums">
            {formatNumber(item.actualProducedQuantity)}
          </span>
        ),
      },
      {
        key: 'scrapQuantity',
        header: 'ضایعات',
        align: 'center',
        isMono: true,
        sortable: true,
        sortValue: item => item.scrapQuantity,
        render: item => (
          <span className="text-[var(--fiori-negative)] tabular-nums">
            {formatNumber(item.scrapQuantity)}
          </span>
        ),
      },
      {
        key: 'operatorName',
        header: 'اپراتور',
        render: item => (
          <span className="inline-flex items-center gap-1 text-[var(--fiori-text-primary)]">
            <User className="w-3 h-3 text-[var(--fiori-text-muted)] shrink-0" />
            <span>{item.operatorName}</span>
          </span>
        ),
      },
      {
        key: 'status',
        header: 'وضعیت',
        align: 'center',
        render: item => {
          if (item.status === 'COMPLETED') {
            return <FioriObjectStatus tone="positive" label="تکمیل" icon size="sm" />;
          }
          if (item.status === 'IN_PROGRESS') {
            return <FioriObjectStatus tone="critical" label="در حال تولید" size="sm" />;
          }
          return <FioriObjectStatus tone="neutral" label="برنامه‌ریزی‌شده" size="sm" />;
        },
      },
    ],
    [scheduleDate, traceDocument]
  );

  return (
    <FioriDynamicPage
      title="برنامه روزانه کارخانه به تفکیک سالن و دستور کار زنده (Live Daily Schedule)"
      subtitle="متصل به دستور کارهای فعال کارگاه (WIP Orders)، سالن‌های استقرار و آمار لحظه‌ای تولید سالم/ضایعات"
      status={
        <FioriObjectStatus
          tone="info"
          label={`تحقق برنامه: ${toPersianDigits(achievementRate)}٪`}
          size="sm"
        />
      }
      activeFiltersCount={activeFiltersCount}
      onResetFilters={() => {
        setSelectedHall('ALL');
        setSelectedShift('ALL');
      }}
      headerActions={
        <div className="flex items-center gap-2 no-print">
          <button
            type="button"
            onClick={loadScheduleFromLiveOrders}
            disabled={loading}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${
                loading ? 'animate-spin text-[var(--fiori-brand)]' : 'text-[var(--fiori-text-secondary)]'
              }`}
            />
            <span>بروزرسانی زنده</span>
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="sap-btn-emphasized flex items-center gap-1.5 px-3.5 py-1.5 text-xs cursor-pointer"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>چاپ برنامه روزانه</span>
          </button>
        </div>
      }
      filterBar={
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs no-print">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-2 bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] px-3 py-1">
              <Building className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
              <span className="text-[var(--fiori-text-secondary)] font-medium">سالن استقرار:</span>
              <select
                value={selectedHall}
                onChange={e => setSelectedHall(e.target.value)}
                className="bg-transparent font-semibold text-[var(--fiori-text-primary)] focus:outline-none cursor-pointer"
              >
                <option value="ALL">همه سالن‌ها ({toPersianDigits(items.length)} عملیات)</option>
                {halls.map(h => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="inline-flex items-center gap-2 bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] px-3 py-1">
              <Clock className="w-3.5 h-3.5 text-[var(--fiori-text-muted)]" />
              <span className="text-[var(--fiori-text-secondary)] font-medium">شیفت:</span>
              <select
                value={selectedShift}
                onChange={e => setSelectedShift(e.target.value)}
                className="bg-transparent font-semibold text-[var(--fiori-text-primary)] focus:outline-none cursor-pointer"
              >
                <option value="ALL">همه شیفت‌ها</option>
                <option value="MORNING">شیفت صبح (۰۷:۰۰ - ۱۵:۰۰)</option>
                <option value="EVENING">شیفت عصر (۱۵:۰۰ - ۲۳:۰۰)</option>
              </select>
            </div>

            <div className="inline-flex items-center gap-2">
              <JalaliDatePicker value={scheduleDate} onChange={setScheduleDate} />
            </div>
          </div>

          <div className="flex items-center gap-4 text-xs font-mono tabular-nums">
            <span className="text-[var(--fiori-text-secondary)]">
              برنامه: <strong className="text-[var(--fiori-text-primary)]">{formatNumber(totalPlanned)}</strong>
            </span>
            <span className="text-[var(--fiori-positive)]">
              تحقق‌یافته: <strong>{formatNumber(totalProduced)}</strong> ({toPersianDigits(achievementRate)}٪)
            </span>
          </div>
        </div>
      }
    >
      <FioriDataTable
        columns={columns}
        data={filteredItems}
        rowKey={item => item.id}
        loading={loading && items.length === 0}
        compact
        bordered
        toolbar={
          <FioriToolbar
            variant="table"
            title="جدول برنامه شیفتی و وضعیت پیشرفت عملیات"
            count={filteredItems.length}
            countLabel="عملیات"
          />
        }
        emptyState={
          <EmptyState
            variant={activeFiltersCount > 0 ? 'FILTER_NO_MATCH' : 'NO_SCHEDULE'}
            compact
            title="هیچ مرحله عملیاتی فعالی برای نمایش در این فیلتر وجود ندارد"
            actionLabel={activeFiltersCount > 0 ? 'پاک‌کردن فیلترها' : undefined}
            onAction={
              activeFiltersCount > 0
                ? () => {
                    setSelectedHall('ALL');
                    setSelectedShift('ALL');
                  }
                : undefined
            }
          />
        }
      />
    </FioriDynamicPage>
  );
};
