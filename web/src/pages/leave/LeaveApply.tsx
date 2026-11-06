import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { Card, CardHead, EmptyState, ErrorState, Field, FormError, ICON, Loading, PageHeader, toast, useDebounced } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { date, days, todayISO } from '../../lib/format';
import { leaveApi, leaveKeys, type PersonOption } from '../../api/leave';
import { EmployeePicker, dayCount, unpaidText } from './shared';

export function LeaveApply() {
  const { user, can } = useAuth();
  const hr = can('leave.manage');
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [params] = useSearchParams();
  const preset = hr && params.get('sipId') && params.get('sipId') !== user?.sipId ? params.get('sipId')! : null;
  const [forOther, setForOther] = useState<PersonOption | null>(
    preset ? { sipId: preset, name: params.get('name') ?? preset, status: 'active', departmentName: null, designationTitle: null } : null,
  );
  const [onBehalf, setOnBehalf] = useState((!user?.sipId && hr) || !!preset);
  const sipId = onBehalf ? forOther?.sipId ?? null : user?.sipId ?? null;
  const self = !onBehalf;

  const [typeId, setTypeId] = useState<number | ''>('');
  const [start, setStart] = useState(todayISO());
  const [end, setEnd] = useState(todayISO());
  const [halfDay, setHalfDay] = useState(false);
  const [reason, setReason] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const summary = useQuery({
    queryKey: self ? leaveKeys.mySummary : leaveKeys.summary(sipId ?? ''),
    queryFn: () => (self ? leaveApi.mySummary() : leaveApi.summary(sipId!)),
    enabled: !!sipId,
  });
  const types = useQuery({ queryKey: leaveKeys.types(false), queryFn: () => leaveApi.types(false) });
  const type = types.data?.data.find((t) => t.id === typeId);

  const rawInput = useMemo(
    () => ({ sipId: self ? undefined : sipId ?? undefined, leaveTypeId: Number(typeId), startDate: start, endDate: halfDay ? start : end, halfDay }),
    [self, sipId, typeId, start, end, halfDay],
  );
  const quoteInput = useDebounced(rawInput);
  const ready = !!sipId && typeId !== '' && !!quoteInput.startDate && !!quoteInput.endDate;
  const quote = useQuery({
    queryKey: leaveKeys.quote(quoteInput),
    queryFn: () => leaveApi.quote(quoteInput),
    enabled: ready && quoteInput.leaveTypeId === typeId,
    retry: false,
  });

  const submit = useMutation({
    mutationFn: () =>
      leaveApi.apply(
        { sipId: self ? undefined : sipId!, leaveTypeId: Number(typeId), startDate: start, endDate: halfDay ? start : end, halfDay, reason: reason.trim() || undefined },
        file,
      ),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: leaveKeys.all });
      void qc.invalidateQueries({ queryKey: ['nav-counts'] });
      toast(self ? 'Leave request sent for approval' : `Leave request sent for ${r.employeeName}`);
      navigate(self ? '/me/leave' : '/leave/requests');
    },
  });

  if (!user?.sipId && !hr) {
    return (
      <div className="rise">
        <PageHeader eyebrow="Leave" title="Apply for leave" />
        <EmptyState title="Your account is not linked to an employee record" hint="Ask HR to link your account to your SIP ID, then apply here" />
      </div>
    );
  }

  const q = quote.data;
  const needsFile = !!type?.requiresAttachment;
  const canSubmit = ready && !!q && q.overlaps.length === 0 && (!needsFile || !!file) && !submit.isPending;
  const balanceOf = (id: number) => summary.data?.balances.find((b) => b.leaveTypeId === id);

  return (
    <div className="rise">
      <PageHeader eyebrow="Leave" title="Apply for leave" subtitle="Days are counted as working days: weekends and public holidays are skipped" />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHead title="Request" />
          <form
            className="space-y-5 px-5 pb-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit) submit.mutate();
            }}
          >
            {hr && (
              <Field label="Employee" required>
                <div className="space-y-2">
                  {user?.sipId && (
                    <div className="flex gap-4 text-sm">
                      <label className="flex items-center gap-2">
                        <input type="radio" checked={!onBehalf} onChange={() => setOnBehalf(false)} /> Myself
                      </label>
                      <label className="flex items-center gap-2">
                        <input type="radio" checked={onBehalf} onChange={() => setOnBehalf(true)} /> Someone else
                      </label>
                    </div>
                  )}
                  {onBehalf && <EmployeePicker value={forOther} onChange={setForOther} />}
                </div>
              </Field>
            )}

            <Field label="Leave type" required>
              {types.isLoading ? (
                <Loading inline />
              ) : types.error ? (
                <ErrorState message={types.error.message} onRetry={() => types.refetch()} />
              ) : (
                <select className="input" value={typeId} onChange={(e) => setTypeId(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">Choose a type</option>
                  {types.data!.data.map((t) => {
                    const b = balanceOf(t.id);
                    const left = !t.isPaid ? 'unpaid' : b && b.balance !== null ? `${days(b.balance)} left` : '';
                    return (
                      <option key={t.id} value={t.id}>
                        {t.name}
                        {left ? ` · ${left}` : ''}
                      </option>
                    );
                  })}
                </select>
              )}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="From" required>
                <input
                  type="date"
                  className="input"
                  value={start}
                  onChange={(e) => {
                    setStart(e.target.value);
                    if (e.target.value > end || halfDay) setEnd(e.target.value);
                  }}
                />
              </Field>
              <Field label="To" required>
                <input type="date" className="input" value={halfDay ? start : end} min={start} disabled={halfDay} onChange={(e) => setEnd(e.target.value)} />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={halfDay}
                onChange={(e) => {
                  setHalfDay(e.target.checked);
                  if (e.target.checked) setEnd(start);
                }}
              />
              Half day (single date only)
            </label>

            <Field label="Reason">
              <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
            </Field>

            <Field label="Attachment" required={needsFile} hint={needsFile ? `${type!.name} leave needs a supporting document, such as a medical note` : 'Optional. PDF, image or Word document'}>
              <input type="file" className="input py-1.5" accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>

            <FormError message={submit.error?.message} />
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => navigate(-1)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={!canSubmit}>
                {q && q.unpaidDays > 0 ? `Apply, ${dayCount(q.unpaidDays)} unpaid` : 'Apply'}
              </button>
            </div>
          </form>
        </Card>

        <Card>
          <CardHead title="Calculation" meta={sipId ? undefined : 'Pick an employee first'} />
          <div className="px-5 pb-5">
            {!ready ? (
              <p className="text-sm text-ink-3">Choose a leave type and dates to see the days and the balance after</p>
            ) : quote.isLoading || quote.isFetching ? (
              <Loading inline />
            ) : quote.error ? (
              <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{quote.error.message}</p>
            ) : q ? (
              <div className="space-y-4">
                <dl className="space-y-2 text-sm">
                  <Row k="Working days" v={days(q.totalDays)} strong />
                  {q.isPaid ? (
                    <>
                      <Row k="Current balance" v={days(q.balance)} />
                      {q.pendingDays > 0 && <Row k="Held by pending requests" v={days(-q.pendingDays)} />}
                      <Row k="Paid from balance" v={days(-q.paidDays)} />
                      <Row k="Balance after" v={days(q.balanceAfter)} />
                    </>
                  ) : (
                    <Row k="Paid" v="No, unpaid type" />
                  )}
                </dl>
                {q.unpaidDays > 0 && (
                  <div className="flex gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
                    <AlertTriangle {...ICON} className="mt-0.5 shrink-0" />
                    <p>
                      {unpaidText(q.unpaidDays, start, halfDay ? start : end)}.{' '}
                      {q.isPaid ? 'The balance does not cover every day; the rest is deducted from salary.' : 'Unpaid leave is deducted from salary.'}
                    </p>
                  </div>
                )}
                {q.overlaps.length > 0 && (
                  <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">
                    Overlaps {q.overlaps[0].status} leave from {date(q.overlaps[0].startDate)} to {date(q.overlaps[0].endDate)}
                  </p>
                )}
                {q.workingDates.length > 0 && q.workingDates.length <= 31 && (
                  <p className="text-xs text-ink-3">Counted: {q.workingDates.map((d) => date(d, true)).join(', ')}</p>
                )}
              </div>
            ) : null}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className="text-ink-2">{k}</dt>
      <dd className={`num ${strong ? 'font-medium text-brand' : ''}`}>{v}</dd>
    </div>
  );
}
