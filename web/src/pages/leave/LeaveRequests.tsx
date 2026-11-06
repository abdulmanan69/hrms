import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Card, CardHead, ErrorState, ICON, Loading, PageHeader, Pagination, SearchInput, Tabs, useDebounced } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { leaveApi, leaveKeys, orgApi, type ApplicationFilters, type LeaveStatus } from '../../api/leave';
import { LeaveDetailModal, LeaveTable } from './shared';

type Tab = 'waiting' | 'all' | 'calendar';

export function LeaveRequests() {
  const { can } = useAuth();
  const approver = can('leave.approve', 'leave.approve.team');
  const [tab, setTab] = useState<Tab>(approver ? 'waiting' : 'all');
  const [openId, setOpenId] = useState<number | null>(null);

  const waitingFilters: ApplicationFilters = { scope: 'mine-to-approve', pageSize: 100 };
  const waiting = useQuery({ queryKey: leaveKeys.applications(waitingFilters), queryFn: () => leaveApi.applications(waitingFilters), enabled: approver });

  const tabs: Array<{ value: Tab; label: string; count?: number }> = [
    ...(approver ? [{ value: 'waiting' as const, label: 'Waiting for you', count: waiting.data?.meta.total }] : []),
    { value: 'all', label: 'All requests' },
    { value: 'calendar', label: 'On leave today and upcoming' },
  ];

  return (
    <div className="rise">
      <PageHeader
        eyebrow="Leave"
        title="Leave requests"
        actions={
          <Link to="/leave/apply" className="btn-primary">
            <Plus {...ICON} />
            Apply for leave
          </Link>
        }
      />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'waiting' &&
        (waiting.isLoading ? (
          <Loading />
        ) : waiting.error ? (
          <ErrorState message={waiting.error.message} onRetry={() => waiting.refetch()} />
        ) : (
          <Card className="overflow-hidden">
            <CardHead title="Waiting for you" meta="Oldest first. Balance after shows what approving now would leave" />
            <LeaveTable
              rows={waiting.data?.data ?? []}
              showStatus={false}
              onOpen={setOpenId}
              emptyTitle="Nothing waiting"
              emptyHint="New requests from the people you approve for show up here"
            />
          </Card>
        ))}

      {tab === 'all' && <AllRequests onOpen={setOpenId} />}
      {tab === 'calendar' && <OnLeave onOpen={setOpenId} />}

      <LeaveDetailModal id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function AllRequests({ onOpen }: { onOpen: (id: number) => void }) {
  const [status, setStatus] = useState<LeaveStatus | 'all'>('all');
  const [leaveTypeId, setLeaveTypeId] = useState<number | ''>('');
  const [departmentId, setDepartmentId] = useState<number | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const term = useDebounced(search);
  const filters: ApplicationFilters = { scope: 'all', status, leaveTypeId, departmentId, from, to, search: term, page, pageSize: 25 };
  const q = useQuery({ queryKey: leaveKeys.applications(filters), queryFn: () => leaveApi.applications(filters), placeholderData: (p) => p });
  const types = useQuery({ queryKey: leaveKeys.types(true), queryFn: () => leaveApi.types(true) });
  const depts = useQuery({ queryKey: ['leave', 'departments'], queryFn: orgApi.departments });
  const set = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v);
    setPage(1);
  };
  const filtered = status !== 'all' || leaveTypeId !== '' || departmentId !== '' || from || to || term;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-end gap-3 px-5 py-4">
        <SearchInput value={search} onChange={set(setSearch)} placeholder="Search name or SIP ID" className="w-64" />
        <select className="input w-36" value={status} onChange={(e) => set(setStatus)(e.target.value as LeaveStatus | 'all')} aria-label="Status">
          <option value="all">Any status</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select className="input w-40" value={leaveTypeId} onChange={(e) => set(setLeaveTypeId)(e.target.value ? Number(e.target.value) : '')} aria-label="Leave type">
          <option value="">Any type</option>
          {types.data?.data.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select className="input w-44" value={departmentId} onChange={(e) => set(setDepartmentId)(e.target.value ? Number(e.target.value) : '')} aria-label="Department">
          <option value="">Any department</option>
          {depts.data?.data.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-2">
          <input type="date" className="input w-40" value={from} onChange={(e) => set(setFrom)(e.target.value)} aria-label="From" />
          <span className="text-sm text-ink-3">to</span>
          <input type="date" className="input w-40" value={to} onChange={(e) => set(setTo)(e.target.value)} aria-label="To" />
        </div>
      </div>
      {q.isLoading ? (
        <div className="p-5">
          <Loading inline />
        </div>
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
      ) : (
        <LeaveTable
          rows={q.data?.data ?? []}
          onOpen={onOpen}
          emptyTitle={filtered ? 'No requests match these filters' : 'No leave requests yet'}
          emptyHint={filtered ? 'Clear a filter to see more' : 'Requests appear here once someone applies for leave'}
          footer={q.data && <Pagination meta={q.data.meta} onPage={setPage} />}
        />
      )}
    </Card>
  );
}

function OnLeave({ onOpen }: { onOpen: (id: number) => void }) {
  const today = useQuery({ queryKey: leaveKeys.today, queryFn: leaveApi.today });
  const upcoming = useQuery({ queryKey: leaveKeys.upcoming, queryFn: () => leaveApi.upcoming(14) });
  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <CardHead title="On leave today" meta={today.data ? `${today.data.data.length} people` : undefined} />
        {today.isLoading ? (
          <div className="p-5">
            <Loading inline />
          </div>
        ) : today.error ? (
          <ErrorState message={today.error.message} onRetry={() => today.refetch()} />
        ) : (
          <LeaveTable rows={today.data!.data} showStatus={false} onOpen={onOpen} emptyTitle="Nobody is on leave today" emptyHint="Approved leave covering today shows here" />
        )}
      </Card>
      <Card className="overflow-hidden">
        <CardHead title="Upcoming" meta="Starting in the next 14 days, approved and pending" />
        {upcoming.isLoading ? (
          <div className="p-5">
            <Loading inline />
          </div>
        ) : upcoming.error ? (
          <ErrorState message={upcoming.error.message} onRetry={() => upcoming.refetch()} />
        ) : (
          <LeaveTable rows={upcoming.data!.data} onOpen={onOpen} emptyTitle="No leave in the next 14 days" emptyHint="Approved and pending leave starting soon shows here" />
        )}
      </Card>
    </div>
  );
}
