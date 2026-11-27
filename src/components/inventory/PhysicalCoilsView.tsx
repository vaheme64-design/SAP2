import React, { useState, useEffect, useMemo } from 'react';
import {
  Layers,
  Search,
  ArrowUpRight,
  ArrowDownLeft,
  RotateCcw,
  Plus,
  CheckCircle2,
  Tag,
  Clock,
  Printer,
  FileText,
  Boxes,
  Split,
  Edit3,
  ShieldAlert,
  Lock,
  Unlock,
} from 'lucide-react';
import { PhysicalCoil } from '../../types/inventory';
import { formatNumber, formatWeightKg, toPersianDigits } from '../../utils/formatters';
import { CoilSlittingGenealogyPanel } from './CoilSlittingGenealogyPanel';
import { useEnterpriseUx } from '../../context/EnterpriseUxContext';
import { useErpRouter } from '../../context/RouterContext';
import { loadQcHoldMap, saveQcHoldMap, QcHoldRecord } from '../../utils/qcHoldStore';
import {
  FioriDynamicPage,
  FioriToolbar,
  FioriDataTable,
  FioriTableColumn,
  FioriObjectStatus,
  FioriMessageStrip,
  FioriDialog,
} from '../fiori/ui';
import { EmptyState } from '../common/EmptyState';

interface PhysicalCoilsViewProps {
  onRefresh?: () => Promise<void>;
  initialSearchQuery?: string;
  currentUser: {
    uid: string;
    displayName: string;
  };
}

export const PhysicalCoilsView: React.FC<PhysicalCoilsViewProps> = ({
  currentUser,
  initialSearchQuery,
  onRefresh,
}) => {
  const router = useErpRouter();
  const { requestConfirm, showUndoToast, openQuickEditDrawer, recordAudit } = useEnterpriseUx();
  const [coils, setCoils] = useState<PhysicalCoil[]>([]);
  const [qcHoldMap, setQcHoldMap] = useState<Record<string, QcHoldRecord>>(() => loadQcHoldMap());
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState(initialSearchQuery || '');
  const [gradeFilter, setGradeFilter] = useState('ALL');
  const [thicknessFilter, setThicknessFilter] = useState('ALL');
  const [warehouseFilter, setWarehouseFilter] = useState('ALL');
  const [contractFilter, setContractFilter] = useState('ALL');
  const [qualityFilter, setQualityFilter] = useState<'ALL' | 'AVAILABLE' | 'QUALITY_HOLD'>('ALL');
  const [ownershipFilter, setOwnershipFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'FULL' | 'PARTIAL' | 'CONSUMED'>('ALL');

  useEffect(() => {
    if (initialSearchQuery !== undefined && initialSearchQuery !== '') {
      setSearchTerm(initialSearchQuery);
    }
  }, [initialSearchQuery]);

  useEffect(() => {
    const onHoldChange = () => setQcHoldMap(loadQcHoldMap());
    window.addEventListener('kpims-qc-hold-changed', onHoldChange);
    return () => window.removeEventListener('kpims-qc-hold-changed', onHoldChange);
  }, []);

  const isCoilInQcHold = (c: PhysicalCoil): boolean => {
    return Boolean(
      c.qualityStatus === 'QUARANTINE' ||
        c.qualityStatus === 'QUALITY_BLOCKED' ||
        qcHoldMap[c.id]?.isHeld ||
        qcHoldMap[c.coilId]?.isHeld
    );
  };

  // Mandatory QC Hold Reason Modal State
  const [qcHoldModalCoil, setQcHoldModalCoil] = useState<PhysicalCoil | null>(null);
  const [qcHoldReasonInput, setQcHoldReasonInput] = useState('');
  const [qcHoldReasonError, setQcHoldReasonError] = useState('');

  const QC_HOLD_REASON_PRESETS = [
    'زنگ‌زدگی سطحی ورق (Surface Rust / Oxidation)',
    'مغایرت ضخامت یا عرض با تلرانس فنی ساپکو',
    'عدم انطباق نتایج تست کشش / سختی با گواهی ذوب',
    'لهیدگی لبه کلاف در زمان حمل و تخلیه (Edge Damage)',
    'موج‌دار بودن سطح ورق یا پوسته شدن گالوانیزه',
  ];

  const executeCoilQcHoldChange = async (coil: PhysicalCoil, nextHeld: boolean, mandatoryReasonFa?: string) => {
    const prevMap = { ...qcHoldMap };
    const prevCoils = [...coils];
    const updatedMap = { ...qcHoldMap };
    const finalReason = (mandatoryReasonFa || '').trim() || 'قرنطینه کیفی کلاف ورق (QC Hold)';

    if (nextHeld) {
      const rec: QcHoldRecord = {
        key: coil.id,
        partId: coil.partId,
        partCode: coil.partCode,
        partName: `${coil.partName} (${coil.coilId})`,
        lotNumber: coil.coilId,
        warehouseName: coil.warehouseName,
        isHeld: true,
        heldQty: coil.remainingWeightKg,
        heldWeightKg: coil.remainingWeightKg,
        unit: 'KG',
        reasonFa: finalReason,
        updatedAt: new Date().toLocaleString('fa-IR'),
        actor: currentUser?.displayName || 'واحد کنترل کیفیت',
      };
      updatedMap[coil.id] = rec;
      updatedMap[coil.coilId] = rec;
    } else {
      delete updatedMap[coil.id];
      delete updatedMap[coil.coilId];
    }

    setQcHoldMap(updatedMap);
    saveQcHoldMap(updatedMap);
    setCoils(prev =>
      prev.map(c =>
        c.id === coil.id
          ? { ...c, qualityStatus: nextHeld ? 'QUARANTINE' : 'AVAILABLE' }
          : c
      )
    );

    const idempotencyKey = `QC-HOLD-${coil.id}-${nextHeld ? 'HOLD' : 'RELEASE'}-${Date.now()}`;

    try {
      const res = await fetch('/api/inventory/qc-hold', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          key: coil.id,
          physicalCoilId: coil.id,
          partId: coil.partId,
          partCode: coil.partCode,
          materialGrade: coil.materialGrade,
          warehouseId: coil.warehouseId,
          locationCode: coil.warehouseLocationCode,
          lotNumber: coil.coilPackNumber || coil.coilId,
          ownership: coil.ownership,
          contractId:
            coil.allocations?.length === 1
              ? coil.allocations[0].contractId
              : undefined,
          isHeld: nextHeld,
          heldQty: coil.remainingWeightKg,
          heldWeightKg: coil.remainingWeightKg,
          reasonFa: finalReason,
          idempotencyKey,
          user: currentUser,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        setQcHoldMap(prevMap);
        saveQcHoldMap(prevMap);
        setCoils(prevCoils);
        setNotification({
          type: 'error',
          message: data?.error || 'خطا در ثبت تغییر وضعیت قرنطینه کیفی کلاف در سرور',
        });
        return;
      }
    } catch (err: any) {
      setQcHoldMap(prevMap);
      saveQcHoldMap(prevMap);
      setCoils(prevCoils);
      setNotification({
        type: 'error',
        message: err?.message || 'خطا در ارتباط با سرور هنگام ثبت قرنطینه کیفی کلاف',
      });
      return;
    }

    await fetchCoils();
    if (onRefresh) {
      await onRefresh();
    }

    recordAudit({
      actionType: 'STATUS_CHANGE',
      module: 'مدیریت کلاف‌های ورق (QC Hold)',
      entityId: coil.id,
      entityCode: coil.coilId,
      summaryFa: nextHeld
        ? `قرنطینه کیفی کلاف «${coil.coilId}» (${formatWeightKg(coil.remainingWeightKg)}) — علت: ${finalReason}`
        : `رفع قرنطینه کیفی کلاف «${coil.coilId}» و بازگشت به ATP`,
      details: nextHeld
        ? `علت قرنطینه (QC Hold Reason): ${finalReason} | کسر ${formatWeightKg(coil.remainingWeightKg)} از موجودی آزاد (ATP) در MRP`
        : `آزادسازی کلاف ${coil.coilId} و بازگشت به موجودی قابل برنامه‌ریزی`,
      beforeSnapshot: { qualityStatus: coil.qualityStatus },
      afterSnapshot: {
        qualityStatus: nextHeld ? 'QUARANTINE' : 'AVAILABLE',
        qcHoldReason: nextHeld ? finalReason : null,
      },
    });

    showUndoToast({
      title: nextHeld
        ? `🔒 کلاف «${coil.coilId}» در قرنطینه کیفی قرار گرفت`
        : `🔓 قرنطینه کیفی کلاف «${coil.coilId}» آزاد شد`,
      description: nextHeld
        ? `علت: ${finalReason} | ${formatWeightKg(coil.remainingWeightKg)} از ATP کسر شد.`
        : 'کلاف به چرخه موجودی آزاد بازگشت.',
      onUndo: () => {
        void executeCoilQcHoldChange(coil, !nextHeld, 'بازگردانی دستی تغییر وضعیت قرنطینه (Undo)');
      },
    });
  };

  const handleToggleCoilQcHold = (coil: PhysicalCoil) => {
    const currentlyHeld = isCoilInQcHold(coil);
    const nextHeld = !currentlyHeld;

    if (nextHeld) {
      // Open Mandatory QC Hold Reason Modal before freezing the coil
      setQcHoldModalCoil(coil);
      setQcHoldReasonInput('');
      setQcHoldReasonError('');
      return;
    }

    requestConfirm({
      title: `رفع قرنطینه کیفی رول ورق — کلاف «${coil.coilId}»`,
      description: `آیا از تایید کیفی و آزادسازی کلاف «${coil.coilId}» اطمینان دارید؟`,
      consequenceText: `وزن ${formatWeightKg(
        coil.remainingWeightKg
      )} مجدداً به موجودی آزاد قابل تخصیص (ATP) در ماژول MRP بازگردانده می‌شود.`,
      severity: 'info',
      confirmLabel: 'تأیید رفع قرنطینه کلاف',
      onConfirm: async () => {
        await executeCoilQcHoldChange(coil, false);
      },
    });
  };

  const handleConfirmQcHoldModalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!qcHoldModalCoil) return;
    const trimmedReason = qcHoldReasonInput.trim();
    if (!trimmedReason) {
      setQcHoldReasonError('ثبت «علت قرنطینه (QC Hold Reason)» قبل از فریز کردن کلاف الزامی است.');
      return;
    }
    const targetCoil = qcHoldModalCoil;
    setQcHoldModalCoil(null);
    setQcHoldReasonInput('');
    setQcHoldReasonError('');
    await executeCoilQcHoldChange(targetCoil, true, trimmedReason);
  };

  // Modals
  const [selectedCoil, setSelectedCoil] = useState<PhysicalCoil | null>(null);
  const [issueModalOpen, setIssueModalOpen] = useState(false);
  const [returnModalOpen, setReturnModalOpen] = useState(false);
  const [allocateModalOpen, setAllocateModalOpen] = useState(false);
  const [genealogyModalOpen, setGenealogyModalOpen] = useState(false);

  // Issue Form states (Single vs Multi-Part issue)
  const [issueMode, setIssueMode] = useState<'SINGLE' | 'MULTI'>('SINGLE');
  const [issueWeight, setIssueWeight] = useState('');
  const [issueMoId, setIssueMoId] = useState('');
  const [issueOperationId, setIssueOperationId] = useState('');
  const [issueScrap, setIssueScrap] = useState('0');
  const [issueRequestKey, setIssueRequestKey] = useState('');
  const [initialInputQuantityPcs, setInitialInputQuantityPcs] = useState('');
  const [multiPartsList, setMultiPartsList] = useState<Array<{ partName: string; moId: string; moOperationId: string; issuedWeightKg: string }>>([
    { partName: '', moId: '', moOperationId: '', issuedWeightKg: '' },
  ]);
  const [availableManufacturingOrders, setAvailableManufacturingOrders] = useState<Array<{
    id: string; moNumber: string; partCode: string; partName: string; status: string;
    weightNetKg: number;
    weightGrossKg: number;
    wipManufacturingOrderId: string | null;
    operations: Array<{ id: string; stepNumber: number; operationCode: string; operationName: string; processType: string; status: string; plannedMachine?: string | null; isFirstOperation?: boolean }>;
  }>>([]);

  // Return Form states
  const [returnWeight, setReturnWeight] = useState('');
  const [returnVarianceWeight, setReturnVarianceWeight] = useState('0');
  const [returnRequestKey, setReturnRequestKey] = useState('');
  const [returnNotes, setReturnNotes] = useState('');

  // Multi-contract allocation form
  const [allocationsList, setAllocationsList] = useState<{ contractId: string; allocatedWeightKg: number }[]>([]);
  const [availableContracts, setAvailableContracts] = useState<
    Array<{ id: string; contractNumber: string; title?: string; customerName?: string }>
  >([]);

  const selectedIssueMo = availableManufacturingOrders.find(mo => mo.id === issueMoId);
  const selectedIssueOperation = selectedIssueMo?.operations.find(operation => operation.id === issueOperationId);
  const suggestedInitialInputPcs = selectedIssueMo && selectedIssueMo.weightGrossKg > 0
    ? Math.floor(Math.max(0, (Number(issueWeight) || 0) - (Number(issueScrap) || 0)) / selectedIssueMo.weightGrossKg)
    : 0;

  useEffect(() => {
    if (selectedIssueOperation?.isFirstOperation) {
      setInitialInputQuantityPcs(suggestedInitialInputPcs > 0 ? String(suggestedInitialInputPcs) : '');
    } else {
      setInitialInputQuantityPcs('');
    }
  }, [issueMoId, issueOperationId, issueWeight, issueScrap]);

  // Genealogy data state
  const [genealogyData, setGenealogyData] = useState<any>(null);
  const [genealogyLoading, setGenealogyLoading] = useState(false);

  // Feedback notification
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const fetchCoils = async () => {
    setLoading(true);
    try {
      const [coilsRes, cntRes, moRes] = await Promise.all([
        fetch('/api/inventory/coils'),
        fetch('/api/inventory/contracts'),
        fetch('/api/inventory/coils/issue-options'),
      ]);
      const data = await coilsRes.json();
      if (data.success) {
        setCoils(data.data);
      }
      const cntData = await cntRes.json();
      if (cntData.success && Array.isArray(cntData.data)) {
        setAvailableContracts(cntData.data);
      }
      const moData = await moRes.json();
      if (moData.success && Array.isArray(moData.data)) setAvailableManufacturingOrders(moData.data);
    } catch (err) {
      console.error('Error fetching coils:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCoils();
  }, []);

  // Dynamic filter option lists derived from live coils
  const dynamicGrades = useMemo(
    () => Array.from(new Set(coils.map(c => c.materialGrade).filter(Boolean))).sort(),
    [coils]
  );
  const dynamicThicknesses = useMemo(
    () => Array.from(new Set(coils.map(c => c.thicknessMm).filter(v => Number.isFinite(v) && v > 0))).sort((a, b) => a - b),
    [coils]
  );
  const dynamicWarehouses = useMemo(() => {
    const map = new Map<string, string>();
    coils.forEach(c => {
      if (c.warehouseId) map.set(c.warehouseId, c.warehouseName || c.warehouseId);
    });
    return Array.from(map.entries());
  }, [coils]);
  const dynamicContracts = useMemo(() => {
    const set = new Set<string>();
    coils.forEach(c => (c.allocations || []).forEach(a => { if (a.contractNumber) set.add(a.contractNumber); }));
    return Array.from(set).sort();
  }, [coils]);

  // Filtered coils
  const filteredCoils = useMemo(() => {
    return coils.filter(c => {
      if (gradeFilter !== 'ALL' && c.materialGrade !== gradeFilter) return false;
      if (thicknessFilter !== 'ALL' && Math.abs(Number(c.thicknessMm || 0) - Number(thicknessFilter)) >= 0.001) return false;
      if (warehouseFilter !== 'ALL' && c.warehouseId !== warehouseFilter) return false;
      if (contractFilter !== 'ALL' && !(c.allocations || []).some(a => a.contractNumber === contractFilter)) return false;
      if (qualityFilter === 'AVAILABLE' && isCoilInQcHold(c)) return false;
      if (qualityFilter === 'QUALITY_HOLD' && !isCoilInQcHold(c)) return false;
      if (ownershipFilter !== 'ALL' && c.ownership !== ownershipFilter) return false;

      // Status filter
      if (statusFilter === 'FULL' && (c.remainingWeightKg < c.originalWeightKg || c.remainingWeightKg <= 0)) {
        return false;
      }
      if (statusFilter === 'PARTIAL' && (c.remainingWeightKg >= c.originalWeightKg || c.remainingWeightKg <= 0)) {
        return false;
      }
      if (statusFilter === 'CONSUMED' && c.remainingWeightKg > 0) {
        return false;
      }

      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase();
        return (
          c.coilId.toLowerCase().includes(q) ||
          c.coilPackNumber.toLowerCase().includes(q) ||
          (c.partName && c.partName.toLowerCase().includes(q)) ||
          (c.partCode && c.partCode.toLowerCase().includes(q)) ||
          (c.heatNumber && c.heatNumber.toLowerCase().includes(q)) ||
          (c.allocations || []).some(a => a.contractNumber?.toLowerCase().includes(q))
        );
      }
      return true;
    });
  }, [coils, gradeFilter, thicknessFilter, warehouseFilter, contractFilter, qualityFilter, ownershipFilter, statusFilter, searchTerm, qcHoldMap]);

  // Aggregate stats across all coils
  const fullCoilsCount = coils.filter(c => c.remainingWeightKg === c.originalWeightKg && c.remainingWeightKg > 0).length;
  const partialCoilsCount = coils.filter(c => c.remainingWeightKg < c.originalWeightKg && c.remainingWeightKg > 0).length;
  const consumedCoilsCount = coils.filter(c => c.remainingWeightKg <= 0).length;
  const totalPhysicalWeight = filteredCoils.reduce((sum, c) => sum + c.remainingWeightKg, 0);

  const handleIssueSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCoil) return;

    if (issueMode === 'MULTI') {
      const validParts = multiPartsList.filter(p => Number(p.issuedWeightKg) > 0);
      if (validParts.length === 0 || validParts.some(p => !p.moId.trim() || !p.moOperationId.trim())) {
        setNotification({ type: 'error', message: 'برای هر ردیف، دستور ساخت، عملیات مجاز و وزن حواله را انتخاب کنید.' });
        return;
      }
      const totalMultiKg = validParts.reduce((sum, p) => sum + Number(p.issuedWeightKg), 0);
      const scrap = Number(issueScrap) || 0;
      const totalRequired = totalMultiKg + scrap;

      if (totalRequired <= 0 || totalRequired > selectedCoil.remainingWeightKg) {
        setNotification({
          type: 'error',
          message: `مجموع وزن تخصیص به قطعات (${totalRequired} kg) باید بین ۱ تا ${selectedCoil.remainingWeightKg} کیلوگرم باشد.`,
        });
        return;
      }

      try {
        const res = await fetch(`/api/inventory/coils/${selectedCoil.id}/issue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            issueRequestKey,
            multiParts: validParts.map(p => ({
              partName: p.partName,
              moId: p.moId,
              moOperationId: p.moOperationId,
              issuedWeightKg: Number(p.issuedWeightKg),
            })),
            scrappedKg: scrap,
            user: currentUser,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setNotification({ type: 'error', message: data.error || 'خطا در صدور چندقطعه‌ای کلاف' });
        } else {
          setNotification({ type: 'success', message: data.message });
          setIssueModalOpen(false);
          setIssueRequestKey('');
          fetchCoils();
        }
      } catch (err: any) {
        setNotification({ type: 'error', message: err.message || 'خطای شبکه' });
      }
    } else {
      const issuedKg = Number(issueWeight);
      if (!issueMoId.trim() || !issueOperationId.trim()) {
        setNotification({ type: 'error', message: 'برای رهگیری مصرف، دستور ساخت و عملیات تولید را انتخاب کنید.' });
        return;
      }
      if (!issuedKg || issuedKg <= 0 || issuedKg > selectedCoil.remainingWeightKg) {
        setNotification({
          type: 'error',
          message: `مقدار صادر شده باید بین ۱ تا ${selectedCoil.remainingWeightKg} کیلوگرم باشد.`,
        });
        return;
      }

      try {
        const res = await fetch(`/api/inventory/coils/${selectedCoil.id}/issue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            issueRequestKey,
            issuedWeightKg: issuedKg,
            moId: issueMoId.trim(),
            moOperationId: issueOperationId.trim(),
            scrappedKg: Number(issueScrap) || 0,
            initialInputQuantityPcs: selectedIssueOperation?.isFirstOperation ? Number(initialInputQuantityPcs) || 0 : undefined,
            wipManufacturingOrderId: selectedIssueMo?.wipManufacturingOrderId || undefined,
            user: currentUser,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setNotification({ type: 'error', message: data.error || 'خطا در صدور جزئی کلاف' });
        } else {
          setNotification({ type: 'success', message: data.message });
          setIssueModalOpen(false);
          setIssueRequestKey('');
          setIssueWeight('');
          fetchCoils();
        }
      } catch (err: any) {
        setNotification({ type: 'error', message: err.message || 'خطای شبکه' });
      }
    }
  };

  const handleReturnSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCoil) return;

    const returnedKg = Number(returnWeight);
    const varianceKg = Math.max(0, Number(returnVarianceWeight) || 0);
    if (!returnedKg || returnedKg <= 0) {
      setNotification({ type: 'error', message: 'وزن ته‌کلاف برگشتی باید مثبت باشد.' });
      return;
    }
    const netIssued = Math.max(0, selectedCoil.originalWeightKg - selectedCoil.remainingWeightKg);
    if (netIssued > 0 && returnedKg + varianceKg > netIssued + 0.001) {
      setNotification({
        type: 'error',
        message: `مجموع وزن برگشتی (${returnedKg} kg) و افت وزنی (${varianceKg} kg) نمی‌تواند از وزن صادرشده (${netIssued} kg) بیشتر باشد.`,
      });
      return;
    }

    const reqKey = returnRequestKey || `RET-COIL-${selectedCoil.id}-${Date.now()}`;
    try {
      const res = await fetch(`/api/inventory/coils/${selectedCoil.id}/return`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': reqKey,
        },
        body: JSON.stringify({
          returnedRemnantWeightKg: returnedKg,
          varianceWeightKg: varianceKg,
          idempotencyKey: reqKey,
          notes: returnNotes || 'برگشت مازاد یا ته‌کلاف از خط تولید به انبار',
          user: currentUser,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setNotification({ type: 'error', message: data.error || 'خطا در برگشت ته‌کلاف' });
      } else {
        setNotification({ type: 'success', message: data.message });
        setReturnModalOpen(false);
        setReturnWeight('');
        setReturnVarianceWeight('0');
        setReturnRequestKey('');
        fetchCoils();
        if (onRefresh) await onRefresh();
      }
    } catch (err: any) {
      setNotification({ type: 'error', message: err.message || 'خطای شبکه' });
    }
  };

  const openAllocateModal = (coil: PhysicalCoil) => {
    setSelectedCoil(coil);
    setAllocationsList(
      coil.allocations && coil.allocations.length > 0
        ? coil.allocations.map(a => ({ contractId: a.contractId, allocatedWeightKg: a.allocatedWeightKg }))
        : [{ contractId: 'CNT-SAPCO-1403-Q3', allocatedWeightKg: coil.originalWeightKg }]
    );
    setAllocateModalOpen(true);
  };

  const handleAllocateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCoil) return;

    const totalAlloc = allocationsList.reduce((sum, a) => sum + Number(a.allocatedWeightKg || 0), 0);
    if (totalAlloc > selectedCoil.originalWeightKg) {
      setNotification({
        type: 'error',
        message: `مجموع وزن تخصیص (${totalAlloc} kg) بیشتر از وزن کلاف (${selectedCoil.originalWeightKg} kg) است.`,
      });
      return;
    }

    try {
      const res = await fetch(`/api/inventory/coils/${selectedCoil.id}/allocate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          allocations: allocationsList,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setNotification({ type: 'error', message: data.error || 'خطا در ثبت تخصیص قراردادها' });
      } else {
        setNotification({ type: 'success', message: data.message });
        setAllocateModalOpen(false);
        fetchCoils();
      }
    } catch (err: any) {
      setNotification({ type: 'error', message: err.message || 'خطای شبکه' });
    }
  };

  const openGenealogyModal = async (coil: PhysicalCoil) => {
    setSelectedCoil(coil);
    setGenealogyModalOpen(true);
    setGenealogyLoading(true);
    try {
      const res = await fetch(`/api/inventory/coils/${coil.id}/genealogy`);
      const data = await res.json();
      if (data.success) {
        setGenealogyData(data.data);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setGenealogyLoading(false);
    }
  };

  const activeFiltersCount = [
    gradeFilter !== 'ALL',
    thicknessFilter !== 'ALL',
    warehouseFilter !== 'ALL',
    contractFilter !== 'ALL',
    qualityFilter !== 'ALL',
    ownershipFilter !== 'ALL',
    statusFilter !== 'ALL',
    Boolean(searchTerm.trim()),
  ].filter(Boolean).length;

  const resetAllFilters = () => {
    setGradeFilter('ALL');
    setThicknessFilter('ALL');
    setWarehouseFilter('ALL');
    setContractFilter('ALL');
    setQualityFilter('ALL');
    setOwnershipFilter('ALL');
    setStatusFilter('ALL');
    setSearchTerm('');
  };

  const coilColumns: FioriTableColumn<PhysicalCoil>[] = [
    {
      key: 'coilId',
      header: 'شناسه کویل',
      sortValue: coil => coil.coilId,
      render: coil => {
        const isHeld = isCoilInQcHold(coil);
        return (
          <div className="space-y-0.5">
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={() => router.traceDocument(coil.coilId, 'WIP_TRACEABILITY')}
                className="sap-doc-link font-mono fiori-ltr-code font-semibold cursor-pointer"
                title="ردگیری مصرف این کلاف در خط تولید"
              >
                {coil.coilId}
              </button>
              {isHeld && <FioriObjectStatus tone="negative" label="QC Hold" size="sm" ltrCode />}
            </div>
            {coil.heatNumber && (
              <button
                type="button"
                onClick={() => router.traceDocument(coil.heatNumber!, 'INVENTORY_LEDGER')}
                className="sap-doc-link text-[10px] block cursor-pointer"
                title="جستجوی شماره ذوب در کاردکس انبار"
              >
                ذوب: <span className="fiori-ltr-code">{coil.heatNumber}</span>
              </button>
            )}
          </div>
        );
      },
    },
    {
      key: 'coilPackNumber',
      header: 'شماره پکینگ (پلاک)',
      sortValue: coil => coil.coilPackNumber,
      render: coil => (
        <span className="font-mono text-[var(--fiori-text-primary)] font-medium fiori-ltr-code">
          {coil.coilPackNumber}
        </span>
      ),
    },
    {
      key: 'lifecycle',
      header: 'وضعیت چرخه عمر',
      sortValue: coil => (isCoilInQcHold(coil) ? 0 : coil.remainingWeightKg),
      render: coil => {
        const isHeld = isCoilInQcHold(coil);
        const isFull = coil.remainingWeightKg === coil.originalWeightKg && coil.remainingWeightKg > 0;
        const isPartial = coil.remainingWeightKg < coil.originalWeightKg && coil.remainingWeightKg > 0;

        if (isHeld) {
          return (
            <FioriObjectStatus
              tone="negative"
              icon={<Lock className="w-3 h-3" />}
              label="قرنطینه کیفی (کسر از ATP)"
            />
          );
        }
        if (isFull) {
          return <FioriObjectStatus tone="positive" label="کامل (دست‌نخورده)" />;
        }
        if (isPartial) {
          return <FioriObjectStatus tone="critical" label="ناقص / ته‌رول" />;
        }
        return <FioriObjectStatus tone="neutral" label="پایان‌یافته (صفر)" />;
      },
    },
    {
      key: 'partName',
      header: 'شرح ورق و ابعاد',
      sortValue: coil => coil.partName || '',
      render: coil => (
        <div>
          <div className="font-medium text-[var(--fiori-text-primary)]">{coil.partName}</div>
          <div className="text-[10px] text-[var(--fiori-text-secondary)] tabular-nums">
            ضخامت: {coil.thicknessMm}mm | عرض: {coil.widthMm}mm
          </div>
        </div>
      ),
    },
    {
      key: 'materialGrade',
      header: 'گرید',
      sortValue: coil => coil.materialGrade,
      render: coil => <FioriObjectStatus tone="neutral" label={coil.materialGrade} ltrCode />,
    },
    {
      key: 'originalWeightKg',
      header: 'وزن اولیه',
      sortValue: coil => coil.originalWeightKg,
      render: coil => (
        <span className="font-mono text-[var(--fiori-text-secondary)] tabular-nums whitespace-nowrap">
          {formatWeightKg(coil.originalWeightKg)}
        </span>
      ),
    },
    {
      key: 'remainingWeightKg',
      header: 'مانده در انبار',
      sortValue: coil => coil.remainingWeightKg,
      render: coil => {
        const isHeld = isCoilInQcHold(coil);
        return isHeld ? (
          <div className="font-mono font-bold tabular-nums">
            <span className="text-[var(--fiori-negative)] line-through">
              {formatWeightKg(coil.remainingWeightKg)}
            </span>
            <span className="block text-[10px] text-[var(--fiori-negative)] font-sans">
              آزاد (ATP): ۰ kg
            </span>
          </div>
        ) : (
          <span className="font-mono font-bold text-[var(--fiori-positive)] tabular-nums whitespace-nowrap">
            {formatWeightKg(coil.remainingWeightKg)}
          </span>
        );
      },
    },
    {
      key: 'allocations',
      header: 'سهمیه قراردادها',
      render: coil =>
        coil.allocations && coil.allocations.length > 0 ? (
          <div className="space-y-0.5">
            {coil.allocations.map((alloc, idx) => (
              <div key={idx} className="flex items-center justify-between gap-1 text-[11px]">
                <button
                  type="button"
                  onClick={() => router.traceDocument(alloc.contractNumber, 'CONTRACTS')}
                  className="sap-doc-link font-mono fiori-ltr-code cursor-pointer"
                  title="مشاهده قرارداد در ماژول قراردادها"
                >
                  {alloc.contractNumber}:
                </button>
                <span className="font-mono text-[var(--fiori-text-primary)] tabular-nums">
                  {formatNumber(alloc.allocatedWeightKg)} kg
                </span>
              </div>
            ))}
          </div>
        ) : (
          <span className="text-[var(--fiori-text-muted)] text-[11px]">—</span>
        ),
    },
    {
      key: 'warehouse',
      header: 'محل استقرار',
      sortValue: coil => coil.warehouseName,
      render: coil => (
        <div>
          <div className="text-[var(--fiori-text-primary)]">{coil.warehouseName}</div>
          <div className="text-[10px] text-[var(--fiori-text-secondary)] font-mono fiori-ltr-code">
            {coil.warehouseLocationCode}
          </div>
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'عملیات کارگاهی و پیوستگی',
      align: 'center',
      render: coil => {
        const isHeld = isCoilInQcHold(coil);
        return (
          <div className="flex items-center justify-center gap-1 flex-wrap">
            <button
              type="button"
              onClick={() => handleToggleCoilQcHold(coil)}
              className={`px-2 py-0.5 rounded-[var(--fiori-radius-sm)] text-[11px] font-semibold transition-colors flex items-center gap-1 border cursor-pointer ${
                isHeld
                  ? 'bg-[var(--fiori-negative)] hover:opacity-90 text-white border-[var(--fiori-negative)]'
                  : 'bg-[var(--fiori-negative-bg)] hover:opacity-90 text-[var(--fiori-negative)] border-[var(--fiori-negative-border)]'
              }`}
              title={
                isHeld
                  ? 'رفع قرنطینه کیفی و بازگشت به موجودی آزاد (ATP)'
                  : 'قرنطینه کیفی / QC Hold و کسر از موجودی آزاد (ATP) در MRP'
              }
            >
              {isHeld ? <Unlock className="w-3 h-3" /> : <ShieldAlert className="w-3 h-3" />}
              <span>{isHeld ? 'رفع قرنطینه' : 'QC Hold'}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setSelectedCoil(coil);
                setIssueWeight(String(coil.remainingWeightKg));
                setIssueMoId('');
                setIssueOperationId('');
                setIssueScrap('0');
                setInitialInputQuantityPcs('');
                setIssueRequestKey(
                  globalThis.crypto?.randomUUID?.() ||
                    `coil-issue-${Date.now()}-${Math.random().toString(36).slice(2)}`
                );
                setIssueMode('SINGLE');
                setIssueModalOpen(true);
              }}
              disabled={coil.remainingWeightKg <= 0 || isHeld}
              className="sap-btn-standard px-2 py-0.5 text-[11px] flex items-center gap-1 disabled:opacity-40 cursor-pointer"
              title={isHeld ? 'کلاف در قرنطینه کیفی است و امکان صدور ندارد' : 'صدور کلاف به خطوط پرس'}
            >
              <ArrowUpRight className="w-3 h-3 text-[var(--fiori-brand)]" />
              <span>صدور</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectedCoil(coil);
                setReturnWeight('');
                setReturnVarianceWeight('0');
                setReturnRequestKey(
                  globalThis.crypto?.randomUUID?.() ||
                    `coil-ret-${Date.now()}-${Math.random().toString(36).slice(2)}`
                );
                setReturnModalOpen(true);
              }}
              disabled={coil.originalWeightKg <= coil.remainingWeightKg}
              className="sap-btn-standard px-2 py-0.5 text-[11px] flex items-center gap-1 cursor-pointer disabled:opacity-40"
              title="برگشت ته‌کلاف یا مازاد به انبار"
            >
              <ArrowDownLeft className="w-3 h-3 text-[var(--fiori-brand)]" />
              <span>ته‌رول</span>
            </button>
            <button
              type="button"
              onClick={() => openGenealogyModal(coil)}
              className="px-2 py-0.5 bg-[var(--fiori-info-bg)] hover:opacity-90 text-[var(--fiori-brand)] border border-[var(--fiori-info-border)] rounded-[var(--fiori-radius-sm)] text-[11px] font-semibold transition-colors flex items-center gap-1 cursor-pointer"
              title="شناسنامه کامل و ردگیری مصرف این کلاف"
            >
              <FileText className="w-3 h-3" />
              <span>شناسنامه</span>
            </button>
            <button
              type="button"
              onClick={() => router.traceDocument(coil.coilId, 'INVENTORY_LEDGER')}
              className="sap-btn-standard px-2 py-0.5 text-[11px] text-[var(--fiori-brand)] cursor-pointer"
              title="مشاهده تمام اسناد ورود و حواله این کلاف در کاردکس انبار"
            >
              کاردکس
            </button>
            <button
              type="button"
              onClick={() => openAllocateModal(coil)}
              className="sap-btn-standard px-2 py-0.5 text-[11px] cursor-pointer"
              title="مدیریت سهمیه‌ها و قراردادها"
            >
              تسهیم
            </button>
            <button
              type="button"
              onClick={() =>
                openQuickEditDrawer({
                  entityId: coil.id,
                  entityCode: coil.coilId,
                  moduleTitle: 'انبار کلاف و رول ورق (Physical Coils)',
                  drawerTitle: `ویرایش مشخصات کلاف ${coil.coilId}`,
                  drawerSubtitle: `شماره پکینگ: ${coil.coilPackNumber}`,
                  fields: [
                    { key: 'coilPackNumber', label: 'شماره پکینگ (پلاک ساپکو)', value: coil.coilPackNumber, type: 'text', required: true },
                    { key: 'heatNumber', label: 'شماره ذوب (Heat Number)', value: coil.heatNumber || '', type: 'text' },
                    { key: 'partName', label: 'شرح ورق / نام کالا', value: coil.partName, type: 'text', required: true },
                    {
                      key: 'materialGrade',
                      label: 'گرید ورق',
                      value: coil.materialGrade,
                      type: 'select',
                      options: [
                        { value: 'ST14', label: 'ST14 (کشش عمیق)' },
                        { value: 'ST12', label: 'ST12 (معمولی)' },
                        { value: 'DC04', label: 'DC04 (فوق کشش)' },
                      ],
                    },
                    { key: 'remainingWeightKg', label: 'وزن مانده در انبار (kg)', value: coil.remainingWeightKg, type: 'number', min: 0 },
                    { key: 'warehouseLocationCode', label: 'کد سلول / محل استقرار انبار', value: coil.warehouseLocationCode || '', type: 'text' },
                  ],
                  onSave: values => {
                    const prevCoils = coils;
                    setCoils(prev =>
                      prev.map(c =>
                        c.id === coil.id
                          ? {
                              ...c,
                              coilPackNumber: String(values.coilPackNumber || c.coilPackNumber),
                              heatNumber: String(values.heatNumber ?? c.heatNumber),
                              partName: String(values.partName || c.partName),
                              materialGrade: String(values.materialGrade || c.materialGrade) as any,
                              remainingWeightKg: Number(values.remainingWeightKg ?? c.remainingWeightKg),
                              warehouseLocationCode: String(values.warehouseLocationCode ?? c.warehouseLocationCode),
                            }
                          : c
                      )
                    );
                    showUndoToast({
                      title: `مشخصات کلاف «${coil.coilId}» بروزرسانی شد`,
                      description: `پکینگ: ${values.coilPackNumber} • مانده: ${formatNumber(Number(values.remainingWeightKg))} kg`,
                      onUndo: () => setCoils(prevCoils),
                    });
                  },
                })
              }
              className="p-1.5 bg-[var(--fiori-bg-surface)] hover:bg-[var(--fiori-info-bg)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-brand)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] transition-colors cursor-pointer"
              title="ویرایش مشخصات کلاف در کشوی جانبی"
            >
              <Edit3 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() =>
                requestConfirm({
                  title: `مسدودسازی کیفی کلاف فیزیکی «${coil.coilId}» (SAP QM MvT 344)`,
                  description: `بر اساس استاندارد تراکنشی SAP S/4HANA، کلاف‌های دارای گردش مالی و شناسنامه ذوب قابل حذف نیستند؛ در صورت نقص یا انصراف، وضعیت کلاف به «مسدود کیفی / Blocked (MvT 344)» تغییر می‌یابد.`,
                  consequences: [
                    `موجودی باقیمانده (${formatNumber(coil.remainingWeightKg)} کیلوگرم) به وضعیت مسدود (Blocked) منتقل و از ATP کسر می‌شود.`,
                    'تاریخچه شناسنامه ذوب و حواله‌های قبلی به صورت دائم حفظ می‌گردد.',
                  ],
                  confirmLabel: 'تایید مسدودسازی کیفی (MvT 344)',
                  variant: 'danger',
                  onConfirm: async () => {
                    await executeCoilQcHoldChange(coil, true, 'مسدودسازی کیفی کلاف (MvT 344) به جای حذف');
                  },
                })
              }
              disabled={isHeld}
              className="p-1.5 bg-[var(--fiori-bg-surface)] hover:bg-[var(--fiori-negative-bg)] text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-negative)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] transition-colors cursor-pointer disabled:opacity-40"
              title="مسدودسازی کیفی (MvT 344 — جایگزین حذف)"
            >
              <Lock className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-4 text-right" dir="rtl">
      {/* Toast Notification */}
      {notification && (
        <FioriMessageStrip
          tone={notification.type === 'success' ? 'success' : 'error'}
          onClose={() => setNotification(null)}
        >
          {notification.message}
        </FioriMessageStrip>
      )}

      <FioriDynamicPage
        title="مدیریت کلاف‌های ورق، ته‌رول و شجره‌نامه مصرف (SAP MM / Coils)"
        subtitle="پایش چرخه عمر رول مادر تا ته‌کلاف، تسهیم چندقراردادی، کنترل قرنطینه کیفی (QC Hold) و ردیابی شماره ذوب"
        activeFiltersCount={activeFiltersCount}
        onResetFilters={resetAllFilters}
        headerActions={
          <button
            type="button"
            onClick={fetchCoils}
            disabled={loading}
            className="sap-btn-standard flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
          >
            <RotateCcw className={`w-3.5 h-3.5 text-[var(--fiori-brand)] ${loading ? 'animate-spin' : ''}`} />
            <span>بروزرسانی اطلاعات</span>
          </button>
        }
        kpiStrip={
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
            <button
              type="button"
              onClick={() => setStatusFilter('ALL')}
              className={`p-3 rounded-[var(--fiori-radius-md)] border text-right transition-all cursor-pointer ${
                statusFilter === 'ALL'
                  ? 'bg-[var(--fiori-brand-bg)] text-[var(--fiori-brand)] border-[var(--fiori-brand)] shadow-[var(--fiori-shadow-card)]'
                  : 'bg-[var(--fiori-bg-surface)] hover:bg-[var(--fiori-bg-subtle)] text-[var(--fiori-text-primary)] border-[var(--fiori-border-default)]'
              }`}
            >
              <div className="flex items-center justify-between text-xs mb-1">
                <span className={statusFilter === 'ALL' ? 'text-[var(--fiori-brand)] font-semibold' : 'text-[var(--fiori-text-secondary)]'}>
                  کل کلاف‌های ثبت‌شده
                </span>
                <Layers className="w-4 h-4 opacity-80" />
              </div>
              <div className="text-xl font-bold font-mono tabular-nums tracking-tight">
                {formatNumber(coils.length)}{' '}
                <span className="text-xs font-normal opacity-75">رول</span>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setStatusFilter('FULL')}
              className={`p-3 rounded-[var(--fiori-radius-md)] border text-right transition-all cursor-pointer ${
                statusFilter === 'FULL'
                  ? 'bg-[var(--fiori-positive-bg)] text-[var(--fiori-positive)] border-[var(--fiori-positive)] shadow-[var(--fiori-shadow-card)]'
                  : 'bg-[var(--fiori-bg-surface)] hover:bg-[var(--fiori-bg-subtle)] text-[var(--fiori-text-primary)] border-[var(--fiori-border-default)]'
              }`}
            >
              <div className="flex items-center justify-between text-xs mb-1">
                <span className={statusFilter === 'FULL' ? 'text-[var(--fiori-positive)] font-semibold' : 'text-[var(--fiori-text-secondary)]'}>
                  کلاف‌های دست‌نخورده (کامل)
                </span>
                <Boxes className="w-4 h-4 text-[var(--fiori-positive)]" />
              </div>
              <div className="text-xl font-bold font-mono tabular-nums tracking-tight text-[var(--fiori-positive)]">
                {formatNumber(fullCoilsCount)}{' '}
                <span className="text-xs font-normal opacity-75">رول</span>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setStatusFilter('PARTIAL')}
              className={`p-3 rounded-[var(--fiori-radius-md)] border text-right transition-all cursor-pointer ${
                statusFilter === 'PARTIAL'
                  ? 'bg-[var(--fiori-critical-bg)] text-[var(--fiori-critical)] border-[var(--fiori-critical)] shadow-[var(--fiori-shadow-card)]'
                  : 'bg-[var(--fiori-bg-surface)] hover:bg-[var(--fiori-bg-subtle)] text-[var(--fiori-text-primary)] border-[var(--fiori-border-default)]'
              }`}
            >
              <div className="flex items-center justify-between text-xs mb-1">
                <span className={statusFilter === 'PARTIAL' ? 'text-[var(--fiori-critical)] font-semibold' : 'text-[var(--fiori-text-secondary)]'}>
                  کلاف‌های ناقص / در گردش (ته‌رول)
                </span>
                <Split className="w-4 h-4 text-[var(--fiori-critical)]" />
              </div>
              <div className="text-xl font-bold font-mono tabular-nums tracking-tight text-[var(--fiori-critical)]">
                {formatNumber(partialCoilsCount)}{' '}
                <span className="text-xs font-normal opacity-75">رول</span>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setStatusFilter('CONSUMED')}
              className={`p-3 rounded-[var(--fiori-radius-md)] border text-right transition-all cursor-pointer ${
                statusFilter === 'CONSUMED'
                  ? 'bg-[var(--fiori-info-bg)] text-[var(--fiori-brand)] border-[var(--fiori-brand)] shadow-[var(--fiori-shadow-card)]'
                  : 'bg-[var(--fiori-bg-surface)] hover:bg-[var(--fiori-bg-subtle)] text-[var(--fiori-text-primary)] border-[var(--fiori-border-default)]'
              }`}
            >
              <div className="flex items-center justify-between text-xs mb-1">
                <span className={statusFilter === 'CONSUMED' ? 'text-[var(--fiori-brand)] font-semibold' : 'text-[var(--fiori-text-secondary)]'}>
                  کلاف‌های پایان‌یافته (مصرف‌شده)
                </span>
                <CheckCircle2 className="w-4 h-4 text-[var(--fiori-text-secondary)]" />
              </div>
              <div className="text-xl font-bold font-mono tabular-nums tracking-tight">
                {formatNumber(consumedCoilsCount)}{' '}
                <span className="text-xs font-normal opacity-75">رول</span>
              </div>
            </button>
          </div>
        }
        filterBar={
          <div className="flex flex-wrap items-center justify-between gap-2.5 text-xs">
            <div className="flex items-center gap-2 flex-1 min-w-[240px]">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--fiori-text-secondary)]" />
                <input
                  type="text"
                  placeholder="جستجوی شماره کویل، پکینگ، شماره ذوب یا قطعه..."
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  className="w-full bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] pr-8 pl-3 py-1.5 text-xs text-[var(--fiori-text-primary)] placeholder-[var(--fiori-text-muted)] focus:outline-none focus:border-[var(--fiori-brand)]"
                />
              </div>
            </div>

            <div className="flex items-center flex-wrap gap-2">
              <select
                value={gradeFilter}
                onChange={e => setGradeFilter(e.target.value)}
                className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1.5 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)]"
              >
                <option value="ALL">همه گریدها</option>
                {dynamicGrades.map(g => (
                  <option key={g} value={g}>گرید: {g}</option>
                ))}
              </select>

              <select
                value={thicknessFilter}
                onChange={e => setThicknessFilter(e.target.value)}
                className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1.5 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)]"
              >
                <option value="ALL">همه ضخامت‌ها</option>
                {dynamicThicknesses.map(t => (
                  <option key={t} value={String(t)}>ضخامت: {t}mm</option>
                ))}
              </select>

              <select
                value={warehouseFilter}
                onChange={e => setWarehouseFilter(e.target.value)}
                className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1.5 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)]"
              >
                <option value="ALL">همه انبارها</option>
                {dynamicWarehouses.map(([id, name]) => (
                  <option key={id} value={id}>{name}</option>
                ))}
              </select>

              <select
                value={contractFilter}
                onChange={e => setContractFilter(e.target.value)}
                className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1.5 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)]"
              >
                <option value="ALL">همه قراردادها</option>
                {dynamicContracts.map(cnt => (
                  <option key={cnt} value={cnt}>قرارداد: {cnt}</option>
                ))}
              </select>

              <select
                value={qualityFilter}
                onChange={e => setQualityFilter(e.target.value as any)}
                className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1.5 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)]"
              >
                <option value="ALL">همه وضعیت‌های کیفی</option>
                <option value="AVAILABLE">آزاد (تأیید کیفی)</option>
                <option value="QUALITY_HOLD">قرنطینه / مسدود کیفی</option>
              </select>

              <select
                value={ownershipFilter}
                onChange={e => setOwnershipFilter(e.target.value)}
                className="bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1.5 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-brand)]"
              >
                <option value="ALL">همه مالکیت‌ها</option>
                <option value="SAPCO_SUPPLIER_OWNED">امانی ساپکو</option>
                <option value="COMPANY_OWNED">ملکی کارخانه</option>
                <option value="CUSTOMER_SUPPLIED">مشتری</option>
              </select>
            </div>
          </div>
        }
      >
        {/* Visual Parent-to-Child Coil Slitting Genealogy Tree */}
        <CoilSlittingGenealogyPanel coils={coils} />

        {/* Coils Table (SAP Fiori Compact Data Table) */}
        <FioriDataTable<PhysicalCoil>
          data={filteredCoils}
          columns={coilColumns}
          rowKey={coil => coil.id}
          loading={loading && coils.length === 0}
          compact
          rowClassName={coil =>
            isCoilInQcHold(coil)
              ? 'bg-[var(--fiori-negative-bg)]/60 hover:bg-[var(--fiori-negative-bg)]'
              : ''
          }
          toolbar={
            <FioriToolbar
              variant="table"
              title="فهرست کلاف‌های فیزیکی ورق"
              count={filteredCoils.length}
              countLabel="رول"
              endContent={
                <span className="text-[11px] text-[var(--fiori-text-secondary)] font-mono tabular-nums">
                  مجموع مانده فیلترشده: <strong className="text-[var(--fiori-text-primary)]">{formatWeightKg(totalPhysicalWeight)}</strong>
                </span>
              }
            />
          }
          emptyState={
            <EmptyState
              variant={activeFiltersCount > 0 ? 'FILTER_NO_MATCH' : 'NO_DATA'}
              compact
              title="هیچ کلاف فیزیکی منطبق بر این فیلترها یافت نشد"
              description="فیلترهای گرید، ضخامت، انبار یا وضعیت کیفی را بازنشانی کنید."
              actionLabel={activeFiltersCount > 0 ? 'پاک‌کردن فیلترها' : undefined}
              onAction={activeFiltersCount > 0 ? resetAllFilters : undefined}
            />
          }
        />
      </FioriDynamicPage>

      {/* Multi-Part Issue Dialog */}
      {selectedCoil && (
        <FioriDialog
          isOpen={issueModalOpen}
          onClose={() => setIssueModalOpen(false)}
          title="خروج و صدور کلاف به خطوط تولید (امکان تخصیص همزمان به ۲ قطعه)"
          subtitle={`کویل ${selectedCoil.coilId} (پکینگ ${selectedCoil.coilPackNumber}) — مانده موجود: ${formatWeightKg(selectedCoil.remainingWeightKg)}`}
          icon={<ArrowUpRight className="w-4 h-4" />}
          tone="brand"
          size="lg"
          footer={(() => {
            const multiSum =
              multiPartsList.reduce((s, p) => s + (Number(p.issuedWeightKg) || 0), 0) +
              (Number(issueScrap) || 0);
            const isInvalidTotal =
              issueMode === 'SINGLE'
                ? (Number(issueWeight) || 0) <= 0 ||
                  (Number(issueWeight) || 0) + (Number(issueScrap) || 0) > selectedCoil.remainingWeightKg
                : multiSum <= 0 || multiSum > selectedCoil.remainingWeightKg;

            return (
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIssueModalOpen(false)}
                  className="sap-btn-standard px-3.5 py-1.5 text-xs cursor-pointer"
                >
                  انصراف
                </button>
                <button
                  type="submit"
                  form="coil-issue-form"
                  disabled={isInvalidTotal}
                  className="sap-btn-emphasized px-4 py-1.5 text-xs font-medium cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
                >
                  ثبت خروج و صدور به خط تولید (MvT 261)
                </button>
              </div>
            );
          })()}
        >
          {/* Toggle Issue Mode: Single Part vs Multi-Part */}
          <div className="flex items-center bg-[var(--fiori-bg-subtle)] p-1 rounded-[var(--fiori-radius-sm)] mb-4 text-xs font-semibold border border-[var(--fiori-border-subtle)]">
            <button
              type="button"
              onClick={() => setIssueMode('SINGLE')}
              className={`flex-1 py-1.5 rounded-[var(--fiori-radius-sm)] transition-all cursor-pointer ${
                issueMode === 'SINGLE'
                  ? 'bg-[var(--fiori-bg-surface)] text-[var(--fiori-brand)] shadow-2xs border border-[var(--fiori-border-default)]'
                  : 'text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)]'
              }`}
            >
              صدور برای یک قطعه / سفارش ساخت
            </button>
            <button
              type="button"
              onClick={() => setIssueMode('MULTI')}
              className={`flex-1 py-1.5 rounded-[var(--fiori-radius-sm)] transition-all cursor-pointer ${
                issueMode === 'MULTI'
                  ? 'bg-[var(--fiori-brand)] text-white shadow-2xs'
                  : 'text-[var(--fiori-text-secondary)] hover:text-[var(--fiori-text-primary)]'
              }`}
            >
              صدور همزمان برای ۲ قطعه (تسهیم بین دو خط)
            </button>
          </div>

          <form id="coil-issue-form" onSubmit={handleIssueSubmit} className="space-y-3.5 text-xs">
            {issueMode === 'SINGLE' ? (
              <>
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-[var(--fiori-text-secondary)] font-medium">
                      نوع صدور و وزن حواله (کیلوگرم)
                    </label>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setIssueWeight(String(selectedCoil.remainingWeightKg))}
                        className={`px-2 py-0.5 rounded-[var(--fiori-radius-sm)] border text-[11px] cursor-pointer ${
                          Number(issueWeight) === selectedCoil.remainingWeightKg
                            ? 'bg-[var(--fiori-brand)] text-white border-[var(--fiori-brand)]'
                            : 'bg-[var(--fiori-bg-surface)] text-[var(--fiori-text-primary)] border-[var(--fiori-border-default)]'
                        }`}
                      >
                        کل رول ({formatNumber(selectedCoil.remainingWeightKg)} kg)
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setIssueWeight(String(Math.max(1, Math.round(selectedCoil.remainingWeightKg / 2))))
                        }
                        className={`px-2 py-0.5 rounded-[var(--fiori-radius-sm)] border text-[11px] cursor-pointer ${
                          Number(issueWeight) > 0 && Number(issueWeight) < selectedCoil.remainingWeightKg
                            ? 'bg-[var(--fiori-brand)] text-white border-[var(--fiori-brand)]'
                            : 'bg-[var(--fiori-bg-surface)] text-[var(--fiori-text-primary)] border-[var(--fiori-border-default)]'
                        }`}
                      >
                        صدور جزئی (بخشی از رول)
                      </button>
                    </div>
                  </div>
                  <input
                    type="number"
                    step="any"
                    value={issueWeight}
                    onChange={e => setIssueWeight(e.target.value)}
                    max={selectedCoil.remainingWeightKg}
                    min={1}
                    required
                    className={`w-full border rounded-[var(--fiori-radius-sm)] px-3 py-2 font-mono font-bold focus:outline-none ${
                      (Number(issueWeight) || 0) > selectedCoil.remainingWeightKg
                        ? 'border-[var(--fiori-negative)] bg-[var(--fiori-negative-bg)] text-[var(--fiori-negative)]'
                        : 'bg-[var(--fiori-bg-subtle)] border-[var(--fiori-border-input)] text-[var(--fiori-text-primary)] focus:border-[var(--fiori-brand)]'
                    }`}
                  />
                  <div className="mt-1 flex items-center justify-between text-[11px] text-[var(--fiori-text-secondary)]">
                    <span>
                      نوع عملیات:{' '}
                      <strong className="text-[var(--fiori-brand)]">
                        {Number(issueWeight) >= selectedCoil.remainingWeightKg
                          ? 'حواله کل رول (Whole Roll)'
                          : 'حواله جزئی رول (Partial Roll)'}
                      </strong>
                    </span>
                    <span>
                      مانده پس از صدور:{' '}
                      <strong className="font-mono text-[var(--fiori-positive)] tabular-nums">
                        {formatNumber(
                          Math.max(
                            0,
                            selectedCoil.remainingWeightKg -
                              (Number(issueWeight) || 0) -
                              (Number(issueScrap) || 0)
                          )
                        )}{' '}
                        kg
                      </strong>
                    </span>
                  </div>
                  {(Number(issueWeight) || 0) > selectedCoil.remainingWeightKg && (
                    <div className="mt-2">
                      <FioriMessageStrip tone="error" compact>
                        وزن درخواستی از مانده آزاد کلاف ({formatNumber(selectedCoil.remainingWeightKg)} kg) بیشتر است.
                      </FioriMessageStrip>
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-[var(--fiori-text-secondary)] mb-1 font-medium">دستور ساخت (MO)</label>
                  <select
                    value={issueMoId}
                    onChange={e => {
                      setIssueMoId(e.target.value);
                      setIssueOperationId('');
                    }}
                    required
                    className="w-full bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-3 py-2 text-[var(--fiori-text-primary)] focus:border-[var(--fiori-brand)] focus:outline-none"
                  >
                    <option value="">انتخاب دستور ساخت</option>
                    {availableManufacturingOrders.map(mo => (
                      <option key={mo.id} value={mo.id}>
                        {mo.moNumber} — {mo.partCode} / {mo.partName}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[var(--fiori-text-secondary)] mb-1 font-medium">عملیات مصرف</label>
                  <select
                    value={issueOperationId}
                    onChange={e => setIssueOperationId(e.target.value)}
                    required
                    disabled={!issueMoId}
                    className="w-full bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-3 py-2 text-[var(--fiori-text-primary)] focus:border-[var(--fiori-brand)] focus:outline-none disabled:opacity-50"
                  >
                    <option value="">انتخاب عملیات</option>
                    {availableManufacturingOrders
                      .find(mo => mo.id === issueMoId)
                      ?.operations.map(operation => (
                        <option key={operation.id} value={operation.id}>
                          مرحله {operation.stepNumber} — {operation.operationName}
                          {operation.plannedMachine ? ' (' + operation.plannedMachine + ')' : ''}
                        </option>
                      ))}
                  </select>
                </div>
                {selectedIssueOperation?.isFirstOperation && (
                  <div className="rounded-[var(--fiori-radius-md)] border border-[var(--fiori-info-border)] bg-[var(--fiori-info-bg)] p-3 space-y-2">
                    <div className="text-xs font-semibold text-[var(--fiori-text-primary)]">
                      ورودی اولیه مرحله اول (عدد قطعه)
                    </div>
                    <div className="text-[11px] text-[var(--fiori-text-secondary)]">
                      پیشنهاد سیستم: {formatNumber(suggestedInitialInputPcs)} عدد؛ بر اساس وزن ناخالص مهندسی هر قطعه ({formatNumber(selectedIssueMo?.weightGrossKg || 0)} kg)
                    </div>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      required
                      value={initialInputQuantityPcs}
                      onChange={e => setInitialInputQuantityPcs(e.target.value)}
                      placeholder="تعداد پیشنهادی را بررسی و تأیید کنید"
                      className="w-full bg-[var(--fiori-bg-surface)] border border-[var(--fiori-info-border)] rounded-[var(--fiori-radius-sm)] px-3 py-2 text-[var(--fiori-text-primary)] font-mono font-bold focus:border-[var(--fiori-brand)] focus:outline-none"
                    />
                    <p className="text-[10px] text-[var(--fiori-text-secondary)]">
                      تعداد پیشنهادی قابل ویرایش است؛ مقدار نهایی با تأیید اپراتور در موجودی انتظار مرحله اول ثبت می‌شود.
                    </p>
                  </div>
                )}
              </>
            ) : (
              /* Multi-Part Allocation (Scenario: 1 coil for 2 parts simultaneously) */
              <div className="space-y-3 bg-[var(--fiori-info-bg)]/60 p-3.5 rounded-[var(--fiori-radius-md)] border border-[var(--fiori-info-border)]">
                <span className="font-semibold text-[var(--fiori-text-primary)] block text-xs">
                  تسهیم وزن کلاف بین قطعات سالن تولید:
                </span>

                {multiPartsList.map((p, idx) => (
                  <div
                    key={idx}
                    className="bg-[var(--fiori-bg-surface)] p-3 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)] space-y-2"
                  >
                    <div className="flex items-center justify-between text-[11px] font-bold text-[var(--fiori-text-primary)]">
                      <span>قطعه شماره {toPersianDigits(idx + 1)}</span>
                      {multiPartsList.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setMultiPartsList(multiPartsList.filter((_, i) => i !== idx))}
                          className="text-[var(--fiori-negative)] hover:underline cursor-pointer"
                        >
                          حذف
                        </button>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] text-[var(--fiori-text-secondary)] mb-1">دستور ساخت</label>
                        <select
                          value={p.moId}
                          onChange={e => {
                            const updated = [...multiPartsList];
                            const selectedMo = availableManufacturingOrders.find(mo => mo.id === e.target.value);
                            updated[idx].moId = e.target.value;
                            updated[idx].partName = selectedMo ? selectedMo.partCode + ' — ' + selectedMo.partName : '';
                            updated[idx].moOperationId = '';
                            setMultiPartsList(updated);
                          }}
                          required
                          className="w-full bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1.5 text-xs text-[var(--fiori-text-primary)]"
                        >
                          <option value="">انتخاب MO</option>
                          {availableManufacturingOrders.map(mo => (
                            <option key={mo.id} value={mo.id}>
                              {mo.moNumber} — {mo.partCode}
                            </option>
                          ))}
                        </select>
                        <span className="block mt-1 text-[10px] text-[var(--fiori-text-secondary)]">{p.partName}</span>
                      </div>
                      <div>
                        <label className="block text-[10px] text-[var(--fiori-text-secondary)] mb-1">وزن مورد نیاز (kg)</label>
                        <input
                          type="number"
                          placeholder="وزن"
                          value={p.issuedWeightKg}
                          onChange={e => {
                            const updated = [...multiPartsList];
                            updated[idx].issuedWeightKg = e.target.value;
                            setMultiPartsList(updated);
                          }}
                          min={0.001}
                          required
                          className="w-full bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1.5 text-xs text-[var(--fiori-text-primary)] font-mono font-bold"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[10px] text-[var(--fiori-text-secondary)] mb-1">عملیات مصرف</label>
                      <select
                        value={p.moOperationId}
                        onChange={e => {
                          const updated = [...multiPartsList];
                          updated[idx].moOperationId = e.target.value;
                          setMultiPartsList(updated);
                        }}
                        required
                        disabled={!p.moId}
                        className="w-full bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1 text-[11px] text-[var(--fiori-text-primary)] disabled:opacity-50"
                      >
                        <option value="">انتخاب عملیات</option>
                        {availableManufacturingOrders
                          .find(mo => mo.id === p.moId)
                          ?.operations.map(operation => (
                            <option key={operation.id} value={operation.id}>
                              مرحله {operation.stepNumber} — {operation.operationName}
                            </option>
                          ))}
                      </select>
                    </div>
                  </div>
                ))}

                <button
                  type="button"
                  onClick={() =>
                    setMultiPartsList([
                      ...multiPartsList,
                      { partName: '', moId: '', moOperationId: '', issuedWeightKg: '' },
                    ])
                  }
                  className="w-full rounded-[var(--fiori-radius-sm)] border border-dashed border-[var(--fiori-info-border)] bg-[var(--fiori-bg-surface)] px-3 py-2 text-xs font-medium text-[var(--fiori-brand)] hover:bg-[var(--fiori-info-bg)] cursor-pointer"
                >
                  افزودن قطعه / دستور ساخت
                </button>

                <div className="flex items-center justify-between pt-2 border-t border-[var(--fiori-info-border)] text-xs">
                  <span className="text-[var(--fiori-text-secondary)]">
                    مجموع صادر شده:{' '}
                    <strong className="font-mono text-[var(--fiori-brand)] tabular-nums">
                      {formatNumber(multiPartsList.reduce((s, p) => s + (Number(p.issuedWeightKg) || 0), 0))} kg
                    </strong>
                  </span>
                  <span className="text-[var(--fiori-text-secondary)]">
                    مانده پس از صدور:{' '}
                    <strong className="font-mono text-[var(--fiori-positive)] tabular-nums">
                      {formatNumber(
                        Math.max(
                          0,
                          selectedCoil.remainingWeightKg -
                            multiPartsList.reduce((s, p) => s + (Number(p.issuedWeightKg) || 0), 0) -
                            (Number(issueScrap) || 0)
                        )
                      )}{' '}
                      kg
                    </strong>
                  </span>
                </div>
              </div>
            )}

            <div>
              <label className="block text-[var(--fiori-text-secondary)] mb-1 font-medium">
                افت وزنی / ضایعات سر و ته کلاف (کیلوگرم)
              </label>
              <input
                type="number"
                value={issueScrap}
                onChange={e => setIssueScrap(e.target.value)}
                min={0}
                className="w-full bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-3 py-2 text-[var(--fiori-text-primary)] font-mono focus:border-[var(--fiori-brand)] focus:outline-none"
              />
            </div>

            {(() => {
              const multiSum =
                multiPartsList.reduce((s, p) => s + (Number(p.issuedWeightKg) || 0), 0) +
                (Number(issueScrap) || 0);
              const isOverCoilCeiling =
                issueMode === 'SINGLE'
                  ? (Number(issueWeight) || 0) + (Number(issueScrap) || 0) > selectedCoil.remainingWeightKg
                  : multiSum > selectedCoil.remainingWeightKg;

              return isOverCoilCeiling ? (
                <FioriMessageStrip tone="error" compact>
                  مجموع وزن حواله و افت وزنی از مانده آزاد کلاف ({formatNumber(selectedCoil.remainingWeightKg)} kg) تجاوز کرده است.
                </FioriMessageStrip>
              ) : null;
            })()}
          </form>
        </FioriDialog>
      )}

      {/* Remnant Return Dialog */}
      {selectedCoil && (
        <FioriDialog
          isOpen={returnModalOpen}
          onClose={() => setReturnModalOpen(false)}
          title="برگشت ته‌کلاف یا مازاد از خط تولید به انبار"
          subtitle={`پکینگ ساپکو: ${selectedCoil.coilPackNumber} (با حفظ کامل ردیابی مادر)`}
          icon={<ArrowDownLeft className="w-4 h-4" />}
          tone="brand"
          size="md"
          footer={
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setReturnModalOpen(false)}
                className="sap-btn-standard px-3.5 py-1.5 text-xs cursor-pointer"
              >
                انصراف
              </button>
              <button
                type="submit"
                form="coil-return-form"
                className="px-4 py-1.5 bg-[var(--fiori-positive)] hover:opacity-95 text-white rounded-[var(--fiori-radius-sm)] text-xs font-medium transition-colors cursor-pointer"
              >
                ثبت برگشت ته‌کلاف به انبار
              </button>
            </div>
          }
        >
          <form id="coil-return-form" onSubmit={handleReturnSubmit} className="space-y-3.5 text-xs">
            <div className="p-2.5 bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] flex items-center justify-between text-[11px]">
              <span className="text-[var(--fiori-text-secondary)]">خالص صادرشده به خط (سقف برگشت):</span>
              <strong className="font-mono text-[var(--fiori-brand)] tabular-nums">
                {formatWeightKg(Math.max(0, selectedCoil.originalWeightKg - selectedCoil.remainingWeightKg))}
              </strong>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[var(--fiori-text-secondary)] mb-1 font-medium">وزن ته‌کلاف برگشتی (kg)</label>
                <input
                  type="number"
                  step="any"
                  value={returnWeight}
                  onChange={e => setReturnWeight(e.target.value)}
                  min={0.1}
                  required
                  placeholder="وزن دقیق باسکول"
                  className="w-full bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-3 py-2 text-[var(--fiori-text-primary)] font-mono font-bold focus:border-[var(--fiori-brand)] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[var(--fiori-text-secondary)] mb-1 font-medium">افت وزنی / پرت برش (kg)</label>
                <input
                  type="number"
                  step="any"
                  value={returnVarianceWeight}
                  onChange={e => setReturnVarianceWeight(e.target.value)}
                  min={0}
                  placeholder="0"
                  className="w-full bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-3 py-2 text-[var(--fiori-text-primary)] font-mono focus:border-[var(--fiori-brand)] focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="block text-[var(--fiori-text-secondary)] mb-1 font-medium">
                توضیحات و گزارش وضعیت ته‌کلاف
              </label>
              <textarea
                value={returnNotes}
                onChange={e => setReturnNotes(e.target.value)}
                placeholder="علت برگشت، کنترل ابعادی و بسته‌بندی مجدد..."
                className="w-full bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-3 py-2 text-[var(--fiori-text-primary)] focus:border-[var(--fiori-brand)] focus:outline-none"
                rows={3}
              />
            </div>
          </form>
        </FioriDialog>
      )}

      {/* COIL GENEALOGY & TRACEABILITY AUDIT DIALOG */}
      {selectedCoil && (
        <FioriDialog
          isOpen={genealogyModalOpen}
          onClose={() => setGenealogyModalOpen(false)}
          title={`شناسنامه کامل و ردگیری مصرف کلاف ${selectedCoil.coilId}`}
          subtitle={`شماره پکینگ: ${selectedCoil.coilPackNumber} | شماره ذوب: ${selectedCoil.heatNumber || 'ثبت‌نشده'}`}
          icon={<FileText className="w-4 h-4" />}
          tone="brand"
          size="xl"
          footer={
            <div className="flex items-center justify-between gap-2 no-print">
              <button
                type="button"
                onClick={() => window.print()}
                className="sap-btn-standard px-3 py-1.5 text-xs flex items-center gap-1.5 cursor-pointer"
                title="چاپ گزارش شناسنامه"
              >
                <Printer className="w-4 h-4" />
                <span>چاپ شناسنامه (A4)</span>
              </button>
              <button
                type="button"
                onClick={() => setGenealogyModalOpen(false)}
                className="sap-btn-emphasized px-4 py-1.5 text-xs font-medium cursor-pointer"
              >
                بستن پنجره شناسنامه
              </button>
            </div>
          }
        >
          {genealogyLoading ? (
            <div className="py-12 text-center text-[var(--fiori-text-secondary)] text-xs">
              در حال استخراج شناسنامه و ردیابی تاریخچه کلاف...
            </div>
          ) : genealogyData ? (
            <div className="space-y-4 text-xs">
              {/* Status Bar & Metrics */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 tabular-nums">
                <div className="bg-[var(--fiori-bg-subtle)] p-3 rounded-[var(--fiori-radius-md)] border border-[var(--fiori-border-default)]">
                  <span className="text-[var(--fiori-text-secondary)] block text-[11px]">وزن اولیه ورود:</span>
                  <strong className="text-[var(--fiori-text-primary)] font-mono text-sm block mt-1">
                    {formatWeightKg(genealogyData.metrics.originalWeightKg)}
                  </strong>
                </div>
                <div className="bg-[var(--fiori-info-bg)] p-3 rounded-[var(--fiori-radius-md)] border border-[var(--fiori-info-border)]">
                  <span className="text-[var(--fiori-brand)] block text-[11px]">مجموع خروجی به خط:</span>
                  <strong className="text-[var(--fiori-brand)] font-mono text-sm block mt-1">
                    {formatWeightKg(genealogyData.metrics.totalIssuedKg)}
                  </strong>
                </div>
                <div className="bg-[var(--fiori-critical-bg)] p-3 rounded-[var(--fiori-radius-md)] border border-[var(--fiori-critical-border)]">
                  <span className="text-[var(--fiori-critical)] block text-[11px]">مجموع برگشت ته‌رول:</span>
                  <strong className="text-[var(--fiori-critical)] font-mono text-sm block mt-1">
                    {formatWeightKg(genealogyData.metrics.totalReturnedKg)}
                  </strong>
                </div>
                <div className="bg-[var(--fiori-positive-bg)] p-3 rounded-[var(--fiori-radius-md)] border border-[var(--fiori-positive-border)]">
                  <span className="text-[var(--fiori-positive)] block text-[11px]">مانده موجود در انبار:</span>
                  <strong className="text-[var(--fiori-positive)] font-mono text-sm block mt-1">
                    {formatWeightKg(genealogyData.metrics.remainingWeightKg)}
                  </strong>
                </div>
              </div>

              {/* Utilization Progress Bar */}
              <div className="bg-[var(--fiori-bg-subtle)] p-3.5 rounded-[var(--fiori-radius-md)] border border-[var(--fiori-border-default)] space-y-1.5">
                <div className="flex items-center justify-between text-xs font-semibold">
                  <span className="text-[var(--fiori-text-primary)]">راندمان و نسبت مصرف کلاف:</span>
                  <span className="font-mono text-[var(--fiori-text-primary)] tabular-nums">
                    {toPersianDigits(genealogyData.metrics.utilizationPercent)}٪ مصرف شده
                  </span>
                </div>
                <div className="w-full bg-[var(--fiori-border-default)] rounded-[var(--fiori-radius-sm)] h-2 overflow-hidden">
                  <div
                    className="bg-[var(--fiori-positive)] h-2 rounded-[var(--fiori-radius-sm)] transition-all duration-500"
                    style={{ width: `${Math.min(100, genealogyData.metrics.utilizationPercent)}%` }}
                  />
                </div>
              </div>

              {/* Contract Allocation Info */}
              {genealogyData.allocations && genealogyData.allocations.length > 0 && (
                <div className="bg-[var(--fiori-bg-surface)] p-3.5 rounded-[var(--fiori-radius-md)] border border-[var(--fiori-border-default)] space-y-2">
                  <span className="font-bold text-[var(--fiori-text-primary)] block text-xs">
                    تسهیم قراردادهای متصل به این کلاف:
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {genealogyData.allocations.map((a: any, i: number) => (
                      <span
                        key={i}
                        className="inline-flex items-center gap-1.5 bg-[var(--fiori-bg-subtle)] border border-[var(--fiori-border-subtle)] px-3 py-1 rounded-[var(--fiori-radius-sm)] text-[var(--fiori-text-primary)] text-xs"
                      >
                        <Tag className="w-3.5 h-3.5 text-[var(--fiori-text-secondary)]" />
                        <span className="fiori-ltr-code">{a.contractNumber}:</span>
                        <strong className="font-mono tabular-nums">{formatNumber(a.allocatedWeightKg)} kg</strong>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Chronological Event Timeline */}
              <div className="space-y-3">
                <h4 className="font-bold text-[var(--fiori-text-primary)] flex items-center gap-1.5 text-xs">
                  <Clock className="w-4 h-4 text-[var(--fiori-text-secondary)]" />
                  <span>تاریخچه وقایع و ردگیری مصرف (ورود، خروج‌ها و برگشت ته‌کلاف):</span>
                </h4>

                <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
                  {/* Event 1: Receipt */}
                  <div className="p-3 bg-[var(--fiori-bg-subtle)] rounded-[var(--fiori-radius-md)] border border-[var(--fiori-border-default)] flex items-start gap-3">
                    <span className="w-2.5 h-2.5 rounded-full bg-[var(--fiori-positive)] mt-1 shrink-0" />
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <strong className="text-[var(--fiori-text-primary)] font-semibold">
                          ورود کلاف به انبار مرکزی مواد اولیه
                        </strong>
                        <span className="text-[10px] text-[var(--fiori-text-muted)] font-mono">
                          {new Date(selectedCoil.receiptDate).toLocaleDateString('fa-IR')}
                        </span>
                      </div>
                      <p className="text-[11px] text-[var(--fiori-text-secondary)] mt-0.5">
                        تامین‌کننده: {selectedCoil.supplierName || 'ساپکو'} | وزن اولیه:{' '}
                        {formatWeightKg(selectedCoil.originalWeightKg)} | انبار: {selectedCoil.warehouseName} (
                        {selectedCoil.warehouseLocationCode})
                      </p>
                    </div>
                  </div>

                  {/* Operational records */}
                  {genealogyData.records && genealogyData.records.length > 0 ? (
                    genealogyData.records.map((r: any) => (
                      <div
                        key={r.id}
                        className={`p-3 rounded-[var(--fiori-radius-md)] border flex items-start gap-3 ${
                          r.actionType === 'ISSUE_TO_PRODUCTION'
                            ? 'bg-[var(--fiori-info-bg)]/60 border-[var(--fiori-info-border)]'
                            : 'bg-[var(--fiori-critical-bg)]/60 border-[var(--fiori-critical-border)]'
                        }`}
                      >
                        <span
                          className={`w-2.5 h-2.5 rounded-full mt-1 shrink-0 ${
                            r.actionType === 'ISSUE_TO_PRODUCTION'
                              ? 'bg-[var(--fiori-brand)]'
                              : 'bg-[var(--fiori-critical)]'
                          }`}
                        />
                        <div className="flex-1">
                          <div className="flex items-center justify-between">
                            <strong className="text-[var(--fiori-text-primary)] font-semibold">
                              {r.actionType === 'ISSUE_TO_PRODUCTION'
                                ? 'خروج و صدور به خط تولید'
                                : 'برگشت مازاد یا ته‌کلاف به انبار'}
                            </strong>
                            <span className="text-[10px] text-[var(--fiori-text-muted)] font-mono">
                              {new Date(r.timestamp).toLocaleDateString('fa-IR')}
                            </span>
                          </div>

                          {r.actionType === 'ISSUE_TO_PRODUCTION' ? (
                            <div className="text-[11px] text-[var(--fiori-text-primary)] mt-0.5 space-y-1">
                              {r.multiParts && r.multiParts.length > 0 ? (
                                <div>
                                  <span className="font-semibold text-[var(--fiori-brand)]">تخصیص چندقطعه‌ای:</span>
                                  <ul className="list-disc list-inside mt-0.5 space-y-0.5 text-[var(--fiori-text-secondary)]">
                                    {r.multiParts.map((mp: any, i: number) => (
                                      <li key={i}>
                                        {mp.partName} ({mp.moId || 'MO'}):{' '}
                                        <strong className="font-mono">{formatNumber(mp.issuedWeightKg)} kg</strong>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              ) : (
                                <div>
                                  دستور ساخت: {r.moId || 'MO-PROD'} | وزن صادر شده:{' '}
                                  <strong className="font-mono">{formatNumber(r.issuedWeightKg)} kg</strong>
                                </div>
                              )}
                              {r.scrappedKg > 0 && (
                                <div className="text-[var(--fiori-critical)]">
                                  افت وزنی / ضایعات سر و ته: {r.scrappedKg} kg
                                </div>
                              )}
                              <div className="text-[10px] text-[var(--fiori-text-muted)]">
                                ثبت توسط: {r.userName || 'اپراتور'}
                              </div>
                            </div>
                          ) : (
                            <div className="text-[11px] text-[var(--fiori-text-primary)] mt-0.5">
                              وزن ته‌کلاف برگشتی:{' '}
                              <strong className="font-mono text-[var(--fiori-positive)]">
                                {formatNumber(r.returnedWeightKg)} kg
                              </strong>
                              {r.notes && <p className="text-[var(--fiori-text-secondary)] mt-0.5">{r.notes}</p>}
                              <div className="text-[10px] text-[var(--fiori-text-muted)] mt-0.5">
                                ثبت توسط: {r.userName || 'انباردار'}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="p-3 bg-[var(--fiori-bg-subtle)] rounded-[var(--fiori-radius-md)] border border-[var(--fiori-border-default)] text-center text-[var(--fiori-text-muted)]">
                      هنوز هیچ برگه صدور به خط تولید یا برگشت ته‌کلافی برای این رول ثبت نشده است (کلاف دست‌نخورده است).
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </FioriDialog>
      )}

      {/* Multi-Contract Allocation Dialog */}
      {selectedCoil && (
        <FioriDialog
          isOpen={allocateModalOpen}
          onClose={() => setAllocateModalOpen(false)}
          title={`تسهیم چندقراردادی کلاف فیزیکی شماره ${selectedCoil.coilId}`}
          subtitle={`وزن کل فیزیکی کلاف: ${formatWeightKg(selectedCoil.originalWeightKg)} | این کلاف واحد می‌تواند به چند قرارداد سهمیه تخصیص داده شود بدون ایجاد کلاف تکراری.`}
          icon={<Layers className="w-4 h-4" />}
          tone="brand"
          size="lg"
          footer={
            <div className="flex items-center justify-between text-xs w-full">
              <span className="text-[var(--fiori-text-secondary)]">
                مجموع تسهیم‌شده:{' '}
                <strong className="text-[var(--fiori-text-primary)] font-mono tabular-nums">
                  {formatNumber(allocationsList.reduce((s, a) => s + Number(a.allocatedWeightKg || 0), 0))}
                </strong>{' '}
                / {selectedCoil.originalWeightKg} kg
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAllocateModalOpen(false)}
                  className="sap-btn-standard px-3.5 py-1.5 text-xs cursor-pointer"
                >
                  انصراف
                </button>
                <button
                  type="submit"
                  form="coil-allocate-form"
                  className="sap-btn-emphasized px-4 py-1.5 text-xs font-medium cursor-pointer"
                >
                  ذخیره تسهیم
                </button>
              </div>
            </div>
          }
        >
          <form id="coil-allocate-form" onSubmit={handleAllocateSubmit} className="space-y-3.5 text-xs">
            <div className="space-y-2">
              {allocationsList.map((item, idx) => (
                <div
                  key={idx}
                  className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 bg-[var(--fiori-bg-subtle)] p-2.5 rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-default)]"
                >
                  <div className="flex-1">
                    <label className="block text-[10px] text-[var(--fiori-text-secondary)] mb-1">
                      انتخاب قرارداد از لیست قراردادهای فعال:
                    </label>
                    <select
                      value={item.contractId}
                      onChange={e => {
                        const updated = [...allocationsList];
                        updated[idx].contractId = e.target.value;
                        setAllocationsList(updated);
                      }}
                      className="w-full bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1.5 text-[var(--fiori-text-primary)] font-mono font-bold focus:outline-none focus:border-[var(--fiori-brand)] text-xs"
                    >
                      <option value="">-- انتخاب قرارداد از لیست --</option>
                      {availableContracts.map(cnt => (
                        <option key={cnt.id} value={cnt.contractNumber}>
                          {cnt.contractNumber} — {cnt.title || cnt.customerName || 'ساپکو'}
                        </option>
                      ))}
                      {item.contractId &&
                        !availableContracts.some(
                          c => c.contractNumber === item.contractId || c.id === item.contractId
                        ) && <option value={item.contractId}>{item.contractId}</option>}
                    </select>
                  </div>
                  <div className="w-full sm:w-32">
                    <label className="block text-[10px] text-[var(--fiori-text-secondary)] mb-1">
                      وزن تخصیصی (kg):
                    </label>
                    <input
                      type="number"
                      placeholder="وزن (kg)"
                      value={item.allocatedWeightKg}
                      onChange={e => {
                        const updated = [...allocationsList];
                        updated[idx].allocatedWeightKg = Number(e.target.value);
                        setAllocationsList(updated);
                      }}
                      className="w-full bg-[var(--fiori-bg-surface)] border border-[var(--fiori-border-input)] rounded-[var(--fiori-radius-sm)] px-2.5 py-1.5 text-[var(--fiori-text-primary)] font-mono font-bold text-xs focus:outline-none focus:border-[var(--fiori-brand)]"
                    />
                  </div>
                  {allocationsList.length > 1 && (
                    <button
                      type="button"
                      onClick={() => {
                        setAllocationsList(allocationsList.filter((_, i) => i !== idx));
                      }}
                      className="text-[var(--fiori-negative)] hover:underline px-1.5 pt-4 text-sm cursor-pointer self-end sm:self-center"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => {
                const defaultCnt = availableContracts[0]?.contractNumber || '';
                setAllocationsList([...allocationsList, { contractId: defaultCnt, allocatedWeightKg: 0 }]);
              }}
              className="text-xs text-[var(--fiori-brand)] hover:underline font-bold flex items-center gap-1 mt-1 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>افزودن سهم قرارداد دیگر</span>
            </button>
          </form>
        </FioriDialog>
      )}

      {/* Mandatory QC Hold Reason Dialog */}
      {qcHoldModalCoil && (
        <FioriDialog
          isOpen={Boolean(qcHoldModalCoil)}
          onClose={() => setQcHoldModalCoil(null)}
          title={`ثبت اجباری علت قرنطینه کیفی (QC Hold) — کلاف ${qcHoldModalCoil.coilId}`}
          subtitle={`شماره ذوب: ${qcHoldModalCoil.heatNumber || '—'} | وزن درگیر: ${formatWeightKg(qcHoldModalCoil.remainingWeightKg)}`}
          icon={<ShieldAlert className="w-4 h-4" />}
          tone="danger"
          size="lg"
          footer={
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setQcHoldModalCoil(null)}
                className="sap-btn-standard px-3.5 py-1.5 text-xs cursor-pointer"
              >
                انصراف
              </button>
              <button
                type="submit"
                form="coil-qc-hold-form"
                className="px-4 py-1.5 rounded-[var(--fiori-radius-sm)] bg-[var(--fiori-negative)] hover:opacity-95 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>ثبت علت در لاگ و اعمال قرنطینه (QC Hold)</span>
              </button>
            </div>
          }
        >
          <form id="coil-qc-hold-form" onSubmit={handleConfirmQcHoldModalSubmit} className="space-y-3.5 text-xs">
            <FioriMessageStrip tone="error" title="هشدار کنترل کیفیت و برنامه‌ریزی (ATP)" compact>
              با ثبت قرنطینه کیفی، مقدار{' '}
              <strong className="font-mono">{formatWeightKg(qcHoldModalCoil.remainingWeightKg)}</strong> از موجودی آزاد
              قابل تخصیص (ATP) در ماژول MRP کسر شده و حواله آن به خط تولید مسدود می‌گردد. درج علت دقیق قرنطینه در
              لاگ حسابرسی (Audit Trail) اجباری است.
            </FioriMessageStrip>

            <div>
              <label className="block text-[11px] font-bold text-[var(--fiori-text-primary)] mb-1.5">
                انتخاب سریع از دلایل متداول عدم انطباق کیفی:
              </label>
              <div className="flex flex-wrap gap-1.5">
                {QC_HOLD_REASON_PRESETS.map(preset => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => {
                      setQcHoldReasonInput(preset);
                      setQcHoldReasonError('');
                    }}
                    className={`px-2.5 py-1 rounded-[var(--fiori-radius-sm)] text-[11px] border transition cursor-pointer ${
                      qcHoldReasonInput === preset
                        ? 'bg-[var(--fiori-negative)] text-white border-[var(--fiori-negative)] font-bold'
                        : 'bg-[var(--fiori-bg-subtle)] hover:bg-[var(--fiori-bg-hover)] text-[var(--fiori-text-primary)] border-[var(--fiori-border-default)]'
                    }`}
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-[var(--fiori-text-primary)] mb-1">
                علت قرنطینه کیفی (QC Hold Reason) <span className="text-[var(--fiori-negative)]">* (اجباری)</span>
              </label>
              <textarea
                rows={3}
                value={qcHoldReasonInput}
                onChange={e => {
                  setQcHoldReasonInput(e.target.value);
                  if (e.target.value.trim()) setQcHoldReasonError('');
                }}
                placeholder="شرح دقیق عیب ظاهری، مغایرت ابعادی یا شماره برگه عدم انطباق (NCR) را وارد نمایید..."
                className="w-full rounded-[var(--fiori-radius-sm)] border border-[var(--fiori-border-input)] bg-[var(--fiori-bg-surface)] px-3 py-2 text-xs text-[var(--fiori-text-primary)] focus:outline-none focus:border-[var(--fiori-negative)]"
              />
              {qcHoldReasonError && (
                <p className="text-[11px] text-[var(--fiori-negative)] font-bold mt-1">{qcHoldReasonError}</p>
              )}
            </div>
          </form>
        </FioriDialog>
      )}
    </div>
  );
};
