import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Card, CardHead, ErrorState, ICON, Loading, PageHeader } from '../../components/ui';
import { leaveApi, leaveKeys } from '../../api/leave';
import { BalanceCards, LeaveDetailModal, LeaveTable, LedgerTable } from './shared';

export function MyLeave() {
  const q = useQuery({ queryKey: leaveKeys.mySummary, queryFn: leaveApi.mySummary });
  const [openId, setOpenId] = useState<number | null>(null);

  return (
    <div className="rise">
      <PageHeader
        eyebrow="Self-service"
        title="My leave"
        actions={
          <Link to="/leave/apply" className="btn-primary">
            <Plus {...ICON} />
            Apply for leave
          </Link>
        }
      />
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
      ) : (
        <>
          <BalanceCards balances={q.data!.balances} />
          <Card className="mt-6 overflow-hidden">
            <CardHead title="My requests" meta="Pending and future approved leave can be cancelled" />
            <LeaveTable
              rows={q.data!.applications}
              showEmployee={false}
              allowCancel
              onOpen={setOpenId}
              emptyTitle="No leave requests yet"
              emptyIllustration="leave.empty"
              emptyHint="Use Apply for leave; your requests and their status show here"
            />
          </Card>
          <Card className="mt-6 overflow-hidden">
            <CardHead title="Balance history" meta="Every grant, leave taken and adjustment, newest first" />
            <LedgerTable entries={q.data!.ledger} />
          </Card>
        </>
      )}
      <LeaveDetailModal id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
