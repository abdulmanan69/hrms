import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { MODE_LABEL, recruitmentApi, type Interview, type Mode } from '../../api/recruitment';
import { useAuth } from '../../lib/auth';
import { dateTime, label } from '../../lib/format';
import { EmptyState, ErrorState, Loading, PageHeader, Pagination, SearchInput, StatusTag, Tabs, useDebounced } from '../../components/ui';
import { OutcomeModal, useRecruitUsers } from './shared';

type Scope = 'upcoming' | 'past';

export function Interviews() {
  const { can, user } = useAuth();
  const canManage = can('recruitment.manage');
  const [scope, setScope] = useState<Scope>('upcoming');
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState('');
  const [outcome, setOutcome] = useState('');
  const [interviewerId, setInterviewerId] = useState('');
  const [page, setPage] = useState(1);
  const [recording, setRecording] = useState<Interview | null>(null);
  const q = useDebounced(search);
  const users = useRecruitUsers();

  const filters = { search: q || undefined, mode: mode || undefined, outcome: outcome || undefined, interviewerId: interviewerId || undefined };
  const list = useQuery({
    queryKey: ['recruitment', 'interviews', scope, filters, page],
    queryFn: () => recruitmentApi.interviews({ scope, page, ...filters }),
    placeholderData: keepPreviousData,
  });
  const upcomingCount = useQuery({
    queryKey: ['recruitment', 'interviews', 'upcoming', 'count'],
    queryFn: () => recruitmentApi.interviews({ scope: 'upcoming', page: 1, pageSize: 1 }),
  });
  const pendingCount = useQuery({
    queryKey: ['recruitment', 'interviews', 'past', 'pending-count'],
    queryFn: () => recruitmentApi.interviews({ scope: 'past', page: 1, pageSize: 1, outcome: 'none' }),
  });

  const filtered = !!(q || mode || outcome || interviewerId);
  const reset = (fn: () => void) => {
    fn();
    setPage(1);
  };

  return (
    <div>
      <PageHeader
        eyebrow="Recruitment"
        title="Interviews"
        subtitle={
          pendingCount.data && pendingCount.data.meta.total > 0
            ? `${pendingCount.data.meta.total} past interview${pendingCount.data.meta.total === 1 ? '' : 's'} without an outcome`
            : 'Schedule interviews from a candidate profile'
        }
      />

      <Tabs<Scope>
        value={scope}
        onChange={(v) => reset(() => setScope(v))}
        tabs={[
          { value: 'upcoming', label: 'Upcoming', count: upcomingCount.data?.meta.total },
          { value: 'past', label: 'Past' },
        ]}
      />

      <div className="card">
        <div className="flex flex-wrap items-center gap-2 px-5 py-4">
          <SearchInput value={search} onChange={(v) => reset(() => setSearch(v))} placeholder="Candidate or position" className="w-full sm:w-64" />
          <select className="input w-auto" value={mode} onChange={(e) => reset(() => setMode(e.target.value))} aria-label="Mode">
            <option value="">Any mode</option>
            {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </select>
          <select className="input w-auto" value={outcome} onChange={(e) => reset(() => setOutcome(e.target.value))} aria-label="Outcome">
            <option value="">Any outcome</option>
            <option value="none">No outcome yet</option>
            <option value="positive">Positive</option>
            <option value="neutral">Neutral</option>
            <option value="negative">Negative</option>
          </select>
          <select className="input w-auto" value={interviewerId} onChange={(e) => reset(() => setInterviewerId(e.target.value))} aria-label="Interviewer">
            <option value="">Any interviewer</option>
            {user && <option value={user.userId}>Me</option>}
            {(users.data ?? [])
              .filter((u) => u.id !== user?.userId)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </select>
        </div>

        {list.isLoading ? (
          <div className="border-t border-line">
            <Loading inline label="Loading interviews" />
          </div>
        ) : list.error ? (
          <ErrorState message={list.error.message} onRetry={() => list.refetch()} />
        ) : list.data!.data.length === 0 ? (
          <EmptyState
            bare
            title={filtered ? 'No interviews match' : scope === 'upcoming' ? 'No upcoming interviews' : 'No past interviews'}
            hint={
              filtered
                ? 'Try different filters.'
                : 'Open a candidate and use Schedule interview. It appears here with its interviewers.'
            }
            action={
              !filtered ? (
                <Link to="/recruitment/candidates" className="btn-secondary">
                  Go to candidates
                </Link>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th className="th">When</th>
                    <th className="th">Candidate</th>
                    <th className="th">Position</th>
                    <th className="th">Mode</th>
                    <th className="th">Interviewers</th>
                    <th className="th">Outcome</th>
                    <th className="th text-right">Rating</th>
                    <th className="th" />
                  </tr>
                </thead>
                <tbody>
                  {list.data!.data.map((i) => (
                    <tr key={i.id}>
                      <td className="td num">{dateTime(i.scheduledAt)}</td>
                      <td className="td">
                        <Link to={`/recruitment/candidates/${i.candidateId}`} className="font-medium hover:underline">
                          {i.candidateName}
                        </Link>
                        {i.stage && <p className="text-xs text-ink-3">{label(i.stage)}</p>}
                      </td>
                      <td className="td text-ink-2">{i.positionApplied}</td>
                      <td className="td text-ink-2">{MODE_LABEL[i.mode]}</td>
                      <td className="td text-ink-2">
                        <span className="block max-w-[220px] truncate" title={i.interviewers.map((x) => x.name).join(', ')}>
                          {i.interviewers.map((x) => x.name).join(', ')}
                        </span>
                      </td>
                      <td className="td">{i.outcome ? <StatusTag value={i.outcome} /> : <span className="text-ink-3">Pending</span>}</td>
                      <td className="td num text-right">{i.rating ? `${i.rating}/5` : '—'}</td>
                      <td className="td text-right">
                        {canManage && (
                          <button className="btn-ghost btn-sm" onClick={() => setRecording(i)}>
                            {i.outcome ? 'Edit outcome' : 'Record outcome'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination meta={list.data!.meta} onPage={setPage} />
          </>
        )}
      </div>

      <OutcomeModal open={!!recording} onClose={() => setRecording(null)} interview={recording} candidateName={recording?.candidateName ?? ''} />
    </div>
  );
}
