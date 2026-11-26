import React, { useState, useMemo, useEffect } from 'react';
import {
  X,
  ArrowRightLeft,
  CheckCircle2,
  AlertCircle,
  ArrowLeft,
  Building2,
  Plus,
} from 'lucide-react';
import {
  Part,
  WarehouseDefinition,
  DetailedStockBalance,
} from '../../types/inventory';
import { formatNumber } from '../../utils/formatters';
import { QuickEntryModals, QuickCreateEntityType } from '../common/QuickEntryModals';
import { classifyMaterialFamily, MaterialFamily, MATERIAL_FAMILY_LABELS_FA } from '../../utils/materialClassification';

interface TransferFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  parts: Part[];
  warehouses: WarehouseDefinition[];
  balances: DetailedStockBalance[];
  onSubmit: (payload: any) => Promise<{ success: boolean; message?: string; error?: string }>;
  onItemCreated?: () => void;
}

export const TransferFormModal: React.FC<TransferFormModalProps> = ({
  isOpen,
  onClose,
  parts: initialParts,
  warehouses: initialWarehouses,
  balances,
  onSubmit,
  onItemCreated,
}) => {
  const [localParts, setLocalParts] = useState<Part[]>(initialParts);
  const [localWarehouses, setLocalWarehouses] = useState<WarehouseDefinition[]>(initialWarehouses);
  const [activeQuickModal, setActiveQuickModal] = useState<QuickCreateEntityType | null>(null);
  const [quickWarehouseTarget, setQuickWarehouseTarget] = useState<'SOURCE' | 'TARGET'>('TARGET');

  useEffect(() => {
    setLocalParts(initialParts);
  }, [initialParts]);
  useEffect(() => {
    setLocalWarehouses(initialWarehouses);
  }, [initialWarehouses]);

  const [sourceWarehouseId, setSourceWarehouseId] = useState<string>('WH-RAW');
  const [targetWarehouseId, setTargetWarehouseId] = useState<string>('WH-WIP-STAMP');
  const [sourceLocationCode, setSourceLocationCode] = useState<string>('LOC-RAW-A1');
  const [targetLocationCode, setTargetLocationCode] = useState<string>('LOC-WIP-S1');
  const [materialFamilyFilter, setMaterialFamilyFilter] = useState<'ALL' | MaterialFamily>('ALL');
  const [selectedPartId, setSelectedPartId] = useState<string>('');
  const [selectedBalanceId, setSelectedBalanceId] = useState<string>('');
  const [quantity, setQuantity] = useState<string>('');
  const [referenceNumber, setReferenceNumber] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [idempotencyKey, setIdempotencyKey] = useState<string>(
    () => `TRF-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );

  const [loading, setLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const filteredParts = useMemo(() => {
    if (materialFamilyFilter === 'ALL') return localParts;
    return localParts.filter(p => classifyMaterialFamily(p) === materialFamilyFilter);
  }, [localParts, materialFamilyFilter]);

  useEffect(() => {
    if (filteredParts.length > 0 && !filteredParts.some(p => p.id === selectedPartId)) {
      setSelectedPartId(filteredParts[0].id);
    }
  }, [filteredParts, selectedPartId]);

  const sourceWh = localWarehouses.find(w => w.id === sourceWarehouseId);
  const targetWh = localWarehouses.find(w => w.id === targetWarehouseId);

  const sourceLots = useMemo(() => {
    return balances.filter(
      b => b.partId === selectedPartId && b.warehouseId === sourceWarehouseId && b.availableQty > 0
    );
  }, [balances, selectedPartId, sourceWarehouseId]);

  useEffect(() => {
    if (sourceLots.length > 0) {
      if (!sourceLots.some(l => l.id === selectedBalanceId)) {
        setSelectedBalanceId(sourceLots[0].id);
        if (sourceLots[0].locationCode) {
          setSourceLocationCode(sourceLots[0].locationCode);
        }
      }
    } else {
      setSelectedBalanceId('');
    }
  }, [sourceLots, selectedBalanceId]);

  const selectedBalance = useMemo(
    () => sourceLots.find(l => l.id === selectedBalanceId) || sourceLots[0] || null,
    [sourceLots, selectedBalanceId]
  );

  const availableInSource = useMemo(() => {
    if (selectedBalance) return selectedBalance.availableQty;
    const list = balances.filter(b => b.partId === selectedPartId && b.warehouseId === sourceWarehouseId);
    return list.reduce((sum, b) => sum + b.availableQty, 0);
  }, [balances, selectedPartId, sourceWarehouseId, selectedBalance]);

  const qmLockedInSource = useMemo(() => {
    const list = balances.filter(b => b.partId === selectedPartId && b.warehouseId === sourceWarehouseId);
    return list.reduce((sum, b) => sum + (b.qualityInspectionQty || 0) + (b.blockedQty || 0), 0);
  }, [balances, selectedPartId, sourceWarehouseId]);

  const selectedPart = localParts.find(p => p.id === selectedPartId);
  const requestedQty = Number(quantity) || 0;
  const isOverdraft = requestedQty > availableInSource;
  const isSameWarehouse = sourceWarehouseId === targetWarehouseId;

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (sourceWarehouseId === targetWarehouseId) {
      setErrorMessage('انبار مبدا و انبار مقصد نمی‌توانند یکسان باشند.');
      return;
    }

    if (requestedQty <= 0) {
      setErrorMessage('مقدار انتقال باید عددی مثبت و بزرگتر از صفر باشد.');
      return;
    }

    if (isOverdraft) {
      setErrorMessage(
        `موجودی قابل استفاده در انبار مبدا کافی نیست. موجودی آزاد مبدا: ${formatNumber(availableInSource)}؛ مقدار درخواستی جهت انتقال: ${formatNumber(requestedQty)}.`
      );
      return;
    }

    setLoading(true);

    const inheritedOwnership = selectedBalance?.ownership || 'COMPANY_OWNED';
    const inheritedContractId = selectedBalance?.contractId;
    const inheritedContractNumber = selectedBalance?.contractNumber;
    const inheritedLotNumber = selectedBalance?.lotNumber || undefined;
    const inheritedHeatNumber = selectedBalance?.heatNumber || undefined;
    const effectiveSourceLocation = selectedBalance?.locationCode || sourceLocationCode;

    const payload = {
      documentType: 'TRANSFER',
      idempotencyKey,
      warehouseId: sourceWarehouseId,
      warehouseName: sourceWh?.name,
      targetWarehouseId,
      targetWarehouseName: targetWh?.name,
      ownership: inheritedOwnership,
      contractId: inheritedContractId,
      contractNumber: inheritedContractNumber,
      referenceType: 'INTERNAL_TRANSFER',
      referenceNumber: referenceNumber.trim() || undefined,
      autoPost: true,
      lines: [
        {
          partId: selectedPartId,
          partCode: selectedPart?.code,
          partName: selectedPart?.name,
          lotNumber: inheritedLotNumber,
          heatNumber: inheritedHeatNumber,
          ownership: inheritedOwnership,
          contractId: inheritedContractId,
          contractNumber: inheritedContractNumber,
          locationCode: effectiveSourceLocation,
          targetLocationCode,
          quantity: requestedQty,
          unit: selectedPart?.unit || 'PCS',
          qualityStatus: 'AVAILABLE',
          notes: notes.trim() || undefined,
        },
      ],
    };

    const res = await onSubmit(payload);
    setLoading(false);

    if (res.success) {
      setQuantity('');
      setIdempotencyKey(`TRF-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      onClose();
    } else {
      setErrorMessage(res.error || 'خطا در ثبت انتقال بین انبارها');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#333333]/40 backdrop-blur-[1px] flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white border border-[#d9d9d9] w-full max-w-2xl rounded-md shadow-xl overflow-hidden my-6">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#ffffff] border-b border-[#d9d9d9] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="p-2 bg-[#e5f3fa] border border-[#b3ddf2] text-[#007cc0] rounded">
              <ArrowRightLeft className="w-4 h-4" />
            </span>
            <div>
              <h3 className="text-sm font-semibold text-[#333333]">
                انتقال کالا و رول بین انبارها (Warehouse Transfer)
              </h3>
              <p className="text-[11px] text-[#666666] mt-0.5">
                جابجایی فیزیکی رول ورق یا قطعات از انبار مبدا به انبار مقصد با حفظ مالکیت و شماره کویل‌پک
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-200/60 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5 text-xs">
          {errorMessage && (
            <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl flex items-center gap-2 text-rose-700">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Visual Source -> Destination Flow */}
          <div className="grid grid-cols-1 md:grid-cols-11 gap-3 items-center">
            <div className="md:col-span-5 bg-amber-50/60 p-4 rounded-xl border border-amber-200 space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 font-bold text-amber-900">
                  <Building2 className="w-4 h-4 text-amber-700" />
                  <span>۱. انبار مبدا (خروج از)</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setQuickWarehouseTarget('SOURCE');
                    setActiveQuickModal('WAREHOUSE');
                  }}
                  className="text-[11px] font-semibold text-amber-800 hover:text-amber-950 flex items-center gap-0.5 cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  <span>+ انبار جدید</span>
                </button>
              </div>
              <select
                value={sourceWarehouseId}
                onChange={e => {
                  setSourceWarehouseId(e.target.value);
                  const wh = localWarehouses.find(w => w.id === e.target.value);
                  if (wh && wh.locations.length > 0) setSourceLocationCode(wh.locations[0]);
                }}
                className="w-full bg-white border border-amber-300 rounded-lg px-3 py-2 text-slate-900 font-semibold"
              >
                {localWarehouses.map(w => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <div>
                <span className="text-[11px] text-slate-600 block mb-1">جایگاه مبدا:</span>
                <select
                  value={sourceLocationCode}
                  onChange={e => setSourceLocationCode(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-800 font-mono"
                >
                  {(sourceWh?.locations || ['LOC-01']).map(loc => (
                    <option key={loc} value={loc}>
                      {loc}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="md:col-span-1 flex justify-center">
              <div className="w-8 h-8 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-600">
                <ArrowLeft className="w-4 h-4" />
              </div>
            </div>

            <div className="md:col-span-5 bg-emerald-50/60 p-4 rounded-xl border border-emerald-200 space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 font-bold text-emerald-900">
                  <Building2 className="w-4 h-4 text-emerald-700" />
                  <span>۲. انبار مقصد (ورود به)</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setQuickWarehouseTarget('TARGET');
                    setActiveQuickModal('WAREHOUSE');
                  }}
                  className="text-[11px] font-semibold text-emerald-700 hover:text-emerald-900 flex items-center gap-0.5 cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  <span>+ انبار جدید</span>
                </button>
              </div>
              <select
                value={targetWarehouseId}
                onChange={e => {
                  setTargetWarehouseId(e.target.value);
                  const wh = localWarehouses.find(w => w.id === e.target.value);
                  if (wh && wh.locations.length > 0) setTargetLocationCode(wh.locations[0]);
                }}
                className="w-full bg-white border border-emerald-300 rounded-lg px-3 py-2 text-slate-900 font-semibold"
              >
                {localWarehouses.map(w => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <div>
                <span className="text-[11px] text-slate-600 block mb-1">جایگاه مقصد:</span>
                <select
                  value={targetLocationCode}
                  onChange={e => setTargetLocationCode(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-800 font-mono"
                >
                  {(targetWh?.locations || ['LOC-01']).map(loc => (
                    <option key={loc} value={loc}>
                      {loc}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {isSameWarehouse && (
            <div className="p-2.5 bg-[#ffecec] border border-[#f2b8b5] rounded flex items-center gap-2 text-[#bb0000] font-semibold">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>انبار مبدا و انبار مقصد نمی‌توانند یکسان باشند (کنترل آنی جابجایی MvT 311).</span>
            </div>
          )}

          {/* Material Family Filter */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold text-slate-600 ml-1">گروه کالا:</span>
            {(['ALL', 'SHEET_METAL', 'FASTENER', 'RUBBER', 'WIP', 'FINISHED_GOOD'] as const).map(fam => (
              <button
                key={fam}
                type="button"
                onClick={() => setMaterialFamilyFilter(fam)}
                className={`px-2.5 py-1 rounded border text-[11px] font-medium cursor-pointer transition-colors ${
                  materialFamilyFilter === fam
                    ? 'bg-[#007cc0] text-white border-[#007cc0]'
                    : 'bg-[#f5f5f5] text-[#333333] border-[#d9d9d9] hover:bg-[#e5f3fa]'
                }`}
              >
                {fam === 'ALL' ? 'همه اقلام' : MATERIAL_FAMILY_LABELS_FA[fam]}
              </button>
            ))}
          </div>

          {/* Item & Lot Selection */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-slate-700 font-semibold">
                  انتخاب کالا / ورق / پیچ و مهره / لاستیک <span className="text-rose-500">*</span>
                </label>
                <button
                  type="button"
                  onClick={() => setActiveQuickModal('PART')}
                  className="text-[11px] font-semibold text-emerald-700 hover:text-emerald-800 flex items-center gap-0.5 cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  <span>+ تعریف سریع کالا</span>
                </button>
              </div>
              <select
                value={selectedPartId}
                onChange={e => setSelectedPartId(e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 text-slate-900 font-semibold"
              >
                {filteredParts.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.code}) — {p.unit === 'KG' ? 'کیلوگرم' : 'عدد'}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-slate-700 font-semibold mb-1">
                انتخاب کویل‌پک / بچ / مالکیت موجود در مبدا
              </label>
              <select
                value={selectedBalanceId}
                onChange={e => {
                  setSelectedBalanceId(e.target.value);
                  const found = sourceLots.find(l => l.id === e.target.value);
                  if (found?.locationCode) setSourceLocationCode(found.locationCode);
                }}
                className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 text-slate-900 font-mono"
              >
                {sourceLots.length === 0 ? (
                  <option value="">موجودی آزاد در انبار مبدا وجود ندارد</option>
                ) : (
                  sourceLots.map(l => (
                    <option key={l.id} value={l.id}>
                      {l.lotNumber || 'عمومی'} | {l.ownership === 'SAPCO_SUPPLIER_OWNED' ? 'امانی ساپکو' : 'ملکی'}{l.contractNumber ? ` (${l.contractNumber})` : ''} — آزاد: {formatNumber(l.availableQty)} {l.unit}
                    </option>
                  ))
                )}
              </select>
              {selectedBalance && (
                <div className="mt-1 text-[11px] text-[#007cc0] flex flex-wrap items-center gap-2">
                  <span>
                    مالکیت منتقل‌شونده:{' '}
                    <strong>
                      {selectedBalance.ownership === 'SAPCO_SUPPLIER_OWNED'
                        ? 'امانی ساپکو (حفظ امانی)'
                        : selectedBalance.ownership === 'CUSTOMER_SUPPLIED'
                          ? 'امانی مشتری'
                          : 'ملکی شرکت کوثر'}
                    </strong>
                  </span>
                  {selectedBalance.contractNumber && (
                    <span className="font-mono bg-[#e5f3fa] px-1.5 py-0.5 rounded border border-[#b3ddf2]">
                      قرارداد: {selectedBalance.contractNumber}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Quantity and Ref */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-slate-700 font-semibold mb-1">
                مقدار انتقال ({selectedPart?.unit === 'KG' ? 'کیلوگرم' : 'عدد'}) <span className="text-rose-500">*</span>
              </label>
              <input
                type="number"
                step="any"
                value={quantity}
                onChange={e => {
                  setQuantity(e.target.value);
                  if (errorMessage) setErrorMessage(null);
                }}
                placeholder="مقدار جابجایی..."
                className={`w-full border rounded px-3.5 py-2 font-mono font-bold text-sm focus:outline-none ${
                  isOverdraft ? 'border-[#bb0000] bg-[#ffecec]/50 text-[#bb0000]' : 'bg-[#f5f5f5] border-[#bfbfbf] text-[#333333] focus:bg-white focus:border-[#007cc0]'
                }`}
              />
              <div className="text-[11px] text-[#107e3e] mt-1 flex flex-wrap items-center gap-2">
                <span>سقف آزاد (Unrestricted): <strong className="font-mono">{formatNumber(availableInSource)}</strong></span>
                {qmLockedInSource > 0 && (
                  <span className="text-[#e9730c]">
                    · در قرنطینه/مسدود (غیرقابل جابجایی ۳۱۱): <strong className="font-mono">{formatNumber(qmLockedInSource)}</strong>
                  </span>
                )}
              </div>
              {isOverdraft && (
                <span className="text-[11px] font-semibold text-[#bb0000] mt-1 block">
                  مقدار درخواستی از سقف موجودی آزاد مبدا ({formatNumber(availableInSource)}) بیشتر است.
                </span>
              )}
            </div>

            <div>
              <label className="block text-slate-700 font-semibold mb-1">
                شماره مجوز / حواله جابجایی
              </label>
              <input
                type="text"
                value={referenceNumber}
                onChange={e => setReferenceNumber(e.target.value)}
                placeholder="مثلاً TRF-1403-402"
                className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-2.5 text-slate-900 font-mono"
              />
            </div>
          </div>

          <div>
            <label className="block text-slate-700 font-semibold mb-1">توضیحات انتقال</label>
            <input
              type="text"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="علت انتقال بین انبارها..."
              className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-2 text-slate-900"
            />
          </div>

          {/* Actions */}
          <div className="pt-4 border-t border-[#d9d9d9] flex items-center justify-between">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="sap-btn-standard px-4 py-1.5 cursor-pointer"
            >
              انصراف
            </button>
            <button
              type="submit"
              disabled={loading || isOverdraft || isSameWarehouse || requestedQty <= 0}
              className="sap-btn-emphasized px-5 py-1.5 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>{loading ? 'در حال ثبت انتقال...' : 'ثبت قطعی انتقال بین انبارها'}</span>
            </button>
          </div>
        </form>
      </div>

      <QuickEntryModals
        activeModal={activeQuickModal}
        onClose={() => setActiveQuickModal(null)}
        onCreated={(type, item) => {
          if (type === 'PART') {
            setLocalParts(prev => [item, ...prev]);
            setSelectedPartId(item.id);
          } else if (type === 'WAREHOUSE') {
            setLocalWarehouses(prev => [...prev, item]);
            if (quickWarehouseTarget === 'SOURCE') {
              setSourceWarehouseId(item.id);
              if (item.locations?.[0]) setSourceLocationCode(item.locations[0]);
            } else {
              setTargetWarehouseId(item.id);
              if (item.locations?.[0]) setTargetLocationCode(item.locations[0]);
            }
          }
          if (onItemCreated) onItemCreated();
        }}
      />
    </div>
  );
};
