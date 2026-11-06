import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { currentMonth, ROLE_LABEL, salesApi, type IncentiveResult } from '../../api/sales';
import { EmptyState, ErrorState, Loading } from '../../components/ui';
import { date, money, month as monthText } from '../../lib/format';

/** One person's sales and incentive for a month: on the employee profile and in self-service. */
export function SalesPanel({ sipId }: { sipId: string }) {
  const [ym, setYm] = useState(currentMonth());
  const q = useQuery({ queryKey: ['sales', 'person', sipId, ym], queryFn: () => salesApi.person(sipId, ym) });

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
        <>
          <div className="grid gap-6 sm:grid-cols-3">
            <Figure label="Sales closed" value={String(q.data!.counts.closer)} />
            <Figure label="Fronter credits" value={String(q.data!.counts.fronter)} />
            <Figure label="Incentive, PKR" value={money(q.data!.incentive.total)} accent />
          </div>
          <div className="mt-5 space-y-2">
            <Working label="Closer" r={q.data!.incentive.closer} hasSlabs={q.data!.plan.closer.slabs.length > 0} />
            <Working label="Fronter" r={q.data!.incentive.fronter} hasSlabs={q.data!.plan.fronter.slabs.length > 0} />
          </div>
          <div className="mt-6">
            {q.data!.sales.length === 0 ? (
              <EmptyState bare title="No sales this month" />
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {q.data!.sales.map((s) => (
                  <li key={s.id} className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-sm ${s.status === 'void' ? 'text-ink-3' : ''}`}>
                    <span className="num w-20 shrink-0 text-ink-3">{date(s.saleDate, true)}</span>
                    <span className={s.status === 'void' ? 'line-through' : ''}>{ROLE_LABEL[s.role]}</span>
                    <span className="truncate text-ink-2">{s.reference ?? ''}</span>
                    <span className="ml-auto text-xs text-ink-3">
                      {s.status === 'void' ? `Voided: ${s.voidReason}` : s.source === 'manual' ? 'Recorded by hand' : s.source === 'vicidial' ? 'VICIdial' : s.source}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Figure({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <p className="text-sm text-ink-2">{label}</p>
      <p className={`num mt-1 text-2xl font-medium ${accent ? 'text-brand' : ''}`}>{value}</p>
    </div>
  );
}

/** "12 sales × 500 = 6,000 · 8 more for the next slab" */
function Working({ label, r, hasSlabs }: { label: string; r: IncentiveResult; hasSlabs: boolean }) {
  if (r.sales === 0 || !hasSlabs) return null;
  return (
    <p className="text-xs text-ink-3">
      <span className="text-ink-2">{label}:</span>{' '}
      {r.steps.length === 0
        ? `${r.sales} sales, below the target`
        : r.steps
            .filter((s) => s.count > 0)
            .map((s) => `${s.count} × ${money(s.rate)}`)
            .join(' + ') + ` = ${money(r.amount)}`}
      {r.toNext !== null && `, ${r.toNext} more for the next slab`}
    </p>
  );
}
