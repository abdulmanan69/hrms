/** Pieces shared by the leave pages: request table, detail and decision modals, balance cards, ledger. */
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Paperclip, X } from 'lucide-react';
import {
  ConfirmModal,
  DetailList,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  ICON,
  Loading,
  Modal,
  SearchInput,
  SipId,
  StatusTag,
  Tag,
  toast,
  useDebounced,
} from '../../components/ui';
import { date, dateRange, dateTime, days, label, month, sentWhen } from '../../lib/format';
import { leaveApi, leaveKeys, orgApi, type BalanceCard, type LeaveApplication, type LedgerEntry, type PersonOption } from '../../api/leave';

/* ------------------------------------------------------------------ */
/* Text helpers                                                         */
/* ------------------------------------------------------------------ */

function monthName(iso: string): string {
  return month(iso.slice(0, 7)).split(' ')[0];
}

/** "November" or "November and December" — the pay runs the unpaid days fall in. */
export function payMonths(start: string, end: string): string {
  const a = monthName(start);
  const b = monthName(end);
  return a === b ? a : `${a} and ${b}`;
}

export function unpaidText(n: number, start: string, end: string): string {
  return `${days(n)} ${n === 1 || n === 0.5 ? 'day' : 'days'} unpaid in ${payMonths(start, end)} pay`;
}

export function dayCount(n: number): string {
  return `${days(n)} ${n === 1 || n === 0.5 ? 'day' : 'days'}`;
}

/* ------------------------------------------------------------------ */
/* Mutations                                                            */
/* ------------------------------------------------------------------ */

export function useLeaveActions() {
  const qc = useQueryClient();
  const done = (msg: string) => {
    void qc.invalidateQueries({ queryKey: leaveKeys.all });
    void qc.invalidateQueries({ queryKey: ['nav-counts'] });
    toast(msg);
  };
  const fail = (e: Error) => toast(e.message, 'bad');
  const approve = useMutation({
    mutationFn: (v: { id: number; comment?: string }) => leaveApi.approve(v.id, v.comment),
    onSuccess: (r) => done(`Approved leave for ${r.employeeName}`),
    onError: fail,
  });
  const reject = useMutation({
    mutationFn: (v: { id: number; comment?: string }) => leaveApi.reject(v.id, v.comment),
    onSuccess: (r) => done(`Rejected leave for ${r.employeeName}`),
  });
  const cancel = useMutation({
    mutationFn: (v: { id: number; comment?: string }) => leaveApi.cancel(v.id, v.comment),
    onSuccess: () => done('Leave cancelled'),
  });
  return { approve, reject, cancel };
}

/* ------------------------------------------------------------------ */
/* Request table                                                        */
/* ------------------------------------------------------------------ */

function EffectCell({ r }: { r: LeaveApplication }) {
  if (!r.effect) return <span className="text-ink-3">—</span>;
  if (r.effect.unpaidDays > 0) return <span className="text-xs text-warn">{unpaidText(r.effect.unpaidDays, r.startDate, r.endDate)}</span>;
  return <span className="num text-ink-2">{days(r.effect.balanceAfter)}</span>;
}

/**
 * Leave requests as the dashboard shows them: person + SIP ID, type, dates,
 * days, balance after (or unpaid days), and approve/reject for those allowed.
 */
export function LeaveTable({
  rows,
  showEmployee = true,
  showStatus = true,
  onOpen,
  emptyTitle,
  emptyHint,
  footer,
  allowCancel = false,
}: {
  rows: LeaveApplication[];
  /** show a Cancel button on rows the user may cancel */
  allowCancel?: boolean;
  showEmployee?: boolean;
  showStatus?: boolean;
  onOpen: (id: number) => void;
  emptyTitle: string;
  emptyHint?: ReactNode;
  footer?: ReactNode;
}) {
  const { approve, cancel } = useLeaveActions();
  const [rejecting, setRejecting] = useState<LeaveApplication | null>(null);
  const [cancelling, setCancelling] = useState<LeaveApplication | null>(null);
  if (rows.length === 0) return <EmptyState bare title={emptyTitle} hint={emptyHint} />;
  return (
    <>
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              {showEmployee && <th className="th">Employee</th>}
              <th className="th">Type</th>
              <th className="th">Dates</th>
              <th className="th text-right">Days</th>
              <th className="th text-right">Balance after</th>
              {showStatus && <th className="th">Status</th>}
              <th className="th" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="row-link" onClick={() => onOpen(r.id)}>
                {showEmployee && (
                  <td className="td">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{r.employeeName}</span>
                      <span onClick={(e) => e.stopPropagation()}>
                        <SipId id={r.sipId} to={`/employees/${r.sipId}`} />
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-3">
                      {r.departmentName ? `${r.departmentName}, ` : ''}sent {sentWhen(r.createdAt)}
                    </p>
                  </td>
                )}
                <td className="td">
                  <div className="flex items-center gap-2">
                    <Tag tone={r.isPaid ? 'neutral' : 'warn'}>{r.leaveTypeName}</Tag>
                    {r.hasAttachment && <Paperclip size={14} strokeWidth={1.5} className="text-ink-3" aria-label="Has attachment" />}
                  </div>
                </td>
                <td className="td text-ink-2">
                  {dateRange(r.startDate, r.endDate)}
                  {r.halfDay && <span className="ml-1 text-xs text-ink-3">half day</span>}
                </td>
                <td className="td num text-right">{days(r.totalDays)}</td>
                <td className="td text-right">
                  <EffectCell r={r} />
                </td>
                {showStatus && (
                  <td className="td">
                    <StatusTag value={r.status} />
                  </td>
                )}
                <td className="td" onClick={(e) => e.stopPropagation()}>
                  {allowCancel && r.canCancel && !r.canDecide && (
                    <div className="flex justify-end">
                      <button className="btn-ghost btn-sm" onClick={() => setCancelling(r)}>
                        Cancel
                      </button>
                    </div>
                  )}
                  {r.canDecide && (
                    <div className="flex justify-end gap-1">
                      <button
                        onClick={() => setRejecting(r)}
                        className="grid h-8 w-8 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-bad-soft hover:text-bad"
                        aria-label={`Reject leave for ${r.employeeName}`}
                        title="Reject"
                      >
                        <X {...ICON} />
                      </button>
                      <button
                        onClick={() => approve.mutate({ id: r.id })}
                        disabled={approve.isPending}
                        className="grid h-8 w-8 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-good-soft hover:text-good"
                        aria-label={`Approve leave for ${r.employeeName}`}
                        title="Approve"
                      >
                        <Check {...ICON} />
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer}
      <RejectModal app={rejecting} onClose={() => setRejecting(null)} />
      <ConfirmModal
        open={!!cancelling}
        title="Cancel leave"
        body={
          cancelling &&
          `${cancelling.leaveTypeName} leave, ${dateRange(cancelling.startDate, cancelling.endDate)}. ${
            cancelling.status === 'approved' && cancelling.effect && cancelling.effect.paidDays > 0
              ? `${dayCount(cancelling.effect.paidDays)} go back to the balance.`
              : 'Nothing changes on the balance.'
          }`
        }
        confirmLabel="Cancel leave"
        danger
        busy={cancel.isPending}
        onConfirm={() => cancelling && cancel.mutate({ id: cancelling.id }, { onSuccess: () => setCancelling(null), onError: (e) => toast(e.message, 'bad') })}
        onClose={() => setCancelling(null)}
      />
    </>
  );
}

export function RejectModal({ app, onClose }: { app: LeaveApplication | null; onClose: () => void }) {
  const { reject } = useLeaveActions();
  const [comment, setComment] = useState('');
  const close = () => {
    setComment('');
    reject.reset();
    onClose();
  };
  return (
    <Modal
      open={!!app}
      title="Reject leave"
      onClose={close}
      footer={
        <>
          <button className="btn-secondary" onClick={close} disabled={reject.isPending}>
            Cancel
          </button>
          <button
            className="btn-danger"
            disabled={reject.isPending}
            onClick={() => app && reject.mutate({ id: app.id, comment: comment.trim() }, { onSuccess: close })}
          >
            Reject
          </button>
        </>
      }
    >
      {app && (
        <div className="space-y-4">
          <p className="text-sm text-ink-2">
            {app.employeeName} asked for {dayCount(app.totalDays)} of {app.leaveTypeName.toLowerCase()} leave, {dateRange(app.startDate, app.endDate)}.
            Nothing is deducted from the balance.
          </p>
          <Field label="Comment" hint="Sent to the employee with the decision">
            <textarea className="input" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} />
          </Field>
          <FormError message={reject.error?.message} />
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Detail modal                                                         */
/* ------------------------------------------------------------------ */

export function LeaveDetailModal({ id, onClose }: { id: number | null; onClose: () => void }) {
  const q = useQuery({ queryKey: leaveKeys.application(id ?? 0), queryFn: () => leaveApi.application(id!), enabled: id !== null });
  const { approve, cancel } = useLeaveActions();
  const [comment, setComment] = useState('');
  const [rejecting, setRejecting] = useState<LeaveApplication | null>(null);
  const close = () => {
    setComment('');
    approve.reset();
    cancel.reset();
    onClose();
  };
  const a = q.data;
  const footer =
    a && (a.canDecide || a.canCancel) ? (
      <>
        {a.canCancel && (
          <button className="btn-secondary mr-auto" disabled={cancel.isPending} onClick={() => cancel.mutate({ id: a.id, comment: comment.trim() }, { onSuccess: close })}>
            Cancel leave
          </button>
        )}
        {a.canDecide && (
          <>
            <button className="btn-secondary" onClick={() => setRejecting(a)}>
              Reject
            </button>
            <button className="btn-primary" disabled={approve.isPending} onClick={() => approve.mutate({ id: a.id, comment: comment.trim() }, { onSuccess: close })}>
              Approve
            </button>
          </>
        )}
      </>
    ) : undefined;

  return (
    <>
      <Modal open={id !== null && !rejecting} title={a ? `${a.leaveTypeName} leave` : 'Leave request'} onClose={close} footer={footer} wide>
        {q.isLoading ? (
          <Loading inline />
        ) : q.error ? (
          <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
        ) : a ? (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{a.employeeName}</span>
              <SipId id={a.sipId} to={`/employees/${a.sipId}`} />
              <StatusTag value={a.status} />
            </div>
            <DetailList
              cols={3}
              items={[
                { label: 'Dates', value: `${dateRange(a.startDate, a.endDate)}${a.halfDay ? ', half day' : ''}` },
                { label: 'Working days', value: days(a.totalDays), mono: true },
                { label: 'Paid', value: a.isPaid ? 'Yes' : 'No, unpaid type' },
                { label: 'Sent', value: `${dateTime(a.createdAt)}${a.createdByName && a.createdByName !== a.employeeName ? ` by ${a.createdByName}` : ''}` },
                { label: 'Department', value: a.departmentName ?? '—' },
                {
                  label: 'Attachment',
                  value: a.hasAttachment ? (
                    <a href={leaveApi.attachmentUrl(a.id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
                      <Paperclip size={14} strokeWidth={1.5} />
                      {a.attachmentName}
                    </a>
                  ) : (
                    'None'
                  ),
                },
              ]}
            />
            <div>
              <p className="text-xs text-ink-3">Reason</p>
              <p className="mt-1 whitespace-pre-wrap text-sm">{a.reason || 'No reason given'}</p>
            </div>

            <EffectSummary a={a} ledger={a.ledger} />

            {a.status !== 'pending' && (a.approverName || a.decisionComment) && (
              <div className="rounded-lg border border-line px-4 py-3 text-sm">
                <p>
                  {label(a.status)}
                  {a.approverName ? ` by ${a.approverName}` : ''}
                  {a.decidedAt ? `, ${dateTime(a.decidedAt)}` : ''}
                </p>
                {a.decisionComment && <p className="mt-1 text-ink-2">{a.decisionComment}</p>}
              </div>
            )}

            {(a.canDecide || a.canCancel) && (
              <Field label="Comment" hint={a.canDecide ? 'Optional, sent to the employee with the decision' : 'Optional'}>
                <textarea className="input" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} />
              </Field>
            )}
            <FormError message={approve.error?.message ?? cancel.error?.message} />
          </div>
        ) : null}
      </Modal>
      <RejectModal
        app={rejecting}
        onClose={() => {
          setRejecting(null);
          close();
        }}
      />
    </>
  );
}

function EffectSummary({ a, ledger }: { a: LeaveApplication; ledger: LedgerEntry[] }) {
  const rows: Array<{ k: string; v: ReactNode }> = [];
  if (a.status === 'pending' && a.effect) {
    if (a.isPaid) {
      rows.push({ k: 'Current balance', v: days(a.balance) });
      rows.push({ k: 'Deducted if approved now', v: days(-a.effect.paidDays) });
      rows.push({ k: 'Balance after', v: days(a.effect.balanceAfter) });
    }
    if (a.effect.unpaidDays > 0) rows.push({ k: 'Unpaid', v: <span className="text-warn">{unpaidText(a.effect.unpaidDays, a.startDate, a.endDate)}</span> });
  } else if (a.status === 'approved') {
    if (a.unpaidDays > 0) rows.push({ k: 'Unpaid', v: <span className="text-warn">{unpaidText(a.unpaidDays, a.startDate, a.endDate)}</span> });
  }
  if (rows.length === 0 && ledger.length === 0) {
    return (
      <div>
        <p className="text-xs text-ink-3">Ledger effect</p>
        <p className="mt-1 text-sm text-ink-2">
          {a.status === 'rejected' || (a.status === 'cancelled' && ledger.length === 0) ? 'None: nothing was deducted' : 'None'}
        </p>
      </div>
    );
  }
  return (
    <div>
      <p className="mb-2 text-xs text-ink-3">Ledger effect</p>
      {rows.length > 0 && (
        <dl className="mb-3 space-y-1">
          {rows.map((r) => (
            <div key={r.k} className="flex justify-between text-sm">
              <dt className="text-ink-2">{r.k}</dt>
              <dd className="num">{r.v}</dd>
            </div>
          ))}
        </dl>
      )}
      {ledger.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {ledger.map((e) => (
            <li key={e.id} className="flex items-baseline justify-between gap-4 px-4 py-2 text-sm">
              <span className="text-ink-2">
                {label(e.entryType)} on {date(e.entryDate)}
              </span>
              <span className="num">
                {e.days > 0 ? '+' : ''}
                {days(e.days)} <span className="text-ink-3">→ {days(e.balanceAfter)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Balances and ledger                                                  */
/* ------------------------------------------------------------------ */

/** One card per leave type: the balance as the figure, entitlement and usage as context. */
export function BalanceCards({ balances }: { balances: BalanceCard[] }) {
  const paid = balances.filter((b) => b.isPaid);
  const unpaid = balances.filter((b) => !b.isPaid);
  if (balances.length === 0) return <EmptyState title="No leave types yet" hint="HR sets up leave types under Leave types" />;
  return (
    <section className="grid grid-cols-2 gap-4 xl:grid-cols-4">
      {paid.map((b) => (
        <div key={b.leaveTypeId} className="card p-5">
          <p className="text-sm text-ink-2">{b.name}</p>
          <p className="num mt-3 text-[28px] font-medium leading-none">{days(b.balance)}</p>
          <p className="mt-3 text-xs text-ink-3">
            of {days(b.entitlement)} a year, {days(b.takenThisYear)} taken
            {b.pending > 0 ? `, ${days(b.pending)} pending` : ''}
          </p>
        </div>
      ))}
      {unpaid.map((b) => (
        <div key={b.leaveTypeId} className="card p-5">
          <p className="text-sm text-ink-2">{b.name}</p>
          <p className="num mt-3 text-[28px] font-medium leading-none">{days(b.takenThisYear)}</p>
          <p className="mt-3 text-xs text-ink-3">days taken this year, unpaid{b.pending > 0 ? `, ${days(b.pending)} pending` : ''}</p>
        </div>
      ))}
    </section>
  );
}

export function LedgerTable({ entries, emptyHint }: { entries: LedgerEntry[]; emptyHint?: string }) {
  if (entries.length === 0) return <EmptyState bare title="No ledger entries" hint={emptyHint ?? 'Grants, leave taken and adjustments appear here'} />;
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th className="th">Date</th>
            <th className="th">Type</th>
            <th className="th">Entry</th>
            <th className="th">Note</th>
            <th className="th text-right">Days</th>
            <th className="th text-right">Balance</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="td text-ink-2">{date(e.entryDate)}</td>
              <td className="td">{e.leaveTypeName ?? '—'}</td>
              <td className="td">{label(e.entryType)}</td>
              <td className="td max-w-[320px] truncate text-ink-2" title={e.note ?? undefined}>
                {e.note ?? '—'}
                {e.createdByName ? <span className="text-ink-3"> · {e.createdByName}</span> : null}
              </td>
              <td className={`td num text-right ${e.days < 0 ? 'text-ink' : 'text-good'}`}>
                {e.days > 0 ? '+' : ''}
                {days(e.days)}
              </td>
              <td className="td num text-right text-ink-2">{days(e.balanceAfter)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Employee picker and adjustment                                       */
/* ------------------------------------------------------------------ */

export function EmployeePicker({ value, onChange }: { value: PersonOption | null; onChange: (p: PersonOption | null) => void }) {
  const [search, setSearch] = useState('');
  const term = useDebounced(search);
  const q = useQuery({ queryKey: ['leave', 'people', term], queryFn: () => orgApi.people(term), enabled: !value });
  if (value) {
    return (
      <div className="flex h-9 items-center justify-between rounded-lg border border-line px-3">
        <span className="flex items-center gap-2 text-sm">
          {value.name} <SipId id={value.sipId} />
        </span>
        <button type="button" className="btn-ghost btn-sm" onClick={() => onChange(null)}>
          Change
        </button>
      </div>
    );
  }
  return (
    <div>
      <SearchInput value={search} onChange={setSearch} placeholder="Search by name or SIP ID" />
      <ul className="mt-1 max-h-48 divide-y divide-line overflow-y-auto rounded-lg border border-line">
        {q.isLoading && (
          <li className="px-3 py-2">
            <Loading inline />
          </li>
        )}
        {q.data?.data
          .filter((p) => p.status !== 'inactive')
          .map((p) => (
            <li key={p.sipId}>
              <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-bg" onClick={() => onChange(p)}>
                <span>{p.name}</span>
                <SipId id={p.sipId} />
                <span className="ml-auto text-xs text-ink-3">{p.departmentName ?? ''}</span>
              </button>
            </li>
          ))}
        {q.data && q.data.data.length === 0 && <li className="px-3 py-2 text-sm text-ink-3">No one matches</li>}
      </ul>
    </div>
  );
}

export function AdjustModal({
  open,
  onClose,
  person,
  leaveTypeId,
}: {
  open: boolean;
  onClose: () => void;
  /** fixed employee; when absent the modal shows a picker */
  person?: { sipId: string; name: string } | null;
  leaveTypeId?: number;
}) {
  const qc = useQueryClient();
  const types = useQuery({ queryKey: leaveKeys.types(false), queryFn: () => leaveApi.types(false), enabled: open });
  const [picked, setPicked] = useState<PersonOption | null>(null);
  const [typeId, setTypeId] = useState<number | ''>(leaveTypeId ?? '');
  const [direction, setDirection] = useState<'add' | 'remove'>('add');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const who = person ?? (picked ? { sipId: picked.sipId, name: picked.name } : null);
  const m = useMutation({
    mutationFn: () =>
      leaveApi.adjust({
        sipId: who!.sipId,
        leaveTypeId: Number(typeId),
        days: (direction === 'add' ? 1 : -1) * Number(amount),
        note: note.trim(),
      }),
    onSuccess: (e) => {
      void qc.invalidateQueries({ queryKey: leaveKeys.all });
      toast(`Balance is now ${days(e.balanceAfter)} days`);
      close();
    },
  });
  const close = () => {
    setPicked(null);
    setAmount('');
    setNote('');
    setDirection('add');
    setTypeId(leaveTypeId ?? '');
    m.reset();
    onClose();
  };
  const n = Number(amount);
  const valid = !!who && typeId !== '' && n > 0 && n <= 365 && note.trim().length >= 3;
  return (
    <Modal
      open={open}
      title="Adjust leave balance"
      onClose={close}
      footer={
        <>
          <button className="btn-secondary" onClick={close} disabled={m.isPending}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!valid || m.isPending} onClick={() => m.mutate()}>
            Save adjustment
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Employee" required>
          {person ? (
            <div className="flex h-9 items-center gap-2 text-sm">
              {person.name} <SipId id={person.sipId} />
            </div>
          ) : (
            <EmployeePicker value={picked} onChange={setPicked} />
          )}
        </Field>
        <Field label="Leave type" required>
          <select className="input" value={typeId} onChange={(e) => setTypeId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Choose a type</option>
            {types.data?.data
              .filter((t) => t.isPaid)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Change">
            <select className="input" value={direction} onChange={(e) => setDirection(e.target.value as 'add' | 'remove')}>
              <option value="add">Add days</option>
              <option value="remove">Remove days</option>
            </select>
          </Field>
          <Field label="Days" required>
            <input className="input num" type="number" min={0.5} step={0.5} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        </div>
        <Field label="Note" required hint="Kept on the ledger entry, e.g. Joining bonus leave or Correction for March">
          <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
        <FormError message={m.error?.message} />
      </div>
    </Modal>
  );
}
