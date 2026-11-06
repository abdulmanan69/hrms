import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { payrollApi, type NegativeNet, type Run, type Skipped } from '../../api/payroll';
import { EmptyState, ErrorState, Field, FormError, ICON, Loading, Modal, PageHeader, StatusTag } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { money, month } from '../../lib/format';
import { SkippedList } from './shared';

function nextMonth(runs: Run[]): string {
  const now = new Date();
  const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const taken = new Set(runs.map((r) => r.periodMonth));
  if (!taken.has(current)) return current;
  const latest = runs.map((r) => r.periodMonth).sort().pop()!;
  const [y, m] = latest.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

export function PayrollRuns() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const runs = useQuery({ queryKey: ['payroll', 'runs'], queryFn: payrollApi.runs });
  const [creating, setCreating] = useState(false);

  return (
    <div>
      <PageHeader
        eyebrow="Payroll"
        title="Payroll runs"
        subtitle="One run per month: gross earned, plus additions, minus deductions"
        actions={
          can('payroll.manage') && (
            <button className="btn-primary" onClick={() => setCreating(true)} disabled={!runs.data}>
              <Plus {...ICON} /> Run payroll
            </button>
          )
        }
      />

      {runs.isLoading ? (
        <Loading />
      ) : runs.error ? (
        <ErrorState message={runs.error.message} onRetry={() => runs.refetch()} />
      ) : runs.data!.data.length === 0 ? (
        <EmptyState
          title="No payroll runs yet"
          hint="Run payroll for a month to compute a payslip for every active employee with a salary structure"
          action={
            can('payroll.manage') && (
              <button className="btn-primary" onClick={() => setCreating(true)}>
                <Plus {...ICON} /> Run payroll
              </button>
            )
          }
        />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="th">Month</th>
                  <th className="th">Status</th>
                  <th className="th text-right">Payslips</th>
                  <th className="th text-right">A gross earned</th>
                  <th className="th text-right">B additions</th>
                  <th className="th text-right">C deductions</th>
                  <th className="th text-right">Net, PKR</th>
                </tr>
              </thead>
              <tbody>
                {runs.data!.data.map((r) => (
                  <tr key={r.id} className="row-link" onClick={() => navigate(`/payroll/runs/${r.id}`)}>
                    <td className="td font-medium">{month(r.periodMonth)}</td>
                    <td className="td">
                      <StatusTag value={r.status} />
                    </td>
                    <td className="td num text-right">{r.headcount}</td>
                    <td className="td num text-right">{money(r.totalA)}</td>
                    <td className="td num text-right text-ink-2">{money(r.totalB)}</td>
                    <td className="td num text-right text-ink-2">{money(r.totalC)}</td>
                    <td className="td num text-right font-medium">{money(r.totalNet)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {creating && runs.data && <CreateRunModal suggested={nextMonth(runs.data.data)} onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateRunModal({ suggested, onClose }: { suggested: string; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [ym, setYm] = useState(suggested);
  const [result, setResult] = useState<{ run: Run; skipped: Skipped[]; negative: NegativeNet[] } | null>(null);
  const create = useMutation({
    mutationFn: () => payrollApi.createRun(ym),
    onSuccess: (res) => {
      setResult(res);
      void qc.invalidateQueries({ queryKey: ['payroll'] });
    },
  });

  if (result) {
    return (
      <Modal
        open
        title={`${month(result.run.periodMonth)} run created`}
        onClose={onClose}
        footer={
          <>
            <button className="btn-secondary" onClick={onClose}>
              Close
            </button>
            <button className="btn-primary" onClick={() => navigate(`/payroll/runs/${result.run.id}`)}>
              Review run
            </button>
          </>
        }
      >
        <p className="text-sm text-ink-2">
          <span className="num text-ink">{result.run.headcount}</span> payslips computed in draft, net{' '}
          <span className="num text-ink">{money(result.run.totalNet)}</span> PKR.
        </p>
        {result.negative.length > 0 && (
          <p className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">
            Net pay is negative for {result.negative.map((n) => n.name).join(', ')}
          </p>
        )}
        <SkippedList skipped={result.skipped} title="Not included" />
      </Modal>
    );
  }

  return (
    <Modal
      open
      title="Run payroll"
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!/^\d{4}-\d{2}$/.test(ym) || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Computing' : 'Run payroll'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Month" hint="Active employees with a salary structure by month end get a payslip">
          <input type="month" className="input" value={ym} onChange={(e) => setYm(e.target.value)} />
        </Field>
        <p className="text-sm text-ink-3">The run starts as a draft. You can add additions and deductions, recompute, then approve.</p>
        <FormError message={create.error?.message} />
      </div>
    </Modal>
  );
}
