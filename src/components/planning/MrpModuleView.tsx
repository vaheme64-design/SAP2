import React, { useState, useEffect, useCallback } from 'react';
import {
  Calculator,
  ClipboardCheck,
  Download,
  Printer,
  RefreshCw,
  Search,
  Filter,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  FileSpreadsheet,
  PackageCheck,
  ShieldAlert,
  Boxes,
  Layers,
  ArrowRight,
  TrendingUp,
  Clock,
  Sparkles,
  Info,
  ChevronDown,
  ChevronUp,
  FileCheck,
  Lock,
  Pin,
  ShoppingCart,
  GitBranch,
  Plus,
  Trash2,
  X,
  Edit3,
} from 'lucide-react';
import {
  MrpRunResult,
  MrpMaterialRow,
  MrpPartRow,
  MoMaterialCheckResult,
} from '../../types/mrp';
import { formatNumber, toPersianDigits } from '../../utils/formatters';
import { ReportModuleSkeleton } from '../common/Skeleton';
import { FormulaTooltip } from '../common/FormulaTooltip';
import { useEnterpriseUx } from '../../context/EnterpriseUxContext';
import { useErpRouter } from '../../context/RouterContext';
import {
  loadQcHoldMap,
  loadVipPartsMap,
  QcHoldRecord,
} from '../../utils/qcHoldStore';
import {
  FioriMessageStrip,
  FioriObjectStatus,
  FioriToolbar,
} from '../fiori/ui';
import { EmptyState } from '../common/EmptyState';

interface TechDocResolution {
  partId: string;
  partCode: string;
  hasBom: boolean;
  hasRouting: boolean;
  materialGrade: string;
  thicknessMm: number;
  unitWeightKg: number;
  scrapAllowancePct: number;
  hardwareComponentName?: string;
  hardwareQtyPerUnit?: number;
  operations: Array<{
    stepCode: string;
    stepName: string;
    machineName: string;
    cycleTimeSec: number;
  }>;
  updatedAt: string;
}

interface IssuedPrRecord {
  prNumber: string;
  materialCode: string;
  materialName: string;
  quantity: number;
  unit: string;
  createdAt: string;
}

interface MrpModuleViewProps {
  onRefreshGlobal?: () => Promise<void>;
}

export const MrpModuleView: React.FC<MrpModuleViewProps> = ({ onRefreshGlobal }) => {
  const { requestConfirm, showUndoToast, recordAudit } = useEnterpriseUx();
  const { traceDocument } = useErpRouter();
  const [activeTab, setActiveTab] = useState<'materials' | 'pre_issue' | 'parts' | 'simulation'>('materials');
  const [rawMrpData, setMrpData] = useState<MrpRunResult | null>(null);
  const [qcHoldMap, setQcHoldMap] = useState<Record<string, QcHoldRecord>>(() => loadQcHoldMap());
  const [vipMap, setVipMap] = useState<Record<string, boolean>>(() => loadVipPartsMap());

  // Persisted Technical Docs Resolutions (BOM & Routing defined inline via MRP Drawer)
  const [techDocsMap, setTechDocsMap] = useState<Record<string, TechDocResolution>>(() => {
    try {
      const saved = localStorage.getItem('kpims_mrp_tech_docs_v1');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  // Persisted Purchase Requisitions (PR) issued for shortage rows
  const [issuedPrMap, setIssuedPrMap] = useState<Record<string, IssuedPrRecord>>(() => {
    try {
      const saved = localStorage.getItem('kpims_mrp_issued_prs_v1');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  // Inline Slide-Over Drawer State for defining BOM / Routing directly inside MRP
  const [bomRoutingDrawerPart, setBomRoutingDrawerPart] = useState<MrpPartRow | null>(null);
  const [drawerFocusSection, setDrawerFocusSection] = useState<'BOM' | 'ROUTING'>('BOM');
  const [drawerBomGrade, setDrawerBomGrade] = useState<string>('DC04');
  const [drawerBomThickness, setDrawerBomThickness] = useState<string>('1.2');
  const [drawerBomUnitWeight, setDrawerBomUnitWeight] = useState<string>('1.45');
  const [drawerBomScrapPct, setDrawerBomScrapPct] = useState<string>('12');
  const [drawerBomHardware, setDrawerBomHardware] = useState<string>('مهره جوشی چهارگوش M8 DIN 928');
  const [drawerBomHardwareQty, setDrawerBomHardwareQty] = useState<string>('2');
  const [drawerOps, setDrawerOps] = useState<
    Array<{ stepCode: string; stepName: string; machineName: string; cycleTimeSec: number }>
  >([
    { stepCode: 'OP-10', stepName: 'برش ورق و بلنک‌زنی اولیه', machineName: 'قیچی گیوتین ۶ متری ۱', cycleTimeSec: 6 },
    { stepCode: 'OP-20', stepName: 'کشش عمیق و فرم‌دهی اصلی', machineName: 'پرس هیدرولیک ۴۰۰ تن ۱', cycleTimeSec: 12 },
    { stepCode: 'OP-30', stepName: 'پانچ، دوربری و کالیبره نهایی', machineName: 'پرس ضربه‌ای ۲۵۰ تن ۱', cycleTimeSec: 10 },
  ]);

  // Simulation Parameters
  const [simGrowth, setSimGrowth] = useState<number>(0);
  const [simHorizon, setSimHorizon] = useState<number>(30);
  const [simIncludeWip, setSimIncludeWip] = useState<boolean>(true);
  const [simIncludeConsignment, setSimIncludeConsignment] = useState<boolean>(true);
  const [simulating, setSimulating] = useState(false);

  useEffect(() => {
    const onHold = () => {
      setQcHoldMap(loadQcHoldMap());
    };
    const onVip = () => {
      setVipMap(loadVipPartsMap());
    };
    window.addEventListener('kpims-qc-hold-changed', onHold);
    window.addEventListener('kpims-vip-parts-changed', onVip);
    return () => {
      window.removeEventListener('kpims-qc-hold-changed', onHold);
      window.removeEventListener('kpims-vip-parts-changed', onVip);
    };
  }, []);

  // Dynamically recompute MRP ATP, VIP priority, and Inline BOM/Routing Resolutions
  const mrpData = React.useMemo<MrpRunResult | null>(() => {
    if (!rawMrpData) return null;

    const updatedParts = rawMrpData.parts
      .map(p => {
        const isVIP = Boolean(p.isVIP || vipMap[p.partId] || vipMap[p.partCode]);
        const resolvedDoc = techDocsMap[p.partId] || techDocsMap[p.partCode];
        const partHoldQty = Object.values(qcHoldMap)
          .filter(h => h.isHeld && (h.partId === p.partId || h.partCode === p.partCode))
          .reduce((s, h) => s + (h.heldQty || 0), 0);
        const effectiveFgStock = Math.max(0, p.coveredByFgStock - partHoldQty);
        const netRequirement = Math.max(
          0,
          p.grossDemand - effectiveFgStock - p.coveredByWip - p.coveredByActiveMos
        );
        return {
          ...p,
          isVIP,
          hasBom: Boolean(p.hasBom || resolvedDoc?.hasBom),
          hasRouting: Boolean(p.hasRouting || resolvedDoc?.hasRouting),
          coveredByFgStock: effectiveFgStock,
          netRequirement,
        };
      })
      .sort((a, b) => {
        if (Boolean(a.isVIP) !== Boolean(b.isVIP)) return a.isVIP ? -1 : 1;
        return b.netRequirement - a.netRequirement;
      });

    const updatedMaterials = rawMrpData.materials.map(m => {
      const extraHoldKg = Object.values(qcHoldMap)
        .filter(h => {
          if (!h.isHeld) return false;
          const matchCode = h.partCode === m.materialCode || (h.lotNumber && m.matchingCoils?.some(c => c.coilNumber === h.lotNumber || c.coilId === h.key));
          const matchName = h.partName && m.materialGrade && h.partName.toLowerCase().includes(m.materialGrade.toLowerCase());
          return Boolean(matchCode || matchName);
        })
        .reduce((s, h) => s + (m.unitCode === 'KG' ? (h.heldWeightKg || h.heldQty || 0) : (h.heldQty || h.heldWeightKg || 0)), 0);

      const effectiveQuarantined = Math.max(m.onHandQuarantined || 0, extraHoldKg);
      const totalPhysical = (m.onHandOwned || 0) + (simIncludeConsignment ? m.onHandConsignment || 0 : 0);
      // Direct subtraction of QC Hold (onHandQuarantined) from Free Available (ATP):
      const netAvailable = Math.max(0, totalPhysical - (m.reservedActive || 0) - effectiveQuarantined);
      const targetRequired = m.unitCode === 'KG' ? m.requiredWeightKg : m.requiredQuantity;
      const shortageQuantity = Math.max(0, Math.round((targetRequired - netAvailable) * 10) / 10);
      const coveredByContract = Math.min(shortageQuantity, m.openContractQuantity || 0);
      const hardShortageQuantity = Math.max(0, Math.round((shortageQuantity - coveredByContract) * 10) / 10);

      let severity: MrpMaterialRow['severity'] = 'OK';
      if (shortageQuantity > 0) {
        severity = hardShortageQuantity === 0 ? 'SHORTAGE_COVERED_BY_CONTRACT' : 'HARD_SHORTAGE';
      }

      return {
        ...m,
        onHandQuarantined: effectiveQuarantined,
        netAvailable,
        shortageQuantity,
        coveredByContract,
        hardShortageQuantity,
        severity,
      };
    });

    updatedMaterials.sort((a, b) => {
      const aVip = a.demandedByParts.some(dp => vipMap[dp.partId] || vipMap[dp.partCode]);
      const bVip = b.demandedByParts.some(dp => vipMap[dp.partId] || vipMap[dp.partCode]);
      if (aVip && a.severity !== 'OK' && !(bVip && b.severity !== 'OK')) return -1;
      if (bVip && b.severity !== 'OK' && !(aVip && a.severity !== 'OK')) return 1;
      const sevScore = { HARD_SHORTAGE: 3, SHORTAGE_COVERED_BY_CONTRACT: 2, OK: 1 };
      return sevScore[b.severity] - sevScore[a.severity] || b.shortageQuantity - a.shortageQuantity;
    });

    return {
      ...rawMrpData,
      parts: updatedParts,
      materials: updatedMaterials,
      summary: {
        ...rawMrpData.summary,
        ok: updatedMaterials.filter(m => m.severity === 'OK').length,
        contractCovered: updatedMaterials.filter(m => m.severity === 'SHORTAGE_COVERED_BY_CONTRACT').length,
        hardShortages: updatedMaterials.filter(m => m.severity === 'HARD_SHORTAGE').length,
        totalShortageWeightKg: updatedMaterials.reduce((s, m) => s + m.hardShortageQuantity, 0),
      },
    };
  }, [rawMrpData, qcHoldMap, vipMap, simIncludeConsignment, techDocsMap]);

  // Open Inline Slide-Over Drawer for defining missing BOM or Routing without leaving MRP
  const handleOpenBomRoutingDrawer = (part: MrpPartRow, section: 'BOM' | 'ROUTING') => {
    const existing = techDocsMap[part.partId] || techDocsMap[part.partCode];
    setBomRoutingDrawerPart(part);
    setDrawerFocusSection(section);
    setDrawerBomGrade(existing?.materialGrade || (part.partName.includes('گالوانیزه') ? 'DX51D' : 'DC04'));
    setDrawerBomThickness(String(existing?.thicknessMm || 1.2));
    setDrawerBomUnitWeight(String(existing?.unitWeightKg || 1.45));
    setDrawerBomScrapPct(String(existing?.scrapAllowancePct || 12));
    setDrawerBomHardware(existing?.hardwareComponentName || 'مهره جوشی چهارگوش M8 DIN 928');
    setDrawerBomHardwareQty(String(existing?.hardwareQtyPerUnit ?? 2));
    if (existing?.operations && existing.operations.length > 0) {
      setDrawerOps(existing.operations);
    } else {
      setDrawerOps([
        { stepCode: 'OP-10', stepName: 'برش ورق و بلنک‌زنی اولیه', machineName: 'قیچی گیوتین ۶ متری ۱', cycleTimeSec: 6 },
        { stepCode: 'OP-20', stepName: `کشش و فرم‌دهی ${part.partName}`, machineName: 'پرس هیدرولیک ۴۰۰ تن ۱', cycleTimeSec: 12 },
        { stepCode: 'OP-30', stepName: 'پانچ، خم نهایی و کنترل کیفیت', machineName: 'پرس ضربه‌ای ۲۵۰ تن ۱', cycleTimeSec: 10 },
      ]);
    }
  };

  const handleSaveBomRoutingFromDrawer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bomRoutingDrawerPart) return;
    const prevDocs = { ...techDocsMap };
    const resolution: TechDocResolution = {
      partId: bomRoutingDrawerPart.partId,
      partCode: bomRoutingDrawerPart.partCode,
      hasBom: true,
      hasRouting: drawerOps.length > 0,
      materialGrade: drawerBomGrade,
      thicknessMm: Math.max(0.4, parseFloat(drawerBomThickness) || 1.2),
      unitWeightKg: Math.max(0.05, parseFloat(drawerBomUnitWeight) || 1.2),
      scrapAllowancePct: Math.max(0, parseFloat(drawerBomScrapPct) || 10),
      hardwareComponentName: drawerBomHardware,
      hardwareQtyPerUnit: Math.max(0, parseInt(drawerBomHardwareQty, 10) || 0),
      operations: drawerOps,
      updatedAt: new Date().toLocaleString('fa-IR'),
    };

    const nextDocs = {
      ...techDocsMap,
      [bomRoutingDrawerPart.partId]: resolution,
      [bomRoutingDrawerPart.partCode]: resolution,
    };
    setTechDocsMap(nextDocs);
    try {
      localStorage.setItem('kpims_mrp_tech_docs_v1', JSON.stringify(nextDocs));
    } catch {
      // ignore
    }

    // Persist Part, Routing AND Advanced BOM to backend APIs so server MRP/Backflush stay synced
    try {
      const rawMaterialCode = `RM-SHEET-${resolution.materialGrade}-${resolution.thicknessMm}`;
      const grossWeight = Number(
        (resolution.unitWeightKg * (1 + resolution.scrapAllowancePct / 100)).toFixed(3)
      );
      const bomComponents: Array<Record<string, unknown>> = [
        {
          id: `BOM-CMP-${resolution.partCode}-RAW`,
          componentPartId: rawMaterialCode,
          componentPartCode: rawMaterialCode,
          componentPartName: `ورق خام گرید ${resolution.materialGrade} ضخامت ${resolution.thicknessMm}mm`,
          componentType: 'RAW_SHEET',
          quantityPerAssembly: 1,
          unit: 'PCS',
          grossWeightKg: grossWeight,
          netWeightKg: resolution.unitWeightKg,
          scrapAllowancePercent: resolution.scrapAllowancePct,
          joiningProcess: 'STAMPING',
          subMoRequired: false,
          stageJoinedStepNumber: 10,
          supplierSource: 'COMPANY_PURCHASED',
        },
      ];

      if (resolution.hardwareComponentName && (resolution.hardwareQtyPerUnit || 0) > 0) {
        bomComponents.push({
          id: `BOM-CMP-${resolution.partCode}-HW`,
          componentPartId: `HW-${resolution.partCode}`,
          componentPartCode: `HW-${resolution.partCode}`,
          componentPartName: resolution.hardwareComponentName,
          componentType: 'FASTENER_HARDWARE',
          quantityPerAssembly: resolution.hardwareQtyPerUnit,
          unit: 'PCS',
          grossWeightKg: Number(((resolution.hardwareQtyPerUnit || 1) * 0.008).toFixed(3)),
          netWeightKg: Number(((resolution.hardwareQtyPerUnit || 1) * 0.008).toFixed(3)),
          scrapAllowancePercent: 0,
          joiningProcess: 'SPOT_WELD',
          subMoRequired: false,
          stageJoinedStepNumber: 30,
          supplierSource: 'COMPANY_PURCHASED',
        });
      }

      await Promise.all([
        fetch('/api/parts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: bomRoutingDrawerPart.partId,
            code: bomRoutingDrawerPart.partCode,
            name: bomRoutingDrawerPart.partName,
            category: 'FINISHED_GOOD',
            unit: 'PCS',
            materialGrade: resolution.materialGrade,
            thicknessMm: resolution.thicknessMm,
            weightPerUnitKg: resolution.unitWeightKg,
          }),
        }).catch(() => {}),
        fetch('/api/routings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            partId: bomRoutingDrawerPart.partId,
            partCode: bomRoutingDrawerPart.partCode,
            partName: bomRoutingDrawerPart.partName,
            operations: resolution.operations.map((op, i) => ({
              stepNumber: (i + 1) * 10,
              stepCode: op.stepCode,
              stepName: op.stepName,
              processType: i === 0 ? 'SHEARING' : 'STAMPING',
              machineName: op.machineName,
              standardCycleTimeSec: op.cycleTimeSec,
            })),
          }),
        }).catch(() => {}),
        fetch('/api/production/boms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: `BOM-${bomRoutingDrawerPart.partCode}`,
            assemblyPartId: bomRoutingDrawerPart.partId,
            assemblyPartCode: bomRoutingDrawerPart.partCode,
            assemblyPartName: bomRoutingDrawerPart.partName,
            version: 'V1.0',
            isActive: true,
            components: bomComponents,
          }),
        }).catch(() => {}),
      ]);
      await loadMrp();
      if (onRefreshGlobal) await onRefreshGlobal();
    } catch {
      // local state updated
    }

    const savedPartName = bomRoutingDrawerPart.partName;
    const savedPartCode = bomRoutingDrawerPart.partCode;
    setBomRoutingDrawerPart(null);

    recordAudit({
      actionType: 'UPDATE',
      module: 'ماژول برنامه‌ریزی و MRP (رفع بن‌بست فنی)',
      entityId: resolution.partId,
      entityCode: savedPartCode,
      summaryFa: `تعریف و تایید درجا (Inline) درخت محصول (BOM: ورق ${resolution.materialGrade} ضخامت ${resolution.thicknessMm}mm) و مسیر تولید (${resolution.operations.length} ایستگاه OP) برای «${savedPartName}»`,
    });

    showUndoToast({
      title: `BOM و مسیر تولید «${savedPartName}» ثبت و تأیید شد`,
      description: 'وضعیت مستندات فنی در جدول تقاضای قطعات بدون خروج از MRP به «تأییدشده» تغییر یافت.',
      variant: 'success',
      onUndo: () => {
        setTechDocsMap(prevDocs);
        try {
          localStorage.setItem('kpims_mrp_tech_docs_v1', JSON.stringify(prevDocs));
        } catch {
          // ignore
        }
      },
    });
  };

  // Issue Purchase Requisition (PR) for a material row with shortage (🛒 صدور درخواست خرید)
  const handleIssuePurchaseRequisition = (
    materialCode: string,
    materialName: string,
    shortageQty: number,
    unit: string = 'kg',
    grade?: string
  ) => {
    const reqQty = Math.max(100, Math.ceil(shortageQty));
    requestConfirm({
      title: `صدور درخواست خرید رسمی (PR) — «${materialName}»`,
      description: `آیا از صدور درخواست خرید (Purchase Requisition) به مقدار ${formatNumber(reqQty)} ${unit} برای جبران کسری موجودی «${materialName}» اطمینان دارید؟`,
      consequences: [
        `ثبت سند رسمی درخواست خرید (PR) به مقدار ${formatNumber(reqQty)} ${unit} و ارسال به واحد بازرگانی / تامین ساپکو`,
        `رزرو سفارش خرید در موازنه نیازمندی‌های مواد (MRP) برای جلوگیری از توقف خط پرس`,
        'ثبت رویداد در لاگ ممیزی (Audit Trail) با قابلیت لغو فوری (Undo)',
      ],
      confirmLabel: 'تأیید و صدور درخواست خرید (PR)',
      variant: 'indigo',
      onConfirm: async () => {
        const prevPrs = { ...issuedPrMap };
        const proposedPrNumber = `PR-1404-${Math.floor(1000 + Math.random() * 8999)}`;
        try {
          const res = await fetch('/api/mrp/purchase-requisitions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prNumber: proposedPrNumber,
              materialCode,
              materialName,
              materialGrade: grade,
              quantity: reqQty,
              unit,
            }),
          });
          const json = await res.json();
          if (!res.ok || !json.success) {
            setError(json.error || 'خطا در صدور درخواست خرید (PR)');
            return;
          }
          const saved = json.data;
          const finalPrNumber = saved?.prNumber || proposedPrNumber;
          const newPr: IssuedPrRecord = {
            prNumber: finalPrNumber,
            materialCode,
            materialName,
            quantity: saved?.quantity || reqQty,
            unit: saved?.unit || unit,
            createdAt: saved?.createdAtFa || new Date().toLocaleString('fa-IR'),
          };
          const nextPrs = { ...issuedPrMap, [materialCode]: newPr };
          setIssuedPrMap(nextPrs);
          try {
            localStorage.setItem('kpims_mrp_issued_prs_v1', JSON.stringify(nextPrs));
          } catch {
            // ignore
          }

          recordAudit({
            actionType: 'CREATE',
            module: 'ماژول برنامه‌ریزی و MRP (تدارکات و خرید)',
            entityId: finalPrNumber,
            entityCode: materialCode,
            summaryFa: `صدور درخواست خرید (${finalPrNumber}) برای «${materialName}» (${grade || materialCode}) به مقدار ${formatNumber(reqQty)} ${unit}`,
          });

          setNotice(
            `درخواست خرید شماره ${finalPrNumber} برای «${materialName}» به مقدار ${formatNumber(reqQty)} ${unit} با موفقیت در سرور ثبت و به واحد تدارکات/ساپکو ارسال شد.`
          );

          showUndoToast({
            title: `🛒 درخواست خرید ${finalPrNumber} صادر شد`,
            description: `مقدار ${formatNumber(reqQty)} ${unit} «${materialName}» در صف تامین بازرگانی ثبت گردید.`,
            variant: 'success',
            onUndo: async () => {
              await fetch(`/api/mrp/purchase-requisitions/${encodeURIComponent(finalPrNumber)}/reverse`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  reason: `ابطال درخواست خرید ${finalPrNumber} توسط کاربر (Undo / Reversal)`,
                }),
              }).catch(() => {});
              setIssuedPrMap(prevPrs);
              try {
                localStorage.setItem('kpims_mrp_issued_prs_v1', JSON.stringify(prevPrs));
              } catch {
                // ignore
              }
            },
          });
        } catch (err: any) {
          setError(err?.message || 'خطا در ارتباط با سرور برای صدور درخواست خرید');
        }
      },
    });
  };
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Filters for materials table
  const [materialSearch, setMaterialSearch] = useState('');
  const [severityFilter, setSeverityFilter] = useState<'ALL' | 'HARD_SHORTAGE' | 'SHORTAGE_COVERED_BY_CONTRACT' | 'OK'>('ALL');
  const [gradeFilter, setGradeFilter] = useState<string>('ALL');

  // Pre-Issue Check State
  const [moList, setMoList] = useState<{ id: string; moNumber: string; partCode: string; partName: string; targetQuantity: number; status: string }[]>([]);
  const [selectedMoId, setSelectedMoId] = useState<string>('');
  const [moCheckResult, setMoCheckResult] = useState<MoMaterialCheckResult | null>(null);
  const [checkingMo, setCheckingMo] = useState(false);
  const [reservingMo, setReservingMo] = useState(false);

  // Detail Modal / Popover for parts demanded
  const [expandedMaterialCode, setExpandedMaterialCode] = useState<string | null>(null);

  const loadMrp = useCallback(async (params?: { growth?: number; horizon?: number; includeWip?: boolean; includeConsignment?: boolean }) => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      if (params?.growth !== undefined) q.append('growth', String(params.growth));
      if (params?.horizon !== undefined) q.append('horizonDays', String(params.horizon));
      if (params?.includeWip !== undefined) q.append('includeWip', String(params.includeWip));
      if (params?.includeConsignment !== undefined) q.append('includeConsignment', String(params.includeConsignment));

      const res = await fetch(`/api/mrp/run?${q.toString()}`);
      const json = await res.json();
      if (json.success && json.data) {
        setMrpData(json.data);
      } else {
        setError(json.error || 'خطا در بارگذاری محاسبات MRP');
      }
    } catch (err: any) {
      setError(err.message || 'خطا در ارتباط با سرور');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMoList = useCallback(async () => {
    try {
      const res = await fetch('/api/mrp/mos');
      const json = await res.json();
      if (json.success && json.data) {
        setMoList(json.data);
        if (json.data.length > 0 && !selectedMoId) {
          setSelectedMoId(json.data[0].id);
        }
      }
    } catch {
      // ignore
    }
  }, [selectedMoId]);

  const loadPurchaseRequisitions = useCallback(async () => {
    try {
      const res = await fetch('/api/mrp/purchase-requisitions');
      const json = await res.json();
      if (json.success && Array.isArray(json.data) && json.data.length > 0) {
        const serverMap: Record<string, IssuedPrRecord> = {};
        for (const r of json.data) {
          if (r.status !== 'CANCELLED') {
            serverMap[r.materialCode] = {
              prNumber: r.prNumber,
              materialCode: r.materialCode,
              materialName: r.materialName,
              quantity: r.quantity,
              unit: r.unit,
              createdAt: r.createdAtFa || r.createdAt,
            };
          }
        }
        setIssuedPrMap(prev => ({ ...prev, ...serverMap }));
      }
    } catch {
      // keep local fallback
    }
  }, []);

  useEffect(() => {
    loadMrp();
    loadMoList();
    loadPurchaseRequisitions();
  }, [loadMrp, loadMoList, loadPurchaseRequisitions]);

  // Run Pre-issue check when selected MO changes
  const runMoCheck = async (moIdToTest?: string) => {
    const targetId = moIdToTest || selectedMoId;
    if (!targetId) return;
    setCheckingMo(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/mrp/mos/${encodeURIComponent(targetId)}/check`);
      const json = await res.json();
      if (json.success && json.data) {
        setMoCheckResult(json.data);
      } else {
        setError(json.error || 'خطا در بررسی مواد دستور کار');
      }
    } catch (err: any) {
      setError(err.message || 'خطا در بررسی مواد');
    } finally {
      setCheckingMo(false);
    }
  };

  useEffect(() => {
    if (selectedMoId && activeTab === 'pre_issue') {
      runMoCheck(selectedMoId);
    }
  }, [selectedMoId, activeTab]);

  const handleAutoReserve = async () => {
    if (!selectedMoId) return;
    setReservingMo(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/mrp/mos/${encodeURIComponent(selectedMoId)}/reserve`, {
        method: 'POST',
      });
      const json = await res.json();
      if (json.success) {
        const count = json.data?.reserved?.length || 0;
        setNotice(`موجودی آزاد با موفقیت برای دستور کار ${json.data?.moNumber} رزرو شد (${toPersianDigits(count)} ردیف رزرو جدید).`);
        await runMoCheck(selectedMoId);
        await loadMrp();
        if (onRefreshGlobal) await onRefreshGlobal();
      } else {
        setError(json.error || 'خطا در رزرو خودکار مواد');
      }
    } catch (err: any) {
      setError(err.message || 'خطا در انجام عملیات رزرو');
    } finally {
      setReservingMo(false);
    }
  };

  const handleRunSimulation = async () => {
    setSimulating(true);
    setError(null);
    try {
      await loadMrp({
        growth: simGrowth,
        horizon: simHorizon,
        includeWip: simIncludeWip,
        includeConsignment: simIncludeConsignment,
      });
      setActiveTab('materials');
    } finally {
      setSimulating(false);
    }
  };

  const handleExportCsv = () => {
    if (!mrpData) return;
    const headers = [
      'کد ماده اولیه',
      'عنوان ماده',
      'گرید',
      'ضخامت (mm)',
      'واحد',
      'نیاز کل ناخالص',
      'نیاز وزنی (kg)',
      'موجودی ملکی',
      'موجودی امانی ساپکو',
      'قرنطینه کیفی',
      'رزرو فعال',
      'موجودی خالص آزاد (ATP)',
      'قرارداد باز ساپکو',
      'کسری کل',
      'پوشش با قرارداد',
      'کسری قطعی',
      'وضعیت نهایی',
    ];

    const rows = mrpData.materials.map(m => [
      m.materialCode,
      `"${m.materialName.replace(/"/g, '""')}"`,
      m.materialGrade,
      m.thicknessMm,
      m.unitCode,
      m.requiredQuantity,
      m.requiredWeightKg,
      m.onHandOwned,
      m.onHandConsignment,
      m.onHandQuarantined,
      m.reservedActive,
      m.netAvailable,
      m.openContractQuantity,
      m.shortageQuantity,
      m.coveredByContract,
      m.hardShortageQuantity,
      m.severity === 'OK' ? 'پوشش کامل' : m.severity === 'SHORTAGE_COVERED_BY_CONTRACT' ? 'پوشش با قرارداد' : 'کسری قطعی',
    ]);

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `MRP_Material_Forecast_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Filtered materials
  const filteredMaterials = (mrpData?.materials || []).filter(m => {
    if (severityFilter !== 'ALL' && m.severity !== severityFilter) return false;
    if (gradeFilter !== 'ALL' && !m.materialGrade.toLowerCase().includes(gradeFilter.toLowerCase())) return false;
    if (materialSearch.trim()) {
      const q = materialSearch.toLowerCase();
      const matchCode = m.materialCode.toLowerCase().includes(q);
      const matchName = m.materialName.toLowerCase().includes(q);
      const matchGrade = m.materialGrade.toLowerCase().includes(q);
      if (!matchCode && !matchName && !matchGrade) return false;
    }
    return true;
  });

  return (
    <div className="space-y-4 print:space-y-3">
      {/* SAP Horizon Fiori Header & IconTabBar */}
      <div className="sap-card overflow-hidden no-print border border-[var(--fiori-border)]">
        <div className="px-4 py-3 flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-[var(--fiori-border)] bg-[var(--fiori-surface)]">
          <div className="flex items-start gap-2.5">
            <span className="p-2 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-brand-subtle)] text-[var(--fiori-brand)] border border-[var(--fiori-info-border)] shrink-0">
              <Calculator className="w-4 h-4" />
            </span>
            <div>
              <h1 className="text-sm font-semibold text-[var(--fiori-text-primary)] flex items-center gap-2 flex-wrap">
                پیش‌بینی نیازمندی مواد و موازنه کلاف (MRP)
                <FioriObjectStatus tone="info" size="sm" ltrCode label="ATP & BOM Explosion" />
              </h1>
              <p className="text-xs text-[var(--fiori-text-secondary)] mt-0.5">
                انفجار درخت محصول (BOM)، کسر موجودی آزاد ملکی و امانی ساپکو، حذف قرنطینه و پیش‌بینی پوشش قراردادها
              </p>
            </div>
          </div>

          <div className="flex items-center flex-wrap gap-2">
            {mrpData && (
              <div className="text-[11px] text-[var(--fiori-text-secondary)] hidden lg:flex items-center gap-1.5 bg-[var(--fiori-surface-subtle)] px-2.5 py-1 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border)]">
                <Clock className="w-3.5 h-3.5 text-[var(--fiori-brand)]" />
                <span>آخرین محاسبه:</span>
                <span className="text-[var(--fiori-text-primary)] font-semibold tabular-nums">{mrpData.ranAtFa}</span>
              </div>
            )}

            <button
              type="button"
              onClick={() => loadMrp()}
              disabled={loading}
              className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer disabled:opacity-50 whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-[var(--fiori-brand)]' : ''}`} />
              <span>محاسبه مجدد</span>
            </button>

            <button
              type="button"
              onClick={handleExportCsv}
              disabled={!mrpData}
              className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer disabled:opacity-50 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5 text-[var(--fiori-positive)]" />
              <span>خروجی اکسل</span>
            </button>

            <button
              type="button"
              onClick={() => window.print()}
              className="sap-btn-emphasized flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer whitespace-nowrap"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>چاپ رسمی</span>
            </button>
          </div>
        </div>

        <div className="sap-icon-tab-bar px-2 border-b-0">
          {[
            { id: 'materials', label: `۱. موازنه کلاف‌ها و مواد اولیه (${toPersianDigits(mrpData?.materials.length || 0)})` },
            { id: 'pre_issue', label: '۲. کنترل پیش از حواله دستور کار (Pre-Issue ATP)' },
            { id: 'parts', label: `۳. موازنه تقاضای قطعات (${toPersianDigits(mrpData?.parts.length || 0)})` },
            { id: 'simulation', label: '۴. شبیه‌ساز What-If' },
          ].map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id as any)}
              className={`sap-icon-tab ${activeTab === t.id ? 'sap-icon-tab-active' : ''}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Error & Notice Banners */}
      {error && (
        <FioriMessageStrip tone="error" onClose={() => setError(null)} compact>
          {error}
        </FioriMessageStrip>
      )}

      {notice && (
        <FioriMessageStrip tone="success" onClose={() => setNotice(null)} compact>
          {notice}
        </FioriMessageStrip>
      )}

      {/* Skeleton Loading State */}
      {loading && !mrpData && (
        <ReportModuleSkeleton kpiCount={6} showChart={false} tableRows={6} tableColumns={9} theme="light" />
      )}

      {/* KPI Cards Summary */}
      {mrpData && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
          <div className="sap-card p-3 text-right border border-[var(--fiori-border)]">
            <span className="text-[11px] text-[var(--fiori-text-secondary)] font-semibold block">تعداد مواد و کلاف‌ها</span>
            <div className="text-lg font-bold text-[var(--fiori-text-primary)] font-mono mt-0.5 tabular-nums">
              {toPersianDigits(mrpData.summary.materialsConsidered)}
            </div>
            <span className="text-[10px] text-[var(--fiori-text-muted)] mt-0.5 block">اقلام فعال در BOM</span>
          </div>

          <div className="sap-card p-3 text-right border border-[var(--fiori-border)]">
            <span className="text-[11px] text-[var(--fiori-positive)] font-semibold flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" />
              پوشش کامل با موجودی
            </span>
            <div className="text-lg font-bold text-[var(--fiori-positive)] font-mono mt-0.5 tabular-nums">
              {toPersianDigits(mrpData.summary.ok)}
            </div>
            <span className="text-[10px] text-[var(--fiori-text-muted)] mt-0.5 block">تأمین تضمین‌شده</span>
          </div>

          <div className="sap-card p-3 text-right border border-[var(--fiori-border)]">
            <span className="text-[11px] text-[var(--fiori-critical)] font-semibold flex items-center gap-1">
              <Info className="w-3.5 h-3.5" />
              پوشش با قرارداد باز
            </span>
            <div className="text-lg font-bold text-[var(--fiori-critical)] font-mono mt-0.5 tabular-nums">
              {toPersianDigits(mrpData.summary.contractCovered)}
            </div>
            <span className="text-[10px] text-[var(--fiori-text-muted)] mt-0.5 block">در انتظار تحویل سهمیه</span>
          </div>

          <div className="sap-card p-3 text-right border border-[var(--fiori-negative-border)] bg-[var(--fiori-negative-bg)]">
            <span className="text-[11px] text-[var(--fiori-negative)] font-semibold flex items-center gap-1">
              <ShieldAlert className="w-3.5 h-3.5" />
              کسری قطعی مواد
            </span>
            <div className="text-lg font-bold text-[var(--fiori-negative)] font-mono mt-0.5 tabular-nums">
              {toPersianDigits(mrpData.summary.hardShortages)}
            </div>
            <span className="text-[10px] text-[var(--fiori-negative)] mt-0.5 block font-semibold">هشدار توقف پرس</span>
          </div>

          <div className="sap-card p-3 text-right border border-[var(--fiori-border)]">
            <span className="text-[11px] text-[var(--fiori-text-secondary)] font-semibold block">کل وزن ناخالص مواد</span>
            <div className="text-base font-bold text-[var(--fiori-text-primary)] font-mono mt-0.5 tabular-nums">
              {formatNumber(mrpData.summary.totalGrossWeightKg)} <span className="text-xs font-normal text-[var(--fiori-text-secondary)]">kg</span>
            </div>
            <span className="text-[10px] text-[var(--fiori-text-muted)] mt-0.5 block">شامل نرم ضایعات</span>
          </div>

          <div className="sap-card p-3 text-right border border-[var(--fiori-border)]">
            <span className="text-[11px] text-[var(--fiori-negative)] font-semibold block">کسری وزنی کل کلاف‌ها</span>
            <div className="text-base font-bold text-[var(--fiori-negative)] font-mono mt-0.5 tabular-nums">
              {formatNumber(mrpData.summary.totalShortageWeightKg)} <span className="text-xs font-normal text-[var(--fiori-negative)]">kg</span>
            </div>
            <span className="text-[10px] text-[var(--fiori-text-muted)] mt-0.5 block">نیاز به خرید / حواله</span>
          </div>
        </div>
      )}

      {/* =========================================================================
          TAB 1: MATERIALS NETTING MATRIX
          ========================================================================= */}
      {activeTab === 'materials' && (
        <div className="space-y-3">
          {/* Filters Bar */}
          <div className="sap-card p-3 flex flex-col sm:flex-row items-center justify-between gap-2.5 no-print border border-[var(--fiori-border)]">
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <div className="relative flex-1 sm:w-64">
                <Search className="w-3.5 h-3.5 text-[var(--fiori-text-secondary)] absolute right-2.5 top-2" />
                <input
                  type="text"
                  placeholder="جستجو در کد، نام کلاف یا گرید..."
                  value={materialSearch}
                  onChange={e => setMaterialSearch(e.target.value)}
                  className="w-full bg-[var(--fiori-surface-subtle)] border border-[var(--fiori-border-strong)] rounded-[var(--fiori-radius-sm)] pr-8 pl-3 py-1 text-xs text-[var(--fiori-text-primary)] placeholder-[var(--fiori-text-muted)] focus:bg-[var(--fiori-surface)] focus:outline-none focus:border-[var(--fiori-brand)]"
                />
              </div>

              <select
                value={gradeFilter}
                onChange={e => setGradeFilter(e.target.value)}
                className="bg-[var(--fiori-surface)] border border-[var(--fiori-border-strong)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)]"
              >
                <option value="ALL">همه گریدها</option>
                <option value="DC04">DC04 (کشش عمیق)</option>
                <option value="ST14">ST14 (روغنی فرم‌دهی)</option>
                <option value="DX51">DX51D (گالوانیزه)</option>
                <option value="ST37">ST37 (شیت سیاه)</option>
              </select>
            </div>

            <div className="flex items-center gap-1.5 w-full sm:w-auto overflow-x-auto pb-1 sm:pb-0">
              <span className="text-[11px] text-[var(--fiori-text-secondary)] ml-1">فیلتر وضعیت:</span>
              <button
                type="button"
                onClick={() => setSeverityFilter('ALL')}
                className={`px-2.5 py-1 rounded-[var(--fiori-radius-sm)] text-xs font-semibold cursor-pointer transition ${
                  severityFilter === 'ALL'
                    ? 'bg-[var(--fiori-brand)] text-white'
                    : 'bg-[var(--fiori-surface)] text-[var(--fiori-text-primary)] hover:bg-[var(--fiori-brand-subtle)] border border-[var(--fiori-border)]'
                }`}
              >
                همه ({toPersianDigits(mrpData?.materials.length || 0)})
              </button>

              <button
                type="button"
                onClick={() => setSeverityFilter('HARD_SHORTAGE')}
                className={`px-2.5 py-1 rounded-[var(--fiori-radius-sm)] text-xs font-semibold cursor-pointer transition flex items-center gap-1 ${
                  severityFilter === 'HARD_SHORTAGE'
                    ? 'bg-[var(--fiori-negative)] text-white'
                    : 'bg-[var(--fiori-surface)] text-[var(--fiori-negative)] hover:bg-[var(--fiori-negative-bg)] border border-[var(--fiori-negative-border)]'
                }`}
              >
                <ShieldAlert className="w-3 h-3" />
                کسری قطعی ({toPersianDigits(mrpData?.summary.hardShortages || 0)})
              </button>

              <button
                type="button"
                onClick={() => setSeverityFilter('SHORTAGE_COVERED_BY_CONTRACT')}
                className={`px-2.5 py-1 rounded-[var(--fiori-radius-sm)] text-xs font-semibold cursor-pointer transition flex items-center gap-1 ${
                  severityFilter === 'SHORTAGE_COVERED_BY_CONTRACT'
                    ? 'bg-[var(--fiori-critical)] text-white'
                    : 'bg-[var(--fiori-surface)] text-[var(--fiori-critical)] hover:bg-[var(--fiori-critical-bg)] border border-[var(--fiori-critical-border)]'
                }`}
              >
                <Info className="w-3 h-3" />
                پوشش با قرارداد ({toPersianDigits(mrpData?.summary.contractCovered || 0)})
              </button>

              <button
                type="button"
                onClick={() => setSeverityFilter('OK')}
                className={`px-2.5 py-1 rounded-[var(--fiori-radius-sm)] text-xs font-semibold cursor-pointer transition flex items-center gap-1 ${
                  severityFilter === 'OK'
                    ? 'bg-[var(--fiori-positive)] text-white'
                    : 'bg-[var(--fiori-surface)] text-[var(--fiori-positive)] hover:bg-[var(--fiori-positive-bg)] border border-[var(--fiori-positive-border)]'
                }`}
              >
                <CheckCircle2 className="w-3 h-3" />
                کافی ({toPersianDigits(mrpData?.summary.ok || 0)})
              </button>
            </div>
          </div>

          {/* Table */}
          <div className="sap-card overflow-hidden printable-area border border-[var(--fiori-border)]">
            {/* Print Header shown only during print */}
            <div className="hidden print:block p-4 border-b border-[var(--fiori-border)] text-center">
              <span className="text-xs text-[var(--fiori-text-secondary)] block">شرکت تولیدی قطعات خودرو (زنجیره تامین ساپکو)</span>
              <h2 className="text-base font-bold text-[var(--fiori-text-primary)] mt-1">گزارش رسمی پیش‌بینی نیازمندی مواد و موازنه کلاف (MRP)</h2>
              <span className="text-[10px] text-[var(--fiori-text-secondary)] font-mono">تاریخ موازنه: {mrpData?.ranAtFa || 'امروز'}</span>
            </div>

            <FioriToolbar
              variant="table"
              title="جدول موازنه مواد اولیه و کلاف‌های فولادی (MRP Netting)"
              count={filteredMaterials.length}
              countLabel="ماده اولیه"
              className="no-print"
            />

            {filteredMaterials.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  variant={materialSearch || severityFilter !== 'ALL' || gradeFilter !== 'ALL' ? 'FILTER_NO_MATCH' : 'NO_DATA'}
                  compact
                  actionLabel={materialSearch || severityFilter !== 'ALL' || gradeFilter !== 'ALL' ? 'پاک‌سازی فیلترها' : undefined}
                  onAction={
                    materialSearch || severityFilter !== 'ALL' || gradeFilter !== 'ALL'
                      ? () => {
                          setMaterialSearch('');
                          setSeverityFilter('ALL');
                          setGradeFilter('ALL');
                        }
                      : undefined
                  }
                />
              </div>
            ) : (
            <div className="overflow-x-auto">
              <table className="sap-table-compact w-full text-right">
                <thead>
                  <tr>
                    <th className="py-1.5 px-2.5">کد و عنوان ماده اولیه</th>
                    <th className="py-1.5 px-2.5 text-center">گرید و ضخامت</th>
                    <th className="py-1.5 px-2.5 text-center text-[var(--fiori-brand)]">
                      <span className="inline-flex items-center">
                        <span>نیاز کل (kg)</span>
                        <FormulaTooltip
                          title="فرمول نیاز ناخالص ماده اولیه (BOM Explosion)"
                          formula="GrossKg = Σ (NetPartDemand × UnitWeight × (1 + ScrapPct))"
                          description="حاصل‌ضرب نیاز خالص تولید هر قطعه در وزن استاندارد واحد به علاوه ضریب پرت و ضایعات مصوب."
                          badgeColor="indigo"
                        />
                      </span>
                    </th>
                    <th className="py-1.5 px-2.5 text-center">موجودی ملکی</th>
                    <th className="py-1.5 px-2.5 text-center text-[var(--fiori-positive)]">امانی ساپکو</th>
                    <th className="py-1.5 px-2.5 text-center text-[var(--fiori-negative)]">قرنطینه (QC Hold)</th>
                    <th className="py-1.5 px-2.5 text-center text-[var(--fiori-critical)]">رزرو فعال</th>
                    <th className="py-1.5 px-2.5 text-center text-[var(--fiori-positive)]">
                      <span className="inline-flex items-center">
                        <span>موجودی آزاد (ATP)</span>
                        <FormulaTooltip
                          title="فرمول موجودی آزاد قابل برنامه‌ریزی (ATP)"
                          formula="ATP = (Owned + Consignment) - Reserved - QCHold"
                          description="هر کالا یا رول ورقی که در قرنطینه کیفی (QC Hold) قرار گیرد، مستقیماً از موجودی آزاد (ATP) کسر شده و در تولید لحاظ نمی‌گردد."
                          badgeColor="emerald"
                        />
                      </span>
                    </th>
                    <th className="py-1.5 px-2.5 text-center text-[var(--fiori-brand)]">قرارداد باز</th>
                    <th className="py-1.5 px-2.5 text-center text-[var(--fiori-negative)]">
                      <span className="inline-flex items-center">
                        <span>کسری قطعی</span>
                        <FormulaTooltip
                          title="فرمول کسری قطعی (Hard Shortage)"
                          formula="HardShortage = max(0, (RequiredKg - ATP) - OpenContractKg)"
                          description="مقدار کسری ماده اولیه که نه با موجودی آزاد انبار (ATP) و نه با سهمیه قراردادهای باز ساپکو پوشش داده نمی‌شود."
                          badgeColor="rose"
                        />
                      </span>
                    </th>
                    <th className="py-1.5 px-2.5 text-center">وضعیت تأمین</th>
                    <th className="py-1.5 px-2.5 text-center no-print">اکشن سریع تدارکات (PR)</th>
                    <th className="py-1.5 px-2.5 text-center no-print">قطعات متقاضی</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {filteredMaterials.map(m => {
                    const isExpanded = expandedMaterialCode === m.materialCode;
                    const hasVipDemand = m.demandedByParts.some(dp => vipMap[dp.partId] || vipMap[dp.partCode]);
                    const issuedPr = issuedPrMap[m.materialCode];
                    const effectiveShortage = m.hardShortageQuantity > 0 ? m.hardShortageQuantity : m.shortageQuantity;
                    return (
                      <React.Fragment key={m.materialId}>
                        <tr
                          className={`transition ${
                            hasVipDemand
                              ? 'bg-[var(--fiori-critical-bg)] hover:opacity-95'
                              : 'hover:bg-[var(--fiori-surface-hover)]'
                          }`}
                        >
                          <td className="py-1.5 px-2.5 font-sans">
                            <div className="font-semibold text-[var(--fiori-text-primary)] flex items-center gap-1.5 flex-wrap">
                              <span>{m.materialName}</span>
                              {hasVipDemand && (
                                <FioriObjectStatus
                                  tone="critical"
                                  size="sm"
                                  icon={<Pin className="w-2.5 h-2.5" />}
                                  label="VIP"
                                />
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => traceDocument(m.materialCode, 'INVENTORY_LEDGER')}
                              className="sap-doc-link text-[11px] fiori-ltr-code cursor-pointer"
                            >
                              {m.materialCode}
                            </button>
                          </td>
                          <td className="py-1.5 px-2.5 text-center">
                            <FioriObjectStatus tone="neutral" size="sm" ltrCode label={m.materialGrade} />
                            {m.thicknessMm > 0 && (
                              <span className="block text-[10px] text-[var(--fiori-text-secondary)] font-mono mt-0.5 tabular-nums">
                                {toPersianDigits(m.thicknessMm)} mm
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 px-2.5 text-center text-[var(--fiori-brand)] font-semibold">
                            {formatNumber(m.requiredWeightKg)}
                          </td>
                          <td className="py-1.5 px-2.5 text-center text-[var(--fiori-text-primary)]">
                            {formatNumber(m.onHandOwned)}
                          </td>
                          <td className="py-1.5 px-2.5 text-center text-[var(--fiori-positive)] font-semibold">
                            {formatNumber(m.onHandConsignment)}
                          </td>
                          <td className="py-1.5 px-2.5 text-center text-[var(--fiori-negative)]">
                            {m.onHandQuarantined > 0 ? (
                              <span className="text-[var(--fiori-negative)] font-semibold underline" title="خارج از چرخه تخصیص">
                                {formatNumber(m.onHandQuarantined)}
                              </span>
                            ) : (
                              '۰'
                            )}
                          </td>
                          <td className="py-1.5 px-2.5 text-center text-[var(--fiori-critical)]">
                            {formatNumber(m.reservedActive)}
                          </td>
                          <td className="py-1.5 px-2.5 text-center text-[var(--fiori-positive)] font-bold bg-[var(--fiori-positive-bg)]">
                            {formatNumber(m.netAvailable)}
                          </td>
                          <td className="py-1.5 px-2.5 text-center text-[var(--fiori-brand)]">
                            {formatNumber(m.openContractQuantity)}
                          </td>
                          <td className="py-1.5 px-2.5 text-center font-bold">
                            {m.hardShortageQuantity > 0 ? (
                              <FioriObjectStatus tone="negative" size="sm" label={formatNumber(m.hardShortageQuantity)} />
                            ) : (
                              <span className="text-[var(--fiori-text-muted)]">-</span>
                            )}
                          </td>
                          <td className="py-1.5 px-2.5 text-center font-sans">
                            {m.severity === 'OK' && (
                              <FioriObjectStatus tone="positive" size="sm" icon label="پوشش کامل" />
                            )}
                            {m.severity === 'SHORTAGE_COVERED_BY_CONTRACT' && (
                              <FioriObjectStatus tone="critical" size="sm" icon label="پوشش قرارداد" />
                            )}
                            {m.severity === 'HARD_SHORTAGE' && (
                              <FioriObjectStatus tone="negative" size="sm" icon label="کسری قطعی" />
                            )}
                          </td>
                          <td className="py-1.5 px-2.5 text-center font-sans no-print">
                            {issuedPr ? (
                              <div className="inline-flex flex-col items-center gap-0.5">
                                <FioriObjectStatus tone="info" size="sm" ltrCode label={`✓ ${issuedPr.prNumber}`} />
                                <span className="text-[9px] text-[var(--fiori-text-secondary)] tabular-nums">
                                  {formatNumber(issuedPr.quantity)} {issuedPr.unit}
                                </span>
                              </div>
                            ) : effectiveShortage > 0 ? (
                              <button
                                type="button"
                                onClick={() =>
                                  handleIssuePurchaseRequisition(
                                    m.materialCode,
                                    m.materialName,
                                    effectiveShortage,
                                    'kg',
                                    m.materialGrade
                                  )
                                }
                                title="صدور فوری درخواست خرید (Purchase Requisition) برای جبران کسری"
                                className="px-2.5 py-1 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-negative)] hover:opacity-90 text-white text-[11px] font-semibold inline-flex items-center gap-1 transition cursor-pointer whitespace-nowrap"
                              >
                                <ShoppingCart className="w-3 h-3" />
                                <span>صدور درخواست خرید (PR)</span>
                              </button>
                            ) : (
                              <span className="text-[10px] text-[var(--fiori-text-muted)]">نیاز ندارد</span>
                            )}
                          </td>
                          <td className="py-1.5 px-2.5 text-center">
                            <button
                              type="button"
                              onClick={() => setExpandedMaterialCode(isExpanded ? null : m.materialCode)}
                              className="sap-btn-standard px-2 py-0.5 text-[11px] font-sans inline-flex items-center gap-1 cursor-pointer whitespace-nowrap"
                            >
                              <span>{toPersianDigits(m.demandedByParts.length)} قطعه</span>
                              {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                            </button>
                          </td>
                        </tr>

                        {/* Expanded Drawer for Demanded Parts & Matching Coils */}
                        {isExpanded && (
                          <tr className="bg-[var(--fiori-surface-subtle)] border-b border-[var(--fiori-border)] font-sans">
                            <td colSpan={13} className="p-3">
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                                {/* Demanded by Parts */}
                                <div className="bg-[var(--fiori-surface)] border border-[var(--fiori-border)] rounded-[var(--fiori-radius-sm)] p-3">
                                  <h4 className="font-semibold text-[var(--fiori-text-primary)] mb-2 flex items-center gap-2">
                                    <Boxes className="w-4 h-4 text-[var(--fiori-brand)]" />
                                    قطعات متقاضی این متریال در برنامه:
                                  </h4>
                                  <div className="space-y-1.5">
                                    {m.demandedByParts.map((dp, idx) => (
                                      <div
                                        key={idx}
                                        className="flex items-center justify-between p-2 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-surface-subtle)] border border-[var(--fiori-border)]"
                                      >
                                        <div>
                                          <div className="font-semibold text-[var(--fiori-text-primary)]">{dp.partName}</div>
                                          <button
                                            type="button"
                                            onClick={() => traceDocument(dp.partCode, 'INVENTORY_LEDGER')}
                                            className="sap-doc-link text-[10px] fiori-ltr-code cursor-pointer"
                                          >
                                            {dp.partCode}
                                          </button>
                                        </div>
                                        <div className="text-left font-mono tabular-nums">
                                          <div className="text-[var(--fiori-brand)] font-semibold">
                                            {formatNumber(dp.weightKg)} <span className="text-[10px] font-sans text-[var(--fiori-text-secondary)]">kg</span>
                                          </div>
                                          <div className="text-[10px] text-[var(--fiori-text-secondary)]">
                                            ({formatNumber(dp.requiredQuantity)} عدد)
                                          </div>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>

                                {/* Physical Matching Coils in Plant */}
                                <div className="bg-[var(--fiori-surface)] border border-[var(--fiori-border)] rounded-[var(--fiori-radius-sm)] p-3">
                                  <h4 className="font-semibold text-[var(--fiori-text-primary)] mb-2 flex items-center gap-2">
                                    <Layers className="w-4 h-4 text-[var(--fiori-positive)]" />
                                    کلاف‌ها و رول‌های فیزیکی منطبق پای پرس:
                                  </h4>
                                  {m.matchingCoils.length > 0 ? (
                                    <div className="space-y-1.5">
                                      {m.matchingCoils.map((c, idx) => (
                                        <div
                                          key={idx}
                                          className="flex items-center justify-between p-2 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-surface-subtle)] border border-[var(--fiori-border)]"
                                        >
                                          <div>
                                            <button
                                              type="button"
                                              onClick={() => traceDocument(c.coilNumber, 'COILS')}
                                              className="sap-doc-link font-semibold fiori-ltr-code cursor-pointer"
                                            >
                                              {c.coilNumber}
                                            </button>
                                            <div className="text-[10px] text-[var(--fiori-text-secondary)]">
                                              {c.ownership === 'SAPCO_CONSIGNMENT' ? 'امانی ساپکو' : 'ملکی کارخانه'} • {c.warehouseLocation}
                                            </div>
                                          </div>
                                          <div className="text-left font-mono tabular-nums">
                                            <span className="text-[var(--fiori-positive)] font-semibold text-xs">
                                              {formatNumber(c.remainingWeightKg)} kg
                                            </span>
                                            <span className="block text-[10px] text-[var(--fiori-text-secondary)]">
                                              ضخامت {toPersianDigits(c.thicknessMm)}mm
                                            </span>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <EmptyState
                                      variant="NO_DATA"
                                      compact
                                      title="کلاف منطبق ثبت نشده است"
                                      description="هیچ رول فیزیکی با این مشخصات در انبار ثبت نشده است."
                                    />
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            )}
          </div>
        </div>
      )}

      {/* =========================================================================
          TAB 2: PRE-ISSUE CHECK & AUTO-RESERVE (بررسی پیش از حواله)
          ========================================================================= */}
      {activeTab === 'pre_issue' && (
        <div className="space-y-4">
          {/* MO Selector & ATP Status Card */}
          <div className="sap-card p-4 border border-[var(--fiori-border)] space-y-3">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex-1">
                <label className="block text-xs font-semibold text-[var(--fiori-text-primary)] mb-1.5">
                  انتخاب دستور کار ساخت (MO) جهت بررسی موجودی مواد پیش از صدور حواله:
                </label>
                <div className="flex items-center gap-2">
                  <select
                    value={selectedMoId}
                    onChange={e => setSelectedMoId(e.target.value)}
                    className="flex-1 max-w-xl bg-[var(--fiori-surface)] border border-[var(--fiori-border-strong)] rounded-[var(--fiori-radius-sm)] px-3 py-1.5 text-xs text-[var(--fiori-text-primary)] font-medium focus:outline-none focus:border-[var(--fiori-brand)]"
                  >
                    {moList.map(mo => (
                      <option key={mo.id} value={mo.id}>
                        {mo.moNumber} — {mo.partName} ({formatNumber(mo.targetQuantity)} عدد) [وضعیت: {mo.status}]
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    onClick={() => runMoCheck(selectedMoId)}
                    disabled={checkingMo}
                    className="sap-btn-standard px-3.5 py-1.5 text-xs font-semibold transition cursor-pointer disabled:opacity-50 flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${checkingMo ? 'animate-spin text-[var(--fiori-brand)]' : ''}`} />
                    <span>بررسی در لحظه</span>
                  </button>
                </div>
              </div>

              {moCheckResult && (
                <button
                  type="button"
                  onClick={handleAutoReserve}
                  disabled={reservingMo}
                  className="sap-btn-emphasized px-4 py-2 text-xs font-semibold transition cursor-pointer disabled:opacity-50 flex flex-col items-center justify-center gap-0.5 text-center whitespace-nowrap"
                >
                  <div className="flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5" />
                    <span>رزرو خودکار موجودی آزاد (ATP)</span>
                  </div>
                  <span className="text-[10px] opacity-90 font-normal">
                    قفل کردن مواد در انبار برای این دستور کار
                  </span>
                </button>
              )}
            </div>

            {moCheckResult && (
              <FioriMessageStrip
                tone={moCheckResult.readyToIssue ? 'success' : 'error'}
                title={moCheckResult.readyToIssue ? 'آماده صدور حواله خروج پای پرس' : 'دارای کسری مواد / عدم امکان حواله'}
                compact
              >
                {moCheckResult.readyToIssue
                  ? 'کلیه ورق‌ها و قطعات این دستور کار در انبار آزاد و موجود است.'
                  : 'یک یا چند قلم متریال در انبار آزاد نبوده و نیازمند حواله یا تأمین است.'}
              </FioriMessageStrip>
            )}
          </div>

          {/* BOM Materials Availability Table */}
          {moCheckResult && (
            <div className="sap-card overflow-hidden border border-[var(--fiori-border)]">
              <FioriToolbar
                variant="table"
                title={
                  <span className="inline-flex items-center gap-1.5">
                    <span>جدول موازنه اقلام BOM دستور کار</span>
                    <button
                      type="button"
                      onClick={() => traceDocument(moCheckResult.moNumber, 'WIP_TRACEABILITY')}
                      className="sap-doc-link fiori-ltr-code cursor-pointer"
                    >
                      {moCheckResult.moNumber}
                    </button>
                    <span>({moCheckResult.partName})</span>
                  </span>
                }
                count={moCheckResult.lines.length}
                countLabel="ردیف BOM"
                endContent={
                  <span className="text-xs text-[var(--fiori-text-secondary)] font-mono tabular-nums">
                    تیراژ مصوب: {formatNumber(moCheckResult.targetQuantity)} عدد
                  </span>
                }
              />

              {moCheckResult.lines.length === 0 ? (
                <div className="p-6">
                  <EmptyState variant="NO_DATA" compact title="هیچ قلم BOM یافت نشد" />
                </div>
              ) : (
              <div className="overflow-x-auto">
                <table className="sap-table-compact w-full text-right">
                  <thead>
                    <tr>
                      <th className="py-1.5 px-2.5">کد و عنوان قطعه / ماده در BOM</th>
                      <th className="py-1.5 px-2.5 text-center">واحد</th>
                      <th className="py-1.5 px-2.5 text-center text-[var(--fiori-brand)]">کل نیاز سفارش</th>
                      <th className="py-1.5 px-2.5 text-center">حواله شده قبلی</th>
                      <th className="py-1.5 px-2.5 text-center">باقیمانده نیاز</th>
                      <th className="py-1.5 px-2.5 text-center">موجودی انبار</th>
                      <th className="py-1.5 px-2.5 text-center text-[var(--fiori-critical)]">رزرو همین MO</th>
                      <th className="py-1.5 px-2.5 text-center text-[var(--fiori-negative)]">رزرو سایر MOها</th>
                      <th className="py-1.5 px-2.5 text-center text-[var(--fiori-positive)]">آزاد برای این MO</th>
                      <th className="py-1.5 px-2.5 text-center text-[var(--fiori-negative)]">کسری</th>
                      <th className="py-1.5 px-2.5 text-center">وضعیت ردیف</th>
                      <th className="py-1.5 px-2.5 text-center">اکشن سریع خرید (PR)</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono tabular-nums">
                    {moCheckResult.lines.map((l, idx) => {
                      const linePr = issuedPrMap[l.materialCode];
                      return (
                        <tr key={idx} className="hover:bg-[var(--fiori-surface-hover)] transition">
                          <td className="py-1.5 px-2.5 font-sans">
                            <div className="font-semibold text-[var(--fiori-text-primary)]">{l.materialName}</div>
                            <button
                              type="button"
                              onClick={() => traceDocument(l.materialCode, 'INVENTORY_LEDGER')}
                              className="sap-doc-link text-[11px] fiori-ltr-code cursor-pointer"
                            >
                              {l.materialCode}
                            </button>
                            {l.notes.length > 0 && (
                              <div className="text-[10px] text-[var(--fiori-text-secondary)] mt-0.5">{l.notes.join(' • ')}</div>
                            )}
                          </td>
                          <td className="py-1.5 px-2.5 text-center text-[var(--fiori-text-secondary)]">{l.unitCode}</td>
                          <td className="py-1.5 px-2.5 text-center text-[var(--fiori-brand)] font-semibold">{formatNumber(l.requiredQuantity)}</td>
                          <td className="py-1.5 px-2.5 text-center text-[var(--fiori-text-secondary)]">{formatNumber(l.alreadyIssuedQuantity)}</td>
                          <td className="py-1.5 px-2.5 text-center text-[var(--fiori-text-primary)] font-semibold">{formatNumber(l.remainingRequired)}</td>
                          <td className="py-1.5 px-2.5 text-center text-[var(--fiori-text-primary)]">{formatNumber(l.onHandApproved)}</td>
                          <td className="py-1.5 px-2.5 text-center text-[var(--fiori-critical)] font-semibold">{formatNumber(l.reservedForThisMo)}</td>
                          <td className="py-1.5 px-2.5 text-center text-[var(--fiori-negative)]">{formatNumber(l.reservedForOthers)}</td>
                          <td className="py-1.5 px-2.5 text-center text-[var(--fiori-positive)] font-bold bg-[var(--fiori-positive-bg)]">
                            {formatNumber(l.availableForThisMo)}
                          </td>
                          <td className="py-1.5 px-2.5 text-center font-bold">
                            {l.shortageQuantity > 0 ? (
                              <FioriObjectStatus tone="negative" size="sm" label={formatNumber(l.shortageQuantity)} />
                            ) : (
                              <span className="text-[var(--fiori-text-muted)]">۰</span>
                            )}
                          </td>
                          <td className="py-1.5 px-2.5 text-center font-sans">
                            {l.status === 'READY' && (
                              <FioriObjectStatus tone="positive" size="sm" icon label="آماده حواله" />
                            )}
                            {l.status === 'SHORTAGE' && (
                              <FioriObjectStatus tone="negative" size="sm" icon label="کسری موجودی" />
                            )}
                            {l.status === 'NOT_REQUIRED' && (
                              <FioriObjectStatus tone="neutral" size="sm" label="تأمین کامل شده" />
                            )}
                          </td>
                          <td className="py-1.5 px-2.5 text-center font-sans">
                            {linePr ? (
                              <FioriObjectStatus tone="info" size="sm" ltrCode label={`✓ ${linePr.prNumber}`} />
                            ) : l.shortageQuantity > 0 ? (
                              <button
                                type="button"
                                onClick={() =>
                                  handleIssuePurchaseRequisition(
                                    l.materialCode,
                                    l.materialName,
                                    l.shortageQuantity,
                                    l.unitCode
                                  )
                                }
                                className="px-2.5 py-1 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-negative)] hover:opacity-90 text-white text-[10px] font-semibold inline-flex items-center gap-1 cursor-pointer transition whitespace-nowrap"
                              >
                                <ShoppingCart className="w-3 h-3" />
                                <span>صدور درخواست خرید (PR)</span>
                              </button>
                            ) : (
                              <span className="text-[10px] text-[var(--fiori-text-muted)]">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* =========================================================================
          TAB 3: PARTS DEMAND NETTING (موازنه تقاضای قطعات - با دکمه کشوی تعریف درجا BOM/مسیر)
          ========================================================================= */}
      {activeTab === 'parts' && mrpData && (
        <div className="sap-card overflow-hidden border border-[var(--fiori-border)]">
          <FioriToolbar
            variant="table"
            title="موازنه تیراژ قطعات نهایی خودرویی (تقاضای باز مشتریان نسبت به موجودی و WIP)"
            subtitle="بر روی وضعیت‌های «فاقد BOM» یا «فاقد مسیر» کلیک کنید تا کشوی جانبی تعریف سریع مستندات فنی باز شود (بدون خروج از ماژول MRP)."
            count={mrpData.parts.length}
            countLabel="محصول"
          />

          {mrpData.parts.length === 0 ? (
            <div className="p-6">
              <EmptyState variant="NO_DATA" compact title="تقاضای قطعه‌ای در MRP ثبت نشده است" />
            </div>
          ) : (
          <div className="overflow-x-auto">
            <table className="sap-table-compact w-full text-right">
              <thead>
                <tr>
                  <th className="py-1.5 px-2.5">کد و نام قطعه خودرویی</th>
                  <th className="py-1.5 px-2.5">خودرو</th>
                  <th className="py-1.5 px-2.5 text-center text-[var(--fiori-brand)]">تقاضای ناخالص</th>
                  <th className="py-1.5 px-2.5 text-center text-[var(--fiori-positive)]">موجودی محصول نهایی</th>
                  <th className="py-1.5 px-2.5 text-center text-[var(--fiori-critical)]">رزرو محصول</th>
                  <th className="py-1.5 px-2.5 text-center text-[var(--fiori-brand)]">کار در جریان (WIP)</th>
                  <th className="py-1.5 px-2.5 text-center text-[var(--fiori-brand)]">دستور کار باز (MO)</th>
                  <th className="py-1.5 px-2.5 text-center text-[var(--fiori-negative)]">نیاز خالص تولید</th>
                  <th className="py-1.5 px-2.5 text-center">وضعیت مستندات فنی (کلیک برای تکمیل در کشو)</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {mrpData.parts.map(p => (
                  <tr
                    key={p.partId}
                    className={`transition ${
                      p.isVIP ? 'bg-[var(--fiori-critical-bg)] hover:opacity-95' : 'hover:bg-[var(--fiori-surface-hover)]'
                    }`}
                  >
                    <td className="py-1.5 px-2.5 font-sans">
                      <div className="font-semibold text-[var(--fiori-text-primary)] flex items-center gap-1.5 flex-wrap">
                        <span>{p.partName}</span>
                        {p.isVIP && (
                          <FioriObjectStatus
                            tone="critical"
                            size="sm"
                            icon={<Pin className="w-2.5 h-2.5" />}
                            label="VIP"
                          />
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => traceDocument(p.partCode, 'INVENTORY_LEDGER')}
                        className="sap-doc-link text-[11px] fiori-ltr-code cursor-pointer"
                      >
                        {p.partCode}
                      </button>
                    </td>
                    <td className="py-1.5 px-2.5 font-sans text-[var(--fiori-text-primary)]">{p.carModel || '-'}</td>
                    <td className="py-1.5 px-2.5 text-center text-[var(--fiori-brand)] font-semibold">
                      {formatNumber(p.grossDemand)}
                    </td>
                    <td className="py-1.5 px-2.5 text-center text-[var(--fiori-positive)] font-semibold">
                      {formatNumber(p.coveredByFgStock)}
                    </td>
                    <td className="py-1.5 px-2.5 text-center text-[var(--fiori-critical)]">
                      {formatNumber(p.coveredByFgReservations)}
                    </td>
                    <td className="py-1.5 px-2.5 text-center text-[var(--fiori-brand)] font-semibold">
                      {formatNumber(p.coveredByWip)}
                    </td>
                    <td className="py-1.5 px-2.5 text-center text-[var(--fiori-brand)]">
                      {formatNumber(p.coveredByActiveMos)}
                    </td>
                    <td className="py-1.5 px-2.5 text-center font-bold">
                      {p.netRequirement > 0 ? (
                        <FioriObjectStatus tone="negative" size="sm" label={formatNumber(p.netRequirement)} />
                      ) : (
                        <FioriObjectStatus tone="positive" size="sm" label="پوشش کامل (۰)" />
                      )}
                    </td>
                    <td className="py-1.5 px-2.5 text-center font-sans">
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleOpenBomRoutingDrawer(p, 'BOM')}
                          title={
                            p.hasBom
                              ? 'مشاهده یا ویرایش درخت محصول (BOM) در کشوی جانبی'
                              : 'کلیک جهت تعریف سریع BOM در کشوی جانبی بدون خروج از MRP'
                          }
                          className={`px-2 py-1 rounded-[var(--fiori-radius-sm)] text-[10px] font-semibold inline-flex items-center gap-1 transition cursor-pointer whitespace-nowrap ${
                            p.hasBom
                              ? 'bg-[var(--fiori-positive-bg)] text-[var(--fiori-positive)] border border-[var(--fiori-positive-border)] hover:opacity-90'
                              : 'bg-[var(--fiori-negative)] hover:opacity-90 text-white border border-[var(--fiori-negative)]'
                          }`}
                        >
                          <Edit3 className="w-2.5 h-2.5" />
                          <span>{p.hasBom ? 'BOM تأییدشده' : 'فاقد BOM (تعریف +)'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleOpenBomRoutingDrawer(p, 'ROUTING')}
                          title={
                            p.hasRouting
                              ? 'مشاهده یا ویرایش مسیر تولید (Routing) در کشوی جانبی'
                              : 'کلیک جهت تعریف سریع مسیر تولید در کشوی جانبی بدون خروج از MRP'
                          }
                          className={`px-2 py-1 rounded-[var(--fiori-radius-sm)] text-[10px] font-semibold inline-flex items-center gap-1 transition cursor-pointer whitespace-nowrap ${
                            p.hasRouting
                              ? 'bg-[var(--fiori-info-bg)] text-[var(--fiori-info)] border border-[var(--fiori-info-border)] hover:opacity-90'
                              : 'bg-[var(--fiori-critical)] hover:opacity-90 text-white border border-[var(--fiori-critical)]'
                          }`}
                        >
                          <GitBranch className="w-2.5 h-2.5" />
                          <span>{p.hasRouting ? 'مسیر ساخت' : 'فاقد مسیر (تعریف +)'}</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </div>
      )}

      {/* =========================================================================
          TAB 4: DEMAND SIMULATION (شبیه‌ساز سناریوی تقاضا)
          ========================================================================= */}
      {activeTab === 'simulation' && (
        <div className="sap-card p-5 space-y-4 border border-[var(--fiori-border)]">
          <div>
            <h3 className="text-sm font-semibold text-[var(--fiori-text-primary)] flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[var(--fiori-brand)]" />
              شبیه‌ساز پیش‌بینی نیازمندی مواد و سناریوی رشد تقاضا (What-If Simulation)
            </h3>
            <p className="text-xs text-[var(--fiori-text-secondary)] mt-0.5">
              تنظیم سناریوهای رشد تقاضای ساپکو، افق زمانی برنامه‌ریزی، و سنجش میزان کسری کلاف قبل از تعهد تجاری
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3.5">
            <div className="bg-[var(--fiori-surface-subtle)] border border-[var(--fiori-border)] rounded-[var(--fiori-radius-sm)] p-3.5">
              <label className="block text-xs font-semibold text-[var(--fiori-text-primary)] mb-2">
                درصد رشد تقاضای سفارشات:
              </label>
              <div className="flex items-center gap-1.5">
                {[0, 15, 25, 50].map(pct => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => setSimGrowth(pct)}
                    className={`flex-1 py-1.5 rounded-[var(--fiori-radius-sm)] text-xs font-semibold transition cursor-pointer ${
                      simGrowth === pct
                        ? 'bg-[var(--fiori-brand)] text-white'
                        : 'bg-[var(--fiori-surface)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] border border-[var(--fiori-border)]'
                    }`}
                  >
                    {pct === 0 ? 'مبنا (۰٪)' : `+${toPersianDigits(pct)}٪`}
                  </button>
                ))}
              </div>
            </div>

            <div className="bg-[var(--fiori-surface-subtle)] border border-[var(--fiori-border)] rounded-[var(--fiori-radius-sm)] p-3.5">
              <label className="block text-xs font-semibold text-[var(--fiori-text-primary)] mb-2">
                افق زمانی برنامه‌ریزی:
              </label>
              <div className="flex items-center gap-1.5">
                {[7, 14, 30, 90].map(days => (
                  <button
                    key={days}
                    type="button"
                    onClick={() => setSimHorizon(days)}
                    className={`flex-1 py-1.5 rounded-[var(--fiori-radius-sm)] text-xs font-semibold transition cursor-pointer ${
                      simHorizon === days
                        ? 'bg-[var(--fiori-brand)] text-white'
                        : 'bg-[var(--fiori-surface)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] border border-[var(--fiori-border)]'
                    }`}
                  >
                    {toPersianDigits(days)} روزه
                  </button>
                ))}
              </div>
            </div>

            <div className="bg-[var(--fiori-surface-subtle)] border border-[var(--fiori-border)] rounded-[var(--fiori-radius-sm)] p-3.5 flex flex-col justify-between">
              <label className="block text-xs font-semibold text-[var(--fiori-text-primary)] mb-2">
                ملاحظات چرخه ساخت و موجودی:
              </label>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs text-[var(--fiori-text-primary)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={simIncludeWip}
                    onChange={e => setSimIncludeWip(e.target.checked)}
                    className="accent-[var(--fiori-brand)] rounded"
                  />
                  <span>لحاظ کردن موجودی کار در جریان (WIP)</span>
                </label>
                <label className="flex items-center gap-2 text-xs text-[var(--fiori-text-primary)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={simIncludeConsignment}
                    onChange={e => setSimIncludeConsignment(e.target.checked)}
                    className="accent-[var(--fiori-brand)] rounded"
                  />
                  <span>شمارش موجودی امانی ساپکو</span>
                </label>
              </div>
            </div>

            <div className="flex items-end">
              <button
                type="button"
                onClick={handleRunSimulation}
                disabled={simulating}
                className="sap-btn-emphasized w-full py-3 text-xs font-semibold transition cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <Sparkles className="w-4 h-4" />
                <span>اجرای شبیه‌سازی سناریو</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          SLIDE-OVER DRAWER FOR INLINE BOM & ROUTING DEFINITION INSIDE MRP
          ========================================================================= */}
      {bomRoutingDrawerPart && (
        <div
          className="fixed inset-0 z-[85] flex justify-end bg-black/40"
          dir="rtl"
          onClick={() => setBomRoutingDrawerPart(null)}
        >
          <div
            className="relative w-full max-w-xl bg-[var(--fiori-surface)] h-full shadow-xl border-r border-[var(--fiori-border)] flex flex-col justify-between overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            {/* Sticky Header */}
            <div className="sticky top-0 z-20 p-4 border-b border-[var(--fiori-border)] bg-[var(--fiori-surface)] flex items-center justify-between">
              <div>
                <FioriObjectStatus tone="info" size="sm" label="حل بن‌بست فنی درجا (Inline MRP Technical Resolution)" />
                <h3 className="text-sm font-semibold text-[var(--fiori-text-primary)] mt-1">
                  تعریف BOM و مسیر تولید: {bomRoutingDrawerPart.partName}
                </h3>
                <p className="text-[11px] text-[var(--fiori-text-secondary)] font-mono mt-0.5 tabular-nums">
                  {bomRoutingDrawerPart.partCode} | تقاضای خالص: {formatNumber(bomRoutingDrawerPart.netRequirement)} عدد
                </p>
              </div>
              <button
                type="button"
                onClick={() => setBomRoutingDrawerPart(null)}
                className="p-1.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border)] bg-[var(--fiori-surface-subtle)] hover:bg-[var(--fiori-surface-hover)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Section Switcher Tabs */}
            <div className="sap-icon-tab-bar px-4 bg-[var(--fiori-surface-subtle)]">
              <button
                type="button"
                onClick={() => setDrawerFocusSection('BOM')}
                className={`sap-icon-tab ${drawerFocusSection === 'BOM' ? 'sap-icon-tab-active' : ''}`}
              >
                <Layers className="w-3.5 h-3.5" />
                <span>۱. ساختار درخت محصول (BOM ورق و اقلام)</span>
              </button>
              <button
                type="button"
                onClick={() => setDrawerFocusSection('ROUTING')}
                className={`sap-icon-tab ${drawerFocusSection === 'ROUTING' ? 'sap-icon-tab-active' : ''}`}
              >
                <GitBranch className="w-3.5 h-3.5" />
                <span>۲. مسیر تولید و ایستگاه‌ها (Routing / OP)</span>
              </button>
            </div>

            {/* Form Body */}
            <form onSubmit={handleSaveBomRoutingFromDrawer} className="flex-1 p-4 space-y-4 text-xs">
              {/* BOM Section */}
              <div
                className={`p-3.5 rounded-[var(--fiori-radius-sm)] border space-y-3 ${
                  drawerFocusSection === 'BOM'
                    ? 'bg-[var(--fiori-brand-subtle)] border-[var(--fiori-brand)]'
                    : 'bg-[var(--fiori-surface-subtle)] border-[var(--fiori-border)]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-[var(--fiori-text-primary)] flex items-center gap-1.5">
                    <Layers className="w-4 h-4 text-[var(--fiori-brand)]" />
                    <span>مشخصات ماده اولیه و درخت محصول (BOM)</span>
                  </span>
                  <FioriObjectStatus tone="info" size="sm" label="انفجار خودکار در MRP" />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-[var(--fiori-text-primary)] mb-1">گرید ورق فولادی (Grade):</label>
                    <select
                      value={drawerBomGrade}
                      onChange={e => setDrawerBomGrade(e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-surface)] border border-[var(--fiori-border-strong)] text-[var(--fiori-text-primary)] font-semibold focus:border-[var(--fiori-brand)] focus:outline-none"
                    >
                      <option value="DC04">DC04 (ورق روغنی کشش عمیق ساپکو)</option>
                      <option value="ST14">ST14 (ورق روغنی فوق کشش)</option>
                      <option value="ST12">ST12 (ورق سرد معمولی)</option>
                      <option value="DX51D">DX51D (ورق گالوانیزه ضدخوردگی)</option>
                      <option value="S355MC">S355MC (ورق استحکام بالا شاسی)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block font-semibold text-[var(--fiori-text-primary)] mb-1">ضخامت ورق (mm):</label>
                    <input
                      type="number"
                      step="0.1"
                      min="0.4"
                      max="6.0"
                      value={drawerBomThickness}
                      onChange={e => setDrawerBomThickness(e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-surface)] border border-[var(--fiori-border-strong)] text-[var(--fiori-text-primary)] font-mono tabular-nums focus:border-[var(--fiori-brand)] focus:outline-none"
                      required
                    />
                  </div>

                  <div>
                    <label className="block font-semibold text-[var(--fiori-text-primary)] mb-1">وزن خالص قطعه (kg):</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0.05"
                      value={drawerBomUnitWeight}
                      onChange={e => setDrawerBomUnitWeight(e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-surface)] border border-[var(--fiori-border-strong)] text-[var(--fiori-text-primary)] font-mono tabular-nums focus:border-[var(--fiori-brand)] focus:outline-none"
                      required
                    />
                  </div>

                  <div>
                    <label className="block font-semibold text-[var(--fiori-text-primary)] mb-1">ضریب پرت و ضایعات برش (%):</label>
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      max="40"
                      value={drawerBomScrapPct}
                      onChange={e => setDrawerBomScrapPct(e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-surface)] border border-[var(--fiori-border-strong)] text-[var(--fiori-text-primary)] font-mono tabular-nums focus:border-[var(--fiori-brand)] focus:outline-none"
                      required
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-[var(--fiori-border)]">
                  <div className="sm:col-span-2">
                    <label className="block font-semibold text-[var(--fiori-text-primary)] mb-1">قطعه/یراق مونتاژی فرعی (Sub-Component):</label>
                    <input
                      type="text"
                      value={drawerBomHardware}
                      onChange={e => setDrawerBomHardware(e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-surface)] border border-[var(--fiori-border-strong)] text-[var(--fiori-text-primary)] focus:border-[var(--fiori-brand)] focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-[var(--fiori-text-primary)] mb-1">ضریب مصرف در واحد:</label>
                    <input
                      type="number"
                      min="0"
                      value={drawerBomHardwareQty}
                      onChange={e => setDrawerBomHardwareQty(e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-surface)] border border-[var(--fiori-border-strong)] text-[var(--fiori-text-primary)] font-mono tabular-nums focus:border-[var(--fiori-brand)] focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Routing Section */}
              <div
                className={`p-3.5 rounded-[var(--fiori-radius-sm)] border space-y-3 ${
                  drawerFocusSection === 'ROUTING'
                    ? 'bg-[var(--fiori-brand-subtle)] border-[var(--fiori-brand)]'
                    : 'bg-[var(--fiori-surface-subtle)] border-[var(--fiori-border)]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-[var(--fiori-text-primary)] flex items-center gap-1.5">
                    <GitBranch className="w-4 h-4 text-[var(--fiori-brand)]" />
                    <span>ایستگاه‌های مسیر تولید (Routing Operations)</span>
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setDrawerOps(prev => [
                        ...prev,
                        {
                          stepCode: `OP-${(prev.length + 1) * 10}`,
                          stepName: 'ایستگاه عملیاتی جدید',
                          machineName: 'پرس ضربه‌ای ۱۶۰ تن ۱',
                          cycleTimeSec: 10,
                        },
                      ])
                    }
                    className="sap-btn-emphasized px-2.5 py-1 text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3 h-3" />
                    <span>افزودن ایستگاه OP</span>
                  </button>
                </div>

                <div className="space-y-2">
                  {drawerOps.map((op, idx) => (
                    <div
                      key={idx}
                      className="p-2 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-surface)] border border-[var(--fiori-border)] grid grid-cols-12 gap-2 items-center"
                    >
                      <div className="col-span-2">
                        <input
                          type="text"
                          value={op.stepCode}
                          onChange={e =>
                            setDrawerOps(prev =>
                              prev.map((item, i) => (i === idx ? { ...item, stepCode: e.target.value } : item))
                            )
                          }
                          className="w-full px-2 py-1 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-surface-subtle)] border border-[var(--fiori-border)] font-mono text-[11px] font-semibold text-[var(--fiori-brand)] fiori-ltr-code"
                        />
                      </div>
                      <div className="col-span-4">
                        <input
                          type="text"
                          value={op.stepName}
                          onChange={e =>
                            setDrawerOps(prev =>
                              prev.map((item, i) => (i === idx ? { ...item, stepName: e.target.value } : item))
                            )
                          }
                          placeholder="شرح عملیات"
                          className="w-full px-2 py-1 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-surface-subtle)] border border-[var(--fiori-border)] text-[11px]"
                        />
                      </div>
                      <div className="col-span-4">
                        <input
                          type="text"
                          value={op.machineName}
                          onChange={e =>
                            setDrawerOps(prev =>
                              prev.map((item, i) => (i === idx ? { ...item, machineName: e.target.value } : item))
                            )
                          }
                          placeholder="ماشین / پرس"
                          className="w-full px-2 py-1 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-surface-subtle)] border border-[var(--fiori-border)] text-[11px]"
                        />
                      </div>
                      <div className="col-span-2 flex items-center justify-end gap-1">
                        <input
                          type="number"
                          min="1"
                          value={op.cycleTimeSec}
                          onChange={e =>
                            setDrawerOps(prev =>
                              prev.map((item, i) =>
                                i === idx ? { ...item, cycleTimeSec: Number(e.target.value) || 8 } : item
                              )
                            )
                          }
                          title="زمان سیکل (ثانیه)"
                          className="w-12 px-1.5 py-1 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-surface-subtle)] border border-[var(--fiori-border)] font-mono text-[11px] text-center tabular-nums"
                        />
                        {drawerOps.length > 1 && (
                          <button
                            type="button"
                            onClick={() => setDrawerOps(prev => prev.filter((_, i) => i !== idx))}
                            className="p-1 text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-negative)] cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Sticky Footer */}
              <div className="sticky bottom-0 pt-3 pb-2 bg-[var(--fiori-surface)] border-t border-[var(--fiori-border)] flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setBomRoutingDrawerPart(null)}
                  className="sap-btn-standard px-4 py-1.5 text-xs cursor-pointer"
                >
                  انصراف
                </button>
                <button
                  type="submit"
                  className="sap-btn-emphasized px-4 py-1.5 text-xs cursor-pointer"
                >
                  ذخیره مستندات فنی و بروزرسانی درجا در MRP
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
