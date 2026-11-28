import React, { Suspense, useMemo, useState } from 'react';
import {
  ArrowRight,
  Map,
  ChevronLeft,
  Layers,
  ClipboardList,
  PackageOpen,
  Factory,
  Warehouse,
  Link2,
  Check,
  HelpCircle,
  Workflow,
  ListTree,
  Disc,
  GitBranch,
  Cpu,
  FileText,
  Wrench,
  Compass,
} from 'lucide-react';
import { useErpRouter, RouteNavigateParams, RouteState } from '../../context/RouterContext';
import { TabKey } from '../Sidebar';
import { resolvePageTrainingEntry } from '../../data/pageTrainingCatalog';
import { toPersianDigits } from '../../utils/formatters';
import type { ActivePageGuideContext, GuideDrawerSectionTab } from './PageGuideSystem';

const LazyPageGuideDrawer = React.lazy(() =>
  import('./PageGuideDrawer').then(mod => ({ default: mod.PageGuideDrawer })),
);

interface LifecycleStageDef {
  step: string;
  title: string;
  subtitle: string;
  tab: TabKey;
  subParams: Record<string, any>;
  isActive: (route: RouteState) => boolean;
  icon: React.ReactNode;
}

interface RelatedFioriLink {
  label: string;
  icon: React.ReactNode;
  params: RouteNavigateParams;
  title?: string;
}

function getContextualRelatedLinks(route: RouteState): RelatedFioriLink[] {
  if (route.tab === 'master_data') {
    const links: RelatedFioriLink[] = [
      {
        label: 'مشاهده دستورات ساخت مرتبط (MO)',
        icon: <ClipboardList className="w-3.5 h-3.5 text-[#007cc0]" />,
        params: {
          tab: 'production',
          productionViewMode: 'ERP_WORKBENCH',
          productionModuleTab: 'MANUFACTURING_ORDERS_LIST',
          docQuery: route.docQuery || null,
        },
        title: 'رفتن به فهرست دستورات ساخت (PP)',
      },
      route.masterSubSection === 'BOM'
        ? {
            label: 'مسیرهای تولید (Routings)',
            icon: <Workflow className="w-3.5 h-3.5 text-[#007cc0]" />,
            params: { tab: 'master_data', masterSubSection: 'ROUTINGS' },
          }
        : {
            label: 'درخت محصول (BOM)',
            icon: <ListTree className="w-3.5 h-3.5 text-[#007cc0]" />,
            params: { tab: 'master_data', masterSubSection: 'BOM' },
          },
      {
        label: 'موجودی انبار و رول‌ها (MM)',
        icon: <Warehouse className="w-3.5 h-3.5 text-[#107e3e]" />,
        params: { tab: 'inventory', inventorySubTab: 'INQUIRY' },
      },
      {
        label: 'کارتابل جریان ساخت (WIP)',
        icon: <GitBranch className="w-3.5 h-3.5 text-[#007cc0]" />,
        params: { tab: 'wip', wipSubTab: 'ORDERS' },
      },
      {
        label: 'نیازسنجی و صدور MO (MRP)',
        icon: <Cpu className="w-3.5 h-3.5 text-[#e9730c]" />,
        params: { tab: 'planning', planningSubTab: 'mrp' },
      },
    ];
    return links;
  }

  if (route.tab === 'inventory') {
    return [
      {
        label: 'مشاهده دستورات ساخت مرتبط (MO)',
        icon: <ClipboardList className="w-3.5 h-3.5 text-[#007cc0]" />,
        params: {
          tab: 'production',
          productionViewMode: 'ERP_WORKBENCH',
          productionModuleTab: 'MANUFACTURING_ORDERS_LIST',
          docQuery: route.docQuery || null,
        },
        title: 'مشاهده و رهگیری دستورات ساخت (PP)',
      },
      {
        label: 'کارتابل جریان ساخت (WIP)',
        icon: <GitBranch className="w-3.5 h-3.5 text-[#007cc0]" />,
        params: { tab: 'wip', wipSubTab: 'ORDERS' },
      },
      {
        label: 'درخت محصول (BOM)',
        icon: <ListTree className="w-3.5 h-3.5 text-[#007cc0]" />,
        params: { tab: 'master_data', masterSubSection: 'BOM' },
      },
      {
        label: 'پیشنهاد برنامه و صدور MO (MRP)',
        icon: <Cpu className="w-3.5 h-3.5 text-[#107e3e]" />,
        params: { tab: 'planning', planningSubTab: 'recommendations' },
      },
    ];
  }

  if (route.tab === 'production') {
    return [
      {
        label: 'رول‌ها و سرکلاف انبار (MM)',
        icon: <Disc className="w-3.5 h-3.5 text-[#007cc0]" />,
        params: { tab: 'inventory', inventorySubTab: 'COILS' },
      },
      {
        label: 'اسناد و حواله‌های انبار (MIGO)',
        icon: <FileText className="w-3.5 h-3.5 text-[#107e3e]" />,
        params: { tab: 'inventory', inventorySubTab: 'MOVEMENT' },
      },
      {
        label: 'درخت محصول (BOM)',
        icon: <ListTree className="w-3.5 h-3.5 text-[#007cc0]" />,
        params: { tab: 'master_data', masterSubSection: 'BOM' },
      },
      {
        label: 'کارتابل جریان ساخت (WIP)',
        icon: <GitBranch className="w-3.5 h-3.5 text-[#007cc0]" />,
        params: { tab: 'wip', wipSubTab: 'ORDERS' },
      },
      {
        label: 'نیازسنجی و صدور MO (MRP)',
        icon: <Cpu className="w-3.5 h-3.5 text-[#e9730c]" />,
        params: { tab: 'planning', planningSubTab: 'recommendations' },
      },
    ];
  }

  if (route.tab === 'wip') {
    return [
      {
        label: 'مدیریت دستورات ساخت (PP)',
        icon: <ClipboardList className="w-3.5 h-3.5 text-[#007cc0]" />,
        params: {
          tab: 'production',
          productionViewMode: 'ERP_WORKBENCH',
          productionModuleTab: 'MANUFACTURING_ORDERS_LIST',
        },
      },
      {
        label: 'رول‌ها و سرکلاف انبار (MM)',
        icon: <Disc className="w-3.5 h-3.5 text-[#007cc0]" />,
        params: { tab: 'inventory', inventorySubTab: 'COILS' },
      },
      {
        label: 'اسناد انبار (MIGO)',
        icon: <FileText className="w-3.5 h-3.5 text-[#107e3e]" />,
        params: { tab: 'inventory', inventorySubTab: 'MOVEMENT' },
      },
      {
        label: 'درخت محصول و مسیر (BOM)',
        icon: <ListTree className="w-3.5 h-3.5 text-[#007cc0]" />,
        params: { tab: 'master_data', masterSubSection: 'BOM' },
      },
    ];
  }

  if (route.tab === 'planning') {
    return [
      {
        label: 'مشاهده دستورات ساخت (MO)',
        icon: <ClipboardList className="w-3.5 h-3.5 text-[#007cc0]" />,
        params: {
          tab: 'production',
          productionViewMode: 'ERP_WORKBENCH',
          productionModuleTab: 'MANUFACTURING_ORDERS_LIST',
        },
      },
      {
        label: 'موجودی انبار و کسری‌ها (MM)',
        icon: <Warehouse className="w-3.5 h-3.5 text-[#107e3e]" />,
        params: { tab: 'inventory', inventorySubTab: 'ALERTS' },
      },
      {
        label: 'درخت محصول (BOM)',
        icon: <ListTree className="w-3.5 h-3.5 text-[#007cc0]" />,
        params: { tab: 'master_data', masterSubSection: 'BOM' },
      },
      {
        label: 'ماشین‌آلات و ظرفیت',
        icon: <Wrench className="w-3.5 h-3.5 text-[#556b82]" />,
        params: { tab: 'machines', machineSubTab: 'utilization' },
      },
    ];
  }

  if (route.tab === 'dashboard') {
    return [];
  }

  return [
    {
      label: 'دستورات ساخت (MO)',
      icon: <ClipboardList className="w-3.5 h-3.5 text-[#007cc0]" />,
      params: {
        tab: 'production',
        productionViewMode: 'ERP_WORKBENCH',
        productionModuleTab: 'MANUFACTURING_ORDERS_LIST',
      },
    },
    {
      label: 'انبار و رول‌ها (MM)',
      icon: <Warehouse className="w-3.5 h-3.5 text-[#107e3e]" />,
      params: { tab: 'inventory', inventorySubTab: 'INQUIRY' },
    },
    {
      label: 'درخت محصول (BOM)',
      icon: <ListTree className="w-3.5 h-3.5 text-[#007cc0]" />,
      params: { tab: 'master_data', masterSubSection: 'BOM' },
    },
    {
      label: 'جریان ساخت (WIP)',
      icon: <GitBranch className="w-3.5 h-3.5 text-[#007cc0]" />,
      params: { tab: 'wip', wipSubTab: 'ORDERS' },
    },
  ];
}

const MO_LIFECYCLE_STAGES: LifecycleStageDef[] = [
  {
    step: '۰۱',
    title: 'تعریف BOM و مسیر تولید',
    subtitle: 'ایستگاه‌ها و قطعات مادر/فرعی',
    tab: 'master_data',
    subParams: { tab: 'master_data', masterSubSection: 'BOM' },
    isActive: r =>
      r.tab === 'master_data' &&
      ['BOM', 'ROUTINGS', 'PRODUCT_STRUCTURE', 'OPERATIONS', 'PARTS'].includes(r.masterSubSection || ''),
    icon: <Layers className="w-3.5 h-3.5" />,
  },
  {
    step: '۰۲',
    title: 'نیازسنجی MRP و صدور MO',
    subtitle: 'پیشنهاد تولید و دستورات فرعی',
    tab: 'planning',
    subParams: { tab: 'planning', planningSubTab: 'recommendations' },
    isActive: r => r.tab === 'planning',
    icon: <ClipboardList className="w-3.5 h-3.5" />,
  },
  {
    step: '۰۳',
    title: 'مدیریت دستورات (MO) و سرکلاف',
    subtitle: 'صدور، پیشرفت، OP10 و حذف امن',
    tab: 'production',
    subParams: {
      tab: 'production',
      productionViewMode: 'ERP_WORKBENCH',
      productionModuleTab: 'MANUFACTURING_ORDERS_LIST',
    },
    isActive: r => r.tab === 'production' || (r.tab === 'inventory' && r.inventorySubTab === 'COILS'),
    icon: <PackageOpen className="w-3.5 h-3.5" />,
  },
  {
    step: '۰۴',
    title: 'اجرای کارگاه و ردیابی WIP',
    subtitle: 'گزارش مراحل، حواله بین‌ایستگاهی',
    tab: 'wip',
    subParams: { tab: 'wip', wipSubTab: 'ORDERS' },
    isActive: r => r.tab === 'wip',
    icon: <Factory className="w-3.5 h-3.5" />,
  },
  {
    step: '۰۵',
    title: 'رسید انبار محصول و کاردکس',
    subtitle: 'تحویل قطعی و بازبینی اسناد',
    tab: 'inventory',
    subParams: { tab: 'inventory', inventorySubTab: 'INQUIRY' },
    isActive: r => r.tab === 'inventory' && r.inventorySubTab !== 'COILS',
    icon: <Warehouse className="w-3.5 h-3.5" />,
  },
];

export const MoLifecycleGuideStrip: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const router = useErpRouter();

  return (
    <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] px-3 py-2 shadow-[var(--fiori-shadow-card)]" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--fiori-text-primary)]">
          <Map className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
          <span>نقشه مسیر چرخه دستور تولید (از تعریف BOM تا انبار و ابطال امن)</span>
        </div>
        {!compact && (
          <span className="text-[11px] text-[var(--fiori-text-secondary)]">
            برای رفتن مستقیم به هر مرحله، روی کارت آن کلیک کنید
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
        {MO_LIFECYCLE_STAGES.map(stage => {
          const active = stage.isActive(router.route);
          return (
            <button
              key={stage.step}
              type="button"
              onClick={() => router.navigate(stage.subParams)}
              className={`text-right px-2.5 py-1.5 rounded-[var(--fiori-radius-sm)] border transition-colors cursor-pointer flex items-start gap-2 fiori-focus-ring ${
                active
                  ? 'bg-[var(--fiori-brand-bg)] border-[var(--fiori-brand)] text-[var(--fiori-brand)]'
                  : 'bg-[var(--fiori-bg-subtle)] border-[var(--fiori-border-default)] text-[var(--fiori-text-primary)] hover:bg-[var(--fiori-bg-hover)] hover:border-[var(--fiori-brand-border)]'
              }`}
            >
              <span
                className={`mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded-[var(--fiori-radius-sm)] text-[10px] font-semibold shrink-0 tabular-nums ${
                  active
                    ? 'bg-[var(--fiori-brand)] text-white'
                    : 'bg-[var(--fiori-neutral-bg)] text-[var(--fiori-text-secondary)]'
                }`}
              >
                {stage.step}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1 text-[11px] font-semibold truncate">
                  {stage.icon}
                  <span className="truncate">{stage.title}</span>
                </span>
                <span className="block text-[10px] text-[var(--fiori-text-secondary)] truncate mt-0.5">
                  {stage.subtitle}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

interface WorkspaceNavigationBarProps {
  guideContext?: ActivePageGuideContext;
  onNavigate?: (tab: any, subTab?: any) => void;
}

export const WorkspaceNavigationBar: React.FC<WorkspaceNavigationBarProps> = ({
  guideContext,
  onNavigate,
}) => {
  const router = useErpRouter();
  const [showLifecycleMap, setShowLifecycleMap] = useState(false);
  const [showRelatedMenu, setShowRelatedMenu] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSection, setDrawerSection] = useState<GuideDrawerSectionTab>('ALL');

  const guideEntry = useMemo(() => {
    if (!guideContext) return null;
    return resolvePageTrainingEntry(guideContext);
  }, [
    guideContext?.tab,
    guideContext?.masterSubSection,
    guideContext?.inventorySubTab,
    guideContext?.planningSubTab,
    guideContext?.productionViewMode,
    guideContext?.productionModuleTab,
    guideContext?.wipSubTab,
    guideContext?.machineSubTab,
    guideContext?.contractsSubTab,
    guideContext?.settingsSubTab,
    guideContext?.reportSubTab,
  ]);

  const relatedLinks = useMemo(() => getContextualRelatedLinks(router.route), [router.route]);

  const handleCopyDirectLink = async () => {
    const shareUrl = router.buildShareableUrl();
    if (!shareUrl) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(shareUrl);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = shareUrl;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 2200);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = shareUrl;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        setCopiedLink(true);
        window.setTimeout(() => setCopiedLink(false), 2200);
      } catch {
        // ignore
      }
      document.body.removeChild(textarea);
    }
  };

  const openGuide = (section: GuideDrawerSectionTab) => {
    setDrawerSection(section);
    setDrawerOpen(true);
  };

  const isDashboardRoot =
    router.route.tab === 'dashboard' &&
    !router.route.moId &&
    !router.route.timelineMoId &&
    !router.route.modal &&
    !router.canGoBack;

  return (
    <div className="space-y-2" dir="rtl">
      {/* Compact Single-Row SAP Fiori Horizon Context Strip */}
      <div className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-card)] px-3 py-1.5 flex flex-wrap items-center justify-between gap-2">
        {/* Right side: Back + Breadcrumbs */}
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          {!isDashboardRoot && (
            <button
              type="button"
              onClick={() => router.goBack()}
              disabled={!router.canGoBack}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-medium border border-[var(--fiori-border-input)] bg-[var(--fiori-bg-surface)] text-[var(--fiori-text-primary)] hover:bg-[var(--fiori-brand-bg)] hover:border-[var(--fiori-brand)] hover:text-[var(--fiori-brand)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0 cursor-pointer fiori-focus-ring"
              title={`بازگشت به: ${router.previousEntryLabel}`}
            >
              <ArrowRight className="w-3.5 h-3.5" />
              <span>بازگشت</span>
            </button>
          )}

          <nav
            aria-label="Breadcrumb"
            className="flex flex-wrap items-center gap-1 text-[11px] text-[var(--fiori-text-secondary)] pr-0.5"
          >
            {router.breadcrumbs.map((crumb, idx) => {
              const isLast = idx === router.breadcrumbs.length - 1;
              return (
                <React.Fragment key={`${crumb.label}-${idx}`}>
                  {idx > 0 && <ChevronLeft className="w-3 h-3 text-[var(--fiori-text-muted)] shrink-0" />}
                  {crumb.onClick && !isLast ? (
                    <button
                      type="button"
                      onClick={crumb.onClick}
                      className="hover:text-[var(--fiori-brand)] hover:underline transition-colors whitespace-nowrap cursor-pointer"
                    >
                      {crumb.label}
                    </button>
                  ) : (
                    <span className={isLast ? 'font-semibold text-[var(--fiori-text-primary)]' : ''}>
                      {crumb.label}
                    </span>
                  )}
                </React.Fragment>
              );
            })}
          </nav>
        </div>

        {/* Left side: Compact Contextual Actions */}
        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
          {relatedLinks.length > 0 && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowRelatedMenu(prev => !prev)}
                aria-expanded={showRelatedMenu}
                aria-haspopup="menu"
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-medium border transition-colors whitespace-nowrap shrink-0 cursor-pointer fiori-focus-ring ${
                  showRelatedMenu
                    ? 'bg-[var(--fiori-brand-bg)] border-[var(--fiori-brand)] text-[var(--fiori-brand)]'
                    : 'bg-[var(--fiori-bg-surface)] border-[var(--fiori-border-default)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-brand)] hover:border-[var(--fiori-brand-border)] hover:bg-[var(--fiori-brand-bg)]'
                }`}
                title="لینک‌های مرتبط با این ماژول"
              >
                <Compass className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
                <span>لینک‌های مرتبط</span>
                <span className="px-1 rounded bg-[var(--fiori-neutral-bg)] text-[10px] font-mono tabular-nums text-[var(--fiori-text-secondary)]">
                  {toPersianDigits(relatedLinks.length)}
                </span>
              </button>

              {showRelatedMenu && (
                <>
                  <div
                    className="fixed inset-0 z-30"
                    onClick={() => setShowRelatedMenu(false)}
                    aria-hidden="true"
                  />
                  <div
                    role="menu"
                    className="absolute left-0 top-full mt-1.5 w-64 bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-popover)] p-1.5 z-40 space-y-0.5"
                  >
                    <div className="px-2 py-1 text-[10px] font-semibold text-[var(--fiori-text-muted)] border-b border-[var(--fiori-border-subtle)] mb-1">
                      صفحات مرتبط این ماژول
                    </div>
                    {relatedLinks.map(link => (
                      <button
                        key={link.label}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setShowRelatedMenu(false);
                          router.navigate(link.params);
                        }}
                        title={link.title || link.label}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--fiori-radius-sm)] text-right text-[11px] font-medium text-[var(--fiori-text-primary)] hover:bg-[var(--fiori-brand-bg)] hover:text-[var(--fiori-brand)] transition-colors cursor-pointer"
                      >
                        {link.icon}
                        <span className="truncate">{link.label}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowLifecycleMap(prev => !prev)}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-medium border transition-colors whitespace-nowrap shrink-0 cursor-pointer fiori-focus-ring ${
              showLifecycleMap
                ? 'bg-[var(--fiori-brand-bg)] border-[var(--fiori-brand)] text-[var(--fiori-brand)]'
                : 'bg-[var(--fiori-bg-surface)] border-[var(--fiori-border-default)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] hover:bg-[var(--fiori-bg-hover)]'
            }`}
            title="نمایش نقشه مراحل چرخه دستور تولید (BOM -> MRP -> صدور MO -> کارگاه WIP -> انبار)"
          >
            <Map className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{showLifecycleMap ? 'بستن نقشه' : 'مسیر تولید'}</span>
          </button>

          <button
            type="button"
            onClick={handleCopyDirectLink}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-medium border transition-colors whitespace-nowrap shrink-0 cursor-pointer fiori-focus-ring ${
              copiedLink
                ? 'bg-[var(--fiori-positive-bg)] border-[var(--fiori-positive-border)] text-[var(--fiori-positive)]'
                : 'bg-[var(--fiori-bg-surface)] border-[var(--fiori-border-default)] text-[var(--fiori-text-secondary)] hover:bg-[var(--fiori-brand-bg)] hover:border-[var(--fiori-brand-border)] hover:text-[var(--fiori-brand)]'
            }`}
            title={`کپی لینک مستقیم این صفحه: ${router.buildShareableUrl()}`}
          >
            {copiedLink ? <Check className="w-3.5 h-3.5" /> : <Link2 className="w-3.5 h-3.5" />}
            <span className="hidden xl:inline">{copiedLink ? 'کپی شد' : 'لینک صفحه'}</span>
          </button>

          {guideEntry && (
            <>
              <button
                type="button"
                onClick={() => openGuide('SCENARIOS')}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-medium border border-[var(--fiori-positive-border)] bg-[var(--fiori-positive-bg)] hover:opacity-90 text-[var(--fiori-positive)] whitespace-nowrap shrink-0 cursor-pointer fiori-focus-ring"
                title="مشاهده سناریوهای عملیاتی این صفحه"
              >
                <Workflow className="w-3.5 h-3.5" />
                <span className="hidden lg:inline">
                  سناریوها ({toPersianDigits(guideEntry.scenarios.length)})
                </span>
              </button>

              <button
                type="button"
                onClick={() => openGuide('ALL')}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-semibold border border-[var(--fiori-brand-border)] bg-[var(--fiori-brand-bg)] hover:bg-[var(--fiori-bg-selected)] text-[var(--fiori-brand)] whitespace-nowrap shrink-0 cursor-pointer fiori-focus-ring"
                title={`آموزش کامل «${guideEntry.title}» و کاربرد همه دکمه‌ها`}
              >
                <HelpCircle className="w-3.5 h-3.5" />
                <span>آموزش</span>
              </button>
            </>
          )}
        </div>
      </div>

      {showLifecycleMap && <MoLifecycleGuideStrip />}

      {drawerOpen && guideEntry && (
        <Suspense fallback={null}>
          <LazyPageGuideDrawer
            isOpen={drawerOpen}
            entry={guideEntry}
            initialFocus={drawerSection}
            onClose={() => setDrawerOpen(false)}
            onNavigate={onNavigate}
          />
        </Suspense>
      )}
    </div>
  );
};
