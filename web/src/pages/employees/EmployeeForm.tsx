import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Card, CardHead, ErrorState, Field, FormError, Loading, PageHeader, SipId, toast } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { label, todayISO } from '../../lib/format';
import { EMPLOYMENT_STATUSES, empKeys, employeesApi, type EmployeeDetail, type EmployeeInput, type EmploymentStatus } from '../../api/employees';
import { useInvalidateEmployees } from './parts';

type FormState = Record<
  | 'firstName'
  | 'middleInitial'
  | 'lastName'
  | 'gender'
  | 'dateOfBirth'
  | 'cnic'
  | 'email'
  | 'phone'
  | 'altPhone'
  | 'address1'
  | 'address2'
  | 'city'
  | 'state'
  | 'postalCode'
  | 'country'
  | 'departmentId'
  | 'designationId'
  | 'managerSipId'
  | 'employmentStatus'
  | 'dateOfJoining'
  | 'bankName'
  | 'accountNo'
  | 'remarks'
  | 'sipId',
  string
>;

const EMPTY: FormState = {
  firstName: '',
  middleInitial: '',
  lastName: '',
  gender: '',
  dateOfBirth: '',
  cnic: '',
  email: '',
  phone: '',
  altPhone: '',
  address1: '',
  address2: '',
  city: '',
  state: '',
  postalCode: '',
  country: 'Pakistan',
  departmentId: '',
  designationId: '',
  managerSipId: '',
  employmentStatus: 'probation',
  dateOfJoining: todayISO(),
  bankName: '',
  accountNo: '',
  remarks: '',
  sipId: '',
};

function fromEmployee(e: EmployeeDetail): FormState {
  const s = (v: string | number | null | undefined) => (v == null ? '' : String(v));
  return {
    sipId: e.sipId,
    firstName: e.firstName,
    middleInitial: s(e.middleInitial),
    lastName: e.lastName,
    gender: s(e.gender),
    dateOfBirth: s(e.dateOfBirth),
    cnic: s(e.cnic),
    email: s(e.email),
    phone: s(e.phone),
    altPhone: s(e.altPhone),
    address1: s(e.address1),
    address2: s(e.address2),
    city: s(e.city),
    state: s(e.state),
    postalCode: s(e.postalCode),
    country: s(e.country),
    departmentId: s(e.departmentId),
    designationId: s(e.designationId),
    managerSipId: s(e.managerSipId),
    employmentStatus: e.employmentStatus,
    dateOfJoining: e.dateOfJoining,
    bankName: s(e.bankName),
    accountNo: s(e.accountNo),
    remarks: s(e.remarks),
  };
}

function toInput(f: FormState, includeSensitive: boolean): EmployeeInput {
  const t = (v: string) => (v.trim() === '' ? null : v.trim());
  const body: EmployeeInput = {
    firstName: f.firstName.trim(),
    middleInitial: t(f.middleInitial),
    lastName: f.lastName.trim(),
    gender: t(f.gender),
    email: t(f.email),
    phone: t(f.phone),
    altPhone: t(f.altPhone),
    address1: t(f.address1),
    address2: t(f.address2),
    city: t(f.city),
    state: t(f.state),
    postalCode: t(f.postalCode),
    country: t(f.country),
    departmentId: f.departmentId ? Number(f.departmentId) : null,
    designationId: f.designationId ? Number(f.designationId) : null,
    managerSipId: t(f.managerSipId),
    employmentStatus: f.employmentStatus as EmploymentStatus,
    dateOfJoining: f.dateOfJoining,
    remarks: t(f.remarks),
  };
  if (includeSensitive) {
    body.cnic = t(f.cnic);
    body.dateOfBirth = t(f.dateOfBirth);
    body.bankName = t(f.bankName);
    body.accountNo = t(f.accountNo);
  }
  return body;
}

export function EmployeeForm() {
  const { sipId } = useParams<{ sipId: string }>();
  const editing = !!sipId;
  const existing = useQuery({ queryKey: empKeys.detail(sipId ?? ''), queryFn: () => employeesApi.get(sipId!), enabled: editing });

  if (editing && existing.isLoading) return <Loading />;
  if (editing && existing.error) return <ErrorState message={existing.error.message} onRetry={() => existing.refetch()} />;
  return <FormBody key={sipId ?? 'new'} existing={editing ? existing.data : undefined} />;
}

function FormBody({ existing }: { existing?: EmployeeDetail }) {
  const navigate = useNavigate();
  const invalidate = useInvalidateEmployees();
  const [f, setF] = useState<FormState>(existing ? fromEmployee(existing) : EMPTY);
  const showSensitive = existing ? existing.sensitiveVisible : true;

  const depts = useQuery({ queryKey: empKeys.departments, queryFn: employeesApi.departments });
  const desigs = useQuery({ queryKey: empKeys.designations, queryFn: employeesApi.designations });
  const people = useQuery({
    queryKey: empKeys.people({ status: 'active', limit: 500 }),
    queryFn: () => employeesApi.people({ status: 'active', limit: 500 }),
  });

  const designationOptions = useMemo(
    () =>
      (desigs.data?.data ?? []).filter(
        (d) => (d.active || String(d.id) === f.designationId) && (!f.departmentId || d.departmentId == null || String(d.departmentId) === f.departmentId),
      ),
    [desigs.data, f.departmentId, f.designationId],
  );

  // Drop a designation that doesn't belong to the newly picked department.
  useEffect(() => {
    if (f.designationId && desigs.data && !designationOptions.some((d) => String(d.id) === f.designationId)) {
      setF((x) => ({ ...x, designationId: '' }));
    }
  }, [designationOptions, f.designationId, desigs.data]);

  const save = useMutation({
    mutationFn: () => {
      const body = toInput(f, showSensitive);
      return existing ? employeesApi.update(existing.sipId, body) : employeesApi.create({ ...body, sipId: f.sipId.trim() || undefined });
    },
    onSuccess: (emp) => {
      invalidate();
      toast(existing ? 'Changes saved' : `Added ${emp.name} as SIP ${emp.sipId}`);
      navigate(`/employees/${emp.sipId}`);
    },
  });
  const fieldErrors = save.error instanceof ApiError ? save.error.details ?? {} : {};
  const err = (k: keyof FormState) => fieldErrors[k]?.[0] ?? null;
  const hasFieldErrors = Object.keys(fieldErrors).length > 0;

  const bind = (k: keyof FormState) => ({
    value: f[k],
    onChange: (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value })),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  const managerOptions = (people.data?.data ?? []).filter((p) => p.sipId !== existing?.sipId);
  const cancelTo = existing ? `/employees/${existing.sipId}` : '/employees';

  return (
    <form className="rise" onSubmit={submit} noValidate>
      <PageHeader
        back={{ to: cancelTo, label: existing ? existing.name : 'Employees' }}
        title={existing ? 'Edit employee' : 'Add employee'}
        subtitle={
          existing ? (
            <span className="inline-flex items-center gap-2">
              SIP ID <SipId id={existing.sipId} /> is fixed and cannot be changed
            </span>
          ) : (
            'The SIP ID is generated when you save. New employees start as pending until their CNIC copy and signed contract are on file'
          )
        }
        actions={
          <>
            <Link to={cancelTo} className="btn-secondary">
              Cancel
            </Link>
            <button type="submit" className="btn-primary" disabled={save.isPending}>
              {existing ? 'Save changes' : 'Add employee'}
            </button>
          </>
        }
      />

      {save.error && (
        <div className="mb-6">
          <FormError message={hasFieldErrors ? 'Some fields need attention. See the messages below' : save.error.message} />
        </div>
      )}

      <div className="space-y-6">
        <Section title="Identity" meta="Name is shown as first name, middle initial and last name">
          <Grid cols={3}>
            <Field label="First name" required error={err('firstName')}>
              <input className="input" autoFocus={!existing} {...bind('firstName')} />
            </Field>
            <Field label="Middle initial" error={err('middleInitial')}>
              <input className="input" maxLength={2} {...bind('middleInitial')} />
            </Field>
            <Field label="Last name" required error={err('lastName')}>
              <input className="input" {...bind('lastName')} />
            </Field>
            {showSensitive && (
              <Field label="CNIC" error={err('cnic')} hint="12345-1234567-1. Needed before the record can go active">
                <input className="input num" inputMode="numeric" placeholder="35202-1234567-1" {...bind('cnic')} />
              </Field>
            )}
            {showSensitive && (
              <Field label="Date of birth" error={err('dateOfBirth')}>
                <input type="date" className="input" {...bind('dateOfBirth')} />
              </Field>
            )}
            <Field label="Gender" error={err('gender')}>
              <select className="input" {...bind('gender')}>
                <option value="">Not stated</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
                <option value="other">Other</option>
              </select>
            </Field>
          </Grid>
          {!showSensitive && <p className="mt-4 text-xs text-ink-3">CNIC, date of birth and bank details are visible only to HR and finance</p>}
        </Section>

        <Section title="Contact and address">
          <Grid cols={3}>
            <Field label="Email" error={err('email')}>
              <input type="email" className="input" {...bind('email')} />
            </Field>
            <Field label="Phone" error={err('phone')} hint="Digits only, e.g. 0300 1234567 or +92 42 1234567 ext 12">
              <input type="tel" className="input num" {...bind('phone')} />
            </Field>
            <Field label="Alternate phone" error={err('altPhone')}>
              <input type="tel" className="input num" {...bind('altPhone')} />
            </Field>
            <Field label="Address" error={err('address1')} className="sm:col-span-2">
              <input className="input" {...bind('address1')} />
            </Field>
            <Field label="Address line 2" error={err('address2')}>
              <input className="input" {...bind('address2')} />
            </Field>
            <Field label="City" error={err('city')}>
              <input className="input" {...bind('city')} />
            </Field>
            <Field label="State or province" error={err('state')}>
              <input className="input" {...bind('state')} />
            </Field>
            <Field label="Postal code" error={err('postalCode')} hint="Kept exactly as typed, leading zeros included">
              <input className="input num" {...bind('postalCode')} />
            </Field>
            <Field label="Country" error={err('country')}>
              <input className="input" {...bind('country')} />
            </Field>
          </Grid>
        </Section>

        <Section title="Employment">
          <Grid cols={3}>
            <Field label="Department" error={err('departmentId')}>
              <select className="input" {...bind('departmentId')}>
                <option value="">No department</option>
                {(depts.data?.data ?? [])
                  .filter((d) => d.active || String(d.id) === f.departmentId)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Designation" error={err('designationId')}>
              <select className="input" {...bind('designationId')}>
                <option value="">No designation</option>
                {designationOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Manager" error={err('managerSipId')} hint="Approves their leave">
              <select className="input" {...bind('managerSipId')}>
                <option value="">No manager</option>
                {existing?.managerSipId && !managerOptions.some((m) => m.sipId === existing.managerSipId) && (
                  <option value={existing.managerSipId}>
                    {existing.managerName} ({existing.managerSipId}, {existing.managerStatus})
                  </option>
                )}
                {managerOptions.map((m) => (
                  <option key={m.sipId} value={m.sipId}>
                    {m.name} ({m.sipId}){m.designationTitle ? `, ${m.designationTitle}` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Employment status" required error={err('employmentStatus')}>
              <select className="input" {...bind('employmentStatus')}>
                {EMPLOYMENT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {label(s)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Joining date" required error={err('dateOfJoining')}>
              <input type="date" className="input" {...bind('dateOfJoining')} />
            </Field>
            {!existing && (
              <Field label="SIP ID" hint="Their VICIdial user, e.g. WTI1002. Leave empty to generate one" error={err('sipId')}>
                <input className="input num" {...bind('sipId')} autoComplete="off" />
              </Field>
            )}
          </Grid>
        </Section>

        {showSensitive && (
          <Section title="Bank" meta="Where salary is paid">
            <Grid cols={3}>
              <Field label="Bank" error={err('bankName')}>
                <input className="input" placeholder="e.g. HBL" {...bind('bankName')} />
              </Field>
              <Field label="Account number or IBAN" error={err('accountNo')} className="sm:col-span-2">
                <input className="input num" {...bind('accountNo')} />
              </Field>
            </Grid>
          </Section>
        )}

        <Section title="Remarks">
          <Field label="Notes for HR" error={err('remarks')}>
            <textarea className="input" rows={3} {...bind('remarks')} />
          </Field>
        </Section>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <Link to={cancelTo} className="btn-secondary">
          Cancel
        </Link>
        <button type="submit" className="btn-primary" disabled={save.isPending}>
          {existing ? 'Save changes' : 'Add employee'}
        </button>
      </div>
    </form>
  );
}

function Section({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <Card>
      <CardHead title={title} meta={meta} />
      <div className="px-5 pb-5">{children}</div>
    </Card>
  );
}

function Grid({ cols, children }: { cols: 2 | 3; children: ReactNode }) {
  return <div className={`grid gap-4 sm:grid-cols-2 ${cols === 3 ? 'xl:grid-cols-3' : ''}`}>{children}</div>;
}
