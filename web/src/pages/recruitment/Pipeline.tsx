import { useState, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Plus } from 'lucide-react';
import { recruitmentApi, type Board, type BoardItem, type Stage } from '../../api/recruitment';
import { useAuth } from '../../lib/auth';
import { date, label, relative } from '../../lib/format';
import { EmptyState, ErrorState, ICON, Loading, PageHeader, SearchInput, toast, useDebounced } from '../../components/ui';
import { CandidateFormModal } from './CandidateForm';
import { FollowupDate, OwnerInitials, invalidateRecruitment, usePositions, useRecruitUsers } from './shared';

export function Pipeline() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const canMove = can('recruitment.manage');
  const [position, setPosition] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<Stage | null>(null);
  const q = useDebounced(search);
  const positions = usePositions();
  const users = useRecruitUsers();

  const key = ['recruitment', 'board', { position, ownerId, q }] as const;
  const board = useQuery({
    queryKey: key,
    queryFn: () => recruitmentApi.board({ position: position || undefined, ownerId: ownerId || undefined, search: q || undefined }),
  });

  const move = useMutation({
    mutationFn: (v: { item: BoardItem; to: Stage }) => recruitmentApi.moveStage(v.item.applicationId, { stage: v.to, fromStage: v.item.stage }),
    onMutate: async ({ item, to }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Board>(key);
      if (prev) {
        qc.setQueryData<Board>(key, {
          ...prev,
          columns: prev.columns.map((c) => ({
            ...c,
            items:
              c.stage === to
                ? [...c.items, { ...item, stage: to, daysInStage: 0 }]
                : c.items.filter((i) => i.applicationId !== item.applicationId),
          })),
        });
      }
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast(err.message, 'bad');
    },
    onSuccess: (_d, { item, to }) => toast(`Moved ${item.name} to ${label(to)}`),
    onSettled: () => invalidateRecruitment(qc),
  });

  const followups = useQuery({ queryKey: ['recruitment', 'followups', 'due'], queryFn: () => recruitmentApi.followups('due') });

  const onDrop = (to: Stage) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const id = Number(e.dataTransfer.getData('text/plain'));
    setDragging(null);
    const item = board.data?.columns.flatMap((c) => c.items).find((i) => i.applicationId === id);
    if (!item || item.stage === to) return;
    move.mutate({ item, to });
  };

  const total = board.data?.columns.reduce((n, c) => n + c.items.length, 0) ?? 0;
  const filtered = !!(position || ownerId || q);

  return (
    <div>
      <PageHeader
        eyebrow="Recruitment"
        title="Pipeline"
        subtitle={board.data ? `${total} open application${total === 1 ? '' : 's'}${canMove ? ', drag a card to move it' : ''}` : undefined}
        actions={
          <>
            {board.data && (
              <Link to="/recruitment/candidates?status=hired" className="btn-secondary">
                Hired
                <span className="num text-ink-3">{board.data.hired.total}</span>
                {board.data.hired.thisMonth > 0 && <span className="text-xs text-ink-3">{board.data.hired.thisMonth} this month</span>}
              </Link>
            )}
            {canMove && (
              <button className="btn-primary" onClick={() => setAdding(true)}>
                <Plus {...ICON} />
                Add candidate
              </button>
            )}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="Name, position or candidate ID" className="w-full sm:w-72" />
        <select className="input w-auto" value={position} onChange={(e) => setPosition(e.target.value)} aria-label="Position">
          <option value="">All positions</option>
          {(positions.data ?? []).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select className="input w-auto" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} aria-label="Owner">
          <option value="">Any owner</option>
          {(users.data ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </div>

      {board.isLoading ? (
        <Loading label="Loading pipeline" />
      ) : board.error ? (
        <ErrorState message={board.error.message} onRetry={() => board.refetch()} />
      ) : total === 0 && !filtered ? (
        <EmptyState
          title="No open applications"
          illustration="recruitment.empty"
          hint="Add a candidate and their application starts in Application received."
          action={
            canMove ? (
              <button className="btn-primary" onClick={() => setAdding(true)}>
                <Plus {...ICON} />
                Add candidate
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
          <div className="flex min-w-max gap-3">
            {board.data!.columns.map((col) => (
              <section
                key={col.stage}
                aria-label={col.label}
                className={`flex w-64 shrink-0 flex-col rounded-xl border border-line transition-colors ${
                  over === col.stage ? 'bg-raised' : 'bg-raised/50'
                }`}
                onDragOver={
                  canMove
                    ? (e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        if (over !== col.stage) setOver(col.stage);
                      }
                    : undefined
                }
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null);
                }}
                onDrop={canMove ? onDrop(col.stage) : undefined}
              >
                <header className="flex items-baseline justify-between gap-2 px-3 pt-3 pb-2">
                  <h2 className="truncate text-sm font-medium">{col.label}</h2>
                  <span className="num text-xs text-ink-3">{col.items.length}</span>
                </header>
                <ul className="flex min-h-[96px] flex-1 flex-col gap-2 px-2 pb-2">
                  {col.items.map((item) => (
                    <BoardCard
                      key={item.applicationId}
                      item={item}
                      today={board.data!.today}
                      draggable={canMove}
                      dragging={dragging === item.applicationId}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', String(item.applicationId));
                        e.dataTransfer.effectAllowed = 'move';
                        setDragging(item.applicationId);
                      }}
                      onDragEnd={() => {
                        setDragging(null);
                        setOver(null);
                      }}
                    />
                  ))}
                  {col.items.length === 0 && <li className="px-1 py-3 text-xs text-ink-3">{filtered ? 'None match' : 'Empty'}</li>}
                </ul>
              </section>
            ))}
          </div>
        </div>
      )}

      <FollowupsCard data={followups.data} loading={followups.isLoading} error={followups.error?.message} />

      <CandidateFormModal open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

function BoardCard({
  item,
  today,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  item: BoardItem;
  today: string;
  draggable: boolean;
  dragging: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
}) {
  const navigate = useNavigate();
  const due = item.nextFollowupDate && item.nextFollowupDate <= today;
  return (
    <li
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => navigate(`/recruitment/candidates/${item.candidateId}`)}
      className={`cursor-pointer rounded-lg border border-line p-3 transition-colors ${
        dragging ? 'bg-raised' : 'bg-surface hover:bg-bg'
      } ${draggable ? 'active:cursor-grabbing' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium">{item.name}</p>
        <OwnerInitials name={item.ownerName} />
      </div>
      <p className="mt-0.5 truncate text-xs text-ink-2">{item.positionApplied}</p>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs">
        <span className="num text-ink-3" title="Days in this stage">
          {item.daysInStage}d
        </span>
        {due && (
          <span className="num text-warn" title="Follow-up due">
            Follow up {item.nextFollowupDate === today ? 'today' : date(item.nextFollowupDate, true)}
          </span>
        )}
      </div>
    </li>
  );
}

function FollowupsCard({
  data,
  loading,
  error,
}: {
  data?: Awaited<ReturnType<typeof recruitmentApi.followups>>;
  loading: boolean;
  error?: string;
}) {
  return (
    <div className="card mt-6">
      <div className="card-head">
        <div className="flex items-baseline gap-2">
          <p className="card-title">Follow-ups due</p>
          {data && <span className="num text-xs text-ink-3">{data.data.length}</span>}
        </div>
        <Link to="/recruitment/candidates" className="inline-flex items-center gap-1 text-sm text-ink-2 transition-colors hover:text-ink">
          All candidates <ArrowRight size={14} strokeWidth={1.5} />
        </Link>
      </div>
      {loading ? (
        <div className="border-t border-line">
          <Loading inline label="Loading follow-ups" />
        </div>
      ) : error ? (
        <ErrorState message={error} />
      ) : !data || data.data.length === 0 ? (
        <EmptyState bare title="Nothing due" hint="Set a next follow-up date when you log a contact and it shows here on the day." />
      ) : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th className="th">Candidate</th>
                <th className="th">Position</th>
                <th className="th">Stage</th>
                <th className="th">Owner</th>
                <th className="th text-right">Last contact</th>
                <th className="th text-right">Due</th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((f) => (
                <tr key={f.applicationId}>
                  <td className="td">
                    <Link to={`/recruitment/candidates/${f.candidateId}`} className="font-medium hover:underline">
                      {f.name}
                    </Link>
                  </td>
                  <td className="td text-ink-2">{f.positionApplied}</td>
                  <td className="td text-ink-2">{label(f.stage)}</td>
                  <td className="td text-ink-2">{f.ownerName ?? '—'}</td>
                  <td className="td num text-right text-ink-3">{f.lastContactAt ? relative(f.lastContactAt) : '—'}</td>
                  <td className="td text-right">
                    {f.overdue ? <FollowupDate value={f.nextFollowupDate} today={data.today} /> : <span className="text-warn">Today</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
