import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { Card, ConfirmModal, EmptyState, ErrorState, ICON, Loading, PageHeader, SearchInput, SipId, toast, useDebounced } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { days } from '../../lib/format';
import { leaveApi, leaveKeys, orgApi } from '../../api/leave';
import { AdjustModal } from './shared';

export function LeaveBalances() {
  const { can } = useAuth();
  const manage = can('leave.manage');
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState<number | ''>('');
  const term = useDebounced(search);
  const query = { search: term, departmentId };
  const q = useQuery({ queryKey: leaveKeys.balances(query), queryFn: () => leaveApi.balances(query), placeholderData: (p) => p });
  const depts = useQuery({ queryKey: ['leave', 'departments'], queryFn: orgApi.departments });
  const [adjust, setAdjust] = useState<{ sipId: string; name: string } | null | 'pick'>(null);
  const [confirmAccrual, setConfirmAccrual] = useState(false);
  const accrue = useMutation({
    mutationFn: leaveApi.runAccruals,
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: leaveKeys.all });
      setConfirmAccrual(false);
      toast(r.written > 0 ? `Accruals done: ${r.written} ledger ${r.written === 1 ? 'entry' : 'entries'} written` : 'Accruals done: nothing was due');
    },
  });

  return (
    <div className="rise">
      <PageHeader
        eyebrow="Leave"
        title="Leave balances"
        subtitle="Current balance per paid leave type for every active employee"
        actions={
          <>
            <a className="btn-secondary" href={leaveApi.balancesCsvUrl(query)}>
              <Download {...ICON} className="text-ink-3" />
              Export CSV
            </a>
            {manage && (
              <>
                <button className="btn-secondary" onClick={() => setConfirmAccrual(true)}>
                  <RefreshCw {...ICON} className="text-ink-3" />
                  Run accruals now
                </button>
                <button className="btn-primary" onClick={() => setAdjust('pick')}>
                  <SlidersHorizontal {...ICON} />
                  Adjust balance
                </button>
              </>
            )}
          </>
        }
      />

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <SearchInput value={search} onChange={setSearch} placeholder="Search name or SIP ID" className="w-64" />
          <select className="input w-48" value={departmentId} onChange={(e) => setDepartmentId(e.target.value ? Number(e.target.value) : '')} aria-label="Department">
            <option value="">Any department</option>
            {depts.data?.data.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        {q.isLoading ? (
          <div className="p-5">
            <Loading inline />
          </div>
        ) : q.error ? (
          <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
        ) : q.data!.data.length === 0 ? (
          <EmptyState
            bare
            title={term || departmentId ? 'No one matches' : 'No active employees'}
            hint={term || departmentId ? 'Clear the search or department to see everyone' : 'Balances appear once employees are active'}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="th">Employee</th>
                  {q.data!.types.map((t) => (
                    <th key={t.id} className="th text-right">
                      {t.name}
                      <span className="ml-1 text-ink-3">/ {days(t.entitlement)}</span>
                    </th>
                  ))}
                  {manage && <th className="th" />}
                </tr>
              </thead>
              <tbody>
                {q.data!.data.map((r) => (
                  <tr key={r.sipId}>
                    <td className="td">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{r.name}</span>
                        <SipId id={r.sipId} to={`/employees/${r.sipId}`} />
                      </div>
                      {r.departmentName && <p className="mt-0.5 text-xs text-ink-3">{r.departmentName}</p>}
                    </td>
                    {q.data!.types.map((t) => {
                      const v = r.balances[String(t.id)] ?? 0;
                      return (
                        <td key={t.id} className={`td num text-right ${v < 0 ? 'text-bad' : v === 0 ? 'text-ink-3' : ''}`}>
                          {days(v)}
                        </td>
                      );
                    })}
                    {manage && (
                      <td className="td text-right">
                        <button className="btn-ghost btn-sm" onClick={() => setAdjust({ sipId: r.sipId, name: r.name })}>
                          Adjust
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <AdjustModal open={adjust !== null} person={adjust === 'pick' ? null : adjust} onClose={() => setAdjust(null)} />
      <ConfirmModal
        open={confirmAccrual}
        title="Run accruals now"
        body="Grants any leave that is due today: annual grants, monthly accruals and year-end carry-forward. Grants already written are skipped, so running it twice changes nothing."
        confirmLabel="Run accruals"
        busy={accrue.isPending}
        onConfirm={() => accrue.mutate()}
        onClose={() => setConfirmAccrual(false)}
      >
        {accrue.error && <p className="mt-3 text-sm text-bad">{accrue.error.message}</p>}
      </ConfirmModal>
    </div>
  );
}
