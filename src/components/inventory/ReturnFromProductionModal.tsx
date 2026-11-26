import React, { useState, useMemo, useEffect } from 'react';
import {
  X,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  ArrowLeft,
  FileText,
  Layers,
  Package,
} from 'lucide-react';
import {
  DetailedStockBalance,
  Part,
  PhysicalCoil,
  StockOwnership,
  WarehouseDefinition,
} from '../../types/inventory';
import { formatWeightKg, formatNumber } from '../../utils/formatters';
import { ContextualHelp } from '../common/ContextualHelp';
import { classifyMaterialFamily, MATERIAL_FAMILY_LABELS_FA } from '../../utils/materialClassification';

interface ReturnFromProductionModalProps {
  isOpen: boolean;
  onClose: () => void;
  coils: PhysicalCoil[];
  warehouses: WarehouseDefinition[];
  parts?: Part[];
  balances?: DetailedStockBalance[];
  currentUser: { uid: string; displayName: string; role: string };
  onSubmitDocument?: (payload: any) => Promise<{ success: boolean; message?: string; error?: string }>;
  onSuccess: () => Promise<void>;
}

type ReturnMode = 'COIL_REMNANT' | 'GENERAL_MATERIAL';

export const ReturnFromProductionModal: React.FC<ReturnFromProductionModalProps> = ({
  isOpen,
  onClose,
  coils,
  warehouses,
  parts = [],
  balances = [],
  currentUser,
  onSubmitDocument,
  onSuccess,
}) => {
  const [returnMode, setReturnMode] = useState<ReturnMode>('COIL_REMNANT');
  const [step, setStep] = useState<1 | 2>(1);

  // Mode 1: Sheet-metal coil remnant return
  const [selectedCoilId, setSelectedCoilId] = useState<string>('');
  const [returnWeightKg, setReturnWeightKg] = useState<string>('');
  const [varianceWeightKg, setVarianceWeightKg] = useState<string>('0');

  // Mode 2: Fasteners / Rubber / Non-coil raw material return (MvT 262)
  const [selectedPartId, setSelectedPartId] = useState<string>('');
  const [generalReturnQty, setGeneralReturnQty] = useState<string>('');
  const [generalLotNumber, setGeneralLotNumber] = useState<string>('');
  const [generalOwnership, setGeneralOwnership] = useState<StockOwnership>('COMPANY_OWNED');
  const [generalContractNumber, setGeneralContractNumber] = useState<string>('');
  const [generalMoReference, setGeneralMoReference] = useState<string>('');

  const [sourceStation, setSourceStation] = useState<string>('خط پرس و برشکاری سالن ۱');
  const [targetWarehouseId, setTargetWarehouseId] = useState<string>('WH-RAW');
  const [notes, setNotes] = useState<string>('');
  const [idempotencyKey, setIdempotencyKey] = useState<string>(
    () => `RET-262-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const returnableCoils = useMemo(() => {
    const issuedOnes = coils.filter(c => c.originalWeightKg > c.remainingWeightKg);
    return issuedOnes.length > 0 ? issuedOnes : coils;
  }, [coils]);

  const nonCoilRawParts = useMemo(() => {
    const raw = parts.filter(p => {
      const fam = classifyMaterialFamily(p);
      return fam === 'FASTENER' || fam === 'RUBBER' || (p.category === 'RAW_MATERIAL' && p.unit !== 'KG');
    });
    return raw.length > 0 ? raw : parts.filter(p => p.category === 'RAW_MATERIAL');
  }, [parts]);

  useEffect(() => {
    if (isOpen && returnableCoils.length > 0 && !selectedCoilId) {
      setSelectedCoilId(returnableCoils[0].id);
    }
  }, [isOpen, returnableCoils, selectedCoilId]);

  useEffect(() => {
    if (isOpen && nonCoilRawParts.length > 0 && !selectedPartId) {
      setSelectedPartId(nonCoilRawParts[0].id);
    }
  }, [isOpen, nonCoilRawParts, selectedPartId]);

  // Inherit default ownership/contract when selecting a non-coil part
  useEffect(() => {
    if (!selectedPartId) return;
    const match = balances.find(b => b.partId === selectedPartId);
    if (match) {
      setGeneralOwnership(match.ownership || 'COMPANY_OWNED');
      if (match.contractNumber) setGeneralContractNumber(match.contractNumber);
      if (match.warehouseId) setTargetWarehouseId(match.warehouseId);
    }
  }, [selectedPartId, balances]);

  if (!isOpen) return null;

  const selectedCoil = coils.find(c => c.id === selectedCoilId);
  const originalWeight = selectedCoil?.originalWeightKg || 0;
  const currentRemainingInStore = selectedCoil?.remainingWeightKg || 0;
  const netIssuedToLine = Math.max(0, originalWeight - currentRemainingInStore);
  const enteredReturnKg = Number(returnWeightKg) || 0;
  const enteredVarianceKg = Math.max(0, Number(varianceWeightKg) || 0);
  const maxReturnableKg = netIssuedToLine > 0 ? netIssuedToLine : originalWeight;
  const exceedsIssued = netIssuedToLine > 0 && enteredReturnKg + enteredVarianceKg > netIssuedToLine + 0.001;

  const selectedPart = nonCoilRawParts.find(p => p.id === selectedPartId) || parts.find(p => p.id === selectedPartId);
  const enteredGeneralQty = Number(generalReturnQty) || 0;
  const targetWarehouse = warehouses.find(w => w.id === targetWarehouseId);

  const resetFormAndClose = () => {
    setStep(1);
    setReturnWeightKg('');
    setVarianceWeightKg('0');
    setGeneralReturnQty('');
    setGeneralLotNumber('');
    setGeneralMoReference('');
    setNotes('');
    setErrorMsg(null);
    setIdempotencyKey(`RET-262-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    onClose();
  };

  const handleConfirmCoilReturn = async () => {
    if (!selectedCoil) return;
    setErrorMsg(null);

    if (enteredReturnKg <= 0) {
      setErrorMsg('وزن ورق برگشتی به انبار باید بزرگتر از صفر باشد.');
      return;
    }

    if (exceedsIssued) {
      setErrorMsg(
        `مجموع وزن برگشتی (${formatNumber(enteredReturnKg)} kg)${enteredVarianceKg > 0 ? ` و افت وزنی (${formatNumber(enteredVarianceKg)} kg)` : ''} نمی‌تواند بیشتر از مقدار صادرشده به خط (${formatNumber(netIssuedToLine)} kg) باشد.`
      );
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/inventory/coils/${selectedCoil.id}/return`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          returnedRemnantWeightKg: enteredReturnKg,
          varianceWeightKg: enteredVarianceKg > 0 ? enteredVarianceKg : 0,
          warehouseId: targetWarehouseId || selectedCoil.warehouseId,
          idempotencyKey,
          notes:
            notes.trim() ||
            `برگشت ته‌کلاف از ${sourceStation} به ${targetWarehouse?.name || 'انبار مواد اولیه'}`,
          user: currentUser,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setErrorMsg(data.error || 'خطا در ثبت برگشت ورق از خط تولید');
        setLoading(false);
        return;
      }

      await onSuccess();
      setLoading(false);
      resetFormAndClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'خطای ارتباط با سرور در ثبت برگشت از تولید');
      setLoading(false);
    }
  };

  const handleConfirmGeneralReturn = async () => {
    if (!selectedPart) return;
    setErrorMsg(null);
    if (enteredGeneralQty <= 0) {
      setErrorMsg('مقدار برگشتی از تولید باید بزرگتر از صفر باشد.');
      return;
    }

    setLoading(true);
    try {
      const unitWeight = selectedPart.unit === 'KG' ? 1 : Number(selectedPart.weightPerUnitKg || 0.01);
      const qtyKg = Number((enteredGeneralQty * unitWeight).toFixed(3));
      const matchedBalance = balances.find(
        b => b.partId === selectedPart.id && b.warehouseId === targetWarehouseId
      );

      const payload = {
        documentType: 'RECEIPT_RAW_MATERIAL',
        movementType: '262',
        idempotencyKey,
        warehouseId: targetWarehouseId,
        warehouseName: targetWarehouse?.name,
        ownership: generalOwnership,
        contractId: matchedBalance?.contractId,
        contractNumber: generalContractNumber.trim() || matchedBalance?.contractNumber || undefined,
        referenceType: 'PRODUCTION_RETURN',
        referenceNumber: generalMoReference.trim() || sourceStation,
        auditNote:
          notes.trim() ||
          `برگشت مازاد ${selectedPart.name} از ${sourceStation} به ${targetWarehouse?.name || 'انبار'} (MvT 262)`,
        autoPost: true,
        lines: [
          {
            partId: selectedPart.id,
            partCode: selectedPart.code,
            partName: selectedPart.name,
            lotNumber: generalLotNumber.trim() || matchedBalance?.lotNumber || undefined,
            ownership: generalOwnership,
            contractId: matchedBalance?.contractId,
            contractNumber: generalContractNumber.trim() || matchedBalance?.contractNumber || undefined,
            locationCode: targetWarehouse?.locations?.[0] || 'LOC-01',
            quantity: enteredGeneralQty,
            unit: selectedPart.unit,
            quantityKg: qtyKg,
            qualityStatus: 'AVAILABLE',
            notes: notes.trim() || `برگشت از ${sourceStation}`,
          },
        ],
      };

      let result: { success: boolean; error?: string };
      if (onSubmitDocument) {
        result = await onSubmitDocument(payload);
      } else {
        const res = await fetch('/api/inventory/documents', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({
            ...payload,
            createdByUid: currentUser.uid,
            createdByName: currentUser.displayName,
          }),
        });
        const data = await res.json();
        result = { success: res.ok && Boolean(data.success), error: data.error };
      }

      if (!result.success) {
        setErrorMsg(result.error || 'خطا در ثبت برگشت کالا از خط تولید');
        setLoading(false);
        return;
      }

      await onSuccess();
      setLoading(false);
      resetFormAndClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'خطای ارتباط با سرور در ثبت برگشت از تولید');
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#333333]/40 backdrop-blur-[1px] flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white border border-[#d9d9d9] w-full max-w-2xl rounded-xl shadow-xl overflow-hidden my-6">
        {/* Header */}
        <div className="p-5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="p-2.5 bg-blue-600 text-white rounded-xl">
              <RotateCcw className="w-5 h-5" />
            </span>
            <div>
              <h3 className="text-sm lg:text-base font-bold text-slate-900">
                ثبت برگشت مواد، ته‌کلاف، پیچ و مهره و لاستیک از خط تولید (MvT 262)
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                بازگرداندن مازاد مصرف یا ته‌رول به انبار با حفظ ردیابی کویل‌پک، مالکیت امانی و قرارداد
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={resetFormAndClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-200/60 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode Switcher */}
        <div className="px-6 pt-4 flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => {
              setReturnMode('COIL_REMNANT');
              setStep(1);
              setErrorMsg(null);
            }}
            className={`flex-1 py-2 px-3 rounded-lg border font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
              returnMode === 'COIL_REMNANT'
                ? 'bg-[#e5f3fa] border-[#007cc0] text-[#007cc0]'
                : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Layers className="w-4 h-4" />
            <span>برگشت ته‌کلاف ورق (کلاف فیزیکی)</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setReturnMode('GENERAL_MATERIAL');
              setStep(1);
              setErrorMsg(null);
            }}
            className={`flex-1 py-2 px-3 rounded-lg border font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
              returnMode === 'GENERAL_MATERIAL'
                ? 'bg-[#e5f3fa] border-[#007cc0] text-[#007cc0]'
                : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Package className="w-4 h-4" />
            <span>برگشت پیچ و مهره، لاستیک و مواد غیرکلافی</span>
          </button>
        </div>

        <div className="p-6 space-y-5 text-xs">
          {errorMsg && (
            <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl flex items-center gap-2 text-rose-700">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
              <span>{errorMsg}</span>
            </div>
          )}

          {returnMode === 'COIL_REMNANT' ? (
            step === 1 ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1.5">
                    انتخاب رول فیزیکی / کویل‌پک تحویل‌شده به خط <span className="text-rose-500">*</span>
                    <ContextualHelp
                      title="انتخاب رول و کویل‌پک"
                      description="رولی که قبلاً تمام یا بخشی از آن برای خط تولید صادر شده و اکنون باقی‌مانده آن به انبار بازگردانده می‌شود را انتخاب کنید."
                      whyNeeded="برای اینکه وزن برگشتی دقیقاً به همان کویل‌پک و قرارداد اصلی اضافه شود."
                      example="COIL-2026-01 (PK-SAP-901)"
                      mandatory
                    />
                  </label>
                  <select
                    value={selectedCoilId}
                    onChange={e => setSelectedCoilId(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-2.5 text-slate-900 font-medium focus:outline-none focus:bg-white focus:border-blue-600"
                  >
                    {returnableCoils.map(c => {
                      const issued = Math.max(0, c.originalWeightKg - c.remainingWeightKg);
                      return (
                        <option key={c.id} value={c.id}>
                          کویل‌پک: {c.coilPackNumber} | کد رول: {c.coilId} | گرید {c.materialGrade} ضخامت {c.thicknessMm}mm | صادرشده: {formatNumber(issued)} kg
                        </option>
                      );
                    })}
                  </select>
                </div>

                {selectedCoil && (
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between border-b border-slate-200/80 pb-2.5">
                      <div>
                        <span className="text-slate-500">مشخصات فنی رول: </span>
                        <strong className="text-slate-900">
                          {selectedCoil.partName || `ورق ${selectedCoil.materialGrade}`} (ضخامت {selectedCoil.thicknessMm}mm · عرض {selectedCoil.widthMm}mm)
                        </strong>
                      </div>
                      <span className="font-mono text-slate-700 bg-white px-2.5 py-1 rounded-lg border border-slate-200">
                        کویل‌پک: {selectedCoil.coilPackNumber}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div className="bg-white p-3 rounded-lg border border-slate-200/80">
                        <span className="text-[11px] text-slate-500 block">وزن اولیه رول</span>
                        <span className="text-sm font-bold text-slate-900 font-mono tabular-nums mt-1 block">
                          {formatWeightKg(originalWeight)}
                        </span>
                      </div>
                      <div className="bg-white p-3 rounded-lg border border-slate-200/80">
                        <span className="text-[11px] text-slate-500 block">خالص صادرشده به خط</span>
                        <span className="text-sm font-bold text-amber-700 font-mono tabular-nums mt-1 block">
                          {formatWeightKg(netIssuedToLine)}
                        </span>
                      </div>
                      <div className="bg-white p-3 rounded-lg border border-slate-200/80">
                        <span className="text-[11px] text-slate-500 block">موجودی فعلی در انبار</span>
                        <span className="text-sm font-bold text-emerald-700 font-mono tabular-nums mt-1 block">
                          {formatWeightKg(currentRemainingInStore)}
                        </span>
                      </div>
                      <div className="bg-blue-50/70 p-3 rounded-lg border border-blue-200">
                        <span className="text-[11px] text-blue-700 font-medium block">حداکثر قابل برگشت</span>
                        <span className="text-sm font-bold text-blue-900 font-mono tabular-nums mt-1 block">
                          {formatWeightKg(maxReturnableKg)}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1.5">
                      وزن ته‌کلاف برگشتی (kg) <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="number"
                      step="any"
                      value={returnWeightKg}
                      onChange={e => setReturnWeightKg(e.target.value)}
                      placeholder="مثلاً 800"
                      className={`w-full bg-slate-50 border rounded-xl px-3 py-2 text-slate-900 font-mono font-bold text-sm focus:outline-none ${
                        exceedsIssued ? 'border-rose-400 bg-rose-50 text-rose-800' : 'border-slate-300 focus:bg-white focus:border-blue-600'
                      }`}
                    />
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1.5">
                      افت وزنی / پرت برش (kg)
                    </label>
                    <input
                      type="number"
                      step="any"
                      min={0}
                      value={varianceWeightKg}
                      onChange={e => setVarianceWeightKg(e.target.value)}
                      placeholder="0"
                      className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-slate-900 font-mono focus:outline-none focus:bg-white focus:border-blue-600"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1.5">
                      انبار مقصد برگشت
                    </label>
                    <select
                      value={targetWarehouseId}
                      onChange={e => setTargetWarehouseId(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-slate-800 focus:outline-none focus:bg-white focus:border-blue-600"
                    >
                      {warehouses.map(w => (
                        <option key={w.id} value={w.id}>{w.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {exceedsIssued && (
                  <span className="text-[11px] text-rose-600 block font-semibold">
                    مجموع وزن برگشتی و افت وزنی نمی‌تواند از وزن صادرشده به خط ({formatWeightKg(netIssuedToLine)}) بیشتر باشد.
                  </span>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1.5">ایستگاه بازگرداننده</label>
                    <select
                      value={sourceStation}
                      onChange={e => setSourceStation(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-slate-800"
                    >
                      <option value="خط پرس و برشکاری سالن ۱">خط پرس و برشکاری سالن ۱</option>
                      <option value="پرس ۸۰۰ تن کشش عمیق">پرس ۸۰۰ تن کشش عمیق</option>
                      <option value="خط نواربری و گیوتین">خط نواربری و گیوتین</option>
                      <option value="سالن جوشکاری و مونتاژ">سالن جوشکاری و مونتاژ</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1.5">توضیحات قبض باسکول</label>
                    <input
                      type="text"
                      value={notes}
                      onChange={e => setNotes(e.target.value)}
                      placeholder="شماره قبض باسکول یا علت برگشت..."
                      className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-slate-800"
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 space-y-4">
                <div className="flex items-center gap-2 text-slate-900 font-bold text-sm border-b border-slate-200 pb-3">
                  <FileText className="w-4 h-4 text-blue-600" />
                  <span>پیش‌نمایش سند برگشت ته‌کلاف (MvT 262)</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div className="bg-white p-3 rounded-lg border border-slate-200">
                    <span className="text-slate-500 block">رول و کویل‌پک:</span>
                    <strong className="text-slate-900 font-mono mt-0.5 block">
                      {selectedCoil?.coilId} ({selectedCoil?.coilPackNumber})
                    </strong>
                  </div>
                  <div className="bg-white p-3 rounded-lg border border-slate-200">
                    <span className="text-slate-500 block">انبار مقصد:</span>
                    <strong className="text-slate-900 mt-0.5 block">
                      {targetWarehouse?.name || selectedCoil?.warehouseName}
                    </strong>
                  </div>
                  <div className="bg-emerald-50 p-3 rounded-lg border border-emerald-200">
                    <span className="text-emerald-700 block">وزن برگشتی به انبار:</span>
                    <strong className="text-emerald-900 font-mono text-sm mt-0.5 block">
                      + {formatWeightKg(enteredReturnKg)}
                      {enteredVarianceKg > 0 ? ` (افت: ${formatWeightKg(enteredVarianceKg)})` : ''}
                    </strong>
                  </div>
                  <div className="bg-white p-3 rounded-lg border border-slate-200">
                    <span className="text-slate-500 block">موجودی جدید رول پس از ثبت:</span>
                    <strong className="text-slate-900 font-mono text-sm mt-0.5 block">
                      {formatWeightKg(currentRemainingInStore + enteredReturnKg)}
                    </strong>
                  </div>
                </div>
              </div>
            )
          ) : (
            /* Mode 2: Fasteners, Rubber & Non-Coil Return from Production (MvT 262) */
            <div className="space-y-4">
              <div>
                <label className="block text-slate-700 font-semibold mb-1.5">
                  انتخاب کالا (پیچ و مهره، لاستیک، قطعات پلیمری یا مواد اولیه) <span className="text-rose-500">*</span>
                </label>
                <select
                  value={selectedPartId}
                  onChange={e => setSelectedPartId(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-2.5 text-slate-900 font-medium"
                >
                  {nonCoilRawParts.map(p => (
                    <option key={p.id} value={p.id}>
                      [{MATERIAL_FAMILY_LABELS_FA[classifyMaterialFamily(p)]}] {p.name} ({p.code}) — واحد: {p.unit === 'KG' ? 'کیلوگرم' : 'عدد'}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1.5">
                    مقدار برگشتی ({selectedPart?.unit === 'KG' ? 'کیلوگرم' : 'عدد'}) <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="number"
                    step="any"
                    min={0.001}
                    value={generalReturnQty}
                    onChange={e => setGeneralReturnQty(e.target.value)}
                    placeholder="مثلاً 250"
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-slate-900 font-mono font-bold text-sm"
                  />
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1.5">انبار مقصد برگشت</label>
                  <select
                    value={targetWarehouseId}
                    onChange={e => setTargetWarehouseId(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-slate-800"
                  >
                    {warehouses.map(w => (
                      <option key={w.id} value={w.id}>{w.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1.5">نوع مالکیت</label>
                  <select
                    value={generalOwnership}
                    onChange={e => setGeneralOwnership(e.target.value as StockOwnership)}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-slate-800"
                  >
                    <option value="COMPANY_OWNED">ملکی کارخانه</option>
                    <option value="SAPCO_SUPPLIER_OWNED">امانی ساپکو</option>
                    <option value="CUSTOMER_SUPPLIED">امانی مشتری</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1.5">شماره بچ / بسته (اختیاری)</label>
                  <input
                    type="text"
                    value={generalLotNumber}
                    onChange={e => setGeneralLotNumber(e.target.value)}
                    placeholder="مثلاً LOT-FST-01"
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-slate-900 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-semibold mb-1.5">شماره قرارداد (اختیاری)</label>
                  <input
                    type="text"
                    value={generalContractNumber}
                    onChange={e => setGeneralContractNumber(e.target.value)}
                    placeholder="مثلاً SAPCO-1403-Q3"
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-slate-900 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-semibold mb-1.5">مرجع دستور ساخت (MO)</label>
                  <input
                    type="text"
                    value={generalMoReference}
                    onChange={e => setGeneralMoReference(e.target.value)}
                    placeholder="مثلاً MO-1403-102"
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-slate-900 font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1.5">علت برگشت از خط تولید</label>
                <input
                  type="text"
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="مازاد بسته پیچ و مهره یا قطعات لاستیکی سالم برگشتی از خط مونتاژ..."
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-slate-800"
                />
              </div>
            </div>
          )}

          {/* Footer Actions */}
          <div className="pt-4 border-t border-slate-200 flex items-center justify-between">
            <button
              type="button"
              onClick={returnMode === 'COIL_REMNANT' && step === 2 ? () => setStep(1) : resetFormAndClose}
              disabled={loading}
              className="sap-btn-standard px-4 py-2 cursor-pointer"
            >
              {returnMode === 'COIL_REMNANT' && step === 2 ? 'بازگشت و اصلاح' : 'انصراف'}
            </button>

            {returnMode === 'COIL_REMNANT' ? (
              step === 1 ? (
                <button
                  type="button"
                  disabled={enteredReturnKg <= 0 || exceedsIssued || !selectedCoil}
                  onClick={() => setStep(2)}
                  className="sap-btn-emphasized px-5 py-2 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <span>پیش‌نمایش سند برگشت</span>
                  <ArrowLeft className="w-4 h-4" />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={loading}
                  onClick={handleConfirmCoilReturn}
                  className="px-5 py-2 bg-[#107e3e] hover:bg-[#0d6832] text-white rounded font-semibold transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>{loading ? 'در حال ثبت در کاردکس...' : 'ثبت قطعی برگشت ته‌کلاف (MvT 262)'}</span>
                </button>
              )
            ) : (
              <button
                type="button"
                disabled={loading || enteredGeneralQty <= 0 || !selectedPart}
                onClick={handleConfirmGeneralReturn}
                className="px-5 py-2 bg-[#107e3e] hover:bg-[#0d6832] text-white rounded font-semibold transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>{loading ? 'در حال ثبت در کاردکس...' : 'ثبت قطعی برگشت کالا از تولید (MvT 262)'}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
