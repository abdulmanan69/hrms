import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, SlidersHorizontal } from 'lucide-react';
import { Card, CardHead, ErrorState, ICON, Loading } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { leaveApi, leaveKeys } from '../../api/leave';
import { AdjustModal, BalanceCards, LeaveDetailModal, LeaveTable, LedgerTable } from './shared';

/** Leave tab on the employee profile. Owned by the leave module. */
export function EmployeeLeavePanel({ sipId }: { sipId: string }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: leaveKeys.summary(sipId), queryFn: () => leaveApi.summary(sipId) });
  const [openId, setOpenId] = useState<number | null>(null);
  const [adjusting, setAdjusting] = useState(false);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState message={q.error.message} onRetry={() => q.refetch()} />;
  const s = q.data!;
  const manage = can('leave.manage');

  return (
    <div>
      {manage && (
        <div className="mb-4 flex justify-end gap-2">
          <Link to={`/leave/apply?sipId=${encodeURIComponent(s.employee.sipId)}&name=${encodeURIComponent(s.employee.name)}`} className="btn-secondary">
            <Plus {...ICON} className="text-ink-3" />
            Apply on their behalf
          </Link>
          <button className="btn-secondary" onClick={() => setAdjusting(true)}>
            <SlidersHorizontal {...ICON} className="text-ink-3" />
            Adjust balance
          </button>
        </div>
      )}
      <BalanceCards balances={s.balances} />
      <Card className="mt-6 overflow-hidden">
        <CardHead title="Leave requests" />
        <LeaveTable
          rows={s.applications}
          showEmployee={false}
          allowCancel
          onOpen={setOpenId}
          emptyTitle="No leave requests"
          emptyHint={`Requests ${s.employee.name} sends show here`}
        />
      </Card>
      <Card className="mt-6 overflow-hidden">
        <CardHead title="Balance history" meta="Grants, leave taken and adjustments, newest first" />
        <LedgerTable entries={s.ledger} />
      </Card>
      <LeaveDetailModal id={openId} onClose={() => setOpenId(null)} />
      <AdjustModal open={adjusting} person={{ sipId: s.employee.sipId, name: s.employee.name }} onClose={() => setAdjusting(false)} />
    </div>
  );
}
