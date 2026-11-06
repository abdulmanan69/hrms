/** Add a candidate with their first application, or edit a candidate's details. */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { SOURCE_HINT, orgApi, recruitmentApi, type Candidate, type CandidateInput } from '../../api/recruitment';
import { useAuth } from '../../lib/auth';
import { todayISO } from '../../lib/format';
import { Field, FormError, Modal, toast } from '../../components/ui';
import { DuplicateNotice, duplicateOf, invalidateRecruitment, usePositions, useRecruitUsers } from './shared';

type Form = Required<{ [K in keyof CandidateInput]: string }>;

const EMPTY: Form = {
  firstName: '',
  middleInitial: '',
  lastName: '',
  email: '',
  phone: '',
  altPhone: '',
  address1: '',
  address2: '',
  city: '',
  state: '',
  postalCode: '',
  country: 'Pakistan',
  gender: '',
  dateOfBirth: '',
  source: '',
  notes: '',
};

function fromCandidate(c: Candidate): Form {
  const out = { ...EMPTY };
  for (const k of Object.keys(EMPTY) as Array<keyof Form>) out[k] = (c[k] as string | null) ?? '';
  return out;
}

/** Blank strings become null so the server stores nothing rather than ''. */
function toInput(f: Form): CandidateInput {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(f)) out[k] = v.trim() === '' ? null : v.trim();
  return out as unknown as CandidateInput;
}

const US_PK = {
  Pakistan: { state: 'Province', postal: 'Postal code', postalHint: '5 digits, e.g. 54000' },
  'United States': { state: 'State', postal: 'ZIP code', postalHint: 'Keep leading zeros, e.g. 07087' },
} as Record<string, { state: string; postal: string; postalHint: string }>;

export function CandidateFormModal({ open, onClose, candidate }: { open: boolean; onClose: () => void; candidate?: Candidate }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user } = useAuth();
  const editing = !!candidate;
  const users = useRecruitUsers();
  const positions = usePositions();
  const depts = useQuery({ queryKey: ['recruitment', 'org', 'departments'], queryFn: orgApi.departments, enabled: open && !editing });

  const [f, setF] = useState<Form>(EMPTY);
  const [position, setPosition] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [applied, setApplied] = useState('');
  const [followup, setFollowup] = useState('');

  useEffect(() => {
    if (!open) return;
    setF(candidate ? fromCandidate(candidate) : EMPTY);
    setPosition('');
    setDepartmentId('');
    setOwnerId(user ? String(user.userId) : '');
    setApplied(todayISO());
    setFollowup('');
    m.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, candidate]);

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  const m = useMutation({
    mutationFn: (force: boolean) => {
      const input = toInput(f);
      if (editing) return recruitmentApi.updateCandidate(candidate!.id, { ...input, force }).then((c) => ({ id: c.id }));
      return recruitmentApi
        .createCandidate({
          ...input,
          force,
          application: {
            positionApplied: position.trim(),
            departmentId: departmentId ? Number(departmentId) : null,
            applicationDate: applied || undefined,
            ownerRecruiterId: ownerId ? Number(ownerId) : null,
            nextFollowupDate: followup || null,
          },
        })
        .then((r) => ({ id: r.candidate.id }));
    },
    onSuccess: ({ id }) => {
      invalidateRecruitment(qc);
      toast(editing ? 'Candidate updated' : 'Candidate added');
      onClose();
      if (!editing) navigate(`/recruitment/candidates/${id}`);
    },
  });

  const dup = duplicateOf(m.error);
  const country = US_PK[f.country] ?? { state: 'State or province', postal: 'Postal code', postalHint: 'Kept as text' };
  const busy = m.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={editing ? 'Edit candidate' : 'Add candidate'}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="candidate-form" className="btn-primary" disabled={busy}>
            {busy && <Loader2 size={16} strokeWidth={1.5} className="animate-spin" />}
            {editing ? 'Save changes' : 'Add candidate'}
          </button>
        </>
      }
    >
      <form
        id="candidate-form"
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate(false);
        }}
      >
        <section className="space-y-4">
          <p className="text-sm font-medium">Identity</p>
          <div className="grid gap-4 sm:grid-cols-[1fr_80px_1fr]">
            <Field label="First name" required>
              <input className="input" value={f.firstName} onChange={set('firstName')} required />
            </Field>
            <Field label="M.I.">
              <input className="input" value={f.middleInitial} onChange={set('middleInitial')} maxLength={2} />
            </Field>
            <Field label="Last name" required>
              <input className="input" value={f.lastName} onChange={set('lastName')} required />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Gender">
              <select className="input" value={f.gender} onChange={set('gender')}>
                <option value="">Not given</option>
                <option value="female">Female</option>
                <option value="male">Male</option>
                <option value="other">Other</option>
              </select>
            </Field>
            <Field label="Date of birth">
              <input type="date" className="input" value={f.dateOfBirth} onChange={set('dateOfBirth')} />
            </Field>
          </div>
        </section>

        <section className="space-y-4">
          <p className="text-sm font-medium">Contact</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Email" hint="Email or phone is required">
              <input type="email" className="input" value={f.email} onChange={set('email')} />
            </Field>
            <Field label="Phone" hint="Digits only, no address">
              <input type="tel" className="input num" value={f.phone} onChange={set('phone')} placeholder="+92 300 1234567" />
            </Field>
            <Field label="Alternate phone">
              <input type="tel" className="input num" value={f.altPhone} onChange={set('altPhone')} />
            </Field>
          </div>
        </section>

        <section className="space-y-4">
          <p className="text-sm font-medium">Address</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Address line 1">
              <input className="input" value={f.address1} onChange={set('address1')} />
            </Field>
            <Field label="Address line 2">
              <input className="input" value={f.address2} onChange={set('address2')} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Country">
              <input className="input" list="rec-countries" value={f.country} onChange={set('country')} />
              <datalist id="rec-countries">
                <option value="Pakistan" />
                <option value="United States" />
              </datalist>
            </Field>
            <Field label="City">
              <input className="input" value={f.city} onChange={set('city')} />
            </Field>
            <Field label={country.state}>
              <input className="input" value={f.state} onChange={set('state')} />
            </Field>
            <Field label={country.postal} hint={country.postalHint}>
              <input className="input num" inputMode="text" value={f.postalCode} onChange={set('postalCode')} />
            </Field>
          </div>
        </section>

        {!editing && (
          <section className="space-y-4">
            <p className="text-sm font-medium">Application</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Position applied" required>
                <input className="input" list="rec-positions" value={position} onChange={(e) => setPosition(e.target.value)} required />
                <datalist id="rec-positions">
                  {(positions.data ?? []).map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </Field>
              <Field label="Department">
                <select className="input" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                  <option value="">Not set</option>
                  {(depts.data ?? [])
                    .filter((d) => d.active)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                </select>
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
              <div className="grid grid-cols-2 gap-4">
                <Field label="Applied on">
                  <input type="date" className="input" value={applied} onChange={(e) => setApplied(e.target.value)} />
                </Field>
                <Field label="Follow up on">
                  <input type="date" className="input" value={followup} onChange={(e) => setFollowup(e.target.value)} />
                </Field>
              </div>
            </div>
          </section>
        )}

        <section className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
            <Field label="Source" hint={SOURCE_HINT}>
              <input className="input" value={f.source} onChange={set('source')} />
            </Field>
            <Field label="Notes" hint="Recruiter remarks">
              <textarea className="input" rows={2} value={f.notes} onChange={set('notes')} />
            </Field>
          </div>
        </section>

        {dup ? (
          <DuplicateNotice id={dup.id} message={dup.message}>
            <button type="button" className="font-medium underline underline-offset-2" onClick={() => m.mutate(true)} disabled={busy}>
              Save anyway
            </button>
          </DuplicateNotice>
        ) : (
          <FormError message={m.error?.message} />
        )}
      </form>
    </Modal>
  );
}
