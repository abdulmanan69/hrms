import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { Card, CardHead, ConfirmModal, EmptyState, ErrorState, Field, FormError, ICON, Loading, Modal, PageHeader, StatusTag, Tag, toast } from '../../components/ui';
import { date, days, label } from '../../lib/format';
import { leaveApi, leaveKeys, type LeaveSettings, type LeaveType, type LeaveTypeInput } from '../../api/leave';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function LeaveTypes() {
  const q = useQuery({ queryKey: leaveKeys.types(true), queryFn: () => leaveApi.types(true) });
  const [editing, setEditing] = useState<LeaveType | 'new' | null>(null);

  return (
    <div className="rise">
      <PageHeader
        eyebrow="Leave"
        title="Leave types"
        subtitle="Entitlements, accrual and the working calendar used to count leave days"
        actions={
          <button className="btn-primary" onClick={() => setEditing('new')}>
            <Plus {...ICON} />
            Add leave type
          </button>
        }
      />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="overflow-hidden xl:col-span-2">
          <CardHead title="Types" meta="Types in use are deactivated, never deleted" />
          {q.isLoading ? (
            <div className="p-5">
              <Loading inline />
            </div>
          ) : q.error ? (
            <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
          ) : q.data!.data.length === 0 ? (
            <EmptyState bare title="No leave types" hint="Add a type such as Casual or Sick so employees can apply" action={<button className="btn-secondary btn-sm" onClick={() => setEditing('new')}>Add leave type</button>} />
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th className="th">Name</th>
                    <th className="th">Pay</th>
                    <th className="th text-right">Days a year</th>
                    <th className="th">Accrual</th>
                    <th className="th text-right">Carry forward</th>
                    <th className="th">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data!.data.map((t) => (
                    <tr key={t.id} className="row-link" onClick={() => setEditing(t)}>
                      <td className="td">
                        <span className="font-medium">{t.name}</span>
                        {t.requiresAttachment && <span className="ml-2 text-xs text-ink-3">attachment required</span>}
                      </td>
                      <td className="td">{t.isPaid ? <Tag>Paid</Tag> : <Tag tone="warn">Unpaid</Tag>}</td>
                      <td className="td num text-right">{t.isPaid ? days(t.annualEntitlementDays) : '—'}</td>
                      <td className="td text-ink-2">{t.isPaid ? label(t.accrualRule) : '—'}</td>
                      <td className="td num text-right">{t.isPaid && t.carryForwardMax > 0 ? days(t.carryForwardMax) : '—'}</td>
                      <td className="td">
                        <StatusTag value={t.active ? 'active' : 'inactive'} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <SettingsCard />
      </div>
      <TypeModal type={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

const BLANK: LeaveTypeInput = {
  name: '',
  annualEntitlementDays: 0,
  isPaid: true,
  accrualRule: 'annual',
  carryForwardMax: 0,
  requiresAttachment: false,
  active: true,
  sortOrder: 0,
};

function TypeModal({ type, onClose }: { type: LeaveType | 'new' | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<LeaveTypeInput>(BLANK);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const existing = type && type !== 'new' ? type : null;
  useEffect(() => {
    if (type === 'new') setForm(BLANK);
    else if (type) {
      const { id: _i, applicationCount: _a, ledgerCount: _l, ...rest } = type;
      setForm(rest);
    }
  }, [type]);
  const set = <K extends keyof LeaveTypeInput>(k: K, v: LeaveTypeInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const refresh = () => void qc.invalidateQueries({ queryKey: leaveKeys.all });
  const save = useMutation({
    mutationFn: () => (existing ? leaveApi.updateType(existing.id, form) : leaveApi.createType(form)),
    onSuccess: (t) => {
      refresh();
      toast(existing ? `Saved ${t.name}` : `Added ${t.name}`);
      close();
    },
  });
  const remove = useMutation({
    mutationFn: () => leaveApi.deleteType(existing!.id),
    onSuccess: (r) => {
      refresh();
      toast(r.deleted ? 'Leave type deleted' : 'Leave type is in use, so it was deactivated');
      setConfirmDelete(false);
      close();
    },
  });
  const close = () => {
    save.reset();
    remove.reset();
    onClose();
  };
  const used = existing ? existing.applicationCount + existing.ledgerCount > 0 : false;

  return (
    <>
      <Modal
        open={!!type && !confirmDelete}
        title={existing ? `Edit ${existing.name}` : 'Add leave type'}
        onClose={close}
        footer={
          <>
            {existing && (
              <button className="btn-ghost mr-auto text-bad" onClick={() => setConfirmDelete(true)}>
                {used ? 'Deactivate' : 'Delete'}
              </button>
            )}
            <button className="btn-secondary" onClick={close} disabled={save.isPending}>
              Cancel
            </button>
            <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending || !form.name.trim()}>
              {existing ? 'Save' : 'Add leave type'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name" required>
            <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={40} />
          </Field>
          <Field label="Pay" hint={used ? 'This type is in use, so paid or unpaid cannot change' : 'Unpaid days reduce salary in payroll'}>
            <select className="input" value={form.isPaid ? 'paid' : 'unpaid'} disabled={used} onChange={(e) => set('isPaid', e.target.value === 'paid')}>
              <option value="paid">Paid, from a balance</option>
              <option value="unpaid">Unpaid</option>
            </select>
          </Field>
          {form.isPaid && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Days a year">
                  <input className="input num" type="number" min={0} max={365} step={0.5} value={form.annualEntitlementDays} onChange={(e) => set('annualEntitlementDays', Number(e.target.value))} />
                </Field>
                <Field label="Accrual">
                  <select className="input" value={form.accrualRule} onChange={(e) => set('accrualRule', e.target.value as LeaveTypeInput['accrualRule'])}>
                    <option value="annual">Annual grant on Jan 1</option>
                    <option value="monthly">Monthly, a twelfth each month</option>
                    <option value="none">None, adjust by hand</option>
                  </select>
                </Field>
              </div>
              <Field label="Carry forward, most days" hint="Balance above this expires at year end; 0 means nothing carries over">
                <input className="input num" type="number" min={0} max={365} step={0.5} value={form.carryForwardMax} onChange={(e) => set('carryForwardMax', Number(e.target.value))} />
              </Field>
            </>
          )}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Sort order">
              <input className="input num" type="number" min={0} max={1000} value={form.sortOrder} onChange={(e) => set('sortOrder', Number(e.target.value))} />
            </Field>
            <div className="space-y-2 pt-7 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.requiresAttachment} onChange={(e) => set('requiresAttachment', e.target.checked)} />
                Requires an attachment
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} />
                Active
              </label>
            </div>
          </div>
          <FormError message={save.error?.message} />
        </div>
      </Modal>
      <ConfirmModal
        open={confirmDelete}
        title={used ? `Deactivate ${existing?.name}` : `Delete ${existing?.name}`}
        body={
          used
            ? 'This type has applications or ledger entries, so it is kept for history and hidden from new requests.'
            : 'This type has never been used and will be removed.'
        }
        confirmLabel={used ? 'Deactivate' : 'Delete'}
        danger
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onClose={() => setConfirmDelete(false)}
      >
        {remove.error && <p className="mt-3 text-sm text-bad">{remove.error.message}</p>}
      </ConfirmModal>
    </>
  );
}

function SettingsCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: leaveKeys.settings, queryFn: leaveApi.settings });
  const [draft, setDraft] = useState<LeaveSettings | null>(null);
  const [newDate, setNewDate] = useState('');
  useEffect(() => {
    if (q.data) setDraft(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: (s: LeaveSettings) => leaveApi.saveSettings(s),
    onSuccess: (s) => {
      qc.setQueryData(leaveKeys.settings, s);
      void qc.invalidateQueries({ queryKey: leaveKeys.all });
      toast('Leave calendar saved');
    },
  });
  if (q.isLoading || !draft) return <Loading />;
  if (q.error) return <ErrorState message={q.error.message} onRetry={() => q.refetch()} />;
  const toggle = (d: number) =>
    setDraft({ ...draft, weekendDays: draft.weekendDays.includes(d) ? draft.weekendDays.filter((x) => x !== d) : [...draft.weekendDays, d].sort() });
  const dirty = JSON.stringify(draft) !== JSON.stringify(q.data);

  return (
    <Card>
      <CardHead title="Leave calendar" meta="Days that never count as leave" />
      <div className="space-y-5 px-5 pb-5">
        <div>
          <p className="mb-2 text-sm text-ink-2">Weekend days</p>
          <div className="flex flex-wrap gap-1">
            {WEEKDAYS.map((name, i) => {
              const on = draft.weekendDays.includes(i);
              return (
                <button
                  key={i}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(i)}
                  className={`h-8 rounded-lg border px-2.5 text-sm transition-colors ${on ? 'border-brand/40 bg-brand-soft text-brand' : 'border-line text-ink-2 hover:text-ink'}`}
                >
                  {name.slice(0, 3)}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <p className="mb-2 text-sm text-ink-2">Public holidays</p>
          <div className="flex gap-2">
            <input type="date" className="input" value={newDate} onChange={(e) => setNewDate(e.target.value)} aria-label="Holiday date" />
            <button
              type="button"
              className="btn-secondary"
              disabled={!newDate || draft.holidays.includes(newDate)}
              onClick={() => {
                setDraft({ ...draft, holidays: [...draft.holidays, newDate].sort() });
                setNewDate('');
              }}
            >
              Add
            </button>
          </div>
          {draft.holidays.length === 0 ? (
            <p className="mt-3 text-sm text-ink-3">No public holidays yet. Add each date so leave across it is not counted</p>
          ) : (
            <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
              {draft.holidays.map((h) => (
                <li key={h} className="flex items-center justify-between px-3 py-1.5 text-sm">
                  <span className="num">{date(h)}</span>
                  <button className="icon-btn" aria-label={`Remove ${date(h)}`} onClick={() => setDraft({ ...draft, holidays: draft.holidays.filter((x) => x !== h) })}>
                    <X {...ICON} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <FormError message={save.error?.message} />
        <div className="flex justify-end gap-2">
          {dirty && (
            <button className="btn-secondary" onClick={() => setDraft(q.data!)}>
              Discard
            </button>
          )}
          <button className="btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>
            Save calendar
          </button>
        </div>
      </div>
    </Card>
  );
}
