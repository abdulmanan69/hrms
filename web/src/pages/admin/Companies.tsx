import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date } from '../../lib/format';
import { ConfirmModal, EmptyState, ErrorState, Field, FormError, ICON, Loading, Modal, PageHeader, StatusTag, toast } from '../../components/ui';

type Company = {
  id: number;
  name: string;
  slug: string;
  status: 'active' | 'disabled';
  createdAt: string;
  activeEmployees: number;
  employees: number;
  users: number;
};

const KEY = ['platform', 'companies'];

/** Super admins only: each company's people, payroll and leave are kept fully apart. */
export function Companies() {
  const { user, switchCompany } = useAuth();
  const q = useQuery({ queryKey: KEY, queryFn: () => api<{ data: Company[] }>('/platform/companies') });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Company | null>(null);

  if (!user?.isSuperAdmin) return <EmptyState title="Only a super admin can manage companies" />;

  return (
    <div>
      <PageHeader
        eyebrow="Admin"
        title="Companies"
        subtitle="Each company has its own people, payroll, leave and users. Nothing is shared between them"
        actions={
          <button className="btn-primary" onClick={() => setAdding(true)}>
            <Plus {...ICON} /> Add company
          </button>
        }
      />

      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="th">Company</th>
                  <th className="th">Sign-in code</th>
                  <th className="th text-right">Active staff</th>
                  <th className="th text-right">Users</th>
                  <th className="th">Status</th>
                  <th className="th">Added</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody>
                {q.data!.data.map((c) => {
                  const current = c.id === user.companyId;
                  return (
                    <tr key={c.id} className="row-link" onClick={() => setEditing(c)}>
                      <td className="td">
                        <span className="font-medium">{c.name}</span>
                        {current && <span className="ml-2 text-xs text-brand">Working here</span>}
                        {!current && c.id === user.homeCompanyId && <span className="ml-2 text-xs text-ink-3">Your company</span>}
                      </td>
                      <td className="td num text-ink-2">{c.slug}</td>
                      <td className="td num text-right">{c.activeEmployees}</td>
                      <td className="td num text-right text-ink-2">{c.users}</td>
                      <td className="td">
                        <StatusTag value={c.status} />
                      </td>
                      <td className="td text-ink-2">{date(c.createdAt.slice(0, 10))}</td>
                      <td className="td text-right" onClick={(e) => e.stopPropagation()}>
                        {!current && (
                          <button className="btn-secondary btn-sm" onClick={() => switchCompany(c.id)}>
                            Open <ArrowRight size={14} strokeWidth={1.5} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="mt-4 max-w-2xl text-xs text-ink-3">
        The sign-in code is only asked for when the same email has an account in more than one company. Disabling a company signs its people out and blocks
        their sign-in; its records stay as they are.
      </p>

      {adding && <AddCompany onClose={() => setAdding(false)} />}
      {editing && <EditCompany company={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function AddCompany({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [password, setPassword] = useState('');
  const m = useMutation({
    mutationFn: () =>
      api<Company>('/platform/companies', {
        method: 'POST',
        body: { name, slug, admin: { name: adminName, email: adminEmail, password } },
      }),
    onSuccess: (c) => {
      toast(`${c.name} added`);
      void qc.invalidateQueries({ queryKey: KEY });
      onClose();
    },
  });
  const ready = name.trim().length >= 2 && slug.length >= 2 && adminName && adminEmail && password.length >= 8;

  return (
    <Modal
      open
      title="Add company"
      description="It starts with the default roles, leave types, departments and payroll rules"
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!ready || m.isPending} onClick={() => m.mutate()}>
            Add company
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError message={m.error?.message} />
        <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
          <Field label="Company name" required>
            <input
              className="input"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
            />
          </Field>
          <Field label="Sign-in code" hint="Lowercase, digits, dashes">
            <input
              className="input num"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
              }}
            />
          </Field>
        </div>
        <div className="rounded-xl border border-line p-4">
          <p className="mb-3 text-sm font-medium">First HR admin</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required>
              <input className="input" value={adminName} onChange={(e) => setAdminName(e.target.value)} />
            </Field>
            <Field label="Email" required>
              <input className="input" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
            </Field>
            <Field label="Password" hint="At least 8 characters. They can change it after signing in" required className="sm:col-span-2">
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </Field>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function EditCompany({ company, onClose }: { company: Company; onClose: () => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [name, setName] = useState(company.name);
  const [confirm, setConfirm] = useState(false);
  const save = useMutation({
    mutationFn: (body: { name?: string; status?: 'active' | 'disabled' }) => api<Company>(`/platform/companies/${company.id}`, { method: 'PATCH', body }),
    onSuccess: (_c, body) => {
      toast(body.status === 'disabled' ? `${company.name} disabled` : body.status === 'active' ? `${company.name} enabled again` : 'Company renamed');
      void qc.invalidateQueries({ queryKey: KEY });
      onClose();
    },
  });
  const own = company.id === user?.homeCompanyId;

  return (
    <>
      <Modal
        open={!confirm}
        title={company.name}
        description={`Sign-in code ${company.slug}`}
        onClose={onClose}
        footer={
          <>
            {company.status === 'active' ? (
              <button className="btn-ghost mr-auto text-bad hover:bg-bad-soft hover:text-bad" disabled={own} title={own ? 'You cannot disable your own company' : undefined} onClick={() => setConfirm(true)}>
                Disable company
              </button>
            ) : (
              <button className="btn-secondary mr-auto" onClick={() => save.mutate({ status: 'active' })}>
                Enable again
              </button>
            )}
            <button className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="btn-primary" disabled={name.trim().length < 2 || name === company.name || save.isPending} onClick={() => save.mutate({ name })}>
              Save
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <FormError message={save.error?.message} />
          <Field label="Company name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <dl className="grid grid-cols-3 gap-4 rounded-xl bg-bg p-4">
            <div>
              <dt className="text-xs text-ink-3">Active staff</dt>
              <dd className="num mt-1 text-lg">{company.activeEmployees}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">All staff</dt>
              <dd className="num mt-1 text-lg">{company.employees}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">Users</dt>
              <dd className="num mt-1 text-lg">{company.users}</dd>
            </div>
          </dl>
        </div>
      </Modal>
      <ConfirmModal
        open={confirm}
        title={`Disable ${company.name}`}
        body="Its people are signed out and can't sign in until the company is enabled again. No records are changed or removed."
        confirmLabel="Disable company"
        danger
        busy={save.isPending}
        onClose={() => setConfirm(false)}
        onConfirm={() => save.mutate({ status: 'disabled' })}
      />
    </>
  );
}
