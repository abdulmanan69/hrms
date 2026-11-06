import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, Pencil } from 'lucide-react';
import { Avatar, Card, CardHead, DetailList, ErrorState, Field, FormError, ICON, Loading, Modal, SipId, StatusTag, toast } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { date, label } from '../../lib/format';
import { empKeys, employeesApi, type ContactInput, type EmployeeDetail } from '../../api/employees';
import { DocumentList, useInvalidateEmployees } from './parts';
import { statusText } from './Employees';

export function MyProfile() {
  const q = useQuery({ queryKey: empKeys.me, queryFn: employeesApi.me });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState message={q.error?.message ?? 'Your profile could not be loaded'} onRetry={() => q.refetch()} />;
  return <Mine emp={q.data} />;
}

function Mine({ emp }: { emp: EmployeeDetail }) {
  const [editing, setEditing] = useState(false);
  const address = [emp.address1, emp.address2, emp.city, emp.state, emp.postalCode, emp.country].filter(Boolean).join(', ');

  return (
    <div className="rise">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <Avatar name={emp.name} size={56} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[28px] font-medium leading-tight tracking-[-0.01em]">{emp.name}</h1>
              <SipId id={emp.sipId} />
              <StatusTag value={emp.status} text={statusText(emp.status)} />
            </div>
            <p className="mt-1 text-sm text-ink-2">{[emp.designationTitle, emp.departmentName].filter(Boolean).join(' · ') || 'My profile'}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Link to="/me/leave" className="btn-secondary">
            My leave
          </Link>
          <Link to="/me/payslips" className="btn-secondary">
            My payslips
          </Link>
        </div>
      </div>

      {emp.status === 'pending' && emp.blockers.length > 0 && (
        <div className="card mb-6 px-5 py-4 text-sm text-ink-2">
          Your record is waiting for {emp.blockers.join(', ')}. HR will activate it once these are on file.
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHead
              title="Contact and address"
              meta="You can update these yourself"
              actions={
                <button className="btn-secondary btn-sm" onClick={() => setEditing(true)}>
                  <Pencil {...ICON} className="text-ink-3" />
                  Edit
                </button>
              }
            />
            <div className="px-5 pb-5">
              <DetailList
                items={[
                  { label: 'Email', value: emp.email },
                  { label: 'Phone', value: emp.phone, mono: true },
                  { label: 'Alternate phone', value: emp.altPhone, mono: true },
                  { label: 'Address', value: address || null },
                ]}
              />
            </div>
          </Card>
          <Card>
            <CardHead title="Employment" meta="Ask HR to correct anything here" />
            <div className="px-5 pb-5">
              <DetailList
                cols={3}
                items={[
                  { label: 'Department', value: emp.departmentName },
                  { label: 'Designation', value: emp.designationTitle },
                  { label: 'Manager', value: emp.managerName },
                  { label: 'Employment status', value: <StatusTag value={emp.employmentStatus} /> },
                  { label: 'Joining date', value: date(emp.dateOfJoining) },
                ]}
              />
            </div>
          </Card>
          <Card>
            <CardHead title="Identity and bank" meta="Ask HR to correct anything here" />
            <div className="px-5 pb-5">
              <DetailList
                cols={3}
                items={[
                  { label: 'CNIC', value: emp.cnic, mono: true },
                  { label: 'Date of birth', value: emp.dateOfBirth ? date(emp.dateOfBirth) : null },
                  { label: 'Gender', value: emp.gender ? label(emp.gender) : null },
                  { label: 'Bank', value: emp.bankName },
                  { label: 'Account number', value: emp.accountNo, mono: true },
                ]}
              />
            </div>
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <CardHead title="My documents" />
            <DocumentList sipId={emp.sipId} documents={emp.documents} required={emp.requiredDocuments} canManage={false} />
          </Card>
          <Card>
            <CardHead title="Self-service" />
            <ul className="divide-y divide-line border-t border-line">
              {[
                { to: '/me/leave', label: 'My leave', hint: 'Balances and requests' },
                { to: '/leave/apply', label: 'Apply for leave', hint: 'Sent to your manager' },
                { to: '/me/payslips', label: 'My payslips', hint: 'Monthly salary slips' },
              ].map((l) => (
                <li key={l.to}>
                  <Link to={l.to} className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-bg">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">{l.label}</p>
                      <p className="text-xs text-ink-3">{l.hint}</p>
                    </div>
                    <ArrowRight size={14} strokeWidth={1.5} className="text-ink-3" />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      {editing && <ContactModal emp={emp} onClose={() => setEditing(false)} />}
    </div>
  );
}

const CONTACT_KEYS = ['email', 'phone', 'altPhone', 'address1', 'address2', 'city', 'state', 'postalCode', 'country'] as const;

function ContactModal({ emp, onClose }: { emp: EmployeeDetail; onClose: () => void }) {
  const invalidate = useInvalidateEmployees();
  const [f, setF] = useState<Record<(typeof CONTACT_KEYS)[number], string>>(() => {
    const out = {} as Record<(typeof CONTACT_KEYS)[number], string>;
    for (const k of CONTACT_KEYS) out[k] = emp[k] ?? '';
    return out;
  });
  const save = useMutation({
    mutationFn: () => {
      const body: ContactInput = {};
      for (const k of CONTACT_KEYS) body[k] = f[k].trim() || null;
      return employeesApi.updateMe(body);
    },
    onSuccess: () => {
      invalidate();
      toast('Contact details saved');
      onClose();
    },
  });
  const details = save.error instanceof ApiError ? save.error.details ?? {} : {};
  const err = (k: string) => details[k]?.[0] ?? null;
  const bind = (k: (typeof CONTACT_KEYS)[number]) => ({ value: f[k], onChange: (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value })) });

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="Edit contact and address"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
            Save
          </button>
        </>
      }
    >
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Email" error={err('email')}>
          <input type="email" className="input" {...bind('email')} />
        </Field>
        <Field label="Phone" error={err('phone')} hint="Digits only, e.g. 0300 1234567">
          <input type="tel" className="input num" {...bind('phone')} />
        </Field>
        <Field label="Alternate phone" error={err('altPhone')}>
          <input type="tel" className="input num" {...bind('altPhone')} />
        </Field>
        <Field label="Address" error={err('address1')}>
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
        <Field label="Postal code" error={err('postalCode')}>
          <input className="input num" {...bind('postalCode')} />
        </Field>
        <Field label="Country" error={err('country')}>
          <input className="input" {...bind('country')} />
        </Field>
        <div className="sm:col-span-2">
          <FormError message={Object.keys(details).length ? null : save.error?.message} />
        </div>
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}
