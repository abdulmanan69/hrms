import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bar as RBar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Plus, SlidersHorizontal } from 'lucide-react';
import { currentMonth, ROLE_LABEL, salesApi, type Sale, type SalesSummary } from '../../api/sales';
import { Bar, Card, CardHead, EmptyState, ErrorState, Field, FormError, ICON, Loading, Modal, PageHeader, Pagination, SearchInput, Segmented, SipId, Stat, Tabs, toast, useDebounced } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { date, money, month as monthText, todayISO } from '../../lib/format';
import { PersonPicker } from '../payroll/shared';

type Tab = 'people' | 'sales';

export function Sales() {
  const { can } = useAuth();
  const [ym, setYm] = useState(currentMonth());
  const [tab, setTab] = useState<Tab>('people');
  const [recording, setRecording] = useState(false);
  const summary = useQuery({ queryKey: ['sales', 'summary', ym], queryFn: () => salesApi.summary(ym) });
  const manage = can('sales.manage');

  return (
    <div>
      <PageHeader
        eyebrow="Sales"
        title={monthText(ym)}
        subtitle="Sales credited to closers and fronters, and the incentive they have earned this month"
        actions={
          <>
            <input type="month" className="input w-auto" value={ym} max={currentMonth()} onChange={(e) => e.target.value && setYm(e.target.value)} aria-label="Month" />
            {manage && (
              <Link to="/sales/incentives" className="btn-secondary">
                <SlidersHorizontal {...ICON} className="text-ink-3" /> Incentive slabs
              </Link>
            )}
            {manage && (
              <button className="btn-primary" onClick={() => setRecording(true)} disabled={summary.data?.closed}>
                <Plus {...ICON} /> Record sale
              </button>
            )}
          </>
        }
      />

      {summary.isLoading ? (
        <Loading />
      ) : summary.error ? (
        <ErrorState message={summary.error.message} onRetry={() => summary.refetch()} />
      ) : (
        <SummaryView s={summary.data!} tab={tab} setTab={setTab} manage={manage} />
      )}

      {recording && <RecordSaleModal onClose={() => setRecording(false)} />}
    </div>
  );
}

function SummaryView({ s, tab, setTab, manage }: { s: SalesSummary; tab: Tab; setTab: (t: Tab) => void; manage: boolean }) {
  const noPlan = s.plan.closer.slabs.length === 0 && s.plan.fronter.slabs.length === 0;
  return (
    <>
      {s.closed && (
        <div className="card mb-6 px-5 py-4 text-sm text-ink-2">
          {monthText(s.month)} payroll is approved, so these sales are final and the incentive below is what was paid.
        </div>
      )}
      {noPlan && manage && (
        <div className="card mb-6 flex flex-wrap items-center gap-3 px-5 py-4 text-sm">
          <span className="text-ink-2">No incentive slabs are set, so sales earn nothing yet.</span>
          <Link to="/sales/incentives" className="btn-secondary btn-sm ml-auto">
            Set slabs
          </Link>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Stat label="Sales closed" value={s.totals.closer} note={`${s.totals.people} people credited`} />
        <Stat label="Fronter credits" value={s.totals.fronter} note="Transfers that became a sale" />
        <Stat label="Incentive earned, PKR" value={money(s.totals.incentive)} note={s.plan.includeInPayroll ? 'Added to payroll in section B' : 'Not added to payroll'} accent />
        <Stat label="Voided" value={s.totals.voided} note="Not counted for incentive" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <DailyChart s={s} />
        <TopClosers s={s} />
      </div>

      <div className="mt-8">
        <Tabs
          tabs={[
            { value: 'people', label: 'By person', count: s.people.length },
            { value: 'sales', label: 'Sales' },
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'people' ? <PeopleTable s={s} /> : <SalesList month={s.month} manage={manage && !s.closed} />}
      </div>
    </>
  );
}

function DailyChart({ s }: { s: SalesSummary }) {
  const data = useMemo(() => {
    const [y, m] = s.month.split('-').map(Number);
    const days = new Date(y, m, 0).getDate();
    const byDate = new Map(s.byDay.map((d) => [d.date, d]));
    const today = todayISO();
    return Array.from({ length: days }, (_, i) => {
      const iso = `${s.month}-${String(i + 1).padStart(2, '0')}`;
      return { day: i + 1, iso, closer: byDate.get(iso)?.closer ?? 0, fronter: byDate.get(iso)?.fronter ?? 0, today: iso === today };
    });
  }, [s]);
  const best = data.reduce((b, d) => (d.closer > b.closer ? d : b), data[0]);
  return (
    <Card className="flex flex-col">
      <CardHead title="Sales per day" meta={best && best.closer > 0 ? `Best day ${date(best.iso, true)}, ${best.closer} sales` : 'No sales this month yet'} />
      <div className="h-[260px] px-2 pb-4">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 12, right: 16, left: 0, bottom: 0 }} barCategoryGap="22%">
            <CartesianGrid vertical={false} stroke="rgba(23,23,23,0.06)" />
            <XAxis dataKey="day" tickLine={false} axisLine={false} interval={data.length > 20 ? 4 : 0} tick={{ fill: '#737373', fontSize: 12, fontFamily: 'JetBrains Mono' }} dy={6} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} tick={{ fill: '#737373', fontSize: 12, fontFamily: 'JetBrains Mono' }} />
            <Tooltip
              cursor={{ fill: 'rgba(23,23,23,0.04)' }}
              formatter={(v: number) => [v, 'Sales']}
              labelFormatter={(_l, p) => (p?.[0]?.payload?.iso ? date(p[0].payload.iso) : '')}
              contentStyle={{ borderRadius: 10, border: '1px solid rgba(23,23,23,0.08)', boxShadow: '0 8px 24px rgba(0,0,0,0.06)', fontSize: 12, fontFamily: 'JetBrains Mono' }}
              labelStyle={{ color: '#737373', marginBottom: 2 }}
            />
            <RBar dataKey="closer" radius={[3, 3, 0, 0]}>
              {data.map((d) => (
                <Cell key={d.day} fill={d.today ? '#3B4A9F' : '#A3A3A3'} />
              ))}
            </RBar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function TopClosers({ s }: { s: SalesSummary }) {
  const top = s.people.filter((p) => p.closer > 0).slice(0, 6);
  const max = top[0]?.closer ?? 0;
  return (
    <Card>
      <CardHead title="Top closers" meta="Confirmed sales this month" />
      {top.length === 0 ? (
        <EmptyState bare title="No sales yet" />
      ) : (
        <ul className="space-y-4 px-5 pb-5">
          {top.map((p, i) => (
            <li key={p.sipId}>
              <div className="mb-1.5 flex items-baseline gap-2 text-sm">
                <span className="num w-4 text-xs text-ink-3">{i + 1}</span>
                <Link to={`/employees/${p.sipId}`} className="truncate hover:underline">
                  {p.name}
                </Link>
                <span className="num ml-auto">{p.closer}</span>
              </div>
              <div className="pl-6">
                <Bar value={p.closer} max={max} accent={i === 0} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function nextText(n: number | null, hasSlabs: boolean) {
  if (!hasSlabs) return '';
  return n === null ? 'Top slab' : `${n} to next slab`;
}

function PeopleTable({ s }: { s: SalesSummary }) {
  if (s.people.length === 0) return <EmptyState title="No sales recorded this month" hint="Sales come from VICIdial every hour, or are recorded here by hand" />;
  const showFronter = s.totals.fronter > 0 || s.plan.fronter.slabs.length > 0;
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th className="th">Person</th>
              <th className="th">Department</th>
              <th className="th text-right">Closed</th>
              {showFronter && <th className="th text-right">Fronted</th>}
              <th className="th">Next slab</th>
              <th className="th text-right">Incentive, PKR</th>
            </tr>
          </thead>
          <tbody>
            {s.people.map((p) => (
              <tr key={p.sipId}>
                <td className="td">
                  <div className="flex items-center gap-2">
                    <Link to={`/employees/${p.sipId}`} className="font-medium hover:underline">
                      {p.name}
                    </Link>
                    <SipId id={p.sipId} />
                  </div>
                </td>
                <td className="td text-ink-2">{p.department ?? ''}</td>
                <td className="td num text-right">{p.closer}</td>
                {showFronter && <td className="td num text-right text-ink-2">{p.fronter}</td>}
                <td className="td text-xs text-ink-3">{p.closer > 0 ? nextText(p.closerToNext, s.plan.closer.slabs.length > 0) : p.fronter > 0 ? nextText(p.fronterToNext, s.plan.fronter.slabs.length > 0) : ''}</td>
                <td className="td num text-right font-medium">{money(p.incentive)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SalesList({ month, manage }: { month: string; manage: boolean }) {
  const [status, setStatus] = useState<'all' | 'confirmed' | 'void'>('all');
  const [role, setRole] = useState<'all' | 'closer' | 'fronter'>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search);
  const [voiding, setVoiding] = useState<Sale | null>(null);
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['sales', 'list', month, status, role, debounced, page],
    queryFn: () => salesApi.list({ month, status: status === 'all' ? undefined : status, role: role === 'all' ? undefined : role, search: debounced || undefined, page }),
  });
  const restore = useMutation({
    mutationFn: (id: number) => salesApi.restore(id),
    onSuccess: () => {
      toast('Sale restored');
      void qc.invalidateQueries({ queryKey: ['sales'] });
    },
    onError: (e: Error) => toast(e.message, 'bad'),
  });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="w-full sm:w-64">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search" />
        </div>
        <Segmented options={[{ value: 'all', label: 'All' }, { value: 'closer', label: 'Closers' }, { value: 'fronter', label: 'Fronters' }]} value={role} onChange={(v) => { setRole(v); setPage(1); }} />
        <Segmented options={[{ value: 'all', label: 'All' }, { value: 'confirmed', label: 'Confirmed' }, { value: 'void', label: 'Voided' }]} value={status} onChange={(v) => { setStatus(v); setPage(1); }} />
      </div>
      {list.isLoading ? (
        <Loading />
      ) : list.error ? (
        <ErrorState message={list.error.message} onRetry={() => list.refetch()} />
      ) : list.data!.data.length === 0 ? (
        <EmptyState title="No sales match" />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="th">Date</th>
                  <th className="th">Person</th>
                  <th className="th">Credit</th>
                  <th className="th">Reference</th>
                  <th className="th">Source</th>
                  <th className="th text-right">Value, PKR</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody>
                {list.data!.data.map((r) => (
                  <tr key={r.id} className={r.status === 'void' ? 'text-ink-3' : ''}>
                    <td className="td num whitespace-nowrap">{date(r.saleDate, true)}</td>
                    <td className="td">
                      <div className="flex items-center gap-2">
                        <span className={r.status === 'void' ? 'line-through' : ''}>{r.name}</span>
                        <SipId id={r.sipId} />
                      </div>
                    </td>
                    <td className="td text-ink-2">{ROLE_LABEL[r.role]}</td>
                    <td className="td">
                      <span className="text-ink-2">{r.reference ?? ''}</span>
                      {r.status === 'void' && <p className="text-xs text-ink-3">Voided: {r.voidReason}</p>}
                    </td>
                    <td className="td text-xs text-ink-3">
                      {r.source === 'manual' ? 'Recorded by hand' : `${r.source === 'vicidial' ? 'VICIdial' : r.source}${r.externalUser ? `, ${r.externalUser}` : ''}`}
                    </td>
                    <td className="td num text-right text-ink-2">{r.amount != null ? money(r.amount) : ''}</td>
                    <td className="td text-right">
                      {manage &&
                        (r.status === 'confirmed' ? (
                          <button className="btn-ghost btn-sm" onClick={() => setVoiding(r)}>
                            Void
                          </button>
                        ) : (
                          <button className="btn-ghost btn-sm" disabled={restore.isPending} onClick={() => restore.mutate(r.id)}>
                            Restore
                          </button>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination meta={list.data!.meta} onPage={setPage} />
        </div>
      )}
      {voiding && <VoidModal sale={voiding} onClose={() => setVoiding(null)} />}
    </div>
  );
}

function VoidModal({ sale, onClose }: { sale: Sale; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => salesApi.void(sale.id, reason.trim()),
    onSuccess: () => {
      toast('Sale voided');
      void qc.invalidateQueries({ queryKey: ['sales'] });
      onClose();
    },
  });
  return (
    <Modal
      open
      title="Void this sale"
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-danger" disabled={!reason.trim() || m.isPending} onClick={() => m.mutate()}>
            Void sale
          </button>
        </>
      }
    >
      <p className="text-sm text-ink-2">
        {sale.name}, {ROLE_LABEL[sale.role].toLowerCase()} on {date(sale.saleDate)}
        {sale.reference ? ` (${sale.reference})` : ''}. It stays on record but no longer counts for the incentive
        {sale.source !== 'manual' ? ', and later syncs from VICIdial will not restore it' : ''}.
      </p>
      <div className="mt-4">
        <Field label="Reason">
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Cancelled by customer" autoFocus />
        </Field>
      </div>
      <FormError message={m.error?.message} />
    </Modal>
  );
}

function RecordSaleModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [closer, setCloser] = useState<{ sipId: string; name: string } | null>(null);
  const [fronter, setFronter] = useState<{ sipId: string; name: string } | null>(null);
  const [withFronter, setWithFronter] = useState(false);
  const [saleDate, setSaleDate] = useState(todayISO());
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: () =>
      salesApi.create({
        sipId: closer!.sipId,
        fronterSipId: withFronter && fronter ? fronter.sipId : null,
        saleDate,
        reference: reference.trim() || null,
        amount: amount ? Number(amount) : null,
        note: note.trim() || null,
      }),
    onSuccess: () => {
      toast('Sale recorded');
      void qc.invalidateQueries({ queryKey: ['sales'] });
      onClose();
    },
  });
  const ready = !!closer && (!withFronter || !!fronter) && !!saleDate && (!amount || /^\d+$/.test(amount));
  return (
    <Modal
      open
      title="Record a sale"
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!ready || m.isPending} onClick={() => m.mutate()}>
            Record sale
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Closer" hint="The person who made the sale">
          <PersonPicker value={closer} onChange={setCloser} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" checked={withFronter} onChange={(e) => setWithFronter(e.target.checked)} />
          A fronter transferred this call
        </label>
        {withFronter && (
          <Field label="Fronter">
            <PersonPicker value={fronter} onChange={setFronter} />
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date">
            <input type="date" className="input" value={saleDate} max={todayISO()} onChange={(e) => setSaleDate(e.target.value)} />
          </Field>
          <Field label="Sale value, PKR" hint="Optional">
            <input className="input num" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} />
          </Field>
        </div>
        <Field label="Reference" hint="Customer, policy or lead number">
          <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <Field label="Note" hint="Optional">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <FormError message={m.error?.message} />
      </div>
    </Modal>
  );
}
