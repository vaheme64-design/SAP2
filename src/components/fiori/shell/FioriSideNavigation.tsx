import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  PanelRightClose,
  PanelRightOpen,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { UserRoleProfile } from '../../../types/inventory';
import { RouteNavigateParams, RouteState } from '../../../context/RouterContext';
import { usePersistedExpandMap } from '../../../hooks/usePersistedCollapse';
import { loadCustomRoleTitles } from '../../../utils/userDirectoryStorage';
import {
  ShellNavMetrics,
  ShellNavSubItem,
  findActiveNavContext,
  formatShellNavBadge,
  getAccessibleNavGroups,
} from './navigationConfig';

export interface FioriSideNavigationProps {
  route: RouteState;
  currentUser: UserRoleProfile;
  metrics: ShellNavMetrics;
  collapsed: boolean;
  onToggleCollapse: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onNavigate: (params: RouteNavigateParams) => void;
  onOpenAiAssistant?: () => void;
}

export const FioriSideNavigation: React.FC<FioriSideNavigationProps> = ({
  route,
  currentUser,
  metrics,
  collapsed,
  onToggleCollapse,
  mobileOpen,
  onCloseMobile,
  onNavigate,
  onOpenAiAssistant,
}) => {
  const [moduleSearch, setModuleSearch] = useState('');
  const [roleLabels, setRoleLabels] = useState<Record<UserRoleProfile['role'], string>>(() =>
    loadCustomRoleTitles()
  );

  const { map: expandedGroups, toggle: toggleGroup } = usePersistedExpandMap(
    'fiori_shell_nav_groups',
    {
      overview: true,
      daily_ops: true,
      planning_supply: true,
      master_admin: false,
    }
  );

  const activeContext = useMemo(() => findActiveNavContext(route), [route]);

  const [expandedModules, setExpandedModules] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    if (activeContext.item?.id) {
      initial[activeContext.item.id] = true;
    }
    return initial;
  });

  // Keep the currently active module's nested navigation expanded on Back/Forward & direct URL load
  useEffect(() => {
    const activeItemId = activeContext.item?.id;
    if (activeItemId) {
      setExpandedModules(prev => (prev[activeItemId] ? prev : { ...prev, [activeItemId]: true }));
    }
  }, [activeContext.item?.id]);

  // Sync custom role display names
  useEffect(() => {
    const syncRoles = () => setRoleLabels(loadCustomRoleTitles());
    window.addEventListener('kpims-users-updated', syncRoles);
    return () => window.removeEventListener('kpims-users-updated', syncRoles);
  }, []);

  // Close mobile drawer on Escape key
  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseMobile();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen, onCloseMobile]);

  const accessibleGroups = useMemo(
    () => getAccessibleNavGroups(currentUser.role, false),
    [currentUser.role]
  );

  const searchNormalized = moduleSearch.trim().toLowerCase();

  const toggleModuleSubList = (moduleId: string) => {
    setExpandedModules(prev => ({
      ...prev,
      [moduleId]: !prev[moduleId],
    }));
  };

  const handleSelectNav = (params: RouteNavigateParams, isMobileDrawer: boolean) => {
    onNavigate(params);
    if (isMobileDrawer) {
      onCloseMobile();
    }
  };

  const renderNavigationTree = (isRailCollapsed: boolean, isMobileDrawer: boolean) => {
    return (
      <div className="flex flex-col h-full justify-between select-none" dir="rtl">
        <div className="flex flex-col min-h-0 flex-1">
          {/* Rail / Drawer Header */}
          <div
            className={`flex items-center border-b border-[var(--fiori-border-subtle)] px-2.5 py-2 shrink-0 ${
              isRailCollapsed ? 'justify-center' : 'justify-between gap-2'
            }`}
          >
            {!isRailCollapsed && (
              <span className="text-[11px] font-semibold text-[var(--fiori-text-secondary)] truncate">
                ناوبری ماژول‌های KPIMS
              </span>
            )}
            {isMobileDrawer ? (
              <button
                type="button"
                onClick={onCloseMobile}
                aria-label="بستن منوی ناوبری"
                className="p-1.5 rounded-[var(--fiori-radius-sm)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] hover:bg-[var(--fiori-bg-hover)] cursor-pointer fiori-focus-ring"
              >
                <X className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={onToggleCollapse}
                aria-expanded={!isRailCollapsed}
                aria-controls="kpims-desktop-side-nav"
                title={isRailCollapsed ? 'باز کردن منوی کناری' : 'جمع کردن منوی کناری'}
                className="p-1.5 rounded-[var(--fiori-radius-sm)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-brand)] hover:bg-[var(--fiori-brand-bg)] transition-colors cursor-pointer fiori-focus-ring"
              >
                {isRailCollapsed ? (
                  <PanelRightOpen className="w-4 h-4" />
                ) : (
                  <PanelRightClose className="w-4 h-4" />
                )}
              </button>
            )}
          </div>

          {/* Instant Filter Search (Expanded Mode) */}
          {!isRailCollapsed && (
            <div className="px-2.5 pt-2.5 pb-1.5 shrink-0 space-y-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute right-2.5 top-2 pointer-events-none text-[var(--fiori-text-muted)]" />
                <input
                  type="text"
                  value={moduleSearch}
                  onChange={e => setModuleSearch(e.target.value)}
                  placeholder="فیلتر ماژول یا زیرصفحه..."
                  aria-label="فیلتر ماژول‌های ناوبری"
                  className="fiori-input w-full pr-8 pl-6 py-1.5 text-xs bg-[var(--fiori-bg-subtle)] focus:bg-[var(--fiori-bg-surface)]"
                />
                {moduleSearch && (
                  <button
                    type="button"
                    onClick={() => setModuleSearch('')}
                    aria-label="پاک کردن جستجو"
                    className="absolute left-2 top-2 text-[var(--fiori-text-muted)] hover:text-[var(--fiori-text-primary)] cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {onOpenAiAssistant && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenAiAssistant();
                    if (isMobileDrawer) onCloseMobile();
                  }}
                  title="دستیار هوشمند کارخانه (Ctrl + Space)"
                  className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-[var(--fiori-radius-sm)] text-xs font-medium bg-[var(--fiori-bg-subtle)] hover:bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border border-[var(--fiori-border-default)] transition-colors cursor-pointer fiori-focus-ring"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <Sparkles className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">دستیار هوشمند (Copilot)</span>
                  </span>
                  <kbd className="px-1.5 py-0.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-surface)] text-[10px] font-mono text-[var(--fiori-text-secondary)] border border-[var(--fiori-border-default)] shrink-0">
                    Ctrl+Space
                  </kbd>
                </button>
              )}
            </div>
          )}

          {/* Collapsed AI Assistant shortcut */}
          {isRailCollapsed && onOpenAiAssistant && (
            <div className="px-2 pt-2 shrink-0 flex justify-center">
              <div className="relative group/ai w-full flex justify-center">
                <button
                  type="button"
                  onClick={onOpenAiAssistant}
                  aria-label="دستیار هوشمند (Ctrl+Space)"
                  className="w-10 h-9 flex items-center justify-center rounded-[var(--fiori-radius-sm)] text-[var(--fiori-brand)] bg-[var(--fiori-bg-subtle)] hover:bg-[var(--fiori-brand-bg)] border border-[var(--fiori-border-default)] transition-colors cursor-pointer fiori-focus-ring"
                >
                  <Sparkles className="w-4 h-4" />
                </button>
                <div
                  role="tooltip"
                  className="pointer-events-none opacity-0 group-hover/ai:opacity-100 group-focus-within/ai:opacity-100 transition-opacity duration-150 fixed-tooltip absolute right-full top-1/2 -translate-y-1/2 mr-2 z-50 whitespace-nowrap rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-text-primary)] text-white text-[11px] font-medium px-2.5 py-1 shadow-lg"
                >
                  دستیار هوشمند (Ctrl+Space)
                </div>
              </div>
            </div>
          )}

          {/* Grouped Navigation Items */}
          <nav
            aria-label="ناوبری اصلی سامانه"
            className={`flex-1 px-2 py-2 space-y-3 ${
              isRailCollapsed ? 'overflow-visible' : 'overflow-y-auto'
            }`}
          >
            {accessibleGroups.map(group => {
              const filteredItems = group.items
                .map(item => {
                  if (!searchNormalized) {
                    return { item, matchedSubs: item.subItems || [] };
                  }
                  const itemMatches =
                    item.label.toLowerCase().includes(searchNormalized) ||
                    item.shortLabel.toLowerCase().includes(searchNormalized) ||
                    item.keywords.toLowerCase().includes(searchNormalized);

                  const matchedSubs = (item.subItems || []).filter(
                    sub =>
                      sub.label.toLowerCase().includes(searchNormalized) ||
                      sub.keywords.toLowerCase().includes(searchNormalized)
                  );

                  if (itemMatches || matchedSubs.length > 0) {
                    return {
                      item,
                      matchedSubs: matchedSubs.length > 0 ? matchedSubs : item.subItems || [],
                    };
                  }
                  return null;
                })
                .filter(Boolean) as Array<{
                item: (typeof group.items)[number];
                matchedSubs: ShellNavSubItem[];
              }>;

              if (filteredItems.length === 0) return null;

              const hasActiveItemInGroup = filteredItems.some(entry => entry.item.tab === route.tab);
              const isGroupExpanded = isRailCollapsed
                ? true
                : Boolean(searchNormalized) || hasActiveItemInGroup || Boolean(expandedGroups[group.id]);

              return (
                <div key={group.id} className="space-y-1">
                  {!isRailCollapsed && (
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.id)}
                      aria-expanded={isGroupExpanded}
                      className="w-full flex items-center justify-between px-2 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] font-semibold text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] hover:bg-[var(--fiori-bg-hover)] transition-colors cursor-pointer fiori-focus-ring"
                    >
                      <span>{group.title}</span>
                      {isGroupExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                      ) : (
                        <ChevronLeft className="w-3.5 h-3.5 shrink-0" />
                      )}
                    </button>
                  )}

                  {isGroupExpanded && (
                    <ul className="space-y-0.5">
                      {filteredItems.map(({ item, matchedSubs }) => {
                        const Icon = item.icon;
                        const isItemActive = route.tab === item.tab;
                        const hasSubItems = matchedSubs.length > 0;
                        const isModuleExpanded =
                          !isRailCollapsed &&
                          hasSubItems &&
                          (Boolean(searchNormalized) || Boolean(expandedModules[item.id]));
                        const itemBadge = formatShellNavBadge(
                          item.badgeKey,
                          metrics,
                          item.badgeSuffix || ''
                        );

                        return (
                          <li key={item.id} className="space-y-0.5">
                            <div className="relative group/navitem flex items-center gap-0.5">
                              <button
                                type="button"
                                onClick={() => handleSelectNav(item.routeParams, isMobileDrawer)}
                                aria-current={isItemActive && !hasSubItems ? 'page' : undefined}
                                aria-label={isRailCollapsed ? item.label : undefined}
                                className={`flex-1 flex items-center min-w-0 ${
                                  isRailCollapsed
                                    ? 'justify-center px-2 py-2'
                                    : 'justify-between px-2.5 py-2'
                                } rounded-[var(--fiori-radius-sm)] text-xs transition-colors cursor-pointer text-right fiori-focus-ring border ${
                                  isItemActive
                                    ? 'bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border-[var(--fiori-brand-border)] font-semibold'
                                    : 'bg-transparent text-[var(--fiori-text-primary)] border-transparent hover:bg-[var(--fiori-bg-hover)] font-normal'
                                }`}
                              >
                                <span className="flex items-center gap-2.5 min-w-0">
                                  <Icon
                                    className={`w-4 h-4 shrink-0 ${
                                      isItemActive
                                        ? 'text-[var(--fiori-brand)]'
                                        : 'text-[var(--fiori-text-secondary)]'
                                    }`}
                                  />
                                  {!isRailCollapsed && (
                                    <span className="truncate">{item.label}</span>
                                  )}
                                </span>

                                {!isRailCollapsed && itemBadge && (
                                  <span
                                    className={`px-1.5 py-0.5 rounded-[var(--fiori-radius-sm)] text-[10px] font-medium tabular-nums shrink-0 border ${
                                      item.badgeTone === 'warning'
                                        ? 'bg-[var(--fiori-critical-bg)] text-[var(--fiori-critical)] border-[var(--fiori-critical-border)]'
                                        : 'bg-[var(--fiori-neutral-bg)] text-[var(--fiori-text-secondary)] border-[var(--fiori-border-subtle)]'
                                    }`}
                                  >
                                    {itemBadge}
                                  </span>
                                )}
                              </button>

                              {/* Independent Sub-Navigation Expand/Collapse Chevron */}
                              {!isRailCollapsed && hasSubItems && !searchNormalized && (
                                <button
                                  type="button"
                                  onClick={() => toggleModuleSubList(item.id)}
                                  aria-expanded={isModuleExpanded}
                                  aria-label={`باز یا بسته کردن زیرمنوی ${item.shortLabel}`}
                                  className="p-1.5 rounded-[var(--fiori-radius-sm)] text-[var(--fiori-text-muted)] hover:text-[var(--fiori-text-primary)] hover:bg-[var(--fiori-bg-hover)] transition-colors cursor-pointer shrink-0 fiori-focus-ring"
                                >
                                  {isModuleExpanded ? (
                                    <ChevronDown className="w-3.5 h-3.5" />
                                  ) : (
                                    <ChevronLeft className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              )}

                              {/* Collapsed Rail Hover / Focus Tooltip (RTL: pops to left of rail) */}
                              {isRailCollapsed && (
                                <div
                                  role="tooltip"
                                  className="pointer-events-none opacity-0 group-hover/navitem:opacity-100 group-focus-within/navitem:opacity-100 transition-opacity duration-150 absolute right-full top-1/2 -translate-y-1/2 mr-2 z-50 whitespace-nowrap rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-text-primary)] text-white text-[11px] font-medium px-2.5 py-1 shadow-lg flex items-center gap-2"
                                >
                                  <span>{item.label}</span>
                                  {itemBadge && (
                                    <span className="px-1 py-0.5 rounded bg-white/15 text-[10px] tabular-nums">
                                      {itemBadge}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Nested Sub-Items */}
                            {isModuleExpanded && (
                              <ul className="mr-3 pr-2 border-r border-[var(--fiori-border-default)] space-y-0.5 py-0.5">
                                {matchedSubs.map(sub => {
                                  const SubIcon = sub.icon;
                                  const isSubActive = sub.isActive(route);
                                  const subBadge = formatShellNavBadge(sub.badgeKey, metrics);

                                  return (
                                    <li key={sub.id}>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          handleSelectNav(sub.routeParams, isMobileDrawer)
                                        }
                                        aria-current={isSubActive ? 'page' : undefined}
                                        className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-[var(--fiori-radius-sm)] text-[11px] transition-colors cursor-pointer text-right fiori-focus-ring ${
                                          isSubActive
                                            ? 'bg-[var(--fiori-bg-selected)] text-[var(--fiori-brand)] font-semibold'
                                            : 'text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] hover:bg-[var(--fiori-bg-hover)] font-normal'
                                        }`}
                                      >
                                        <span className="flex items-center gap-2 min-w-0">
                                          <SubIcon
                                            className={`w-3.5 h-3.5 shrink-0 ${
                                              isSubActive
                                                ? 'text-[var(--fiori-brand)]'
                                                : 'text-[var(--fiori-text-muted)]'
                                            }`}
                                          />
                                          <span className="truncate">{sub.label}</span>
                                        </span>
                                        {subBadge && (
                                          <span
                                            className={`px-1.5 py-0.5 rounded-[var(--fiori-radius-sm)] text-[10px] font-medium tabular-nums shrink-0 ${
                                              sub.badgeTone === 'warning'
                                                ? 'bg-[var(--fiori-critical-bg)] text-[var(--fiori-critical)]'
                                                : 'bg-[var(--fiori-neutral-bg)] text-[var(--fiori-text-secondary)]'
                                            }`}
                                          >
                                            {subBadge}
                                          </span>
                                        )}
                                      </button>
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}

            {searchNormalized &&
              accessibleGroups.every(
                g =>
                  !g.items.some(
                    it =>
                      it.label.toLowerCase().includes(searchNormalized) ||
                      it.keywords.toLowerCase().includes(searchNormalized) ||
                      (it.subItems || []).some(
                        s =>
                          s.label.toLowerCase().includes(searchNormalized) ||
                          s.keywords.toLowerCase().includes(searchNormalized)
                      )
                  )
              ) && (
                <div className="px-2 py-4 text-center text-xs text-[var(--fiori-text-muted)]">
                  ماژول یا صفحه‌ای با این عبارت یافت نشد.
                </div>
              )}
          </nav>
        </div>

        {/* Footer Context: Role Visibility & System Identity */}
        {!isRailCollapsed && (
          <div className="px-3 py-2 border-t border-[var(--fiori-border-subtle)] bg-[var(--fiori-bg-subtle)] text-[11px] text-[var(--fiori-text-secondary)] flex items-center justify-between gap-2 shrink-0">
            <span className="truncate font-medium">
              نقش: {roleLabels[currentUser.role] || currentUser.role}
            </span>
            <span className="text-[10px] text-[var(--fiori-text-muted)] shrink-0 font-mono">
              KPIMS
            </span>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {/* Desktop Persistent & Collapsible Side Navigation Rail */}
      <aside
        id="kpims-desktop-side-nav"
        aria-label="ناوبری جانبی"
        className={`hidden md:flex flex-col shrink-0 bg-[var(--fiori-bg-surface)] border-l border-[var(--fiori-border-default)] sticky top-12 h-[calc(100vh-3rem)] transition-[width] duration-200 z-30 ${
          collapsed ? 'w-16' : 'w-64'
        }`}
      >
        {renderNavigationTree(collapsed, false)}
      </aside>

      {/* Mobile / Tablet Slide-Over RTL Drawer */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex" dir="rtl">
          <div
            className="fixed inset-0 bg-[#1d2d3e]/40 backdrop-blur-[1px]"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <aside
            id="kpims-mobile-side-nav"
            role="dialog"
            aria-modal="true"
            aria-label="منوی ناوبری سامانه"
            className="relative z-10 w-72 max-w-[85vw] h-full bg-[var(--fiori-bg-surface)] border-l border-[var(--fiori-border-default)] shadow-2xl flex flex-col"
          >
            {renderNavigationTree(false, true)}
          </aside>
        </div>
      )}
    </>
  );
};
