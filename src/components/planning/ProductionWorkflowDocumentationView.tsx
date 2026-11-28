import React, { useState, useMemo } from 'react';
import {
  GitBranch,
  Layers,
  CheckCircle2,
  Printer,
  ShieldCheck,
  Database,
  ExternalLink,
} from 'lucide-react';
import { useErpRouter, RouteNavigateParams } from '../../context/RouterContext';
import {
  FioriDynamicPage,
  FioriDataTable,
  FioriTableColumn,
  FioriToolbar,
  FioriObjectStatus,
} from '../fiori/ui';

interface SapPpMappingRow {
  step: string;
  operationTitle: string;
  tcode: string;
  kpimsEquivalent: string;
  dbEntities: string;
  linkLabel: string;
  navParams: RouteNavigateParams;
}

const SAP_PP_MAPPING_ROWS: SapPpMappingRow[] = [
  {
    step: '۰۱',
    operationTitle: 'دریافت و تحلیل تقاضای ساپکو',
    tcode: 'VA01 / MD61 (PIR)',
    kpimsEquivalent: 'ماژول ثبت سفارش مشتری و پیش‌بینی تقاضای ساپکو بر اساس کد قرارداد',
    dbEntities: 'CustomerOrder (SO-1404-...)',
    linkLabel: 'قراردادها ←',
    navParams: { tab: 'contracts' },
  },
  {
    step: '۰۲',
    operationTitle: 'انفجار درخت محصول (BOM)',
    tcode: 'CS01 / CS03 (BOM Explosion)',
    kpimsEquivalent: 'ساختار سلسله‌مراتبی بازگشتی (Recursive Tree) قطعات اصلی و زیرمجموعه‌ها',
    dbEntities: 'ProductStructure / BOM Nodes',
    linkLabel: 'درخت BOM ←',
    navParams: { tab: 'master_data', masterSubSection: 'BOM' },
  },
  {
    step: '۰۳',
    operationTitle: 'محاسبه نیاز خالص مواد (MRP)',
    tcode: 'MD01N / MD04 (Stock/Req)',
    kpimsEquivalent: 'موازنه موجودی فیزیکی و امانی رول ورق و پیش‌بینی کسری بر حسب کیلوگرم',
    dbEntities: 'NetRequirements / PlannedOrder',
    linkLabel: 'موتور MRP ←',
    navParams: { tab: 'planning', planningSubTab: 'mrp' },
  },
  {
    step: '۰۴',
    operationTitle: 'زمان‌بندی پله‌ای عملیات (Routing)',
    tcode: 'CA01 / CM01 (Capacity CRP)',
    kpimsEquivalent: 'ماتریس زمان‌بندی روزهای مختلف هر OP (برش، بلنک، خم، جوش) و قالب‌های مشترک',
    dbEntities: 'ScheduledOpStep (OP10..OP50)',
    linkLabel: 'گانت ظرفیت ←',
    navParams: { tab: 'planning', planningSubTab: 'capacity_planning' },
  },
  {
    step: '۰۵',
    operationTitle: 'صدور حواله ورق به خط تولید',
    tcode: 'MIGO 261 (Goods Issue)',
    kpimsEquivalent: 'تخصیص کلاف ورق از انبار به مرحله اول (OP10) همراه با ثبت وزن و لات‌نامبر',
    dbEntities: 'ISSUE_RAW_MATERIAL',
    linkLabel: 'انبار رول ←',
    navParams: { tab: 'inventory', inventorySubTab: 'COILS' },
  },
  {
    step: '۰۶',
    operationTitle: 'ثبت کارکرد خط و رهگیری WIP',
    tcode: 'CO11N (Order Confirmation)',
    kpimsEquivalent: 'محاسبه برخط بافر بین مراحل، انتقال مانده کار روزانه به روز بعد (Roll-Forward)',
    dbEntities: 'wipBufferAfterOp / ROLLED_FORWARD',
    linkLabel: 'رهگیری WIP ←',
    navParams: { tab: 'wip', wipSubTab: 'ORDERS' },
  },
  {
    step: '۰۷',
    operationTitle: 'رسید خودکار انبار محصول نهایی',
    tcode: 'MIGO 101 (Auto Goods Receipt)',
    kpimsEquivalent: 'با تکمیل آخرین مرحله (Final OP)، سند رسید انبار به صورت اتوماتیک صادر می‌شود',
    dbEntities: 'RECEIPT_FINISHED_GOODS (RCV-FG-...)',
    linkLabel: 'اسناد انبار ←',
    navParams: { tab: 'inventory', inventorySubTab: 'MOVEMENT' },
  },
];

export const ProductionWorkflowDocumentationView: React.FC = () => {
  const { navigate } = useErpRouter();
  const [selectedPhaseId, setSelectedPhaseId] = useState<string>('PHASE-BOM');
  const [activeStandardTab, setActiveStandardTab] = useState<
    'WORKFLOW' | 'SAP_PP_COMPARISON' | 'DOCUMENTATION_SPEC'
  >('WORKFLOW');

  // -------------------------------------------------------------
  // Workflow Steps (Global Standard: SAP PP / APICS CPIM / IATF 16949)
  // -------------------------------------------------------------
  const workflowPhases = [
    {
      id: 'PHASE-ORDER',
      stepNumber: '۰۱',
      code: 'SO / FORECAST',
      title: '۱. دریافت سفارش، پیش‌بینی تقاضا و قراردادها',
      sapEquivalent: 'Sales & Operations Planning (S&OP) / VA01 Customer Order',
      actor: 'واحد فروش و امور قراردادهای ساپکو / ایران‌خودرو',
      inputs: 'برنامه ماهانه ارسالی ساپکو (EDI/SAPCO Web)، قراردادهای باز، سفارشات متفرقه قطعات یدکی (ایساکو)',
      processDescription:
        'ثبت و صحه‌گذاری تقاضای قطعات خودرویی در بازه‌های هفتگی و روزانه. بررسی اعتبارات مالی، شماره قرارداد مرتبط و تعیین تاریخ تحویل تعهدشده (Confirmed Due Date).',
      outputs: 'سفارش مشتری تاییدشده (Customer Order / Demand Schedule)',
      kpi: 'دقت پیش‌بینی تقاضا (Forecast Accuracy > 95%)، درصد سفارشات ثبت‌شده به موقع',
      navLabel: 'باز کردن سفارشات و قراردادهای ساپکو',
      navParams: { tab: 'contracts' } as RouteNavigateParams,
    },
    {
      id: 'PHASE-BOM',
      stepNumber: '۰۲',
      code: 'BOM EXPLOSION & MRP',
      title: '۲. انفجار مواد درختی (BOM Explosion) و نیازسنجی خالص (MRP)',
      sapEquivalent: 'CS01 Bill of Material / MD01 MRP Run (Gross-to-Net Explosion)',
      actor: 'واحد مهندسی صنایع، برنامه‌ریزی تولید (PPC) و کنترل موجودی',
      inputs: 'درخت سلسله‌مراتبی محصول (BOM)، ضرایب مصرف ورق به کیلوگرم، پرتی مجاز، موجودی فیزیکی و امانی انبار',
      processDescription:
        'شکستن قطعات نهایی (مانند براکت ضدسرقت موتور) به زیرمجموعه‌ها (صفحه اصلی و مکمل) و محاسبه نیاز خالص رول ورق (DC01A ضخامت ۲ عرض ۱۱۴۰) با کسر موجودی آزاد انبار و کلاف‌های در راه (Scheduled Receipts).',
      outputs: 'پیشنهادات برنامه تولید (Planned Orders) و درخواست خرید/تخصیص ورق (Purchase Requisition)',
      kpi: 'نرخ پرتی مجاز مهندسی (Scrap Allowance < 2%)، تراز دقیق متریال بدون کسری خط',
      navLabel: 'اجرای MRP و بررسی BOM',
      navParams: { tab: 'planning', planningSubTab: 'mrp' } as RouteNavigateParams,
    },
    {
      id: 'PHASE-ROUTING',
      stepNumber: '۰۳',
      code: 'CRP & SCHEDULING',
      title: '۳. زمان‌بندی پله‌ای عملیات (Routing) و سنجش ظرفیت ماشین‌آلات (CRP)',
      sapEquivalent: 'CA01 Routing / CM01 Capacity Requirements Planning / Opcenter APS',
      actor: 'کارشناس ارشد برنامه‌ریزی و سرپرستان سالن‌های تولید',
      inputs: 'مسیر ساخت قطعه (Routing OPs: برش، بلنک، خم، پانچ، جوشکاری، رنگ کاتافورز ED)، نرخ استاندارد ضرب در ساعت، ماتریس تعویض قالب',
      processDescription:
        'زمان‌بندی دقیق هر مرحله کاری (OP10 تا OP50) روی پرس‌های ۱۶۰، ۲۵۰ و ۴۰۰ تن. امکان اجرای چند مرحله امروز و مراحل تکمیلی در روزهای آتی. تولید همزمان قالب‌های مشترک چپ و راست (Seat Back LH/RH).',
      outputs: 'دستور کار کارگاهی مصوب (Manufacturing Order - MO) و برگه توزیع کار روزانه خط (Dispatch Sheet)',
      kpi: 'نرخ بهره‌برداری ظرفیت (Capacity Utilization > 85%)، انطباق با برنامه (Adherence)',
      navLabel: 'تایید پیشنهاد برنامه و گانت ظرفیت',
      navParams: { tab: 'planning', planningSubTab: 'recommendations' } as RouteNavigateParams,
    },
    {
      id: 'PHASE-DISPATCH',
      stepNumber: '۰۴',
      code: 'MATERIAL ISSUE & START',
      title: '۴. حواله مواد اولیه از انبار و شروع فرآیند برش و پرسکاری',
      sapEquivalent: 'MIGO 261 (Goods Issue for Order) / CO02 MO Release',
      actor: 'انباردار مواد اولیه، راننده لیفتراک و اپراتور ایستگاه اول (OP10)',
      inputs: 'دستور کار کارگاهی (MO)، رول کلاف تخصیص‌یافته با پلاک شناسایی و لات‌نامبر ساپکو',
      processDescription:
        'تحویل رول ورق استاندارد از انبار مواد به پای قیچی گیوتین ۶ متری (OP10). ثبت اتوماتیک سند خروج ورق (`ISSUE_RAW_MATERIAL`) و اختصاص متریال به بچ تولید جهت ردیابی کامل کیفیت (Traceability).',
      outputs: 'نوارها و شیت‌های برش‌خورده اولیه آماده ورود به ایستگاه بلنک‌زنی',
      kpi: 'زمان تحویل کلاف به خط (Lead Time < 15 min)، مغایرت صفر در وزن تحویلی',
      navLabel: 'ثبت حواله رول ورق و کلاف‌ها',
      navParams: { tab: 'inventory', inventorySubTab: 'COILS' } as RouteNavigateParams,
    },
    {
      id: 'PHASE-WIP',
      stepNumber: '۰۵',
      code: 'SHOP-FLOOR MES & WIP',
      title: '۵. رهگیری کار در جریان (WIP per OP)، ثبت تولید و انتقال مانده (Roll-Forward)',
      sapEquivalent: 'CO11N Production Order Confirmation / MES Execution',
      actor: 'اپراتورهای دستگاه، بازرسان کنترل کیفیت حین تولید (QC IPQC) و سرپرست شیفت',
      inputs: 'قطعات نیمه‌ساخته بین ایستگاهی، لاگ تولید ضربی، فرم‌های توقفات اضطراری و ستاپ قالب',
      processDescription:
        'ردیابی برخط تعداد قطعات سالم، ضایعات و موجودی نیمه‌ساخته در هر عملیات (WIP Buffer After OP). در صورت عدم تحقق تیراژ روزانه، محاسبه مانده کار و انتقال اتوماتیک آن به برنامه روز بعد (Roll-Forward).',
      outputs: 'کارت‌های ردیابی نیمه‌ساخته (WIP Cards)، داده‌های محاسبه OEE و لاگ تعمیرات اضطراری PM',
      kpi: 'شاخص OEE بالای ۷۰٪، نرخ ضایعات زیر ۱.۸٪، میانگین زمان توقف تعویض قالب زیر ۳۵ دقیقه',
      navLabel: 'کارتابل دستور کار و رهگیری WIP',
      navParams: { tab: 'wip', wipSubTab: 'ORDERS' } as RouteNavigateParams,
    },
    {
      id: 'PHASE-FINAL',
      stepNumber: '۰۶',
      code: 'FINAL QC & WAREHOUSE RECEIPT',
      title: '۶. کنترل کیفیت نهایی، صدور خودکار رسید انبار محصول و بسته‌بندی',
      sapEquivalent: 'MIGO 101 (Goods Receipt for Order) / QA32 Inspection Lot Completion',
      actor: 'مهندس کنترل کیفیت نهایی (OQC)، انباردار محصولات نهایی و ترابری',
      inputs: 'قطعات خروجی از مرحله آخر مسیر تولید (Final OP: پوشش رنگ ED یا بسته‌بندی پالت ساپکو)',
      processDescription:
        'با تایید تکمیل مرحله آخر، سیستم به صورت خودکار سند رسمی رسید انبار محصول (`RECEIPT_FINISHED_GOODS`) را با شماره پیگیری یکتا صادر، بارکد پالت را چاپ و موجودی انبار محصول نهایی (`WH-FINISHED`) را افزایش می‌دهد.',
      outputs: 'محصول نهایی آماده تحویل، پالت لیبل‌خورده ساپکو و سند قطعی رسید انبار',
      kpi: 'تحویل به موقع به خودروساز (OTIF > 98%)، رسید ۱۰۰٪ اتوماتیک بدون نیاز به ثبت دستی مجدد',
      navLabel: 'کارتابل کنترل کیفیت و رسید محصول',
      navParams: { tab: 'inventory', inventorySubTab: 'QUALITY_QM' } as RouteNavigateParams,
    },
  ];

  const selectedPhase = workflowPhases.find(p => p.id === selectedPhaseId) || workflowPhases[1];

  const comparisonColumns = useMemo<FioriTableColumn<SapPpMappingRow>[]>(
    () => [
      {
        key: 'step',
        header: 'گام فرآیند',
        isMono: true,
        cellClassName: 'font-semibold',
        render: r => r.step,
      },
      {
        key: 'operationTitle',
        header: 'عنوان عملیات در صنعت',
        cellClassName: 'font-semibold text-[var(--fiori-text-primary)]',
        render: r => r.operationTitle,
      },
      {
        key: 'tcode',
        header: 'کد ترانزکشن در SAP PP',
        isMono: true,
        isLtrCode: true,
        cellClassName: 'text-[var(--fiori-brand)] font-semibold',
        render: r => r.tcode,
      },
      {
        key: 'kpimsEquivalent',
        header: 'عملکرد معادل در سیستم کوثر',
        render: r => r.kpimsEquivalent,
      },
      {
        key: 'dbEntities',
        header: 'اسناد و کدهای پایگاه داده',
        isMono: true,
        isLtrCode: true,
        cellClassName: 'text-[11px] text-[var(--fiori-text-secondary)]',
        render: r => r.dbEntities,
      },
      {
        key: 'link',
        header: 'لینک مستقیم',
        align: 'center',
        render: r => (
          <button
            type="button"
            onClick={() => navigate(r.navParams)}
            className="sap-doc-link text-[11px] cursor-pointer"
          >
            {r.linkLabel}
          </button>
        ),
      },
    ],
    [navigate]
  );

  // Print Isolated Architecture Documentation (A4 Portrait)
  const handlePrintDoc = () => {
    const existing = document.getElementById('workflow-doc-print-frame') as HTMLIFrameElement | null;
    if (existing) existing.remove();

    const iframe = document.createElement('iframe');
    iframe.id = 'workflow-doc-print-frame';
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow?.document;
    if (!doc) return;

    const phasesHtml = workflowPhases
      .map(
        p => `
      <div style="border: 1px solid #333; border-radius: 6px; padding: 10px; margin-bottom: 10px; page-break-inside: avoid;">
        <div style="display: flex; justify-content: space-between; border-bottom: 1px solid #ccc; padding-bottom: 4px; margin-bottom: 6px;">
          <strong style="font-size: 13px;">${p.title}</strong>
          <span style="font-family: monospace; font-size: 11px; color: #1e3a8a;">[${p.sapEquivalent}]</span>
        </div>
        <div style="font-size: 11px; margin-bottom: 4px;"><strong>مسئول و متولی:</strong> ${p.actor}</div>
        <div style="font-size: 11px; margin-bottom: 4px;"><strong>ورودی‌ها (Inputs):</strong> ${p.inputs}</div>
        <div style="font-size: 11px; margin-bottom: 4px;"><strong>شرح فرآیند استاندارد:</strong> ${p.processDescription}</div>
        <div style="font-size: 11px; margin-bottom: 4px;"><strong>خروجی‌ها (Outputs):</strong> ${p.outputs}</div>
        <div style="font-size: 11px; color: #047857;"><strong>شاخص‌های کلیدی عملکرد (KPIs):</strong> ${p.kpi}</div>
      </div>
    `
      )
      .join('');

    doc.open();
    doc.write(`
      <!DOCTYPE html>
      <html lang="fa" dir="rtl">
      <head>
        <meta charset="UTF-8" />
        <title>مستند فنی و نمودار جریان کار سیستم برنامه‌ریزی تولید (استاندارد SAP PP)</title>
        <style>
          body { font-family: Tahoma, Arial, sans-serif; padding: 16px; color: #111; direction: rtl; }
          .header { border: 2px solid #111; padding: 12px; border-radius: 8px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; }
          h1 { margin: 0 0 6px 0; font-size: 15px; }
          @media print { @page { size: A4 portrait; margin: 10mm; } }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <h1>مستند معماری و جریان فرآیندی برنامه‌ریزی و کنترل تولید قطعات خودرویی (استاندارد SAP PP / MES)</h1>
            <div>شرکت قطعات محوری کوثر — مدیریت سیستم‌ها، برنامه‌ریزی تولید و مهندسی صنایع</div>
          </div>
          <div style="text-align: left; font-size: 11px;">
            <div><strong>کد سند:</strong> SOP-PPC-SAP-001</div>
            <div><strong>استاندارد انطباق:</strong> IATF 16949 / SAP PP-MRP</div>
            <div><strong>ویرایش:</strong> بهار ۱۴۰۴</div>
          </div>
        </div>
        ${phasesHtml}
      </body>
      </html>
    `);
    doc.close();

    setTimeout(() => {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    }, 300);
  };

  return (
    <FioriDynamicPage
      title="مستند فنی و نمودار جریان کار (Workflow) سیستم برنامه‌ریزی تولید بر اساس استانداردهای جهانی (SAP PP / MES)"
      subtitle="توصیف چرخه کامل بسته تولید در صنایع قطعه‌سازی خودرو: از دریافت سفارش مشتری ← انفجار مواد درختی (BOM) ← زمان‌بندی پله‌ای عملیات (Routing) ← رهگیری برخط موجودی نیمه‌ساخته (WIP) ← صدور خودکار رسید محصول نهایی در انبار."
      status={
        <FioriObjectStatus
          tone="info"
          label="انطباق کامل با الگوهای SAP PP، Odoo MRP و IATF 16949"
        />
      }
      collapsibleFilters={false}
      headerActions={
        <button
          type="button"
          onClick={handlePrintDoc}
          className="sap-btn-emphasized flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
        >
          <Printer className="w-3.5 h-3.5" />
          <span>چاپ رسمی مستند فنی (A4)</span>
        </button>
      }
      filterBar={
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
          {[
            { id: 'WORKFLOW' as const, label: '۱. دیاگرام تعاملی ۶ مرحله‌ای جریان کار (Interactive Flow)' },
            { id: 'SAP_PP_COMPARISON' as const, label: '۲. جدول تطبیقی با استاندارد و کدهای ترانزکشن SAP PP' },
            { id: 'DOCUMENTATION_SPEC' as const, label: '۳. شرح استاندارد عملیاتی (SOP) و چک‌لیست فرآیندی' },
          ].map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveStandardTab(tab.id)}
              className={`p-2.5 rounded-[var(--fiori-radius-sm)] border text-center font-semibold transition cursor-pointer ${
                activeStandardTab === tab.id
                  ? 'bg-[var(--fiori-brand)] text-white border-[var(--fiori-brand)]'
                  : 'bg-[var(--fiori-bg-surface)] text-[var(--fiori-text-primary)] border-[var(--fiori-border-default)] hover:bg-[var(--fiori-bg-hover)]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      }
    >
      {/* TAB 1: INTERACTIVE 6-STEP WORKFLOW DIAGRAM */}
      {activeStandardTab === 'WORKFLOW' && (
        <div className="space-y-4">
          <div className="fiori-surface-card p-4 space-y-3">
            <FioriToolbar
              variant="section"
              title="دیاگرام جریان داده و اسناد در زنجیره بسته برنامه‌ریزی و اجرای تولید"
              startContent={<Layers className="w-4 h-4 text-[var(--fiori-brand)] shrink-0" />}
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2.5 items-stretch">
              {workflowPhases.map(phase => {
                const isSelected = selectedPhaseId === phase.id;
                return (
                  <button
                    key={phase.id}
                    type="button"
                    onClick={() => setSelectedPhaseId(phase.id)}
                    className={`p-3 rounded-[var(--fiori-radius-sm)] border text-right transition-all flex flex-col justify-between cursor-pointer ${
                      isSelected
                        ? 'bg-[var(--fiori-brand-bg)] text-[var(--fiori-text-primary)] border-[var(--fiori-brand)] ring-1 ring-[var(--fiori-brand)]'
                        : 'bg-[var(--fiori-bg-subtle)] hover:bg-[var(--fiori-bg-hover)] text-[var(--fiori-text-primary)] border-[var(--fiori-border-default)]'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span
                          className={`font-mono font-semibold text-xs px-1.5 py-0.5 rounded-[var(--fiori-radius-sm)] ${
                            isSelected
                              ? 'bg-[var(--fiori-brand)] text-white'
                              : 'bg-[var(--fiori-neutral-bg)] text-[var(--fiori-text-primary)]'
                          }`}
                        >
                          گام {phase.stepNumber}
                        </span>
                        <span className="text-[10px] font-mono fiori-ltr-code text-[var(--fiori-text-secondary)]">
                          {phase.code}
                        </span>
                      </div>
                      <div className="font-semibold text-xs leading-snug">{phase.title}</div>
                    </div>

                    <div className="mt-3 pt-2 border-t border-[var(--fiori-border-subtle)] text-[10px] text-[var(--fiori-text-secondary)] font-mono">
                      {phase.sapEquivalent.split('/')[0]}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Deep-Dive Inspection Card */}
          <div className="fiori-surface-card p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--fiori-border-subtle)] pb-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <FioriObjectStatus
                    tone="brand"
                    label={`گام ${selectedPhase.stepNumber} • ${selectedPhase.code}`}
                  />
                  <h3 className="text-base font-semibold text-[var(--fiori-text-primary)]">
                    {selectedPhase.title}
                  </h3>
                </div>
                <div className="text-xs font-mono text-[var(--fiori-brand)] font-semibold mt-1">
                  معادل استاندارد در SAP:{' '}
                  <span className="fiori-ltr-code">{selectedPhase.sapEquivalent}</span>
                </div>
              </div>

              <div className="text-xs text-[var(--fiori-text-primary)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] px-3 py-1.5 rounded-[var(--fiori-radius-sm)]">
                <strong>واحد سازمانی مجری:</strong> {selectedPhase.actor}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div className="p-3.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-info-border)] bg-[var(--fiori-info-bg)]/60 space-y-1.5">
                <span className="font-semibold text-[var(--fiori-brand)] flex items-center gap-1.5">
                  <Database className="w-4 h-4 text-[var(--fiori-brand)]" />
                  <span>ورودی‌های فرآیند (Process Inputs):</span>
                </span>
                <p className="text-[var(--fiori-text-primary)] leading-relaxed">
                  {selectedPhase.inputs}
                </p>
              </div>

              <div className="p-3.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-positive-border)] bg-[var(--fiori-positive-bg)]/70 space-y-1.5">
                <span className="font-semibold text-[var(--fiori-positive)] flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-[var(--fiori-positive)]" />
                  <span>خروجی‌های فرآیند (Process Deliverables / Outputs):</span>
                </span>
                <p className="text-[var(--fiori-text-primary)] leading-relaxed">
                  {selectedPhase.outputs}
                </p>
              </div>
            </div>

            <div className="p-3.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] bg-[var(--fiori-bg-subtle)] space-y-1.5 text-xs">
              <span className="font-semibold text-[var(--fiori-text-primary)] block">
                شرح تفصیلی عملیات و منطق محاسباتی:
              </span>
              <p className="text-[var(--fiori-text-primary)] leading-relaxed text-sm">
                {selectedPhase.processDescription}
              </p>
            </div>

            <div className="p-3 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-critical-border)] bg-[var(--fiori-critical-bg)] flex items-center justify-between text-xs text-[var(--fiori-text-primary)] flex-wrap gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-[var(--fiori-critical)] flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-[var(--fiori-critical)]" />
                  <span>شاخص‌های کلیدی عملکرد این گام (KPIs):</span>
                </span>
                <span className="font-mono font-semibold text-[var(--fiori-text-primary)]">
                  {selectedPhase.kpi}
                </span>
              </div>
              <button
                type="button"
                onClick={() => navigate(selectedPhase.navParams)}
                className="sap-btn-emphasized px-3 py-1.5 text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
              >
                <span>{selectedPhase.navLabel}</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: SAP PP / ERP TRANSFORMATION COMPARISON TABLE */}
      {activeStandardTab === 'SAP_PP_COMPARISON' && (
        <FioriDataTable
          toolbar={
            <FioriToolbar
              variant="table"
              title="جدول تطبیقی فرآیندهای برنامه‌ریزی تولید کوثر با کدهای ترانزکشن و استانداردهای SAP S/4HANA PP"
              subtitle="نگاشت دقیق اجزای نرم‌افزار به ماژول‌های Production Planning (PP)، Material Requirements Planning (MRP) و Shop Floor Control (SFC)"
              count={SAP_PP_MAPPING_ROWS.length}
              countLabel="گام"
              startContent={<GitBranch className="w-4 h-4 text-[var(--fiori-brand)] shrink-0" />}
            />
          }
          columns={comparisonColumns}
          data={SAP_PP_MAPPING_ROWS}
          rowKey={r => r.step}
        />
      )}

      {/* TAB 3: STANDARD OPERATING PROCEDURE (SOP) & CHECKLIST */}
      {activeStandardTab === 'DOCUMENTATION_SPEC' && (
        <div className="fiori-surface-card p-5 space-y-4 text-xs">
          <FioriToolbar
            variant="section"
            title="دستورالعمل استاندارد کاری (Standard Operating Procedure - SOP): مدیریت فرآیند برنامه‌ریزی و اجرای تولید"
            subtitle="چک‌لیست الزامی تضمین کیفیت IATF 16949 جهت جلوگیری از ایجاد گلوگاه‌های خط و کاهش پرتی مواد اولیه"
          />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 leading-relaxed text-[var(--fiori-text-primary)]">
            <div className="p-4 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] bg-[var(--fiori-bg-subtle)] space-y-2">
              <span className="font-semibold text-[var(--fiori-text-primary)] block text-sm">
                ۱. قوانین انفجار مواد (BOM) و موازنه کلاف ساپکو:
              </span>
              <ul className="list-disc list-inside space-y-1 text-[var(--fiori-text-secondary)]">
                <li>ثبت ضریب مصرف استاندارد قطعه بر حسب کیلوگرم به ازای هر ضرب با در نظر گرفتن پرتی اسکلت بلنک.</li>
                <li>تطابق گرید متریال (DC01A, DC04, ST12, ST37) با شناسنامه فنی نقشه ساپکو.</li>
                <li>اولویت تخصیص کلاف‌های امانی با موعد سررسید قرارداد نزدیک‌تر جهت جلوگیری از دیرکرد سهمیه.</li>
                <li>بررسی ضخامت و عرض استاندارد ورق قبل از صدور دستور برش در گیوتین.</li>
              </ul>
            </div>

            <div className="p-4 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] bg-[var(--fiori-bg-subtle)] space-y-2">
              <span className="font-semibold text-[var(--fiori-text-primary)] block text-sm">
                ۲. قوانین زمان‌بندی عملیات و مانده کار (Roll-Forward):
              </span>
              <ul className="list-disc list-inside space-y-1 text-[var(--fiori-text-secondary)]">
                <li>عدم زمان‌بندی مرحله بعدی قبل از تکمیل تیراژ بافر حداقل در مرحله قبلی (Buffer Min Limit).</li>
                <li>در صورت توقف اضطراری بیش از ۶۰ دقیقه، انتقال خودکار باقیمانده کار به شیفت یا روز بعدی.</li>
                <li>تطابق برنامه روزانه خط با تقویم سرویس و نگهداری پیشگیرانه (PM) ماشین‌آلات.</li>
                <li>ثبت همزمان تولید قطعات چپ و راست در قالب‌های مشترک دوتایی (Dual-Cavity Molds).</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </FioriDynamicPage>
  );
};
