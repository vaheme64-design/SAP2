import React, { useState, useMemo } from 'react';
import {
  Gauge,
  Clock,
  TrendingUp,
  Download,
  Printer,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  BarChart3,
  GitBranch,
  Search,
  ShieldAlert,
  Plus,
  X,
  Trash2,
  ExternalLink,
} from 'lucide-react';
import { exportToCsv } from '../../utils/csvExport';
import { formatNumber, toPersianDigits } from '../../utils/formatters';
import { ScrapParetoChart } from './ScrapParetoChart';
import { useErpRouter } from '../../context/RouterContext';
import { usePersistedExpandMap, usePersistedOpen } from '../../hooks/usePersistedCollapse';
import { EmptyState } from '../common/EmptyState';
import {
  FioriDynamicPage,
  FioriDataTable,
  FioriTableColumn,
  FioriToolbar,
  FioriObjectStatus,
  FioriMessageStrip,
  FioriDialog,
  FioriStatusTone,
} from '../fiori/ui';

// -------------------------------------------------------------
// Types & Domain Models
// -------------------------------------------------------------
export interface MachineDowntimeEvent {
  id: string;
  machineCode: string;
  machineName: string;
  hall: string;
  category: 'UNPLANNED_BREAKDOWN' | 'SETUP_CHANGE' | 'MINOR_STOP' | 'MATERIAL_SHORTAGE' | 'OPERATOR_ABSENCE';
  categoryLabel: string;
  startHour: string; // e.g. "08:30"
  durationMinutes: number;
  reason: string;
  actionTaken: string;
  color: string;
}

export interface ScheduleAdherenceRecord {
  orderCode: string;
  partCode: string;
  partName: string;
  carModel: string;
  plannedQty: number;
  actualProducedQty: number;
  scrapQty: number;
  plannedStartHour: string;
  plannedEndHour: string;
  actualStartHour: string;
  actualEndHour: string;
  adherencePercent: number;
  varianceUnits: number;
  status: 'AHEAD' | 'ON_TRACK' | 'DELAYED' | 'CRITICAL_LAG';
  delayRootCause?: string;
  shifts: string;
}

export interface OeeNodeItem {
  id: string;
  title: string;
  metric: string;
  percentage: number;
  color: string;
  bgColor: string;
  borderColor: string;
  description: string;
  children?: OeeNodeItem[];
}

const DOWNTIME_CATEGORY_TONE: Record<MachineDowntimeEvent['category'], FioriStatusTone> = {
  UNPLANNED_BREAKDOWN: 'negative',
  SETUP_CHANGE: 'critical',
  MINOR_STOP: 'critical',
  MATERIAL_SHORTAGE: 'brand',
  OPERATOR_ABSENCE: 'neutral',
};

export const ComprehensiveProductionReportView: React.FC = () => {
  const { traceDocument } = useErpRouter();
  // Horizon Filter: Today, Yesterday, Current Week, Monthly
  const [selectedHorizon, setSelectedHorizon] = useState<'TODAY' | 'YESTERDAY' | 'WEEKLY' | 'MONTHLY'>('TODAY');
  const [selectedHall, setSelectedHall] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const {
    isExpanded: isOeeNodeExpanded,
    toggle: toggleNode,
    expandAll: expandAllOeeNodes,
    collapseAll: collapseAllOeeNodes,
  } = usePersistedExpandMap('report_oee_tree_nodes', {});
  const [isDowntimeSectionOpen, , toggleDowntimeSection] = usePersistedOpen('report_downtime_timeline_open', false);
  const [isAdherenceSectionOpen, , toggleAdherenceSection] = usePersistedOpen('report_schedule_adherence_open', false);

  // Selected Machine for timeline inspection
  const [inspectedMachine] = useState<string | null>(null);

  // -------------------------------------------------------------
  // Data: Dynamic Machine Downtime Events
  // -------------------------------------------------------------
  const DEFAULT_INITIAL_DOWNTIMES: MachineDowntimeEvent[] = [
    {
      id: 'DT-01',
      machineCode: 'SHR-GUI-01',
      machineName: 'قیچی گیوتین ۶ متری ۱',
      hall: 'سالن برش',
      category: 'SETUP_CHANGE',
      categoryLabel: 'تنظیم تیغه و فیکسچربندی برش',
      startHour: '07:30',
      durationMinutes: 45,
      reason: 'تعویض لبه تیغه گیوتین جهت برش ورق گرید DC04 با ضخامت ۲ میل',
      actionTaken: 'تنظیم لقی تیغه به میزان ۰.۱۸ میلیمتر و تست اولیه ۵ قطعه',
      color: 'bg-amber-500',
    },
    {
      id: 'DT-02',
      machineCode: 'PRS-250T-01',
      machineName: 'پرس ۲۵۰ تن ۱ (کشش/بلنک)',
      hall: 'سالن پرس',
      category: 'UNPLANNED_BREAKDOWN',
      categoryLabel: 'خرابی اضطراری هیدرولیک',
      startHour: '10:15',
      durationMinutes: 70,
      reason: 'نشت شیلنگ فشارقوی پمپ مدار کمکی بالشتک کشش (Die Cushion)',
      actionTaken: 'تیم نت (PM) شیلنگ هیدرولیک تعویض و هواگیری هیدرولیک انجام داد',
      color: 'bg-rose-600',
    },
    {
      id: 'DT-03',
      machineCode: 'PRS-160T-01',
      machineName: 'پرس ۱۶۰ تن ۱ (پانچ/خم)',
      hall: 'سالن پرس',
      category: 'SETUP_CHANGE',
      categoryLabel: 'تعویض قالب (SMED)',
      startHour: '12:30',
      durationMinutes: 35,
      reason: 'خروج قالب بلنک مکمل پژو ۲۰۶ و بارگذاری قالب خم لبه براکت',
      actionTaken: 'استفاده از کلمپ پنوماتیک و استقرار قالب در ۳۵ دقیقه (زیر ۴۰ دقیقه استاندارد)',
      color: 'bg-amber-500',
    },
    {
      id: 'DT-04',
      machineCode: 'PRS-160T-02',
      machineName: 'پرس ۱۶۰ تن ۲ (فرم/پانچ)',
      hall: 'سالن پرس',
      category: 'MINOR_STOP',
      categoryLabel: 'توقف جزئی / گیرکردن قطعه در قالب',
      startHour: '14:20',
      durationMinutes: 20,
      reason: 'عدم پرش کامل قطعه از روی سنبه به علت نقص در فنر پران (Ejector Pin)',
      actionTaken: 'روغن‌کاری پین پران و پاکسازی پلیسه‌های سطح ماتریس توسط اپراتور',
      color: 'bg-[#e9730c]',
    },
    {
      id: 'DT-05',
      machineCode: 'WLD-SPOT-01',
      machineName: 'پرس‌جوش مقاومتی ۱ (مهره‌جوش M6)',
      hall: 'سالن جوشکاری',
      category: 'MATERIAL_SHORTAGE',
      categoryLabel: 'تأخیر در تغذیه مهره جوشی M6',
      startHour: '15:10',
      durationMinutes: 30,
      reason: 'اتمام بافر تغذیه اتوماتیک مهره جوشی کاسه‌ای (Vibratory Feeder)',
      actionTaken: 'شارژ سریع کارتن مهره جوش استاندارد از انبار قطعات مصرفی',
      color: 'bg-[#007cc0]',
    },
    {
      id: 'DT-06',
      machineCode: 'WLD-CO2-ST01',
      machineName: 'کابین جوش CO2 شماره ۱',
      hall: 'سالن جوشکاری',
      category: 'UNPLANNED_BREAKDOWN',
      categoryLabel: 'سوختن نازل و گیرکردن سیم جوش',
      startHour: '16:45',
      durationMinutes: 25,
      reason: 'جرقه بیش از حد و انسداد نازل تورچ جوشکاری CO2',
      actionTaken: 'تعویض نازل تماسی و اسپری ضدجرقه (Anti-Spatter)',
      color: 'bg-rose-600',
    },
  ];

  const STORAGE_KEY_DOWNTIMES = 'kpims_dynamic_machine_downtimes_v2';

  const [machineDowntimes, setMachineDowntimes] = useState<MachineDowntimeEvent[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_DOWNTIMES);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // ignore
    }
    return DEFAULT_INITIAL_DOWNTIMES;
  });

  const saveDowntimes = (items: MachineDowntimeEvent[]) => {
    setMachineDowntimes(items);
    try {
      localStorage.setItem(STORAGE_KEY_DOWNTIMES, JSON.stringify(items));
    } catch {
      // ignore
    }
  };

  const handleDeleteDowntimeEvent = (id: string) => {
    const updated = machineDowntimes.filter(d => d.id !== id);
    saveDowntimes(updated);
  };

  // State for OEE Tree Node Drill-Down Drawer / Slide-Over
  const [oeeDrillDownContext, setOeeDrillDownContext] = useState<{
    title: string;
    categoryLabel: string;
    metric: string;
    description: string;
    events: MachineDowntimeEvent[];
  } | null>(null);

  // Modal State for Logging New Machine Downtime Event
  const [isLogDowntimeModalOpen, setIsLogDowntimeModalOpen] = useState<boolean>(false);
  const [newDtMachineCode, setNewDtMachineCode] = useState<string>('PRS-250T-01');
  const [newDtCategory, setNewDtCategory] = useState<
    'SETUP_CHANGE' | 'UNPLANNED_BREAKDOWN' | 'MINOR_STOP' | 'MATERIAL_SHORTAGE'
  >('UNPLANNED_BREAKDOWN');
  const [newDtDuration, setNewDtDuration] = useState<number>(30);
  const [newDtStartHour, setNewDtStartHour] = useState<string>('11:00');
  const [newDtReason, setNewDtReason] = useState<string>('');
  const [newDtAction, setNewDtAction] = useState<string>('');

  const handleAddDowntimeEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    const machineMap: Record<string, { name: string; hall: string }> = {
      'PRS-250T-01': { name: 'پرس ۲۵۰ تن ۱ (کشش/بلنک)', hall: 'سالن پرس' },
      'PRS-160T-01': { name: 'پرس ۱۶۰ تن ۱ (خم/پانچ)', hall: 'سالن پرس' },
      'SHR-GUI-01': { name: 'قیچی گیوتین ۶ متری ۱', hall: 'سالن برش' },
      'PRS-800T-G1': { name: 'پرس هیدرولیک ۸۰۰ تن', hall: 'سالن پرس سنگین' },
      'WLD-SPOT-01': { name: 'پرس‌جوش مقاومتی ۱ (مهره‌جوش M6)', hall: 'سالن جوشکاری' },
      'WLD-CO2-ST01': { name: 'کابین جوش CO2 شماره ۱', hall: 'سالن جوشکاری' },
    };
    const info = machineMap[newDtMachineCode] || { name: newDtMachineCode, hall: 'سالن تولید' };
    const labelMap: Record<string, string> = {
      SETUP_CHANGE: 'تنظیم قالب و ستاپ (SMED)',
      UNPLANNED_BREAKDOWN: 'خرابی اضطراری مکانیکی / هیدرولیکی',
      MINOR_STOP: 'توقف کوتاه و رفع گیر قالب',
      MATERIAL_SHORTAGE: 'تأخیر در تغذیه مواد و ورق پای کار',
    };
    const colorMap: Record<string, string> = {
      SETUP_CHANGE: 'bg-[#e9730c]',
      UNPLANNED_BREAKDOWN: 'bg-[#bb0000]',
      MINOR_STOP: 'bg-[#d97706]',
      MATERIAL_SHORTAGE: 'bg-[#007cc0]',
    };

    const newEvent: MachineDowntimeEvent = {
      id: `DT-${Date.now().toString().slice(-4)}`,
      machineCode: newDtMachineCode,
      machineName: info.name,
      hall: info.hall,
      category: newDtCategory,
      categoryLabel: labelMap[newDtCategory] || 'توقف خط',
      startHour: newDtStartHour,
      durationMinutes: Number(newDtDuration) || 15,
      reason: newDtReason || 'ثبت گزارش توقف در شیفت کاری',
      actionTaken: newDtAction || 'اقدام اصلاحی توسط تیم نگهداری و تعمیرات (نت)',
      color: colorMap[newDtCategory] || 'bg-rose-600',
    };

    saveDowntimes([newEvent, ...machineDowntimes]);

    try {
      await fetch('/api/oee/log-shift', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          machineId: newDtMachineCode,
          eventType: newDtCategory === 'SETUP_CHANGE' ? 'PLANNED_DOWNTIME' : 'UNPLANNED_DOWNTIME',
          durationMinutes: Number(newDtDuration) || 15,
          reasonTitleFa: newDtReason || labelMap[newDtCategory],
        }),
      });
    } catch {
      // ignore
    }

    setIsLogDowntimeModalOpen(false);
    setNewDtReason('');
    setNewDtAction('');
  };

  // -------------------------------------------------------------
  // Data: Schedule Adherence
  // -------------------------------------------------------------
  const adherenceList: ScheduleAdherenceRecord[] = useMemo(
    () => [
      {
        orderCode: 'MO-1404-3101',
        partCode: 'SAPCO-ASY-ECU-BRK-01',
        partName: 'مجموعه براکت ضدسرقت رایانه موتور',
        carModel: 'پژو ۲۰۶',
        plannedQty: 1500,
        actualProducedQty: 1420,
        scrapQty: 18,
        plannedStartHour: '07:00',
        plannedEndHour: '15:00',
        actualStartHour: '07:15',
        actualEndHour: '15:25',
        adherencePercent: 94.7,
        varianceUnits: -80,
        status: 'ON_TRACK',
        delayRootCause: 'تأخیر جزئی در تغذیه مهره جوش M6 در شیفت صبح',
        shifts: 'شیفت صبح و عصر',
      },
      {
        orderCode: 'MO-ECU-MAIN-01',
        partCode: 'WIP-ECU-MAIN-BRK',
        partName: 'صفحه براکت اصلی ضدسرقت رایانه موتور (پرس‌کاری و مهره‌جوش)',
        carModel: 'پژو ۲۰۶ / ۲۰۷',
        plannedQty: 1500,
        actualProducedQty: 1530,
        scrapQty: 12,
        plannedStartHour: '07:00',
        plannedEndHour: '14:30',
        actualStartHour: '07:00',
        actualEndHour: '14:15',
        adherencePercent: 102.0,
        varianceUnits: +30,
        status: 'AHEAD',
        delayRootCause: 'تولید بالاتر از برنامه با افزایش ریتم پرس‌کاری ۲۵۰ تن',
        shifts: 'شیفت صبح',
      },
      {
        orderCode: 'MO-ECU-COMP-01',
        partCode: 'WIP-ECU-COMP-BRK',
        partName: 'قطعه مکمل براکت ضدسرقت رایانه موتور (بلنک، خم و پیچ‌جوش)',
        carModel: 'پژو ۲۰۶ / ۲۰۷',
        plannedQty: 1500,
        actualProducedQty: 1310,
        scrapQty: 22,
        plannedStartHour: '08:00',
        plannedEndHour: '16:00',
        actualStartHour: '08:30',
        actualEndHour: '16:30',
        adherencePercent: 87.3,
        varianceUnits: -190,
        status: 'DELAYED',
        delayRootCause: 'توقف ۳۵ دقیقه‌ای تعویض قالب بلنک مکمل (SMED)',
        shifts: 'شیفت صبح و عصر',
      },
    ],
    []
  );

  // -------------------------------------------------------------
  // Dynamic OEE Calculation Driven Live by Downtime & Maintenance Logs
  // -------------------------------------------------------------
  const dynamicOeeMetrics = useMemo(() => {
    const totalShiftMinutes = 6 * 480;

    const setupMinutes = machineDowntimes
      .filter(d => d.category === 'SETUP_CHANGE')
      .reduce((sum, d) => sum + d.durationMinutes, 0);

    const breakdownMinutes = machineDowntimes
      .filter(d => d.category === 'UNPLANNED_BREAKDOWN' || d.category === 'MATERIAL_SHORTAGE')
      .reduce((sum, d) => sum + d.durationMinutes, 0);

    const minorStopsMinutes = machineDowntimes
      .filter(d => d.category === 'MINOR_STOP')
      .reduce((sum, d) => sum + d.durationMinutes, 0);

    const totalDowntimeMinutes = setupMinutes + breakdownMinutes;
    const netOperatingMinutes = Math.max(100, totalShiftMinutes - totalDowntimeMinutes);

    const availPct = Math.round((netOperatingMinutes / totalShiftMinutes) * 1000) / 10;
    const setupPct = Math.round((setupMinutes / totalShiftMinutes) * 1000) / 10;
    const breakdownPct = Math.round((breakdownMinutes / totalShiftMinutes) * 1000) / 10;

    const speedLossMinutes = minorStopsMinutes + 35;
    const perfPct = Math.max(
      60,
      Math.min(98, Math.round((1 - speedLossMinutes / netOperatingMinutes) * 1000) / 10)
    );
    const minorStopsPct = Math.round((minorStopsMinutes / netOperatingMinutes) * 1000) / 10;
    const reducedSpeedPct = Math.max(
      1,
      Math.round(((speedLossMinutes - minorStopsMinutes) / netOperatingMinutes) * 1000) / 10
    );

    const baseProducedPcs = 7200;
    const setupScrapPcs = Math.round(setupMinutes * 0.8);
    const processScrapPcs = Math.round(breakdownMinutes * 0.5) + 38;
    const totalScrap = setupScrapPcs + processScrapPcs;
    const qualPct = Math.round(((baseProducedPcs - totalScrap) / baseProducedPcs) * 1000) / 10;
    const setupScrapPct = Math.round((setupScrapPcs / baseProducedPcs) * 1000) / 10;
    const processScrapPct = Math.round((processScrapPcs / baseProducedPcs) * 1000) / 10;

    const oeePct = Math.round(((availPct * perfPct * qualPct) / 10000) * 10) / 10;

    return {
      totalShiftMinutes,
      setupMinutes,
      breakdownMinutes,
      minorStopsMinutes,
      totalDowntimeMinutes,
      availPct,
      setupPct,
      breakdownPct,
      perfPct,
      minorStopsPct,
      reducedSpeedPct,
      qualPct,
      setupScrapPcs,
      processScrapPcs,
      setupScrapPct,
      processScrapPct,
      oeePct,
    };
  }, [machineDowntimes]);

  const oeeTree: OeeNodeItem = useMemo(() => {
    const m = dynamicOeeMetrics;
    return {
      id: 'oee_root',
      title: 'شاخص اثربخشی کلی تجهیزات (OEE کل کارخانه - محاسباتی زنده)',
      metric: `${toPersianDigits(m.oeePct)}٪`,
      percentage: m.oeePct,
      color: 'text-[var(--fiori-critical)]',
      bgColor: 'bg-[var(--fiori-critical-bg)]/60',
      borderColor: 'border-[var(--fiori-critical-border)]',
      description: `حاصل‌ضرب پویای مؤلفه‌ها: دسترس‌پذیری (${toPersianDigits(m.availPct)}٪) × راندمان عملکرد (${toPersianDigits(m.perfPct)}٪) × کیفیت سالم (${toPersianDigits(m.qualPct)}٪)`,
      children: [
        {
          id: 'oee_avail',
          title: '۱. نرخ دسترس‌پذیری ماشین‌آلات (Availability)',
          metric: `${toPersianDigits(m.availPct)}٪`,
          percentage: m.availPct,
          color: 'text-[var(--fiori-brand)]',
          bgColor: 'bg-[var(--fiori-info-bg)]',
          borderColor: 'border-[var(--fiori-info-border)]',
          description: `زمان کارکرد خالص کسر از کل ${toPersianDigits(m.totalDowntimeMinutes)} دقیقه توقف ثبت‌شده در رویدادها`,
          children: [
            {
              id: 'avail_planned_downtime',
              title: 'توقفات برنامه‌ریزی‌شده / تعویض قالب (SMED)',
              metric: `${toPersianDigits(m.setupPct)}٪ زمان کل (${toPersianDigits(m.setupMinutes)} دقیقه)`,
              percentage: m.setupPct,
              color: 'text-[var(--fiori-text-primary)]',
              bgColor: 'bg-[var(--fiori-bg-subtle)]',
              borderColor: 'border-[var(--fiori-border-default)]',
              description: `مجموع زمان توقفات تعویض قالب و ستاپ ثبت‌شده در ${toPersianDigits(machineDowntimes.filter(d => d.category === 'SETUP_CHANGE').length)} رویداد لاگ‌شده`,
            },
            {
              id: 'avail_unplanned_breakdown',
              title: 'خرابی‌های اضطراری مکانیکی و هیدرولیکی',
              metric: `${toPersianDigits(m.breakdownPct)}٪ زمان کل (${toPersianDigits(m.breakdownMinutes)} دقیقه)`,
              percentage: m.breakdownPct,
              color: 'text-[var(--fiori-negative)]',
              bgColor: 'bg-[var(--fiori-negative-bg)]',
              borderColor: 'border-[var(--fiori-negative-border)]',
              description: `مجموع زمان خرابی‌های اضطراری هیدرولیک و توقفات خط در ${toPersianDigits(machineDowntimes.filter(d => d.category === 'UNPLANNED_BREAKDOWN' || d.category === 'MATERIAL_SHORTAGE').length)} رویداد لاگ‌شده`,
            },
          ],
        },
        {
          id: 'oee_perf',
          title: '۲. راندمان عملکرد و ریتم ضرب (Performance Rate)',
          metric: `${toPersianDigits(m.perfPct)}٪`,
          percentage: m.perfPct,
          color: 'text-[var(--fiori-brand)]',
          bgColor: 'bg-[var(--fiori-brand-bg)]',
          borderColor: 'border-[var(--fiori-brand-border)]',
          description: 'نسبت ضرب واقعی به ظرفیت اسمی استاندارد (کسر توقفات میکرو و افت سرعت ناشی از جنس ورق)',
          children: [
            {
              id: 'perf_minor_stops',
              title: 'توقفات میکرو (زیر ۵ دقیقه) و پران قطعه',
              metric: `${toPersianDigits(m.minorStopsPct)}٪ افت سرعت (${toPersianDigits(m.minorStopsMinutes)} دقیقه)`,
              percentage: m.minorStopsPct,
              color: 'text-[var(--fiori-critical)]',
              bgColor: 'bg-[var(--fiori-critical-bg)]',
              borderColor: 'border-[var(--fiori-critical-border)]',
              description: 'توقفات کوتاه ناشی از گیرکردن قطعه در قالب و مکث رول‌بازکن',
            },
            {
              id: 'perf_reduced_speed',
              title: 'کاهش ریتم اسمی به علت سختی و ضخامت ورق',
              metric: `${toPersianDigits(m.reducedSpeedPct)}٪ افت سرعت`,
              percentage: m.reducedSpeedPct,
              color: 'text-[var(--fiori-brand)]',
              bgColor: 'bg-[var(--fiori-bg-surface)]',
              borderColor: 'border-[var(--fiori-border-default)]',
              description: 'احتیاط اپراتور و پرس در شکل‌دهی ورق‌های با استحکام بالا جهت پیشگیری از چروک‌خوردگی و ترک',
            },
          ],
        },
        {
          id: 'oee_qual',
          title: '۳. نرخ کیفیت و تولید سالم (Quality Rate)',
          metric: `${toPersianDigits(m.qualPct)}٪`,
          percentage: m.qualPct,
          color: 'text-[var(--fiori-positive)]',
          bgColor: 'bg-[var(--fiori-positive-bg)]',
          borderColor: 'border-[var(--fiori-positive-border)]',
          description: `نسبت قطعات سالم تاییدشده (مجموع ضایعات: ${toPersianDigits(m.setupScrapPcs + m.processScrapPcs)} قطعه)`,
          children: [
            {
              id: 'qual_setup_scrap',
              title: 'ضایعات قطعات تنظیمی و راه‌اندازی ابتدای شیفت',
              metric: `${toPersianDigits(m.setupScrapPct)}٪ (${toPersianDigits(m.setupScrapPcs)} قطعه)`,
              percentage: m.setupScrapPct,
              color: 'text-[var(--fiori-positive)]',
              bgColor: 'bg-[var(--fiori-positive-bg)]',
              borderColor: 'border-[var(--fiori-positive-border)]',
              description: 'قطعات تست اولیه حین تنظیم لقی قالب و کنترل ابعادی با گیج',
            },
            {
              id: 'qual_process_defects',
              title: 'ضایعات حین فرآیند (پلیسه، ترک و پارگی کشش)',
              metric: `${toPersianDigits(m.processScrapPct)}٪ (${toPersianDigits(m.processScrapPcs)} قطعه)`,
              percentage: m.processScrapPct,
              color: 'text-[var(--fiori-negative)]',
              bgColor: 'bg-[var(--fiori-negative-bg)]',
              borderColor: 'border-[var(--fiori-negative-border)]',
              description: 'ترک لبه در کشش عمیق و جوش سرد شناسایی‌شده در بازرسی‌های حین تولید',
            },
          ],
        },
      ],
    };
  }, [dynamicOeeMetrics, machineDowntimes]);

  // Filtered Adherence List
  const filteredAdherence = useMemo(() => {
    return adherenceList.filter(item => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const match =
          item.orderCode.toLowerCase().includes(q) ||
          item.partCode.toLowerCase().includes(q) ||
          item.partName.toLowerCase().includes(q) ||
          item.carModel.toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    });
  }, [adherenceList, searchQuery]);

  // Filtered Downtime Events
  const filteredDowntimes = useMemo(() => {
    return machineDowntimes.filter(ev => {
      if (selectedHall !== 'ALL' && ev.hall !== selectedHall) return false;
      if (inspectedMachine && ev.machineCode !== inspectedMachine) return false;
      return true;
    });
  }, [machineDowntimes, selectedHall, inspectedMachine]);

  // Overall Adherence Metric
  const totalPlannedPcs = adherenceList.reduce((acc, r) => acc + r.plannedQty, 0);
  const totalActualPcs = adherenceList.reduce((acc, r) => acc + r.actualProducedQty, 0);
  const overallAdherencePercent = Math.round((totalActualPcs / Math.max(1, totalPlannedPcs)) * 1000) / 10;
  const totalDowntimeMinutes = machineDowntimes.reduce((acc, ev) => acc + ev.durationMinutes, 0);

  // Unique Machines for Timeline Row
  const uniqueMachines = Array.from(new Set(machineDowntimes.map(ev => ev.machineCode))).map(code => {
    const found = machineDowntimes.find(ev => ev.machineCode === code);
    return {
      code,
      name: found?.machineName || code,
      hall: found?.hall || '',
    };
  });

  // Downtime Log Fiori Columns
  const downtimeColumns = useMemo<FioriTableColumn<MachineDowntimeEvent>[]>(
    () => [
      {
        key: 'machineCode',
        header: 'کد ماشین',
        isMono: true,
        isLtrCode: true,
        cellClassName: 'font-semibold text-[var(--fiori-text-primary)]',
        render: ev => ev.machineCode,
      },
      {
        key: 'machineName',
        header: 'نام دستگاه و پرس',
        cellClassName: 'font-semibold text-[var(--fiori-text-primary)]',
        render: ev => ev.machineName,
      },
      {
        key: 'hall',
        header: 'سالن',
        cellClassName: 'text-[var(--fiori-text-secondary)]',
        render: ev => ev.hall,
      },
      {
        key: 'categoryLabel',
        header: 'نوع توقف',
        render: ev => (
          <FioriObjectStatus
            tone={DOWNTIME_CATEGORY_TONE[ev.category]}
            label={ev.categoryLabel}
          />
        ),
      },
      {
        key: 'startHour',
        header: 'ساعت شروع',
        isMono: true,
        isLtrCode: true,
        cellClassName: 'font-semibold',
        render: ev => ev.startHour,
      },
      {
        key: 'durationMinutes',
        header: 'مدت (دقیقه)',
        isMono: true,
        sortable: true,
        sortValue: ev => ev.durationMinutes,
        cellClassName: 'font-semibold text-[var(--fiori-negative)]',
        render: ev => `${toPersianDigits(ev.durationMinutes)} min`,
      },
      {
        key: 'reason',
        header: 'علت ریشه‌ای خرابی',
        cellClassName: 'text-[11px] leading-snug',
        render: ev => ev.reason,
      },
      {
        key: 'actionTaken',
        header: 'اقدام اصلاحی انجام‌شده (Action)',
        cellClassName: 'text-[11px] text-[var(--fiori-positive)] leading-snug',
        render: ev => ev.actionTaken,
      },
      {
        key: 'actions',
        header: 'عملیات',
        align: 'center',
        render: ev => (
          <button
            type="button"
            onClick={() => handleDeleteDowntimeEvent(ev.id)}
            className="p-1 text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-negative)] hover:bg-[var(--fiori-negative-bg)] rounded-[var(--fiori-radius-sm)] transition cursor-pointer"
            title="حذف این توقف و به‌روزرسانی آنی درصد شاخه‌های درخت OEE"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        ),
      },
    ],
    [machineDowntimes]
  );

  // Schedule Adherence Fiori Columns
  const adherenceColumns = useMemo<FioriTableColumn<ScheduleAdherenceRecord>[]>(
    () => [
      {
        key: 'orderCode',
        header: 'شماره دستور کار',
        sortable: true,
        sortValue: item => item.orderCode,
        render: item => (
          <button
            type="button"
            onClick={() => traceDocument(item.orderCode, 'WIP_TRACEABILITY')}
            className="sap-doc-link fiori-ltr-code font-bold"
            title="رهگیری دستور کار در WIP"
          >
            {item.orderCode}
          </button>
        ),
      },
      {
        key: 'part',
        header: 'نام و مشخصات قطعه',
        render: item => (
          <div>
            <div className="font-semibold text-[var(--fiori-text-primary)]">{item.partName}</div>
            <button
              type="button"
              onClick={() => traceDocument(item.partCode, 'INVENTORY_LEDGER')}
              className="sap-doc-link fiori-ltr-code text-[10px]"
              title="مشاهده کاردکس قطعه"
            >
              {item.partCode}
            </button>
          </div>
        ),
      },
      {
        key: 'carModel',
        header: 'خودرو',
        render: item => item.carModel,
      },
      {
        key: 'plannedWindow',
        header: 'زمان مصوب',
        isMono: true,
        cellClassName: 'text-[11px] text-[var(--fiori-text-secondary)]',
        render: item => `${item.plannedStartHour} تا ${item.plannedEndHour}`,
      },
      {
        key: 'actualWindow',
        header: 'زمان واقعی',
        isMono: true,
        cellClassName: 'text-[11px]',
        render: item => `${item.actualStartHour} تا ${item.actualEndHour}`,
      },
      {
        key: 'plannedQty',
        header: 'تیراژ مصوب',
        isMono: true,
        sortable: true,
        sortValue: item => item.plannedQty,
        cellClassName: 'font-semibold',
        render: item => formatNumber(item.plannedQty),
      },
      {
        key: 'actualProducedQty',
        header: 'تولید سالم',
        isMono: true,
        sortable: true,
        sortValue: item => item.actualProducedQty,
        cellClassName: 'font-semibold text-[var(--fiori-positive)]',
        render: item => formatNumber(item.actualProducedQty),
      },
      {
        key: 'scrapQty',
        header: 'ضایعات',
        isMono: true,
        cellClassName: 'text-[var(--fiori-negative)]',
        render: item => formatNumber(item.scrapQty),
      },
      {
        key: 'adherencePercent',
        header: 'درصد تحقق (Adherence)',
        sortable: true,
        sortValue: item => item.adherencePercent,
        render: item => (
          <div className="flex items-center gap-2">
            <div className="w-16 bg-[var(--fiori-bg-subtle)] rounded-sm h-2 overflow-hidden border border-[var(--fiori-border-default)]">
              <div
                className={`h-full ${
                  item.adherencePercent >= 95
                    ? 'bg-[var(--fiori-positive)]'
                    : item.adherencePercent >= 85
                    ? 'bg-[var(--fiori-critical)]'
                    : 'bg-[var(--fiori-negative)]'
                }`}
                style={{ width: `${Math.min(100, item.adherencePercent)}%` }}
              />
            </div>
            <span className="font-mono font-semibold tabular-nums">
              {toPersianDigits(item.adherencePercent)}٪
            </span>
          </div>
        ),
      },
      {
        key: 'varianceUnits',
        header: 'انحراف (تعداد)',
        isMono: true,
        sortable: true,
        sortValue: item => item.varianceUnits,
        cellClassName: item =>
          `font-semibold ${
            item.varianceUnits >= 0
              ? 'text-[var(--fiori-positive)]'
              : 'text-[var(--fiori-negative)]'
          }`,
        render: item =>
          item.varianceUnits >= 0
            ? `+${formatNumber(item.varianceUnits)}`
            : formatNumber(item.varianceUnits),
      },
      {
        key: 'status',
        header: 'وضعیت انطباق',
        render: item => (
          <FioriObjectStatus
            tone={
              item.status === 'AHEAD'
                ? 'positive'
                : item.status === 'ON_TRACK'
                ? 'brand'
                : item.status === 'DELAYED'
                ? 'critical'
                : 'negative'
            }
            label={
              item.status === 'AHEAD'
                ? 'جلوتر از برنامه'
                : item.status === 'ON_TRACK'
                ? 'منطبق با برنامه'
                : item.status === 'DELAYED'
                ? 'دارای تأخیر'
                : 'تأخیر بحرانی'
            }
          />
        ),
      },
      {
        key: 'delayRootCause',
        header: 'علت ریشه‌ای تأخیر',
        cellClassName: 'text-[11px] text-[var(--fiori-text-secondary)] leading-snug',
        render: item => item.delayRootCause || '-',
      },
    ],
    [traceDocument]
  );

  // Print Isolated Report (A4 Landscape)
  const handlePrintReport = () => {
    const existing = document.getElementById('comprehensive-report-print-frame') as HTMLIFrameElement | null;
    if (existing) existing.remove();

    const iframe = document.createElement('iframe');
    iframe.id = 'comprehensive-report-print-frame';
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow?.document;
    if (!doc) return;

    const rowsHtml = adherenceList
      .map(
        (r, idx) => `
      <tr>
        <td>${toPersianDigits(idx + 1)}</td>
        <td style="font-family: monospace; font-weight: bold;">${r.orderCode}</td>
        <td><strong>${r.partName}</strong><br/><span style="font-size:10px; color:#555;">${r.partCode} (${r.carModel})</span></td>
        <td>${formatNumber(r.plannedQty)}</td>
        <td style="font-weight: bold; color: #047857;">${formatNumber(r.actualProducedQty)}</td>
        <td style="color: #dc2626;">${formatNumber(r.scrapQty)}</td>
        <td style="font-weight: bold;">${toPersianDigits(r.adherencePercent)}٪</td>
        <td>${r.varianceUnits >= 0 ? '+' + formatNumber(r.varianceUnits) : formatNumber(r.varianceUnits)}</td>
        <td>${r.status === 'AHEAD' ? 'جلوتر از برنامه' : r.status === 'ON_TRACK' ? 'منطبق با برنامه' : r.status === 'DELAYED' ? 'دارای تأخیر' : 'تأخیر بحرانی'}</td>
        <td style="font-size: 10px;">${r.delayRootCause || '-'}</td>
      </tr>
    `
      )
      .join('');

    const downtimesHtml = machineDowntimes
      .map(
        (dt, idx) => `
      <tr>
        <td>${toPersianDigits(idx + 1)}</td>
        <td><strong>${dt.machineName}</strong> (${dt.machineCode})</td>
        <td>${dt.hall}</td>
        <td>${dt.categoryLabel}</td>
        <td>ساعت ${dt.startHour}</td>
        <td style="font-weight: bold;">${toPersianDigits(dt.durationMinutes)} دقیقه</td>
        <td style="font-size: 10px;">${dt.reason}</td>
        <td style="font-size: 10px;">${dt.actionTaken}</td>
      </tr>
    `
      )
      .join('');

    doc.open();
    doc.write(`
      <!DOCTYPE html>
      <html lang="fa" dir="rtl">
      <head>
        <meta charset="UTF-8" />
        <title>گزارش جامع شاخص‌های بهره‌وری (OEE)، توقفات ماشین‌آلات و انحراف برنامه</title>
        <style>
          body { font-family: Tahoma, Arial, sans-serif; padding: 16px; color: #111; direction: rtl; }
          .header { border: 2px solid #111; padding: 12px; border-radius: 8px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; }
          h1 { margin: 0 0 6px 0; font-size: 15px; }
          .kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 14px; font-size: 11px; }
          .kpi-card { border: 1px solid #444; padding: 8px; border-radius: 6px; background: #f8fafc; }
          table { width: 100%; border-collapse: collapse; font-size: 10.5px; margin-bottom: 14px; }
          th, td { border: 1px solid #333; padding: 5px 6px; text-align: right; }
          th { background: #f1f5f9; font-weight: bold; }
          h2 { font-size: 12px; margin: 12px 0 6px 0; border-bottom: 1px solid #999; padding-bottom: 4px; }
          @media print { @page { size: A4 landscape; margin: 8mm; } }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <h1>گزارش جامع شاخص‌های بهره‌وری (OEE)، توقفات ماشین‌آلات و انحراف از برنامه (Schedule Adherence)</h1>
            <div>شرکت قطعات محوری کوثر — واحد برنامه‌ریزی، کنترل تولید و تضمین کیفیت (PPC & QC)</div>
          </div>
          <div style="text-align: left; font-size: 11px;">
            <div><strong>شاخص کل OEE:</strong> ۷۱.۶٪</div>
            <div><strong>انطباق با برنامه (Adherence):</strong> ${toPersianDigits(overallAdherencePercent)}٪</div>
            <div><strong>کل زمان توقف ثبت‌شده:</strong> ${toPersianDigits(totalDowntimeMinutes)} دقیقه</div>
          </div>
        </div>

        <div class="kpi-row">
          <div class="kpi-card"><strong>دسترس‌پذیری (Availability):</strong> ۸۸.۴٪</div>
          <div class="kpi-card"><strong>راندمان عملکرد (Performance):</strong> ۸۲.۵٪</div>
          <div class="kpi-card"><strong>نرخ کیفیت سالم (Quality):</strong> ۹۸.۲٪</div>
          <div class="kpi-card"><strong>انحراف کل تولید:</strong> ${formatNumber(totalActualPcs - totalPlannedPcs)} عدد</div>
        </div>

        <h2>۱. جدول انحراف از برنامه تولید به تفکیک دستور کار و قطعه (Schedule Adherence)</h2>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>دستور کار</th>
              <th>نام و کد قطعه</th>
              <th>هدف</th>
              <th>تولید سالم</th>
              <th>ضایعات</th>
              <th>تحقق (%)</th>
              <th>انحراف</th>
              <th>وضعیت</th>
              <th>علت ریشه‌ای تأخیر</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>

        <h2>۲. گزارش زمانی توقفات ثبت‌شده ماشین‌آلات و پرس‌ها (Downtime Log)</h2>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>دستگاه و پرس</th>
              <th>سالن</th>
              <th>دسته‌بندی توقف</th>
              <th>ساعت وقوع</th>
              <th>مدت توقف</th>
              <th>شرح علت ریشه‌ای خرابی</th>
              <th>اقدام اصلاحی انجام‌شده</th>
            </tr>
          </thead>
          <tbody>
            ${downtimesHtml}
          </tbody>
        </table>
      </body>
      </html>
    `);
    doc.close();

    setTimeout(() => {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    }, 300);
  };

  // Export CSV of Adherence & Downtime
  const handleExportCsv = () => {
    const headers = [
      'شماره دستور کار',
      'کد قطعه',
      'نام قطعه',
      'خودرو',
      'تیراژ برنامه‌ریزی‌شده',
      'تولید واقعی سالم',
      'ضایعات',
      'درصد تحقق برنامه (Adherence %)',
      'انحراف تیراژ',
      'وضعیت انطباق',
      'علت ریشه‌ای تأخیر',
    ];
    const rows = adherenceList.map(r => [
      r.orderCode,
      r.partCode,
      r.partName,
      r.carModel,
      r.plannedQty,
      r.actualProducedQty,
      r.scrapQty,
      `${r.adherencePercent}%`,
      r.varianceUnits,
      r.status,
      r.delayRootCause || '',
    ]);
    exportToCsv(`گزارش_انحراف_برنامه_و_OEE_${selectedHorizon}`, headers, rows);
  };

  return (
    <FioriDynamicPage
      title="داشبورد گزارش‌دهی جامع تولید: شاخص‌های بهره‌وری (OEE)، توقفات ماشین‌آلات و انحراف برنامه (Schedule Adherence)"
      subtitle="رصد بلادرنگ زنجیره ارزش تولید: ساختار سلسله‌مراتبی OEE (دسترس‌پذیری × عملکرد × کیفیت)، توقفات سالن‌های پرس بر روی خط زمان (Gantt/Timeline) و تحلیل شکاف زمانی و مقداری دستورهای ساخت (MO)."
      status={
        <FioriObjectStatus
          tone="brand"
          label="نمودارهای ساختار درختی و محور زمانی (Timeline)"
        />
      }
      collapsibleFilters={false}
      activeFiltersCount={selectedHall !== 'ALL' ? 1 : 0}
      onResetFilters={() => setSelectedHall('ALL')}
      headerActions={
        <>
          <button
            type="button"
            onClick={handlePrintReport}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>چاپ رسمی گزارش (A4 ایزوله)</span>
          </button>
          <button
            type="button"
            onClick={handleExportCsv}
            className="sap-btn-emphasized flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>خروجی اکسل (CSV)</span>
          </button>
        </>
      }
      filterBar={
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-semibold text-[var(--fiori-text-primary)]">بازه زمانی گزارش:</span>
            {[
              { id: 'TODAY' as const, label: 'امروز (شیفت فعال)' },
              { id: 'YESTERDAY' as const, label: 'روز قبل' },
              { id: 'WEEKLY' as const, label: 'هفته جاری (تجمعی)' },
              { id: 'MONTHLY' as const, label: 'ماهانه (۳۰ روز)' },
            ].map(h => (
              <button
                key={h.id}
                type="button"
                onClick={() => setSelectedHorizon(h.id)}
                className={`px-3 py-1 rounded-[var(--fiori-radius-sm)] font-semibold transition cursor-pointer border ${
                  selectedHorizon === h.id
                    ? 'bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border-[var(--fiori-brand)]'
                    : 'bg-[var(--fiori-bg-surface)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] border-[var(--fiori-border-default)]'
                }`}
              >
                {h.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[var(--fiori-text-secondary)] font-medium">فیلتر سالن:</span>
            <select
              value={selectedHall}
              onChange={e => setSelectedHall(e.target.value)}
              className="fiori-input px-3 py-1 font-semibold cursor-pointer"
            >
              <option value="ALL">همه سالن‌های کارخانه</option>
              <option value="سالن برش">سالن برش و گیوتین</option>
              <option value="سالن پرس">سالن پرس و فرم‌دهی</option>
              <option value="سالن جوشکاری">سالن جوشکاری و پرس‌جوش</option>
            </select>
          </div>
        </div>
      }
      kpiStrip={
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* KPI 1: OEE */}
          <div className="fiori-surface-card p-3.5 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[var(--fiori-text-secondary)]">
                شاخص کل OEE کارخانه
              </span>
              <Gauge className="w-4 h-4 text-[var(--fiori-brand)]" />
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-[var(--fiori-text-primary)] font-mono tabular-nums">
                ۷۱.۶٪
              </span>
              <span className="text-xs font-semibold text-[var(--fiori-positive)]">
                روند مثبت (+۲.۴٪)
              </span>
            </div>
            <p className="text-[11px] text-[var(--fiori-text-secondary)]">
              هدف استاندارد ساپکو: بالای ۷۰٪ | دسترس‌پذیری ۸۸.۴٪ × عملکرد ۸۲.۵٪ × کیفیت ۹۸.۲٪
            </p>
          </div>

          {/* KPI 2: Schedule Adherence */}
          <div className="fiori-surface-card p-3.5 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[var(--fiori-text-secondary)]">
                انطباق با برنامه (Adherence)
              </span>
              <TrendingUp className="w-4 h-4 text-[var(--fiori-brand)]" />
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-[var(--fiori-text-primary)] font-mono tabular-nums">
                {toPersianDigits(overallAdherencePercent)}٪
              </span>
              <span className="text-xs font-semibold text-[var(--fiori-text-secondary)] tabular-nums">
                تولید {formatNumber(totalActualPcs)} از {formatNumber(totalPlannedPcs)}
              </span>
            </div>
            <p className="text-[11px] text-[var(--fiori-text-secondary)]">
              کسری نهایی خط: {formatNumber(Math.abs(totalActualPcs - totalPlannedPcs))} قطعه (عمدتاً به دلیل توقف پرس ۲۵۰ تن)
            </p>
          </div>

          {/* KPI 3: Total Downtimes */}
          <div className="fiori-surface-card p-3.5 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[var(--fiori-text-secondary)]">
                مجموع زمان توقفات ماشین‌آلات
              </span>
              <Clock className="w-4 h-4 text-[var(--fiori-negative)]" />
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-[var(--fiori-negative)] font-mono tabular-nums">
                {toPersianDigits(totalDowntimeMinutes)}
              </span>
              <span className="text-xs font-semibold text-[var(--fiori-text-secondary)] tabular-nums">
                دقیقه ({toPersianDigits((totalDowntimeMinutes / 60).toFixed(1))} ساعت)
              </span>
            </div>
            <p className="text-[11px] text-[var(--fiori-text-secondary)]">
              توقف اضطراری: ۹۵ دقیقه (۴۳٪) | تعویض قالب و ستاپ: ۸۰ دقیقه (۳۶٪) | سایر: ۴۵ دقیقه
            </p>
          </div>

          {/* KPI 4: Quality & Scrap Rate */}
          <div className="fiori-surface-card p-3.5 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[var(--fiori-text-secondary)]">
                نرخ کیفیت و تولید سالم
              </span>
              <ShieldAlert className="w-4 h-4 text-[var(--fiori-positive)]" />
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-[var(--fiori-positive)] font-mono tabular-nums">
                ۹۸.۲٪
              </span>
              <span className="text-xs font-semibold text-[var(--fiori-negative)] tabular-nums">
                ضایعات: ۱.۸٪ (۱۲۸ عدد)
              </span>
            </div>
            <p className="text-[11px] text-[var(--fiori-text-secondary)]">
              بیشترین ضایعات در قالب کشش صندلی چپ (۳۱ قطعه) به علت نوسان فشار بالشتک پرس
            </p>
          </div>
        </div>
      }
    >
      {/* ==================================================================== */}
      {/* SECTION 1: TREE-STRUCTURED OEE BREAKDOWN CHART (نمودار درختی OEE)    */}
      {/* ==================================================================== */}
      <div className="fiori-surface-card p-4 space-y-3.5">
        <FioriToolbar
          variant="section"
          title="۱. نمودار ساختار درختی شکست شاخص اثربخشی کلی تجهیزات (Tree-Structured OEE Breakdown)"
          subtitle="نمایش علل ریشه‌ای افت OEE در قالب شاخه‌های دسترس‌پذیری، عملکرد و کیفیت و دلایل فرعی مربوط به هر شاخه"
          startContent={
            <div className="w-8 h-8 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-critical-bg)] text-[var(--fiori-critical)] border border-[var(--fiori-critical-border)] flex items-center justify-center shrink-0">
              <GitBranch className="w-4 h-4" />
            </div>
          }
          endContent={
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => setIsLogDowntimeModalOpen(true)}
                className="sap-btn-emphasized px-3 py-1 cursor-pointer flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>ثبت رویداد توقف / خرابی نت</span>
              </button>
              <button
                type="button"
                onClick={() => expandAllOeeNodes(['oee_root', 'oee_avail', 'oee_perf', 'oee_qual'])}
                className="sap-btn-standard px-2.5 py-1 cursor-pointer"
              >
                باز کردن همه شاخه‌ها
              </button>
              <button
                type="button"
                onClick={collapseAllOeeNodes}
                className="sap-btn-standard px-2.5 py-1 cursor-pointer"
              >
                بستن همه شاخه‌ها
              </button>
            </div>
          }
        />

        {/* Tree Root Node */}
        <div className="space-y-4 pt-1">
          {/* Level 0: Root Node */}
          <div
            className={`p-3.5 rounded-[var(--fiori-radius-md)] border ${oeeTree.borderColor} ${oeeTree.bgColor} transition-all`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => toggleNode(oeeTree.id)}
                  className="w-7 h-7 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-surface)] border border-[var(--fiori-critical-border)] text-[var(--fiori-critical)] flex items-center justify-center cursor-pointer"
                  title={isOeeNodeExpanded(oeeTree.id) ? 'بستن شاخه‌های OEE' : 'باز کردن شاخه‌های OEE'}
                >
                  {isOeeNodeExpanded(oeeTree.id) ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronRight className="w-4 h-4" />
                  )}
                </button>
                <div>
                  <span className="font-semibold text-sm text-[var(--fiori-text-primary)] block">
                    {oeeTree.title}
                  </span>
                  <span className="text-xs text-[var(--fiori-text-secondary)]">
                    {oeeTree.description}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-48 bg-[var(--fiori-bg-surface)] border border-[var(--fiori-critical-border)] rounded-sm h-3 overflow-hidden p-0.5">
                  <div
                    className="bg-[var(--fiori-critical)] h-full rounded-sm transition-all duration-500"
                    style={{ width: `${oeeTree.percentage}%` }}
                  />
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setOeeDrillDownContext({
                      title: 'ریز رکوردهای کلیه توقفات مؤثر بر OEE کل کارخانه',
                      categoryLabel: 'تمام لاگ‌های ثبت‌شده',
                      metric: oeeTree.metric,
                      description: `محاسبه زنده بر اساس ${toPersianDigits(machineDowntimes.length)} رویداد توقف و تعویض قالب در شیفت`,
                      events: machineDowntimes,
                    })
                  }
                  className="font-mono font-bold text-xl tabular-nums text-[var(--fiori-critical)] hover:underline cursor-pointer flex items-center gap-1"
                  title="کلیک جهت مشاهده لاگ‌های توقف مؤثر بر OEE"
                >
                  <span>{oeeTree.metric}</span>
                  <ExternalLink className="w-3.5 h-3.5 inline" />
                </button>
              </div>
            </div>

            {/* Level 1: Three Pillars */}
            {isOeeNodeExpanded(oeeTree.id) && oeeTree.children && (
              <div className="mt-4 pt-4 border-t border-[var(--fiori-critical-border)] grid grid-cols-1 md:grid-cols-3 gap-4">
                {oeeTree.children.map(pillar => {
                  const isExpanded = isOeeNodeExpanded(pillar.id);
                  return (
                    <div
                      key={pillar.id}
                      className={`p-3.5 rounded-[var(--fiori-radius-md)] border ${pillar.borderColor} ${pillar.bgColor} flex flex-col justify-between space-y-3`}
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2 border-b border-[var(--fiori-border-subtle)] pb-2">
                          <button
                            type="button"
                            onClick={() => toggleNode(pillar.id)}
                            className="flex items-center gap-1.5 text-xs font-semibold text-[var(--fiori-text-primary)] hover:text-[var(--fiori-brand)] cursor-pointer text-right"
                          >
                            {isExpanded ? (
                              <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                            ) : (
                              <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                            )}
                            <span>{pillar.title}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (pillar.id === 'oee_avail') {
                                setOeeDrillDownContext({
                                  title: 'رویدادهای مؤثر بر دسترس‌پذیری ماشین‌آلات (Availability)',
                                  categoryLabel: 'توقفات برنامه‌ریزی‌شده و اضطراری',
                                  metric: pillar.metric,
                                  description: pillar.description,
                                  events: machineDowntimes,
                                });
                              } else if (pillar.id === 'oee_perf') {
                                setOeeDrillDownContext({
                                  title: 'رویدادهای مؤثر بر راندمان عملکرد و افت سرعت',
                                  categoryLabel: 'توقفات کوتاه و میکرو',
                                  metric: pillar.metric,
                                  description: pillar.description,
                                  events: machineDowntimes.filter(d => d.category === 'MINOR_STOP'),
                                });
                              } else {
                                setOeeDrillDownContext({
                                  title: 'رویدادهای نرخ کیفیت و قطعات معیوب',
                                  categoryLabel: 'ضایعات ستاپ و حین تولید',
                                  metric: pillar.metric,
                                  description: pillar.description,
                                  events: machineDowntimes.filter(
                                    d => d.category === 'SETUP_CHANGE' || d.category === 'UNPLANNED_BREAKDOWN'
                                  ),
                                });
                              }
                            }}
                            className={`font-mono font-bold tabular-nums text-sm hover:underline cursor-pointer flex items-center gap-1 ${pillar.color}`}
                            title="مشاهده لاگ‌های این ستون OEE"
                          >
                            <span>{pillar.metric}</span>
                            <ExternalLink className="w-3 h-3 inline opacity-70" />
                          </button>
                        </div>
                        <p className="text-[11px] text-[var(--fiori-text-secondary)] mt-2 leading-relaxed">
                          {pillar.description}
                        </p>
                      </div>

                      {/* Level 2 Sub-branches */}
                      {isExpanded && pillar.children && (
                        <div className="space-y-2 pt-2 border-t border-[var(--fiori-border-subtle)]">
                          {pillar.children.map(sub => (
                            <button
                              key={sub.id}
                              type="button"
                              onClick={() => {
                                if (sub.id === 'avail_planned_downtime') {
                                  setOeeDrillDownContext({
                                    title: sub.title,
                                    categoryLabel: 'توقفات تعویض قالب و ستاپ (SMED)',
                                    metric: sub.metric,
                                    description: sub.description,
                                    events: machineDowntimes.filter(d => d.category === 'SETUP_CHANGE'),
                                  });
                                } else if (sub.id === 'avail_unplanned_breakdown') {
                                  setOeeDrillDownContext({
                                    title: sub.title,
                                    categoryLabel: 'خرابی‌های اضطراری مکانیکی و هیدرولیکی',
                                    metric: sub.metric,
                                    description: sub.description,
                                    events: machineDowntimes.filter(
                                      d => d.category === 'UNPLANNED_BREAKDOWN' || d.category === 'MATERIAL_SHORTAGE'
                                    ),
                                  });
                                } else if (sub.id === 'perf_minor_stops') {
                                  setOeeDrillDownContext({
                                    title: sub.title,
                                    categoryLabel: 'توقفات کوتاه و میکرو',
                                    metric: sub.metric,
                                    description: sub.description,
                                    events: machineDowntimes.filter(d => d.category === 'MINOR_STOP'),
                                  });
                                } else {
                                  setOeeDrillDownContext({
                                    title: sub.title,
                                    categoryLabel: 'رویدادهای مرتبط با این شاخه',
                                    metric: sub.metric,
                                    description: sub.description,
                                    events: machineDowntimes,
                                  });
                                }
                              }}
                              className={`w-full p-2.5 rounded-[var(--fiori-radius-sm)] border text-right transition cursor-pointer hover:shadow-xs group ${sub.borderColor} ${sub.bgColor} space-y-1 text-xs`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-semibold text-[var(--fiori-text-primary)] text-[11px] group-hover:text-[var(--fiori-brand)] flex items-center gap-1">
                                  <span>{sub.title}</span>
                                  <ExternalLink className="w-2.5 h-2.5 opacity-0 group-hover:opacity-100 transition" />
                                </span>
                                <span className="font-mono font-semibold text-[11px] tabular-nums text-[var(--fiori-text-primary)] group-hover:underline">
                                  {sub.metric}
                                </span>
                              </div>
                              <p className="text-[10px] text-[var(--fiori-text-secondary)] leading-normal">
                                {sub.description}
                              </p>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ==================================================================== */}
      {/* SECTION 1.5: SCRAP & DOWNTIME PARETO CHART (IATF 16949 / 80-20)      */}
      {/* ==================================================================== */}
      <ScrapParetoChart />

      {/* ==================================================================== */}
      {/* SECTION 2: MACHINE DOWNTIME TIMELINE                                 */}
      {/* ==================================================================== */}
      <div className="fiori-surface-card p-4 space-y-3.5">
        <div
          onClick={toggleDowntimeSection}
          className={`flex flex-wrap items-center justify-between gap-3 cursor-pointer ${
            isDowntimeSectionOpen ? 'border-b border-[var(--fiori-border-subtle)] pb-3' : ''
          }`}
        >
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-negative-bg)] text-[var(--fiori-negative)] border border-[var(--fiori-negative-border)] flex items-center justify-center shrink-0">
              <Clock className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--fiori-text-primary)]">
                ۲. نمودار زمانی توقفات ماشین‌آلات و خطوط تولید (Machine Downtime Timeline / Gantt)
              </h3>
              <p className="text-xs text-[var(--fiori-text-secondary)] mt-0.5 tabular-nums">
                مجموع توقفات شیفت:{' '}
                <strong className="font-mono text-[var(--fiori-negative)]">
                  {toPersianDigits(totalDowntimeMinutes)} دقیقه
                </strong>{' '}
                در{' '}
                <strong className="font-mono text-[var(--fiori-text-primary)]">
                  {toPersianDigits(uniqueMachines.length)} دستگاه
                </strong>{' '}
                ({toPersianDigits(filteredDowntimes.length)} رویداد ثبت‌شده)
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 text-xs flex-wrap" onClick={e => e.stopPropagation()}>
            {isDowntimeSectionOpen && (
              <>
                <FioriObjectStatus tone="negative" variant="dot" label="خرابی اضطراری" />
                <FioriObjectStatus tone="critical" variant="dot" label="تعویض قالب (SMED)" />
                <FioriObjectStatus tone="critical" variant="dot" label="توقف جزئی پران" />
                <FioriObjectStatus tone="brand" variant="dot" label="کمبود مهره جوش / تغذیه" />
              </>
            )}
            <button
              type="button"
              onClick={toggleDowntimeSection}
              className="sap-btn-standard px-2.5 py-1 text-xs flex items-center gap-1 cursor-pointer whitespace-nowrap"
            >
              <span>{isDowntimeSectionOpen ? 'بستن جزئیات' : 'نمایش خط زمان و جدول'}</span>
              {isDowntimeSectionOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {isDowntimeSectionOpen && (
          <>
            {/* Timeline Axis (Hours 07:00 to 19:00) */}
            <div className="overflow-x-auto border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] p-3.5 bg-[var(--fiori-bg-subtle)] space-y-3.5">
              <div className="min-w-[850px] space-y-3">
                {/* Hour Rulers */}
                <div className="grid grid-cols-12 gap-1 text-[11px] font-mono text-[var(--fiori-text-secondary)] border-b border-[var(--fiori-border-default)] pb-2 text-center">
                  <span>۰۷:۰۰</span>
                  <span>۰۸:۰۰</span>
                  <span>۰۹:۰۰</span>
                  <span>۱۰:۰۰</span>
                  <span>۱۱:۰۰</span>
                  <span>۱۲:۰۰</span>
                  <span>۱۳:۰۰</span>
                  <span>۱۴:۰۰</span>
                  <span>۱۵:۰۰</span>
                  <span>۱۶:۰۰</span>
                  <span>۱۷:۰۰</span>
                  <span>۱۸:۰۰</span>
                </div>

                {/* Machine Rows */}
                {uniqueMachines.map(mch => {
                  const events = machineDowntimes.filter(ev => ev.machineCode === mch.code);
                  return (
                    <div key={mch.code} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-[var(--fiori-text-primary)]">
                          {mch.name}{' '}
                          <span className="font-mono text-[var(--fiori-text-secondary)] font-normal">
                            (<span className="fiori-ltr-code">{mch.code}</span> — {mch.hall})
                          </span>
                        </span>
                        <span className="text-[11px] text-[var(--fiori-text-secondary)] tabular-nums">
                          مجموع توقف: {toPersianDigits(events.reduce((sum, e) => sum + e.durationMinutes, 0))} دقیقه
                        </span>
                      </div>

                      {/* 12-hour bar track */}
                      <div className="relative h-8 bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] overflow-hidden flex items-center">
                        <div className="absolute inset-0 grid grid-cols-12 pointer-events-none divide-x divide-[var(--fiori-border-subtle)] divide-x-reverse" />

                        {events.map(ev => {
                          const [hStr, mStr] = ev.startHour.split(':');
                          const startTotalMinutes = (parseInt(hStr, 10) - 7) * 60 + parseInt(mStr, 10);
                          const leftPercent = Math.max(0, Math.min(100, (startTotalMinutes / 720) * 100));
                          const widthPercent = Math.max(
                            2,
                            Math.min(100 - leftPercent, (ev.durationMinutes / 720) * 100)
                          );

                          return (
                            <div
                              key={ev.id}
                              style={{
                                right: `${leftPercent}%`,
                                width: `${widthPercent}%`,
                              }}
                              title={`${ev.categoryLabel} (${ev.startHour} به مدت ${ev.durationMinutes} دقیقه): ${ev.reason}`}
                              className={`absolute h-6 rounded-sm px-1.5 text-[10px] text-white font-semibold flex items-center justify-center truncate cursor-pointer shadow-xs ${ev.color}`}
                            >
                              {ev.durationMinutes}m
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Detailed Downtime Log Table */}
            <FioriDataTable
              columns={downtimeColumns}
              data={filteredDowntimes}
              rowKey={ev => ev.id}
              emptyState={
                <EmptyState
                  compact
                  variant="NO_DOWNTIME"
                  actionLabel="ثبت لاگ توقف دستگاه"
                  onAction={() => setIsLogDowntimeModalOpen(true)}
                />
              }
            />
          </>
        )}
      </div>

      {/* ==================================================================== */}
      {/* SECTION 3: SCHEDULE ADHERENCE                                        */}
      {/* ==================================================================== */}
      <div className="fiori-surface-card p-4 space-y-3.5">
        <div
          onClick={toggleAdherenceSection}
          className={`flex flex-wrap items-center justify-between gap-3 cursor-pointer ${
            isAdherenceSectionOpen ? 'border-b border-[var(--fiori-border-subtle)] pb-3' : ''
          }`}
        >
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border border-[var(--fiori-brand-border)] flex items-center justify-center shrink-0">
              <BarChart3 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--fiori-text-primary)]">
                ۳. ماتریس انحراف از برنامه تولید و تطابق زمان‌بندی (Schedule Adherence & Variance Analysis)
              </h3>
              <p className="text-xs text-[var(--fiori-text-secondary)] mt-0.5 tabular-nums">
                انطباق کل:{' '}
                <strong className="font-mono text-[var(--fiori-brand)]">
                  {toPersianDigits(overallAdherencePercent)}٪
                </strong>{' '}
                · تولید سالم:{' '}
                <strong className="font-mono text-[var(--fiori-positive)]">
                  {formatNumber(totalActualPcs)}
                </strong>{' '}
                از{' '}
                <strong className="font-mono text-[var(--fiori-text-primary)]">
                  {formatNumber(totalPlannedPcs)}
                </strong>{' '}
                ·{' '}
                <span className="text-[var(--fiori-negative)]">
                  {toPersianDigits(
                    adherenceList.filter(a => a.status === 'DELAYED' || a.status === 'CRITICAL_LAG').length
                  )}{' '}
                  دستور با تأخیر
                </span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
            {isAdherenceSectionOpen && (
              <div className="relative w-64 text-xs">
                <Search className="w-3.5 h-3.5 text-[var(--fiori-text-secondary)] absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="جستجوی دستور کار یا نام قطعه..."
                  className="fiori-input w-full pr-8 pl-2.5 py-1.5"
                />
              </div>
            )}
            <button
              type="button"
              onClick={toggleAdherenceSection}
              className="sap-btn-standard px-2.5 py-1 text-xs flex items-center gap-1 cursor-pointer whitespace-nowrap"
            >
              <span>
                {isAdherenceSectionOpen
                  ? 'بستن جدول'
                  : `نمایش ماتریس (${toPersianDigits(filteredAdherence.length)} دستور)`}
              </span>
              {isAdherenceSectionOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {isAdherenceSectionOpen && (
          <FioriDataTable
            columns={adherenceColumns}
            data={filteredAdherence}
            rowKey={item => item.orderCode}
            emptyState={
              <EmptyState
                compact
                variant="SEARCH_NO_MATCH"
                actionLabel="پاک‌کردن متن جستجو"
                onAction={() => setSearchQuery('')}
              />
            }
          />
        )}
      </div>

      {/* ==================================================================== */}
      {/* MODAL: LOG NEW DOWNTIME / MAINTENANCE BREAKDOWN (FioriDialog)        */}
      {/* ==================================================================== */}
      <FioriDialog
        isOpen={isLogDowntimeModalOpen}
        onClose={() => setIsLogDowntimeModalOpen(false)}
        title="ثبت لاگ توقف دستگاه و باز-محاسبه زنده شاخص OEE"
        icon={<Clock className="w-4 h-4" />}
        tone="brand"
        size="sm"
        footer={
          <>
            <button
              type="button"
              onClick={() => setIsLogDowntimeModalOpen(false)}
              className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              form="log-downtime-form"
              className="sap-btn-emphasized px-5 py-1.5 text-xs cursor-pointer flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>ثبت توقف و باز-محاسبه OEE</span>
            </button>
          </>
        }
      >
        <form id="log-downtime-form" onSubmit={handleAddDowntimeEvent} className="space-y-3 text-xs">
          <div>
            <label className="block font-semibold text-[var(--fiori-text-primary)] mb-1">
              دستگاه و خط تولید *
            </label>
            <select
              value={newDtMachineCode}
              onChange={e => setNewDtMachineCode(e.target.value)}
              className="fiori-input w-full px-3 py-1.5 font-semibold cursor-pointer"
            >
              <option value="PRS-250T-01">پرس ۲۵۰ تن ۱ (کشش/بلنک - سالن پرس)</option>
              <option value="PRS-160T-01">پرس ۱۶۰ تن ۱ (خم/پانچ - سالن پرس)</option>
              <option value="SHR-GUI-01">قیچی گیوتین ۶ متری ۱ (سالن برش)</option>
              <option value="PRS-800T-G1">پرس هیدرولیک ۸۰۰ تن (سالن پرس سنگین)</option>
              <option value="WLD-SPOT-01">پرس‌جوش مقاومتی ۱ (مهره‌جوش M6 - سالن جوش)</option>
              <option value="WLD-CO2-ST01">کابین جوش CO2 شماره ۱ (سالن جوش)</option>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-[var(--fiori-text-primary)] mb-1">
                دسته‌بندی توقف *
              </label>
              <select
                value={newDtCategory}
                onChange={e =>
                  setNewDtCategory(
                    e.target.value as
                      | 'SETUP_CHANGE'
                      | 'UNPLANNED_BREAKDOWN'
                      | 'MINOR_STOP'
                      | 'MATERIAL_SHORTAGE'
                  )
                }
                className="fiori-input w-full px-2.5 py-1.5 font-semibold cursor-pointer"
              >
                <option value="UNPLANNED_BREAKDOWN">خرابی اضطراری (نت)</option>
                <option value="SETUP_CHANGE">تعویض قالب و ستاپ (SMED)</option>
                <option value="MINOR_STOP">توقف کوتاه / میکرو</option>
                <option value="MATERIAL_SHORTAGE">کسری ورق / مواد اولیه</option>
              </select>
            </div>
            <div>
              <label className="block font-semibold text-[var(--fiori-text-primary)] mb-1">
                مدت زمان توقف (دقیقه) *
              </label>
              <input
                type="number"
                min={1}
                max={480}
                required
                value={newDtDuration}
                onChange={e => setNewDtDuration(Number(e.target.value))}
                className="fiori-input w-full px-3 py-1.5 font-mono font-semibold text-[var(--fiori-negative)]"
              />
            </div>
          </div>

          <div>
            <label className="block font-semibold text-[var(--fiori-text-primary)] mb-1">
              ساعت شروع توقف
            </label>
            <input
              type="text"
              placeholder="مثلاً 10:30"
              value={newDtStartHour}
              onChange={e => setNewDtStartHour(e.target.value)}
              className="fiori-input w-full px-3 py-1.5 font-mono"
            />
          </div>

          <div>
            <label className="block font-semibold text-[var(--fiori-text-primary)] mb-1">
              علت توقف و ریشه‌یابی عیب *
            </label>
            <textarea
              rows={2}
              required
              placeholder="شرح خرابی، نشت روغن، شکست سنبه، عیب الکتریکی..."
              value={newDtReason}
              onChange={e => setNewDtReason(e.target.value)}
              className="fiori-input w-full px-3 py-1.5"
            />
          </div>

          <div>
            <label className="block font-semibold text-[var(--fiori-text-primary)] mb-1">
              اقدام اصلاحی و عملیات نت (PM)
            </label>
            <input
              type="text"
              placeholder="تعویض پکینگ، هواگیری، تیزکاری تیغه..."
              value={newDtAction}
              onChange={e => setNewDtAction(e.target.value)}
              className="fiori-input w-full px-3 py-1.5"
            />
          </div>

          <FioriMessageStrip tone="warning" compact>
            با فشردن دکمه ثبت، زمان توقف مستقیماً از ساعت کارکرد خالص کم شده و شاخص دسترس‌پذیری (Availability) و OEE در نمودار درختی بلافاصله باز-محاسبه می‌گردد.
          </FioriMessageStrip>
        </form>
      </FioriDialog>

      {/* ==================================================================== */}
      {/* SLIDE-OVER DRAWER: OEE TREE BRANCH DRILL-DOWN                        */}
      {/* ==================================================================== */}
      {oeeDrillDownContext && (
        <div className="fixed inset-0 z-50 overflow-hidden bg-[#1d2d3e]/40 backdrop-blur-[1px] flex justify-end no-print">
          <div className="relative w-full max-w-2xl bg-[var(--fiori-bg-surface)] h-full shadow-[var(--fiori-shadow-dialog)] flex flex-col text-right text-xs border-r border-[var(--fiori-border-default)]">
            <div className="p-4 border-b border-[var(--fiori-border-default)] bg-[var(--fiori-bg-subtle)] flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <FioriObjectStatus tone="brand" label="Drill-Down شاخه درخت OEE" />
                  <span className="font-mono font-bold text-[var(--fiori-text-primary)] text-sm tabular-nums">
                    {oeeDrillDownContext.metric}
                  </span>
                </div>
                <h3 className="font-semibold text-sm text-[var(--fiori-text-primary)] mt-1">
                  {oeeDrillDownContext.title}
                </h3>
                <p className="text-[var(--fiori-text-secondary)] text-[11px] mt-0.5">
                  {oeeDrillDownContext.description}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOeeDrillDownContext(null)}
                className="p-1.5 text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] rounded-[var(--fiori-radius-sm)] hover:bg-[var(--fiori-bg-hover)] cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-3 bg-[var(--fiori-brand-bg)] border-b border-[var(--fiori-brand-border)] text-[11px] text-[var(--fiori-text-primary)] flex items-center justify-between">
              <span>
                دسته‌بندی: <strong>{oeeDrillDownContext.categoryLabel}</strong>
              </span>
              <span className="tabular-nums">
                تعداد رویدادهای خام:{' '}
                <strong>{toPersianDigits(oeeDrillDownContext.events.length)} مورد</strong>
              </span>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
              {oeeDrillDownContext.events.length > 0 ? (
                oeeDrillDownContext.events.map(ev => (
                  <div
                    key={ev.id}
                    className="p-3 bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] space-y-1.5 hover:bg-[var(--fiori-bg-surface)] transition"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <FioriObjectStatus tone="brand" label={ev.machineCode} ltrCode />
                        <strong className="text-[var(--fiori-text-primary)] text-xs">
                          {ev.machineName}
                        </strong>
                      </div>
                      <FioriObjectStatus
                        tone="negative"
                        label={`${toPersianDigits(ev.durationMinutes)} دقیقه توقف`}
                      />
                    </div>
                    <div className="text-[11px] text-[var(--fiori-text-primary)] leading-snug">
                      <span className="text-[var(--fiori-text-secondary)] font-semibold">
                        علت خرابی:{' '}
                      </span>
                      {ev.reason}
                    </div>
                    <div className="text-[11px] text-[var(--fiori-positive)] leading-snug">
                      <span className="font-semibold">اقدام اصلاحی نت: </span>
                      {ev.actionTaken}
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-[var(--fiori-text-secondary)] font-mono pt-1 border-t border-[var(--fiori-border-subtle)]">
                      <span>سالن: {ev.hall}</span>
                      <span>شروع: {ev.startHour}</span>
                      <button
                        type="button"
                        onClick={() => handleDeleteDowntimeEvent(ev.id)}
                        className="text-[var(--fiori-negative)] hover:underline flex items-center gap-0.5 cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>حذف رویداد</span>
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <EmptyState
                  compact
                  variant="NO_DOWNTIME"
                  actionLabel="ثبت لاگ توقف جدید"
                  onAction={() => {
                    setOeeDrillDownContext(null);
                    setIsLogDowntimeModalOpen(true);
                  }}
                />
              )}
            </div>

            <div className="p-3 border-t border-[var(--fiori-border-default)] bg-[var(--fiori-bg-subtle)] flex justify-between items-center">
              <button
                type="button"
                onClick={() => {
                  setOeeDrillDownContext(null);
                  setIsLogDowntimeModalOpen(true);
                }}
                className="sap-btn-emphasized px-3.5 py-1.5 flex items-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>ثبت لاگ توقف جدید</span>
              </button>
              <button
                type="button"
                onClick={() => setOeeDrillDownContext(null)}
                className="sap-btn-standard px-4 py-1.5 cursor-pointer"
              >
                بستن
              </button>
            </div>
          </div>
        </div>
      )}
    </FioriDynamicPage>
  );
};
