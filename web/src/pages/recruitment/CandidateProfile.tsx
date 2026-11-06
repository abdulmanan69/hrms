import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, CalendarPlus, Mail, MessageCircle, Pencil, Phone, Plus, Trash2, UserCheck, X } from 'lucide-react';
import {
  CHANNEL_LABEL,
  MODE_LABEL,
  isClosed,
  recruitmentApi,
  type Application,
  type Candidate,
  type CandidateDetail,
  type Communication,
  type Interview,
} from '../../api/recruitment';
import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date, dateTime, label, relative, todayISO } from '../../lib/format';
import {
  Card,
  CardHead,
  ConfirmModal,
  DetailList,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  ICON,
  Loading,
  Modal,
  PageHeader,
  SipId,
  StatusTag,
  toast,
} from '../../components/ui';
import { CandidateFormModal } from './CandidateForm';
import {
  FollowupDate,
  HireModal,
  LogContactModal,
  MoveStageModal,
  OutcomeModal,
  RejectModal,
  ScheduleInterviewModal,
  StageStrip,
  invalidateRecruitment,
  usePositions,
  useRecruitUsers,
} from './shared';

type Dialog =
  | { kind: 'move' | 'reject' | 'hire'; app: Application }
  | { kind: 'schedule'; app?: Application }
  | { kind: 'contact' | 'edit' | 'remove' | 'apply' }
  | { kind: 'outcome'; interview: Interview }
  | null;

export function CandidateProfile() {
  const { id } = useParams();
  const candidateId = Number(id);
  const { can } = useAuth();
  const canManage = can('recruitment.manage');
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);

  const q = useQuery({
    queryKey: ['recruitment', 'candidate', candidateId],
    queryFn: () => recruitmentApi.candidate(candidateId),
    enabled: Number.isFinite(candidateId),
  });

  if (q.isLoading) return <Loading label="Loading candidate" />;
  if (q.error) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return notFound ? (
      <EmptyState title="Candidate not found" hint="They may have been removed. Search the candidate list instead." />
    ) : (
      <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
    );
  }
  const d = q.data!;
  const c = d.candidate;
  const openApps = d.applications.filter((a) => !isClosed(a.status));
  const primary = openApps[0] ?? d.applications.find((a) => a.status === 'hired') ?? d.applications[0];
  const canHire = primary && !isClosed(primary.status) && (primary.currentStage === 'offer_accepted' || primary.currentStage === 'offer_made');

  return (
    <div>
      <PageHeader
        back={{ to: '/recruitment/candidates', label: 'Candidates' }}
        title={c.name}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="num text-xs">{c.code}</span>
            {primary && <StatusTag value={primary.status} />}
            {primary && (
              <span>
                {primary.positionApplied} · {label(primary.currentStage)}
              </span>
            )}
            {primary?.hiredSipId && <SipId id={primary.hiredSipId} to={`/employees/${primary.hiredSipId}`} />}
          </span>
        }
        actions={
          canManage && (
            <>
              {primary && (
                <button className="btn-secondary" onClick={() => setDialog({ kind: 'move', app: primary })} disabled={primary.currentStage === 'onboarding'}>
                  <ArrowRightLeft {...ICON} className="text-ink-3" />
                  Move stage
                </button>
              )}
              {openApps.length > 0 && (
                <button className="btn-secondary" onClick={() => setDialog({ kind: 'schedule', app: primary })}>
                  <CalendarPlus {...ICON} className="text-ink-3" />
                  Schedule interview
                </button>
              )}
              <button className="btn-secondary" onClick={() => setDialog({ kind: 'contact' })}>
                <MessageCircle {...ICON} className="text-ink-3" />
                Log contact
              </button>
              {primary && !isClosed(primary.status) && (
                <button className="btn-secondary" onClick={() => setDialog({ kind: 'reject', app: primary })}>
                  <X {...ICON} className="text-ink-3" />
                  Reject
                </button>
              )}
              {canHire && (
                <button className="btn-primary" onClick={() => setDialog({ kind: 'hire', app: primary })}>
                  <UserCheck {...ICON} />
                  Hire
                </button>
              )}
            </>
          )
        }
      />

      {/* min-w-0: columns may shrink below their content, so wide tables scroll inside their card on phones */}
      <div className="grid gap-4 xl:grid-cols-3 [&>*]:min-w-0">
        <div className="space-y-4 xl:col-span-2">
          <ApplicationsCard
            apps={d.applications}
            canManage={canManage}
            onMove={(app) => setDialog({ kind: 'move', app })}
            onReject={(app) => setDialog({ kind: 'reject', app })}
            onHire={(app) => setDialog({ kind: 'hire', app })}
            onApply={() => setDialog({ kind: 'apply' })}
          />
          <InterviewsCard
            interviews={d.interviews}
            canManage={canManage}
            canSchedule={openApps.length > 0}
            onSchedule={() => setDialog({ kind: 'schedule', app: primary })}
            onOutcome={(interview) => setDialog({ kind: 'outcome', interview })}
          />
          <CommunicationsCard items={d.communications} canManage={canManage} onLog={() => setDialog({ kind: 'contact' })} />
        </div>

        <div className="space-y-4">
          <DetailsCard c={c} canManage={canManage} onEdit={() => setDialog({ kind: 'edit' })} onRemove={() => setDialog({ kind: 'remove' })} />
          <FollowupCard detail={d} />
          <HistoryCard detail={d} />
        </div>
      </div>

      <MoveStageModal open={dialog?.kind === 'move'} onClose={close} application={dialog?.kind === 'move' ? dialog.app : null} candidateName={c.name} />
      <RejectModal open={dialog?.kind === 'reject'} onClose={close} application={dialog?.kind === 'reject' ? dialog.app : null} candidateName={c.name} />
      <HireModal
        open={dialog?.kind === 'hire'}
        onClose={close}
        application={dialog?.kind === 'hire' ? dialog.app : null}
        candidateName={c.name}
        candidateCnic={c.cnic}
      />
      <ScheduleInterviewModal
        open={dialog?.kind === 'schedule'}
        onClose={close}
        applications={openApps}
        defaultApplicationId={dialog?.kind === 'schedule' ? dialog.app?.id : undefined}
        candidateName={c.name}
      />
      <OutcomeModal
        open={dialog?.kind === 'outcome'}
        onClose={close}
        interview={dialog?.kind === 'outcome' ? { ...dialog.interview, stage: d.applications.find((a) => a.id === dialog.interview.applicationId)?.currentStage } : null}
        candidateName={c.name}
      />
      <LogContactModal open={dialog?.kind === 'contact'} onClose={close} candidateId={c.id} candidateName={c.name} applications={d.applications} />
      <CandidateFormModal open={dialog?.kind === 'edit'} onClose={close} candidate={c} />
      <NewApplicationModal open={dialog?.kind === 'apply'} onClose={close} candidateId={c.id} />
      <RemoveCandidate open={dialog?.kind === 'remove'} onClose={close} candidate={c} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ApplicationsCard({
  apps,
  canManage,
  onMove,
  onReject,
  onHire,
  onApply,
}: {
  apps: Application[];
  canManage: boolean;
  onMove: (a: Application) => void;
  onReject: (a: Application) => void;
  onHire: (a: Application) => void;
  onApply: () => void;
}) {
  return (
    <Card>
      <CardHead
        title={apps.length > 1 ? 'Applications' : 'Application'}
        meta={apps.length > 1 ? `${apps.length} in total` : undefined}
        actions={
          canManage && (
            <button className="btn-ghost btn-sm" onClick={onApply}>
              <Plus {...ICON} />
              New application
            </button>
          )
        }
      />
      <ul className="divide-y divide-line border-t border-line">
        {apps.map((a) => (
          <li key={a.id} className="space-y-4 px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">{a.positionApplied}</p>
                  <StatusTag value={a.status} />
                  {a.hiredSipId && <SipId id={a.hiredSipId} to={`/employees/${a.hiredSipId}`} />}
                </div>
                <p className="mt-1 text-xs text-ink-3">
                  Applied {date(a.applicationDate)}
                  {a.departmentName ? ` · ${a.departmentName}` : ''} · Owner {a.ownerName ?? 'unassigned'}
                  {a.priorityRank ? ` · Priority ${a.priorityRank}` : ''}
                </p>
              </div>
              {canManage && apps.length > 1 && (
                <div className="flex gap-1">
                  {a.currentStage !== 'onboarding' && (
                    <button className="btn-ghost btn-sm" onClick={() => onMove(a)}>
                      Move stage
                    </button>
                  )}
                  {!isClosed(a.status) && (
                    <button className="btn-ghost btn-sm" onClick={() => onReject(a)}>
                      Reject
                    </button>
                  )}
                  {!isClosed(a.status) && (a.currentStage === 'offer_accepted' || a.currentStage === 'offer_made') && (
                    <button className="btn-ghost btn-sm" onClick={() => onHire(a)}>
                      Hire
                    </button>
                  )}
                </div>
              )}
            </div>
            <StageStrip stage={a.currentStage} status={a.status} />
            <p className="text-xs text-ink-3">
              {a.status === 'rejected' ? 'Rejected at ' : 'At '}
              {label(a.currentStage)} for <span className="num">{a.daysInStage}</span> day{a.daysInStage === 1 ? '' : 's'}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function InterviewsCard({
  interviews,
  canManage,
  canSchedule,
  onSchedule,
  onOutcome,
}: {
  interviews: Interview[];
  canManage: boolean;
  canSchedule: boolean;
  onSchedule: () => void;
  onOutcome: (i: Interview) => void;
}) {
  return (
    <Card>
      <CardHead
        title="Interviews"
        actions={
          canManage &&
          canSchedule && (
            <button className="btn-ghost btn-sm" onClick={onSchedule}>
              <CalendarPlus {...ICON} />
              Schedule
            </button>
          )
        }
      />
      {interviews.length === 0 ? (
        <EmptyState bare title="No interviews yet" hint="Scheduled interviews and their outcomes appear here." />
      ) : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th className="th">When</th>
                <th className="th">Mode</th>
                <th className="th">Interviewers</th>
                <th className="th">Outcome</th>
                <th className="th text-right">Rating</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {interviews.map((i) => (
                <tr key={i.id} className="align-top">
                  <td className="td num">{dateTime(i.scheduledAt)}</td>
                  <td className="td text-ink-2">{MODE_LABEL[i.mode]}</td>
                  <td className="td text-ink-2">
                    <span className="block max-w-[200px] truncate">{i.interviewers.map((x) => x.name).join(', ')}</span>
                  </td>
                  <td className="td">
                    {i.outcome ? <StatusTag value={i.outcome} /> : <span className="text-ink-3">Pending</span>}
                    {i.feedbackNotes && <p className="mt-1 max-w-[260px] whitespace-normal text-xs text-ink-3">{i.feedbackNotes}</p>}
                  </td>
                  <td className="td num text-right">{i.rating ? `${i.rating}/5` : '—'}</td>
                  <td className="td text-right">
                    {canManage && (
                      <button className="btn-ghost btn-sm" onClick={() => onOutcome(i)}>
                        {i.outcome ? 'Edit outcome' : 'Record outcome'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const CHANNEL_ICON = { email: Mail, whatsapp: MessageCircle, call: Phone } as const;

function CommunicationsCard({ items, canManage, onLog }: { items: Communication[]; canManage: boolean; onLog: () => void }) {
  return (
    <Card>
      <CardHead
        title="Communications"
        actions={
          canManage && (
            <button className="btn-ghost btn-sm" onClick={onLog}>
              <Plus {...ICON} />
              Log contact
            </button>
          )
        }
      />
      {items.length === 0 ? (
        <EmptyState bare title="No contact logged" hint="Log each email, WhatsApp message and call with a next follow-up date." />
      ) : (
        <ol className="border-t border-line px-5 py-2">
          {items.map((m) => {
            const Icon = CHANNEL_ICON[m.channel];
            return (
              <li key={m.id} className="flex gap-3 py-3">
                <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-raised">
                  <Icon {...ICON} className="text-ink-3" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <p className="text-sm">
                      <span className="font-medium">{m.subject ?? CHANNEL_LABEL[m.channel]}</span>
                      <span className="text-ink-3">
                        {' '}
                        · {m.direction === 'inbound' ? 'Inbound' : 'Outbound'} {m.channel === 'whatsapp' ? 'WhatsApp' : CHANNEL_LABEL[m.channel].toLowerCase()}
                      </span>
                    </p>
                    <span className="num text-xs text-ink-3">{dateTime(m.occurredAt)}</span>
                  </div>
                  {m.summary && <p className="mt-1 whitespace-pre-line text-sm text-ink-2">{m.summary}</p>}
                  <p className="mt-1 text-xs text-ink-3">
                    {m.userName ?? 'Someone'}
                    {m.nextFollowupDate ? ` · next follow-up ${date(m.nextFollowupDate)}` : ''}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

function DetailsCard({ c, canManage, onEdit, onRemove }: { c: Candidate; canManage: boolean; onEdit: () => void; onRemove: () => void }) {
  const address = [c.address1, c.address2].filter(Boolean).join(', ');
  const place = [c.city, c.state, c.postalCode].filter(Boolean).join(', ');
  return (
    <Card>
      <CardHead
        title="Details"
        actions={
          canManage && (
            <>
              <button className="icon-btn" onClick={onEdit} aria-label="Edit candidate" title="Edit">
                <Pencil {...ICON} />
              </button>
              <button className="icon-btn" onClick={onRemove} aria-label="Remove candidate" title="Remove">
                <Trash2 {...ICON} />
              </button>
            </>
          )
        }
      />
      <div className="space-y-5 px-5 pb-5">
        <DetailList
          items={[
            { label: 'Email', value: c.email ? <a className="hover:underline" href={`mailto:${c.email}`}>{c.email}</a> : '—' },
            { label: 'Phone', value: c.phone ?? '—', mono: true },
            { label: 'Alternate phone', value: c.altPhone ?? '—', mono: true },
            { label: 'Source', value: c.source ?? '—' },
            { label: 'Gender', value: c.gender ? label(c.gender) : '—' },
            { label: 'Date of birth', value: date(c.dateOfBirth) },
          ]}
        />
        <div className="border-t border-line pt-4">
          <p className="text-xs text-ink-3">Address</p>
          <p className="mt-1 text-sm">{address || '—'}</p>
          {(place || c.country) && (
            <p className="text-sm text-ink-2">
              {place}
              {place && c.country ? ' · ' : ''}
              {c.country}
            </p>
          )}
        </div>
        {c.notes && (
          <div className="border-t border-line pt-4">
            <p className="text-xs text-ink-3">Notes</p>
            <p className="mt-1 whitespace-pre-line text-sm text-ink-2">{c.notes}</p>
          </div>
        )}
        <p className="text-xs text-ink-3">Added {date(c.createdAt.slice(0, 10))}</p>
      </div>
    </Card>
  );
}

function FollowupCard({ detail }: { detail: CandidateDetail }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const open = detail.applications.filter((a) => !isClosed(a.status));
  const today = todayISO();
  const m = useMutation({
    mutationFn: (v: { id: number; date: string | null }) => recruitmentApi.updateApplication(v.id, { nextFollowupDate: v.date }),
    onSuccess: () => {
      invalidateRecruitment(qc);
      toast('Follow-up updated');
    },
    onError: (e) => toast(e.message, 'bad'),
  });
  const last = detail.communications[0];
  return (
    <Card>
      <CardHead title="Follow-up" meta={last ? `Last contact ${relative(last.occurredAt)}` : 'No contact logged yet'} />
      {open.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-ink-3">No open application to follow up on.</p>
      ) : (
        <ul className="space-y-3 px-5 pb-5">
          {open.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0 text-sm">
                {open.length > 1 && <p className="truncate text-xs text-ink-3">{a.positionApplied}</p>}
                <FollowupDate value={a.nextFollowupDate} today={today} />
                {a.nextFollowupDate && a.nextFollowupDate < today && <span className="ml-2 text-xs text-warn">Overdue</span>}
              </div>
              {can('recruitment.manage') && (
                <input
                  type="date"
                  className="input w-40"
                  value={a.nextFollowupDate ?? ''}
                  aria-label="Next follow-up date"
                  onChange={(e) => m.mutate({ id: a.id, date: e.target.value || null })}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function HistoryCard({ detail }: { detail: CandidateDetail }) {
  const multi = detail.applications.length > 1;
  const pos = new Map(detail.applications.map((a) => [a.id, a.positionApplied]));
  return (
    <Card>
      <CardHead title="Stage history" />
      {detail.stageHistory.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-ink-3">No stage changes yet.</p>
      ) : (
        <ol className="space-y-3 px-5 pb-5">
          {detail.stageHistory.map((h) => {
            const reject = h.fromStage === h.toStage;
            return (
              <li key={h.id} className="relative pl-4">
                <span className={`absolute left-0 top-1.5 h-1.5 w-1.5 rounded-full ${reject ? 'bg-bad' : 'bg-ink/30'}`} />
                <p className="text-sm">
                  {reject ? 'Rejected at ' : h.fromStage ? '' : 'Started at '}
                  {label(h.toStage)}
                </p>
                <p className="text-xs text-ink-3">
                  <span className="num">{dateTime(h.at)}</span> · {h.userName ?? 'System'}
                  {multi ? ` · ${pos.get(h.applicationId)}` : ''}
                </p>
                {h.note && !(reject && h.note === 'Rejected') && (
                  <p className="mt-0.5 text-xs text-ink-2">{reject ? h.note.replace(/^Rejected: /, '') : h.note}</p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function NewApplicationModal({ open, onClose, candidateId }: { open: boolean; onClose: () => void; candidateId: number }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const positions = usePositions();
  const users = useRecruitUsers();
  const [position, setPosition] = useState('');
  const [ownerId, setOwnerId] = useState('');
  useEffect(() => {
    if (!open) return;
    setPosition('');
    setOwnerId(user ? String(user.userId) : '');
  }, [open, user]);
  const m = useMutation({
    mutationFn: () => recruitmentApi.addApplication(candidateId, { positionApplied: position.trim(), ownerRecruiterId: ownerId ? Number(ownerId) : null }),
    onSuccess: () => {
      invalidateRecruitment(qc);
      toast('Application added');
      onClose();
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New application"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={m.isPending}>
            Cancel
          </button>
          <button className="btn-primary" type="submit" form="new-app" disabled={m.isPending}>
            Add application
          </button>
        </>
      }
    >
      <form
        id="new-app"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label="Position applied" required>
          <input className="input" list="rec-positions-new" value={position} onChange={(e) => setPosition(e.target.value)} required />
          <datalist id="rec-positions-new">
            {(positions.data ?? []).map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </Field>
        <Field label="Owner">
          <select className="input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">Unassigned</option>
            {(users.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>
        <FormError message={m.error?.message} />
      </form>
    </Modal>
  );
}

function RemoveCandidate({ open, onClose, candidate }: { open: boolean; onClose: () => void; candidate: Candidate }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const m = useMutation({
    mutationFn: () => recruitmentApi.deleteCandidate(candidate.id),
    onSuccess: () => {
      invalidateRecruitment(qc);
      toast(`${candidate.name} removed`);
      navigate('/recruitment/candidates');
    },
  });
  const body = useMemo(
    () => `${candidate.name} leaves the candidate list and pipeline. The record is kept for the audit trail, not erased.`,
    [candidate.name],
  );
  return (
    <ConfirmModal
      open={open}
      onClose={onClose}
      title="Remove candidate"
      body={body}
      confirmLabel="Remove"
      danger
      busy={m.isPending}
      onConfirm={() => m.mutate()}
    >
      <div className="mt-3">
        <FormError message={m.error?.message} />
      </div>
    </ConfirmModal>
  );
}
