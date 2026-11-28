import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Bell,
  BellRing,
  Compass,
  Database,
  Edit3,
  Grid,
  Menu,
  Palette,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { Part, UserRoleProfile } from '../../../types/inventory';
import { CloudSyncCheckResult } from '../../../types/dbSync';
import { RouteNavigateParams, RouteState, useErpRouter } from '../../../context/RouterContext';
import { TabKey } from '../../Sidebar';
import { GlobalSearchPaletteModal } from '../../common/GlobalSearchPaletteModal';
import { PWAInstallButton } from '../../pwa/PWAInstallButton';
import {
  CustomFactoryUser,
  loadCustomRoleTitles,
  loadCustomUsers,
  setActiveFactoryUser,
} from '../../../utils/userDirectoryStorage';
import { formatToJalali } from '../../../utils/jalali';
import { toPersianDigits } from '../../../utils/formatters';
import {
  findActiveNavContext,
  getAccessibleNavItems,
  isRoleAuthorizedForItem,
} from './navigationConfig';

export interface FioriShellBarProps {
  route: RouteState;
  currentUser: UserRoleProfile;
  parts?: Part[];
  coilsCount?: number;
  reorderAlertsCount?: number;
  loading: boolean;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  mobileNavOpen: boolean;
  onToggleMobileNav: () => void;
  onRoleChange: (role: UserRoleProfile['role']) => void;
  onSelectUser?: (uid: string) => void;
  onNavigateRoute: (params: RouteNavigateParams) => void;
  onLegacyNavigate?: (
    tab: TabKey,
    subTab?: string,
    actionModal?: 'RECEIPT' | 'ISSUE' | 'RETURN' | 'TRANSFER'
  ) => void;
  onOpenTemplateModal?: () => void;
  onOpenAiAssistant?: () => void;
  onSeedDemo: () => Promise<void>;
  onCleanDemo: () => Promise<void>;
  onOpenErpModal: () => void;
  onOpenHelpModal?: () => void;
  cloudSyncCheck?: CloudSyncCheckResult | null;
  autoCheckCloudUpdates?: boolean;
  cloudSyncBusy?: 'CHECK' | 'PUSH' | 'PULL' | null;
  onToggleAutoCloudCheck?: (enabled: boolean) => Promise<void>;
  onCheckCloudUpdates?: (force?: boolean) => Promise<void>;
  onCloudPull?: () => Promise<void>;
  onCloudPush?: () => Promise<void>;
}

const APP_FINDER_QUICK_LINKS: Array<{
  id: string;
  label: string;
  roles: Array<UserRoleProfile['role']>;
  params: RouteNavigateParams;
}> = [
  {
    id: 'quick-mo-list',
    label: 'مدیریت دستورات ساخت (MO)',
    roles: ['ADMIN', 'PRODUCTION_MANAGER', 'LINE_SUPERVISOR', 'QC_INSPECTOR'],
    params: {
      tab: 'production',
      productionViewMode: 'ERP_WORKBENCH',
      productionModuleTab: 'MANUFACTURING_ORDERS_LIST',
      moId: null,
    },
  },
  {
    id: 'quick-coils',
    label: 'رول‌های ورق و سرکلاف',
    roles: ['ADMIN', 'WAREHOUSE_KEEPER', 'PRODUCTION_MANAGER', 'LINE_SUPERVISOR', 'QC_INSPECTOR'],
    params: { tab: 'inventory', inventorySubTab: 'COILS', docQuery: null },
  },
  {
    id: 'quick-mrp',
    label: 'پیشنهاد و صدور MO (MRP)',
    roles: ['ADMIN', 'PRODUCTION_MANAGER', 'WAREHOUSE_KEEPER'],
    params: { tab: 'planning', planningSubTab: 'recommendations' },
  },
  {
    id: 'quick-wip-orders',
    label: 'کارت دستورات WIP',
    roles: ['ADMIN', 'PRODUCTION_MANAGER', 'LINE_SUPERVISOR', 'QC_INSPECTOR'],
    params: { tab: 'wip', wipSubTab: 'ORDERS', moId: null },
  },
  {
    id: 'quick-bom',
    label: 'درخت محصول (BOM)',
    roles: ['ADMIN', 'PRODUCTION_MANAGER', 'WAREHOUSE_KEEPER'],
    params: { tab: 'master_data', masterSubSection: 'BOM' },
  },
  {
    id: 'quick-qm',
    label: 'کنترل کیفیت (QM)',
    roles: ['ADMIN', 'WAREHOUSE_KEEPER', 'PRODUCTION_MANAGER', 'LINE_SUPERVISOR', 'QC_INSPECTOR'],
    params: { tab: 'inventory', inventorySubTab: 'QUALITY_QM', docQuery: null },
  },
];

export const FioriShellBar: React.FC<FioriShellBarProps> = ({
  route,
  currentUser,
  coilsCount = 0,
  reorderAlertsCount = 0,
  loading,
  sidebarCollapsed,
  onToggleSidebar,
  mobileNavOpen,
  onToggleMobileNav,
  onRoleChange,
  onSelectUser,
  onNavigateRoute,
  onLegacyNavigate,
  onOpenTemplateModal,
  onOpenAiAssistant,
  onSeedDemo,
  onCleanDemo,
  onOpenErpModal,
  onOpenHelpModal,
  cloudSyncCheck,
  autoCheckCloudUpdates = false,
  cloudSyncBusy = null,
  onToggleAutoCloudCheck,
  onCheckCloudUpdates,
  onCloudPull,
  onCloudPush,
}) => {
  const router = useErpRouter();
  const shellBarRef = useRef<HTMLElement>(null);

  const [showConfirmClean, setShowConfirmClean] = useState(false);
  const [dbStatus, setDbStatus] = useState<{ isConnected: boolean; isConfigured: boolean } | null>(
    null
  );
  const [showNotifications, setShowNotifications] = useState(false);
  const [showAppMatrix, setShowAppMatrix] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [isSearchPaletteOpen, setIsSearchPaletteOpen] = useState(false);

  const [customUsers, setCustomUsers] = useState<CustomFactoryUser[]>(() => loadCustomUsers());
  const [roleLabels, setRoleLabels] = useState<Record<UserRoleProfile['role'], string>>(() =>
    loadCustomRoleTitles()
  );

  useEffect(() => {
    fetch('/api/db/status')
      .then(res => res.json())
      .then(data => {
        if (data.success && data.data) {
          setDbStatus(data.data);
        }
      })
      .catch(() => {
        setDbStatus({ isConnected: false, isConfigured: false });
      });
  }, []);

  useEffect(() => {
    const syncUsers = () => {
      setCustomUsers(loadCustomUsers());
      setRoleLabels(loadCustomRoleTitles());
    };
    window.addEventListener('kpims-users-updated', syncUsers);
    return () => window.removeEventListener('kpims-users-updated', syncUsers);
  }, []);

  // Global keyboard shortcuts: Ctrl+K / F3 / Ctrl+/ for Search Palette, Ctrl+Space for AI, Escape for popovers
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'k' || e.key === '/')) {
        e.preventDefault();
        setIsSearchPaletteOpen(true);
      } else if (e.key === 'F3') {
        e.preventDefault();
        setIsSearchPaletteOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'Space') {
        e.preventDefault();
        onOpenAiAssistant?.();
      } else if (e.key === 'Escape') {
        setShowAppMatrix(false);
        setShowNotifications(false);
        setShowUserMenu(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onOpenAiAssistant]);

  // Close open shell popovers on outside pointer click
  useEffect(() => {
    if (!showAppMatrix && !showNotifications && !showUserMenu) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (shellBarRef.current && !shellBarRef.current.contains(e.target as Node)) {
        setShowAppMatrix(false);
        setShowNotifications(false);
        setShowUserMenu(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [showAppMatrix, showNotifications, showUserMenu]);

  const activeNavContext = useMemo(() => findActiveNavContext(route), [route]);
  const appFinderItems = useMemo(
    () => getAccessibleNavItems(currentUser.role, false),
    [currentUser.role]
  );
  const authorizedQuickLinks = useMemo(
    () => APP_FINDER_QUICK_LINKS.filter(link => isRoleAuthorizedForItem(link, currentUser.role)),
    [currentUser.role]
  );

  const now = new Date();
  const timeStr = toPersianDigits(
    `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  );
  const jalaliNumeric = formatToJalali(now);

  const hasPendingNotifications =
    reorderAlertsCount > 0 ||
    cloudSyncCheck?.state === 'REMOTE_AHEAD' ||
    cloudSyncCheck?.state === 'DIVERGED';

  const closeAllPopovers = () => {
    setShowAppMatrix(false);
    setShowNotifications(false);
    setShowUserMenu(false);
  };

  return (
    <header
      ref={shellBarRef}
      dir="rtl"
      className="bg-[var(--fiori-bg-surface)] text-[var(--fiori-text-primary)] border-b border-[var(--fiori-border-default)] sticky top-0 z-40 px-2.5 sm:px-4 h-12 flex items-center justify-between gap-2 sm:gap-3"
    >
      {/* START (RTL Right): Navigation Toggle + App Finder + KPIMS Identity + Module Context */}
      <div className="flex items-center gap-1.5 sm:gap-2.5 min-w-0">
        {/* Mobile Drawer Toggle */}
        <button
          type="button"
          onClick={() => {
            closeAllPopovers();
            onToggleMobileNav();
          }}
          aria-expanded={mobileNavOpen}
          aria-controls="kpims-mobile-side-nav"
          aria-label="باز کردن منوی ناوبری"
          className="md:hidden p-1.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] hover:bg-[var(--fiori-brand-bg)] hover:text-[var(--fiori-brand)] text-[var(--fiori-text-secondary)] border border-[var(--fiori-border-default)] transition-colors cursor-pointer fiori-focus-ring shrink-0"
        >
          <Menu className="w-4 h-4" />
        </button>

        {/* Desktop Side Rail Toggle */}
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-expanded={!sidebarCollapsed}
          aria-controls="kpims-desktop-side-nav"
          title={sidebarCollapsed ? 'باز کردن پنل ناوبری' : 'جمع کردن پنل ناوبری'}
          className="hidden md:inline-flex p-1.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] hover:bg-[var(--fiori-brand-bg)] hover:text-[var(--fiori-brand)] text-[var(--fiori-text-secondary)] border border-[var(--fiori-border-default)] transition-colors cursor-pointer fiori-focus-ring shrink-0"
        >
          {sidebarCollapsed ? (
            <PanelRightOpen className="w-4 h-4" />
          ) : (
            <PanelRightClose className="w-4 h-4" />
          )}
        </button>

        {/* App Finder Popover */}
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => {
              const next = !showAppMatrix;
              closeAllPopovers();
              setShowAppMatrix(next);
            }}
            aria-expanded={showAppMatrix}
            aria-haspopup="dialog"
            title="کاتالوگ ماژول‌های KPIMS (App Finder)"
            className="p-1.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] hover:bg-[var(--fiori-brand-bg)] hover:text-[var(--fiori-brand)] text-[var(--fiori-text-secondary)] border border-[var(--fiori-border-default)] transition-colors cursor-pointer flex items-center justify-center fiori-focus-ring"
          >
            <Grid className="w-4 h-4" />
          </button>

          {showAppMatrix && (
            <div
              role="dialog"
              aria-label="کاتالوگ ماژول‌های KPIMS"
              className="absolute right-0 top-full mt-2 w-[310px] sm:w-[420px] bg-[var(--fiori-bg-surface)] text-[var(--fiori-text-primary)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-popover)] p-3.5 z-50"
            >
              <div className="flex items-center justify-between border-b border-[var(--fiori-border-subtle)] pb-2 mb-2.5">
                <span className="text-xs font-semibold text-[var(--fiori-text-primary)]">
                  کاتالوگ ماژول‌های مجاز ({roleLabels[currentUser.role] || currentUser.role})
                </span>
                <button
                  type="button"
                  onClick={() => setShowAppMatrix(false)}
                  aria-label="بستن کاتالوگ"
                  className="text-[var(--fiori-text-muted)] hover:text-[var(--fiori-text-primary)] text-xs px-1 cursor-pointer fiori-focus-ring"
                >
                  ✕
                </button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {appFinderItems.map(item => {
                  const Icon = item.icon;
                  const isActive = route.tab === item.tab;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        onNavigateRoute(item.routeParams);
                        setShowAppMatrix(false);
                      }}
                      className={`flex flex-col items-center gap-1.5 p-2 rounded-[var(--fiori-radius-sm)] border transition-colors cursor-pointer fiori-focus-ring ${
                        isActive
                          ? 'border-[var(--fiori-brand)] bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)]'
                          : 'border-[var(--fiori-border-subtle)] hover:bg-[var(--fiori-bg-hover)] text-[var(--fiori-text-primary)]'
                      }`}
                    >
                      <div
                        className={`w-7 h-7 rounded-[var(--fiori-radius-sm)] flex items-center justify-center ${
                          isActive
                            ? 'bg-[var(--fiori-brand)] text-white'
                            : 'bg-[var(--fiori-bg-subtle)] text-[var(--fiori-brand)]'
                        }`}
                      >
                        <Icon className="w-3.5 h-3.5" />
                      </div>
                      <span className="text-[11px] font-medium text-center leading-tight">
                        {item.shortLabel}
                      </span>
                    </button>
                  );
                })}
              </div>

              {authorizedQuickLinks.length > 0 && (
                <div className="mt-3 pt-2.5 border-t border-[var(--fiori-border-subtle)]">
                  <div className="text-[10px] font-semibold text-[var(--fiori-text-secondary)] mb-1.5">
                    دسترسی مستقیم به زیرصفحه‌های کلیدی:
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {authorizedQuickLinks.map(link => (
                      <button
                        key={link.id}
                        type="button"
                        onClick={() => {
                          onNavigateRoute(link.params);
                          setShowAppMatrix(false);
                        }}
                        className="px-2 py-1 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] bg-[var(--fiori-bg-subtle)] hover:bg-[var(--fiori-brand-bg)] hover:border-[var(--fiori-brand)] hover:text-[var(--fiori-brand)] text-[10px] font-medium text-[var(--fiori-text-primary)] transition-colors cursor-pointer fiori-focus-ring"
                      >
                        {link.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* KPIMS Identity + Current Module / Sub-Page Context */}
        <button
          type="button"
          onClick={() =>
            onNavigateRoute({
              tab: 'dashboard',
              moId: null,
              timelineMoId: null,
              modal: null,
              docQuery: null,
            })
          }
          title="بازگشت به لانچ‌پد اصلی KPIMS"
          className="flex items-center gap-2 cursor-pointer min-w-0 group fiori-focus-ring rounded-[var(--fiori-radius-sm)] px-1 py-0.5"
        >
          <span className="px-2 py-0.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-brand)] text-white font-mono text-[11px] font-semibold shrink-0 flex items-center gap-1">
            <span>KPIMS</span>
            <span className="text-white/85 font-normal hidden xs:inline sm:inline">| ERP</span>
          </span>
          <span className="text-[var(--fiori-border-default)] hidden sm:inline shrink-0">/</span>
          <span className="text-xs font-semibold text-[var(--fiori-text-primary)] truncate max-w-[140px] sm:max-w-[230px] lg:max-w-[320px] group-hover:text-[var(--fiori-brand)]">
            {activeNavContext.subItem?.label ||
              activeNavContext.item?.shortLabel ||
              router.currentRouteLabel}
          </span>
        </button>

        {route.tab !== 'dashboard' && (
          <button
            type="button"
            onClick={() =>
              onNavigateRoute({
                tab: 'dashboard',
                moId: null,
                timelineMoId: null,
                modal: null,
                docQuery: null,
              })
            }
            className="hidden lg:inline-flex items-center gap-1 px-2 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-medium bg-[var(--fiori-bg-subtle)] hover:bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border border-[var(--fiori-border-default)] cursor-pointer whitespace-nowrap shrink-0 fiori-focus-ring"
          >
            <ArrowRight className="w-3 h-3" />
            <span>صفحه خانه</span>
          </button>
        )}
      </div>

      {/* CENTER: Global Enterprise Search Trigger (Ctrl+K) */}
      <div className="relative flex-1 max-w-md hidden md:flex items-center">
        <button
          type="button"
          onClick={() => setIsSearchPaletteOpen(true)}
          aria-label="جستجوی سراسری (Ctrl+K)"
          className="w-full relative flex items-center rounded-[var(--fiori-radius-sm)] pr-8 pl-14 py-1.5 text-xs cursor-pointer transition-colors bg-[var(--fiori-bg-subtle)] hover:bg-[var(--fiori-bg-hover)] border border-[var(--fiori-border-input)] text-right fiori-focus-ring"
        >
          <Search className="w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--fiori-brand)]" />
          <span className="truncate text-[var(--fiori-text-secondary)] text-[11px]">
            جستجو در دستورات ساخت، کالاها، قراردادها و اسناد...
          </span>
          <kbd className="absolute left-2 top-1/2 -translate-y-1/2 px-1.5 py-0.5 rounded-[var(--fiori-radius-sm)] text-[10px] font-mono text-[var(--fiori-text-secondary)] bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] pointer-events-none">
            Ctrl+K
          </kbd>
        </button>
      </div>

      {/* END (RTL Left): Shell Actions, Notifications & User Menu */}
      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
        {/* Mobile Search Icon */}
        <button
          type="button"
          onClick={() => setIsSearchPaletteOpen(true)}
          aria-label="جستجوی سراسری"
          title="جستجوی سراسری"
          className="md:hidden p-1.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] hover:bg-[var(--fiori-brand-bg)] text-[var(--fiori-text-primary)] border border-[var(--fiori-border-default)] cursor-pointer fiori-focus-ring"
        >
          <Search className="w-4 h-4 text-[var(--fiori-brand)]" />
        </button>

        <PWAInstallButton />

        {onOpenHelpModal && (
          <button
            type="button"
            onClick={onOpenHelpModal}
            className="px-2 sm:px-2.5 py-1 rounded-[var(--fiori-radius-sm)] text-xs font-medium flex items-center gap-1.5 cursor-pointer text-[var(--fiori-brand)] bg-[var(--fiori-brand-bg)] hover:bg-[var(--fiori-bg-selected)] border border-[var(--fiori-brand-border)] whitespace-nowrap shrink-0 transition-colors fiori-focus-ring"
            title="راهنمای تعاملی سناریوها، آموزش صفحه به صفحه و دکمه‌ها"
          >
            <Compass className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden xl:inline">راهنمای سیستم</span>
          </button>
        )}

        {/* Cloud DB Sync Status Button */}
        <button
          type="button"
          onClick={() => {
            if (cloudSyncCheck?.state === 'REMOTE_AHEAD' && onCloudPull) {
              onCloudPull();
            } else if (cloudSyncCheck?.state === 'LOCAL_AHEAD' && onCloudPush) {
              onCloudPush();
            } else {
              onOpenErpModal();
            }
          }}
          disabled={Boolean(cloudSyncBusy)}
          className={`hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-medium border transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50 fiori-focus-ring ${
            cloudSyncCheck?.state === 'REMOTE_AHEAD'
              ? 'bg-[var(--fiori-critical-bg)] text-[var(--fiori-critical)] border-[var(--fiori-critical-border)]'
              : cloudSyncCheck?.state === 'LOCAL_AHEAD'
              ? 'bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border-[var(--fiori-brand-border)]'
              : cloudSyncCheck?.state === 'IN_SYNC'
              ? 'bg-[var(--fiori-positive-bg)] text-[var(--fiori-positive)] border-[var(--fiori-positive-border)]'
              : 'bg-[var(--fiori-bg-subtle)] text-[var(--fiori-text-primary)] border-[var(--fiori-border-default)] hover:bg-[var(--fiori-brand-bg)]'
          }`}
          title="همگام‌سازی پایگاه داده محلی و ابری"
        >
          <RefreshCw className={`w-3 h-3 ${cloudSyncBusy ? 'animate-spin' : ''}`} />
          <span className="hidden lg:inline">
            {cloudSyncBusy === 'PULL'
              ? 'دریافت از آنلاین...'
              : cloudSyncBusy === 'PUSH'
              ? 'ارسال به آنلاین...'
              : cloudSyncCheck?.state === 'REMOTE_AHEAD'
              ? 'آپدیت از آنلاین (Pull)'
              : cloudSyncCheck?.state === 'LOCAL_AHEAD'
              ? 'ارسال به آنلاین (Push)'
              : cloudSyncCheck?.state === 'IN_SYNC'
              ? 'همگام با آنلاین'
              : 'همگام‌سازی DB'}
          </span>
        </button>

        {/* Reorder Alerts Shortcut */}
        {reorderAlertsCount > 0 && (
          <button
            type="button"
            onClick={() => onNavigateRoute({ tab: 'inventory', inventorySubTab: 'ALERTS', docQuery: null })}
            className="hidden sm:inline-flex items-center gap-1.5 px-2 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-medium transition-colors cursor-pointer bg-[var(--fiori-critical-bg)] hover:opacity-90 text-[var(--fiori-critical)] border border-[var(--fiori-critical-border)] whitespace-nowrap shrink-0 fiori-focus-ring"
            title="مشاهده فهرست اقلام زیر نقطه سفارش"
          >
            <BellRing className="w-3 h-3 shrink-0" />
            <span className="tabular-nums">{toPersianDigits(reorderAlertsCount)} کسری موجودی</span>
          </button>
        )}

        {/* Notifications & Sync Center Popover */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              const next = !showNotifications;
              closeAllPopovers();
              setShowNotifications(next);
            }}
            aria-expanded={showNotifications}
            aria-haspopup="dialog"
            aria-label="اعلان‌های کارخانه و همگام‌سازی"
            title="اعلان‌های کارخانه و همگام‌سازی آنلاین"
            className="p-1.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] hover:bg-[var(--fiori-brand-bg)] hover:text-[var(--fiori-brand)] text-[var(--fiori-text-secondary)] border border-[var(--fiori-border-default)] transition-colors cursor-pointer relative fiori-focus-ring"
          >
            <Bell className="w-4 h-4" />
            {hasPendingNotifications && (
              <span
                aria-label="اعلان فعال"
                className="w-2 h-2 rounded-full bg-[var(--fiori-critical)] border border-white absolute top-1 right-1"
              />
            )}
          </button>

          {showNotifications && (
            <div
              role="dialog"
              aria-label="مرکز اعلان‌ها و همگام‌سازی"
              className="absolute left-0 top-full mt-2 w-[310px] sm:w-[340px] bg-[var(--fiori-bg-surface)] text-[var(--fiori-text-primary)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-popover)] p-3 z-50 text-xs space-y-2.5"
            >
              <div className="flex items-center justify-between border-b border-[var(--fiori-border-subtle)] pb-2">
                <span className="font-semibold text-[var(--fiori-text-primary)]">
                  مرکز اعلان‌ها و همگام‌سازی
                </span>
                <button
                  type="button"
                  onClick={() => setShowNotifications(false)}
                  aria-label="بستن اعلان‌ها"
                  className="text-[var(--fiori-text-muted)] hover:text-[var(--fiori-text-primary)] cursor-pointer px-1"
                >
                  ✕
                </button>
              </div>

              <div className="space-y-2">
                <div
                  className={`p-2.5 rounded-[var(--fiori-radius-sm)] border space-y-2 ${
                    cloudSyncCheck?.state === 'REMOTE_AHEAD' ||
                    cloudSyncCheck?.state === 'DIVERGED'
                      ? 'bg-[var(--fiori-critical-bg)] border-[var(--fiori-critical-border)]'
                      : 'bg-[var(--fiori-bg-subtle)] border-[var(--fiori-border-default)]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-[var(--fiori-text-primary)] flex items-center gap-1">
                      <Database className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
                      همگام‌سازی آنلاین
                    </span>
                    <span className="text-[10px] font-semibold text-[var(--fiori-brand)]">
                      {cloudSyncCheck?.state === 'REMOTE_AHEAD'
                        ? 'آپدیت جدید موجود'
                        : cloudSyncCheck?.state === 'LOCAL_AHEAD'
                        ? 'نیازمند Push'
                        : cloudSyncCheck?.state === 'DIVERGED'
                        ? 'تغییر همزمان'
                        : cloudSyncCheck?.state === 'IN_SYNC'
                        ? 'همگام'
                        : 'آماده بررسی'}
                    </span>
                  </div>

                  {cloudSyncCheck?.messageFa && (
                    <div className="text-[11px] text-[var(--fiori-text-secondary)] leading-relaxed">
                      {cloudSyncCheck.messageFa}
                    </div>
                  )}

                  {onToggleAutoCloudCheck && (
                    <label className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--fiori-text-primary)] cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={autoCheckCloudUpdates}
                        onChange={e => onToggleAutoCloudCheck(e.target.checked)}
                        className="w-3.5 h-3.5 accent-[var(--fiori-brand)] cursor-pointer"
                      />
                      <span>بررسی خودکار آپدیت آنلاین حین اجرا</span>
                    </label>
                  )}

                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    {onCheckCloudUpdates && (
                      <button
                        type="button"
                        onClick={() => onCheckCloudUpdates(true)}
                        disabled={Boolean(cloudSyncBusy)}
                        className="px-2 py-1 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] hover:bg-[var(--fiori-bg-hover)] text-[10px] font-semibold cursor-pointer disabled:opacity-50"
                      >
                        {cloudSyncBusy === 'CHECK' ? 'در حال چک...' : 'چک آنلاین'}
                      </button>
                    )}
                    {onCloudPull && (
                      <button
                        type="button"
                        onClick={async () => {
                          await onCloudPull();
                          setShowNotifications(false);
                        }}
                        disabled={Boolean(cloudSyncBusy)}
                        className="px-2 py-1 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-brand)] hover:bg-[var(--fiori-brand-hover)] text-white text-[10px] font-semibold cursor-pointer disabled:opacity-50"
                      >
                        {cloudSyncBusy === 'PULL' ? 'در حال Pull...' : 'آپدیت از آنلاین (Pull)'}
                      </button>
                    )}
                    {onCloudPush && (
                      <button
                        type="button"
                        onClick={async () => {
                          await onCloudPush();
                          setShowNotifications(false);
                        }}
                        disabled={Boolean(cloudSyncBusy)}
                        className="px-2 py-1 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-surface)] border border-[var(--fiori-brand)] text-[var(--fiori-brand)] hover:bg-[var(--fiori-brand-bg)] text-[10px] font-semibold cursor-pointer disabled:opacity-50"
                      >
                        {cloudSyncBusy === 'PUSH' ? 'در حال Push...' : 'آپلود (Push)'}
                      </button>
                    )}
                  </div>
                </div>

                {reorderAlertsCount > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      onNavigateRoute({ tab: 'inventory', inventorySubTab: 'ALERTS', docQuery: null });
                      setShowNotifications(false);
                    }}
                    className="w-full text-right p-2.5 bg-[var(--fiori-critical-bg)] hover:bg-[#ffe8cc] rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-critical-border)] cursor-pointer block"
                  >
                    <div className="font-medium text-[var(--fiori-critical)]">
                      هشدار کسری نقطه سفارش ({toPersianDigits(reorderAlertsCount)} قلم کالا)
                    </div>
                    <div className="text-[11px] text-[#7d3c0a] mt-0.5">
                      بررسی جدول کسری‌ها و صدور دستور خرید یا تولید جبرانی
                    </div>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    onNavigateRoute({ tab: 'inventory', inventorySubTab: 'COILS', docQuery: null });
                    setShowNotifications(false);
                  }}
                  className="w-full text-right p-2.5 bg-[var(--fiori-bg-subtle)] hover:bg-[var(--fiori-brand-bg)] rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-subtle)] cursor-pointer block"
                >
                  <div className="font-medium text-[var(--fiori-text-primary)]">
                    موجودی کلاف‌های ورق در انبار
                  </div>
                  <div className="text-[11px] text-[var(--fiori-text-secondary)] mt-0.5">
                    {toPersianDigits(coilsCount)} رول فیزیکی با برچسب و کویل‌پک در سامانه ثبت شده است.
                  </div>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* User Profile, Active Session & System Menu */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              const next = !showUserMenu;
              closeAllPopovers();
              setShowUserMenu(next);
            }}
            aria-expanded={showUserMenu}
            aria-haspopup="dialog"
            className="flex items-center gap-2 pl-2 pr-1 py-1 rounded-[var(--fiori-radius-sm)] hover:bg-[var(--fiori-bg-hover)] text-[var(--fiori-text-primary)] transition-colors cursor-pointer fiori-focus-ring"
          >
            <div className="w-7 h-7 rounded-full bg-[var(--fiori-brand)] text-white flex items-center justify-center font-medium text-xs shrink-0">
              {currentUser.displayName ? currentUser.displayName[0] : 'ک'}
            </div>
            <div className="hidden lg:block text-right leading-tight">
              <div className="text-[11px] font-semibold text-[var(--fiori-text-primary)] truncate max-w-[130px]">
                {currentUser.displayName || 'کاربر سیستم'}
              </div>
              <div className="text-[10px] text-[var(--fiori-text-secondary)] truncate max-w-[130px]">
                {roleLabels[currentUser.role] || 'مدیر سیستم'}
              </div>
            </div>
          </button>

          {showUserMenu && (
            <div
              role="dialog"
              aria-label="منوی کاربر و تنظیمات نشست"
              className="absolute left-0 top-full mt-2 w-80 max-w-[calc(100vw-1.5rem)] bg-[var(--fiori-bg-surface)] text-[var(--fiori-text-primary)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] shadow-[var(--fiori-shadow-popover)] p-3 z-50 text-xs space-y-3"
            >
              <div className="border-b border-[var(--fiori-border-subtle)] pb-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-[var(--fiori-text-primary)] truncate">
                    {currentUser.displayName || 'کاربر سیستم'}
                  </div>
                  <div className="text-[11px] text-[var(--fiori-text-secondary)] truncate">
                    {roleLabels[currentUser.role]}
                  </div>
                </div>
                <div className="text-[10px] text-[var(--fiori-text-secondary)] font-mono tabular-nums shrink-0">
                  {timeStr} · {jalaliNumeric}
                </div>
              </div>

              <div>
                <label className="text-[11px] font-semibold text-[var(--fiori-text-secondary)] block mb-1">
                  کاربر فعال نشست:
                </label>
                <select
                  value={currentUser.uid}
                  onChange={e => {
                    const nextUid = e.target.value;
                    if (onSelectUser) {
                      onSelectUser(nextUid);
                    } else {
                      setActiveFactoryUser(nextUid);
                    }
                    setShowUserMenu(false);
                  }}
                  className="fiori-input w-full p-1.5 text-xs font-medium cursor-pointer"
                >
                  {customUsers.map(u => (
                    <option key={u.uid} value={u.uid}>
                      {u.displayName} — {roleLabels[u.role]}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-[11px] font-semibold text-[var(--fiori-text-secondary)] block mb-1">
                  تغییر نقش و سطح دسترسی:
                </label>
                <select
                  value={currentUser.role}
                  onChange={e => {
                    onRoleChange(e.target.value as UserRoleProfile['role']);
                    setShowUserMenu(false);
                  }}
                  className="fiori-input w-full p-1.5 text-xs font-medium cursor-pointer"
                >
                  {Object.entries(roleLabels).map(([roleKey, label]) => (
                    <option key={roleKey} value={roleKey}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="button"
                onClick={() => {
                  setShowUserMenu(false);
                  onNavigateRoute({ tab: 'settings', settingsSubTab: 'rbac', moId: null });
                }}
                className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-brand-bg)] hover:bg-[var(--fiori-bg-selected)] text-[var(--fiori-brand)] border border-[var(--fiori-brand-border)] text-[11px] font-semibold cursor-pointer transition-colors"
              >
                <Edit3 className="w-3.5 h-3.5" />
                <span>مدیریت کاربران و سطوح دسترسی</span>
              </button>

              <div className="pt-2 border-t border-[var(--fiori-border-subtle)] space-y-1">
                {onOpenTemplateModal && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowUserMenu(false);
                      onOpenTemplateModal();
                    }}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--fiori-radius-sm)] hover:bg-[var(--fiori-bg-hover)] text-[var(--fiori-text-primary)] cursor-pointer"
                  >
                    <Palette className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
                    <span>تنظیمات قالب و رنگ‌بندی محیط</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setShowUserMenu(false);
                    onOpenErpModal();
                  }}
                  className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-[var(--fiori-radius-sm)] hover:bg-[var(--fiori-bg-hover)] text-[var(--fiori-text-primary)] cursor-pointer"
                >
                  <span className="flex items-center gap-2">
                    <Database className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
                    <span>وضعیت پایگاه داده و همگام‌سازی</span>
                  </span>
                  <span
                    className={`text-[10px] font-semibold ${
                      cloudSyncCheck?.state === 'REMOTE_AHEAD' ||
                      cloudSyncCheck?.state === 'DIVERGED'
                        ? 'text-[var(--fiori-critical)]'
                        : dbStatus?.isConnected
                        ? 'text-[var(--fiori-positive)]'
                        : 'text-[var(--fiori-critical)]'
                    }`}
                  >
                    {cloudSyncCheck?.state === 'REMOTE_AHEAD'
                      ? 'آپدیت آنلاین موجود'
                      : dbStatus === null
                      ? '...'
                      : dbStatus.isConnected
                      ? 'PostgreSQL متصل'
                      : 'دیسک پایدار'}
                  </span>
                </button>

                {currentUser.role === 'ADMIN' && (
                  <>
                    <button
                      type="button"
                      onClick={async () => {
                        await onSeedDemo();
                        setShowUserMenu(false);
                      }}
                      disabled={loading}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--fiori-radius-sm)] hover:bg-[var(--fiori-bg-hover)] text-[var(--fiori-text-primary)] cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 text-[var(--fiori-brand)] ${loading ? 'animate-spin' : ''}`}
                      />
                      <span>بازنشانی داده‌های نمونه کارخانه</span>
                    </button>

                    {!showConfirmClean ? (
                      <button
                        type="button"
                        onClick={() => setShowConfirmClean(true)}
                        disabled={loading}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--fiori-radius-sm)] hover:bg-[var(--fiori-negative-bg)] text-[var(--fiori-negative)] cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>پاکسازی داده‌های نمونه</span>
                      </button>
                    ) : (
                      <div className="flex items-center justify-between bg-[var(--fiori-negative-bg)] border border-[var(--fiori-negative-border)] px-2.5 py-1.5 rounded-[var(--fiori-radius-sm)] text-xs">
                        <span className="text-[var(--fiori-negative)] text-[11px] font-semibold">
                          تأیید پاکسازی داده‌ها؟
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={async () => {
                              await onCleanDemo();
                              setShowConfirmClean(false);
                              setShowUserMenu(false);
                            }}
                            className="bg-[var(--fiori-negative)] hover:opacity-90 text-white font-semibold px-2 py-0.5 rounded-[var(--fiori-radius-sm)] text-[10px] cursor-pointer"
                          >
                            بله، حذف
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowConfirmClean(false)}
                            className="text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] px-1.5 py-0.5 text-[10px] cursor-pointer"
                          >
                            انصراف
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="pt-2 border-t border-[var(--fiori-border-subtle)] flex items-center justify-between text-[11px] text-[var(--fiori-text-secondary)]">
                <span>سامانه صنعتی کوثر · KPIMS</span>
                <button
                  type="button"
                  onClick={() => setShowUserMenu(false)}
                  className="text-[var(--fiori-brand)] hover:underline font-semibold cursor-pointer"
                >
                  بستن
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Unified Global Command Palette Modal (Ctrl+K) */}
      <GlobalSearchPaletteModal
        isOpen={isSearchPaletteOpen}
        onClose={() => setIsSearchPaletteOpen(false)}
        onNavigate={(tab, subTab) => {
          if (onLegacyNavigate) {
            onLegacyNavigate(tab, subTab);
          } else {
            onNavigateRoute({ tab });
          }
        }}
      />
    </header>
  );
};
