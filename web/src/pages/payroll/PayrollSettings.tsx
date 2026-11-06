import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { payrollApi, type PayrollRules, type WhtSlab } from '../../api/payroll';
import { ErrorState, Field, FormError, ICON, Loading, PageHeader, Segmented, toast } from '../../components/ui';
import { money } from '../../lib/format';
import { MoneyInput } from './shared';

type SlabDraft = { to: string; fixed: string; rate: string };

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function PayrollSettings() {
  const q = useQuery({ queryKey: ['payroll', 'rules'], queryFn: payrollApi.rules });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState message={q.error.message} onRetry={() => q.refetch()} />;
  return <RulesForm rules={q.data!} />;
}

function RulesForm({ rules }: { rules: PayrollRules }) {
  const qc = useQueryClient();
  const [pf, setPf] = useState(String(rules.pfPercentOfBasic));
  const [eobi, setEobi] = useState(String(rules.eobiEmployeeAmount));
  const [basis, setBasis] = useState(rules.prorationBasis);
  const [slabs, setSlabs] = useState<SlabDraft[]>([]);

  useEffect(() => {
    setSlabs(rules.whtSlabs.map((s) => ({ to: s.to === null ? '' : String(s.to), fixed: String(s.fixed), rate: String(s.rate) })));
  }, [rules]);

  // Each slab starts where the previous one ends, so only the upper bound is typed.
  const built: WhtSlab[] = slabs.map((s, i) => ({
    from: i === 0 ? 0 : Number(slabs[i - 1].to || 0),
    to: i === slabs.length - 1 ? null : Number(s.to || 0),
    fixed: Number(s.fixed || 0),
    rate: Number(s.rate || 0),
  }));

  const save = useMutation({
    mutationFn: () =>
      payrollApi.saveRules({ pfPercentOfBasic: Number(pf), eobiEmployeeAmount: Number(eobi || 0), prorationBasis: basis, whtSlabs: built }),
    onSuccess: () => {
      toast('Payroll rules saved');
      void qc.invalidateQueries({ queryKey: ['payroll'] });
    },
  });

  const set = (i: number, k: keyof SlabDraft, v: string) => setSlabs((xs) => xs.map((s, j) => (j === i ? { ...s, [k]: v } : s)));

  return (
    <div>
      <PageHeader
        eyebrow="Payroll"
        title="Payroll rules"
        subtitle="Used by every draft run when it is created or recomputed. Approved runs keep the figures they were approved with"
        actions={
          <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
            Save rules
          </button>
        }
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="card xl:col-span-2">
          <div className="card-head">
            <div>
              <p className="card-title">Withholding tax slabs</p>
              <p className="text-xs text-ink-3">Annual taxable pay in PKR. Monthly tax = tax on (A + B) × 12, divided by 12</p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="th">Above</th>
                  <th className="th">Up to</th>
                  <th className="th">Fixed tax</th>
                  <th className="th">Rate on the excess, %</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody>
                {slabs.map((s, i) => (
                  <tr key={i}>
                    <td className="td num text-ink-2">{money(built[i].from)}</td>
                    <td className="td w-44">
                      {i === slabs.length - 1 ? <span className="text-ink-3">No limit</span> : <MoneyInput value={s.to} onChange={(v) => set(i, 'to', v)} />}
                    </td>
                    <td className="td w-40">
                      <MoneyInput value={s.fixed} onChange={(v) => set(i, 'fixed', v)} />
                    </td>
                    <td className="td w-32">
                      <input className="input num text-right" inputMode="decimal" value={s.rate} onChange={(e) => set(i, 'rate', e.target.value.replace(/[^\d.]/g, ''))} />
                    </td>
                    <td className="td w-12 text-right">
                      {slabs.length > 1 && (
                        <button className="icon-btn" aria-label="Remove slab" title="Remove slab" onClick={() => setSlabs((xs) => xs.filter((_, j) => j !== i))}>
                          <X {...ICON} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-line px-5 py-3">
            <button
              className="btn-ghost btn-sm"
              onClick={() =>
                setSlabs((xs) => {
                  const last = xs[xs.length - 1];
                  const prevTo = xs.length > 1 ? Number(xs[xs.length - 2].to || 0) : 0;
                  return [...xs.slice(0, -1), { ...last, to: String(prevTo + 1_000_000) }, { to: '', fixed: '0', rate: '0' }];
                })
              }
            >
              <Plus {...ICON} /> Add slab
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <p className="card-title">Deductions and proration</p>
          </div>
          <div className="space-y-4 px-5 pb-5">
            <Field label="Provident fund, % of basic" hint="Employee share, taken from the earned basic">
              <input className="input num text-right" inputMode="decimal" value={pf} onChange={(e) => setPf(e.target.value.replace(/[^\d.]/g, ''))} />
            </Field>
            <Field label="EOBI, PKR a month" hint="Fixed employee contribution in any month with a paid day">
              <MoneyInput value={eobi} onChange={setEobi} />
            </Field>
            <div>
              <span className="mb-1.5 block text-sm text-ink-2">Proration basis</span>
              <Segmented
                value={basis}
                onChange={setBasis}
                options={[
                  { value: 'calendar', label: 'Calendar days' },
                  { value: 'working', label: 'Working days' },
                ]}
              />
              <p className="mt-1.5 text-xs text-ink-3">
                {basis === 'calendar'
                  ? 'Daily rate = monthly gross ÷ days in the month'
                  : `Daily rate = monthly gross ÷ working days; weekends are ${(rules.weekendDays ?? []).map((d) => DAY_NAMES[d]).join(' and ') || 'not set'} from the leave calendar`}
              </p>
            </div>
            <FormError message={save.error?.message} />
          </div>
        </div>
      </div>
    </div>
  );
}
