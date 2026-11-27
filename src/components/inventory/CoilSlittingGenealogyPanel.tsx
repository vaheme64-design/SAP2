import React, { useState, useMemo, useEffect } from 'react';
import {
  GitBranch,
  Flame,
  Scissors,
  Edit3,
  Plus,
  RotateCcw,
} from 'lucide-react';
import { PhysicalCoil } from '../../types/inventory';
import { formatNumber, toPersianDigits } from '../../utils/formatters';
import { useEnterpriseUx } from '../../context/EnterpriseUxContext';
import { useErpRouter } from '../../context/RouterContext';
import { FioriToolbar, FioriObjectStatus } from '../fiori/ui';

export interface ChildSlitNode {
  id: string;
  childCode: string;
  type: 'SLIT_STRIP' | 'BLANK_SHEET' | 'REMNANT_COIL' | 'EDGE_SCRAP';
  typeLabel: string;
  dimensionsLabel: string;
  weightKg: number;
  sheetCount?: number;
  assignedMoNumber?: string;
  targetPartName?: string;
  warehouseLocation: string;
  status: 'IN_STOCK' | 'ISSUED_TO_LINE' | 'CONSUMED' | 'SCRAP_BIN' | 'REVERSED';
  isDeleted?: boolean;
}

export interface ParentCoilSlittingTree {
  parentId: string;
  parentCoilCode: string;
  coilPackNumber: string;
  heatNumber: string;
  materialGrade: string;
  thicknessMm: number;
  originalWidthMm: number;
  originalWeightKg: number;
  supplierName: string;
  slittingDate: string;
  slittingMachine: string;
  contractNumber: string;
  children: ChildSlitNode[];
}

const INITIAL_SLITTING_TREES: ParentCoilSlittingTree[] = [
  {
    parentId: 'PC-SLIT-01',
    parentCoilCode: 'COIL-402918',
    coilPackNumber: 'PK-SAPCO-88210',
    heatNumber: 'HT-99204-A',
    materialGrade: 'ST14',
    thicknessMm: 1.5,
    originalWidthMm: 1250,
    originalWeightKg: 8400,
    supplierName: 'فولاد مبارکه اصفهان (امانی ساپکو)',
    slittingDate: '۱۴۰۴/۰۱/۱۸',
    slittingMachine: 'خط نواربری و برش رول (Slitter Line 01)',
    contractNumber: 'CNT-SAPCO-1404-108',
    children: [
      {
        id: 'CH-101',
        childCode: 'SLIT-402918-S1',
        type: 'SLIT_STRIP',
        typeLabel: 'نوار فرعی ۱ (Slit Strip)',
        dimensionsLabel: 'عرض ۳۸۰mm × ضخامت ۱.۵mm',
        weightKg: 2520,
        sheetCount: 1650,
        assignedMoNumber: 'MO-1404-0101',
        targetPartName: 'براکت نگه‌دارنده رادیاتور پژو ۲۰۶',
        warehouseLocation: 'خط پرس ۴۰۰ تن (ایستگاه OP-10)',
        status: 'ISSUED_TO_LINE',
      },
      {
        id: 'CH-102',
        childCode: 'SLIT-402918-S2',
        type: 'SLIT_STRIP',
        typeLabel: 'نوار فرعی ۲ (Slit Strip)',
        dimensionsLabel: 'عرض ۳۸۰mm × ضخامت ۱.۵mm',
        weightKg: 2520,
        sheetCount: 1650,
        assignedMoNumber: 'MO-1404-0101',
        targetPartName: 'براکت نگه‌دارنده رادیاتور پژو ۲۰۶',
        warehouseLocation: 'انبار ورق نیمه‌ساخته (RACK-B02)',
        status: 'IN_STOCK',
      },
      {
        id: 'CH-103',
        childCode: 'BLNK-402918-B3',
        type: 'BLANK_SHEET',
        typeLabel: 'بسته شیت فرعی ۳ (Blank Pack)',
        dimensionsLabel: 'ابعاد ۴۶۰×۸۰۰mm × ضخامت ۱.۵mm',
        weightKg: 2100,
        sheetCount: 980,
        assignedMoNumber: 'MO-1404-0103',
        targetPartName: 'محافظ فلزی ضدسرقت ECU پژو پارس',
        warehouseLocation: 'انبار شیت برش‌خورده (RACK-C04)',
        status: 'IN_STOCK',
      },
      {
        id: 'CH-104',
        childCode: 'REM-402918-R1',
        type: 'REMNANT_COIL',
        typeLabel: 'ته‌کلاف مادر (Remnant Coil)',
        dimensionsLabel: 'عرض ۱۲۵۰mm × ضخامت ۱.۵mm',
        weightKg: 1120,
        warehouseLocation: 'انبار رول ورق (زون ته‌کلاف A-04)',
        status: 'IN_STOCK',
      },
      {
        id: 'CH-105',
        childCode: 'SCR-402918-E1',
        type: 'EDGE_SCRAP',
        typeLabel: 'پرت کناره‌بری (Edge Trim)',
        dimensionsLabel: 'لبه نواربری ۲×۱۵mm',
        weightKg: 140,
        warehouseLocation: 'باکس ضایعات ذوبی (SCRAP-Z1)',
        status: 'SCRAP_BIN',
      },
    ],
  },
  {
    parentId: 'PC-SLIT-02',
    parentCoilCode: 'COIL-403105',
    coilPackNumber: 'PK-IKCO-77412',
    heatNumber: 'HT-88412-B',
    materialGrade: 'DC04',
    thicknessMm: 0.8,
    originalWidthMm: 1500,
    originalWeightKg: 9600,
    supplierName: 'فولاد مبارکه اصفهان (قرارداد ایپکو/ایران‌خودرو)',
    slittingDate: '۱۴۰۴/۰۱/۱۹',
    slittingMachine: 'خط برش عرضی و شیت‌کن (CTL & Slitter 02)',
    contractNumber: 'CNT-IKCO-1404-204',
    children: [
      {
        id: 'CH-201',
        childCode: 'BLNK-403105-B1',
        type: 'BLANK_SHEET',
        typeLabel: 'پالت شیت فرعی ۱ (Blank Sheet)',
        dimensionsLabel: 'ابعاد ۷۲۰×۱۲۰۰mm × ضخامت ۰.۸mm',
        weightKg: 3800,
        sheetCount: 900,
        assignedMoNumber: 'MO-1404-0102',
        targetPartName: 'پنل تقویتی ستون وسط دنا پلاس (B-Pillar)',
        warehouseLocation: 'پای خط پرس ۸۰۰ تن (OP-10)',
        status: 'ISSUED_TO_LINE',
      },
      {
        id: 'CH-202',
        childCode: 'BLNK-403105-B2',
        type: 'BLANK_SHEET',
        typeLabel: 'پالت شیت فرعی ۲ (Blank Sheet)',
        dimensionsLabel: 'ابعاد ۷۲۰×۱۲۰۰mm × ضخامت ۰.۸mm',
        weightKg: 3800,
        sheetCount: 900,
        assignedMoNumber: 'MO-1404-0107',
        targetPartName: 'پوسته گلگیر جلو چپ پژو ۲۰۷',
        warehouseLocation: 'انبار شیت آماده پرس (RACK-D01)',
        status: 'IN_STOCK',
      },
      {
        id: 'CH-203',
        childCode: 'REM-403105-R1',
        type: 'REMNANT_COIL',
        typeLabel: 'ته‌کلاف برگشتی (Remnant Coil)',
        dimensionsLabel: 'عرض ۱۵۰۰mm × ضخامت ۰.۸mm',
        weightKg: 1840,
        warehouseLocation: 'انبار رول ورق (زون A-02)',
        status: 'IN_STOCK',
      },
      {
        id: 'CH-204',
        childCode: 'SCR-403105-E1',
        type: 'EDGE_SCRAP',
        typeLabel: 'پرت سر و ته کلاف (Crop Scrap)',
        dimensionsLabel: 'پرت برش اولیه',
        weightKg: 160,
        warehouseLocation: 'باکس ضایعات ورق',
        status: 'SCRAP_BIN',
      },
    ],
  },
  {
    parentId: 'PC-SLIT-03',
    parentCoilCode: 'COIL-403590',
    coilPackNumber: 'PK-SAPCO-90114',
    heatNumber: 'HT-77519-C',
    materialGrade: 'S355MC',
    thicknessMm: 2.5,
    originalWidthMm: 1200,
    originalWeightKg: 7200,
    supplierName: 'فولاد اکسین / مبارکه (ملکی کارخانه)',
    slittingDate: '۱۴۰۴/۰۱/۲۰',
    slittingMachine: 'قیچی گیوتین ۶ متری و نواربر سنگین',
    contractNumber: 'CNT-SAPCO-1404-112',
    children: [
      {
        id: 'CH-301',
        childCode: 'SLIT-403590-S1',
        type: 'SLIT_STRIP',
        typeLabel: 'نوار فرعی تقویتی ۱',
        dimensionsLabel: 'عرض ۲۹۰mm × ضخامت ۲.۵mm',
        weightKg: 3100,
        sheetCount: 620,
        assignedMoNumber: 'MO-1404-0104',
        targetPartName: 'رام زیر موتور خودرو تارا (Crossmember)',
        warehouseLocation: 'سالن پرس سنگین - پرس ۴۰۰ تن',
        status: 'ISSUED_TO_LINE',
      },
      {
        id: 'CH-302',
        childCode: 'SLIT-403590-S2',
        type: 'SLIT_STRIP',
        typeLabel: 'نوار فرعی تقویتی ۲',
        dimensionsLabel: 'عرض ۲۹۰mm × ضخامت ۲.۵mm',
        weightKg: 3100,
        sheetCount: 620,
        assignedMoNumber: 'MO-1404-0104',
        targetPartName: 'رام زیر موتور خودرو تارا (Crossmember)',
        warehouseLocation: 'انبار میانی برش (WIP-SLIT-03)',
        status: 'IN_STOCK',
      },
      {
        id: 'CH-303',
        childCode: 'REM-403590-R1',
        type: 'REMNANT_COIL',
        typeLabel: 'ته‌کلاف مادر (Remnant)',
        dimensionsLabel: 'عرض ۱۲۰۰mm × ضخامت ۲.۵mm',
        weightKg: 890,
        warehouseLocation: 'انبار کلاف سنگین (B-01)',
        status: 'IN_STOCK',
      },
      {
        id: 'CH-304',
        childCode: 'SCR-403590-E1',
        type: 'EDGE_SCRAP',
        typeLabel: 'پرت لبه‌بری (Edge Scrap)',
        dimensionsLabel: 'لبه برش ضخامت ۲.۵mm',
        weightKg: 110,
        warehouseLocation: 'باکس ضایعات',
        status: 'SCRAP_BIN',
      },
    ],
  },
];

interface CoilSlittingGenealogyPanelProps {
  coils?: PhysicalCoil[];
  onReverseSlitting?: (parentCoilCode: string, restoredWeightKg: number) => void;
}

export const CoilSlittingGenealogyPanel: React.FC<CoilSlittingGenealogyPanelProps> = ({
  coils = [],
  onReverseSlitting,
}) => {
  const { openQuickEditDrawer, requestConfirm, showUndoToast, recordAudit } = useEnterpriseUx();
  const router = useErpRouter();

  const [treesState, setTreesState] = useState<ParentCoilSlittingTree[]>(() => {
    try {
      const saved = localStorage.getItem('kpims_coil_slitting_trees_v1');
      if (saved) return JSON.parse(saved);
    } catch {
      // ignore
    }
    return INITIAL_SLITTING_TREES;
  });

  useEffect(() => {
    try {
      localStorage.setItem('kpims_coil_slitting_trees_v1', JSON.stringify(treesState));
    } catch {
      // ignore
    }
  }, [treesState]);

  const slittingTrees = useMemo(() => {
    const dynamicTrees: ParentCoilSlittingTree[] = coils.slice(0, 2).map((c, idx) => {
      const origW = c.originalWeightKg || 6000;
      const remW = c.remainingWeightKg ?? Math.round(origW * 0.25);
      const consumedW = Math.max(500, origW - remW);
      const strip1W = Math.round(consumedW * 0.52);
      const strip2W = Math.round(consumedW * 0.44);
      const scrapW = Math.max(20, consumedW - strip1W - strip2W);

      return {
        parentId: `DYN-${c.id}`,
        parentCoilCode: c.coilId,
        coilPackNumber: c.coilPackNumber,
        heatNumber: c.heatNumber || `HT-1404-${910 + idx}`,
        materialGrade: c.materialGrade,
        thicknessMm: c.thicknessMm,
        originalWidthMm: c.widthMm || 1250,
        originalWeightKg: origW,
        supplierName: c.supplierName || 'فولاد مبارکه اصفهان',
        slittingDate: '۱۴۰۴/۰۱/۲۱',
        slittingMachine: 'خط نواربری و شیت‌کن کویل (Slitting Line)',
        contractNumber: c.allocations?.[0]?.contractNumber || 'CNT-SAPCO-1404',
        children: [
          {
            id: `DYN-CH-${c.id}-1`,
            childCode: `SLIT-${c.coilId}-01`,
            type: 'SLIT_STRIP',
            typeLabel: 'نوار فرعی ۱ (Slit Strip)',
            dimensionsLabel: `عرض ${Math.round((c.widthMm || 1250) / 3)}mm × ضخامت ${c.thicknessMm}mm`,
            weightKg: strip1W,
            sheetCount: Math.round(strip1W / 1.4),
            assignedMoNumber: 'MO-1404-0101',
            targetPartName: c.partName,
            warehouseLocation: 'خط پرسکاری (OP-10)',
            status: 'ISSUED_TO_LINE',
          },
          {
            id: `DYN-CH-${c.id}-2`,
            childCode: `BLNK-${c.coilId}-02`,
            type: 'BLANK_SHEET',
            typeLabel: 'بسته شیت فرعی ۲ (Child Blank)',
            dimensionsLabel: `شیت برش‌خورده × ضخامت ${c.thicknessMm}mm`,
            weightKg: strip2W,
            sheetCount: Math.round(strip2W / 1.6),
            assignedMoNumber: 'MO-1404-0103',
            targetPartName: c.partName,
            warehouseLocation: 'انبار میانی شیت (WIP-RACK)',
            status: 'IN_STOCK',
          },
          {
            id: `DYN-CH-${c.id}-3`,
            childCode: `REM-${c.coilId}`,
            type: 'REMNANT_COIL',
            typeLabel: 'ته‌کلاف مادر در انبار (Remnant)',
            dimensionsLabel: `عرض ${c.widthMm || 1250}mm × ضخامت ${c.thicknessMm}mm`,
            weightKg: remW,
            warehouseLocation: c.warehouseLocationCode || 'زون A-01',
            status: 'IN_STOCK',
          },
          {
            id: `DYN-CH-${c.id}-4`,
            childCode: `SCR-${c.coilId}`,
            type: 'EDGE_SCRAP',
            typeLabel: 'پرت کناره‌بری (Edge Scrap)',
            dimensionsLabel: 'کناره نواربری',
            weightKg: scrapW,
            warehouseLocation: 'باکس ضایعات',
            status: 'SCRAP_BIN',
          },
        ],
      };
    });

    const combined = [...treesState];
    dynamicTrees.forEach(dt => {
      if (!combined.some(t => t.parentCoilCode === dt.parentCoilCode)) {
        combined.push(dt);
      }
    });
    return combined;
  }, [coils, treesState]);

  const [selectedTreeId, setSelectedTreeId] = useState<string>(INITIAL_SLITTING_TREES[0].parentId);

  const activeTree = useMemo(
    () => slittingTrees.find(t => t.parentId === selectedTreeId) || slittingTrees[0],
    [slittingTrees, selectedTreeId]
  );

  const updateActiveTree = (updater: (tree: ParentCoilSlittingTree) => ParentCoilSlittingTree) => {
    setTreesState(prev => {
      const exists = prev.some(t => t.parentId === activeTree.parentId);
      if (exists) {
        return prev.map(t => (t.parentId === activeTree.parentId ? updater(t) : t));
      }
      return [...prev, updater(activeTree)];
    });
  };

  const visibleChildren = useMemo(
    () => activeTree.children.filter(c => !c.isDeleted),
    [activeTree]
  );

  const totalSlitWeight = useMemo(
    () =>
      visibleChildren
        .filter(c => c.type === 'SLIT_STRIP' || c.type === 'BLANK_SHEET')
        .reduce((s, c) => s + c.weightKg, 0),
    [visibleChildren]
  );

  const remnantWeight = useMemo(
    () => visibleChildren.filter(c => c.type === 'REMNANT_COIL').reduce((s, c) => s + c.weightKg, 0),
    [visibleChildren]
  );

  const scrapWeight = useMemo(
    () => visibleChildren.filter(c => c.type === 'EDGE_SCRAP').reduce((s, c) => s + c.weightKg, 0),
    [visibleChildren]
  );

  // Reverse Slitting (ابطال برش کلاف مادر و بازگردانی وزن نوارهای فرعی به رول مادر)
  const handleReverseSlitting = () => {
    const childStripsToRemove = visibleChildren.filter(c => c.type !== 'REMNANT_COIL');
    const reclaimedWeightKg = totalSlitWeight + scrapWeight;

    requestConfirm({
      title: `ابطال برش کلاف (Reverse Slitting) — رول مادر ${activeTree.parentCoilCode}`,
      message: `آیا از ابطال کامل عملیات برش کلاف «${activeTree.parentCoilCode}» (شماره ذوب: ${activeTree.heatNumber}) اطمینان دارید؟`,
      consequences: [
        `حذف نوارها و شیت‌های فرعی برش‌خورده (${toPersianDigits(childStripsToRemove.length)} ردیف فرعی: ${childStripsToRemove.map(c => c.childCode).join('، ') || '—'})`,
        `بازگشت کامل وزن مصرفی و پرت (${formatNumber(reclaimedWeightKg)} کیلوگرم) به موجودی رول مادر (جمع کل مجدد: ${formatNumber(activeTree.originalWeightKg)} kg)`,
        'ثبت سند ابطال برش در تاریخچه حسابرسی (Audit Trail) با قابلیت بازگردانی فوری (Undo)',
      ],
      confirmLabel: 'تأیید ابطال برش و بازگشت وزن به رول مادر',
      variant: 'danger',
      onConfirm: () => {
        const prevSnap = [...treesState];

        updateActiveTree(t => {
          const hasRemnant = t.children.some(c => c.type === 'REMNANT_COIL');
          const updatedChildren: ChildSlitNode[] = t.children.map(c => {
            if (c.type === 'REMNANT_COIL') {
              return {
                ...c,
                isDeleted: false,
                weightKg: t.originalWeightKg,
                typeLabel: 'رول مادر کامل (پس از ابطال برش / Reverse Slitting)',
                dimensionsLabel: `عرض ${t.originalWidthMm}mm × ضخامت ${t.thicknessMm}mm`,
              };
            }
            return { ...c, isDeleted: true };
          });

          if (!hasRemnant) {
            updatedChildren.push({
              id: `REM-REV-${Date.now()}`,
              childCode: `REM-${t.parentCoilCode}`,
              type: 'REMNANT_COIL',
              typeLabel: 'رول مادر کامل (پس از ابطال برش / Reverse Slitting)',
              dimensionsLabel: `عرض ${t.originalWidthMm}mm × ضخامت ${t.thicknessMm}mm`,
              weightKg: t.originalWeightKg,
              warehouseLocation: 'انبار رول ورق (زون A-01)',
              status: 'IN_STOCK',
            });
          }

          return {
            ...t,
            children: updatedChildren,
          };
        });

        onReverseSlitting?.(activeTree.parentCoilCode, activeTree.originalWeightKg);

        recordAudit({
          entityId: activeTree.parentId,
          entityCode: activeTree.parentCoilCode,
          moduleName: 'شجره‌نامه برش کلاف (Reverse Slitting)',
          actionType: 'STATUS_CHANGE',
          title: `ابطال برش کلاف (Reverse Slitting) برای رول مادر ${activeTree.parentCoilCode}`,
          details: `حذف ${childStripsToRemove.length} نوار فرعی و بازگشت ${formatNumber(reclaimedWeightKg)} kg به رول مادر (ذوب ${activeTree.heatNumber})`,
        });

        showUndoToast({
          title: `عملیات برش کلاف «${activeTree.parentCoilCode}» ابطال شد`,
          detail: `${formatNumber(reclaimedWeightKg)} کیلوگرم از نوارهای فرعی به رول مادر بازگردانده شد.`,
          variant: 'warning',
          onUndo: () => {
            setTreesState(prevSnap);
          },
        });
      },
    });
  };

  // Edit Parent Coil in Slide-Over Drawer
  const handleEditParentCoil = () => {
    openQuickEditDrawer({
      title: `ویرایش مشخصات رول مادر ${activeTree.parentCoilCode}`,
      entityId: activeTree.parentId,
      entityCode: activeTree.parentCoilCode,
      moduleName: 'شجره‌نامه برش کلاف (Coil Slitting)',
      fields: [
        { key: 'parentCoilCode', label: 'کد رول مادر (Parent Coil ID)', type: 'text' },
        { key: 'heatNumber', label: 'شماره ذوب (Heat Number)', type: 'text' },
        { key: 'materialGrade', label: 'گرید ورق (Grade)', type: 'text' },
        { key: 'thicknessMm', label: 'ضخامت ورق (mm)', type: 'number' },
        { key: 'originalWidthMm', label: 'عرض اولیه کلاف (mm)', type: 'number' },
        { key: 'originalWeightKg', label: 'وزن اولیه کلاف (kg)', type: 'number' },
        { key: 'slittingMachine', label: 'خط برش / نواربر', type: 'text' },
      ],
      initialValues: {
        parentCoilCode: activeTree.parentCoilCode,
        heatNumber: activeTree.heatNumber,
        materialGrade: activeTree.materialGrade,
        thicknessMm: activeTree.thicknessMm,
        originalWidthMm: activeTree.originalWidthMm,
        originalWeightKg: activeTree.originalWeightKg,
        slittingMachine: activeTree.slittingMachine,
      },
      onSave: updated => {
        setTreesState(prev =>
          prev.map(t =>
            t.parentId === activeTree.parentId
              ? {
                  ...t,
                  parentCoilCode: String(updated.parentCoilCode || t.parentCoilCode),
                  heatNumber: String(updated.heatNumber || t.heatNumber),
                  materialGrade: String(updated.materialGrade || t.materialGrade),
                  thicknessMm: Number(updated.thicknessMm) || t.thicknessMm,
                  originalWidthMm: Number(updated.originalWidthMm) || t.originalWidthMm,
                  originalWeightKg: Number(updated.originalWeightKg) || t.originalWeightKg,
                  slittingMachine: String(updated.slittingMachine || t.slittingMachine),
                }
              : t
          )
        );
      },
    });
  };

  // Edit Child Strip/Sheet Node in Slide-Over Drawer
  const handleEditChildNode = (child: ChildSlitNode) => {
    openQuickEditDrawer({
      title: `ویرایش خروجی فرعی برش: ${child.childCode}`,
      subtitle: `متصل به رول مادر ${activeTree.parentCoilCode} (شماره ذوب: ${activeTree.heatNumber})`,
      entityId: child.id,
      entityCode: child.childCode,
      moduleName: 'شجره‌نامه برش کلاف (Coil Slitting)',
      fields: [
        { key: 'childCode', label: 'کد نوار / شیت فرعی (Child Code)', type: 'text' },
        { key: 'typeLabel', label: 'عنوان خروجی', type: 'text' },
        { key: 'dimensionsLabel', label: 'ابعاد و مشخصات برش', type: 'text' },
        { key: 'weightKg', label: 'وزن خروجی فرعی (kg)', type: 'number' },
        { key: 'sheetCount', label: 'تعداد شیت / بلنک (اختیاری)', type: 'number' },
        { key: 'assignedMoNumber', label: 'شماره دستور تولید متصل (MO)', type: 'text' },
        { key: 'targetPartName', label: 'نام قطعه هدف', type: 'text' },
        { key: 'warehouseLocation', label: 'محل استقرار / ایستگاه', type: 'text' },
      ],
      initialValues: {
        childCode: child.childCode,
        typeLabel: child.typeLabel,
        dimensionsLabel: child.dimensionsLabel,
        weightKg: child.weightKg,
        sheetCount: child.sheetCount || 0,
        assignedMoNumber: child.assignedMoNumber || '',
        targetPartName: child.targetPartName || '',
        warehouseLocation: child.warehouseLocation,
      },
      onSave: updated => {
        setTreesState(prev =>
          prev.map(t => {
            if (t.parentId !== activeTree.parentId) return t;
            return {
              ...t,
              children: t.children.map(c =>
                c.id === child.id
                  ? {
                      ...c,
                      childCode: String(updated.childCode || c.childCode),
                      typeLabel: String(updated.typeLabel || c.typeLabel),
                      dimensionsLabel: String(updated.dimensionsLabel || c.dimensionsLabel),
                      weightKg: Math.max(1, Number(updated.weightKg) || c.weightKg),
                      sheetCount: Number(updated.sheetCount) || undefined,
                      assignedMoNumber: String(updated.assignedMoNumber || ''),
                      targetPartName: String(updated.targetPartName || ''),
                      warehouseLocation: String(updated.warehouseLocation || c.warehouseLocation),
                    }
                  : c
              ),
            };
          })
        );
      },
    });
  };

  // Add New Child Strip/Sheet via Slide-Over Drawer
  const handleAddChildNode = () => {
    const newChildId = `CH-${Date.now()}`;
    const nextCode = `SLIT-${activeTree.parentCoilCode.replace('COIL-', '')}-S${visibleChildren.length + 1}`;
    openQuickEditDrawer({
      title: `افزودن نوار / شیت فرعی جدید به رول مادر ${activeTree.parentCoilCode}`,
      subtitle: `شماره ذوب ارث‌برده‌شده: ${activeTree.heatNumber}`,
      entityId: newChildId,
      entityCode: nextCode,
      moduleName: 'شجره‌نامه برش کلاف (Coil Slitting)',
      fields: [
        { key: 'childCode', label: 'کد نوار / شیت فرعی', type: 'text' },
        {
          key: 'type',
          label: 'نوع خروجی برش',
          type: 'select',
          options: [
            { value: 'SLIT_STRIP', label: 'نوار فرعی (Slit Strip)' },
            { value: 'BLANK_SHEET', label: 'پالت شیت فرعی (Blank Sheet)' },
            { value: 'REMNANT_COIL', label: 'ته‌کلاف برگشتی (Remnant)' },
          ],
        },
        { key: 'dimensionsLabel', label: 'ابعاد برش', type: 'text' },
        { key: 'weightKg', label: 'وزن (کیلوگرم)', type: 'number' },
        { key: 'sheetCount', label: 'تعداد شیت / برگ', type: 'number' },
        { key: 'assignedMoNumber', label: 'شماره دستور تولید (MO)', type: 'text' },
        { key: 'targetPartName', label: 'نام قطعه تولیدی', type: 'text' },
        { key: 'warehouseLocation', label: 'محل استقرار', type: 'text' },
      ],
      initialValues: {
        childCode: nextCode,
        type: 'SLIT_STRIP',
        dimensionsLabel: `عرض ۳۲۰mm × ضخامت ${activeTree.thicknessMm}mm`,
        weightKg: 1450,
        sheetCount: 850,
        assignedMoNumber: 'MO-1404-2001',
        targetPartName: 'قطعه پرسکاری ساپکو',
        warehouseLocation: 'انبار میانی شیت و نوار (RACK-B05)',
      },
      onSave: vals => {
        const chosenType = (vals.type as ChildSlitNode['type']) || 'SLIT_STRIP';
        const newNode: ChildSlitNode = {
          id: newChildId,
          childCode: String(vals.childCode || nextCode),
          type: chosenType,
          typeLabel:
            chosenType === 'BLANK_SHEET'
              ? 'پالت شیت فرعی (Blank Sheet)'
              : chosenType === 'REMNANT_COIL'
              ? 'ته‌کلاف مادر (Remnant)'
              : 'نوار فرعی (Slit Strip)',
          dimensionsLabel: String(vals.dimensionsLabel || ''),
          weightKg: Math.max(1, Number(vals.weightKg) || 1000),
          sheetCount: Number(vals.sheetCount) || undefined,
          assignedMoNumber: String(vals.assignedMoNumber || ''),
          targetPartName: String(vals.targetPartName || ''),
          warehouseLocation: String(vals.warehouseLocation || 'انبار ورق'),
          status: 'IN_STOCK',
        };
        setTreesState(prev =>
          prev.map(t =>
            t.parentId === activeTree.parentId
              ? { ...t, children: [...t.children, newNode] }
              : t
          )
        );
      },
    });
  };

  // Reverse Child Node (Immutable Reversal + Undo)
  const handleReverseChildNode = (child: ChildSlitNode) => {
    requestConfirm({
      title: `ابطال خروجی برش کلاف (${child.childCode}) — Document Reversal`,
      message: `آیا از ابطال «${child.typeLabel} — ${child.childCode}» به وزن ${formatNumber(child.weightKg)} کیلوگرم اطمینان دارید؟`,
      consequences: [
        `تغییر وضعیت خروجی برش به «ابطال شده (REVERSED)» در شجره‌نامه رول مادر ${activeTree.parentCoilCode}`,
        'بازمحاسبه موازنه جرم و بازگشت وزن به مانده رول مادر بدون حذف سوابق',
        'ثبت رویداد در تاریخچه ممیزی با امکان لغو فوری (Undo)',
      ],
      confirmLabel: 'تایید ابطال خروجی برش (Reversal)',
      variant: 'danger',
      onConfirm: () => {
        const prevSnap = [...treesState];
        setTreesState(prev =>
          prev.map(t => {
            if (t.parentId !== activeTree.parentId) return t;
            return {
              ...t,
              children: t.children.map(c =>
                c.id === child.id ? { ...c, status: 'REVERSED', isDeleted: true } : c
              ),
            };
          })
        );
        recordAudit({
          entityId: child.id,
          entityCode: child.childCode,
          moduleName: 'شجره‌نامه برش کلاف',
          actionType: 'REVERSAL',
          title: `ابطال نوار/شیت فرعی ${child.childCode}`,
          details: `از رول مادر ${activeTree.parentCoilCode} (ذوب ${activeTree.heatNumber})`,
        });
        showUndoToast({
          title: `خروجی برش «${child.childCode}» ابطال (REVERSED) شد`,
          detail: 'برای بازگردانی به شجره‌نامه کلاف روی لغو (Undo) کلیک کنید.',
          variant: 'danger',
          onUndo: () => setTreesState(prevSnap),
        });
      },
    });
  };

  return (
    <div className="sap-card overflow-hidden text-right" dir="rtl">
      {/* Header & Parent Coil Selector */}
      <FioriToolbar
        variant="section"
        title="شجره‌نامه برش کلاف (Coil Slitting Genealogy)"
        subtitle="مشاهده و ویرایش کشویی (با آیکون مداد) برش رول مادر (Parent) به نوارها و شیت‌های فرعی (Child)، ته‌کلاف و دستورات تولید (MO)"
        startContent={
          <div className="flex items-center gap-2 shrink-0">
            <span className="w-8 h-8 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-info-bg)] text-[var(--fiori-brand)] border border-[var(--fiori-info-border)] flex items-center justify-center">
              <GitBranch className="w-4 h-4" />
            </span>
            <FioriObjectStatus tone="critical" label="ردیابی شماره ذوب (Heat Traceability)" />
          </div>
        }
        endContent={
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-[var(--fiori-text-secondary)] font-medium ml-1">انتخاب رول مادر:</span>
            {slittingTrees.map(tree => {
              const isSelected = tree.parentId === activeTree.parentId;
              return (
                <button
                  key={tree.parentId}
                  type="button"
                  onClick={() => setSelectedTreeId(tree.parentId)}
                  className={`px-3 py-1 rounded-[var(--fiori-radius-sm)] text-xs font-mono font-semibold transition cursor-pointer flex items-center gap-1.5 border ${
                    isSelected
                      ? 'bg-[var(--fiori-brand)] text-white border-[var(--fiori-brand)]'
                      : 'bg-[var(--fiori-bg-subtle)] hover:bg-[var(--fiori-info-bg)] text-[var(--fiori-text-primary)] border-[var(--fiori-border-default)]'
                  }`}
                >
                  <span className="fiori-ltr-code">{tree.parentCoilCode}</span>
                  <span
                    className={`text-[10px] px-1.5 rounded-[var(--fiori-radius-sm)] ${
                      isSelected
                        ? 'bg-white/20 text-white'
                        : 'bg-[var(--fiori-bg-surface)] text-[var(--fiori-text-secondary)] border border-[var(--fiori-border-default)]'
                    }`}
                  >
                    {tree.materialGrade}
                  </span>
                </button>
              );
            })}
          </div>
        }
      />

      {/* Visual Tree Layout: Parent Coil (Right) ➔ Slitting Operation ➔ Child Strips/Sheets (Left) */}
      <div className="p-4 grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
        {/* 1. Parent Coil Card (رول مادر) with Pencil Drawer Edit */}
        <div className="lg:col-span-4 bg-[var(--fiori-bg-subtle)] text-[var(--fiori-text-primary)] rounded-[var(--fiori-radius-md)] p-4 flex flex-col justify-between relative overflow-hidden border border-[var(--fiori-border-default)]">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <FioriObjectStatus tone="info" label="رول مادر (Parent Master Coil)" />
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-[var(--fiori-text-secondary)] fiori-ltr-code">
                  {activeTree.coilPackNumber}
                </span>
                <button
                  type="button"
                  onClick={handleEditParentCoil}
                  title="ویرایش مشخصات رول مادر در کشو"
                  className="p-1.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-surface)] hover:bg-[var(--fiori-info-bg)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-brand)] border border-[var(--fiori-border-default)] transition cursor-pointer"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div>
              <button
                type="button"
                onClick={() => router.traceDocument(activeTree.parentCoilCode, 'COILS')}
                className="sap-doc-link text-base font-bold font-mono tracking-tight fiori-ltr-code cursor-pointer"
                title="مشاهده پرونده رول مادر"
              >
                {activeTree.parentCoilCode}
              </button>
              <div className="text-xs text-[var(--fiori-text-secondary)] mt-0.5">{activeTree.supplierName}</div>
              {activeTree.contractNumber && (
                <div className="text-[11px] text-[var(--fiori-text-secondary)] mt-0.5">
                  قرارداد:{' '}
                  <button
                    type="button"
                    onClick={() => router.traceDocument(activeTree.contractNumber, 'CONTRACTS')}
                    className="sap-doc-link text-[11px] fiori-ltr-code cursor-pointer"
                  >
                    {activeTree.contractNumber}
                  </button>
                </div>
              )}
            </div>

            {/* Heat Number Highlight Box */}
            <div className="p-2.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Flame className="w-4 h-4 text-[var(--fiori-critical)] shrink-0" />
                <div>
                  <span className="text-[10px] text-[var(--fiori-text-secondary)] block">
                    شماره ذوب فولاد (Heat Number)
                  </span>
                  <button
                    type="button"
                    onClick={() => router.traceDocument(activeTree.heatNumber, 'WIP_TRACEABILITY')}
                    className="sap-doc-link font-mono text-xs font-bold fiori-ltr-code cursor-pointer"
                    title="رهگیری شماره ذوب در تولید"
                  >
                    {activeTree.heatNumber}
                  </button>
                </div>
              </div>
              <div className="text-left">
                <span className="text-[10px] text-[var(--fiori-text-secondary)] block">گرید و ضخامت</span>
                <span className="font-mono text-xs font-semibold text-[var(--fiori-text-primary)] tabular-nums">
                  {activeTree.materialGrade} | {toPersianDigits(activeTree.thicknessMm)}mm
                </span>
              </div>
            </div>

            {/* Parent Specs Grid */}
            <div className="grid grid-cols-2 gap-2 text-xs tabular-nums">
              <div className="p-2.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)]">
                <span className="text-[10px] text-[var(--fiori-text-secondary)] block">وزن اولیه رول مادر</span>
                <span className="font-mono font-bold text-[var(--fiori-positive)] text-sm mt-0.5 block">
                  {formatNumber(activeTree.originalWeightKg)} kg
                </span>
              </div>
              <div className="p-2.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-default)]">
                <span className="text-[10px] text-[var(--fiori-text-secondary)] block">عرض اولیه کلاف</span>
                <span className="font-mono font-bold text-[var(--fiori-text-primary)] text-sm mt-0.5 block">
                  {formatNumber(activeTree.originalWidthMm)} mm
                </span>
              </div>
            </div>
          </div>

          {/* Mass Balance Bar inside Parent Card */}
          <div className="mt-4 pt-3 border-t border-[var(--fiori-border-default)] space-y-2">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-[var(--fiori-text-secondary)]">موازنه جرم برش کلاف:</span>
              <span className="font-mono text-[var(--fiori-positive)] font-semibold tabular-nums">
                راندمان برش:{' '}
                {toPersianDigits(
                  Math.min(
                    100,
                    Math.round(((totalSlitWeight + remnantWeight) / Math.max(1, activeTree.originalWeightKg)) * 100)
                  )
                )}
                ٪
              </span>
            </div>
            <div className="w-full h-2 bg-[var(--fiori-border-subtle)] rounded-[var(--fiori-radius-sm)] overflow-hidden flex">
              <div
                className="bg-[var(--fiori-positive)] h-full"
                style={{ width: `${(totalSlitWeight / Math.max(1, activeTree.originalWeightKg)) * 100}%` }}
                title={`نوار و شیت فرعی: ${totalSlitWeight} kg`}
              />
              <div
                className="bg-[var(--fiori-critical)] h-full"
                style={{ width: `${(remnantWeight / Math.max(1, activeTree.originalWeightKg)) * 100}%` }}
                title={`ته‌کلاف: ${remnantWeight} kg`}
              />
              <div
                className="bg-[var(--fiori-negative)] h-full"
                style={{ width: `${(scrapWeight / Math.max(1, activeTree.originalWeightKg)) * 100}%` }}
                title={`پرت برش: ${scrapWeight} kg`}
              />
            </div>
            <div className="flex items-center justify-between text-[10px] text-[var(--fiori-text-secondary)] font-mono tabular-nums">
              <span>نوار/شیت: {formatNumber(totalSlitWeight)}kg</span>
              <span>ته‌کلاف: {formatNumber(remnantWeight)}kg</span>
              <span>پرت: {formatNumber(scrapWeight)}kg</span>
            </div>
          </div>
        </div>

        {/* 2. Child Strips & Sheets Tree Branches (نوارها و شیت‌های فرعی - Child Nodes) */}
        <div className="lg:col-span-8 flex flex-col justify-between space-y-3">
          <div className="border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-md)] overflow-hidden">
            <FioriToolbar
              variant="section"
              title={`ایستگاه برش: ${activeTree.slittingMachine}`}
              subtitle={`تاریخ برش: ${activeTree.slittingDate}`}
              startContent={<Scissors className="w-4 h-4 text-[var(--fiori-brand)] shrink-0" />}
              endContent={
                <div className="flex items-center gap-2 flex-wrap">
                  <FioriObjectStatus
                    tone="info"
                    label={`${toPersianDigits(visibleChildren.length)} خروجی فرعی (Child) از ذوب ${activeTree.heatNumber}`}
                  />
                  {totalSlitWeight > 0 && (
                    <button
                      type="button"
                      onClick={handleReverseSlitting}
                      title="ابطال عملیات برش و بازگرداندن وزن نوارهای فرعی به رول مادر"
                      className="px-2.5 py-1 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-negative-bg)] hover:bg-[var(--fiori-negative)] text-[var(--fiori-negative)] hover:text-white border border-[var(--fiori-negative-border)] hover:border-[var(--fiori-negative)] text-[11px] font-semibold flex items-center gap-1 transition-colors cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>ابطال برش (Reverse Slitting)</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleAddChildNode}
                    className="sap-btn-emphasized px-2.5 py-1 text-[11px] flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3 h-3" />
                    <span>افزودن نوار/شیت فرعی</span>
                  </button>
                </div>
              }
            />
          </div>

          {/* Vertical Connected Tree of Child Outputs */}
          <div className="relative pr-5 space-y-2">
            {/* Vertical Connector Line */}
            <div className="absolute right-2 top-3 bottom-3 w-0.5 bg-[var(--fiori-border-default)] rounded-full" />

            {visibleChildren.map(child => {
              const isStripOrSheet = child.type === 'SLIT_STRIP' || child.type === 'BLANK_SHEET';
              const isRemnant = child.type === 'REMNANT_COIL';

              const dotColor = isStripOrSheet
                ? 'bg-[var(--fiori-positive)] ring-[var(--fiori-positive-bg)]'
                : isRemnant
                ? 'bg-[var(--fiori-critical)] ring-[var(--fiori-critical-bg)]'
                : 'bg-[var(--fiori-negative)] ring-[var(--fiori-negative-bg)]';

              const cardBorder = isStripOrSheet
                ? 'border-[var(--fiori-border-default)] hover:border-[var(--fiori-brand)] bg-[var(--fiori-bg-surface)]'
                : isRemnant
                ? 'border-[var(--fiori-critical-border)] bg-[var(--fiori-critical-bg)]/40'
                : 'border-[var(--fiori-negative-border)] bg-[var(--fiori-negative-bg)]/40';

              return (
                <div
                  key={child.id}
                  className={`relative rounded-[var(--fiori-radius-sm)] border p-2.5 transition-all ${cardBorder}`}
                >
                  {/* Tree Branch Node Circle */}
                  <span
                    className={`absolute -right-[17px] top-1/2 -translate-y-1/2 w-3 h-3 rounded-full ring-4 ${dotColor}`}
                  />

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-xs font-bold text-[var(--fiori-text-primary)] bg-[var(--fiori-bg-subtle)] px-2 py-0.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] fiori-ltr-code">
                          {child.childCode}
                        </span>
                        <FioriObjectStatus
                          tone={isStripOrSheet ? 'positive' : isRemnant ? 'critical' : 'negative'}
                          label={child.typeLabel}
                          size="sm"
                        />
                        <span className="text-xs font-semibold text-[var(--fiori-text-primary)]">
                          {child.dimensionsLabel}
                        </span>
                        <span className="text-[10px] font-mono text-[var(--fiori-text-secondary)] bg-[var(--fiori-bg-subtle)] px-1.5 py-0.5 rounded-[var(--fiori-radius-sm)]">
                          ذوب ارث‌برده: <span className="fiori-ltr-code">{activeTree.heatNumber}</span>
                        </span>
                      </div>

                      <div className="flex items-center gap-3 flex-wrap text-[11px] text-[var(--fiori-text-secondary)]">
                        <span>
                          محل استقرار: <strong className="text-[var(--fiori-text-primary)]">{child.warehouseLocation}</strong>
                        </span>
                        {child.targetPartName && (
                          <>
                            <span className="text-[var(--fiori-text-muted)]">•</span>
                            <span>
                              قطعه هدف: <strong className="text-[var(--fiori-text-primary)]">{child.targetPartName}</strong>
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Right-side Metrics, Linked MO Badge, Pencil Edit & Soft Delete */}
                    <div className="flex items-center gap-2.5 self-end sm:self-center shrink-0">
                      {child.assignedMoNumber && (
                        <div className="px-2 py-0.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-info-bg)] border border-[var(--fiori-info-border)] text-left">
                          <span className="text-[9px] text-[var(--fiori-text-secondary)] block">دستور تولید متصل</span>
                          <button
                            type="button"
                            onClick={() => router.traceDocument(child.assignedMoNumber!, 'WIP_TRACEABILITY')}
                            className="sap-doc-link font-mono text-xs font-bold fiori-ltr-code cursor-pointer"
                            title="رهگیری این دستور تولید"
                          >
                            {child.assignedMoNumber}
                          </button>
                        </div>
                      )}

                      {child.sheetCount && (
                        <div className="text-left px-2 py-0.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)]">
                          <span className="text-[9px] text-[var(--fiori-text-secondary)] block">تعداد شیت/بلنک</span>
                          <span className="font-mono text-xs font-semibold text-[var(--fiori-text-primary)] tabular-nums">
                            {formatNumber(child.sheetCount)} برگ
                          </span>
                        </div>
                      )}

                      <div className="text-left min-w-[75px]">
                        <span className="text-[10px] text-[var(--fiori-text-secondary)] block">وزن فرعی</span>
                        <span className="font-mono text-sm font-bold text-[var(--fiori-text-primary)] tabular-nums">
                          {formatNumber(child.weightKg)} <span className="text-[10px] font-normal">kg</span>
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleEditChildNode(child)}
                        title="ویرایش در کشو (Edit)"
                        className="p-1.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-surface)] hover:bg-[var(--fiori-info-bg)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-brand)] border border-[var(--fiori-border-default)] transition cursor-pointer"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>

                      <button
                        type="button"
                        onClick={() => handleReverseChildNode(child)}
                        title="ابطال خروجی برش (Reversal)"
                        className="p-1.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-bg-surface)] hover:bg-[var(--fiori-negative)] text-[var(--fiori-text-secondary)] hover:text-white border border-[var(--fiori-border-default)] transition cursor-pointer"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
