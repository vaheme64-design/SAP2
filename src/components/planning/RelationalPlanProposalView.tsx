import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Wand2, CheckCircle2, Send, AlertTriangle, Save, ExternalLink } from 'lucide-react';
import { formatNumber, toPersianDigits } from '../../utils/formatters';
import { formatToJalali } from '../../utils/jalali';
import { useErpRouter } from '../../context/RouterContext';
import { useEnterpriseUx } from '../../context/EnterpriseUxContext';

type Proposal = {
  id: string;
  proposalNumber: string;
  version: number;
  status: 'DRAFT' | 'APPROVED' | 'SUPERSEDED' | 'RELEASED' | 'CANCELLED';
  generatedAt: string;
  notes?: string | null;
  productionPlan?: { id: string; planNumber: string; status: string } | null;
  lines: any[];
};

const statusLabels: Record<string, string> = {
  DRAFT: 'پیش‌نویس (نیازمند بررسی برنامه‌ریز)',
  APPROVED: 'تأییدشده',
  RELEASED: 'صادرشده به تولید',
  SUPERSEDED: 'نسخه منسوخ',
  CANCELLED: 'لغوشده',
};

const statusColors: Record<string, string> = {
  DRAFT: 'text-[#e9730c]',
  APPROVED: 'text-[#107e3e]',
  RELEASED: 'text-[#007cc0]',
  SUPERSEDED: 'text-[#666666]',
  CANCELLED: 'text-[#bb0000]',
};

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.success) {
    throw new Error(body.error || body.message || `خطای درخواست (${response.status})`);
  }
  return body.data as T;
}

export const RelationalPlanProposalView: React.FC<{ onReleased?: () => Promise<void> }> = ({ onReleased }) => {
  const { route, navigate, traceDocument, pushSelectionStep } = useErpRouter();
  const { requestConfirm } = useEnterpriseUx();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    type: 'success' | 'error';
    text: string;
    mos?: Array<{ id?: string; moNumber: string; partName?: string }>;
  } | null>(null);

  const [machineChoices, setMachineChoices] = useState<Record<string, string>>({});
  const [shiftChoices, setShiftChoices] = useState<Record<string, string>>({});
  const [opDateChoices, setOpDateChoices] = useState<Record<string, { start: string; end: string }>>({});
  const [lineEdits, setLineEdits] = useState<Record<string, { plannedQty: number; startDate: string; endDate: string }>>({});
  const [revisionNote, setRevisionNote] = useState('اصلاح دستی تیراژ، تاریخ یا تخصیص ماشین و شیفت');

  const hydrateDetailChoices = useCallback((selected: any) => {
    const mChoices: Record<string, string> = {};
    const sChoices: Record<string, string> = {};
    const dChoices: Record<string, { start: string; end: string }> = {};
    const lEdits: Record<string, { plannedQty: number; startDate: string; endDate: string }> = {};

    for (const line of selected?.lines || []) {
      const lStart = String(line.plannedStartDate || '').slice(0, 10);
      const lEnd = String(line.plannedEndDate || '').slice(0, 10);
      lEdits[line.id] = {
        plannedQty: Number(line.plannedQty || 0),
        startDate: lStart,
        endDate: lEnd,
      };
      for (const assignment of line.operationAssignments || []) {
        const key = `${line.id}:${assignment.routeOperationId}`;
        mChoices[key] = assignment.machineId || '';
        sChoices[key] = assignment.shiftId || '';
        dChoices[key] = {
          start: String(assignment.plannedStartDate || lStart).slice(0, 10),
          end: String(assignment.plannedEndDate || lEnd).slice(0, 10),
        };
      }
    }

    setMachineChoices(mChoices);
    setShiftChoices(sChoices);
    setOpDateChoices(dChoices);
    setLineEdits(lEdits);
  }, []);

  const load = useCallback(async (preferredId?: string | null) => {
    setLoading(true);
    try {
      const rows = await api<Proposal[]>('/api/planning/proposals');
      setProposals(rows || []);
      const queryMatch = route.docQuery
        ? rows?.find(r => r.proposalNumber === route.docQuery || r.id === route.docQuery)
        : undefined;
      const nextId = preferredId || queryMatch?.id || selectedId || rows?.[0]?.id || null;
      setSelectedId(nextId);
      if (nextId) {
        const selected = await api<any>(`/api/planning/proposals/${nextId}`);
        setDetail(selected);
        hydrateDetailChoices(selected);
      } else {
        setDetail(null);
      }
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'خطا در دریافت پیشنهادها' });
    } finally {
      setLoading(false);
    }
  }, [selectedId, route.docQuery, hydrateDetailChoices]);

  useEffect(() => {
    void load(null);
  }, [route.docQuery]);

  const machines = useMemo(() => {
    const list = detail?.inputSnapshot?.masterData?.machines || [];
    return new Map<string, any>(list.map((machine: any) => [machine.id, machine]));
  }, [detail]);

  const shifts = useMemo(() => {
    const list = detail?.inputSnapshot?.masterData?.shifts || [];
    return Array.isArray(list) ? list : [];
  }, [detail]);

  const requirementsByPart = useMemo(() => {
    const reqs = detail?.inputSnapshot?.requirements || [];
    return new Map<string, any>(reqs.map((r: any) => [r.partId, r]));
  }, [detail]);

  const selectProposal = async (id: string) => {
    if (selectedId && selectedId !== id) {
      const prevId = selectedId;
      const matched = proposals.find(p => p.id === id);
      pushSelectionStep(
        `پیشنهاد ${matched?.proposalNumber || id}`,
        () => {
          void selectProposal(prevId);
        },
        `planning-proposal-${id}`,
      );
    }
    setSelectedId(id);
    setMessage(null);
    try {
      const selected = await api<any>(`/api/planning/proposals/${id}`);
      setDetail(selected);
      hydrateDetailChoices(selected);
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'خطا در دریافت جزئیات' });
    }
  };

  const runAction = async (action: () => Promise<any>, successText: string, released = false) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await action();
      const preferredId = result?.id || result?.proposal?.id || selectedId;
      await load(preferredId);
      const releasedMos = Array.isArray(result?.manufacturingOrders)
        ? result.manufacturingOrders.map((m: any) => ({ id: m.id, moNumber: m.moNumber, partName: m.partName }))
        : undefined;
      setMessage({ type: 'success', text: successText, mos: releasedMos });
      if (released && onReleased) await onReleased();
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'عملیات ناموفق بود' });
    } finally {
      setBusy(false);
    }
  };

  const regenerate = () => {
    requestConfirm({
      title: 'تولید پیشنهاد جدید برنامه از داده‌های جاری',
      message: 'آیا مطمئن هستید که می‌خواهید پیشنهاد برنامه تولید جدید بر اساس سفارشات باز، موجودی انبار، BOM، WIP و ظرفیت ماشین‌آلات ساخته شود؟',
      confirmLabel: 'تأیید و ساخت پیش‌نویس جدید',
      variant: 'warning',
      onConfirm: () =>
        runAction(
          () => api('/api/planning/proposals/regenerate', { method: 'POST', body: JSON.stringify({}) }),
          'پیش‌نویس پیشنهاد جدید ساخته شد (بدون اعمال خودکار در خط تولید).',
        ),
    });
  };

  const revise = () => {
    if (!detail) return;
    const changes = (detail.lines || []).map((line: any) => {
      const lEdit = lineEdits[line.id];
      return {
        proposalLineId: line.id,
        plannedQty: lEdit?.plannedQty,
        plannedStartDate: lEdit?.startDate,
        plannedEndDate: lEdit?.endDate,
        operationAssignments: (line.operationAssignments || []).map((assignment: any) => {
          const key = `${line.id}:${assignment.routeOperationId}`;
          const dEdit = opDateChoices[key];
          return {
            routeOperationId: assignment.routeOperationId,
            machineId: machineChoices[key] ?? assignment.machineId ?? null,
            shiftId: shiftChoices[key] ?? assignment.shiftId ?? null,
            plannedStartDate: dEdit?.start || assignment.plannedStartDate,
            plannedEndDate: dEdit?.end || assignment.plannedEndDate,
          };
        }),
      };
    });
    return runAction(
      () =>
        api(`/api/planning/proposals/${detail.id}/revise`, {
          method: 'POST',
          body: JSON.stringify({ note: revisionNote, changes }),
        }),
      'نسخه اصلاح‌شده به‌عنوان پیش‌نویس جدید ذخیره شد؛ نسخه قبلی به‌عنوان سابقه حفظ شد.',
    );
  };

  const approve = () => {
    if (!detail) return;
    requestConfirm({
      title: `تأیید پیشنهاد برنامه ${detail.proposalNumber}`,
      message: `آیا تأیید پیشنهاد ${detail.proposalNumber} (نسخه ${toPersianDigits(detail.version)}) بدون صدور فوری MO را تأیید می‌کنید؟`,
      confirmLabel: 'تأیید پیشنهاد',
      variant: 'emerald',
      onConfirm: () =>
        runAction(
          () =>
            api(`/api/planning/proposals/${detail.id}/approve`, {
              method: 'POST',
              body: JSON.stringify({ approvedBy: 'مدیر برنامه‌ریزی تولید' }),
            }),
          'پیشنهاد با موفقیت تأیید شد.',
        ),
    });
  };

  const release = () => {
    if (!detail) return;
    requestConfirm({
      title: `صدور دستورهای تولید (MO) از پیشنهاد ${detail.proposalNumber}`,
      message: `آیا تبدیل ردیف‌های تأییدشده پیشنهاد ${detail.proposalNumber} به دستورهای کار واقعی و تخصیص شیفت ماشین‌آلات را تأیید می‌کنید؟`,
      confirmLabel: 'تأیید و صدور MO',
      variant: 'indigo',
      onConfirm: () =>
        runAction(
          () =>
            api(`/api/planning/proposals/${detail.id}/release`, {
              method: 'POST',
              body: JSON.stringify({ releasedBy: 'سرپرست برنامه‌ریزی' }),
            }),
          'برنامه تولید، دستورهای ساخت و تخصیص شیفت ماشین‌آلات به‌صورت تراکنشی ثبت شدند.',
          true,
        ),
    });
  };

  const approveAndRelease = () => {
    if (!detail) return;
    requestConfirm({
      title: `تأیید و صدور فوری MO — ${detail.proposalNumber}`,
      message: `با تأیید این عملیات، پیشنهاد ${detail.proposalNumber} نهایی شده و کلیه دستورهای تولید (MO) و نوبت‌دهی ماشین‌آلات وارد کارتابل کارگاه می‌شوند.`,
      confirmLabel: 'تأیید نهایی و صدور به کارگاه',
      variant: 'emerald',
      onConfirm: () =>
        runAction(
          () =>
            api(`/api/planning/proposals/${detail.id}/approve-and-release`, {
              method: 'POST',
              body: JSON.stringify({ actor: 'مدیر برنامه‌ریزی تولید' }),
            }),
          'پیشنهاد تأیید و دستورهای کار (MO) به کارتابل WIP و تقویم ماشین‌آلات صادر شدند.',
          true,
        ),
    });
  };

  const conflictOpsCount = useMemo(() => {
    if (!detail?.lines) return 0;
    return detail.lines.reduce(
      (sum: number, l: any) => sum + (l.operationAssignments || []).filter((a: any) => a.hasCapacityConflict).length,
      0,
    );
  }, [detail]);

  return (
    <div className="space-y-4" dir="rtl">
      <section className="sap-card p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-[#333333]">میز کار پیشنهادهای برنامه تولید (MRP · BOM · تخصیص پرس)</h2>
            <p className="mt-1 text-xs text-[#666666]">
              پیشنهادها به‌صورت پیش‌نویس تولید می‌شوند و تا پیش از بازبینی و تأیید برنامه‌ریز هیچ دستور کاری به صورت خودکار صادر نمی‌شود.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void load(selectedId)}
              disabled={loading || busy}
              className="sap-btn-standard px-3 py-1.5 text-xs font-semibold disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className="ml-1 inline h-3.5 w-3.5" />بروزرسانی
            </button>
            <button
              type="button"
              onClick={regenerate}
              disabled={loading || busy}
              className="sap-btn-emphasized px-3 py-1.5 text-xs font-semibold disabled:opacity-50 cursor-pointer"
            >
              <Wand2 className="ml-1 inline h-3.5 w-3.5" />تولید پیش‌نویس از اطلاعات جاری
            </button>
          </div>
        </div>
        {message && (
          <div className={`rounded border p-3 text-xs space-y-2 ${message.type === 'error' ? 'border-[#f5b8b8] bg-[#fde8e8] text-[#bb0000]' : 'border-[#b7dfc5] bg-[#eef8f2] text-[#107e3e]'}`}>
            <div>{message.text}</div>
            {message.mos && message.mos.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="font-semibold">دستور کارهای صادرشده:</span>
                {message.mos.map(m => (
                  <button
                    key={m.moNumber}
                    type="button"
                    onClick={() => navigate({ tab: 'wip', wipSubTab: 'ORDERS', docQuery: m.moNumber, moId: m.id || null })}
                    className="px-2.5 py-1 rounded bg-white border border-[#b7dfc5] text-[#007cc0] font-mono font-bold hover:bg-[#e5f3fa] cursor-pointer inline-flex items-center gap-1"
                  >
                    <span>{m.moNumber}</span>
                    <ExternalLink className="w-3 h-3" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[290px_minmax(0,1fr)]">
        <aside className="sap-card p-3">
          <div className="mb-2 flex items-center justify-between border-b border-[#e8e8e8] pb-2">
            <h3 className="text-xs font-bold text-[#333333]">سوابق پیشنهادها</h3>
            <span className="text-[11px] font-mono tabular-nums text-[#666666]">{toPersianDigits(proposals.length)} مورد</span>
          </div>
          <div className="space-y-2">
            {proposals.map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => void selectProposal(item.id)}
                className={`w-full rounded border p-3 text-right transition cursor-pointer ${
                  selectedId === item.id ? 'border-[#007cc0] bg-[#e5f3fa]' : 'border-[#d9d9d9] bg-white hover:border-[#007cc0]/50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-[#333333] font-mono">{item.proposalNumber}</span>
                  <span className="text-[11px] font-mono tabular-nums text-[#666666]">نسخه {toPersianDigits(item.version)}</span>
                </div>
                <div className="mt-1 flex items-center justify-between text-[11px]">
                  <span className={`font-semibold ${statusColors[item.status] || 'text-[#333333]'}`}>
                    {statusLabels[item.status] || item.status}
                  </span>
                  <span className="font-mono tabular-nums text-[#666666]">{formatToJalali(item.generatedAt)}</span>
                </div>
                <div className="mt-1.5 text-[10px] text-[#666666] font-mono tabular-nums">
                  {toPersianDigits(item.lines?.length || 0)} ردیف برنامه
                </div>
              </button>
            ))}
            {!loading && proposals.length === 0 && (
              <p className="rounded bg-[#f5f5f5] p-4 text-center text-xs text-[#666666]">هنوز پیشنهادی ساخته نشده است.</p>
            )}
          </div>
        </aside>

        <main className="min-w-0 space-y-3">
          {!detail ? (
            <div className="sap-card border-dashed p-10 text-center text-xs text-[#666666]">
              برای مشاهده جزئیات، یک پیشنهاد انتخاب کنید یا پیش‌نویس جدید بسازید.
            </div>
          ) : (
            <>
              <section className="sap-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap text-xs">
                      <h3 className="text-sm font-bold text-[#333333] font-mono">{detail.proposalNumber}</h3>
                      <span className="text-[#666666]">·</span>
                      <span className="font-mono text-[#333333]">نسخه {toPersianDigits(detail.version)}</span>
                      <span className="text-[#666666]">·</span>
                      <span className={`font-bold ${statusColors[detail.status] || 'text-[#007cc0]'}`}>
                        {statusLabels[detail.status] || detail.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-[#666666]">{detail.notes || 'بدون توضیحات'}</p>
                  </div>
                  {detail.productionPlan && (
                    <div className="text-xs text-[#107e3e] flex items-center gap-1.5">
                      <span>برنامه صادرشده:</span>
                      <button
                        type="button"
                        onClick={() => traceDocument(detail.productionPlan.planNumber, 'WIP_TRACEABILITY')}
                        className="sap-doc-link font-mono"
                      >
                        {detail.productionPlan.planNumber}
                      </button>
                    </div>
                  )}
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
                  {[
                    ['ردیف تولید', detail.lines?.length || 0],
                    ['جمع تیراژ برنامه', (detail.lines || []).reduce((sum: number, line: any) => sum + Number(line.plannedQty || 0), 0)],
                    ['دارای هشدار / کسری', (detail.lines || []).filter((line: any) => (line.warnings || []).length).length],
                    ['تداخل ظرفیت عملیات', conflictOpsCount],
                  ].map(([label, value]) => (
                    <div key={String(label)} className="rounded border border-[#e8e8e8] bg-[#fafafa] p-3 text-center">
                      <div className="text-[11px] text-[#666666]">{label}</div>
                      <div className="mt-1 text-sm font-bold text-[#333333] font-mono tabular-nums">{formatNumber(Number(value))}</div>
                    </div>
                  ))}
                </div>
              </section>

              {(detail.lines || []).map((line: any) => {
                const reqSnapshot = requirementsByPart.get(line.partId);
                const exploded = Array.isArray(reqSnapshot?.explodedComponents) ? reqSnapshot.explodedComponents : [];
                const lEdit = lineEdits[line.id] || {
                  plannedQty: Number(line.plannedQty || 0),
                  startDate: String(line.plannedStartDate || '').slice(0, 10),
                  endDate: String(line.plannedEndDate || '').slice(0, 10),
                };

                return (
                  <section key={line.id} className="sap-card p-4 space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#e8e8e8] pb-3">
                      <div className="space-y-1">
                        <div className="text-sm font-bold text-[#333333] flex items-center gap-1.5 flex-wrap">
                          <span>{line.part?.name || 'قطعه'}</span>
                          {line.part?.partNumber && (
                            <button
                              type="button"
                              onClick={() => traceDocument(line.part.partNumber, 'INVENTORY_LEDGER')}
                              className="sap-doc-link font-mono text-xs"
                            >
                              {line.part.partNumber}
                            </button>
                          )}
                        </div>
                        <div className="text-xs text-[#666666] flex items-center gap-1.5 flex-wrap">
                          <span>سفارش:</span>
                          {line.customerOrderLine?.order?.orderNumber ? (
                            <button
                              type="button"
                              onClick={() => traceDocument(line.customerOrderLine.order.orderNumber, 'WIP_TRACEABILITY')}
                              className="sap-doc-link font-mono"
                            >
                              {line.customerOrderLine.order.orderNumber}
                            </button>
                          ) : (
                            <span>—</span>
                          )}
                          <span>· ردیف {toPersianDigits(line.customerOrderLine?.lineNumber || 0)}</span>
                          <span>· اولویت {toPersianDigits(line.priority || 2)}</span>
                          {reqSnapshot && (
                            <>
                              <span>· تقاضای باز: <strong className="font-mono tabular-nums">{formatNumber(reqSnapshot.grossDemandQty ?? line.requestedQty)}</strong></span>
                              <span>· محصول آزاد: <strong className="font-mono tabular-nums">{formatNumber(reqSnapshot.availableFinishedGoodsQty ?? 0)}</strong></span>
                              <span>· WIP: <strong className="font-mono tabular-nums">{formatNumber(reqSnapshot.downstreamWipQty ?? 0)}</strong></span>
                            </>
                          )}
                        </div>
                      </div>

                      {detail.status === 'DRAFT' ? (
                        <div className="flex flex-wrap items-end gap-2 text-xs">
                          <label className="flex flex-col gap-1">
                            <span className="text-[10px] text-[#666666]">تیراژ برنامه‌ریزی (عدد)</span>
                            <input
                              type="number"
                              min={1}
                              value={lEdit.plannedQty}
                              onChange={e =>
                                setLineEdits(prev => ({
                                  ...prev,
                                  [line.id]: { ...lEdit, plannedQty: Math.max(1, Number(e.target.value) || 1) },
                                }))
                              }
                              className="w-28 rounded border border-[#bfbfbf] bg-white px-2 py-1 text-xs font-mono tabular-nums text-[#333333] focus:outline-none focus:border-[#007cc0]"
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-[10px] text-[#666666]">تاریخ شروع</span>
                            <input
                              type="date"
                              value={lEdit.startDate}
                              onChange={e =>
                                setLineEdits(prev => ({
                                  ...prev,
                                  [line.id]: { ...lEdit, startDate: e.target.value },
                                }))
                              }
                              className="rounded border border-[#bfbfbf] bg-white px-2 py-1 text-xs font-mono text-[#333333] focus:outline-none focus:border-[#007cc0]"
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-[10px] text-[#666666]">موعد پایان</span>
                            <input
                              type="date"
                              value={lEdit.endDate}
                              onChange={e =>
                                setLineEdits(prev => ({
                                  ...prev,
                                  [line.id]: { ...lEdit, endDate: e.target.value },
                                }))
                              }
                              className="rounded border border-[#bfbfbf] bg-white px-2 py-1 text-xs font-mono text-[#333333] focus:outline-none focus:border-[#007cc0]"
                            />
                          </label>
                        </div>
                      ) : (
                        <div className="text-left text-xs">
                          <div className="font-bold text-[#333333] font-mono tabular-nums">{formatNumber(Number(line.plannedQty))} عدد</div>
                          <div className="mt-1 text-[#666666] font-mono tabular-nums">
                            {formatToJalali(line.plannedStartDate)} تا {formatToJalali(line.plannedEndDate)}
                          </div>
                        </div>
                      )}
                    </div>

                    {exploded.length > 0 && (
                      <div className="rounded border border-[#e8e8e8] bg-[#fafafa] p-2.5 space-y-1.5">
                        <div className="text-[11px] font-bold text-[#333333]">انفجار درخت مواد (BOM Explosion) و وضعیت تأمین</div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-[11px] text-right">
                            <thead className="text-[#666666] border-b border-[#e8e8e8]">
                              <tr>
                                <th className="py-1 px-2">کد / نام قلم</th>
                                <th className="py-1 px-2">سطح</th>
                                <th className="py-1 px-2">نیاز ناخالص</th>
                                <th className="py-1 px-2">WIP</th>
                                <th className="py-1 px-2">موجودی آزاد</th>
                                <th className="py-1 px-2">کسری</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-[#eeeeee]">
                              {exploded.map((c: any, idx: number) => (
                                <tr key={`${c.partCode}-${idx}`}>
                                  <td className="py-1 px-2 font-mono">{c.partCode} — {c.partName}</td>
                                  <td className="py-1 px-2 font-mono tabular-nums">L{toPersianDigits(c.level)}</td>
                                  <td className="py-1 px-2 font-mono tabular-nums">{formatNumber(c.grossRequiredQty)} {c.unitCode}</td>
                                  <td className="py-1 px-2 font-mono tabular-nums">{formatNumber(c.wipCreditedQty)}</td>
                                  <td className="py-1 px-2 font-mono tabular-nums">{formatNumber(c.availableQty)}</td>
                                  <td className={`py-1 px-2 font-mono tabular-nums font-bold ${c.hasShortage ? 'text-[#bb0000]' : 'text-[#107e3e]'}`}>
                                    {c.hasShortage ? `${formatNumber(c.shortageQty)} ${c.unitCode}` : 'تأمین'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {(line.warnings || []).length > 0 && (
                      <div className="rounded border border-[#f5d0a9] bg-[#fff5eb] p-2.5 text-xs text-[#e9730c]">
                        <AlertTriangle className="ml-1 inline h-3.5 w-3.5" />
                        {line.warnings.join(' · ')}
                      </div>
                    )}

                    <div className="space-y-2">
                      <div className="text-[11px] font-bold text-[#666666]">تخصیص ماشین، شیفت و بازه زمانی عملیات مسیر</div>
                      {(line.operationAssignments || []).map((assignment: any) => {
                        const key = `${line.id}:${assignment.routeOperationId}`;
                        const eligible = (assignment.eligibleMachineIds || []).map((id: string) => machines.get(id)).filter(Boolean) as any[];
                        const dChoice = opDateChoices[key] || {
                          start: String(assignment.plannedStartDate || lEdit.startDate).slice(0, 10),
                          end: String(assignment.plannedEndDate || lEdit.endDate).slice(0, 10),
                        };

                        return (
                          <div
                            key={key}
                            className={`rounded border p-2.5 space-y-2 ${
                              assignment.hasCapacityConflict ? 'border-[#f5b8b8] bg-[#fde8e8]/35' : 'border-[#e8e8e8] bg-[#fafafa]'
                            }`}
                          >
                            <div className="grid grid-cols-1 items-center gap-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(190px,1fr)_minmax(140px,0.8fr)_auto]">
                              <div>
                                <div className="text-xs font-semibold text-[#333333]">
                                  {toPersianDigits(assignment.stepNumber)} · <span className="font-mono">{assignment.stepCode}</span> — {assignment.stepName}
                                </div>
                                <div className="mt-0.5 text-[10px] text-[#666666] font-mono tabular-nums">
                                  {assignment.dieCode ? `قالب: ${assignment.dieCode}` : assignment.dieId ? 'قالب مشخص‌شده در مسیر' : 'بدون قالب'}
                                  {assignment.requiredTonnage ? ` · نیاز: ${formatNumber(assignment.requiredTonnage)} تن` : ''}
                                  {assignment.estimatedHours ? ` · برآورد زمان: ${toPersianDigits(assignment.estimatedHours)} ساعت` : ''}
                                </div>
                              </div>

                              <select
                                value={machineChoices[key] ?? assignment.machineId ?? ''}
                                disabled={detail.status !== 'DRAFT' || eligible.length === 0}
                                onChange={event => setMachineChoices(prev => ({ ...prev, [key]: event.target.value }))}
                                aria-label={`انتخاب ماشین برای ${assignment.stepCode}`}
                                className="w-full rounded border border-[#bfbfbf] bg-white px-2 py-1.5 text-xs text-[#333333] focus:outline-none focus:border-[#007cc0] disabled:opacity-60"
                              >
                                <option value="">بدون تخصیص ماشین</option>
                                {eligible.map((machine: any) => (
                                  <option key={machine.id} value={machine.id}>
                                    {machine.code} — {machine.name} ({formatNumber(Number(machine.tonnageCapacity || 0))} تن · اشغال {toPersianDigits(machine.utilizationPercent ?? 0)}٪)
                                  </option>
                                ))}
                              </select>

                              <select
                                value={shiftChoices[key] ?? assignment.shiftId ?? ''}
                                disabled={detail.status !== 'DRAFT' || shifts.length === 0}
                                onChange={event => setShiftChoices(prev => ({ ...prev, [key]: event.target.value }))}
                                aria-label={`انتخاب شیفت برای ${assignment.stepCode}`}
                                className="w-full rounded border border-[#bfbfbf] bg-white px-2 py-1.5 text-xs text-[#333333] focus:outline-none focus:border-[#007cc0] disabled:opacity-60"
                              >
                                {shifts.length === 0 ? (
                                  <option value="">شیفت پیش‌فرض</option>
                                ) : (
                                  shifts.map((sh: any) => (
                                    <option key={sh.id} value={sh.id}>
                                      {sh.name} ({sh.startTime}-{sh.endTime})
                                    </option>
                                  ))
                                )}
                              </select>

                              <div className="flex items-center gap-1 text-[11px] font-mono">
                                <input
                                  type="date"
                                  disabled={detail.status !== 'DRAFT'}
                                  value={dChoice.start}
                                  onChange={e =>
                                    setOpDateChoices(prev => ({
                                      ...prev,
                                      [key]: { ...dChoice, start: e.target.value },
                                    }))
                                  }
                                  className="rounded border border-[#bfbfbf] bg-white px-1.5 py-1 text-[11px] text-[#333333] disabled:opacity-60"
                                />
                                <span className="text-[#666666]">تا</span>
                                <input
                                  type="date"
                                  disabled={detail.status !== 'DRAFT'}
                                  value={dChoice.end}
                                  onChange={e =>
                                    setOpDateChoices(prev => ({
                                      ...prev,
                                      [key]: { ...dChoice, end: e.target.value },
                                    }))
                                  }
                                  className="rounded border border-[#bfbfbf] bg-white px-1.5 py-1 text-[11px] text-[#333333] disabled:opacity-60"
                                />
                              </div>
                            </div>

                            {assignment.hasCapacityConflict && assignment.conflictMessage && (
                              <div className="text-[11px] text-[#bb0000] font-semibold flex items-center gap-1">
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                <span>{assignment.conflictMessage}</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })}

              <section className="flex flex-wrap items-center justify-between gap-2 sap-card p-4">
                {detail.status === 'DRAFT' ? (
                  <>
                    <input
                      value={revisionNote}
                      onChange={event => setRevisionNote(event.target.value)}
                      className="min-w-[200px] flex-1 rounded border border-[#bfbfbf] bg-white px-3 py-1.5 text-xs text-[#333333] focus:outline-none focus:border-[#007cc0]"
                      aria-label="توضیح بازنگری"
                    />
                    <button
                      type="button"
                      onClick={revise}
                      disabled={busy}
                      className="sap-btn-standard px-3 py-1.5 text-xs font-semibold disabled:opacity-50 cursor-pointer"
                    >
                      <Save className="ml-1 inline h-3.5 w-3.5" />ذخیره بازنگری به‌عنوان نسخه جدید
                    </button>
                    <button
                      type="button"
                      onClick={approve}
                      disabled={busy}
                      className="sap-btn-standard px-3 py-1.5 text-xs font-semibold text-[#107e3e] border-[#107e3e] disabled:opacity-50 cursor-pointer"
                    >
                      <CheckCircle2 className="ml-1 inline h-3.5 w-3.5" />فقط تأیید پیشنهاد
                    </button>
                    <button
                      type="button"
                      onClick={approveAndRelease}
                      disabled={busy}
                      className="rounded bg-[#107e3e] hover:bg-[#0c6631] px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50 cursor-pointer"
                    >
                      <Send className="ml-1 inline h-3.5 w-3.5" />تأیید و صدور دستور کار (MO)
                    </button>
                  </>
                ) : detail.status === 'APPROVED' ? (
                  <button
                    type="button"
                    onClick={release}
                    disabled={busy}
                    className="sap-btn-emphasized px-4 py-1.5 text-xs font-semibold disabled:opacity-50 cursor-pointer"
                  >
                    <Send className="ml-1 inline h-3.5 w-3.5" />صدور دستورهای تولید (MO)
                  </button>
                ) : (
                  <div className="flex items-center justify-between w-full gap-2 flex-wrap">
                    <p className="text-xs text-[#666666]">
                      {detail.status === 'RELEASED'
                        ? 'این پیشنهاد تأیید و به برنامه تولید، دستور کار (MO) و تخصیص شیفت ماشین‌آلات تبدیل شده است.'
                        : 'برای این پیشنهاد اقدام دیگری در دسترس نیست.'}
                    </p>
                    {detail.productionPlan && (
                      <button
                        type="button"
                        onClick={() => navigate({ tab: 'wip', wipSubTab: 'ORDERS', docQuery: detail.productionPlan.planNumber })}
                        className="sap-btn-standard px-3 py-1.5 text-xs font-semibold text-[#007cc0] cursor-pointer flex items-center gap-1"
                      >
                        <span>مشاهده دستور کارها در WIP</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                )}
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
};
