import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SlidersHorizontal } from 'lucide-react';
import {
  attendanceApi,
  clock,
  hoursMinutes,
  MANUAL_STATUSES,
  spanSec,
  STATUS_CELL,
  STATUS_LABEL,
  STATUS_MARK,
  type AttendanceSettings,
  type AttendanceStatus,
  type Grid,
  type GridRow,
  type ManualStatus,
  type PersonDay,
} from '../../api/attendance';
import { currentMonth } from '../../api/sales';
import { employeesApi } from '../../api/employees';
import { EmptyState, ErrorState, Field, FormError, ICON, Loading, Modal, PageHeader, SearchInput, Stat, toast, useDebounced } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { date, month as monthText, relative } from '../../lib/format';

const LEGEND: AttendanceStatus[] = ['present', 'late', 'half_day', 'absent', 'leave', 'off'];

export function Attendance() {
  const { can } = useAuth();
  const manage = can('attendance.manage');
  const [ym, setYm] = useState(currentMonth());
  const [dept, setDept] = useState<number | ''>('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 250);
  const [editing, setEditing] = useState<{ row: GridRow; day: PersonDay } | null>(null);
  const [rules, setRules] = useState(false);
  const depts = useQuery({ queryKey: ['employees', 'org', 'departments'], queryFn: () => employeesApi.departments() });
  const grid = useQuery({
    queryKey: ['attendance', 'grid', ym, dept, q],
    queryFn: () => attendanceApi.grid({ month: ym, department: dept || undefined, q: q || undefined }),
  });

  return (
    <div>
      <PageHeader
        eyebrow="Attendance"
        title={monthText(ym)}
        subtitle="Shift days from the dialer: first and last call, judged by the attendance rules"
        actions={
          <>
            <input type="month" className="input w-auto" value={ym} max={currentMonth()} onChange={(e) => e.target.value && setYm(e.target.value)} aria-label="Month" />
            {manage && (
              <button className="btn-secondary" onClick={() => setRules(true)}>
                <SlidersHorizontal {...ICON} className="text-ink-3" /> Rules
              </button>
            )}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search name or SIP ID" className="w-full sm:w-64" />
        <select className="input w-auto" value={dept} onChange={(e) => setDept(e.target.value ? Number(e.target.value) : '')} aria-label="Department">
          <option value="">All departments</option>
          {depts.data?.data.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <Legend />
      </div>

      {grid.isLoading ? (
        <Loading />
      ) : grid.error ? (
        <ErrorState message={grid.error.message} onRetry={() => grid.refetch()} />
      ) : (
        <GridView g={grid.data!} manage={manage} onEdit={(row, day) => setEditing({ row, day })} />
      )}

      {editing && grid.data && <DayModal row={editing.row} day={editing.day} settings={grid.data.settings} onClose={() => setEditing(null)} />}
      {rules && <RulesModal onClose={() => setRules(false)} />}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-ink-3 sm:ml-auto">
      {LEGEND.map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5">
          <span className={`inline-grid h-4 w-4 place-items-center rounded text-[10px] font-medium ${STATUS_CELL[s]}`}>{STATUS_MARK[s]}</span>
          {STATUS_LABEL[s]}
        </span>
      ))}
    </div>
  );
}

function GridView({ g, manage, onEdit }: { g: Grid; manage: boolean; onEdit: (row: GridRow, day: PersonDay) => void }) {
  const totals = useMemo(() => {
    const t = { present: 0, late: 0, absent: 0, half: 0, people: g.data.length };
    for (const r of g.data) {
      t.present += r.totals.present + r.totals.late;
      t.late += r.totals.late;
      t.absent += r.totals.absent;
      t.half += r.totals.half_day;
    }
    return t;
  }, [g]);

  if (g.data.length === 0) return <EmptyState title="Nobody to show" hint="No active employees match this filter" />;
  const days = g.data[0].days.map((d) => d.day);
  const noData = !g.lastSync;

  return (
    <>
      <div className="mb-6 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Stat label="Days present" value={totals.present} note={`${totals.people} people`} />
        <Stat label="Late" value={totals.late} note={g.settings.shiftStart ? `After ${g.settings.shiftStart} + ${g.settings.lateAfterMinutes} min` : 'No shift start set'} />
        <Stat label="Half days" value={totals.half} note={`Under ${g.settings.halfDayBelowHours} hours on the dialer`} />
        <Stat label="Absent" value={totals.absent} note={g.lastSync ? `Dialer data ${relative(g.lastSync)}` : 'No dialer data yet'} />
      </div>

      {noData && (
        <div className="card mb-6 px-5 py-4 text-sm text-ink-2">
          No dialer activity has arrived yet. The QA platform sends each agent's first and last call every hour; days fill in from then.
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 min-w-[200px] border-b border-line bg-surface px-4 py-2.5 text-left text-xs font-normal text-ink-3">Employee</th>
              {days.map((d) => {
                const n = new Date(d + 'T00:00:00Z');
                const weekend = n.getUTCDay() === 0 || n.getUTCDay() === 6;
                return (
                  <th key={d} className={`num w-7 min-w-[28px] border-b border-line px-0 py-2.5 text-center font-normal ${d === g.today ? 'text-brand' : weekend ? 'text-ink-3/60' : 'text-ink-3'}`}>
                    {n.getUTCDate()}
                  </th>
                );
              })}
              <th className="num border-b border-line px-3 py-2.5 text-right font-normal text-ink-3">P</th>
              <th className="num border-b border-line px-3 py-2.5 text-right font-normal text-ink-3">L</th>
              <th className="num border-b border-line px-3 py-2.5 text-right font-normal text-ink-3">A</th>
              <th className="num border-b border-line px-3 py-2.5 pr-4 text-right font-normal text-ink-3">Talk</th>
            </tr>
          </thead>
          <tbody>
            {g.data.map((r) => (
              <tr key={r.sipId} className="group">
                <td className="sticky left-0 z-10 border-b border-line bg-surface px-4 py-1.5 group-hover:bg-raised">
                  <Link to={`/employees/${encodeURIComponent(r.sipId)}`} className="block truncate text-sm text-ink hover:underline">
                    {r.name}
                  </Link>
                  <span className="num text-[11px] text-ink-3">{r.sipId}</span>
                </td>
                {r.days.map((d) => (
                  <td key={d.day} className="border-b border-line p-0.5 text-center group-hover:bg-raised">
                    <Cell d={d} tz={g.settings.timeZone} onClick={manage && d.day <= g.today ? () => onEdit(r, d) : undefined} />
                  </td>
                ))}
                <td className="num border-b border-line px-3 text-right group-hover:bg-raised">{r.totals.present + r.totals.late}</td>
                <td className="num border-b border-line px-3 text-right text-warn group-hover:bg-raised">{r.totals.late || ''}</td>
                <td className="num border-b border-line px-3 text-right text-bad group-hover:bg-raised">{r.totals.absent || ''}</td>
                <td className="num border-b border-line px-3 pr-4 text-right text-ink-2 group-hover:bg-raised">{r.totals.talkSec ? hoursMinutes(r.totals.talkSec) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-ink-3">
        Shift days run from {g.settings.dayStartsAt} to {g.settings.dayStartsAt} the next day ({g.settings.timeZone}), dated the day they begin.
        {manage && ' Click a day to set it by hand.'}
      </p>
    </>
  );
}

function Cell({ d, tz, onClick }: { d: PersonDay; tz: string; onClick?: () => void }) {
  const title = d.status
    ? `${date(d.day, true)}: ${STATUS_LABEL[d.status]}${d.calls ? `, ${clock(d.firstAt, tz)} – ${clock(d.lastAt, tz)}, ${d.calls} calls` : ''}${d.lateMinutes ? `, ${d.lateMinutes} min late` : ''}${d.manual ? ', set by HR' : ''}${d.note ? ` (${d.note})` : ''}`
    : date(d.day, true);
  const cls = d.status ? STATUS_CELL[d.status] : 'text-ink-3';
  const inner = (
    <span className={`relative grid h-6 w-6 place-items-center rounded text-[11px] font-medium ${cls}`}>
      {d.status ? STATUS_MARK[d.status] : ''}
      {d.manual && <span className="absolute right-0.5 top-0.5 h-1 w-1 rounded-full bg-current" />}
    </span>
  );
  return onClick ? (
    <button type="button" title={title} onClick={onClick} className="mx-auto block rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
      {inner}
    </button>
  ) : (
    <span title={title} className="mx-auto block w-fit">
      {inner}
    </span>
  );
}

function DayModal({ row, day, settings, onClose }: { row: GridRow; day: PersonDay; settings: AttendanceSettings; onClose: () => void }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<ManualStatus>(day.manual && day.status && day.status !== 'working' ? day.status : 'present');
  const [note, setNote] = useState(day.note ?? '');
  const done = (msg: string) => {
    qc.invalidateQueries({ queryKey: ['attendance'] });
    toast(msg);
    onClose();
  };
  const save = useMutation({ mutationFn: () => attendanceApi.setDay(row.sipId, day.day, { status, note: note.trim() || null }), onSuccess: () => done('Day saved') });
  const clear = useMutation({ mutationFn: () => attendanceApi.clearDay(row.sipId, day.day), onSuccess: () => done('Handed back to the dialer') });

  return (
    <Modal
      open
      onClose={onClose}
      title={`${row.name}, ${date(day.day)}`}
      description={
        day.calls > 0
          ? `Dialer: ${clock(day.firstAt, settings.timeZone)} – ${clock(day.lastAt, settings.timeZone)} (${hoursMinutes(spanSec(day))}), ${day.calls} calls, ${hoursMinutes(day.talkSec)} talk`
          : 'No dialer activity on this shift day'
      }
      footer={
        <>
          {day.manual && (
            <button className="btn-secondary mr-auto" onClick={() => clear.mutate()} disabled={clear.isPending}>
              Use the dialer again
            </button>
          )}
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
            Save
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Status">
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as ManualStatus)}>
            {MANUAL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note" hint="Why the day differs from the dialer, e.g. field visit or dialer outage">
          <input className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <FormError message={(save.error ?? clear.error)?.message} />
      </div>
    </Modal>
  );
}

function RulesModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['attendance', 'settings'], queryFn: attendanceApi.settings });
  const [s, setS] = useState<AttendanceSettings | null>(null);
  const v = s ?? q.data ?? null;
  const set = (patch: Partial<AttendanceSettings>) => setS({ ...(v as AttendanceSettings), ...patch });
  const save = useMutation({
    mutationFn: () => attendanceApi.saveSettings(v!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['attendance'] });
      toast('Attendance rules saved');
      onClose();
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Attendance rules"
      description="Applied when a day is shown, so a change also re-judges past days"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => save.mutate()} disabled={!v || save.isPending}>
            Save rules
          </button>
        </>
      }
    >
      {!v ? (
        <Loading />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Shift day starts at" hint="A night shift is one day, dated the evening it began">
            <input type="time" className="input" value={v.dayStartsAt} onChange={(e) => set({ dayStartsAt: e.target.value })} />
          </Field>
          <Field label="Time zone">
            <input className="input" value={v.timeZone} onChange={(e) => set({ timeZone: e.target.value })} />
          </Field>
          <Field label="Shift starts at" hint="Leave empty to not judge lateness">
            <input type="time" className="input" value={v.shiftStart ?? ''} onChange={(e) => set({ shiftStart: e.target.value || null })} />
          </Field>
          <Field label="Late after, minutes">
            <input type="number" min={0} max={240} className="input" value={v.lateAfterMinutes} onChange={(e) => set({ lateAfterMinutes: Number(e.target.value) })} />
          </Field>
          <Field label="Half day below, hours" hint="First to last call">
            <input type="number" min={0} max={24} step={0.5} className="input" value={v.halfDayBelowHours} onChange={(e) => set({ halfDayBelowHours: Number(e.target.value) })} />
          </Field>
          <Field label="Mark absent">
            <select className="input" value={v.absentFor} onChange={(e) => set({ absentFor: e.target.value as AttendanceSettings['absentFor'] })}>
              <option value="dialer_agents">Agents who dialed in the last 30 days</option>
              <option value="everyone">Every active employee</option>
              <option value="none">Nobody</option>
            </select>
          </Field>
          <p className="text-xs text-ink-3 sm:col-span-2">Weekends and public holidays come from the Leave settings. Approved leave shows as leave.</p>
          <div className="sm:col-span-2">
            <FormError message={save.error?.message} />
          </div>
        </div>
      )}
    </Modal>
  );
}
