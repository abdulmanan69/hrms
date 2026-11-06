import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { attendanceApi, clock, hoursMinutes, spanSec, STATUS_CELL, STATUS_LABEL } from '../../api/attendance';
import { currentMonth } from '../../api/sales';
import { EmptyState, ErrorState, Loading } from '../../components/ui';
import { date, month as monthText } from '../../lib/format';

/** One person's attendance for a month: on the employee profile and in self-service. */
export function AttendancePanel({ sipId }: { sipId: string }) {
  const [ym, setYm] = useState(currentMonth());
  const q = useQuery({ queryKey: ['attendance', 'person', sipId, ym], queryFn: () => attendanceApi.person(sipId, ym) });

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <p className="text-sm font-medium">{monthText(ym)}</p>
        <input type="month" className="input ml-auto w-auto" value={ym} max={currentMonth()} onChange={(e) => e.target.value && setYm(e.target.value)} aria-label="Month" />
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
      ) : (
        (() => {
          const d = q.data!;
          const shown = d.days.filter((x) => x.status && x.day <= d.today).reverse();
          return (
            <>
              <div className="grid grid-cols-2 gap-6 sm:grid-cols-5">
                <Figure label="Present" value={d.totals.present + d.totals.late} />
                <Figure label="Late" value={d.totals.late} />
                <Figure label="Half days" value={d.totals.half_day} />
                <Figure label="Absent" value={d.totals.absent} bad={d.totals.absent > 0} />
                <Figure label="Talk time" value={hoursMinutes(d.totals.talkSec)} />
              </div>
              <div className="mt-6">
                {shown.length === 0 ? (
                  <EmptyState bare title="No attendance this month" hint="Days appear here once the dialer reports calls" />
                ) : (
                  <ul className="divide-y divide-line rounded-lg border border-line">
                    {shown.map((x) => (
                      <li key={x.day} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
                        <span className="num w-24 shrink-0 text-ink-3">{date(x.day, true)}</span>
                        <span className={`inline-flex h-6 items-center rounded-md px-2 text-xs font-medium ${STATUS_CELL[x.status!]}`}>{STATUS_LABEL[x.status!]}</span>
                        {x.calls > 0 && (
                          <span className="num text-ink-2">
                            {clock(x.firstAt, d.settings.timeZone)} – {clock(x.lastAt, d.settings.timeZone)}
                            <span className="text-ink-3"> · {hoursMinutes(spanSec(x))}</span>
                          </span>
                        )}
                        {x.lateMinutes !== null && <span className="num text-xs text-warn">{x.lateMinutes} min late</span>}
                        <span className="num ml-auto text-xs text-ink-3">
                          {x.manual ? `Set by HR${x.note ? `: ${x.note}` : ''}` : x.calls > 0 ? `${x.calls} calls · ${hoursMinutes(x.talkSec)} talk` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          );
        })()
      )}
    </div>
  );
}

function Figure({ label, value, bad }: { label: string; value: number | string; bad?: boolean }) {
  return (
    <div>
      <p className="text-sm text-ink-2">{label}</p>
      <p className={`num mt-1 text-2xl font-medium ${bad ? 'text-bad' : ''}`}>{value}</p>
    </div>
  );
}
