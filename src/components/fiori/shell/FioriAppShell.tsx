import React, { useState } from 'react';
import { Part, UserRoleProfile } from '../../../types/inventory';
import { CloudSyncCheckResult } from '../../../types/dbSync';
import { RouteNavigateParams, useErpRouter } from '../../../context/RouterContext';
import { usePersistedOpen } from '../../../hooks/usePersistedCollapse';
import { TabKey } from '../../Sidebar';
import { FioriShellBar } from './FioriShellBar';
import { FioriSideNavigation } from './FioriSideNavigation';
import { ShellNavMetrics } from './navigationConfig';

export interface FioriAppShellProps {
  currentUser: UserRoleProfile;
  parts?: Part[];
  partsCount?: number;
  coilsCount?: number;
  plansCount?: number;
  reorderAlertsCount?: number;
  loading: boolean;
  onRoleChange: (role: UserRoleProfile['role']) => void;
  onSelectUser?: (uid: string) => void;
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
  children: React.ReactNode;
}

export const FioriAppShell: React.FC<FioriAppShellProps> = ({
  currentUser,
  parts = [],
  partsCount,
  coilsCount = 0,
  plansCount = 0,
  reorderAlertsCount = 0,
  loading,
  onRoleChange,
  onSelectUser,
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
  children,
}) => {
  const router = useErpRouter();
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistedOpen(
    'fiori_shell_sidebar_collapsed',
    false
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const handleNavigateRoute = (params: RouteNavigateParams) => {
    router.navigate({
      moId: null,
      timelineMoId: null,
      modal: null,
      docQuery: null,
      ...params,
    });
  };

  const navMetrics: ShellNavMetrics = {
    partsCount: partsCount ?? parts.length,
    coilsCount,
    plansCount,
    reorderAlertsCount,
  };

  return (
    <div
      dir="rtl"
      className="min-h-screen bg-[var(--fiori-bg-canvas)] text-[var(--fiori-text-primary)] flex flex-col font-sans selection:bg-[var(--fiori-brand)] selection:text-white"
    >
      <FioriShellBar
        route={router.route}
        currentUser={currentUser}
        parts={parts}
        coilsCount={coilsCount}
        reorderAlertsCount={reorderAlertsCount}
        loading={loading}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
        mobileNavOpen={mobileNavOpen}
        onToggleMobileNav={() => setMobileNavOpen(prev => !prev)}
        onRoleChange={onRoleChange}
        onSelectUser={onSelectUser}
        onNavigateRoute={handleNavigateRoute}
        onLegacyNavigate={onLegacyNavigate}
        onOpenTemplateModal={onOpenTemplateModal}
        onOpenAiAssistant={onOpenAiAssistant}
        onSeedDemo={onSeedDemo}
        onCleanDemo={onCleanDemo}
        onOpenErpModal={onOpenErpModal}
        onOpenHelpModal={onOpenHelpModal}
        cloudSyncCheck={cloudSyncCheck}
        autoCheckCloudUpdates={autoCheckCloudUpdates}
        cloudSyncBusy={cloudSyncBusy}
        onToggleAutoCloudCheck={onToggleAutoCloudCheck}
        onCheckCloudUpdates={onCheckCloudUpdates}
        onCloudPull={onCloudPull}
        onCloudPush={onCloudPush}
      />

      <div className="flex-1 flex min-w-0">
        <FioriSideNavigation
          route={router.route}
          currentUser={currentUser}
          metrics={navMetrics}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
          mobileOpen={mobileNavOpen}
          onCloseMobile={() => setMobileNavOpen(false)}
          onNavigate={handleNavigateRoute}
          onOpenAiAssistant={onOpenAiAssistant}
        />

        <main id="kpims-main-content" className="flex-1 min-w-0 overflow-x-hidden">
          <div className="max-w-[1440px] mx-auto w-full px-3 py-3 sm:px-5 sm:py-4 space-y-2.5">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
};
