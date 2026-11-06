/**
 * Pieces the recruitment pages share: lookups, the stage strip, and the
 * action modals (move stage, reject, schedule interview, record outcome,
 * log contact, hire).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import {
  BOARD_STAGES,
  CHANNEL_LABEL,
  MODE_LABEL,
  STAGES,
  STRIP_STAGES,
  orgApi,
  recruitmentApi,
  type Application,
  type Channel,
  type Direction,
  type HireInput,
  type Interview,
  type Mode,
  type Outcome,
  type Stage,
} from '../../api/recruitment';
import { ApiError } from '../../lib/api';
import { date, initials, label, todayISO } from '../../lib/format';
import { Field, FormError, Modal, Segmented, SipId, toast } from '../../components/ui';

/* ------------------------------------------------------------------ */
/* Lookups and cache                                                    */
/* ------------------------------------------------------------------ */

export function useRecruitUsers() {
  return useQuery({ queryKey: ['recruitment', 'users'], queryFn: recruitmentApi.users, staleTime: 5 * 60_000 });
}

export function usePositions() {
  return useQuery({ queryKey: ['recruitment', 'positions'], queryFn: recruitmentApi.positions, staleTime: 60_000 });
}

/** After any recruitment write: refresh the module and the sidebar counts. */
export function invalidateRecruitment(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: ['recruitment'] });
  void qc.invalidateQueries({ queryKey: ['nav-counts'] });
}

export function OwnerInitials({ name }: { name: string | null }) {
  if (!name) return <span className="text-xs text-ink-3">—</span>;
  return (
    <span
      title={name}
      className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-raised text-[11px] font-medium text-ink-2"
      aria-label={`Owner ${name}`}
    >
      {initials(name) || '?'}
    </span>
  );
}

/** Stage as a tag: closed outcomes take their status tone, open stages stay neutral. */
export function stageText(stage: Stage | null | undefined): string {
  return stage ? label(stage) : '—';
}

/** datetime-local value (local time) → ISO string */
function localToISO(v: string): string {
  return new Date(v).toISOString();
}

function nowLocal(offsetHours = 0): string {
  const d = new Date(Date.now() + offsetHours * 3600_000);
  d.setMinutes(0, 0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function Busy({ on }: { on: boolean }) {
  return on ? <Loader2 size={16} strokeWidth={1.5} className="animate-spin" /> : null;
}

function Footer({ onClose, busy, submit, danger, form }: { onClose: () => void; busy: boolean; submit: string; danger?: boolean; form: string }) {
  return (
    <>
      <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
        Cancel
      </button>
      <button type="submit" form={form} className={danger ? 'btn-danger' : 'btn-primary'} disabled={busy}>
        <Busy on={busy} />
        {submit}
      </button>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Stage strip                                                          */
/* ------------------------------------------------------------------ */

/** The pipeline as a quiet stepper; the current stage is the one brand mark. */
export function StageStrip({ stage, status }: { stage: Stage; status: string }) {
  const branch = stage === 'offer_rejected';
  const at = branch ? STRIP_STAGES.indexOf('offer_accepted') : STRIP_STAGES.indexOf(stage);
  const rejected = status === 'rejected';
  return (
    <ol className="flex gap-1" aria-label="Pipeline progress">
      {STRIP_STAGES.map((s, i) => {
        const current = i === at;
        const done = i < at;
        const bar = current ? (rejected ? 'bg-bad' : 'bg-brand') : done ? 'bg-ink/30' : 'bg-raised';
        const text = current ? (branch ? 'Offer rejected' : label(s)) : label(s);
        return (
          <li key={s} className="min-w-0 flex-1" title={text}>
            <div className={`h-1 rounded-full ${bar}`} />
            <p className={`mt-1.5 hidden truncate text-[11px] lg:block ${current ? 'font-medium text-ink' : 'text-ink-3'}`}>{text}</p>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/* Move stage                                                           */
/* ------------------------------------------------------------------ */

export function MoveStageModal({
  open,
  onClose,
  application,
  candidateName,
}: {
  open: boolean;
  onClose: () => void;
  application: Application | null;
  candidateName: string;
}) {
  const qc = useQueryClient();
  const [stage, setStage] = useState<Stage>('screening');
  const [note, setNote] = useState('');
  const hired = application?.status === 'hired';
  const options = useMemo<Stage[]>(
    () => (hired ? ['onboarding'] : STAGES.filter((s) => s !== 'hired' && s !== 'onboarding')),
    [hired],
  );

  useEffect(() => {
    if (!open || !application) return;
    const idx = BOARD_STAGES.indexOf(application.currentStage);
    const next = hired ? 'onboarding' : idx >= 0 && idx < BOARD_STAGES.length - 1 ? BOARD_STAGES[idx + 1] : application.currentStage;
    setStage(next);
    setNote('');
  }, [open, application, hired]);

  const m = useMutation({
    mutationFn: () => recruitmentApi.moveStage(application!.id, { stage, note: note || null, fromStage: application!.currentStage }),
    onSuccess: () => {
      invalidateRecruitment(qc);
      toast(`Moved ${candidateName} to ${label(stage)}`);
      onClose();
    },
  });

  return (
    <Modal open={open} onClose={onClose} title="Move stage" footer={<Footer onClose={onClose} busy={m.isPending} submit="Move" form="move-stage" />}>
      <form
        id="move-stage"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        {application?.status === 'rejected' && (
          <p className="text-sm text-ink-2">This application is rejected. Moving it reopens it at the chosen stage.</p>
        )}
        <Field label="Stage" required hint={hired ? undefined : 'Use Hire to move a candidate to Hired'}>
          <select className="input" value={stage} onChange={(e) => setStage(e.target.value as Stage)}>
            {options.map((s) => (
              <option key={s} value={s}>
                {label(s)}
                {application?.currentStage === s ? ' (current)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note">
          <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why it moved, optional" />
        </Field>
        <FormError message={m.error?.message} />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Reject                                                               */
/* ------------------------------------------------------------------ */

export function RejectModal({
  open,
  onClose,
  application,
  candidateName,
}: {
  open: boolean;
  onClose: () => void;
  application: Application | null;
  candidateName: string;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const m = useMutation({
    mutationFn: () => recruitmentApi.reject(application!.id, reason || null),
    onSuccess: () => {
      invalidateRecruitment(qc);
      toast(`Rejected ${candidateName}`);
      onClose();
    },
  });
  return (
    <Modal open={open} onClose={onClose} title={`Reject ${candidateName}`} footer={<Footer onClose={onClose} busy={m.isPending} submit="Reject" danger form="reject" />}>
      <form
        id="reject"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <p className="text-sm text-ink-2">
          The application for {application?.positionApplied} closes at {stageText(application?.currentStage)} and leaves the pipeline. You can reopen it later
          by moving its stage.
        </p>
        <Field label="Reason">
          <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional, kept in the stage history" />
        </Field>
        <FormError message={m.error?.message} />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Interviews                                                           */
/* ------------------------------------------------------------------ */

function InterviewerPicker({ value, onChange }: { value: number[]; onChange: (ids: number[]) => void }) {
  const users = useRecruitUsers();
  if (users.isLoading) return <p className="text-sm text-ink-3">Loading people</p>;
  if (users.error) return <p className="text-sm text-bad">{users.error.message}</p>;
  return (
    <div className="max-h-44 overflow-y-auto rounded-lg border border-line">
      {(users.data ?? []).map((u) => (
        <label key={u.id} className="flex cursor-pointer items-center gap-3 border-b border-line px-3 py-2 text-sm last:border-b-0 hover:bg-bg">
          <input
            type="checkbox"
            className="accent-brand"
            checked={value.includes(u.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, u.id] : value.filter((x) => x !== u.id))}
          />
          <span className="min-w-0 flex-1 truncate">{u.name}</span>
          <span className="truncate text-xs text-ink-3">{u.recruiter ? 'Recruitment' : u.email}</span>
        </label>
      ))}
    </div>
  );
}

export function ScheduleInterviewModal({
  open,
  onClose,
  applications,
  defaultApplicationId,
  candidateName,
}: {
  open: boolean;
  onClose: () => void;
  applications: Application[];
  defaultApplicationId?: number;
  candidateName: string;
}) {
  const qc = useQueryClient();
  const [applicationId, setApplicationId] = useState<number>(0);
  const [when, setWhen] = useState('');
  const [mode, setMode] = useState<Mode>('online');
  const [ids, setIds] = useState<number[]>([]);
  useEffect(() => {
    if (!open) return;
    setApplicationId(defaultApplicationId ?? applications[0]?.id ?? 0);
    setWhen(nowLocal(24));
    setMode('online');
    setIds([]);
  }, [open, defaultApplicationId, applications]);

  const m = useMutation({
    mutationFn: () => {
      if (!when) throw new Error('Pick a date and time');
      if (ids.length === 0) throw new Error('Pick at least one interviewer');
      return recruitmentApi.scheduleInterview({ applicationId, scheduledAt: localToISO(when), mode, interviewerIds: ids });
    },
    onSuccess: () => {
      invalidateRecruitment(qc);
      toast(`Interview scheduled with ${candidateName}`);
      onClose();
    },
  });

  return (
    <Modal open={open} onClose={onClose} title="Schedule interview" footer={<Footer onClose={onClose} busy={m.isPending} submit="Schedule" form="schedule" />}>
      <form
        id="schedule"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        {applications.length > 1 && (
          <Field label="Application" required>
            <select className="input" value={applicationId} onChange={(e) => setApplicationId(Number(e.target.value))}>
              {applications.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.positionApplied} · {label(a.currentStage)}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date and time" required>
            <input type="datetime-local" className="input" value={when} onChange={(e) => setWhen(e.target.value)} required />
          </Field>
          <Field label="Mode" required>
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
              {(Object.keys(MODE_LABEL) as Mode[]).map((k) => (
                <option key={k} value={k}>
                  {MODE_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Interviewers" required hint="They get a notification">
          <InterviewerPicker value={ids} onChange={setIds} />
        </Field>
        <FormError message={m.error?.message} />
      </form>
    </Modal>
  );
}

export function OutcomeModal({ open, onClose, interview, candidateName }: { open: boolean; onClose: () => void; interview: Interview | null; candidateName: string }) {
  const qc = useQueryClient();
  const [outcome, setOutcome] = useState<Outcome>('positive');
  const [rating, setRating] = useState<string>('');
  const [feedback, setFeedback] = useState('');
  const [followup, setFollowup] = useState('');
  useEffect(() => {
    if (!open || !interview) return;
    setOutcome(interview.outcome ?? 'positive');
    setRating(interview.rating ? String(interview.rating) : '');
    setFeedback(interview.feedbackNotes ?? '');
    setFollowup(interview.followupAction ?? '');
  }, [open, interview]);
  const m = useMutation({
    mutationFn: () =>
      recruitmentApi.updateInterview(interview!.id, {
        outcome,
        rating: rating ? Number(rating) : null,
        feedbackNotes: feedback || null,
        followupAction: followup || null,
      }),
    onSuccess: () => {
      invalidateRecruitment(qc);
      toast('Outcome recorded');
      onClose();
    },
  });
  return (
    <Modal open={open} onClose={onClose} title={`Interview outcome · ${candidateName}`} footer={<Footer onClose={onClose} busy={m.isPending} submit="Save outcome" form="outcome" />}>
      <form
        id="outcome"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label="Outcome" required>
          <Segmented<Outcome>
            value={outcome}
            onChange={setOutcome}
            options={[
              { value: 'positive', label: 'Positive' },
              { value: 'neutral', label: 'Neutral' },
              { value: 'negative', label: 'Negative' },
            ]}
          />
        </Field>
        <Field label="Rating" hint="1 to 5, optional">
          <select className="input w-32" value={rating} onChange={(e) => setRating(e.target.value)}>
            <option value="">No rating</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Feedback">
          <textarea className="input" rows={4} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
        </Field>
        <Field label="Follow-up action" hint="e.g. schedule a second round">
          <input className="input" value={followup} onChange={(e) => setFollowup(e.target.value)} />
        </Field>
        {interview?.stage === 'interview_scheduled' && !interview.outcome && (
          <p className="text-xs text-ink-3">Saving moves the application to Interview completed.</p>
        )}
        <FormError message={m.error?.message} />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Communication log                                                    */
/* ------------------------------------------------------------------ */

export function LogContactModal({
  open,
  onClose,
  candidateId,
  candidateName,
  applications,
}: {
  open: boolean;
  onClose: () => void;
  candidateId: number;
  candidateName: string;
  applications: Application[];
}) {
  const qc = useQueryClient();
  const openApps = applications.filter((a) => a.status !== 'rejected' && a.status !== 'hired');
  const [channel, setChannel] = useState<Channel>('call');
  const [direction, setDirection] = useState<Direction>('outbound');
  const [subject, setSubject] = useState('');
  const [summary, setSummary] = useState('');
  const [when, setWhen] = useState('');
  const [followup, setFollowup] = useState('');
  const [applicationId, setApplicationId] = useState<number | undefined>();
  useEffect(() => {
    if (!open) return;
    const first = openApps[0];
    setChannel('call');
    setDirection('outbound');
    setSubject('');
    setSummary('');
    setWhen(nowLocal());
    setApplicationId(first?.id);
    setFollowup(first?.nextFollowupDate && first.nextFollowupDate > todayISO() ? first.nextFollowupDate : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const m = useMutation({
    mutationFn: () =>
      recruitmentApi.logContact(candidateId, {
        channel,
        direction,
        subject: subject || null,
        summary: summary || null,
        occurredAt: when ? localToISO(when) : undefined,
        nextFollowupDate: applicationId ? followup || null : undefined,
        applicationId,
      }),
    onSuccess: () => {
      invalidateRecruitment(qc);
      toast('Contact logged');
      onClose();
    },
  });

  return (
    <Modal open={open} onClose={onClose} title={`Log contact · ${candidateName}`} footer={<Footer onClose={onClose} busy={m.isPending} submit="Log contact" form="log-contact" />}>
      <form
        id="log-contact"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <div className="flex flex-wrap gap-3">
          <Segmented<Channel>
            value={channel}
            onChange={setChannel}
            options={(Object.keys(CHANNEL_LABEL) as Channel[]).map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))}
          />
          <Segmented<Direction>
            value={direction}
            onChange={setDirection}
            options={[
              { value: 'outbound', label: 'Outbound' },
              { value: 'inbound', label: 'Inbound' },
            ]}
          />
        </div>
        <Field label="Subject">
          <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Summary">
          <textarea className="input" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What was said and agreed" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="When">
            <input type="datetime-local" className="input" value={when} onChange={(e) => setWhen(e.target.value)} />
          </Field>
          <Field label="Next follow-up" hint={openApps.length ? 'Blank clears the reminder' : 'No open application to remind on'}>
            <input type="date" className="input" min={todayISO()} value={followup} onChange={(e) => setFollowup(e.target.value)} disabled={!openApps.length} />
          </Field>
        </div>
        {openApps.length > 1 && (
          <Field label="Follow-up for">
            <select className="input" value={applicationId} onChange={(e) => setApplicationId(Number(e.target.value))}>
              {openApps.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.positionApplied}
                </option>
              ))}
            </select>
          </Field>
        )}
        <FormError message={m.error?.message} />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Hire                                                                 */
/* ------------------------------------------------------------------ */

export function HireModal({
  open,
  onClose,
  application,
  candidateName,
  candidateCnic,
}: {
  open: boolean;
  onClose: () => void;
  application: Application | null;
  candidateName: string;
  candidateCnic: string | null;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const depts = useQuery({ queryKey: ['recruitment', 'org', 'departments'], queryFn: orgApi.departments, enabled: open });
  const desigs = useQuery({ queryKey: ['recruitment', 'org', 'designations'], queryFn: orgApi.designations, enabled: open });
  const people = useQuery({ queryKey: ['recruitment', 'org', 'people'], queryFn: () => orgApi.people(), enabled: open });
  const [f, setF] = useState<HireInput>({ dateOfJoining: '', departmentId: 0, designationId: 0, employmentStatus: 'probation', managerSipId: '', cnic: '' });
  const [done, setDone] = useState<string | null>(null);
  const fromOffer = application?.currentStage === 'offer_made';
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (!open) return;
    setF({
      dateOfJoining: todayISO(),
      departmentId: application?.departmentId ?? 0,
      designationId: 0,
      employmentStatus: 'probation',
      managerSipId: '',
      cnic: candidateCnic && !candidateCnic.includes('*') ? candidateCnic : '',
    });
    setConfirm(false);
    setDone(null);
  }, [open, application, candidateCnic]);

  const designations = (desigs.data ?? []).filter((d) => d.active && (!f.departmentId || d.departmentId === f.departmentId || d.departmentId == null));
  const set = <K extends keyof HireInput>(k: K, v: HireInput[K]) => setF((x) => ({ ...x, [k]: v }));

  const m = useMutation({
    mutationFn: () => {
      if (!f.departmentId) throw new Error('Pick a department');
      if (!f.designationId) throw new Error('Pick a designation');
      if (fromOffer && !confirm) throw new Error('Confirm that the offer was accepted');
      return recruitmentApi.hire(application!.id, {
        ...f,
        managerSipId: f.managerSipId || null,
        cnic: f.cnic || null,
        confirm: fromOffer ? confirm : undefined,
      });
    },
    onSuccess: (r) => {
      invalidateRecruitment(qc);
      void qc.invalidateQueries({ queryKey: ['employees'] });
      toast(`${candidateName} hired as SIP ${r.sipId}`);
      setDone(r.sipId);
    },
  });

  if (done) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        title="Hired"
        footer={
          <>
            <button className="btn-secondary" onClick={onClose}>
              Close
            </button>
            <button className="btn-primary" onClick={() => navigate(`/employees/${done}`)}>
              Open employee profile
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-ink-2">
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-ink">{candidateName}</span> is now an employee <SipId id={done} to={`/employees/${done}`} />
          </p>
          <p>The record is pending until the CNIC copy and signed contract are uploaded. HR has been notified.</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} title={`Hire ${candidateName}`} footer={<Footer onClose={onClose} busy={m.isPending} submit="Hire" form="hire" />}>
      <form
        id="hire"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <p className="text-sm text-ink-2">
          Creates the employee record with a new SIP ID. Name, contact and address carry over from the candidate.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Joining date" required>
            <input type="date" className="input" value={f.dateOfJoining} onChange={(e) => set('dateOfJoining', e.target.value)} required />
          </Field>
          <Field label="Employment status" required>
            <select className="input" value={f.employmentStatus} onChange={(e) => set('employmentStatus', e.target.value as HireInput['employmentStatus'])}>
              <option value="probation">Probation</option>
              <option value="contractual">Contractual</option>
              <option value="permanent">Permanent</option>
            </select>
          </Field>
          <Field label="Department" required>
            <select
              className="input"
              value={f.departmentId || ''}
              onChange={(e) => setF((x) => ({ ...x, departmentId: Number(e.target.value), designationId: 0 }))}
            >
              <option value="">Select</option>
              {(depts.data ?? [])
                .filter((d) => d.active)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Designation" required>
            <select className="input" value={f.designationId || ''} onChange={(e) => set('designationId', Number(e.target.value))}>
              <option value="">Select</option>
              {designations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Manager">
            <select className="input" value={f.managerSipId ?? ''} onChange={(e) => set('managerSipId', e.target.value)}>
              <option value="">No manager</option>
              {(people.data ?? []).map((p) => (
                <option key={p.sipId} value={p.sipId}>
                  {p.name} · {p.sipId}
                </option>
              ))}
            </select>
          </Field>
          <Field label="CNIC" hint="Optional now, needed to activate">
            <input className="input num" value={f.cnic ?? ''} onChange={(e) => set('cnic', e.target.value)} placeholder="35202-1234567-1" />
          </Field>
        </div>
        {fromOffer && (
          <label className="flex items-start gap-2 text-sm text-ink-2">
            <input type="checkbox" className="mt-0.5 accent-brand" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
            The offer is still at Offer made. I confirm the candidate accepted it.
          </label>
        )}
        <FormError message={m.error?.message} />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Duplicate warning                                                    */
/* ------------------------------------------------------------------ */

/** Reads the 409 duplicate payload the server sends on create/update. */
export function duplicateOf(err: unknown): { id: number; message: string } | null {
  if (err instanceof ApiError && err.code === 'duplicate_candidate') {
    const id = Number(err.details?.candidateId?.[0]);
    return id ? { id, message: err.message } : null;
  }
  return null;
}

export function DuplicateNotice({ id, message, children }: { id: number; message: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
      <p>{message}</p>
      <div className="mt-2 flex items-center gap-3">
        <Link to={`/recruitment/candidates/${id}`} className="font-medium underline underline-offset-2">
          Open existing record
        </Link>
        {children}
      </div>
    </div>
  );
}

export function FollowupDate({ value, today }: { value: string | null; today: string }) {
  if (!value) return <span className="text-ink-3">—</span>;
  const due = value <= today;
  return <span className={`num ${due ? 'text-warn' : ''}`}>{date(value, true)}</span>;
}
