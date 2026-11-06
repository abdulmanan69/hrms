import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { salesApi, type IncentivePlan, type Plan, type SaleRole } from '../../api/sales';
import { Card, CardHead, ErrorState, FormError, ICON, Loading, PageHeader, Segmented, toast } from '../../components/ui';
import { money } from '../../lib/format';

/** Same rules as server/src/services/incentives.ts */
function incentive(sales: number, plan: Plan): number {
  const slabs = [...plan.slabs].filter((s) => s.from >= 1).sort((a, b) => a.from - b.from);
  const idx = slabs.reduce((i, s, k) => (sales >= s.from ? k : i), -1);
  if (idx < 0) return 0;
  if (plan.mode === 'reached') return sales * slabs[idx].rate;
  let total = 0;
  for (let k = 0; k <= idx; k++) {
    const upper = slabs[k + 1] ? slabs[k + 1].from - 1 : sales;
    total += Math.max(0, Math.min(sales, upper) - slabs[k].from + 1) * slabs[k].rate;
  }
  return total;
}

const ROLE_TEXT: Record<SaleRole, { title: string; meta: string }> = {
  closer: { title: 'Closers', meta: 'Paid per sale the person closed' },
  fronter: { title: 'Fronters', meta: 'Paid per transfer that became a sale' },
};

export function IncentiveSlabs() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sales', 'plan'], queryFn: salesApi.plan });
  const [plan, setPlan] = useState<IncentivePlan | null>(null);
  useEffect(() => {
    if (q.data) setPlan(structuredClone(q.data));
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => salesApi.savePlan(plan!),
    onSuccess: (p) => {
      qc.setQueryData(['sales', 'plan'], p);
      void qc.invalidateQueries({ queryKey: ['sales'] });
      toast('Incentive slabs saved');
    },
  });

  if (q.isLoading || (!plan && !q.error)) return <Loading />;
  if (q.error) return <ErrorState message={q.error.message} onRetry={() => q.refetch()} />;
  const p = plan!;
  const set = (role: SaleRole, next: Plan) => setPlan({ ...p, [role]: next });
  const dirty = JSON.stringify(p) !== JSON.stringify(q.data);
  const dupes = (['closer', 'fronter'] as const).some((r) => new Set(p[r].slabs.map((s) => s.from)).size !== p[r].slabs.length);

  return (
    <div>
      <PageHeader
        back={{ to: '/sales', label: 'Sales' }}
        title="Incentive slabs"
        subtitle="What each confirmed sale earns in a month. Payroll uses these rates when it computes a draft run"
        actions={
          <button className="btn-primary" disabled={!dirty || dupes || save.isPending} onClick={() => save.mutate()}>
            Save slabs
          </button>
        }
      />
      <div className="grid gap-4 xl:grid-cols-2">
        {(['closer', 'fronter'] as const).map((role) => (
          <PlanCard key={role} role={role} plan={p[role]} onChange={(next) => set(role, next)} />
        ))}
      </div>
      <Card className="mt-4 p-5">
        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-0.5" checked={p.includeInPayroll} onChange={(e) => setPlan({ ...p, includeInPayroll: e.target.checked })} />
          <span>
            <span className="block text-sm">Add the incentive to payslips</span>
            <span className="mt-0.5 block text-xs text-ink-3">
              Paid in section B as Sales incentive and Fronter incentive, and counted for withholding tax. Approved runs keep the amounts they were approved with
            </span>
          </span>
        </label>
      </Card>
      {dupes && <FormError message="Two slabs start at the same number of sales" />}
      <FormError message={save.error?.message} />
    </div>
  );
}

function PlanCard({ role, plan, onChange }: { role: SaleRole; plan: Plan; onChange: (p: Plan) => void }) {
  const [tryN, setTryN] = useState('12');
  const slabs = plan.slabs;
  const setSlab = (i: number, key: 'from' | 'rate', v: string) => {
    const n = Number(v.replace(/[^\d]/g, '') || 0);
    onChange({ ...plan, slabs: slabs.map((s, k) => (k === i ? { ...s, [key]: n } : s)) });
  };
  const add = () => {
    const last = slabs[slabs.length - 1];
    onChange({ ...plan, slabs: [...slabs, last ? { from: last.from + 10, rate: last.rate } : { from: 1, rate: 0 }] });
  };
  const sorted = [...slabs].sort((a, b) => a.from - b.from);
  const n = Number(tryN) || 0;

  return (
    <Card>
      <CardHead
        title={ROLE_TEXT[role].title}
        meta={ROLE_TEXT[role].meta}
        actions={
          <Segmented
            options={[
              { value: 'reached', label: 'Slab reached' },
              { value: 'stepped', label: 'Per slab' },
            ]}
            value={plan.mode}
            onChange={(mode) => onChange({ ...plan, mode })}
          />
        }
      />
      <div className="px-5 pb-5">
        <p className="mb-4 text-xs text-ink-3">
          {plan.mode === 'reached'
            ? 'Every sale in the month is paid at the rate of the highest slab reached'
            : 'Each sale is paid at the rate of the slab it falls in'}
          . Sales below the first slab earn nothing.
        </p>
        {slabs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-ink-3">No slabs, so {role === 'closer' ? 'closers' : 'fronters'} earn no incentive</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-3">
                <th className="pb-2 font-normal">From sales</th>
                <th className="pb-2 font-normal">Up to</th>
                <th className="pb-2 font-normal">PKR per sale</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {slabs.map((s, i) => {
                const next = sorted.find((x) => x.from > s.from);
                return (
                  <tr key={i}>
                    <td className="py-1 pr-3">
                      <input className="input num w-24" inputMode="numeric" value={s.from} onChange={(e) => setSlab(i, 'from', e.target.value)} aria-label="From sales" />
                    </td>
                    <td className="py-1 pr-3 text-ink-3">{next ? <span className="num">{next.from - 1}</span> : 'and above'}</td>
                    <td className="py-1 pr-3">
                      <input className="input num w-32" inputMode="numeric" value={s.rate} onChange={(e) => setSlab(i, 'rate', e.target.value)} aria-label="PKR per sale" />
                    </td>
                    <td className="py-1 text-right">
                      <button className="btn-ghost btn-sm" aria-label="Remove slab" onClick={() => onChange({ ...plan, slabs: slabs.filter((_, k) => k !== i) })}>
                        <X {...ICON} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button className="btn-secondary btn-sm" onClick={add} disabled={slabs.length >= 20}>
            <Plus {...ICON} className="text-ink-3" /> Add slab
          </button>
          {slabs.length > 0 && (
            <p className="ml-auto flex items-center gap-2 text-sm text-ink-2">
              <input className="input num h-8 w-16" inputMode="numeric" value={tryN} onChange={(e) => setTryN(e.target.value.replace(/[^\d]/g, ''))} aria-label="Try a number of sales" />
              sales earn <span className="num font-medium text-ink">PKR {money(incentive(n, plan))}</span>
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
