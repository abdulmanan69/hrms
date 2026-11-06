import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, ExternalLink, FileDown, Landmark, Pencil, RotateCcw, RefreshCw, Trash2, X } from 'lucide-react';
import { B_COMPONENTS, payrollApi, type Payslip, type PayslipLine, type Run, type Skipped } from '../../api/payroll';
import {
  ConfirmModal,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  ICON,
  Loading,
  Modal,
  PageHeader,
  SearchInput,
  SipId,
  StatusTag,
  Tag,
  toast,
} from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { dateTime, days, money, month } from '../../lib/format';
import { Ledger, MoneyInput, SkippedList, type LedgerSection } from './shared';

type Action = 'approve' | 'pay' | 'reopen' | 'delete';

const CONFIRM: Record<Action, { title: string; label: string; body: (m: string) => string; danger?: boolean }> = {
  approve: {
    title: 'Approve run',
    label: 'Approve',
    body: (m) => `Approving locks every ${m} payslip and writes the loan deductions to each employee's ledger.`,
  },
  pay: {
    title: 'Mark as paid',
    label: 'Mark as paid',
    body: (m) => `Employees are told their ${m} payslip is ready. A paid run cannot be reopened.`,
  },
  reopen: {
    title: 'Reopen run',
    label: 'Reopen',
    body: (m) => `The ${m} run goes back to draft and its loan deductions are removed from the ledgers.`,
  },
  delete: {
    title: 'Delete draft run',
    label: 'Delete draft',
    body: (m) => `Every ${m} payslip, including manual additions and deductions, is removed.`,
    danger: true,
  },
};

export function PayrollRunDetail() {
  const { id } = useParams();
  const runId = Number(id);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [openSlip, setOpenSlip] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [recomputed, setRecomputed] = useState<{ skipped: Skipped[]; removed: Skipped[] } | null>(null);

  const q = useQuery({ queryKey: ['payroll', 'run', runId], queryFn: () => payrollApi.run(runId), enabled: Number.isFinite(runId) });

  const recompute = useMutation({
    mutationFn: () => payrollApi.recompute(runId),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['payroll'] });
      toast('Run recomputed');
      if (res.skipped.length || res.removed.length) setRecomputed({ skipped: res.skipped, removed: res.removed });
    },
    onError: (e) => toast(e.message, 'bad'),
  });

  const act = useMutation({
    mutationFn: async (a: Action): Promise<Run | null> => {
      if (a === 'approve') return (await payrollApi.approve(runId)).run;
      if (a === 'pay') return (await payrollApi.pay(runId)).run;
      if (a === 'reopen') return (await payrollApi.reopen(runId)).run;
      await payrollApi.deleteRun(runId);
      return null;
    },
    onSuccess: (_r, a) => {
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: ['payroll'] });
      toast({ approve: 'Run approved', pay: 'Run marked as paid', reopen: 'Run reopened', delete: 'Draft run deleted' }[a]);
      if (a === 'delete') navigate('/payroll/runs');
    },
  });

  const rows = useMemo(() => {
    const all = q.data?.payslips ?? [];
    const t = search.trim().toLowerCase();
    return t ? all.filter((p) => p.name.toLowerCase().includes(t) || p.sipId.toLowerCase().includes(t)) : all;
  }, [q.data, search]);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState message={q.error.message} onRetry={() => q.refetch()} />;
  const { run, ledger, payslips } = q.data!;
  const label = month(run.periodMonth);
  const draft = run.status === 'draft';
  const negatives = payslips.filter((p) => p.netTotal < 0);
  const flagged = payslips.filter((p) => p.warnings.length > 0);

  const sections: LedgerSection[] = (['A', 'B', 'C'] as const).map((key) => {
    const l = ledger.find((x) => x.section === key)!;
    return {
      key,
      label: { A: 'Gross earned', B: 'Additions', C: 'Deductions' }[key],
      total: { A: run.totalA, B: run.totalB, C: run.totalC }[key],
      lines: l.lines.map((x) => ({ name: x.component, amount: x.amount })),
      empty: key === 'B' ? 'None yet. Open a payslip to add overtime, incentive or bonus' : undefined,
    };
  });

  const subtitle = [
    `${run.daysOfMonth} days, ${run.workingDays} working days`,
    run.paidAt ? `paid ${dateTime(run.paidAt)}` : run.approvedAt ? `approved ${dateTime(run.approvedAt)}` : `created ${dateTime(run.createdAt)}`,
  ].join(', ');

  return (
    <div>
      <PageHeader
        back={{ to: '/payroll/runs', label: 'Payroll runs' }}
        title={
          <span className="inline-flex items-center gap-3">
            {label} <StatusTag value={run.status} />
          </span>
        }
        subtitle={subtitle}
        actions={
          <>
            <a className="btn-secondary" href={payrollApi.exportUrl(runId)}>
              <Download {...ICON} className="text-ink-3" /> Export CSV
            </a>
            <a className="btn-secondary" href={payrollApi.runPdfUrl(runId)}>
              <FileDown {...ICON} className="text-ink-3" /> Payslips PDF
            </a>
            {!draft && can('payroll.approve') && (
              <a className="btn-secondary" href={payrollApi.bankUrl(runId)}>
                <Landmark {...ICON} className="text-ink-3" /> Bank file
              </a>
            )}
            {draft && can('payroll.manage') && (
              <>
                <button className="btn-secondary" onClick={() => setConfirm('delete')}>
                  <Trash2 {...ICON} className="text-ink-3" /> Delete draft
                </button>
                <button className="btn-secondary" disabled={recompute.isPending} onClick={() => recompute.mutate()}>
                  <RefreshCw {...ICON} className={`text-ink-3 ${recompute.isPending ? 'animate-spin' : ''}`} /> Recompute
                </button>
              </>
            )}
            {run.status === 'approved' && can('payroll.approve') && (
              <button className="btn-secondary" onClick={() => setConfirm('reopen')}>
                <RotateCcw {...ICON} className="text-ink-3" /> Reopen
              </button>
            )}
            {draft && can('payroll.approve') && (
              <button className="btn-primary" onClick={() => setConfirm('approve')} disabled={payslips.length === 0 || negatives.length > 0}>
                <Check {...ICON} /> Approve
              </button>
            )}
            {run.status === 'approved' && can('payroll.approve') && (
              <button className="btn-primary" onClick={() => setConfirm('pay')}>
                <Check {...ICON} /> Mark as paid
              </button>
            )}
          </>
        }
      />

      {negatives.length > 0 && (
        <p className="mb-6 rounded-lg bg-bad-soft px-4 py-3 text-sm text-bad">
          Net pay is negative for {negatives.map((n) => n.name).join(', ')}. Reduce their deductions before approving.
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="card min-w-0 overflow-hidden">
          <div className="card-head">
            <div className="flex items-baseline gap-2">
              <p className="card-title">Payslips</p>
              <span className="num text-xs text-ink-3">{payslips.length}</span>
            </div>
            <SearchInput value={search} onChange={setSearch} placeholder="Search name or SIP ID" className="w-full max-w-xs" />
          </div>
          {payslips.length === 0 ? (
            <EmptyState bare title="No payslips in this run" hint="Add salary structures for active employees, then recompute" />
          ) : rows.length === 0 ? (
            <EmptyState bare title="No one matches" hint="Try another name or SIP ID" />
          ) : (
            <div className="overflow-x-auto">
              <table className="table [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_td]:px-3 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5 [&_th]:px-3">
                <thead>
                  <tr>
                    <th className="th">Employee</th>
                    <th className="th text-right">Paid days</th>
                    <th className="th text-right">A</th>
                    <th className="th text-right">B</th>
                    <th className="th text-right">C</th>
                    <th className="th text-right">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id} className="row-link" onClick={() => setOpenSlip(p.id)}>
                      <td className="td">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{p.name}</span>
                          <SipId id={p.sipId} />
                        </div>
                        <p className="mt-0.5 flex gap-2 text-xs text-ink-3">
                          <span>{p.departmentName ?? 'No department'}</span>
                          {p.hasIncrement && <span>Increment this month</span>}
                          {p.notJoinedDays > 0 && <span>Joined mid-month</span>}
                        </p>
                      </td>
                      <td className="td num text-right">
                        {days(p.paidDays)}
                        <span className="text-ink-3">/{run.daysOfMonth}</span>
                        {p.unpaidDays > 0 && <span className="block text-xs text-warn">{days(p.unpaidDays)} unpaid</span>}
                      </td>
                      <td className="td num text-right">{money(p.grossA)}</td>
                      <td className="td num text-right text-ink-2">{money(p.totalAdditionsB)}</td>
                      <td className="td num text-right text-ink-2">{money(p.totalDeductionsC)}</td>
                      <td className={`td num text-right font-medium ${p.netTotal < 0 ? 'text-bad' : ''}`}>{money(p.netTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="card">
            <div className="card-head">
              <p className="card-title">{label} run</p>
              <span className="num text-xs text-ink-3">{payslips.length} payslips</span>
            </div>
            <div className="px-5 pb-4">
              <Ledger sections={sections} net={run.totalNet} />
            </div>
          </div>
          {flagged.length > 0 && (
            <div className="card">
              <div className="card-head">
                <p className="card-title">Check before approving</p>
              </div>
              <ul className="divide-y divide-line border-t border-line">
                {flagged.map((p) => (
                  <li key={p.id}>
                    <button className="w-full px-5 py-3 text-left transition-colors hover:bg-bg" onClick={() => setOpenSlip(p.id)}>
                      <span className="flex items-center gap-2 text-sm">
                        {p.name} <SipId id={p.sipId} />
                      </span>
                      {p.warnings.map((w) => (
                        <p key={w} className="mt-0.5 text-xs text-ink-3">
                          {w}
                        </p>
                      ))}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {openSlip !== null && <PayslipEditor id={openSlip} editable={draft && can('payroll.manage')} onClose={() => setOpenSlip(null)} />}

      {confirm && (
        <ConfirmModal
          open
          title={CONFIRM[confirm].title}
          confirmLabel={CONFIRM[confirm].label}
          danger={CONFIRM[confirm].danger}
          busy={act.isPending}
          body={CONFIRM[confirm].body(label)}
          onConfirm={() => act.mutate(confirm)}
          onClose={() => {
            setConfirm(null);
            act.reset();
          }}
        >
          <div className="mt-3">
            <FormError message={act.error?.message} />
          </div>
        </ConfirmModal>
      )}

      {recomputed && (
        <Modal open title="Run recomputed" onClose={() => setRecomputed(null)}>
          <p className="text-sm text-ink-2">Manual additions and deductions were kept.</p>
          <SkippedList skipped={recomputed.removed} title="Removed from the run" />
          <SkippedList skipped={recomputed.skipped} title="Not included" />
        </Modal>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One payslip, with manual B and C lines while the run is a draft     */
/* ------------------------------------------------------------------ */

function PayslipEditor({ id, editable, onClose }: { id: number; editable: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['payroll', 'payslip', id], queryFn: () => payrollApi.payslip(id) });
  const [adding, setAdding] = useState<'B' | 'C' | null>(null);
  const [editing, setEditing] = useState<PayslipLine | null>(null);

  const done = (p: Payslip) => {
    qc.setQueryData(['payroll', 'payslip', id], p);
    void qc.invalidateQueries({ queryKey: ['payroll', 'run'] });
    void qc.invalidateQueries({ queryKey: ['payroll', 'runs'] });
  };
  const remove = useMutation({
    mutationFn: (lineId: number) => payrollApi.removeLine(id, lineId),
    onSuccess: (p) => {
      done(p);
      toast('Line removed');
    },
    onError: (e) => toast(e.message, 'bad'),
  });

  const p = q.data;
  const lineItems = (section: 'A' | 'B' | 'C') =>
    (p?.lines ?? [])
      .filter((l) => l.section === section)
      .map((l) => ({
        key: l.id,
        name: (
          <span className="inline-flex items-center gap-2">
            {l.component}
            {l.isManual && section === 'C' && <span className="text-ink-3">manual</span>}
          </span>
        ),
        amount: l.amount,
        action:
          editable && l.isManual ? (
            <span className="flex">
              <button className="icon-btn h-6 w-6" aria-label={`Edit ${l.component}`} title="Edit" onClick={() => setEditing(l)}>
                <Pencil size={14} strokeWidth={1.5} />
              </button>
              <button className="icon-btn h-6 w-6" aria-label={`Remove ${l.component}`} title="Remove" onClick={() => remove.mutate(l.id)}>
                <X size={14} strokeWidth={1.5} />
              </button>
            </span>
          ) : undefined,
      }));

  return (
    <Modal open wide title={p ? `${p.name}, ${month(p.periodMonth)}` : 'Payslip'} onClose={onClose}>
      {q.isLoading ? (
        <Loading inline />
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
      ) : (
        p && (
          <div className="grid gap-6 md:grid-cols-5">
            <div className="md:col-span-3">
              <Ledger
                sections={[
                  { key: 'A', label: 'Gross earned', total: p.grossA, lines: lineItems('A') },
                  { key: 'B', label: 'Additions', total: p.totalAdditionsB, lines: lineItems('B'), empty: 'No additions' },
                  { key: 'C', label: 'Deductions', total: p.totalDeductionsC, lines: lineItems('C'), empty: 'No deductions' },
                ]}
                net={p.netTotal}
              />
              {editable && (
                <div className="mt-4 flex gap-2">
                  <button className="btn-secondary btn-sm" onClick={() => setAdding('B')}>
                    Add addition
                  </button>
                  <button className="btn-secondary btn-sm" onClick={() => setAdding('C')}>
                    Add deduction
                  </button>
                </div>
              )}
            </div>
            <div className="space-y-4 md:col-span-2">
              <div className="flex items-center gap-2">
                <SipId id={p.sipId} to={`/employees/${p.sipId}`} />
                <span className="text-sm text-ink-2">{p.designationTitle ?? p.departmentName ?? ''}</span>
              </div>
              <dl className="space-y-2 text-sm">
                <Row label="Days in month" value={`${p.daysOfMonth}${p.basis === 'working' ? ' working' : ''}`} />
                <Row label="Paid days, current rate" value={days(p.currentSalaryDays)} />
                {p.periods.length > 1 && <Row label="Paid days, new rate" value={days(p.newSalaryDays)} />}
                {p.notJoinedDays > 0 && <Row label="Before joining" value={days(p.notJoinedDays)} />}
                {p.unpaidDays > 0 && <Row label="Unpaid leave" value={days(p.unpaidDays)} />}
              </dl>
              <div>
                <p className="mb-1.5 text-xs text-ink-3">Rate periods</p>
                <ul className="space-y-1 text-xs">
                  {p.periods.map((r) => (
                    <li key={r.from} className="flex justify-between gap-2">
                      <span className="text-ink-2">
                        {r.from.slice(8)}–{r.to.slice(8)} at <span className="num">{money(r.monthlyGross)}</span>
                      </span>
                      <span className="num text-ink-3">{days(r.paidDays)} days</span>
                    </li>
                  ))}
                </ul>
              </div>
              {p.warnings.map((w) => (
                <p key={w} className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
                  {w}
                </p>
              ))}
              <Link to={`/payroll/payslips/${p.id}`} className="btn-secondary btn-sm">
                <ExternalLink {...ICON} className="text-ink-3" /> Open payslip
              </Link>
              <a href={payrollApi.payslipPdfUrl(p.id)} className="btn-secondary btn-sm">
                <FileDown {...ICON} className="text-ink-3" /> PDF
              </a>
            </div>
          </div>
        )
      )}
      {adding && <LineModal payslipId={id} section={adding} onClose={() => setAdding(null)} onSaved={done} />}
      {editing && <LineModal payslipId={id} section={editing.section as 'B' | 'C'} line={editing} onClose={() => setEditing(null)} onSaved={done} />}
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-ink-3">{label}</dt>
      <dd className="num">{value}</dd>
    </div>
  );
}

function LineModal({
  payslipId,
  section,
  line,
  onClose,
  onSaved,
}: {
  payslipId: number;
  section: 'B' | 'C';
  line?: PayslipLine;
  onClose: () => void;
  onSaved: (p: Payslip) => void;
}) {
  const options = section === 'B' ? B_COMPONENTS : ['Other'];
  const initial = line?.component ?? options[0];
  const [choice, setChoice] = useState(options.includes(initial) ? initial : '__custom');
  const [custom, setCustom] = useState(options.includes(initial) ? '' : initial);
  const [amount, setAmount] = useState(line ? String(line.amount) : '');
  const component = choice === '__custom' ? custom.trim() : choice;

  const save = useMutation({
    mutationFn: () =>
      line
        ? payrollApi.updateLine(payslipId, line.id, { component, amount: Number(amount) })
        : payrollApi.addLine(payslipId, { section, component, amount: Number(amount) }),
    onSuccess: (p) => {
      onSaved(p);
      toast(line ? 'Line updated' : section === 'B' ? 'Addition added' : 'Deduction added');
      onClose();
    },
  });

  return (
    <Modal
      open
      title={line ? `Edit ${line.component}` : section === 'B' ? 'Add addition' : 'Add deduction'}
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!component || !Number(amount) || save.isPending} onClick={() => save.mutate()}>
            Save
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Component">
          <select className="input" value={choice} onChange={(e) => setChoice(e.target.value)}>
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
            <option value="__custom">Something else</option>
          </select>
        </Field>
        {choice === '__custom' && (
          <Field label="Name">
            <input className="input" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={section === 'B' ? 'Night shift allowance' : 'Salary advance recovery'} autoFocus />
          </Field>
        )}
        <Field label="Amount, PKR" hint={section === 'B' ? 'Added on top of gross earned; counts toward withholding tax' : 'Taken off after the statutory deductions'}>
          <MoneyInput value={amount} onChange={setAmount} />
        </Field>
        {section === 'C' && <Tag tone="neutral">PF, EOBI, withholding tax and loan installments are computed</Tag>}
        <FormError message={save.error?.message} />
      </div>
    </Modal>
  );
}
