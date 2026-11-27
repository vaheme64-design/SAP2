import React from 'react';
import {
  LayoutDashboard,
  Hammer,
  GitCommit,
  Boxes,
  CalendarDays,
  FileSignature,
  Layers,
  ScrollText,
  Wrench,
  FileSpreadsheet,
  Settings,
  Search,
  BellRing,
  FileText,
  Disc,
  Truck,
  Sparkles,
  Cpu,
  Printer,
  ListTree,
  FolderTree,
  GitBranch,
  Settings2,
  Building,
  Warehouse,
  Car,
  ShieldCheck,
  Scale,
  Upload,
  TrendingUp,
  Activity,
  UserCheck,
  Database,
  Clock,
  BarChart3,
  BookOpen,
} from 'lucide-react';
import { UserRoleProfile } from '../../../types/inventory';
import { TabKey } from '../../Sidebar';
import { RouteNavigateParams, RouteState } from '../../../context/RouterContext';
import { toPersianDigits } from '../../../utils/formatters';

export type ShellNavGroupId = 'overview' | 'daily_ops' | 'planning_supply' | 'master_admin';

export type ShellBadgeMetricKey = 'partsCount' | 'coilsCount' | 'plansCount' | 'reorderAlertsCount';

export interface ShellNavSubItem {
  id: string;
  label: string;
  keywords: string;
  icon: React.ComponentType<{ className?: string }>;
  routeParams: RouteNavigateParams;
  isActive: (route: RouteState) => boolean;
  badgeKey?: ShellBadgeMetricKey;
  badgeTone?: 'neutral' | 'warning';
}

export interface ShellNavItem {
  id: string;
  tab: TabKey;
  label: string;
  shortLabel: string;
  keywords: string;
  icon: React.ComponentType<{ className?: string }>;
  roles: Array<UserRoleProfile['role']>;
  routeParams: RouteNavigateParams;
  badgeKey?: ShellBadgeMetricKey;
  badgeSuffix?: string;
  badgeTone?: 'neutral' | 'warning';
  subItems?: ShellNavSubItem[];
}

export interface ShellNavGroup {
  id: ShellNavGroupId;
  title: string;
  defaultExpanded: boolean;
  items: ShellNavItem[];
}

export interface ShellNavMetrics {
  partsCount?: number;
  coilsCount?: number;
  plansCount?: number;
  reorderAlertsCount?: number;
}

const ALL_ROLES: Array<UserRoleProfile['role']> = [
  'ADMIN',
  'PRODUCTION_MANAGER',
  'WAREHOUSE_KEEPER',
  'LINE_SUPERVISOR',
  'QC_INSPECTOR',
];

export const SHELL_NAV_GROUPS: ShellNavGroup[] = [
  {
    id: 'overview',
    title: 'نمای کلی',
    defaultExpanded: true,
    items: [
      {
        id: 'nav-dashboard',
        tab: 'dashboard',
        label: 'لانچ‌پد و پیشخوان کارخانه',
        shortLabel: 'لانچ‌پد Fiori',
        keywords: 'داشبورد خانه پیشخوان خلاصه وضعیت روزانه launchpad',
        icon: LayoutDashboard,
        roles: ALL_ROLES,
        routeParams: {
          tab: 'dashboard',
          moId: null,
          timelineMoId: null,
          modal: null,
          docQuery: null,
        },
      },
    ],
  },
  {
    id: 'daily_ops',
    title: 'عملیات روزانه',
    defaultExpanded: true,
    items: [
      {
        id: 'nav-production',
        tab: 'production',
        label: 'خط تولید و دستورات ساخت (PP)',
        shortLabel: 'سفارشات تولید (PP)',
        keywords: 'تولید دستورات ساخت mo سرکلاف پرسکاری کارگاه دیسپچ قبض',
        icon: Hammer,
        roles: ['ADMIN', 'PRODUCTION_MANAGER', 'LINE_SUPERVISOR', 'QC_INSPECTOR'],
        routeParams: {
          tab: 'production',
          productionViewMode: 'ERP_WORKBENCH',
          productionModuleTab: 'MANUFACTURING_ORDERS_LIST',
          moId: null,
          timelineMoId: null,
          docQuery: null,
        },
        subItems: [
          {
            id: 'prod-shop-floor',
            label: 'کنسول اجرای کارگاه و توقفات',
            keywords: 'اجرای کارگاه shop floor اپراتور شروع توقف تکمیل',
            icon: Hammer,
            routeParams: {
              tab: 'production',
              productionViewMode: 'ERP_WORKBENCH',
              productionModuleTab: 'SHOP_FLOOR_EXECUTION',
              moId: null,
            },
            isActive: route =>
              route.tab === 'production' &&
              route.productionViewMode === 'ERP_WORKBENCH' &&
              route.productionModuleTab === 'SHOP_FLOOR_EXECUTION',
          },
          {
            id: 'prod-orders',
            label: 'مدیریت دستورات ساخت (MO)',
            keywords: 'لیست دستورات ساخت mo فیلتر وضعیت پیشرفت سرکلاف',
            icon: Layers,
            routeParams: {
              tab: 'production',
              productionViewMode: 'ERP_WORKBENCH',
              productionModuleTab: 'MANUFACTURING_ORDERS_LIST',
              moId: null,
            },
            isActive: route =>
              route.tab === 'production' &&
              route.productionViewMode === 'ERP_WORKBENCH' &&
              route.productionModuleTab === 'MANUFACTURING_ORDERS_LIST',
          },
          {
            id: 'prod-matrix',
            label: 'برنامه و مراحل تولید (OP)',
            keywords: 'زمان بندی ماتریس پرسکاری شیفت صبح عصر شب',
            icon: CalendarDays,
            routeParams: {
              tab: 'production',
              productionViewMode: 'ERP_WORKBENCH',
              productionModuleTab: 'MULTI_PART_SCHEDULER',
              moId: null,
            },
            isActive: route =>
              route.tab === 'production' &&
              route.productionViewMode === 'ERP_WORKBENCH' &&
              route.productionModuleTab === 'MULTI_PART_SCHEDULER',
          },
          {
            id: 'prod-dispatch',
            label: 'برگه کار روزانه شیفت',
            keywords: 'کاربرگ دیسپچ پرینت چاپ برگه شیفت اپراتور',
            icon: Printer,
            routeParams: {
              tab: 'production',
              productionViewMode: 'ERP_WORKBENCH',
              productionModuleTab: 'DAILY_DISPATCH_SHEET',
              moId: null,
            },
            isActive: route =>
              route.tab === 'production' &&
              route.productionViewMode === 'ERP_WORKBENCH' &&
              route.productionModuleTab === 'DAILY_DISPATCH_SHEET',
          },
          {
            id: 'prod-wip-tracker',
            label: 'موجودی پای خط (WIP)',
            keywords: 'رهگیری کار در جریان wip op گلوگاه پالت پای خط',
            icon: GitCommit,
            routeParams: {
              tab: 'production',
              productionViewMode: 'ERP_WORKBENCH',
              productionModuleTab: 'LIVE_WIP_OP_TRACKER',
              moId: null,
            },
            isActive: route =>
              route.tab === 'production' &&
              route.productionViewMode === 'ERP_WORKBENCH' &&
              route.productionModuleTab === 'LIVE_WIP_OP_TRACKER',
          },
          {
            id: 'prod-oee',
            label: 'گزارش‌های OEE و بهره‌وری',
            keywords: 'گزارش oee راندمان تولید خط پرسکاری',
            icon: Activity,
            routeParams: {
              tab: 'production',
              productionViewMode: 'ERP_WORKBENCH',
              productionModuleTab: 'KPI_OEE_REPORTS',
              moId: null,
            },
            isActive: route =>
              route.tab === 'production' &&
              route.productionViewMode === 'ERP_WORKBENCH' &&
              route.productionModuleTab === 'KPI_OEE_REPORTS',
          },
          {
            id: 'prod-projections',
            label: 'پیش‌بینی مصرف مواد اولیه',
            keywords: 'پیش بینی مصرف ورق مواد اولیه برنامه تولید',
            icon: TrendingUp,
            routeParams: {
              tab: 'production',
              productionViewMode: 'ERP_WORKBENCH',
              productionModuleTab: 'MATERIAL_REQUIREMENT_PROJECTION',
              moId: null,
            },
            isActive: route =>
              route.tab === 'production' &&
              route.productionViewMode === 'ERP_WORKBENCH' &&
              route.productionModuleTab === 'MATERIAL_REQUIREMENT_PROJECTION',
          },
          {
            id: 'prod-timeline',
            label: 'تایم‌لاین درختی ساخت',
            keywords: 'تایم لاین درختی برنامه زمانی تولید',
            icon: Clock,
            routeParams: {
              tab: 'production',
              productionViewMode: 'ERP_WORKBENCH',
              productionModuleTab: 'TREE_TIMELINE_REPORT',
              moId: null,
            },
            isActive: route =>
              route.tab === 'production' &&
              route.productionViewMode === 'ERP_WORKBENCH' &&
              route.productionModuleTab === 'TREE_TIMELINE_REPORT',
          },
          {
            id: 'prod-workflow',
            label: 'نقشه گردش کار SAP PP',
            keywords: 'گردش کار sap pp مستند تولید',
            icon: BookOpen,
            routeParams: {
              tab: 'production',
              productionViewMode: 'ERP_WORKBENCH',
              productionModuleTab: 'SAP_PP_WORKFLOW',
              moId: null,
            },
            isActive: route =>
              route.tab === 'production' &&
              route.productionViewMode === 'ERP_WORKBENCH' &&
              route.productionModuleTab === 'SAP_PP_WORKFLOW',
          },
          {
            id: 'prod-vouchers',
            label: 'ثبت قبض تکی کارگاه (MIGO)',
            keywords: 'اسناد کارگاهی ثبت تولید سالم ضایعات قبض حواله',
            icon: FileText,
            routeParams: {
              tab: 'production',
              productionViewMode: 'VOUCHERS',
              moId: null,
            },
            isActive: route => route.tab === 'production' && route.productionViewMode === 'VOUCHERS',
          },
        ],
      },
      {
        id: 'nav-wip',
        tab: 'wip',
        label: 'جریان قطعات در ساخت (WIP)',
        shortLabel: 'جریان ساخت (WIP)',
        keywords: 'جریان ساخت wip کارتابل گلوگاه رهگیری حواله ایستگاه',
        icon: GitCommit,
        roles: ['ADMIN', 'PRODUCTION_MANAGER', 'LINE_SUPERVISOR', 'QC_INSPECTOR'],
        routeParams: {
          tab: 'wip',
          wipSubTab: 'UNIFIED_DIRECTORY',
          moId: null,
          docQuery: null,
        },
        subItems: [
          {
            id: 'wip-unified',
            label: 'میز کار یکپارچه کارگاه و WIP',
            keywords: 'میز کار یکپارچه wip کارگاه عملیات',
            icon: LayoutDashboard,
            routeParams: { tab: 'wip', wipSubTab: 'UNIFIED_DIRECTORY', moId: null },
            isActive: route => route.tab === 'wip' && (!route.wipSubTab || route.wipSubTab === 'UNIFIED_DIRECTORY'),
          },
          {
            id: 'wip-orders',
            label: 'کارت دستورات تولید (MO)',
            keywords: 'کارت دستورات کار mo عملیات',
            icon: Layers,
            routeParams: { tab: 'wip', wipSubTab: 'ORDERS', moId: null },
            isActive: route => route.tab === 'wip' && route.wipSubTab === 'ORDERS',
          },
          {
            id: 'wip-bottleneck',
            label: 'تحلیل گلوگاه‌های تولید',
            keywords: 'گلوگاه صف ایستگاه تولید توقف',
            icon: Activity,
            routeParams: { tab: 'wip', wipSubTab: 'BOTTLENECK', moId: null },
            isActive: route => route.tab === 'wip' && route.wipSubTab === 'BOTTLENECK',
          },
          {
            id: 'wip-traceability',
            label: 'رهگیری سری ساخت و کلاف',
            keywords: 'رهگیری سری ساخت کلاف ذوب بچ',
            icon: Search,
            routeParams: { tab: 'wip', wipSubTab: 'TRACEABILITY', moId: null },
            isActive: route => route.tab === 'wip' && route.wipSubTab === 'TRACEABILITY',
          },
          {
            id: 'wip-transfers',
            label: 'حواله‌های بین‌ایستگاهی WIP',
            keywords: 'حواله انتقال بین ایستگاهی پالت',
            icon: Truck,
            routeParams: { tab: 'wip', wipSubTab: 'TRANSFERS', moId: null },
            isActive: route => route.tab === 'wip' && route.wipSubTab === 'TRANSFERS',
          },
          {
            id: 'wip-stages',
            label: 'ایستگاه‌ها و موجودی پای کار',
            keywords: 'ایستگاه موجودی پای کار خط تولید',
            icon: Boxes,
            routeParams: { tab: 'wip', wipSubTab: 'STAGES', moId: null },
            isActive: route => route.tab === 'wip' && route.wipSubTab === 'STAGES',
          },
          {
            id: 'wip-dashboard',
            label: 'داشبورد شاخص‌های WIP',
            keywords: 'داشبورد شاخص کار در جریان',
            icon: BarChart3,
            routeParams: { tab: 'wip', wipSubTab: 'DASHBOARD', moId: null },
            isActive: route => route.tab === 'wip' && route.wipSubTab === 'DASHBOARD',
          },
        ],
      },
      {
        id: 'nav-inventory',
        tab: 'inventory',
        label: 'انبار، کالا و کنترل کیفیت (MM/QM)',
        shortLabel: 'انبار و کیفیت (MM/QM)',
        keywords: 'انبار موجودی ورق رول کویل کاردکس اسناد حواله رسید کنترل کیفیت qm',
        icon: Boxes,
        roles: ALL_ROLES,
        badgeKey: 'reorderAlertsCount',
        badgeTone: 'warning',
        routeParams: {
          tab: 'inventory',
          inventorySubTab: 'DASHBOARD',
          moId: null,
          docQuery: null,
        },
        subItems: [
          {
            id: 'inv-dashboard',
            label: 'پیشخوان و ثبت رسید و حواله',
            keywords: 'پیشخوان انبار رسید حواله برگشت انتقال',
            icon: Boxes,
            routeParams: { tab: 'inventory', inventorySubTab: 'DASHBOARD', docQuery: null },
            isActive: route => route.tab === 'inventory' && route.inventorySubTab === 'DASHBOARD',
          },
          {
            id: 'inv-inquiry',
            label: 'موجودی لحظه‌ای و کاردکس کالا',
            keywords: 'استعلام موجودی فیلتر ضخامت جنس ورق کاردکس',
            icon: Search,
            routeParams: { tab: 'inventory', inventorySubTab: 'INQUIRY', docQuery: null },
            isActive: route => route.tab === 'inventory' && route.inventorySubTab === 'INQUIRY',
          },
          {
            id: 'inv-movement',
            label: 'اسناد و حواله‌های انبار (MIGO)',
            keywords: 'اسناد گردش انبار کاردکس migo ابطال سند',
            icon: FileText,
            routeParams: { tab: 'inventory', inventorySubTab: 'MOVEMENT', docQuery: null },
            isActive: route => route.tab === 'inventory' && route.inventorySubTab === 'MOVEMENT',
          },
          {
            id: 'inv-coils',
            label: 'مدیریت رول‌ها و کویل‌پک',
            keywords: 'رول ورق کویل پک کلاف برش سرکلاف',
            icon: Layers,
            badgeKey: 'coilsCount',
            badgeTone: 'neutral',
            routeParams: { tab: 'inventory', inventorySubTab: 'COILS', docQuery: null },
            isActive: route => route.tab === 'inventory' && route.inventorySubTab === 'COILS',
          },
          {
            id: 'inv-qm',
            label: 'کنترل کیفیت و قرنطینه (QM)',
            keywords: 'کنترل کیفیت قرنطینه تایید مصرف ud qm بازرسی',
            icon: ShieldCheck,
            routeParams: { tab: 'inventory', inventorySubTab: 'QUALITY_QM', docQuery: null },
            isActive: route => route.tab === 'inventory' && route.inventorySubTab === 'QUALITY_QM',
          },
          {
            id: 'inv-alerts',
            label: 'هشدارهای نقطه سفارش (ROP)',
            keywords: 'هشدار کسری نقطه سفارش حداقل موجودی reorder',
            icon: BellRing,
            badgeKey: 'reorderAlertsCount',
            badgeTone: 'warning',
            routeParams: { tab: 'inventory', inventorySubTab: 'ALERTS', docQuery: null },
            isActive: route => route.tab === 'inventory' && route.inventorySubTab === 'ALERTS',
          },
          {
            id: 'inv-contracts',
            label: 'انبار امانی قراردادها',
            keywords: 'قرارداد امانی سهمیه انبار',
            icon: FileSignature,
            routeParams: { tab: 'inventory', inventorySubTab: 'CONTRACTS', docQuery: null },
            isActive: route => route.tab === 'inventory' && route.inventorySubTab === 'CONTRACTS',
          },
          {
            id: 'inv-sapco',
            label: 'حساب مواد امانی ساپکو',
            keywords: 'مواد ساپکو امانی حساب کلاف',
            icon: Disc,
            routeParams: { tab: 'inventory', inventorySubTab: 'SAPCO', docQuery: null },
            isActive: route => route.tab === 'inventory' && route.inventorySubTab === 'SAPCO',
          },
          {
            id: 'inv-stages',
            label: 'موجودی مراحل تولید',
            keywords: 'موجودی مراحل ایستگاه انبار نیمه ساخته',
            icon: GitCommit,
            routeParams: { tab: 'inventory', inventorySubTab: 'STAGES', docQuery: null },
            isActive: route => route.tab === 'inventory' && route.inventorySubTab === 'STAGES',
          },
          {
            id: 'inv-reconciliation',
            label: 'انبارگردانی و تطبیق موجودی',
            keywords: 'انبارگردانی شمارش تطبیق مغایرت موجودی',
            icon: Scale,
            routeParams: { tab: 'inventory', inventorySubTab: 'RECONCILIATION', docQuery: null },
            isActive: route => route.tab === 'inventory' && route.inventorySubTab === 'RECONCILIATION',
          },
          {
            id: 'inv-custom-reports',
            label: 'گزارش‌ساز سفارشی انبار',
            keywords: 'گزارش سفارشی ستون اکسل',
            icon: FileSpreadsheet,
            routeParams: { tab: 'inventory', inventorySubTab: 'CUSTOM_REPORTS', docQuery: null },
            isActive: route => route.tab === 'inventory' && route.inventorySubTab === 'CUSTOM_REPORTS',
          },
          {
            id: 'inv-import-export',
            label: 'ورود و خروج اکسل (CSV)',
            keywords: 'اکسل csv ایمپورت اکسپورت ورود اطلاعات',
            icon: Upload,
            routeParams: { tab: 'inventory', inventorySubTab: 'IMPORT_EXPORT', docQuery: null },
            isActive: route => route.tab === 'inventory' && route.inventorySubTab === 'IMPORT_EXPORT',
          },
        ],
      },
    ],
  },
  {
    id: 'planning_supply',
    title: 'برنامه‌ریزی و تأمین',
    defaultExpanded: true,
    items: [
      {
        id: 'nav-planning',
        tab: 'planning',
        label: 'برنامه‌ریزی تولید و MRP',
        shortLabel: 'برنامه‌ریزی و MRP',
        keywords: 'برنامه ریزی تولید نیازسنجی mrp ظرفیت ماشین آلات سفارشات مشتری',
        icon: CalendarDays,
        roles: ['ADMIN', 'PRODUCTION_MANAGER', 'WAREHOUSE_KEEPER'],
        badgeKey: 'plansCount',
        badgeTone: 'neutral',
        routeParams: {
          tab: 'planning',
          planningSubTab: 'erp_workbench',
          moId: null,
          docQuery: null,
        },
        subItems: [
          {
            id: 'plan-workbench',
            label: 'میز کار برنامه‌ریزی',
            keywords: 'میز کار برنامه ریزی تولید',
            icon: LayoutDashboard,
            routeParams: { tab: 'planning', planningSubTab: 'erp_workbench' },
            isActive: route => route.tab === 'planning' && route.planningSubTab === 'erp_workbench',
          },
          {
            id: 'plan-mrp',
            label: 'موتور نیازسنجی مواد (MRP)',
            keywords: 'انفجار مواد bom mrp کسری خرید ورق',
            icon: Cpu,
            routeParams: { tab: 'planning', planningSubTab: 'mrp' },
            isActive: route => route.tab === 'planning' && route.planningSubTab === 'mrp',
          },
          {
            id: 'plan-recommendations',
            label: 'پیشنهادات برنامه و صدور MO',
            keywords: 'پیشنهاد برنامه خرید مواد صدور دستور ساخت',
            icon: Sparkles,
            routeParams: { tab: 'planning', planningSubTab: 'recommendations' },
            isActive: route => route.tab === 'planning' && route.planningSubTab === 'recommendations',
          },
          {
            id: 'plan-capacity',
            label: 'تقویم ظرفیت ماشین‌آلات',
            keywords: 'ظرفیت ماشین آلات پرس تداخل زمانی',
            icon: CalendarDays,
            routeParams: { tab: 'planning', planningSubTab: 'capacity_planning' },
            isActive: route => route.tab === 'planning' && route.planningSubTab === 'capacity_planning',
          },
          {
            id: 'plan-daily',
            label: 'برنامه شیفت و خط روزانه',
            keywords: 'برنامه روزانه شیفت خط پرسکاری',
            icon: Clock,
            routeParams: { tab: 'planning', planningSubTab: 'daily_schedule' },
            isActive: route => route.tab === 'planning' && route.planningSubTab === 'daily_schedule',
          },
          {
            id: 'plan-orders',
            label: 'سفارشات مشتری و تعهدات',
            keywords: 'سفارش مشتری ساپکو تعهد تحویل',
            icon: Truck,
            routeParams: { tab: 'planning', planningSubTab: 'orders' },
            isActive: route => route.tab === 'planning' && route.planningSubTab === 'orders',
          },
          {
            id: 'plan-approved',
            label: 'برنامه‌های تاییدشده تولید',
            keywords: 'برنامه تایید شده مصوب تولید',
            icon: ShieldCheck,
            routeParams: { tab: 'planning', planningSubTab: 'approved_plans' },
            isActive: route => route.tab === 'planning' && route.planningSubTab === 'approved_plans',
          },
          {
            id: 'plan-consumables',
            label: 'پیش‌بینی مصرف‌شدنی‌ها',
            keywords: 'مصرف شدنی ابزار روانکار مواد کمکی',
            icon: Wrench,
            routeParams: { tab: 'planning', planningSubTab: 'consumables' },
            isActive: route => route.tab === 'planning' && route.planningSubTab === 'consumables',
          },
          {
            id: 'plan-dashboard',
            label: 'داشبورد شاخص‌های برنامه‌ریزی',
            keywords: 'داشبورد برنامه ریزی شاخص',
            icon: BarChart3,
            routeParams: { tab: 'planning', planningSubTab: 'dashboard' },
            isActive: route => route.tab === 'planning' && route.planningSubTab === 'dashboard',
          },
          {
            id: 'plan-workflow-doc',
            label: 'مستندات فرآیند برنامه‌ریزی',
            keywords: 'مستند گردش کار برنامه ریزی',
            icon: BookOpen,
            routeParams: { tab: 'planning', planningSubTab: 'workflow_doc' },
            isActive: route => route.tab === 'planning' && route.planningSubTab === 'workflow_doc',
          },
        ],
      },
      {
        id: 'nav-contracts',
        tab: 'contracts',
        label: 'قراردادها و سفارشات مشتری (SD)',
        shortLabel: 'فروش و قراردادها (SD)',
        keywords: 'قرارداد فروش مشتری ساپکو سهمیه تعهد تحویل sd',
        icon: FileSignature,
        roles: ['ADMIN', 'PRODUCTION_MANAGER', 'WAREHOUSE_KEEPER'],
        routeParams: {
          tab: 'contracts',
          contractsSubTab: 'CONTRACTS_QUOTAS',
          moId: null,
          docQuery: null,
        },
        subItems: [
          {
            id: 'contracts-quotas',
            label: 'قراردادها و سهمیه‌های تامین',
            keywords: 'قرارداد سهمیه ورق امانی ساپکو',
            icon: FileSignature,
            routeParams: { tab: 'contracts', contractsSubTab: 'CONTRACTS_QUOTAS' },
            isActive: route =>
              route.tab === 'contracts' &&
              (!route.contractsSubTab || route.contractsSubTab === 'CONTRACTS_QUOTAS'),
          },
          {
            id: 'contracts-orders',
            label: 'سفارشات تحویل به مشتری',
            keywords: 'سفارش مشتری برنامه تحویل sd',
            icon: Truck,
            routeParams: { tab: 'contracts', contractsSubTab: 'CUSTOMER_ORDERS' },
            isActive: route => route.tab === 'contracts' && route.contractsSubTab === 'CUSTOMER_ORDERS',
          },
        ],
      },
      {
        id: 'nav-sapco',
        tab: 'sapco',
        label: 'رول‌ها و مواد امانی ساپکو',
        shortLabel: 'مواد ساپکو',
        keywords: 'مواد امانی ساپکو رول کویل شماره ذوب heat',
        icon: Disc,
        roles: ['ADMIN', 'WAREHOUSE_KEEPER', 'PRODUCTION_MANAGER', 'QC_INSPECTOR'],
        badgeKey: 'coilsCount',
        badgeSuffix: ' رول',
        badgeTone: 'neutral',
        routeParams: {
          tab: 'sapco',
          moId: null,
          docQuery: null,
        },
      },
    ],
  },
  {
    id: 'master_admin',
    title: 'اطلاعات پایه و مدیریت',
    defaultExpanded: false,
    items: [
      {
        id: 'nav-master-data',
        tab: 'master_data',
        label: 'اطلاعات پایه و درخت محصول',
        shortLabel: 'اطلاعات پایه و BOM',
        keywords: 'اطلاعات پایه کالا قطعه bom مسیر ساخت روتینگ سالن انبار مدل خودرو',
        icon: ScrollText,
        roles: ['ADMIN', 'PRODUCTION_MANAGER', 'WAREHOUSE_KEEPER'],
        badgeKey: 'partsCount',
        badgeTone: 'neutral',
        routeParams: {
          tab: 'master_data',
          masterSubSection: 'PARTS',
          moId: null,
          docQuery: null,
        },
        subItems: [
          {
            id: 'mst-parts',
            label: 'کاتالوگ قطعات و اقلام',
            keywords: 'قطعه کالا محصول پارت نامبر کد فنی',
            icon: Boxes,
            routeParams: { tab: 'master_data', masterSubSection: 'PARTS' },
            isActive: route => route.tab === 'master_data' && (!route.masterSubSection || route.masterSubSection === 'PARTS'),
          },
          {
            id: 'mst-bom',
            label: 'درخت محصول چندسطحی (BOM)',
            keywords: 'درخت محصول bom ضریب مصرف مواد',
            icon: ListTree,
            routeParams: { tab: 'master_data', masterSubSection: 'BOM' },
            isActive: route => route.tab === 'master_data' && route.masterSubSection === 'BOM',
          },
          {
            id: 'mst-tree',
            label: 'نمودار درختی ساختار محصول',
            keywords: 'گراف درختی ساختار محصول',
            icon: FolderTree,
            routeParams: { tab: 'master_data', masterSubSection: 'PRODUCT_STRUCTURE' },
            isActive: route => route.tab === 'master_data' && route.masterSubSection === 'PRODUCT_STRUCTURE',
          },
          {
            id: 'mst-routings',
            label: 'مسیرهای ساخت و روتینگ',
            keywords: 'مسیر ساخت توالی عملیات روتینگ',
            icon: GitBranch,
            routeParams: { tab: 'master_data', masterSubSection: 'ROUTINGS' },
            isActive: route => route.tab === 'master_data' && route.masterSubSection === 'ROUTINGS',
          },
          {
            id: 'mst-operations',
            label: 'عملیات‌های استاندارد تولید',
            keywords: 'عملیات استاندارد زمان چرخه smed',
            icon: Settings2,
            routeParams: { tab: 'master_data', masterSubSection: 'OPERATIONS' },
            isActive: route => route.tab === 'master_data' && route.masterSubSection === 'OPERATIONS',
          },
          {
            id: 'mst-machines',
            label: 'پرس‌ها و ماشین‌آلات',
            keywords: 'پرس هیدرولیک ضربه ای تناژ دستگاه',
            icon: Cpu,
            routeParams: { tab: 'master_data', masterSubSection: 'MACHINES' },
            isActive: route => route.tab === 'master_data' && route.masterSubSection === 'MACHINES',
          },
          {
            id: 'mst-dies',
            label: 'قالب‌ها و سنبه/ماتریس',
            keywords: 'قالب کشش برش خم سنبه ماتریس',
            icon: Wrench,
            routeParams: { tab: 'master_data', masterSubSection: 'DIES' },
            isActive: route => route.tab === 'master_data' && route.masterSubSection === 'DIES',
          },
          {
            id: 'mst-halls',
            label: 'سالن‌های استقرار و خطوط',
            keywords: 'سالن تولید خط پرس جوشکاری',
            icon: Building,
            routeParams: { tab: 'master_data', masterSubSection: 'FACTORY_HALLS' },
            isActive: route => route.tab === 'master_data' && route.masterSubSection === 'FACTORY_HALLS',
          },
          {
            id: 'mst-warehouses',
            label: 'انبارها و موقعیت‌ها',
            keywords: 'انبار موقعیت قفسه',
            icon: Warehouse,
            routeParams: { tab: 'master_data', masterSubSection: 'WAREHOUSES' },
            isActive: route => route.tab === 'master_data' && route.masterSubSection === 'WAREHOUSES',
          },
          {
            id: 'mst-carmodels',
            label: 'مدل‌های خودرو ساپکو',
            keywords: 'مدل خودرو پژو تارا دنا شاهین',
            icon: Car,
            routeParams: { tab: 'master_data', masterSubSection: 'CAR_MODELS' },
            isActive: route => route.tab === 'master_data' && route.masterSubSection === 'CAR_MODELS',
          },
        ],
      },
      {
        id: 'nav-machines',
        tab: 'machines',
        label: 'ماشین‌آلات، قالب‌ها و نت (PM)',
        shortLabel: 'ماشین‌آلات و نت',
        keywords: 'ماشین آلات تجهیزات تعمیرات نگهداری نت pm قالب اپراتور oee',
        icon: Wrench,
        roles: ['ADMIN', 'PRODUCTION_MANAGER', 'LINE_SUPERVISOR'],
        routeParams: {
          tab: 'machines',
          machineSubTab: 'machines',
          moId: null,
          docQuery: null,
        },
        subItems: [
          {
            id: 'mch-machines',
            label: 'پرس‌ها و خطوط تولید',
            keywords: 'پرس هیدرولیک ضربه ای تناژ دستگاه',
            icon: Cpu,
            routeParams: { tab: 'machines', machineSubTab: 'machines' },
            isActive: route => route.tab === 'machines' && route.machineSubTab === 'machines',
          },
          {
            id: 'mch-maintenance',
            label: 'نگهداری و تعمیرات (PM)',
            keywords: 'تعمیرات نگهداری نت tpm pm خرابی پیشگیرانه',
            icon: Wrench,
            routeParams: { tab: 'machines', machineSubTab: 'maintenance' },
            isActive: route => route.tab === 'machines' && route.machineSubTab === 'maintenance',
          },
          {
            id: 'mch-dies',
            label: 'قالب‌ها و سنبه/ماتریس',
            keywords: 'قالب سنبه ماتریس عمر ضربه',
            icon: Layers,
            routeParams: { tab: 'machines', machineSubTab: 'dies' },
            isActive: route => route.tab === 'machines' && route.machineSubTab === 'dies',
          },
          {
            id: 'mch-oee',
            label: 'بهره‌وری تجهیزات (OEE)',
            keywords: 'oee بهره‌وری دسترس‌پذیری کیفیت',
            icon: Activity,
            routeParams: { tab: 'machines', machineSubTab: 'oee' },
            isActive: route => route.tab === 'machines' && route.machineSubTab === 'oee',
          },
          {
            id: 'mch-utilization',
            label: 'تحلیل بار و ظرفیت ماشین‌ها',
            keywords: 'بار ماشین آلات ظرفیت بهره برداری',
            icon: TrendingUp,
            routeParams: { tab: 'machines', machineSubTab: 'utilization' },
            isActive: route => route.tab === 'machines' && route.machineSubTab === 'utilization',
          },
          {
            id: 'mch-halls',
            label: 'سالن‌ها و خطوط تولید',
            keywords: 'سالن استقرار خط تولید',
            icon: Building,
            routeParams: { tab: 'machines', machineSubTab: 'halls' },
            isActive: route => route.tab === 'machines' && route.machineSubTab === 'halls',
          },
          {
            id: 'mch-operators',
            label: 'اپراتورها و مهارت‌ها',
            keywords: 'اپراتور پرسنل تولید مهارت',
            icon: UserCheck,
            routeParams: { tab: 'machines', machineSubTab: 'operators' },
            isActive: route => route.tab === 'machines' && route.machineSubTab === 'operators',
          },
        ],
      },
      {
        id: 'nav-reports',
        tab: 'reports',
        label: 'گزارش‌های تحلیلی و OEE',
        shortLabel: 'گزارش‌ها و OEE',
        keywords: 'گزارش مدیریتی بهای تمام شده راندمان oee ضایعات تحلیل انحراف',
        icon: FileSpreadsheet,
        roles: ['ADMIN', 'PRODUCTION_MANAGER', 'WAREHOUSE_KEEPER', 'QC_INSPECTOR'],
        routeParams: {
          tab: 'reports',
          reportSubTab: 'plan_vs_actual',
          moId: null,
          docQuery: null,
        },
        subItems: [
          {
            id: 'rep-plan-actual',
            label: 'مقایسه برنامه و عملکرد تولید',
            keywords: 'برنامه عملکرد تحقق انحراف تولید',
            icon: BarChart3,
            routeParams: { tab: 'reports', reportSubTab: 'plan_vs_actual' },
            isActive: route => route.tab === 'reports' && (!route.reportSubTab || route.reportSubTab === 'plan_vs_actual'),
          },
          {
            id: 'rep-oee',
            label: 'داشبورد شاخص OEE',
            keywords: 'oee راندمان تجهیزات توقفات',
            icon: Activity,
            routeParams: { tab: 'reports', reportSubTab: 'oee_module' },
            isActive: route => route.tab === 'reports' && route.reportSubTab === 'oee_module',
          },
          {
            id: 'rep-valuation',
            label: 'ارزش و موجودی انبار',
            keywords: 'موجودی ارزش گردش کالا انبار',
            icon: Boxes,
            routeParams: { tab: 'reports', reportSubTab: 'valuation_qty' },
            isActive: route => route.tab === 'reports' && route.reportSubTab === 'valuation_qty',
          },
          {
            id: 'rep-scrap',
            label: 'تحلیل ضایعات و علل کیفی',
            keywords: 'ضایعات خرابی کیفیت عیوب',
            icon: TrendingUp,
            routeParams: { tab: 'reports', reportSubTab: 'scrap_analysis' },
            isActive: route => route.tab === 'reports' && route.reportSubTab === 'scrap_analysis',
          },
          {
            id: 'rep-comprehensive',
            label: 'گزارش جامع تولید و انحرافات',
            keywords: 'گزارش جامع تولید کل خط',
            icon: FileSpreadsheet,
            routeParams: { tab: 'reports', reportSubTab: 'comprehensive_production' },
            isActive: route => route.tab === 'reports' && route.reportSubTab === 'comprehensive_production',
          },
        ],
      },
      {
        id: 'nav-settings',
        tab: 'settings',
        label: 'تنظیمات سیستم و دسترسی‌ها',
        shortLabel: 'کاربران و تنظیمات',
        keywords: 'کاربران دسترسی نقش rbac پایگاه داده همگام سازی تنظیمات',
        icon: Settings,
        roles: ['ADMIN'],
        routeParams: {
          tab: 'settings',
          settingsSubTab: 'rbac',
          moId: null,
          docQuery: null,
        },
        subItems: [
          {
            id: 'set-rbac',
            label: 'کاربران و سطوح دسترسی (RBAC)',
            keywords: 'کاربران نقش سطح دسترسی rbac',
            icon: ShieldCheck,
            routeParams: { tab: 'settings', settingsSubTab: 'rbac' },
            isActive: route => route.tab === 'settings' && (!route.settingsSubTab || route.settingsSubTab === 'rbac'),
          },
          {
            id: 'set-db',
            label: 'پایگاه داده و همگام‌سازی آنلاین',
            keywords: 'پایگاه داده postgresql همگام سازی sync',
            icon: Database,
            routeParams: { tab: 'settings', settingsSubTab: 'db_architecture' },
            isActive: route => route.tab === 'settings' && route.settingsSubTab === 'db_architecture',
          },
        ],
      },
    ],
  },
];

export function isRoleAuthorizedForItem(
  item: Pick<ShellNavItem, 'roles'>,
  role: UserRoleProfile['role']
): boolean {
  if (role === 'ADMIN') return true;
  return item.roles.includes(role);
}

export function getAccessibleNavGroups(
  role: UserRoleProfile['role'],
  showAllModules = false
): ShellNavGroup[] {
  return SHELL_NAV_GROUPS.map(group => ({
    ...group,
    items: showAllModules
      ? group.items
      : group.items.filter(item => isRoleAuthorizedForItem(item, role)),
  })).filter(group => group.items.length > 0);
}

export function getAccessibleNavItems(
  role: UserRoleProfile['role'],
  showAllModules = false
): ShellNavItem[] {
  return getAccessibleNavGroups(role, showAllModules).flatMap(group => group.items);
}

export function formatShellNavBadge(
  badgeKey: ShellBadgeMetricKey | undefined,
  metrics: ShellNavMetrics,
  suffix = ''
): string | null {
  if (!badgeKey) return null;
  const value = metrics[badgeKey];
  if (typeof value !== 'number' || value <= 0) return null;
  return `${toPersianDigits(value)}${suffix}`;
}

export function findActiveNavContext(route: RouteState): {
  groupId: ShellNavGroupId | null;
  item: ShellNavItem | null;
  subItem: ShellNavSubItem | null;
} {
  for (const group of SHELL_NAV_GROUPS) {
    for (const item of group.items) {
      if (item.tab === route.tab) {
        const matchedSub = item.subItems?.find(sub => sub.isActive(route)) || null;
        return {
          groupId: group.id,
          item,
          subItem: matchedSub,
        };
      }
    }
  }
  return { groupId: null, item: null, subItem: null };
}
