import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, Plus } from 'lucide-react';
import { STAGES, STATUSES, candidateCode, recruitmentApi, type CandidateFilters } from '../../api/recruitment';
import { useAuth } from '../../lib/auth';
import { date, label } from '../../lib/format';
import { EmptyState, ErrorState, ICON, Loading, PageHeader, Pagination, SearchInput, StatusTag, useDebounced } from '../../components/ui';
import { CandidateFormModal } from './CandidateForm';
import { usePositions, useRecruitUsers } from './shared';

export function Candidates() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [params] = useSearchParams();
  const [filters, setFilters] = useState<CandidateFilters>(() => ({
    status: params.get('status') || undefined,
    stage: params.get('stage') || undefined,
    position: params.get('position') || undefined,
  }));
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const q = useDebounced(search);
  const positions = usePositions();
  const users = useRecruitUsers();

  const query: CandidateFilters = { ...filters, search: q || undefined };
  const list = useQuery({
    queryKey: ['recruitment', 'candidates', query, page],
    queryFn: () => recruitmentApi.candidates({ ...query, page }),
    placeholderData: keepPreviousData,
  });

  const setFilter = (k: keyof CandidateFilters) => (e: { target: { value: string } }) => {
    setFilters((f) => ({ ...f, [k]: e.target.value || undefined }));
    setPage(1);
  };
  const filtered = Object.values(filters).some(Boolean) || !!q;

  return (
    <div>
      <PageHeader
        eyebrow="Recruitment"
        title="Candidates"
        subtitle={list.data ? `${list.data.meta.total.toLocaleString()} ${filtered ? 'matching' : 'in total'}` : undefined}
        actions={
          <>
            <a className="btn-secondary" href={recruitmentApi.exportUrl(query)}>
              <Download {...ICON} className="text-ink-3" />
              Export CSV
            </a>
            {can('recruitment.manage') && (
              <button className="btn-primary" onClick={() => setAdding(true)}>
                <Plus {...ICON} />
                Add candidate
              </button>
            )}
          </>
        }
      />

      <div className="card">
        <div className="flex flex-wrap items-center gap-2 px-5 py-4">
          <SearchInput value={search} onChange={(v) => (setSearch(v), setPage(1))} placeholder="Name, candidate ID, email, phone" className="w-full sm:w-72" />
          <select className="input w-auto" value={filters.position ?? ''} onChange={setFilter('position')} aria-label="Position">
            <option value="">All positions</option>
            {(positions.data ?? []).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select className="input w-auto" value={filters.status ?? ''} onChange={setFilter('status')} aria-label="Status">
            <option value="">Any status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
          <select className="input w-auto" value={filters.stage ?? ''} onChange={setFilter('stage')} aria-label="Stage">
            <option value="">Any stage</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
          <select className="input w-auto" value={String(filters.ownerId ?? '')} onChange={setFilter('ownerId')} aria-label="Owner">
            <option value="">Any owner</option>
            {(users.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <input className="input w-36" value={filters.source ?? ''} onChange={setFilter('source')} placeholder="Source" aria-label="Source" />
          <div className="flex items-center gap-1.5 text-sm text-ink-3">
            <input type="date" className="input w-auto" value={filters.from ?? ''} onChange={setFilter('from')} aria-label="Applied from" />
            <span>to</span>
            <input type="date" className="input w-auto" value={filters.to ?? ''} onChange={setFilter('to')} aria-label="Applied to" />
          </div>
          {filtered && (
            <button
              className="btn-ghost btn-sm"
              onClick={() => {
                setFilters({});
                setSearch('');
                setPage(1);
              }}
            >
              Clear
            </button>
          )}
        </div>

        {list.isLoading ? (
          <div className="border-t border-line">
            <Loading inline label="Loading candidates" />
          </div>
        ) : list.error ? (
          <ErrorState message={list.error.message} onRetry={() => list.refetch()} />
        ) : list.data!.data.length === 0 ? (
          <EmptyState
            bare
            title={filtered ? 'No candidates match' : 'No candidates yet'}
            hint={filtered ? 'Try a different search or clear the filters.' : 'Candidates you add appear here with their latest application.'}
            action={
              !filtered && can('recruitment.manage') ? (
                <button className="btn-primary" onClick={() => setAdding(true)}>
                  <Plus {...ICON} />
                  Add candidate
                </button>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th className="th">Name</th>
                    <th className="th">Position</th>
                    <th className="th">Stage</th>
                    <th className="th">Source</th>
                    <th className="th text-right">Applied</th>
                    <th className="th">Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data!.data.map((c) => (
                    <tr key={c.id} className="row-link" onClick={() => navigate(`/recruitment/candidates/${c.id}`)}>
                      <td className="td">
                        <p className="font-medium">{c.name}</p>
                        <p className="text-xs text-ink-3">
                          <span className="num">{candidateCode(c.id)}</span>
                          {(c.email ?? c.phone) && <span>, {c.email ?? c.phone}</span>}
                        </p>
                      </td>
                      <td className="td">
                        {c.positionApplied ?? '—'}
                        {c.applicationCount > 1 && <span className="num ml-1.5 text-xs text-ink-3">+{c.applicationCount - 1}</span>}
                      </td>
                      {/* status follows the stage; only the two closing outcomes get a tag */}
                      <td className="td text-ink-2">
                        {c.status === 'rejected' || c.status === 'hired' ? (
                          <StatusTag value={c.status} />
                        ) : c.currentStage ? (
                          label(c.currentStage)
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="td text-ink-2">{c.source ?? '—'}</td>
                      <td className="td num text-right text-ink-2">{date(c.applicationDate)}</td>
                      <td className="td text-ink-2">{c.ownerName ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination meta={list.data!.meta} onPage={setPage} />
          </>
        )}
      </div>

      <CandidateFormModal open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}
