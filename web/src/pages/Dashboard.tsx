import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, Download, Plus, X } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, downloadUrl } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateRange, days, label, money, month, relative, sentWhen } from '../lib/format';
import { Bar, ConfirmModal, EmptyState, ErrorState, Field, ICON, Loading, PageHeader, SipId, Stat, StatusTag, Tag, toast } from '../components/ui';

type Dash = {
  today: string;
  people: { active: number; pending: number; joinedThisMonth: number; leftThisMonth: number } | null;
  leave: {
    onLeaveToday: number;
    onLeaveTodayUnpaid: number;
    pending: number;
    oldestPendingAt: string | null;
    canDecide: boolean;
    queue: Array<{
      id: number;
      sipId: string;
      name: string;
      department: string | null;
      type: string;
      isPaid: boolean;
      startDate: string;
      endDate: string;
      totalDays: number;
      unpaidDays: number;
      createdAt: string;
      balanceAfter: number | null;
    }>;
  } | null;
  recruitment: {
    stages: Array<{ stage: string; count: number }>;
    open: number;
    appliedThisMonth: number;
    appliedLastMonth: number;
    hiredThisMonth: number;
  } | null;
  payroll: {
    history: Array<{ periodMonth: string; net: number; status: string }>;
    latest: {
      id: number;
      periodMonth: string;
      status: string;
      net: number;
      a: number;
      b: number;
      c: number;
      headcount: number;
      prorated: number;
      increments: number;
      sections: Array<{ section: 'A' | 'B' | 'C'; lines: Array<{ component: string; amount: number }> }>;
    } | null;
  } | null;
  blocked: Array<{ sipId: string; name: string; missing: string[] }> | null;
  activity: Array<{ id: number; who: string | null; summary: string; createdAt: string }> | null;
};

const STAT_COLS: Record<number, string> = { 1: 'xl:grid-cols-1', 2: 'xl:grid-cols-2', 3: 'xl:grid-cols-3', 4: 'xl:grid-cols-4' };
const MONTH_SHORT =['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

export function Dashboard() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Dash>('/dashboard'), refetchInterval: 60_000 });

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState message={q.error?.message ?? 'Could not load the dashboard'} onRetry={() => q.refetch()} />;
  const d = q.data;
  const thisMonth = month(d.today.slice(0, 7));
  const latest = d.payroll?.latest;

  const stats: Array<{ label: string; value: string; note: string }> = [];
  if (d.people) {
    const net = d.people.joinedThisMonth - d.people.leftThisMonth;
    stats.push({
      label: 'Active employees',
      value: String(d.people.active),
      note: net === 0 ? `${d.people.pending} waiting for activation` : `${signed(net)} this month`,
    });
  }
  if (d.leave) {
    stats.push({
      label: 'On leave today',
      value: String(d.leave.onLeaveToday),
      note: d.leave.onLeaveToday === 0 ? 'Everyone is in' : `${d.leave.onLeaveToday - d.leave.onLeaveTodayUnpaid} paid, ${d.leave.onLeaveTodayUnpaid} unpaid`,
    });
    stats.push({
      label: 'Leave requests waiting',
      value: String(d.leave.pending),
      note: d.leave.oldestPendingAt ? `Oldest sent ${sentWhen(d.leave.oldestPendingAt)}` : 'Nothing waiting',
    });
  }
  if (d.recruitment) {
    stats.push({
      label: 'Open applications',
      value: String(d.recruitment.open),
      note: `${d.recruitment.appliedThisMonth} new this month, ${d.recruitment.appliedLastMonth} last month`,
    });
  }

  const subtitle = latest
    ? `${month(latest.periodMonth)} payroll is ${latest.status === 'draft' ? 'in draft' : latest.status}`
    : can('payroll.view')
      ? 'No payroll run yet'
      : undefined;

  return (
    <div>
      <PageHeader
        eyebrow="Dashboard"
        title={thisMonth}
        subtitle={subtitle}
        actions={
          can('employees.manage') && (
            <>
              <a className="btn-secondary" href={downloadUrl('/employees/export')}>
                <Download {...ICON} className="text-ink-3" />
                Export staff
              </a>
              <Link to="/employees/new" className="btn-primary">
                <Plus {...ICON} />
                Add employee
              </Link>
            </>
          )
        }
      />

      {stats.length > 0 && (
        <section className={`grid grid-cols-2 gap-4 ${STAT_COLS[Math.min(stats.length, 4)]}`}>
          {stats.map((s) => (
            <Stat key={s.label} label={s.label} value={s.value} note={s.note} />
          ))}
        </section>
      )}

      {d.payroll && (
        <section className="mt-6 grid gap-4 xl:grid-cols-3">
          <NetPayrollChart history={d.payroll.history} />
          {latest ? <RunLedger run={latest} /> : <NoRun />}
        </section>
      )}

      {(d.leave?.canDecide || d.recruitment) && (
        <section className="mt-6 grid gap-4 xl:grid-cols-3">
          {d.leave?.canDecide && <LeaveQueue rows={d.leave.queue} total={d.leave.pending} wide={!!d.recruitment} />}
          {d.recruitment && <Pipeline data={d.recruitment} />}
        </section>
      )}

      {(d.activity || d.blocked) && (
        <section className="mt-6 grid gap-4 xl:grid-cols-3">
          {d.activity && <Activity rows={d.activity} wide={!!d.blocked} />}
          {d.blocked && <Blocked rows={d.blocked} />}
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function NetPayrollChart({ history }: { history: Array<{ periodMonth: string; net: number; status: string }> }) {
  if (history.length === 0) {
    return (
      <div className="card xl:col-span-2">
        <EmptyState bare title="No payroll history yet" hint="Net pay per month shows here once the first run is created" />
      </div>
    );
  }
  const last = history[history.length - 1];
  const prev = history.length > 1 ? history[history.length - 2] : null;
  const change = prev && prev.net > 0 ? ((last.net - prev.net) / prev.net) * 100 : null;
  const lastIsDraft = last.status === 'draft';
  // settled months as a neutral line; a draft month as a dashed accent segment
  const data = history.map((p, i) => ({
    month: MONTH_SHORT[Number(p.periodMonth.slice(5, 7)) - 1],
    period: p.periodMonth,
    paid: !lastIsDraft || i < history.length - 1 ? p.net : null,
    draft: lastIsDraft && i >= history.length - 2 ? p.net : null,
  }));
  const values = history.map((h) => h.net);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.15, max * 0.02, 1);

  return (
    <div className="card flex flex-col xl:col-span-2">
      <div className="card-head">
        <div>
          <p className="card-title">Net payroll</p>
          <p className="text-xs text-ink-3">PKR, last {history.length} {history.length === 1 ? 'month' : 'months'}</p>
        </div>
        <div className="text-right">
          <p className="num text-xl font-medium text-brand">{money(last.net)}</p>
          <p className="text-xs text-ink-3">
            {change === null ? month(last.periodMonth) : `${change >= 0 ? '+' : ''}${change.toFixed(1)}% vs ${month(prev!.periodMonth).split(' ')[0]}`}
          </p>
        </div>
      </div>
      <div className="min-h-[300px] flex-1 px-2 pb-4">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 12, right: 20, left: 4, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="rgba(23,23,23,0.06)" />
            <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fill: '#737373', fontSize: 12, fontFamily: 'JetBrains Mono' }} dy={8} />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={56}
              domain={[Math.max(0, min - pad), max + pad]}
              tickCount={5}
              tickFormatter={(v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : `${Math.round(v / 1000)}k`)}
              tick={{ fill: '#737373', fontSize: 12, fontFamily: 'JetBrains Mono' }}
            />
            <Tooltip
              cursor={{ stroke: 'rgba(23,23,23,0.12)' }}
              formatter={(v: number, key: string) => [money(v), key === 'draft' ? 'Draft' : 'Net']}
              labelFormatter={(_l, p) => (p?.[0]?.payload?.period ? month(p[0].payload.period) : '')}
              contentStyle={{
                borderRadius: 10,
                border: '1px solid rgba(23,23,23,0.08)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.06)',
                fontSize: 12,
                fontFamily: 'JetBrains Mono',
              }}
              labelStyle={{ color: '#737373', marginBottom: 2 }}
            />
            <Line type="monotone" dataKey="paid" stroke="#525252" strokeWidth={1.75} dot={history.length === 1 ? { r: 3.5, fill: '#3B4A9F', strokeWidth: 0 } : false} activeDot={{ r: 3.5, fill: '#171717', strokeWidth: 0 }} />
            <Line
              type="monotone"
              dataKey="draft"
              stroke="#3B4A9F"
              strokeWidth={1.75}
              strokeDasharray="4 4"
              dot={(p: { cx?: number; cy?: number; index?: number }) =>
                p.index === data.length - 1 && p.cx !== undefined && p.cy !== undefined ? (
                  <g key="draft-dot">
                    <circle cx={p.cx} cy={p.cy} r={7} fill="#3B4A9F" opacity={0.12} />
                    <circle cx={p.cx} cy={p.cy} r={3.5} fill="#3B4A9F" />
                  </g>
                ) : (
                  <g key={`d-${p.index}`} />
                )
              }
              activeDot={{ r: 3.5, fill: '#3B4A9F', strokeWidth: 0 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function NoRun() {
  const { can } = useAuth();
  return (
    <div className="card">
      <EmptyState
        bare
        title="No payroll run yet"
        hint="A run computes every active employee's payslip as A + B − C"
        action={
          can('payroll.manage') && (
            <Link to="/payroll/runs" className="btn-secondary btn-sm">
              Go to payroll
            </Link>
          )
        }
      />
    </div>
  );
}

/* The run as the salary sheet reads it: A + B − C, ruled like a ledger. */
function RunLedger({ run }: { run: NonNullable<NonNullable<Dash['payroll']>['latest']> }) {
  const meta = { A: { label: 'Gross earned', sign: '', total: run.a }, B: { label: 'Additions', sign: '+', total: run.b }, C: { label: 'Deductions', sign: '−', total: run.c } };
  return (
    <div className="card flex flex-col">
      <div className="card-head">
        <p className="card-title">{month(run.periodMonth).split(' ')[0]} run</p>
        <StatusTag value={run.status} />
      </div>

      <div className="flex-1 px-5">
        {run.sections.map((s) => (
          <div key={s.section} className="border-t border-line py-3 first:border-t-0 first:pt-1">
            <div className="flex items-baseline gap-3">
              <span className="num w-4 text-xs text-ink-3">{s.section}</span>
              <span className="flex-1 text-sm">{meta[s.section].label}</span>
              <span className="num text-sm">
                {meta[s.section].sign && <span className="mr-1 text-ink-3">{meta[s.section].sign}</span>}
                {money(meta[s.section].total)}
              </span>
            </div>
            {s.lines.length > 0 && (
              <ul className="mt-1.5 space-y-1 pl-7">
                {s.lines.map((l) => (
                  <li key={l.component} className="flex justify-between gap-3 text-xs text-ink-3">
                    <span className="truncate">{l.component}</span>
                    <span className="num">{money(l.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}

        {/* Double rule under the total, like the bottom of a salary sheet */}
        <div className="flex items-baseline gap-3 border-y-[3px] border-double border-ink/15 py-3">
          <span className="num w-4 text-xs text-ink-3">=</span>
          <span className="flex-1 text-sm font-medium">Net, PKR</span>
          <span className="num text-base font-medium text-brand">{money(run.net)}</span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 px-5 py-4">
        <p className="text-xs text-ink-3">
          <span className="num">{run.headcount}</span> payslips
          {run.prorated > 0 && (
            <>
              , <span className="num">{run.prorated}</span> prorated joiners
            </>
          )}
          {run.increments > 0 && (
            <>
              , <span className="num">{run.increments}</span> increments
            </>
          )}
        </p>
        <Link to={`/payroll/runs/${run.id}`} className="btn-secondary btn-sm shrink-0">
          Review
        </Link>
      </div>
    </div>
  );
}

function LeaveQueue({ rows, total, wide }: { rows: NonNullable<Dash['leave']>['queue']; total: number; wide: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [rejecting, setRejecting] = useState<(typeof rows)[number] | null>(null);
  const [comment, setComment] = useState('');
  const decide = useMutation({
    mutationFn: (v: { id: number; action: 'approve' | 'reject'; comment?: string }) =>
      api(`/leave/applications/${v.id}/${v.action}`, { method: 'POST', body: { comment: v.comment || undefined } }),
    onSuccess: (_r, v) => {
      toast(v.action === 'approve' ? 'Leave approved' : 'Leave rejected');
      setRejecting(null);
      setComment('');
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      void qc.invalidateQueries({ queryKey: ['nav-counts'] });
      void qc.invalidateQueries({ queryKey: ['leave'] });
    },
    onError: (e) => toast(e.message, 'bad'),
  });

  return (
    <div className={`card overflow-hidden ${wide ? 'xl:col-span-2' : 'xl:col-span-3'}`}>
      <div className="card-head">
        <div className="flex items-baseline gap-2">
          <p className="card-title">Leave waiting for you</p>
          <span className="num text-xs text-ink-3">{total}</span>
        </div>
        <Link to="/leave/requests" className="inline-flex items-center gap-1 text-sm text-ink-2 transition-colors hover:text-ink">
          All requests <ArrowRight size={14} strokeWidth={1.5} />
        </Link>
      </div>
      {rows.length === 0 ? (
        <div className="border-t border-line">
          <EmptyState bare title="Nothing waiting" hint="New leave requests from your people show up here" />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="table [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_td]:px-4 [&_th:first-child]:pl-5 [&_th]:px-4">
            <thead>
              <tr>
                <th className="th">Employee</th>
                <th className="th">Type</th>
                <th className="th">Dates</th>
                <th className="th text-right">Days</th>
                <th className="th text-right">Left after</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="row-link" onClick={() => navigate('/leave/requests')}>
                  <td className="td">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{r.name}</span>
                      <SipId id={r.sipId} />
                    </div>
                    <p className="mt-0.5 text-xs text-ink-3">
                      {r.department ? `${r.department}, ` : ''}sent {sentWhen(r.createdAt)}
                    </p>
                  </td>
                  <td className="td">
                    <Tag tone={!r.isPaid || r.unpaidDays > 0 ? 'warn' : 'neutral'}>{r.type}</Tag>
                  </td>
                  <td className="td text-ink-2">{dateRange(r.startDate, r.endDate)}</td>
                  <td className="td num text-right">{days(r.totalDays)}</td>
                  <td className="td text-right">
                    {r.unpaidDays > 0 ? (
                      <span className="text-xs text-warn">{days(r.unpaidDays)} unpaid in {month(r.startDate.slice(0, 7)).split(' ')[0]} pay</span>
                    ) : (
                      <span className="num text-ink-2">{r.balanceAfter === null ? '—' : days(r.balanceAfter)}</span>
                    )}
                  </td>
                  <td className="td" onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-end gap-1">
                      <button
                        onClick={() => setRejecting(r)}
                        className="icon-btn hover:bg-bad-soft hover:text-bad"
                        aria-label={`Reject leave for ${r.name}`}
                        title="Reject"
                        disabled={decide.isPending}
                      >
                        <X {...ICON} />
                      </button>
                      <button
                        onClick={() => decide.mutate({ id: r.id, action: 'approve' })}
                        className="icon-btn hover:bg-good-soft hover:text-good"
                        aria-label={`Approve leave for ${r.name}`}
                        title="Approve"
                        disabled={decide.isPending}
                      >
                        <Check {...ICON} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmModal
        open={!!rejecting}
        title="Reject leave"
        body={rejecting && `${rejecting.name}, ${rejecting.type.toLowerCase()} leave, ${dateRange(rejecting.startDate, rejecting.endDate)}`}
        confirmLabel="Reject"
        danger
        busy={decide.isPending}
        onClose={() => setRejecting(null)}
        onConfirm={() => rejecting && decide.mutate({ id: rejecting.id, action: 'reject', comment })}
      >
        <Field label="Comment" hint="Optional. The employee sees it" className="mt-4">
          <textarea className="input" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
      </ConfirmModal>
    </div>
  );
}

function Pipeline({ data }: { data: NonNullable<Dash['recruitment']> }) {
  const max = Math.max(1, ...data.stages.map((p) => p.count));
  return (
    <div className="card flex flex-col">
      <div className="card-head">
        <div className="flex items-baseline gap-2">
          <p className="card-title">Hiring pipeline</p>
          <span className="num text-xs text-ink-3">{data.open} open</span>
        </div>
        <Link to="/recruitment/pipeline" className="inline-flex items-center gap-1 text-sm text-ink-2 transition-colors hover:text-ink">
          Board <ArrowRight size={14} strokeWidth={1.5} />
        </Link>
      </div>
      <ul className="flex-1 space-y-3 px-5 pb-2">
        {data.stages.map((p) => (
          <li key={p.stage}>
            <div className="flex justify-between text-sm">
              <span className="text-ink-2">{label(p.stage)}</span>
              <span className="num">{p.count}</span>
            </div>
            <div className="mt-1.5">
              <Bar value={p.count} max={max} />
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center justify-between border-t border-line px-5 py-3 text-sm">
        <span className="text-ink-2">Hired this month</span>
        <span className="num font-medium text-brand">{data.hiredThisMonth}</span>
      </div>
    </div>
  );
}

function Activity({ rows, wide }: { rows: NonNullable<Dash['activity']>; wide: boolean }) {
  const { can } = useAuth();
  return (
    <div className={`card ${wide ? 'xl:col-span-2' : 'xl:col-span-3'}`}>
      <div className="card-head">
        <p className="card-title">Recent activity</p>
        {can('audit.view') && (
          <Link to="/admin/audit" className="inline-flex items-center gap-1 text-sm text-ink-2 transition-colors hover:text-ink">
            Audit trail <ArrowRight size={14} strokeWidth={1.5} />
          </Link>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="border-t border-line">
          <EmptyState bare title="No activity yet" hint="Hires, approvals, payroll runs and edits are listed here as they happen" />
        </div>
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {rows.map((a) => (
            <li key={a.id} className="flex items-baseline gap-4 px-5 py-3">
              <span className="num w-20 shrink-0 text-xs text-ink-3">{relative(a.createdAt)}</span>
              <p className="min-w-0 flex-1 text-sm text-ink-2">
                <span className="text-ink">{a.who ?? 'System'}</span> {a.summary}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Blocked({ rows }: { rows: NonNullable<Dash['blocked']> }) {
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <p className="card-title">Can't go active yet</p>
          <p className="text-xs text-ink-3">New hires missing required details or documents</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="border-t border-line">
          <EmptyState bare title="Everyone is active" hint="New hires appear here until their CNIC and contract are on file" />
        </div>
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {rows.map((b) => (
            <li key={b.sipId} className="flex items-center gap-3 px-5 py-3">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{b.name}</span>
                  <SipId id={b.sipId} to={`/employees/${b.sipId}`} />
                </div>
                <p className="mt-0.5 text-xs text-ink-3">{b.missing.length ? `Missing ${b.missing.join(', ')}` : 'Ready to activate'}</p>
              </div>
              <Link to={`/employees/${b.sipId}`} className="btn-secondary btn-sm shrink-0">
                {b.missing.length ? 'Upload' : 'Activate'}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
