import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, label } from '../../lib/format';
import {
  Avatar,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  ICON,
  Loading,
  Modal,
  PageHeader,
  SearchInput,
  SipId,
  StatusTag,
  Tabs,
  Tag,
  toast,
  useDebounced,
} from '../../components/ui';

type UserRow = {
  id: number;
  email: string;
  name: string;
  status: 'active' | 'disabled';
  isSuperAdmin: boolean;
  sipId: string | null;
  employeeName: string | null;
  roleId: number;
  roleName: string;
  roleLabel: string;
  lastLoginAt: string | null;
};
type Role = { id: number; name: string; label: string; description: string | null; permissions: string[]; isSystem: boolean; userCount: number };
type Person = { sipId: string; name: string; departmentName: string | null };

/** What each permission lets someone do, in plain words. */
const PERMISSION_TEXT: Record<string, string> = {
  'dashboard.view': 'See the dashboard',
  'recruitment.view': 'See candidates, pipeline and interviews',
  'recruitment.manage': 'Add candidates, move stages, schedule interviews, hire',
  'employees.view': 'See every employee record',
  'team.view': 'See only their direct reports',
  'employees.manage': 'Add and edit employees, departments, activation',
  'employees.sensitive': 'See CNIC, bank account and date of birth',
  'documents.manage': 'Upload and remove employee documents',
  'payroll.view': 'See payroll runs, payslips and salary structures',
  'payroll.manage': 'Create runs, edit salaries, loans and additions',
  'payroll.approve': 'Approve runs and mark them paid',
  'leave.view': 'See everyone’s leave and balances',
  'leave.approve': 'Approve anyone’s leave',
  'leave.approve.team': 'Approve their direct reports’ leave',
  'leave.manage': 'Leave types, balance adjustments, apply on behalf',
  'users.manage': 'Manage user accounts and roles',
  'audit.view': 'Read the audit trail',
  'settings.manage': 'Change payroll and leave rules',
  'integrations.manage': 'API keys, webhooks and live events for other systems',
  'metrics.write': 'Report figures per employee from another system (QA scores, hours)',
  'sales.view': 'See every sale and incentive (team.view: their reports’ only)',
  'sales.manage': 'Record and void sales, set incentive slabs',
  'sales.write': 'Report sales from another system (VICIdial)',
};

export function Users() {
  const [tab, setTab] = useState<'users' | 'roles'>('users');
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const users = useQuery({ queryKey: ['users', debounced], queryFn: () => api<{ data: UserRow[] }>('/users', { query: { search: debounced } }) });
  const roles = useQuery({ queryKey: ['users', 'roles'], queryFn: () => api<{ data: Role[]; permissions: string[] }>('/users/roles') });

  return (
    <div>
      <PageHeader
        eyebrow="Admin"
        title="Users and roles"
        subtitle="Who can sign in, and what each role may see and do"
        actions={
          tab === 'users' && (
            <button className="btn-primary" onClick={() => setEditing('new')}>
              <Plus {...ICON} /> Add user
            </button>
          )
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'users', label: 'Users', count: users.data?.data.length },
          { value: 'roles', label: 'Roles', count: roles.data?.data.length },
        ]}
      />

      {tab === 'users' && (
        <div className="card overflow-hidden">
          <div className="flex items-center gap-3 px-5 py-4">
            <SearchInput value={search} onChange={setSearch} placeholder="Search name or email" className="w-full max-w-xs" />
          </div>
          {users.isLoading ? (
            <Loading inline label="Loading users" />
          ) : users.error ? (
            <ErrorState message={users.error.message} onRetry={() => users.refetch()} />
          ) : users.data!.data.length === 0 ? (
            <EmptyState bare title="No users match" hint="Try another name or email" />
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th className="th">User</th>
                    <th className="th">Role</th>
                    <th className="th">Employee record</th>
                    <th className="th">Status</th>
                    <th className="th">Last sign-in</th>
                  </tr>
                </thead>
                <tbody>
                  {users.data!.data.map((u) => (
                    <tr key={u.id} className="row-link" onClick={() => setEditing(u)}>
                      <td className="td">
                        <div className="flex items-center gap-3">
                          <Avatar name={u.name} />
                          <div>
                            <p className="flex items-center gap-2 font-medium">
                              {u.name}
                              {u.isSuperAdmin && <Tag tone="brand">Super admin</Tag>}
                            </p>
                            <p className="text-xs text-ink-3">{u.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="td text-ink-2">{u.roleLabel}</td>
                      <td className="td">
                        {u.sipId ? (
                          <span className="flex items-center gap-2">
                            <SipId id={u.sipId} />
                            <span className="text-ink-2">{u.employeeName}</span>
                          </span>
                        ) : (
                          <span className="text-ink-3">Not linked</span>
                        )}
                      </td>
                      <td className="td">
                        <StatusTag value={u.status} />
                      </td>
                      <td className="td num text-xs text-ink-3">{u.lastLoginAt ? dateTime(u.lastLoginAt) : 'Never'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'roles' && (roles.isLoading ? <Loading /> : roles.error ? <ErrorState message={roles.error.message} /> : <Roles roles={roles.data!.data} all={roles.data!.permissions} />)}

      {editing && roles.data && <UserModal user={editing === 'new' ? null : editing} roles={roles.data.data} onClose={() => setEditing(null)} />}
    </div>
  );
}

function UserModal({ user, roles, onClose }: { user: UserRow | null; roles: Role[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [roleId, setRoleId] = useState<number>(user?.roleId ?? roles.find((r) => r.name === 'employee')?.id ?? roles[0]?.id);
  const [sipId, setSipId] = useState(user?.sipId ?? '');
  const [status, setStatus] = useState(user?.status ?? 'active');
  const [password, setPassword] = useState('');
  const [personSearch, setPersonSearch] = useState('');
  const debounced = useDebounced(personSearch);
  const people = useQuery({
    queryKey: ['org', 'people', 'all', debounced],
    queryFn: () => api<{ data: Person[] }>('/org/people', { query: { search: debounced, status: 'all', limit: 20 } }),
  });

  const save = useMutation({
    mutationFn: async () => {
      const body = { name, email, roleId, sipId: sipId || null, status };
      if (user) {
        await api(`/users/${user.id}`, { method: 'PATCH', body });
        if (password) await api(`/users/${user.id}/password`, { method: 'POST', body: { password } });
      } else {
        await api('/users', { method: 'POST', body: { ...body, password } });
      }
    },
    onSuccess: () => {
      toast(user ? 'User updated' : 'User added');
      void qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
  });

  const role = roles.find((r) => r.id === roleId);
  return (
    <Modal
      open
      title={user ? `Edit ${user.name}` : 'Add user'}
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={save.isPending || !name || !email || (!user && password.length < 8)} onClick={() => save.mutate()}>
            {user ? 'Save' : 'Add user'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError message={save.error?.message} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email" required>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        </div>
        <Field label="Role" hint={role?.description ?? undefined}>
          <select className="input" value={roleId} onChange={(e) => setRoleId(Number(e.target.value))}>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Employee record" hint="Linking gives self-service: own profile, payslips and leave. Managers must be linked to see their team">
          <div className="space-y-2">
            {sipId && (
              <div className="flex items-center justify-between rounded-lg border border-line px-3 py-2">
                <span className="flex items-center gap-2 text-sm">
                  <SipId id={sipId} /> {people.data?.data.find((p) => p.sipId === sipId)?.name ?? user?.employeeName}
                </span>
                <button className="text-xs text-ink-3 hover:text-ink" onClick={() => setSipId('')} type="button">
                  Unlink
                </button>
              </div>
            )}
            {!sipId && (
              <>
                <input className="input" placeholder="Search by name or SIP ID" value={personSearch} onChange={(e) => setPersonSearch(e.target.value)} />
                {personSearch && (
                  <ul className="max-h-40 divide-y divide-line overflow-y-auto rounded-lg border border-line">
                    {(people.data?.data ?? []).map((p) => (
                      <li key={p.sipId}>
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-bg"
                          onClick={() => {
                            setSipId(p.sipId);
                            setPersonSearch('');
                          }}
                        >
                          <SipId id={p.sipId} /> {p.name}
                          <span className="ml-auto text-xs text-ink-3">{p.departmentName}</span>
                        </button>
                      </li>
                    ))}
                    {people.data?.data.length === 0 && <li className="px-3 py-2 text-sm text-ink-3">No match</li>}
                  </ul>
                )}
              </>
            )}
          </div>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={user ? 'New password' : 'Password'} hint={user ? 'Leave empty to keep the current one' : 'At least 8 characters'} required={!user}>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </Field>
          {user && (
            <Field label="Status">
              <select className="input" value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'disabled')} disabled={user.id === me?.userId}>
                <option value="active">Active</option>
                <option value="disabled">Disabled</option>
              </select>
            </Field>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Roles({ roles, all }: { roles: Role[]; all: string[] }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState(roles[0]?.id);
  const role = roles.find((r) => r.id === selected) ?? roles[0];
  const [draft, setDraft] = useState<string[] | null>(null);
  const perms = draft ?? role?.permissions ?? [];
  const isAll = perms.includes('*');
  const groups = useMemo(() => {
    const g = new Map<string, string[]>();
    for (const p of all) {
      const key = p.split('.')[0];
      g.set(key, [...(g.get(key) ?? []), p]);
    }
    return [...g.entries()];
  }, [all]);

  const save = useMutation({
    mutationFn: () => api(`/users/roles/${role.id}`, { method: 'PATCH', body: { permissions: perms } }),
    onSuccess: () => {
      toast(`${role.label} updated`);
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ['users', 'roles'] });
    },
  });

  if (!role) return <EmptyState title="No roles" />;
  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <div className="card p-2">
        {roles.map((r) => (
          <button
            key={r.id}
            onClick={() => {
              setSelected(r.id);
              setDraft(null);
            }}
            className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left transition-colors ${
              r.id === role.id ? 'bg-raised shadow-[inset_0_0_0_1px_rgba(23,23,23,0.06)]' : 'hover:bg-bg'
            }`}
          >
            <span>
              <span className="block text-sm font-medium">{r.label}</span>
              <span className="block text-xs text-ink-3">{r.description}</span>
            </span>
            <span className="num text-xs text-ink-3">{r.userCount}</span>
          </button>
        ))}
      </div>
      <div className="card">
        <div className="card-head">
          <div>
            <p className="card-title">{role.label}</p>
            <p className="text-xs text-ink-3">{isAll ? 'Full access to everything' : `${perms.length} permissions`}</p>
          </div>
          {draft && (
            <div className="flex gap-2">
              <button className="btn-secondary btn-sm" onClick={() => setDraft(null)}>
                Discard
              </button>
              <button className="btn-primary btn-sm" onClick={() => save.mutate()} disabled={save.isPending}>
                Save role
              </button>
            </div>
          )}
        </div>
        <div className="border-t border-line px-5 py-4">
          <FormError message={save.error?.message} />
          {isAll ? (
            <p className="text-sm text-ink-2">This role can do everything, including managing users and settings. Self-service is always available to linked accounts.</p>
          ) : (
            <div className="space-y-6">
              {groups.map(([group, list]) => (
                <div key={group}>
                  <p className="mb-2 text-xs text-ink-3">{label(group)}</p>
                  <ul className="space-y-1">
                    {list.map((p) => (
                      <li key={p}>
                        <label className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-bg">
                          <input
                            type="checkbox"
                            className="mt-0.5 h-4 w-4 accent-[#3B4A9F]"
                            checked={perms.includes(p)}
                            onChange={(e) => setDraft(e.target.checked ? [...perms, p] : perms.filter((x) => x !== p))}
                          />
                          <span>
                            <span className="block text-sm">{PERMISSION_TEXT[p] ?? p}</span>
                            <span className="num block text-xs text-ink-3">{p}</span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
